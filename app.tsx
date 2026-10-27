import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, PointerEvent } from "react";
import { definePluginApp, useBbContext, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";

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

const BOARD_REFRESH_MS = 1000;
const BOTTOM_BOARD_OPEN_CLASS = "kanban-board-bottom-open";
const BOTTOM_BOARD_HEIGHT_VAR = "--kanban-board-bottom-height";
const DEFAULT_PANEL_MIN_HEIGHT = 320;
const PANEL_MIN_HEIGHT = 240;
const PANEL_MAX_HEIGHT_RATIO = 0.9;
const PANEL_KEYBOARD_STEP = 24;
const PANEL_KEYBOARD_LARGE_STEP = 96;
const COLUMNS: BoardColumn[] = ["queue", "wip", "blocked", "done"];

const COLUMN_TONE: Record<BoardColumn, string> = {
  queue: "border-muted-foreground/25 bg-muted/40",
  wip: "border-amber-500/30 bg-amber-500/5",
  blocked: "border-destructive/30 bg-destructive/5",
  done: "border-emerald-500/30 bg-emerald-500/5",
};

const COLUMN_BADGE: Record<BoardColumn, string> = {
  queue: "bg-muted text-muted-foreground",
  wip: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "bg-destructive/10 text-destructive",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

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

function splitTaskTitle(value: string): { category: string | null; rest: string } {
  const match = value.match(/^\[([^\]]+)\]\s*(.*)$/u);
  if (!match) return { category: null, rest: value };
  return { category: match[1], rest: match[2] || value };
}

function taskCardTitle(task: BoardTask): { category: string | null; title: string } {
  const shortName = splitTaskTitle(task.shortName);
  if (shortName.category) return { category: shortName.category, title: shortName.rest };
  const segments = task.titleChain.split(" > ");
  const current = splitTaskTitle(segments[segments.length - 1] ?? task.titleChain);
  const parentCategory = splitTaskTitle(task.titleChain).category;
  return { category: current.category ?? parentCategory, title: current.rest };
}

function groupTasksByColumn(board: BoardState | null): Map<BoardColumn, BoardTask[]> {
  const grouped = new Map<BoardColumn, BoardTask[]>(COLUMNS.map((column) => [column, []]));
  for (const task of board?.tasks ?? []) grouped.get(task.column)?.push(task);
  return grouped;
}

function EmptyState({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground ${className}`}>
      {children}
    </div>
  );
}

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

function TaskStatusMark({ column }: { column: BoardColumn }) {
  if (column === "wip") {
    return (
      <span aria-label="In progress" className="relative inline-flex size-5 items-center justify-center">
        <span className="absolute inline-flex size-4 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-500" />
      </span>
    );
  }
  const label = column === "done" ? "Done" : column === "blocked" ? "Blocked" : "Queued";
  const glyph = column === "done" ? "✓" : column === "blocked" ? "×" : "?";
  return (
    <span aria-label={label} className={`inline-flex size-5 items-center justify-center rounded-full text-xs font-bold ${COLUMN_BADGE[column]}`}>
      {glyph}
    </span>
  );
}

function TaskCard({ task, onMove, onArchive }: {
  task: BoardTask;
  onMove: (threadId: string, column: BoardColumn) => void;
  onArchive: (threadId: string) => void;
}) {
  const title = taskCardTitle(task);
  const status = task.thread?.runtimeStatus ?? task.thread?.status;
  return (
    <article className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <TaskStatusMark column={task.column} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {title.category ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {title.category}
              </span>
            ) : null}
            <h3 className="min-w-0 truncate text-sm font-medium text-foreground" title={task.titleChain}>{title.title}</h3>
          </div>
          {task.note ? <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{task.note}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono">{task.threadId}</span>
            {status ? <span>{status}</span> : null}
            {task.childCount > 0 ? <span>{task.childCount} child{task.childCount === 1 ? "" : "ren"} hidden</span> : null}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {COLUMNS.filter((column) => column !== task.column).map((column) => (
          <button
            key={column}
            type="button"
            className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => onMove(task.threadId, column)}
          >
            {column}
          </button>
        ))}
        {task.column === "done" || task.column === "blocked" ? (
          <button
            type="button"
            className="ml-auto rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onArchive(task.threadId)}
          >
            archive
          </button>
        ) : null}
      </div>
    </article>
  );
}

function AddTaskForm({ onAdd }: { onAdd: (prompt: string) => Promise<void> }) {
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = prompt.trim();
    if (!next || pending) return;
    setPending(true);
    try {
      await onAdd(next);
      setPrompt("");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-2 rounded-lg border border-border bg-card p-2">
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Add a new top-level Kanban task…"
        className="min-h-16 w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="submit"
          disabled={pending || !prompt.trim()}
          className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Add task
        </button>
      </div>
    </form>
  );
}

function BoardPage({ embedded = false }: { embedded?: boolean }) {
  const context = useBbContext();
  const { rpc, board, error, report, refetch } = useBoard();
  const grouped = useMemo(() => groupTasksByColumn(board), [board]);

  const moveTask = useCallback((threadId: string, column: BoardColumn) => {
    rpc.call("board_update_task", { threadId, column }).then(refetch, report);
  }, [rpc, refetch, report]);

  const archiveTask = useCallback((threadId: string) => {
    rpc.call("board_remove_task", { threadId }).then(refetch, report);
  }, [rpc, refetch, report]);

  const addTask = useCallback(async (prompt: string) => {
    await rpc.call("board_spawn_task", {
      shortName: shortNameFromPrompt(prompt),
      prompt,
      projectId: (context as any)?.projectId,
    });
    refetch();
  }, [context, rpc, refetch]);

  return (
    <div className={embedded ? "h-full min-h-0 overflow-y-auto" : "h-full min-h-0 flex-1 overflow-y-auto"}>
      <div className={embedded ? "box-border w-full px-3 py-3" : "box-border w-full px-4 py-4 md:px-5"}>
        {embedded ? null : (
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold text-foreground">Kanban Board</h1>
              <p className="mt-1 text-sm text-muted-foreground">BB thread cards grouped by progress.</p>
            </div>
            <button type="button" className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent" onClick={refetch}>Refresh</button>
          </div>
        )}
        {error ? <p className="mb-3 rounded border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">{error}</p> : null}
        {board === null ? (
          <EmptyState>Loading Kanban board…</EmptyState>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {board.columns.map((column) => {
              const tasks = grouped.get(column.id) ?? [];
              return (
                <section key={column.id} className={`min-w-0 rounded-xl border p-3 ${COLUMN_TONE[column.id]}`}>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">{column.title}</h2>
                      <p className="text-[11px] text-muted-foreground">{column.description}</p>
                    </div>
                    <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">{tasks.length}</span>
                  </div>
                  {column.id === "queue" ? <AddTaskForm onAdd={addTask} /> : null}
                  <div className="space-y-2">
                    {tasks.length === 0 && column.id !== "queue" ? <EmptyState className="px-3 py-4 text-xs">No cards</EmptyState> : null}
                    {tasks.map((task) => (
                      <TaskCard key={task.threadId} task={task} onMove={moveTask} onArchive={archiveTask} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function useTaskStatusNotifications() {
  useRealtime("board-task-status", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const data = payload as { column?: string; title?: string; note?: string };
    if (data.column !== "done" && data.column !== "blocked") return;
    // Historical UI surfaced this as a toast. Keep the subscription so the overlay wakes/refetches
    // even in BB builds where the toaster shim is not available to this reconstructed source.
    console.info(`[kanban-board] ${data.title ?? "Task"} moved to ${data.column}`, data.note ?? "");
  });
}

function BottomBoardOverlay() {
  const [open, setOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState(defaultPanelHeight);
  const resizeCleanupRef = useRef<() => void>(() => {});
  const { board } = useBoard();
  useTaskStatusNotifications();
  const blockedTasks = board?.tasks.filter((task) => task.column === "blocked").length ?? 0;

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
        className="fixed bottom-3 right-4 z-50 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-lg hover:bg-accent"
        onClick={() => setOpen(true)}
        aria-label="Open Kanban board"
      >
        <span aria-hidden>▦</span>
        Kanban{blockedTasks > 0 ? ` · ${blockedTasks} blocked` : ""}
      </button>
    );
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-background/95 shadow-2xl backdrop-blur"
      style={{ height: `${panelHeight}px` }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Kanban board panel"
        tabIndex={0}
        className="group flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center border-b border-border/60 focus:outline-none focus:ring-2 focus:ring-ring"
        onPointerDown={startResize}
        onKeyDown={handleResizeKeyDown}
        title="Drag to resize"
      >
        <span className="h-1 w-12 rounded-full bg-border transition-colors group-hover:bg-primary/40 group-focus:bg-primary/40" />
      </div>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground" aria-hidden>▦</span>
          <span className="font-medium text-foreground">Kanban Board</span>
          {blockedTasks > 0 ? (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              {blockedTasks} blocked
            </span>
          ) : null}
        </div>
        <button type="button" className="rounded px-2 py-1 text-sm hover:bg-accent" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <BoardPage embedded />
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

  app.slots.experimental_appOverlay({
    id: "bottom-board",
    component: BottomBoardOverlay,
  });

  app.slots.navPanel({
    id: "board",
    title: "Kanban Board",
    icon: "Columns",
    path: "board",
    component: BoardPage,
  });
});
