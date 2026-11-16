import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost as createHost } from "@get-bb/plugin-sdk/testing";
import { createRadar } from "../server/radar";
import { radarActionSchema, radarRankItemSchema, type RadarDigest } from "../server/radar-schema";

const digest: RadarDigest = {
  date: "2026-11-16", generatedAt: "2026-11-16T12:00:00.000Z", backlog: [],
  pairings: [{ id: "idea", ideaKey: "technique", title: "Technique", summary: "Summary", whatIsNew: "New finding", permalink: "https://shopify.enterprise.slack.com/archives/C123/p456" }], others: [],
  watch: { opportunities: [{ key: "opportunity", title: "Fix report freshness", problem: "stale reports", owner: "unowned", ask: 5, askWhy: "Decisions depend on reports", solutions: [{ idea: "refresh on ingestion", fit: 5, buyIn: 4, ambition: 4 }], evidence: [{ ref: "slack:1", quote: "Reports are stale", url: "https://shopify.enterprise.slack.com/archives/C123/p123" }] }] },
};

function createFakePluginHost(options: Parameters<typeof createHost>[0]) {
  return createHost({ ...options, experimental_callHostRpc: async (call) => {
    if (call.method === "radar_rank") {
      const input = call.input;
      assert.ok(input && typeof input === "object" && "items" in input && Array.isArray(input.items));
      const order = input.items.map((item) => radarRankItemSchema.parse(item).id);
      return { order, rationale: "Test ranking", rounds: Array.from({ length: 3 }, () => ({ ranking: order, review: "Reviewed" })) };
    }
    return options?.experimental_callHostRpc?.(call);
  } });
}

test("draft/cancel leaves unread; submission preserves selections and is idempotent after board failure", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { radarHostId: "host-test" }, experimental_callHostRpc: async () => ({ digest, dataDir: "/radar" }) });
  let creates = 0;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const composer = { projectId: "project-test", input: [{ type: "text", text: "Implement the selected solution" }], model: "chosen-model", environment: { type: "project-default" } };
  const radar = createRadar(bb, async (input, created) => {
    creates++;
    assert.equal(input.composer, composer);
    await gate;
    created!("thread-created");
    throw new Error("Board materialization failed after creation");
  });
  try {
    assert.equal((await radar.list()).unread, 2);
    const draft = await radar.draft("opportunity:opportunity");
    assert.match(draft.prompt, /Implement the best solution/);
    assert.match(draft.prompt, /Reports are stale/);
    assert.equal((await radar.list()).unread, 2);
    const first = radar.submit("opportunity:opportunity", composer);
    const duplicate = radar.submit("opportunity:opportunity", composer);
    assert.equal(first, duplicate);
    assert.throws(() => radar.dismiss("opportunity:opportunity"), /being submitted/);
    release();
    assert.deepEqual(await first, { threadId: "thread-created" });
    assert.deepEqual(await radar.submit("opportunity:opportunity", composer), { threadId: "thread-created" });
    assert.equal(creates, 1);
    const state = await radar.list();
    assert.equal(state.unread, 1);
    assert.equal(state.items.find((item) => item.kind === "opportunity")?.read, true);
    radar.dismiss("technique:technique", true);
    assert.equal((await radar.list()).unread, 0);
  } finally { await harness.lifecycle.dispose(); }
});

test("failed creation leaves recommendation actionable and dismissed items stay hidden after refresh", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { radarHostId: "host-test" }, experimental_callHostRpc: async () => ({ digest, dataDir: "/radar", text: "Refreshed" }) });
  const radar = createRadar(bb, async () => { throw new Error("Host offline"); });
  try {
    await radar.list();
    await assert.rejects(radar.submit("opportunity:opportunity", { projectId: "test", input: [{ type: "text", text: "Implement" }] }), /Host offline/);
    assert.equal((await radar.list()).unread, 2);
    radar.dismiss("opportunity:opportunity");
    radar.dismiss("technique:technique", true);
    await radar.execute({ action: "scan" });
    assert.deepEqual((await radar.list()).items, []);
  } finally { await harness.lifecycle.dispose(); }
});

test("scans append unseen keys across days without replacing or reopening existing recommendations", async () => {
  let next = structuredClone(digest);
  const { bb, harness } = createFakePluginHost({ settings: { radarHostId: "host-test" }, experimental_callHostRpc: async () => ({ digest: next, dataDir: "/radar", text: "Scanned" }) });
  const radar = createRadar(bb, async (_input, created) => { created!("existing-thread"); });
  try {
    await radar.list();
    await radar.submit("opportunity:opportunity", { projectId: "test", input: [{ type: "text", text: "Implement" }] });
    radar.dismiss("technique:technique", true);
    next.generatedAt = "2026-11-17T12:00:00.000Z";
    next.date = "2026-11-17";
    next.watch.opportunities[0].title = "Reworded duplicate";
    next.watch.opportunities.push({ ...next.watch.opportunities[0], key: "new-opportunity", title: "New opportunity" });
    next.others = [{ ...next.pairings[0], ideaKey: "new-technique", title: "New technique" }];
    await radar.execute({ action: "scan" });
    await radar.execute({ action: "scan" });
    const state = await radar.list();
    assert.equal(state.unread, 2);
    assert.deepEqual(state.items.map((item) => item.id).sort(), ["opportunity:new-opportunity", "opportunity:opportunity", "technique:new-technique"]);
    const original = state.items.find((item) => item.id === "opportunity:opportunity")!;
    assert.equal(original.title, "Fix report freshness");
    assert.equal(original.read, true);
    assert.equal(original.threadId, "existing-thread");
    assert.equal(original.createdAt, digest.generatedAt);
    next = { ...next, pairings: [], others: [], watch: { opportunities: [] } };
    await radar.execute({ action: "scan" });
    assert.deepEqual((await radar.list()).items, state.items);
  } finally { await harness.lifecycle.dispose(); }
});

