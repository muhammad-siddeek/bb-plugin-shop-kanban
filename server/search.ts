import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "../contract";
import { withoutToolHelp } from "./agents";
import { commandMissing, indexHostId } from "./hosts";
import type { SearchResponse } from "./schema";
import { isRunningSelf, type LiveThread } from "./status";
import { ELLIPSIS, oneLine, safe } from "./text";
import type { ThreadMessage, ThreadReader } from "./threads";

// Thread search: every visible thread, archived included, is exported as one markdown file on a persistent
// host and indexed there by qmd (BM25). Idle threads are re-exported when their `updatedAt` moves; running
// threads every few minutes, then once more when they settle. Searching never touches the board.

const INDEX_KEY = "search-index-v1";
/** Quiet period after thread events before syncing. */
const SYNC_DELAY_MS = 5_000;
const SYNC_INTERVAL_MS = 10 * 60_000;
/** Running threads can go hours without settling, and may not bump `updatedAt` mid-turn, so they refresh on a clock. */
const RUNNING_EXPORT_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 15_000;
const EXPORT_CONCURRENCY = 3;
/** Threads exported per host write; the index is updated after every batch, the first kept small so results appear early. */
const FIRST_BATCH_SIZE = 10;
/** The host contract's cap on docs per write. */
const BATCH_SIZE = 50;
/** The host contract's cap on deletions per write. */
const REMOVE_BATCH = 1_000;
/** The host runs `qmd collection add` and `qmd update` for up to 120s each; bb's default call timeout is 30s. */
const INDEX_CALL_TIMEOUT_MS = 150_000;
const MESSAGE_MAX_CHARS = 6_000;
/** Below the host contract's 200k cap. */
const DOC_MAX_CHARS = 100_000;
const SEARCH_LIMIT = 20;
const SNIPPET_MAX_CHARS = 240;
const ROLE_HEADINGS: Record<ThreadMessage["role"], string> = { user: "User", assistant: "Assistant", message: "Message" };
const ROLE_HEADING_LINE = /^#{1,6}\s+(User|Assistant|Message)\s*$/;

const NO_HOST =
  "Thread search keeps its index on a connected persistent bb host, and none is connected (ephemeral hosts are skipped).";

/** Which threads the index holds on `hostId`: thread id → the exported `updatedAt`, or null when exported mid-run. */
const indexStateSchema = z.object({ hostId: z.string().nullable(), synced: z.record(z.string(), z.number().nullable()) });
type IndexState = z.infer<typeof indexStateSchema>;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}${ELLIPSIS}`;
}

/** A missing CLI reads better as advice than as a spawn error. */
function explain(command: string, error: string): string {
  return commandMissing(error)
    ? `${command} was not found on the host. Install qmd (npm install -g @tobilu/qmd) or set the searchCommand setting to its absolute path.`
    : error;
}

/** `# title`, then one section per message; over the size cap, keep the opening request and the latest messages. */
function threadMarkdown(thread: LiveThread, messages: ThreadMessage[]): string {
  const title = `# ${oneLine(thread.title ?? thread.titleFallback ?? thread.id)}`;
  const sections = messages.map((message) => {
    // Drop the board instructions appended to spawned threads' prompts.
    const text = withoutToolHelp(message.text);
    return `## ${ROLE_HEADINGS[message.role]}\n\n${clip(text, MESSAGE_MAX_CHARS)}`;
  });
  const [opening, ...rest] = sections;
  const latest: string[] = [];
  let size = title.length + (opening?.length ?? 0);
  for (let index = rest.length - 1; index >= 0 && size + rest[index].length <= DOC_MAX_CHARS; index -= 1) {
    latest.unshift(rest[index]);
    size += rest[index].length;
  }
  return `${[title, ...(opening ? [opening] : []), ...latest].join("\n\n")}\n`;
}

/**
 * qmd snippets open with a `@@ -8,4 @@` locator and carry the export's title and role headings; keep the
 * prose. `heading` is qmd's title for the document: its `# ` line without the marker.
 */
