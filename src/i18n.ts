export type Language = "ru" | "en";

/** POSIX message-locale precedence; empty variables do not override lower ones. */
export function detectLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const locale = (env.LC_ALL || env.LC_MESSAGES || env.LANG || "").trim();
  return /^ru(?:$|[-_.@])/i.test(locale) ? "ru" : "en";
}

/** Keep both translations together; unknown, C/POSIX and unset locales use English. */
export function t(ru: string, en: string): string {
  return detectLanguage() === "ru" ? ru : en;
}
