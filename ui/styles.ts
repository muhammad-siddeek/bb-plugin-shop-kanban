import type { BoardStatus } from "./model";

// The board's visual vocabulary: every class string that more than one component draws with. Tailwind reads these at
// build time, so each stays a complete literal.

/**
 * The board's type scale, a closed set. Every text size, and the weight and tracking of headings, badges and chips,
 * comes from here so cards, rows, popovers and the title bar read as one family; 16px is only for form fields on
 * touch screens, where anything smaller zooms the page. Weights: 400 copy, 500 actions, 600 titles and labels, 700
 * unread titles and column headings; emphasis stays at the call site. Line heights, one per role: none on one-line
 * controls, 14px for wrapping meta, 16px for wrapping body copy, 18px for a two-line card's lines and any title that
 * wraps, 20px for a one-line row.
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
  /** Category and risk chips in front of a title. */
  chip: "text-[9px] font-semibold uppercase tracking-[0.06em]",
} as const;

/**
 * The board's sizes, a closed set on a 4px grid with 2px half-steps for the insides of rows.
 * - Spacing: 2, 4, 6, 8, 12, 16, 20. Cards and rows sit 4px apart, groups in a column 8px, a popover's content
 *   12px in from its edge, a dialog's 20px (12px on phones).
 * - Heights: 16 chips and marks, 20 a row's line and actions, 24 group headers and fields, 28 one-line cards and
 *   title-bar controls, 32 column headers and dashed slots, 36 the title bar. Touch screens take
 *   28 inside columns, 36 in the title bar and for form fields.
 * - Icons: 10 on a disc or in a chip, 12 beside meta text, 14 for marks and row actions, 16 in banners, dialogs and
 *   the title bar's mark. Dots: 6 for a verdict, 8 in the working meter.
 * - Radii: 4 (chips, small controls, focus outlines), 6 (cards, buttons, fields, slots), 12 (popovers, the dialog),
 *   full (pills, discs, dots). Strokes: 1 hairlines, 1.5 small rings and the spinner, 2 focus rings, 3 selection.
 * Offsets that line one thing up with another (CARD_INSET, COLUMN_INSET, a one-line card's 3px pad, the row
 * actions' 5px drop) are derived from these, not new steps; so is glyph geometry (the meter's dot spacing).
 */

/**
 * Every card's title: semibold, bold while unread, with the underline its hover draws. The caller picks what hovers
 * (`hover:underline` on the title, `group-hover/open:underline` on its button) and the color.
 */
export function cardTitle(unread = false): string {
  return `${TYPE.title} ${unread ? "font-bold" : "font-semibold"} decoration-muted-foreground/50 underline-offset-2`;
}

/**
 * The board's colors, a closed set. Four hues, each with one meaning: sky (queued, new), amber (working, warning),
 * rose (blocked, errors, removing), emerald (done, approving). Everything else is bb's neutral theme (foreground,
 * muted-foreground, border, background, card, popover, muted, accent, ring); no primary, no black but the dialog's scrim.
 *
 * Every hue and the grey climb one alpha ladder, each step with one job:
 * - /15 tint: badge and chip fills, hover and pressed washes, a drop target's highlight.
 * - /50 line: borders, an unread card's edge, chart thresholds, a drop target still waiting.
 * - /70 edge: lines that carry a state (the queued ring, a free slot) and edges under the pointer or focus.
 * - solid -500: marks, unread pills, meter dots; -600 under the pointer on a solid button.
 * Grey reads about a step heavier than a hue at the same alpha (a grey /50 line measures like the hues' /70 ones), so
 * grey marks and data bars take the line step. Neutral lines: `border-border` for edges, `/60` for dividers inside a
 * surface, and the cards' hairline.
 *
 * Text: foreground; foreground/85 for read titles and figures within copy; muted-foreground for secondary copy,
 * labels and idle icons; /80 for the quietest words (ages, costs, hints, placeholders: 4.6:1 on a light card); /50
 * for glyphs only, never words. Opacity only reveals (0 and 100) or holds back (50: disabled, dragged, stale), and
 * every focus ring is `ring-ring/60`.
 */

/**
 * Accent text per hue: the -500 shade on dark, -700 on light, where -500 is too faint to read (about 2:1 on
 * white). light-dark() follows the nearest bb theme scope (its .light/.dark classes set color-scheme), so the
 * selected card, drawn in the opposite theme, gets the right shade too.
 */
export const ACCENT_TEXT = {
  sky: "text-[light-dark(var(--color-sky-700),var(--color-sky-500))]",
  amber: "text-[light-dark(var(--color-amber-700),var(--color-amber-500))]",
  rose: "text-[light-dark(var(--color-rose-700),var(--color-rose-500))]",
  emerald: "text-[light-dark(var(--color-emerald-700),var(--color-emerald-500))]",
} as const;

