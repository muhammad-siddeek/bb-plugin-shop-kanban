import { useEffect, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactElement, ReactNode } from "react";
import { experimental_Icon as Icon, experimental_useCodeTheme, experimental_useProviders, useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { CLOCK_TICK_MS, columnMeta, groupTasksByColumn, isUnread, scrollThreadToLatest, shortNameFromPrompt, type BoardColumn, type BoardTask } from "./model";
import { useNow, type BoardApi, type ReviewsApi } from "./hooks";
import { IconButton } from "./primitives";
import { TaskCard, type ThemeScope } from "./card";
import { ReviewSection } from "./reviews";
import type { AgentProvider } from "./session";

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
    <form
      onSubmit={submit}
      aria-busy={pending}
      className="shrink-0 rounded-lg border border-sky-500/40 bg-card p-2 shadow-sm ring-1 ring-sky-500/10 transition-[box-shadow,border-color] focus-within:border-sky-500/60 focus-within:ring-2 focus-within:ring-sky-500/20"
    >
      <textarea
        autoFocus
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What should the new thread do?"
        disabled={pending}
        rows={3}
        className="block min-h-16 w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-wait disabled:opacity-60"
      />
      <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/50 pt-1.5">
        <span className="flex min-w-0 items-center gap-1 truncate text-[10px] text-muted-foreground/70" title="Enter to start · Shift+Enter for a new line · Esc to cancel">
          <kbd className="rounded border border-border/70 bg-muted/60 px-1 font-sans text-[9px] leading-[14px] text-muted-foreground">↵</kbd>
          <span>start</span>
          <kbd className="ml-1 rounded border border-border/70 bg-muted/60 px-1 font-sans text-[9px] leading-[14px] text-muted-foreground">esc</kbd>
          <span>cancel</span>
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto h-6 shrink-0 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !prompt.trim()}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-xs transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            <>
              <span className="inline-flex size-2.5 animate-spin rounded-full border-[1.5px] border-primary-foreground/30 border-t-primary-foreground" aria-hidden />
              Starting…
            </>
          ) : "Start thread"}
        </button>
      </div>
    </form>
  );
}

function ColumnEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-center rounded-lg border border-dashed border-border/60 px-3 py-5 text-[11px] text-muted-foreground/60">
      {children}
    </div>
  );
}

function BoardColumnView({ column, title, tasks, now, readLocally, selectedThreadId, invertedTheme, providersById, onArchive, onOpen, onStartAdding, lead, addForm }: {
  column: BoardColumn;
  title: string;
  tasks: BoardTask[];
  readLocally: ReadonlySet<string>;
  now: number;
  selectedThreadId: string | null;
  invertedTheme: ThemeScope;
  providersById: ReadonlyMap<string, AgentProvider>;
  onArchive: (threadId: string) => void;
  onOpen: (threadId: string) => void;
  onStartAdding: (() => void) | null;
  /** Rendered above the column's cards: the review queue in Queue. */
  lead: ReactElement | null;
  /** The new-task form; non-null only while it is open. */
  addForm: ReactElement | null;
}) {
  const meta = columnMeta(column);
  const adding = addForm !== null;
  return (
    <section
      aria-label={title}
      className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/35 shadow-xs"
    >
      <span className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] ${meta.accent} opacity-80`} aria-hidden />
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/40 pl-3 pr-2 pt-[3px]">
        <h2 className={`truncate text-[11px] font-bold uppercase leading-none tracking-[0.12em] ${meta.title}`}>{title.toUpperCase()}</h2>
        <span className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none tabular-nums ${meta.badge}`}>{tasks.length}</span>
        {onStartAdding && !adding ? (
          <IconButton icon="Plus" label="New thread" onClick={onStartAdding} small className="ml-auto" />
        ) : null}
      </header>
      <div data-board-column-scroll="" className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]">
        {lead}
        {addForm}
        {tasks.map((task) => (
          <TaskCard
            key={task.threadId}
            task={task}
            now={now}
            unread={task.column === "done" && isUnread(task, readLocally)}
            selected={task.threadId === selectedThreadId}
            invertedTheme={invertedTheme}
            provider={task.thread?.providerId ? providersById.get(task.thread.providerId) ?? null : null}
            onArchive={onArchive}
            onOpen={onOpen}
          />
        ))}
        {tasks.length === 0 && !adding ? (
          onStartAdding ? (
            <button
              type="button"
              onClick={onStartAdding}
              className="flex w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/60 px-3 py-5 text-[11px] text-muted-foreground/70 transition-colors hover:border-sky-500/50 hover:bg-sky-500/5 hover:text-sky-500 focus-visible:border-sky-500/60 focus-visible:text-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/20"
            >
              <Icon name="Plus" className="size-3.5" aria-hidden />
              New thread
            </button>
          ) : (
            <ColumnEmpty>No threads</ColumnEmpty>
          )
        ) : null}
      </div>
    </section>
  );
}

