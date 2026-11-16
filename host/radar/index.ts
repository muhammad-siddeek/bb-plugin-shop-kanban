import { join } from "node:path";
import { fetchBacklog, selectBacklog } from "./backlog";
import { backfill } from "./backfill";
import { CONFIG, PATHS, radarDate } from "./config";
import { connectWebhook, deliver } from "./deliver";
import { NO_WATCH, renderMarkdown, type Digest, type DigestItem, type DigestWatch, type Pairing } from "./digest";
import { recordFeedback } from "./feedback";
import { GatewayError } from "./gateway";
import { loadLeaders } from "./leaders";
import { timed } from "./log";
import { match } from "./match";
import { analyze, buildDigest, commitDigest, loadState, pruneClassified, saveState, selectIdeas } from "./pipeline";
import { loadRegistry } from "./registry";
import { radarSignal, safeMessage, serializeRadar, throwIfAborted, type RadarContext } from "./runtime";
import { fetchMessages } from "./slack";
import { readJson, writeJson } from "./store";
import { commitSweep, loadWatchState, rewindToday, selectOpportunities, sweep } from "./watch";

export type { Digest } from "./digest";
export type { RadarContext } from "./runtime";

export interface RadarInput {
  action: "run" | "scan" | "refresh" | "backfill" | "feedback" | "webhook";
  force?: boolean;
  dryRun?: boolean;
  days?: number;
  id?: string;
  vote?: "up" | "down";
  note?: string;
  url?: string;
}

export interface RadarResult {
  digest: Digest | null;
  text: string;
}

type StoredItem = Omit<DigestItem, "leadership"> & {
  leadership: Omit<DigestItem["leadership"], "headline"> & { headline?: string };
};
type StoredPairing = StoredItem & Omit<Pairing, keyof DigestItem | "priority"> & { priority?: Pairing["priority"] };
type StoredDigest = Omit<Digest, "pairings" | "others" | "othersHidden" | "backlog" | "watch"> & {
  pairings: StoredPairing[];
  others?: StoredItem[];
  /** The first two releases called unpaired techniques "radar". Convert, never drop them. */
  radar?: StoredItem[];
  othersHidden?: number;
  backlog?: Digest["backlog"];
  watch?: Partial<DigestWatch>;
};

/** Upgrade structurally valid historic snapshots before consumer-schema validation or rendering; preserve findings. */
export function normalizeDigest(stored: StoredDigest): Digest {
  const hasHeadline = (item: StoredItem) => item.leadership.headline !== undefined;
  if (
    stored.radar === undefined && stored.others !== undefined && stored.othersHidden !== undefined &&
    stored.backlog !== undefined && stored.watch?.groups !== undefined && stored.watch.scanned !== undefined &&
    stored.watch.opportunities !== undefined && stored.watch.skipped !== undefined &&
    stored.others.every(hasHeadline) && stored.pairings.every((item) => item.priority !== undefined && hasHeadline(item))
  ) return stored as Digest;

  const { radar, ...digest } = stored;
  const item = (value: StoredItem): DigestItem => ({
    ...value,
    leadership: { ...value.leadership, headline: value.leadership.headline ?? "" },
  });
  return {
    ...digest,
    pairings: digest.pairings.map((value) => ({
      ...value,
      ...item(value),
      priority: value.priority ?? (value.strength >= CONFIG.p0MatchStrength ? "P0" : "P1"),
    })),
    others: (digest.others ?? radar ?? []).map(item),
    othersHidden: digest.othersHidden ?? 0,
    backlog: digest.backlog ?? [],
    watch: {
      ...digest.watch,
      groups: digest.watch?.groups ?? [],
      scanned: digest.watch?.scanned ?? 0,
      opportunities: digest.watch?.opportunities ?? [],
      skipped: digest.watch?.skipped ?? [],
    },
  };
}

