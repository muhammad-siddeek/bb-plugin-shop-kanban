import { useCallback, useEffect, useRef } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import {
  COLUMN_META,
  boardCardLayoutKey,
  columnMeta,
  formatRelativeTime,
  revealBoardCard,
  taskActivityTime,
  taskCardTitle,
  type BoardColumn,
  type BoardTask,
} from "./model";
import { HarnessMeta, type AgentProvider } from "./session";

// All marks share one 16px frame so they line up with the 18px title line (mt-px centers them).
const MARK_FRAME = "mt-px inline-flex size-4 shrink-0 items-center justify-center";
const BLOCKED_STRIPE =
  "before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:rounded-r-full before:bg-rose-500/70 before:content-['']";

/** Theme class that re-scopes bb's color tokens for a subtree (`.light` / `.dark`). */
export type ThemeScope = "light" | "dark";

function TaskStatusMark({ column, unread = false }: { column: BoardColumn; unread?: boolean }) {
  if (column === "wip") {
    return (
      <span aria-label="In progress" title="In progress" className={MARK_FRAME}>
        <span className="block size-3.5 animate-spin rounded-full border-[1.5px] border-amber-500/20 border-t-amber-500 [animation-duration:900ms]" />
      </span>
    );
  }
  if (column === "done") {
    return (
      <span
        aria-label={unread ? "Done · unread" : "Done"}
        title={unread ? "Done · unread" : "Done"}
        className={`${MARK_FRAME} rounded-full transition-colors ${
          unread ? "bg-emerald-500 text-white" : COLUMN_META.done.badge
        }`}
      >
        <Icon name="Check" className="size-3" aria-hidden />
      </span>
    );
  }
  if (column === "blocked") {
    return (
      <span
        aria-label="Blocked"
        title="Blocked"
        className={`${MARK_FRAME} rounded-full bg-rose-500 text-[10.5px] font-bold leading-none text-white`}
      >
        !
      </span>
    );
  }
  return (
    <span aria-label="Queued" title="Queued" className={MARK_FRAME}>
      <span className="block size-3.5 rounded-full border-[1.5px] border-dashed border-sky-500/70" />
    </span>
  );
}

export function TaskCard({ task, now, unread, selected, invertedTheme, provider, onArchive, onOpen }: {
  task: BoardTask;
  now: number;
  unread: boolean;
  /** Card belongs to the thread currently open in bb. */
  selected: boolean;
  /** Opposite of bb's active theme; the selected card renders in it so it stands out. */
  invertedTheme: ThemeScope;
  /** The harness the card's thread runs on; null when bb's roster doesn't list it. */
  provider: AgentProvider | null;
  onArchive: (threadId: string) => void;
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
      const layout = card ? boardCardLayoutKey(card) : null;
      if (!card || (!state.force && layout === state.layout)) return;
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
  const { category, intent } = taskCardTitle(task);
  const titleText = category ? `[${category}] ${intent}` : intent;
  const emphasized = unread && task.column === "done";
  const titleNode = (
    <>
      {category ? (
        <span className="inline-flex h-4 max-w-[45%] shrink-0 items-center rounded-[4px] bg-muted px-1 text-[9px] font-semibold uppercase leading-none tracking-[0.06em] text-muted-foreground">
          <span className="truncate">{category}</span>
        </span>
      ) : null}
      <span className="min-w-0 truncate">{intent}</span>
    </>
  );
  const titleClass = `flex h-[18px] min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-foreground ${
    emphasized ? "font-semibold" : "font-medium"
  }`;
  const meta = columnMeta(task.column);
  const activity = taskActivityTime(task);
  const canOpen = !task.missingThread;
  const reason = task.statusReason && task.column !== "done" && task.statusReason !== "Running" ? task.statusReason : null;

  // Selection wins over the column/unread border; the blocked stripe stays either way.
  const borderClass = selected
    ? "border-border"
    : emphasized
      ? "border-emerald-500/30 hover:border-emerald-500/50"
      : "border-border/60 hover:border-border";
  const stateClass = task.column === "blocked" ? `${borderClass} ${BLOCKED_STRIPE}` : borderClass;
  // Selected: flip the card into the opposite theme (bg-card, text-*, bg-muted follow) and ring it
  // in the column accent. Outline 2px + 2px offset stays inside the column's p-2 scroll padding.
  const surfaceClass = selected
    ? `${invertedTheme} shadow-md outline-2 outline-offset-2 ${meta.outline}`
    : "shadow-xs hover:shadow-sm";

  return (
    <article
      ref={ref}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      onClick={(event) => {
        if (!canOpen || (event.target as HTMLElement).closest("button, a, [role='button']")) return;
        open();
      }}
      className={`group relative rounded-lg border bg-card px-2.5 pb-1.5 pt-2 transition-[border-color,box-shadow,background-color] duration-150 has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-ring/60 ${
        canOpen ? "cursor-pointer" : ""
      } ${stateClass} ${surfaceClass}`}
    >
      <div className="flex items-start gap-2">
        <TaskStatusMark column={task.column} unread={unread} />
        <div className="min-w-0 flex-1">
          {canOpen ? (
            <button
              type="button"
              data-card-open=""
              onClick={open}
              title={`Open thread · ${titleText}`}
              className={`${titleClass} w-full rounded-sm text-left decoration-muted-foreground/40 underline-offset-2 hover:underline focus-visible:outline-none`}
            >
              {titleNode}
            </button>
          ) : (
            <h3 className={titleClass} title={titleText}>{titleNode}</h3>
          )}
          {task.note ? (
            <p className="mt-0.5 line-clamp-2 text-xs leading-[16px] text-muted-foreground" title={task.note}>{task.note}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-1 flex h-5 items-center gap-1 pl-6">
        {activity !== null ? (
          <time
            dateTime={new Date(activity).toISOString()}
            title={`Updated ${new Date(activity).toLocaleString()}`}
            className="shrink-0 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground/70"
          >
            {formatRelativeTime(activity, now)}
          </time>
        ) : null}
        <HarnessMeta provider={provider} session={task.session} />
        {reason ? (
          <span className={`min-w-0 truncate text-[10.5px] font-medium opacity-90 ${meta.title}`} title={reason}>
            <span className="text-muted-foreground/50" aria-hidden>· </span>
            {reason}
          </span>
        ) : null}
        {task.missingThread ? (
          <span className="min-w-0 truncate text-[10.5px] font-medium text-rose-500" title="The BB thread for this card no longer exists">
            <span className="text-muted-foreground/50" aria-hidden>· </span>
            no thread
          </span>
        ) : null}
        <button
          type="button"
          title="Archive thread"
          aria-label="Archive thread"
          className="-mr-1 ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-[color,background-color,opacity] duration-150 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [@media(hover:hover)]:opacity-50 group-hover:opacity-100"
          onClick={() => onArchive(task.threadId)}
        >
          <Icon name="Archive" className="size-3.5" aria-hidden />
        </button>
      </div>
    </article>
  );
}
