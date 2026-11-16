// Opportunity watch, folded into the daily digest: sweeps the due WATCH groups (Slack threads, GitHub PRs, Vault) for
// unowned ExP problems, has the LLM rate each ask and propose three ranked solutions, and keeps only big asks with
// a big solution the team could plausibly accept.
import { CONFIG, PATHS, WATCH, WATCH_LIMITS, radarDate, type WatchGroup } from "./config";
import { lit, runCode } from "./gateway";
import type { Leaders } from "./leaders";
import { inBatches, structured } from "./llm";
import { timed } from "./log";
import type { Problem } from "./registry";
import { safeMessage, throwIfAborted } from "./runtime";
import { fetchMessages, fetchThreads, permalink, type Message, type Reply, type UserInfo } from "./slack";
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
}

export interface Sweep {
  at: number;
  groups: string[];
  scanned: number;
  found: Opportunity[];
  /** Source labels that failed (e.g. rate-limited); their cursors stay put so the next run retries them. */
  failed: { key: string; label: string }[];
}

export const loadWatchState = (): WatchState => ({ cursors: {}, reported: {}, ...readJson<Partial<WatchState>>(PATHS.watchState, {}) });

const sourceKeys = (g: WatchGroup) => [...g.channels.map((c) => `slack:${c.id}`), ...g.repos.map((r) => `github:${r}`)];

/** Groups with a source last swept at least `everyDays` ago (less a grace period for schedule jitter). */
export function dueGroups(groups: WatchGroup[], cursors: WatchState["cursors"], now: number): WatchGroup[] {
  return groups.filter((g) => {
    const cadence = g.everyDays * 86_400 - WATCH_LIMITS.dueGraceHours * 3600;
    return sourceKeys(g).some((k) => now - (cursors[k] ?? 0) >= cadence);
  });
}

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

/** Threads in the channel that started or got replies after `since`; new threads come with their first replies. */
async function channelActivity(
  ch: WatchGroup["channels"][number],
  since: number,
  now: number,
  windowDays: number,
  users: Record<string, UserInfo>,
): Promise<Activity[]> {
  const msgs = await fetchMessages(ch.id, Math.floor(now - windowDays * 86_400), { includeBots: ch.includeBots });
  const fresh = msgs.filter((m) => Number(m.ts) > since);
  // Slack rate-limits thread reads, so only the most recently active threads are opened; a revived thread that
  // isn't opened has nothing new to show and is left for the next sweep.
  const active = (m: Message) => Number(m.latestReply ?? 0);
  const open = new Set(
    msgs
      .filter((m) => active(m) > since)
      .sort((a, b) => active(b) - active(a))
      .slice(0, WATCH_LIMITS.maxThreadsPerChannel)
      .map((m) => m.ts),
  );
  const revived = msgs.filter((m) => Number(m.ts) <= since && open.has(m.ts));
  const limit = WATCH_LIMITS.maxRepliesPerThread;
  const freshReplies = await fetchThreads(ch.id, fresh.filter((m) => open.has(m.ts)).map((m) => m.ts), { limit });
  const newReplies = await fetchThreads(ch.id, revived.map((m) => m.ts), { limit, oldest: since.toFixed(6) });
  const replies = { ...freshReplies, ...newReplies };
  const render = (m: Message, isNew: boolean): Activity => {
    const thread: Reply[] = replies[m.ts] ?? [];
    // Bot posts (alerts) only need their headline; people's posts keep their substance.
    const body = m.text.slice(0, m.user.startsWith("B") ? 400 : 1500);
    const extra = [...m.attachments, ...m.files].join(" | ").slice(0, 400);
    const lines = [
      `${isNew ? "New thread" : "Earlier thread with new replies"} started ${day(Number(m.ts))} by ${who(m.user, m.userName, users)}: ${body}${extra ? ` [${extra}]` : ""}`,
      ...(isNew ? [] : [`(${m.replyCount - thread.length} earlier replies not shown)`]),
      ...thread.map((r) => `- ${who(r.user, r.userName, users)} (${day(Number(r.ts))}): ${r.text}`),
    ];
    return { ref: `${ch.name}/${m.ts}`, url: permalink(ch.id, m.ts), text: `#${ch.name}\n${lines.join("\n")}` };
  };
  return [...fresh.map((m) => render(m, true)), ...revived.map((m) => render(m, false))];
}

