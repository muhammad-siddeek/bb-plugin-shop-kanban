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
    issuesUrl: "https://vault.shopify.io/teams/2902-ExP/issues",
    channels: [
      { id: "C0591HU360M", name: "exp-team" },
      { id: "C0132GND4TB", name: "help-exp" },
    ],
  },
  model: "claude-sonnet-5-5",
  timezone: "America/Toronto",
  userCacheMaxAgeDays: 30,
  leadersBootstrapDays: 30,
  classifyBatchSize: 15,
  updateBatchChars: 80_000,
  minCategoryConfidence: 0.6,
  minMatchStrength: 0.7,
  p0MatchStrength: 0.85,
  minReactors: 2,
  weights: { match: 0.5, leadership: 0.3, traction: 0.2 },
  resurfaceFactor: 2,
  feedbackExamples: 15,
  backlogDueWithinDays: 1,
};

export const KEEP_CATEGORIES = ["new_tech", "new_finding", "leadership_push"] as const;

export interface WatchSources {
  channels: { id: string; name: string; includeBots?: boolean }[];
  repos: string[];
  vault: { projectTeams: string[]; issueTeams: string[] };
}

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
  vault: { projectTeams: ["2902", "16737"], issueTeams: ["16737"] },
};

export const WATCH_LIMITS = {
  minAsk: 4,
  minAmbition: 4,
  minCredible: 3,
  chunkChars: 400_000,
};

export const radarDate = (at = new Date()): string => at.toLocaleDateString("en-CA", { timeZone: CONFIG.timezone });
