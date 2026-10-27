// Shop Kanban server.
//
// Reconstructed from the previously bundled server.cjs, plus derived task status:
// every non-archived, visible, top-level BB thread is a card, and its column is
// computed from live thread state rather than the column an agent last reported.
//
//   WIP      the thread (or any descendant) is currently running
//   Blocked  not running, and it needs the user: a pending interaction, an error,
//            a failed result, or a last message that asks a question / requests input
//   Done     not running, and the last message reports completion
//   Queue    not started yet (pending, queued work waiting, or no turn finished)

import { z } from "zod";
import { hostContract } from "./contract";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

const COLUMN_IDS = ["queue", "wip", "blocked", "done"] as const;
type Column = (typeof COLUMN_IDS)[number];
type Result = "success" | "failed";

const columnSchema = z.enum(COLUMN_IDS);
const resultSchema = z.enum(["success", "failed"]);

const COLUMNS: Record<Column, { id: Column; title: string; description: string }> = {
  queue: { id: "queue", title: "Queue", description: "Tasks waiting to be started." },
  wip: { id: "wip", title: "WIP", description: "Tasks currently running, or with running children." },
  blocked: { id: "blocked", title: "Blocked", description: "Idle tasks that need user input or asked a question." },
  done: { id: "done", title: "Done", description: "Idle tasks whose last message reported completion." },
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
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUserInputAt: z.string().nullable(),
  missingThread: z.boolean(),
  thread: threadSummarySchema.nullable(),
});

const boardColumnSchema = z.object({ id: columnSchema, title: z.string(), description: z.string() });
const boardStateSchema = z.object({ columns: z.array(boardColumnSchema), tasks: z.array(boardTaskSchema) });

export const rpcContract = {
  board_list: { input: z.null(), output: boardStateSchema },
  board_spawn_task: {
    input: z.object({
      shortName: z.string().trim().min(1).max(40),
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
      shortName: z.string().trim().min(1).max(40).optional(),
      note: z.string().trim().max(2_000).optional(),
      result: resultSchema.nullable().optional(),
      showOnBoard: z.boolean().optional(),
      showChildren: z.boolean().optional(),
    }),
    output: boardTaskSchema,
  },
  board_remove_task: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
};

const BOARD_CHANGED = "board-changed";
const BOARD_TASK_STATUS = "board-task-status";
const TASKS_KEY = "tasks-v1";
const LABELS_KEY = "labels-v2";

// ---------------------------------------------------------------------------
// Stored task records (cards spawned or moved through the plugin)
// ---------------------------------------------------------------------------

type StoredTask = {
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

type BoardTask = z.infer<typeof boardTaskSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const SHORT_NAME_MAX = 40;
const SHORT_NAME_CUT = 37;
const ELLIPSIS = "…";

function cleanShortName(value: string): string {
  const text = oneLine(value).replace(/>/g, " ").trim();
  return text.length <= SHORT_NAME_MAX ? text : `${text.slice(0, SHORT_NAME_CUT).trimEnd()}${ELLIPSIS}`;
}

function compactTitle(value: unknown): string {
  const words = cleanShortName(typeof value === "string" && value.trim() ? value : "Task")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
  return words.length > 0 ? words : "Task";
}

function normalizeColumn(value: unknown): Column {
  switch (value) {
    case "queue":
    case "wip":
    case "blocked":
    case "done":
      return value;
    case "backlog":
      return "queue";
    case "investigating":
    case "theories":
    case "trying":
      return "wip";
    case "success":
      return "done";
    case "failed":
      return "blocked";
    default:
      return "queue";
  }
}

const CATEGORY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "this", "that", "task", "tasks", "card", "cards",
  "make", "move", "change", "update", "fix", "add", "new", "user", "agent", "session", "thread", "work",
]);

function categoryParts(value: string): { category: string | null; rest: string } {
  const match = value.match(/^\[([^\]]{1,40})\]\s*(.*)$/u);
  return match
    ? { category: cleanShortName(match[1]).toLowerCase(), rest: match[2].trim() }
    : { category: null, rest: value.trim() };
}

function categoryTokens(value: string): string[] {
  return Array.from(
    new Set(value.toLowerCase().replace(/\[[^\]]*\]/gu, " ").match(/[a-z0-9][a-z0-9-]{2,}/gu) ?? []),
  ).filter((token) => !CATEGORY_STOPWORDS.has(token));
}

const KANBAN_CATEGORY = "kanban extension";
const KANBAN_SIGNALS = [
  "kanban", "shop-kanban", "bb-plugin-shop-kanban", "board", "queue", "column", "columns", "form", "dialog",
  "panel", "icon", "spinner", "archive", "layout", "title",
];

function hasKanbanCategorySignal(value: string): boolean {
  const tokens = new Set(categoryTokens(value));
  return KANBAN_SIGNALS.some((signal) => tokens.has(signal));
}

function inferCategory(title: string, context: string): string {
  const { category } = categoryParts(title);
  if (category) return category;
  const text = `${title} ${context}`;
  if (hasKanbanCategorySignal(text)) return KANBAN_CATEGORY;
  const tokens = categoryTokens(text).slice(0, 2);
  return tokens.length === 0 ? "task" : tokens.join(" ").slice(0, 28).trim();
}

function categorizedTitle(value: string, context: string): string {
  const title = oneLine(value) || "Task";
  const { category, rest } = categoryParts(title);
  const body = rest || "Task";
  return category && (category !== KANBAN_CATEGORY || hasKanbanCategorySignal(`${body} ${context}`))
    ? `[${category}] ${body}`
    : `[${inferCategory(body, context)}] ${body}`;
}

function resultForUpdate(
  explicit: Result | null | undefined,
  column: Column,
  columnChanged: boolean,
  previous: Result | null | undefined,
): Result | null {
  if (explicit !== undefined) return explicit;
  if (column === "done") return "success";
  if (column === "blocked") return "failed";
  return columnChanged ? null : previous ?? null;
}

function metadataFor(task: StoredTask) {
  return {
    boardTask: true,
    shortName: task.shortName,
    titleChain: task.titleChain,
    column: task.column,
    parentThreadId: task.parentThreadId,
    result: task.result,
    note: task.note,
    showOnBoard: task.showOnBoard === true,
    showChildren: task.showChildren === true,
    updatedAt: task.updatedAt,
  };
}

