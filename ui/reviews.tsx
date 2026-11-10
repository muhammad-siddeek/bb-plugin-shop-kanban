import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_BADGE, ACCENT_TEXT, CARD_EDGE, CARD_SURFACE, formatShortAge, type ReviewCard, type ReviewScope } from "./model";
import type { ReviewVerdict, ReviewsApi } from "./hooks";
import {
  EMPTY_NOTE,
  ForgeLink,
  GroupHeader,
  MARK_FRAME,
  ROW_ACTION,
  ROW_ICON_ACTION,
  RowActions,
  ShowMore,
  Spinner,
  listProblems,
  useBbLinks,
  useRowError,
} from "./primitives";

// Reviews, the first list in the Queue column's In tab: a two-line card per pull request waiting on the user,
// toggled between requests of the user by name (Me, where the board always opens) and of their teams (Team). The
// title opens a new-thread draft asking for what changed, why, and how risky it is; the second line opens the pull
// request (marking it read), approves after a confirming second click, or requests changes with a reason.

const SHOWN_MAX = 8;
const CONFIRM_MS = 3_000;
const SCOPE = {
  me: { label: "Me", hint: "Requested of you by name", empty: "Nothing requested of you." },
  team: { label: "Team", hint: "Requested of your teams", empty: "Nothing requested of your teams." },
} as const;
const RISK_CHIP = {
  low: { label: "Low", tone: ACCENT_BADGE.emerald },
  medium: { label: "Med", tone: ACCENT_BADGE.amber },
  high: { label: "High", tone: ACCENT_BADGE.rose },
} as const;

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

type ReviewActions = {
  onDraft: (review: ReviewCard) => Promise<void>;
  onOpen: (review: ReviewCard) => Promise<void>;
  onArchive: (review: ReviewCard) => Promise<void>;
  onSubmit: (review: ReviewCard, verdict: ReviewVerdict, body: string) => Promise<void>;
};

