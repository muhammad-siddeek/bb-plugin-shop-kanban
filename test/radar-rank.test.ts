import assert from "node:assert/strict";
import { test } from "node:test";
import { rankRadar } from "../host/radar-rank";

const items = ["one", "two", "three"].map((id) => ({
  id, kind: "technique" as const, read: false, threadId: null, createdAt: "2026-11-16T12:00:00Z",
  finding: { id, ideaKey: id, title: id, summary: "Finding", whatIsNew: "Evidence", permalink: "https://shopify.slack.com/archives/C1/p1" },
}));

test("three independent reviews correct the ranking and feed the next round without dropping items", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LLM_PROXY_TOKEN;
  process.env.LLM_PROXY_TOKEN = "ranking-test-token";
  const requests: { system: string; messages: { content: string }[] }[] = [];
  const replies = [
    { order: ["one", "two", "three"], rationale: "Initial" },
    { order: ["two", "one", "three"], critique: "Two has stronger evidence" },
    { order: ["two", "three", "one"], rationale: "Revised" },
    { order: ["three", "two", "one"], critique: "Three is unowned" },
    { order: ["three", "two", "one"], rationale: "Final proposal" },
    { order: ["two", "three", "one"], critique: "Two has better buy-in" },
  ];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(replies[requests.length - 1]) }] }));
  };
  try {
    const result = await rankRadar(items, { dataDir: "/tmp/radar-ranking-test", signal: new AbortController().signal });
    assert.deepEqual(result.order, ["two", "three", "one"]);
    assert.equal(result.rounds.length, 3);
    assert.equal(requests.length, 6);
    assert.match(requests[2].messages[0].content, /Two has stronger evidence/);
    assert.match(requests[4].messages[0].content, /Three is unowned/);
    assert.match(requests[1].system, /independent.*reviewer/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.LLM_PROXY_TOKEN;
    else process.env.LLM_PROXY_TOKEN = originalToken;
  }
});

test("a ranking that omits a recommendation is rejected rather than hiding the item", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LLM_PROXY_TOKEN;
  process.env.LLM_PROXY_TOKEN = "ranking-test-token";
  globalThis.fetch = async () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ order: ["one"], rationale: "Incomplete" }) }] }));
  try {
    await assert.rejects(rankRadar(items, { dataDir: "/tmp/radar-ranking-test", signal: new AbortController().signal }), /every current item/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.LLM_PROXY_TOKEN;
    else process.env.LLM_PROXY_TOKEN = originalToken;
  }
});
