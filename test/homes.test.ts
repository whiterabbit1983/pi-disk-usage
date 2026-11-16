import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanHome } from "../src/disk.ts";
import { accessibleHomes, scanHomes } from "../src/homes.ts";

const fixture = await mkdtemp(join(process.cwd(), ".homes-test-"));
after(async () => { await rm(fixture, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;

test("home discovery deduplicates current home, overlaps and aliases; skips symlinks and missing /home", async () => {
  const homes = join(fixture, "discovery");
  const alice = join(homes, "alice");
  const bob = join(homes, "bob");
  await mkdir(join(alice, "nested"), { recursive: true });
  await mkdir(bob);
  await writeFile(join(homes, "not-a-directory"), "text");
  await symlink("/tmp", join(homes, "tmp-alias"));
  const alias = join(fixture, "alice-alias");
  await symlink(alice, alias);
  assert.deepEqual((await accessibleHomes(alias, signal(), homes)).sort(), [alice, bob].sort());
  assert.deepEqual((await accessibleHomes(join(alice, "nested"), signal(), homes)).sort(), [alice, bob].sort());
  assert.deepEqual(await accessibleHomes(alice, signal(), join(fixture, "missing")), [alice]);
  assert.deepEqual(await accessibleHomes("/tmp", signal(), join(fixture, "missing")), []);
});

test("each accessible home keeps its own top-20, including current home outside /home", async () => {
  const homes = join(fixture, "ranking");
  const own = join(fixture, "root-home");
  const alice = join(homes, "alice");
  const bob = join(homes, "bob");
  for (const root of [own, alice, bob]) await mkdir(join(root, ".cache"), { recursive: true });
  for (let i = 1; i <= 25; i++) {
    await writeFile(join(alice, ".cache", `alice-${i}`), Buffer.alloc(i * 4096, 1));
    await writeFile(join(bob, ".cache", `bob-${i}`), Buffer.alloc((i + 1) * 4096, 1));
  }
  await writeFile(join(own, "own-large-file"), Buffer.alloc(200_000, 1));
  const report = await scanHomes(own, signal(), 120_000, homes);
  assert.deepEqual(report.directories.map(({ root }) => root).sort(), [own, alice, bob].sort());
  for (const directory of report.directories) {
    assert.equal(directory.entries.length, directory.root === own ? 2 : 20);
    assert.equal(new Set(directory.entries.map(({ path }) => path)).size, directory.entries.length);
    assert.ok(directory.entries.every(({ path }) => path.startsWith(`${directory.root}/`)));
    assert.ok(directory.entries.every((entry, i, all) => i === 0 || all[i - 1].bytes >= entry.bytes));
    assert.deepEqual(directory, await scanHome(directory.root, signal()));
  }
  assert.equal(report.directories.flatMap(({ entries }) => entries).length, 42);
  const individual = await Promise.all([own, alice, bob].map((root) => scanHome(root, signal())));
  assert.equal(report.total, individual.reduce((sum, item) => sum + item.total!, 0));
  assert.equal(report.incomplete, false);
  const dedup = await scanHomes(alice, signal(), 120_000, homes);
  assert.deepEqual(dedup.directories.map(({ root }) => root).sort(), [alice, bob].sort());
});

test("unreadable homes and denied /home listings are silently skipped", { skip: process.getuid?.() === 0 }, async () => {
  const homes = join(fixture, "permissions");
  const own = join(fixture, "accessible-own");
  const locked = join(homes, "locked");
  await mkdir(locked, { recursive: true });
  await mkdir(own);
  await writeFile(join(own, "file"), Buffer.alloc(4096, 1));
  await writeFile(join(locked, "secret"), Buffer.alloc(8192, 1));
  await chmod(locked, 0);
  try {
    const report = await scanHomes(own, signal(), 120_000, homes);
    assert.deepEqual(report.directories.map(({ root }) => root), [own]);
    assert.ok(report.directories.flatMap(({ entries }) => entries).every(({ path }) => !path.startsWith(locked)));
    await chmod(homes, 0);
    try { assert.deepEqual(await accessibleHomes(own, signal(), homes), [own]); }
    finally { await chmod(homes, 0o755); }
  } finally { await chmod(locked, 0o755); }
});

test("permission revoked after discovery is silently skipped while other homes still contribute", async () => {
  const homes = join(fixture, "revoked-homes");
  const revoked = join(homes, "revoked");
  const allowed = join(homes, "allowed");
  const bin = join(fixture, "fake-bin");
  for (const path of [revoked, allowed, bin]) await mkdir(path, { recursive: true });
  const du = join(bin, "du");
  await writeFile(du, `#!${process.execPath}\nconst root = process.argv.at(-1);\nif (root.endsWith("/revoked")) { process.stderr.write("du: Permission denied"); process.exitCode = 1; }\nelse process.stdout.write("4096\\t" + root + "/file\\0" + "8192\\t" + root + "\\0");\n`);
  await chmod(du, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const report = await scanHomes(allowed, signal(), 120_000, homes);
    assert.deepEqual(report.directories.map(({ root }) => root), [allowed]);
    assert.equal(report.directories[0].entries.length, 1);
    assert.equal(report.total, 8192);
    assert.equal(report.incomplete, true);
    assert.ok(!JSON.stringify(report).includes("Permission denied"));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("per-directory scans propagate cancellation and missing du rather than hiding a tool failure", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanHomes(fixture, controller.signal), { name: "AbortError" });
  const originalPath = process.env.PATH;
  const emptyBin = join(fixture, "empty-bin");
  await mkdir(emptyBin);
  process.env.PATH = emptyBin;
  try {
    await assert.rejects(scanHomes(fixture, signal(), 120_000, join(fixture, "missing")), { code: "ENOENT" });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
