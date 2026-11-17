import { ACCENT_TEXT, formatMoney, type BoardSession } from "./model";
import { TYPE } from "./primitives";

/** Context fill (0-1) where the pie turns amber, then red. */
const CONTEXT_WARN = 0.7;
const CONTEXT_CRITICAL = 0.9;
// The pie is drawn in currentColor, so its wedge and disc share the accent.
const WARN_TONE = ACCENT_TEXT.amber;
const CRITICAL_TONE = ACCENT_TEXT.rose;
/** The pie's outer radius in its 12-unit box. Its wedge is a circle at half this radius stroked the full radius wide. */
const PIE_RADIUS = 5.5;
const WEDGE_CIRCUMFERENCE = Math.PI * PIE_RADIUS;

/** What the card's cost and context pie say about a session. */
function sessionFacts(session: BoardSession | null) {
  const currency = session?.cost?.currency;
  // Part of the spend is priced from other replies' rates when a harness saved replies without a price.
  const estimated = session?.cost && session.costEstimated > 0;
  // The footer's figure is compact; its accessible label is exact.
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
  return { cost, spent, fill, percent, tone };
}

/** The session's cost for a card's footer or one-line row. */
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

/**
 * Context-window fill as a pie: a solid wedge over a faint disc. Dim grey under the status mark until it
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
      className={`size-3 -rotate-90 ${tone ?? "text-muted-foreground/45"}`}
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
