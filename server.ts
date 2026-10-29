// Board server: every non-archived, visible, top-level BB thread is a card. Its column is derived from live thread
// state (deriveStatus in server/status.ts); agents report nothing.

import type { BbPluginApi, PluginThreadEventName, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  COLUMN_IDS,
  COLUMNS,
  ERROR_MAX,
  rpcContract,
  STATUS_COLUMN,
  storedTaskSchema,
  type BoardTask,
  type Result,
  type Status,
  type StoredTask,
} from "./server/schema";
import { capped, categorizedTitle, cleanShortName, compactTitle, nowIso, safe } from "./server/text";
import { deriveStatus, isRunningSelf, isWorking, toLiveThread, type LiveThread } from "./server/status";
import { registerAgentTools, registerCli, type TaskSpawn } from "./server/agents";
import { createSessionInfo } from "./server/session";
import { createLabeler } from "./server/labeler";
import { createThreadReader } from "./server/threads";
import { createSearchIndex } from "./server/search";
import { createReviewQueue } from "./server/reviews";
import { createWipLimit } from "./server/wip-limit";

export { rpcContract } from "./server/schema";

const BOARD_CHANGED = "board-changed";
const TASKS_KEY = "tasks-v1";
/** Parked threads: thread id → when the user parked it (ms). */
const PARKED_KEY = "parked-v1";
/** The same failure is logged at most once per this interval. */
const LOG_REPEAT_MS = 60 * 60_000;
/**
 * Queued-row states bb's Send now can still send; a claimed row is already on its way, a failed one isn't queued.
 * Indexed by a row's state, so a state bb adds fails the typecheck until it's listed here.
 */
const SENDABLE_ROW_STATES = {
  queued: true,
  waiting: true,
  scheduled: true,
  claimed: false,
  failed_retrying: false,
  failed_exhausted: false,
} satisfies Record<string, boolean>;

function statusResult(status: Status): Result | null {
  return status === "done" ? "success" : status === "blocked" ? "failed" : null;
}

