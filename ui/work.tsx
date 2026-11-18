import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { prRef, type WorkItem, type WorkList, type WorkMark, type WorkState } from "./model";
import { usePending, type WorkApi } from "./hooks";
import { Age, CappedList, ForgeLink, GroupHeader, IconMark, listProblems, RowActions, useBbLinks, useRowAction } from "./primitives";
import {
  ACCENT_BADGE,
  ACCENT_TEXT,
  CHIP,
  EMPTY_NOTE,
  ONE_LINE_AGE,
  ONE_LINE_PAD,
  ROW_ACTION,
  TWO_LINE_META,
  TWO_LINE_META_ROW,
  TWO_LINE_PAD,
  TYPE,
  cardFrame,
  cardTitle,
  type CardRail,
} from "./styles";

// Work lists in the Queue column: Open and Shipped in the Out tab (one line each), Assigned at the bottom of the Queue
// tab (two lines).
// The title opens a new-thread draft that takes the item further (land it, measure and demo it, or work the
// issue); the forge link opens it on its forge, and on shipped pull requests the toggles mark it measured or demoed.

const LIST_META: Record<WorkList, { title: string; hint: string; empty: string; mark: string; tone: string; rail: CardRail }> = {
  open: {
    title: "Open",
    hint: "Your open pull requests, drafts included",
    empty: "No open pull requests.",
    mark: "GitPullRequest",
    tone: ACCENT_TEXT.sky,
    rail: "sky",
  },
  shipped: {
    title: "Shipped",
    hint: "Your merged pull requests; each leaves once you mark it measured and demoed",
    empty: "Everything merged is measured and demoed.",
    mark: "GitMerge",
    tone: ACCENT_TEXT.emerald,
    rail: "emerald",
  },
  assigned: {
    title: "Assigned",
    hint: "Open issues assigned to you",
    empty: "No issues assigned to you.",
    mark: "CircleDot",
    tone: ACCENT_TEXT.amber,
    rail: "amber",
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
  onMark: (item: WorkItem, mark: WorkMark, on: boolean) => Promise<unknown>;
}) {
  const links = useBbLinks();
  const { attempt, view: error } = useRowAction();
  const meta = LIST_META[item.list];
  const at = (item.list === "shipped" ? item.mergedAt : null) ?? item.updatedAt;
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
    <IconMark
      label={draftMark ? "Draft pull request" : meta.hint}
      icon={draftMark ? "GitPullRequestDraft" : meta.mark}
      fallback={item.kind === "issue" ? "AlertCircle" : "GitPullRequest"}
      tone={draftMark ? "text-muted-foreground/50" : meta.tone}
    />
  );
  const titleButton = (
    <button
      type="button"
      onClick={() => links.compose(draftPrompt(item))}
      className={`flex h-[18px] w-full min-w-0 items-center rounded-sm text-left ${cardTitle()} leading-[18px] text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60`}
    >
      <span className="min-w-0 truncate">{item.title}</span>
    </button>
  );

  // Out (open and shipped pull requests): one line. The forge link and the follow-up toggles join archive on hover;
  // a follow-up already set stays as a badge so the row says what is left.
  if (item.list !== "assigned") {
    const done = item.list === "shipped" ? FOLLOW_UPS.filter((followUp) => item[followUp.mark]) : [];
    return (
      <article className={`group relative ${cardFrame(meta.rail)} ${ONE_LINE_PAD}`}>
        <div className="flex h-5 items-center gap-2">
          {mark}
          <div className="min-w-0 flex-1">{titleButton}</div>
          {done.map((followUp) => (
            <span key={followUp.mark} className={`${CHIP} gap-0.5 ${ACCENT_BADGE.emerald}`}>
              <Icon name="Check" className="size-2.5" aria-hidden />
              {followUp.label}
            </span>
          ))}
          {draftMark ? <span className={`shrink-0 ${TYPE.meta} text-muted-foreground/80`}>draft</span> : null}
          <Age at={at} now={now} className={ONE_LINE_AGE} />
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
    <article className={`group relative ${cardFrame(meta.rail)} ${TWO_LINE_PAD}`}>
      <div className="flex items-start gap-2">
        {mark}
        <div className="min-w-0 flex-1">
          {titleButton}
          <div className={TWO_LINE_META_ROW}>
            <span className={TWO_LINE_META}>
              <Age at={at} now={now} after=" · " />
              {prRef(item)}
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
  const byList: Record<WorkList, WorkItem[]> = { open: [], shipped: [], assigned: [] };
  for (const item of items) byList[item.list].push(item);

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

export function WorkGroup({ list, work, now }: { list: WorkList; work: WorkItems; now: number }) {
  const { state } = work;
  if (!state || !work.lists.includes(list)) return null;
  const meta = LIST_META[list];
  const items = work.byList[list];
  const problems = listProblems(
    [work.error, state.error],
    state.sources.filter((source) => source.list === list),
  );

  return (
    <div className="space-y-1">
      <GroupHeader
        title={meta.title}
        // Assigned draws no count: its cards already say how many issues wait.
        count={list === "assigned" ? null : items.length}
        refreshing={state.refreshing}
        problems={problems}
      />
      {items.length === 0 ? (
        <p className={EMPTY_NOTE}>{state.refreshedAt === null ? "Reading pull requests…" : meta.empty}</p>
      ) : null}
      <CappedList items={items}>
        {(item) => <WorkRow key={`${item.list}:${item.id}`} item={item} now={now} onMark={work.mark} />}
      </CappedList>
    </div>
  );
}
