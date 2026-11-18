import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon, experimental_NewThreadComposer as NewThreadComposer, useBbNavigate, type NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { PLUGIN_SLUG } from "../brand";
import { usePending, type RadarApi } from "./hooks";
import { errorMessage, formatShortAge, parseTime } from "./model";
import { Age, CappedList, GroupHeader, IconMark, Mark, RowActions, Spinner, keyForBox, useRowAction } from "./primitives";
import { ACCENT_TEXT, ALERT_BANNER, CARD_INSET, ELEVATION, EMPTY_NOTE, ONE_LINE_PAD, ROW_ACTION, TWO_LINE_META, TWO_LINE_META_ROW, TWO_LINE_PAD, TYPE, UNREAD_BADGE, cardFrame, cardTitle } from "./styles";
import type { RadarItem, RadarState } from "../server/radar-schema";

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
  const { attempt, view: error } = useRowAction();
  const read = isRead(item);
  // Read stays readable: only the mark and the weight change, as on every other card.
  const titleClass = `block w-full min-w-0 truncate rounded-sm text-left ${cardTitle(!read)} leading-[18px] ${read ? "text-foreground/85" : "text-foreground"}`;
  const open = () => {
    if (item.threadId) onThread(item.threadId);
    else if (!read) onDraft(item);
  };

  return (
    <article className={`group relative ${cardFrame()} ${TWO_LINE_PAD}`}>
      <div className="flex items-start gap-2">
        <IconMark label={read ? "Read opportunity" : "Unread opportunity"} icon="Zap" filled disc={read ? undefined : UNREAD_BADGE.sky} tone="text-muted-foreground/50" />
        <div className="min-w-0 flex-1">
          {read && !item.threadId ? (
            <p className={titleClass}>{item.title}</p>
          ) : (
            <button
              type="button"
              aria-haspopup={read ? undefined : "dialog"}
              onClick={open}
              className={`${titleClass} hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60`}
            >
              {item.title}
            </button>
          )}
          {item.summary ? <p className={`mt-0.5 line-clamp-2 ${TYPE.body} leading-4 text-muted-foreground/80`}>{item.summary}</p> : null}
          <div className={TWO_LINE_META_ROW}>
            <span className={TWO_LINE_META}>
              <Age at={item.createdAt} now={now} after=" · " />
              {read ? item.threadId ? "Thread created" : "Read" : "Ready to explore"}
            </span>
            {!read || item.threadId ? (
              <button type="button" onClick={open} className={`${ROW_ACTION} gap-1 px-1.5 ${TYPE.meta} hover:bg-accent hover:text-foreground`}>
                {read ? "Open thread" : "Explore"}
                <Icon name={read ? "ArrowUpRight" : "ArrowRight"} className="size-3" aria-hidden />
              </button>
            ) : null}
          </div>
          {error}
        </div>
      </div>
      <RowActions label="Dismiss opportunity" onArchive={() => void attempt(() => onDismiss(item.id))} />
    </article>
  );
}

