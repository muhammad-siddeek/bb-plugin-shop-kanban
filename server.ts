// Board server: every non-archived, visible, top-level BB thread is a card. Its column is derived from live thread
// state (deriveStatus in server/status.ts), not from the column an agent last reported.

import type { BbPluginApi, PluginThreadEventName, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  COLUMN_IDS,
  COLUMNS,
  rpcContract,
  STATUS_COLUMN,
  storedTaskSchema,
  type BoardTask,
  type Result,
  type Status,
  type StoredTask,
} from "./server/schema";
import { categorizedTitle, cleanShortName, compactTitle, nowIso, safe } from "./server/text";
import { deriveStatus, isRunningSelf, isWorking, toLiveThread, type LiveThread } from "./server/status";
import { registerAgentTools, registerCli, toolHelp, type TaskSpawn, type TaskUpdate } from "./server/agents";
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

function statusResult(status: Status): Result | null {
  return status === "done" ? "success" : status === "blocked" ? "failed" : null;
}

/** `previous` with an agent's or the CLI's update applied. */
function updatedTask(input: TaskUpdate, previous: StoredTask | undefined, thread: LiveThread | null): StoredTask {
  const now = nowIso();
  const baseName = input.shortName ?? previous?.shortName ?? compactTitle(thread?.title ?? thread?.titleFallback ?? input.threadId);
  const shortName = input.shortName
    ? categorizedTitle(baseName, previous?.description ?? previous?.note ?? "")
    : cleanShortName(baseName);
  const column = input.column ?? previous?.column ?? "queue";
  const parentThreadId = previous?.parentThreadId ?? thread?.parentThreadId ?? null;
  // An explicit result wins; otherwise Done/Blocked imply one, and moving elsewhere clears it.
  const result =
    input.result !== undefined
      ? input.result
      : statusResult(column) ?? (input.column !== undefined ? null : previous?.result ?? null);
  return {
    threadId: input.threadId,
    shortName,
    titleChain: input.shortName && parentThreadId === null ? shortName : previous?.titleChain ?? shortName,
    column,
    parentThreadId,
    projectId: previous?.projectId ?? thread?.projectId ?? null,
    description: previous?.description ?? null,
    result,
    note: input.note ?? previous?.note ?? null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
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
    const derived = deriveStatus(thread, details, stored, descendants, label, parkedAt);
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

  /** Materialize a single card (the return value of thread mutations); `live` saves reading the thread again. */
  async function materializeOne(stored: StoredTask, live?: LiveThread | null): Promise<BoardTask> {
    const thread = live ?? toLiveThread(await reader.getThread(stored.threadId));
    if (!thread) {
      return {
        ...stored,
        status: stored.column,
        column: STATUS_COLUMN[stored.column],
        childCount: 0,
        runningChildCount: 0,
        statusReason: null,
        unread: false,
        lastUserInputAt: null,
        missingThread: true,
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

  /** A thread an agent reports finished or stuck turns unread and notifies the user. */
  async function notifyIfSettled(previous: StoredTask | undefined, next: StoredTask) {
    if (previous?.column === next.column) return;
    if (next.column !== "blocked" && next.column !== "done") return;
    await preferThreadNotifications(next.threadId);
    await safe(() => bb.sdk.threads.markUnread({ threadId: next.threadId }));
    publishBoardChanged();
  }

  /** Store an update and mirror it into the thread's metadata; also returns the thread as read. */
  async function storeUpdate(input: TaskUpdate) {
    const thread = toLiveThread(await reader.getThread(input.threadId));
    const { previous, next } = await editTask(input.threadId, (previous) => updatedTask(input, previous, thread));
    const { threadId, projectId, description, createdAt, ...metadata } = next;
    await safe(() => bb.sdk.threads.updatePluginMetadata({ threadId, set: { boardTask: true, ...metadata } }));
    await notifyIfSettled(previous, next);
    return { thread, next };
  }

  async function updateTask(input: TaskUpdate): Promise<BoardTask> {
    const { thread, next } = await storeUpdate(input);
    return materializeOne(next, thread);
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
      column: input.column ?? (input.parentThreadId ? "wip" : "queue"),
      parentThreadId: input.parentThreadId ?? null,
      result: null,
      note: null,
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
      threadId: thread.id,
      ...common,
      projectId,
      description: input.prompt.trim().slice(0, 1_000),
      createdAt: now,
    };
    // The thread exists by now: failing to store its description must not report the spawn as failed.
    await editTask(task.threadId, () => task).catch((error: unknown) =>
      logOnce(`storing a spawned thread failed: ${errorMessage(error)}`),
    );
    await preferThreadNotifications(task.threadId);
    return materializeOne(task, toLiveThread(thread));
  }

  async function markTaskResult(threadId: string, success: boolean, summary: string) {
    const result: Result = success ? "success" : "failed";
    const task = await updateTask({ threadId, column: success ? "done" : "blocked", result, note: summary });
    return { task, result };
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
          remove: ["shortName", "titleChain", "column", "result", "note"],
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

  const boardApi = { listBoard, spawnTask, updateTask, markTaskResult, removeTask, parkTask };
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
    const task = (await readTasks())[thread.id];
    if (task?.column === "queue" && !task.result) await storeUpdate({ threadId: thread.id, column: "wip" });
  });

  on("thread.failed", async ({ thread, error }) => {
    if (!(await readTasks())[thread.id]) return;
    await storeUpdate({ threadId: thread.id, column: "blocked", result: "failed", note: error ?? "Thread failed." });
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