function ReviewRow({ review, now, unread, actions }: { review: ReviewCard; now: number; unread: boolean; actions: ReviewActions }) {
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<ReviewVerdict | null>(null);
  const { attempt, view: error } = useRowError();

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

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
      className={`group relative ${CARD_SURFACE} px-2 pb-1 pt-1.5 ${unread ? "border-sky-500/45 hover:border-sky-500/70" : CARD_EDGE}`}
    >
      <div className="flex items-start gap-2">
        <span className={MARK_FRAME} aria-label={unread ? "Pull request, new" : "Pull request"} title={unread ? "New since you last opened it" : "Pull request"}>
          <Icon name="GitPullRequest" className={`size-3.5 ${unread ? ACCENT_TEXT.sky : "text-muted-foreground/50"}`} aria-hidden />
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
          <div className="mt-0.5 flex h-5 items-center gap-0.5 pointer-coarse:h-7">
            <span className="mr-1 min-w-0 flex-1 truncate text-[10.5px] tabular-nums text-muted-foreground/80" title={metaHint}>
              {Number.isFinite(updated) ? `${formatShortAge(updated, now)} · ` : ""}
              {review.rereview ? <span className={`font-medium ${ACCENT_TEXT.sky}`}>re-review · </span> : null}
              {review.author} · {review.repo.split("/").pop()}#{review.number}
              {review.draft ? " · draft" : ""}
            </span>
            <ForgeLink forge={review.forge} onClick={() => void attempt(() => actions.onOpen(review))} />
            <button
              type="button"
              aria-label={confirming ? "Confirm approval" : "Approve"}
              title={confirming ? "Click again to approve" : "Approve"}
              disabled={pending !== null}
              onClick={() => (confirming ? void submit("approve", "") : setConfirming(true))}
              className={
                confirming
                  ? `${ROW_ACTION} bg-emerald-500 px-1.5 text-[10px] font-semibold text-white hover:bg-emerald-600`
                  : `${ROW_ICON_ACTION} hover:bg-emerald-500/10 hover:text-[light-dark(var(--color-emerald-700),var(--color-emerald-500))]`
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
              className={`${ROW_ICON_ACTION} hover:bg-rose-500/10 hover:text-[light-dark(var(--color-rose-700),var(--color-rose-500))] ${declining ? `bg-rose-500/10 ${ACCENT_TEXT.rose}` : ""}`}
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
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setDeclining(false);
                }}
                placeholder="What needs to change?"
                aria-label="What needs to change"
                disabled={pending !== null}
                className="h-6 min-w-0 flex-1 rounded-md border border-border/70 bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-rose-500/60 disabled:opacity-60 pointer-coarse:h-9 pointer-coarse:text-base"
              />
              <button
                type="submit"
                disabled={pending !== null || !reason.trim()}
                title="Request changes with this reason"
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-rose-500 px-2 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-9 pointer-coarse:px-3 pointer-coarse:text-sm"
              >
                {pending === "request_changes" ? <Spinner /> : null}
                Send
              </button>
            </form>
          ) : null}
          {error}
        </div>
      </div>

      <RowActions label="Archive pull request" title="Archive: hide this pull request from the queue" onArchive={() => void attempt(() => actions.onArchive(review))} />
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
    <div role="group" aria-label="Whose review requests" className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted/70 p-px pointer-coarse:h-7">
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
            className={`relative inline-flex h-4 items-center gap-1 rounded-[5px] px-1.5 text-[10px] font-medium leading-none transition-[color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-6 pointer-coarse:px-2.5 pointer-coarse:text-[11px] ${
              selected ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {SCOPE[scope].label}
            <span className={`tabular-nums ${selected ? "text-muted-foreground" : fresh ? ACCENT_TEXT.sky : "opacity-70"}`}>{counts[scope]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Reviews requested of the user by name (not their teams), and how many are new: the In tab's count. */
export function visibleReviews(reviews: ReviewsApi): { count: number; fresh: number } {
  const listed = (reviews.state?.reviews ?? []).filter((review) => review.scope === "me");
  return { count: listed.length, fresh: listed.filter((review) => review.unread).length };
}

export function ReviewGroup({ reviews, now }: { reviews: ReviewsApi; now: number }) {
  const links = useBbLinks();
  const { state } = reviews;
  const [showAll, setShowAll] = useState(false);
  // Not stored: the board opens on Me every time it is shown.
  const [chosenScope, setChosenScope] = useState<ReviewScope>("me");
  // Opened ("read"), archived or reviewed ("hidden") here: applied at once, before the server's next list round-trips.
  const [local, setLocal] = useState<ReadonlyMap<string, "read" | "hidden">>(() => new Map());
  const mark = (id: string, value: "read" | "hidden" | null) =>
    setLocal((current) => {
      if ((current.get(id) ?? null) === value) return current;
      const next = new Map(current);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });

  useEffect(() => {
    // Drop local marks once the server agrees, so a new push can mark the card unread again.
    if (!state) return;
    const listed = new Map(state.reviews.map((review) => [review.id, review]));
    setLocal((current) => {
      const next = new Map([...current].filter(([id, value]) => (value === "hidden" ? listed.has(id) : listed.get(id)?.unread === true)));
      return next.size === current.size ? current : next;
    });
  }, [state]);

  if (!state || state.scopes.length === 0) return null;
  const listed = state.reviews.filter((review) => local.get(review.id) !== "hidden");

  // Skipped searches are expected on many machines, so a hover hint, not a warning.
  const { problems, skipped } = listProblems([reviews.error, state.error], state.sources);
  const loading = state.refreshedAt === null;

  // A scope whose searches were all removed falls back to the one left.
  const scope = state.scopes.includes(chosenScope) ? chosenScope : state.scopes[0];
  const isNew = (review: ReviewCard) => review.unread && !local.has(review.id);
  const counts: Record<ReviewScope, number> = { me: 0, team: 0 };
  const unread: Record<ReviewScope, number> = { me: 0, team: 0 };
  for (const review of listed) {
    counts[review.scope] += 1;
    if (isNew(review)) unread[review.scope] += 1;
  }
  const scoped = listed.filter((review) => review.scope === scope);
  const shown = showAll ? scoped : scoped.slice(0, SHOWN_MAX);

  const actions: ReviewActions = {
    onDraft: async (review) => {
      mark(review.id, "read");
      links.compose(await reviews.draft(review.id));
    },
    onOpen: async (review) => {
      mark(review.id, "read");
      links.openUrl(review.url);
      await reviews.markRead(review.id);
    },
    onArchive: async (review) => {
      mark(review.id, "hidden");
      try {
        await reviews.archive(review.id);
      } catch (cause) {
        mark(review.id, null);
        throw cause;
      }
    },
    onSubmit: async (review, verdict, body) => {
      await reviews.submit(review.id, verdict, body);
      mark(review.id, "hidden");
    },
  };

  const selectScope = (next: ReviewScope) => {
    setChosenScope(next);
    setShowAll(false);
  };

  return (
    <div className="space-y-1">
      <GroupHeader
        title="Reviews"
        count={state.scopes.length === 1 ? scoped.length : null}
        hint={skipped.length > 0 ? ["Not read:", ...skipped].join("\n") : "Open pull requests waiting on your review"}
        refreshing={state.refreshing}
        problems={problems}
      >
        {state.scopes.length > 1 ? <ScopeToggle scopes={state.scopes} active={scope} counts={counts} unread={unread} onSelect={selectScope} /> : null}
        {unread[scope] > 0 ? <span className={`text-[10px] font-medium ${ACCENT_TEXT.sky}`}>{unread[scope]} new</span> : null}
      </GroupHeader>
      {scoped.length === 0 ? (
        <p className={EMPTY_NOTE}>{loading ? "Reading pull requests…" : SCOPE[scope].empty}</p>
      ) : null}
      {shown.map((review) => (
        <ReviewRow key={review.id} review={review} now={now} unread={isNew(review)} actions={actions} />
      ))}
      <ShowMore total={scoped.length} max={SHOWN_MAX} all={showAll} onToggle={() => setShowAll((all) => !all)} />
    </div>
  );
}
