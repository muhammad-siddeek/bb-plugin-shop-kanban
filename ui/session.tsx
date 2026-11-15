import { useLayoutEffect, useRef, type RefObject } from "react";
import { experimental_Icon as Icon, experimental_ProviderIcon as ProviderIcon, type PluginProvidersState } from "@get-bb/plugin-sdk/app";
import { ACCENT_TEXT, formatMoney, type BoardSession } from "./model";
import { TYPE } from "./primitives";

/** An agent provider from bb's roster (`experimental_useProviders`), the same record the sidebar draws. */
export type AgentProvider = PluginProvidersState["providers"][number];

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
/** Context fill (0-1) where the pie turns amber, then red. */
const CONTEXT_WARN = 0.7;
const CONTEXT_CRITICAL = 0.9;
// The pie is drawn in currentColor, so its wedge and disc share the accent.
const WARN_TONE = { ring: ACCENT_TEXT.amber, bar: "bg-amber-500" };
const CRITICAL_TONE = { ring: ACCENT_TEXT.rose, bar: "bg-rose-500" };
/** The pie's outer radius in its 12-unit box. Its wedge is a circle at half this radius stroked the full radius wide. */
const PIE_RADIUS = 5.5;
const WEDGE_CIRCUMFERENCE = Math.PI * PIE_RADIUS;
/**
 * bb wraps provider artwork in a `min-w-max` span, and the artwork's SVG is `size-full` with no width or
 * height, so Safari sizes it at the 300px SVG default and every card overflows its column by ~270px.
 * A definite size on the SVG itself (`.x > svg` outranks its `.size-full`) keeps the icon 14px everywhere.
 */
const PROVIDER_ICON = "size-3.5 shrink-0 [&>svg]:size-3.5";

/** Three significant figures: "37.8K", "194K", "1M". */
const TOKENS = new Intl.NumberFormat(undefined, { notation: "compact", maximumSignificantDigits: 3 });

/** What the footer and the card tooltip say about a session. */
function sessionFacts(session: BoardSession | null) {
  const currency = session?.cost?.currency;
  // Part of the spend is priced from other replies' rates when a harness saved replies without a price.
  const estimated = session?.cost && session.costEstimated > 0;
  // The footer's figure is compact; the tooltip's sentence is exact.
  const cost = session?.cost ? `${estimated ? "~" : ""}${formatMoney(session.cost.amount, currency)}` : null;
  // The cost covers the thread's descendant threads too; say so when more than one spent.
  const spent = session?.cost
    ? `${estimated ? "~" : ""}${formatMoney(session.cost.amount, currency, true)} spent${session.costThreads > 1 ? ` across ${session.costThreads} threads` : ""}${
        estimated ? ` (${formatMoney(session.costEstimated, currency, true)} estimated)` : ""
      }`
    : null;
  const used = session?.usedTokens ?? null;
  const capacity = session?.contextWindow ?? null;
  const fill = used !== null && capacity ? used / capacity : null;
  const percent = fill === null ? null : `${Math.round(fill * 100)}%`;
  const tone = fill === null || fill < CONTEXT_WARN ? null : fill < CONTEXT_CRITICAL ? WARN_TONE : CRITICAL_TONE;
  const tokens = used !== null && capacity ? `${session?.estimated ? "~" : ""}${TOKENS.format(used)} / ${TOKENS.format(capacity)} tokens · ${percent}` : null;
  // Short facts first so only the long model id truncates.
  const details = [
    session?.access,
    session?.serviceTier,
    session?.modelId && session.modelId !== session.model ? session.modelId : null,
  ].filter(Boolean).join(" · ");
  return { cost, spent, fill, percent, tone, tokens, details };
}

/** The session's cost for a card's footer or one-line row; the card's tooltip has the details. */
export function SessionCost({ session, className = `inline-flex h-5 shrink-0 items-center whitespace-nowrap ${TYPE.meta} tabular-nums text-muted-foreground/80` }: {
  session: BoardSession | null;
  className?: string;
}) {
  const { cost, spent } = sessionFacts(session);
  if (cost === null) return null;
  return (
    <span aria-label={spent ?? undefined} className={className}>
      {cost}
    </span>
  );
}

/** The thread's harness icon, small and greyed so it sits under the status mark without competing with it. */
export function ModelMark({ provider }: { provider: AgentProvider | null }) {
  if (!provider) return null;
  return (
    <span role="img" aria-label={provider.displayName} className="inline-flex">
      <ProviderIcon providerKind="agent" provider={provider} className="size-3 shrink-0 opacity-60 grayscale [&>svg]:size-3" aria-hidden />
    </span>
  );
}

/**
 * Context-window fill as a pie: a solid wedge over a faint disc. Dimmer than the grey harness icon above it until it
 * turns amber, then red, as the window fills. Filled rather than stroked, so it never reads as the Working spinner.
 */
