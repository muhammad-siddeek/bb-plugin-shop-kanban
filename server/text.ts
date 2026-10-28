export function nowIso(): string {
  return new Date().toISOString();
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const SHORT_NAME_MAX = 40;
const SHORT_NAME_CUT = 37;
export const ELLIPSIS = "…";

export function cleanShortName(value: string): string {
  const text = oneLine(value).replace(/>/g, " ").trim();
  return text.length <= SHORT_NAME_MAX ? text : `${text.slice(0, SHORT_NAME_CUT).trimEnd()}${ELLIPSIS}`;
}

/** At most the first five words of `value`, or "Thread". */
export function compactTitle(value: string): string {
  return cleanShortName(value).split(/\s+/u).slice(0, 5).join(" ") || "Thread";
}

const CATEGORY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "this", "that", "task", "tasks", "card", "cards",
  "make", "move", "change", "update", "fix", "add", "new", "user", "agent", "session", "thread", "work",
]);

/** "[category] body": the bracketed prefix `value` has, or one inferred from its words and `context`. */
export function categorizedTitle(value: string, context: string): string {
  const text = oneLine(value) || "Thread";
  const match = text.match(/^\[([^\]]{1,40})\]\s*(.*)$/u);
  const body = (match ? match[2].trim() : text) || "Thread";
  if (match) {
    const category = cleanShortName(match[1]).toLowerCase();
    if (category) return `[${category}] ${body}`;
  }
  // The first two meaningful words (3+ chars, outside brackets) of the title and its context.
  const words = new Set(`${body} ${context}`.toLowerCase().replace(/\[[^\]]*\]/gu, " ").match(/[a-z0-9][a-z0-9-]{2,}/gu));
  const inferred = [...words].filter((word) => !CATEGORY_STOPWORDS.has(word)).slice(0, 2).join(" ").slice(0, 28).trim();
  return `[${inferred || "thread"}] ${body}`;
}

export async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

