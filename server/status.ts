import type { Column, StoredTask } from "./schema";
import { ELLIPSIS, oneLine } from "./text";

export type LiveThread = {
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
  lastReadAt: number | null;
  latestAttentionAt: number | null;
};

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);
const positive = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);

export function toLiveThread(raw: any): LiveThread | null {
  if (!raw || typeof raw !== "object" || raw.id == null) return null;
  const activity = raw.activity && typeof raw.activity === "object" ? raw.activity : {};
  return {
    id: String(raw.id),
    title: str(raw.title),
    titleFallback: str(raw.titleFallback),
    status: str(raw.status),
    displayStatus: str(raw.runtime?.displayStatus) ?? str(raw.runtimeStatus),
    providerId: str(raw.providerId),
    projectId: str(raw.projectId),
    parentThreadId: str(raw.parentThreadId),
    hostId: str(raw.environmentHostId),
    visibility: str(raw.visibility),
    archivedAt: num(raw.archivedAt),
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt),
    hasPendingInteraction: raw.hasPendingInteraction === true,
    lastReadAt: num(raw.lastReadAt),
    latestAttentionAt: num(raw.latestAttentionAt),
    queuedWork: str(raw.queuedWork),
    backgroundWork:
      positive(activity.activeBackgroundAgentCount) +
      positive(activity.activeBackgroundCommandCount) +
      positive(activity.activeWorkflowCount),
  };
}

const RUNNING_STATUSES = new Set(["starting", "active", "stopping", "provisioning"]);

export function isRunningSelf(thread: LiveThread): boolean {
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
  if (/\?["'”’)\]*_]*(\s|$)/u.test(lastParagraphs(cleaned, 1))) return true;
  const tail = lastParagraphs(cleaned, 2).slice(-800);
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

export type ThreadDetails = {
  key: number | null;
  output: string | null;
  lastUserInputAt: number | null;
  lastUserPrompt: string | null;
  firstUserPrompt: string | null;
  /** Recent user messages, oldest first (at most 50). */
  userPrompts: string[];
};

/** Model-written card label: "[category] intent" title plus a summary of the latest interaction. */
export type CardLabel = {
  titleSig: string;
  category: string;
  intent: string;
  summarySig: string;
  summary: string | null;
  needsInput: boolean | null;
  failedAt?: number;
  /** Title the board last wrote to the bb thread, to tell our renames from the user's. */
  appliedTitle?: string;
  /** The title our last rename replaced; seeing it again just means a stale snapshot. */
  replacedTitle?: string | null;
  /** The user renamed the thread themselves; stop syncing and show their title. */
  userTitled?: boolean;
};

export type LabelView = { title: string | null; summary: string | null; needsInput: boolean | null };

type Derived = { column: Column; reason: string; description: string | null; runningChildren: number };

export function deriveStatus(
  thread: LiveThread,
  details: ThreadDetails,
  stored: StoredTask | undefined,
  descendants: LiveThread[],
  label: LabelView,
): Derived {
  const runningSelf = isRunningSelf(thread);
  const runningChildren = descendants.filter(isRunningSelf).length;
  const promptText = label.summary ?? excerpt(details.lastUserPrompt);
  const outputText = label.summary ?? excerpt(details.output);
  const storedFresh =
    stored?.note && (details.lastUserInputAt === null || Date.parse(stored.updatedAt) >= details.lastUserInputAt);

  if (thread.hasPendingInteraction) {
    return { column: "blocked", reason: "Waiting for your response", description: outputText ?? stored?.note ?? promptText, runningChildren };
  }

  if (runningSelf || runningChildren > 0) {
    const reason = runningSelf ? "Running" : `${runningChildren} child task${runningChildren === 1 ? "" : "s"} running`;
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

  if (!details.output?.trim()) {
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

