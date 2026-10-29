import { z } from "zod";
import { forgeInput } from "../contract";

/**
 * A card's state. Blocked cards (waiting on the user or errored) sit in the WIP column, marked red; Parked holds idle
 * threads the user set aside to come back to.
 */
export const STATUS_IDS = ["queue", "wip", "blocked", "done", "parked"] as const;
export type Status = (typeof STATUS_IDS)[number];

export const COLUMN_IDS = ["queue", "wip", "done", "parked"] as const;
export type Column = (typeof COLUMN_IDS)[number];
/** The column a card in each state sits in. */
export const STATUS_COLUMN: Record<Status, Column> = { queue: "queue", wip: "wip", blocked: "wip", done: "done", parked: "parked" };

const resultSchema = z.enum(["success", "failed"]);
export type Result = z.infer<typeof resultSchema>;

/**
 * Longest failure message a card stores. Every card's state shares one KV row capped at 256KB, so one unbounded
 * message would fail every later board write.
 */
export const ERROR_MAX = 2_000;

const boardColumnSchema = z.object({ id: z.enum(COLUMN_IDS), title: z.string(), description: z.string() });

export const COLUMNS: Record<Column, z.infer<typeof boardColumnSchema>> = {
  queue: { id: "queue", title: "Queue", description: "Threads waiting to be started." },
  wip: {
    id: "wip",
    title: "WIP",
    description: "Threads running or with running children, and idle threads blocked on user input or an error.",
  },
  done: { id: "done", title: "Done", description: "Idle threads whose last message reported completion." },
  parked: { id: "parked", title: "Parked", description: "Idle threads set aside for later, until they run again." },
};

const threadSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  titleFallback: z.string().nullable(),
  status: z.string().nullable(),
  runtimeStatus: z.string().nullable(),
  providerId: z.string().nullable(),
  updatedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
});

/** The card thread's harness session: current execution options (display labels), context usage, and the tree's spend. */
const boardSessionSchema = z.object({
  modelId: z.string().nullable(),
  /** Catalog display name; the raw model id until the provider's catalog has loaded. */
  model: z.string().nullable(),
  reasoning: z.string().nullable(),
  /** Null for the provider's default tier. */
  serviceTier: z.string().nullable(),
  access: z.string().nullable(),
  /**
   * Spent by the thread, its harness subagents and every descendant thread, archived ones included; null while
   * it is first read, or when no harness in the tree reports cost.
   */
  cost: z.object({ amount: z.number(), currency: z.string() }).nullable(),
  /**
   * The part of `cost` that is estimated: replies a harness saved with tokens but no price (omp 18.13's Shopify
   * Auto replies), priced at the average rates that provider and model charged in the host's other transcripts.
   */
  costEstimated: z.number(),
  /** Threads whose spend is in `cost`, the card's own included. */
  costThreads: z.number(),
  usedTokens: z.number().nullable(),
  contextWindow: z.number().nullable(),
  /** Token counts are bb's estimate rather than the harness's report. */
  estimated: z.boolean(),
});

const boardTaskSchema = z.object({
  threadId: z.string(),
  shortName: z.string(),
  titleChain: z.string(),
  status: z.enum(STATUS_IDS),
  column: z.enum(COLUMN_IDS),
  parentThreadId: z.string().nullable(),
  projectId: z.string().nullable(),
  description: z.string().nullable(),
  result: resultSchema.nullable(),
  note: z.string().nullable(),
  childCount: z.number(),
  runningChildCount: z.number(),
  statusReason: z.string().nullable(),
  /** In Queue with a message waiting to send (held for a WIP slot, or otherwise queued), so starting it now can send it. */
  startable: z.boolean(),
  /** bb's unread state: new activity since the user last opened the thread. */
  unread: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUserInputAt: z.string().nullable(),
  missingThread: z.boolean(),
  thread: threadSummarySchema.nullable(),
  session: boardSessionSchema.nullable(),
});

/** The highest WIP limit the board takes. */
export const WIP_LIMIT_MAX = 50;
/** The WIP limit: at most `limit` cards running at once (null: no limit), and how many threads wait for a slot. */
const wipLimitSchema = z.object({ limit: z.number().int().nullable(), waiting: z.number().int() });
export type WipLimitView = z.infer<typeof wipLimitSchema>;

const boardStateSchema = z.object({ columns: z.array(boardColumnSchema), tasks: z.array(boardTaskSchema), wipLimit: wipLimitSchema });

const shortNameInput = z.string().trim().min(1).max(40);
const threadRefSchema = z.object({ threadId: z.string() });

/** A thread matching a search: any visible thread, archived or not, on the board or not. */
const searchResultSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  snippet: z.string().nullable(),
  archived: z.boolean(),
  updatedAt: z.number().nullable(),
});

const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  /** Threads in the index. */
  indexed: z.number(),
  /** A sync is exporting or re-indexing threads right now. */
  indexing: z.boolean(),
  /** Why search or the last index sync failed; null when both are fine. */
  error: z.string().nullable(),
});

