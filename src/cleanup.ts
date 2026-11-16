import { execFile } from "node:child_process";
import { relative, sep } from "node:path";
import { promisify } from "node:util";
import type { UsageEntry } from "./disk.ts";

export interface CleanupAdvice {
  id: string;
  title: string;
  inspect: string[];
  clean: string[];
  caution: string;
}

/** Capability detection only: this NEVER invokes --clean, sudo or a shell. */
export async function supportsTmpfilesDryRun(signal?: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)("systemd-tmpfiles", ["--help"], {
      encoding: "utf8", timeout: 3_000, maxBuffer: 128 * 1024, signal,
      env: { ...process.env, LC_ALL: "C" },
    });
    return /--dry-run\b/.test(stdout);
  } catch { return false; }
}

const RULES: Array<{ match: (path: string) => boolean; advice: CleanupAdvice }> = [
  {
    match: (p) => under(p, ".npm"),
    advice: {
      id: "npm", title: "npm: ~/.npm",
      inspect: ["npm cache ls"], clean: ["npm cache verify"],
      caution: "verify проверяет целостность и убирает мусор; не удаляйте весь ~/.npm и не используйте clean --force без причины.",
    },
  },
  {
    match: (p) => under(p, ".cache/pip"),
    advice: {
      id: "pip", title: "pip: ~/.cache/pip",
      inspect: ["python3 -m pip cache info", "python3 -m pip cache list"],
      clean: ["python3 -m pip cache purge"],
      caution: "Только кэш pip, не virtualenv и не установленные пакеты. В следующий раз потребуется повторная загрузка; дождитесь завершения установок.",
    },
  },
  {
    match: (p) => under(p, ".cache/uv"),
    advice: {
      id: "uv", title: "uv: ~/.cache/uv", inspect: ["uv cache dir"], clean: ["uv cache prune"],
      caution: "Удаляет неиспользуемые записи средствами uv. Не удаляйте кэш через rm во время работы uv.",
    },
  },
  {
    match: (p) => under(p, ".local/share/pnpm/store") || under(p, ".cache/pnpm"),
    advice: {
      id: "pnpm", title: "pnpm: store/cache", inspect: ["pnpm store path"], clean: ["pnpm store prune"],
      caution: "Штатная очистка store; не при работающем store server. Будущие установки могут заново загрузить пакеты. Не удаляйте store целиком.",
    },
  },
  {
    match: (p) => under(p, ".cache/yarn"),
    advice: {
      id: "yarn", title: "Yarn Classic: ~/.cache/yarn", inspect: ["yarn --version", "yarn cache dir"],
      clean: ["yarn cache clean"],
      caution: "Команды для Yarn 1.x. Для Berry используйте документацию своей версии; .yarn/cache может храниться в Git. Очистка потребует повторных загрузок.",
    },
  },
  {
    match: (p) => under(p, ".cache/go-build"),
    advice: {
      id: "go", title: "Go: кэш сборки", inspect: ["go env GOCACHE"], clean: ["go clean -cache"],
      caution: "Удаляет кэш компиляции, не исходники и не module cache. Следующая сборка будет медленнее; не очищайте во время сборки.",
    },
  },
  {
    match: (p) => under(p, ".local/share/docker") || under(p, ".docker"),
    advice: {
      id: "docker", title: "Docker", inspect: ["docker context show", "docker system df -v"],
      clean: ["docker builder prune"],
      caution: "Только после проверки выбранного daemon/context: команда предлагает удалить неиспользуемый кэш сборки и запрашивает подтверждение. Не удаляет ~/.docker с настройками/credentials. Не используйте volume prune или system prune --volumes автоматически.",
    },
  },
  {
    match: (p) => under(p, ".local/share/containers"),
    advice: {
      id: "podman", title: "Podman: containers/storage", inspect: ["podman system df"],
      clean: ["podman image prune"],
      caution: "Показывает запрос подтверждения удаления dangling images. Проверьте список; контейнеры и volumes вручную не удаляйте.",
    },
  },
  {
    match: (p) => under(p, ".local/share/Trash"),
    advice: {
      id: "trash", title: "Корзина", inspect: ["gio trash --list"], clean: [],
      caution: "Восстановите нужные файлы, затем подтвердите очистку в файловом менеджере. Команда немедленной очистки всей корзины не предлагается: удаление необратимо.",
    },
  },
  {
    match: (p) => /(^|\/)(node_modules|target|\.venv|venv|\.gradle|\.cargo|\.rustup|\.m2)(\/|$)/.test(p),
    advice: {
      id: "development", title: "Зависимости, toolchain и каталоги сборки", inspect: [], clean: [],
      caution: "Общей команды нет. Определите проект и менеджер; target очищайте через cargo clean из проверенного Rust-проекта после остановки сборок. .cargo/.rustup содержат toolchain, настройки и credentials; node_modules/.venv могут содержать локальные изменения. Автоматическое удаление запрещено.",
    },
  },
  {
    match: (p) => /(^|\/)(\.mozilla|google-chrome|chromium|BraveSoftware|\.config|\.vscode|JetBrains)(\/|$)/.test(p),
    advice: {
      id: "profiles", title: "Профили и настройки приложений", inspect: [], clean: [],
      caution: "Не удаляйте профиль целиком: там могут быть пароли, история, расширения и настройки. Используйте диалог очистки кэша самого приложения, не выбирая cookies/пароли/данные сайтов без необходимости. IDE — штатную очистку кэша.",
    },
  },
];

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function cleanupAdvice(home: string, entries: UsageEntry[], tmpfilesDryRun: boolean): CleanupAdvice[] {
  const advice: CleanupAdvice[] = [{
    id: "tmp", title: "/tmp: системные правила tmpfiles",
    inspect: tmpfilesDryRun
      ? ["sudo systemd-tmpfiles --clean --prefix=/tmp --dry-run"]
      : ["systemd-tmpfiles --cat-config --no-pager"],
    clean: ["sudo systemd-tmpfiles --clean --prefix=/tmp"],
    caution: `${tmpfilesDryRun ? "Сначала изучите dry-run." : "В этой версии --dry-run недоступен или не удалось проверить поддержку. Просмотр конфигурации НЕ является предпросмотром удалений."} --clean учитывает возраст и исключения из системных правил; при отсутствии правил может ничего не удалить. Это не гарантия сохранности всех нужных файлов. Не добавляйте --remove, --boot, --create и не используйте rm -rf /tmp/*.`,
  }, {
    id: "journal", title: "Системный журнал journald (если используется)",
    inspect: ["journalctl --disk-usage"], clean: ["sudo journalctl --vacuum-time=14d"],
    caution: "Необратимо удаляет только архивные журналы старше 14 дней. Выберите срок хранения по своим требованиям; активный журнал не очищает. /var/log целиком не удаляйте.",
  }, {
    id: "apt", title: "Кэш APT (только Debian/Ubuntu)",
    inspect: ["du -sh /var/cache/apt/archives"], clean: ["sudo apt-get clean"],
    caution: "Удаляет скачанные .deb, не установленные пакеты. Не во время установки/обновления; для offline-переустановки пакеты придётся скачать заново. Не заменяйте на autoremove без отдельного анализа.",
  }];
  for (const { match, advice: rule } of RULES) {
    if (entries.some((entry) => {
      const path = relative(home, entry.path).split(sep).join("/");
      return path !== ".." && !path.startsWith("../") && match(path);
    })) advice.push(rule);
  }
  advice.push({
    id: "unknown", title: "Прочие каталоги: сначала определить владельца и назначение", inspect: [], clean: [],
    caution: "Неизвестные кэши, базы данных, Docker volumes, резервные копии и системные каталоги нельзя безопасно очистить общей командой. Используйте штатные средства программы, резервную копию и её документацию. ~/.cache также нельзя удалять целиком вслепую. Все команды здесь — рекомендации для ручной проверки, ничего не выполняется автоматически.",
  });
  return advice;
}
