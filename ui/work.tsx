import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { WorkItem, WorkList, WorkMark, WorkStage, WorkState } from "./model";
import { usePending, type WorkApi } from "./hooks";
import { TaskStatusMark } from "./card";
import { Age, CappedList, ForgeLink, GroupHeader, IconMark, Spinner, listProblems, Mark, RowActions, useBbLinks, useRowAction } from "./primitives";
import {
  ACCENT_BADGE,
  ACCENT_TEXT,
  CHIP,
  EMPTY_NOTE,
  ONE_LINE_AGE,
  ONE_LINE_PAD,
  ROW_ACTION,
  TYPE,
  UNREAD_BADGE,
  cardFrame,
  cardTitle,
} from "./styles";

// Work lists, one line each. Outgoing PRs, in the Queue column above Parked: the user's open pull requests,
// each with a status mark that says whose move it is (red like a blocked thread when it waits on the user) and where
// it stands. Shipped, in the Queue column's Out tab. The title opens a new-thread draft that takes the item its next
// step (fix CI, answer review, merge, measure and demo it); the forge link opens it on its forge, and on shipped pull
// requests the toggles mark it measured or demoed.

const LIST_META: Record<WorkList, { title: string; hint: string; empty: string; mark: string; tone: string }> = {
  open: {
    title: "Outgoing PRs",
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
};
const FOLLOW_UPS: { mark: "measured" | "demoed"; label: string }[] = [
  { mark: "measured", label: "Measured" },
  { mark: "demoed", label: "Demoed" },
];

/** Outgoing order: what waits on the user first, then what they can merge, then what waits on others, then drafts. */
const TONE_ORDER: Record<WorkStage["tone"], number> = { you: 0, ready: 1, waiting: 2, idle: 3 };
/** A stage line's text per tone: the user's move in the hue of its mark, everything else quiet. */
export const STAGE_TEXT: Record<WorkStage["tone"], string> = {
  you: `font-medium ${ACCENT_TEXT.rose}`,
  ready: `font-medium ${ACCENT_TEXT.emerald}`,
  waiting: "text-muted-foreground",
  idle: "text-muted-foreground",
};

/**
 * An open pull request's leading mark, labeled with where it stands: the board's red blocked mark when it waits on
 * the user, a green merge disc when they can merge it, the Working petals while CI runs, an hourglass on reviewers.
 */
export function StageMark({ stage }: { stage: WorkStage }) {
  switch (stage.step) {
    case "conflict":
    case "ci_failing":
    case "changes_requested":
    case "behind":
    case "no_reviewers":
      return (
        <Mark label={stage.label} disc="bg-rose-500 text-[10px] font-bold leading-none text-white">
          !
        </Mark>
      );
    case "ready":
      return <IconMark label={stage.label} icon="GitMerge" fallback="Check" disc={UNREAD_BADGE.emerald} />;
    case "ci_running":
      return <TaskStatusMark status="wip" unread={false} />;
    case "in_review":
      return <IconMark label={stage.label} icon="Hourglass" fallback="Clock" tone={ACCENT_TEXT.amber} />;
    case "draft":
      return <IconMark label={stage.label} icon="GitPullRequestDraft" fallback="GitPullRequest" tone="text-muted-foreground/50" />;
    case "unknown":
      return (
        <Mark label={stage.label}>
          <Spinner />
        </Mark>
      );
  }
}

/** The seed of a new thread that takes the item its next step. */
function draftPrompt(item: WorkItem): string {
  const ref = `${item.url} ("${item.title}")`;
  if (item.list === "shipped") {
    const merged = item.mergedAt ? ` It merged on ${item.mergedAt.slice(0, 10)}.` : "";
    return `Help me measure the impact of my pull request ${ref} and demo it.${merged} Find the metrics, dashboards or experiments it should move and compare them before and after it shipped, then outline a short demo of the change.`;
  }
  switch (item.stage?.step) {
    case "ci_failing":
      return `CI is failing on my pull request ${ref} (${item.stage.label.replace(/^CI failing · /u, "")}): read the failing checks' logs, find the cause and fix it.`;
    case "changes_requested":
      return `Reviewers requested changes on my pull request ${ref}: read every unresolved review comment, and address each one or tell me why not.`;
    case "conflict":
      return `My pull request ${ref} has a merge conflict with its base branch: rebase it, resolve the conflicts and tell me what you had to decide.`;
    case "behind":
      return `My pull request ${ref} is behind its base branch: update it and make sure CI still passes.`;
    case "ready":
      return `My pull request ${ref} is approved: check it is still green and safe to ship, tell me anything that blocks the merge, and how to roll it out.`;
    case "no_reviewers":
      return `My pull request ${ref} has no reviewers yet: find who owns the code it changes and suggest who should review it.`;
    default:
      return `Help me land my pull request ${ref}${item.draft ? ", still a draft" : ""}: read its review comments, CI checks and merge readiness, and tell me what is left before it can merge.`;
  }
}

/** The title: opens a new-thread draft that takes the item its next step. */
function titleButton(item: WorkItem, compose: (prompt: string) => void) {
  return (
    <button
      type="button"
      onClick={() => compose(draftPrompt(item))}
      className={`flex h-[18px] w-full min-w-0 items-center rounded-sm text-left ${cardTitle()} leading-[18px] text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60`}
    >
      <span className="min-w-0 truncate">{item.title}</span>
    </button>
  );
}

/** An open pull request in Outgoing PRs: the stage mark, title, where it stands and age; forge link and archive on hover. */
function InFlightRow({ item, now, onMark }: { item: WorkItem; now: number; onMark: (item: WorkItem, mark: WorkMark, on: boolean) => Promise<unknown> }) {
  const links = useBbLinks();
  const { attempt, view: error } = useRowAction();
  const meta = LIST_META[item.list];
  const stage = item.stage;
  return (
    <article className={`group relative ${cardFrame()} ${ONE_LINE_PAD}`}>
      <div className="flex h-5 items-center gap-2">
        {stage ? <StageMark stage={stage} /> : <IconMark label={meta.hint} icon={meta.mark} tone={meta.tone} />}
        <div className="min-w-0 flex-1">{titleButton(item, links.compose)}</div>
        {stage ? <span className={`max-w-[45%] shrink-0 truncate ${TYPE.meta} ${STAGE_TEXT[stage.tone]}`}>{stage.label}</span> : null}
        <Age at={item.updatedAt} now={now} className={ONE_LINE_AGE} />
      </div>
      {error}
      <RowActions centered label="Archive pull request" onArchive={() => void attempt(() => onMark(item, "archived", true))}>
        <ForgeLink forge={item.forge} onClick={() => links.openUrl(item.url)} />
      </RowActions>
    </article>
  );
}

/** A shipped pull request in Out: one line, the follow-up toggles beside the forge link on hover. */
function ShippedRow({ item, now, onMark }: { item: WorkItem; now: number; onMark: (item: WorkItem, mark: WorkMark, on: boolean) => Promise<unknown> }) {
  const links = useBbLinks();
  const { attempt, view: error } = useRowAction();
  const meta = LIST_META.shipped;
  const followUps = FOLLOW_UPS.map((followUp) => {
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
  });
  // A follow-up already set stays as a badge so the row says what is left.
  const done = FOLLOW_UPS.filter((followUp) => item[followUp.mark]);
  return (
    <article className={`group relative ${cardFrame()} ${ONE_LINE_PAD}`}>
      <div className="flex h-5 items-center gap-2">
        <IconMark label={meta.hint} icon={meta.mark} fallback="GitPullRequest" tone={meta.tone} />
        <div className="min-w-0 flex-1">{titleButton(item, links.compose)}</div>
        {done.map((followUp) => (
          <span key={followUp.mark} className={`${CHIP} gap-0.5 ${ACCENT_BADGE.emerald}`}>
            <Icon name="Check" className="size-2.5" aria-hidden />
            {followUp.label}
          </span>
        ))}
        <Age at={item.mergedAt ?? item.updatedAt} now={now} className={ONE_LINE_AGE} />
      </div>
      {error}
      <RowActions centered label="Archive pull request" onArchive={() => void attempt(() => onMark(item, "archived", true))}>
        {followUps}
        <ForgeLink forge={item.forge} onClick={() => links.openUrl(item.url)} />
      </RowActions>
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
  // Per item, the marks set here: archived hides it, and a shipped one with both follow-ups set leaves too. Each is
  // dropped once the server agrees.
  const { state } = work;
  const [local, changeLocal] = usePending<WorkState, Partial<Record<WorkMark, boolean>>>(state, (marks, id, served) => {
    const item = served.items.find((candidate) => candidate.id === id);
    if (!item) return false;
    return (marks.archived ?? false) || (marks.measured !== undefined && marks.measured !== item.measured) || (marks.demoed !== undefined && marks.demoed !== item.demoed);
  });

  const items = (state?.items ?? []).flatMap((item) => {
    const marks = local.get(item.id);
    if (!marks) return [item];
    if (marks.archived) return [];
    const merged = { ...item, measured: marks.measured ?? item.measured, demoed: marks.demoed ?? item.demoed };
    return merged.list === "shipped" && merged.measured && merged.demoed ? [] : [merged];
  });
  const byList: Record<WorkList, WorkItem[]> = { open: [], shipped: [] };
  for (const item of items) byList[item.list].push(item);
  // Stable: within a tone, the server's newest-update-first order holds.
  byList.open.sort((a, b) => TONE_ORDER[a.stage?.tone ?? "waiting"] - TONE_ORDER[b.stage?.tone ?? "waiting"]);

  const mark = async (item: WorkItem, kind: WorkMark, on: boolean) => {
    changeLocal(item.id, (marks) => ({ ...marks, [kind]: on }));
    try {
      await work.mark(item.id, kind, on);
    } catch (cause) {
      changeLocal(item.id, (marks) => {
        const { [kind]: _dropped, ...rest } = marks ?? {};
        return Object.keys(rest).length > 0 ? rest : undefined;
      });
      throw cause;
    }
  };

  return { state, error: work.error, lists: state?.lists ?? [], byList, mark };
}

/** A header pill counting what waits on the user: red like the blocked mark. Nothing at zero. */
export function NeedsYouBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className={`inline-flex h-4 shrink-0 items-center rounded-full px-1.5 ${TYPE.badge} leading-none ${UNREAD_BADGE.rose}`}>{count} need you</span>;
}

export function WorkGroup({ list, work, now }: { list: WorkList; work: WorkItems; now: number }) {
  const { state } = work;
  if (!state || !work.lists.includes(list)) return null;
  const meta = LIST_META[list];
  const items = work.byList[list];
  const problems = listProblems(
    [work.error, state.error],
    state.sources.filter((source) => source.list === list),
  );
  const needsYou = items.filter((item) => item.stage?.tone === "you").length;

  return (
    <div role="group" aria-label={meta.title} className="space-y-1">
      <GroupHeader title={meta.title} count={items.length} refreshing={state.refreshing} problems={problems}>
        {list === "open" ? <NeedsYouBadge count={needsYou} /> : null}
      </GroupHeader>
      {items.length === 0 ? (
        <p className={EMPTY_NOTE}>{state.refreshedAt === null ? "Reading pull requests…" : meta.empty}</p>
      ) : null}
      <CappedList items={items}>
        {(item) =>
          list === "shipped" ? (
            <ShippedRow key={`${item.list}:${item.id}`} item={item} now={now} onMark={work.mark} />
          ) : (
            <InFlightRow key={`${item.list}:${item.id}`} item={item} now={now} onMark={work.mark} />
          )
        }
      </CappedList>
    </div>
  );
}