test("a successful snapshot clears a previous host-read failure", async () => {
  let offline = true;
  const { bb, harness } = createFakePluginHost({ settings: { radarHostId: "host-test" }, experimental_callHostRpc: async () => {
    if (offline) throw new Error("Host offline");
    return { digest, dataDir: "/radar" };
  } });
  const radar = createRadar(bb, async () => {});
  try {
    assert.match((await radar.list()).error ?? "", /Host offline/);
    offline = false;
    const recovered = await radar.list();
    assert.equal(recovered.error, null);
    assert.equal(recovered.unread, 2);
  } finally { await harness.lifecycle.dispose(); }
});

test("automatic refresh scans once per work hour in Toronto and never outside work hours", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-16T11:00:00Z") });
  const actions: string[] = [];
  let { bb, harness } = createFakePluginHost({
    settings: { radarEnabled: true, radarHostId: "host-test" },
    experimental_callHostRpc: async ({ input }) => {
      actions.push(radarActionSchema.parse(input).action);
      return { digest, text: "Updated" };
    },
  });
  createRadar(bb, async () => {});
  const tick = async (iso: string) => {
    t.mock.timers.setTime(new Date(iso).getTime());
    await harness.behavior.runSchedule("radar-daily");
  };
  try {
    await tick("2026-11-16T11:55:00Z"); // 06:55 EST
    assert.deepEqual(actions, []);
    await tick("2026-11-16T12:00:00Z"); // 07:00 EST
    await tick("2026-11-16T12:55:00Z");
    await tick("2026-11-16T13:00:00Z"); // 08:00 is an ordinary scan.
    await tick("2026-11-16T13:05:00Z");
    await tick("2026-11-16T14:00:00Z");
    ({ bb, harness } = await harness.lifecycle.reload((next) => { createRadar(next, async () => {}); }));
    await tick("2026-11-16T14:05:00Z"); // Reload keeps the completed hour.
    await tick("2026-11-16T20:00:00Z"); // 15:00 EST
    await tick("2026-11-16T21:00:00Z");
    assert.deepEqual(actions, ["scan", "scan", "scan", "scan"]);
    await tick("2026-11-21T12:00:00Z"); // Saturday 07:00: no hourly refresh.
    assert.deepEqual(actions, ["scan", "scan", "scan", "scan"]);
    await tick("2027-03-15T11:00:00Z"); // 07:00 EDT after DST changes.
    assert.equal(actions.at(-1), "scan");
    assert.equal(actions.length, 5);
    await harness.behavior.setSettings({ radarEnabled: false });
    await tick("2027-03-15T12:00:00Z");
    assert.equal(actions.length, 5);
  } finally { await harness.lifecycle.dispose(); }
});

test("new scans rank old and new items together, preserve read state, and retain the reviewed order across reload", async () => {
  let next = structuredClone(digest);
  let order: string[] = [];
  let { bb, harness } = createHost({ settings: { radarHostId: "host-test" }, experimental_callHostRpc: async ({ method, input }) => {
    if (method !== "radar_rank") return { digest: next, text: "Scanned", dataDir: "/radar" };
    assert.ok(input && typeof input === "object" && "items" in input && Array.isArray(input.items));
    const items = input.items.map((item) => radarRankItemSchema.parse(item));
    order = items.map((item) => item.id).reverse();
    return { order, rationale: "Reviewed ordering", rounds: Array.from({ length: 3 }, () => ({ ranking: order, review: "Reviewed" })) };
  } });
  let radar = createRadar(bb, async (_input, created) => { created!("taken-thread"); });
  try {
    await radar.execute({ action: "scan" });
    await radar.submit("opportunity:opportunity", { projectId: "test", input: [{ type: "text", text: "Implement" }] });
    next = { ...next, generatedAt: "2026-11-17T12:00:00Z", watch: { opportunities: [{ ...digest.watch.opportunities[0], key: "new", title: "New" }] }, pairings: [], others: [] };
    await radar.execute({ action: "scan" });
    const state = await radar.list();
    assert.deepEqual(state.items.map((item) => item.id), order);
    assert.equal(state.items.find((item) => item.id === "opportunity:opportunity")?.read, true);
    assert.deepEqual(new Set(order), new Set(["technique:technique", "opportunity:new", "opportunity:opportunity"]));
    ({ bb, harness } = await harness.lifecycle.reload((nextHost) => { radar = createRadar(nextHost, async () => {}); }));
    assert.deepEqual((await radar.list()).items.map((item) => item.id), order);
  } finally { await harness.lifecycle.dispose(); }
});

test("opening Radar reads the snapshot without waiting for or invoking the ranker", async () => {
  const calls: string[] = [];
  const { bb, harness } = createHost({
    settings: { radarHostId: "host-test" },
    experimental_callHostRpc: async ({ method }) => {
      calls.push(method);
      if (method !== "radar_snapshot") throw new Error("Opening the inbox must not invoke ranking");
      return { digest, dataDir: "/radar" };
    },
  });
  const radar = createRadar(bb, async () => {});
  try {
    const state = await radar.list();
    assert.deepEqual(calls, ["radar_snapshot"]);
    assert.equal(state.error, null);
    assert.deepEqual(new Set(state.items.map((item) => item.id)), new Set(["opportunity:opportunity", "technique:technique"]));
  } finally { await harness.lifecycle.dispose(); }
});
