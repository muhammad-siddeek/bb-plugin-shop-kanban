import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { toLiveThread, type LiveThread, type ThreadDetails } from "./status";
import { compactTitle, safe } from "./text";

// Thread reads for the board: the live thread list, descendants, parent titles, and each
// thread's user turns and last output. Every read degrades to null/empty instead of throwing.

const PAGE = 200;
const MAX_THREADS = 5_000;

/** The SDK types `limit` as a string; the board has always sent a number. */
type EventListArgs = Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0];

/** SDK list calls return either a bare array or an object wrapping it under `key`. */
export function rows(value: unknown, key: string): any[] {
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

export function createThreadReader(bb: BbPluginApi) {
  const detailsCache = new Map<string, ThreadDetails>();
  const firstPromptCache = new Map<string, string | null>();

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
    const events = rows(await turnRequests(threadId, "desc", 50), "events");
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
      output,
      lastUserInputAt: turn.at,
      lastUserPrompt: turn.prompt,
      firstUserPrompt: firstPrompt,
      userPrompts: turn.prompts,
    };
    detailsCache.set(thread.id, details);
    return details;
  }

  /** All non-archived threads (hidden included); null when even the first page fails. */
  async function listAllThreads(): Promise<LiveThread[] | null> {
    const all: LiveThread[] = [];
    for (let offset = 0; offset < MAX_THREADS; offset += PAGE) {
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

  /** Every descendant of a thread (hidden included); empty when the read fails. */
  async function listDescendants(threadId: string): Promise<LiveThread[]> {
    const result = await safe(async () =>
      await bb.sdk.threads.experimental_listDescendants({ threadIds: [threadId], includeHidden: true }),
    );
    return rows(result, "threads").map(toLiveThread).filter((entry): entry is LiveThread => entry !== null);
  }

  /** Drop cached details for threads that left the thread list. */
  function retain(ids: ReadonlySet<string>) {
    for (const id of detailsCache.keys()) if (!ids.has(id)) detailsCache.delete(id);
  }

  /** Drop every cache entry for a deleted thread. */
  function forget(threadId: string) {
    detailsCache.delete(threadId);
    firstPromptCache.delete(threadId);
  }

  return { getThread, titleChainForParent, threadDetails, listAllThreads, listDescendants, retain, forget };
}
