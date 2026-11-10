import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { HARNESS_NOTICE, LABEL_PROMPT_VERSION, LABEL_SYSTEM, SUMMARY_PROMPT_VERSION, THREAD_MENTION, hashText, labelPrompt, parseLabel } from "./labels";
import type { LabelView, LiveThread, ThreadDetails } from "./status";
import { commandMissing, connectedHostId, hostClient } from "./hosts";
import { coalesced, errorMessage, jobQueue, parseRecord, safe, throttledLog } from "./text";

// Model-written card labels: a small model on the thread's host writes the "[category] intent" title and a
// summary of the latest interaction. Labels are stored in KV, refreshed in the background with bounded
// concurrency, and the card title is mirrored onto the bb thread title until the user renames it.

const LABELS_KEY = "labels-v2";
const LABEL_CONCURRENCY = 2;
const LABEL_TIMEOUT_MS = 12_000;
/** How long a failed label refresh or thread rename waits before it is tried again. */
const RETRY_MS = 10 * 60_000;
/** The same log line is written at most once per this interval. */
const LOG_INTERVAL_MS = 60 * 60_000;
/** Let bb's own titler finish on brand-new threads before taking over. */
const TITLE_SETTLE_MS = 60_000;

const cardLabelSchema = z.object({
  titleSig: z.string(),
  category: z.string(),
  intent: z.string(),
  summarySig: z.string(),
  summary: z.string().nullable(),
  needsInput: z.boolean().nullable(),
  /** Title the board last wrote to the bb thread, to tell our renames from the user's. */
  appliedTitle: z.string().optional(),
  /** The title our last rename replaced; seeing it again just means a stale snapshot. */
  replacedTitle: z.string().nullable().optional(),
  /** The user renamed the thread themselves; stop syncing and show their title. */
  userTitled: z.boolean().optional(),
  /**
   * Hash of the opening user message the title was written from. When the board later reads more of it (an
   * attachment it couldn't read before), the old title was a guess and is written afresh.
   */
  firstSig: z.string().optional(),
});
type Labels = Record<string, z.infer<typeof cardLabelSchema>>;
/** What a queued refresh writes: the signatures it labels and the title the model is shown. */
type LabelJob = { titleSig: string; summarySig: string; firstSig: string; currentTitle: string | null };

/** The lines `turnInput` frames an attached file or image with. */
const ATTACHMENT_MARKS = /^\[(attached (file|image)\b[^\n]*|end of attached file)\]$/gmu;
/** Closes a text attachment the board read; labels from before 0.16 never saw such text. */
const READ_ATTACHMENT = /^\[end of attached file\]$/mu;
/**
 * Below this many characters of the user's own words (attachment names and harness notices left out), the messages
 * can't name the thread: "keep going" on its own. The labeler then also reads the agent's last finished reply.
 */
const THIN_USER_TEXT = 120;

/** The user's own words across `messages`: attachment markers and harness notices removed. */
function userWords(messages: (string | null)[]): string {
  return messages
    .filter((text): text is string => Boolean(text) && !HARNESS_NOTICE.test(text!))
    .map((text) => text.replace(ATTACHMENT_MARKS, "").trim())
    .join(" ")
    .trim();
}

