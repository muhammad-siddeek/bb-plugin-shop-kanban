import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import type { Status, StoredTask } from "./schema";
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

/** A `threads.list` row; the SDK exports no name for it. */
type ThreadListRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
/** A thread as `threads.get`, `threads.spawn` and thread events return it; the SDK names it only through events. */
type ThreadResponse = PluginThreadEventPayloads["thread.created"]["thread"];

export function toLiveThread(raw: ThreadListRow | ThreadResponse | null | undefined): LiveThread | null {
  if (!raw) return null;
  // Only list rows carry the host, pending interaction, queued work and activity counts.
  const row = "activity" in raw ? raw : null;
  return {
    id: raw.id,
    title: raw.title,
    titleFallback: raw.titleFallback,
    status: raw.status,
    displayStatus: raw.runtime.displayStatus,
    providerId: raw.providerId,
    projectId: raw.projectId,
    parentThreadId: raw.parentThreadId,
    hostId: row?.environmentHostId ?? null,
    visibility: raw.visibility,
    archivedAt: raw.archivedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    hasPendingInteraction: row?.hasPendingInteraction ?? false,
    lastReadAt: raw.lastReadAt,
    latestAttentionAt: raw.latestAttentionAt,
    queuedWork: row?.queuedWork ?? null,
    backgroundWork: row
      ? row.activity.activeBackgroundAgentCount + row.activity.activeBackgroundCommandCount + row.activity.activeWorkflowCount
      : 0,
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

/** Does the final assistant message ask the user something or wait on them? */
function asksForInput(output: string): boolean {
  const cleaned = output
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, "code")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  if (!cleaned) return false;
  const paragraphs = cleaned.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  if (/\?["'”’)\]*_]*(\s|$)/u.test(paragraphs.at(-1) ?? "")) return true;
  const tail = paragraphs.slice(-2).join("\n\n").slice(-800);
  return INPUT_REQUEST_PATTERNS.some((pattern) => pattern.test(tail));
}

/** `text` as one plain line of at most 280 characters. */
function excerpt(text: string | null): string | null {
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
  return cleaned.length <= 280 ? cleaned : `${cleaned.slice(0, 279).trimEnd()}${ELLIPSIS}`;
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

export type LabelView = { title: string | null; summary: string | null; needsInput: boolean | null };

type Derived = { status: Status; reason: string; description: string | null; runningChildren: number };

/**
 * Doing work, itself or through a child, rather than waiting on the user: a card in WIP that is not blocked. Such a
 * thread can't be parked, and a parked one shows in WIP while it works.
 */
export function isWorking(thread: LiveThread, descendants: LiveThread[]): boolean {
  return !thread.hasPendingInteraction && (isRunningSelf(thread) || descendants.some(isRunningSelf));
}

/**
 * The card's state, why, and its description. `parkedAt` is when the user parked the thread; it stays parked until
 * it settles or fails again, either of which moves bb's attention time past it.
 */
export function deriveStatus(
  thread: LiveThread,
  details: ThreadDetails,
  stored: StoredTask | undefined,
  descendants: LiveThread[],
  label: LabelView,
  parkedAt: number | null,
): Derived {
  const runningSelf = isRunningSelf(thread);
  const runningChildren = descendants.filter(isRunningSelf).length;
  const reply = excerpt(details.output);
  const prompt = excerpt(details.lastUserPrompt);
  const note = stored?.note ?? null;
  // A note the agent wrote since the user last spoke still describes the thread.
  const freshNote =
    stored?.note && (details.lastUserInputAt === null || Date.parse(stored.updatedAt) >= details.lastUserInputAt) ? stored.note : null;
  const errored = thread.status === "error" || thread.displayStatus === "error" || thread.queuedWork === "failed";
  const childWaiting = descendants.some((child) => child.hasPendingInteraction);
  const children = `${runningChildren} child thread${runningChildren === 1 ? "" : "s"} running`;

  // The first rule that holds wins. `from` lists the description's sources by preference; the labeler's summary,
  // when there is one, beats them all.
  type Rule = [when: () => boolean, status: Status, reason: string, from: (string | null)[]];
  const rules: Rule[] = [
    [() => thread.hasPendingInteraction, "blocked", "Waiting for your response", [reply, note, prompt]],
    [() => runningSelf, "wip", "Running", [freshNote, prompt, note]],
    [() => runningChildren > 0, "wip", children, [freshNote, prompt, note]],
    [() => errored, "blocked", "Errored", [note, reply, prompt]],
    [() => thread.status === "pending" || thread.queuedWork === "waiting", "queue", "Queued", [prompt, note]],
    [() => childWaiting, "blocked", "A child thread is waiting for your response", [reply, note, prompt]],
    [() => !details.output?.trim(), "queue", "Not started", [prompt, note]],
    [() => freshNote !== null && stored?.result === "failed", "blocked", "Reported failure", [note]],
    [() => label.needsInput ?? asksForInput(details.output ?? ""), "blocked", "Asked a question", [reply]],
  ];
  const [, status, reason, from]: Rule = rules.find(([when]) => when()) ?? [() => true, "done", "Completed", [reply]];
  // A parked card keeps the reason it had when idle, so Parked still says whether it finished or asked something.
  const parked = parkedAt !== null && parkedAt >= (thread.latestAttentionAt ?? 0) && !isWorking(thread, descendants);
  return {
    status: parked ? "parked" : status,
    reason,
    description: label.summary ?? from.find((text) => text !== null) ?? null,
    runningChildren,
  };
}

