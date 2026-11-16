// Pipeline stages: classify + score the channel window, pick novel ideas, pair with ExP, build the digest.
import { CONFIG, KEEP_CATEGORIES, PATHS } from "./config";
import type { BacklogItem } from "./backlog";
import { classify, type Classification } from "./classify";
import { NO_WATCH, type Digest, type DigestItem, type DigestWatch, type Pairing } from "./digest";
import type { Leaders } from "./leaders";
import type { Match } from "./match";
import type { Problem } from "./registry";
import {
  computeBaseline,
  engagement,
  leadershipSignal,
  novelty,
  passesEngagement,
  rankScore,
  tractionScore,
  type Baseline,
  type LeadershipSignal,
  type ReportedIdea,
  type TractionSample,
} from "./score";
import { fetchThreads, permalink, resolveUsers, type Message } from "./slack";
import { timed } from "./log";
import { readJson, writeJson } from "./store";

export interface ItemRecord {
  date: string;
  ideaKey: string;
  category: string;
  title: string;
  problemTitle: string;
  permalink: string;
}

export interface State {
  /** Toronto date (YYYY-MM-DD) of the last delivered digest. */
  lastRunDate: string;
  /** Classification cache by message ts; replyCount is the thread size it was judged at. */
  classified: Record<string, { replyCount: number; c: Classification }>;
  /** Ideas already delivered, by ideaKey. */
  reported: Record<string, ReportedIdea>;
  /** Delivered digest items by id, for reader feedback. */
  items: Record<string, ItemRecord>;
}

export function loadState(): State {
  const s = readJson<Partial<State>>(PATHS.state, {});
  return { lastRunDate: s.lastRunDate ?? "", classified: s.classified ?? {}, reported: s.reported ?? {}, items: s.items ?? {} };
}

export const saveState = (s: State): void => writeJson(PATHS.state, s);

export interface Candidate {
  msg: Message;
  c: Classification;
  author: string;
  engagement: TractionSample;
  leadership: LeadershipSignal;
  traction: number;
  passesEngagement: boolean;
}

export interface Analysis {
  baseline: Baseline;
  classified: { msg: Message; c: Classification }[];
  /** Confidently kept (new tech / finding / leadership push), scored. */
  candidates: Candidate[];
}

const KEEP = new Set<string>(KEEP_CATEGORIES);

/** Classify the window (reusing cached verdicts unless a thread grew), then score every kept message. */
export async function analyze(window: Message[], baselineSample: Message[], state: State, leaders: Leaders): Promise<Analysis> {
  const baseline = computeBaseline(baselineSample.map(engagement));

  const stale = window.filter((m) => {
    const hit = state.classified[m.ts];
    return !hit || m.replyCount - hit.replyCount >= CONFIG.reclassifyReplyGrowth;
  });
  if (stale.length) {
    const parents = stale
      .filter((m) => m.replyCount >= CONFIG.threadMinReplies)
      .sort((a, b) => b.replyCount - a.replyCount)
      .slice(0, CONFIG.maxThreads)
      .map((m) => m.ts);
    const threads = await timed(`threads (${parents.length})`, () => fetchThreads(CONFIG.channel.id, parents));
    const authors = await timed("authors", () => resolveUsers(stale.map((m) => m.user)));
    const fresh = await timed(`classify (${stale.length})`, () =>
      classify(
        stale.map((msg) => ({ msg, replies: threads[msg.ts] ?? [], authorTitle: authors[msg.user]?.title ?? "" })),
        leaders.priorities,
        Object.entries(state.reported).map(([key, r]) => ({ key, title: r.title })),
      ),
    );
    const replyCount = new Map(stale.map((m) => [m.ts, m.replyCount]));
    for (const c of fresh) state.classified[c.ts] = { replyCount: replyCount.get(c.ts) ?? 0, c };
  }

  const classified = window.flatMap((msg) => {
    const hit = state.classified[msg.ts];
    return hit ? [{ msg, c: hit.c }] : [];
  });
  const kept = classified.filter(({ c }) => KEEP.has(c.category) && c.confidence >= CONFIG.minCategoryConfidence);
  // Leadership detection needs titles of everyone who engaged with a kept message.
  const users = await timed("engager titles", () =>
    resolveUsers(kept.flatMap(({ msg }) => [msg.user, ...msg.replyUsers, ...msg.reactions.flatMap((r) => r.users)])),
  );
  const chainIds = new Set(leaders.chain.map((m) => m.slackId).filter(Boolean));
  const themes = new Map(leaders.priorities.map((p) => [p.id, p.theme]));

  const candidates = kept.map(({ msg, c }): Candidate => {
    const e = engagement(msg);
    const aligned = c.priorityIds.flatMap((id) => {
      const theme = themes.get(id);
      return theme ? [theme] : [];
    });
    const leadership = leadershipSignal(msg, users, chainIds, aligned);
    return {
      msg,
      c,
      author: users[msg.user]?.name || msg.userName,
      engagement: e,
      leadership,
      traction: tractionScore(e, c.confirmations, baseline),
      passesEngagement: passesEngagement(e, leadership),
    };
  });
  return { baseline, classified, candidates };
}

export interface Idea extends Candidate {
  ideaKey: string;
  resurfaced: boolean;
}