function cleanSnippet(snippet: string | null, heading: string | null): string | null {
  if (!snippet) return null;
  const titleLine = heading === null ? null : `# ${heading}`;
  const lines = snippet
    .split("\n")
    .filter((line) => !line.startsWith("@@") && line !== titleLine && !ROLE_HEADING_LINE.test(line.trim()))
    .map((line) => line.replace(/^#{1,6}\s+/, ""));
  const text = oneLine(lines.join(" "));
  return text ? clip(text, SNIPPET_MAX_CHARS) : null;
}

export function createSearchIndex(bb: BbPluginApi, reader: ThreadReader) {
  const settings = bb.settings.define({
    searchCommand: {
      type: "string",
      label: "Search command",
      description:
        "qmd CLI (https://github.com/tobi/qmd) on a connected persistent host. It indexes every thread, archived included, for the board's search bar. Leave empty to turn thread search off.",
      default: "qmd",
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  let state: IndexState | null = null;
  let syncing = false;
  let syncAgain = false;
  let syncError: string | null = null;
  /** The last KV save error that was logged; a large index can outgrow the KV value cap on every save. */
  let saveErrorLogged: string | null = null;
  let disposed = false;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  /** When each running thread was last exported by this process. */
  const runningExports = new Map<string, number>();

  /** Idle: whenever `updatedAt` moved since the export (a mid-run export never matches). Running: on a clock. */
  function needsExport(thread: LiveThread, exported: number | null | undefined, now: number): boolean {
    if (!isRunningSelf(thread)) return exported !== (thread.updatedAt ?? 0);
    return now - (runningExports.get(thread.id) ?? 0) >= RUNNING_EXPORT_INTERVAL_MS;
  }

  async function loadState(): Promise<IndexState> {
    if (state) return state;
    const raw = await safe(() => bb.storage.kv.get<unknown>(INDEX_KEY));
    state = indexStateSchema.safeParse(raw).data ?? { hostId: null, synced: {} };
    return state;
  }

  async function saveState(next: IndexState) {
    state = next;
    try {
      await bb.storage.kv.set(INDEX_KEY, next);
      saveErrorLogged = null;
    } catch (error) {
      // The index keeps working from memory; a restart re-exports what was not saved.
      const text = error instanceof Error ? error.message : String(error);
      if (text !== saveErrorLogged) bb.log.info(`saving the search index state failed: ${text}`);
      saveErrorLogged = text;
    }
  }

  async function exportThreads(threads: LiveThread[]) {
    const docs: Array<{ thread: LiveThread; markdown: string }> = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: EXPORT_CONCURRENCY }, async () => {
        while (next < threads.length) {
          const thread = threads[next++];
          const messages = await reader.readMessages(thread.id);
          if (messages) docs.push({ thread, markdown: threadMarkdown(thread, messages) });
        }
      }),
    );
    return docs;
  }

  /**
   * Bring the index up to date: drop files of deleted threads, re-export idle threads that changed, newest first.
   * The host's file list is the truth, so a wiped data dir, a wiped qmd index or a new host heals itself.
   */
  async function sync() {
    const command = (await settings.get()).searchCommand.trim();
    if (!command) {
      syncError = null;
      return;
    }
    const previous = await loadState();
    const hostId = await indexHostId(bb, previous.hostId);
    if (!hostId) {
      syncError = NO_HOST;
      return;
    }
    const status = await safe(() => host.call("index_status", { command }, { hostId, timeoutMs: INDEX_CALL_TIMEOUT_MS }));
    if (!status || status.error) {
      syncError = explain(command, status?.error ?? "The host could not read the search index.");
      return;
    }
    const [active, archived] = await Promise.all([reader.listAllThreads(false), reader.listAllThreads(true)]);
    if (!active || !archived) return;
    const threads = [...active, ...archived].filter((thread) => thread.visibility !== "hidden");
    const live = new Set(threads.map((thread) => thread.id));
    const onHost = new Set(status.threadIds);
    const synced = Object.fromEntries(
      Object.entries(previous.hostId === hostId ? previous.synced : {}).filter(([id]) => onHost.has(id)),
    );
    // A failed page or the listing cap leaves threads out; drop only files of threads that are gone or hidden.
    const unlisted = status.threadIds.filter((id) => !live.has(id));
    const existing = await reader.threadsById(unlisted);
    const remove = unlisted.filter((id) => (existing.get(id)?.visibility ?? "hidden") === "hidden");
    const now = Date.now();
    const stale = threads
      .filter((thread) => needsExport(thread, synced[thread.id], now))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    // Claim the host now, so search stops waiting for it even when nothing needs exporting.
    await saveState({ hostId, synced });
    for (let offset = 0; (offset < stale.length || remove.length > 0) && !disposed; ) {
      const size = offset === 0 ? FIRST_BATCH_SIZE : BATCH_SIZE;
      const docs = await exportThreads(stale.slice(offset, offset + size));
      offset += size;
      const dropping = remove.splice(0, REMOVE_BATCH);
      const write = await safe(() =>
        host.call(
          "index_write",
          { command, docs: docs.map(({ thread, markdown }) => ({ threadId: thread.id, markdown })), remove: dropping },
          { hostId, timeoutMs: INDEX_CALL_TIMEOUT_MS },
        ),
      );
      if (!write || write.error) {
        syncError = explain(command, write?.error ?? "The host could not update the search index.");
        return;
      }
      for (const { thread } of docs) {
        const running = isRunningSelf(thread);
        synced[thread.id] = running ? null : thread.updatedAt ?? 0;
        if (running) runningExports.set(thread.id, Date.now());
        else runningExports.delete(thread.id);
      }
      await saveState({ hostId, synced });
    }
    syncError = null;
  }

  async function runSync() {
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    do {
      syncAgain = false;
      await sync().catch((cause) => {
        syncError = cause instanceof Error ? cause.message : String(cause);
      });
    } while (syncAgain && !disposed);
    syncing = false;
  }

  /** Debounced sync; thread events arrive in bursts. */
  function scheduleSync(delayMs = SYNC_DELAY_MS) {
    if (syncTimer || disposed) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void runSync();
    }, delayMs);
  }

  async function search(query: string): Promise<SearchResponse> {
    const current = await loadState();
    const command = (await settings.get()).searchCommand.trim();
    const hostId = command ? await indexHostId(bb, current.hostId) : null;
    // A host that does not hold the index yet has nothing to search until the first batch lands there; a failing
    // first sync (qmd missing, say) never claims it, so its error must show here rather than "Indexing".
    const moving = hostId !== null && hostId !== current.hostId;
    const respond = (error: string | null, results: SearchResponse["results"] = []): SearchResponse => ({
      results,
      indexed: moving ? 0 : Object.keys(current.synced).length,
      indexing: (syncing || moving) && !error,
      error,
    });
    if (!command) return respond("Thread search is off. Set the searchCommand setting to a qmd CLI.");
    if (!hostId) return respond(NO_HOST);
    if (moving) {
      scheduleSync(0);
      return respond(syncError);
    }
    const found = await safe(() => host.call("index_search", { command, query, limit: SEARCH_LIMIT }, { hostId }));
    if (!found) return respond("The host could not run the search.");
    if (found.error) return respond(explain(command, found.error));
    const threads = await reader.threadsById(found.hits.map((hit) => hit.threadId));
    const results = found.hits.flatMap((hit) => {
      const thread = threads.get(hit.threadId);
      if (!thread) return [];
      return [{
        threadId: thread.id,
        title: oneLine(thread.title ?? hit.title ?? thread.titleFallback ?? thread.id),
        snippet: cleanSnippet(hit.snippet, hit.title),
        archived: thread.archivedAt !== null,
        updatedAt: thread.updatedAt,
      }];
    });
    return respond(syncError, results);
  }

  settings.onChange((next, prev) => {
    if (next.searchCommand !== prev.searchCommand) scheduleSync(0);
  });
  // A timer of its own: a search or a settings change in the meantime must still sync at once.
  const startupTimer = setTimeout(() => scheduleSync(0), STARTUP_DELAY_MS);
  const intervalTimer = setInterval(() => scheduleSync(0), SYNC_INTERVAL_MS);

  function dispose() {
    disposed = true;
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
    clearTimeout(syncTimer);
  }

  return { search, scheduleSync, dispose };
}
