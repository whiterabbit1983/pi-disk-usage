import { execFile } from "node:child_process"
import { relative, sep } from "node:path"
import { promisify } from "node:util"
import type { UsageEntry } from "./disk.ts"
import { t } from "./i18n.ts"

export interface CleanupAdvice {
    id: string
    title: string
    inspect: string[]
    clean: string[]
    caution: string
}

/** Capability detection only: this NEVER invokes --clean, sudo or a shell. */
export async function supportsTmpfilesDryRun(signal?: AbortSignal): Promise<boolean> {
    try {
        const { stdout } = await promisify(execFile)("systemd-tmpfiles", ["--help"], {
            encoding: "utf8",
            timeout: 3_000,
            maxBuffer: 128 * 1024,
            signal,
            env: { ...process.env, LC_ALL: "C" },
        })
        return /--dry-run\b/.test(stdout)
    } catch {
        return false
    }
}

const cleanupRules = (): Array<{ match: (path: string) => boolean; advice: CleanupAdvice }> => [
    {
        match: (p) => under(p, ".npm"),
        advice: {
            id: "npm",
            title: "npm: ~/.npm",
            inspect: ["npm cache ls"],
            clean: ["npm cache verify"],
            caution: t(
                "verify проверяет целостность и убирает мусор; не удаляйте весь ~/.npm и не используйте clean --force без причины.",
                "verify checks integrity and removes garbage; do not delete all of ~/.npm or use clean --force without a reason.",
            ),
        },
    },
    {
        match: (p) => under(p, ".cache/pip"),
        advice: {
            id: "pip",
            title: "pip: ~/.cache/pip",
            inspect: ["python3 -m pip cache info", "python3 -m pip cache list"],
            clean: ["python3 -m pip cache purge"],
            caution: t(
                "Только кэш pip, не virtualenv и не установленные пакеты. В следующий раз потребуется повторная загрузка; дождитесь завершения установок.",
                "Only the pip cache, not virtualenvs or installed packages. Future installs will need downloads again; wait for ongoing installs to finish.",
            ),
        },
    },
    {
        match: (p) => under(p, ".cache/uv"),
        advice: {
            id: "uv",
            title: "uv: ~/.cache/uv",
            inspect: ["uv cache dir"],
            clean: ["uv cache prune"],
            caution: t(
                "Удаляет неиспользуемые записи средствами uv. Не удаляйте кэш через rm во время работы uv.",
                "Removes unused entries using uv's own tools. Do not delete the cache with rm while uv is running.",
            ),
        },
    },
    {
        match: (p) => under(p, ".local/share/pnpm/store") || under(p, ".cache/pnpm"),
        advice: {
            id: "pnpm",
            title: "pnpm: store/cache",
            inspect: ["pnpm store path"],
            clean: ["pnpm store prune"],
            caution: t(
                "Штатная очистка store; не при работающем store server. Будущие установки могут заново загрузить пакеты. Не удаляйте store целиком.",
                "Uses the store's native cleanup; do not run while the store server is active. Future installs may download packages again. Do not delete the entire store.",
            ),
        },
    },
    {
        match: (p) => under(p, ".cache/yarn"),
        advice: {
            id: "yarn",
            title: "Yarn Classic: ~/.cache/yarn",
            inspect: ["yarn --version", "yarn cache dir"],
            clean: ["yarn cache clean"],
            caution: t(
                "Команды для Yarn 1.x. Для Berry используйте документацию своей версии; .yarn/cache может храниться в Git. Очистка потребует повторных загрузок.",
                "Commands are for Yarn 1.x. For Berry, consult your version's documentation; .yarn/cache may be tracked in Git. Cleanup will require downloads again.",
            ),
        },
    },
    {
        match: (p) => under(p, ".cache/go-build"),
        advice: {
            id: "go",
            title: t("Go: кэш сборки", "Go: build cache"),
            inspect: ["go env GOCACHE"],
            clean: ["go clean -cache"],
            caution: t(
                "Удаляет кэш компиляции, не исходники и не module cache. Следующая сборка будет медленнее; не очищайте во время сборки.",
                "Removes the compilation cache, not source code or the module cache. The next build will be slower; do not clean during a build.",
            ),
        },
    },
    {
        match: (p) => under(p, ".local/share/docker") || under(p, ".docker"),
        advice: {
            id: "docker",
            title: "Docker",
            inspect: ["docker context show", "docker system df -v"],
            clean: ["docker builder prune"],
            caution: t(
                "Только после проверки выбранного daemon/context: команда предлагает удалить неиспользуемый кэш сборки и запрашивает подтверждение. Не удаляет ~/.docker с настройками/credentials. Не используйте volume prune или system prune --volumes автоматически.",
                "Check the selected daemon/context first: the command offers to remove unused build cache and asks for confirmation. It does not delete ~/.docker with its settings/credentials. Do not run volume prune or system prune --volumes automatically.",
            ),
        },
    },
    {
        match: (p) => under(p, ".local/share/containers"),
        advice: {
            id: "podman",
            title: "Podman: containers/storage",
            inspect: ["podman system df"],
            clean: ["podman image prune"],
            caution: t(
                "Показывает запрос подтверждения удаления dangling images. Проверьте список; контейнеры и volumes вручную не удаляйте.",
                "Asks for confirmation before deleting dangling images. Review the list; do not manually delete containers or volumes.",
            ),
        },
    },
    {
        match: (p) => under(p, ".local/share/Trash"),
        advice: {
            id: "trash",
            title: t("Корзина", "Trash"),
            inspect: ["gio trash --list"],
            clean: [],
            caution: t(
                "Восстановите нужные файлы, затем подтвердите очистку в файловом менеджере. Команда немедленной очистки всей корзины не предлагается: удаление необратимо.",
                "Restore any files you need, then confirm emptying the trash in your file manager. No command to immediately empty the entire trash is suggested: deletion is irreversible.",
            ),
        },
    },
    {
        match: (p) => /(^|\/)(node_modules|target|\.venv|venv|\.gradle|\.cargo|\.rustup|\.m2)(\/|$)/.test(p),
        advice: {
            id: "development",
            title: t("Зависимости, toolchain и каталоги сборки", "Dependencies, toolchains and build directories"),
            inspect: [],
            clean: [],
            caution: t(
                "Общей команды нет. Определите проект и менеджер; target очищайте через cargo clean из проверенного Rust-проекта после остановки сборок. .cargo/.rustup содержат toolchain, настройки и credentials; node_modules/.venv могут содержать локальные изменения. Автоматическое удаление запрещено.",
                "There is no universal command. Identify the project and package manager; clean target using cargo clean from a verified Rust project after stopping builds. .cargo/.rustup contain toolchains, settings and credentials; node_modules/.venv may contain local changes. Automatic deletion is prohibited.",
            ),
        },
    },
    {
        match: (p) =>
            /(^|\/)(\.mozilla|google-chrome|chromium|BraveSoftware|\.config|\.vscode|JetBrains)(\/|$)/.test(p),
        advice: {
            id: "profiles",
            title: t("Профили и настройки приложений", "Application profiles and settings"),
            inspect: [],
            clean: [],
            caution: t(
                "Не удаляйте профиль целиком: там могут быть пароли, история, расширения и настройки. Используйте диалог очистки кэша самого приложения, не выбирая cookies/пароли/данные сайтов без необходимости. IDE — штатную очистку кэша.",
                "Do not delete an entire profile: it may contain passwords, history, extensions and settings. Use the application's cache-cleanup dialog; do not select cookies/passwords/site data unnecessarily. For IDEs, use their built-in cache cleanup.",
            ),
        },
    },
]

