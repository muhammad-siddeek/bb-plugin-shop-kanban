import { z } from "zod";
import { forgeInput } from "../contract";

/**
 * A card's state. Blocked cards (waiting on the user or errored) sit in the Working column, marked red; Parked holds idle
 * threads the user set aside to come back to.
 */
const STATUS_IDS = ["queue", "wip", "blocked", "done", "parked"] as const;
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
    title: "Working",
    description: "Threads with a turn in progress, themselves or in a child thread, and idle threads blocked on user input or an error.",
  },
  done: { id: "done", title: "Done", description: "Idle threads whose last message reported completion." },
  parked: { id: "parked", title: "Parked", description: "Idle threads set aside for later, until they start working again." },
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
  /** In Queue with a message waiting to send (held by the working limit, or otherwise queued), so starting it now can send it. */
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

/** The highest working limit the board takes. */
export const WIP_LIMIT_MAX = 50;
/** The working limit: at most `limit` cards working at once (null: no limit), and how many threads wait for a slot. */
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
const reviewScopeSchema = z.enum(["me", "team"]);

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

/**
 * The Queue column's pull request lists beside Reviews: `open`, the user's open pull requests, drafts included;
 * `shipped`, their recently merged ones not yet both measured and demoed; `assigned`, open issues assigned to them.
 */
const workListSchema = z.enum(["open", "shipped", "assigned"]);

