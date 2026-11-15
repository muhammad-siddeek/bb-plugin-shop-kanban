import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { ACCENT_TEXT, errorMessage } from "./model";

/**
 * The board's type scale. Every text size, and the weight and tracking of headings, badges and chips, comes from here so
 * cards, rows, popovers and the title bar read as one family. Weights for emphasis (a title's semibold, an action's
 * medium) stay at the call site.
 */
export const TYPE = {
  /** Card, row and search result titles; the composer's text; a popover's headline figure. */
  title: "text-[13px]",
  /** Card summaries, inputs, buttons, banners and panel copy. */
  body: "text-[12px]",
  /** Secondary text: row meta, times and costs, empty notes, hints, tooltips and popover lists. */
  meta: "text-[11px]",
  /** Column titles and the Queue column's tabs. */
  heading: "text-[11px] font-bold uppercase tracking-[0.1em]",
  /** Section headings inside a column or popover, and the title bar's status counts. */
  label: "text-[10px] font-semibold uppercase tracking-[0.1em]",
  /** Counts and small pills. */
  badge: "text-[10px] font-semibold tabular-nums",
  /** Small toggles and their notes, such as Me | Team. */
  control: "text-[10px] font-medium",
  /** Category and risk chips in front of a title. */
  chip: "text-[9px] font-semibold uppercase tracking-[0.06em]",
} as const;

/** A heading inside a column lines up with the cards' content: their 1px border plus `px-2`. */
const CARD_INSET = "px-[9px]";
/** Every small chip (a card's category, review risk, Archived, a follow-up already set): 16px, square-ish corners. */
export const CHIP = `inline-flex h-4 shrink-0 items-center rounded-[4px] px-1 ${TYPE.chip} leading-none`;
// Every card's marks share one 16px frame: they line up with the 18px title line (mt-px centers them), and pull
// request, issue and thread cards line up in the column.
export const MARK_FRAME = "mt-px inline-flex size-4 shrink-0 items-center justify-center";
/** A row's 20px action (28px on touch screens); `ROW_ICON_ACTION` is its square icon-only form. */
export const ROW_ACTION =
  "inline-flex h-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-7";
export const ROW_ICON_ACTION = `${ROW_ACTION} w-5 pointer-coarse:w-7`;
export const FORGE_NAME = { delta: "Delta", github: "GitHub" } as const;
/** Every dashed placeholder (empty lists, drop targets, the New thread button): one 32px-minimum slot. */
export const DASHED_SLOT = `flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-center ${TYPE.meta}`;
/** A list that has nothing to show, or nothing yet. */
export const EMPTY_NOTE = `${DASHED_SLOT} border-foreground/15 text-muted-foreground/90`;
/** One-line cards and rows (Done, Parked, Out): 28px tall, the 20px line inside a 3px pad and the border. */
export const ONE_LINE_PAD = "px-2 py-[3px]";
/**
 * A one-line row's age at its end. Touch screens always show the row's actions over the end of the line, so the age
 * gives way there instead of showing half under them.
 */
export const ONE_LINE_AGE = `shrink-0 whitespace-nowrap ${TYPE.meta} tabular-nums text-muted-foreground/80 [@media(hover:none)]:hidden`;

/** bb's composer and links: a new-thread draft in the open thread's project, and URLs (a new tab when bb can't). */
export function useBbLinks() {
  const navigate = useBbNavigate();
  const context = useBbContext();
  return {
    compose(initialPrompt: string) {
      navigate?.toCompose?.({ ...(context?.projectId ? { projectId: context.projectId } : {}), initialPrompt, focusPrompt: true });
    },
    openUrl(url: string) {
      if (!navigate?.openUrl?.(url)) window.open(url, "_blank", "noopener,noreferrer");
    },
  };
}

/**
 * A row's failure, shown on the row itself: the board's own error banner clears on its next read, a second later.
 * `attempt` runs an action and keeps its error.
 */
export function useRowError() {
  const [error, setError] = useState<string | null>(null);
  const attempt = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const view = error ? (
    <p role="alert" className={`mb-0.5 line-clamp-2 ${TYPE.meta} leading-[14px] ${ACCENT_TEXT.rose}`}>
      {error}
    </p>
  ) : null;
  return { attempt, view };
}

/** A list's problems worth a warning; searches skipped as expected (no host, a forge CLI missing or signed out) aren't. */
export function listProblems(errors: (string | null)[], sources: { search: string; error: string | null; missing: boolean }[]) {
  return [
    ...new Set([...errors, ...sources.map((source) => (source.error && !source.missing ? `${source.search}: ${source.error}` : null))]),
  ].filter((problem): problem is string => Boolean(problem));
}

