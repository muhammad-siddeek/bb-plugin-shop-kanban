import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG, WATCH_LIMITS } from "../../host/radar/config";
import { selectOpportunities, type Opportunity, type Solution } from "../../host/radar/watch";

const sol = (ambition: number, fit = 4, buyIn = 4): Solution => ({ idea: `idea-${ambition}`, fit, buyIn, ambition });

function opp(key: string, o: Partial<Opportunity> & { evidenceCount?: number } = {}): Opportunity {
  const { evidenceCount = 1, ...rest } = o;
  return {
    key,
    title: `Opportunity ${key}`,
    problem: "",
    owner: "unowned",
    ask: 5,
    askWhy: "",
    solutions: [sol(5), sol(3), sol(2)],
    evidence: Array.from({ length: evidenceCount }, (_, i) => ({ ref: `c/${key}.${i}`, quote: "", url: `https://x/${key}/${i}` })),
    ...rest,
  };
}

test("only a big ask with a big solution the team could accept qualifies", () => {
  const { picked } = selectOpportunities(
    [
      opp("big-big"),
      opp("small-ask", { ask: WATCH_LIMITS.minAsk - 1 }),
      // The usual shape: the best-ranked solution is the direct fix, the big one ranks lower but is still credible.
      opp("fix-first", { solutions: [sol(2, 5, 5), sol(4, 3, 3)] }),
      // Big, but the team would not accept it.
      opp("big-but-rejected", { solutions: [sol(2, 5, 5), sol(5, 4, WATCH_LIMITS.minCredible - 1)] }),
    ],
    {},
    "2026-11-16",
  );
  assert.deepEqual(picked.map((o) => o.key).sort(), ["big-big", "fix-first"]);
});

test("an opportunity is delivered once, then again only after its evidence grows by the resurface factor", () => {
  const first = selectOpportunities([opp("srm-silent", { evidenceCount: 2 })], {}, "2026-11-16");
  assert.deepEqual(first.picked.map((o) => o.key), ["srm-silent"]);
  assert.deepEqual(first.reported["srm-silent"], { title: "Opportunity srm-silent", date: "2026-11-16", seen: 2, atReport: 2 });

  // One more sighting: 3 < 2 × factor, so it stays quiet but the sighting is counted.
  const second = selectOpportunities([opp("srm-silent")], first.reported, "2026-11-17");
  assert.equal(second.picked.length, 0);
  assert.equal(second.reported["srm-silent"].seen, 3);

  const needed = 2 * CONFIG.resurfaceFactor - 3;
  const third = selectOpportunities([opp("srm-silent", { evidenceCount: needed })], second.reported, "2026-11-18");
  assert.deepEqual(third.picked.map((o) => [o.key, o.resurfaced]), [["srm-silent", true]]);
  assert.equal(third.reported["srm-silent"].atReport, 2 * CONFIG.resurfaceFactor);
});

test("picks rank by ask and biggest credible solution without losing qualifying overflow", () => {
  const found = [
    opp("ask4", { ask: 4 }),
    opp("ask5-amb4", { solutions: [sol(4)] }),
    opp("ask5-amb5"),
    ...Array.from({ length: 12 }, (_, i) => opp(`filler-${i}`, { ask: 4, solutions: [sol(4)] })),
  ];
  const { picked, reported } = selectOpportunities(found, {}, "2026-11-16");
  assert.equal(picked.length, found.length);
  assert.deepEqual(picked.slice(0, 2).map((o) => o.key), ["ask5-amb5", "ask5-amb4"]);
  assert.equal(Object.keys(reported).length, found.length);
});
