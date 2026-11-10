import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, KeyboardEvent, ReactElement, ReactNode } from "react";
import { experimental_Icon as Icon, experimental_useProviders, useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { PLUGIN_SLUG } from "../brand";
import { ACCENT_BADGE, CLOCK_TICK_MS, STATUS_META, THREAD_DRAG_TYPE, groupTasksByColumn, isUnread, shortNameFromPrompt, type BoardColumn, type BoardState, type BoardTask } from "./model";
import { useNow, type BoardApi, type ReviewsApi, type WorkApi } from "./hooks";
import { TaskCard } from "./card";
import { ReviewGroup, visibleReviews } from "./reviews";
import { WipLimitControl } from "./wip-limit";
import { WorkGroup, useWorkItems } from "./work";
import { CARD_INSET, TYPE } from "./primitives";

const SCROLL_TO_LATEST_SELECTOR = 'button[aria-label="Scroll to latest event"]';
/** The new-thread form's text, written on every keystroke so a crash or reload doesn't lose it. */
const DRAFT_KEY = `${PLUGIN_SLUG}:new-thread-draft`;
/** The Queue column's open tab, kept across reloads. */
const QUEUE_TAB_KEY = `${PLUGIN_SLUG}:queue-tab`;

/** The Queue column's tabs: threads waiting to start, work coming to the user, and work going out from them. */
type QueueTab = "queue" | "incoming" | "outgoing";
const QUEUE_TABS: { id: QueueTab; label: string; hint: string }[] = [
  { id: "queue", label: "Queue", hint: "Threads waiting to be started" },
  { id: "incoming", label: "In", hint: "Pull requests waiting on your review, and issues assigned to you" },
  { id: "outgoing", label: "Out", hint: "Your open pull requests, and merged ones still to measure or demo" },
];

/** A localStorage value; null when storage is off. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store `value` (empty removes it); with storage off it lives only as long as the page. */
function writeStored(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage off.
  }
}

function readQueueTab(): QueueTab {
  const stored = readStored(QUEUE_TAB_KEY);
  return QUEUE_TABS.some((tab) => tab.id === stored) ? (stored as QueueTab) : "queue";
}

/** `set` with `id` added, or `set` itself when it already holds it. */
function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return set.has(id) ? set : new Set([...set, id]);
}

/** `set` without `id`, or `set` itself when it doesn't hold it. */
function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

/**
 * Thread ids the board applied before the server's board caught up. Each is dropped once the board no longer
 * `holds` its card (the server agrees, or the card left the board).
 */
function useLocalIds(board: BoardState | null, holds: (task: BoardTask) => boolean) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!board || ids.size === 0) return;
    const next = new Set(board.tasks.filter((task) => holds(task) && ids.has(task.threadId)).map((task) => task.threadId));
    if (next.size !== ids.size) setIds(next);
    // `holds` is a pure test written inline: only the board and the ids change its answer.
  }, [board, ids]);
  return [ids, setIds] as const;
}

/** Outline of a column or section while a dragged card is on its way: dashed, solid once the card is over it. */
function dropOutline(awaiting: boolean, over: boolean): string {
  if (!awaiting) return "";
  return over
    ? "bg-muted-foreground/12 outline-2 -outline-offset-2 outline-muted-foreground/70"
    : "outline-2 outline-dashed -outline-offset-2 outline-muted-foreground/45";
}

/**
 * Drop-target handlers for a dragged card, taken while `onDrop` is set; `over` while the pointer is inside.
 * dragenter/dragleave fire for every child crossed, so a depth count tells when the pointer really leaves. `awaiting`
 * is whether a drag this target takes is on its way; `over` resets once it isn't.
 */
