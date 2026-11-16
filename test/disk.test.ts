import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectLanguage } from "../src/i18n.ts";
import {
  DuCollector, GB, formatBytes, isInside, parseDf, readDiskUsage, safeText,
  scanHome, scanTmp, usageLevel, usagePercent,
} from "../src/disk.ts";

const fixture = await mkdtemp(join(process.cwd(), ".disk-test-"));
after(async () => { await rm(fixture, { recursive: true, force: true }); });

const df = `Filesystem Type 1B-blocks Used Available Mounted on
/dev/root ext4 200000000000 45000000000 150000000000 /
/dev/root ext4 200000000000 45000000000 150000000000 /bind
/dev/home ext4 100000000000 12000000000 80000000000 /home
/dev/data xfs 80000000000 9000000000 70000000000 /media/with spaces
tmpfs tmpfs 4000000000 600000000 3400000000 /run
tmpfs tmpfs 4000000000 1000000000 3000000000 /tmp
/dev/loop0 squashfs 1000 1000 0 /snap/tool/1
`;

test("thresholds use occupied capacity percentage, including exact boundaries", () => {
  const total = 100 * GB;
  assert.equal(usageLevel(0, total), "green");
  assert.equal(usageLevel(70 * GB, total), "green");
  assert.equal(usageLevel(70 * GB + 1, total), "yellow");
  assert.equal(usageLevel(80 * GB - 1, total), "yellow");
  assert.equal(usageLevel(80 * GB, total), "orange");
  assert.equal(usageLevel(90 * GB, total), "orange");
  assert.equal(usageLevel(90 * GB + 1, total), "red");
  assert.equal(usageLevel(140 * GB, 200 * GB), "green");
  assert.equal(usageLevel(190 * GB, 200 * GB), "red");
  assert.equal(usagePercent(50, 200), 25);
  assert.equal(usagePercent(0, 0), 0);
});

test("df totals include root, home, other disks and /tmp, not duplicate mounts or /run", () => {
  const usage = parseDf(df);
  assert.equal(usage.used, 67 * GB);
  assert.equal(usage.filesystems.length, 4);
  assert.equal(usage.filesystems[2].mount, "/media/with spaces");
  assert.throws(() => parseDf("bad output"));
});

test("formatting and terminal injection protection", () => {
  assert.equal(formatBytes(50 * GB), "50.0 GB");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 kB");
  assert.equal(formatBytes(NaN), "?");
  assert.equal(safeText("a\n\x1b[31m\t中"), "a\\u000a\\u001b[31m\\u0009中");
  assert.ok(!/[\x00-\x1f]/.test(safeText("\x1b]8;;evil\x07")));
});

test("path containment is segment-aware", () => {
  assert.equal(isInside("/home/me", "/home/me/a"), true);
  assert.equal(isInside("/home/me", "/home/me-too/a"), false);
  assert.equal(isInside("/home/me", "/home/me"), false);
  assert.equal(isInside("/home/me", "/tmp/a"), false);
});

test("streaming du keeps exactly top 20 and accepts tabs/newlines and split chunks", () => {
  const collector = new DuCollector("/home/test");
  const records = Array.from({ length: 1000 }, (_, i) => `${i}\t/home/test/file-${i}\0`).join("");
  const extra = "9999\t/home/test/strange\tline\n名\0";
  const data = records + extra + "999999\t/home/test-other/outside\0" + "888888\t/tmp/secret\0" + "100000\t/home/test\0";
  for (let i = 0; i < data.length; i += 7) collector.push(data.slice(i, i + 7));
  assert.equal(collector.entries.length, 20);
  assert.equal(collector.entries[0].path, "/home/test/strange\tline\n名");
  assert.equal(collector.entries[1].bytes, 999);
  assert.equal(collector.entries.at(-1)?.bytes, 981);
  assert.equal(collector.total, 100000);
});

test("summary collector never retains /tmp children", () => {
  const collector = new DuCollector("/tmp", 0);
  collector.push("100\t/tmp/private\0" + "200\t/tmp\0");
  assert.equal(collector.total, 200);
  assert.deepEqual(collector.entries, []);
});

