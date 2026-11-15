import { useCallback, useEffect, useId, useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_TEXT, CARD_EDGE, CARD_SURFACE, STATUS_META, THREAD_DRAG_TYPE, taskActivityTime, taskCardTitle, type BoardStatus, type BoardTask } from "./model";
import { Age, CHIP, MARK_FRAME, ONE_LINE_AGE, ONE_LINE_PAD, RowActions, Spinner, TYPE } from "./primitives";
import { CardTooltip, ContextPie, SessionCost, type AgentProvider } from "./session";

const CARD_ACTION =
  "inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none pointer-coarse:size-7";
const BLOCKED_STRIPE =
  "before:absolute before:inset-y-1.5 before:-left-px before:w-[3px] before:rounded-r-full before:bg-rose-500/70 before:content-['']";

/** Resting on a card this long opens its tooltip; quick passes across the board don't. */
const TOOLTIP_DELAY_MS = 350;
/** A full card's cost and age: 18px lines at the ends of its two rows. */
const META_LINE = `flex h-[18px] shrink-0 items-center whitespace-nowrap ${TYPE.meta} tabular-nums text-muted-foreground/80`;

// Reveal margins: the column list's p-1.5 (covers the selected card's 3px outline); columns sit flush with the
// board's edges, so horizontally a column only needs to be inside the scroller.
const REVEAL_MARGIN_Y = 6;
const REVEAL_MARGIN_X = 0;

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
function revealBoardCard(card: HTMLElement) {
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
function boardCardLayoutKey(card: HTMLElement): string | null {
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

/** The Working mark's petals, from 12 o'clock clockwise; each fades a step further behind the leading one. */
const PETALS = Array.from({ length: 8 }, (_, i) => ({ angle: i * 45, opacity: 1 - i * 0.11 }));

export function TaskStatusMark({ status, unread }: { status: BoardStatus; unread: boolean }) {
  if (status === "wip") {
    // A petal spinner, ticking a petal at a time: a stroked arc would read as the context pie below it.
    return (
      <span role="img" aria-label="Working" className={MARK_FRAME}>
        <svg
          viewBox="0 0 16 16"
          className="size-3.5 animate-[spin_800ms_steps(8)_infinite] text-[light-dark(var(--color-amber-600),var(--color-amber-500))]"
          aria-hidden
        >
          {PETALS.map(({ angle, opacity }) => (
            <line
              key={angle}
              x1="8"
              y1="1.75"
              x2="8"
              y2="4.75"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeOpacity={opacity}
              transform={`rotate(${-angle} 8 8)`}
            />
          ))}
        </svg>
      </span>
    );
  }
  if (status === "done") {
    const label = unread ? "Done · unread" : "Done";
    return (
      <span
        role="img"
        aria-label={label}
        className={`${MARK_FRAME} rounded-full transition-colors ${
          unread ? "bg-emerald-500 text-white" : STATUS_META.done.badge
        }`}
      >
        <Icon name="Check" className="size-3" aria-hidden />
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span
        role="img"
        aria-label="Blocked"
        className={`${MARK_FRAME} rounded-full bg-rose-500 text-[10.5px] font-bold leading-none text-white`}
      >
        !
      </span>
    );
  }
  if (status === "parked") {
    return (
      <span role="img" aria-label="Parked" className={`${MARK_FRAME} rounded-full ${STATUS_META.parked.badge}`}>
        <Icon name="Pause" className="size-2.5" aria-hidden />
      </span>
    );
  }
  return (
    <span role="img" aria-label="In queue" className={MARK_FRAME}>
      <span className="block size-3.5 rounded-full border-[1.5px] border-dashed border-sky-500/70" />
    </span>
  );
}

export function TaskCard({ task, now, unread, selected, dragging, starting, provider, onArchive, onPark, onMarkUnread, onStart, onDragChange, onOpen }: {
  task: BoardTask;
  now: number;
  /** Done and not yet read: the title goes from semibold to bold and the check fills. */
  unread: boolean;
  /** Card belongs to the thread currently open in bb. */
  selected: boolean;
  /** This card is the one being dragged. */
  dragging: boolean;
  /** Its start is on its way to the server: the start button waits. */
  starting: boolean;
  /** The harness the card's thread runs on; null when bb's roster doesn't list it. */
  provider: AgentProvider | null;
  onArchive: (threadId: string) => void;
  /** Park an idle card, or unpark a parked one. */
  onPark: (threadId: string, parked: boolean) => void;
  /** Mark a read Done card's thread unread again. */
  onMarkUnread: (threadId: string) => void;
  /** Start a startable Queue card now, past the working limit. */
  onStart: (threadId: string) => void;
  /** A drag of this card started (its thread id) or ended (null). */
  onDragChange: (threadId: string | null) => void;
  onOpen: (threadId: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const reveal = useRef({ frame: 0, force: false, layout: null as string | null });
  // Eager reveal: keep the selected card fully visible whenever the layout around it changes (selection,
  // mount, any re-render such as a sibling reorder or note change, resize/reflow) and whenever it is
  // clicked. Triggers compare a scroll-independent layout key instead of listening to scroll events,
  // so a user who scrolls away is only pulled back if the board layout actually shifts.
  const scheduleReveal = useCallback((force = false) => {
    const state = reveal.current;
    state.force ||= force;
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      const card = ref.current;
      if (!card) return;
      const layout = boardCardLayoutKey(card);
      if (!state.force && layout === state.layout) return;
      state.force = false;
      state.layout = layout;
      revealBoardCard(card);
    });
  }, []);
  useEffect(() => {
    if (selected) scheduleReveal();
  });
  useEffect(() => {
    const card = ref.current;
    if (!selected || !card) return;
    const state = reveal.current;
    const observer = new ResizeObserver(() => scheduleReveal());
    for (const element of [card, card.closest("[data-board-column-scroll]"), card.closest("[data-board-scroll]")]) {
      if (element) observer.observe(element);
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(state.frame);
      Object.assign(state, { frame: 0, force: false, layout: null });
    };
  }, [selected, scheduleReveal]);
  const open = () => {
    onOpen(task.threadId);
    scheduleReveal(true);
  };
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const tooltipTimer = useRef(0);
  // Every card has a tooltip: it carries the session details and what the card's lines hide (how it was left or why
  // it waits, and the summary past its truncation).
  const hasSession = provider !== null || task.session !== null;
  const showTooltip = () => {
    if (hasSession || compactHint) setTooltipOpen(true);
  };
  const hideTooltip = () => {
    window.clearTimeout(tooltipTimer.current);
    setTooltipOpen(false);
  };
  useEffect(() => () => window.clearTimeout(tooltipTimer.current), []);
  const dragFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(dragFrame.current), []);
  // Chrome sends the drag's source card a pointerenter when the drag ends, wherever the pointer is; the tooltip
  // ignores it until the pointer next leaves the card.
  const dragEnded = useRef(false);
  // Scrolling the board moves the card out from under the fixed tooltip: close rather than chase it.
  // Other scrollers (a streaming thread timeline) don't contain the card and are ignored.
  useEffect(() => {
    const card = ref.current;
    if (!tooltipOpen || !card) return;
    const close = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(card)) setTooltipOpen(false);
    };
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [tooltipOpen]);
  const { category, intent } = taskCardTitle(task);
  const parked = task.status === "parked";
  // Done and Parked cards are finished or set aside: one line (mark, tag, title, and cost, else age), the rest in the
  // tooltip.
  const compact = parked || task.status === "done";
  // Tag and title on one line: a full card's first line, or a one-line card's only one.
  const titleText = (
    <span className={`flex min-w-0 items-center gap-1.5 ${TYPE.body} leading-5`}>
      {category ? (
        <span className={`${CHIP} bg-muted text-muted-foreground`}>
          {category}
        </span>
      ) : null}
      <span
        className={`min-w-0 truncate ${TYPE.title} decoration-muted-foreground/40 underline-offset-2 group-hover/open:underline ${
          parked ? "text-foreground/70" : unread || !compact ? "text-foreground" : "text-foreground/85"
        } ${unread ? "font-bold" : "font-semibold"}`}
      >
        {intent}
      </span>
    </span>
  );
  const meta = STATUS_META[task.status];
  const activity = taskActivityTime(task);
  const canOpen = !task.missingThread;
  // Done cards don't repeat "Completed"; parked ones say how they were left, so they do.
  const reason = task.statusReason && task.status !== "done" && task.statusReason !== "Working" ? task.statusReason : null;
  const compactHint = [reason, task.note].filter(Boolean).join(" — ");
  const age = activity !== null ? <Age at={activity} now={now} className={META_LINE} /> : null;
  const titleButton = canOpen ? (
    <button
      type="button"
      data-card-open=""
      onClick={open}
      aria-describedby={tooltipOpen ? tooltipId : undefined}
      className="group/open block min-w-0 flex-1 truncate rounded-sm text-left focus-visible:outline-none"
    >
      {titleText}
    </button>
  ) : (
    <div className="min-w-0 flex-1 truncate">{titleText}</div>
  );
  // Idle cards can be parked, and parked ones unparked; working ones can't be either.
  const parkToggle = canOpen && task.status !== "wip";
  // Idle cards outside Parked can also be dragged there; a startable Queue card can also be dropped on Working to start it.
  const canDrag = parkToggle && !parked;

  // Selection wins over the column/unread border; the blocked stripe and the parked dashes stay either way.
  const borderClass = selected
    ? "border-transparent"
    : unread
      ? "border-emerald-500/45 hover:border-emerald-500/70"
      : CARD_EDGE;
  const stateClass =
    task.status === "blocked" ? `${borderClass} ${BLOCKED_STRIPE}` : parked ? `${borderClass} border-dashed` : borderClass;
  // Selected: a thick outline in the column accent; 3px stays inside the column list's p-1.5 scroll padding.
  const surfaceClass = selected ? `shadow-md outline-3 outline-offset-0 ${meta.outline}` : "";

  return (
    <article
      ref={ref}
      draggable={canDrag}
      onDragStart={(event) => {
        if (!canDrag) return;
        hideTooltip();
        event.dataTransfer.setData(THREAD_DRAG_TYPE, task.threadId);
        event.dataTransfer.effectAllowed = "move";
        // Next frame: restyling the card now would also restyle the drag image the browser is about to capture.
        dragFrame.current = requestAnimationFrame(() => onDragChange(task.threadId));
      }}
      onDragEnd={() => {
        if (!canDrag) return;
        cancelAnimationFrame(dragFrame.current);
        dragEnded.current = true;
        onDragChange(null);
      }}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      onClick={(event) => {
        if (!canOpen || (event.target as HTMLElement).closest("button, a, [role='button']")) return;
        open();
      }}
      onPointerEnter={(event) => {
        // Mouse only: touch has no hover, and a tap opens the thread.
        if (event.pointerType !== "mouse" || dragEnded.current) return;
        window.clearTimeout(tooltipTimer.current);
        tooltipTimer.current = window.setTimeout(showTooltip, TOOLTIP_DELAY_MS);
      }}
      onPointerLeave={() => {
        dragEnded.current = false;
        hideTooltip();
      }}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) showTooltip();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hideTooltip();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") hideTooltip();
      }}
      className={`group relative ${CARD_SURFACE} ${compact ? ONE_LINE_PAD : "px-2 py-1.5"} has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-ring/60 ${
        canOpen ? "cursor-pointer" : ""
      } ${dragging ? "opacity-40" : ""} ${stateClass} ${surfaceClass}`}
    >
      {compact ? (
        <div className="flex h-5 items-center gap-2">
          <span className="-mt-px flex w-4 shrink-0 justify-center">
            <TaskStatusMark status={task.status} unread={unread} />
          </span>
          {titleButton}
          {task.session?.cost ? (
            <SessionCost session={task.session} className={ONE_LINE_AGE} />
          ) : activity !== null ? (
            <Age at={activity} now={now} className={ONE_LINE_AGE} />
          ) : null}
        </div>
      ) : (
        // Two lines: status, tag and title, cost; context fill, summary, age. The status reason is in the tooltip.
        <>
          <div className="flex h-[18px] items-center gap-2">
            <span className="flex w-4 shrink-0 justify-center">
              <TaskStatusMark status={task.status} unread={unread} />
            </span>
            {titleButton}
            <SessionCost session={task.session} className={META_LINE} />
          </div>
          <div className="flex h-[18px] items-center gap-2">
            <span className="flex w-4 shrink-0 justify-center">
              <ContextPie session={task.session} />
            </span>
            <span className={`min-w-0 flex-1 truncate ${TYPE.body} ${task.missingThread ? `font-medium ${ACCENT_TEXT.rose}` : "text-muted-foreground"}`}>
              {task.missingThread ? "no thread" : task.note}
            </span>
            {age}
          </div>
        </>
      )}

      <RowActions label="Archive thread" centered={compact} onArchive={() => onArchive(task.threadId)}>
        {/* A startable card's next step is to start, so Play takes park's place; it can still be dragged to Parked. */}
        {task.startable ? (
          <button
            type="button"
            aria-label="Start thread now"
            disabled={starting}
            className={CARD_ACTION}
            onClick={() => onStart(task.threadId)}
          >
            {starting ? <Spinner /> : <Icon name="Play" className="size-3.5" aria-hidden />}
          </button>
        ) : task.status === "done" ? (
          // A Done card is finished, not something to pause: its action is to bring it back as unread. An unread card
          // already is, so it has none.
          unread || !canOpen ? null : (
            <button
              type="button"
              aria-label="Mark thread unread"
              className={CARD_ACTION}
              onClick={() => onMarkUnread(task.threadId)}
            >
              <Icon name="CircleDot" className="size-3.5" aria-hidden />
            </button>
          )
        ) : parkToggle ? (
          <button
            type="button"
            aria-label={parked ? "Unpark thread" : "Park thread"}
            className={CARD_ACTION}
            onClick={() => onPark(task.threadId, !parked)}
          >
            <Icon name={parked ? "ArrowTurnBackward" : "Pause"} className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </RowActions>

      {tooltipOpen ? (
        <CardTooltip id={tooltipId} anchor={ref} provider={provider} session={task.session} summary={compactHint} />
      ) : null}
    </article>
  );
}