function deliveredSnapshot(date: string): Digest | null {
  const latest = readJson<StoredDigest | null>(PATHS.latest, null);
  if (latest?.date === date) {
    const digest = normalizeDigest(latest);
    if (digest !== latest) writeJson(PATHS.latest, digest);
    return digest;
  }
  // Existing installations have historic JSON digests but the latest standalone runner stopped saving them.
  const historic = readJson<StoredDigest | null>(join(PATHS.digests, `${date}.json`), null);
  if (!historic) return null;
  const digest = normalizeDigest(historic);
  writeJson(PATHS.latest, digest);
  return digest;
}

async function run(force: boolean, dryRun: boolean, incremental = false): Promise<RadarResult> {
  const date = radarDate();
  const state = loadState();
  const deliveredToday = state.lastRunDate === date;
  if (deliveredToday && !force && !dryRun && !incremental) {
    const digest = deliveredSnapshot(date);
    if (digest) return { digest, text: renderMarkdown(digest) };
  }

  // Preview/redo today's window without mutating the durable sent ledger until delivery succeeds.
  const redoToday = !incremental && (force || dryRun || deliveredToday);
  const withoutToday = <T extends { date: string }>(records: Record<string, T>): Record<string, T> =>
    redoToday ? Object.fromEntries(Object.entries(records).filter(([, entry]) => entry.date !== date)) : records;
  const reported = withoutToday(state.reported);
  const loadedWatch = loadWatchState();
  const watchState = { cursors: { ...loadedWatch.cursors }, reported: withoutToday(loadedWatch.reported) };
  if (redoToday) rewindToday(watchState);

  const [[registry, leaders], issues] = await Promise.all([
    timed("context", () => Promise.all([loadRegistry(), loadLeaders()])),
    timed("backlog", fetchBacklog),
  ]);
  const nowSec = Date.now() / 1000;
  const windowStart = nowSec - CONFIG.lookbackHours * 3600;
  const [{ window, analysis, ideas, matches }, swept] = await Promise.all([
    (async () => {
      const sample = await timed("fetch", () => fetchMessages(CONFIG.channel.id, Math.floor(nowSec - CONFIG.baselineDays * 86_400)));
      const window = sample.filter((message) => Number(message.ts) >= windowStart);
      const analysis = await analyze(window, sample, state, leaders);
      const ideas = selectIdeas(analysis.candidates, reported);
      const matches = await timed(`match (${ideas.length})`, () => match(ideas.map((idea) => idea.c), registry.problems));
      return { window, analysis, ideas, matches };
    })(),
    // A failed watch does not cost the rest of the digest or advance its cursors. Cancellation is never a partial success.
    sweep(watchState, registry.problems, leaders, nowSec, incremental).then(
      (result) => ({ result, error: "" }),
      (error: unknown) => {
        throwIfAborted();
        console.error(`watch sweep failed: ${safeMessage(error)}`);
        return { result: null, error: safeMessage(error).slice(0, 120) };
      },
    ),
  ]);
  const selection = swept.result && { sweep: swept.result, ...selectOpportunities(swept.result.found, watchState.reported, date) };
  const watch: DigestWatch = selection
    ? {
        groups: selection.sweep.groups,
        scanned: selection.sweep.scanned,
        opportunities: selection.picked,
        skipped: [...new Set(selection.sweep.failed.map((failure) => failure.label))],
      }
    : { ...NO_WATCH, error: swept.error };
  const digest = buildDigest({
    date,
    scanned: window.length,
    analysis,
    ideas,
    matches,
    problems: registry.problems,
    backlog: selectBacklog(issues, date),
    watch,
  });
  pruneClassified(state, windowStart);
  throwIfAborted();

  if (dryRun) {
    saveState(state); // Classification cache only: sent items, lastRunDate, latest.json and watch state are unchanged.
    return { digest, text: renderMarkdown(digest) };
  }
  if (deliveredToday && !force && !incremental) {
    // Recovery for an imported sent ledger with no retained digest: rebuild the UI snapshot, never send a duplicate.
    writeJson(PATHS.latest, digest);
    return { digest, text: renderMarkdown(digest) };
  }

  // Manual scans publish without Slack delivery; both paths retain existing discovery ledgers.
  if (!incremental) await deliver(digest);
  throwIfAborted();
  writeJson(PATHS.latest, digest);
  state.reported = reported;
  const lastRunDate = state.lastRunDate;
  commitDigest(state, digest);
  if (incremental) state.lastRunDate = lastRunDate;
  saveState(state);
  if (selection) commitSweep(watchState, selection.sweep, selection.reported);
  return { digest, text: renderMarkdown(digest) };
}

