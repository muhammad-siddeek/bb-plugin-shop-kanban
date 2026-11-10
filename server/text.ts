import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";

export function nowIso(): string {
  return new Date().toISOString();
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export const SHORT_NAME_MAX = 40;
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

/** `value` cut to at most `max` characters, ending in an ellipsis when cut. */
export function capped(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}${ELLIPSIS}`;
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

/** A model reply's JSON object: from its first `{` to its last `}`, parsed; undefined when there is none. */
export function replyJson(text: string): unknown {
  const json = text.match(/\{[\s\S]*\}/u)?.[0];
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Logs a line unless the same `key` was logged within `intervalMs`: failures repeat for every thread or pull request,
 * and one line per distinct failure per interval keeps the plugin log readable.
 */
export function throttledLog(bb: BbPluginApi, intervalMs: number) {
  const loggedAt = new Map<string, number>();
  return (line: string, key = line) => {
    const now = Date.now();
    for (const [seen, at] of loggedAt) if (now - at >= intervalMs) loggedAt.delete(seen);
    if (loggedAt.has(key)) return;
    loggedAt.set(key, now);
    bb.log.info(line);
  };
}

/** Calls `fn` once, `ms` after the first call since it last ran; `cancel` stops it for good. */
export function coalesced(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
  return Object.assign(call, { cancel: () => clearTimeout(timer) });
}

/** Runs queued jobs `concurrency` at a time, until `stopped` says otherwise. */
export function jobQueue(concurrency: number, stopped: () => boolean = () => false) {
  const waiting: Array<() => Promise<void>> = [];
  let active = 0;
  function pump() {
    while (!stopped() && active < concurrency && waiting.length > 0) {
      const job = waiting.shift()!;
      active += 1;
      void job().finally(() => {
        active -= 1;
        pump();
      });
    }
  }
  return {
    push(job: () => Promise<void>) {
      waiting.push(job);
      pump();
    },
    clear() {
      waiting.length = 0;
    },
  };
}

/** A stored `id → value` KV record; entries that don't parse are dropped. */
export function parseRecord<T>(raw: unknown, schema: z.ZodType<T>): Record<string, T> {
  const record: Record<string, T> = {};
  if (!raw || typeof raw !== "object") return record;
  for (const [id, value] of Object.entries(raw)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) record[id] = parsed.data;
  }
  return record;
}
