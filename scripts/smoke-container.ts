/** Run only in a disposable container with private writable /home and /tmp mounts. */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isContainer } from "../src/container.ts";
import { readDiskUsage } from "../src/disk.ts";
import { scanHomes } from "../src/homes.ts";
import { detectLanguage } from "../src/i18n.ts";
import { cleanupAdvice } from "../src/cleanup.ts";

assert.equal(process.env.PI_DISK_USAGE_CONTAINER_SMOKE, "1", "Opt in only inside a disposable test container");
assert.equal(await isContainer(), true);
assert.equal(process.getuid?.(), 0, "Start as container root to prepare permission fixtures");
for (const home of ["alice", "bob", "locked"]) {
  await mkdir(`/home/${home}`, { recursive: true, mode: 0o755 });
  for (let i = 1; i <= 25; i++) {
    await writeFile(`/home/${home}/${home}-${i}`, Buffer.alloc(i * 4096, 1));
  }
}
await chmod("/home/locked", 0);
// Measure as an unprivileged user, not root (which bypasses chmod restrictions).
process.setgid!(65534);
process.setuid!(65534);
const usage = await readDiskUsage();
assert.equal(usage.scope, "container");
assert.ok(usage.used > 0);
assert.equal(usage.total, 0);
assert.equal(usage.available, 0);
assert.deepEqual(usage.filesystems, []);
assert.equal(usage.incomplete, true, "Unreadable homes must be marked as partial");
const homes = await scanHomes("/home/alice", new AbortController().signal);
assert.deepEqual(homes.directories.map(({ root }) => root).sort(), ["/home/alice", "/home/bob"]);
for (const directory of homes.directories) {
  assert.equal(directory.entries.length, 20);
  assert.ok(directory.entries.every(({ path }) => path.startsWith(`${directory.root}/`)));
}
assert.equal(homes.directories.flatMap(({ entries }) => entries).length, 40);
assert.ok(!homes.directories.some(({ root }) => root.includes("locked")));
assert.equal(homes.incomplete, false);
const advice = cleanupAdvice(homes.root, homes.directories.find(({ root }) => root === homes.root)!.entries, false, true);
assert.equal(advice[0].id, "container");
assert.ok(!advice.flatMap(({ inspect, clean }) => [...inspect, ...clean]).some((command) => /sudo|systemd/.test(command)));
console.log(`PASS Docker (${detectLanguage()}): visible-root du usage, partial scan, unprivileged top-20 per home, inaccessible home skipped`);
