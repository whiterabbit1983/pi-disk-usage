import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent"
import {
    MouseRegion,
    parseColor,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type TUI,
    type TuiMouseEvent,
    type TuiMouseEventResult,
} from "@earendil-works/pi-tui"
import { readSharedDiskUsage } from "./cache.ts"
import { cleanupAdvice, supportsTmpfilesDryRun } from "./cleanup.ts"
import { t } from "./i18n.ts"
import { containerUsageLevel } from "./container.ts"
import { scanHomes, type HomesReport } from "./homes.ts"
import {
    formatBytes,
    isInside,
    safeText,
    scanTmp,
    usageLevel,
    usagePercent,
    type DirectoryReport,
    type DiskUsage,
} from "./disk.ts"

const COLORS = {
    green: parseColor("#22c55e"),
    yellow: parseColor("#facc15"),
    orange: parseColor("#ff9800"),
    red: parseColor("#ef4444"),
}
const USAGE_ICONS = { green: "✅", yellow: "👀", orange: "⚠️", red: "🚨" }
export interface IndicatorState {
    usage?: DiskUsage
}
export function coloredUsage(theme: Theme, usage: DiskUsage): string {
    const container = usage.scope === "container"
    const level = container
        ? containerUsageLevel(usage.used, usage.containerThresholds)
        : usageLevel(usage.used, usage.total)
    const text = container
        ? `${t("Контейнер /: занято", "Container /: used")} ${formatBytes(usage.used)}${usage.incomplete ? t(" (неполные данные)", " (partial scan)") : ""}`
        : `${t("Диск: занято", "Disk: used")} ${usagePercent(usage.used, usage.total).toFixed(1)}% · ${formatBytes(usage.used)} / ${formatBytes(usage.total)}`
    return theme.style(
        `${USAGE_ICONS[level]} ${text}` + (usage.stale ? t(" (предыдущее измерение)", " (previous measurement)") : ""),
        {
            fg: COLORS[level],
            bold: true,
        },
    )
}

