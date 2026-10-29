import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, KeyboardEvent, ReactElement } from "react";
import { experimental_Icon as Icon, experimental_useCodeTheme, experimental_useProviders, useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { PLUGIN_SLUG } from "../brand";
import { CLOCK_TICK_MS, STATUS_META, THREAD_DRAG_TYPE, groupTasksByColumn, isUnread, shortNameFromPrompt, type BoardColumn, type BoardTask } from "./model";
import { useNow, type BoardApi, type ReviewsApi } from "./hooks";
import { IconButton } from "./primitives";
import { TaskCard, type ThemeScope } from "./card";
import { ReviewSection } from "./reviews";
import type { AgentProvider } from "./session";
import { WipLimitControl } from "./wip-limit";

const SCROLL_TO_LATEST_SELECTOR = 'button[aria-label="Scroll to latest event"]';
/** The new-thread form's text, written on every keystroke so a crash or reload doesn't lose it. */
const DRAFT_KEY = `${PLUGIN_SLUG}:new-thread-draft`;

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(text: string) {
  try {
    if (text) window.localStorage.setItem(DRAFT_KEY, text);
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage off: the draft lives only as long as the form.
  }
}

/**
 * After opening a thread, jump its timeline to the newest message. bb restores the last
 * scroll position per thread, so keep nudging for a moment while it mounts and restores,
 * and stop as soon as the user scrolls themselves.
 */
function scrollThreadToLatest(threadId: string) {
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

/**
 * `focus` is false when the form reopens on its own with a saved draft (after a reload or crash), so it
 * doesn't take focus from bb's composer.
 */
function AddTaskForm({ focus, onAdd, onCancel, onError }: {
  focus: boolean;
  onAdd: (prompt: string) => Promise<void>;
  onCancel: () => void;
  onError: (cause: unknown) => void;
}) {
  const [prompt, setPrompt] = useState(readDraft);
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Caret after a restored draft, ready to keep typing.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!focus || !textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [focus]);

  const edit = (text: string) => {
    setPrompt(text);
    writeDraft(text);
  };
  // Cancel means discard; only an open form keeps a draft.
  const cancel = () => {
    writeDraft("");
    onCancel();
  };
  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const next = prompt.trim();
    if (!next || pending) return;
    setPending(true);
    try {
      await onAdd(next);
      cancel();
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
      cancel();
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-busy={pending}
      className="shrink-0 rounded-lg border border-sky-500/40 bg-card p-2 shadow-sm ring-1 ring-sky-500/10 transition-[box-shadow,border-color] focus-within:border-sky-500/60 focus-within:ring-2 focus-within:ring-sky-500/20"
    >
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What should the new thread do?"
        disabled={pending}
        rows={3}
        className="block min-h-16 w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-wait disabled:opacity-60 pointer-coarse:text-base"
      />
      <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/50 pt-1.5">
        <span className="flex min-w-0 items-center gap-1 truncate text-[10px] text-muted-foreground/80 pointer-coarse:hidden" title="Enter to start · Shift+Enter for a new line · Esc to cancel">
          <kbd className="rounded border border-border/70 bg-muted/60 px-1 font-sans text-[9px] leading-[14px] text-muted-foreground">↵</kbd>
          <span>start</span>
          <kbd className="ml-1 rounded border border-border/70 bg-muted/60 px-1 font-sans text-[9px] leading-[14px] text-muted-foreground">esc</kbd>
          <span>cancel</span>
        </span>
        <button
          type="button"
          onClick={cancel}
          className="ml-auto h-6 shrink-0 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-9 pointer-coarse:px-3 pointer-coarse:text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !prompt.trim()}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-xs transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-9 pointer-coarse:px-3.5 pointer-coarse:text-sm"
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

/** What a column does with a dragged card: Parked parks any idle card, WIP starts a Queue card that has a message waiting. */
type ColumnDrop = { label: string; icon: string; onDrop: (threadId: string) => void };

function BoardColumnView({ column, title, tasks, now, readLocally, selectedThreadId, draggingId, startingIds, invertedTheme, providersById, onArchive, onPark, onStart, onDragChange, drop, onOpen, onStartAdding, headerControl, lead, addForm }: {
  column: BoardColumn;
  title: string;
  tasks: BoardTask[];
  readLocally: ReadonlySet<string>;
  now: number;
  selectedThreadId: string | null;
  /** The card being dragged, if any. */
  draggingId: string | null;
  /** Cards whose start is on its way to the server; their start button waits. */
  startingIds: ReadonlySet<string>;
  invertedTheme: ThemeScope;
  providersById: ReadonlyMap<string, AgentProvider>;
  onArchive: (threadId: string) => void;
  onPark: (threadId: string, parked: boolean) => void;
  onStart: (threadId: string) => void;
  onDragChange: (threadId: string | null) => void;
  /** Non-null while this column takes a dragged card: always for Parked, for WIP while a startable card is dragged. */
  drop: ColumnDrop | null;
  onOpen: (threadId: string) => void;
  onStartAdding: (() => void) | null;
  /** Drawn at the header's end: the WIP limit picker in WIP. */
  headerControl: ReactElement | null;
  /** Rendered above the column's cards, below the new-thread form or button: the review queue in Queue. */
  lead: ReactElement | null;
  /** The new-thread form; non-null only while it is open. */
  addForm: ReactElement | null;
}) {
  const meta = STATUS_META[column];
  const adding = addForm !== null;
  // A drag is on its way and this column takes it; `over` while the pointer is inside it. dragenter/dragleave
  // fire for every child crossed, so a depth count tells when the pointer really leaves.
  const awaitingDrop = drop !== null && draggingId !== null;
  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    if (awaitingDrop) return;
    dragDepth.current = 0;
    setOver(false);
  }, [awaitingDrop]);
  const takesDrag = (event: DragEvent) => drop !== null && event.dataTransfer.types.includes(THREAD_DRAG_TYPE);
  const dropClass = !awaitingDrop
    ? ""
    : over
      ? "bg-muted-foreground/12 outline-2 -outline-offset-2 outline-muted-foreground/70"
      : "outline-2 outline-dashed -outline-offset-2 outline-muted-foreground/45";
  return (
    <section
      aria-label={title}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/35 shadow-xs transition-[background-color,outline-color] duration-150 max-sm:snap-start ${dropClass}`}
      onDragEnter={(event) => {
        if (!takesDrag(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!takesDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(event) => {
        if (!takesDrag(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        if (!takesDrag(event) || !drop) return;
        event.preventDefault();
        dragDepth.current = 0;
        setOver(false);
        const threadId = event.dataTransfer.getData(THREAD_DRAG_TYPE);
        if (threadId) drop.onDrop(threadId);
      }}
    >
      <span className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] ${meta.accent} opacity-80`} aria-hidden />
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/40 pl-3 pr-2 pt-[3px]">
        <h2 className={`truncate text-[11px] font-bold uppercase leading-none tracking-[0.12em] ${meta.title}`}>{title.toUpperCase()}</h2>
        <span className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none tabular-nums ${meta.badge}`}>{tasks.length}</span>
        {onStartAdding && !adding ? (
          <IconButton icon="Plus" label="New thread" onClick={onStartAdding} small className="ml-auto" />
        ) : null}
        {headerControl}
      </header>
      {/* Vertical scroller only: `overflow-y-auto` alone makes x `auto` too, so content wider than the column
          would scroll the column sideways and swallow the swipe. Sideways swipes on the cards must chain to the
          board's horizontal scroll, so overscroll is contained on y only. */}
      <div data-board-column-scroll="" className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overflow-x-hidden overscroll-y-contain p-2 [scrollbar-width:thin]">
        {addForm}
        {awaitingDrop && drop ? (
          <div
            className={`flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-5 text-[11px] font-medium transition-colors ${
              over ? "border-muted-foreground/70 bg-card text-foreground" : "border-muted-foreground/40 text-muted-foreground"
            }`}
          >
            <Icon name={drop.icon} className="size-3.5" aria-hidden />
            {drop.label}
          </div>
        ) : null}
        {onStartAdding && !adding ? (
          <button
            type="button"
            onClick={onStartAdding}
            className="flex w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/60 px-3 py-5 text-[11px] text-muted-foreground/90 transition-colors hover:border-sky-500/50 hover:bg-sky-500/5 hover:text-[light-dark(var(--color-sky-700),var(--color-sky-500))] focus-visible:border-sky-500/60 focus-visible:text-[light-dark(var(--color-sky-700),var(--color-sky-500))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/20"
          >
            <Icon name="Plus" className="size-3.5" aria-hidden />
            New thread
          </button>
        ) : tasks.length === 0 && !adding && !awaitingDrop ? (
          <div className="flex shrink-0 items-center justify-center rounded-lg border border-dashed border-border/60 px-3 py-5 text-center text-[11px] text-muted-foreground/90">
            {column === "parked" ? "Drag an idle thread here to come back to it later" : "No threads"}
          </div>
        ) : null}
        {lead}
        {tasks.map((task) => (
          <TaskCard
            key={task.threadId}
            task={task}
            now={now}
            unread={task.status === "done" && isUnread(task, readLocally)}
            selected={task.threadId === selectedThreadId}
            dragging={task.threadId === draggingId}
            starting={startingIds.has(task.threadId)}
            invertedTheme={invertedTheme}
            provider={task.thread?.providerId ? providersById.get(task.thread.providerId) ?? null : null}
            onArchive={onArchive}
            onPark={onPark}
            onStart={onStart}
            onDragChange={onDragChange}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

export function BoardView({ api, reviews }: { api: BoardApi; reviews: ReviewsApi }) {
  const context = useBbContext();
  const selectedThreadId = context.threadId;
  // The selected card renders in the opposite theme so it pops against the board.
  const invertedTheme: ThemeScope = experimental_useCodeTheme().mode === "dark" ? "light" : "dark";
  // Same roster and lookup as bb's sidebar: a thread's harness icon is its agent provider's artwork.
  const { providers } = experimental_useProviders();
  const providersById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const navigate = useBbNavigate();
  const { rpc, board, error, report, refetch } = api;
  // Cards opened from the board count as read right away, before bb's read state round-trips.
  const [readLocally, setReadLocally] = useState<ReadonlySet<string>>(() => new Set());
  // Cards parked from the board move to Parked right away, before the server's board round-trips.
  const [parkedLocally, setParkedLocally] = useState<ReadonlySet<string>>(() => new Set());
  const grouped = useMemo(() => groupTasksByColumn(board, readLocally, parkedLocally), [board, readLocally, parkedLocally]);
  useEffect(() => {
    // Drop local overrides once the server agrees, so later activity can mark the card unread again.
    if (!board || readLocally.size === 0) return;
    const next = new Set(board.tasks.filter((task) => task.unread && readLocally.has(task.threadId)).map((task) => task.threadId));
    if (next.size !== readLocally.size) setReadLocally(next);
  }, [board, readLocally]);
  useEffect(() => {
    // Likewise once the server shows them parked, or they left the board.
    if (!board || parkedLocally.size === 0) return;
    const next = new Set(
      board.tasks.filter((task) => task.status !== "parked" && parkedLocally.has(task.threadId)).map((task) => task.threadId),
    );
    if (next.size !== parkedLocally.size) setParkedLocally(next);
  }, [board, parkedLocally]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingStartable = board?.tasks.some((task) => task.threadId === draggingId && task.startable) ?? false;
  // Cards started from the board: their start button waits until the server's board shows them started.
  const [startingIds, setStartingIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    // Drop them once the server's board no longer offers to start them, or they left the board.
    if (!board || startingIds.size === 0) return;
    const next = new Set(board.tasks.filter((task) => task.startable && startingIds.has(task.threadId)).map((task) => task.threadId));
    if (next.size !== startingIds.size) setStartingIds(next);
  }, [board, startingIds]);
  const now = useNow(CLOCK_TICK_MS);
  // A saved draft means the form was open with text when the app last closed: reopen it, without focus.
  const [adding, setAdding] = useState<"closed" | "restored" | "opened">(() => (readDraft() ? "restored" : "closed"));

  const archiveTask = (threadId: string) => {
    rpc.call("board_remove_task", { threadId }).then(refetch, report);
  };

  const forgetParked = (threadId: string) => {
    setParkedLocally((current) => {
      if (!current.has(threadId)) return current;
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
  };

  const parkTask = (threadId: string, parked: boolean) => {
    // Parking shows right away; unparking waits for the server, which decides where the card goes.
    if (parked) setParkedLocally((current) => new Set([...current, threadId]));
    else forgetParked(threadId);
    rpc.call("board_park_task", { threadId, parked }).then(
      (task) => {
        // A thread that started running meanwhile stays where it is.
        if (task.status !== "parked") forgetParked(threadId);
        refetch();
      },
      (cause) => {
        forgetParked(threadId);
        report(cause);
      },
    );
  };

  const dropPark = (threadId: string) => {
    // The card leaves its column before its dragend fires, and a removed card's dragend never reaches React.
    setDraggingId(null);
    parkTask(threadId, true);
  };

  const startTask = (threadId: string) => {
    setStartingIds((current) => new Set([...current, threadId]));
    rpc.call("board_start_task", { threadId }).then(refetch, (cause) => {
      setStartingIds((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
      report(cause);
    });
  };

  const openTask = (threadId: string) => {
    setReadLocally((current) => (current.has(threadId) ? current : new Set([...current, threadId])));
    rpc.call("board_mark_read", { threadId }).then(refetch, refetch);
    try {
      navigate.toThread(threadId);
      scrollThreadToLatest(threadId);
    } catch (cause) {
      report(cause);
    }
  };

  const addTask = async (prompt: string) => {
    // With no thread open there is no project: leave the key out (the server picks one); an undefined value isn't JSON.
    await rpc.call("board_spawn_task", {
      shortName: shortNameFromPrompt(prompt),
      prompt,
      ...(context.projectId ? { projectId: context.projectId } : {}),
    });
    refetch();
  };

  const setWipLimit = (limit: number | null) => {
    rpc.call("board_set_wip_limit", { limit }).then(refetch, report);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div role="alert" className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive">
          <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
        </div>
      ) : null}
      {board ? (
        // Phones: one column per screen with a peek of the next, snapping as you swipe.
        <div data-board-scroll="" className="grid min-h-0 flex-1 auto-cols-[minmax(250px,1fr)] grid-flow-col gap-2.5 overflow-x-auto overscroll-x-contain p-3 [scrollbar-width:thin] max-sm:auto-cols-[calc(100%-2.5rem)] max-sm:snap-x max-sm:snap-mandatory max-sm:scroll-px-3">
          {board.columns.map((column) => (
            <BoardColumnView
              key={column.id}
              column={column.id}
              title={column.title}
              tasks={grouped.get(column.id) ?? []}
              now={now}
              readLocally={readLocally}
              selectedThreadId={selectedThreadId}
              draggingId={draggingId}
              startingIds={startingIds}
              invertedTheme={invertedTheme}
              providersById={providersById}
              onArchive={archiveTask}
              onPark={parkTask}
              onStart={startTask}
              onDragChange={setDraggingId}
              drop={
                column.id === "parked"
                  ? { label: "Drop to park", icon: "Pause", onDrop: dropPark }
                  : column.id === "wip" && draggingStartable
                    ? { label: "Drop to start now", icon: "Play", onDrop: startTask }
                    : null
              }
              onOpen={openTask}
              onStartAdding={column.id === "queue" ? () => setAdding("opened") : null}
              headerControl={
                column.id === "wip" ? (
                  <WipLimitControl
                    limit={board.wipLimit.limit}
                    running={(grouped.get("wip") ?? []).filter((task) => task.status === "wip").length}
                    waiting={board.wipLimit.waiting}
                    onChange={setWipLimit}
                  />
                ) : null
              }
              lead={column.id === "queue" ? <ReviewSection reviews={reviews} now={now} /> : null}
              addForm={
                column.id === "queue" && adding !== "closed" ? (
                  <AddTaskForm focus={adding === "opened"} onAdd={addTask} onCancel={() => setAdding("closed")} onError={report} />
                ) : null
              }
            />
          ))}
        </div>
      ) : error ? null : (
        // Before the first board arrives; if reads fail, only the error above shows while they retry.
        <div role="status" aria-live="polite" className="flex flex-1 items-center justify-center gap-2.5 text-xs font-medium text-muted-foreground">
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/80" aria-hidden />
          Loading board…
        </div>
      )}
    </div>
  );
}

