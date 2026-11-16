import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown, type Digest } from "../../host/radar/digest";

test("local markdown renders every retained opportunity and solution without delivery limits", () => {
  const digest: Digest = {
    date: "2026-11-16",
    generatedAt: "2026-11-16T12:00:00Z",
    windowHours: 0,
    scanned: 0,
    qualified: 0,
    pairings: [],
    others: [],
    othersHidden: 0,
    backlog: [],
    watch: {
      scanned: 12,
      skipped: ["#retry-me"],
      opportunities: Array.from({ length: 12 }, (_, i) => ({
        key: `problem-${i}`,
        title: `Opportunity ${i}`,
        problem: "Repeated cross-team failures",
        owner: "unowned",
        ask: 5,
        askWhy: "Affects the whole platform",
        solutions: Array.from({ length: 3 }, (_, j) => ({ idea: `Solution ${i}/${j}`, fit: 4, buyIn: 4, ambition: 5 })),
        evidence: [{ ref: `thread-${i}`, quote: "This keeps happening", url: `https://example.com/${i}` }],
        resurfaced: false,
      })),
    },
  };
  const text = renderMarkdown(digest);
  for (const opportunity of digest.watch.opportunities) {
    assert.ok(text.includes(opportunity.title));
    for (const solution of opportunity.solutions) assert.ok(text.includes(solution.idea));
  }
  assert.match(text, /retried next run.*#retry-me/);
});
