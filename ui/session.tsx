import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { experimental_ProviderIcon as ProviderIcon, type PluginProvidersState } from "@get-bb/plugin-sdk/app";
import type { BoardSession } from "./model";

/** An agent provider from bb's roster (`experimental_useProviders`), the same record the sidebar draws. */
export type AgentProvider = PluginProvidersState["providers"][number];

const OPEN_DELAY_MS = 150;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;
/** Context fill (0-1) where the ring turns amber, then red. */
const CONTEXT_WARN = 0.7;
const CONTEXT_CRITICAL = 0.9;
const RING_RADIUS = 4.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatCost({ amount, currency }: { amount: number; currency: string }): string {
  let format: (value: number) => string;
  try {
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    format = (value) => formatter.format(value);
  } catch {
    format = (value) => `${value.toFixed(2)} ${currency}`;
  }
  return amount > 0 && amount < 0.01 ? `<${format(0.01)}` : format(amount);
}

/**
 * Harness icon, session cost and context-window fill for a card's footer. Hovering or focusing the
 * group opens a tooltip with the harness, model, thinking level and the exact numbers.
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

  const cost = session?.cost ? formatCost(session.cost) : null;
  const used = session?.usedTokens ?? null;
  const capacity = session?.contextWindow ?? null;
  const fill = used !== null && capacity ? used / capacity : null;
  const percent = fill === null ? null : `${Math.round(fill * 100)}%`;
  if (!provider && cost === null && percent === null && !session?.model) return null;

  const ringTone = fill === null || fill < CONTEXT_WARN ? "" : fill < CONTEXT_CRITICAL ? "text-amber-500" : "text-rose-500";
  const barTone = fill === null || fill < CONTEXT_WARN ? "bg-muted-foreground/60" : fill < CONTEXT_CRITICAL ? "bg-amber-500" : "bg-rose-500";
  const rows: Array<[string, ReactNode]> = [];
  if (session?.model) {
    rows.push([
      "Model",
      <>
        {session.model}
        {session.modelId && session.modelId !== session.model ? (
          <span className="block break-words font-mono text-[10px] leading-[14px] text-muted-foreground">{session.modelId}</span>
        ) : null}
      </>,
    ]);
  }
  if (session?.reasoning) rows.push(["Thinking", session.reasoning]);
  if (session?.serviceTier) rows.push(["Tier", session.serviceTier]);
  if (session?.access) rows.push(["Access", session.access]);
  if (fill !== null && used !== null && capacity) {
    rows.push([
      "Context",
      <>
        {`${session?.estimated ? "~" : ""}${used.toLocaleString()} / ${capacity.toLocaleString()} tokens (${percent})`}
        <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className={`block h-full rounded-full ${barTone}`} style={{ width: `${Math.min(fill, 1) * 100}%` }} />
        </span>
      </>,
    ]);
  }
  if (cost !== null) rows.push(["Spent", <span className="font-medium">{cost}</span>]);

  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-label={[provider?.displayName, cost && `${cost} spent`, percent && `${percent} of context used`].filter(Boolean).join(", ")}
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
        className="inline-flex h-4 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm text-[10.5px] tabular-nums text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
          className="pointer-events-none w-max min-w-44 max-w-72 overflow-hidden rounded-lg border border-border bg-popover px-2.5 py-2 text-[11px] leading-4 text-popover-foreground shadow-lg"
        >
          {provider ? (
            <div className="-mx-2.5 mb-1.5 flex items-center gap-1.5 border-b border-border/60 px-2.5 pb-1.5 font-semibold">
              <ProviderIcon providerKind="agent" provider={provider} className="size-3.5" aria-hidden />
              {provider.displayName}
            </div>
          ) : null}
          {rows.length > 0 ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 tabular-nums text-popover-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-muted-foreground">No session details yet</p>
          )}
        </div>
      ) : null}
    </>
  );
}
