import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactElement } from "react";
import { experimental_Icon as Icon, experimental_NewThreadComposer as NewThreadComposer, experimental_useSidebarThreads, useBbContext, useBbNavigate, useSdk, type NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { PLUGIN_SLUG } from "../brand";
import { CLOCK_TICK_MS, THREAD_DRAG_TYPE, groupTasksByColumn, shortNameFromPrompt, type BoardColumn, type BoardState, type BoardTask, type Domain } from "./model";
import { useNow, usePending, type BoardApi, type RemoteApi, type WorkApi, type RadarApi } from "./hooks";
import { TaskCard } from "./card";
import { RemoteSection } from "./remote";
import { WipLimitControl } from "./wip-limit";
import { WorkGroup, useWorkItems } from "./work";
import { CountBadge, GroupHeader, Spinner, keyForBox } from "./primitives";
import { ACCENT_HOVER_TEXT, ALERT_BANNER, COLUMN_INSET, DASHED_SLOT, ELEVATION, EMPTY_NOTE, STATUS_META, TYPE, UNREAD_BADGE } from "./styles";
import { RadarPanel } from "./radar";
import { OMP_PROVIDER_ID } from "./provider-icons";

const SCROLL_TO_LATEST_SELECTOR = 'button[aria-label="Scroll to latest event"]';
/** Where bb's new-thread composer keeps the board's draft, so closing the form, a reload or a crash doesn't lose it. */
const DRAFT_KEY = `${PLUGIN_SLUG}:new-thread-draft`;
/** The Queue column's open tab, kept across reloads. */
const QUEUE_TAB_KEY = `${PLUGIN_SLUG}:queue-tab`;

/** The Queue column's tabs: queued threads (with Parked below them), Radar, and shipped work going out from the user. */
type QueueTab = "queue" | "radar" | "outgoing";
const QUEUE_TABS: { id: QueueTab; label: string }[] = [
  { id: "queue", label: "Queue" },
  { id: "radar", label: "Radar" },
  { id: "outgoing", label: "Out" },
];

/** A localStorage value; null when storage is off. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store `value`; with storage off it lives only as long as the page. */
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage off.
  }
}

function readQueueTab(): QueueTab {
  const stored = readStored(QUEUE_TAB_KEY);
  return QUEUE_TABS.some((tab) => tab.id === stored) ? (stored as QueueTab) : "queue";
}

/** Outline of a column or section while a dragged card is on its way: dashed, solid once the card is over it. */
function dropOutline(awaiting: boolean, over: boolean): string {
  if (!awaiting) return "";
  return over
    ? "bg-muted-foreground/15 outline-2 -outline-offset-2 outline-muted-foreground/70"
    : "outline-2 outline-dashed -outline-offset-2 outline-muted-foreground/50";
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
      className={`${DASHED_SLOT} font-medium transition-colors ${
        over ? "border-muted-foreground/70 bg-card text-foreground" : "border-muted-foreground/50 text-muted-foreground"
      }`}
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
      {label}
    </div>
  );
}