function useCardDrop(onDrop: ((threadId: string) => void) | null, awaiting: boolean, stopPropagation = false) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (awaiting) return;
    depth.current = 0;
    setOver(false);
  }, [awaiting]);
  const takes = (event: DragEvent) => onDrop !== null && event.dataTransfer.types.includes(THREAD_DRAG_TYPE);
  const handlers = {
    onDragEnter(event: DragEvent) {
      if (!takes(event)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver(event: DragEvent) {
      if (!takes(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDragLeave(event: DragEvent) {
      if (!takes(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop(event: DragEvent) {
      if (!takes(event)) return;
      event.preventDefault();
      if (stopPropagation) event.stopPropagation();
      depth.current = 0;
      setOver(false);
      const threadId = event.dataTransfer.getData(THREAD_DRAG_TYPE);
      if (threadId) onDrop?.(threadId);
    },
  };
  return { over, handlers };
}

/** Where a dragged card lands, and what dropping it there does. */
function DropHint({ over, icon, label }: { over: boolean; icon: string; label: string }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-3 ${TYPE.meta} font-medium transition-colors ${
        over ? "border-muted-foreground/70 bg-card text-foreground" : "border-muted-foreground/40 text-muted-foreground"
      }`}
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
      {label}
    </div>
  );
}

function EmptySlot({ children }: { children: ReactNode }) {
  return (
    <div className={`flex shrink-0 items-center justify-center rounded-md border border-dashed border-foreground/15 px-3 py-3 text-center ${TYPE.meta} text-muted-foreground/90`}>
      {children}
    </div>
  );
}

/** The Queue column's header: one uppercase tab per list with its count, underlined in the column's accent when open. */
function QueueTabs({ tabs, active, onSelect }: {
  tabs: { id: QueueTab; label: string; hint: string; count: number; fresh: number }[];
  active: QueueTab;
  onSelect: (tab: QueueTab) => void;
}) {
  const meta = STATUS_META.queue;
  return (
    // Tabs keep their full labels; a column too narrow for all three scrolls them sideways instead.
    <div role="tablist" aria-label="Queue column" className="flex min-w-0 items-stretch gap-3 self-stretch overflow-x-auto [scrollbar-width:none]">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            title={`${tab.hint}${tab.fresh > 0 ? ` · ${tab.fresh} new` : ""}`}
            onClick={() => onSelect(tab.id)}
            className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm ${TYPE.heading} leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 ${
              selected ? meta.title : "text-muted-foreground/70 hover:text-foreground"
            }`}
          >
            <span>{tab.label}</span>
            <span
              className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1.5 ${TYPE.badge} leading-none tracking-normal ${
                selected ? meta.badge : tab.fresh > 0 ? ACCENT_BADGE.sky : STATUS_META.parked.badge
              }`}
            >
              {tab.count}
            </span>
            {selected ? <span aria-hidden className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] rounded-full ${meta.accent}`} /> : null}
          </button>
        );
      })}
    </div>
  );
}

function readDraft(): string {
  return readStored(DRAFT_KEY) ?? "";
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
    writeStored(DRAFT_KEY, text);
  };
  // Cancel means discard; only an open form keeps a draft.
  const cancel = () => {
    writeStored(DRAFT_KEY, "");
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
      className="shrink-0 rounded-md border border-sky-500/50 bg-card px-2 py-1.5 shadow-sm ring-1 ring-sky-500/10 transition-[box-shadow,border-color] focus-within:border-sky-500/60 focus-within:ring-2 focus-within:ring-sky-500/20"
    >
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What should the new thread do?"
        disabled={pending}
        rows={3}
        className={`block min-h-16 w-full resize-none bg-transparent py-0.5 ${TYPE.title} leading-snug text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-wait disabled:opacity-60 pointer-coarse:text-base`}
      />
      <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/50 pt-1.5">
        <span className={`flex min-w-0 items-center gap-1 truncate ${TYPE.meta} text-muted-foreground/80 pointer-coarse:hidden`} title="Enter to start · Shift+Enter for a new line · Esc to cancel">
          <kbd className="rounded border border-border/70 bg-muted/60 px-1 font-sans text-[10px] leading-[14px] text-muted-foreground">↵</kbd>
          <span>start</span>
          <kbd className="ml-1 rounded border border-border/70 bg-muted/60 px-1 font-sans text-[10px] leading-[14px] text-muted-foreground">esc</kbd>
          <span>cancel</span>
        </span>
        <button
          type="button"
          onClick={cancel}
          className={`ml-auto h-6 shrink-0 whitespace-nowrap rounded-md px-2 ${TYPE.body} text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-9 pointer-coarse:px-3 pointer-coarse:text-sm`}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !prompt.trim()}
          className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-2.5 ${TYPE.body} font-medium text-primary-foreground shadow-xs transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-9 pointer-coarse:px-3.5 pointer-coarse:text-sm`}
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

/** What a column does with a dragged card: Parked parks any idle card, Working starts a Queue card that has a message waiting. */
type ColumnDrop = { label: string; icon: string; onDrop: (threadId: string) => void };

/** The Queue tab's Parked section: finished threads set aside to come back to later. Takes dragged idle cards. */
function ParkedSection({ tasks, dragging, onDrop, renderCard }: {
  tasks: BoardTask[];
  dragging: boolean;
  onDrop: (threadId: string) => void;
  renderCard: (task: BoardTask) => ReactElement;
}) {
  const meta = STATUS_META.parked;
  const { over, handlers } = useCardDrop(onDrop, dragging, true);
  return (
    <div role="group" aria-label="Parked" className={`space-y-1 rounded-md pt-1 transition-colors ${dropOutline(dragging, over)}`} {...handlers}>
      <div className={`flex h-6 items-center gap-1.5 ${CARD_INSET}`}>
        <h3 className={`${TYPE.label} leading-none ${meta.title}`}>Parked</h3>
        <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1.5 ${TYPE.badge} leading-none ${meta.badge}`}>{tasks.length}</span>
        <span className="h-px flex-1 bg-border/60" aria-hidden />
      </div>
      {dragging ? <DropHint over={over} icon="Pause" label="Drop to park" /> : null}
      {tasks.length === 0 && !dragging ? <EmptySlot>Drag a finished thread here to come back to it later</EmptySlot> : null}
      {tasks.map(renderCard)}
    </div>
  );
}

