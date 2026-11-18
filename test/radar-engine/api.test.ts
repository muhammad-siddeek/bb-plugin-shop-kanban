import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CONFIG, WATCH, radarDate } from "../../host/radar/config";
import { GatewayError } from "../../host/radar/gateway";
import { executeRadar, normalizeDigest, type Digest } from "../../host/radar/index";
import type { State } from "../../host/radar/pipeline";
import { withRadarContext } from "../../host/radar/runtime";
import { fetchMessages, fetchThreads, resolveUsers, scanChannel, type Message } from "../../host/radar/slack";
import { commitSweep, loadWatchState, selectOpportunities, sweep, type WatchState } from "../../host/radar/watch";

const originalFetch = globalThis.fetch;
const originalGatewayToken = process.env.TOOL_GATEWAY_TOKEN;
const originalLlmToken = process.env.LLM_PROXY_TOKEN;
let directories: string[] = [];
let dataDir: string;

function temporaryStore(): string {
  const path = mkdtempSync(join(tmpdir(), "radar-api-"));
  directories.push(path);
  return path;
}

function fixture(name: string, value: unknown, directory = dataDir): void {
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readFixture<T>(name: string, directory = dataDir): T {
  return JSON.parse(readFileSync(join(directory, name), "utf8")) as T;
}

function seed(state: Partial<State> = {}, directory = dataDir): State {
  const initial: State = { lastRunDate: "", classified: {}, reported: {}, items: {}, ...state };
  fixture("state.json", initial, directory);
  fixture("registry.json", { refreshedAt: new Date().toISOString(), problems: [] }, directory);
  fixture("leaders.json", { refreshedAt: new Date().toISOString(), chain: [], priorities: [] }, directory);
  fixture("users.json", {}, directory);
  fixture("watch-state.json", { cursors: {}, reported: {} }, directory);
  return initial;
}

function digest(): Digest {
  return {
    date: radarDate(),
    generatedAt: new Date().toISOString(),
    scanned: 10,
    qualified: 1,
    pairings: [],
    others: [{
      id: "sample-1",
      ts: "1794834000.000001",
      ideaKey: "durable-agents",
      permalink: `${CONFIG.slackHost}/archives/${CONFIG.channel.id}/p1794834000000001`,
      category: "new_tech",
      title: "Durable agents",
      summary: "Full findings, not just the card title.",
      whatIsNew: "Agents survive restarts.",
      author: "Author",
      links: ["https://example.com/findings"],
      leadership: { score: 0.5, reasons: ["leader replied"], headline: "leader replied" },
      engagement: { reactors: 4, replyUsers: 2 },
      confirmations: 2,
      traction: 0.6,
      resurfaced: false,
    }],
    backlog: [],
    watch: {
      scanned: 3,
      skipped: [],
      opportunities: [{
        key: "repeated-alerts",
        title: "Remove recurring alert toil",
        problem: "Repeated alerts interrupt several teams.",
        owner: "unowned",
        ask: 5,
        askWhy: "Several teams lose trust in alerts.",
        solutions: [
          { idea: "Repair the alert query", fit: 5, buyIn: 5, ambition: 2 },
          { idea: "Build shared alert validation", fit: 4, buyIn: 4, ambition: 4 },
          { idea: "Build an autonomous alert investigator", fit: 3, buyIn: 3, ambition: 5 },
        ],
        evidence: [{ ref: "help/123", quote: "This keeps happening", url: `${CONFIG.slackHost}/archives/C123/p123` }],
        resurfaced: false,
      }],
    },
  };
}

const context = (directory = dataDir, signal = new AbortController().signal) => ({ dataDir: directory, signal });

interface RawMessage {
  ts: string;
  user: string;
  text: string;
  reply_count?: number;
  reply_users?: string[];
  reactions?: { name: string; count: number; users: string[] }[];
  latest_reply?: string;
}

interface RawPr {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  state: string;
  body: string;
}

function rawMessage(ts: number, text = "A reusable new engineering technique"): RawMessage {
  return { ts: ts.toFixed(6), user: "U1", text, reactions: [{ name: "eyes", count: 2, users: ["U2", "U3"] }] };
}

function services() {
  const service = {
    history: {} as Record<string, RawMessage[]>,
    replies: {} as Record<string, RawMessage[]>,
    prs: {} as Record<string, RawPr[]>,
    failedChannels: new Set<string>(),
    missingChannelCursors: new Set<string>(),
    projects: "No active projects",
    issues: "No open issues",
    chain: "**Organizational Chart:**\n",
    contributions: {} as Record<string, string>,
    generateOpportunities: false,
    incompleteClassification: false,
    failWatchJudge: false,
    channelReads: [] as { channel: string; oldest: string; cursor?: string }[],
    threadReads: [] as { channel: string; parent: string; oldest?: string; cursor?: string }[],
    prReads: [] as { repo: string; query: string; page: number }[],
    contributionReads: [] as { user: string; start_date: string; end_date: string }[],
    modelCalls: [] as { system: string; user: string }[],
    registryUpdates: [] as { upserts: object[]; removed: string[] }[],
    programs: [] as string[],
    throttle: 0,
    cooldownMs: 0,
    blockedUntil: 0,
    slackCalls: 0,
  };
  const throttled = () => {
    if (service.throttle && service.slackCalls++ % (service.throttle + 1) !== service.throttle) throw new Error("ratelimited");
    if (Date.now() < service.blockedUntil) throw new Error('{"ok":false,"error":"rate_limited","status":429}');
    service.blockedUntil = Date.now() + service.cooldownMs;
  };
  const slack = {
    read_channel: async (channel: string, options: { oldest: string; latest?: string; limit: number; cursor?: string }) => {
      throttled();
      service.channelReads.push({ channel, oldest: options.oldest, cursor: options.cursor });
      if (service.failedChannels.has(channel)) throw new Error("source unavailable");
      if (service.missingChannelCursors.has(channel)) return { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "" } };
      const rows = (service.history[channel] ?? [])
        .filter((message) => Number(message.ts) > Number(options.oldest) && Number(message.ts) <= Number(options.latest ?? Infinity))
        .sort((a, b) => Number(b.ts) - Number(a.ts));
      const offset = Number(options.cursor ?? 0);
      const next = offset + options.limit;
      return { ok: true, messages: rows.slice(offset, next), has_more: next < rows.length, response_metadata: { next_cursor: next < rows.length ? String(next) : "" } };
    },
    read_thread: async (channel: string, parent: string, options: { oldest?: string; latest?: string; limit: number; cursor?: string }) => {
      throttled();
      service.threadReads.push({ channel, parent, oldest: options.oldest, cursor: options.cursor });
      if (service.failedChannels.has(channel)) throw new Error("source unavailable");
      const rows = [
        ...(service.history[channel] ?? []).filter((message) => message.ts === parent),
        ...(service.replies[`${channel}:${parent}`] ?? []),
      ].filter((message) => Number(message.ts) > Number(options.oldest ?? 0) && Number(message.ts) <= Number(options.latest ?? Infinity))
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      const offset = Number(options.cursor ?? 0);
      const next = offset + options.limit;
      return { ok: true, messages: rows.slice(offset, next), has_more: next < rows.length, response_metadata: { next_cursor: next < rows.length ? String(next) : "" } };
    },
    read_user_profile: async () => {
      throttled();
      return "Real Name: Engineer\nTitle: Software Engineer";
    },
  };
  const vault = {
    get_team: async () => "ExP owns experiments and feature flags.",
    get_projects: async () => service.projects,
    get_project: async () => "Full active project context.",
    get_issues: async () => service.issues,
    get_issue: async () => { throw new Error("Unexpected issue read"); },
    get_current_user: async () => service.chain,
    get_user: async () => "Slack ID: ULEADER",
    get_user_contributions: async (user: string, options: { start_date: string; end_date: string }) => {
      service.contributionReads.push({ user, ...options });
      return service.contributions[user] ?? "No new contributions";
    },
  };
  const github = {
    search_pull_requests: async (query: string, options: { owner: string; repo: string; page: number; perPage: number }) => {
      const repo = `${options.owner}/${options.repo}`;
      service.prReads.push({ repo, query, page: options.page });
      const [from, to] = query.slice("updated:".length).split("..").map(Date.parse);
      const rows = (service.prs[repo] ?? []).filter((pr) => Date.parse(pr.updated_at) >= from && Date.parse(pr.updated_at) <= to);
      const offset = (options.page - 1) * options.perPage;
      return { total_count: rows.length, incomplete_results: false, items: rows.slice(offset, offset + options.perPage) };
    },
  };
  globalThis.fetch = async (url, init) => {
    let value: unknown;
    if (String(url) === "https://tool-gateway.shopify.io/codemode/mcp") {
      const { params } = JSON.parse(String(init?.body)) as { params: { arguments: { code: string } } };
      service.programs.push(params.arguments.code);
      const program = new Function("slack", "vault", "github", `return ${stripTypeScriptTypes(`(async () => {${params.arguments.code}})()`)}`);
      value = await program(slack, vault, github);
      let text = typeof value === "string" ? value : JSON.stringify(value);
      if (text.length > 1_000_000) text = `${text.slice(0, 1_000_000)}\n[stdout truncated]`;
      return new Response(JSON.stringify({ result: { content: [{ type: "text", text }] } }), { headers: { "Content-Type": "application/json" } });
    }
    assert.equal(String(url), "https://proxy.shopify.ai/apis/anthropic/v1/messages");
    const request = JSON.parse(String(init?.body)) as { system: string; messages: { content: string }[] };
    const user = request.messages[0].content;
    service.modelCalls.push({ system: request.system, user });
    if (request.system.includes("You maintain a problem registry")) {
      value = service.registryUpdates.shift() ?? { upserts: [], removed: [] };
    } else if (request.system.includes("You maintain what Shopify leadership")) {
      value = { upserts: [], removed: [] };
    } else if (request.system.includes("You triage messages")) {
      value = {
        items: service.incompleteClassification ? [] : [...user.matchAll(/<message ts="([^"]+)"/g)].map((match) => ({
          ts: match[1], category: "new_tech", confidence: 0.95, ideaKey: `technique-${match[1]}`, title: `Technique ${match[1]}`,
          summary: "A reusable engineering technique", whatIsNew: "A new approach", confirmations: 1, links: [], priorityIds: [],
        })),
      };
    } else if (request.system.includes("You pair new AI tech")) {
      value = { items: [...user.matchAll(/<idea ts="([^"]+)"/g)].map((match) => ({ ts: match[1], problemId: "none", strength: 0, why: "", tryThis: "" })) };
    } else {
      assert.match(request.system, /You scout engineering opportunities/);
      if (service.failWatchJudge) throw new Error("watch judge unavailable");
      value = {
        opportunities: service.generateOpportunities
          ? [...user.matchAll(/<activity ref="([^"]+)"/g)].filter((match) => !match[1].startsWith("vault/")).map((match) => ({
              key: match[1].replace(/[^a-z0-9]+/gi, "-"), title: `Opportunity ${match[1]}`, problem: "Recurring platform failures", owner: "unowned",
              ask: 5, askWhy: "Affects many teams", solutions: [2, 4, 5].map((ambition) => ({ idea: `Solution ${ambition}`, fit: 4, buyIn: 4, ambition })),
              evidence: [{ ref: match[1], quote: "Recurring platform failures" }],
            }))
          : [],
      };
    }
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }] }), { headers: { "Content-Type": "application/json" } });
  };
  return service;
}

