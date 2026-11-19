import { constants } from "node:fs"
import { access, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { isInside, scanHome, type DirectoryReport } from "./disk.ts"
import { t } from "./i18n.ts"

/** Discover readable/searchable homes; directory symlinks under /home are not followed. */
export async function accessibleHomes(home: string, signal: AbortSignal, homesDirectory = "/home"): Promise<string[]> {
    signal.throwIfAborted()
    const children = await readdir(homesDirectory, { withFileTypes: true }).catch(() => [])
    const candidates = [
        home,
        ...children.filter((entry) => entry.isDirectory()).map((entry) => join(homesDirectory, entry.name)),
    ]
    const roots = new Set<string>()
    for (const candidate of candidates) {
        signal.throwIfAborted()
        try {
            const root = await realpath(candidate)
            if (root === "/tmp" || isInside("/tmp", root)) continue
            await access(root, constants.R_OK | constants.X_OK)
            roots.add(root)
        } catch {
            /* Unreadable, vanished or otherwise inaccessible homes are silently skipped. */
        }
    }
    signal.throwIfAborted()
    // Prefer an ancestor if the current home overlaps one of /home's directories.
    return [...roots]
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .filter((root, _index, all) => !all.some((parent) => isInside(parent, root)))
}

export interface HomesReport {
    /** Canonical home of the current user, used for ~ paths and own-cache advice. */
    root: string
    directories: DirectoryReport[]
    total?: number
    incomplete: boolean
}

/** Keep a separate bounded top-20 per accessible home, with one overall deadline. */
export async function scanHomes(
    home: string,
    signal: AbortSignal,
    timeoutMs = 120_000,
    homesDirectory = "/home",
): Promise<HomesReport> {
    const started = Date.now()
    const roots = await accessibleHomes(home, signal, homesDirectory)
    const directories: DirectoryReport[] = []
    let total = 0
    let hasTotal = false
    let incomplete = false
    for (const root of roots) {
        signal.throwIfAborted()
        const remaining = timeoutMs - (Date.now() - started)
        if (remaining <= 0)
            throw new Error(t("Истекло время сканирования домашних каталогов", "Home-directory scan timed out"))
        try {
            const report = await scanHome(root, signal, remaining)
            if (report.incomplete && report.total === undefined && !report.entries.length) {
                incomplete = true
                continue
            }
            directories.push(report)
            if (report.total !== undefined) {
                total += report.total
                hasTotal = true
            }
            incomplete ||= report.incomplete
        } catch (error) {
            signal.throwIfAborted()
            const code = (error as NodeJS.ErrnoException)?.code
            if ((error as NodeJS.ErrnoException)?.syscall?.startsWith("spawn")) throw error
            if (
                code === "EACCES" ||
                code === "EPERM" ||
                code === "ENOENT" ||
                /permission denied|access denied|operation not permitted|no such file or directory/i.test(String(error))
            ) {
                // Access can be revoked after discovery; never surface permission errors for a home.
                incomplete = true
                continue
            }
            throw error
        }
    }
    signal.throwIfAborted()
    const currentHome = await realpath(home).catch(() => home)
    signal.throwIfAborted()
    return { root: currentHome, directories, total: hasTotal ? total : undefined, incomplete }
}
