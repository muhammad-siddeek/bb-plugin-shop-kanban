import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract } from "../contract";
import { LABEL_CONCURRENCY, LABEL_PROMPT_VERSION, LABEL_RETRY_MS, LABEL_SYSTEM, hashText, labelPrompt, parseLabel } from "./labels";
import type { CardLabel, LabelView, LiveThread, ThreadDetails } from "./status";
import { safe } from "./text";
import { rows } from "./threads";

// Model-written card labels: a small model on the thread's host writes the "[category] intent" title and a
// summary of the latest interaction. Labels are stored in KV, refreshed in the background with bounded
// concurrency, and the card title is mirrored onto the bb thread title until the user renames it.

const LABELS_KEY = "labels-v2";
/** Let bb's own titler finish on brand-new threads before taking over. */
const TITLE_SETTLE_MS = 60_000;

/** `onChange` is called (debounced) whenever a label update should re-render the board. */
export function createLabeler(bb: BbPluginApi, onChange: () => void) {
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

  const host = bb.hosts.experimental_client({ contract: hostContract });
  let labels: Record<string, CardLabel> | null = null;
  let labelsWrite: Promise<void> = Promise.resolve();
  const labelQueue: Array<() => Promise<void>> = [];
  const labelInFlight = new Set<string>();
  let labelActive = 0;
  const renaming = new Set<string>();
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackHostId: string | null = null;

  async function load(): Promise<Record<string, CardLabel>> {
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

  function changedSoon() {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      onChange();
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

  /** Runs the configured labeler on the thread's host; throws when it is off or returns nothing usable. */
  async function requestLabel(
    thread: LiveThread,
    details: ThreadDetails,
    running: boolean,
    currentTitle: string | null,
    all: Record<string, CardLabel>,
  ) {
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
          currentTitle,
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
    return parsed;
  }

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
      changedSoon();
      return;
    }
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

  /**
   * Returns the current (possibly stale) label and schedules a refresh when the thread moved on.
   * `all` is the record returned by `load()`.
   */
  function view(thread: LiveThread, details: ThreadDetails, running: boolean, all: Record<string, CardLabel>): LabelView {
    const current = all[thread.id];
    const titleSig = `v${LABEL_PROMPT_VERSION}:${details.userPrompts.length}:${details.lastUserInputAt ?? 0}:${hashText(details.firstUserPrompt ?? thread.title ?? thread.id)}`;
    const summarySig = running
      ? `v${LABEL_PROMPT_VERSION}:run:${details.lastUserInputAt ?? 0}`
      : `v${LABEL_PROMPT_VERSION}:idle:${details.lastUserInputAt ?? 0}:${hashText(details.output ?? "")}`;
    const title = current?.category && current.intent ? `[${current.category}] ${current.intent}` : null;
    const fresh = current !== undefined && title !== null && current.titleSig === titleSig && current.summarySig === summarySig;
    const backingOff = current?.failedAt !== undefined && Date.now() - current.failedAt < LABEL_RETRY_MS && current.summarySig === summarySig;
    const worthLabeling = running || Boolean(details.output?.trim()) || Boolean(details.lastUserPrompt);

    if (!fresh && !backingOff && worthLabeling && !labelInFlight.has(thread.id)) {
      labelInFlight.add(thread.id);
      labelQueue.push(async () => {
        try {
          const parsed = await requestLabel(thread, details, running, title, all);
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
          changedSoon();
        }
      });
      pumpLabels();
    }

    const summary = fresh ? current.summary : null;
    const needsInput = fresh && !running ? current.needsInput : null;
    if (current?.userTitled && thread.title) return { title: thread.title, summary, needsInput };
    if (title) syncThreadTitle(thread, title, all);
    return { title, summary, needsInput };
  }

  /** Drop a deleted thread's label. */
  async function forget(threadId: string) {
    const all = await load();
    if (threadId in all) {
      delete all[threadId];
      persistLabels();
    }
  }

  function dispose() {
    clearTimeout(changedTimer);
    labelQueue.length = 0;
  }

  return { load, view, forget, dispose };
}
