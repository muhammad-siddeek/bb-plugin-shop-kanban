// Incremental discovery: classify changed threads, retain qualifying ideas, pair them with ExP, and build the inbox snapshot.
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
import { fetchThreads, permalink, resolveUsers, type Message, type Reply, type SlackChannelState } from "./slack";
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
  /** Legacy delivery date, preserved for imported stores; scans never gate on or change it. */
  lastRunDate: string;
  /** Classification cache by parent ts, invalidated by any newly discovered thread activity. */
  classified: Record<string, { replyCount: number; signature?: string; c: Classification }>;
  reported: Record<string, ReportedIdea>;
  /** Published items by stable id, for reader feedback. */
  items: Record<string, ItemRecord>;
  cursors?: Record<string, number>;
  channels?: Record<string, SlackChannelState>;
}

export function loadState(): State {
  const s = readJson<Partial<State>>(PATHS.state, {});
  return { ...s, lastRunDate: s.lastRunDate ?? "", classified: s.classified ?? {}, reported: s.reported ?? {}, items: s.items ?? {}, cursors: s.cursors ?? {}, channels: s.channels ?? {} };
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

/** Classify changed threads with complete reply context, then score every kept message. */
export async function analyze(
  window: Message[],
  baselineSample: Message[],
  state: State,
  leaders: Leaders,
  threadContext: Record<string, Reply[]> = {},
): Promise<Analysis> {
  const baseline = computeBaseline(baselineSample.map(engagement));

  const stale = window.filter((m) => {
    const hit = state.classified[m.ts];
    return !hit || hit.signature !== JSON.stringify(m);
  });
  if (stale.length) {
    const parents = stale.filter((message) => message.replyCount > 0 && !Object.hasOwn(threadContext, message.ts)).map((message) => message.ts);
    const threads = { ...threadContext, ...await timed(`threads (${parents.length})`, () => fetchThreads(CONFIG.channel.id, parents)) };
    const authors = await timed("authors", () => resolveUsers(stale.map((m) => m.user)));
    const fresh = await timed(`classify (${stale.length})`, () =>
      classify(
        stale.map((msg) => ({ msg, replies: threads[msg.ts] ?? [], authorTitle: authors[msg.user]?.title ?? "" })),
        leaders.priorities,
        Object.entries(state.reported).map(([key, r]) => ({ key, title: r.title })),
      ),
    );
    const messages = new Map(stale.map((message) => [message.ts, message]));
    for (const c of fresh) {
      const message = messages.get(c.ts)!;
      state.classified[c.ts] = { replyCount: message.replyCount, signature: JSON.stringify(message), c };
    }
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
  windowHours?: number;
}): Digest {
  const problems = new Map(args.problems.map((p) => [p.id, p]));
  const matchByTs = new Map(args.matches.map((m) => [m.ts, m]));
  const item = (x: Idea): DigestItem => ({
    id: `idea-${x.msg.ts}`,
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
  const pairings: Pairing[] = matched.map(({ x, m, p, priority, score }) => ({
    ...item(x),
    problem: { id: p.id, title: p.title, kind: p.kind },
    priority,
    strength: m.strength,
    why: m.why,
    tryThis: m.tryThis,
    score,
  }));

  // Every qualified unpaired idea is retained too; advancing a source checkpoint must never strand overflow.
  const matchedTs = new Set(matched.map(({ x }) => x.msg.ts));
  const nearMiss = (x: Idea) => {
    const m = matchByTs.get(x.msg.ts);
    return m && problems.has(m.problemId) ? m.strength : 0;
  };
  const rest = args.ideas
    .filter((x) => !matchedTs.has(x.msg.ts))
    .map((x) => ({ x, score: rankScore(nearMiss(x), x.leadership.score, x.traction) }))
    .sort((a, b) => b.score - a.score);
  const others = rest.map(({ x }) => item(x));

  return {
    date: args.date,
    generatedAt: new Date().toISOString(),
    windowHours: args.windowHours ?? 0,
    scanned: args.scanned,
    qualified: args.analysis.candidates.length,
    pairings,
    others,
    othersHidden: 0,
    backlog: args.backlog,
    watch: args.watch ?? NO_WATCH,
  };
}

/** Record published items so novelty and feedback survive subsequent scans. */
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
}

