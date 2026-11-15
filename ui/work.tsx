import { useEffect, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ACCENT_BADGE, ACCENT_TEXT, CARD_EDGE, CARD_SURFACE, formatShortAge, type WorkItem, type WorkList, type WorkMark, type WorkState } from "./model";
import type { WorkApi } from "./hooks";
import {
  CHIP,
  EMPTY_NOTE,
  ForgeLink,
  GroupHeader,
  listProblems,
  MARK_FRAME,
  ONE_LINE_AGE,
  ONE_LINE_PAD,
  ROW_ACTION,
  RowActions,
  ShowMore,
  TYPE,
  useBbLinks,
  useRowError,
} from "./primitives";

// Work lists in the Queue column's tabs: Open and Shipped in Out (one line each), Assigned in In (two lines).
// The title opens a new-thread draft that takes the item further (land it, measure and demo it, or work the
// issue); the forge link opens it on its forge, and on shipped pull requests the toggles mark it measured or demoed.

const SHOWN_MAX = 8;
const LIST_META: Record<WorkList, { title: string; hint: string; empty: string; mark: string; tone: string }> = {
  open: {
    title: "Open",
    hint: "Your open pull requests, drafts included",
    empty: "No open pull requests.",
    mark: "GitPullRequest",
    tone: ACCENT_TEXT.sky,
  },
  shipped: {
    title: "Shipped",
    hint: "Your merged pull requests; each leaves once you mark it measured and demoed",
    empty: "Everything merged is measured and demoed.",
    mark: "GitMerge",
    tone: ACCENT_TEXT.emerald,
  },
  assigned: {
    title: "Assigned",
    hint: "Open issues assigned to you",
    empty: "No issues assigned to you.",
    mark: "CircleDot",
    tone: ACCENT_TEXT.amber,
  },
};
const FOLLOW_UPS: { mark: "measured" | "demoed"; label: string }[] = [
  { mark: "measured", label: "Measured" },
  { mark: "demoed", label: "Demoed" },
];

/** The seed of a new thread that takes the item further. */
function draftPrompt(item: WorkItem): string {
  const ref = `${item.url} ("${item.title}")`;
  if (item.list === "shipped") {
    const merged = item.mergedAt ? ` It merged on ${item.mergedAt.slice(0, 10)}.` : "";
    return `Help me measure the impact of my pull request ${ref} and demo it.${merged} Find the metrics, dashboards or experiments it should move and compare them before and after it shipped, then outline a short demo of the change.`;
  }
  if (item.kind === "issue") {
    return `Look into the issue ${ref}, which is assigned to me: summarize what it asks for, then propose how to resolve it.`;
  }
  return `Help me land my pull request ${ref}${item.draft ? ", still a draft" : ""}: read its review comments, CI checks and merge readiness, and tell me what is left before it can merge.`;
}

function WorkRow({ item, now, onMark }: {
  item: WorkItem;
  now: number;
  onMark: (item: WorkItem, mark: WorkMark, on: boolean) => Promise<void>;
}) {
  const links = useBbLinks();
  const { attempt, view: error } = useRowError();
  const meta = LIST_META[item.list];
  const at = Date.parse((item.list === "shipped" ? item.mergedAt : null) ?? item.updatedAt);
  const draftMark = item.kind === "pr" && item.draft;
  const noun = item.kind === "issue" ? "issue" : "pull request";
  const followUps =
    item.list === "shipped"
      ? FOLLOW_UPS.map((followUp) => {
          const on = item[followUp.mark];
          return (
            <button
              key={followUp.mark}
              type="button"
              aria-pressed={on}
              onClick={() => void attempt(() => onMark(item, followUp.mark, !on))}
              className={`${ROW_ACTION} gap-0.5 px-1 ${TYPE.meta} font-medium ${on ? ACCENT_BADGE.emerald : "hover:bg-accent hover:text-foreground"}`}
            >
              {on ? <Icon name="Check" className="size-3" aria-hidden /> : null}
              {followUp.label}
            </button>
          );
        })
      : null;
  const mark = (
    <span className={MARK_FRAME} aria-label={draftMark ? "Draft pull request" : meta.hint}>
      <Icon
        name={draftMark ? "GitPullRequestDraft" : meta.mark}
        fallback={item.kind === "issue" ? "AlertCircle" : "GitPullRequest"}
        className={`size-3.5 ${draftMark ? "text-muted-foreground/50" : meta.tone}`}
        aria-hidden
      />
    </span>
  );
  const titleButton = (
    <button
      type="button"
      onClick={() => links.compose(draftPrompt(item))}
      className={`flex h-[18px] w-full min-w-0 items-center rounded-sm text-left ${TYPE.title} font-semibold leading-[18px] text-foreground decoration-muted-foreground/40 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60`}
    >
      <span className="min-w-0 truncate">{item.title}</span>
    </button>
  );

  // Out (open and shipped pull requests): one line. The forge link and the follow-up toggles join archive on hover;
  // a follow-up already set stays as a badge so the row says what is left.
  if (item.list !== "assigned") {
    const done = item.list === "shipped" ? FOLLOW_UPS.filter((followUp) => item[followUp.mark]) : [];
    return (
      <article className={`group relative ${CARD_SURFACE} ${CARD_EDGE} ${ONE_LINE_PAD}`}>
        <div className="flex h-5 items-center gap-2">
          <span className="-mt-px flex">{mark}</span>
          <div className="min-w-0 flex-1">{titleButton}</div>
          {done.map((followUp) => (
            <span key={followUp.mark} className={`${CHIP} gap-0.5 ${ACCENT_BADGE.emerald}`}>
              <Icon name="Check" className="size-2.5" aria-hidden />
              {followUp.label}
            </span>
          ))}
          {draftMark ? <span className={`shrink-0 ${TYPE.meta} text-muted-foreground/80`}>draft</span> : null}
          {Number.isFinite(at) ? (
            <span className={ONE_LINE_AGE}>
              {formatShortAge(at, now)}
            </span>
          ) : null}
        </div>
        {error}
        <RowActions
          centered
          label={`Archive ${noun}`}
          onArchive={() => void attempt(() => onMark(item, "archived", true))}
        >
          {followUps}
          <ForgeLink forge={item.forge} onClick={() => links.openUrl(item.url)} />
        </RowActions>
      </article>
    );
  }

  return (
    <article className={`group relative ${CARD_SURFACE} ${CARD_EDGE} px-2 pb-1 pt-1.5`}>
      <div className="flex items-start gap-2">
        {mark}
        <div className="min-w-0 flex-1">
          {titleButton}
          <div className="-mr-[3px] mt-0.5 flex h-5 items-center gap-0.5 pointer-coarse:h-7">
            <span className={`mr-1 min-w-0 flex-1 truncate ${TYPE.meta} tabular-nums text-muted-foreground/80`}>
              {Number.isFinite(at) ? `${formatShortAge(at, now)} · ` : ""}
              {item.repo.split("/").pop()}#{item.number}
            </span>
            <ForgeLink forge={item.forge} onClick={() => links.openUrl(item.url)} />
          </div>
          {error}
        </div>
      </div>
      <RowActions
        label={`Archive ${noun}`}
        onArchive={() => void attempt(() => onMark(item, "archived", true))}
      />
    </article>
  );
}

