import { useCallback, useEffect, useRef } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { THREAD_DRAG_TYPE, taskActivityTime, taskCardTitle, type BoardStatus, type BoardTask } from "./model";
import { Age, IconMark, Mark, RowActions, Spinner } from "./primitives";
import { ACCENT_TEXT, CARD_PAD_X, CHIP, ELEVATION, ICON_ACTION, ON_ACCENT_TEXT, ONE_LINE_AGE, ONE_LINE_PAD, STATUS_META, TYPE, UNREAD_BADGE, cardFrame, cardTitle } from "./styles";
import { ContextPie, SessionCost } from "./session";

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
      <Mark label="Working">
        <svg
          viewBox="0 0 16 16"
          className={`size-3.5 animate-[spin_800ms_steps(8)_infinite] ${ACCENT_TEXT.amber}`}
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
      </Mark>
    );
  }
  if (status === "done") {
    return (
      <Mark label={unread ? "Done · unread" : "Done"} disc={`transition-colors ${unread ? UNREAD_BADGE.emerald : STATUS_META.done.badge}`}>
        <Icon name="Check" className="size-3" aria-hidden />
      </Mark>
    );
  }
  if (status === "blocked") {
    return (
      <Mark label="Blocked" disc={`bg-rose-500 text-[10px] font-bold leading-none ${ON_ACCENT_TEXT}`}>
        !
      </Mark>
    );
  }
  if (status === "parked") return <IconMark label="Parked" icon="Pause" disc={STATUS_META.parked.badge} />;
  return (
    <Mark label="In queue">
      <span className="block size-3.5 rounded-full border-[1.5px] border-dashed border-sky-500/70" />
    </Mark>
  );
}

export function TaskCard({ task, now, unread, selected, dragging, starting, onArchive, onPark, onMarkUnread, onStart, onDragChange, onOpen }: {
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
  const dragFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(dragFrame.current), []);
  const { category, intent } = taskCardTitle(task);
  const parked = task.status === "parked";
  // Done and Parked cards are finished or set aside: one line (mark, tag, title, and cost, else age).
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
        className={`min-w-0 truncate ${cardTitle(unread)} group-hover/open:underline ${
          unread || !compact ? "text-foreground" : "text-foreground/85"
        }`}
      >
        {intent}
      </span>
    </span>
  );
  const meta = STATUS_META[task.status];
  // Working cards drop the age, so their summary runs to the end of the second line.
  const activity = task.status === "wip" ? null : taskActivityTime(task);
  const canOpen = !task.missingThread;
  const titleButton = canOpen ? (
    <button
      type="button"
      data-card-open=""
      onClick={open}
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

  // Selection wins over the column/unread border; the parked dashes stay either way.
  const frameClass = `${cardFrame(selected ? "none" : unread ? "emerald" : "rest")}${parked ? " border-dashed" : ""}`;
  // Selected: a thick outline in the column accent; 3px stays inside the column list's p-1.5 scroll padding.
  const surfaceClass = selected ? `${ELEVATION.raised} outline-3 outline-offset-0 ${meta.outline}` : "";

  return (
    <article
      ref={ref}
      draggable={canDrag}
      onDragStart={(event) => {
        if (!canDrag) return;
        event.dataTransfer.setData(THREAD_DRAG_TYPE, task.threadId);
        event.dataTransfer.effectAllowed = "move";
        // Next frame: restyling the card now would also restyle the drag image the browser is about to capture.
        dragFrame.current = requestAnimationFrame(() => onDragChange(task.threadId));
      }}
      onDragEnd={() => {
        if (!canDrag) return;
        cancelAnimationFrame(dragFrame.current);
        onDragChange(null);
      }}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      onClick={(event) => {
        if (!canOpen || (event.target as HTMLElement).closest("button, a, [role='button']")) return;
        open();
      }}
      className={`group relative ${frameClass} ${compact ? ONE_LINE_PAD : `${CARD_PAD_X} py-1.5`} has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-ring/60 ${
        canOpen ? "cursor-pointer" : ""
      } ${dragging ? "opacity-50" : ""} ${surfaceClass}`}
    >
      {compact ? (
        <div className="flex h-5 items-center gap-2">
          <TaskStatusMark status={task.status} unread={unread} />
          {titleButton}
          {task.session?.cost ? (
            <SessionCost session={task.session} className={ONE_LINE_AGE} />
          ) : (
            <Age at={activity} now={now} className={ONE_LINE_AGE} />
          )}
        </div>
      ) : (
        // Two lines: status, tag and title, cost; context fill, summary, age (none while working).
        <>
          <div className="flex h-[18px] items-center gap-2">
            <TaskStatusMark status={task.status} unread={unread} />
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
            <Age at={activity} now={now} className={META_LINE} />
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
            className={ICON_ACTION.neutral}
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
              className={ICON_ACTION.neutral}
              onClick={() => onMarkUnread(task.threadId)}
            >
              <Icon name="CircleDot" className="size-3.5" aria-hidden />
            </button>
          )
        ) : parkToggle ? (
          <button
            type="button"
            aria-label={parked ? "Unpark thread" : "Park thread"}
            className={ICON_ACTION.neutral}
            onClick={() => onPark(task.threadId, !parked)}
          >
            <Icon name={parked ? "ArrowTurnBackward" : "Pause"} className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </RowActions>
    </article>
  );
}