/** One candidate per idea (its strongest message), minus ideas already delivered without a traction jump. */
export function selectIdeas(candidates: Candidate[], reported: Record<string, ReportedIdea>): Idea[] {
  // A message that was already delivered keeps its original key even if reclassification renamed it.
  const keyByTs = new Map(Object.entries(reported).map(([key, r]) => [r.ts, key]));
  const strength = (x: Candidate) => rankScore(0, x.leadership.score, x.traction);
  const best = new Map<string, Candidate>();
  for (const x of candidates) {
    if (!x.passesEngagement) continue;
    const key = keyByTs.get(x.msg.ts) ?? x.c.ideaKey;
    const cur = best.get(key);
    if (!cur || strength(x) > strength(cur)) best.set(key, x);
  }
  return [...best].flatMap(([ideaKey, x]) => {
    const n = novelty(ideaKey, x.traction, reported);
    return n.novel ? [{ ...x, ideaKey, resurfaced: n.resurfaced }] : [];
  });
}

export function buildDigest(args: {
  date: string;
  scanned: number;
  analysis: Analysis;
  ideas: Idea[];
  matches: Match[];
  problems: Problem[];
  backlog: BacklogItem[];
  watch?: DigestWatch;
}): Digest {
  const problems = new Map(args.problems.map((p) => [p.id, p]));
  const matchByTs = new Map(args.matches.map((m) => [m.ts, m]));
  const tag = args.date.slice(5).replace("-", "");
  const item = (x: Idea, id: string): DigestItem => ({
    id,
    ts: x.msg.ts,
    ideaKey: x.ideaKey,
    permalink: permalink(CONFIG.channel.id, x.msg.ts),
    category: x.c.category,
    title: x.c.title,
    summary: x.c.summary,
    whatIsNew: x.c.whatIsNew,
    author: x.author,
    links: x.c.links,
    leadership: x.leadership,
    engagement: x.engagement,
    confirmations: x.c.confirmations,
    traction: x.traction,
    resurfaced: x.resurfaced,
  });

  // P0 = direct hit on a stated ExP pain; it outranks any P1 regardless of traction.
  const matched = args.ideas
    .flatMap((x) => {
      const m = matchByTs.get(x.msg.ts);
      const p = m ? problems.get(m.problemId) : undefined;
      if (!m || !p || m.strength < CONFIG.minMatchStrength) return [];
      const priority = m.strength >= CONFIG.p0MatchStrength ? ("P0" as const) : ("P1" as const);
      return [{ x, m, p, priority, score: rankScore(m.strength, x.leadership.score, x.traction) }];
    })
    .sort((a, b) => a.priority.localeCompare(b.priority) || b.score - a.score);
  // Cap per problem so one popular theme (e.g. "cheaper model → agent cost") cannot fill the digest.
  const perProblem = new Map<string, number>();
  const chosen = matched.filter(({ p }) => {
    const n = perProblem.get(p.id) ?? 0;
    if (n >= CONFIG.maxPairingsPerProblem) return false;
    perProblem.set(p.id, n + 1);
    return true;
  });
  const pairings: Pairing[] = chosen.slice(0, CONFIG.maxPairings).map(({ x, m, p, priority, score }, i) => ({
    ...item(x, `${tag}-${i + 1}`),
    problem: { id: p.id, title: p.title, kind: p.kind },
    priority,
    strength: m.strength,
    why: m.why,
    tryThis: m.tryThis,
    score,
  }));

  // Everything else that qualified, ranked by promise (a near-miss fit counts); overflow pairings wait for tomorrow.
  const matchedTs = new Set(matched.map(({ x }) => x.msg.ts));
  const nearMiss = (x: Idea) => {
    const m = matchByTs.get(x.msg.ts);
    return m && problems.has(m.problemId) ? m.strength : 0;
  };
  const rest = args.ideas
    .filter((x) => !matchedTs.has(x.msg.ts))
    .map((x) => ({ x, score: rankScore(nearMiss(x), x.leadership.score, x.traction) }))
    .sort((a, b) => b.score - a.score);
  const others = rest.slice(0, CONFIG.maxOthers).map(({ x }, i) => item(x, `${tag}-${pairings.length + i + 1}`));

  return {
    date: args.date,
    generatedAt: new Date().toISOString(),
    windowHours: CONFIG.lookbackHours,
    scanned: args.scanned,
    qualified: args.analysis.candidates.length,
    pairings,
    others,
    othersHidden: rest.length - others.length,
    backlog: args.backlog,
    watch: args.watch ?? NO_WATCH,
  };
}

/** Record delivered items so they are not repeated and can receive feedback. */
export function commitDigest(state: State, d: Digest): void {
  const items: (DigestItem & { problem?: Pairing["problem"] })[] = [...d.pairings, ...d.others];
  for (const it of items) {
    state.reported[it.ideaKey] = { ts: it.ts, date: d.date, traction: it.traction, title: it.title };
    state.items[it.id] = {
      date: d.date,
      ideaKey: it.ideaKey,
      category: it.category,
      title: it.title,
      problemTitle: it.problem?.title ?? "",
      permalink: it.permalink,
    };
  }
  state.lastRunDate = d.date;
}

/** Cached verdicts older than the window can never be re-scored. */
export function pruneClassified(state: State, oldestSec: number): void {
  for (const ts of Object.keys(state.classified)) if (Number(ts) < oldestSec) delete state.classified[ts];
}
