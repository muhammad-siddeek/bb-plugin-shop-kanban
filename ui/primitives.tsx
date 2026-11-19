import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { experimental_Icon as Icon, useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { errorMessage, formatShortAge, parseTime } from "./model";
import { ACCENT_TEXT, CARD_INSET, ICON_ACTION, ROW_ACTION, TYPE } from "./styles";

const FORGE_NAME = { delta: "Delta", github: "GitHub" } as const;
/** Lists show this many rows until "Show N more". */
const SHOWN_MAX = 8;

/**
 * How long ago `at` (epoch ms or an ISO string) was, as a `<time>`: `5m`, `3h`, `2d`; nothing when it isn't a time.
 * `after` follows it only when it shows, such as a meta line's ` · `.
 */
export function Age({ at, now, className, after }: { at: string | number | null; now: number; className?: string; after?: string }) {
  const ms = parseTime(at);
  if (ms === null) return null;
  return (
    <>
      <time dateTime={new Date(ms).toISOString()} className={className}>
        {formatShortAge(ms, now)}
      </time>
      {after}
    </>
  );
}

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
 * A row's actions and their failure, shown on the row itself: the board's own error banner clears on its next read, a
 * second later. `attempt` runs an action and keeps its error. Given a `key`, the action is `pending` until it settles,
 * and keyed attempts made meanwhile are dropped.
 */
export function useRowAction<Key extends string = string>() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Key | null>(null);
  const attempt = async (action: () => Promise<unknown>, key?: Key) => {
    if (key !== undefined) {
      if (pending !== null) return;
      setPending(key);
    }
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    }
    if (key !== undefined) setPending(null);
  };
  const view = error ? (
    <p role="alert" className={`mb-0.5 line-clamp-2 ${TYPE.meta} leading-[14px] ${ACCENT_TEXT.rose}`}>
      {error}
    </p>
  ) : null;
  return { attempt, pending, view };
}

/** While `open`, a press anywhere outside `root` calls `close`. */
export function useOutsideClose(root: RefObject<Element | null>, open: boolean, close: () => void) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node && root.current?.contains(event.target))) latest.current();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [root, open]);
}

/**
 * Whether a key belongs to `box`, which holds bb's composer: typed inside it, with none of the composer's menus open.
 * The menus portal outside the box and handle their own keys, Escape included.
 */
export function keyForBox(box: Element, event: { target: EventTarget | null }): boolean {
  return event.target instanceof Node && box.contains(event.target) && !box.querySelector('[aria-expanded="true"]');
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

/** `large` for a whole panel's loading state. */
export function Spinner({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 animate-spin rounded-full border-muted-foreground/15 border-t-muted-foreground ${large ? "size-4 border-2" : "size-3 border-[1.5px]"}`}
    />
  );
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
 * A section's header row inside a column (Parked, Read, and the work and review lists): an uppercase title and
 * its count, then `children` (notes), a hairline to the end, and there a spinner while it refreshes and an amber
 * mark while it has problems.
 */
export function GroupHeader({ title, count, countTone, refreshing = false, problems = [], children }: {
  title: string;
  count: number | null;
  countTone?: string;
  refreshing?: boolean;
  problems?: string[];
  children?: ReactNode;
}) {
  return (
    <div className={`flex h-6 items-center gap-1.5 ${CARD_INSET} pointer-coarse:h-7`}>
      <h3 className={`flex min-w-0 items-center gap-1.5 ${TYPE.label} leading-none text-muted-foreground`}>
        <span className="truncate">{title}</span>
        {count !== null ? <CountBadge count={count} tone={countTone} /> : null}
      </h3>
      {children}
      <span className="h-px min-w-2 flex-1 bg-border/60" aria-hidden />
      {refreshing ? <Spinner /> : null}
      {problems.length > 0 ? (
        <span role="img" aria-label={`${title} problems: ${problems.join("; ")}`} title={problems.join("\n")} className={`inline-flex ${ACCENT_TEXT.amber}`}>
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
        className={ICON_ACTION.rose}
        onClick={onArchive}
      >
        <Icon name="Archive" className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

/** A list's first SHOWN_MAX rows, then a toggle that shows the rest or folds them away again. */
export function CappedList<T>({ items, children }: { items: readonly T[]; children: (item: T) => ReactNode }) {
  const [all, setAll] = useState(false);
  return (
    <>
      {(all ? items : items.slice(0, SHOWN_MAX)).map((item) => children(item))}
      {items.length > SHOWN_MAX ? (
        <button
          type="button"
          onClick={() => setAll((shown) => !shown)}
          className={`block h-5 w-full rounded-md ${TYPE.meta} text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-7`}
        >
          {all ? "Show fewer" : `Show ${items.length - SHOWN_MAX} more`}
        </button>
      ) : null}
    </>
  );
}

/**
 * A card's leading mark: a 16px frame whose 1px top and bottom margins make it as tall as the 18px title line, so it
 * centers on the title in every row, and pull request and thread cards line up in the column. On a `disc` (a
 * solid or tinted circle) it holds a 10px glyph; bare, a 14px one.
 */
export function Mark({ label, disc, children }: { label: string; disc?: string; children: ReactNode }) {
  return (
    <span role="img" aria-label={label} className={`my-px inline-flex size-4 shrink-0 items-center justify-center${disc ? ` rounded-full ${disc}` : ""}`}>
      {children}
    </span>
  );
}

/** A mark showing one icon: on `disc` in the disc's text color, else bare in `tone`. */
export function IconMark({ label, icon, fallback, disc, tone = "", filled = false }: {
  label: string;
  icon: string;
  fallback?: string;
  disc?: string;
  tone?: string;
  /** Fill the icon's shapes too (Lucide icons are outlines). */
  filled?: boolean;
}) {
  return (
    <Mark label={label} disc={disc}>
      <Icon name={icon} fallback={fallback} className={`${disc ? "size-2.5" : `size-3.5 ${tone}`}${filled ? " fill-current" : ""}`} aria-hidden />
    </Mark>
  );
}

/** The title bar's bordered icon button (Hide board). */
export function IconButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md border border-border text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-9"
    >
      <Icon name={icon} className="size-3.5 pointer-coarse:size-4" aria-hidden />
    </button>
  );
}