interface Pr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  state: string;
  body: string;
}

/** PRs opened after `since` in each repo, with the start of their descriptions. */
async function repoActivity(repos: string[], since: number): Promise<Activity[]> {
  if (repos.length === 0) return [];
  const prs = await runCode<Pr[]>(`
interface RawPr { number: number; title: string; html_url: string; user?: { login?: string }; created_at: string; state: string; draft?: boolean; body?: string | null }
const out: { repo: string; number: number; title: string; url: string; author: string; createdAt: string; state: string; body: string }[] = [];
for (const full of ${lit(repos)} as string[]) {
  const [owner, repo] = full.split('/');
  const r = (await github.search_pull_requests(${lit(`created:>=${day(since)}`)}, { owner, repo, perPage: ${WATCH_LIMITS.maxPrsPerRepo}, sort: 'created', order: 'desc' })) as unknown as { items?: RawPr[] };
  for (const p of r.items ?? []) out.push({
    repo: full, number: p.number, title: p.title, url: p.html_url, author: p.user?.login ?? '', createdAt: p.created_at,
    state: p.draft ? 'draft' : p.state, body: String(p.body ?? '').slice(0, 1500),
  });
}
return out;`);
  return prs
    .filter((p) => Date.parse(p.createdAt) / 1000 > since)
    .map((p) => ({
      ref: `${p.repo}#${p.number}`,
      url: p.url,
      text: `PR ${p.repo}#${p.number} (${p.state}) by ${p.author}, opened ${p.createdAt.slice(0, 10)}: ${p.title}\n${p.body}`,
    }));
}

/** Active GSD projects and open issues for the configured Vault teams, as a snapshot. */
async function vaultActivity({ projectTeams, issueTeams }: WatchGroup["vault"]): Promise<Activity[]> {
  if (projectTeams.length + issueTeams.length === 0) return [];
  const snaps = await runCode<{ team: string; kind: "projects" | "issues"; text: string }[]>(`
const str = (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x));
return await Promise.all([
  ...(${lit(projectTeams)} as string[]).map(async (team) => ({
    team, kind: 'projects', text: str(await vault.get_projects({ team_id: team, status: 'active', limit: 50 })).slice(0, 15000),
  })),
  ...(${lit(issueTeams)} as string[]).map(async (team) => ({
    team, kind: 'issues', text: str(await vault.get_issues({ team_id: team, status: 'open', limit: 200 })).slice(0, 40000),
  })),
]);`);
  return snaps.map((s) => ({
    ref: `vault/${s.team}/${s.kind}`,
    url: `https://vault.shopify.io/teams/${s.team}${s.kind === "issues" ? "/issues" : ""}`,
    text: `Vault team ${s.team}: ${s.kind === "issues" ? "open issues (includes subteams)" : "active GSD projects"}\n${s.text}`,
  }));
}

/**
 * New activity from one group's sources: channels one at a time (parallel sweeps trip Slack's thread-read limit).
 * A source that fails after the gateway's retries is skipped and reported in `failed`, so one rate-limited channel
 * doesn't cost the rest of the sweep.
 */
