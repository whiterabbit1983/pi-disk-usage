import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Theme, KeybindingsManager as AgentKeys } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { cleanupAdvice } from "../src/cleanup.ts";
import { parseDf, type DiskUsage } from "../src/disk.ts";
import extension from "../src/index.ts";
import { detectLanguage, t } from "../src/i18n.ts";
import { createIndicator, DiskReport, type IndicatorState } from "../src/ui.ts";

/** Synchronous callbacks only: never leak a locale change into another test. */
function withLocale<T>(locale: string, run: () => T): T {
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = locale;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous;
  }
}

test("message locale uses LC_ALL > LC_MESSAGES > LANG, skipping empty variables", () => {
  assert.equal(detectLanguage({ LC_ALL: "C", LC_MESSAGES: "ru_RU.UTF-8", LANG: "ru_RU" }), "en");
  assert.equal(detectLanguage({ LC_ALL: "ru_RU", LC_MESSAGES: "en_US", LANG: "en_US" }), "ru");
  assert.equal(detectLanguage({ LC_ALL: "", LC_MESSAGES: "ru_RU.UTF-8", LANG: "en_US" }), "ru");
  assert.equal(detectLanguage({ LC_MESSAGES: "fr_FR", LANG: "ru_RU" }), "en");
  assert.equal(detectLanguage({ LC_ALL: "", LC_MESSAGES: "", LANG: "ru_RU.UTF-8" }), "ru");
});

test("only Russian language tags select Russian; all other and unset locales use English", () => {
  for (const locale of ["ru", "ru_RU.UTF-8", "ru_RU.utf8", "ru-RU", "ru.UTF-8", "ru@variant", "RU_ru", "ru_UA"]) {
    assert.equal(detectLanguage({ LANG: locale }), "ru", locale);
  }
  for (const locale of ["en_US.UTF-8", "de_DE.UTF-8", "uk_UA.UTF-8", "C", "C.UTF-8", "POSIX", "", "unknown", "russian", "rubbish"]) {
    assert.equal(detectLanguage({ LANG: locale }), "en", locale);
  }
  assert.equal(detectLanguage({}), "en");
});

const theme = {
  fg: (_token: string, text: string) => text,
  style: (text: string) => text,
} as unknown as Theme;
const usage: DiskUsage = { used: 10, total: 100, available: 90, filesystems: [] };

