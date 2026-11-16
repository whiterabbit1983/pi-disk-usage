import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cacheError, cacheFresh, cacheLocation, CONTAINER_REFRESH_MS, environmentKey, HOST_REFRESH_MS, readCache, readSharedDiskUsage, writeCache, type CacheRecord } from "../src/cache.ts";
import { isContainer } from "../src/container.ts";

const exec = promisify(execFile);
const usage = { used: 55_000_000_000, total: 0, available: 0, filesystems: [], scope: "container" as const };
const key = "a".repeat(64);
const moduleUrl = pathToFileURL(join(process.cwd(), "src/cache.ts")).href;
const client = `import {readSharedDiskUsage} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await readSharedDiskUsage()));`;

async function fixture(run: (f: { dir: string; env: NodeJS.ProcessEnv; count: string; runtime: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-shared-cache-test-"));
  const runtime = join(dir, "runtime");
  const bin = join(dir, "bin");
  const count = join(dir, "calls");
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(bin);
  // Replace only df/du; exercise real timeout, flock, worker and separate Node processes.
  const script = `#!/bin/sh\nprintf 'scan\\n' >> '${count}'\nsleep 0.3\n`;
  await writeFile(join(bin, "du"), script + "printf '55000000000\\t/\\000'\n", { mode: 0o755 });
  await writeFile(join(bin, "df"), script + "printf 'source type size used avail target\\n/dev/test ext4 100000000000 55000000000 45000000000 /\\n'\n", { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: runtime, PATH: `${bin}:${process.env.PATH}` };
  delete env.PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB;
  try { await run({ dir, env, count, runtime }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("Timed out waiting for test fixture");
}

// Environment mutation is confined to this test process; subtests are sequential.
async function withEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try { return await run(); }
  finally {
    for (const name of Object.keys(process.env)) if (!(name in old)) delete process.env[name];
    Object.assign(process.env, old);
  }
}

test("cache TTL, clock rollback, error backoff and namespace keys", () => {
  const record: CacheRecord = { version: 1, key, usage, measuredAt: 1_000 };
  assert.equal(HOST_REFRESH_MS, 180_000);
  assert.equal(CONTAINER_REFRESH_MS, 600_000);
  assert.equal(cacheFresh(record, HOST_REFRESH_MS, 180_999), true);
  assert.equal(cacheFresh(record, HOST_REFRESH_MS, 181_000), false);
  assert.equal(cacheFresh(record, CONTAINER_REFRESH_MS, 600_999), true);
  assert.equal(cacheFresh(record, CONTAINER_REFRESH_MS, 601_000), false);
  assert.equal(cacheFresh(record, HOST_REFRESH_MS, 999), false);
  assert.equal(cacheError({ ...record, error: { at: 1000, message: "failed" } }, 1001), "failed");
  assert.equal(cacheError({ ...record, error: { at: 1000, message: "failed" } }, 6000), undefined);
  assert.notEqual(environmentKey([1, "host", 1000, "mnt:1"]), environmentKey([1, "container", 1000, "mnt:1"]));
  assert.notEqual(environmentKey([1, "host", 1000, "mnt:1"]), environmentKey([1, "host", 1001, "mnt:1"]));
  assert.notEqual(environmentKey([1, "host", 1000, "mnt:1"]), environmentKey([1, "host", 1000, "mnt:2"]));
});

test("atomic private records reject corruption, wrong versions, keys and invalid numbers", async () => {
  await fixture(async ({ dir }) => {
    const path = join(dir, "cache.json");
    assert.equal(await readCache(path, key), undefined);
    for (const value of ["{broken", "null", "{}", JSON.stringify({ version: 2, key, usage }), JSON.stringify({ version: 1, key, error: null }), JSON.stringify({ version: 1, key: "wrong", usage, measuredAt: 1 }), JSON.stringify({ version: 1, key, usage: { ...usage, used: -1 }, measuredAt: 1 })]) {
      await writeFile(path, value);
      assert.equal(await readCache(path, key), undefined);
    }
    await writeCache(path, { version: 1, key, usage, measuredAt: Date.now() });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readCache(path, key))?.usage, usage);
    assert.ok(!(await readdir(dir)).some((name) => name.endsWith(".tmp")));
  });
});

test("six concurrent Pi processes measure once; fresh cache and local thresholds require no extra scan", async () => {
  await fixture(async ({ env, count }) => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => exec(process.execPath, ["--input-type=module", "-e", client], {
      env: { ...env, PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB: i % 2 ? "10,20,30" : "50,60,70" }, timeout: 15_000,
    })));
    const values = results.map(({ stdout }) => JSON.parse(stdout));
    assert.ok(values.every((value) => value.used === usage.used && value.measuredAt === values[0].measuredAt && !value.stale));
    if (await isContainer()) {
      assert.deepEqual(values[0].containerThresholds, [50, 60, 70]);
      assert.deepEqual(values[1].containerThresholds, [10, 20, 30]);
    }
    await exec(process.execPath, ["--input-type=module", "-e", client], { env });
    assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 1);
  });
});

