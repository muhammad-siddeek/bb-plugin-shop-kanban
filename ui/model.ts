import { PLUGIN_SLUG } from "../brand";
import type { BoardSession } from "../server/schema";

// Shared board types, constants, and pure helpers.

// Type-only re-export of the server's schema type; keeps zod out of the browser bundle.
export type { BoardSession };

export type BoardColumn = "queue" | "wip" | "blocked" | "done";

export type BoardTask = {
  threadId: string;
  shortName: string;
  titleChain: string;
  column: BoardColumn;
  parentThreadId: string | null;
  projectId: string | null;
  description: string | null;
  result: "success" | "failed" | null;
  note: string | null;
  showOnBoard: boolean;
  showChildren: boolean;
  childCount: number;
  hiddenChildCount: number;
  runningChildCount?: number;
  statusReason?: string | null;
  unread?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUserInputAt: string | null;
  missingThread: boolean;
  thread: {
    id: string;
    title: string | null;
    titleFallback: string | null;
    status: string | null;
    runtimeStatus: string | null;
    providerId: string | null;
    updatedAt: number | null;
    archivedAt: number | null;
  } | null;
  session: BoardSession | null;
};

export type BoardState = {
  columns: Array<{ id: BoardColumn; title: string; description: string }>;
  tasks: BoardTask[];
};

export const PLUGIN_ICON = "ListTodo";
export const BOARD_REFRESH_MS = 1000;
export const CLOCK_TICK_MS = 15_000;
export const BOTTOM_BOARD_OPEN_CLASS = `${PLUGIN_SLUG}-bottom-open`;
export const BOTTOM_BOARD_HEIGHT_VAR = `--${PLUGIN_SLUG}-bottom-height`;
const DEFAULT_PANEL_MIN_HEIGHT = 320;
export const PANEL_MIN_HEIGHT = 240;
const PANEL_MAX_HEIGHT_RATIO = 0.9;
export const PANEL_KEYBOARD_STEP = 24;
export const PANEL_KEYBOARD_LARGE_STEP = 96;
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

export function maxPanelHeight(): number {
  if (typeof window === "undefined") return DEFAULT_PANEL_MIN_HEIGHT;
  return Math.max(PANEL_MIN_HEIGHT, Math.round(window.innerHeight * PANEL_MAX_HEIGHT_RATIO));
}

export function clampPanelHeight(value: number): number {
  return Math.min(Math.max(value, PANEL_MIN_HEIGHT), maxPanelHeight());
}

export function defaultPanelHeight(): number {
  if (typeof window === "undefined") return DEFAULT_PANEL_MIN_HEIGHT;
  return clampPanelHeight(Math.max(DEFAULT_PANEL_MIN_HEIGHT, Math.round(window.innerHeight * 0.48)));
}

export function shortNameFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "New task";
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

const SCROLL_TO_LATEST_SELECTOR = 'button[aria-label="Scroll to latest event"]';

/**
 * After opening a thread, jump its timeline to the newest message. bb restores the last
 * scroll position per thread, so keep nudging for a moment while it mounts and restores,
 * and stop as soon as the user scrolls themselves.
 */
export function scrollThreadToLatest(threadId: string) {
  if (typeof window === "undefined") return;
  const startedAt = Date.now();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  for (const name of events) window.addEventListener(name, cancel, { capture: true, passive: true, once: true });
  const cleanup = () => {
    for (const name of events) window.removeEventListener(name, cancel, { capture: true });
  };
  const tick = () => {
    if (cancelled) return cleanup();
    const onThread = window.location.pathname.includes(`/threads/${threadId}`);
    if (onThread || Date.now() - startedAt > 400) {
      const buttons = document.querySelectorAll<HTMLButtonElement>(SCROLL_TO_LATEST_SELECTOR);
      if (buttons.length > 0) {
        for (const button of buttons) button.click();
      } else {
        for (const viewport of document.querySelectorAll<HTMLElement>("[data-thread-window] [data-page-scroll-viewport]")) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      }
    }
    if (Date.now() - startedAt < 1_800) window.setTimeout(tick, 150);
    else cleanup();
  };
  window.requestAnimationFrame(tick);
}

// Reveal margins: the column list's p-2 (covers the selected card's 4px outline) and the grid's p-3.
const REVEAL_MARGIN_Y = 8;
const REVEAL_MARGIN_X = 12;

/**
 * Smallest scroll delta that fits [start, end] inside the band inset by `margin`: zero when it already
 * fits, otherwise just the overshoot at the nearer edge; content larger than the band aligns its start.
 */
function revealDelta(start: number, end: number, bandStart: number, bandSize: number, margin: number): number {
  const min = bandStart + margin;
  const max = bandStart + bandSize - margin;
  if (start < min) return Math.round(start - min);
  if (end > max) return Math.round(end - start > max - min ? start - min : end - max);
  return 0;
}

/**
 * Scroll the board so `card` is fully visible with minimal movement: no scroll when it already is,
 * otherwise only enough to clear the nearest edge — vertically in its column, horizontally in the board
 * grid. Scrolls only the board's own containers (never `scrollIntoView`, which would move bb's layout too).
 */
export function revealBoardCard(card: HTMLElement) {
  if (typeof window === "undefined") return;
  const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

  const list = card.closest<HTMLElement>("[data-board-column-scroll]");
  if (list) {
    const cardRect = card.getBoundingClientRect();
    const top = list.getBoundingClientRect().top + list.clientTop;
    const delta = revealDelta(cardRect.top, cardRect.bottom, top, list.clientHeight, REVEAL_MARGIN_Y);
    if (delta !== 0) list.scrollTo({ top: list.scrollTop + delta, behavior });
  }

  const column = card.closest<HTMLElement>("section");
  const grid = column?.closest<HTMLElement>("[data-board-scroll]");
  if (column && grid) {
    const columnRect = column.getBoundingClientRect();
    const left = grid.getBoundingClientRect().left + grid.clientLeft;
    const delta = revealDelta(columnRect.left, columnRect.right, left, grid.clientWidth, REVEAL_MARGIN_X);
    if (delta !== 0) grid.scrollTo({ left: grid.scrollLeft + delta, behavior });
  }
}

/** Scroll-independent signature of where `card` sits on the board; changes only when the layout does. */
export function boardCardLayoutKey(card: HTMLElement): string | null {
  const list = card.closest<HTMLElement>("[data-board-column-scroll]");
  const column = list?.closest<HTMLElement>("section");
  const grid = column?.closest<HTMLElement>("[data-board-scroll]");
  if (!list || !column || !grid) return null;
  const cardRect = card.getBoundingClientRect();
  const columnRect = column.getBoundingClientRect();
  return [
    cardRect.top - list.getBoundingClientRect().top + list.scrollTop,
    cardRect.height,
    list.clientHeight,
    columnRect.left - grid.getBoundingClientRect().left + grid.scrollLeft,
    columnRect.width,
    grid.clientWidth,
  ]
    .map((value) => Math.round(value))
    .join(":");
}

function parseTime(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Most recent activity on a card: board update, thread activity, or user input. */
export function taskActivityTime(task: BoardTask): number | null {
  const candidates = [task.updatedAt, task.thread?.updatedAt, task.lastUserInputAt, task.createdAt]
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

/** Unread unless bb says it was read, or the user just opened it from the board. */
export function isUnread(task: BoardTask, readLocally: ReadonlySet<string>): boolean {
  return task.unread === true && !readLocally.has(task.threadId);
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

export function columnMeta(column: BoardColumn) {
  return COLUMN_META[column] ?? COLUMN_META.queue;
}

