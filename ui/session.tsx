import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, experimental_ProviderIcon as ProviderIcon, type PluginProvidersState } from "@get-bb/plugin-sdk/app";
import type { BoardSession } from "./model";

/** An agent provider from bb's roster (`experimental_useProviders`), the same record the sidebar draws. */
export type AgentProvider = PluginProvidersState["providers"][number];

const OPEN_DELAY_MS = 150;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;
/** Context fill (0-1) where the ring turns amber, then red. */
const CONTEXT_WARN = 0.7;
const CONTEXT_CRITICAL = 0.9;
const WARN_TONE = { ring: "text-amber-500", bar: "bg-amber-500" };
const CRITICAL_TONE = { ring: "text-rose-500", bar: "bg-rose-500" };
const RING_RADIUS = 4.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatCost({ amount, currency }: { amount: number; currency: string }): string {
  const tiny = amount > 0 && amount < 0.01;
  const value = tiny ? 0.01 : amount;
  let text: string;
  try {
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    text = formatter.format(value);
  } catch {
    text = `${value.toFixed(2)} ${currency}`;
  }
  return tiny ? `<${text}` : text;
}

const TOKENS = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/**
 * Harness icon, session cost and context-window fill for a card's footer. Hovering or focusing any of
 * them opens a compact tooltip: harness, model and thinking level; tokens and cost; access, tier, model id.
 */
export function HarnessMeta({ provider, session }: { provider: AgentProvider | null; session: BoardSession | null }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // The popover lives in the top layer, so the column's overflow can't clip it; place it against the
  // trigger (above when it fits, else below), right edges aligned, clamped inside the viewport.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const anchor = triggerRef.current;
    if (!open || !popover || !anchor) return;
    popover.showPopover();
    const a = anchor.getBoundingClientRect();
    const p = popover.getBoundingClientRect();
    const above = a.top - ANCHOR_GAP - p.height;
    const top = above >= VIEWPORT_MARGIN ? above : Math.min(a.bottom + ANCHOR_GAP, window.innerHeight - VIEWPORT_MARGIN - p.height);
    const left = Math.min(a.right - p.width, window.innerWidth - VIEWPORT_MARGIN - p.width);
    popover.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
    popover.style.left = `${Math.max(VIEWPORT_MARGIN, left)}px`;
    // Scrolling the board moves the trigger out from under the fixed popover: close rather than chase it.
    // Other scrollers (a streaming thread timeline) don't contain the trigger and are ignored.
    const close = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(anchor)) setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [open]);

  // Part of the spend is priced from other replies' rates when a harness saved replies without a price.
  const estimate = session?.cost && session.costEstimated > 0 ? formatCost({ amount: session.costEstimated, currency: session.cost.currency }) : null;
  const cost = session?.cost ? `${estimate ? "~" : ""}${formatCost(session.cost)}` : null;
  // The cost covers the thread's descendant threads too; say so when more than one spent.
  const spent =
    cost === null
      ? null
      : `${cost} spent${(session?.costThreads ?? 0) > 1 ? ` across ${session?.costThreads} threads` : ""}${estimate ? ` (${estimate} estimated)` : ""}`;
  const used = session?.usedTokens ?? null;
  const capacity = session?.contextWindow ?? null;
  const fill = used !== null && capacity ? used / capacity : null;
  const percent = fill === null ? null : `${Math.round(fill * 100)}%`;
  if (!provider && cost === null && percent === null && !session?.model) return null;

  const tone = fill === null || fill < CONTEXT_WARN ? null : fill < CONTEXT_CRITICAL ? WARN_TONE : CRITICAL_TONE;
  const ringTone = tone?.ring ?? "";
  const barTone = tone?.bar ?? "bg-muted-foreground/50";
  const usage = [
    used !== null && capacity ? `${session?.estimated ? "~" : ""}${TOKENS.format(used)} / ${TOKENS.format(capacity)} tokens · ${percent}` : null,
    spent,
  ].filter(Boolean).join(" · ");
  // Short facts first so only the long model id truncates.
  const details = [
    session?.access,
    session?.serviceTier,
    session?.modelId && session.modelId !== session.model ? session.modelId : null,
  ].filter(Boolean).join(" · ");

  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-label={[provider?.displayName, spent, percent && `${percent} of context used`].filter(Boolean).join(", ")}
        aria-describedby={open ? tooltipId : undefined}
        onPointerEnter={() => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
        }}
        onPointerLeave={hide}
        onFocus={() => setOpen(true)}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === "Escape") hide();
        }}
        className="-mx-1 inline-flex h-5 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm px-1 text-[10.5px] tabular-nums text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {cost !== null ? <span>{cost}</span> : null}
        {fill !== null ? (
          <span className={`inline-flex items-center gap-0.5 ${ringTone}`}>
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
        {provider ? <ProviderIcon providerKind="agent" provider={provider} className="size-3.5" aria-hidden /> : null}
      </span>
      {open ? (
        <div
          ref={popoverRef}
          id={tooltipId}
          role="tooltip"
          popover="manual"
          style={{ inset: "auto", margin: 0 }}
          className="pointer-events-none w-max max-w-80 overflow-hidden rounded-md border border-border bg-popover px-2 pb-1.5 pt-1 text-[11px] leading-4 text-popover-foreground shadow-lg"
        >
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            {provider ? (
              <>
                <ProviderIcon providerKind="agent" provider={provider} className="size-3.5 shrink-0" aria-hidden />
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
          <div className="whitespace-nowrap tabular-nums">{usage || <span className="text-muted-foreground">No session details yet</span>}</div>
          {details ? <div className="truncate text-[10px] text-muted-foreground">{details}</div> : null}
          {/* Context fill as a hairline along the bottom edge: no extra line of text. */}
          {fill !== null ? (
            <span className={`absolute bottom-0 left-0 h-[2px] ${barTone}`} style={{ width: `${Math.min(fill, 1) * 100}%` }} aria-hidden />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
