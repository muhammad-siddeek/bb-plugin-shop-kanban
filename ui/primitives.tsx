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

// Every card's marks share one 16px frame: they line up with the 18px title line (mt-px centers them), and pull
// request, issue and thread cards line up in the column.
export const MARK_FRAME = "mt-px inline-flex size-4 shrink-0 items-center justify-center";
/** A row's 20px action (28px on touch screens); `ROW_ICON_ACTION` is its square icon-only form. */
export const ROW_ACTION =
  "inline-flex h-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-7";
export const ROW_ICON_ACTION = `${ROW_ACTION} w-5 pointer-coarse:w-7`;
export const FORGE_NAME = { delta: "Delta", github: "GitHub" } as const;
/** A list that has nothing to show, or nothing yet. */
export const EMPTY_NOTE = `rounded-md border border-dashed border-foreground/15 px-3 py-2 text-center ${TYPE.meta} text-muted-foreground/90`;

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
    <p role="alert" className={`mb-0.5 line-clamp-2 ${TYPE.meta} leading-[14px] ${ACCENT_TEXT.rose}`} title={error}>
      {error}
    </p>
  ) : null;
  return { attempt, view };
}

/** A list's problems worth a warning, and the searches skipped as expected (no host, a forge CLI missing or signed out). */
export function listProblems(errors: (string | null)[], sources: { search: string; error: string | null; missing: boolean }[]) {
  const problems = [
    ...new Set([...errors, ...sources.map((source) => (source.error && !source.missing ? `${source.search}: ${source.error}` : null))]),
  ].filter((problem): problem is string => Boolean(problem));
  const skipped = [...new Set(sources.flatMap((source) => (source.error && source.missing ? [source.error] : [])))];
  return { problems, skipped };
}

/** A row's "open on its forge" link. */
export function ForgeLink({ forge, onClick }: { forge: keyof typeof FORGE_NAME; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Open in ${FORGE_NAME[forge]}`}
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
 * A list's header row in the Queue column's tabs: an uppercase title and its count, then `children` (toggles, a
 * "new" count), and at the end a spinner while it refreshes and an amber mark listing its problems.
 */
export function GroupHeader({ title, count, hint, refreshing, problems, children }: {
  title: string;
  count: number | null;
  hint?: string;
  refreshing: boolean;
  problems: string[];
  children?: ReactNode;
}) {
  return (
    <div className="flex h-6 items-center gap-1.5 px-1 pointer-coarse:h-7">
      <h3 title={hint} className={`flex min-w-0 items-center gap-1 ${TYPE.label} text-muted-foreground`}>
        <span className="truncate">{title}</span>
        {count !== null ? (
          <span className={`ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1.5 ${TYPE.badge} normal-case leading-none tracking-normal`}>
            {count}
          </span>
        ) : null}
      </h3>
      {children}
      <span className="ml-auto flex items-center gap-1">
        {refreshing ? <Spinner /> : null}
        {problems.length > 0 ? (
          <span role="img" aria-label={`${title} problems: ${problems.join("; ")}`} title={problems.join("\n")} className={`inline-flex ${ACCENT_TEXT.amber}`}>
            <Icon name="AlertCircle" className="size-3.5" aria-hidden />
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A card's actions, archive last: they overlay the end of the title line (no reflow); a card-colored backdrop with a
 * short leftward fade hides the truncated title underneath. Revealed on hover/focus, always on touch.
 */
export function RowActions({ label, title, onArchive, children }: { label: string; title?: string; onArchive: () => void; children?: ReactNode }) {
  return (
    <span className="absolute right-1 top-[5px] flex gap-0.5 bg-card opacity-0 transition-opacity duration-150 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-l before:from-card before:to-transparent before:content-[''] group-hover:opacity-100 group-focus-within:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100 pointer-coarse:right-0.5 pointer-coarse:top-px">
      {children}
      <button
        type="button"
        title={title}
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
      title={label}
      onClick={onClick}
      className={`inline-flex ${look} shrink-0 cursor-pointer select-none items-center justify-center transition-[background-color,color,transform] duration-150 ease-out active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 ${className}`}
    >
      <Icon name={icon} className={small ? "size-3.5 pointer-coarse:size-4" : solid ? "size-4 pointer-coarse:size-5" : "size-[15px] pointer-coarse:size-5"} aria-hidden />
    </button>
  );
}
