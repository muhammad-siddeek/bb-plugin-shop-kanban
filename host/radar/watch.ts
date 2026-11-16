// Opportunity watch: sweeps all configured sources (Slack threads, GitHub PRs, Vault) for
// unowned ExP problems, has the LLM rate each ask and propose three ranked solutions, and keeps only big asks with
// a big solution the team could plausibly accept.
import { CONFIG, PATHS, WATCH, WATCH_LIMITS, type WatchSources } from "./config";
import { lit, runCode } from "./gateway";
import type { Leaders } from "./leaders";
import { inBatches, structured } from "./llm";
import { timed } from "./log";
import type { Problem } from "./registry";
import { safeMessage, throwIfAborted } from "./runtime";
import { permalink, scanChannel, type SlackChannelState, type UserInfo } from "./slack";
import { readJson, writeJson } from "./store";

/** One unit of new activity the judge sees: a Slack thread, a PR, or a Vault snapshot. */
export interface Activity {
  ref: string;
  url: string;
  text: string;
}

/** Scores are 1-5. Solutions are ranked by fit + buyIn; ambition is how impactful, agentic and big it is. */
export interface Solution {
  idea: string;
  fit: number;
  buyIn: number;
  ambition: number;
}

export interface Opportunity {
  key: string;
  title: string;
  problem: string;
  owner: "unowned" | "partly_owned";
  /** How big the problem is (reach and stakes, never effort), 1-5. */
  ask: number;
  askWhy: string;
  /** Best-ranked first. */
  solutions: Solution[];
  evidence: { ref: string; quote: string; url: string }[];
}

export interface Picked extends Opportunity {
  resurfaced: boolean;
}

export interface ReportedOpportunity {
  title: string;
  date: string;
  /** Evidence items seen across all sweeps. */
  seen: number;
  /** `seen` when it was last delivered; it resurfaces once `seen` reaches CONFIG.resurfaceFactor times this. */
  atReport: number;
}

export interface WatchState {
  /** Unix seconds each source was last swept up to, by source key. */
  cursors: Record<string, number>;
  reported: Record<string, ReportedOpportunity>;
  channels?: Record<string, SlackChannelState>;
  /** Last completely read Vault/PR content. Inclusive PR boundary reads and unchanged snapshots are not re-judged. */
  snapshots?: Record<string, string>;
}

export interface Sweep {
  at: number;
  scanned: number;
  found: Opportunity[];
  /** Source labels that failed (e.g. rate-limited); their cursors stay put so the next run retries them. */
  failed: { key: string; label: string }[];
  channels?: Record<string, SlackChannelState>;
  snapshots?: Record<string, string>;
}

export const loadWatchState = (): WatchState => ({ cursors: {}, reported: {}, ...readJson<Partial<WatchState>>(PATHS.watchState, {}) });

const SOURCE_KEYS = [
  ...WATCH.channels.map((c) => `slack:${c.id}`),
  ...WATCH.repos.map((r) => `github:${r}`),
  ...WATCH.vault.projectTeams.map((team) => `vault:projects:${team}`),
  ...WATCH.vault.issueTeams.map((team) => `vault:issues:${team}`),
];

// ---- gathering -------------------------------------------------------------------------------------------------

const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * Author label from the digest's user cache and the management chain. No live profile lookups: Slack rate-limits
 * `read_user_profile` to about one call per 4s, which stalls a sweep for minutes.
 */
function who(id: string, fallback: string, users: Record<string, UserInfo>): string {
  const u = users[id];
  if (!u?.name) return fallback || id;
  return u.title ? `${u.name} (${u.title})` : u.name;
}

