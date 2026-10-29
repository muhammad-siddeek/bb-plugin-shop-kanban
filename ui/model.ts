import { PLUGIN_SLUG } from "../brand";
import type { z } from "zod";
import type {
  BoardSession,
  BoardTask,
  Column,
  ReviewCard,
  ReviewScope,
  ReviewState,
  SearchResponse,
  Status,
  rpcContract,
} from "../server/schema";

// Shared board types, constants, and pure helpers.

// Type-only re-exports of the server's schema types; keeps zod out of the browser bundle.
export type { BoardSession, BoardTask, ReviewCard, ReviewScope, ReviewState, SearchResponse };
export type BoardColumn = Column;
export type BoardStatus = Status;
export type BoardState = z.infer<(typeof rpcContract)["board_list"]["output"]>;

export const CLOCK_TICK_MS = 15_000;
export const BOTTOM_BOARD_OPEN_CLASS = `${PLUGIN_SLUG}-bottom-open`;
export const BOTTOM_BOARD_HEIGHT_VAR = `--${PLUGIN_SLUG}-bottom-height`;
/** Set while the board is hidden; on phones the hidden board is a bottom bar that keeps its own strip of the page. */
export const BOTTOM_BOARD_COLLAPSED_CLASS = `${PLUGIN_SLUG}-bottom-collapsed`;
/** dataTransfer type of a dragged card, carrying its thread id; only the Parked column accepts it. */
export const THREAD_DRAG_TYPE = `application/x-${PLUGIN_SLUG}-thread`;
const COLUMNS: BoardColumn[] = ["queue", "wip", "done", "parked"];

/**
 * Accent text per hue: the -500 shade on dark, -700 on light, where -500 is too faint to read (about 2:1 on
 * white). light-dark() follows the nearest bb theme scope (its .light/.dark classes set color-scheme), so the
 * selected card, drawn in the opposite theme, gets the right shade too.
 */
export const ACCENT_TEXT = {
  sky: "text-[light-dark(var(--color-sky-700),var(--color-sky-500))]",
  amber: "text-[light-dark(var(--color-amber-700),var(--color-amber-500))]",
  rose: "text-[light-dark(var(--color-rose-700),var(--color-rose-500))]",
  emerald: "text-[light-dark(var(--color-emerald-700),var(--color-emerald-500))]",
} as const;

/** A tinted pill (counts, risk chips): the tint costs contrast, so its text goes one shade darker on light. */
export const ACCENT_BADGE = {
  sky: "bg-sky-500/15 text-[light-dark(var(--color-sky-800),var(--color-sky-500))]",
  amber: "bg-amber-500/15 text-[light-dark(var(--color-amber-800),var(--color-amber-500))]",
  rose: "bg-rose-500/15 text-[light-dark(var(--color-rose-800),var(--color-rose-500))]",
  emerald: "bg-emerald-500/15 text-[light-dark(var(--color-emerald-800),var(--color-emerald-500))]",
} as const;

/** Colors per card state; each column takes those of the state it is named after. Parked is grey. */
export const STATUS_META: Record<BoardStatus, {
  title: string;
  accent: string;
  badge: string;
  outline: string;
}> = {
  queue: { title: ACCENT_TEXT.sky, accent: "bg-sky-500", badge: ACCENT_BADGE.sky, outline: "outline-sky-500" },
  wip: { title: ACCENT_TEXT.amber, accent: "bg-amber-500", badge: ACCENT_BADGE.amber, outline: "outline-amber-500" },
  blocked: { title: ACCENT_TEXT.rose, accent: "bg-rose-500", badge: ACCENT_BADGE.rose, outline: "outline-rose-500" },
  done: { title: ACCENT_TEXT.emerald, accent: "bg-emerald-500", badge: ACCENT_BADGE.emerald, outline: "outline-emerald-500" },
  parked: {
    title: "text-muted-foreground",
    accent: "bg-muted-foreground/40",
    badge: "bg-muted-foreground/15 text-muted-foreground",
    outline: "outline-muted-foreground/60",
  },
};

export function shortNameFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "New thread";
  return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 37).trimEnd()}…`;
}

function stripCategory(value: string): string {
  const match = value.match(/^\s*\[[^\]]+\]\s*(.*)$/u);
  return (match ? match[1] : value).trim();
}

/** Card title as "[category] intent"; the category comes from the first segment that has one. */
export function taskCardTitle(task: BoardTask): { category: string | null; intent: string } {
  const segments = task.titleChain.split(" > ");
  const last = segments[segments.length - 1];
  const category =
    [last, ...segments, task.shortName].map((segment) => segment.match(/^\s*\[([^\]]+)\]/u)?.[1].trim()).find(Boolean) ?? null;
  const intent = stripCategory(last) || stripCategory(task.shortName) || task.threadId;
  return { category, intent };
}

function parseTime(value: string | number | null): number | null {
  if (value === null) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Most recent activity on a card: board update, thread activity, or user input. */
export function taskActivityTime(task: BoardTask): number | null {
  const candidates = [task.updatedAt, task.thread?.updatedAt ?? null, task.lastUserInputAt, task.createdAt]
    .map(parseTime)
    .filter((value): value is number => value !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function formatRelativeTime(ms: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return plural(minutes, "min");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hr");
  const days = Math.floor(hours / 24);
  if (days < 7) return plural(days, "day");
  if (days < 30) return plural(Math.floor(days / 7), "week");
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** `formatRelativeTime` in a few characters ("now", "5m", "3h", "2d", "3w"), for one-line review cards. */
export function formatShortAge(ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Unread unless bb says it was read, or the user just opened it from the board. */
export function isUnread(task: BoardTask, readLocally: ReadonlySet<string>): boolean {
  return task.unread && !readLocally.has(task.threadId);
}

/** `parkedLocally`: cards just parked from the board, shown in Parked before the server's board catches up. */
export function groupTasksByColumn(
  board: BoardState | null,
  readLocally: ReadonlySet<string>,
  parkedLocally: ReadonlySet<string>,
): Map<BoardColumn, BoardTask[]> {
  const grouped = new Map<BoardColumn, BoardTask[]>(COLUMNS.map((column) => [column, []]));
  for (const served of board?.tasks ?? []) {
    const task = parkedLocally.has(served.threadId) ? { ...served, column: "parked" as const, status: "parked" as const } : served;
    grouped.get(task.column)?.push(task);
  }
  // Each column keeps the server's timestamp order within these groups.
  // WIP: blocked cards, which wait on the user, above running ones.
  const wip = grouped.get("wip") ?? [];
  grouped.set("wip", [...wip.filter((task) => task.status === "blocked"), ...wip.filter((task) => task.status !== "blocked")]);
  // Done: unread cards first, then read ones.
  const done = grouped.get("done") ?? [];
  grouped.set("done", [
    ...done.filter((task) => isUnread(task, readLocally)),
    ...done.filter((task) => !isUnread(task, readLocally)),
  ]);
  return grouped;
}
