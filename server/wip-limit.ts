import type { BbPluginApi, PluginThreadEventName } from "@get-bb/plugin-sdk";
import { WIP_LIMIT_MAX, type WipLimitView } from "./schema";
import { isRunningSelf, type LiveThread } from "./status";
import type { ThreadReader } from "./threads";

// WIP limit: at most `limit` cards running at once. A card is the board's: a visible, non-archived top-level thread
// with its descendants rolled up. It holds a slot while it or a descendant runs and nobody waits on the user
// (isWorking's rule), so Blocked cards hold none. Every message passes bb's `message.dispatch` checkpoint; one that
// would start a card that isn't running while `limit` cards are waits as a queued row, and bb sends it once a slot
// frees. Work inside a running card (steers, follow-ups, child threads) proceeds: the card already holds its slot,
// and holding a child its parent waits on would stall the card. The user's Send now on a queued row skips the
// checkpoint by bb's design.

const LIMIT_KEY = "wip-limit-v1";
/**
 * A card let through this recently counts as running before its thread shows it: bb flips an idle thread a follow-up
 * reaches to active only after the checkpoint's lock releases, so the next message decided could miss it. The grace
 * ends early once that thread frees its slot (a turn can finish before any later message is decided).
 */
const ADMITTED_MS = 15_000;
/** While messages wait, ask bb to try them again this often: a slot can free without a thread event (a background task ending). */
const RECHECK_MS = 30_000;
/**
 * bb's re-attempt walk skips a row it re-queued under a second ago, so a recheck right after another one can miss a
 * freed slot; each freeing event asks again once this long after the last one.
 */
const TRAILING_RECHECK_MS = 1_500;
/** Events after which a card may have stopped holding a slot; each carries the thread. */
const FREEING_EVENTS = [
  "thread.idle",
  "thread.failed",
  "thread.archived",
  "thread.deleted",
  "interaction.pending",
  "experimental_thread.parentChanged",
] as const satisfies readonly PluginThreadEventName[];

export function createWipLimit(bb: BbPluginApi, reader: ThreadReader, onChange: () => void) {
  let limit: number | null = null;
  const loaded = bb.storage.kv
    .get<unknown>(LIMIT_KEY)
    .then((value) => {
      // Anything but a whole number in range (unset, or corrupt) means no limit.
      limit = typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= WIP_LIMIT_MAX ? value : null;
    })
    .catch((error: unknown) => bb.log.warn(`reading the WIP limit failed: ${String(error)}`));
  /** Card (root thread) id → when, and to which thread in it, a message was let through. */
  const admitted = new Map<string, { at: number; threadId: string }>();
  /** Queued rows held by this plugin: row id → thread id. */
  const waiting = new Map<string, string>();

  function recheck() {
    void bb.experimental_hooks.recheck("message.dispatch").catch(() => undefined);
  }

  /** Cards running now: root thread ids whose tree runs while the root waits on nobody. */
  function workingCards(threads: LiveThread[]) {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    // A thread whose parent isn't listed (archived) is a card of its own, as on the board.
    const rootOf = (thread: LiveThread): LiveThread => {
      let at = thread;
      for (let depth = 0; at.parentThreadId && depth < 100; depth++) {
        const parent = byId.get(at.parentThreadId);
        if (!parent) break;
        at = parent;
      }
      return at;
    };
    const working = new Set<string>();
    for (const thread of threads) {
      if (!isRunningSelf(thread)) continue;
      const root = rootOf(thread);
      if (root.visibility !== "hidden" && !root.hasPendingInteraction) working.add(root.id);
    }
    return { byId, rootOf, working };
  }

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    if (ctx.attempt === "join-turn") return { action: "proceed" };
    await loaded;
    const max = limit;
    if (max === null) return { action: "proceed" };
    // Fail open: when the threads can't be read, the message goes rather than waiting on a count nobody has.
    const threads = await reader.listAllThreads();
    if (threads === null) return { action: "proceed" };
    const { byId, rootOf, working } = workingCards(threads);
    const target = byId.get(ctx.thread.id);
    const root = target ? rootOf(target) : null;
    if (!root || root.visibility === "hidden") return { action: "proceed" };

    const now = Date.now();
    for (const [id, { at }] of admitted) if (now - at > ADMITTED_MS || working.has(id)) admitted.delete(id);
    const busy = new Set([...working, ...admitted.keys()]);
    if (busy.has(root.id)) return { action: "proceed" };
    if (busy.size >= max) {
      const reason = max === 0
        ? "WIP limit is 0: sends when you raise it"
        : `WIP full (${busy.size} of ${max} running): sends when a WIP thread finishes`;
      return { action: "wait", reason };
    }
    admitted.set(root.id, { at: now, threadId: ctx.thread.id });
    return { action: "proceed" };
  });

  function track(entry: { id: string; threadId: string; waitingOn: { kind: string; pluginId?: string } | null }) {
    const ours = entry.waitingOn?.kind === "plugin" && entry.waitingOn.pluginId === bb.pluginId;
    const changed = ours !== waiting.has(entry.id);
    if (ours) waiting.set(entry.id, entry.threadId);
    else waiting.delete(entry.id);
    if (changed) onChange();
  }
  bb.events.on("message.queued", ({ entry }) => track(entry));
  bb.events.on("message.dispatched", ({ entry }) => track({ ...entry, waitingOn: null }));
  bb.events.on("message.cancelled", ({ entry }) => track({ ...entry, waitingOn: null }));
  const forgetThread = ({ thread }: { thread: { id: string } }) => {
    for (const [id, threadId] of waiting) if (threadId === thread.id) waiting.delete(id);
  };
  bb.events.on("thread.archived", forgetThread);
  bb.events.on("thread.deleted", forgetThread);
  let trailing: ReturnType<typeof setTimeout> | undefined;
  for (const event of FREEING_EVENTS) {
    bb.events.on(event, ({ thread }) => {
      for (const [id, entry] of admitted) if (entry.threadId === thread.id) admitted.delete(id);
      if (waiting.size === 0) return;
      recheck();
      clearTimeout(trailing);
      trailing = setTimeout(() => (waiting.size > 0 ? recheck() : undefined), TRAILING_RECHECK_MS);
    });
  }

  const timer = setInterval(() => {
    if (waiting.size > 0) recheck();
  }, RECHECK_MS);
  // Rows held before a reload are re-decided now; those still held queue again and are tracked from their event.
  recheck();

  const view = (): WipLimitView => ({ limit, waiting: new Set(waiting.values()).size });

  return {
    view,
    /** Whether a message to this thread is held for a WIP slot. */
    isWaiting(threadId: string): boolean {
      for (const id of waiting.values()) if (id === threadId) return true;
      return false;
    },
    async setLimit(next: number | null): Promise<WipLimitView> {
      await loaded;
      await bb.storage.kv.set(LIMIT_KEY, next);
      limit = next;
      onChange();
      // A higher limit or none lets held messages go now; a lower one holds only new starts, never running threads.
      recheck();
      return view();
    },
    dispose() {
      clearInterval(timer);
      clearTimeout(trailing);
    },
  };
}
