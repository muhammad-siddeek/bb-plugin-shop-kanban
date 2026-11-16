// Calibration: classify + score + match the last N days (no cache, no state changes) into a report.
import { join } from "node:path";
import { CONFIG, KEEP_CATEGORIES, PATHS } from "./config";
import { loadLeaders } from "./leaders";
import { match } from "./match";
import { timed } from "./log";
import { analyze, loadState, type State } from "./pipeline";
import { loadRegistry } from "./registry";
import { rankScore } from "./score";
import { fetchMessages, permalink } from "./slack";
import { writeText } from "./store";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const day = (ts: string) => new Date(Number(ts) * 1000).toLocaleDateString("en-CA");

export async function backfill(days: number): Promise<string> {
  const [registry, leaders] = await Promise.all([loadRegistry(), loadLeaders()]);
  const msgs = await timed("fetch", () => fetchMessages(CONFIG.channel.id, Math.floor(Date.now() / 1000 - days * 86_400)));
  // Fresh classification cache: calibration exists to re-judge with the current prompt.
  const scratch: State = { ...loadState(), classified: {} };
  const analysis = await analyze(msgs, msgs, scratch, leaders);
  const passing = analysis.candidates.filter((x) => x.passesEngagement);
  const matches = new Map(
    (await timed(`match (${passing.length})`, () => match(passing.map((x) => x.c), registry.problems))).map((m) => [m.ts, m]),
  );
  const problems = new Map(registry.problems.map((p) => [p.id, p]));
  const candidates = new Map(analysis.candidates.map((x) => [x.msg.ts, x]));

  const byCategory = new Map<string, number>();
  for (const { c } of analysis.classified) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);

  const rows = analysis.classified.map(({ msg, c }) => {
    const x = candidates.get(msg.ts);
    const m = matches.get(msg.ts);
    const gate = !x
      ? c.confidence < CONFIG.minCategoryConfidence && (KEEP_CATEGORIES as readonly string[]).includes(c.category)
        ? "low-conf"
        : "drop"
      : x.passesEngagement
        ? "keep"
        : "low-eng";
    const reactors = new Set(msg.reactions.flatMap((r) => r.users)).size;
    const pairing = m && m.problemId !== "none" ? `${problems.get(m.problemId)?.title ?? m.problemId} (${m.strength.toFixed(2)})` : "";
    return `| [${day(msg.ts)}](${permalink(CONFIG.channel.id, msg.ts)}) | ${reactors}/${msg.replyUsers.length} | ${c.category} ${c.confidence.toFixed(2)} | ${gate} | ${cell(c.title)} | ${x ? x.leadership.score.toFixed(2) : ""} | ${x ? x.traction.toFixed(2) : ""} | ${cell(pairing)} |`;
  });

  const paired = passing
    .flatMap((x) => {
      const m = matches.get(x.msg.ts);
      const p = m ? problems.get(m.problemId) : undefined;
      return m && p && m.strength >= CONFIG.minMatchStrength
        ? [{ x, m, p, score: rankScore(m.strength, x.leadership.score, x.traction) }]
        : [];
    })
    .sort((a, b) => b.score - a.score);

  const report = [
    `# Backfill ${new Date().toLocaleDateString("en-CA")} — last ${days} days`,
    "",
    `- Messages: ${msgs.length}; classified: ${analysis.classified.length}`,
    `- Categories: ${[...byCategory].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`,
    `- Kept (confident): ${analysis.candidates.length}; pass engagement: ${passing.length}; paired (strength ≥ ${CONFIG.minMatchStrength}): ${paired.length} (~${(paired.length / days).toFixed(1)}/day before novelty dedupe)`,
    `- Traction baseline p90: ${analysis.baseline.reactorsP90} reactors, ${analysis.baseline.replyUsersP90} repliers`,
    "",
    "## Would-be pairings",
    "",
    ...paired.map(
      ({ x, m, p, score }) =>
        `- ${score.toFixed(2)} [${x.c.category}] **${x.c.title}** → ${p.title} (fit ${m.strength.toFixed(2)}, lead ${x.leadership.score.toFixed(2)}, traction ${x.traction.toFixed(2)})\n  - ${m.why}`,
    ),
    "",
    "## All messages",
    "",
    "| date | reactors/repliers | category | gate | title | lead | traction | pairing |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  const path = join(PATHS.calibration, `backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeText(path, report + "\n");
  return path;
}
