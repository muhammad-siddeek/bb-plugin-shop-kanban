import { radarPath } from "./runtime";

export const PATHS = {
  get state() { return radarPath("state.json"); },
  get users() { return radarPath("users.json"); },
  get registry() { return radarPath("registry.json"); },
  get leaders() { return radarPath("leaders.json"); },
  get feedback() { return radarPath("feedback.jsonl"); },
  get calibration() { return radarPath("calibration"); },
  get watchState() { return radarPath("watch-state.json"); },
  get canvas() { return radarPath("canvas.json"); },
  get latest() { return radarPath("latest.json"); },
  get digests() { return radarPath("digests"); },
};

export const CONFIG = {
  slackHost: "https://shopify.enterprise.slack.com",
  channel: { id: "C08J7AHA3TQ", name: "ai-centaurs" },
  me: { slackId: "U0BT2991JV6", vaultId: "40658" },
  team: {
    name: "ExP",
    vaultId: "2902",
    // Vault issues page the resiliency backlog reads: every open issue on it, nothing pre-filtered.
    issuesUrl: "https://vault.shopify.io/teams/2902-ExP/issues",
    channels: [
      { id: "C0591HU360M", name: "exp-team" },
      { id: "C0132GND4TB", name: "help-exp" },
    ],
  },
  model: "claude-sonnet-5-5",
  // The full digest lives in this Slack canvas (inline links); the DM is a one-line summary pointing at it.
  canvasTitle: "Radar",
  // The host owns scheduling; all engine dates follow the same Toronto calendar.
  timezone: "America/Toronto",

  // Daily window: everything in the last N hours is (re)scored; traction keeps accruing for ~72h.
  lookbackHours: 72,
  // Traction baseline (percentiles) is computed over this many days of top-level messages.
  baselineDays: 14,
  registryMaxAgeDays: 7,
  leadersMaxAgeDays: 7,
  userCacheMaxAgeDays: 30,

  // Thread context fetched for classification.
  threadMinReplies: 3,
  maxThreads: 20,
  maxRepliesPerThread: 12,
  classifyBatchSize: 15,
  // Re-classify a cached message when its thread grew by at least this many replies.
  reclassifyReplyGrowth: 5,

  // Gates
  minCategoryConfidence: 0.6,
  minMatchStrength: 0.7,
  // Pairings at or above this fit are rated P0 (matcher rubric: "directly hits the problem's stated pain").
  p0MatchStrength: 0.85,
  minReactors: 2,
  // Ranking weights (priority order: ExP fit, leadership, traction).
  weights: { match: 0.5, leadership: 0.3, traction: 0.2 },
  // A reported idea may reappear only when its traction grew by this factor.
  resurfaceFactor: 2,

  maxPairings: 5,
  maxPairingsPerProblem: 2,
  // Unpaired ideas listed as P2 bullets after the pairings.
  maxOthers: 4,
  feedbackExamples: 15,
  // Resiliency backlog (open Vault issues): anyone's issue shows once its SLA fix-due date is at most this many
  // days away; open issues assigned to you always show.
  backlogDueWithinDays: 1,
};

export const KEEP_CATEGORIES = ["new_tech", "new_finding", "leadership_push"] as const;

export interface WatchGroup {
  name: string;
  /** Swept in the daily run once its sources were last swept at least this many days ago. */
  everyDays: number;
  /** `includeBots` for alert channels, where recurring alerts are the signal. */
  channels: { id: string; name: string; includeBots?: boolean }[];
  /** GitHub `owner/repo`; PRs opened since the last sweep are judged. */
  repos: string[];
  /**
   * Vault teams judged as a snapshot: active GSD projects (direct team only) and open issues (Vault includes
   * subtree teams, so list a parent once rather than it and its children).
   */
  vault: { projectTeams: string[]; issueTeams: string[] };
  /** Threads started this many days back are re-read when they get new replies. */
  threadWindowDays: number;
  /** Catch-up cap when the last sweep is older than this (first run, Mac off, paused automation). */
  maxLookbackHours: number;
}

// Opportunity watch sources, folded into the daily digest. Daily: help/on-call, active projects, team channels and
// core repos. Weekly: planning and sister-team channels in Charlie King's org, plus Vault snapshots.
export const WATCH: WatchGroup[] = [
  {
    name: "daily",
    everyDays: 1,
    channels: [
      { id: "C0132GND4TB", name: "help-exp" },
      { id: "CC94M5K45", name: "experiments-goalie", includeBots: true },
      { id: "C0AT1SSJY92", name: "proj-exp-unified-verdict" },
      { id: "C0591HU360M", name: "exp-team" },
      { id: "C0AHGUJG0G4", name: "exp-river" },
      { id: "C0C6X49BWQ1", name: "temp-verdict-rust-modernization" },
      { id: "C0AT86YE0BG", name: "exp-agentic-alerts" },
    ],
    repos: ["Shopify/experiments-data", "Shopify/exp-stats", "shopify-playground/verdict-rust-core"],
    vault: { projectTeams: [], issueTeams: [] },
    threadWindowDays: 7,
    maxLookbackHours: 96,
  },
  {
    name: "weekly",
    everyDays: 7,
    channels: [
      { id: "C0C136TUPU5", name: "exp-2027-big-bets-burst" },
      { id: "C0BPSMEKS82", name: "proj-exp-flag-scorecards" },
      { id: "C0C0X0L3UKU", name: "proj-talespin-fireworks-rl-gym" },
      { id: "C0AFCF0JQRK", name: "simgym-team" },
      { id: "C0C2LAQNVRB", name: "proj-agent-server-browser-use" },
      { id: "C0AKUSQ9SD6", name: "proj-static-shop-cloner" },
    ],
    repos: ["shopify-playground/merchant-experimentation-data"],
    // ExP (2902) and Optimization (16737, Charlie King's org; its issue list already includes ExP's).
    vault: { projectTeams: ["2902", "16737"], issueTeams: ["16737"] },
    threadWindowDays: 14,
    maxLookbackHours: 8 * 24,
  },
];

export const WATCH_LIMITS = {
  // Only a big ask with a big solution the team could plausibly accept makes the digest. Scores are 1-5. The
  // best-ranked solution (fit + buy-in) is usually the direct fix, so the gate looks at every credible solution.
  minAsk: 4,
  minAmbition: 4,
  /** A solution counts as credible with fit and buy-in both at least this. */
  minCredible: 3,
  maxItems: 3,
  /** A group counts as due this long before its full cadence, so a run a little earlier than yesterday's still sweeps. */
  dueGraceHours: 3,
  /** Per-channel and per-thread caps on what the judge sees (Slack rate-limits thread reads). */
  maxThreadsPerChannel: 20,
  maxRepliesPerThread: 40,
  maxPrsPerRepo: 20,
  /**
   * Judge input is split into chunks of about this many characters (~100K tokens). Chunks are judged separately and
   * may name one problem differently, so a sweep should fit in one.
   */
  chunkChars: 400_000,
};

export const radarDate = (at = new Date()): string => at.toLocaleDateString("en-CA", { timeZone: CONFIG.timezone });
