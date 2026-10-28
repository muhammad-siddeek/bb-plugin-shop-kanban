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
  rpcContract,
} from "../server/schema";

// Shared board types, constants, and pure helpers.

// Type-only re-exports of the server's schema types; keeps zod out of the browser bundle.
export type { BoardSession, BoardTask, ReviewCard, ReviewScope, ReviewState, SearchResponse };
export type BoardColumn = Column;
export type BoardState = z.infer<(typeof rpcContract)["board_list"]["output"]>;

export const CLOCK_TICK_MS = 15_000;
export const BOTTOM_BOARD_OPEN_CLASS = `${PLUGIN_SLUG}-bottom-open`;
export const BOTTOM_BOARD_HEIGHT_VAR = `--${PLUGIN_SLUG}-bottom-height`;
const COLUMNS: BoardColumn[] = ["queue", "wip", "blocked", "done"];

export const COLUMN_META: Record<BoardColumn, {
  title: string;
  accent: string;
  badge: string;
  outline: string;
}> = {
  queue: {
    title: "text-sky-500",
    accent: "bg-sky-500",
    badge: "bg-sky-500/15 text-sky-500",
    outline: "outline-sky-500",
  },
  wip: {
    title: "text-amber-500",
    accent: "bg-amber-500",
    badge: "bg-amber-500/15 text-amber-500",
    outline: "outline-amber-500",
  },
  blocked: {
    title: "text-rose-500",
    accent: "bg-rose-500",
    badge: "bg-rose-500/15 text-rose-500",
    outline: "outline-rose-500",
  },
  done: {
    title: "text-emerald-500",
    accent: "bg-emerald-500",
    badge: "bg-emerald-500/15 text-emerald-500",
    outline: "outline-emerald-500",
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

export function groupTasksByColumn(board: BoardState | null, readLocally: ReadonlySet<string>): Map<BoardColumn, BoardTask[]> {
  const grouped = new Map<BoardColumn, BoardTask[]>(COLUMNS.map((column) => [column, []]));
  for (const task of board?.tasks ?? []) grouped.get(task.column)?.push(task);
  // Done: unread cards first, then read ones; each group keeps the server's timestamp order.
  const done = grouped.get("done") ?? [];
  grouped.set("done", [
    ...done.filter((task) => isUnread(task, readLocally)),
    ...done.filter((task) => !isUnread(task, readLocally)),
  ]);
  return grouped;
}