/** Durable thread indexes make replies to arbitrarily old parents discoverable without a rolling history window. */
async function channelActivity(
  ch: WatchSources["channels"][number],
  since: number,
  now: number,
  users: Record<string, UserInfo>,
  previous?: SlackChannelState,
): Promise<{ activity: Activity[]; state: SlackChannelState }> {
  const scanned = await scanChannel(ch.id, since, now, previous, { includeBots: ch.includeBots });
  return {
    state: scanned.state,
    activity: scanned.messages.map((message) => {
      const isNew = Number(message.ts) > since;
      const replies = scanned.updates[message.ts] ?? [];
      const extra = [...message.attachments, ...message.files].join(" | ");
      const lines = [
        `${isNew ? "New thread" : replies.length ? "Earlier thread with new replies" : "Updated earlier thread"} started ${day(Number(message.ts))} by ${who(message.user, message.userName, users)}: ${message.text}${extra ? ` [${extra}]` : ""}`,
        ...(isNew ? [] : [`(${Math.max(0, message.replyCount - replies.length)} earlier replies retained in the thread index)`]),
        ...replies.map((reply) => `- ${who(reply.user, reply.userName, users)} (${day(Number(reply.ts))}): ${reply.text}`),
      ];
      return { ref: `${ch.name}/${message.ts}`, url: permalink(ch.id, message.ts), text: `#${ch.name}\n${lines.join("\n")}` };
    }),
  };
}

interface Pr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  state: string;
  body: string;
}

/** Read every updated PR. GitHub's 1,000-result search ceiling is handled by subdividing the checkpoint range. */
async function repoActivity(repo: string, since: number, now: number): Promise<Activity[]> {
  const prs = await runCode<Pr[]>(`
interface RawPr { number: number; title: string; html_url: string; user?: { login?: string }; created_at: string; updated_at?: string; state: string; draft?: boolean; body?: string | null }
interface SearchPage { items?: RawPr[]; total_count?: number; incomplete_results?: boolean }
const [owner, repo] = ${lit(repo)}.split('/');
const out = new Map<number, RawPr>();
const read = async (from: number, to: number): Promise<void> => {
  const range = 'updated:' + new Date(from * 1000).toISOString() + '..' + new Date(to * 1000).toISOString();
  let count: number | undefined;
  let received = 0;
  for (let page = 1; ; page++) {
    const result = (await github.search_pull_requests(range, { owner, repo, perPage: 100, page, sort: 'updated', order: 'asc' })) as unknown as SearchPage;
    if (!Array.isArray(result.items) || result.incomplete_results) throw new Error('GitHub returned an incomplete PR search for ' + ${lit(repo)});
    if (page === 1) {
      count = result.total_count;
      if (count !== undefined && count > 1000) {
        const mid = Math.floor((from + to) / 2);
        if (mid <= from || mid >= to) throw new Error('GitHub PR search exceeds 1000 results at one timestamp for ' + ${lit(repo)});
        await read(from, mid);
        await read(mid, to);
        return;
      }
    }
    for (const pr of result.items) out.set(pr.number, pr);
    received += result.items.length;
    if (count !== undefined && received >= count) return;
    if (result.items.length < 100) {
      if (count !== undefined && received < count) throw new Error('GitHub PR pagination ended early for ' + ${lit(repo)});
      return;
    }
    if (page >= 10) throw new Error('GitHub PR pagination did not finish for ' + ${lit(repo)});
  }
};
await read(${lit(Math.floor(since))}, ${lit(now)});
return [...out.values()].map((pr) => ({
  repo: ${lit(repo)}, number: pr.number, title: pr.title, url: pr.html_url, author: pr.user?.login ?? '',
  createdAt: pr.created_at, updatedAt: pr.updated_at ?? pr.created_at,
  state: pr.draft ? 'draft' : pr.state, body: String(pr.body ?? ''),
}));`);
  return prs
    .filter((pr) => Date.parse(pr.updatedAt) / 1000 >= Math.floor(since) && Date.parse(pr.updatedAt) / 1000 <= now)
    .map((pr) => ({
      ref: `${pr.repo}#${pr.number}`,
      url: pr.url,
      text: `PR ${pr.repo}#${pr.number} (${pr.state}) by ${pr.author}, updated ${pr.updatedAt}: ${pr.title}\n${pr.body}`,
    }));
}