export function BoardView({ api, reviews }: { api: BoardApi; reviews: ReviewsApi }) {
  const context = useBbContext();
  const selectedThreadId = context?.threadId ?? null;
  // The selected card renders in the opposite theme so it pops against the board.
  const invertedTheme: ThemeScope = experimental_useCodeTheme().mode === "dark" ? "light" : "dark";
  // Same roster and lookup as bb's sidebar: a thread's harness icon is its agent provider's artwork.
  const { providers } = experimental_useProviders();
  const providersById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const navigate = useBbNavigate();
  const { rpc, board, error, report, refetch } = api;
  // Cards opened from the board count as read right away, before bb's read state round-trips.
  const [readLocally, setReadLocally] = useState<ReadonlySet<string>>(() => new Set());
  const grouped = useMemo(() => groupTasksByColumn(board, readLocally), [board, readLocally]);
  useEffect(() => {
    // Drop local overrides once the server agrees, so later activity can mark the card unread again.
    if (!board || readLocally.size === 0) return;
    const stillUnread = new Set(board.tasks.filter((task) => task.unread).map((task) => task.threadId));
    const next = new Set([...readLocally].filter((id) => stillUnread.has(id)));
    if (next.size !== readLocally.size) setReadLocally(next);
  }, [board, readLocally]);
  const now = useNow(CLOCK_TICK_MS);
  const [adding, setAdding] = useState(false);

  const archiveTask = (threadId: string) => {
    rpc.call("board_remove_task", { threadId }).then(refetch, report);
  };

  const openTask = (threadId: string) => {
    setReadLocally((current) => (current.has(threadId) ? current : new Set([...current, threadId])));
    rpc.call("board_mark_read", { threadId }).then(refetch, refetch);
    try {
      navigate?.toThread?.(threadId);
      scrollThreadToLatest(threadId);
    } catch (cause) {
      report(cause);
    }
  };

  const addTask = async (prompt: string) => {
    await rpc.call("board_spawn_task", {
      shortName: shortNameFromPrompt(prompt),
      prompt,
      projectId: context?.projectId,
    });
    refetch();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div role="alert" className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive">
          <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
        </div>
      ) : null}
      {board === null ? (
        <div role="status" aria-live="polite" className="flex flex-1 items-center justify-center gap-2.5 text-xs font-medium text-muted-foreground">
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/80" aria-hidden />
          Loading board…
        </div>
      ) : (
        <div data-board-scroll="" className="grid min-h-0 flex-1 auto-cols-[minmax(250px,1fr)] grid-flow-col gap-2.5 overflow-x-auto overscroll-x-contain p-3 [scrollbar-width:thin]">
          {board.columns.map((column) => (
            <BoardColumnView
              key={column.id}
              column={column.id}
              title={column.title}
              tasks={grouped.get(column.id) ?? []}
              now={now}
              readLocally={readLocally}
              selectedThreadId={selectedThreadId}
              invertedTheme={invertedTheme}
              providersById={providersById}
              onArchive={archiveTask}
              onOpen={openTask}
              onStartAdding={column.id === "queue" ? () => setAdding(true) : null}
              lead={column.id === "queue" ? <ReviewSection reviews={reviews} now={now} /> : null}
              addForm={column.id === "queue" && adding ? <AddTaskForm onAdd={addTask} onCancel={() => setAdding(false)} onError={report} /> : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