test("real du scans hidden/nested files, measures allocated blocks, does not follow symlinks", async () => {
  const home = join(fixture, "home");
  const outside = join(fixture, "outside");
  await mkdir(join(home, ".cache"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret"), Buffer.alloc(512_000, 1));
  await symlink(outside, join(home, "external-link"));
  await symlink("/tmp", join(home, "tmp-link"));
  for (let i = 1; i <= 25; i++) {
    await writeFile(join(home, ".cache", `file-${i}`), Buffer.alloc(i * 4096, 1));
  }
  await writeFile(join(home, "tab\tnew\n名"), Buffer.alloc(300_000, 1));
  const report = await scanHome(home, new AbortController().signal);
  assert.equal(report.entries.length, 20);
  assert.equal(report.entries[0].kind, "directory");
  assert.equal(report.entries[0].path, join(home, ".cache"));
  assert.equal(report.entries[1].path, join(home, "tab\tnew\n名"));
  const stat = await lstat(report.entries[1].path);
  assert.equal(report.entries[1].bytes, stat.blocks * 512);
  assert.ok(report.total! >= report.entries[0].bytes);
  assert.ok(report.entries.every((entry) => !entry.path.includes("secret")));
  assert.ok(report.entries.every((entry, i, all) => i === 0 || all[i - 1].bytes >= entry.bytes));
  assert.equal(report.incomplete, false);
});

test("/tmp cannot be used as a home report, including through a symlink", async () => {
  const message = detectLanguage() === "ru" ? /не показывается/ : /not displayed/;
  await assert.rejects(scanHome("/tmp", new AbortController().signal), message);
  const link = join(fixture, "tmp-alias");
  await symlink("/tmp", link);
  await assert.rejects(scanHome(link, new AbortController().signal), message);
});

test("real df returns system-wide disk usage", async () => {
  const usage = await readDiskUsage();
  assert.ok(usage.used > 0);
  assert.ok(usage.filesystems.some((fs) => fs.mount === "/"));
  assert.equal(usage.used, usage.scope === "container"
    ? usage.filesystems.find((fs) => fs.mount === "/")!.used
    : usage.filesystems.reduce((sum, fs) => sum + fs.used, 0));
});

test("cancelled scans terminate without waiting for du", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanHome(fixture, controller.signal), { name: "AbortError" });
});

test("du partial errors, summary arguments, timeout and in-flight cancellation", async () => {
  const bin = join(fixture, "bin");
  await mkdir(bin);
  const duPath = join(bin, "du");
  const originalPath = process.env.PATH;
  const fakeDu = async (source: string) => {
    await writeFile(duPath, `#!${process.execPath}\n${source}\n`);
    await chmod(duPath, 0o755);
  };
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    await fakeDu(`const root = process.argv.at(-1); process.stdout.write('4096\\t' + root + '/child\\0' + '8192\\t' + root + '\\0'); process.stderr.write('Permission denied'); process.exitCode = 1;`);
    const partial = await scanHome(fixture, new AbortController().signal);
    assert.equal(partial.total, 8192);
    assert.equal(partial.entries.length, 1);
    assert.equal(partial.incomplete, true);
    assert.ok(!JSON.stringify(partial).includes("Permission denied"));

    await fakeDu(`if (!process.argv.includes('--summarize') || process.argv.includes('--all')) process.exit(2); process.stdout.write('12345\\t/tmp\\0'); process.stderr.write("du: cannot read directory '/tmp/systemd-private-test': Permission denied"); process.exitCode = 1;`);
    const tmp = await scanTmp(new AbortController().signal);
    assert.equal(tmp.total, 12345);
    assert.deepEqual(tmp.entries, []);
    assert.equal(tmp.incomplete, true);
    assert.ok(!JSON.stringify(tmp).includes("systemd-private"));
    assert.ok(!JSON.stringify(tmp).includes("Permission denied"));

    await fakeDu(`setInterval(() => {}, 1000);`);
    await assert.rejects(scanHome(fixture, new AbortController().signal, 100), detectLanguage() === "ru" ? /Сканирование заняло/ : /Scan exceeded/);
    const controller = new AbortController();
    const operation = scanHome(fixture, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(operation, { name: "AbortError" });

    await fakeDu(`process.stderr.write('Access denied'); process.exitCode = 1;`);
    const denied = await scanHome(fixture, new AbortController().signal);
    assert.equal(denied.total, undefined);
    assert.deepEqual(denied.entries, []);
    assert.equal(denied.incomplete, true);
    assert.doesNotMatch(JSON.stringify(denied), /Access denied/);

    await fakeDu(`process.stderr.write("du: /private: Permission denied\\n"); process.stderr.write("du: input/output error\\n"); process.exitCode = 1;`);
    await assert.rejects(scanHome(fixture, new AbortController().signal), (error: Error) => {
      assert.match(error.message, /input\/output error/);
      assert.doesNotMatch(error.message, /Permission denied|private/);
      return true;
    });
  } finally { process.env.PATH = originalPath; }
});