/** Vault has no list-pagination parameter: reject truncated responses rather than checkpointing missing content. */
async function vaultActivity(team: string, kind: "projects" | "issues"): Promise<Activity> {
  const text = await runCode<string>(`
const value = await vault.${kind === "projects" ? "get_projects" : "get_issues"}(${lit({ team_id: team, status: kind === "projects" ? "active" : "open", limit: kind === "projects" ? 100 : 200 })});
const text = typeof value === 'string' ? value : JSON.stringify(value);
if (/Results limited to|\\btruncated\\b/i.test(text) || [...text.matchAll(/^\\|\\s*\\d+\\s*\\|/gm)].length >= ${kind === "projects" ? 100 : 200}) {
  throw new Error('Vault returned a truncated ${kind} snapshot for ' + ${lit(team)});
}
return text;`);
  return {
    ref: `vault/${team}/${kind}`,
    url: `https://vault.shopify.io/teams/${team}${kind === "issues" ? "/issues" : ""}`,
    text: `Vault team ${team}: ${kind === "issues" ? "open issues (includes subteams)" : "active GSD projects"}\n${text}`,
  };
}

/**
 * New activity from every source: channels one at a time (parallel sweeps trip Slack's thread-read limit).
 * A source that fails after the gateway's retries is skipped and reported in `failed`, so one rate-limited channel
 * doesn't cost the rest of the sweep.
 */
async function collectActivity(
  state: WatchState,
  now: number,
  users: Record<string, UserInfo>,
  failed: Sweep["failed"],
): Promise<{ activity: Activity[]; channels: Record<string, SlackChannelState>; snapshots: Record<string, string> }> {
  const channels = { ...state.channels };
  const snapshots = { ...state.snapshots };
  const activity: Activity[] = [];
  const attempt = async (key: string, label: string, fn: () => Promise<Activity[]>) => {
    throwIfAborted();
    try {
      activity.push(...(await fn()));
    } catch (err) {
      throwIfAborted();
      console.error(`watch: skipped ${label}: ${safeMessage(err).split("\n").pop()}`);
      failed.push({ key, label });
    }
  };
  for (const channel of WATCH.channels) {
    const key = `slack:${channel.id}`;
    await attempt(key, `#${channel.name}`, async () => {
      const scanned = await channelActivity(channel, state.cursors[key] ?? 0, now, users, channels[key]);
      channels[key] = scanned.state;
      return scanned.activity;
    });
  }
  for (const repo of WATCH.repos) {
    const key = `github:${repo}`;
    await attempt(key, repo, async () => {
      const found = await repoActivity(repo, state.cursors[key] ?? 0, now);
      return found.filter((activity) => {
        const snapshotKey = `github:${activity.ref}`;
        if (snapshots[snapshotKey] === activity.text) return false;
        snapshots[snapshotKey] = activity.text;
        return true;
      });
    });
  }
  for (const kind of ["projects", "issues"] as const) {
    const teams = kind === "projects" ? WATCH.vault.projectTeams : WATCH.vault.issueTeams;
    for (const team of teams) {
      const key = `vault:${kind}:${team}`;
      await attempt(key, `Vault ${team} ${kind}`, async () => {
        const snapshot = await vaultActivity(team, kind);
        if (snapshots[key] === snapshot.text) return [];
        snapshots[key] = snapshot.text;
        return [snapshot];
      });
    }
  }
  return { activity, channels, snapshots };
}

// ---- judging ---------------------------------------------------------------------------------------------------

const SYSTEM = `You scout engineering opportunities for the reader, a senior engineer on ExP (Shopify's Experiments
Platform: experiments, feature flags and the Verdict SDKs, bandits, the experiments dashboard, exp-data-plane,
exp-stats, ExP agentic tooling). The reader wants a big, high-impact project to own, inside ExP or connecting ExP with
the rest of their skip-level manager's org. The reader builds with AI coding agents, so effort is never a constraint:
never estimate, weigh or mention effort, duration or size in time.

You get new activity since the last sweep (Slack threads, PRs, Vault snapshots) and what ExP already knows about.
Find problems the activity shows that nobody has taken: recurring pain or alerts, parked or deferred scope, designs
without a builder, unanswered asks to ExP, incident follow-ups without an owner, leader asks without a named owner,
and other teams needing experiments, flags, metrics or bandits with no ExP path.

For each opportunity:
- ask (1-5): how big the problem is, by reach and stakes. 5: an org-level goal, leadership asking for it, or broken
  experiment trust or merchant impact across many teams. 4: recurring cost across teams, or a platform gap blocking a
  strategic project. 3: one team's recurring pain. 2: a local annoyance. 1: trivial. askWhy: at most 15 words naming
  the reach and stakes.
- Exactly three distinct solutions, from the most direct fix to the most ambitious credible approach. Each:
  idea: at most 14 words, concrete (what gets built, on which system). No filler.
  fit (1-5): technically sound and consistent with ExP's architecture and the direction stated in the activity.
  buyIn (1-5): how likely the owners and team accept it, given who owns the area, what leaders said, and objections
  raised in the threads.
  ambition (1-5): how impactful, agentic and big. 5: removes the whole class of problem, or turns a manual workflow
  into an autonomous agent or system used across teams. 4: a new platform capability several teams use. 3: a solid
  feature for one team. 2: a fix. 1: a workaround.
- owner: "unowned" when nobody took it, "partly_owned" when someone owns a piece but the main problem is open. Skip
  work someone clearly owns, including the reader's own.
- title at most 8 words. problem at most 15 words: what is broken or missing and who it hurts.
- key: short stable kebab-case naming the underlying problem. Reuse the key of an already reported opportunity when it
  is the same one.
- evidence: cite each ref exactly as given, with a verbatim quote of at most 25 words. No evidence, no opportunity.

Skip routine traffic: review or approval requests, deploy notices, how-to questions answered in the thread, social
posts, bot alerts that fired once and resolved. Return an empty list when nothing qualifies.`;