beforeEach(() => {
  dataDir = temporaryStore();
  process.env.TOOL_GATEWAY_TOKEN = "radar-api-test-gateway-token";
  process.env.LLM_PROXY_TOKEN = "radar-api-test-llm-token";
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGatewayToken === undefined) delete process.env.TOOL_GATEWAY_TOKEN;
  else process.env.TOOL_GATEWAY_TOKEN = originalGatewayToken;
  if (originalLlmToken === undefined) delete process.env.LLM_PROXY_TOKEN;
  else process.env.LLM_PROXY_TOKEN = originalLlmToken;
  for (const path of directories) rmSync(path, { recursive: true, force: true });
  directories = [];
});

test("delivery actions are removed rather than kept as aliases", async () => {
  seed();
  await assert.rejects(executeRadar({ action: "run" } as never, context()), /Unknown Radar action/);
  await assert.rejects(executeRadar({ action: "webhook" } as never, context()), /Unknown Radar action/);
});

test("every scan checks durable source checkpoints even after a same-day snapshot", async () => {
  const today = radarDate();
  const cursor = Date.now() / 1000 - 60;
  const sourceKey = `slack:${CONFIG.channel.id}`;
  const state = seed({
    lastRunDate: today,
    reported: { sent: { ts: "123", title: "Sent", date: today, traction: 0.5 } },
    cursors: { [sourceKey]: cursor, "imported:source": 7 },
    channels: { [sourceKey]: { threads: {} } },
  });
  const sourceCursors = Object.fromEntries([...WATCH.channels.map((channel) => `slack:${channel.id}`), ...WATCH.repos.map((repo) => `github:${repo}`)].map((key) => [key, cursor]));
  fixture("watch-state.json", {
    cursors: { ...sourceCursors, "slack:already-swept": cursor },
    channels: Object.fromEntries(WATCH.channels.map((channel) => [`slack:${channel.id}`, { threads: {} }])),
    reported: { sent: { title: "Sent opportunity", date: today, seen: 2, atReport: 2 } },
  });
  fixture("latest.json", digest());
  const service = services();
  const first = await executeRadar({ action: "scan" }, context());
  assert.equal(first.digest?.scanned, 0);
  assert.deepEqual(readFixture<State>("state.json").reported, state.reported);
  assert.equal(readFixture<State>("state.json").lastRunDate, today);
  assert.equal(readFixture<State>("state.json").cursors?.["imported:source"], 7);
  assert.ok(readFixture<State>("state.json").cursors![sourceKey] > cursor);
  assert.deepEqual(readFixture("latest.json"), first.digest);
  const watch = readFixture<WatchState>("watch-state.json");
  assert.equal(watch.cursors["slack:already-swept"], cursor);
  for (const key of Object.keys(sourceCursors)) assert.ok(watch.cursors[key] > cursor, `${key} was checked despite its recent cursor`);
  assert.deepEqual(watch.reported, { sent: { title: "Sent opportunity", date: today, seen: 2, atReport: 2 } });
  assert.ok(service.channelReads.some((read) => read.channel === CONFIG.channel.id && read.oldest === String(cursor)));
  const calls = service.channelReads.length;
  await executeRadar({ action: "scan" }, context());
  assert.ok(service.channelReads.length > calls);
});