async function groupActivity(
  g: WatchGroup,
  cursors: WatchState["cursors"],
  now: number,
  users: Record<string, UserInfo>,
  failed: Sweep["failed"],
): Promise<Activity[]> {
  const since = (key: string) => Math.max(cursors[key] ?? 0, now - g.maxLookbackHours * 3600);
  const out: Activity[] = [];
  const attempt = async (keys: string[], label: string, fn: () => Promise<Activity[]>) => {
    throwIfAborted();
    try {
      out.push(...(await fn()));
    } catch (err) {
      throwIfAborted();
      console.error(`watch: skipped ${label}: ${safeMessage(err).split("\n").pop()}`);
      failed.push(...keys.map((key) => ({ key, label })));
    }
  };
  for (const c of g.channels) {
    const key = `slack:${c.id}`;
    await attempt([key], `#${c.name}`, () => channelActivity(c, since(key), now, g.threadWindowDays, users));
  }
  // One shared cutoff for the group's repos: the oldest repo cursor (they are searched together).
  if (g.repos.length) {
    const keys = g.repos.map((r) => `github:${r}`);
    await attempt(keys, "GitHub PRs", () => repoActivity(g.repos, Math.min(...keys.map(since))));
  }
  await attempt([], "Vault", () => vaultActivity(g.vault));
  return out;
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

/** Sweep every due group and judge the new activity together. Commit with `commitSweep` once delivered. */
export async function sweep(state: WatchState, problems: Problem[], leaders: Leaders, now: number, allGroups = false): Promise<Sweep> {
  throwIfAborted();
  const due = allGroups ? WATCH : dueGroups(WATCH, state.cursors, now);
  const users: Record<string, UserInfo> = {
    ...readJson<Record<string, UserInfo>>(PATHS.users, {}),
    ...Object.fromEntries(leaders.chain.filter((c) => c.slackId).map((c) => [c.slackId, { name: c.name, title: c.title, at: leaders.refreshedAt }])),
  };
  const activity: Activity[] = [];
  const failed: Sweep["failed"] = [];
  for (const g of due) activity.push(...(await timed(`watch ${g.name}`, () => groupActivity(g, state.cursors, now, users, failed))));
  const since = Math.min(now, ...due.flatMap(sourceKeys).map((k) => state.cursors[k] ?? 0));
  const found = activity.length
    ? await timed(`watch judge (${activity.length})`, () => judge(activity, context(since, problems, leaders, state.reported)))
    : [];
  return { at: now, groups: due.map((g) => g.name), scanned: activity.length, found, failed };
}

/** Ambition of the biggest solution the team could plausibly accept; 0 when none is credible. */
const bigCredible = (o: Opportunity) =>
  Math.max(0, ...o.solutions.filter((s) => s.fit >= WATCH_LIMITS.minCredible && s.buyIn >= WATCH_LIMITS.minCredible).map((s) => s.ambition));

/**
 * Merge a sweep's opportunities by key and keep the big ones: ask ≥ minAsk and a credible solution (fit and buy-in
 * ≥ minCredible) with ambition ≥ minAmbition. Each is delivered once, again only after its evidence grows by CONFIG.resurfaceFactor.
 * Returns the picks (biggest first, capped) and the updated ledger.
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
  const picked = candidates
    .sort((a, b) => b.ask - a.ask || bigCredible(b) - bigCredible(a))
    .slice(0, WATCH_LIMITS.maxItems);
  for (const o of picked) {
    const seen = next[o.key]?.seen ?? o.evidence.length;
    next[o.key] = { title: o.title, date, seen, atReport: seen };
  }
  return { picked, reported: next };
}

/** Forget today's Toronto cursors for an in-memory redo/preview; commit them only after successful delivery. */
export function rewindToday(state: WatchState): void {
  const today = radarDate();
  for (const [key, at] of Object.entries(state.cursors)) if (radarDate(new Date(at * 1000)) >= today) delete state.cursors[key];
}

/** Advance the swept groups' cursors and store the ledger. */
export function commitSweep(state: WatchState, s: Sweep, reported: WatchState["reported"]): void {
  const swept = WATCH.filter((g) => s.groups.includes(g.name));
  const failed = new Set(s.failed.map((f) => f.key));
  for (const key of swept.flatMap(sourceKeys)) if (!failed.has(key)) state.cursors[key] = s.at;
  writeJson(PATHS.watchState, { ...state, reported });
}
