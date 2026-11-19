/** Internal entry point, executed under util-linux flock, never loaded as a Pi extension. */
import { cacheError, cacheFresh, CONTAINER_REFRESH_MS, HOST_REFRESH_MS, readCache, writeCache } from "./cache.ts"
import { readDiskUsage } from "./disk.ts"

const [path, key, scope] = process.argv.slice(2)
if (!path || !/^[a-f0-9]{64}$/.test(key ?? "") || !["host", "container"].includes(scope ?? "")) {
    throw new Error("Invalid disk cache worker arguments")
}
const ttl = scope === "container" ? CONTAINER_REFRESH_MS : HOST_REFRESH_MS
// Critical: check again AFTER flock acquisition. Queued workers use the first
// worker's result instead of sequentially repeating its expensive scan.
const previous = await readCache(path, key)
if (!cacheFresh(previous, ttl) && !cacheError(previous)) {
    try {
        const { containerThresholds: _thresholds, ...usage } = await readDiskUsage()
        if ((usage.scope === "container") !== (scope === "container")) throw new Error("Disk measurement scope changed")
        await writeCache(path, { version: 1, key, measuredAt: Date.now(), usage })
    } catch (error) {
        await writeCache(path, {
            version: 1,
            key,
            measuredAt: previous?.measuredAt,
            usage: previous?.usage,
            error: { at: Date.now(), message: error instanceof Error ? error.message : String(error) },
        })
    }
}