test("failed discovery does not erase imported ledgers, checkpoints or the prior snapshot", async () => {
  const state = seed({
    lastRunDate: radarDate(),
    reported: { sent: { ts: "123", title: "Sent idea", date: radarDate(), traction: 0.5 } },
    cursors: { "slack:old-source": 123 },
  });
  const latest = digest();
  fixture("latest.json", latest);
  globalThis.fetch = async () => { throw new Error("network unavailable"); };
  await assert.rejects(executeRadar({ action: "scan" }, context()), /network unavailable/);
  assert.deepEqual(readFixture("state.json"), state);
  assert.deepEqual(readFixture("latest.json"), latest);
});

test("Slack history and thread reads follow every page across programs without truncating content", async () => {
  const service = services();
  service.history[CONFIG.channel.id] = Array.from({ length: 2105 }, (_, i) => rawMessage(i + 1, "x".repeat(3000)));
  const messages = await withRadarContext(context(), () => fetchMessages(CONFIG.channel.id, 0));
  assert.equal(messages.length, 2105);
  assert.equal(messages[0].text.length, 3000);
  assert.equal(service.channelReads.length, 22);
  const parent = service.history[CONFIG.channel.id][0].ts;
  service.replies[`${CONFIG.channel.id}:${parent}`] = Array.from({ length: 225 }, (_, i) => rawMessage(i + 2, "y".repeat(5000)));
  const threads = await withRadarContext(context(), () => fetchThreads(CONFIG.channel.id, [parent]));
  assert.equal(threads[parent].length, 225);
  assert.equal(threads[parent][224].text.length, 5000);
  assert.equal(service.threadReads.length, 3);
});