/** The Queue column's header: one uppercase tab per list with its count, underlined in the column's accent when open. */
function QueueTabs({ tabs, active, onSelect }: {
  tabs: { id: QueueTab; label: string; count: number }[];
  active: QueueTab;
  onSelect: (tab: QueueTab) => void;
}) {
  const meta = STATUS_META.queue;
  return (
    // Tabs keep their full labels; a column too narrow for both scrolls them sideways instead.
    <div role="tablist" aria-label="Queue column" className="flex min-w-0 items-stretch gap-3 self-stretch overflow-x-auto [scrollbar-width:none]">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(tab.id)}
            className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm ${TYPE.heading} leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 ${
              selected ? meta.title : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span>{tab.label}</span>
            <CountBadge count={tab.count} tone={tab.id === "radar" ? UNREAD_BADGE.rose : selected ? meta.badge : STATUS_META.parked.badge} />
            {selected ? <span aria-hidden className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] rounded-full ${meta.accent}`} /> : null}
          </button>
        );
      })}
    </div>
  );
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

/** omp's default model from the last lookup, so a reopened form seeds it on mount instead of re-seeding a moment later. */
let knownOmpDefaultModel: string | undefined;

/** The model bb's catalog marks as omp's default; undefined until the catalog answers. */
function useOmpDefaultModel(projectId: string | undefined, onError: (cause: unknown) => void): string | undefined {
  const sdk = useSdk();
  const [model, setModel] = useState(knownOmpDefaultModel);
  const reportRef = useRef(onError);
  reportRef.current = onError;
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    sdk.providers.models({ providerId: OMP_PROVIDER_ID, projectId, signal: controller.signal }).then(
      (catalog) => {
        knownOmpDefaultModel = catalog.models.find((entry) => entry.isDefault)?.model;
        setModel(knownOmpDefaultModel);
      },
      (cause) => {
        if (!controller.signal.aborted) reportRef.current(cause);
      },
    );
    return () => controller.abort();
  }, [sdk, projectId]);
  return model;
}

/**
 * bb's own new-thread composer (prompt, provider/model/reasoning picker, project, environment, branch and
 * permission mode), so a board thread starts exactly like one from bb's New thread page. It opens on no project
 * (bb's personal project) and omp on omp's default model; the user can change any of them.
 */
function AddTaskForm({ onAdd, onClose, onError }: {
  onAdd: (request: NewThreadRequest) => Promise<void>;
  onClose: () => void;
  onError: (cause: unknown) => void;
}) {
  const [focusRequest] = useState(Date.now);
  const personalProjectId = experimental_useSidebarThreads().projects.find((project) => project.isPersonal)?.id;
  const ompModel = useOmpDefaultModel(personalProjectId, onError);
  const submit = async (request: NewThreadRequest) => {
    try {
      await onAdd(request);
    } catch (cause) {
      onError(cause);
      // Rethrown so the composer keeps the draft.
      throw cause;
    }
    onClose();
  };
  return (
    <div
      className={`relative shrink-0 rounded-md border border-sky-500/50 bg-card ${ELEVATION.rest} ring-1 ring-sky-500/15`}
      // Capture phase: bb's composer editor handles Escape itself and the key never bubbles up here. A key from a
      // portaled menu (outside this box), or while one of the composer's own menus is open, stays with that menu.
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || !keyForBox(event.currentTarget, event)) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <NewThreadComposer
        layout="document"
        draftKey={DRAFT_KEY}
        placeholder="What should the new thread do?"
        focusRequest={focusRequest}
        {...(personalProjectId ? { defaultProjectId: personalProjectId } : {})}
        defaultProviderId={OMP_PROVIDER_ID}
        {...(ompModel ? { defaultModel: ompModel } : {})}
        onSubmit={submit}
      />
      {/* Floats inside the box's top-right corner, over the composer. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className={`absolute right-1 top-1 z-10 inline-flex size-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground ${ELEVATION.rest} transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-7`}
      >
        <Icon name="X" className="size-3 pointer-coarse:size-4" aria-hidden />
      </button>
    </div>
  );
}

/** What a column does with a dragged card: Parked parks any idle card, Working starts a Queue card that has a message waiting. */
type ColumnDrop = { label: string; icon: string; onDrop: (threadId: string) => void };

/** Opens the new-thread form where it stands. */
function NewThreadButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${EMPTY_NOTE} w-full transition-colors hover:border-sky-500/50 hover:bg-sky-500/15 ${ACCENT_HOVER_TEXT.sky} focus-visible:border-sky-500/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60`}
    >
      <Icon name="Plus" className="size-3.5" aria-hidden />
      New thread
    </button>
  );
}

/**
 * The Queue tab's Parked section: threads set aside to come back to later. Takes dragged idle cards, and starts new
 * threads that wait here, unstarted even with working slots free, until moved to Queue.
 */
