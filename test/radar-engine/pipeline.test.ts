import assert from "node:assert/strict";
import { test } from "node:test";
import type { Classification } from "../../host/radar/classify";
import { CONFIG } from "../../host/radar/config";
import type { Match } from "../../host/radar/match";
import { buildDigest, selectIdeas, type Analysis, type Candidate } from "../../host/radar/pipeline";
import type { Problem } from "../../host/radar/registry";

function candidate(ts: string, o: Partial<Classification> & { traction?: number; leadership?: number; passes?: boolean } = {}): Candidate {
  const { traction = 0.5, leadership = 0, passes = true, ...c } = o;
  return {
    msg: { ts, user: "U1", userName: "A", text: "", replyCount: 0, replyUsers: [], reactions: [], attachments: [], files: [] },
    c: {
      ts,
      category: "new_tech",
      confidence: 0.9,
      ideaKey: `idea-${ts}`,
      title: `Idea ${ts}`,
      summary: "",
      whatIsNew: "",
      confirmations: 0,
      links: [],
      priorityIds: [],
      ...c,
    },
    author: "A",
    engagement: { reactors: 5, replyUsers: 1 },
    leadership: { score: leadership, reasons: [], headline: "" },
    traction,
    passesEngagement: passes,
  };
}

const problem = (id: string): Problem => ({ id, title: `Problem ${id}`, kind: "project", summary: "", whatWouldHelp: "", refs: [] });
const matchFor = (ts: string, problemId: string, strength: number): Match => ({ ts, problemId, strength, why: "", tryThis: "" });
const analysis = (candidates: Candidate[]): Analysis => ({ baseline: { reactorsP90: 25, replyUsersP90: 8 }, classified: [], candidates });

test("selectIdeas keeps one message per idea: the strongest", () => {
  const ideas = selectIdeas(
    [candidate("1", { ideaKey: "gpt-6", traction: 0.2 }), candidate("2", { ideaKey: "gpt-6", traction: 0.7 })],
    {},
  );
  assert.deepEqual(
    ideas.map((i) => [i.ideaKey, i.msg.ts]),
    [["gpt-6", "2"]],
  );
});

test("selectIdeas drops messages that fail the engagement gate", () => {
  assert.deepEqual(selectIdeas([candidate("1", { passes: false })], {}), []);
});

test("selectIdeas suppresses delivered ideas until traction multiplies", () => {
  const reported = { "gpt-6": { ts: "1", date: "2026-10-01", traction: 0.3, title: "GPT-6" } };
  const below = selectIdeas([candidate("2", { ideaKey: "gpt-6", traction: 0.3 * CONFIG.resurfaceFactor - 0.01 })], reported);
  assert.deepEqual(below, []);
  const above = selectIdeas([candidate("2", { ideaKey: "gpt-6", traction: 0.3 * CONFIG.resurfaceFactor })], reported);
  assert.equal(above.length, 1);
  assert.equal(above[0].resurfaced, true);
});

test("selectIdeas keeps a delivered message's key when reclassification renames it", () => {
  const reported = { "old-key": { ts: "1", date: "2026-10-01", traction: 0.5, title: "Old" } };
  assert.deepEqual(selectIdeas([candidate("1", { ideaKey: "new-key", traction: 0.5 })], reported), []);
});

test("buildDigest gates pairings on match strength and ranks by score", () => {
  const cands = [candidate("1", { traction: 0.2 }), candidate("2", { traction: 0.9 }), candidate("3")];
  const ideas = selectIdeas(cands, {});
  const d = buildDigest({
    date: "2026-10-03",
    scanned: 10,
    analysis: analysis(cands),
    ideas,
    matches: [matchFor("1", "p", 0.8), matchFor("2", "p", 0.8), matchFor("3", "p", CONFIG.minMatchStrength - 0.01)],
    problems: [problem("p")],
    backlog: [],
  });
  assert.deepEqual(
    d.pairings.map((p) => [p.ts, p.id]),
    [
      ["2", "idea-2"],
      ["1", "idea-1"],
    ],
  );
  assert.deepEqual(
    d.others.map((o) => [o.ts, o.id]),
    [["3", "idea-3"]],
  );
});

test("buildDigest rates direct hits P0 and lists them above more popular P1 pairings", () => {
  const cands = [candidate("pop", { traction: 1, leadership: 1 }), candidate("hit", { traction: 0 })];
  const d = buildDigest({
    date: "2026-10-03",
    scanned: 10,
    analysis: analysis(cands),
    ideas: selectIdeas(cands, {}),
    matches: [matchFor("pop", "p", CONFIG.p0MatchStrength - 0.01), matchFor("hit", "q", CONFIG.p0MatchStrength)],
    problems: [problem("p"), problem("q")],
    backlog: [],
  });
  assert.deepEqual(
    d.pairings.map((p) => [p.ts, p.priority]),
    [
      ["hit", "P0"],
      ["pop", "P1"],
    ],
  );
});

test("buildDigest retains every pairing and unpaired idea in promise order", () => {
  const overflow = Array.from({ length: 12 }, (_, i) => candidate(`m${i}`, { leadership: 0.9 }));
  const near = candidate("near");
  const hallucinated = candidate("ghost", { leadership: 0.9 });
  const unpaired = [candidate("plain", { traction: 0.5 }), candidate("mid", { traction: 0.3 }), candidate("faint", { traction: 0.1 })];
  const cands = [...overflow, ...unpaired, hallucinated, near];
  const d = buildDigest({
    date: "2026-10-03",
    scanned: 20,
    analysis: analysis(cands),
    ideas: selectIdeas(cands, {}),
    matches: [
      ...overflow.map((c, i) => matchFor(c.msg.ts, `p${i}`, 0.9)),
      matchFor("ghost", "missing", 0.9),
      matchFor("near", "p0", CONFIG.minMatchStrength - 0.05),
    ],
    problems: overflow.map((_, i) => problem(`p${i}`)),
    backlog: [],
  });
  assert.equal(d.pairings.length, overflow.length);
  const byPromise = ["near", "ghost", "plain", "mid", "faint"];
  assert.deepEqual(
    d.others.map((o) => o.ts),
    byPromise,
  );
});

test("buildDigest retains all qualifying ideas for the same problem", () => {
  const sameProblem = Array.from({ length: 8 }, (_, i) =>
    candidate(`s${i}`, { leadership: 0.9, traction: 0.9 - i * 0.1 }),
  );
  const other = candidate("o", { traction: 0.1 });
  const cands = [...sameProblem, other];
  const d = buildDigest({
    date: "2026-10-03",
    scanned: 10,
    analysis: analysis(cands),
    ideas: selectIdeas(cands, {}),
    matches: [...sameProblem.map((c) => matchFor(c.msg.ts, "p", 0.9)), matchFor("o", "q", 0.7)],
    problems: [problem("p"), problem("q")],
    backlog: [],
  });
  assert.deepEqual(
    d.pairings.map((p) => p.ts),
    [...sameProblem.map((c) => c.msg.ts), "o"],
  );
  assert.deepEqual(d.others, []);
});

test("incremental scans use stable per-thread feedback ids rather than colliding daily positions", () => {
  const build = (ts: string) => {
    const candidates = [candidate(ts)];
    return buildDigest({
      date: "2026-10-03",
      scanned: 1,
      analysis: analysis(candidates),
      ideas: selectIdeas(candidates, {}),
      matches: [],
      problems: [],
      backlog: [],
    });
  };
  assert.notEqual(build("1").others[0].id, build("2").others[0].id);
  assert.equal(build("1").others[0].id, build("1").others[0].id);
});