for (const locale of ["ru_RU.UTF-8", "en_US.UTF-8", "C", "fr_FR.UTF-8"]) {
  test(`indicator, report, command and errors are localized for ${locale}`, () => withLocale(locale, () => {
    const russian = locale.startsWith("ru");
    assert.equal(t("русский", "English"), russian ? "русский" : "English");
    let state: IndicatorState = {};
    const indicator = createIndicator(theme, () => state, () => {});
    assert.match(indicator.render(120).join("\n"), russian ? /Диск: измерение.*клик/ : /Disk: measuring.*click/);
    state = { usage };
    assert.match(indicator.render(120).join("\n"), russian ? /Диск: занято 10\.0%/ : /Disk: used 10\.0%/);
    state = { error: "failure" };
    assert.match(indicator.render(120).join("\n"), russian ? /Диск: ошибка обновления/ : /Disk: refresh failed/);

    const tui = { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI;
    const keys = new KeybindingsManager(TUI_KEYBINDINGS) as AgentKeys;
    const report = new DiskReport(tui, theme, keys, () => {}, "/home/test", usage, () => {});
    const initial = report.render(140).join("\n");
    assert.match(initial, russian ? /Диск · обзор/ : /Disk · overview/);
    assert.match(initial, russian ? /Топ-20 файлов и папок/ : /Top 20 files and directories/);
    assert.match(initial, russian ? /Сканирование домашних каталогов/ : /Scanning home directories/);
    report.handleInput("c");
    const cleanup = report.render(140).join("\n");
    assert.match(cleanup, russian ? /Рекомендации по очистке/ : /Cleanup recommendations/);
    assert.match(cleanup, russian ? /Проверка: systemd-tmpfiles/ : /Inspect: systemd-tmpfiles/);
    assert.match(cleanup, russian ? /После проверки: sudo/ : /After inspection: sudo/);
    if (!russian) assert.doesNotMatch(initial + cleanup, /[а-яё]/i);
    report.dispose();

    const containerUsage: DiskUsage = { ...usage, scope: "container" };
    const containerReport = new DiskReport(tui, theme, keys, () => {}, "/home/test", containerUsage, () => {});
    Object.assign(containerReport, {
      home: { root: "/home/test", roots: ["/home/test", "/home/other"], total: 30, incomplete: false,
        entries: [{ path: "/home/test/own-file", bytes: 10 }, { path: "/home/other/other-file", bytes: 20 }] },
      tmp: { root: "/tmp", total: 10, entries: [], incomplete: false },
    });
    const containerPage = containerReport.render(160).join("\n");
    assert.match(containerPage, russian ? /Контейнер \/: занято/ : /Container \/: used/);
    assert.match(containerPage, /~\/own-file/);
    assert.match(containerPage, /\/home\/other\/other-file/);
    assert.match(containerPage, russian ? /не суммируются/ : /not summed/);
    assert.doesNotMatch(containerPage, /~\/other-file/);
    containerReport.handleInput("c");
    const containerCleanup = containerReport.render(160).join("\n");
    assert.match(containerCleanup, /docker system df -v/);
    assert.doesNotMatch(containerCleanup, /sudo systemd-tmpfiles|sudo apt-get|sudo journalctl/);
    if (!russian) assert.doesNotMatch(containerPage + containerCleanup, /[а-яё]/i);
    containerReport.dispose();

    let description = "";
    extension({
      registerCommand(_name: string, options: { description?: string }) { description = options.description ?? ""; },
      on() {},
    } as unknown as ExtensionAPI);
    assert.match(description, russian ? /Занятое место/ : /Disk usage/);
    assert.throws(() => parseDf("invalid"), russian ? /df не вернул/ : /df returned no available filesystems/);
  }));
}

test("every cleanup rule is translated without changing commands or safety restrictions", () => {
  const home = "/home/test";
  const entries = [".npm", ".cache/pip", ".cache/uv", ".local/share/pnpm/store", ".cache/yarn", ".cache/go-build",
    ".docker", ".local/share/containers", ".local/share/Trash", ".cargo", ".config/chromium"]
    .map((path) => ({ path: `${home}/${path}`, bytes: 1 }));
  for (const dryRun of [false, true]) {
    const ru = withLocale("ru_RU.UTF-8", () => cleanupAdvice(home, entries, dryRun));
    const en = withLocale("en_US.UTF-8", () => cleanupAdvice(home, entries, dryRun));
    assert.equal(en.length, 15);
    assert.deepEqual(en.map(({ id, inspect, clean }) => ({ id, inspect, clean })),
      ru.map(({ id, inspect, clean }) => ({ id, inspect, clean })));
    for (let i = 0; i < en.length; i++) {
      assert.doesNotMatch(en[i].title + en[i].caution, /[а-яё]/i, en[i].id);
      assert.match(ru[i].caution, /[а-яё]/i, ru[i].id);
      assert.notEqual(en[i].caution, ru[i].caution, en[i].id);
    }
    assert.match(en[0].caution, dryRun ? /Inspect the dry-run output first/ : /NOT a preview of deletions/);
    assert.match(en[0].caution, /does not guarantee/);
    assert.match(en.find(({ id }) => id === "journal")!.caution, /Irreversibly/);
    assert.deepEqual(en.find(({ id }) => id === "unknown")!.clean, []);
    assert.deepEqual(en.find(({ id }) => id === "profiles")!.clean, []);
  }
});