function ParkedSection({ tasks, dragging, onDrop, renderCard, onStartAdding, addForm }: {
  tasks: BoardTask[];
  dragging: boolean;
  onDrop: (threadId: string) => void;
  renderCard: (task: BoardTask) => ReactElement;
  onStartAdding: () => void;
  addForm: ReactElement | null;
}) {
  const { over, handlers } = useCardDrop(onDrop, dragging, true);
  return (
    <div role="group" aria-label="Parked" className={`space-y-1 rounded-md pt-1 transition-colors ${dropOutline(dragging, over)}`} {...handlers}>
      <GroupHeader title="Parked" count={tasks.length} />
      {addForm}
      {dragging ? <DropHint over={over} icon="Pause" label="Drop to park" /> : null}
      {/* Like Queue, an empty Parked shows just its New thread button. */}
      {!addForm && !dragging ? <NewThreadButton onClick={onStartAdding} /> : null}
      {tasks.map(renderCard)}
    </div>
  );
}

/** Read results on top with no header, then Unread; both keep the column's completion order. */
function DoneTasks({ tasks, renderCard }: { tasks: BoardTask[]; renderCard: (task: BoardTask) => ReactElement }) {
  const read = tasks.filter((task) => !task.unread);
  const unread = tasks.filter((task) => task.unread);
  return (
    <>
      {read.map(renderCard)}
      {unread.length > 0 ? (
        <div role="group" aria-label="Unread" className="space-y-1 pt-1">
          <GroupHeader title="Unread" count={unread.length} countTone={UNREAD_BADGE.emerald} />
          {unread.map(renderCard)}
        </div>
      ) : null}
    </>
  );
}