test("a source without a thread index builds it from its checkpoint and resumes new replies without an age window", async () => {
  const service = services();
  const now = Date.now() / 1000;
  const since = now - 120 * 86_400;
  const old = rawMessage(now - 500 * 86_400);
  const parent = rawMessage(since + 60);
  service.history[CONFIG.channel.id] = [old, parent];
  service.replies[`${CONFIG.channel.id}:${old.ts}`] = [rawMessage(since + 1, "A reply before the index existed")];
  service.replies[`${CONFIG.channel.id}:${parent.ts}`] = [rawMessage(since + 120, "A new finding")];
  const first = await withRadarContext(context(), () => scanChannel(CONFIG.channel.id, since, now));
  assert.deepEqual(first.messages.map((message) => message.ts), [parent.ts]);
  assert.deepEqual(Object.keys(first.state.threads), [parent.ts]);
  assert.equal(service.channelReads[0].oldest, String(since));
  service.replies[`${CONFIG.channel.id}:${parent.ts}`].push(rawMessage(now + 1, "Another new reply"));
  const second = await withRadarContext(context(), () => scanChannel(CONFIG.channel.id, now, now + 2, first.state));
  assert.equal(service.channelReads.at(-1)?.oldest, String(now));
  assert.equal(service.threadReads.at(-1)?.oldest, String(now));
  assert.deepEqual(second.updates[parent.ts].map((reply) => reply.text), ["Another new reply"]);
  assert.equal(second.state.threads[parent.ts].replies.length, 2);
});

test("briefly throttled Slack calls are retried in place", async () => {
  const service = services();
  service.throttle = 1;
  const now = Date.now() / 1000;
  const parent = rawMessage(now - 60);
  service.history[CONFIG.channel.id] = [parent];
  service.replies[`${CONFIG.channel.id}:${parent.ts}`] = [rawMessage(now - 30, "A throttled reply")];
  const scan = await withRadarContext(context(), () => scanChannel(CONFIG.channel.id, now - 120, now));
  assert.deepEqual(scan.state.threads[parent.ts].replies.map((reply) => reply.text), ["A throttled reply"]);
  const users = await withRadarContext(context(), () => resolveUsers(["U1", "U2", "U3"]));
  assert.deepEqual(["U1", "U2", "U3"].map((id) => users[id]?.title), Array(3).fill("Software Engineer"));
  assert.equal(service.programs.length, 4);
});

async function fastForward<T>(timers: TestContext["mock"]["timers"], p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    await nextTurn();
    timers.tick(1_000);
  }
  return p;
}

test("sustained Slack throttling ends programs early and resumes after a pause; once nothing passes reads fail and profiles wait", async (t) => {
  const { timers } = t.mock;
  timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const service = services();
  service.cooldownMs = 4_000;
  const now = Date.now() / 1000;
  const parents = [rawMessage(now - 90), rawMessage(now - 60)];
  service.history[CONFIG.channel.id] = parents;
  for (const [index, parent] of parents.entries()) {
    service.replies[`${CONFIG.channel.id}:${parent.ts}`] = [rawMessage(now - 30 + index, `Reply ${index}`)];
  }
  const scan = await fastForward(timers, withRadarContext(context(), () => scanChannel(CONFIG.channel.id, now - 120, now)));
  assert.deepEqual(
    parents.map((parent) => scan.state.threads[parent.ts].replies.map((reply) => reply.text)),
    [["Reply 0"], ["Reply 1"]],
  );
  const users = await fastForward(timers, withRadarContext(context(), () => resolveUsers(["U1", "U2", "U3"])));
  assert.deepEqual(["U1", "U2", "U3"].map((id) => users[id]?.title), Array(3).fill("Software Engineer"));
  service.throttle = Infinity;
  const partial = await fastForward(timers, withRadarContext(context(), () => resolveUsers(["U1", "U4"])));
  assert.deepEqual([partial.U1?.title, partial.U4], ["Software Engineer", undefined]);
  await assert.rejects(
    fastForward(timers, withRadarContext(context(), () => scanChannel(CONFIG.channel.id, now - 120, now))),
    (error) => error instanceof GatewayError && error.kind === "ratelimit",
  );
});