/** A pull request or issue in one of the work lists. */
const workItemSchema = z.object({
  /** `<forge>:<owner>/<repo>#<number>` */
  id: z.string(),
  list: workListSchema,
  forge: forgeInput,
  kind: z.enum(["pr", "issue"]),
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  draft: z.boolean(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  /** Shipped only: the user marked its impact measured, or its change demoed. */
  measured: z.boolean(),
  demoed: z.boolean(),
});

const workSourceSchema = z.object({
  search: z.string(),
  list: workListSchema,
  /** Matches read, before archived (and, for shipped, measured-and-demoed) ones are hidden. */
  count: z.number(),
  total: z.number(),
  error: z.string().nullable(),
  /** Cannot run here: no connected persistent host, or the forge's CLI is not installed or not signed in. Shown quietly. */
  missing: z.boolean(),
});

const workStateSchema = z.object({
  /** Lists with at least one search line; a list without one is hidden. */
  lists: z.array(workListSchema),
  /** Open and assigned: most recently updated first. Shipped: most recently merged first. */
  items: z.array(workItemSchema),
  sources: z.array(workSourceSchema),
  refreshing: z.boolean(),
  refreshedAt: z.number().nullable(),
  error: z.string().nullable(),
});

/** What a work mark records: archived hides an item for good; shipped ones leave once both measured and demoed. */
const workMarkSchema = z.enum(["archived", "measured", "demoed"]);

/** macOS memory pressure (kern.memorystatus_vm_pressure_level), the signal Activity Monitor's pressure graph shows. */
const memoryPressureSchema = z.enum(["normal", "warn", "critical"]);

/**
 * The bb server machine's resources: the computer bb runs on, not the browser viewing it. Byte counts are bytes, rates
 * bytes per second. Fields the OS can't report are null.
 */
const systemStatsSchema = z.object({
  /** The machine's display name ("Muhammad's MacBook Pro"), else its hostname. */
  name: z.string(),
  platform: z.string(),
  uptimeSec: z.number(),
  sampledAt: z.number(),
  intervalMs: z.number(),
  cpu: z.object({
    /** Share of all cores busy over the last interval, 0-100. */
    percent: z.number(),
    cores: z.number(),
    /** Core clusters (Apple silicon's performance levels), largest first; empty when the OS doesn't group them. */
    groups: z.array(z.object({ name: z.string(), cores: z.number() })),
    /** 1, 5 and 15 minute load averages; null on Windows. */
    load: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  }),
  memory: z.object({
    total: z.number(),
    /** What Activity Monitor calls Memory Used: app memory + wired + compressed (macOS); total - available (Linux). */
    used: z.number(),
    app: z.number().nullable(),
    wired: z.number().nullable(),
    compressed: z.number().nullable(),
    /** File cache macOS hands back to apps on demand. */
    cached: z.number().nullable(),
    pressure: memoryPressureSchema.nullable(),
    /** Share of memory the OS counts as free for apps, 0-100 (kern.memorystatus_level on macOS, MemAvailable on Linux). */
    availablePercent: z.number().nullable(),
  }),
  swap: z
    .object({
      total: z.number(),
      used: z.number(),
      /** Paging to and from swap over the last interval; null until two samples exist. */
      inPerSec: z.number().nullable(),
      outPerSec: z.number().nullable(),
    })
    .nullable(),
  /** The volume holding the home directory, where projects, caches and bb's data live. */
  disk: z.object({ total: z.number(), free: z.number() }).nullable(),
  battery: z
    .object({
      percent: z.number(),
      onBattery: z.boolean(),
      /** "charging", "discharging", "charged", ... as the OS words it. */
      state: z.string(),
      /** Minutes left (to empty on battery, to full while charging); null while the OS is still estimating. */
      minutesLeft: z.number().nullable(),
    })
    .nullable(),
  /** Recent samples, oldest first, one per interval: CPU percent and memory used percent. */
  history: z.object({ cpu: z.array(z.number()), memory: z.array(z.number()), swapRate: z.array(z.number()) }),
});
export type SystemStats = z.infer<typeof systemStatsSchema>;

/** Processes grouped by executable name, the heaviest first by CPU and by memory. */
const systemProcessesSchema = z.object({
  sampledAt: z.number(),
  groups: z.array(
    z.object({
      name: z.string(),
      count: z.number(),
      /** Sum of `ps` %CPU (100 = one full core; a decaying average over the last minute on macOS). */
      cpu: z.number(),
      /** Resident memory, bytes. */
      memory: z.number(),
    }),
  ),
  error: z.string().nullable(),
});
export type SystemProcesses = z.infer<typeof systemProcessesSchema>;

/**
 * The signed-in user's Shopify AI proxy spend, from the proxy's per-user counter: every tool on the proxy, not just
 * bb threads. Costs are USD; `today` is the bb machine's local calendar day. Figures are null until a read succeeds;
 * after one has, a failed read keeps them and sets `error`.
 */
const aiUsageSchema = z.object({
  sampledAt: z.number(),
  timezone: z.string(),
  todayCost: z.number().nullable(),
  hourCost: z.number().nullable(),
  /** The proxy's "seven days": today plus the 7 days before it, so 8 calendar days. */
  sevenDaysCost: z.number().nullable(),
  /** The proxy has no pricing loaded, so costs read $0: unknown, not free. */
  pricingStale: z.boolean(),
  /**
   * The last 7 local days, oldest first, ending today; empty unless every day's spend is known. Past days come from
   * the data warehouse (or the server's own readings), today from the proxy.
   */
  days: z.array(z.object({ date: z.string(), cost: z.number() })),
  /** The sum of `days`; null without them. */
  weekCost: z.number().nullable(),
  /** No `days` yet because the warehouse read is still running. */
  daysLoading: z.boolean(),
  /** Why there are no `days`, when the warehouse read failed. */
  daysError: z.string().nullable(),
  error: z.string().nullable(),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

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
  /** Park an idle thread (it stays in Parked until it starts working again), or unpark it. */
  board_park_task: { input: z.object({ threadId: z.string(), parked: z.boolean() }), output: boardTaskSchema },
  /** Start a Queue card now: send its waiting message with bb's Send now, past the working limit. */
  board_start_task: { input: threadRefSchema, output: boardTaskSchema },
  board_mark_read: { input: threadRefSchema, output: z.object({ ok: z.boolean() }) },
  board_mark_unread: { input: threadRefSchema, output: z.object({ ok: z.boolean() }) },
  /** Set the working limit (null: none); messages that would start another card past it wait in their thread's queue. */
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
  work_list: { input: z.null(), output: workStateSchema },
  /** Set or clear a mark on a work item. */
  work_mark: { input: z.object({ id: reviewRefSchema.shape.id, mark: workMarkSchema, on: z.boolean() }), output: okSchema },
  /** The bb server machine's CPU, memory, swap, disk and battery; reading starts a sampler that idles once reads stop. */
  system_stats: { input: z.null(), output: systemStatsSchema },
  /** The heaviest processes on the bb server machine, grouped by name. */
  system_processes: { input: z.null(), output: systemProcessesSchema },
  /** Today's Shopify AI proxy spend for the signed-in user; cached a minute on the server. */
  ai_usage: { input: z.null(), output: aiUsageSchema },
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
export type WorkList = z.infer<typeof workListSchema>;
export type WorkMark = z.infer<typeof workMarkSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkSource = z.infer<typeof workSourceSchema>;
export type WorkState = z.infer<typeof workStateSchema>;