export function createIndicator(theme: Theme, state: () => IndicatorState, open: () => void): Component {
    let clickableWidth = 0
    return new MouseRegion(
        {
            render(width) {
                const current = state()
                const text = current.usage
                    ? coloredUsage(theme, current.usage)
                    : theme.fg("dim", t("Диск: --", "Disk: --"))
                clickableWidth = Math.min(width, visibleWidth(text))
                const hint = theme.fg("dim", t("  [клик / /disk]", "  [click / /disk]"))
                return [truncateToWidth(text + hint, width)]
            },
            invalidate() {},
        },
        (event) => {
            if (event.type === "click" && event.button === "left" && event.y === 0 && event.x < clickableWidth) {
                open()
                return { handled: true }
            }
            return undefined
        },
    )
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** A read-only report with a bounded viewport; no file deletion actions. */
export class DiskReport implements Component {
    readonly capturesViewportInput = true
    private tui: TUI
    private theme: Theme
    private keys: KeybindingsManager
    private done: () => void
    private homePath: string
    private publish: (usage: DiskUsage) => void
    private usage?: DiskUsage
    private diskError?: string
    private home?: HomesReport
    private tmp?: DirectoryReport
    private homeError?: string
    private tmpError?: string
    private controller?: AbortController
    private disposed = false
    private offset = 0
    private pageSize = 1
    private contentLength = 0
    private width = 0
    private adviceStart = 0
    private tmpfilesDryRun = false

    constructor(
        tui: TUI,
        theme: Theme,
        keys: KeybindingsManager,
        done: () => void,
        homePath: string,
        initial: DiskUsage | undefined,
        publish: (usage: DiskUsage) => void,
    ) {
        this.tui = tui
        this.theme = theme
        this.keys = keys
        this.done = done
        this.homePath = homePath
        this.usage = initial
        this.publish = publish
    }

    refresh(): void {
        if (this.disposed) return
        this.controller?.abort()
        const controller = new AbortController()
        this.controller = controller
        this.home = this.tmp = undefined
        this.homeError = this.tmpError = this.diskError = undefined
        this.offset = 0
        const active = () => !this.disposed && this.controller === controller && !controller.signal.aborted
        const load = async <T>(
            operation: Promise<T>,
            success: (value: T) => void,
            failure: (error: string) => void,
        ) => {
            try {
                const result = await operation
                if (active()) success(result)
            } catch (error) {
                if (active()) failure(errorMessage(error))
            } finally {
                if (active()) this.tui.requestRender()
            }
        }
        void load(
            supportsTmpfilesDryRun(controller.signal),
            (supported) => {
                this.tmpfilesDryRun = supported
            },
            () => {},
        )
        void load(
            readSharedDiskUsage(controller.signal, (previous) => {
                if (!active()) return
                this.usage = previous
                this.publish(previous)
                this.tui.requestRender()
            }),
            (usage) => {
                this.usage = usage
                this.publish(usage)
            },
            (error) => {
                this.diskError = error
            },
        )
        void load(
            scanHomes(this.homePath, controller.signal),
            (report) => {
                this.home = report
            },
            (error) => {
                this.homeError = error
            },
        )
        void load(
            scanTmp(controller.signal),
            (report) => {
                this.tmp = report
            },
            (error) => {
                this.tmpError = error
            },
        )
        this.tui.requestRender()
    }

    private content(width: number): string[] {
        const th = this.theme
        const lines: string[] = []
        const add = (text: string) => lines.push(...wrapTextWithAnsi(text, Math.max(1, width)))
        if (this.usage) {
            add(coloredUsage(th, this.usage))
            if (this.usage.scope !== "container")
                add(
                    `${t("Всего", "Total")}: ${formatBytes(this.usage.total)} · ${t("доступно", "available")}: ${formatBytes(this.usage.available)}`,
                )
        }
        if (this.usage?.scope === "container") {
            add(
                th.fg(
                    "dim",
                    t(
                        "du: занятые блоки видимых файлов /, включая тома и /tmp; исключены /proc, /sys, /dev и /run. Это не размер записываемого слоя Docker. Недоступные файлы не учитываются.",
                        "du: allocated blocks of visible files under /, including volumes and /tmp; excludes /proc, /sys, /dev and /run. This is not the Docker writable-layer size. Inaccessible files are not counted.",
                    ),
                ),
            )
        }
        if (this.diskError)
            add(
                th.fg(
                    "warning",
                    `${t("Статистика диска", "Disk statistics")}: ${safeText(this.diskError)} (${t("предыдущее значение, если есть", "previous value, if available")})`,
                ),
            )
        if (!this.usage && !this.diskError)
            add(t("Получение статистики файловых систем…", "Loading filesystem statistics…"))
        lines.push("")
        add(th.fg("accent", t("/tmp — только общий размер", "/tmp — total size only")))
        if (this.tmp) {
            add(
                `/tmp: ${this.tmp.total === undefined ? "?" : formatBytes(this.tmp.total)} (${this.usage?.scope === "container" ? t("может находиться на отдельном томе или tmpfs", "may reside on a separate volume or tmpfs") : t("уже входит в счётчик диска", "already included in disk usage")})`,
            )
        } else
            add(
                this.tmpError
                    ? th.fg("warning", safeText(this.tmpError))
                    : t("Подсчёт /tmp… содержимое не выводится.", "Measuring /tmp… contents are not displayed."),
            )
        const tmpAdvice = cleanupAdvice(this.homePath, [], this.tmpfilesDryRun, this.usage?.scope === "container")[0]
        add(
            th.fg(
                "dim",
                t(
                    "Автоочистки нет. Команды выполняются только вручную после проверки.",
                    "No automatic cleanup. Run commands manually only after inspection.",
                ),
            ),
        )
        for (const command of tmpAdvice.inspect) add(`${t("Проверка", "Inspect")}: ${command}`)
        for (const command of tmpAdvice.clean) add(`${t("После проверки", "After inspection")}: ${command}`)
        add(th.fg("dim", tmpAdvice.caution))
        lines.push("")
        add(
            th.fg(
                "accent",
                t(
                    "Топ-20 файлов и папок отдельно по домашним каталогам",
                    "Top 20 files and directories per home directory",
                ),
            ),
        )
        if (this.home) {
            add(
                `${t("Всего в доступных домашних каталогах", "Accessible home directories total")}: ${this.home.total === undefined ? "?" : formatBytes(this.home.total)}`,
            )
            if (!this.home.directories.length)
                add(t("Нет доступных файлов и папок.", "No accessible files or directories."))
            for (const directory of this.home.directories) {
                lines.push("")
                add(
                    th.fg(
                        "accent",
                        `${t("Топ-20", "Top 20")}: ${safeText(directory.root)}${directory.root === this.home.root ? " (~)" : ""}`,
                    ),
                )
                add(
                    `${t("Размер каталога", "Directory size")}: ${directory.total === undefined ? "?" : formatBytes(directory.total)}`,
                )
                if (!directory.entries.length)
                    add(t("Нет доступных файлов и папок.", "No accessible files or directories."))
                for (const [index, entry] of directory.entries.entries()) {
                    const path = isInside(this.home.root, entry.path)
                        ? `~/${entry.path.slice(this.home.root.length).replace(/^\//, "")}`
                        : entry.path
                    const kind =
                        entry.kind === "directory"
                            ? "DIR "
                            : entry.kind === "symlink"
                              ? "LINK"
                              : entry.kind === "file"
                                ? "FILE"
                                : " ?  "
                    add(
                        `${String(index + 1).padStart(2)}. ${formatBytes(entry.bytes).padStart(10)}  ${kind}  ${safeText(path)}`,
                    )
                }
            }
        } else
            add(
                this.homeError
                    ? th.fg("warning", safeText(this.homeError))
                    : t(
                          "Сканирование домашних каталогов… Esc отменит сканирование.",
                          "Scanning home directories… Esc cancels the scan.",
                      ),
            )
        add(
            th.fg(
                "dim",
                t(
                    "Каталоги без прав доступа пропускаются без ошибок. ~ — ваш домашний каталог; для остальных показан полный путь.",
                    "Homes without access permissions are silently skipped. ~ means your home; other paths are shown in full.",
                ),
            ),
        )
        add(
            th.fg(
                "dim",
                t(
                    "Включая скрытые каталоги и вложенные пути. Символические ссылки не раскрываются.",
                    "Includes hidden directories and nested paths. Symbolic links are not followed.",
                ),
            ),
        )
        add(
            th.fg(
                "dim",
                t(
                    "Размер папки включает её содержимое: строки рейтинга нельзя складывать.",
                    "Directory sizes include their contents: do not add the ranking rows together.",
                ),
            ),
        )
        lines.push("")
        if (this.usage?.scope !== "container")
            add(
                th.fg(
                    "accent",
                    t("Файловые системы (не только домашний каталог)", "Filesystems (not just the home directory)"),
                ),
            )
        for (const fs of this.usage?.scope === "container" ? [] : (this.usage?.filesystems ?? [])) {
            add(
                `${usagePercent(fs.used, fs.total).toFixed(1)}%  ${formatBytes(fs.used)} / ${formatBytes(fs.total)}  ${safeText(fs.mount)} [${safeText(fs.type)}]`,
            )
        }
        add(
            th.fg(
                "dim",
                t(
                    "GB = 1 000 000 000 байт. du: занятые блоки; df: вся файловая система.",
                    "GB = 1,000,000,000 bytes. du: allocated blocks; df: the entire filesystem.",
                ),
            ),
        )
        lines.push("")
        this.adviceStart = lines.length
        add(
            th.fg(
                "accent",
                t(
                    "Рекомендации по очистке — только ручное выполнение",
                    "Cleanup recommendations — manual execution only",
                ),
            ),
        )
        add(
            th.fg(
                "warning",
                t(
                    "Универсально безопасного удаления нет. Сначала проверка, затем осознанная очистка.",
                    "No deletion is universally safe. Inspect first, then clean up deliberately.",
                ),
            ),
        )
        add(
            th.fg(
                "dim",
                t(
                    "Рекомендации для пользовательских кэшей относятся только к вашему домашнему каталогу. Чужие данные не очищайте.",
                    "User-cache recommendations apply only to your own home. Do not clean up other users' data.",
                ),
            ),
        )
        const ownEntries = this.home?.directories.find((directory) => directory.root === this.home?.root)?.entries ?? []
        for (const advice of cleanupAdvice(
            this.home?.root ?? this.homePath,
            ownEntries,
            this.tmpfilesDryRun,
            this.usage?.scope === "container",
        )) {
            lines.push("")
            add(th.fg("accent", advice.title))
            for (const command of advice.inspect) add(`${t("Проверка", "Inspect")}: ${command}`)
            for (const command of advice.clean) add(`${t("После проверки", "After inspection")}: ${command}`)
            add(advice.caution)
        }
        return lines
    }

    render(width: number): string[] {
        this.width = width
        const rows = Math.max(1, Math.min(36, Math.floor(this.tui.terminal.rows * 0.85)))
        const innerWidth = Math.max(1, width - 4)
        const body = this.content(innerWidth)
        this.contentLength = body.length
        this.pageSize = Math.max(1, rows - 4)
        this.offset = Math.max(0, Math.min(this.offset, body.length - this.pageSize))
        const page = body.slice(this.offset, this.offset + this.pageSize)
        if (width < 10 || rows < 5) return page.slice(0, rows).map((line) => truncateToWidth(line, width))
        const border = (text: string) => this.theme.fg("border", text)
        const row = (text: string) => {
            const clipped = truncateToWidth(text, innerWidth)
            return border("│ ") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + border(" │")
        }
        const top = truncateToWidth(t(" Диск · обзор ", " Disk · overview "), width - 5)
        const bottom = truncateToWidth(
            ` ↑↓ PgUp/PgDn · ${t("c очистка · r обновить · Esc закрыть", "c cleanup · r refresh · Esc close")} · ${this.offset + 1}/${body.length} `,
            width - 2,
        )
        return [
            border(`╭${top}${"─".repeat(Math.max(0, width - visibleWidth(top) - 5))}[×]╮`),
            ...page.map(row),
            border(`╰${bottom}${"─".repeat(Math.max(0, width - visibleWidth(bottom) - 2))}╯`),
        ]
    }

    handleInput(data: string): void {
        if (this.keys.matches(data, "tui.select.cancel") || data === "q") {
            this.close()
            return
        }
        if (data === "r" || data === "R") {
            this.refresh()
            return
        }
        if (data === "c" || data === "C") {
            this.offset = this.offset === this.adviceStart ? 0 : this.adviceStart
            this.tui.requestRender()
            return
        }
        if (this.keys.matches(data, "tui.select.up")) this.scroll(-1)
        else if (this.keys.matches(data, "tui.select.down")) this.scroll(1)
        else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll(-this.pageSize)
        else if (this.keys.matches(data, "tui.select.pageDown")) this.scroll(this.pageSize)
    }

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        if (event.type === "wheel") {
            this.scroll(event.wheelDelta ?? 0)
            return { handled: true }
        }
        if (event.type === "click" && event.button === "left" && event.y === 0 && event.x >= this.width - 4) {
            this.close()
            return { handled: true }
        }
        return undefined
    }

    private scroll(delta: number): void {
        this.offset = Math.max(0, Math.min(this.offset + delta, this.contentLength - this.pageSize))
        this.tui.requestRender()
    }

    close(): void {
        if (this.disposed) return
        this.dispose()
        this.done()
    }

    invalidate(): void {}
    dispose(): void {
        this.disposed = true
        this.controller?.abort()
    }
}