/** The work lists as the board shows them: marks set here apply at once, before the server's next list round-trips. */
type WorkItems = {
  state: WorkState | null;
  error: string | null;
  /** Lists with a search configured. */
  lists: WorkList[];
  byList: Record<WorkList, WorkItem[]>;
  mark(item: WorkItem, kind: WorkMark, on: boolean): Promise<void>;
};

/** One per board, shared by its work groups so the tab counts agree with them. */
export function useWorkItems(work: WorkApi): WorkItems {
  // Per item, the marks set here: archived hides it, and a shipped one with both follow-ups set leaves too.
  const [local, setLocal] = useState<ReadonlyMap<string, Partial<Record<WorkMark, boolean>>>>(() => new Map());
  const { state } = work;

  useEffect(() => {
    // Drop local marks once the server agrees.
    if (!state) return;
    setLocal((current) => {
      const next = new Map(
        [...current].filter(([id, marks]) => {
          const item = state.items.find((candidate) => candidate.id === id);
          if (!item) return false;
          return (marks.archived ?? false) || (marks.measured !== undefined && marks.measured !== item.measured) || (marks.demoed !== undefined && marks.demoed !== item.demoed);
        }),
      );
      return next.size === current.size ? current : next;
    });
  }, [state]);

  const items = (state?.items ?? []).flatMap((item) => {
    const marks = local.get(item.id);
    if (!marks) return [item];
    if (marks.archived) return [];
    const merged = { ...item, measured: marks.measured ?? item.measured, demoed: marks.demoed ?? item.demoed };
    return merged.list === "shipped" && merged.measured && merged.demoed ? [] : [merged];
  });
  const byList: Record<WorkList, WorkItem[]> = { open: [], shipped: [], assigned: [] };
  for (const item of items) byList[item.list].push(item);

  const mark = async (item: WorkItem, kind: WorkMark, on: boolean) => {
    setLocal((current) => new Map(current).set(item.id, { ...current.get(item.id), [kind]: on }));
    try {
      await work.mark(item.id, kind, on);
    } catch (cause) {
      setLocal((current) => {
        const next = new Map(current);
        const { [kind]: _dropped, ...rest } = next.get(item.id) ?? {};
        if (Object.keys(rest).length > 0) next.set(item.id, rest);
        else next.delete(item.id);
        return next;
      });
      throw cause;
    }
  };

  return { state, error: work.error, lists: state?.lists ?? [], byList, mark };
}

export function WorkGroup({ list, work, now }: { list: WorkList; work: WorkItems; now: number }) {
  const [showAll, setShowAll] = useState(false);
  const { state } = work;
  if (!state || !work.lists.includes(list)) return null;
  const meta = LIST_META[list];
  const items = work.byList[list];
  const shown = showAll ? items : items.slice(0, SHOWN_MAX);
  const problems = listProblems(
    [work.error, state.error],
    state.sources.filter((source) => source.list === list),
  );

  return (
    <div className="space-y-1">
      <GroupHeader
        title={meta.title}
        count={items.length}
        refreshing={state.refreshing}
        problems={problems}
      />
      {items.length === 0 ? (
        <p className={EMPTY_NOTE}>{state.refreshedAt === null ? "Reading pull requests…" : meta.empty}</p>
      ) : null}
      {shown.map((item) => (
        <WorkRow key={`${item.list}:${item.id}`} item={item} now={now} onMark={work.mark} />
      ))}
      <ShowMore total={items.length} max={SHOWN_MAX} all={showAll} onToggle={() => setShowAll((all) => !all)} />
    </div>
  );
}
