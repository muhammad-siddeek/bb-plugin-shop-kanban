import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, PointerEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";

type BoardColumn = "queue" | "wip" | "blocked" | "done";

type BoardTask = {
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
};

type BoardState = {
  columns: Array<{ id: BoardColumn; title: string; description: string }>;
  tasks: BoardTask[];
};

type BoardApi = ReturnType<typeof useBoard>;

const PLUGIN_ICON = "ListTodo";
const BOARD_REFRESH_MS = 1000;
const CLOCK_TICK_MS = 15_000;
const BOTTOM_BOARD_OPEN_CLASS = "shop-kanban-bottom-open";
const BOTTOM_BOARD_HEIGHT_VAR = "--shop-kanban-bottom-height";
const DEFAULT_PANEL_MIN_HEIGHT = 320;
const PANEL_MIN_HEIGHT = 240;
const PANEL_MAX_HEIGHT_RATIO = 0.9;
const PANEL_KEYBOARD_STEP = 24;
const PANEL_KEYBOARD_LARGE_STEP = 96;
const COLUMNS: BoardColumn[] = ["queue", "wip", "blocked", "done"];

const COLUMN_META: Record<BoardColumn, {
  label: string;
  title: string;
  dot: string;
  accent: string;
  hover: string;
  badge: string;
}> = {
  queue: {
    label: "Queue",
    title: "text-sky-500",
    dot: "bg-sky-500",
    accent: "bg-sky-500",
    hover: "hover:bg-sky-500/10 hover:text-sky-500",
    badge: "bg-sky-500/15 text-sky-500",
  },
  wip: {
    label: "WIP",
    title: "text-amber-500",
    dot: "bg-amber-500",
    accent: "bg-amber-500",
    hover: "hover:bg-amber-500/10 hover:text-amber-500",
    badge: "bg-amber-500/15 text-amber-500",
  },
  blocked: {
    label: "Blocked",
    title: "text-rose-500",
    dot: "bg-rose-500",
    accent: "bg-rose-500",
    hover: "hover:bg-rose-500/10 hover:text-rose-500",
    badge: "bg-rose-500/15 text-rose-500",
  },
  done: {
    label: "Done",
    title: "text-emerald-500",
    dot: "bg-emerald-500",
    accent: "bg-emerald-500",
    hover: "hover:bg-emerald-500/10 hover:text-emerald-500",
    badge: "bg-emerald-500/15 text-emerald-500",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maxPanelHeight(): number {
  if (typeof window === "undefined") return DEFAULT_PANEL_MIN_HEIGHT;
  return Math.max(PANEL_MIN_HEIGHT, Math.round(window.innerHeight * PANEL_MAX_HEIGHT_RATIO));
}

function clampPanelHeight(value: number): number {
  return Math.min(Math.max(value, PANEL_MIN_HEIGHT), maxPanelHeight());
}

function defaultPanelHeight(): number {
  if (typeof window === "undefined") return DEFAULT_PANEL_MIN_HEIGHT;
  return clampPanelHeight(Math.max(DEFAULT_PANEL_MIN_HEIGHT, Math.round(window.innerHeight * 0.48)));
}

function shortNameFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "New task";
  return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 37).trimEnd()}…`;
}

function stripCategory(value: string): string {
  const match = value.match(/^\s*\[[^\]]+\]\s*(.*)$/u);
  return (match ? match[1] : value).trim();
}

/** Card title without the bracketed category tag; prefers the untruncated title chain. */
function taskCardTitle(task: BoardTask): string {
  const segments = task.titleChain.split(" > ");
  const current = stripCategory(segments[segments.length - 1] ?? "");
  return current || stripCategory(task.shortName) || task.shortName || task.threadId;
}

function parseTime(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Most recent activity on a card: board update, thread activity, or user input. */
function taskActivityTime(task: BoardTask): number | null {
  const candidates = [task.updatedAt, task.thread?.updatedAt, task.lastUserInputAt, task.createdAt]
    .map(parseTime)
    .filter((value): value is number => value !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

function formatRelativeTime(ms: number, now: number): string {
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

function groupTasksByColumn(board: BoardState | null): Map<BoardColumn, BoardTask[]> {
  const grouped = new Map<BoardColumn, BoardTask[]>(COLUMNS.map((column) => [column, []]));
  for (const task of board?.tasks ?? []) grouped.get(task.column)?.push(task);
  return grouped;
}

function columnMeta(column: BoardColumn) {
  return COLUMN_META[column] ?? COLUMN_META.queue;
}

function columnLabel(board: BoardState | null, column: BoardColumn): string {
  return board?.columns.find((entry) => entry.id === column)?.title ?? columnMeta(column).label;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useBoard() {
  const rpc = useRpc<any>();
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("board_list").then((result: BoardState) => {
      setBoard(result);
      setError(null);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    refetch();
    const timer = window.setInterval(refetch, BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refetch]);

  useRealtime("board-changed", refetch);
  useRealtime("board-task-status", refetch);

  return { rpc, board, error, report, refetch };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useTaskStatusNotifications() {
  useRealtime("board-task-status", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const data = payload as { column?: string; title?: string; note?: string };
    if (data.column !== "done" && data.column !== "blocked") return;
    // Historical UI surfaced this as a toast. Keep the subscription so the overlay wakes/refetches
    // even in BB builds where the toaster shim is not available to this reconstructed source.
    console.info(`[shop-kanban] ${data.title ?? "Task"} moved to ${data.column}`, data.note ?? "");
  });
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function IconButton({ icon, label, onClick, small = false, className = "" }: {
  icon: string;
  label: string;
  onClick: () => void;
  small?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex ${small ? "size-6" : "size-7"} shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      <Icon name={icon} className={small ? "size-3.5" : "size-4"} aria-hidden />
    </button>
  );
}

function TaskStatusMark({ column }: { column: BoardColumn }) {
  if (column === "wip") {
    return (
      <span aria-label="In progress" title="In progress" className="mt-px inline-flex size-4 shrink-0 items-center justify-center">
        <span className="inline-flex size-3.5 animate-spin rounded-full border-2 border-amber-500/25 border-t-amber-500" />
      </span>
    );
  }
  if (column === "done") {
    return (
      <span aria-label="Done" title="Done" className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Icon name="Check" className="size-2.5" aria-hidden />
      </span>
    );
  }
  if (column === "blocked") {
    return (
      <span aria-label="Blocked" title="Blocked" className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-rose-500 text-[11px] font-bold leading-none text-white">
        !
      </span>
    );
  }
  return (
    <span aria-label="Queued" title="Queued" className="mt-px inline-flex size-4 shrink-0 items-center justify-center">
      <span className="size-3.5 rounded-full border-2 border-dashed border-sky-500/70" />
    </span>
  );
}

function TaskCard({ task, now, labelFor, onMove, onArchive, onOpen }: {
  task: BoardTask;
  now: number;
  labelFor: (column: BoardColumn) => string;
  onMove: (threadId: string, column: BoardColumn) => void;
  onArchive: (threadId: string) => void;
  onOpen: (threadId: string) => void;
}) {
  const title = taskCardTitle(task);
  const activity = taskActivityTime(task);
  const canOpen = !task.missingThread;
  const canArchive = task.column === "done" || task.column === "blocked";

  return (
    <article
      className={`@container group relative rounded-lg border bg-card px-3 py-2.5 shadow-xs transition-[border-color,box-shadow] hover:shadow-sm ${
        task.column === "blocked" ? "border-rose-500/30 hover:border-rose-500/50" : "border-border/70 hover:border-border"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <TaskStatusMark column={task.column} />
        <div className="min-w-0 flex-1">
          {canOpen ? (
            <button
              type="button"
              onClick={() => onOpen(task.threadId)}
              title={`Open thread · ${task.titleChain}`}
              className="line-clamp-2 w-full rounded-sm text-left text-[13px] font-medium leading-snug text-foreground decoration-muted-foreground/50 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {title}
            </button>
          ) : (
            <h3 className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground" title={task.titleChain}>{title}</h3>
          )}
          {task.note ? (
            <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground" title={task.note}>{task.note}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-1.5 flex min-h-6 items-center gap-1 pl-6.5">
        {activity !== null ? (
          <time
            dateTime={new Date(activity).toISOString()}
            title={`Updated ${new Date(activity).toLocaleString()}`}
            className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/80"
          >
            {formatRelativeTime(activity, now)}
          </time>
        ) : null}
        {task.missingThread ? (
          <span className="min-w-0 truncate text-[11px] text-rose-500" title="The BB thread for this card no longer exists">· no thread</span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          {COLUMNS.filter((column) => column !== task.column).map((column) => (
            <button
              key={column}
              type="button"
              title={`Move to ${labelFor(column)}`}
              aria-label={`Move to ${labelFor(column)}`}
              className={`inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${columnMeta(column).hover}`}
              onClick={() => onMove(task.threadId, column)}
            >
              <span className={`size-2 rounded-full ${columnMeta(column).dot}`} aria-hidden />
              <span className="hidden @[20rem]:inline">{labelFor(column)}</span>
            </button>
          ))}
          {canArchive ? (
            <button
              type="button"
              title="Archive"
              aria-label="Archive"
              className="ml-0.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onArchive(task.threadId)}
            >
              <Icon name="Archive" className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function AddTaskForm({ onAdd, onCancel, onError }: {
  onAdd: (prompt: string) => Promise<void>;
  onCancel: () => void;
  onError: (cause: unknown) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const next = prompt.trim();
    if (!next || pending) return;
    setPending(true);
    try {
      await onAdd(next);
      setPrompt("");
      onCancel();
    } catch (cause) {
      onError(cause);
    } finally {
      setPending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-sky-500/40 bg-card p-2 shadow-xs ring-2 ring-sky-500/10">
      <textarea
        autoFocus
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe a new task…"
        disabled={pending}
        className="min-h-16 w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <div className="mt-1 flex items-center gap-2">
        <span className="min-w-0 truncate text-[10px] text-muted-foreground/70" title="Enter to add · Shift+Enter for a new line · Esc to cancel">↵ to add · esc to cancel</span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !prompt.trim()}
          className="shrink-0 whitespace-nowrap rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add task"}
        </button>
      </div>
    </form>
  );
}

function ColumnEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-border/70 px-3 py-6 text-xs text-muted-foreground/70">
      {children}
    </div>
  );
}

function BoardColumnView({ column, title, tasks, now, labelFor, onMove, onArchive, onOpen, adding, onStartAdding, addForm }: {
  column: BoardColumn;
  title: string;
  tasks: BoardTask[];
  now: number;
  labelFor: (column: BoardColumn) => string;
  onMove: (threadId: string, column: BoardColumn) => void;
  onArchive: (threadId: string) => void;
  onOpen: (threadId: string) => void;
  adding: boolean;
  onStartAdding: (() => void) | null;
  addForm: ReactNode;
}) {
  const meta = columnMeta(column);
  return (
    <section className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/30">
      <span className={`absolute inset-x-0 top-0 h-0.5 ${meta.accent} opacity-70`} aria-hidden />
      <header className="flex h-10 shrink-0 items-center gap-2 px-3 pt-0.5">
        <span className={`size-2 rounded-full ${meta.dot}`} aria-hidden />
        <h2 className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${meta.title}`}>{title.toUpperCase()}</h2>
        <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums ${meta.badge}`}>{tasks.length}</span>
        {onStartAdding && !adding ? (
          <IconButton icon="Plus" label="Add task" onClick={onStartAdding} small className="ml-auto" />
        ) : null}
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {adding ? addForm : null}
        {tasks.map((task) => (
          <TaskCard
            key={task.threadId}
            task={task}
            now={now}
            labelFor={labelFor}
            onMove={onMove}
            onArchive={onArchive}
            onOpen={onOpen}
          />
        ))}
        {tasks.length === 0 && !adding ? (
          onStartAdding ? (
            <button
              type="button"
              onClick={onStartAdding}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/70 px-3 py-6 text-xs text-muted-foreground/80 transition-colors hover:border-sky-500/50 hover:bg-sky-500/5 hover:text-sky-500"
            >
              <Icon name="Plus" className="size-3.5" aria-hidden />
              Add a task
            </button>
          ) : (
            <ColumnEmpty>No cards</ColumnEmpty>
          )
        ) : null}
      </div>
    </section>
  );
}

function BoardView({ api }: { api: BoardApi }) {
  const context = useBbContext();
  const navigate = useBbNavigate() as { toThread?: (threadId: string) => unknown } | null;
  const { rpc, board, error, report, refetch } = api;
  const grouped = useMemo(() => groupTasksByColumn(board), [board]);
  const now = useNow(CLOCK_TICK_MS);
  const [adding, setAdding] = useState(false);

  const labelFor = useCallback((column: BoardColumn) => columnLabel(board, column), [board]);

  const moveTask = useCallback((threadId: string, column: BoardColumn) => {
    rpc.call("board_update_task", { threadId, column }).then(refetch, report);
  }, [rpc, refetch, report]);

  const archiveTask = useCallback((threadId: string) => {
    rpc.call("board_remove_task", { threadId }).then(refetch, report);
  }, [rpc, refetch, report]);

  const openTask = useCallback((threadId: string) => {
    try {
      navigate?.toThread?.(threadId);
    } catch (cause) {
      report(cause);
    }
  }, [navigate, report]);

  const addTask = useCallback(async (prompt: string) => {
    await rpc.call("board_spawn_task", {
      shortName: shortNameFromPrompt(prompt),
      prompt,
      projectId: (context as any)?.projectId,
    });
    refetch();
  }, [context, rpc, refetch]);

  const startAdding = useCallback(() => setAdding(true), []);
  const stopAdding = useCallback(() => setAdding(false), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
        </div>
      ) : null}
      {board === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex size-3.5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground" />
          Loading board…
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-cols-[minmax(250px,1fr)] grid-flow-col gap-3 overflow-x-auto p-3">
          {board.columns.map((column) => (
            <BoardColumnView
              key={column.id}
              column={column.id}
              title={column.title}
              tasks={grouped.get(column.id) ?? []}
              now={now}
              labelFor={labelFor}
              onMove={moveTask}
              onArchive={archiveTask}
              onOpen={openTask}
              adding={column.id === "queue" && adding}
              onStartAdding={column.id === "queue" ? startAdding : null}
              addForm={<AddTaskForm onAdd={addTask} onCancel={stopAdding} onError={report} />}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom overlay
// ---------------------------------------------------------------------------

function BottomBoardOverlay() {
  const [open, setOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState(defaultPanelHeight);
  const resizeCleanupRef = useRef<() => void>(() => {});
  const api = useBoard();
  const { board, refetch } = api;
  useTaskStatusNotifications();
  const blockedTasks = board?.tasks.filter((task) => task.column === "blocked").length ?? 0;
  const wipTasks = board?.tasks.filter((task) => task.column === "wip").length ?? 0;

  const resizeBy = useCallback((delta: number) => {
    setPanelHeight((height) => clampPanelHeight(height + delta));
  }, []);

  const startResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current();

    const startY = event.clientY;
    const startHeight = panelHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      setPanelHeight(clampPanelHeight(startHeight + startY - moveEvent.clientY));
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizeCleanupRef.current = () => {};
    };

    resizeCleanupRef.current = stopResize;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize, { once: true });
    window.addEventListener("pointercancel", stopResize, { once: true });
  }, [panelHeight]);

  const handleResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        resizeBy(PANEL_KEYBOARD_STEP);
        break;
      case "ArrowDown":
        event.preventDefault();
        resizeBy(-PANEL_KEYBOARD_STEP);
        break;
      case "PageUp":
        event.preventDefault();
        resizeBy(PANEL_KEYBOARD_LARGE_STEP);
        break;
      case "PageDown":
        event.preventDefault();
        resizeBy(-PANEL_KEYBOARD_LARGE_STEP);
        break;
      case "Home":
        event.preventDefault();
        setPanelHeight(PANEL_MIN_HEIGHT);
        break;
      case "End":
        event.preventDefault();
        setPanelHeight(maxPanelHeight());
        break;
    }
  }, [resizeBy]);

  useEffect(() => {
    return () => resizeCleanupRef.current();
  }, []);

  useEffect(() => {
    const handleResize = () => setPanelHeight((height) => clampPanelHeight(height));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(BOTTOM_BOARD_OPEN_CLASS, open);
    return () => root.classList.remove(BOTTOM_BOARD_OPEN_CLASS);
  }, [open]);

  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      root.style.setProperty(BOTTOM_BOARD_HEIGHT_VAR, `${panelHeight}px`);
    } else {
      root.style.removeProperty(BOTTOM_BOARD_HEIGHT_VAR);
    }
    return () => root.style.removeProperty(BOTTOM_BOARD_HEIGHT_VAR);
  }, [open, panelHeight]);

  if (!open) {
    return (
      <button
        type="button"
        className="fixed bottom-3 right-4 z-50 inline-flex items-center gap-2 rounded-full border border-border bg-card/95 py-1.5 pl-3 pr-2 text-[13px] font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent"
        onClick={() => setOpen(true)}
        aria-label="Open Shop Kanban board"
        title="Open Shop Kanban board"
      >
        <Icon name={PLUGIN_ICON} className="size-4 text-muted-foreground" aria-hidden />
        Shop Kanban
        {wipTasks > 0 ? (
          <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums ${COLUMN_META.wip.badge}`}>{wipTasks} wip</span>
        ) : null}
        {blockedTasks > 0 ? (
          <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums ${COLUMN_META.blocked.badge}`}>{blockedTasks} blocked</span>
        ) : null}
        <Icon name="ChevronUp" className="size-3.5 text-muted-foreground" aria-hidden />
      </button>
    );
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-background/95 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur"
      style={{ height: `${panelHeight}px` }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Shop Kanban board panel"
        aria-valuemin={PANEL_MIN_HEIGHT}
        aria-valuemax={maxPanelHeight()}
        aria-valuenow={panelHeight}
        tabIndex={0}
        className="group absolute inset-x-0 -top-1.5 z-10 flex h-3 cursor-row-resize touch-none items-center justify-center focus:outline-none"
        onPointerDown={startResize}
        onKeyDown={handleResizeKeyDown}
        title="Drag to resize"
      >
        <span className="h-1 w-10 rounded-full bg-border transition-all group-hover:w-16 group-hover:bg-primary/50 group-focus-visible:w-16 group-focus-visible:bg-primary/60" />
      </div>

      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/70 pl-4 pr-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name={PLUGIN_ICON} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm font-semibold text-foreground">Shop Kanban</span>
        </div>
        {board ? (
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {board.tasks.length} task{board.tasks.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {blockedTasks > 0 ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${COLUMN_META.blocked.badge}`}>
            {blockedTasks} blocked
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon="ArrowReloadHorizontal" label="Refresh board" onClick={refetch} />
          <IconButton icon="ChevronDown" label="Hide board" onClick={() => setOpen(false)} />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <BoardView api={api} />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "bottom-board-layout",
    mount({ signal }) {
      const style = document.createElement("style");
      style.textContent = `
        html.${BOTTOM_BOARD_OPEN_CLASS} body {
          padding-bottom: var(${BOTTOM_BOARD_HEIGHT_VAR}, max(20rem, 48vh));
        }
      `;
      document.head.appendChild(style);
      const cleanup = () => {
        style.remove();
        document.documentElement.classList.remove(BOTTOM_BOARD_OPEN_CLASS);
        document.documentElement.style.removeProperty(BOTTOM_BOARD_HEIGHT_VAR);
      };
      signal.addEventListener("abort", cleanup, { once: true });
      return cleanup;
    },
  });

  // The board lives only in the bottom overlay; no nav-rail destination is registered.
  app.slots.experimental_appOverlay({
    id: "bottom-board",
    component: BottomBoardOverlay,
  });
});