function TechniqueRow({ item, now, onOpen }: { item: RadarItem; now: number; onOpen: (item: RadarItem) => Promise<void> }) {
  const { attempt, pending, view: error } = useRowAction();
  const opening = pending !== null;

  // One line, like Done and Out rows: the bulb, the title, its age, and the link out.
  return (
    <article className={`group relative ${cardFrame()} ${ONE_LINE_PAD}`}>
      <div className="flex h-5 items-center gap-2">
        <Mark label="Unread technique" disc={UNREAD_BADGE.sky}>
          <svg viewBox="0 0 24 24" className="size-2.5" aria-hidden="true">
            <path fill="currentColor" d="M12 2a7 7 0 0 0-4.9 12c.9.9 1.4 1.6 1.6 3h6.6c.2-1.4.7-2.1 1.6-3A7 7 0 0 0 12 2Z" />
            <path d="M9 19h6m-5 3h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </Mark>
        <button
          type="button"
          disabled={opening}
          onClick={() => void attempt(() => onOpen(item), "open")}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left ${cardTitle(true)} leading-[18px] text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50`}
        >
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <Age at={item.createdAt} now={now} className={`shrink-0 ${TYPE.meta} font-normal tabular-nums text-muted-foreground/80`} />
          <span className="inline-flex shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground">{opening ? <Spinner /> : <Icon name="ExternalLink" className="size-3" aria-hidden />}</span>
        </button>
      </div>
      {error}
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
    if (!panel || !keyForBox(panel, event)) return;
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 max-sm:p-2"
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
        className={`relative flex h-[min(52rem,calc(100dvh-2rem))] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground ${ELEVATION.modal} outline-none max-sm:h-[calc(100dvh-1rem)]`}
      >
        <header className="relative shrink-0 border-b border-border px-5 py-4 pr-14 max-sm:px-3 max-sm:pr-12">
          <h2 id={titleId} className={`${TYPE.title} font-semibold leading-[18px]`}>{draft.item.title}</h2>
          <p id={descriptionId} className={`mt-1 ${TYPE.body} leading-4 text-muted-foreground`}>Review the full findings and choose your settings. Nothing runs until you submit.</p>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            disabled={submitting}
            aria-label="Close opportunity"
            className="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-9"
          >
            <Icon name="X" className="size-4" aria-hidden />
          </button>
        </header>
        {submitError ? <p role="alert" className={`shrink-0 px-5 py-2 ${ALERT_BANNER} ${TYPE.body} leading-4 max-sm:px-3`}>{submitError}</p> : null}
        <div className="min-h-0 flex-1 p-3 sm:p-5">
          {draft.error ? (
            <div role="alert" className={`flex h-full flex-col items-center justify-center gap-3 text-center ${TYPE.body}`}>
              <p className={`max-w-lg ${ACCENT_TEXT.rose}`}>{draft.error}</p>
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

export function RadarPanel({ api, now, onQueued }: { api: RadarApi; now: number; onQueued: () => void }) {
  const navigate = useBbNavigate();
  const [draft, setDraft] = useState<RadarDraft | null>(null);
  const { state } = api;
  // Dismissed or opened here: hidden at once, until the server's list drops them too.
  const [hidden, changeHidden] = usePending<RadarState, true>(state, (_, id, served) => served.items.some((item) => item.id === id));
  const { attempt: attemptRefresh, pending: refreshing, view: refreshError } = useRowAction();
  const refresh = () => {
    if (!state?.running) void attemptRefresh(api.refresh, "scan");
  };

  const hide = (id: string) => {
    changeHidden(id, () => true);
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
  const generated = parseTime(state?.generatedAt ?? null);
  const generatedAge = generated !== null ? formatShortAge(generated, now) : null;

  const scanning = refreshing !== null || state?.running;
  return (
    <div className="space-y-2">
      <div className={`flex min-h-8 items-center gap-2 border-b border-border/60 ${CARD_INSET} pb-2 ${TYPE.meta}`}>
        <span role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground/80">
          {scanning ? <><Spinner /><span className="truncate">Looking for new ideas…</span></> : generated !== null ? (
            <time dateTime={state?.generatedAt ?? undefined} title={new Date(generated).toLocaleString()} className="truncate">Updated {generatedAge === "now" ? "just now" : `${generatedAge} ago`}</time>
          ) : <span className="truncate">{state ? "Ready for your first scan" : api.error ? "Radar unavailable" : "Loading Radar…"}</span>}
        </span>
        <button type="button" aria-label="Refresh Radar" title="Scan for new recommendations" disabled={scanning} onClick={refresh} className={`${ROW_ACTION} gap-1.5 border border-border px-2 hover:bg-accent hover:text-foreground`}>
          <Icon name="RefreshCw" className={`size-3 ${scanning ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
      </div>
      {refreshError}
      <section aria-label="Ranked recommendations" className="space-y-1">
        <GroupHeader title="Recommendations" count={state ? unread.length : null} countTone={UNREAD_BADGE.sky} problems={problems} />
        {!state ? (
          <p className={EMPTY_NOTE}>{problems.length > 0 ? "Couldn't read Radar." : "Reading Radar…"}</p>
        ) : unread.length === 0 ? (
          <p className={EMPTY_NOTE}>No new recommendations. Refresh to look again.</p>
        ) : unread.map((item) => item.kind === "opportunity" ? (
          <OpportunityRow key={item.id} item={item} now={now} onDraft={loadDraft} onDismiss={dismiss} onThread={(threadId) => navigate.toThread(threadId)} />
        ) : <TechniqueRow key={item.id} item={item} now={now} onOpen={openTechnique} />)}
      </section>
      {read.length > 0 ? (
        <section aria-label="Read opportunities" className="space-y-1">
          <GroupHeader title="Read" count={read.length} />
          <CappedList items={read}>
            {(item) => <OpportunityRow key={item.id} item={item} now={now} onDraft={loadDraft} onDismiss={dismiss} onThread={(threadId) => navigate.toThread(threadId)} />}
          </CappedList>
        </section>
      ) : null}
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