/** Accent text on hover and keyboard focus, for controls that take their hue only when pointed at. */
export const ACCENT_HOVER_TEXT = {
  sky: "hover:text-[light-dark(var(--color-sky-700),var(--color-sky-500))] focus-visible:text-[light-dark(var(--color-sky-700),var(--color-sky-500))]",
  rose: "hover:text-[light-dark(var(--color-rose-700),var(--color-rose-500))] focus-visible:text-[light-dark(var(--color-rose-700),var(--color-rose-500))]",
  emerald: "hover:text-[light-dark(var(--color-emerald-700),var(--color-emerald-500))] focus-visible:text-[light-dark(var(--color-emerald-700),var(--color-emerald-500))]",
} as const;

/** A tinted pill (counts, risk chips): the tint costs contrast, so its text goes one shade darker on light. */
export const ACCENT_BADGE = {
  sky: "bg-sky-500/15 text-[light-dark(var(--color-sky-800),var(--color-sky-500))]",
  amber: "bg-amber-500/15 text-[light-dark(var(--color-amber-800),var(--color-amber-500))]",
  rose: "bg-rose-500/15 text-[light-dark(var(--color-rose-800),var(--color-rose-500))]",
  emerald: "bg-emerald-500/15 text-[light-dark(var(--color-emerald-800),var(--color-emerald-500))]",
} as const;

/** Unread marks and counts: a solid circle or pill with white text, so new things stand out from tinted ones. */
export const UNREAD_BADGE = {
  sky: "bg-sky-500 text-white",
  rose: "bg-rose-500 text-white",
  emerald: "bg-emerald-500 text-white",
} as const;

/** Colors per card state; each column takes those of the state it is named after. Parked is grey. */
export const STATUS_META: Record<BoardStatus, {
  title: string;
  accent: string;
  badge: string;
  outline: string;
}> = {
  queue: { title: ACCENT_TEXT.sky, accent: "bg-sky-500", badge: ACCENT_BADGE.sky, outline: "outline-sky-500" },
  wip: { title: ACCENT_TEXT.amber, accent: "bg-amber-500", badge: ACCENT_BADGE.amber, outline: "outline-amber-500" },
  blocked: { title: ACCENT_TEXT.rose, accent: "bg-rose-500", badge: ACCENT_BADGE.rose, outline: "outline-rose-500" },
  done: { title: ACCENT_TEXT.emerald, accent: "bg-emerald-500", badge: ACCENT_BADGE.emerald, outline: "outline-emerald-500" },
  parked: { title: "text-muted-foreground", accent: "bg-muted-foreground", badge: "bg-muted-foreground/15 text-muted-foreground", outline: "outline-muted-foreground" },
};

/** Shadows, by how high a thing sits. Tailwind needs whole literals, so the variants that use them repeat them. */
export const ELEVATION = {
  /** Cards and boxes resting on a column. */
  rest: "shadow-[0_1px_1px_0_rgb(0_0_0/0.05),0_1px_3px_-1px_rgb(0_0_0/0.08)]",
  /** A hovered or selected card. */
  raised: "shadow-[0_1px_2px_0_rgb(0_0_0/0.08),0_2px_6px_-2px_rgb(0_0_0/0.12)]",
  /** What floats over the board or the page: the title bar's dropdowns. */
  float: "shadow-[0_2px_6px_-2px_rgb(0_0_0/0.15),0_12px_32px_-12px_rgb(0_0_0/0.35)]",
  /** The board itself, docked along bb's bottom edge and casting up over bb's page. */
  floatUp: "shadow-[0_-2px_6px_-2px_rgb(0_0_0/0.15),0_-12px_32px_-12px_rgb(0_0_0/0.35)]",
  /** The Radar dialog. */
  modal: "shadow-[0_24px_80px_-16px_rgb(0_0_0/0.5)]",
} as const;

/**
 * Every card's surface: a hairline plus a 1px drop, since the cards sit only 4px apart and need a crisp edge rather
 * than spacing to separate them. Raised under the pointer.
 */
const CARD_SURFACE = `rounded-md border bg-card ${ELEVATION.rest} transition-[border-color,box-shadow,background-color,opacity] duration-150 hover:shadow-[0_1px_2px_0_rgb(0_0_0/0.08),0_2px_6px_-2px_rgb(0_0_0/0.12)]`;
/**
 * The cards' hairline, drawn from the foreground so it reads in both themes and in the selected card's inverted
 * scope. Dark cards sit darker than their column, so it goes a step brighter there to keep a drawn edge.
 */
