import assert from "node:assert/strict"
import { test } from "node:test"
import type { Theme, KeybindingsManager as AgentKeys } from "@earendil-works/pi-coding-agent"
import {
    KeybindingsManager,
    TUI_KEYBINDINGS,
    styleText,
    visibleWidth,
    type TUI,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui"
import { cleanupAdvice, supportsTmpfilesDryRun } from "../src/cleanup.ts"
import { GB, type DiskUsage } from "../src/disk.ts"
import { detectLanguage } from "../src/i18n.ts"
import type { HomesReport } from "../src/homes.ts"
import { coloredUsage, createIndicator, DiskReport, type IndicatorState } from "../src/ui.ts"

const theme = {
    fg: (_token: string, text: string) => text,
    style: (text: string, style: Parameters<typeof styleText>[1]) => styleText(text, style, "truecolor"),
} as unknown as Theme
const usage: DiskUsage = {
    used: 100 * GB,
    total: 250 * GB,
    available: 140 * GB,
    filesystems: [
        { source: "/dev/root", type: "ext4", mount: "/", used: 100 * GB, total: 250 * GB, available: 140 * GB },
    ],
}
function mouse(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
    return {
        type: "click",
        button: "left",
        x: 0,
        y: 0,
        screenX: 0,
        screenY: 0,
        width: 80,
        height: 1,
        shift: false,
        alt: false,
        ctrl: false,
        ...overrides,
    }
}

test("indicator supports clicks only on its label and uses exact requested colors", () => {
    let clicks = 0
    let state: IndicatorState = { usage: { ...usage, used: 95 * GB, total: 100 * GB } }
    const indicator = createIndicator(
        theme,
        () => state,
        () => {
            clicks++
        },
    )
    const red = indicator.render(100)[0]
    assert.match(red, /\x1b\[38;2;239;68;68m/)
    indicator.handleMouse?.(mouse())
    assert.equal(clicks, 1)
    indicator.handleMouse?.(mouse({ x: 75 }))
    indicator.handleMouse?.(mouse({ button: "right" }))
    indicator.handleMouse?.(mouse({ type: "press" }))
    assert.equal(clicks, 1)
    state = { usage: { ...usage, used: 80 * GB, total: 100 * GB } }
    assert.match(indicator.render(100)[0], /\x1b\[38;2;255;152;0m/)
    state = { usage: { ...usage, used: 75 * GB, total: 100 * GB } }
    assert.match(indicator.render(100)[0], /\x1b\[38;2;250;204;21m/)
    state = { usage: { ...usage, used: 70 * GB, total: 100 * GB } }
    assert.match(indicator.render(100)[0], /\x1b\[38;2;34;197;94m/)
    assert.match(indicator.render(100)[0], /70\.0%/)
    state = {}
    assert.match(indicator.render(100)[0], /--/)
    for (const width of [0, 1, 4, 20, 40]) assert.ok(visibleWidth(indicator.render(width)[0]) <= width)
})

test("indicator uses -- until a measurement is available", () => {
    let state: IndicatorState = {}
    const indicator = createIndicator(
        theme,
        () => state,
        () => {},
    )
    assert.match(indicator.render(120)[0], /--/)
    state = { usage }
    assert.match(indicator.render(120)[0], /40\.0%/)
})

test("tmp cleanup commands and safety caveats are visible without pressing c", () => {
    const tui = { terminal: { rows: 80 }, requestRender() {} } as unknown as TUI
    const keys = new KeybindingsManager(TUI_KEYBINDINGS) as AgentKeys
    for (const dryRun of [false, true]) {
        const report = new DiskReport(
            tui,
            theme,
            keys,
            () => {},
            "/home/test",
            usage,
            () => {},
        )
        Object.assign(report, { tmpfilesDryRun: dryRun })
        const page = report.render(160).join("\n")
        assert.match(page, /sudo systemd-tmpfiles --clean --prefix=\/tmp/)
        assert.match(page, dryRun ? /--dry-run/ : /systemd-tmpfiles --cat-config/)
        assert.match(page, detectLanguage() === "ru" ? /исключения из системных правил/ : /exclusions in system rules/)
        assert.doesNotMatch(page, /Нажмите c|Press c/)
        report.dispose()
    }
})

test("usage icons reflect host and container severity levels", () => {
    for (const [hostGB, containerGB, icon] of [
        [40, 40, "✅"],
        [75, 50, "👀"],
        [85, 60, "⚠️"],
        [95, 70, "🚨"],
    ] as const) {
        for (const value of [
            { ...usage, used: hostGB * GB, total: 100 * GB },
            { ...usage, scope: "container" as const, used: containerGB * GB },
        ]) {
            const label = coloredUsage(theme, value).replace(/\x1b\[[0-9;]*m/g, "")
            assert.ok(label.startsWith(`${icon} `), label)
        }
    }
})

test("container indicator and report show only used bytes with absolute thresholds", () => {
    const container: DiskUsage = { ...usage, scope: "container", used: 50 * GB, incomplete: true }
    const label = coloredUsage(theme, container)
    assert.match(label, /50\.0 GB/)
    assert.match(label, /\x1b\[38;2;250;204;21m/)
    assert.doesNotMatch(label, /%|250\.0|140\.0/)
    assert.match(label, detectLanguage() === "ru" ? /неполные данные/ : /partial scan/)
    assert.match(coloredUsage(theme, { ...container, containerThresholds: [10, 20, 30] }), /\x1b\[38;2;239;68;68m/)
    const tui = { terminal: { rows: 80 }, requestRender() {} } as unknown as TUI
    const keys = new KeybindingsManager(TUI_KEYBINDINGS) as AgentKeys
    const report = new DiskReport(
        tui,
        theme,
        keys,
        () => {},
        "/home/test",
        container,
        () => {},
    )
    const pages: string[] = []
    for (let i = 0; i < 10; i++) {
        pages.push(report.render(160).join("\n"))
        report.handleMouse(mouse({ type: "wheel", wheelDelta: 10 }))
    }
    assert.doesNotMatch(pages.join("\n"), /%|250\.0 GB|140\.0 GB|statfs|доступно:|available:/)
    report.dispose()
})

test("report fits narrow/wide/short terminals, supports scrolling, cleanup jump, close", () => {
    let renders = 0
    let closed = 0
    const terminal = { rows: 24 }
    const tui = {
        terminal,
        requestRender: () => {
            renders++
        },
    } as unknown as TUI
    const keys = new KeybindingsManager(TUI_KEYBINDINGS) as AgentKeys
    const report = new DiskReport(
        tui,
        theme,
        keys,
        () => {
            closed++
        },
        "/home/名",
        usage,
        () => {},
    )
    for (const height of [3, 8, 24, 80]) {
        terminal.rows = height
        for (const width of [0, 1, 4, 10, 20, 80, 160]) {
            const lines = report.render(width)
            assert.ok(
                lines.length <= Math.max(1, Math.floor(height * 0.85)),
                `height=${height}, actual=${lines.length}`,
            )
            assert.ok(
                lines.every((line) => visibleWidth(line) <= width),
                `width=${width}`,
            )
        }
    }
    terminal.rows = 24
    report.render(100)
    report.handleInput("c")
    assert.match(
        report.render(100).join("\n"),
        detectLanguage() === "ru" ? /Рекомендации по очистке/ : /Cleanup recommendations/,
    )
    assert.match(report.render(100).join("\n"), /systemd-tmpfiles/)
    const before = report.render(100).join("\n")
    report.handleMouse(mouse({ type: "wheel", wheelDelta: 3 }))
    assert.notEqual(report.render(100).join("\n"), before)
    assert.ok(renders > 0)
    report.handleInput("\x1b")
    assert.equal(closed, 1)
    report.close()
    assert.equal(closed, 1)
})

test("per-home rankings remain scrollable beyond 20 rows and cache advice uses only the current home", () => {
    const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI
    const keys = new KeybindingsManager(TUI_KEYBINDINGS) as AgentKeys
    const report = new DiskReport(
        tui,
        theme,
        keys,
        () => {},
        "/home/alice",
        usage,
        () => {},
    )
    const home: HomesReport = {
        root: "/home/alice",
        total: 420,
        incomplete: false,
        directories: ["/home/alice", "/home/bob"].map((root, index) => ({
            root,
            total: 210,
            incomplete: false,
            entries: Array.from({ length: 20 }, (_entry, i) => ({
                path: `${root}/${i === 19 ? (index === 0 ? ".npm" : ".cache/pip") : `file-${i + 1}`}`,
                bytes: 20 - i,
            })),
        })),
    }
    home.directories.push({ root: "/home/empty", total: 0, entries: [], incomplete: false })
    Object.assign(report, { home })
    const pages: string[] = []
    for (let i = 0; i < 20; i++) {
        const lines = report.render(120)
        assert.ok(lines.every((line) => visibleWidth(line) <= 120))
        pages.push(lines.join("\n"))
        report.handleMouse(mouse({ type: "wheel", wheelDelta: 10 }))
    }
    const rendered = pages.join("\n")
    assert.match(rendered, /20\.\s+1 B\s+\?\s+~\/\.npm/)
    assert.match(rendered, /20\.\s+1 B\s+\?\s+\/home\/bob\/\.cache\/pip/)
    assert.match(rendered, /\/home\/empty/)
    assert.match(
        rendered,
        detectLanguage() === "ru" ? /Нет доступных файлов и папок/ : /No accessible files or directories/,
    )
    assert.match(rendered, /npm cache verify/)
    assert.doesNotMatch(rendered, /python3 -m pip cache purge/)
    report.dispose()
})

test("known caches use native tools, unknown directories get no deletion command", () => {
    const home = "/home/test"
    const entries = [
        ".npm",
        ".cache/pip",
        ".cache/uv",
        ".docker",
        ".cargo",
        ".config/chromium",
        "unknown-database",
    ].map((path) => ({ path: `${home}/${path}`, bytes: 1 }))
    const advice = cleanupAdvice(home, entries, false)
    assert.ok(advice.find((a) => a.id === "npm")?.clean.includes("npm cache verify"))
    assert.ok(advice.find((a) => a.id === "pip")?.clean.includes("python3 -m pip cache purge"))
    assert.ok(advice.find((a) => a.id === "uv")?.clean.includes("uv cache prune"))
    assert.deepEqual(advice.find((a) => a.id === "profiles")?.clean, [])
    assert.deepEqual(advice.find((a) => a.id === "unknown")?.clean, [])
    const commands = advice.flatMap((a) => [...a.inspect, ...a.clean])
    assert.ok(
        commands.every(
            (command) => !command.includes("rm ") && !command.includes("--force") && !command.includes("--volumes"),
        ),
    )
    assert.ok(!commands.some((command) => command.includes("--dry-run")))
    const modern = cleanupAdvice(home, entries, true)
    assert.match(modern[0].inspect[0], /--dry-run/)
    const noMatch = cleanupAdvice(home, [{ path: "/home/test-other/.npm", bytes: 1 }], false)
    assert.ok(!noMatch.some((advice) => advice.id === "npm"))
})

test("tmpfiles dry-run support detection is read-only and tolerates cancellation", async () => {
    assert.equal(typeof (await supportsTmpfilesDryRun()), "boolean")
    const controller = new AbortController()
    controller.abort()
    assert.equal(await supportsTmpfilesDryRun(controller.signal), false)
})