/** A row's "open on its forge" link. */
export function ForgeLink({ forge, onClick }: { forge: keyof typeof FORGE_NAME; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${ROW_ACTION} gap-0.5 px-1 ${TYPE.meta} font-medium hover:bg-accent hover:text-foreground`}
    >
      {FORGE_NAME[forge]}
      <Icon name="ExternalLink" className="size-3" aria-hidden />
    </button>
  );
}

export function Spinner() {
  return <span aria-hidden className="inline-flex size-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/25 border-t-muted-foreground" />;
}

/**
 * Every count on the board (column and tab titles, section headers): a 16px pill, or nothing at zero so empty
 * lists don't add a row of noise. `tone` is the status or accent badge class; muted by default.
 */
export function CountBadge({ count, tone = "bg-muted text-muted-foreground" }: { count: number; tone?: string }) {
  if (count === 0) return null;
  return (
    <span className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1.5 ${TYPE.badge} normal-case leading-none tracking-normal ${tone}`}>
      {count}
    </span>
  );
}

/**
 * A section's header row inside a column (Parked, Read, and the Queue column's tabs' lists): an uppercase title and
 * its count, then `children` (toggles), a hairline to the end, and there a spinner while it refreshes and an amber
 * mark while it has problems.
 */
export function GroupHeader({ title, count, refreshing = false, problems = [], children }: {
  title: string;
  count: number | null;
  refreshing?: boolean;
  problems?: string[];
  children?: ReactNode;
}) {
  return (
    <div className={`flex h-6 items-center gap-1.5 ${CARD_INSET} pointer-coarse:h-7`}>
      <h3 className={`flex min-w-0 items-center gap-1.5 ${TYPE.label} leading-none text-muted-foreground`}>
        <span className="truncate">{title}</span>
        {count !== null ? <CountBadge count={count} /> : null}
      </h3>
      {children}
      <span className="h-px min-w-2 flex-1 bg-border/60" aria-hidden />
      {refreshing ? <Spinner /> : null}
      {problems.length > 0 ? (
        <span role="img" aria-label={`${title} problems: ${problems.join("; ")}`} className={`inline-flex ${ACCENT_TEXT.amber}`}>
          <Icon name="AlertCircle" className="size-3.5" aria-hidden />
        </span>
      ) : null}
    </div>
  );
}

/**
 * A card's actions, archive last: they overlay the end of the title line (no reflow); a card-colored backdrop with a
 * short leftward fade hides the truncated title underneath. Revealed on hover/focus, always on touch.
 */
export function RowActions({ label, onArchive, centered = false, children }: {
  label: string;
  onArchive: () => void;
  /** One-line rows: centered on the row's height instead of on the first line. */
  centered?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className={`absolute right-1 ${centered ? "top-1/2 -translate-y-1/2" : "top-[5px] pointer-coarse:top-px"} flex gap-0.5 bg-card opacity-0 transition-opacity duration-150 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-l before:from-card before:to-transparent before:content-[''] group-hover:opacity-100 group-focus-within:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100 pointer-coarse:right-0.5`}>
      {children}
      <button
        type="button"
        aria-label={label}
        className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-7"
        onClick={onArchive}
      >
        <Icon name="Archive" className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

/** Under a list cut at `max` rows: shows the rest, or folds them away again. */
export function ShowMore({ total, max, all, onToggle }: { total: number; max: number; all: boolean; onToggle: () => void }) {
  if (total <= max) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full rounded-md py-0.5 ${TYPE.meta} text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:py-2.5`}
    >
      {all ? "Show fewer" : `Show ${total - max} more`}
    </button>
  );
}

export function IconButton({ icon, label, onClick, small = false, solid = false, className = "" }: {
  icon: string;
  label: string;
  onClick: () => void;
  small?: boolean;
  /** A filled foreground circle (white in dark mode), for the bar's main action. */
  solid?: boolean;
  className?: string;
}) {
  const look = solid
    ? "size-7 rounded-full bg-foreground text-background shadow-sm hover:bg-foreground/85 active:bg-foreground/70 pointer-coarse:size-10"
    : `${small ? "size-6 rounded-md pointer-coarse:size-8" : "h-7 w-10 rounded-lg pointer-coarse:h-11 pointer-coarse:w-14"} text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent/70`;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex ${look} shrink-0 cursor-pointer select-none items-center justify-center transition-[background-color,color,transform] duration-150 ease-out active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 ${className}`}
    >
      <Icon name={icon} className={small ? "size-3.5 pointer-coarse:size-4" : solid ? "size-4 pointer-coarse:size-5" : "size-[15px] pointer-coarse:size-5"} aria-hidden />
    </button>
  );
}