test("legacy stores without checkpoints resume where the old engine stopped; a new leader starts 30 days back", async () => {
  const now = Date.now();
  const lastRunDate = radarDate(new Date(now - 3 * 86_400_000));
  const registryAt = new Date(now - 5 * 86_400_000).toISOString();
  const leadersAt = new Date(now - 6 * 86_400_000).toISOString();
  seed({ lastRunDate });
  fixture("registry.json", { refreshedAt: registryAt, problems: [] });
  fixture("leaders.json", { refreshedAt: leadersAt, chain: [], priorities: [] });
  const service = services();
  service.chain = "**Organizational Chart:**\n[Leader](https://vault.shopify.io/users/1): VP\n";
  await executeRadar({ action: "scan" }, context());
  const oldest = (channel: string) => service.channelReads.find((read) => read.channel === channel)?.oldest;
  assert.equal(oldest(CONFIG.channel.id), String(Date.parse(lastRunDate) / 1000));
  assert.equal(oldest(CONFIG.team.channels[0].id), String(Date.parse(registryAt) / 1000));
  assert.equal(service.contributionReads[0].start_date, leadersAt.slice(0, 10));
  const newcomer = "https://vault.shopify.io/users/2";
  service.chain += `[Newcomer](${newcomer}): Director\n`;
  await executeRadar({ action: "refresh" }, context());
  const read = service.contributionReads.find((contribution) => contribution.user === newcomer);
  assert.equal(read?.start_date, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
});

test("technique discovery retains all qualifying historical catch-up items and retries incomplete classification", async () => {
  const now = Date.now() / 1000;
  const sourceKey = `slack:${CONFIG.channel.id}`;
  const state = seed({ cursors: { [sourceKey]: now - 200 * 86_400 } });
  const service = services();
  service.history[CONFIG.channel.id] = Array.from({ length: 31 }, (_, i) => rawMessage(now - 100 * 86_400 + i));
  service.incompleteClassification = true;
  await assert.rejects(executeRadar({ action: "scan" }, context()), /Classification omitted or duplicated/);
  assert.deepEqual(readFixture("state.json"), state);
  assert.equal(existsSync(join(dataDir, "latest.json")), false);
  service.incompleteClassification = false;
  const result = await executeRadar({ action: "scan" }, context());
  assert.equal(result.digest?.others.length, 31);
  const saved = readFixture<State>("state.json");
  assert.equal(Object.keys(saved.reported).length, 31);
  assert.equal(Object.keys(saved.classified).length, 31);
  assert.ok(saved.cursors![sourceKey] > now - 1);
  const calls = service.modelCalls.filter((call) => call.system.includes("You triage messages")).length;
  await executeRadar({ action: "scan" }, context());
  assert.equal(service.modelCalls.filter((call) => call.system.includes("You triage messages")).length, calls);
  assert.equal(Object.keys(readFixture<State>("state.json").classified).length, 31);
});

test("watch retains every qualifying revived thread beyond prior thread and reply caps", async () => {
  const service = services();
  service.generateOpportunities = true;
  const channel = WATCH.channels[0];
  const now = Date.now() / 1000;
  const since = now - 100 * 86_400;
  service.history[channel.id] = Array.from({ length: 26 }, (_, i) => rawMessage(since - 400 * 86_400 + i));
  for (const parent of service.history[channel.id]) {
    service.replies[`${channel.id}:${parent.ts}`] = Array.from({ length: 125 }, (_, i) => rawMessage(since + i + 1, `New evidence ${i}`));
  }
  const threads = Object.fromEntries(service.history[channel.id].map((parent): [string, { message: Message; replies: [] }] => [parent.ts, {
    message: { ts: parent.ts, user: parent.user, userName: "", text: parent.text, replyCount: 0, replyUsers: [], reactions: parent.reactions ?? [], attachments: [], files: [] },
    replies: [],
  }]));
  await withRadarContext(context(), async () => {
    const state: WatchState = { cursors: { [`slack:${channel.id}`]: since }, reported: {}, channels: { [`slack:${channel.id}`]: { threads } } };
    const result = await sweep(state, [], { refreshedAt: "", chain: [], priorities: [] }, now);
    const selection = selectOpportunities(result.found, state.reported, radarDate());
    assert.equal(selection.picked.length, 26);
    assert.equal(service.threadReads.filter((read) => read.channel === channel.id).length, 78);
    const judged = service.modelCalls.find((call) => call.system.includes("You scout engineering opportunities"))!.user;
    assert.match(judged, /New evidence 124/);
    commitSweep(state, result, selection.reported);
    assert.equal(Object.keys(loadWatchState().reported).length, 26);
  });
});

test("PR catch-up uses each durable repo checkpoint, includes old PR updates and partitions the search ceiling", async () => {
  const service = services();
  const repo = WATCH.repos[0];
  const now = Date.now() / 1000;
  const since = now - 200 * 86_400;
  service.prs[repo] = Array.from({ length: 1105 }, (_, i) => ({
    number: i + 1, title: `PR ${i + 1}`, html_url: `https://github.com/${repo}/pull/${i + 1}`,
    created_at: new Date((since - 86_400) * 1000).toISOString(),
    updated_at: new Date((since + i + 1) * 1000).toISOString(),
    state: "open", body: `Full PR body ${i + 1}`,
  }));
  await withRadarContext(context(), async () => {
    const state: WatchState = { cursors: { [`github:${repo}`]: since }, reported: {} };
    const result = await sweep(state, [], { refreshedAt: "", chain: [], priorities: [] }, now);
    assert.equal(result.scanned, 1105 + WATCH.vault.projectTeams.length + WATCH.vault.issueTeams.length);
    const queries = service.prReads.filter((read) => read.repo === repo);
    assert.ok(queries.some((read) => read.page > 1));
    assert.ok(new Set(queries.map((read) => read.query)).size > 1);
    assert.ok(queries[0].query.includes(new Date(Math.floor(since) * 1000).toISOString()));
    const judged = service.modelCalls.filter((call) => call.system.includes("You scout engineering opportunities")).map((call) => call.user).join("\n");
    assert.match(judged, /Full PR body 1105/);
  });
});

test("failed sources keep their imported checkpoints and are retried without a catch-up clamp", async () => {
  const service = services();
  const channel = WATCH.channels[0];
  const key = `slack:${channel.id}`;
  const now = Date.now() / 1000;
  const since = now - 200 * 86_400;
  service.history[channel.id] = [rawMessage(now - 120 * 86_400)];
  service.failedChannels.add(channel.id);
  await withRadarContext(context(), async () => {
    const state: WatchState = { cursors: { [key]: since, "imported:source": 123 }, reported: {} };
    const first = await sweep(state, [], { refreshedAt: "", chain: [], priorities: [] }, now);
    commitSweep(state, first, {});
    assert.equal(loadWatchState().cursors[key], since);
    assert.equal(loadWatchState().cursors["imported:source"], 123);
    assert.ok(first.failed.some((failure) => failure.key === key));
    service.failedChannels.delete(channel.id);
    const second = await sweep(loadWatchState(), [], { refreshedAt: "", chain: [], priorities: [] }, now + 1);
    assert.equal(second.scanned, 1);
    commitSweep(loadWatchState(), second, {});
    assert.equal(loadWatchState().cursors[key], now + 1);
  });
});

test("Vault snapshots are judged only when persisted content changes", async () => {
  const service = services();
  const now = Date.now() / 1000;
  await withRadarContext(context(), async () => {
    const state: WatchState = { cursors: {}, reported: {}, snapshots: { "imported:source": "preserve me" } };
    const first = await sweep(state, [], { refreshedAt: "", chain: [], priorities: [] }, now);
    commitSweep(state, first, {});
    const calls = service.modelCalls.length;
    const second = await sweep(loadWatchState(), [], { refreshedAt: "", chain: [], priorities: [] }, now + 1);
    assert.equal(second.scanned, 0);
    assert.equal(service.modelCalls.length, calls);
    commitSweep(loadWatchState(), second, {});
    service.projects = "An active project now has a new unowned blocker";
    const third = await sweep(loadWatchState(), [], { refreshedAt: "", chain: [], priorities: [] }, now + 2);
    assert.equal(third.scanned, WATCH.vault.projectTeams.length);
    commitSweep(loadWatchState(), third, {});
    assert.equal(loadWatchState().snapshots?.["imported:source"], "preserve me");
  });
});

test("watch judging failures leave every watch checkpoint and snapshot available for retry", async () => {
  seed();
  const before = readFileSync(join(dataDir, "watch-state.json"), "utf8");
  const service = services();
  service.failWatchJudge = true;
  const failed = await executeRadar({ action: "scan" }, context());
  assert.match(failed.digest?.watch.error ?? "", /watch judge unavailable/);
  assert.equal(readFileSync(join(dataDir, "watch-state.json"), "utf8"), before);
  service.failWatchJudge = false;
  const retried = await executeRadar({ action: "scan" }, context());
  assert.equal(retried.digest?.watch.error, undefined);
  assert.ok(Object.keys(readFixture<WatchState>("watch-state.json").snapshots ?? {}).length > 0);
});

test("truncated Vault sources fail explicitly and never advance their checkpoints", async () => {
  const service = services();
  service.projects = "Results limited to 100 projects";
  await withRadarContext(context(), async () => {
    const state: WatchState = { cursors: {}, reported: {} };
    const result = await sweep(state, [], { refreshedAt: "", chain: [], priorities: [] }, Date.now() / 1000);
    commitSweep(state, result, {});
    for (const team of WATCH.vault.projectTeams) {
      const key = `vault:projects:${team}`;
      assert.ok(result.failed.some((failure) => failure.key === key));
      assert.equal(loadWatchState().cursors[key], undefined);
    }
  });
});

test("an unfinished Slack page fails the scan rather than checkpointing a capped result", async () => {
  const sourceKey = `slack:${CONFIG.channel.id}`;
  const state = seed({ cursors: { [sourceKey]: 123 } });
  const service = services();
  service.missingChannelCursors.add(CONFIG.channel.id);
  await assert.rejects(executeRadar({ action: "scan" }, context()), /Slack channel pagination did not finish/);
  assert.deepEqual(readFixture("state.json"), state);
  assert.equal(existsSync(join(dataDir, "latest.json")), false);
});

test("one new reply on a durable old technique thread is reclassified with its full context", async () => {
  const now = Date.now() / 1000;
  const parent = rawMessage(now - 500 * 86_400, "An old question");
  const message: Message = {
    ts: parent.ts, user: parent.user, userName: "Engineer", text: parent.text, replyCount: 0, replyUsers: [],
    reactions: parent.reactions!, attachments: [], files: [],
  };
  const sourceKey = `slack:${CONFIG.channel.id}`;
  seed({
    cursors: { [sourceKey]: now - 86_400 },
    channels: { [sourceKey]: { threads: { [parent.ts]: { message, replies: [] } } } },
    classified: { [parent.ts]: {
      replyCount: 0, signature: JSON.stringify(message),
      c: { ts: parent.ts, category: "question", confidence: 0.9, ideaKey: "old-question", title: "Old question", summary: "", whatIsNew: "", confirmations: 0, links: [], priorityIds: [] },
    } },
  });
  const service = services();
  service.history[CONFIG.channel.id] = [parent];
  service.replies[`${CONFIG.channel.id}:${parent.ts}`] = [rawMessage(now - 60, "A new technique that answers the old question")];
  const result = await executeRadar({ action: "scan" }, context());
  assert.equal(result.digest?.others.length, 1);
  assert.match(service.modelCalls.find((call) => call.system.includes("You triage messages"))!.user, /A new technique that answers the old question/);
  assert.equal(readFixture<State>("state.json").classified[parent.ts].replyCount, 1);
});

test("quiet old technique posts are reconsidered when new reactions cross the engagement gate", async () => {
  const now = Date.now() / 1000;
  const parent = rawMessage(now - 500 * 86_400);
  const message: Message = {
    ts: parent.ts, user: parent.user, userName: "", text: parent.text,
    replyCount: 0, replyUsers: [], reactions: [], attachments: [], files: [],
  };
  const sourceKey = `slack:${CONFIG.channel.id}`;
  seed({
    cursors: { [sourceKey]: now - 86_400 },
    channels: { [sourceKey]: { threads: { [parent.ts]: { message, replies: [] } } } },
  });
  const service = services();
  service.history[CONFIG.channel.id] = [parent];
  const result = await executeRadar({ action: "scan" }, context());
  assert.equal(result.digest?.others.length, 1);
  assert.equal(readFixture<State>("state.json").channels![sourceKey].threads[parent.ts].message.reactions[0].count, 2);
});

test("PR checkpoint boundaries are inclusive and unchanged content is not judged twice", async () => {
  const service = services();
  const now = Math.floor(Date.now() / 1000) + 0.5;
  const repo = WATCH.repos[0];
  service.prs[repo] = [{
    number: 1, title: "Boundary PR", html_url: `https://github.com/${repo}/pull/1`,
    created_at: new Date((now - 10_000) * 1000).toISOString(),
    updated_at: new Date(Math.floor(now) * 1000).toISOString(), state: "open", body: "Updated during the checkpoint second",
  }];
  await withRadarContext(context(), async () => {
    const state: WatchState = { cursors: { [`github:${repo}`]: now }, reported: {} };
    const first = await sweep(state, [], { refreshedAt: "", chain: [], priorities: [] }, now + 0.1);
    assert.equal(first.scanned, 1 + WATCH.vault.projectTeams.length + WATCH.vault.issueTeams.length);
    commitSweep(state, first, {});
    const calls = service.modelCalls.length;
    const second = await sweep(loadWatchState(), [], { refreshedAt: "", chain: [], priorities: [] }, now + 0.2);
    assert.equal(second.scanned, 0);
    assert.equal(service.modelCalls.length, calls);
  });
});

test("context refresh folds uncapped incremental sources into prior context regardless of refresh age", async () => {
  seed();
  const service = services();
  const now = Date.now() / 1000;
  const since = now - 180 * 86_400;
  const channel = CONFIG.team.channels[0];
  const leaderUrl = "https://vault.shopify.io/users/1";
  const contributionKey = `vault:contributions:${leaderUrl}`;
  const priorProblem = { id: "prior-problem", title: "Prior problem", kind: "toil", summary: "Existing supported pain", whatWouldHelp: "Automation", refs: [] };
  const priorPriority = { id: "prior-priority", theme: "Prior priority", description: "Existing supported direction", evidence: [] };
  fixture("registry.json", {
    refreshedAt: new Date().toISOString(), problems: [priorProblem],
    cursors: { [`slack:${channel.id}`]: since, "imported:registry": 7 },
  });
  fixture("leaders.json", {
    refreshedAt: new Date().toISOString(),
    chain: [{ name: "Leader", title: "VP", vaultUrl: leaderUrl, slackId: "ULEADER" }],
    priorities: [priorPriority], cursors: { [contributionKey]: since, "imported:leader": 8 },
  });
  service.chain = `**Organizational Chart:**\n[Leader](${leaderUrl}): VP\n`;
  service.contributions[leaderUrl] = "A leadership direction missed by a rolling thirty-day refresh";
  service.history[channel.id] = [rawMessage(now - 120 * 86_400, "A long-unread support problem")];
  const first = await executeRadar({ action: "refresh" }, context());
  assert.match(first.text, /Prior problem/);
  const registryCall = service.modelCalls.find((call) => call.system.includes("You maintain a problem registry"))!;
  assert.match(registryCall.user, /prior-problem/);
  assert.match(registryCall.user, /A long-unread support problem/);
  const leadersCall = service.modelCalls.find((call) => call.system.includes("You maintain what Shopify leadership"))!;
  assert.match(leadersCall.user, /prior-priority/);
  assert.match(leadersCall.user, /missed by a rolling thirty-day refresh/);
  assert.equal(service.contributionReads[0].start_date, new Date(since * 1000).toISOString().slice(0, 10));
  const calls = service.modelCalls.length;
  await executeRadar({ action: "refresh" }, context());
  assert.equal(service.modelCalls.length, calls);
  assert.equal(readFixture<{ cursors: Record<string, number> }>("registry.json").cursors["imported:registry"], 7);
  assert.equal(readFixture<{ cursors: Record<string, number> }>("leaders.json").cursors["imported:leader"], 8);
});

test("context refresh folds registry changes batch by batch without re-emitting unchanged cards", async () => {
  seed();
  const service = services();
  const card = (id: string, summary = id) => ({ id, title: id, kind: "toil", summary, whatWouldHelp: "", refs: [] });
  fixture("registry.json", { refreshedAt: new Date().toISOString(), problems: [card("kept"), card("updated"), card("resolved")], cursors: {} });
  service.projects = "y".repeat(CONFIG.updateBatchChars);
  service.registryUpdates = [
    { upserts: [card("updated", "new evidence"), card("added")], removed: ["resolved"] },
    { upserts: [card("later")], removed: [] },
  ];
  await executeRadar({ action: "refresh" }, context());
  const calls = service.modelCalls.filter((call) => call.system.includes("You maintain a problem registry"));
  assert.ok(calls.length >= 2);
  assert.match(calls[1].user, /"added"/);
  assert.doesNotMatch(calls[1].user, /"resolved"/);
  assert.deepEqual(
    readFixture<{ problems: { id: string; summary: string }[] }>("registry.json").problems.map((p) => [p.id, p.summary]),
    [["kept", "kept"], ["updated", "new evidence"], ["added", "added"], ["later", "later"]],
  );
});

test("explicit backfill writes its report without advancing discovery or context checkpoints", async () => {
  seed({ cursors: { "imported:source": 123 } });
  const names = ["state.json", "watch-state.json", "registry.json", "leaders.json"];
  const before = names.map((name) => readFileSync(join(dataDir, name), "utf8"));
  const service = services();
  service.history[CONFIG.channel.id] = [rawMessage(Date.now() / 1000 - 3600)];
  const result = await executeRadar({ action: "backfill", days: 1 }, context());
  assert.equal(result.digest, null);
  assert.ok(existsSync(result.text.slice("report: ".length)));
  assert.deepEqual(names.map((name) => readFileSync(join(dataDir, name), "utf8")), before);
});

test("reload cancellation reaches active network requests and never advances durable state", async () => {
  const state = seed();
  const controller = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error("Network request has no cancellation signal");
    started.resolve(signal);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const pending = executeRadar({ action: "scan" }, context(dataDir, controller.signal));
  const observed = await started.promise;
  const rejected = assert.rejects(pending, (error) => error instanceof Error && error.name === "AbortError");
  controller.abort();
  await rejected;
  assert.equal(observed.aborted, true);
  assert.deepEqual(readFixture("state.json"), state);
  assert.deepEqual(readFixture("watch-state.json"), { cursors: {}, reported: {} });
  assert.equal(existsSync(join(dataDir, "latest.json")), false);
});

test("feedback is isolated by plugin storage, even when calls overlap", async () => {
  const second = temporaryStore();
  const item = (title: string) => ({ date: radarDate(), ideaKey: title, category: "new_tech", title, problemTitle: "", permalink: "https://example.com" });
  seed({ items: { same: item("First store") } });
  seed({ items: { same: item("Second store") } }, second);
  await Promise.all([
    executeRadar({ action: "feedback", id: "same", vote: "up", note: "useful" }, context()),
    executeRadar({ action: "feedback", id: "same", vote: "down", note: "not relevant" }, context(second)),
  ]);
  const firstFeedback = readFixture<{ ideaTitle: string; vote: string }>("feedback.jsonl");
  const secondFeedback = readFixture<{ ideaTitle: string; vote: string }>("feedback.jsonl", second);
  assert.equal(firstFeedback.ideaTitle, "First store");
  assert.equal(firstFeedback.vote, "up");
  assert.equal(secondFeedback.ideaTitle, "Second store");
  assert.equal(secondFeedback.vote, "down");
});

test("credential-bearing errors are sanitized before crossing the host API", async () => {
  seed();
  const gateway = process.env.TOOL_GATEWAY_TOKEN!;
  const llm = process.env.LLM_PROXY_TOKEN!;
  const webhook = "https://hooks.slack.com/triggers/private/secret";
  globalThis.fetch = async () => { throw new Error(`failed ${gateway} ${llm} ${webhook}`); };
  await assert.rejects(executeRadar({ action: "scan" }, context()), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(gateway));
    assert.ok(!error.message.includes(llm));
    assert.ok(!error.message.includes(webhook));
    assert.match(error.message, /REDACTED/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("relative storage paths and invalid backfill windows fail before any command executes", async () => {
  await assert.rejects(executeRadar({ action: "scan" }, { dataDir: "relative", signal: new AbortController().signal }), /absolute/);
  await assert.rejects(executeRadar({ action: "backfill", days: 0 }, context()), /positive integer/);
  await assert.rejects(executeRadar({ action: "backfill", days: 1.5 }, context()), /positive integer/);
});

test("the original watch format gains skipped without losing opportunities or ranked solutions", () => {
  const current = digest();
  const historic = {
    ...current,
    watch: { groups: ["daily", "weekly"], scanned: current.watch.scanned, opportunities: current.watch.opportunities },
  };
  const result = normalizeDigest(historic);
  assert.deepEqual(result.watch.skipped, []);
  assert.deepEqual(result.watch.opportunities, current.watch.opportunities);
  assert.equal("groups" in result.watch, false);
});

test("the earliest radar array and unprioritized pairings migrate into the complete current digest", () => {
  const current = digest();
  const idea = current.others[0];
  const legacyIdea = { ...idea, leadership: { score: idea.leadership.score, reasons: idea.leadership.reasons } };
  const result = normalizeDigest({
    date: current.date,
    generatedAt: current.generatedAt,
    scanned: current.scanned,
    qualified: current.qualified,
    pairings: [{
      ...legacyIdea,
      id: "legacy-pairing",
      problem: { id: "p", title: "Known platform pain", kind: "project" },
      strength: CONFIG.p0MatchStrength,
      why: "Directly addresses the platform pain.",
      tryThis: "Try durable execution on the platform workflow.",
      score: 0.8,
    }],
    radar: [legacyIdea],
  });
  assert.equal(result.others[0].summary, idea.summary);
  assert.deepEqual(result.others[0].leadership, { ...legacyIdea.leadership, headline: "" });
  assert.equal(result.pairings[0].priority, "P0");
  assert.equal(result.pairings[0].why, "Directly addresses the platform pain.");
  assert.deepEqual(result.backlog, []);
  assert.deepEqual(result.watch, { scanned: 0, opportunities: [], skipped: [] });
  assert.equal("radar" in result, false);
});
