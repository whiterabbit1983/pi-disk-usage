import { access, readFile } from "node:fs/promises"
import { GB, scanContainerRoot, type DiskUsage, type UsageLevel } from "./disk.ts"
import { t } from "./i18n.ts"

export interface MountInfo {
    device: string
    mount: string
    type: string
    source: string
}

const PSEUDO_TYPES = new Set([
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "cgroup",
    "cgroup2",
    "mqueue",
    "hugetlbfs",
    "securityfs",
    "debugfs",
    "tracefs",
    "pstore",
    "configfs",
    "fusectl",
    "autofs",
    "nsfs",
    "efivarfs",
    "binfmt_misc",
    "squashfs",
])
const decodeMountPath = (path: string) =>
    path.replace(/\\(040|011|012|134)/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))

/** mountinfo uses octal escapes, not shell escaping; never inspect overlay's host paths. */
export function parseMountInfo(text: string): MountInfo[] {
    const mounts = new Map<string, MountInfo>()
    for (const line of text.split("\n")) {
        const [before, after] = line.split(" - ")
        if (!before || !after) continue
        const fields = before.split(" ")
        const fs = after.split(" ")
        if (fields.length < 6 || fs.length < 3 || !/^\d+:\d+$/.test(fields[2])) continue
        const mount = decodeMountPath(fields[4])
        if (!mount.startsWith("/")) continue
        mounts.set(mount, { device: fields[2], mount, type: fs[0], source: decodeMountPath(fs[1]) })
    }
    return [...mounts.values()]
}

export function containerHint(cgroup: string, env: NodeJS.ProcessEnv = process.env): boolean {
    return (
        Boolean(env.container) ||
        /(?:\/docker\/|docker-[\da-f]+\.scope|\/kubepods[/.]|\/containerd\/|\/libpod-|libpod-[\da-f]+\.scope|\/lxc\/)/i.test(
            cgroup,
        )
    )
}

export async function isContainer(): Promise<boolean> {
    const markers = await Promise.all(
        ["/.dockerenv", "/run/.containerenv"].map(async (path) => {
            try {
                await access(path)
                return true
            } catch {
                return false
            }
        }),
    )
    if (markers.some(Boolean)) return true
    const cgroup = await readFile("/proc/1/cgroup", "utf8").catch(() => "")
    return containerHint(cgroup)
}

export function containerMounts(mounts: MountInfo[]): MountInfo[] {
    return mounts
        .filter(
            ({ mount, type }) =>
                mount === "/" ||
                (!PSEUDO_TYPES.has(type) &&
                    !["/proc", "/sys", "/dev", "/run"].some((path) => mount === path || mount.startsWith(`${path}/`))),
        )
        .sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount)))
}

/** Used = blocks - bfree, NOT blocks - bavail (which includes reserved space). */
export function filesystemBytes(stats: { bsize: number; blocks: number; bfree: number; bavail: number }) {
    return {
        total: stats.blocks * stats.bsize,
        used: (stats.blocks - stats.bfree) * stats.bsize,
        available: Math.max(0, stats.bavail * stats.bsize),
    }
}

export const DEFAULT_CONTAINER_THRESHOLDS = [50, 60, 70] as const

/** Decimal GB; invalid settings fail explicitly instead of silently changing colors. */
export function containerThresholds(env: NodeJS.ProcessEnv = process.env): readonly [number, number, number] {
    const raw = env.PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB
    if (raw === undefined) return DEFAULT_CONTAINER_THRESHOLDS
    const parts = raw.split(",").map((part) => part.trim())
    const values = parts.map(Number)
    if (
        parts.length !== 3 ||
        parts.some((part) => !part) ||
        values.some((value) => !Number.isFinite(value) || value < 0) ||
        !(values[0] < values[1] && values[1] < values[2])
    ) {
        throw new Error(
            t(
                "PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB: нужны три возрастающих неотрицательных числа, например 50,60,70",
                "PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB: expected three increasing nonnegative numbers, e.g. 50,60,70",
            ),
        )
    }
    return values as [number, number, number]
}

export function containerUsageLevel(
    used: number,
    thresholds = DEFAULT_CONTAINER_THRESHOLDS as readonly [number, number, number],
): UsageLevel {
    if (used >= thresholds[2] * GB) return "red"
    if (used >= thresholds[1] * GB) return "orange"
    if (used >= thresholds[0] * GB) return "yellow"
    return "green"
}

/** Visible allocated blocks, including mounts; never host backing-store capacity. */
export async function readContainerUsage(signal?: AbortSignal): Promise<DiskUsage> {
    signal?.throwIfAborted()
    const thresholds = containerThresholds()
    const report = await scanContainerRoot(signal ?? new AbortController().signal)
    if (report.total === undefined) throw new Error(t("du не вернул размер /", "du returned no size for /"))
    return {
        scope: "container",
        used: report.total,
        incomplete: report.incomplete,
        containerThresholds: thresholds,
        total: 0,
        available: 0,
        filesystems: [],
    }
}
