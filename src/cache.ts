import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readlink, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { containerThresholds, isContainer } from "./container.ts";
import type { DiskUsage } from "./disk.ts";
import { t } from "./i18n.ts";

export const HOST_REFRESH_MS = 3 * 60_000;
export const CONTAINER_REFRESH_MS = 10 * 60_000;
const ERROR_TTL_MS = 5_000;
export interface CacheRecord {
  version: 1;
  key: string;
  measuredAt?: number;
  usage?: DiskUsage;
  error?: { at: number; message: string };
}

const bytes = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function validUsage(value: unknown): value is DiskUsage {
  if (!value || typeof value !== "object") return false;
  const u = value as DiskUsage;
  return (u.scope === undefined || u.scope === "container") && bytes(u.used) && bytes(u.total) && bytes(u.available) &&
    (u.incomplete === undefined || typeof u.incomplete === "boolean") && Array.isArray(u.filesystems) && u.filesystems.every((fs) =>
      fs && typeof fs.source === "string" && typeof fs.mount === "string" && typeof fs.type === "string" &&
      bytes(fs.used) && bytes(fs.total) && bytes(fs.available));
}

export async function readCache(path: string, key: string): Promise<CacheRecord | undefined> {
  try {
    if ((await stat(path)).size > 2 * 1024 * 1024) return;
    const r = JSON.parse(await readFile(path, "utf8")) as CacheRecord;
    if (!r || typeof r !== "object" || r.version !== 1 || r.key !== key ||
        (r.usage !== undefined && (!validUsage(r.usage) || !bytes(r.measuredAt))) ||
        (r.error !== undefined && (!r.error || !bytes(r.error.at) || typeof r.error.message !== "string"))) return;
    return r;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function cacheFresh(record: CacheRecord | undefined, ttl: number, now = Date.now()): boolean {
  return Boolean(record?.usage && record.measuredAt !== undefined && now >= record.measuredAt && now - record.measuredAt < ttl);
}
export function cacheError(record: CacheRecord | undefined, now = Date.now()): string | undefined {
  if (record?.error && now >= record.error.at && now - record.error.at < ERROR_TTL_MS) return record.error.message;
}

export async function writeCache(path: string, record: CacheRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.uid !== process.geteuid!() || (metadata.mode & 0o077) !== 0) {
    throw new Error(t("Небезопасный каталог кэша диска", "Unsafe disk cache directory"));
  }
  return path;
}

export function environmentKey(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function cacheLocation(container: boolean): Promise<{ path: string; key: string }> {
  const uid = process.geteuid!();
  const root = await stat("/");
  // Fail closed when Linux namespace identity is unavailable: do not mix environments.
  const identity = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink("/proc/self/ns/mnt"), readlink("/proc/self/ns/user"), readlink("/proc/self/ns/pid"),
  ]);
  const key = environmentKey([1, container, process.getuid!(), uid, process.getgid!(), process.getegid!(), process.getgroups!().sort((a, b) => a - b), root.dev, root.ino, ...identity]);
  let base = tmpdir();
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) {
    const metadata = await lstat(runtime).catch(() => undefined);
    if (metadata?.isDirectory() && metadata.uid === uid && (metadata.mode & 0o077) === 0) base = runtime;
  }
  const directory = await privateDirectory(join(base, `pi-disk-usage-${uid}`));
  return { path: join(directory, `${key}.json`), key };
}

/** The kernel owns the lock. The independent timeout kills the entire worker group,
 * including du, even if the requesting Pi is killed or its event loop is stuck. */
function startWorker(path: string, key: string, container: boolean, signal?: AbortSignal): Promise<void> {
  const env = { ...process.env };
  delete env.PI_DISK_USAGE_CONTAINER_THRESHOLDS_GB; // Colors are local, never shared.
  return new Promise((resolve, reject) => {
    const child = spawn("timeout", ["--signal=KILL", "140s", "flock", "--exclusive", "--timeout", "130",
      "--conflict-exit-code", "75", `${path}.lock`, process.execPath,
      fileURLToPath(new URL("./cache-worker.ts", import.meta.url)), path, key, container ? "container" : "host"],
    { detached: true, env, stdio: "ignore" });
    const detach = () => child.unref();
    signal?.addEventListener("abort", detach, { once: true });
    if (signal?.aborted) detach();
    child.once("error", (error) => reject(new Error(`${t("Не удалось запустить общий счётчик (нужны timeout и flock)", "Could not start shared measurement (timeout and flock are required)")}: ${error.message}`)));
    child.once("close", (code) => {
      signal?.removeEventListener("abort", detach);
      if (code === 0) resolve();
      else reject(new Error(`${t("Общий счётчик завершился с ошибкой; проверьте GNU timeout и util-linux flock", "Shared measurement failed; check GNU timeout and util-linux flock")} (${code})`));
    });
    // Keep the caller alive while subscribed, but never kill the shared worker
    // when a report is closed or one Pi shuts down.
  });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readSharedDiskUsage(signal?: AbortSignal, onStale?: (usage: DiskUsage) => void): Promise<DiskUsage> {
  signal?.throwIfAborted();
  const container = await isContainer();
  const thresholds = container ? containerThresholds() : undefined;
  const { path, key } = await cacheLocation(container);
  signal?.throwIfAborted();
  const decorate = (record: CacheRecord, stale = false): DiskUsage => ({
    ...record.usage!, containerThresholds: thresholds, measuredAt: record.measuredAt, stale,
  });
  const ttl = container ? CONTAINER_REFRESH_MS : HOST_REFRESH_MS;
  let record = await readCache(path, key);
  if (cacheFresh(record, ttl) && !cacheError(record)) return decorate(record!);
  if (record?.usage) onStale?.(decorate(record, true));
  const error = cacheError(record);
  if (error) throw new Error(error);
  // Pre-create the permanent lock inode privately. Never unlink it: flock waiters
  // must always refer to the same inode, including after crashes and timeouts.
  const lock = await open(`${path}.lock`, "a", 0o600);
  await lock.close();
  signal?.throwIfAborted();
  await abortable(startWorker(path, key, container, signal), signal);
  signal?.throwIfAborted();
  record = await readCache(path, key);
  const failure = cacheError(record);
  if (failure) throw new Error(failure);
  if (!cacheFresh(record, ttl)) throw new Error(t("Общий счётчик не вернул свежих данных", "Shared measurement returned no fresh data"));
  return decorate(record!);
}
