import { PLUGIN_SLUG } from "../brand";
import type { z } from "zod";
import type {
  AiUsage,
  BoardSession,
  BoardTask,
  Column,
  ReviewCard,
  ReviewScope,
  ReviewState,
  RemoteState,
  SearchResponse,
  Status,
  SystemProcesses,
  SystemStats,
  WorkItem,
  WorkList,
  WorkMark,
  WorkSource,
  WorkState,
  rpcContract,
} from "../server/schema";

// Shared board types, constants, and pure helpers.

// Type-only re-exports of the server's schema types; keeps zod out of the browser bundle.
export type { AiUsage, BoardSession, BoardTask, RemoteState, ReviewCard, ReviewScope, ReviewState, SearchResponse, SystemProcesses, SystemStats, WorkItem, WorkList, WorkMark, WorkSource, WorkState };
export type RemoteItem = RemoteState["items"][number];
export type BoardColumn = Column;
export type BoardStatus = Status;
export type BoardState = z.infer<(typeof rpcContract)["board_list"]["output"]>;

export const CLOCK_TICK_MS = 15_000;
export const TOP_BOARD_CLASS = `${PLUGIN_SLUG}-top-docked`;
export const TOP_BOARD_INSET_VAR = `--${PLUGIN_SLUG}-top-inset`;
export const TOP_BOARD_ATTR = `data-${PLUGIN_SLUG}-board`;
/** dataTransfer type of a dragged card, carrying its thread id; only the Parked column accepts it. */
export const THREAD_DRAG_TYPE = `application/x-${PLUGIN_SLUG}-thread`;
const COLUMNS: BoardColumn[] = ["queue", "wip", "done", "parked"];

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

/** Epoch ms from a timestamp (epoch ms or an ISO string); null when it isn't one. */
export function parseTime(value: string | number | null): number | null {
  if (value === null) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A pull request's or issue's short reference: `repo#123`. */
export function prRef(item: { repo: string; number: number }): string {
  return `${item.repo.split("/").pop()}#${item.number}`;
}

/**
 * The time a card shows: a Done card's completion (so the age matches its place in the column), otherwise its most
 * recent activity: board update, thread activity, or user input.
 */
export function taskActivityTime(task: BoardTask): number | null {
  const completed = task.status === "done" ? parseTime(task.completedAt) : null;
  if (completed !== null) return completed;
  const candidates = [task.updatedAt, task.thread?.updatedAt ?? null, task.lastUserInputAt, task.createdAt]
    .map(parseTime)
    .filter((value): value is number => value !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

/** An age in a few characters ("now", "5m", "3h", "2d", "3w", then "Oct 1"): every card, row and result uses it. */
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

/** Built once per currency and precision: every card formats its cost on each render. */
const moneyFormats = new Map<string, Intl.NumberFormat>();

/**
 * Money, one rule everywhere. `exact` (tooltips, popovers, totals someone reads closely) always has cents.
 * Otherwise (card footers, the title bar chip) cents show only under $10, where they change the reading:
 * "$4.30", "$53", "$418". Anything under a cent reads "<$0.01".
 */
export function formatMoney(amount: number, currency = "USD", exact = false): string {
  const tiny = amount > 0 && amount < 0.01;
  const value = tiny ? 0.01 : amount;
  const digits = exact || value < 10 ? 2 : 0;
  const key = `${currency}:${digits}`;
  let text: string;
  try {
    let formatter = moneyFormats.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
      moneyFormats.set(key, formatter);
    }
    text = formatter.format(value);
  } catch {
    text = `${value.toFixed(digits)} ${currency}`;
  }
  return tiny ? `<${text}` : text;
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `parkedLocally`: cards just parked from the board, shown in Parked before the server's board catches up. */
export function groupTasksByColumn(
  board: BoardState | null,
  parkedLocally: ReadonlyMap<string, unknown>,
): Map<BoardColumn, BoardTask[]> {
  const grouped = new Map<BoardColumn, BoardTask[]>(COLUMNS.map((column) => [column, []]));
  for (const served of board?.tasks ?? []) {
    const task = parkedLocally.has(served.threadId) ? { ...served, column: "parked" as const, status: "parked" as const } : served;
    grouped.get(task.column)?.push(task);
  }
  // Working: blocked cards, which wait on the user, above working ones; each group keeps the server's order.
  const wip = grouped.get("wip") ?? [];
  grouped.set("wip", [...wip.filter((task) => task.status === "blocked"), ...wip.filter((task) => task.status !== "blocked")]);
  // Done: newest completion first, read or not, so a card keeps its place from the moment it lands. Completion only
  // moves when a thread finishes another turn, so reading, relabeling or renaming a card doesn't reshuffle the column.
  grouped.get("done")?.sort((a, b) => (taskActivityTime(b) ?? 0) - (taskActivityTime(a) ?? 0));
  return grouped;
}