function toolHelp(titleChain: string): string {
  return [
    `You are working on Kanban card ${JSON.stringify(titleChain)}.`,
    "Move the card as work progresses with shop_kanban_move_card. Columns are Queue, WIP, Blocked, and Done.",
    "When you finish, call shop_kanban_mark_result with success=true or success=false and a short summary.",
    "Task titles should describe the whole conversation goal, not the latest implementation step.",
    "Task descriptions/notes should describe how far the work has gotten and what changed most recently.",
    "The board categorizes task titles holistically and prefixes them with a 1-2 word bracketed category such as [shop kanban].",
    "When spawning from a parent task, titles are formatted as parent > child, so keep each segment short.",
  ].join("\n");
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

type LiveThread = {
  id: string;
  title: string | null;
  titleFallback: string | null;
  status: string | null;
  displayStatus: string | null;
  providerId: string | null;
  projectId: string | null;
  parentThreadId: string | null;
  hostId: string | null;
  visibility: string | null;
  archivedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  hasPendingInteraction: boolean;
  queuedWork: string | null;
  backgroundWork: number;
};

function toLiveThread(raw: any): LiveThread | null {
  if (!raw || typeof raw !== "object" || raw.id == null) return null;
  const activity = raw.activity && typeof raw.activity === "object" ? raw.activity : {};
  const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
  return {
    id: String(raw.id),
    title: typeof raw.title === "string" ? raw.title : null,
    titleFallback: typeof raw.titleFallback === "string" ? raw.titleFallback : null,
    status: typeof raw.status === "string" ? raw.status : null,
    displayStatus:
      typeof raw.runtime?.displayStatus === "string"
        ? raw.runtime.displayStatus
        : typeof raw.runtimeStatus === "string"
          ? raw.runtimeStatus
          : null,
    providerId: typeof raw.providerId === "string" ? raw.providerId : null,
    projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    parentThreadId: typeof raw.parentThreadId === "string" ? raw.parentThreadId : null,
    hostId: typeof raw.environmentHostId === "string" ? raw.environmentHostId : null,
    visibility: typeof raw.visibility === "string" ? raw.visibility : null,
    archivedAt: typeof raw.archivedAt === "number" ? raw.archivedAt : null,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
    hasPendingInteraction: raw.hasPendingInteraction === true,
    queuedWork: typeof raw.queuedWork === "string" ? raw.queuedWork : null,
    backgroundWork:
      count(activity.activeBackgroundAgentCount) +
      count(activity.activeBackgroundCommandCount) +
      count(activity.activeWorkflowCount),
  };
}

const RUNNING_STATUSES = new Set(["starting", "active", "stopping", "provisioning"]);

function isRunningSelf(thread: LiveThread): boolean {
  return (
    RUNNING_STATUSES.has(thread.status ?? "") ||
    RUNNING_STATUSES.has(thread.displayStatus ?? "") ||
    thread.backgroundWork > 0
  );
}

// Phrases that hand the decision back to the user. Only the tail of the message is
// inspected so questions quoted earlier in a report do not count.
const INPUT_REQUEST_PATTERNS: RegExp[] = [
  /\b(would|do) you (like|want|prefer)\b/i,
  /\bwant me to\b/i,
  /\b(should|shall|can|may) i\b[^.!\n]*\?/i,
  /\bplease (confirm|clarify|advise|choose|decide|approve|provide|share|reply|respond|tell me|let me)\b/i,
  /\b(i|we) need (you|your)\b/i,
  /\bneeds? (your|user) (input|approval|confirmation|decision|answer|help)\b/i,
  /\b(waiting|awaiting) (for |on )?(you|your|user)\b/i,
  /\byour call\b/i,
  /\b(which|what) (one|option|approach|direction) (do|would|should)\b/i,
  /\b(i'?m|i am) (blocked|stuck)\b/i,
  /\b(cannot|can't|unable to) (proceed|continue) (without|until)\b/i,
];

function stripMarkdownNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, "code")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function lastParagraphs(text: string, count: number): string {
  const paragraphs = text
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs.slice(-count).join("\n\n");
}

/** Does the final assistant message ask the user something or wait on them? */
function asksForInput(output: string): boolean {
  const cleaned = stripMarkdownNoise(output).trim();
  if (!cleaned) return false;
  const tail = lastParagraphs(cleaned, 2).slice(-800);
  if (/\?["'”’)\]*_]*\s*$/u.test(lastParagraphs(cleaned, 1))) return true;
  if (/\?["'”’)\]*_]*(\s|$)/u.test(lastParagraphs(cleaned, 1))) return true;
  return INPUT_REQUEST_PATTERNS.some((pattern) => pattern.test(tail));
}

function excerpt(text: string | null | undefined, max = 280): string | null {
  if (!text) return null;
  const cleaned = oneLine(
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#+\s*/gmu, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[-*]\s+/gmu, ""),
  );
  if (!cleaned) return null;
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}${ELLIPSIS}`;
}

type ThreadDetails = {
  key: number | null;
  output: string | null;
  lastUserInputAt: number | null;
  lastUserPrompt: string | null;
  firstUserPrompt: string | null;
};

/** Model-written card label: "[category] intent" title plus a summary of the latest interaction. */
type CardLabel = {
  titleSig: string;
  category: string;
  intent: string;
  summarySig: string;
  summary: string | null;
  needsInput: boolean | null;
  failedAt?: number;
};

type LabelView = { title: string | null; summary: string | null; needsInput: boolean | null };

type Derived = { column: Column; reason: string; description: string | null; runningChildren: number };

function deriveStatus(
  thread: LiveThread,
  details: ThreadDetails,
  stored: StoredTask | undefined,
  descendants: LiveThread[],
  label: LabelView,
): Derived {
  const runningChildren = descendants.filter(isRunningSelf).length;
  const promptText = label.summary ?? excerpt(details.lastUserPrompt);
  const outputText = label.summary ?? excerpt(details.output);
  const storedFresh =
    stored?.note && (details.lastUserInputAt === null || Date.parse(stored.updatedAt) >= details.lastUserInputAt);

  if (thread.hasPendingInteraction) {
    return { column: "blocked", reason: "Waiting for your response", description: outputText ?? stored?.note ?? promptText, runningChildren };
  }

  if (isRunningSelf(thread) || runningChildren > 0) {
    const reason = isRunningSelf(thread)
      ? "Running"
      : `${runningChildren} child task${runningChildren === 1 ? "" : "s"} running`;
    return { column: "wip", reason, description: label.summary ?? (storedFresh ? stored?.note : null) ?? promptText ?? stored?.note ?? null, runningChildren };
  }

  if (thread.status === "error" || thread.displayStatus === "error" || thread.queuedWork === "failed") {
    return { column: "blocked", reason: "Errored", description: label.summary ?? stored?.note ?? outputText ?? promptText, runningChildren };
  }

  if (thread.status === "pending" || thread.queuedWork === "waiting") {
    return { column: "queue", reason: "Queued", description: promptText ?? stored?.note ?? null, runningChildren };
  }

  if (descendants.some((child) => child.hasPendingInteraction)) {
    return { column: "blocked", reason: "A child task is waiting for your response", description: outputText ?? stored?.note ?? promptText, runningChildren };
  }

  if (!details.output || !details.output.trim()) {
    return { column: "queue", reason: "Not started", description: promptText ?? stored?.note ?? null, runningChildren };
  }

  if (storedFresh && stored?.result === "failed") {
    return { column: "blocked", reason: "Reported failure", description: label.summary ?? stored.note ?? outputText, runningChildren };
  }

  if (label.needsInput ?? asksForInput(details.output)) {
    return { column: "blocked", reason: "Asked a question", description: outputText, runningChildren };
  }

  return { column: "done", reason: "Completed", description: outputText, runningChildren };
}

// ---------------------------------------------------------------------------
// Card labels (written by a small model on the host)
// ---------------------------------------------------------------------------

const LABEL_MODELS = ["anthropic/claude-haiku-5-5", "anthropic/claude-haiku-4-5"];
const LABEL_RETRY_MS = 10 * 60_000;
const LABEL_CONCURRENCY = 2;
const LABEL_PROMPT_VERSION = 3;

const LABEL_SYSTEM = [
  "You label cards on a Kanban board where each card is a coding-agent conversation thread.",
  "Reply with only one JSON object and nothing else.",
].join(" ");

function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function clip(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const text = value.replace(/```[\s\S]*?```/g, "[code]").trim();
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}

function labelPrompt(input: {
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  output: string | null;
  running: boolean;
  categories: string[];
}): string {
  const sameRequest = !input.lastPrompt || input.lastPrompt === input.firstPrompt;
  return [
    input.categories.length
      ? `Categories already on the board: ${input.categories.join(", ")}`
      : "No categories on the board yet.",
    `Thread title: ${input.title ?? "(none)"}`,
    `First user request:\n"""\n${clip(input.firstPrompt, 1_500) || "(none)"}\n"""`,
    sameRequest ? "" : `Latest user message:\n"""\n${clip(input.lastPrompt, 1_500)}\n"""`,
    input.running
      ? "The agent is still working on the latest user message."
      : `Agent's latest reply (it has finished):\n"""\n${clip(input.output, 3_500) || "(none)"}\n"""`,
    "",
    'Return JSON: {"category": string, "intent": string, "summary": string, "needsInput": boolean}',
    '- category: 1-2 lowercase words naming the product, repo, plugin or tool the work is about, e.g. "shop kanban", "verdict casebook", "bb setup". Reuse a board category only if this thread is about that same thing; otherwise make a new one. Prefer names that appear in the request.',
    '- intent: what the user wants from the whole thread in 2-5 words, lowercase imperative, keep acronyms and proper nouns, e.g. "refine UI", "fix flaky checkout test".',
    input.running
      ? '- summary: one sentence, at most 18 words, saying what the agent is doing now for the latest user message, present progressive, e.g. "Making card clicks scroll to the latest message."'
      : '- summary: one sentence, at most 18 words, saying what happened in the latest exchange, past tense, no "I", e.g. "Made cards smaller, synced cards with bb threads, and added a blocked reason." Only if it stopped to ask the user something, end with what it needs, e.g. "…; asks whether to merge duplicates."',
    "- needsInput: true only if the reply directly asks the user a question (or says it is waiting on them) and the agent cannot continue the task until they answer. False when the task is finished, even if the reply lists suggested next steps, recommendations, decisions for later, things to review or verify, or optional offers (\"I can also…\", \"let me know if you want…\").",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function parseLabel(text: string): { category: string; intent: string; summary: string; needsInput: boolean } | null {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  let raw: any;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const words = (value: unknown, maxWords: number, maxChars: number) =>
    typeof value === "string"
      ? oneLine(value.replace(/[\[\]"]/g, "")).split(" ").slice(0, maxWords).join(" ").slice(0, maxChars).trim()
      : "";
  const category = words(raw?.category, 2, 24).toLowerCase();
  const intent = words(raw?.intent, 6, 40).replace(/[.!]+$/u, "");
  const summary = typeof raw?.summary === "string" ? oneLine(raw.summary).slice(0, 220) : "";
  if (!category || !intent || !summary) return null;
  return { category, intent, summary, needsInput: raw?.needsInput === true };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: any) {
  bb.log.info("loaded");

  const detailsCache = new Map<string, ThreadDetails>();
  const firstPromptCache = new Map<string, string | null>();
  const host = bb.hosts.experimental_client({ contract: hostContract });
  let labels: Record<string, CardLabel> | null = null;
  let labelsWrite: Promise<void> = Promise.resolve();
  const labelQueue: Array<() => Promise<void>> = [];
  const labelInFlight = new Set<string>();
  let labelActive = 0;
  let changedTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackHostId: string | null = null;

  async function loadLabels(): Promise<Record<string, CardLabel>> {
    if (labels) return labels;
    const raw = await safe(async () => bb.storage.kv.get(LABELS_KEY));
    labels = raw && typeof raw === "object" ? (raw as Record<string, CardLabel>) : {};
    return labels;
  }

  function persistLabels() {
    labelsWrite = labelsWrite.then(async () => {
      await safe(async () => bb.storage.kv.set(LABELS_KEY, labels ?? {}));
    });
  }

  function publishBoardChangedSoon() {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      publishBoardChanged();
    }, 400);
  }

  async function resolveHostId(thread: LiveThread): Promise<string | null> {
    if (thread.hostId) return thread.hostId;
    if (fallbackHostId) return fallbackHostId;
    const hosts = await safe(async () => bb.sdk.hosts.list());
    const list: any[] = Array.isArray(hosts) ? hosts : Array.isArray(hosts?.hosts) ? hosts.hosts : [];
    fallbackHostId = list.find((entry) => entry?.status === "connected")?.id ?? list[0]?.id ?? null;
    return fallbackHostId;
  }

  function pumpLabels() {
    while (labelActive < LABEL_CONCURRENCY && labelQueue.length > 0) {
      const job = labelQueue.shift()!;
      labelActive += 1;
      void job().finally(() => {
        labelActive -= 1;
        pumpLabels();
      });
    }
  }

  /** Returns the current (possibly stale) label and schedules a refresh when the thread moved on. */
  function labelView(
    thread: LiveThread,
    details: ThreadDetails,
    running: boolean,
    all: Record<string, CardLabel>,
  ): LabelView {
    const current = all[thread.id];
    const titleSig = hashText(details.firstUserPrompt ?? thread.title ?? thread.id);
    const summarySig = running
      ? `v${LABEL_PROMPT_VERSION}:run:${details.lastUserInputAt ?? 0}`
      : `v${LABEL_PROMPT_VERSION}:idle:${details.lastUserInputAt ?? 0}:${hashText(details.output ?? "")}`;
    const hasTitle = current !== undefined && current.titleSig === titleSig;
    const fresh = hasTitle && current.summarySig === summarySig;
    const backingOff = current?.failedAt !== undefined && Date.now() - current.failedAt < LABEL_RETRY_MS && current.summarySig === summarySig;
    const worthLabeling = running || Boolean(details.output?.trim()) || Boolean(details.lastUserPrompt);

    if (!fresh && !backingOff && worthLabeling && !labelInFlight.has(thread.id)) {
      labelInFlight.add(thread.id);
      labelQueue.push(async () => {
        try {
          const hostId = await resolveHostId(thread);
          if (!hostId) throw new Error("No connected host to run the labeler.");
          const categories = Array.from(new Set(Object.values(all).map((entry) => entry.category).filter(Boolean))).slice(0, 30);
          const result = await host.call(
            "complete",
            {
              system: LABEL_SYSTEM,
              prompt: labelPrompt({
                title: thread.title,
                firstPrompt: details.firstUserPrompt,
                lastPrompt: details.lastUserPrompt,
                output: details.output,
                running,
                categories,
              }),
              models: LABEL_MODELS,
              timeoutMs: 12_000,
            },
            { hostId },
          );
          const parsed = result?.text ? parseLabel(result.text) : null;
          if (!parsed) throw new Error(result?.error ?? "Labeler returned no usable JSON.");
          const previous = all[thread.id];
          const keepTitle = previous !== undefined && previous.titleSig === titleSig;
          all[thread.id] = {
            titleSig,
            category: keepTitle ? previous.category : parsed.category,
            intent: keepTitle ? previous.intent : parsed.intent,
            summarySig,
            summary: parsed.summary,
            needsInput: running ? null : parsed.needsInput,
          };
        } catch (error) {
          bb.log.info(`label failed for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
          const previous = all[thread.id];
          all[thread.id] = previous
            ? { ...previous, summarySig, failedAt: Date.now() }
            : { titleSig: "", category: "", intent: "", summarySig, summary: null, needsInput: null, failedAt: Date.now() };
        } finally {
          labelInFlight.delete(thread.id);
          persistLabels();
          publishBoardChangedSoon();
        }
      });
      pumpLabels();
    }

    return {
      title: hasTitle && current.category && current.intent ? `[${current.category}] ${current.intent}` : null,
      summary: fresh ? current.summary : null,
      needsInput: fresh && !running ? current.needsInput : null,
    };
  }

  async function readTasks(): Promise<Record<string, StoredTask>> {
    const raw = await bb.storage.kv.get(TASKS_KEY);
    if (!raw || typeof raw !== "object") return {};
    const tasks: Record<string, StoredTask> = {};
    for (const [id, value] of Object.entries(raw as Record<string, any>)) tasks[id] = { ...value, column: normalizeColumn(value.column) };
    for (const task of Object.values(tasks)) {
      task.shortName = categorizedTitle(task.shortName, `${task.titleChain} ${task.description ?? ""}`);
      task.titleChain = categorizedTitle(task.titleChain, task.description ?? task.shortName);
    }
    return tasks;
  }

  function publishBoardChanged() {
    bb.realtime.publish(BOARD_CHANGED, { at: Date.now() });
  }

  async function writeTasks(tasks: Record<string, StoredTask>) {
    await bb.storage.kv.set(TASKS_KEY, tasks);
    publishBoardChanged();
  }

  async function saveTask(task: StoredTask) {
    const tasks = await readTasks();
    tasks[task.threadId] = task;
    await writeTasks(tasks);
    await safe(() => bb.sdk.threads.updatePluginMetadata({ threadId: task.threadId, set: metadataFor(task) }));
    return task;
  }

  async function defaultProjectId(): Promise<string> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const personal = projects.find((p: any) => p.isPersonal || p.kind === "personal" || p.id === "proj_personal") ?? projects[0];
    return personal?.id ?? "proj_personal";
  }

  async function getThread(threadId: string): Promise<any | null> {
    return safe(async () => await bb.sdk.threads.get({ threadId }));
  }

  async function getPluginMeta(threadId: string): Promise<Record<string, any>> {
    return (await safe(async () => bb.sdk.threads.getPluginMetadata({ threadId }))) ?? {};
  }

  async function titleChainForParent(parentThreadId: string | undefined) {
    if (!parentThreadId) return { titleChain: null as string | null, projectId: null as string | null };
    const [thread, meta] = await Promise.all([getThread(parentThreadId), getPluginMeta(parentThreadId)]);
    return {
      titleChain:
        typeof meta.titleChain === "string" && meta.titleChain.trim()
          ? meta.titleChain
          : compactTitle(thread?.title ?? thread?.titleFallback ?? parentThreadId),
      projectId: typeof thread?.projectId === "string" ? thread.projectId : null,
    };
  }

  /** Latest user-initiated turn: time and prompt text. */
  async function lastUserTurn(threadId: string): Promise<{ at: number | null; prompt: string | null }> {
    const result = await safe(async () =>
      await bb.sdk.threads.events.list({ threadId, order: "desc", limit: 50, types: ["client/turn/requested"] }),
    );
    const events: any[] = Array.isArray(result) ? result : Array.isArray(result?.events) ? result.events : [];
    const event = events.find((entry) => entry?.data?.initiator === "user") ?? events[0];
    const prompt = Array.isArray(event?.data?.input)
      ? event.data.input
          .filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text)
          .join("\n")
      : null;
    return { at: typeof event?.createdAt === "number" ? event.createdAt : null, prompt: prompt || null };
  }

  /** The thread's opening user request (cached; it never changes). */
  async function firstUserPrompt(threadId: string): Promise<string | null> {
    if (firstPromptCache.has(threadId)) return firstPromptCache.get(threadId) ?? null;
    const result = await safe(async () =>
      await bb.sdk.threads.events.list({ threadId, order: "asc", limit: 10, types: ["client/turn/requested"] }),
    );
    if (result === null) return null;
    const events: any[] = Array.isArray(result) ? result : Array.isArray(result?.events) ? result.events : [];
    const event = events.find((entry) => entry?.data?.initiator === "user") ?? events[0];
    const prompt = Array.isArray(event?.data?.input)
      ? event.data.input
          .filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text)
          .join("\n") || null
      : null;
    firstPromptCache.set(threadId, prompt);
    return prompt;
  }

  /** Last assistant output + last user turn, cached per thread until the thread changes. */
  async function threadDetails(thread: LiveThread, needOutput: boolean): Promise<ThreadDetails> {
    const key = thread.updatedAt;
    const cached = detailsCache.get(thread.id);
    if (cached && cached.key === key && (cached.output !== null || !needOutput)) return cached;
    const [turn, output, firstPrompt] = await Promise.all([
      lastUserTurn(thread.id),
      needOutput
        ? safe(async () => {
            const result = await bb.sdk.threads.output({ threadId: thread.id });
            return typeof result === "string" ? result : typeof result?.output === "string" ? result.output : null;
          })
        : Promise.resolve(cached?.output ?? null),
      firstUserPrompt(thread.id),
    ]);
    const details: ThreadDetails = {
      key,
      output: output ?? null,
      lastUserInputAt: turn.at,
      lastUserPrompt: turn.prompt,
      firstUserPrompt: firstPrompt,
    };
    detailsCache.set(thread.id, details);
    return details;
  }

  async function listAllThreads(): Promise<LiveThread[] | null> {
    const PAGE = 200;
    const all: LiveThread[] = [];
    for (let offset = 0; offset < 5_000; offset += PAGE) {
      const page = await safe(async () =>
        await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: PAGE, offset }),
      );
      if (page === null) return offset === 0 ? null : all;
      const rows: any[] = Array.isArray(page) ? page : Array.isArray(page?.threads) ? page.threads : [];
      for (const row of rows) {
        const thread = toLiveThread(row);
        if (thread) all.push(thread);
      }
      if (rows.length < PAGE) break;
    }
    return all;
  }

  function threadSummary(thread: LiveThread) {
    return {
      id: thread.id,
      title: thread.title,
      titleFallback: thread.titleFallback,
      status: thread.status,
      runtimeStatus: thread.displayStatus,
      providerId: thread.providerId,
      updatedAt: thread.updatedAt,
      archivedAt: thread.archivedAt,
    };
  }

  function iso(ms: number | null): string {
    return new Date(ms ?? Date.now()).toISOString();
  }

  /** Fallback title until the labeler has run: "[category] thread title". */
  function threadTitle(thread: LiveThread, stored: StoredTask | undefined): string {
    const base = stored?.titleChain || thread.title || (thread.titleFallback ? compactTitle(thread.titleFallback) : null) || thread.id;
    return categorizedTitle(base, thread.titleFallback ?? "");
  }

  async function materialize(
    thread: LiveThread,
    stored: StoredTask | undefined,
    descendants: LiveThread[],
    childCount: number,
  ): Promise<BoardTask> {
    const running = isRunningSelf(thread) || descendants.some(isRunningSelf);
    const [details, all] = await Promise.all([threadDetails(thread, !running), loadLabels()]);
    const label = labelView(thread, details, running, all);
    const derived = deriveStatus(thread, details, stored, descendants, label);
    const title = label.title ?? threadTitle(thread, stored);
    return {
      threadId: thread.id,
      shortName: stored?.shortName ?? cleanShortName(title),
      titleChain: title,
      column: derived.column,
      parentThreadId: thread.parentThreadId,
      projectId: thread.projectId ?? stored?.projectId ?? null,
      description: stored?.description ?? null,
      result: derived.column === "done" ? "success" : derived.column === "blocked" ? "failed" : null,
      note: derived.description,
      showOnBoard: stored?.showOnBoard === true,
      showChildren: stored?.showChildren === true,
      childCount,
      hiddenChildCount: 0,
      runningChildCount: derived.runningChildren,
      statusReason: derived.reason,
      createdAt: stored?.createdAt ?? iso(thread.createdAt),
      updatedAt: iso(Math.max(thread.updatedAt ?? 0, stored ? Date.parse(stored.updatedAt) || 0 : 0) || null),
      lastUserInputAt: details.lastUserInputAt === null ? null : iso(details.lastUserInputAt),
      missingThread: false,
      thread: threadSummary(thread),
    };
  }

  /** Materialize a single card (used as the return value of task mutations). */
  async function materializeOne(stored: StoredTask, rawThread?: any): Promise<BoardTask> {
    const thread = toLiveThread(rawThread ?? (await getThread(stored.threadId)));
    if (!thread) {
      return {
        ...stored,
        childCount: 0,
        hiddenChildCount: 0,
        runningChildCount: 0,
        statusReason: null,
        lastUserInputAt: null,
        missingThread: true,
        thread: null,
      };
    }
    const descendants = (await safe(async () => {
      const result = await bb.sdk.threads.experimental_listDescendants({ threadIds: [thread.id], includeHidden: true });
      const rows: any[] = Array.isArray(result) ? result : Array.isArray(result?.threads) ? result.threads : [];
      return rows.map(toLiveThread).filter((entry): entry is LiveThread => entry !== null);
    })) ?? [];
    return materialize(thread, stored, descendants, descendants.filter((entry) => entry.parentThreadId === thread.id).length);
  }

  async function listBoard() {
    const stored = await readTasks();
    const threads = await listAllThreads();
    if (threads === null) return { columns: COLUMN_IDS.map((id) => COLUMNS[id]), tasks: [] };

    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const children = new Map<string, LiveThread[]>();
    for (const thread of threads) {
      if (!thread.parentThreadId) continue;
      const list = children.get(thread.parentThreadId) ?? [];
      list.push(thread);
      children.set(thread.parentThreadId, list);
    }
    const descendantsOf = (id: string): LiveThread[] => {
      const out: LiveThread[] = [];
      const stack = [...(children.get(id) ?? [])];
      const seen = new Set<string>([id]);
      while (stack.length) {
        const next = stack.pop()!;
        if (seen.has(next.id)) continue;
        seen.add(next.id);
        out.push(next);
        stack.push(...(children.get(next.id) ?? []));
      }
      return out;
    };

    // Every visible, non-archived top-level thread is a card. A thread whose parent is
    // not in the active list (e.g. archived parent) is treated as top-level too.
    const roots = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.visibility !== "hidden" &&
        (!thread.parentThreadId || !byId.has(thread.parentThreadId)),
    );

    // Forget cached details for threads no longer listed.
    for (const id of detailsCache.keys()) if (!byId.has(id)) detailsCache.delete(id);

    const tasks = await Promise.all(
      roots.map((thread) =>
        materialize(thread, stored[thread.id], descendantsOf(thread.id), (children.get(thread.id) ?? []).length),
      ),
    );

    const time = (value: string) => Date.parse(value) || 0;
    tasks.sort((a, b) =>
      a.column === "wip" && b.column === "wip" ? time(b.createdAt) - time(a.createdAt) : time(b.updatedAt) - time(a.updatedAt),
    );

    return { columns: COLUMN_IDS.map((id) => COLUMNS[id]), tasks };
  }

  async function preferThreadNotifications(threadId: string) {
    await safe(() =>
      bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "threadNotifications.set",
        input: { threadId, level: "all" },
        outputSchema: z.any(),
      }),
    );
  }

  async function publishTaskStatus(previous: StoredTask | undefined, next: StoredTask) {
    if (previous?.column === next.column) return;
    if (next.column !== "blocked" && next.column !== "done") return;
    await preferThreadNotifications(next.threadId);
    await safe(() => bb.sdk.threads.markUnread({ threadId: next.threadId }));
    bb.realtime.publish(BOARD_TASK_STATUS, {
      at: Date.now(),
      threadId: next.threadId,
      title: next.titleChain,
      column: next.column,
      note: next.note,
    });
  }

  async function updateTask(input: {
    threadId: string;
    column?: Column;
    shortName?: string;
    note?: string;
    result?: Result | null;
    showOnBoard?: boolean;
    showChildren?: boolean;
  }): Promise<BoardTask> {
    const previous = (await readTasks())[input.threadId];
    const thread = await getThread(input.threadId);
    const now = nowIso();
    const baseName = input.shortName ?? previous?.shortName ?? compactTitle(thread?.title ?? thread?.titleFallback ?? input.threadId);
    const shortName = input.shortName
      ? categorizedTitle(baseName, previous?.description ?? previous?.note ?? "")
      : cleanShortName(baseName);
    const column = input.column ?? previous?.column ?? "queue";
    const result = resultForUpdate(input.result, column, input.column !== undefined, previous?.result);
    const parentThreadId =
      previous?.parentThreadId ?? (typeof thread?.parentThreadId === "string" ? thread.parentThreadId : null);
    const titleChain = input.shortName && parentThreadId === null ? shortName : previous?.titleChain ?? shortName;
    const next: StoredTask = {
      threadId: input.threadId,
      shortName,
      titleChain,
      column,
      parentThreadId,
      projectId: previous?.projectId ?? (typeof thread?.projectId === "string" ? thread.projectId : null),
      description: previous?.description ?? null,
      result,
      note: input.note ?? previous?.note ?? null,
      showOnBoard: input.showOnBoard ?? previous?.showOnBoard ?? false,
      showChildren: input.showChildren ?? previous?.showChildren ?? false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await saveTask(next);
    await publishTaskStatus(previous, next);
    return materializeOne(next, thread);
  }

  async function spawnTask(input: {
    shortName: string;
    prompt: string;
    projectId?: string;
    parentThreadId?: string;
    column?: Column;
    showOnBoard?: boolean;
  }): Promise<BoardTask> {
    const shortName = categorizedTitle(input.shortName, input.prompt);
    const parent = await titleChainForParent(input.parentThreadId);
    const titleChain = parent.titleChain ? `${parent.titleChain} > ${shortName}` : shortName;
    const projectId = input.projectId ?? parent.projectId ?? (await defaultProjectId());
    const now = nowIso();
    const common = {
      shortName,
      titleChain,
      column: input.column ?? (input.parentThreadId ? "wip" : "queue"),
      parentThreadId: input.parentThreadId ?? null,
      result: null,
      note: null,
      showOnBoard: input.showOnBoard === true,
      showChildren: false,
      updatedAt: now,
    } satisfies Partial<StoredTask>;
    const prompt = `${input.prompt.trim()}\n\n---\n${toolHelp(titleChain)}`;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt,
      title: titleChain,
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      pluginMetadata: { boardTask: true, ...common },
    });
    const task: StoredTask = {
      threadId: String(thread.id),
      ...common,
      projectId,
      description: input.prompt.trim().slice(0, 1_000),
      createdAt: now,
    };
    await saveTask(task);
    await preferThreadNotifications(task.threadId);
    return materializeOne(task, thread);
  }

  async function archiveThread(threadId: string): Promise<boolean> {
    if ((await safe(() => bb.sdk.threads.archive({ threadId }))) !== null) return true;
    if ((await safe(() => bb.sdk.threads.archive({ id: threadId }))) !== null) return true;
    return (await safe(() => bb.sdk.threads.archive(threadId))) !== null;
  }

  async function markTaskResult(threadId: string, success: boolean, summary: string) {
    const result: Result = success ? "success" : "failed";
    const task = await updateTask({ threadId, column: success ? "done" : "blocked", result, note: summary });
    return { task, result };
  }

  async function removeTask(threadId: string, options: { archiveThread?: boolean } = {}): Promise<boolean> {
    // Every BB thread is a card, so archiving works for threads the plugin never tracked.
    const archived = options.archiveThread === true ? await archiveThread(threadId) : false;
    const tasks = await readTasks();
    if (!(threadId in tasks)) {
      if (archived) publishBoardChanged();
      return archived;
    }
    delete tasks[threadId];
    await writeTasks(tasks);
    await safe(() =>
      bb.sdk.threads.updatePluginMetadata({
        threadId,
        set: { boardTask: false, updatedAt: nowIso() },
        remove: ["shortName", "titleChain", "column", "result", "note", "showOnBoard", "showChildren"],
      }),
    );
    return true;
  }

  bb.rpc.register(rpcContract, {
    board_list: listBoard,
    board_spawn_task: spawnTask,
    board_update_task: updateTask,
    board_remove_task: async ({ threadId }: { threadId: string }) => ({
      removed: await removeTask(threadId, { archiveThread: true }),
    }),
  });

  bb.agents.registerTool({
    name: "shop_kanban_move_card",
    description: "Move the current or specified Kanban board thread card to another column as work progresses.",
    instructions:
      "Use this when your task state changes. If no threadId is supplied, it updates the current thread. Columns: queue, wip, blocked, done.",
    presentation: { label: { pending: "Moving Kanban card", completed: "Moved Kanban card" }, icon: { glyph: "ListTodo" } },
    parameters: z.object({
      threadId: z.string().optional().describe("Thread/card id. Omit to update the current thread."),
      column: columnSchema,
      note: z
        .string()
        .max(2_000)
        .optional()
        .describe("Progress/status description: how far the work has gotten and what changed most recently."),
      shortName: z
        .string()
        .max(40)
        .optional()
        .describe("Short task title describing the whole conversation goal, not just the latest step."),
      showChildren: z.boolean().optional().describe("Deprecated; the board only shows top-level non-archived cards."),
    }),
    async execute(args: any, context: any) {
      const threadId = args.threadId ?? context.threadId;
      if (!threadId) return "No current thread id was available; pass threadId explicitly.";
      const task = await updateTask({
        threadId,
        column: args.column,
        note: args.note,
        shortName: args.shortName,
        showChildren: args.showChildren,
      });
      return `Moved ${task.titleChain} to ${COLUMNS[args.column as Column].title}.`;
    },
  });

  bb.agents.registerTool({
    name: "shop_kanban_spawn_task",
    description: "Spawn a new BB thread as a Kanban card, usually as a child of the current card.",
    instructions:
      "Choose a shortName that describes the whole conversation goal, not just the latest step. The board will add a 1-2 word bracketed category prefix based on all board tasks. Child cards are titled parent > child, so keep names short.",
    presentation: { label: { pending: "Spawning Kanban task", completed: "Spawned Kanban task" }, icon: { glyph: "Bot" } },
    parameters: z.object({
      shortName: z.string().min(1).max(40).describe("Short task title describing the whole conversation goal."),
      prompt: z.string().min(1).max(12_000).describe("Initial prompt/progress description for the task."),
      parentThreadId: z.string().optional().describe("Parent thread id. Omit to use the current thread."),
      column: columnSchema.optional(),
      showOnBoard: z.boolean().optional().describe("Deprecated; the board only shows top-level non-archived cards."),
    }),
    async execute(args: any, context: any) {
      const parentThreadId = args.parentThreadId ?? context.threadId ?? undefined;
      const task = await spawnTask({ ...args, parentThreadId });
      return `Spawned ${task.titleChain} as @thread:${task.threadId}.`;
    },
  });

  bb.agents.registerTool({
    name: "shop_kanban_create_theory_tasks",
    description:
      "For an investigation card, spawn one independent BB thread/card per theory so separate agents can try different solutions.",
    instructions:
      "Use after investigating and forming theories. Each theory needs a shortName that describes that theory task's overall goal, not just the latest step. The board will add a 1-2 word bracketed category prefix based on all board tasks. Each spawned agent should try that theory independently and mark success/failure.",
    presentation: { label: { pending: "Spawning theory tasks", completed: "Spawned theory tasks" }, icon: { glyph: "Lightbulb" } },
    parameters: z.object({
      parentThreadId: z.string().optional().describe("Investigation thread. Omit to use current thread."),
      showOnBoard: z.boolean().optional().describe("Deprecated; the board only shows top-level non-archived cards."),
      theories: z
        .array(
          z.object({
            shortName: z.string().min(1).max(40).describe("Short title describing the whole theory task goal."),
            theory: z.string().min(1).max(4_000),
            prompt: z
              .string()
              .max(12_000)
              .optional()
              .describe("Progress/task prompt shown as the card description until updates arrive."),
          }),
        )
        .min(1)
        .max(12),
    }),
    async execute(args: any, context: any) {
      const parentThreadId = args.parentThreadId ?? context.threadId ?? undefined;
      if (parentThreadId) {
        await updateTask({ threadId: parentThreadId, column: "wip", note: `Spawned ${args.theories.length} theory task(s).` });
      }
      const spawned: BoardTask[] = [];
      for (const theory of args.theories) {
        const prompt =
          theory.prompt?.trim() ||
          [
            `Try this theory independently: ${theory.theory}`,
            "Investigate or implement the smallest convincing test/solution.",
            "Do not assume another theory task will do your work.",
            "When done, call shop_kanban_mark_result with success=true if the theory worked, otherwise success=false, and include a concise summary.",
          ].join("\n\n");
        spawned.push(
          await spawnTask({
            shortName: theory.shortName,
            prompt,
            parentThreadId,
            column: "wip",
            showOnBoard: args.showOnBoard === true,
          }),
        );
      }
      return `Spawned ${spawned.length} theory task(s): ${spawned
        .map((task) => `${task.titleChain} (@thread:${task.threadId})`)
        .join(", ")}.`;
    },
  });

  bb.agents.registerTool({
    name: "shop_kanban_mark_result",
    description: "Mark the current or specified Kanban card as done or blocked when the agent finishes.",
    instructions:
      "Always call this when finishing a Kanban task. Include a concise summary. Success moves to Done; failure moves to Blocked.",
    presentation: { label: { pending: "Marking Kanban result", completed: "Marked Kanban result" }, icon: { glyph: "CircleCheck" } },
    parameters: z.object({
      threadId: z.string().optional().describe("Thread/card id. Omit to update current thread."),
      success: z.boolean(),
      summary: z
        .string()
        .min(1)
        .max(2_000)
        .describe("Final progress description: how far the work got and why it is done or blocked."),
    }),
    async execute(args: any, context: any) {
      const threadId = args.threadId ?? context.threadId;
      if (!threadId) return "No current thread id was available; pass threadId explicitly.";
      const { task, result } = await markTaskResult(threadId, args.success, args.summary);
      return `Marked ${task.titleChain} as ${result}: ${args.summary}`;
    },
  });

  bb.agents.configure(() => ({
    tools: ["shop_kanban_move_card", "shop_kanban_spawn_task", "shop_kanban_create_theory_tasks", "shop_kanban_mark_result"],
    skills: ["shop-kanban"],
    instructions: [
      "Shop Kanban plugin workflow:",
      "- Treat Kanban cards as BB threads. Move your card between columns with shop_kanban_move_card as work progresses.",
      "- For investigation work, produce theories, then call shop_kanban_create_theory_tasks so each theory gets an independent BB thread/agent. The board only shows top-level non-archived cards; child/sub-task threads are tracked but hidden from the board.",
      "- A card title should describe the whole conversation goal, not the latest implementation step.",
      "- A card description/note should describe how far the work has gotten and what changed most recently.",
      "- Look at the board holistically and group related tasks with a 1-2 word bracketed category prefix, for example [shop kanban]. The board also auto-adds this prefix for new tasks when missing.",
      "- When a BB session spawns another, the child title is parent > child. Keep each segment short (usually 2-5 words).",
      "- The board columns are Queue, WIP, Blocked, and Done. When finished, call shop_kanban_mark_result with success or failure and a concise summary.",
    ].join("\n"),
  }));

  bb.events.on("thread.active", async ({ thread }: any) => {
    publishBoardChanged();
    const task = (await readTasks())[thread.id];
    if (!task || task.result) return;
    if (task.column === "queue") await updateTask({ threadId: thread.id, column: "wip" });
  });

  bb.events.on("thread.failed", async ({ thread, error }: any) => {
    publishBoardChanged();
    if (!(await readTasks())[thread.id]) return;
    await updateTask({ threadId: thread.id, column: "blocked", result: "failed", note: error ?? "Thread failed." });
  });

  bb.events.on("thread.deleted", async ({ thread }: any) => {
    detailsCache.delete(thread.id);
    firstPromptCache.delete(thread.id);
    const all = await loadLabels();
    if (thread.id in all) {
      delete all[thread.id];
      persistLabels();
    }
    await removeTask(thread.id);
    publishBoardChanged();
  });

  for (const event of ["thread.created", "thread.idle", "thread.archived", "thread.unarchived", "interaction.pending", "turn.failed", "message.queued", "experimental_thread.parentChanged"]) {
    bb.events.on(event, () => publishBoardChanged());
  }

  bb.cli.register({
    name: "shop-kanban",
    summary: "Manage the Kanban board of BB thread cards",
    commands: [
      { name: "list", summary: "List Kanban cards", usage: "bb shop-kanban list [--json]" },
      { name: "add", summary: "Spawn a Kanban task thread", usage: "bb shop-kanban add <short-name> -- <prompt> [--json]" },
      { name: "move", summary: "Move a card", usage: "bb shop-kanban move <thread-id> <column> [note] [--json]" },
      { name: "success", summary: "Mark a card done", usage: "bb shop-kanban success <thread-id> <summary> [--json]" },
      { name: "fail", summary: "Mark a card blocked", usage: "bb shop-kanban fail <thread-id> <summary> [--json]" },
      { name: "children", summary: "Show or hide a parent's child cards", usage: "bb shop-kanban children <parent-thread-id> <show|hide> [--json]" },
      { name: "remove", summary: "Archive/remove a card from the board", usage: "bb shop-kanban remove <thread-id> [--json]" },
    ],
    async run(argv: string[]) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command] = args;
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      const usage = [
        "Usage:",
        "  bb shop-kanban list [--json]",
        "  bb shop-kanban add <short-name> -- <prompt> [--json]",
        `  bb shop-kanban move <thread-id> <${COLUMN_IDS.join("|")}> [note] [--json]`,
        "  bb shop-kanban success <thread-id> <summary> [--json]",
        "  bb shop-kanban fail <thread-id> <summary> [--json]",
        "  bb shop-kanban children <parent-thread-id> <show|hide> [--json]",
        "  bb shop-kanban remove <thread-id> [--json]",
      ].join("\n");
      try {
        if (command === "list") {
          const board = await listBoard();
          const lines = board.tasks.map(
            (task) =>
              `${task.threadId}\t${task.column}\t${task.titleChain}${task.statusReason ? ` (${task.statusReason})` : ""}${task.note ? ` — ${task.note}` : ""}`,
          );
          return reply(board, lines.length ? lines.join("\n") : "No Kanban cards yet.");
        }
        if (command === "add") {
          const separator = args.indexOf("--");
          if (separator <= 1) return { exitCode: 1, stderr: usage };
          const shortName = args.slice(1, separator).join(" ");
          const prompt = args.slice(separator + 1).join(" ");
          if (!prompt.trim()) return { exitCode: 1, stderr: usage };
          const task = await spawnTask({ shortName, prompt });
          return reply(task, `Spawned ${task.titleChain} as ${task.threadId}`);
        }
        if (command === "move") {
          const [, threadId, column, ...note] = args;
          if (!threadId || !(COLUMN_IDS as readonly string[]).includes(column)) return { exitCode: 1, stderr: usage };
          const task = await updateTask({ threadId, column: column as Column, note: note.join(" ") || undefined });
          return reply(task, `Moved ${task.titleChain} to ${task.column}`);
        }
        if (command === "success" || command === "fail") {
          const [, threadId, ...rest] = args;
          const summary = rest.join(" ").trim();
          if (!threadId || !summary) return { exitCode: 1, stderr: usage };
          const { task, result } = await markTaskResult(threadId, command === "success", summary);
          return reply(task, `Marked ${task.titleChain} ${result}`);
        }
        if (command === "children") {
          const [, threadId, mode] = args;
          if (!threadId || (mode !== "show" && mode !== "hide")) return { exitCode: 1, stderr: usage };
          const task = await updateTask({ threadId, showChildren: mode === "show" });
          return reply(task, `${mode === "show" ? "Showing" : "Hiding"} child cards for ${task.titleChain}`);
        }
        if (command === "remove") {
          const threadId = args[1];
          if (!threadId) return { exitCode: 1, stderr: usage };
          return reply({ removed: await removeTask(threadId, { archiveThread: true }) }, `Archived ${threadId} from the board`);
        }
        return command === undefined || command === "help" || command === "--help"
          ? { exitCode: 0, stdout: usage }
          : { exitCode: 1, stderr: usage };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  bb.onDispose(() => {
    if (changedTimer) clearTimeout(changedTimer);
    labelQueue.length = 0;
    bb.log.info("disposed");
  });
}
