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
import { hostContract } from "./contract";
import { COLUMN_IDS, COLUMNS, rpcContract, type BoardTask, type Column, type Result, type StoredTask } from "./server/schema";
import { categorizedTitle, cleanShortName, compactTitle, normalizeColumn, nowIso, safe } from "./server/text";
import { deriveStatus, isRunningSelf, toLiveThread, type CardLabel, type LabelView, type LiveThread, type ThreadDetails } from "./server/status";
import { LABEL_CONCURRENCY, LABEL_PROMPT_VERSION, LABEL_RETRY_MS, LABEL_SYSTEM, hashText, labelPrompt, parseLabel } from "./server/labels";
import { registerAgentTools, registerCli, toolHelp } from "./server/agents";

export { rpcContract } from "./server/schema";

const BOARD_CHANGED = "board-changed";
const BOARD_TASK_STATUS = "board-task-status";
const TASKS_KEY = "tasks-v1";
const LABELS_KEY = "labels-v2";

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

/** The SDK types `limit` as a string; the board has always sent a number. */
type EventListArgs = Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0];

/** SDK list calls return either a bare array or an object wrapping it under `key`. */
function rows(value: unknown, key: string): any[] {
  const wrapped = (value as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(value) ? value : Array.isArray(wrapped) ? wrapped : [];
}

/** Text parts of a `client/turn/requested` event, joined. */
function eventText(event: any): string | null {
  return Array.isArray(event?.data?.input)
    ? event.data.input
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n") || null
    : null;
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

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    labelerCommand: {
      type: "string",
      label: "Labeler command",
      description:
        "CLI on the thread's host that runs a small model in print mode (pi-compatible flags: -p --model --system-prompt). Leave empty to turn model-written card labels off; the board then uses heuristic titles and excerpts.",
      default: "pi",
    },
    labelerModels: {
      type: "string",
      label: "Labeler models",
      description: "Comma-separated models to try in order.",
      default: "anthropic/claude-haiku-4-5",
    },
  });

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
    const list = rows(hosts, "hosts");
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

  const TITLE_SETTLE_MS = 60_000;
  const renaming = new Set<string>();

  /**
   * Keep the bb sidebar title equal to the card title. A title that differs from the one we
   * last applied means someone renamed the thread by hand: respect it from then on.
   */
  function syncThreadTitle(thread: LiveThread, title: string, all: Record<string, CardLabel>) {
    const label = all[thread.id];
    if (!label || label.userTitled || thread.title === title || renaming.has(thread.id)) return;
    if (label.appliedTitle && thread.title && thread.title !== label.appliedTitle && thread.title !== label.replacedTitle) {
      all[thread.id] = { ...label, userTitled: true };
      persistLabels();
      publishBoardChangedSoon();
      return;
    }
    // Let bb's own titler finish on brand-new threads before taking over.
    if (!thread.title && thread.createdAt && Date.now() - thread.createdAt < TITLE_SETTLE_MS) return;
    renaming.add(thread.id);
    void (async () => {
      try {
        await bb.sdk.threads.update({ threadId: thread.id, title });
        all[thread.id] = { ...all[thread.id], appliedTitle: title, replacedTitle: thread.title };
        persistLabels();
      } catch (error) {
        bb.log.info(`rename failed for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        renaming.delete(thread.id);
      }
    })();
  }

  /** Returns the current (possibly stale) label and schedules a refresh when the thread moved on. */
  function labelView(
    thread: LiveThread,
    details: ThreadDetails,
    running: boolean,
    all: Record<string, CardLabel>,
  ): LabelView {
    const current = all[thread.id];
    const titleSig = `v${LABEL_PROMPT_VERSION}:${details.userPrompts.length}:${details.lastUserInputAt ?? 0}:${hashText(details.firstUserPrompt ?? thread.title ?? thread.id)}`;
    const summarySig = running
      ? `v${LABEL_PROMPT_VERSION}:run:${details.lastUserInputAt ?? 0}`
      : `v${LABEL_PROMPT_VERSION}:idle:${details.lastUserInputAt ?? 0}:${hashText(details.output ?? "")}`;
    const hasTitle = current !== undefined && Boolean(current.category && current.intent);
    const fresh = hasTitle && current.titleSig === titleSig && current.summarySig === summarySig;
    const backingOff = current?.failedAt !== undefined && Date.now() - current.failedAt < LABEL_RETRY_MS && current.summarySig === summarySig;
    const worthLabeling = running || Boolean(details.output?.trim()) || Boolean(details.lastUserPrompt);

    if (!fresh && !backingOff && worthLabeling && !labelInFlight.has(thread.id)) {
      labelInFlight.add(thread.id);
      labelQueue.push(async () => {
        try {
          const { labelerCommand, labelerModels } = await settings.get();
          const command = labelerCommand.trim();
          const models = labelerModels.split(",").map((model) => model.trim()).filter(Boolean).slice(0, 4);
          if (!command || models.length === 0) throw new Error("Labeler is turned off in settings.");
          const hostId = await resolveHostId(thread);
          if (!hostId) throw new Error("No connected host to run the labeler.");
          const categories = Array.from(new Set(Object.values(all).map((entry) => entry.category).filter(Boolean))).slice(0, 30);
          const result = await host.call(
            "complete",
            {
              command,
              system: LABEL_SYSTEM,
              prompt: labelPrompt({
                title: thread.title,
                currentTitle: current?.category && current.intent ? `[${current.category}] ${current.intent}` : null,
                firstPrompt: details.firstUserPrompt,
                lastPrompt: details.lastUserPrompt,
                prompts: details.userPrompts,
                output: details.output,
                running,
                categories,
              }),
              models,
              timeoutMs: 12_000,
            },
            { hostId },
          );
          const parsed = result?.text ? parseLabel(result.text) : null;
          if (!parsed) throw new Error(result?.error ?? "Labeler returned no usable JSON.");
          const previous = all[thread.id];
          // Only a new user message may retitle the card; summary refreshes keep the title.
          const keepTitle = previous !== undefined && Boolean(previous.category && previous.intent) && previous.titleSig === titleSig;
          all[thread.id] = {
            ...previous,
            titleSig,
            category: keepTitle ? previous.category : parsed.category,
            intent: keepTitle ? previous.intent : parsed.intent,
            summarySig,
            summary: parsed.summary,
            needsInput: running ? null : parsed.needsInput,
            failedAt: undefined,
          };
        } catch (error) {
          bb.log.info(`label failed for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
          const previous = all[thread.id];
          all[thread.id] = previous
            ? { ...previous, titleSig, summarySig, failedAt: Date.now() }
            : { titleSig: "", category: "", intent: "", summarySig, summary: null, needsInput: null, failedAt: Date.now() };
        } finally {
          labelInFlight.delete(thread.id);
          persistLabels();
          publishBoardChangedSoon();
        }
      });
      pumpLabels();
    }

    if (current?.userTitled && thread.title) return { title: thread.title, summary: fresh ? current.summary : null, needsInput: fresh && !running ? current.needsInput : null };
    if (hasTitle) syncThreadTitle(thread, `[${current.category}] ${current.intent}`, all);
    return {
      title: hasTitle ? `[${current.category}] ${current.intent}` : null,
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

  function turnRequests(threadId: string, order: "asc" | "desc", limit: number) {
    return safe(async () =>
      await bb.sdk.threads.events.list({ threadId, order, limit, types: ["client/turn/requested"] } as unknown as EventListArgs),
    );
  }

  /** Latest user-initiated turn (time and text) plus the recent user messages, oldest first. */
  async function lastUserTurn(threadId: string): Promise<{ at: number | null; prompt: string | null; prompts: string[] }> {
    const result = await turnRequests(threadId, "desc", 50);
    const events = rows(result, "events");
    const userEvents = events.filter((entry) => entry?.data?.initiator === "user");
    const event = userEvents[0] ?? events[0];
    const prompts = userEvents
      .map(eventText)
      .filter((text): text is string => Boolean(text))
      .reverse();
    return { at: typeof event?.createdAt === "number" ? event.createdAt : null, prompt: eventText(event), prompts };
  }

  /** The thread's opening user request (cached; it never changes). */
  async function firstUserPrompt(threadId: string): Promise<string | null> {
    if (firstPromptCache.has(threadId)) return firstPromptCache.get(threadId) ?? null;
    const result = await turnRequests(threadId, "asc", 10);
    if (result === null) return null;
    const events = rows(result, "events");
    const event = events.find((entry) => entry?.data?.initiator === "user") ?? events[0];
    const prompt = eventText(event);
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
      userPrompts: turn.prompts,
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
      const list = rows(page, "threads");
      for (const row of list) {
        const thread = toLiveThread(row);
        if (thread) all.push(thread);
      }
      if (list.length < PAGE) break;
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
      unread: thread.latestAttentionAt !== null && (thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt),
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
        unread: false,
        lastUserInputAt: null,
        missingThread: true,
        thread: null,
      };
    }
    const descendants = (await safe(async () => {
      const result = await bb.sdk.threads.experimental_listDescendants({ threadIds: [thread.id], includeHidden: true });
      return rows(result, "threads").map(toLiveThread).filter((entry): entry is LiveThread => entry !== null);
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
    // Oldest first within each column (earlier timestamp at the top).
    tasks.sort((a, b) =>
      a.column === "wip" && b.column === "wip" ? time(a.createdAt) - time(b.createdAt) : time(a.updatedAt) - time(b.updatedAt),
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
    return (await safe(() => bb.sdk.threads.archive({ threadId }))) !== null;
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
    board_mark_read: async ({ threadId }: { threadId: string }) => {
      const ok = (await safe(() => bb.sdk.threads.markRead({ threadId }))) !== null;
      publishBoardChanged();
      return { ok };
    },
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

  const refreshEvents: PluginThreadEventName[] = ["thread.created", "thread.idle", "thread.archived", "thread.unarchived", "interaction.pending", "turn.failed", "message.queued", "experimental_thread.parentChanged"];
  for (const event of refreshEvents) {
    bb.events.on(event, () => publishBoardChanged());
  }

  registerCli(bb, boardApi);

  bb.onDispose(() => {
    if (changedTimer) clearTimeout(changedTimer);
    labelQueue.length = 0;
    bb.log.info("disposed");
  });
}
