import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CONFIG, radarDate } from "../../host/radar/config";
import { executeRadar, type Digest } from "../../host/radar/index";
import type { State } from "../../host/radar/pipeline";

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
    windowHours: CONFIG.lookbackHours,
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
    othersHidden: 0,
    backlog: [],
    watch: {
      groups: ["daily"],
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

test("an already-delivered run returns the complete durable digest without auth, network, or delivery", async () => {
  seed({ lastRunDate: radarDate() });
  const latest = digest();
  fixture("latest.json", latest);
  delete process.env.TOOL_GATEWAY_TOKEN;
  delete process.env.LLM_PROXY_TOKEN;
  const result = await executeRadar({ action: "run" }, context());
  assert.deepEqual(result.digest, latest);
  assert.match(result.text, /Durable agents/);
  assert.equal(result.digest?.watch.opportunities[0].solutions.length, 3);
  assert.equal(process.env.TOOL_GATEWAY_TOKEN, undefined);
  assert.equal(process.env.LLM_PROXY_TOKEN, undefined);
});

test("a historic delivered digest is promoted to latest.json inside the supplied store", async () => {
  seed({ lastRunDate: radarDate() });
  const saved = digest();
  fixture(`digests/${saved.date}.json`, saved);
  const result = await executeRadar({ action: "run" }, context());
  assert.deepEqual(result.digest, saved);
  assert.deepEqual(readFixture("latest.json"), saved);
});

test("dry-run returns findings but preserves latest, sent ledger, last-run date, and watch cursors", async () => {
  const today = radarDate();
  const state = seed({
    lastRunDate: today,
    reported: { sent: { ts: "123", title: "Sent idea", date: today, traction: 0.5 } },
    items: { sent: { date: today, ideaKey: "sent", category: "new_tech", title: "Sent idea", problemTitle: "", permalink: "https://example.com/sent" } },
  });
  fixture("watch-state.json", {
    cursors: { "slack:already-swept": Date.now() / 1000 },
    reported: { sent: { title: "Sent opportunity", date: today, seen: 2, atReport: 2 } },
  });
  const latest = digest();
  fixture("latest.json", latest);
  const watch = readFileSync(join(dataDir, "watch-state.json"), "utf8");
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://tool-gateway.shopify.io/codemode/mcp");
    calls++;
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "[]" }] } }), { headers: { "Content-Type": "application/json" } });
  };
  const result = await executeRadar({ action: "run", dryRun: true, force: true }, context());
  assert.ok(result.digest);
  assert.ok(calls > 0);
  assert.equal(result.digest.date, today);
  assert.deepEqual(readFixture("state.json"), state);
  assert.equal(readFileSync(join(dataDir, "watch-state.json"), "utf8"), watch);
  assert.deepEqual(readFixture("latest.json"), latest);
  assert.equal(process.env.TOOL_GATEWAY_TOKEN, "radar-api-test-gateway-token");
  assert.equal(process.env.LLM_PROXY_TOKEN, "radar-api-test-llm-token");
});

test("scan bypasses today's snapshot, keeps prior ledgers and scans all groups without Slack delivery", async () => {
  const today = radarDate();
  const state = seed({ lastRunDate: today, reported: { sent: { ts: "123", title: "Sent", date: today, traction: 0.5 } } });
  const cursor = Date.now() / 1000 - 60;
  fixture("watch-state.json", { cursors: { "slack:already-swept": cursor }, reported: { sent: { title: "Sent opportunity", date: today, seen: 2, atReport: 2 } } });
  fixture("latest.json", digest());
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://tool-gateway.shopify.io/codemode/mcp");
    calls++;
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "[]" }] } }), { headers: { "Content-Type": "application/json" } });
  };
  const result = await executeRadar({ action: "scan" }, context());
  assert.ok(calls > 0);
  assert.deepEqual(result.digest?.watch.groups, ["daily", "weekly"]);
  assert.deepEqual(readFixture<State>("state.json").reported, state.reported);
  assert.equal(readFixture<State>("state.json").lastRunDate, today);
  assert.deepEqual(readFixture("latest.json"), result.digest);
  const watch = readFixture<{ cursors: Record<string, number>; reported: object }>("watch-state.json");
  assert.equal(watch.cursors["slack:already-swept"], cursor);
  assert.deepEqual(watch.reported, { sent: { title: "Sent opportunity", date: today, seen: 2, atReport: 2 } });
});

test("force bypasses the same-day snapshot but failed discovery does not erase delivered state", async () => {
  const state = seed({
    lastRunDate: radarDate(),
    reported: { sent: { ts: "123", title: "Sent idea", date: radarDate(), traction: 0.5 } },
  });
  const latest = digest();
  fixture("latest.json", latest);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("network unavailable"); };
  await assert.rejects(executeRadar({ action: "run", force: true }, context()), /network unavailable/);
  assert.ok(calls > 0);
  assert.deepEqual(readFixture("state.json"), state);
  assert.deepEqual(readFixture("latest.json"), latest);
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
  const pending = executeRadar({ action: "run" }, context(dataDir, controller.signal));
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
  await assert.rejects(executeRadar({ action: "run" }, context()), (error) => {
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
  await assert.rejects(executeRadar({ action: "run" }, { dataDir: "relative", signal: new AbortController().signal }), /absolute/);
  await assert.rejects(executeRadar({ action: "backfill", days: 0 }, context()), /positive integer/);
  await assert.rejects(executeRadar({ action: "backfill", days: 1.5 }, context()), /positive integer/);
});

test("the original watch format gains skipped without losing opportunities or ranked solutions", async () => {
  seed({ lastRunDate: radarDate() });
  const current = digest();
  const historic = {
    ...current,
    watch: { groups: current.watch.groups, scanned: current.watch.scanned, opportunities: current.watch.opportunities },
  };
  fixture("latest.json", historic);
  const result = await executeRadar({ action: "run" }, context());
  assert.deepEqual(result.digest?.watch.skipped, []);
  assert.deepEqual(result.digest?.watch.opportunities, current.watch.opportunities);
  assert.deepEqual(readFixture<Digest>("latest.json").watch.skipped, []);
  assert.match(result.text, /Remove recurring alert toil/);
});

test("the earliest radar array and unprioritized pairings migrate into the complete current digest", async () => {
  seed({ lastRunDate: radarDate() });
  const current = digest();
  const idea = current.others[0];
  const legacyIdea = { ...idea, leadership: { score: idea.leadership.score, reasons: idea.leadership.reasons } };
  fixture("latest.json", {
    date: current.date,
    generatedAt: current.generatedAt,
    windowHours: current.windowHours,
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
  const result = await executeRadar({ action: "run" }, context());
  assert.ok(result.digest);
  assert.equal(result.digest.others[0].summary, idea.summary);
  assert.deepEqual(result.digest.others[0].leadership, { ...legacyIdea.leadership, headline: "" });
  assert.equal(result.digest.pairings[0].priority, "P0");
  assert.equal(result.digest.pairings[0].why, "Directly addresses the platform pain.");
  assert.equal(result.digest.othersHidden, 0);
  assert.deepEqual(result.digest.backlog, []);
  assert.deepEqual(result.digest.watch, { groups: [], scanned: 0, opportunities: [], skipped: [] });
  assert.equal("radar" in result.digest, false);
  assert.deepEqual(readFixture("latest.json"), result.digest);
});