test("stale data is labelled while waiting, errors back off and retain the last measurement", async () => {
  await fixture(async ({ env, count, dir }) => withEnv(env, async () => {
    const container = await isContainer();
    const location = await cacheLocation(container);
    const oldUsage = container ? usage : { ...usage, scope: undefined, total: 100_000_000_000 };
    await writeCache(location.path, { version: 1, key: location.key, usage: oldUsage, measuredAt: 1 });
    let previous;
    const fresh = await readSharedDiskUsage(undefined, (value) => { previous = value; });
    assert.equal(previous!.stale, true);
    assert.equal(previous!.measuredAt, 1);
    assert.equal(fresh.stale, false);
    assert.ok(fresh.measuredAt! > 1);
    await writeCache(location.path, { version: 1, key: location.key, usage: oldUsage, measuredAt: 1 });
    await writeFile(join(dir, "bin", container ? "du" : "df"), `#!/bin/sh\nprintf 'scan\\n' >> '${count}'\necho failed >&2\nexit 2\n`, { mode: 0o755 });
    await assert.rejects(readSharedDiskUsage());
    await assert.rejects(readSharedDiskUsage());
    const stored = await readCache(location.path, location.key);
    assert.equal(stored?.measuredAt, 1);
    assert.equal(stored?.usage?.used, usage.used);
    assert.ok(stored?.error);
    assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 2);
    // Expire backoff: next call really retries.
    stored!.error!.at = 1;
    await writeCache(location.path, stored!);
    await assert.rejects(readSharedDiskUsage());
    assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 3);
  }));
});

test("du access warnings never enter the shared cache or become UI errors", async () => {
  // Explicit hint exercises the container path even when tests run on a host.
  await fixture(async ({ env, dir }) => withEnv({ ...env, container: "docker" }, async () => {
    await writeFile(join(dir, "bin", "du"), "#!/bin/sh\necho 'du: /secret: Permission denied' >&2\nprintf '55000000000\\t/\\000'\nexit 1\n", { mode: 0o755 });
    const result = await readSharedDiskUsage();
    assert.equal(result.used, usage.used);
    assert.equal(result.incomplete, true);
    const location = await cacheLocation(true);
    const record = await readCache(location.path, location.key);
    assert.equal(record?.error, undefined);
    assert.doesNotMatch(await readFile(location.path, "utf8"), /Permission denied|secret/);
  }));
});

test("cancelling a subscriber does not cancel the shared measurement for another Pi", async () => {
  await fixture(async ({ env, count }) => {
    const code = `import {readSharedDiskUsage} from ${JSON.stringify(moduleUrl)}; import {existsSync} from "node:fs"; const c=new AbortController(); const timer=setInterval(()=>{if(existsSync(${JSON.stringify(count)})) c.abort()},10); try {await readSharedDiskUsage(c.signal)} catch(e) {console.log(e.name)} finally {clearInterval(timer)}`;
    const cancelled = exec(process.execPath, ["--input-type=module", "-e", code], { env, timeout: 15_000 });
    await eventually(async () => (await readFile(count, "utf8").catch(() => "")).includes("scan"));
    const another = await exec(process.execPath, ["--input-type=module", "-e", client], { env, timeout: 15_000 });
    assert.equal(JSON.parse(another.stdout).used, usage.used);
    assert.match((await cancelled).stdout, /AbortError/);
    assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 1);
  });
});

test("kernel lock is released after a crashed worker or hard deadline; lock inode remains usable", async () => {
  await fixture(async ({ env, dir }) => withEnv(env, async () => {
    const location = await cacheLocation(await isContainer());
    const ready = join(dir, "ready");
    const holder = spawn("flock", ["--exclusive", `${location.path}.lock`, process.execPath, "-e",
      `require('fs').writeFileSync(${JSON.stringify(ready)},'ready'); process.kill(process.pid,'SIGKILL')`], { stdio: "ignore", env });
    const exit = new Promise((resolve) => holder.once("close", resolve));
    await exit;
    assert.equal(await readFile(ready, "utf8"), "ready");
    await exec("timeout", ["--signal=KILL", "0.1s", "flock", "--exclusive", `${location.path}.lock`, process.execPath, "-e", "setInterval(()=>{},1000)"], { env }).catch(() => {});
    assert.equal((await readSharedDiskUsage()).used, usage.used);
    assert.ok((await lstat(`${location.path}.lock`)).isFile());
  }));
});

test("cache directory permissions and symlinks fail closed instead of running duplicate scans", async () => {
  await fixture(async ({ env, runtime, dir }) => withEnv(env, async () => {
    const directory = join(runtime, `pi-disk-usage-${process.getuid!()}`);
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    await assert.rejects(cacheLocation(await isContainer()), /Unsafe|Небезопасный/);
    await rm(directory, { recursive: true });
    await symlink(dir, directory);
    await assert.rejects(cacheLocation(await isContainer()), /Unsafe|Небезопасный/);
  }));
});
