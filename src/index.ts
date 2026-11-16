import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readDiskUsage, type DiskUsage } from "./disk.ts";
import { createIndicator, DiskReport, type IndicatorState } from "./ui.ts";

const WIDGET_KEY = "pi-disk-usage";
const REFRESH_MS = 30_000;

export default function diskUsageExtension(pi: ExtensionAPI): void {
  let state: IndicatorState = {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let lifetime: AbortController | undefined;
  let requestRender: (() => void) | undefined;
  let refreshing = false;
  let opening = false;
  let report: DiskReport | undefined;

  const publish = (usage: DiskUsage) => {
    state = { usage };
    requestRender?.();
  };

  const refresh = async () => {
    if (refreshing || !lifetime || lifetime.signal.aborted) return;
    refreshing = true;
    const current = lifetime;
    try {
      const usage = await readDiskUsage(current.signal);
      if (lifetime === current && !current.signal.aborted) publish(usage);
    } catch (error) {
      if (lifetime === current && !current.signal.aborted) {
        state = { ...state, error: error instanceof Error ? error.message : String(error) };
        requestRender?.();
      }
    } finally { refreshing = false; }
  };

  const open = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("/disk доступна только в интерактивном терминале pi", "warning");
      return;
    }
    if (opening) return;
    opening = true;
    try {
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        report = new DiskReport(tui, theme, keys, () => done(), homedir(), state.usage, publish);
        report.refresh();
        return report;
      }, {
        overlay: true,
        overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" },
        blocked: { kind: "question", message: "Использование диска" },
      });
    } catch (error) {
      ctx.ui.notify(`Не удалось открыть отчёт: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      report?.dispose();
      report = undefined;
      opening = false;
    }
  };

  pi.registerCommand("disk", {
    description: "Занятое место на диске, /tmp и топ-20 файлов/папок в домашнем каталоге",
    handler: async (_args, ctx) => open(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    lifetime = new AbortController();
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      requestRender = () => tui.requestRender();
      return createIndicator(theme, () => state, () => { void open(ctx); });
    }, { placement: "belowEditor" });
    void refresh();
    timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    timer.unref();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    lifetime?.abort();
    lifetime = undefined;
    report?.dispose();
    report = undefined;
    requestRender = undefined;
  });
}
