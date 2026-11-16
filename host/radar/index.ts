import { fetchBacklog, selectBacklog } from "./backlog";
import { backfill } from "./backfill";
import { CONFIG, PATHS, radarDate } from "./config";
import { NO_WATCH, renderMarkdown, type Digest, type DigestItem, type DigestWatch, type Pairing } from "./digest";
import { recordFeedback } from "./feedback";
import { GatewayError } from "./gateway";
import { loadLeaders } from "./leaders";
import { timed } from "./log";
import { match } from "./match";
import { analyze, buildDigest, commitDigest, loadState, saveState, selectIdeas } from "./pipeline";
import { loadRegistry } from "./registry";
import { radarSignal, safeMessage, serializeRadar, throwIfAborted, type RadarContext } from "./runtime";
import { scanChannel } from "./slack";
import { writeJson } from "./store";
import { commitSweep, loadWatchState, selectOpportunities, sweep } from "./watch";

export type { Digest } from "./digest";
export type { RadarContext } from "./runtime";

export interface RadarInput {
  action: "scan" | "refresh" | "backfill" | "feedback";
  days?: number;
  id?: string;
  vote?: "up" | "down";
  note?: string;
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
    stored.backlog !== undefined && stored.watch !== undefined && !("groups" in stored.watch) && stored.watch.scanned !== undefined &&
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
      ...(digest.watch?.error === undefined ? {} : { error: digest.watch.error }),
      scanned: digest.watch?.scanned ?? 0,
      opportunities: digest.watch?.opportunities ?? [],
      skipped: digest.watch?.skipped ?? [],
    },
  };
}

async function scan(): Promise<RadarResult> {
  const date = radarDate();
  const nowSec = Date.now() / 1000;
  const state = loadState();
  const watchState = loadWatchState();
  const sourceKey = `slack:${CONFIG.channel.id}`;
  const since = state.cursors?.[sourceKey] ?? 0;
  const [[registry, leaders], issues] = await Promise.all([
    timed("context", () => Promise.all([loadRegistry(), loadLeaders()])),
    timed("backlog", fetchBacklog),
  ]);
  const [{ channel, analysis, ideas, matches }, swept] = await Promise.all([
    (async () => {
      const channel = await timed("fetch", () => scanChannel(CONFIG.channel.id, since, nowSec, state.channels?.[sourceKey]));
      const sample = Object.values(channel.state.threads).map((thread) => thread.message);
      const threads = Object.fromEntries(channel.messages.map((message) => [message.ts, channel.state.threads[message.ts].replies]));
      const analysis = await analyze(channel.messages, sample, state, leaders, threads);
      const ideas = selectIdeas(analysis.candidates, state.reported);
      const matches = await timed(`match (${ideas.length})`, () => match(ideas.map((idea) => idea.c), registry.problems));
      return { channel, analysis, ideas, matches };
    })(),
    // A failed watch never advances its checkpoints. Cancellation is never a partial success.
    sweep(watchState, registry.problems, leaders, nowSec).then(
      (result) => ({ result, error: "" }),
      (error: unknown) => {
        throwIfAborted();
        const message = safeMessage(error);
        console.error(`watch sweep failed: ${message}`);
        return { result: null, error: message.slice(0, 120) };
      },
    ),
  ]);
  const selection = swept.result && { sweep: swept.result, ...selectOpportunities(swept.result.found, watchState.reported, date) };
  const watch: DigestWatch = selection
    ? {
        scanned: selection.sweep.scanned,
        opportunities: selection.picked,
        skipped: [...new Set(selection.sweep.failed.map((failure) => failure.label))],
      }
    : { ...NO_WATCH, error: swept.error };
  const digest = buildDigest({
    date,
    scanned: channel.messages.length,
    windowHours: Math.max(0, nowSec - since) / 3600,
    analysis,
    ideas,
    matches,
    problems: registry.problems,
    backlog: selectBacklog(issues, date),
    watch,
  });
  throwIfAborted();
  // The complete findings are durable before any source checkpoint can advance.
  writeJson(PATHS.latest, digest);
  commitDigest(state, digest);
  state.cursors = { ...state.cursors, [sourceKey]: Math.max(since, nowSec) };
  state.channels = { ...state.channels, [sourceKey]: channel.state };
  saveState(state);
  if (selection) commitSweep(watchState, selection.sweep, selection.reported);
  return { digest, text: renderMarkdown(digest) };
}

function feedback(input: RadarInput): RadarResult {
  const { id, vote, note = "" } = input;
  if (!id || (vote !== "up" && vote !== "down")) throw new Error("Feedback requires an item id and an up/down vote");
  const item = loadState().items[id];
  if (!item) throw new Error(`Unknown Radar item "${id}"; use an id from a published finding`);
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
  const [registry, leaders] = await Promise.all([loadRegistry(), loadLeaders()]);
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
 * that directory, and inbox read/dismiss state. Mutations of one directory are serialized. Every scan resumes durable
 * source checkpoints and returns every qualifying finding, without daily snapshots, previews, or Slack delivery.
 * Other actions return digest:null: refresh incrementally updates context, feedback appends the taste ledger, and
 * explicit backfill writes calibration reports under dataDir without advancing discovery checkpoints.
 * Missing tokens are obtained through RADAR_DEV_BIN or the login shell's dev, scoped to this invocation only.
 */
export async function executeRadar(input: RadarInput, context: RadarContext): Promise<RadarResult> {
  return serializeRadar(context, async () => {
    try {
      switch (input.action) {
        case "scan": return await scan();
        case "refresh": return await refresh();
        case "feedback": return feedback(input);
        case "backfill": {
          const days = input.days ?? 14;
          if (!Number.isInteger(days) || days < 1) throw new Error("Backfill days must be a positive integer");
          return { digest: null, text: `report: ${await backfill(days)}` };
        }
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
