import { access, readFile, stat, statfs } from "node:fs/promises";
import type { DiskUsage, FilesystemUsage } from "./disk.ts";
import { t } from "./i18n.ts";

export interface MountInfo {
  device: string;
  mount: string;
  type: string;
  source: string;
}

const PSEUDO_TYPES = new Set([
  "proc", "sysfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "mqueue", "hugetlbfs",
  "securityfs", "debugfs", "tracefs", "pstore", "configfs", "fusectl", "autofs", "nsfs",
  "efivarfs", "binfmt_misc", "squashfs",
]);
const decodeMountPath = (path: string) => path.replace(/\\(040|011|012|134)/g,
  (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** mountinfo uses octal escapes, not shell escaping; never inspect overlay's host paths. */
export function parseMountInfo(text: string): MountInfo[] {
  const mounts = new Map<string, MountInfo>();
  for (const line of text.split("\n")) {
    const [before, after] = line.split(" - ");
    if (!before || !after) continue;
    const fields = before.split(" ");
    const fs = after.split(" ");
    if (fields.length < 6 || fs.length < 3 || !/^\d+:\d+$/.test(fields[2])) continue;
    const mount = decodeMountPath(fields[4]);
    if (!mount.startsWith("/")) continue;
    mounts.set(mount, { device: fields[2], mount, type: fs[0], source: decodeMountPath(fs[1]) });
  }
  return [...mounts.values()];
}

export function containerHint(cgroup: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.container) || /(?:\/docker\/|docker-[\da-f]+\.scope|\/kubepods[/.]|\/containerd\/|\/libpod-|libpod-[\da-f]+\.scope|\/lxc\/)/i.test(cgroup);
}

export async function isContainer(): Promise<boolean> {
  const markers = await Promise.all(["/.dockerenv", "/run/.containerenv"].map(async (path) => {
    try { await access(path); return true; } catch { return false; }
  }));
  if (markers.some(Boolean)) return true;
  const cgroup = await readFile("/proc/1/cgroup", "utf8").catch(() => "");
  return containerHint(cgroup);
}

export function containerMounts(mounts: MountInfo[]): MountInfo[] {
  return mounts.filter(({ mount, type }) => mount === "/" || (
    !PSEUDO_TYPES.has(type) &&
    !["/proc", "/sys", "/dev", "/run"].some((path) => mount === path || mount.startsWith(`${path}/`))
  )).sort((a, b) => a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount));
}

/** Used = blocks - bfree, NOT blocks - bavail (which includes reserved space). */
export function filesystemBytes(stats: { bsize: number; blocks: number; bfree: number; bavail: number }) {
  return {
    total: stats.blocks * stats.bsize,
    used: (stats.blocks - stats.bfree) * stats.bsize,
    available: Math.max(0, stats.bavail * stats.bsize),
  };
}

/** In a container, only / contributes to the indicator; volumes are shown separately. */
export async function readContainerUsage(signal?: AbortSignal): Promise<DiskUsage> {
  signal?.throwIfAborted();
  const mountinfo = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  const mounts = containerMounts(parseMountInfo(mountinfo));
  if (!mounts.some(({ mount }) => mount === "/")) {
    mounts.unshift({ device: "", source: "/", type: "unknown", mount: "/" });
  }
  const filesystems: FilesystemUsage[] = [];
  const seen = new Set<number>();
  for (const mount of mounts) {
    signal?.throwIfAborted();
    try {
      const metadata = await stat(mount.mount);
      // Exclude Docker's /etc/hosts, /etc/hostname, /etc/resolv.conf and other file binds.
      if (!metadata.isDirectory() || seen.has(metadata.dev)) continue;
      const stats = await statfs(mount.mount);
      signal?.throwIfAborted();
      filesystems.push({ source: mount.source, type: mount.type, mount: mount.mount, ...filesystemBytes(stats) });
      seen.add(metadata.dev);
    } catch (error) {
      signal?.throwIfAborted();
      // An inaccessible/disappearing volume must not hide the root filesystem.
      if (mount.mount === "/") throw error;
    }
  }
  const root = filesystems.find(({ mount }) => mount === "/");
  if (!root) throw new Error(t("Корневая файловая система контейнера недоступна", "Container root filesystem is unavailable"));
  return { filesystems, used: root.used, total: root.total, available: root.available, scope: "container" };
}
