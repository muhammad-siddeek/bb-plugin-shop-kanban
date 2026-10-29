import { useLayoutEffect, useRef, type RefObject } from "react";
import { experimental_Icon as Icon, experimental_ProviderIcon as ProviderIcon, type PluginProvidersState } from "@get-bb/plugin-sdk/app";
import { ACCENT_TEXT, type BoardSession } from "./model";

/** An agent provider from bb's roster (`experimental_useProviders`), the same record the sidebar draws. */
export type AgentProvider = PluginProvidersState["providers"][number];

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
/** Context fill (0-1) where the ring turns amber, then red. */
const CONTEXT_WARN = 0.7;
const CONTEXT_CRITICAL = 0.9;
// The ring is drawn in currentColor, so its percentage and stroke share the accent.
const WARN_TONE = { ring: ACCENT_TEXT.amber, bar: "bg-amber-500" };
const CRITICAL_TONE = { ring: ACCENT_TEXT.rose, bar: "bg-rose-500" };
const RING_RADIUS = 4.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/**
 * bb wraps provider artwork in a `min-w-max` span, and the artwork's SVG is `size-full` with no width or
 * height, so Safari sizes it at the 300px SVG default and every card overflows its column by ~270px.
 * A definite size on the SVG itself (`.x > svg` outranks its `.size-full`) keeps the icon 14px everywhere.
 */
const PROVIDER_ICON = "size-3.5 shrink-0 [&>svg]:size-3.5";

/** Built once per currency: every card formats its cost on each render. */
const currencyFormats = new Map<string, Intl.NumberFormat>();

function formatCost({ amount, currency }: { amount: number; currency: string }): string {
  const tiny = amount > 0 && amount < 0.01;
  const value = tiny ? 0.01 : amount;
  let text: string;
  try {
    let formatter = currencyFormats.get(currency);
    if (!formatter) {
      formatter = new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
      currencyFormats.set(currency, formatter);
    }
    text = formatter.format(value);
  } catch {
    text = `${value.toFixed(2)} ${currency}`;
  }
  return tiny ? `<${text}` : text;
}

const TOKENS = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** What the footer and the card tooltip say about a session. */
function sessionFacts(session: BoardSession | null) {
  // Part of the spend is priced from other replies' rates when a harness saved replies without a price.
  const estimate = session?.cost && session.costEstimated > 0 ? formatCost({ amount: session.costEstimated, currency: session.cost.currency }) : null;
  const cost = session?.cost ? `${estimate ? "~" : ""}${formatCost(session.cost)}` : null;
  // The cost covers the thread's descendant threads too; say so when more than one spent.
  const spent = session?.cost
    ? `${cost} spent${session.costThreads > 1 ? ` across ${session.costThreads} threads` : ""}${estimate ? ` (${estimate} estimated)` : ""}`
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

/** Harness icon, session cost and context-window fill for a card's footer; the card's tooltip has the details. */
export function HarnessMeta({ provider, session }: { provider: AgentProvider | null; session: BoardSession | null }) {
  const { cost, spent, fill, percent, tone } = sessionFacts(session);
  if (!provider && cost === null && percent === null) return null;
  return (
    <span
      role="img"
      aria-label={[provider?.displayName, spent, percent && `${percent} of context used`].filter(Boolean).join(", ")}
      className="inline-flex h-5 shrink-0 items-center gap-2 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground/80"
    >
      {cost !== null ? <span>{cost}</span> : null}
      {fill !== null ? (
        <span className={`inline-flex items-center gap-0.5 ${tone?.ring ?? ""}`}>
          <svg viewBox="0 0 12 12" className="size-3 -rotate-90" aria-hidden>
            <circle cx="6" cy="6" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
            <circle
              cx="6"
              cy="6"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={`${RING_CIRCUMFERENCE * Math.min(fill, 1)} ${RING_CIRCUMFERENCE}`}
            />
          </svg>
          {percent}
        </span>
      ) : null}
      {provider ? <ProviderIcon providerKind="agent" provider={provider} className={PROVIDER_ICON} aria-hidden /> : null}
    </span>
  );
}

/**
 * A card's hover tooltip with its harness session: harness, model and thinking level; tokens and cost; access,
 * tier and model id. It lives in the top layer, so the column's overflow can't clip it, and sits beside the
 * card (right, else left, else above or below), never over it. Rendered only while open.
 */
export function CardTooltip({ id, anchor, provider, session }: {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  provider: AgentProvider | null;
  session: BoardSession | null;
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
      className="pointer-events-none w-max max-w-80 overflow-hidden rounded-md border border-border bg-popover px-2 pb-1.5 pt-1 text-[11px] leading-4 text-popover-foreground shadow-lg"
    >
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
      {details ? <div className="truncate text-[10px] text-muted-foreground">{details}</div> : null}
      {/* Context fill as a hairline along the bottom edge: no extra line of text. */}
      {fill !== null ? (
        <span className={`absolute bottom-0 left-0 h-[2px] ${tone?.bar ?? "bg-muted-foreground/50"}`} style={{ width: `${Math.min(fill, 1) * 100}%` }} aria-hidden />
      ) : null}
    </div>
  );
}