export function ContextPie({ session }: { session: BoardSession | null }) {
  const { fill, percent, tone } = sessionFacts(session);
  if (fill === null) return null;
  return (
    <svg
      role="img"
      aria-label={`${percent} of context used`}
      viewBox="0 0 12 12"
      className={`size-3 -rotate-90 ${tone?.ring ?? "text-muted-foreground/45"}`}
    >
      <circle cx="6" cy="6" r={PIE_RADIUS} fill="currentColor" fillOpacity={0.2} />
      <circle
        cx="6"
        cy="6"
        r={PIE_RADIUS / 2}
        fill="none"
        stroke="currentColor"
        strokeWidth={PIE_RADIUS}
        strokeDasharray={`${WEDGE_CIRCUMFERENCE * Math.min(fill, 1)} ${WEDGE_CIRCUMFERENCE}`}
      />
    </svg>
  );
}

/**
 * A card's hover tooltip with its harness session: harness, model and thinking level; tokens and cost; access,
 * tier and model id. It lives in the top layer, so the column's overflow can't clip it, and sits beside the
 * card (right, else left, else above or below), never over it. Rendered only while open.
 */
export function CardTooltip({ id, anchor, provider, session, summary }: {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  provider: AgentProvider | null;
  session: BoardSession | null;
  /** A one-line card's hidden text (how it was left, and its summary), led into the tooltip. */
  summary?: string;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const { fill, tone, tokens, spent, details } = sessionFacts(session);

  // After every render: the board re-renders as cards reorder, and the tooltip follows its card.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const card = anchor.current;
    if (!popover || !card) return;
    if (!popover.matches(":popover-open")) popover.showPopover();
    const a = card.getBoundingClientRect();
    const p = popover.getBoundingClientRect();
    const fit = (start: number, size: number, limit: number) => Math.max(VIEWPORT_MARGIN, Math.min(start, limit - VIEWPORT_MARGIN - size));
    const right = a.right + ANCHOR_GAP;
    const left = a.left - ANCHOR_GAP - p.width;
    const fitsRight = right + p.width <= window.innerWidth - VIEWPORT_MARGIN;
    let x: number;
    let y: number;
    if (fitsRight || left >= VIEWPORT_MARGIN) {
      x = fitsRight ? right : left;
      y = fit(a.top, p.height, window.innerHeight);
    } else {
      // Neither side fits (a narrow window): above the card, else below it.
      x = fit(a.left, p.width, window.innerWidth);
      const above = a.top - ANCHOR_GAP - p.height;
      y = above >= VIEWPORT_MARGIN ? above : a.bottom + ANCHOR_GAP;
    }
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
  });

  return (
    <div
      ref={popoverRef}
      id={id}
      role="tooltip"
      popover="manual"
      style={{ inset: "auto", margin: 0 }}
      className={`pointer-events-none w-max max-w-80 overflow-hidden rounded-md border border-border bg-popover px-2 pb-1.5 pt-1 ${TYPE.meta} leading-4 text-popover-foreground shadow-lg`}
    >
      {summary ? <div className={`mb-1 max-w-80 whitespace-normal border-b border-border/60 pb-1 ${TYPE.body} leading-snug`}>{summary}</div> : null}
      {provider || session?.model ? (
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {provider ? (
            <>
              <ProviderIcon providerKind="agent" provider={provider} className={PROVIDER_ICON} aria-hidden />
              <span className="font-semibold">{provider.displayName}</span>
            </>
          ) : null}
          {session?.model ? (
            <>
              {provider ? <span className="text-muted-foreground/60" aria-hidden>·</span> : null}
              <span className="min-w-0 truncate">{session.model}</span>
            </>
          ) : null}
          {session?.reasoning ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground" aria-label={`${session.reasoning} thinking`}>
              <span className="mr-1 text-muted-foreground/60" aria-hidden>·</span>
              <Icon name="Brain" className="size-3" aria-hidden />
              {session.reasoning}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* Context, then spend, each on its own line: together they outgrow the tooltip and wrapped mid-phrase. */}
      {tokens ? <div className="tabular-nums">{tokens}</div> : null}
      {spent ? <div className="tabular-nums">{spent}</div> : null}
      {!tokens && !spent ? <div className="text-muted-foreground">No session details yet</div> : null}
      {details ? <div className={`truncate ${TYPE.meta} text-muted-foreground`}>{details}</div> : null}
      {/* Context fill as a hairline along the bottom edge: no extra line of text. */}
      {fill !== null ? (
        <span className={`absolute bottom-0 left-0 h-[2px] ${tone?.bar ?? "bg-muted-foreground/50"}`} style={{ width: `${Math.min(fill, 1) * 100}%` }} aria-hidden />
      ) : null}
    </div>
  );
}