const HAIRLINE =
  "border-[light-dark(color-mix(in_oklab,var(--foreground)_12%,transparent),color-mix(in_oklab,var(--foreground)_18%,transparent))]";
/** Card borders: resting (and hover), an unread card's accent line, or none while an outline draws the edge. */
const CARD_BORDER = {
  rest: `${HAIRLINE} hover:border-[light-dark(color-mix(in_oklab,var(--foreground)_24%,transparent),color-mix(in_oklab,var(--foreground)_30%,transparent))]`,
  sky: "border-sky-500/50 hover:border-sky-500/70",
  emerald: "border-emerald-500/50 hover:border-emerald-500/70",
  none: "border-transparent",
} as const;

/** Every card's frame: the surface and a `border`. The card sets `relative`. */
export function cardFrame(border: keyof typeof CARD_BORDER = "rest"): string {
  return `${CARD_SURFACE} ${CARD_BORDER[border]}`;
}

/**
 * A heading inside a column lines up with the cards' content: their 1px border plus the cards' 6px start and 8px end
 * padding (CARD_PAD_X).
 */
export const CARD_INSET = "pl-[7px] pr-[9px]";
/** The column header and the title bar start on the cards' content edge: the column's 6px padding plus CARD_INSET. */
export const COLUMN_INSET = "pl-[13px]";
/** Every card's side padding: 6px at the start, where the mark's circle sits as far in as from the top, 8px at the end. */
export const CARD_PAD_X = "pl-1.5 pr-2";
/** Every small chip (a card's category, review risk, Archived, a follow-up already set): 16px, square-ish corners. */
export const CHIP = `inline-flex h-4 shrink-0 items-center rounded-sm px-1 ${TYPE.chip} leading-none`;
/** A row's 20px action (28px on touch screens); `ICON_ACTION` holds its square icon-only forms. */
export const ROW_ACTION =
  "inline-flex h-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 transition-[color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-7";
const ROW_ICON_ACTION = `${ROW_ACTION} w-5 pointer-coarse:w-7`;
/** A row's icon-only actions, by hue: grey for most, rose to archive or decline, emerald to approve. */
export const ICON_ACTION = {
  neutral: `${ROW_ICON_ACTION} hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground`,
  rose: `${ROW_ICON_ACTION} hover:bg-rose-500/15 focus-visible:bg-rose-500/15 ${ACCENT_HOVER_TEXT.rose}`,
  emerald: `${ROW_ICON_ACTION} hover:bg-emerald-500/15 focus-visible:bg-emerald-500/15 ${ACCENT_HOVER_TEXT.emerald}`,
} as const;
/** Every dashed placeholder (empty lists, drop targets, the New thread button): one 32px-minimum slot. */
export const DASHED_SLOT = `flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-center ${TYPE.meta}`;
/** A list that has nothing to show, or nothing yet: the cards' hairline, dashed. */
export const EMPTY_NOTE = `${DASHED_SLOT} ${HAIRLINE} text-muted-foreground`;
/** One-line cards and rows (Done, Parked, Out): 28px tall, the 20px line inside a 3px pad and the border. */
export const ONE_LINE_PAD = `${CARD_PAD_X} py-[3px]`;
/** Two-line rows (Reviews, Assigned): the title line, then a meta line of age, reference and the row's actions. */
export const TWO_LINE_PAD = `${CARD_PAD_X} pb-1 pt-1.5`;
/** A two-line row's second line; its actions end flush with the archive button above. */
export const TWO_LINE_META_ROW = "-mr-[3px] mt-0.5 flex h-5 items-center gap-0.5 pointer-coarse:h-7";
/** The second line's text, truncated before the actions. */
export const TWO_LINE_META = `mr-1 min-w-0 flex-1 truncate ${TYPE.meta} tabular-nums text-muted-foreground/80`;
/**
 * A one-line row's age at its end. Touch screens always show the row's actions over the end of the line, so the age
 * gives way there instead of showing half under them.
 */
export const ONE_LINE_AGE = `shrink-0 whitespace-nowrap ${TYPE.meta} tabular-nums text-muted-foreground/80 [@media(hover:none)]:hidden`;

/** The title bar's dropdowns (search results, a resource's popover); full width on phones. */
export const POPOVER = `absolute z-30 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground ${ELEVATION.float} max-sm:inset-x-2 max-sm:w-auto`;
export const POPOVER_SIDE = { above: "bottom-full mb-1.5", below: "top-full mt-1.5" } as const;
export interface Dropdown {
  side: keyof typeof POPOVER_SIDE;
  maxHeight: number;
}
/** An error across the top of a panel (the board, the Radar dialog): a rose tint with a rose line under it. */
export const ALERT_BANNER = `border-b border-rose-500/50 ${ACCENT_BADGE.rose}`;