function feedback(input: RadarInput): RadarResult {
  const { id, vote, note = "" } = input;
  if (!id || (vote !== "up" && vote !== "down")) throw new Error("Feedback requires an item id and an up/down vote");
  const item = loadState().items[id];
  if (!item) throw new Error(`Unknown digest item "${id}"; use an id from a delivered digest`);
  recordFeedback({
    at: new Date().toISOString(),
    id,
    vote,
    note,
    category: item.category,
    ideaTitle: item.title,
    problemTitle: item.problemTitle,
  });
  return { digest: null, text: `recorded ${vote} for ${id}: ${item.title}${item.problemTitle ? ` → ${item.problemTitle}` : ""}` };
}

async function refresh(): Promise<RadarResult> {
  const [registry, leaders] = await Promise.all([loadRegistry(true), loadLeaders(true)]);
  return {
    digest: null,
    text: [
      `registry: ${registry.problems.length} problems`,
      ...registry.problems.map((problem) => `  [${problem.kind}] ${problem.title}`),
      `leadership: ${leaders.chain.length} people in chain, ${leaders.priorities.length} priorities`,
      ...leaders.priorities.map((priority) => `  ${priority.theme}`),
    ].join("\n"),
  };
}

/**
 * Bundled host-library entry point; no CLI, cwd, standalone repository, or external script dependency.
 *
 * The host supplies absolute plugin storage and its reload/shutdown signal, and owns scheduling, importing/exporting
 * that directory, and inbox read/dismiss state. Mutations of one directory are serialized. `run` returns full findings
 * even when already delivered today and honors force/dryRun. `scan` checks all sources incrementally and publishes
 * without Slack delivery or changing the daily delivery date. Dry runs never publish or advance sent/watch state.
 * Other actions return digest:null: refresh rebuilds context, feedback appends the taste ledger, backfill writes calibration
 * reports under dataDir, and webhook validates then stores the connection under the existing login Keychain identity.
 * Missing tokens are obtained through RADAR_DEV_BIN or the login shell's dev, scoped to this invocation only.
 */
export async function executeRadar(input: RadarInput, context: RadarContext): Promise<RadarResult> {
  return serializeRadar(context, async () => {
    try {
      switch (input.action) {
        case "run": return await run(input.force ?? false, input.dryRun ?? false);
        case "scan": return await run(false, false, true);
        case "refresh": return await refresh();
        case "feedback": return feedback(input);
        case "backfill": {
          const days = input.days ?? 14;
          if (!Number.isInteger(days) || days < 1) throw new Error("Backfill days must be a positive integer");
          return { digest: null, text: `report: ${await backfill(days)}` };
        }
        case "webhook": return { digest: null, text: await connectWebhook(input.url ?? "") };
        default: throw new Error("Unknown Radar action");
      }
    } catch (error) {
      if (radarSignal().aborted) {
        const canceled = new Error("Radar execution canceled");
        canceled.name = "AbortError";
        throw canceled;
      }
      const message = safeMessage(error);
      const hint = error instanceof GatewayError && error.kind === "auth" && !message.includes("dev tokens acquire")
        ? " Run `dev tokens acquire`, then retry."
        : "";
      // Deliberately omit causes: subprocess errors can retain credential-bearing argv on their error objects.
      throw new Error(message + hint);
    }
  });
}
