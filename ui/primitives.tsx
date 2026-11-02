import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_TEXT } from "./model";

// Same 16px mark frame as thread cards, so pull request, issue and thread cards line up in the column.
export const MARK_FRAME = "mt-px inline-flex size-4 shrink-0 items-center justify-center";
/** A row's 20px action (28px on touch screens); `ROW_ICON_ACTION` is its square icon-only form. */
export const ROW_ACTION =
  "inline-flex h-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-7";
export const ROW_ICON_ACTION = `${ROW_ACTION} w-5 pointer-coarse:w-7`;

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
    <div className="flex h-5 items-center gap-1.5 px-0.5 pointer-coarse:h-7">
      <h3 title={hint} className="flex min-w-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        <span className="truncate">{title}</span>
        {count !== null ? (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold normal-case leading-none tracking-normal tabular-nums">
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

/** A row's archive button: the thread cards' hover overlay, over the end of the title line. */
export function ArchiveOverlay({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <span className="absolute right-1.5 top-[5px] flex bg-card opacity-0 transition-opacity duration-150 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-l before:from-card before:to-transparent before:content-[''] group-hover:opacity-100 group-focus-within:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100 pointer-coarse:right-1 pointer-coarse:top-px">
      <button
        type="button"
        title={title}
        aria-label={label}
        className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-7"
        onClick={onClick}
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
      className="w-full rounded-md py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:py-2.5"
    >
      {all ? "Show fewer" : `Show ${total - max} more`}
    </button>
  );
}

export function IconButton({ icon, label, onClick, small = false, className = "" }: {
  icon: string;
  label: string;
  onClick: () => void;
  small?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex ${small ? "size-6 rounded-md pointer-coarse:size-8" : "h-7 w-10 rounded-lg pointer-coarse:h-11 pointer-coarse:w-14"} shrink-0 cursor-pointer select-none items-center justify-center text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-90 active:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 ${className}`}
    >
      <Icon name={icon} className={small ? "size-3.5 pointer-coarse:size-4" : "size-[15px] pointer-coarse:size-5"} aria-hidden />
    </button>
  );
}
