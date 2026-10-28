import { useEffect, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { experimental_Icon as Icon, useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { PLUGIN_SLUG } from "../brand";
import { formatShortAge, type ReviewCard, type ReviewScope } from "./model";
import type { ReviewVerdict, ReviewsApi } from "./hooks";

// Review queue at the top of the Queue column: a two-line card per pull request waiting on the user, toggled
// between requests of the user by name (Me, where the board always opens) and of their teams (Team). The title
// opens a new-thread draft asking for what changed, why, and how risky it is; the second line opens the pull
// request (marking it read), approves after a confirming second click, or requests changes with a reason.

const SHOWN_MAX = 8;
const CONFIRM_MS = 3_000;
const COLLAPSED_KEY = `${PLUGIN_SLUG}:reviews-collapsed`;
const FORGE_NAME = { delta: "Delta", github: "GitHub" } as const;
const SCOPE = {
  me: { label: "Me", hint: "Requested of you by name", empty: "Nothing requested of you." },
  team: { label: "Team", hint: "Requested of your teams", empty: "Nothing requested of your teams." },
} as const;
const RISK_CHIP = {
  low: { label: "Low", tone: "bg-emerald-500/15 text-emerald-500" },
  medium: { label: "Med", tone: "bg-amber-500/15 text-amber-500" },
  high: { label: "High", tone: "bg-rose-500/15 text-rose-500" },
} as const;
// Same 16px mark frame as thread cards, so both kinds of card line up in the column.
const MARK_FRAME = "mt-px inline-flex size-4 shrink-0 items-center justify-center";
const ACTION =
  "inline-flex h-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50";

function Spinner() {
  return <span aria-hidden className="inline-flex size-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/25 border-t-muted-foreground" />;
}

function RiskChip({ review }: { review: ReviewCard }) {
  if (review.risk) {
    const chip = RISK_CHIP[review.risk];
    return (
      <span className={`inline-flex h-4 shrink-0 items-center rounded-[4px] px-1 text-[9px] font-semibold uppercase leading-none tracking-[0.06em] ${chip.tone}`}>
        {chip.label}
      </span>
    );
  }
  if (review.summarizing) return <span aria-label="Reading the pull request" className="inline-flex h-4 w-7 shrink-0 animate-pulse rounded-[4px] bg-muted" />;
  return null;
}

type RowActions = {
  onDraft: (review: ReviewCard) => Promise<void>;
  onOpen: (review: ReviewCard) => Promise<void>;
  onArchive: (review: ReviewCard) => Promise<void>;
  onSubmit: (review: ReviewCard, verdict: ReviewVerdict, body: string) => Promise<void>;
};

function ReviewRow({ review, now, unread, actions }: { review: ReviewCard; now: number; unread: boolean; actions: RowActions }) {
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<ReviewVerdict | null>(null);
  // Shown on the card itself: the board's own error banner clears on its next read, a second later.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const attempt = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const submit = async (verdict: ReviewVerdict, body: string) => {
    if (pending) return;
    setConfirming(false);
    setPending(verdict);
    await attempt(() => actions.onSubmit(review, verdict, body));
    setPending(null);
  };

  const sendReason = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason.trim()) void submit("request_changes", reason.trim());
  };

  const reasonKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setDeclining(false);
  };

  const forge = FORGE_NAME[review.forge];
  const updated = Date.parse(review.updatedAt);
  const size =
    review.additions !== null && review.deletions !== null
      ? `+${review.additions} −${review.deletions}${review.changedFiles !== null ? ` in ${review.changedFiles} files` : ""}`
      : null;
  const titleHint = [
    review.summary ? `${review.risk ? `[${review.risk}] ` : ""}${review.summary}` : null,
    "Open a draft thread that explains this pull request.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const metaHint = [
    `${review.repo}#${review.number} by ${review.author}${review.bot ? " (bot)" : ""}`,
    size,
    review.draft ? "draft" : null,
    review.rereview ? "new commits since your review" : null,
    Number.isFinite(updated) ? `updated ${new Date(updated).toLocaleString()}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      className={`group relative rounded-lg border bg-card px-2.5 pb-1 pt-1.5 shadow-xs transition-[border-color,box-shadow] duration-150 hover:shadow-sm ${
        unread ? "border-sky-500/30 hover:border-sky-500/50" : "border-border/60 hover:border-border"
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={MARK_FRAME} aria-label={unread ? "Pull request, new" : "Pull request"} title={unread ? "New since you last opened it" : "Pull request"}>
          <Icon name="GitPullRequest" className={`size-3.5 ${unread ? "text-sky-500" : "text-muted-foreground/50"}`} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => void attempt(() => actions.onDraft(review))}
            title={titleHint}
            className={`flex h-[18px] w-full min-w-0 items-center gap-1.5 rounded-sm text-left text-[13px] leading-[18px] text-foreground decoration-muted-foreground/40 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
              unread ? "font-semibold" : "font-medium"
            }`}
          >
            <RiskChip review={review} />
            <span className="min-w-0 truncate">{review.title}</span>
          </button>
          <div className="mt-0.5 flex h-5 items-center gap-0.5">
            <span className="mr-1 min-w-0 flex-1 truncate text-[10.5px] tabular-nums text-muted-foreground/70" title={metaHint}>
              {Number.isFinite(updated) ? `${formatShortAge(updated, now)} · ` : ""}
              {review.rereview ? <span className="font-medium text-sky-500">re-review · </span> : null}
              {review.author} · {review.repo.split("/").pop()}#{review.number}
              {review.draft ? " · draft" : ""}
            </span>
            <button
              type="button"
              onClick={() => void attempt(() => actions.onOpen(review))}
              title={`Open in ${forge}`}
              className={`${ACTION} gap-0.5 px-1 text-[10.5px] font-medium hover:bg-accent hover:text-foreground`}
            >
              {forge}
              <Icon name="ExternalLink" className="size-3" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={confirming ? "Confirm approval" : "Approve"}
              title={confirming ? "Click again to approve" : "Approve"}
              disabled={pending !== null}
              onClick={() => (confirming ? void submit("approve", "") : setConfirming(true))}
              className={
                confirming
                  ? `${ACTION} bg-emerald-500 px-1.5 text-[10px] font-semibold text-white hover:bg-emerald-600`
                  : `${ACTION} w-5 hover:bg-emerald-500/10 hover:text-emerald-500`
              }
            >
              {pending === "approve" ? <Spinner /> : confirming ? "Approve?" : <Icon name="Check" className="size-3.5" aria-hidden />}
            </button>
            <button
              type="button"
              aria-label="Request changes"
              aria-expanded={declining}
              title="Request changes"
              disabled={pending !== null}
              onClick={() => setDeclining((open) => !open)}
              className={`${ACTION} w-5 hover:bg-rose-500/10 hover:text-rose-500 ${declining ? "bg-rose-500/10 text-rose-500" : ""}`}
            >
              <Icon name="X" className="size-3.5" aria-hidden />
            </button>
          </div>
          {declining ? (
            <form onSubmit={sendReason} className="mb-0.5 mt-1 flex items-center gap-1">
              <input
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                onKeyDown={reasonKeyDown}
                placeholder="What needs to change?"
                aria-label="What needs to change"
                disabled={pending !== null}
                className="h-6 min-w-0 flex-1 rounded-md border border-border/70 bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-rose-500/60 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={pending !== null || !reason.trim()}
                title="Request changes with this reason"
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-rose-500 px-2 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending === "request_changes" ? <Spinner /> : null}
                Send
              </button>
            </form>
          ) : null}
          {error ? (
            <p role="alert" className="mb-0.5 line-clamp-2 text-[10.5px] leading-[14px] text-rose-500" title={error}>
              {error}
            </p>
          ) : null}
        </div>
      </div>

      {/* Archive: same hover overlay as thread cards, over the end of the title line. */}
      <span className="absolute right-1.5 top-[5px] flex bg-card opacity-0 transition-opacity duration-150 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-l before:from-card before:to-transparent before:content-[''] group-hover:opacity-100 group-focus-within:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100">
        <button
          type="button"
          title="Archive: hide this pull request from the queue"
          aria-label="Archive pull request"
          className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color] duration-150 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={() => void attempt(() => actions.onArchive(review))}
        >
          <Icon name="Archive" className="size-3.5" aria-hidden />
        </button>
      </span>
    </article>
  );
}