// Structured output rejects numeric bounds; the 1-5 range is in the prompt.
const SCORE = { type: "integer" };

const SCHEMA = {
  type: "object",
  required: ["opportunities"],
  properties: {
    opportunities: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "title", "problem", "owner", "ask", "askWhy", "solutions", "evidence"],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          problem: { type: "string" },
          owner: { type: "string", enum: ["unowned", "partly_owned"] },
          ask: SCORE,
          askWhy: { type: "string" },
          solutions: {
            type: "array",
            items: {
              type: "object",
              required: ["idea", "fit", "buyIn", "ambition"],
              properties: { idea: { type: "string" }, fit: SCORE, buyIn: SCORE, ambition: SCORE },
            },
          },
          evidence: {
            type: "array",
            items: {
              type: "object",
              required: ["ref", "quote"],
              properties: { ref: { type: "string" }, quote: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

type Judged = Omit<Opportunity, "evidence"> & { evidence: { ref: string; quote: string }[] };

function context(since: number, problems: Problem[], leaders: Leaders, reported: WatchState["reported"]): string {
  const list = (items: string[]) => (items.length ? items.join("\n") : "(none)");
  return [
    `# Reader\nSlack ${CONFIG.me.slackId}. Management chain, top down:\n${list(leaders.chain.map((c) => `- ${c.name}: ${c.title}`))}`,
    `# Leadership priorities\n${list(leaders.priorities.map((p) => `- ${p.theme}: ${p.description}`))}`,
    `# Known ExP problems\n${list(problems.map((p) => `- [${p.kind}] ${p.title}: ${p.summary}`))}`,
    `# Already reported opportunities\n${list(Object.entries(reported).map(([key, r]) => `- ${key}: ${r.title}`))}`,
    `# New activity (since ${new Date(since * 1000).toISOString()})`,
  ].join("\n\n");
}

/** Split activity into prompt-sized chunks, keeping each item whole. */
function chunk(items: Activity[]): Activity[][] {
  const out: Activity[][] = [];
  let size = Infinity;
  for (const it of items) {
    if (size + it.text.length > WATCH_LIMITS.chunkChars) {
      out.push([]);
      size = 0;
    }
    out[out.length - 1].push(it);
    size += it.text.length;
  }
  return out;
}

const solutionRank = (s: Solution) => s.fit + s.buyIn;

async function judge(activity: Activity[], header: string): Promise<Opportunity[]> {
  const urls = new Map(activity.map((a) => [a.ref, a.url]));
  const found = await inBatches(chunk(activity), 1, async ([items]) => {
    const res = await structured<{ opportunities: Judged[] }>({
      system: SYSTEM,
      user: `${header}\n\n${items.map((a) => `<activity ref="${a.ref}">\n${a.text}\n</activity>`).join("\n\n")}`,
      schema: SCHEMA,
    });
    return res.opportunities;
  });
  // Evidence must point at activity we sent; an opportunity left without any is dropped.
  return found.flatMap((o) => {
    const evidence = o.evidence.flatMap((e) => {
      const url = urls.get(e.ref);
      return url ? [{ ...e, url }] : [];
    });
    // Exactly three are asked for; the schema can't enforce a count.
    const solutions = [...o.solutions].sort((a, b) => solutionRank(b) - solutionRank(a) || b.ambition - a.ambition).slice(0, 3);
    return evidence.length && solutions.length ? [{ ...o, evidence, solutions }] : [];
  });
}

// ---- sweep + selection -----------------------------------------------------------------------------------------

/** Sweep every source and judge all new activity. Commit checkpoints only after the findings are published. */
export async function sweep(state: WatchState, problems: Problem[], leaders: Leaders, now: number): Promise<Sweep> {
  throwIfAborted();
  const users: Record<string, UserInfo> = {
    ...readJson<Record<string, UserInfo>>(PATHS.users, {}),
    ...Object.fromEntries(leaders.chain.filter((c) => c.slackId).map((c) => [c.slackId, { name: c.name, title: c.title, at: leaders.refreshedAt }])),
  };
  const failed: Sweep["failed"] = [];
  const { activity, channels, snapshots } = await timed("watch sources", () => collectActivity(state, now, users, failed));
  const since = Math.min(now, ...SOURCE_KEYS.map((k) => state.cursors[k] ?? 0));
  const found = activity.length
    ? await timed(`watch judge (${activity.length})`, () => judge(activity, context(since, problems, leaders, state.reported)))
    : [];
  return { at: now, scanned: activity.length, found, failed, channels, snapshots };
}

/** Ambition of the biggest solution the team could plausibly accept; 0 when none is credible. */
const bigCredible = (o: Opportunity): number => {
  let ambition = 0;
  for (const solution of o.solutions) {
    if (solution.fit >= WATCH_LIMITS.minCredible && solution.buyIn >= WATCH_LIMITS.minCredible) {
      ambition = Math.max(ambition, solution.ambition);
    }
  }
  return ambition;
};

/**
 * Merge a sweep's opportunities by key and keep the big ones: ask ≥ minAsk and a credible solution (fit and buy-in
 * ≥ minCredible) with ambition ≥ minAmbition. Each is reported once, again only after its evidence grows by CONFIG.resurfaceFactor.
 * Returns every qualifying pick (biggest first) and the updated ledger.
 */
export function selectOpportunities(
  found: Opportunity[],
  reported: WatchState["reported"],
  date: string,
): { picked: Picked[]; reported: WatchState["reported"] } {
  const merged = new Map<string, Opportunity>();
  for (const o of found) {
    const prev = merged.get(o.key);
    merged.set(o.key, prev ? { ...(o.ask > prev.ask ? o : prev), evidence: [...prev.evidence, ...o.evidence] } : o);
  }
  const next = { ...reported };
  const candidates: Picked[] = [];
  for (const o of merged.values()) {
    if (o.ask < WATCH_LIMITS.minAsk || bigCredible(o) < WATCH_LIMITS.minAmbition) continue;
    const prev = reported[o.key];
    if (!prev) {
      candidates.push({ ...o, resurfaced: false });
      continue;
    }
    const seen = prev.seen + o.evidence.length;
    next[o.key] = { ...prev, seen };
    if (seen >= prev.atReport * CONFIG.resurfaceFactor) candidates.push({ ...o, resurfaced: true });
  }
  const picked = candidates.sort((a, b) => b.ask - a.ask || bigCredible(b) - bigCredible(a));
  for (const o of picked) {
    const seen = next[o.key]?.seen ?? o.evidence.length;
    next[o.key] = { title: o.title, date, seen, atReport: seen };
  }
  return { picked, reported: next };
}

/** Advance successful sources' cursors and store the ledger. */
export function commitSweep(state: WatchState, s: Sweep, reported: WatchState["reported"]): void {
  const failed = new Set(s.failed.map((f) => f.key));
  for (const key of SOURCE_KEYS) if (!failed.has(key)) state.cursors[key] = Math.max(state.cursors[key] ?? 0, s.at);
  writeJson(PATHS.watchState, { ...state, reported, channels: s.channels ?? state.channels ?? {}, snapshots: s.snapshots ?? state.snapshots ?? {} });
}
