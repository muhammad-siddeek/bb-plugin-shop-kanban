import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "../contract";
import { LABEL_PROMPT_VERSION, LABEL_SYSTEM, SUMMARY_PROMPT_VERSION, hashText, labelPrompt, parseLabel } from "./labels";
import type { LabelView, LiveThread, ThreadDetails } from "./status";
import { commandMissing, connectedHostId } from "./hosts";
import { safe } from "./text";

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
});
type Labels = Record<string, z.infer<typeof cardLabelSchema>>;
/** What a queued refresh writes: the signatures it labels and the title the model is shown. */
type LabelJob = { titleSig: string; summarySig: string; currentTitle: string | null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const host = bb.hosts.experimental_client({ contract: hostContract });
  let labels: Promise<Labels> | null = null;
  let labelsWrite: Promise<void> = Promise.resolve();
  const labelQueue: Array<() => Promise<void>> = [];
  const labelInFlight = new Set<string>();
  let labelActive = 0;
  const renaming = new Set<string>();
  /**
   * Threads whose last refresh failed, with the `titleSig|summarySig` it tried. They keep showing their last label
   * and retry after RETRY_MS, or at once when the thread moves on. Kept in memory: a restart retries.
   */
  const failures = new Map<string, { at: number; sig: string }>();
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  let enabled = true;
  const loggedAt = new Map<string, number>();

  void settings.get().then((values) => (enabled = config(values).models.length > 0), () => {});
  settings.onChange((next) => {
    enabled = config(next).models.length > 0;
    // The user may have just fixed the command: retry failed threads right away.
    failures.clear();
    changedSoon();
  });

  /** Failures repeat for every thread; one line per distinct message per interval keeps the plugin log readable. */
  function logQuietly(line: string) {
    const now = Date.now();
    if (now - (loggedAt.get(line) ?? 0) < LOG_INTERVAL_MS) return;
    for (const [key, at] of loggedAt) if (now - at >= LOG_INTERVAL_MS) loggedAt.delete(key);
    loggedAt.set(line, now);
    bb.log.info(line);
  }

  /** One shared promise, so concurrent first loads mutate and persist the same record. Bad entries are dropped. */
  function load(): Promise<Labels> {
    labels ??= safe(() => bb.storage.kv.get<unknown>(LABELS_KEY)).then((raw) => {
      const all: Labels = {};
      if (!raw || typeof raw !== "object") return all;
      for (const [id, value] of Object.entries(raw)) {
        const parsed = cardLabelSchema.safeParse(value);
        if (parsed.success) all[id] = parsed.data;
      }
      return all;
    });
    return labels;
  }

  function persist() {
    labelsWrite = labelsWrite.then(async () => {
      try {
        await bb.storage.kv.set(LABELS_KEY, await load());
      } catch (error) {
        logQuietly(`saving thread labels failed: ${message(error)}`);
      }
    });
  }

  function changedSoon() {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      onChange();
    }, 400);
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
        logQuietly(`thread rename failed: ${message(error)}`);
        // Every board render would retry it; wait instead.
        setTimeout(() => renaming.delete(thread.id), RETRY_MS).unref?.();
      }
    })();
  }

  async function relabel(thread: LiveThread, details: ThreadDetails, running: boolean, job: LabelJob, all: Labels) {
    const hostId = thread.hostId ?? (await connectedHostId(bb));
    try {
      if (!hostId) throw new Error("No connected bb host to run the labeler on.");
      const categories = Array.from(new Set(Object.values(all).map((entry) => entry.category).filter(Boolean))).slice(0, 30);
      const prompt = labelPrompt({
        title: thread.title,
        currentTitle: job.currentTitle,
        firstPrompt: details.firstUserPrompt,
        lastPrompt: details.lastUserPrompt,
        prompts: details.userPrompts,
        output: details.output,
        running,
        categories,
      });
      const parsed = parseLabel(await complete(hostId, LABEL_SYSTEM, prompt, LABEL_TIMEOUT_MS));
      if (!parsed) throw new Error("reply had no usable JSON; threads keep their last label");
      const previous = all[thread.id];
      // Only a new user message may retitle the card; summary refreshes keep the title.
      const keepTitle = previous !== undefined && Boolean(previous.category && previous.intent) && previous.titleSig === job.titleSig;
      all[thread.id] = {
        ...previous,
        titleSig: job.titleSig,
        category: keepTitle ? previous.category : parsed.category,
        intent: keepTitle ? previous.intent : parsed.intent,
        summarySig: job.summarySig,
        summary: parsed.summary,
        needsInput: running ? null : parsed.needsInput,
      };
      failures.delete(thread.id);
      persist();
    } catch (error) {
      logQuietly(`labeler failed${hostId ? ` on host ${hostId}` : ""}: ${message(error)}`);
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
    const titleSig = `v${LABEL_PROMPT_VERSION}:${details.userPrompts.length}:${details.lastUserInputAt ?? 0}:${hashText(details.firstUserPrompt ?? thread.title ?? thread.id)}`;
    const summaryVersion = `v${LABEL_PROMPT_VERSION}.${SUMMARY_PROMPT_VERSION}`;
    const summarySig = running
      ? `${summaryVersion}:run:${details.lastUserInputAt ?? 0}`
      : `${summaryVersion}:idle:${details.lastUserInputAt ?? 0}:${hashText(details.output ?? "")}`;
    const current = all[thread.id];
    const labeled = current?.category && current.intent ? current : undefined;
    const title = labeled ? `[${labeled.category}] ${labeled.intent}` : null;
    const fresh = labeled?.titleSig === titleSig && labeled.summarySig === summarySig;
    const failure = failures.get(thread.id);
    const backingOff = failure?.sig === `${titleSig}|${summarySig}` && Date.now() - failure.at < RETRY_MS;
    const worthLabeling = running || Boolean(details.output?.trim()) || Boolean(details.lastUserPrompt);

    if (enabled && !fresh && !backingOff && worthLabeling && !labelInFlight.has(thread.id)) {
      labelInFlight.add(thread.id);
      labelQueue.push(() => relabel(thread, details, running, { titleSig, summarySig, currentTitle: title }, all));
      pumpLabels();
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
    clearTimeout(changedTimer);
    labelQueue.length = 0;
  }

  return { load, view, forget, complete, dispose };
}
