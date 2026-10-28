import { z } from "zod";
import { forgeInput } from "../contract";

export const COLUMN_IDS = ["queue", "wip", "blocked", "done"] as const;
export type Column = (typeof COLUMN_IDS)[number];

export const columnSchema = z.enum(COLUMN_IDS);
const resultSchema = z.enum(["success", "failed"]);
export type Result = z.infer<typeof resultSchema>;

const boardColumnSchema = z.object({ id: columnSchema, title: z.string(), description: z.string() });

export const COLUMNS: Record<Column, z.infer<typeof boardColumnSchema>> = {
  queue: { id: "queue", title: "Queue", description: "Threads waiting to be started." },
  wip: { id: "wip", title: "WIP", description: "Threads currently running, or with running children." },
  blocked: { id: "blocked", title: "Blocked", description: "Idle threads that need user input or asked a question." },
  done: { id: "done", title: "Done", description: "Idle threads whose last message reported completion." },
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
  column: columnSchema,
  parentThreadId: z.string().nullable(),
  projectId: z.string().nullable(),
  description: z.string().nullable(),
  result: resultSchema.nullable(),
  note: z.string().nullable(),
  showOnBoard: z.boolean(),
  showChildren: z.boolean(),
  childCount: z.number(),
  hiddenChildCount: z.number(),
  runningChildCount: z.number(),
  statusReason: z.string().nullable(),
  /** bb's unread state: new activity since the user last opened the thread. */
  unread: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUserInputAt: z.string().nullable(),
  missingThread: z.boolean(),
  thread: threadSummarySchema.nullable(),
  session: boardSessionSchema.nullable(),
});

const boardStateSchema = z.object({ columns: z.array(boardColumnSchema), tasks: z.array(boardTaskSchema) });

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

/** An open pull request waiting on the user's review: a one-card entry at the top of the Queue column. */
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
  /** The forge's CLI is not installed on the host. */
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
  /** Why no search could run, e.g. no connected host. */
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
      column: columnSchema.optional(),
      showOnBoard: z.boolean().optional(),
    }),
    output: boardTaskSchema,
  },
  board_update_task: {
    input: z.object({
      threadId: z.string(),
      column: columnSchema.optional(),
      shortName: shortNameInput.optional(),
      note: z.string().trim().max(2_000).optional(),
      result: resultSchema.nullable().optional(),
      showOnBoard: z.boolean().optional(),
      showChildren: z.boolean().optional(),
    }),
    output: boardTaskSchema,
  },
  board_remove_task: { input: threadRefSchema, output: z.object({ removed: z.boolean() }) },
  board_mark_read: { input: threadRefSchema, output: z.object({ ok: z.boolean() }) },
  board_search: { input: z.object({ query: z.string().trim().min(1).max(200) }), output: searchResponseSchema },
  reviews_list: { input: z.null(), output: reviewStateSchema },
  /** Re-run the searches now; resolves once they are read. */
  reviews_refresh: { input: z.null(), output: reviewStateSchema },
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

export type StoredTask = {
  threadId: string;
  shortName: string;
  titleChain: string;
  column: Column;
  parentThreadId: string | null;
  projectId: string | null;
  description: string | null;
  result: Result | null;
  note: string | null;
  showOnBoard: boolean;
  showChildren: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BoardTask = z.infer<typeof boardTaskSchema>;
export type BoardSession = z.infer<typeof boardSessionSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type ReviewRisk = z.infer<typeof reviewRiskSchema>;
export type ReviewScope = z.infer<typeof reviewScopeSchema>;
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export type ReviewSource = z.infer<typeof reviewSourceSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;