function BoardColumnView({ column, title, tasks, renderCard, dragging, drop, onStartAdding, headerControl, tabs, body, addForm, parked }: {
  column: BoardColumn;
  title: string;
  tasks: BoardTask[];
  renderCard: (task: BoardTask) => ReactElement;
  /** A card is being dragged. */
  dragging: boolean;
  /** Non-null while this column takes a dragged card: Working, while a startable card is dragged. */
  drop: ColumnDrop | null;
  onStartAdding: (() => void) | null;
  /** Drawn at the header's end: the working limit picker in Working. */
  headerControl: ReactElement | null;
  /** Drawn instead of the title and count: the Queue column's tabs. */
  tabs: ReactElement | null;
  /** Drawn instead of the column's cards: an Incoming or Out tab. */
  body: ReactElement | null;
  /** The new-thread form; non-null only while it is open. */
  addForm: ReactElement | null;
  /** The Queue column's Parked section: idle threads set aside to come back to, and what a card dropped there does. */
  parked: { tasks: BoardTask[]; onDrop: (threadId: string) => void } | null;
}) {
  const meta = STATUS_META[column];
  const adding = addForm !== null;
  const awaitingDrop = drop !== null && dragging;
  const { over, handlers } = useCardDrop(drop?.onDrop ?? null, awaitingDrop);
  return (
    <section
      aria-label={title}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-muted/45 transition-[background-color,outline-color] duration-150 max-sm:snap-start ${dropOutline(awaitingDrop, over)}`}
      {...handlers}
    >
      {/* Flush columns' accents meet edge to edge: one status strip along the board's top. */}
      <span className={`pointer-events-none absolute inset-x-0 top-0 h-[2px] ${meta.accent} opacity-80`} aria-hidden />
      {/* Text starts on the cards' content edge (column padding + card border + padding), and the stable gutter
          mirrors the scroller's so the header's end lines up with the cards' right edge. */}
      <header className="flex h-8 shrink-0 items-center gap-1.5 overflow-hidden border-b border-border/60 pl-[15px] pr-1.5 pt-[2px] [scrollbar-gutter:stable] [scrollbar-width:thin]">
        {tabs ?? (
          <>
            <h2 className={`truncate ${TYPE.heading} leading-none ${meta.title}`}>{title.toUpperCase()}</h2>
            <span className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1.5 ${TYPE.badge} leading-none ${meta.badge}`}>{tasks.length}</span>
          </>
        )}
        {headerControl}
      </header>
      {/* Vertical scroller only: `overflow-y-auto` alone makes x `auto` too, so content wider than the column
          would scroll the column sideways and swallow the swipe. Sideways swipes on the cards must chain to the
          board's horizontal scroll, so overscroll is contained on y only. */}
      <div
        data-board-column-scroll=""
        className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden overscroll-y-contain p-1.5 [scrollbar-gutter:stable] [scrollbar-width:thin]"
      >
        {body ?? (
          <>
            {addForm}
            {awaitingDrop ? <DropHint over={over} icon={drop.icon} label={drop.label} /> : null}
            {onStartAdding && !adding ? (
              <button
                type="button"
                onClick={onStartAdding}
                className={`flex w-full shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed border-foreground/15 px-3 py-2.5 ${TYPE.meta} text-muted-foreground/90 transition-colors hover:border-sky-500/50 hover:bg-sky-500/5 hover:text-[light-dark(var(--color-sky-700),var(--color-sky-500))] focus-visible:border-sky-500/60 focus-visible:text-[light-dark(var(--color-sky-700),var(--color-sky-500))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/20`}
              >
                <Icon name="Plus" className="size-3.5" aria-hidden />
                New thread
              </button>
            ) : tasks.length === 0 && !adding && !awaitingDrop ? (
              <EmptySlot>No threads</EmptySlot>
            ) : null}
            {tasks.map(renderCard)}
            {parked ? <ParkedSection tasks={parked.tasks} dragging={dragging} onDrop={parked.onDrop} renderCard={renderCard} /> : null}
          </>
        )}
      </div>
    </section>
  );
}

