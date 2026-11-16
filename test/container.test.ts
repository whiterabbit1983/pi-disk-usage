import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GB } from "../src/disk.ts";
import { containerHint, containerMounts, filesystemBytes, parseMountInfo, readContainerUsage, containerThresholds, containerUsageLevel } from "../src/container.ts";
import { cleanupAdvice } from "../src/cleanup.ts";

const mountinfo = String.raw`21 1 0:50 / / rw - overlay overlay rw,lowerdir=/host/private/layers
22 21 0:51 / /proc rw - proc proc rw
23 21 0:52 / /dev rw - tmpfs tmpfs rw
24 21 0:53 / /dev/shm rw - tmpfs shm rw
25 21 8:1 /docker/hosts /etc/hosts rw - ext4 /dev/sda1 rw
26 21 8:1 /data /data rw - ext4 /dev/sda1 rw
27 21 8:1 /data /data-bind rw - ext4 /dev/sda1 rw
28 21 8:2 / /home/with\040spaces rw shared:1 - xfs /dev/sdb1 rw
29 21 0:54 / /tmp rw - tmpfs tmpfs rw
30 21 0:55 / /run rw - tmpfs tmpfs rw
31 21 0:56 / /sys rw - sysfs sysfs rw
32 21 0:57 / /path\134with\011tab\012newline rw - tmpfs tmpfs rw
malformed
`;

test("mountinfo parser handles overlay, optional fields, spaces and octal escapes without host-layer paths", () => {
  const mounts = parseMountInfo(mountinfo);
  assert.equal(mounts[0].type, "overlay");
  assert.equal(mounts[0].mount, "/");
  assert.ok(mounts.some(({ mount }) => mount === "/home/with spaces"));
  assert.ok(mounts.some(({ mount }) => mount === "/path\\with\ttab\nnewline"));
  assert.ok(!JSON.stringify(mounts).includes("/host/private"));
  const visible = containerMounts(mounts);
  assert.equal(visible[0].mount, "/");
  assert.deepEqual(visible.map(({ mount }) => mount).sort(), ["/", "/data", "/data-bind", "/etc/hosts", "/home/with spaces", "/tmp", "/path\\with\ttab\nnewline"].sort());
  const stacked = parseMountInfo("1 0 1:1 / /data rw - ext4 old rw\n2 0 2:2 / /data rw - xfs new rw");
  assert.equal(stacked.length, 1);
  assert.equal(stacked[0].source, "new");
});

test("statfs accounting distinguishes used, free and user-available blocks", () => {
  assert.deepEqual(filesystemBytes({ bsize: 4096, blocks: 100, bfree: 40, bavail: 30 }),
    { total: 409600, used: 245760, available: 122880 });
  assert.equal(filesystemBytes({ bsize: 4096, blocks: 100, bfree: 1, bavail: -1 }).available, 0);
});

test("container hints cover Docker cgroup v1/v2, Kubernetes and rootless Podman without assuming overlay means Docker", () => {
  for (const cgroup of ["1:cpu:/docker/abc", "0::/system.slice/docker-a123.scope", "0::/kubepods/besteffort/pod1", "0::/kubepods.slice/kubepods-pod1.slice", "0::/libpod-a123.scope"]) {
    assert.equal(containerHint(cgroup, {}), true, cgroup);
  }
  assert.equal(containerHint("0::/", {}), false);
  assert.equal(containerHint("0::/user.slice/user-1000.slice", {}), false);
  assert.equal(containerHint("", { container: "docker" }), true);
});

test("container thresholds use exact GB boundaries and validate custom values", () => {
  assert.deepEqual(containerThresholds({}), [50, 60, 70]);
  for (const [gb, level] of [[0, "green"], [49.999, "green"], [50, "yellow"], [59.999, "yellow"], [60, "orange"], [69.999, "orange"], [70, "red"], [100, "red"]] as const) {
    assert.equal(containerUsageLevel(gb * GB), level);
  }
  const custom = containerThresholds({ PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB: " 1.5, 2, 3 " });
  assert.equal(containerUsageLevel(1.5 * GB, custom), "yellow");
  assert.equal(containerUsageLevel(3 * GB, custom), "red");
  for (const raw of ["", "1,2", "1,2,3,4", "1,,3", "-1,2,3", "1,1,3", "3,2,1", "NaN,2,3", "1,2,Infinity"]) {
    assert.throws(() => containerThresholds({ PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB: raw }), /PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB/);
  }
});

test("container usage scans visible root with exclusions, preserves partial status and honors cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "container-du-"));
  const path = process.env.PATH;
  try {
    await writeFile(join(dir, "du"), '#!/bin/sh\nprintf "%s\\n" "$@" > "' + join(dir, "args") + '"\nprintf "55000000000\\t/\\000"\nexit 1\n', { mode: 0o755 });
    process.env.PATH = dir;
    const usage = await readContainerUsage();
    assert.equal(usage.scope, "container");
    assert.equal(usage.used, 55 * GB);
    assert.equal(usage.total, 0);
    assert.equal(usage.available, 0);
    assert.deepEqual(usage.filesystems, []);
    assert.equal(usage.incomplete, true);
    const args = await readFile(join(dir, "args"), "utf8");
    for (const option of ["--block-size=1", "--null", "--summarize", "--exclude=/proc", "--exclude=/sys", "--exclude=/dev", "--exclude=/run"]) assert.ok(args.includes(option));
    assert.ok(args.endsWith("--\n/\n"));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readContainerUsage(controller.signal), { name: "AbortError" });
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});

test("container advice assumes neither systemd nor sudo and does not suggest Docker/Podman cleanup through a socket", () => {
  const entries = [".npm", ".docker", ".local/share/containers"].map((path) => ({ path: `/home/test/${path}`, bytes: 1 }));
  const advice = cleanupAdvice("/home/test", entries, false, true);
  assert.equal(advice[0].id, "container");
  for (const id of ["tmp", "journal", "apt", "docker", "podman"]) assert.ok(!advice.some((item) => item.id === id));
  assert.ok(advice.some(({ id }) => id === "npm"));
  assert.ok(!advice.flatMap(({ inspect, clean }) => [...inspect, ...clean]).some((command) => /sudo|systemd|docker|podman/.test(command)));
});
