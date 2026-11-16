import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { t } from "./i18n.ts";
import { isContainer, readContainerUsage } from "./container.ts";

const execFileAsync = promisify(execFile);
export const GB = 1_000_000_000;
export const TOP_COUNT = 20;
export type UsageLevel = "green" | "yellow" | "orange" | "red";
export interface FilesystemUsage {
  source: string;
  type: string;
  mount: string;
  total: number;
  used: number;
  available: number;
}
export interface DiskUsage {
  /** Container usage is a du scan of visible files; total/available are unavailable (0). */
  scope?: "container";
  incomplete?: boolean;
  /** Shared counter metadata only; directory rankings are not cached. */
  measuredAt?: number;
  stale?: boolean;
  containerThresholds?: readonly [number, number, number];
  filesystems: FilesystemUsage[];
  used: number;
  total: number;
  available: number;
}
export interface UsageEntry {
  path: string;
  bytes: number;
  kind?: "directory" | "file" | "symlink" | "other" | "unknown";
}
export interface DirectoryReport {
  root: string;
  total?: number;
  entries: UsageEntry[];
  /** Internal metadata only: expected traversal warnings are not shown in the UI. */
  incomplete: boolean;
}

export function usagePercent(used: number, total: number): number {
  return total > 0 ? used / total * 100 : 0;
}