export function BoardView({ api, reviews, work }: { api: BoardApi; reviews: ReviewsApi; work: WorkApi }) {
  const context = useBbContext();
  const selectedThreadId = context.threadId;
  // Same roster and lookup as bb's sidebar: a thread's harness icon is its agent provider's artwork.
  const { providers } = experimental_useProviders();
  const providersById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const navigate = useBbNavigate();
  const { rpc, board, error, report, refetch } = api;
  // Cards opened from the board count as read right away, before bb's read state round-trips; dropped once the
  // server agrees, so later activity can mark the card unread again.
  const [readLocally, setReadLocally] = useLocalIds(board, (task) => task.unread);
  // Cards parked from the board move to Parked right away, before the server's board round-trips.
  const [parkedLocally, setParkedLocally] = useLocalIds(board, (task) => task.status !== "parked");
  // Cards started from the board: their start button waits until the server's board no longer offers to start them.
  const [startingIds, setStartingIds] = useLocalIds(board, (task) => task.startable);
  const grouped = useMemo(() => groupTasksByColumn(board, readLocally, parkedLocally), [board, readLocally, parkedLocally]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingStartable = board?.tasks.some((task) => task.threadId === draggingId && task.startable) ?? false;
  const now = useNow(CLOCK_TICK_MS);
  // A saved draft means the form was open with text when the app last closed: reopen it, without focus.
  const [adding, setAdding] = useState<"closed" | "restored" | "opened">(() => (readDraft() ? "restored" : "closed"));

  const archiveTask = (threadId: string) => {
    rpc.call("board_remove_task", { threadId }).then(refetch, report);
  };

  const forgetParked = (threadId: string) => setParkedLocally((current) => withoutId(current, threadId));

  const parkTask = (threadId: string, parked: boolean) => {
    // Parking shows right away; unparking waits for the server, which decides where the card goes.
    if (parked) setParkedLocally((current) => withId(current, threadId));
    else forgetParked(threadId);
    rpc.call("board_park_task", { threadId, parked }).then(
      (task) => {
        // A thread that started working meanwhile stays where it is.
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
    setStartingIds((current) => withId(current, threadId));
    rpc.call("board_start_task", { threadId }).then(refetch, (cause) => {
      setStartingIds((current) => withoutId(current, threadId));
      report(cause);
    });
  };

  const openTask = (threadId: string) => {
    setReadLocally((current) => withId(current, threadId));
    rpc.call("board_mark_read", { threadId }).then(refetch, refetch);
    try {
      navigate.toThread(threadId);
      scrollThreadToLatest(threadId);
    } catch (cause) {
      report(cause);
    }
  };

  const markUnreadTask = (threadId: string) => {
    // Drop the local "read" override so the card goes unread as soon as the server's board says so.
    setReadLocally((current) => withoutId(current, threadId));
    rpc.call("board_mark_unread", { threadId }).then(refetch, (cause) => {
      refetch();
      report(cause);
    });
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

  const workItems = useWorkItems(work);
  const [chosenTab, setChosenTab] = useState<QueueTab>(readQueueTab);
  const selectTab = (tab: QueueTab) => {
    setChosenTab(tab);
    writeStored(QUEUE_TAB_KEY, tab);
  };
  // A tab shows while its lists load, and once any of them has a search configured.
  const incoming = visibleReviews(reviews);
  const tabCounts: Record<QueueTab, { count: number; fresh: number; shown: boolean }> = {
    queue: { count: grouped.get("queue")?.length ?? 0, fresh: 0, shown: true },
    incoming: {
      count: incoming.count + workItems.byList.assigned.length,
      fresh: incoming.fresh,
      shown: !reviews.state || !workItems.state || reviews.state.scopes.length > 0 || workItems.lists.includes("assigned"),
    },
    outgoing: {
      count: workItems.byList.open.length + workItems.byList.shipped.length,
      fresh: 0,
      shown: !workItems.state || workItems.lists.includes("open") || workItems.lists.includes("shipped"),
    },
  };
  const tabs = QUEUE_TABS.filter((tab) => tabCounts[tab.id].shown).map((tab) => ({ ...tab, ...tabCounts[tab.id] }));
  const queueTab = tabs.some((tab) => tab.id === chosenTab) ? chosenTab : "queue";
  const queueBody =
    queueTab === "incoming" ? (
      <div className="space-y-2.5">
        <ReviewGroup reviews={reviews} now={now} />
        <WorkGroup list="assigned" work={workItems} now={now} />
      </div>
    ) : queueTab === "outgoing" ? (
      <div className="space-y-2.5">
        <WorkGroup list="open" work={workItems} now={now} />
        <WorkGroup list="shipped" work={workItems} now={now} />
      </div>
    ) : null;

  const renderCard = (task: BoardTask) => (
    <TaskCard
      key={task.threadId}
      task={task}
      now={now}
      unread={task.status === "done" && isUnread(task, readLocally)}
      selected={task.threadId === selectedThreadId}
      dragging={task.threadId === draggingId}
      starting={startingIds.has(task.threadId)}
      provider={task.thread?.providerId ? providersById.get(task.thread.providerId) ?? null : null}
      onArchive={archiveTask}
      onPark={parkTask}
      onMarkUnread={markUnreadTask}
      onStart={startTask}
      onDragChange={setDraggingId}
      onOpen={openTask}
    />
  );

  const renderColumn = (column: { id: BoardColumn; title: string }) => (
    <BoardColumnView
      key={column.id}
      column={column.id}
      title={column.title}
      tasks={grouped.get(column.id) ?? []}
      renderCard={renderCard}
      dragging={draggingId !== null}
      drop={column.id === "wip" && draggingStartable ? { label: "Drop to start now", icon: "Play", onDrop: startTask } : null}
      onStartAdding={column.id === "queue" ? () => setAdding("opened") : null}
      headerControl={
        column.id === "wip" && board ? (
          <WipLimitControl
            limit={board.wipLimit.limit}
            working={(grouped.get("wip") ?? []).filter((task) => task.status === "wip").length}
            waiting={board.wipLimit.waiting}
            onChange={setWipLimit}
          />
        ) : null
      }
      tabs={column.id === "queue" && tabs.length > 1 ? <QueueTabs tabs={tabs} active={queueTab} onSelect={selectTab} /> : null}
      body={column.id === "queue" ? queueBody : null}
      parked={column.id === "queue" ? { tasks: grouped.get("parked") ?? [], onDrop: dropPark } : null}
      addForm={
        column.id === "queue" && adding !== "closed" ? (
          <AddTaskForm focus={adding === "opened"} onAdd={addTask} onCancel={() => setAdding("closed")} onError={report} />
        ) : null
      }
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div role="alert" className={`flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 ${TYPE.body} leading-snug text-destructive`}>
          <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
        </div>
      ) : null}
      {board ? (
        // Phones: one column per screen with a peek of the next, snapping as you swipe.
        // Columns sit flush with the panel and each other, split by hairlines instead of gutters.
        <div data-board-scroll="" className="grid min-h-0 flex-1 auto-cols-[minmax(250px,1fr)] grid-flow-col divide-x divide-border overflow-x-auto overscroll-x-contain [scrollbar-width:thin] max-sm:auto-cols-[calc(100%-2.5rem)] max-sm:snap-x max-sm:snap-mandatory">
          {/* Parked is a section of the Queue column, not a column of its own. */}
          {board.columns.filter((column) => column.id !== "parked").map(renderColumn)}
        </div>
      ) : error ? null : (
        // Before the first board arrives; if reads fail, only the error above shows while they retry.
        <div role="status" aria-live="polite" className={`flex flex-1 items-center justify-center gap-2.5 ${TYPE.body} font-medium text-muted-foreground`}>
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/80" aria-hidden />
          Loading board…
        </div>
      )}
    </div>
  );
}

