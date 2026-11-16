/** Run only in a disposable container with private writable /home and /tmp mounts. */
import assert from "node:assert/strict";
import { chmod, mkdir, stat, statfs, writeFile } from "node:fs/promises";
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
  for (let i = 1; i <= 15; i++) {
    await writeFile(`/home/${home}/${home}-${i}`, Buffer.alloc(i * 4096, 1));
  }
}
await chmod("/home/locked", 0);
// Measure as an unprivileged user, not root (which bypasses chmod restrictions).
process.setgid!(65534);
process.setuid!(65534);
const usage = await readDiskUsage();
assert.equal(usage.scope, "container");
assert.equal(usage.total, (await statfs("/")).blocks * (await statfs("/")).bsize);
assert.equal(usage.used, usage.filesystems.find(({ mount }) => mount === "/")!.used);
assert.ok(usage.filesystems.some(({ mount, type }) => mount === "/home" && type === "tmpfs"));
assert.ok(usage.filesystems.some(({ mount }) => mount === "/tmp"));
assert.ok(!usage.filesystems.some(({ mount }) => ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"].includes(mount)));
const devices = await Promise.all(usage.filesystems.map(async ({ mount }) => (await stat(mount)).dev));
assert.equal(new Set(devices).size, devices.length);
const homes = await scanHomes("/home/alice", new AbortController().signal);
assert.deepEqual(homes.roots?.slice().sort(), ["/home/alice", "/home/bob"]);
assert.equal(homes.entries.length, 20);
assert.ok(homes.entries.some(({ path }) => path.startsWith("/home/alice/")));
assert.ok(homes.entries.some(({ path }) => path.startsWith("/home/bob/")));
assert.ok(!homes.entries.some(({ path }) => path.includes("locked")));
assert.equal(homes.incomplete, false);
const advice = cleanupAdvice(homes.root, homes.entries, false, true);
assert.equal(advice[0].id, "container");
assert.ok(!advice.flatMap(({ inspect, clean }) => [...inspect, ...clean]).some((command) => /sudo|systemd/.test(command)));
console.log(`PASS Docker (${detectLanguage()}): overlay/statfs, tmpfs volumes, bind deduplication, unprivileged shared top-20, inaccessible home skipped`);