export function usageLevel(used: number, total: number): UsageLevel {
  const percent = usagePercent(used, total);
  if (percent <= 70) return "green";
  if (percent < 80) return "yellow";
  if (percent <= 90) return "orange";
  return "red";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${bytes} B`;
}

/** Paths/errors are untrusted terminal text, not ANSI or OSC sequences. */
export function safeText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const VIRTUAL_TYPES = new Set([
  "tmpfs", "devtmpfs", "squashfs", "proc", "sysfs", "devpts", "cgroup", "cgroup2",
  "efivarfs", "securityfs", "debugfs", "tracefs", "pstore", "configfs", "fusectl",
  "mqueue", "hugetlbfs", "ramfs", "autofs", "binfmt_misc", "nsfs",
]);

/** GNU df already suppresses bind-mount duplicates. Also deduplicate device aliases. */
export function parseDf(output: string): DiskUsage {
  const filesystems: FilesystemUsage[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n").slice(1)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, source, type, size, used, available, mount] = match;
    // /tmp can itself be a RAM filesystem: keep it, but not /run or /dev/shm.
    const temporaryMount = (type === "tmpfs" || type === "ramfs") &&
      (mount === "/tmp" || mount === "/var/tmp");
    if (VIRTUAL_TYPES.has(type) && !temporaryMount) continue;
    const key = temporaryMount ? `${source}:${mount}` : source;
    if (seen.has(key)) continue;
    seen.add(key);
    filesystems.push({ source, type, mount, total: Number(size), used: Number(used), available: Number(available) });
  }
  if (!filesystems.length) throw new Error(t("df не вернул доступных файловых систем", "df returned no available filesystems"));
  return {
    filesystems,
    used: filesystems.reduce((sum, fs) => sum + fs.used, 0),
    total: filesystems.reduce((sum, fs) => sum + fs.total, 0),
    available: filesystems.reduce((sum, fs) => sum + fs.available, 0),
  };
}

export async function readDiskUsage(signal?: AbortSignal): Promise<DiskUsage> {
  signal?.throwIfAborted();
  if (await isContainer()) return readContainerUsage(signal);
  const { stdout } = await execFileAsync("df", [
    "--local", "--block-size=1", "--output=source,fstype,size,used,avail,target",
  ], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5_000, maxBuffer: 2 * 1024 * 1024, signal });
  return parseDf(stdout);
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Stream NUL records; only the best N entries and one incomplete record stay in memory. */
export class DuCollector {
  readonly root: string;
  readonly limit: number;
  total?: number;
  entries: UsageEntry[] = [];
  private pending = "";

  constructor(root: string, limit = TOP_COUNT) {
    this.root = resolve(root);
    this.limit = limit;
  }

  push(chunk: string): void {
    this.pending += chunk;
    let start = 0;
    let end: number;
    while ((end = this.pending.indexOf("\0", start)) !== -1) {
      this.accept(this.pending.slice(start, end));
      start = end + 1;
    }
    this.pending = this.pending.slice(start);
    if (this.pending.length > 1024 * 1024) throw new Error(t("Слишком длинная запись du", "du record is too long"));
  }

  private accept(record: string): void {
    const tab = record.indexOf("\t");
    if (tab < 1) return;
    const bytes = Number(record.slice(0, tab));
    const path = record.slice(tab + 1);
    if (!Number.isFinite(bytes) || bytes < 0 || !isAbsolute(path)) return;
    if (path === this.root) { this.total = bytes; return; }
    if (!isInside(this.root, path) || this.limit <= 0) return;
    if (path === "/tmp" || isInside("/tmp", path)) return;
    const last = this.entries.at(-1);
    if (this.entries.length >= this.limit && last && bytes <= last.bytes) return;
    this.entries.push({ path, bytes });
    this.entries.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
    if (this.entries.length > this.limit) this.entries.pop();
  }
}

async function runDu(root: string, summary: boolean, signal: AbortSignal, timeoutMs: number, excludes: string[] = []): Promise<DirectoryReport> {
  signal.throwIfAborted();
  const collector = new DuCollector(root, summary ? 0 : TOP_COUNT);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, timeoutMs);
  deadline.unref();
  const args = ["--block-size=1", "--null", "--no-dereference",
    ...(summary ? ["--summarize"] : ["--all", "--exclude=/tmp", "--exclude=/tmp/*"]),
    ...excludes.map((path) => `--exclude=${path}`), "--", root];
  const child = spawn("du", args, { env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    killTimer.unref();
  };
  controller.signal.addEventListener("abort", terminate, { once: true });
  const decoder = new StringDecoder("utf8");
  let stderr = "";
  let stderrLine = "";
  let oversizedStderrLine = false;
  let ignoredWarning = false;
  const stderrDecoder = new StringDecoder("utf8");
  const acceptStderrLine = () => {
    if (/permission denied|access denied|operation not permitted/i.test(stderrLine)) ignoredWarning = true;
    else if (!oversizedStderrLine && stderr.length < 4_096) stderr += (stderrLine + "\n").slice(0, 4_096 - stderr.length);
    stderrLine = "";
    oversizedStderrLine = false;
  };
  const consumeStderr = (text: string) => {
    for (const fragment of text.split(/(?<=\n)/)) {
      if (stderrLine.length + fragment.length > 16_384) oversizedStderrLine = true;
      if (!oversizedStderrLine) stderrLine += fragment;
      if (fragment.endsWith("\n")) acceptStderrLine();
    }
  };
  let streamError: unknown;
  child.stdout.on("data", (data: Buffer) => {
    try { collector.push(decoder.write(data)); }
    catch (error) { streamError = error; controller.abort(); }
  });
  child.stderr.on("data", (data: Buffer) => {
    consumeStderr(stderrDecoder.write(data));
  });
  try {
    const code = await new Promise<number | null>((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", resolveCode);
    });
    if (streamError) throw streamError;
    signal.throwIfAborted();
    if (controller.signal.aborted) throw new Error(t(`Сканирование заняло более ${timeoutMs / 1000} с`, `Scan exceeded ${timeoutMs / 1000} seconds`));
    collector.push(decoder.end());
    consumeStderr(stderrDecoder.end());
    if (stderrLine || oversizedStderrLine) acceptStderrLine();
    if (code !== 0 && collector.total === undefined && !collector.entries.length && !(ignoredWarning && !stderr.trim())) {
      if (/(?:unrecognized|invalid|unknown|illegal) option/i.test(stderr)) {
        throw new Error(t("Для сканирования нужен GNU du (coreutils). Debian/Ubuntu: apt-get install coreutils; Alpine: apk add coreutils.", "Scanning requires GNU du (coreutils). Debian/Ubuntu: apt-get install coreutils; Alpine: apk add coreutils."));
      }
      throw new Error(stderr.trim() || t(`du завершился с кодом ${code}`, `du exited with code ${code}`));
    }
    const entries = await Promise.all(collector.entries.map(async (entry): Promise<UsageEntry> => {
      try {
        const stat = await lstat(entry.path);
        return { ...entry, kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other" };
      } catch { return { ...entry, kind: "unknown" }; }
    }));
    signal.throwIfAborted();
    return {
      root, total: collector.total, entries,
      incomplete: code !== 0,
    };
  } finally {
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", terminate);
  }
}

export async function scanHome(home: string, signal: AbortSignal, timeoutMs = 120_000): Promise<DirectoryReport> {
  const root = await realpath(home);
  if (root === "/tmp" || isInside("/tmp", root)) throw new Error(t("Содержимое /tmp не показывается", "The contents of /tmp are not displayed"));
  return runDu(root, false, signal, timeoutMs);
}

export async function scanContainerRoot(signal: AbortSignal, timeoutMs = 120_000): Promise<DirectoryReport> {
  return runDu("/", true, signal, timeoutMs, ["/proc", "/sys", "/dev", "/run"]);
}

export async function scanTmp(signal: AbortSignal, timeoutMs = 120_000): Promise<DirectoryReport> {
  return runDu("/tmp", true, signal, timeoutMs);
}
