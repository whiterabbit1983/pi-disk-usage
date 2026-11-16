import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme, KeybindingsManager as AgentKeys } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, styleText, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { cleanupAdvice, supportsTmpfilesDryRun } from "../src/cleanup.ts";
import { GB, type DiskUsage } from "../src/disk.ts";
import { createIndicator, DiskReport, type IndicatorState } from "../src/ui.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  style: (text: string, style: Parameters<typeof styleText>[1]) => styleText(text, style, "truecolor"),
} as unknown as Theme;
const usage: DiskUsage = {
  used: 100 * GB, total: 250 * GB, available: 140 * GB,
  filesystems: [{ source: "/dev/root", type: "ext4", mount: "/", used: 100 * GB, total: 250 * GB, available: 140 * GB }],
};
function mouse(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0,
    width: 80, height: 1, shift: false, alt: false, ctrl: false, ...overrides,
  };
}

test("indicator supports clicks only on its label and uses exact requested colors", () => {
  let clicks = 0;
  let state: IndicatorState = { usage: { ...usage, used: 95 * GB, total: 100 * GB } };
  const indicator = createIndicator(theme, () => state, () => { clicks++; });
  const red = indicator.render(100)[0];
  assert.match(red, /\x1b\[38;2;239;68;68m/);
  indicator.handleMouse?.(mouse());
  assert.equal(clicks, 1);
  indicator.handleMouse?.(mouse({ x: 75 }));
  indicator.handleMouse?.(mouse({ button: "right" }));
  indicator.handleMouse?.(mouse({ type: "press" }));
  assert.equal(clicks, 1);
  state = { usage: { ...usage, used: 80 * GB, total: 100 * GB } };
  assert.match(indicator.render(100)[0], /\x1b\[38;2;255;152;0m/);
  state = { usage: { ...usage, used: 75 * GB, total: 100 * GB } };
  assert.match(indicator.render(100)[0], /\x1b\[38;2;250;204;21m/);
  state = { usage: { ...usage, used: 70 * GB, total: 100 * GB } };
  assert.match(indicator.render(100)[0], /\x1b\[38;2;34;197;94m/);
  assert.match(indicator.render(100)[0], /70\.0%/);
  state = { error: "df failed" };
  assert.match(indicator.render(100)[0], /ошибка/);
  for (const width of [0, 1, 4, 20, 40]) assert.ok(visibleWidth(indicator.render(width)[0]) <= width);
});

test("report fits narrow/wide/short terminals, supports scrolling, cleanup jump, close", () => {
  let renders = 0;
  let closed = 0;
  const terminal = { rows: 24 };
  const tui = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS) as AgentKeys;
  const report = new DiskReport(tui, theme, keys, () => { closed++; }, "/home/名", usage, () => {});
  for (const height of [3, 8, 24, 80]) {
    terminal.rows = height;
    for (const width of [0, 1, 4, 10, 20, 80, 160]) {
      const lines = report.render(width);
      assert.ok(lines.length <= Math.max(1, Math.floor(height * 0.85)), `height=${height}, actual=${lines.length}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `width=${width}`);
    }
  }
  terminal.rows = 24;
  report.render(100);
  report.handleInput("c");
  assert.match(report.render(100).join("\n"), /Рекомендации по очистке/);
  assert.match(report.render(100).join("\n"), /systemd-tmpfiles/);
  const before = report.render(100).join("\n");
  report.handleMouse(mouse({ type: "wheel", wheelDelta: 3 }));
  assert.notEqual(report.render(100).join("\n"), before);
  assert.ok(renders > 0);
  report.handleInput("\x1b");
  assert.equal(closed, 1);
  report.close();
  assert.equal(closed, 1);
});

test("known caches use native tools, unknown directories get no deletion command", () => {
  const home = "/home/test";
  const entries = [".npm", ".cache/pip", ".cache/uv", ".docker", ".cargo", ".config/chromium", "unknown-database"]
    .map((path) => ({ path: `${home}/${path}`, bytes: 1 }));
  const advice = cleanupAdvice(home, entries, false);
  assert.ok(advice.find((a) => a.id === "npm")?.clean.includes("npm cache verify"));
  assert.ok(advice.find((a) => a.id === "pip")?.clean.includes("python3 -m pip cache purge"));
  assert.ok(advice.find((a) => a.id === "uv")?.clean.includes("uv cache prune"));
  assert.deepEqual(advice.find((a) => a.id === "profiles")?.clean, []);
  assert.deepEqual(advice.find((a) => a.id === "unknown")?.clean, []);
  const commands = advice.flatMap((a) => [...a.inspect, ...a.clean]);
  assert.ok(commands.every((command) => !command.includes("rm ") && !command.includes("--force") && !command.includes("--volumes")));
  assert.ok(!commands.some((command) => command.includes("--dry-run")));
  const modern = cleanupAdvice(home, entries, true);
  assert.match(modern[0].inspect[0], /--dry-run/);
  const noMatch = cleanupAdvice(home, [{ path: "/home/test-other/.npm", bytes: 1 }], false);
  assert.ok(!noMatch.some((advice) => advice.id === "npm"));
});

test("tmpfiles dry-run support detection is read-only and tolerates cancellation", async () => {
  assert.equal(typeof await supportsTmpfilesDryRun(), "boolean");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await supportsTmpfilesDryRun(controller.signal), false);
});
