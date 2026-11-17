import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon, experimental_NewThreadComposer as NewThreadComposer, useBbNavigate, type NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { PLUGIN_SLUG } from "../brand";
import { useNow, type RadarApi } from "./hooks";
import { ACCENT_TEXT, CARD_EDGE, CARD_SURFACE, CLOCK_TICK_MS, errorMessage, formatShortAge } from "./model";
import { Age, EMPTY_NOTE, GroupHeader, MARK_FRAME, ROW_ACTION, ROW_ICON_ACTION, Spinner, TWO_LINE_META, TWO_LINE_META_ROW, TWO_LINE_PAD, TYPE, useRowError } from "./primitives";
import type { RadarItem } from "../server/radar-schema";

type RadarDraft = { item: RadarItem; prompt: string | null; error: string | null };

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]';

function isRead(item: RadarItem): boolean {
  return item.read || item.threadId !== null;
}

function OpportunityRow({ item, now, onDraft, onDismiss, onThread }: {
  item: RadarItem;
  now: number;
  onDraft: (item: RadarItem) => void;
  onDismiss: (id: string) => Promise<void>;
  onThread: (threadId: string) => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const { attempt, view: error } = useRowError();
  const read = isRead(item);
  const created = Date.parse(item.createdAt);
  const titleClass = `block w-full min-w-0 truncate rounded-sm text-left ${TYPE.title} leading-[18px] ${read ? "font-medium text-muted-foreground" : "font-semibold text-foreground"}`;
  const open = () => {
    if (item.threadId) onThread(item.threadId);
    else if (!read) onDraft(item);
  };
  const dismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    await attempt(() => onDismiss(item.id));
    setDismissing(false);
  };

  return (
    <article className={`group relative ${CARD_SURFACE} ${TWO_LINE_PAD} ${read ? CARD_EDGE : "border-border/80 hover:border-sky-500/40 focus-within:border-sky-500/50"}`}>
      <div className="flex items-start gap-2">
        <span className={MARK_FRAME} aria-label={read ? "Read opportunity" : "Unread opportunity"}>
          <Icon name="Zap" className={`size-3.5 fill-current ${read ? "text-muted-foreground/50" : ACCENT_TEXT.sky}`} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {read && !item.threadId ? (
            <p className={titleClass}>{item.title}</p>
          ) : (
            <button
              type="button"
              aria-haspopup={read ? undefined : "dialog"}
              onClick={open}
              className={`${titleClass} decoration-muted-foreground/40 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60`}
            >
              {item.title}
            </button>
          )}
          {item.summary ? <p className={`mt-0.5 line-clamp-2 ${TYPE.body} leading-[16px] text-muted-foreground/80`}>{item.summary}</p> : null}
          <div className={TWO_LINE_META_ROW}>
            <span className={TWO_LINE_META}>
              {Number.isFinite(created) ? <><Age at={created} now={now} className="" /> · </> : null}
              {read ? item.threadId ? "Thread created" : "Read" : "Ready to explore"}
            </span>
            {!read || item.threadId ? (
              <button type="button" onClick={open} className={`${ROW_ACTION} gap-1 px-1.5 ${TYPE.meta} hover:bg-accent hover:text-foreground`}>
                {read ? "Open thread" : "Explore"}
                <Icon name={read ? "ArrowUpRight" : "ArrowRight"} className="size-3" aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss opportunity"
              disabled={dismissing}
              onClick={() => void dismiss()}
              className={`${ROW_ICON_ACTION} opacity-50 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100`}
            >
              {dismissing ? <Spinner /> : <Icon name="Archive" className="size-3.5" aria-hidden />}
            </button>
          </div>
          {error}
        </div>
      </div>
    </article>
  );
}

function TechniqueRow({ item, now, onOpen }: { item: RadarItem; now: number; onOpen: (item: RadarItem) => Promise<void> }) {
  const [opening, setOpening] = useState(false);
  const { attempt, view: error } = useRowError();
  const created = Date.parse(item.createdAt);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    await attempt(() => onOpen(item));
    setOpening(false);
  };

  return (
    <article className={`group ${CARD_SURFACE} px-2 py-2 ${CARD_EDGE} hover:border-sky-500/30 focus-within:border-sky-500/50`}>
      <div className="flex items-start gap-2">
        <span className={MARK_FRAME} aria-label="Unread technique">
          <svg viewBox="0 0 24 24" className={`size-3.5 ${ACCENT_TEXT.sky}`} aria-hidden="true">
            <path fill="currentColor" d="M12 2a7 7 0 0 0-4.9 12c.9.9 1.4 1.6 1.6 3h6.6c.2-1.4.7-2.1 1.6-3A7 7 0 0 0 12 2Z" />
            <path d="M9 19h6m-5 3h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            disabled={opening}
            onClick={() => void open()}
            className={`flex w-full min-w-0 items-start gap-2 rounded-sm text-left ${TYPE.title} font-medium leading-[18px] text-foreground/90 decoration-muted-foreground/40 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-60`}
          >
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {Number.isFinite(created) ? <Age at={created} now={now} className={`shrink-0 ${TYPE.meta} font-normal tabular-nums text-muted-foreground/60`} /> : null}
            <span className="mt-0.5 inline-flex shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground">{opening ? <Spinner /> : <Icon name="ExternalLink" className="size-3" aria-hidden />}</span>
          </button>
          {error}
        </div>
      </div>
    </article>
  );
}

/** A body portal avoids the board overlay's backdrop-filter containing block and narrow, clipped columns. */
function OpportunityModal({ draft, onRetry, onSubmit, onClose, onQueued }: {
  draft: RadarDraft;
  onRetry: () => void;
  onSubmit: (request: NewThreadRequest) => Promise<unknown>;
  onClose: () => void;
  onQueued: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [previousFocus] = useState(() => document.activeElement);
  const [focusRequest] = useState(Date.now);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!panelRef.current?.contains(document.activeElement)) closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [previousFocus]);

  const close = () => {
    if (!inFlight.current) onClose();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    // Composer menus portal outside the dialog. Let their own focus and Escape handlers run first.
    if (!panel || !(event.target instanceof Node) || !panel.contains(event.target) || panel.querySelector('[aria-expanded="true"]')) return;
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.matches(":disabled") && (element.tabIndex >= 0 || element.isContentEditable) && element.getClientRects().length > 0,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  const submit = (request: NewThreadRequest): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    setSubmitting(true);
    setSubmitError(null);
    const pending = (async () => {
      try {
        // Forward the exact request: all picker choices, provenance, attachments and scheduling belong to BB.
        await onSubmit(request);
      } catch (cause) {
        setSubmitError(errorMessage(cause));
        throw cause; // The host composer keeps the draft when submission fails.
      }
      onClose();
      onQueued();
    })().finally(() => {
      inFlight.current = null;
      setSubmitting(false);
    });
    inFlight.current = pending;
    return pending;
  };

  return createPortal(
    <div
      data-bb-plugin={PLUGIN_SLUG}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 max-sm:p-2"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDownCapture={handleKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={submitting}
        tabIndex={-1}
        className="relative flex h-[min(52rem,calc(100dvh-2rem))] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-[0_24px_80px_-16px_rgba(0,0,0,0.5)] outline-none max-sm:h-[calc(100dvh-1rem)]"
      >
        <header className="relative shrink-0 border-b border-border px-5 py-4 pr-14 max-sm:px-3 max-sm:pr-12">
          <h2 id={titleId} className={`${TYPE.title} font-semibold leading-snug`}>{draft.item.title}</h2>
          <p id={descriptionId} className={`mt-1 ${TYPE.body} leading-snug text-muted-foreground`}>Review the full findings and choose your settings. Nothing runs until you submit.</p>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            disabled={submitting}
            aria-label="Close opportunity"
            className="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-9"
          >
            <Icon name="X" className="size-4" aria-hidden />
          </button>
        </header>
        {submitError ? <p role="alert" className={`shrink-0 border-b border-destructive/25 bg-destructive/10 px-5 py-2 ${TYPE.body} text-destructive`}>{submitError}</p> : null}
        <div className="min-h-0 flex-1 p-3 sm:p-5">
          {draft.error ? (
            <div role="alert" className={`flex h-full flex-col items-center justify-center gap-3 text-center ${TYPE.body}`}>
              <p className="max-w-lg text-destructive">{draft.error}</p>
              <button type="button" onClick={onRetry} className={`${ROW_ACTION} gap-1.5 px-2 hover:bg-accent hover:text-foreground`}>
                <Icon name="RefreshCw" className="size-3.5" aria-hidden />
                Load findings again
              </button>
            </div>
          ) : draft.prompt === null ? (
            <div role="status" className={`flex h-full items-center justify-center gap-2 ${TYPE.body} text-muted-foreground`}><Spinner /> Loading all findings…</div>
          ) : (
            <NewThreadComposer
              key={draft.item.id}
              layout="contained"
              className="h-full min-h-0"
              initialPrompt={draft.prompt}
              draftKey={`${PLUGIN_SLUG}:radar-opportunity:${draft.item.id}`}
              focusRequest={focusRequest}
              onSubmit={submit}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function RadarPanel({ api, onQueued }: { api: RadarApi; onQueued: () => void }) {
  const navigate = useBbNavigate();
  const now = useNow(CLOCK_TICK_MS);
  const [draft, setDraft] = useState<RadarDraft | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const { state } = api;
  const [refreshing, setRefreshing] = useState(false);
  const { attempt: attemptRefresh, view: refreshError } = useRowError();
  const refresh = async () => {
    if (refreshing || state?.running) return;
    setRefreshing(true);
    await attemptRefresh(api.refresh);
    setRefreshing(false);
  };

  useEffect(() => {
    if (!state) return;
    const listed = new Set(state.items.map((item) => item.id));
    setHidden((current) => {
      const next = new Set([...current].filter((id) => listed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [state]);

  const hide = (id: string) => {
    setHidden((current) => new Set([...current, id]));
    api.refetch();
  };
  const loadDraft = async (item: RadarItem) => {
    const next: RadarDraft = { item, prompt: null, error: null };
    setDraft(next);
    // A late read must not reopen a cancelled modal or replace a different opportunity's draft.
    try {
      const { prompt } = await api.draft(item.id);
      setDraft((current) => current === next ? { ...next, prompt } : current);
    } catch (cause) {
      setDraft((current) => current === next ? { ...next, error: errorMessage(cause) } : current);
    }
  };
  const dismiss = async (id: string) => {
    await api.dismiss(id);
    hide(id);
  };
  const openTechnique = async (item: RadarItem) => {
    if (!navigate.openUrl(item.sourceUrl)) throw new Error("BB could not open this Slack link. The technique is still unread.");
    await api.openTechnique(item.id);
    hide(item.id);
  };
  const items = state?.items.filter((item) => !hidden.has(item.id)) ?? [];
  const unread = items.filter((item) => !isRead(item));
  const read = items.filter((item) => isRead(item));
  const problems = [api.error, state?.error !== api.error ? state?.error : null].filter((message): message is string => Boolean(message));
  const generated = state?.generatedAt ? Date.parse(state.generatedAt) : NaN;
  const generatedAge = Number.isFinite(generated) ? formatShortAge(generated, now) : null;

  const scanning = refreshing || state?.running;
  return (
    <div className="space-y-2.5">
      <div className={`flex min-h-8 items-center gap-2 border-b border-border/50 px-[9px] pb-2 ${TYPE.meta}`}>
        <span role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground/50">
          {scanning ? <><Spinner /><span className="truncate">Looking for new ideas…</span></> : Number.isFinite(generated) ? (
            <time dateTime={state?.generatedAt ?? undefined} title={new Date(generated).toLocaleString()} className="truncate">Updated {generatedAge === "now" ? "just now" : `${generatedAge} ago`}</time>
          ) : <span className="truncate">{state ? "Ready for your first scan" : api.error ? "Radar unavailable" : "Loading Radar…"}</span>}
        </span>
        <button type="button" aria-label="Refresh Radar" title="Scan for new recommendations" disabled={scanning} onClick={() => void refresh()} className={`${ROW_ACTION} gap-1.5 border border-border/70 bg-background/40 px-2 hover:border-border hover:bg-accent hover:text-foreground disabled:opacity-50`}>
          <Icon name="RefreshCw" className={`size-3 ${scanning ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
      </div>
      {refreshError}
      {problems.map((problem) => <details key={problem} className={`rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 ${TYPE.meta} text-muted-foreground`}>
        <summary className="cursor-pointer font-medium text-foreground/80">Radar couldn't update · show details</summary>
        <p role="alert" className="mt-1.5 whitespace-pre-wrap break-words leading-relaxed">{problem}</p>
      </details>)}
      {state ? (
        <>
          <section aria-label="Ranked recommendations" className="space-y-1">
            <GroupHeader title="Recommendations" count={unread.length} />
            {unread.length === 0 ? <p className={`px-[9px] py-2 ${TYPE.meta} text-muted-foreground/60`}>No new recommendations. Refresh to look again.</p> : unread.map((item) => item.kind === "opportunity" ? (
              <OpportunityRow key={item.id} item={item} now={now} onDraft={loadDraft} onDismiss={dismiss} onThread={(threadId) => navigate.toThread(threadId)} />
            ) : <TechniqueRow key={item.id} item={item} now={now} onOpen={openTechnique} />)}
          </section>
          {read.length > 0 ? (
            <details aria-label="Read opportunities" className="border-t border-border/50 pt-2">
              <summary className={`cursor-pointer px-[9px] py-1 ${TYPE.label} text-muted-foreground/60 transition-colors hover:text-muted-foreground`}>Read · {read.length}</summary>
              {read.map((item) => (
                <OpportunityRow key={item.id} item={item} now={now} onDraft={loadDraft} onDismiss={dismiss} onThread={(threadId) => navigate.toThread(threadId)} />
              ))}
            </details>
          ) : null}
        </>
      ) : problems.length === 0 ? <p className={EMPTY_NOTE}>Reading Radar…</p> : null}
      {draft ? (
        <OpportunityModal
          key={draft.item.id}
          draft={draft}
          onRetry={() => loadDraft(draft.item)}
          onSubmit={(request) => api.submit(draft.item.id, request)}
          onClose={() => setDraft(null)}
          onQueued={() => { api.refetch(); onQueued(); }}
        />
      ) : null}
    </div>
  );
}