function iso(ms: number | null): string {
  return new Date(ms ?? Date.now()).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Depth-first walk of `children` below `id`, guarding against cycles. */
function descendantsOf(children: Map<string, LiveThread[]>, id: string): LiveThread[] {
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
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const labels = createLabeler(bb, publishBoardChanged);
  const reader = createThreadReader(bb);
  const sessions = createSessionInfo(bb, reader);
  const search = createSearchIndex(bb, reader);
  const reviews = createReviewQueue(bb, labels);
  const wip = createWipLimit(bb, reader, publishBoardChanged);
  const loggedAt = new Map<string, number>();

  function publishBoardChanged() {
    bb.realtime.publish(BOARD_CHANGED, { at: Date.now() });
  }

  function logOnce(line: string) {
    const now = Date.now();
    for (const [key, at] of loggedAt) if (now - at >= LOG_REPEAT_MS) loggedAt.delete(key);
    if (loggedAt.has(line)) return;
    loggedAt.set(line, now);
    bb.log.info(line);
  }

  /** The stored tasks KV row; entries that do not parse are dropped. */
  async function readTasks(): Promise<Record<string, StoredTask>> {
    const raw = await bb.storage.kv.get<unknown>(TASKS_KEY);
    const tasks: Record<string, StoredTask> = {};
    if (!raw || typeof raw !== "object") return tasks;
    for (const [id, value] of Object.entries(raw)) {
      const parsed = storedTaskSchema.safeParse(value);
      if (parsed.success) tasks[id] = parsed.data;
    }
    return tasks;
  }

  let kvWrite: Promise<unknown> = Promise.resolve();
  /**
   * Run one KV read-modify-write at a time: each store keeps every thread in one KV row, so overlapping edits from
   * concurrent events would drop each other's changes.
   */
  function serialized<T>(write: () => Promise<T>): Promise<T> {
    const run = kvWrite.then(write);
    kvWrite = run.catch(() => undefined);
    return run;
  }

  /** Replace one stored task with `edit`'s result (`undefined` drops it). */
  function editTask<T extends StoredTask | undefined>(
    threadId: string,
    edit: (previous: StoredTask | undefined) => T,
  ): Promise<{ previous: StoredTask | undefined; next: T }> {
    return serialized(async () => {
      const tasks = await readTasks();
      const previous = tasks[threadId];
      const next = edit(previous);
      if (next) tasks[threadId] = next;
      else delete tasks[threadId];
      if (next || previous) {
        await bb.storage.kv.set(TASKS_KEY, tasks);
        publishBoardChanged();
      }
      return { previous, next };
    });
  }

  /** When each parked thread was parked (ms); entries that do not parse are dropped. */
  async function readParked(): Promise<Record<string, number>> {
    const raw = await bb.storage.kv.get<unknown>(PARKED_KEY);
    const parked: Record<string, number> = {};
    if (!raw || typeof raw !== "object") return parked;
    for (const [id, at] of Object.entries(raw)) if (typeof at === "number" && Number.isFinite(at)) parked[id] = at;
    return parked;
  }

  /** Park a thread as of now, or forget that it was parked. */
  function setParked(threadId: string, parked: boolean): Promise<void> {
    return serialized(async () => {
      const all = await readParked();
      if (!parked && !(threadId in all)) return;
      if (parked) all[threadId] = Date.now();
      else delete all[threadId];
      await bb.storage.kv.set(PARKED_KEY, all);
      publishBoardChanged();
    });
  }

  async function defaultProjectId(): Promise<string> {
    const projects = (await safe(() => bb.sdk.projects.list({ includePersonal: true }))) ?? [];
    const project = projects.find((entry) => entry.kind === "personal") ?? projects[0];
    if (!project) throw new Error("No bb project to start the thread in: open or create a project in bb first.");
    return project.id;
  }

  async function materialize(
    thread: LiveThread,
    stored: StoredTask | undefined,
    parkedAt: number | null,
    descendants: LiveThread[],
    childCount: number,
  ): Promise<BoardTask> {
    const running = isRunningSelf(thread) || descendants.some(isRunningSelf);
    const [details, all, session] = await Promise.all([
      reader.threadDetails(thread, !running),
      labels.load(),
      sessions.sessionFor(thread, descendants),
    ]);
    const label = labels.view(thread, details, running, all);
    const derived = deriveStatus(thread, details, stored?.error ?? null, descendants, label, parkedAt);
    // Until the labeler has run: "[category] thread title".
    const title =
      label.title ??
      categorizedTitle(
        stored?.titleChain || thread.title || (thread.titleFallback ? compactTitle(thread.titleFallback) : null) || thread.id,
        thread.titleFallback ?? "",
      );
    return {
      threadId: thread.id,
      shortName: stored?.shortName ?? cleanShortName(title),
      titleChain: title,
      status: derived.status,
      column: STATUS_COLUMN[derived.status],
      parentThreadId: thread.parentThreadId,
      projectId: thread.projectId ?? stored?.projectId ?? null,
      description: stored?.description ?? null,
      result: statusResult(derived.status),
      note: derived.description,
      childCount,
      runningChildCount: derived.runningChildren,
      statusReason: derived.status === "queue" && wip.isWaiting(thread.id) ? "Waiting for a WIP slot" : derived.reason,
      startable: derived.status === "queue" && thread.queuedWork === "waiting",
      unread: thread.latestAttentionAt !== null && (thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt),
      createdAt: stored?.createdAt ?? iso(thread.createdAt),
      updatedAt: iso(Math.max(thread.updatedAt ?? 0, stored ? Date.parse(stored.updatedAt) || 0 : 0) || null),
      lastUserInputAt: details.lastUserInputAt === null ? null : iso(details.lastUserInputAt),
      missingThread: false,
      thread: {
        id: thread.id,
        title: thread.title,
        titleFallback: thread.titleFallback,
        status: thread.status,
        runtimeStatus: thread.displayStatus,
        providerId: thread.providerId,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt,
      },
      session,
    };
  }

  /** Materialize a just-spawned thread's card; `live` saves reading the thread again. */
  async function materializeOne(stored: StoredTask, live?: LiveThread | null): Promise<BoardTask> {
    const thread = live ?? toLiveThread(await reader.getThread(stored.threadId));
    if (!thread) {
      return {
        ...stored,
        status: "queue",
        column: "queue",
        result: null,
        note: null,
        childCount: 0,
        runningChildCount: 0,
        statusReason: null,
        unread: false,
        lastUserInputAt: null,
        missingThread: true,
        startable: false,
        thread: null,
        session: null,
      };
    }
    const [descendants, parked] = await Promise.all([
      reader.listDescendants(thread.id),
      readParked().catch((): Record<string, number> => ({})),
    ]);
    const children = descendants ?? [];
    return materialize(
      thread,
      stored,
      parked[thread.id] ?? null,
      children,
      children.filter((entry) => entry.parentThreadId === thread.id).length,
    );
  }

  async function listBoard() {
    const columns = COLUMN_IDS.map((id) => COLUMNS[id]);
    // Without the stored names, notes and parked set the board still shows every thread, from live state alone.
    const [stored, parked, threads] = await Promise.all([
      readTasks().catch((error: unknown): Record<string, StoredTask> => {
        logOnce(`reading stored threads failed: ${errorMessage(error)}`);
        return {};
      }),
      readParked().catch((error: unknown): Record<string, number> => {
        logOnce(`reading parked threads failed: ${errorMessage(error)}`);
        return {};
      }),
      reader.listAllThreads(),
    ]);
    if (threads === null) return { columns, tasks: [], wipLimit: wip.view() };

    const ids = new Set(threads.map((thread) => thread.id));
    const children = new Map<string, LiveThread[]>();
    for (const thread of threads) {
      if (!thread.parentThreadId) continue;
      const list = children.get(thread.parentThreadId) ?? [];
      list.push(thread);
      children.set(thread.parentThreadId, list);
    }

    // Every visible, non-archived top-level thread is a card. A thread whose parent is
    // not in the active list (e.g. archived parent) is treated as top-level too.
    const roots = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.visibility !== "hidden" &&
        (!thread.parentThreadId || !ids.has(thread.parentThreadId)),
    );
    labels.setBoard(roots.map((thread) => thread.id));

    // Forget cached facts for threads no longer listed.
    reader.retain(ids);
    sessions.retain(ids);

    const tasks = await Promise.all(
      roots.map((thread) =>
        materialize(
          thread,
          stored[thread.id],
          parked[thread.id] ?? null,
          descendantsOf(children, thread.id),
          (children.get(thread.id) ?? []).length,
        ),
      ),
    );

    // Oldest first (earlier timestamp at the top): running threads by when they started, the rest by last update.
    const sortTime = (task: BoardTask) => Date.parse(task.status === "wip" ? task.createdAt : task.updatedAt) || 0;
    tasks.sort((a, b) => sortTime(a) - sortTime(b));

    return { columns, tasks, wipLimit: wip.view() };
  }

  /** Park an idle thread, or unpark one; returns its card. A running thread can't be parked. */
  async function parkTask(threadId: string, parked: boolean): Promise<BoardTask> {
    const [thread, descendants] = await Promise.all([
      reader.threadsById([threadId]).then((threads) => threads.get(threadId)),
      reader.listDescendants(threadId),
    ]);
    if (!thread || thread.archivedAt !== null) throw new Error(`No thread ${threadId} on the board.`);
    const children = descendants ?? [];
    if (parked && isWorking(thread, children)) {
      throw new Error(`${thread.title ?? threadId} is running; park it once it settles.`);
    }
    await setParked(threadId, parked);
    const [stored, parkedAll] = await Promise.all([readTasks(), readParked()]);
    return materialize(
      thread,
      stored[threadId],
      parkedAll[threadId] ?? null,
      children,
      children.filter((entry) => entry.parentThreadId === threadId).length,
    );
  }

  /**
   * Start a Queue card now: send its thread's next waiting message with bb's Send now, which skips the WIP limit (and
   * any other dispatch hold) by bb's design, as the composer's Send now does. Returns its card.
   */
  async function startTask(threadId: string): Promise<BoardTask> {
    const thread = (await reader.threadsById([threadId])).get(threadId);
    if (!thread || thread.archivedAt !== null) throw new Error(`No thread ${threadId} on the board.`);
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
    const row = rows.find((entry) => SENDABLE_ROW_STATES[entry.state]);
    if (row) {
      const sent = await bb.sdk.threads.queuedMessages.send({ threadId, queuedMessageId: row.id, mode: "auto" });
      if (sent.delivery === "queued") {
        const hold = sent.queuedMessage.waitingOn;
        const why =
          hold?.kind === "plugin" ? hold.reason : hold?.kind === "host-offline" ? `${hold.hostName} is offline` : hold?.kind.replace(/-/g, " ");
        throw new Error(`bb couldn't send it yet${why ? `: ${why}` : ""}.`);
      }
    }
    const [live, descendants, stored, parkedAll] = await Promise.all([
      reader.threadsById([threadId]).then((threads) => threads.get(threadId) ?? thread),
      reader.listDescendants(threadId),
      readTasks(),
      readParked(),
    ]);
    const children = descendants ?? [];
    const card = await materialize(
      live,
      stored[threadId],
      parkedAll[threadId] ?? null,
      children,
      children.filter((entry) => entry.parentThreadId === threadId).length,
    );
    // Nothing to send is fine when the card already left Queue (a second click, or a WIP slot freed meanwhile).
    if (!row && card.status === "queue") throw new Error("Nothing is waiting to be sent in this thread.");
    return card;
  }

  async function preferThreadNotifications(threadId: string) {
    await safe(() =>
      bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "threadNotifications.set",
        input: { threadId, level: "all" },
        outputSchema: z.unknown(),
      }),
    );
  }

  async function spawnTask(input: TaskSpawn): Promise<BoardTask> {
    const shortName = categorizedTitle(input.shortName, input.prompt);
    const parent = await reader.titleChainForParent(input.parentThreadId);
    const titleChain = parent.titleChain ? `${parent.titleChain} > ${shortName}` : shortName;
    const projectId = input.projectId ?? parent.projectId ?? (await defaultProjectId());
    const now = nowIso();
    const common = {
      shortName,
      titleChain,
      parentThreadId: input.parentThreadId ?? null,
      updatedAt: now,
    } satisfies Partial<StoredTask>;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt: input.prompt.trim(),
      title: titleChain,
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      pluginMetadata: { boardTask: true, ...common },
    });
    const task: StoredTask = {
      threadId: thread.id,
      ...common,
      projectId,
      description: input.prompt.trim().slice(0, 1_000),
      error: null,
      createdAt: now,
    };
    // The thread exists by now: failing to store its description must not report the spawn as failed.
    await editTask(task.threadId, () => task).catch((error: unknown) =>
      logOnce(`storing a spawned thread failed: ${errorMessage(error)}`),
    );
    await preferThreadNotifications(task.threadId);
    return materializeOne(task, toLiveThread(thread));
  }

  async function removeTask(threadId: string, options: { archiveThread?: boolean } = {}): Promise<boolean> {
    // Every BB thread is a card, so archiving works for threads the plugin never tracked.
    const archived = options.archiveThread === true && (await safe(() => bb.sdk.threads.archive({ threadId }))) !== null;
    const { previous } = await editTask(threadId, () => undefined);
    await setParked(threadId, false);
    if (previous) {
      await safe(() =>
        bb.sdk.threads.updatePluginMetadata({
          threadId,
          set: { boardTask: false, updatedAt: nowIso() },
          remove: ["shortName", "titleChain"],
        }),
      );
    } else if (archived) {
      publishBoardChanged();
    }
    return archived || previous !== undefined;
  }

  bb.rpc.register(rpcContract, {
    board_list: listBoard,
    board_spawn_task: spawnTask,
    board_remove_task: async ({ threadId }) => ({ removed: await removeTask(threadId, { archiveThread: true }) }),
    board_park_task: ({ threadId, parked }) => parkTask(threadId, parked),
    board_start_task: ({ threadId }) => startTask(threadId),
    board_mark_read: async ({ threadId }) => {
      const ok = (await safe(() => bb.sdk.threads.markRead({ threadId }))) !== null;
      publishBoardChanged();
      return { ok };
    },
    board_set_wip_limit: ({ limit }) => wip.setLimit(limit),
    board_search: ({ query }) => search.search(query),
    reviews_list: () => reviews.list(),
    reviews_draft: ({ id }) => reviews.draft(id),
    reviews_mark_read: ({ id }) => reviews.markRead(id),
    reviews_archive: ({ id }) => reviews.archive(id),
    reviews_submit: ({ id, verdict, body }) => reviews.submit(id, verdict, body),
  });

  const boardApi = { listBoard, spawnTask, removeTask, parkTask };
  registerAgentTools(bb, boardApi);
  registerCli(bb, boardApi);

  /** No caller awaits an event handler: a failure (e.g. a KV write) is logged, at most once per interval. */
  function on<E extends PluginThreadEventName>(event: E, handler: (payload: PluginThreadEventPayloads[E]) => Promise<void>) {
    bb.events.on(event, (payload) =>
      handler(payload).catch((error: unknown) => logOnce(`${event} handler failed: ${errorMessage(error)}`)),
    );
  }

  on("thread.active", async ({ thread }) => {
    // Running again takes a thread out of Parked; when it settles it goes where its new state says.
    await setParked(thread.id, false);
  });

  // A spawned thread's failure message describes its card while it shows as errored.
  on("thread.failed", async ({ thread, error }) => {
    await editTask(thread.id, (previous) =>
      previous && { ...previous, error: capped(error ?? "Thread failed.", ERROR_MAX), updatedAt: nowIso() },
    );
  });

  on("thread.deleted", async ({ thread }) => {
    reader.forget(thread.id);
    await labels.forget(thread.id);
    await removeTask(thread.id);
  });

  // Archived threads leave the board: drop their stored state so the KV rows (capped at 256KB each) only grow with
  // live threads.
  on("thread.archived", async ({ thread }) => {
    await labels.forget(thread.id, true);
    await removeTask(thread.id);
  });

  // Settled, deleted, archived and restored threads change what the thread search index should hold.
  const searchSyncEvents: PluginThreadEventName[] = ["thread.idle", "thread.deleted", "thread.archived", "thread.unarchived"];
  for (const event of searchSyncEvents) bb.events.on(event, () => search.scheduleSync());

  const refreshEvents: PluginThreadEventName[] = [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.deleted",
    "thread.archived",
    "thread.unarchived",
    "interaction.pending",
    "turn.failed",
    "message.queued",
    "experimental_thread.parentChanged",
  ];
  for (const event of refreshEvents) bb.events.on(event, publishBoardChanged);

  bb.onDispose(() => {
    labels.dispose();
    search.dispose();
    reviews.dispose();
    wip.dispose();
    bb.log.info("disposed");
  });
}
