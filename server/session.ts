import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoardSession } from "./schema";
import type { LiveThread } from "./status";
import { safe } from "./text";

// Per-card session facts for the harness popover: the thread's current model, thinking level,
// service tier and access, plus what the session has spent and how full its context window is.

/** Refresh cadence: running threads spend tokens mid-turn without bumping `updatedAt`. */
const RUNNING_REFRESH_MS = 5_000;
const IDLE_REFRESH_MS = 60_000;
/** Model catalogs barely change; a cold provider can answer with no models, so retry those sooner. */
const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_RETRY_MS = 15_000;

const ACCESS_LABELS: Record<string, string> = { full: "Full access", auto: "Auto", "accept-edits": "Accept edits" };

type Options = { model: string; reasoningLevel: string; serviceTier: string; permissionMode: string };
type Usage = { cost: { amount: number; currency: string } | null; usedTokens: number; contextWindow: number; estimated: boolean };
type Raw = { options: Options | null; usage: Usage | null };

type Catalog = {
  models: Map<string, { name: string; efforts: Map<string, string> }>;
  reasoningLevels: Map<string, string>;
  serviceTiers: Map<string, string>;
};

type Entry<T> = { key: unknown; at: number; value: T | null; pending: Promise<T | null> | null };

function labelMap(list: ReadonlyArray<{ id: string; label?: string }> | null | undefined): Map<string, string> {
  return new Map((list ?? []).filter((entry) => entry.label).map((entry) => [entry.id, entry.label!]));
}

export function createSessionInfo(bb: BbPluginApi) {
  const threads = new Map<string, Entry<Raw>>();
  const catalogs = new Map<string, Entry<Catalog>>();

  /** Stale-while-revalidate: only the very first read for a key waits on the fetch. */
  async function cached<T>(
    store: Map<string, Entry<T>>,
    id: string,
    key: unknown,
    maxAgeMs: number,
    fetch: () => Promise<T | null>,
    wait: boolean,
  ): Promise<T | null> {
    const entry: Entry<T> = store.get(id) ?? { key, at: 0, value: null, pending: null };
    store.set(id, entry);
    const stale = entry.key !== key || Date.now() - entry.at > maxAgeMs;
    if (stale && !entry.pending) {
      entry.key = key;
      entry.pending = fetch().then((value) => {
        entry.value = value;
        entry.at = Date.now();
        entry.pending = null;
        return value;
      });
    }
    return entry.at === 0 && entry.pending && wait ? entry.pending : entry.value;
  }

  async function fetchRaw(threadId: string): Promise<Raw> {
    const [options, context] = await Promise.all([
      safe(() => bb.sdk.threads.defaultExecutionOptions({ threadId })),
      safe(() => bb.sdk.threads.context({ threadId })),
    ]);
    const usage = context?.usage ?? null;
    return {
      options: options
        ? { model: options.model, reasoningLevel: options.reasoningLevel, serviceTier: options.serviceTier, permissionMode: options.permissionMode }
        : null,
      usage: usage
        ? { cost: usage.cost ?? null, usedTokens: usage.usedTokens, contextWindow: usage.modelContextWindow, estimated: usage.estimated }
        : null,
    };
  }

  async function fetchCatalog(providerId: string, hostId: string | null): Promise<Catalog | null> {
    const result = await safe(() => bb.sdk.providers.models(hostId ? { providerId, hostId } : { providerId }));
    if (!result || result.models.length === 0) return null;
    const provider = result.providers.find((entry) => entry.id === providerId);
    return {
      models: new Map(
        result.models.map((model) => [
          model.model,
          {
            name: model.displayName,
            efforts: labelMap(model.supportedReasoningEfforts.map((effort) => ({ id: effort.reasoningEffort, label: effort.label }))),
          },
        ]),
      ),
      reasoningLevels: labelMap(provider?.reasoningLevels),
      serviceTiers: labelMap(provider?.serviceTiers),
    };
  }

  async function catalogFor(providerId: string, hostId: string | null): Promise<Catalog | null> {
    const id = `${providerId}:${hostId ?? ""}`;
    const entry = catalogs.get(id);
    // A failed load leaves `value` null; retry it on the shorter cadence.
    const maxAge = entry && entry.at > 0 && entry.value === null ? CATALOG_RETRY_MS : CATALOG_TTL_MS;
    // Never block the board on a catalog load: it can spawn the provider. Labels fill in on a later poll.
    return cached(catalogs, id, null, maxAge, () => fetchCatalog(providerId, hostId), false);
  }

  /** Session facts for a card, or null when bb has recorded neither options nor usage yet. */
  async function sessionFor(thread: LiveThread, running: boolean): Promise<BoardSession | null> {
    const [raw, catalog] = await Promise.all([
      cached(threads, thread.id, thread.updatedAt, running ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS, () => fetchRaw(thread.id), true),
      thread.providerId ? catalogFor(thread.providerId, thread.hostId) : null,
    ]);
    if (!raw || (!raw.options && !raw.usage)) return null;
    const { options, usage } = raw;
    const model = options ? catalog?.models.get(options.model) : undefined;
    const level = options?.reasoningLevel ?? null;
    const tier = options?.serviceTier ?? null;
    return {
      modelId: options?.model ?? null,
      model: model?.name ?? options?.model ?? null,
      reasoning: level === null ? null : model?.efforts.get(level) ?? catalog?.reasoningLevels.get(level) ?? level,
      serviceTier: tier === null || tier === "default" ? null : catalog?.serviceTiers.get(tier) ?? tier,
      access: options ? ACCESS_LABELS[options.permissionMode] ?? options.permissionMode : null,
      cost: usage?.cost ?? null,
      usedTokens: usage?.usedTokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      estimated: usage?.estimated ?? false,
    };
  }

  /** Drop cached facts for threads that left the board. */
  function retain(ids: ReadonlySet<string>) {
    for (const id of threads.keys()) if (!ids.has(id)) threads.delete(id);
  }

  return { sessionFor, retain };
}