function under(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix}/`)
}

export function cleanupAdvice(
    home: string,
    entries: UsageEntry[],
    tmpfilesDryRun: boolean,
    container = false,
): CleanupAdvice[] {
    const advice: CleanupAdvice[] = container
        ? [
              {
                  id: "container",
                  title: t(
                      "Контейнер: очистка зависит от хоста и назначения томов",
                      "Container: cleanup depends on the host and volume ownership",
                  ),
                  inspect: [],
                  clean: [],
                  caution: t(
                      "В контейнере не предполагаются sudo, systemd, journald и APT. /tmp может быть отдельным tmpfs или общим томом: универсальной команды очистки нет. Образы и записываемые слои проверяйте на Docker-хосте через docker system df -v и docker ps --size. Не подключайте Docker socket ради измерений и не запускайте prune автоматически; данные volumes могут быть общими с другими контейнерами.",
                      "sudo, systemd, journald and APT are not assumed inside a container. /tmp may be a separate tmpfs or shared volume: there is no universal cleanup command. Inspect images and writable layers on the Docker host using docker system df -v and docker ps --size. Do not mount the Docker socket just for measurements or run prune automatically; volume data may be shared with other containers.",
                  ),
              },
          ]
        : [
              {
                  id: "tmp",
                  title: t("/tmp: системные правила tmpfiles", "/tmp: system tmpfiles rules"),
                  inspect: tmpfilesDryRun
                      ? ["sudo systemd-tmpfiles --clean --prefix=/tmp --dry-run"]
                      : ["systemd-tmpfiles --cat-config --no-pager"],
                  clean: ["sudo systemd-tmpfiles --clean --prefix=/tmp"],
                  caution: `${tmpfilesDryRun ? t("Сначала изучите dry-run.", "Inspect the dry-run output first.") : t("В этой версии --dry-run недоступен или не удалось проверить поддержку. Просмотр конфигурации НЕ является предпросмотром удалений.", "--dry-run is unavailable in this version or support could not be checked. Viewing configuration is NOT a preview of deletions.")} ${t("--clean учитывает возраст и исключения из системных правил; при отсутствии правил может ничего не удалить. Это не гарантия сохранности всех нужных файлов. Не добавляйте --remove, --boot, --create и не используйте rm -rf /tmp/*.", "--clean respects age limits and exclusions in system rules; without matching rules it may delete nothing. This does not guarantee that all needed files will be preserved. Do not add --remove, --boot, --create or use rm -rf /tmp/*.")}`,
              },
              {
                  id: "journal",
                  title: t("Системный журнал journald (если используется)", "journald system journal (if used)"),
                  inspect: ["journalctl --disk-usage"],
                  clean: ["sudo journalctl --vacuum-time=14d"],
                  caution: t(
                      "Необратимо удаляет только архивные журналы старше 14 дней. Выберите срок хранения по своим требованиям; активный журнал не очищает. /var/log целиком не удаляйте.",
                      "Irreversibly removes only archived journals older than 14 days. Choose retention based on your needs; the active journal is not cleared. Do not delete all of /var/log.",
                  ),
              },
              {
                  id: "apt",
                  title: t("Кэш APT (только Debian/Ubuntu)", "APT cache (Debian/Ubuntu only)"),
                  inspect: ["du -sh /var/cache/apt/archives"],
                  clean: ["sudo apt-get clean"],
                  caution: t(
                      "Удаляет скачанные .deb, не установленные пакеты. Не во время установки/обновления; для offline-переустановки пакеты придётся скачать заново. Не заменяйте на autoremove без отдельного анализа.",
                      "Removes downloaded .deb files, not installed packages. Do not run during installs/updates; packages must be downloaded again for offline reinstalls. Do not substitute autoremove without a separate review.",
                  ),
              },
          ]
    for (const { match, advice: rule } of cleanupRules()) {
        if (container && (rule.id === "docker" || rule.id === "podman")) continue
        if (
            entries.some((entry) => {
                const path = relative(home, entry.path).split(sep).join("/")
                return path !== ".." && !path.startsWith("../") && match(path)
            })
        )
            advice.push(rule)
    }
    advice.push({
        id: "unknown",
        title: t(
            "Прочие каталоги: сначала определить владельца и назначение",
            "Other directories: identify the owner and purpose first",
        ),
        inspect: [],
        clean: [],
        caution: t(
            "Неизвестные кэши, базы данных, Docker volumes, резервные копии и системные каталоги нельзя безопасно очистить общей командой. Используйте штатные средства программы, резервную копию и её документацию. ~/.cache также нельзя удалять целиком вслепую. Все команды здесь — рекомендации для ручной проверки, ничего не выполняется автоматически.",
            "Unknown caches, databases, Docker volumes, backups and system directories cannot be safely cleaned with a universal command. Use the application's native tools, a backup and its documentation. Do not blindly delete all of ~/.cache either. All commands here are recommendations for manual review; nothing runs automatically.",
        ),
    })
    return advice
}
