import type { Column } from "./schema";

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

export function compactTitle(value: unknown): string {
  const words = cleanShortName(typeof value === "string" && value.trim() ? value : "Thread")
    .split(/\s+/u)
    .slice(0, 5)
    .join(" ");
  return words || "Thread";
}

export function normalizeColumn(value: unknown): Column {
  switch (value) {
    case "queue":
    case "wip":
    case "blocked":
    case "done":
      return value;
    case "backlog":
      return "queue";
    case "investigating":
    case "theories":
    case "trying":
      return "wip";
    case "success":
      return "done";
    case "failed":
      return "blocked";
    default:
      return "queue";
  }
}

const CATEGORY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "this", "that", "task", "tasks", "card", "cards",
  "make", "move", "change", "update", "fix", "add", "new", "user", "agent", "session", "thread", "work",
]);

function categoryParts(value: string): { category: string | null; rest: string } {
  const match = value.match(/^\[([^\]]{1,40})\]\s*(.*)$/u);
  return match
    ? { category: cleanShortName(match[1]).toLowerCase(), rest: match[2].trim() }
    : { category: null, rest: value.trim() };
}

function categoryTokens(value: string): string[] {
  return Array.from(
    new Set(value.toLowerCase().replace(/\[[^\]]*\]/gu, " ").match(/[a-z0-9][a-z0-9-]{2,}/gu) ?? []),
  ).filter((token) => !CATEGORY_STOPWORDS.has(token));
}

function inferCategory(title: string, context: string): string {
  const { category } = categoryParts(title);
  if (category) return category;
  // Tokens are 3+ non-space chars, so the result is empty only when there are none.
  return categoryTokens(`${title} ${context}`).slice(0, 2).join(" ").slice(0, 28).trim() || "thread";
}

export function categorizedTitle(value: string, context: string): string {
  const title = oneLine(value) || "Thread";
  const { category, rest } = categoryParts(title);
  const body = rest || "Thread";
  return `[${category || inferCategory(body, context)}] ${body}`;
}

export async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