/** `onChange` is called (debounced) whenever a label update should re-render the board. */
export function createLabeler(bb: BbPluginApi, onChange: () => void) {
  const settings = bb.settings.define({
    labelerCommand: {
      type: "string",
      label: "Labeler command",
      description:
        "CLI on the thread's host that runs a small model in print mode (pi-compatible flags: -p --model --system-prompt). Leave empty to turn model-written thread labels off; the board then uses heuristic titles and excerpts.",
      default: "pi",
    },
    labelerModels: {
      type: "string",
      label: "Labeler models",
      description: "Comma-separated models to try in order.",
      default: "anthropic/claude-haiku-4-5",
    },
  });
  /** No models means the labeler is off. */
  const config = ({ labelerCommand, labelerModels }: { labelerCommand: string; labelerModels: string }) => {
    const command = labelerCommand.trim();
    const models = command ? labelerModels.split(",").map((model) => model.trim()).filter(Boolean).slice(0, 4) : [];
    return { command, models };
  };

  const host = hostClient(bb);
  let labels: Promise<Labels> | null = null;
  let labelsWrite: Promise<void> = Promise.resolve();
  const labelQueue = jobQueue(LABEL_CONCURRENCY);
  const labelInFlight = new Set<string>();
  const renaming = new Set<string>();
  /** Threads that are cards on the board now; their titles show the labeler what the board already groups. */
  let boardIds: string[] = [];
  /**
   * Threads whose last refresh failed, with the `titleSig|summarySig` it tried. They keep showing their last label
   * and retry after RETRY_MS, or at once when the thread moves on. Kept in memory: a restart retries.
   */
  const failures = new Map<string, { at: number; sig: string }>();
  const changedSoon = coalesced(onChange, 400);
  let enabled = true;
  const logQuietly = throttledLog(bb, LOG_INTERVAL_MS);

  void settings.get().then((values) => (enabled = config(values).models.length > 0), () => {});
  settings.onChange((next) => {
    enabled = config(next).models.length > 0;
    // The user may have just fixed the command: retry failed threads right away.
    failures.clear();
    changedSoon();
  });

  /** One shared promise, so concurrent first loads mutate and persist the same record. Bad entries are dropped. */
  function load(): Promise<Labels> {
    labels ??= safe(() => bb.storage.kv.get<unknown>(LABELS_KEY)).then((raw) => parseRecord(raw, cardLabelSchema));
    return labels;
  }

  function persist() {
    labelsWrite = labelsWrite.then(async () => {
      try {
        await bb.storage.kv.set(LABELS_KEY, await load());
      } catch (error) {
        logQuietly(`saving thread labels failed: ${errorMessage(error)}`);
      }
    });
  }

  /**
   * Runs the labeler model on `hostId` and returns its reply; throws when the labeler is off, the CLI fails or
   * the host is unreachable. Shared with the review queue, which writes its pull request summaries with the same model.
   */
  async function complete(hostId: string, system: string, prompt: string, timeoutMs: number): Promise<string> {
    const { command, models } = config(await settings.get());
    if (models.length === 0) throw new Error("Labeler is turned off in settings.");
    // The host tries each model in turn; bb's default 30s call timeout would cut that short.
    const result = await host.call(
      "complete",
      { command, system, prompt, models, timeoutMs },
      { hostId, timeoutMs: timeoutMs * models.length + 5_000 },
    );
    if (result.text) return result.text;
    const error = result.error ?? "Labeler returned nothing.";
    throw new Error(
      commandMissing(error)
        ? `${command} was not found on host ${hostId}. Install it there, or set the labelerCommand setting to a pi-compatible CLI's absolute path.`
        : error,
    );
  }

  /**
   * Keep the bb sidebar title equal to the card title. A title that differs from the one we
   * last applied means someone renamed the thread by hand: respect it from then on.
   */
  function syncThreadTitle(thread: LiveThread, title: string, all: Labels) {
    const label = all[thread.id];
    if (!label || label.userTitled || thread.title === title || renaming.has(thread.id)) return;
    if (label.appliedTitle && thread.title && thread.title !== label.appliedTitle && thread.title !== label.replacedTitle) {
      all[thread.id] = { ...label, userTitled: true };
      persist();
      changedSoon();
      return;
    }
    if (!thread.title && thread.createdAt && Date.now() - thread.createdAt < TITLE_SETTLE_MS) return;
    renaming.add(thread.id);
    void (async () => {
      try {
        await bb.sdk.threads.update({ threadId: thread.id, title });
        // The label may have been forgotten (thread archived) while the rename was in flight.
        const latest = all[thread.id];
        if (latest) all[thread.id] = { ...latest, appliedTitle: title, replacedTitle: thread.title };
        persist();
        renaming.delete(thread.id);
      } catch (error) {
        logQuietly(`thread rename failed: ${errorMessage(error)}`);
        // Every board render would retry it; wait instead.
        setTimeout(() => renaming.delete(thread.id), RETRY_MS).unref?.();
      }
    })();
  }

  async function relabel(thread: LiveThread, details: ThreadDetails, running: boolean, job: LabelJob, all: Labels) {
    const hostId = thread.hostId ?? (await connectedHostId(bb));
    try {
      if (!hostId) throw new Error("No connected bb host to run the labeler on.");
      const board = boardIds.flatMap((id) => {
        const label = id === thread.id ? undefined : all[id];
        return label?.category && label.intent ? [`[${label.category}] ${label.intent}`] : [];
      });
      const userText = [details.firstUserPrompt, ...details.userPrompts].join("\n");
      // Too little to name the thread from: let the agent's last finished reply say what it is working on.
      const thin = userWords([details.firstUserPrompt, ...details.userPrompts]).length < THIN_USER_TEXT;
      // While the agent works, its last reply answers an earlier message; it only stands in for missing user text.
      const output = running && !thin ? null : (details.output ?? (thin ? await safe(async () => (await bb.sdk.threads.output({ threadId: thread.id })).output) : null));
      const mentioned = [...new Set(Array.from(userText.matchAll(THREAD_MENTION), (match) => match[1]))].slice(0, 5);
      const mentionTitles = Object.fromEntries(
        (await Promise.all(mentioned.map(async (id) => [id, (await safe(() => bb.sdk.threads.get({ threadId: id })))?.title]))).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
        ),
      );
      const prompt = labelPrompt({
        currentTitle: job.currentTitle,
        firstPrompt: details.firstUserPrompt,
        prompts: details.userPrompts,
        output,
        running,
        board: board.slice(0, 40),
        mentionTitles,
      });
      const parsed = parseLabel(await complete(hostId, LABEL_SYSTEM, prompt, LABEL_TIMEOUT_MS));
      if (!parsed) throw new Error("reply had no usable JSON; threads keep their last label");
      const previous = all[thread.id];
      // Only a new user message, or the reply that settles it, may retitle the card; other refreshes keep the title.
      const keepTitle = previous !== undefined && Boolean(previous.category && previous.intent) && previous.titleSig === job.titleSig;
      all[thread.id] = {
        ...previous,
        titleSig: job.titleSig,
        firstSig: job.firstSig,
        category: keepTitle ? previous.category : parsed.category,
        intent: keepTitle ? previous.intent : parsed.intent,
        summarySig: job.summarySig,
        summary: parsed.summary,
        needsInput: running ? null : parsed.needsInput,
      };
      failures.delete(thread.id);
      persist();
    } catch (error) {
      logQuietly(`labeler failed${hostId ? ` on host ${hostId}` : ""}: ${errorMessage(error)}`);
      failures.set(thread.id, { at: Date.now(), sig: `${job.titleSig}|${job.summarySig}` });
    } finally {
      labelInFlight.delete(thread.id);
      changedSoon();
    }
  }

  /**
   * Returns the current label (the last one while its refresh keeps failing) and schedules a refresh when the
   * thread moved on. `all` is the record returned by `load()`.
   */
  function view(thread: LiveThread, details: ThreadDetails, running: boolean, all: Labels): LabelView {
    // A new user message may retitle the card, and so may the reply that settles it: the first title is written
    // before the agent has answered. Harness notices only refresh the summary.
    const written = details.userPrompts.filter((text) => !HARNESS_NOTICE.test(text));
    const answering = running && !HARNESS_NOTICE.test(details.lastUserPrompt ?? "");
    // Not the thread's title: it is what the board writes, so a rename would retitle the card from its own output.
    const firstSig = hashText(details.firstUserPrompt ?? thread.titleFallback ?? thread.id);
    const titleSig = `v${LABEL_PROMPT_VERSION}:${written.length}:${hashText(written.at(-1) ?? "")}:${answering ? "run" : "idle"}:${firstSig}`;
    const summaryVersion = `v${LABEL_PROMPT_VERSION}.${SUMMARY_PROMPT_VERSION}`;
    const summarySig = running
      ? `${summaryVersion}:run:${details.lastUserInputAt ?? 0}`
      : `${summaryVersion}:idle:${details.lastUserInputAt ?? 0}:${hashText(details.output ?? "")}`;
    const current = all[thread.id];
    const labeled = current?.category && current.intent ? current : undefined;
    const title = labeled ? `[${labeled.category}] ${labeled.intent}` : null;
    // A title written before the board could read the whole opening message is a guess: don't show it to the
    // labeler as the title to keep. Labels from before 0.16 carry no firstSig and never saw attached text.
    const firstChanged = labeled?.firstSig !== undefined ? labeled.firstSig !== firstSig : READ_ATTACHMENT.test(details.firstUserPrompt ?? "");
    const fresh = labeled?.titleSig === titleSig && labeled.summarySig === summarySig;
    const failure = failures.get(thread.id);
    const backingOff = failure?.sig === `${titleSig}|${summarySig}` && Date.now() - failure.at < RETRY_MS;
    const worthLabeling = running || Boolean(details.output?.trim()) || Boolean(details.lastUserPrompt);

    if (enabled && !fresh && !backingOff && worthLabeling && !labelInFlight.has(thread.id)) {
      labelInFlight.add(thread.id);
      labelQueue.push(() =>
        relabel(thread, details, running, { titleSig, summarySig, firstSig, currentTitle: firstChanged ? null : title }, all),
      );
    }

    const shown = fresh || backingOff ? labeled : undefined;
    const summary = shown?.summary ?? null;
    const needsInput = running ? null : (shown?.needsInput ?? null);
    if (current?.userTitled && thread.title) return { title: thread.title, summary, needsInput };
    if (title) syncThreadTitle(thread, title, all);
    return { title, summary, needsInput };
  }

  /**
   * Drop a deleted or archived thread's label, so the KV row (capped at 256KB) holds live threads only. An archived
   * thread the user renamed keeps its label, so their title survives a restore.
   */
  async function forget(threadId: string, keepRenamed = false) {
    failures.delete(threadId);
    const all = await load();
    if (!(threadId in all) || (keepRenamed && all[threadId].userTitled)) return;
    delete all[threadId];
    persist();
  }

  function dispose() {
    changedSoon.cancel();
    labelQueue.clear();
  }

  /** The threads that are cards on the board, as of the latest board read. */
  function setBoard(threadIds: string[]) {
    boardIds = threadIds;
  }

  return { load, view, forget, complete, dispose, setBoard };
}