export const reviewRiskSchema = z.enum(["low", "medium", "high"]);
/** Whose review a pull request asks for: the user's by name, or one of their teams'. Me first. */
export const reviewScopeSchema = z.enum(["me", "team"]);

/** An open pull request waiting on the user's review: a one-card entry in the Queue column's Reviews section. */
const reviewCardSchema = z.object({
  /** `<forge>:<owner>/<repo>#<number>` */
  id: z.string(),
  forge: forgeInput,
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  bot: z.boolean(),
  draft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Null until the pull request's details are read. */
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  changedFiles: z.number().nullable(),
  /** The model's first read: risk and up to three sentences (what, why, what could break). */
  risk: reviewRiskSchema.nullable(),
  summary: z.string().nullable(),
  /** A summary for the current head is being written. */
  summarizing: z.boolean(),
  /** Not opened from the board since its head commit last moved. */
  unread: z.boolean(),
  /** The user reviewed an older head: commits landed since their review. */
  rereview: z.boolean(),
  /** Me when a search for the user found it, otherwise Team. */
  scope: reviewScopeSchema,
});

/** One configured search: what it found, and why it failed. */
const reviewSourceSchema = z.object({
  search: z.string(),
  scope: reviewScopeSchema,
  /** Open matches read, before archived and already-reviewed ones are hidden. */
  count: z.number(),
  /** Every open match, the user's own reviews included. */
  total: z.number(),
  error: z.string().nullable(),
  /** Cannot run here: no connected persistent host, or the forge's CLI is not installed or not signed in. Shown quietly. */
  missing: z.boolean(),
});

const reviewStateSchema = z.object({
  /** Scopes with at least one search line, Me first; none turns the queue off. */
  scopes: z.array(reviewScopeSchema),
  /** Most recently updated first; archived and reviewed ones are left out. */
  reviews: z.array(reviewCardSchema),
  sources: z.array(reviewSourceSchema),
  refreshing: z.boolean(),
  refreshedAt: z.number().nullable(),
  /** An unexpected failure of the whole refresh. */
  error: z.string().nullable(),
});

const reviewRefSchema = z.object({ id: z.string().min(1).max(300) });
const okSchema = z.object({ ok: z.boolean() });

export const rpcContract = {
  board_list: { input: z.null(), output: boardStateSchema },
  board_spawn_task: {
    input: z.object({
      shortName: shortNameInput,
      prompt: z.string().trim().min(1).max(12_000),
      projectId: z.string().optional(),
      parentThreadId: z.string().optional(),
    }),
    output: boardTaskSchema,
  },
  board_remove_task: { input: threadRefSchema, output: z.object({ removed: z.boolean() }) },
  /** Park an idle thread (it stays in Parked until it runs again), or unpark it. */
  board_park_task: { input: z.object({ threadId: z.string(), parked: z.boolean() }), output: boardTaskSchema },
  /** Start a Queue card now: send its waiting message with bb's Send now, past the WIP limit. */
  board_start_task: { input: threadRefSchema, output: boardTaskSchema },
  board_mark_read: { input: threadRefSchema, output: z.object({ ok: z.boolean() }) },
  /** Set the WIP limit (null: none); messages that would start another card past it wait in their thread's queue. */
  board_set_wip_limit: { input: z.object({ limit: z.number().int().min(0).max(WIP_LIMIT_MAX).nullable() }), output: wipLimitSchema },
  board_search: { input: z.object({ query: z.string().trim().min(1).max(200) }), output: searchResponseSchema },
  reviews_list: { input: z.null(), output: reviewStateSchema },
  /** Mark read and return the prompt that seeds a new thread explaining the pull request. */
  reviews_draft: { input: reviewRefSchema, output: z.object({ prompt: z.string() }) },
  reviews_mark_read: { input: reviewRefSchema, output: okSchema },
  /** Hide a pull request from the queue for good. */
  reviews_archive: { input: reviewRefSchema, output: okSchema },
  /** Approve, or request changes with a reason, as the user; the pull request then leaves the queue. */
  reviews_submit: {
    input: z.object({
      id: reviewRefSchema.shape.id,
      verdict: z.enum(["approve", "request_changes"]),
      body: z.string().trim().max(10_000),
    }),
    output: okSchema,
  },
};

/**
 * One entry of the stored tasks KV blob: what spawning a thread recorded, and its last failure message. Unknown keys
 * (entries from before 0.9.0, and the column, result and note agents reported before 0.14.0) are stripped.
 */
export const storedTaskSchema = z.object({
  threadId: z.string(),
  shortName: z.string(),
  titleChain: z.string(),
  parentThreadId: z.string().nullable().catch(null),
  projectId: z.string().nullable().catch(null),
  description: z.string().nullable().catch(null),
  error: z.string().nullable().catch(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoredTask = z.infer<typeof storedTaskSchema>;

export type BoardTask = z.infer<typeof boardTaskSchema>;
export type BoardSession = z.infer<typeof boardSessionSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type ReviewRisk = z.infer<typeof reviewRiskSchema>;
export type ReviewScope = z.infer<typeof reviewScopeSchema>;
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export type ReviewSource = z.infer<typeof reviewSourceSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;
