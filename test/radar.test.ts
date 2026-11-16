import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRadar } from "../server/radar";
import type { RadarDigest } from "../server/radar-schema";

const digest: RadarDigest = {
  date: "2026-11-16", generatedAt: "2026-11-16T12:00:00.000Z", backlog: [],
  pairings: [{ id: "idea", ideaKey: "technique", title: "Technique", summary: "Summary", whatIsNew: "New finding", permalink: "https://shopify.enterprise.slack.com/archives/C123/p456" }], others: [],
  watch: { opportunities: [{ key: "opportunity", title: "Fix report freshness", problem: "stale reports", owner: "unowned", ask: 5, askWhy: "Decisions depend on reports", solutions: [{ idea: "refresh on ingestion", fit: 5, buyIn: 4, ambition: 4 }], evidence: [{ ref: "slack:1", quote: "Reports are stale", url: "https://shopify.enterprise.slack.com/archives/C123/p123" }] }] },
};

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
    await radar.execute({ action: "run" });
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
