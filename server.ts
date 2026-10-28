// Board server: every non-archived, visible, top-level BB thread is a card, and its
// column is derived from live thread state rather than the column an agent last reported.
//
//   WIP      the thread (or any descendant) is currently running
//   Blocked  not running, and it needs the user: a pending interaction, an error,
//            a failed result, or a last message that asks a question / requests input
//   Done     not running, and the last message reports completion
//   Queue    not started yet (pending, queued work waiting, or no turn finished)

import type { BbPluginApi, PluginThreadEventName } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COLUMN_IDS, COLUMNS, rpcContract, type BoardTask, type Column, type Result, type StoredTask } from "./server/schema";
import { categorizedTitle, cleanShortName, compactTitle, normalizeColumn, nowIso, safe } from "./server/text";
import { deriveStatus, isRunningSelf, toLiveThread, type LiveThread } from "./server/status";
import { registerAgentTools, registerCli, toolHelp } from "./server/agents";
import { createSessionInfo } from "./server/session";
import { createLabeler } from "./server/labeler";
import { createThreadReader } from "./server/threads";
import { createSearchIndex } from "./server/search";

export { rpcContract } from "./server/schema";

const BOARD_CHANGED = "board-changed";
const BOARD_TASK_STATUS = "board-task-status";
const TASKS_KEY = "tasks-v1";

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

  function publishBoardChanged() {
    bb.realtime.publish(BOARD_CHANGED, { at: Date.now() });
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

  async function writeTasks(tasks: Record<string, StoredTask>) {
    await bb.storage.kv.set(TASKS_KEY, tasks);
    publishBoardChanged();
  }

  async function saveTask(task: StoredTask) {
    const tasks = await readTasks();
    tasks[task.threadId] = task;
    await writeTasks(tasks);
    await safe(() => bb.sdk.threads.updatePluginMetadata({ threadId: task.threadId, set: metadataFor(task) }));
  }

  async function defaultProjectId(): Promise<string> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const personal = projects.find((p: any) => p.isPersonal || p.kind === "personal" || p.id === "proj_personal") ?? projects[0];
    return personal?.id ?? "proj_personal";
  }

  async function materialize(
    thread: LiveThread,
    stored: StoredTask | undefined,
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
      unread: thread.latestAttentionAt !== null && (thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt),
      createdAt: stored?.createdAt ?? iso(thread.createdAt),
      updatedAt: iso(Math.max(thread.updatedAt ?? 0, stored ? Date.parse(stored.updatedAt) || 0 : 0) || null),
      lastUserInputAt: details.lastUserInputAt === null ? null : iso(details.lastUserInputAt),
      missingThread: false,
      thread: threadSummary(thread),
      session,
    };
  }

  /** Materialize a single card (used as the return value of task mutations). */
  async function materializeOne(stored: StoredTask, rawThread?: any): Promise<BoardTask> {
    const thread = toLiveThread(rawThread ?? (await reader.getThread(stored.threadId)));
    if (!thread) {
      return {
        ...stored,
        childCount: 0,
        hiddenChildCount: 0,
        runningChildCount: 0,
        statusReason: null,
        unread: false,
        lastUserInputAt: null,
        missingThread: true,
        thread: null,
        session: null,
      };
    }
    const descendants = (await reader.listDescendants(thread.id)) ?? [];
    return materialize(thread, stored, descendants, descendants.filter((entry) => entry.parentThreadId === thread.id).length);
  }

  async function listBoard() {
    const columns = COLUMN_IDS.map((id) => COLUMNS[id]);
    const stored = await readTasks();
    const threads = await reader.listAllThreads();
    if (threads === null) return { columns, tasks: [] };

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

    // Forget cached facts for threads no longer listed.
    reader.retain(ids);
    sessions.retain(ids);

    const tasks = await Promise.all(
      roots.map((thread) =>
        materialize(thread, stored[thread.id], descendantsOf(children, thread.id), (children.get(thread.id) ?? []).length),
      ),
    );

    const time = (value: string) => Date.parse(value) || 0;
    // Oldest first within each column (earlier timestamp at the top).
    tasks.sort((a, b) =>
      a.column === "wip" && b.column === "wip" ? time(a.createdAt) - time(b.createdAt) : time(a.updatedAt) - time(b.updatedAt),
    );

    return { columns, tasks };
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
    const thread = await reader.getThread(input.threadId);
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

  async function markTaskResult(threadId: string, success: boolean, summary: string) {
    const result: Result = success ? "success" : "failed";
    const task = await updateTask({ threadId, column: success ? "done" : "blocked", result, note: summary });
    return { task, result };
  }

  async function removeTask(threadId: string, options: { archiveThread?: boolean } = {}): Promise<boolean> {
    // Every BB thread is a card, so archiving works for threads the plugin never tracked.
    const archived = options.archiveThread === true && (await safe(() => bb.sdk.threads.archive({ threadId }))) !== null;
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
    board_mark_read: async ({ threadId }: { threadId: string }) => {
      const ok = (await safe(() => bb.sdk.threads.markRead({ threadId }))) !== null;
      publishBoardChanged();
      return { ok };
    },
    board_search: async ({ query }: { query: string }) => search.search(query),
  });

  const boardApi = { listBoard, spawnTask, updateTask, markTaskResult, removeTask };
  registerAgentTools(bb, boardApi);

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
    reader.forget(thread.id);
    await labels.forget(thread.id);
    await removeTask(thread.id);
    publishBoardChanged();
    search.scheduleSync();
  });

  // Settled, archived and restored threads change what the thread search index should hold.
  const searchSyncEvents: PluginThreadEventName[] = ["thread.idle", "thread.archived", "thread.unarchived"];
  for (const event of searchSyncEvents) {
    bb.events.on(event, () => search.scheduleSync());
  }

  const refreshEvents: PluginThreadEventName[] = ["thread.created", "thread.idle", "thread.archived", "thread.unarchived", "interaction.pending", "turn.failed", "message.queued", "experimental_thread.parentChanged"];
  for (const event of refreshEvents) {
    bb.events.on(event, () => publishBoardChanged());
  }

  registerCli(bb, boardApi);

  bb.onDispose(() => {
    labels.dispose();
    search.dispose();
    bb.log.info("disposed");
  });
}
