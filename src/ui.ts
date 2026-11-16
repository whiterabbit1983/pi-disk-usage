import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  MouseRegion, parseColor, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { cleanupAdvice, supportsTmpfilesDryRun } from "./cleanup.ts";
import {
  formatBytes, readDiskUsage, safeText, scanHome, scanTmp, usageLevel, usagePercent,
  type DirectoryReport, type DiskUsage,
} from "./disk.ts";

const COLORS = {
  green: parseColor("#22c55e"),
  yellow: parseColor("#facc15"),
  orange: parseColor("#ff9800"),
  red: parseColor("#ef4444"),
};
export interface IndicatorState { usage?: DiskUsage; error?: string; }
export function coloredUsage(theme: Theme, usage: DiskUsage): string {
  return theme.style(`Диск: занято ${usagePercent(usage.used, usage.total).toFixed(1)}% · ${formatBytes(usage.used)} / ${formatBytes(usage.total)}`, {
    fg: COLORS[usageLevel(usage.used, usage.total)], bold: true,
  });
}

export function createIndicator(theme: Theme, state: () => IndicatorState, open: () => void): Component {
  let clickableWidth = 0;
  return new MouseRegion({
    render(width) {
      const current = state();
      const text = current.error
        ? theme.fg("warning", "Диск: ошибка обновления")
        : current.usage ? coloredUsage(theme, current.usage) : theme.fg("dim", "Диск: измерение…");
      clickableWidth = Math.min(width, visibleWidth(text));
      const hint = theme.fg("dim", "  [клик / /disk]");
      return [truncateToWidth(text + hint, width)];
    },
    invalidate() {},
  }, (event) => {
    if (event.type === "click" && event.button === "left" && event.y === 0 && event.x < clickableWidth) {
      open();
      return { handled: true };
    }
    return undefined;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A read-only report with a bounded viewport; no file deletion actions. */
export class DiskReport implements Component {
  readonly capturesViewportInput = true;
  private tui: TUI;
  private theme: Theme;
  private keys: KeybindingsManager;
  private done: () => void;
  private homePath: string;
  private publish: (usage: DiskUsage) => void;
  private usage?: DiskUsage;
  private diskError?: string;
  private home?: DirectoryReport;
  private tmp?: DirectoryReport;
  private homeError?: string;
  private tmpError?: string;
  private controller?: AbortController;
  private disposed = false;
  private offset = 0;
  private pageSize = 1;
  private contentLength = 0;
  private width = 0;
  private adviceStart = 0;
  private tmpfilesDryRun = false;

  constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void,
    homePath: string, initial: DiskUsage | undefined, publish: (usage: DiskUsage) => void) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.homePath = homePath;
    this.usage = initial;
    this.publish = publish;
  }

  refresh(): void {
    if (this.disposed) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.home = this.tmp = undefined;
    this.homeError = this.tmpError = this.diskError = undefined;
    this.offset = 0;
    const active = () => !this.disposed && this.controller === controller && !controller.signal.aborted;
    const load = async <T,>(operation: Promise<T>, success: (value: T) => void, failure: (error: string) => void) => {
      try {
        const result = await operation;
        if (active()) success(result);
      } catch (error) {
        if (active()) failure(errorMessage(error));
      } finally {
        if (active()) this.tui.requestRender();
      }
    };
    void load(supportsTmpfilesDryRun(controller.signal), (supported) => { this.tmpfilesDryRun = supported; }, () => {});
    void load(readDiskUsage(controller.signal), (usage) => {
      this.usage = usage;
      this.publish(usage);
    }, (error) => { this.diskError = error; });
    void load(scanHome(this.homePath, controller.signal), (report) => { this.home = report; },
      (error) => { this.homeError = error; });
    void load(scanTmp(controller.signal), (report) => { this.tmp = report; },
      (error) => { this.tmpError = error; });
    this.tui.requestRender();
  }

  private content(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const add = (text: string) => lines.push(...wrapTextWithAnsi(text, Math.max(1, width)));
    if (this.usage) {
      add(coloredUsage(th, this.usage));
      add(`Всего: ${formatBytes(this.usage.total)} · доступно: ${formatBytes(this.usage.available)}`);
    }
    if (this.diskError) add(th.fg("warning", `df: ${safeText(this.diskError)} (предыдущее значение, если есть)`));
    if (!this.usage && !this.diskError) add("Получение статистики файловых систем…");
    lines.push("");
    add(th.fg("accent", "/tmp — только общий размер"));
    if (this.tmp) {
      add(`/tmp: ${this.tmp.total === undefined ? "?" : formatBytes(this.tmp.total)} (уже входит в счётчик диска)`);
    } else add(this.tmpError ? th.fg("warning", safeText(this.tmpError)) : "Подсчёт /tmp… содержимое не выводится.");
    add(th.fg("dim", "Автоочистки нет. Нажмите c: команды и ограничения очистки /tmp и специализированных каталогов."));
    lines.push("");
    add(th.fg("accent", `Топ-20 файлов и папок: ${safeText(this.home?.root ?? this.homePath)}`));
    if (this.home) {
      add(`Всего в домашнем каталоге: ${this.home.total === undefined ? "?" : formatBytes(this.home.total)}`);
      if (!this.home.entries.length) add("Нет доступных файлов и папок.");
      for (const [index, entry] of this.home.entries.entries()) {
        const path = `~/${entry.path.slice(this.home.root.length).replace(/^\//, "")}`;
        const kind = entry.kind === "directory" ? "DIR " : entry.kind === "symlink" ? "LINK" : entry.kind === "file" ? "FILE" : " ?  ";
        add(`${String(index + 1).padStart(2)}. ${formatBytes(entry.bytes).padStart(10)}  ${kind}  ${safeText(path)}`);
      }
    } else add(this.homeError ? th.fg("warning", safeText(this.homeError)) : "Сканирование домашнего каталога… Esc отменит сканирование.");
    add(th.fg("dim", "Включая скрытые каталоги и вложенные пути. Символические ссылки не раскрываются."));
    add(th.fg("dim", "Размер папки включает её содержимое: строки рейтинга нельзя складывать."));
    lines.push("");
    add(th.fg("accent", "Файловые системы (не только домашний каталог)"));
    for (const fs of this.usage?.filesystems ?? []) {
      add(`${usagePercent(fs.used, fs.total).toFixed(1)}%  ${formatBytes(fs.used)} / ${formatBytes(fs.total)}  ${safeText(fs.mount)} [${safeText(fs.type)}]`);
    }
    add(th.fg("dim", "GB = 1 000 000 000 байт. du: занятые блоки; df: вся файловая система."));
    lines.push("");
    this.adviceStart = lines.length;
    add(th.fg("accent", "Рекомендации по очистке — только ручное выполнение"));
    add(th.fg("warning", "Универсально безопасного удаления нет. Сначала проверка, затем осознанная очистка."));
    for (const advice of cleanupAdvice(this.home?.root ?? this.homePath, this.home?.entries ?? [], this.tmpfilesDryRun)) {
      lines.push("");
      add(th.fg("accent", advice.title));
      for (const command of advice.inspect) add(`Проверка: ${command}`);
      for (const command of advice.clean) add(`После проверки: ${command}`);
      add(advice.caution);
    }
    return lines;
  }

  render(width: number): string[] {
    this.width = width;
    const rows = Math.max(1, Math.min(36, Math.floor(this.tui.terminal.rows * 0.85)));
    const innerWidth = Math.max(1, width - 4);
    const body = this.content(innerWidth);
    this.contentLength = body.length;
    this.pageSize = Math.max(1, rows - 4);
    this.offset = Math.max(0, Math.min(this.offset, body.length - this.pageSize));
    const page = body.slice(this.offset, this.offset + this.pageSize);
    if (width < 10 || rows < 5) return page.slice(0, rows).map((line) => truncateToWidth(line, width));
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string) => {
      const clipped = truncateToWidth(text, innerWidth);
      return border("│ ") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + border(" │");
    };
    const top = truncateToWidth(" Диск · обзор ", width - 5);
    const bottom = truncateToWidth(` ↑↓ PgUp/PgDn · c очистка · r обновить · Esc закрыть · ${this.offset + 1}/${body.length} `, width - 2);
    return [
      border(`╭${top}${"─".repeat(Math.max(0, width - visibleWidth(top) - 5))}[×]╮`),
      ...page.map(row),
      border(`╰${bottom}${"─".repeat(Math.max(0, width - visibleWidth(bottom) - 2))}╯`),
    ];
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel") || data === "q") { this.close(); return; }
    if (data === "r" || data === "R") { this.refresh(); return; }
    if (data === "c" || data === "C") {
      this.offset = this.offset === this.adviceStart ? 0 : this.adviceStart;
      this.tui.requestRender();
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) this.scroll(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.scroll(1);
    else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll(-this.pageSize);
    else if (this.keys.matches(data, "tui.select.pageDown")) this.scroll(this.pageSize);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.scroll(event.wheelDelta ?? 0);
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && event.y === 0 && event.x >= this.width - 4) {
      this.close();
      return { handled: true };
    }
    return undefined;
  }

  private scroll(delta: number): void {
    this.offset = Math.max(0, Math.min(this.offset + delta, this.contentLength - this.pageSize));
    this.tui.requestRender();
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  invalidate(): void {}
  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
  }
}