function ScopeToggle({ scopes, active, counts, unread, onSelect }: {
  scopes: readonly ReviewScope[];
  active: ReviewScope;
  counts: Record<ReviewScope, number>;
  unread: Record<ReviewScope, number>;
  onSelect: (scope: ReviewScope) => void;
}) {
  return (
    <div role="group" aria-label="Whose review requests" className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted/70 p-px">
      {scopes.map((scope) => {
        const selected = scope === active;
        const fresh = !selected && unread[scope] > 0;
        return (
          <button
            key={scope}
            type="button"
            aria-pressed={selected}
            title={`${SCOPE[scope].hint}${unread[scope] > 0 ? ` · ${unread[scope]} new` : ""}`}
            onClick={() => onSelect(scope)}
            className={`relative inline-flex h-4 items-center gap-1 rounded-[5px] px-1.5 text-[10px] font-medium leading-none transition-[color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
              selected ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {SCOPE[scope].label}
            <span className={`tabular-nums ${selected ? "text-muted-foreground" : fresh ? "text-sky-500" : "opacity-70"}`}>{counts[scope]}</span>
          </button>
        );
      })}
    </div>
  );
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function ReviewSection({ reviews, now }: { reviews: ReviewsApi; now: number }) {
  const navigate = useBbNavigate();
  const context = useBbContext();
  const { state } = reviews;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [showAll, setShowAll] = useState(false);
  // Not stored: the board opens on Me every time it is shown.
  const [chosenScope, setChosenScope] = useState<ReviewScope>("me");
  // Archived, reviewed or opened here: applied at once, before the server's next list round-trips.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [readLocally, setReadLocally] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    // Drop local overrides once the server agrees, so a new push can mark the card unread again.
    if (!state) return;
    const listed = new Map(state.reviews.map((review) => [review.id, review]));
    setHidden((current) => {
      const next = new Set([...current].filter((id) => listed.has(id)));
      return next.size === current.size ? current : next;
    });
    setReadLocally((current) => {
      const next = new Set([...current].filter((id) => listed.get(id)?.unread));
      return next.size === current.size ? current : next;
    });
  }, [state]);

  const listed = useMemo(() => (state?.reviews ?? []).filter((review) => !hidden.has(review.id)), [state, hidden]);
  if (!state || state.scopes.length === 0) return null;

  const problems = [
    reviews.error,
    state.error,
    ...state.sources.flatMap((source) => (source.error && !source.missing ? [`${source.search}: ${source.error}`] : [])),
  ].filter((problem): problem is string => Boolean(problem));
  const loading = state.refreshedAt === null;
  if (listed.length === 0 && problems.length === 0 && !loading) return null;

  // A scope whose searches were all removed falls back to the one left.
  const scope = state.scopes.includes(chosenScope) ? chosenScope : state.scopes[0];
  const isNew = (review: ReviewCard) => review.unread && !readLocally.has(review.id);
  const counts: Record<ReviewScope, number> = { me: 0, team: 0 };
  const unread: Record<ReviewScope, number> = { me: 0, team: 0 };
  for (const review of listed) {
    counts[review.scope] += 1;
    if (isNew(review)) unread[review.scope] += 1;
  }
  const scoped = listed.filter((review) => review.scope === scope);
  const newCount = unread[scope];
  const shown = showAll ? scoped : scoped.slice(0, SHOWN_MAX);

  const markRead = (id: string) => setReadLocally((current) => (current.has(id) ? current : new Set([...current, id])));
  const setHiddenId = (id: string, hide: boolean) =>
    setHidden((current) => {
      const next = new Set(current);
      if (hide) next.add(id);
      else next.delete(id);
      return next;
    });

  const actions: RowActions = {
    onDraft: async (review) => {
      markRead(review.id);
      const initialPrompt = await reviews.draft(review.id);
      navigate?.toCompose?.({ ...(context?.projectId ? { projectId: context.projectId } : {}), initialPrompt, focusPrompt: true });
    },
    onOpen: async (review) => {
      markRead(review.id);
      if (!navigate?.openUrl?.(review.url)) window.open(review.url, "_blank", "noopener,noreferrer");
      await reviews.markRead(review.id);
    },
    onArchive: async (review) => {
      setHiddenId(review.id, true);
      try {
        await reviews.archive(review.id);
      } catch (cause) {
        setHiddenId(review.id, false);
        throw cause;
      }
    },
    onSubmit: async (review, verdict, body) => {
      await reviews.submit(review.id, verdict, body);
      setHiddenId(review.id, true);
    },
  };

  const setCollapsedStored = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage off: the section still toggles for this session.
    }
  };

  const selectScope = (next: ReviewScope) => {
    setChosenScope(next);
    setShowAll(false);
    if (collapsed) setCollapsedStored(false);
  };

  return (
    <div className="space-y-1.5 border-b border-border/40 pb-2">
      <div className="flex h-5 items-center gap-1.5 px-0.5">
        <button
          type="button"
          onClick={() => setCollapsedStored(!collapsed)}
          aria-expanded={!collapsed}
          className="flex min-w-0 items-center gap-1 rounded-sm text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3" aria-hidden />
          Reviews
          {state.scopes.length === 1 ? (
            <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold normal-case leading-none tracking-normal tabular-nums">
              {scoped.length}
            </span>
          ) : null}
        </button>
        {state.scopes.length > 1 ? <ScopeToggle scopes={state.scopes} active={scope} counts={counts} unread={unread} onSelect={selectScope} /> : null}
        {newCount > 0 ? <span className="text-[10px] font-medium text-sky-500">{newCount} new</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {state.refreshing ? <Spinner /> : null}
          {problems.length > 0 ? (
            <span role="img" aria-label={`Review queue problems: ${problems.join("; ")}`} title={problems.join("\n")} className="inline-flex text-amber-500">
              <Icon name="AlertCircle" className="size-3.5" aria-hidden />
            </span>
          ) : null}
        </span>
      </div>
      {collapsed ? null : (
        <>
          {scoped.length === 0 ? (
            <p className="px-1 text-[11px] text-muted-foreground/60">{loading ? "Reading pull requests…" : SCOPE[scope].empty}</p>
          ) : null}
          {shown.map((review) => (
            <ReviewRow key={review.id} review={review} now={now} unread={isNew(review)} actions={actions} />
          ))}
          {scoped.length > SHOWN_MAX ? (
            <button
              type="button"
              onClick={() => setShowAll((all) => !all)}
              className="w-full rounded-md py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {showAll ? "Show fewer" : `Show ${scoped.length - SHOWN_MAX} more`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