function BoardColumnView({ column, title, tasks, count, renderCard, dragging, drop, onStartAdding, headerControl, tabs, body, addForm, inFlight, parked, remote }: {
  column: BoardColumn;
  title: string;
  tasks: BoardTask[];
  /** The header's count; null draws none (Working, whose limit control counts instead). */
  count: number | null;
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
  /** Drawn instead of the column's cards: the Out tab. */
  body: ReactElement | null;
  /** The new-thread form; non-null only while it is open. */
  addForm: ReactElement | null;
  /** The user's open pull requests, in the Queue column between its threads and Parked. */
  inFlight: ReactElement | null;
  /**
   * The Queue column's Parked section: idle threads set aside to come back to, what a card dropped there does, and its
   * own new-thread form for threads that wait there unstarted.
   */
  parked: { tasks: BoardTask[]; onDrop: (threadId: string) => void; onStartAdding: () => void; addForm: ReactElement | null } | null;
  /** The Working column's Remote section, under its cards. */
  remote: ReactElement | null;
}) {
  const meta = STATUS_META[column];
  const adding = addForm !== null;
  const awaitingDrop = drop !== null && dragging;
  const { over, handlers } = useCardDrop(drop?.onDrop ?? null, awaitingDrop);
  return (
    <section
      aria-label={title}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-muted/50 transition-[background-color,outline-color] duration-150 max-sm:snap-start ${dropOutline(awaitingDrop, over)}`}
      {...handlers}
    >
      {/* Flush columns' accents meet edge to edge: one status strip along the board's top. */}
      <span className={`pointer-events-none absolute inset-x-0 top-0 h-[2px] ${meta.accent}`} aria-hidden />
      {/* Text starts on the cards' content edge (column padding + card border + padding), and the stable gutter
          mirrors the scroller's so the header's end lines up with the cards' right edge. */}
      <header className={`flex h-8 shrink-0 items-center gap-1.5 overflow-hidden border-b border-border/60 ${COLUMN_INSET} pr-1.5 pt-0.5 [scrollbar-gutter:stable] [scrollbar-width:thin]`}>
        {tabs ?? (
          <>
            <h2 className={`truncate ${TYPE.heading} leading-none ${meta.title}`}>{title.toUpperCase()}</h2>
            {count !== null ? <CountBadge count={count} tone={column === "done" ? UNREAD_BADGE.emerald : meta.badge} /> : null}
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
              <NewThreadButton onClick={onStartAdding} />
            ) : tasks.length === 0 && !adding && !awaitingDrop ? (
              <p className={EMPTY_NOTE}>No threads</p>
            ) : null}
            {column === "done" ? <DoneTasks tasks={tasks} renderCard={renderCard} /> : tasks.map(renderCard)}
            {inFlight}
            {parked ? <ParkedSection tasks={parked.tasks} dragging={dragging} onDrop={parked.onDrop} renderCard={renderCard} onStartAdding={parked.onStartAdding} addForm={parked.addForm} /> : null}
            {remote}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The open domain's columns. Shopify has the full board; Other is just its threads in Queue (Parked included), Working
 * and Done, with no Radar, pull requests or Remote.
 */
export function BoardView({ api, domain, work, remote, radar }: {
  api: BoardApi;
  domain: Domain;
  work: WorkApi;
  remote: RemoteApi;
  radar: RadarApi;
}) {
  const context = useBbContext();
  const selectedThreadId = context.threadId;
  const navigate = useBbNavigate();
  const { rpc, board, error, report, refetch } = api;
  // Read state and completion time come from bb's own live thread view, the one its sidebar draws, so a card goes
  // read or unread exactly when bb's unread dot does. The server's copies stand in for threads it doesn't list yet.
  const { threads: liveThreads } = experimental_useSidebarThreads();
  const liveBoard = useMemo(() => {
    if (!board) return null;
    const live = new Map(liveThreads.map((thread) => [thread.id, thread]));
    return {
      ...board,
      tasks: board.tasks.filter((task) => task.domain === domain).map((task) => {
        const thread = live.get(task.threadId);
        return thread ? { ...task, unread: thread.isUnread, completedAt: new Date(thread.latestAttentionAt).toISOString() } : task;
      }),
    };
  }, [board, liveThreads, domain]);
  // Cards parked from the board move to Parked right away, until the server's board has them parked too.
  const [parkedLocally, changeParked] = usePending<BoardState, true>(board, (_, id, served) =>
    served.tasks.some((task) => task.threadId === id && task.status !== "parked"),
  );
  // Cards started from the board: their start button waits until the server's board no longer offers to start them.
  const [startingIds, changeStarting] = usePending<BoardState, true>(board, (_, id, served) =>
    served.tasks.some((task) => task.threadId === id && task.startable),
  );
  const grouped = useMemo(() => groupTasksByColumn(liveBoard, parkedLocally), [liveBoard, parkedLocally]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingStartable = board?.tasks.some((task) => task.threadId === draggingId && task.startable) ?? false;
  const now = useNow(CLOCK_TICK_MS);
  /** Where the new-thread form is open: Queue starts the thread (as the working limit allows), Parked holds it. */
  const [adding, setAdding] = useState<"queue" | "parked" | null>(null);

  const archiveTask = (threadId: string) => {
    rpc.call("board_remove_task", { threadId }).then(refetch, report);
  };

  const forgetParked = (threadId: string) => changeParked(threadId, () => undefined);

  const parkTask = (threadId: string, parked: boolean) => {
    // Parking shows right away; unparking waits for the server, which decides where the card goes.
    if (parked) changeParked(threadId, () => true);
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
    changeStarting(threadId, () => true);
    rpc.call("board_start_task", { threadId }).then(refetch, (cause) => {
      changeStarting(threadId, () => undefined);
      report(cause);
    });
  };

  const openTask = (threadId: string) => {
    rpc.call("board_mark_read", { threadId }).catch(report);
    try {
      navigate.toThread(threadId);
      scrollThreadToLatest(threadId);
    } catch (cause) {
      report(cause);
    }
  };

  const markUnreadTask = (threadId: string) => {
    rpc.call("board_mark_unread", { threadId }).catch(report);
  };

  const addTask = async (request: NewThreadRequest, parked: boolean) => {
    const prompt = request.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
    await rpc.call("board_spawn_task", {
      shortName: shortNameFromPrompt(prompt || "New thread"),
      prompt: prompt || "New thread",
      projectId: request.projectId,
      composer: { ...request },
      domain,
      parked,
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
  const tasksIn = (column: BoardColumn) => grouped.get(column) ?? [];
  const shopify = domain === "shopify";
  // Out shows while its lists load, and once Shipped has a search configured; Queue always shows.
  const outgoingShown = !workItems.state || workItems.lists.includes("shipped");
  const tabCounts: Record<QueueTab, number> = {
    queue: tasksIn("queue").length,
    radar: radar.state?.unread ?? 0,
    outgoing: workItems.byList.shipped.length,
  };
  const tabs = QUEUE_TABS.filter((tab) => tab.id !== "outgoing" || outgoingShown).map((tab) => ({ ...tab, count: tabCounts[tab.id] }));
  const queueTab = !shopify || (chosenTab === "outgoing" && !outgoingShown) ? "queue" : chosenTab;
  // Outgoing PRs show once their search is configured.
  const inFlightSection = shopify && workItems.lists.includes("open") ? (
    <div className="pt-1">
      <WorkGroup list="open" work={workItems} now={now} />
    </div>
  ) : null;
  const queueBody = queueTab === "outgoing" ? (
    <WorkGroup list="shipped" work={workItems} now={now} />
  ) : queueTab === "radar" ? <RadarPanel api={radar} now={now} onQueued={() => { selectTab("queue"); refetch(); }} /> : null;

  const renderCard = (task: BoardTask) => (
    <TaskCard
      key={task.threadId}
      task={task}
      now={now}
      unread={task.status === "done" && task.unread}
      selected={task.threadId === selectedThreadId}
      dragging={task.threadId === draggingId}
      starting={startingIds.has(task.threadId)}
      onArchive={archiveTask}
      onPark={parkTask}
      onMarkUnread={markUnreadTask}
      onStart={startTask}
      onDragChange={setDraggingId}
      onOpen={openTask}
    />
  );

  // Threads holding a working slot; Blocked ones sit in the column too but don't count against the limit.
  const working = tasksIn("wip").filter((task) => task.status === "wip").length;
  // The limit spans both domains, so its picker counts every domain's working threads.
  const workingEverywhere = board?.tasks.filter((task) => task.status === "wip").length ?? 0;

  const renderColumn = (column: { id: BoardColumn; title: string }) => (
    <BoardColumnView
      key={column.id}
      column={column.id}
      title={column.title}
      tasks={tasksIn(column.id)}
      count={column.id === "wip" ? working : tasksIn(column.id).length}
      renderCard={renderCard}
      dragging={draggingId !== null}
      drop={column.id === "wip" && draggingStartable ? { label: "Drop to start now", icon: "Play", onDrop: startTask } : null}
      onStartAdding={column.id === "queue" ? () => setAdding("queue") : null}
      headerControl={
        column.id === "wip" && board ? (
          <WipLimitControl
            limit={board.wipLimit.limit}
            working={workingEverywhere}
            waiting={board.wipLimit.waiting}
            onChange={setWipLimit}
          />
        ) : null
      }
      tabs={column.id === "queue" && shopify ? <QueueTabs tabs={tabs} active={queueTab} onSelect={selectTab} /> : null}
      body={column.id === "queue" ? queueBody : null}
      inFlight={column.id === "queue" ? inFlightSection : null}
      parked={
        column.id === "queue"
          ? {
              tasks: tasksIn("parked"),
              onDrop: dropPark,
              onStartAdding: () => setAdding("parked"),
              addForm: adding === "parked" ? <AddTaskForm onAdd={(request) => addTask(request, true)} onClose={() => setAdding(null)} onError={report} /> : null,
            }
          : null
      }
      remote={column.id === "wip" && shopify ? <RemoteSection remote={remote} now={now} /> : null}
      addForm={
        column.id === "queue" && adding === "queue" ? (
          <AddTaskForm onAdd={(request) => addTask(request, false)} onClose={() => setAdding(null)} onError={report} />
        ) : null
      }
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div role="alert" className={`flex shrink-0 items-center gap-2 ${COLUMN_INSET} pr-3 py-1.5 ${ALERT_BANNER} ${TYPE.body} leading-4`}>
          <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{error}</span>
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
        <div role="status" aria-live="polite" className={`flex flex-1 items-center justify-center gap-2 ${TYPE.body} font-medium text-muted-foreground`}>
          <Spinner large />
          Loading board…
        </div>
      )}
    </div>
  );
}

