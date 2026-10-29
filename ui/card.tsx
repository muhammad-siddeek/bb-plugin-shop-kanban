import { useCallback, useEffect, useId, useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_TEXT, STATUS_META, THREAD_DRAG_TYPE, formatRelativeTime, taskActivityTime, taskCardTitle, type BoardStatus, type BoardTask } from "./model";
import { CardTooltip, HarnessMeta, type AgentProvider } from "./session";

// All marks share one 16px frame so they line up with the 18px title line (mt-px centers them).
const MARK_FRAME = "mt-px inline-flex size-4 shrink-0 items-center justify-center";
const BLOCKED_STRIPE =
  "before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:rounded-r-full before:bg-rose-500/70 before:content-['']";

/** Resting on a card this long opens its tooltip; quick passes across the board don't. */
const TOOLTIP_DELAY_MS = 350;

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

/** Theme class that re-scopes bb's color tokens for a subtree (`.light` / `.dark`). */
export type ThemeScope = "light" | "dark";

function TaskStatusMark({ status, unread }: { status: BoardStatus; unread: boolean }) {
  if (status === "wip") {
    return (
      <span role="img" aria-label="In progress" className={MARK_FRAME}>
        <span className="block size-3.5 animate-spin rounded-full border-[1.5px] border-amber-500/20 border-t-[light-dark(var(--color-amber-600),var(--color-amber-500))] [animation-duration:900ms]" />
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
    <span role="img" aria-label="Queued" className={MARK_FRAME}>
      <span className="block size-3.5 rounded-full border-[1.5px] border-dashed border-sky-500/70" />
    </span>
  );
}

/** A "· text" fact after the footer's time. */
function FooterNote({ tone, text }: { tone: string; text: string }) {
  return (
    <span className={`min-w-0 truncate text-[10.5px] font-medium ${tone}`}>
      <span className="text-muted-foreground/50" aria-hidden>· </span>
      {text}
    </span>
  );
}

export function TaskCard({ task, now, unread, selected, dragging, starting, invertedTheme, provider, onArchive, onPark, onStart, onDragChange, onOpen }: {
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
  /** Opposite of bb's active theme; the selected card renders in it so it stands out. */
  invertedTheme: ThemeScope;
  /** The harness the card's thread runs on; null when bb's roster doesn't list it. */
  provider: AgentProvider | null;
  onArchive: (threadId: string) => void;
  /** Park an idle card, or unpark a parked one. */
  onPark: (threadId: string, parked: boolean) => void;
  /** Start a startable Queue card now, past the WIP limit. */
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
  // The tooltip is the harness session's details; a card with none (a thread not started yet) has no tooltip.
  const hasSession = provider !== null || task.session !== null;
  const showTooltip = () => {
    if (hasSession) setTooltipOpen(true);
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
  // Lines 1-2: "[tag] title — summary" as one run of text. Hovering the card hands it the footer's line
  // too; the footer's session facts are in the card's tooltip.
  // The 18px lines come from the 12px strut; the 13px title is leading-none so it can't grow a line.
  const text = (
    <span className="line-clamp-2 text-[12px] leading-[18px] group-hover:line-clamp-3">
      {category ? (
        <span className="mr-1.5 mt-px inline-flex h-4 max-w-[45%] items-center rounded-[4px] bg-muted px-1 align-top text-[9px] font-semibold uppercase leading-none tracking-[0.06em] text-muted-foreground">
          <span className="truncate">{category}</span>
        </span>
      ) : null}
      <span
        className={`text-[13px] leading-none decoration-muted-foreground/40 underline-offset-2 group-hover/open:underline ${
          parked ? "text-foreground/70" : "text-foreground"
        } ${unread ? "font-bold" : "font-semibold"}`}
      >
        {intent}
      </span>
      {task.note ? (
        <>
          <span className="text-muted-foreground/50" aria-hidden> — </span>
          <span className="text-muted-foreground">{task.note}</span>
        </>
      ) : null}
    </span>
  );
  const meta = STATUS_META[task.status];
  const activity = taskActivityTime(task);
  const canOpen = !task.missingThread;
  // Done cards don't repeat "Completed"; parked ones say how they were left, so they do.
  const reason = task.statusReason && task.status !== "done" && task.statusReason !== "Running" ? task.statusReason : null;
  // Idle cards can be parked, and parked ones unparked; running ones can't be either.
  const parkToggle = canOpen && task.status !== "wip";
  // Idle cards outside Parked can also be dragged there; a startable Queue card can also be dropped on WIP to start it.
  const canDrag = parkToggle && !parked;

  // Selection wins over the column/unread border; the blocked stripe and the parked dashes stay either way.
  const borderClass = selected
    ? "border-border"
    : unread
      ? "border-emerald-500/30 hover:border-emerald-500/50"
      : "border-border/60 hover:border-border";
  const stateClass =
    task.status === "blocked" ? `${borderClass} ${BLOCKED_STRIPE}` : parked ? `${borderClass} border-dashed` : borderClass;
  // Selected: flip the card into the opposite theme (bg-card, text-*, bg-muted follow) and ring it
  // in the column accent. Outline 2px + 2px offset stays inside the column's p-2 scroll padding.
  const surfaceClass = selected
    ? `${invertedTheme} shadow-md outline-2 outline-offset-2 ${meta.outline}`
    : "shadow-xs hover:shadow-sm";

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
      className={`group relative rounded-lg border bg-card px-2.5 pb-1.5 pt-2 transition-[border-color,box-shadow,background-color,opacity] duration-150 has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-ring/60 ${
        canOpen ? "cursor-pointer" : ""
      } ${dragging ? "opacity-40" : ""} ${stateClass} ${surfaceClass}`}
    >
      <div className="flex items-start gap-2">
        <TaskStatusMark status={task.status} unread={unread} />
        {/* Always two lines tall, so the hover's third line overlays the footer instead of resizing the card. */}
        {canOpen ? (
          <button
            type="button"
            data-card-open=""
            onClick={open}
            aria-describedby={tooltipOpen ? tooltipId : undefined}
            className="group/open block h-9 min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none"
          >
            {text}
          </button>
        ) : (
          <div className="h-9 min-w-0 flex-1">{text}</div>
        )}
      </div>

      {/* Start or park, and archive: overlay the end of the title line (no reflow); a card-colored backdrop with a
          short leftward fade hides the truncated title underneath. Revealed on hover/focus, always on touch. */}
      <span className="absolute right-1.5 top-[7px] flex gap-0.5 bg-card opacity-0 transition-opacity duration-150 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-l before:from-card before:to-transparent before:content-[''] group-hover:opacity-100 group-focus-within:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100 pointer-coarse:right-1 pointer-coarse:top-[3px]">
        {/* A startable card's next step is to start, so Play takes park's place; it can still be dragged to Parked. */}
        {task.startable ? (
          <button
            type="button"
            aria-label="Start thread now"
            title="Start now, past the WIP limit"
            disabled={starting}
            className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none pointer-coarse:size-7"
            onClick={() => onStart(task.threadId)}
          >
            {starting ? (
              <span className="inline-flex size-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/25 border-t-muted-foreground" aria-hidden />
            ) : (
              <Icon name="Play" className="size-3.5" aria-hidden />
            )}
          </button>
        ) : parkToggle ? (
          <button
            type="button"
            aria-label={parked ? "Unpark thread" : "Park thread"}
            className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-7"
            onClick={() => onPark(task.threadId, !parked)}
          >
            <Icon name={parked ? "ArrowTurnBackward" : "Pause"} className="size-3.5" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Archive thread"
          className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-7"
          onClick={() => onArchive(task.threadId)}
        >
          <Icon name="Archive" className="size-3.5" aria-hidden />
        </button>
      </span>

      {/* Hidden while the card is hovered: the summary takes the line, and the tooltip has these facts. */}
      <div className="mt-1 flex h-5 items-center gap-2 pl-6 group-hover:pointer-events-none group-hover:opacity-0">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {activity !== null ? (
            <time
              dateTime={new Date(activity).toISOString()}
              className="shrink-0 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground/80"
            >
              {formatRelativeTime(activity, now)}
            </time>
          ) : null}
          {reason ? <FooterNote tone={`opacity-90 ${meta.title}`} text={reason} /> : null}
          {task.missingThread ? <FooterNote tone={ACCENT_TEXT.rose} text="no thread" /> : null}
        </div>
        <div className="flex shrink-0 items-center">
          <HarnessMeta provider={provider} session={task.session} />
        </div>
      </div>
      {tooltipOpen ? <CardTooltip id={tooltipId} anchor={ref} provider={provider} session={task.session} /> : null}
    </article>
  );
}
