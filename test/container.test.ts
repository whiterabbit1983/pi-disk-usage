import assert from "node:assert/strict";
import { test } from "node:test";
import { stat, statfs } from "node:fs/promises";
import { containerHint, containerMounts, filesystemBytes, parseMountInfo, readContainerUsage } from "../src/container.ts";
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

test("container capacity uses only /, lists unique directory filesystems and honors cancellation", async () => {
  const usage = await readContainerUsage();
  const root = usage.filesystems.find(({ mount }) => mount === "/")!;
  const stats = filesystemBytes(await statfs("/"));
  assert.equal(usage.scope, "container");
  assert.equal(usage.total, stats.total);
  assert.equal(usage.total, root.total);
  assert.equal(usage.used, root.used);
  assert.equal(usage.available, root.available);
  const devices: number[] = [];
  for (const filesystem of usage.filesystems) {
    const metadata = await stat(filesystem.mount);
    assert.ok(metadata.isDirectory());
    devices.push(metadata.dev);
  }
  assert.equal(devices.length, new Set(devices).size);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readContainerUsage(controller.signal), { name: "AbortError" });
});

test("container advice assumes neither systemd nor sudo and does not suggest Docker/Podman cleanup through a socket", () => {
  const entries = [".npm", ".docker", ".local/share/containers"].map((path) => ({ path: `/home/test/${path}`, bytes: 1 }));
  const advice = cleanupAdvice("/home/test", entries, false, true);
  assert.equal(advice[0].id, "container");
  for (const id of ["tmp", "journal", "apt", "docker", "podman"]) assert.ok(!advice.some((item) => item.id === id));
  assert.ok(advice.some(({ id }) => id === "npm"));
  assert.ok(!advice.flatMap(({ inspect, clean }) => [...inspect, ...clean]).some((command) => /sudo|systemd|docker|podman/.test(command)));
});
