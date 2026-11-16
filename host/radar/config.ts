import { radarPath } from "./runtime";

export const PATHS = {
  get state() { return radarPath("state.json"); },
  get users() { return radarPath("users.json"); },
  get registry() { return radarPath("registry.json"); },
  get leaders() { return radarPath("leaders.json"); },
  get feedback() { return radarPath("feedback.jsonl"); },
  get calibration() { return radarPath("calibration"); },
  get watchState() { return radarPath("watch-state.json"); },
  get latest() { return radarPath("latest.json"); },
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
  // The host owns scheduling; all engine dates follow the same Toronto calendar.
  timezone: "America/Toronto",

  userCacheMaxAgeDays: 30,

  // Classification batches bound individual model calls, never the discoveries retained.
  classifyBatchSize: 15,

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

  feedbackExamples: 15,
  // Resiliency backlog (open Vault issues): anyone's issue shows once its SLA fix-due date is at most this many
  // days away; open issues assigned to you always show.
  backlogDueWithinDays: 1,
};

export const KEEP_CATEGORIES = ["new_tech", "new_finding", "leadership_push"] as const;

export interface WatchSources {
  /** `includeBots` for alert channels, where recurring alerts are the signal. */
  channels: { id: string; name: string; includeBots?: boolean }[];
  /** GitHub `owner/repo`; PRs updated since each repo's durable checkpoint are judged. */
  repos: string[];
  /**
   * Vault teams judged as a snapshot: active GSD projects (direct team only) and open issues (Vault includes
   * subtree teams, so list a parent once rather than it and its children).
   */
  vault: { projectTeams: string[]; issueTeams: string[] };
}

// Every refresh checks the same sources; cursors restrict judging to new activity.
export const WATCH: WatchSources = {
  channels: [
    { id: "C0132GND4TB", name: "help-exp" },
    { id: "CC94M5K45", name: "experiments-goalie", includeBots: true },
    { id: "C0AT1SSJY92", name: "proj-exp-unified-verdict" },
    { id: "C0591HU360M", name: "exp-team" },
    { id: "C0AHGUJG0G4", name: "exp-river" },
    { id: "C0C6X49BWQ1", name: "temp-verdict-rust-modernization" },
    { id: "C0AT86YE0BG", name: "exp-agentic-alerts" },
    { id: "C0C136TUPU5", name: "exp-2027-big-bets-burst" },
    { id: "C0BPSMEKS82", name: "proj-exp-flag-scorecards" },
    { id: "C0C0X0L3UKU", name: "proj-talespin-fireworks-rl-gym" },
    { id: "C0AFCF0JQRK", name: "simgym-team" },
    { id: "C0C2LAQNVRB", name: "proj-agent-server-browser-use" },
    { id: "C0AKUSQ9SD6", name: "proj-static-shop-cloner" },
  ],
  repos: ["Shopify/experiments-data", "Shopify/exp-stats", "shopify-playground/verdict-rust-core", "shopify-playground/merchant-experimentation-data"],
  // Optimization's issue list includes ExP; don't fetch those issues twice.
  vault: { projectTeams: ["2902", "16737"], issueTeams: ["16737"] },
};

export const WATCH_LIMITS = {
  // Only a big ask with a big solution the team could plausibly accept makes the digest. Scores are 1-5. The
  // best-ranked solution (fit + buy-in) is usually the direct fix, so the gate looks at every credible solution.
  minAsk: 4,
  minAmbition: 4,
  /** A solution counts as credible with fit and buy-in both at least this. */
  minCredible: 3,
  /**
   * Judge input is split into chunks of about this many characters (~100K tokens). Chunks are judged separately and
   * may name one problem differently, so a sweep should fit in one.
   */
  chunkChars: 400_000,
};

export const radarDate = (at = new Date()): string => at.toLocaleDateString("en-CA", { timeZone: CONFIG.timezone });
