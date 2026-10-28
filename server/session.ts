import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, piSessionIdInput, sessionIdInput } from "../contract";
import type { BoardSession } from "./schema";
import { isRunningSelf, type LiveThread } from "./status";
import { safe } from "./text";
import type { ProviderSessions, ThreadReader } from "./threads";

// Per-card session facts for the harness popover: the thread's current model, thinking level,
// service tier and access, how full its context window is, and what the card's whole tree has spent.
//
// The tree is the thread, every descendant bb thread (hidden and archived ones included), and each
// thread's harness subagents. omp reports only its own replies plus its direct `task` children, and Pi
// reports nothing, so omp and Pi threads are read from their transcripts on the thread's host instead
// (omp's subagents at every depth included). Other harnesses count as bb reports them.

/** Refresh cadence: running threads spend tokens mid-turn without bumping `updatedAt`. */
const RUNNING_REFRESH_MS = 5_000;
const IDLE_REFRESH_MS = 60_000;
/** Model catalogs barely change; a cold provider can answer with no models, so retry those sooner. */
const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_RETRY_MS = 15_000;

type SpendMethod = "omp_spend" | "pi_spend";
type Spender = { method: SpendMethod; sessionId: typeof sessionIdInput };
/** Harnesses whose spend is read from transcripts, by provider id: the host method and the session ids it takes. */
const TRANSCRIPT_SPENDERS: Record<string, Spender> = {
  "acp-omp": { method: "omp_spend", sessionId: sessionIdInput },
  pi: { method: "pi_spend", sessionId: piSessionIdInput },
};
/** The host's spend methods take at most this many session ids per call. */
const SESSIONS_PAGE = 500;
/**
 * A wedged host would otherwise hold the tree cost for the SDK's 30s default. A host's first call scans its whole
 * transcript history for the estimate rates (seconds); a call cut short still finishes that scan for the next one.
 */
const SPEND_CALL_TIMEOUT_MS = 15_000;

const ACCESS_LABELS: Record<string, string> = { full: "Full access", auto: "Auto", "accept-edits": "Accept edits" };

type Options = { model: string; reasoningLevel: string; serviceTier: string; permissionMode: string };
type Cost = { amount: number; currency: string };
type Usage = { usedTokens: number; contextWindow: number; estimated: boolean };
type Raw = { options: Options | null; usage: Usage | null };

type Catalog = {
  models: Map<string, { name: string; efforts: Map<string, string> }>;
  reasoningLevels: Map<string, string>;
  serviceTiers: Map<string, string>;
};

type Entry<T> = { key: unknown; at: number; value: T | null; pending: Promise<T | null> | null };
/**
 * What a card's tree spent; `estimated` is the part of `cost` priced from other replies' rates (see the host's
 * spend reader), `threads` counts the threads whose spend is in `cost`, the card's own included.
 */
type TreeCost = { cost: Cost | null; estimated: number; threads: number };
/** One harness session's transcript spend, in USD. */
type SessionSpend = { amount: number; estimated: number };
/**
 * One tree thread's reported spend and harness session ids. `key` is the `updatedAt` it was read at; undefined
 * after a failed read so the next refresh reads again.
 */
type ThreadSpend = { key: number | null | undefined; reported: Cost | null; sessions: ProviderSessions | null };
type TreeThread = { thread: LiveThread; spender: Spender | null; spend: ThreadSpend };

function labelMap(list: ReadonlyArray<{ id: string; label?: string }> | null | undefined): Map<string, string> {
  return new Map((list ?? []).filter((entry) => entry.label).map((entry) => [entry.id, entry.label!]));
}

export function createSessionInfo(bb: BbPluginApi, reader: ThreadReader) {
  const threads = new Map<string, Entry<Raw>>();
  const catalogs = new Map<string, Entry<Catalog>>();
  const trees = new Map<string, Entry<TreeCost>>();
  /** Thread ids in each card's tree, as last listed; keeps `spends` of archived descendants across board refreshes. */
  const treeIds = new Map<string, string[]>();
  const spends = new Map<string, ThreadSpend>();
  const host = bb.hosts.experimental_client({ contract: hostContract });

  /**
   * Stale-while-revalidate: only the very first read for a key waits on the fetch. A failed fetch (null or thrown)
   * keeps the last value.
   */
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
      entry.pending = fetch()
        .catch(() => null)
        .then((value) => {
          entry.value = value ?? entry.value;
          entry.at = Date.now();
          entry.pending = null;
          return entry.value;
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
      usage: usage ? { usedTokens: usage.usedTokens, contextWindow: usage.modelContextWindow, estimated: usage.estimated } : null,
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
    // A catalog that never loaded is retried on the shorter cadence.
    const maxAge = entry && entry.at > 0 && entry.value === null ? CATALOG_RETRY_MS : CATALOG_TTL_MS;
    // Never block the board on a catalog load: it can spawn the provider. Labels fill in on a later poll.
    return cached(catalogs, id, null, maxAge, () => fetchCatalog(providerId, hostId), false);
  }

  async function threadSpend(thread: LiveThread, spender: Spender | null): Promise<ThreadSpend> {
    const known = spends.get(thread.id);
    if (known && known.key === thread.updatedAt && !isRunningSelf(thread)) return known;
    const [context, sessions] = await Promise.all([
      safe(() => bb.sdk.threads.context({ threadId: thread.id })),
      spender ? reader.providerSessions(thread.id, known?.sessions ?? null) : null,
    ]);
    const spend: ThreadSpend = {
      key: context === null || (spender && sessions === null) ? undefined : thread.updatedAt,
      reported: context?.usage?.cost ?? known?.reported ?? null,
      sessions: sessions ?? known?.sessions ?? null,
    };
    spends.set(thread.id, spend);
    return spend;
  }

  /**
   * Spend per harness session (keyed `method:id`), from the transcripts on each thread's host; omp's include its
   * subagents. A call to a disconnected host would wait out the SDK's 30s timeout, so its threads are skipped and
   * count what bb reports; every host is tried when the host list can't be read.
   */
  async function transcriptSpends(tree: readonly TreeThread[]): Promise<Map<string, SessionSpend>> {
    const hosts = await safe(() => bb.sdk.hosts.list());
    const offline = new Set(hosts?.flatMap((entry) => (entry.status === "connected" ? [] : [entry.id])));
    const groups = new Map<string, { method: SpendMethod; hostId: string; ids: Set<string> }>();
    for (const { thread, spender, spend } of tree) {
      if (!spender || !thread.hostId || offline.has(thread.hostId)) continue;
      const key = `${spender.method}:${thread.hostId}`;
      const group = groups.get(key) ?? { method: spender.method, hostId: thread.hostId, ids: new Set<string>() };
      for (const id of spend.sessions?.ids ?? []) if (spender.sessionId.safeParse(id).success) group.ids.add(id);
      groups.set(key, group);
    }
    const bySession = new Map<string, SessionSpend>();
    for (const { method, hostId, ids } of groups.values()) {
      const list = [...ids];
      for (let start = 0; start < list.length; start += SESSIONS_PAGE) {
        const sessionIds = list.slice(start, start + SESSIONS_PAGE);
        // A failed call or a missing harness finds nothing: those threads count what bb reports.
        const result = await safe(() => host.call(method, { sessionIds }, { hostId, timeoutMs: SPEND_CALL_TIMEOUT_MS }));
        for (const [id, spend] of Object.entries(result?.spends ?? {})) bySession.set(`${method}:${id}`, spend);
      }
    }
    return bySession;
  }

  /**
   * The card's tree spend. Each omp or Pi thread counts what its transcripts hold, or what bb reports when none of
   * its sessions has one on its host (a disconnected host, a transcript `omp gc` removed). Spend in another
   * currency than the first one found is left out.
   */
  async function fetchTreeCost(card: LiveThread): Promise<TreeCost | null> {
    const descendants = await reader.listDescendants(card.id, true);
    if (descendants === null) return null;
    treeIds.set(card.id, [card.id, ...descendants.map((thread) => thread.id)]);
    // One thread at a time: a tree can hold hundreds of threads, and nothing waits on this.
    const tree: TreeThread[] = [];
    for (const thread of [card, ...descendants]) {
      const provider = thread.providerId ?? "";
      const spender = Object.hasOwn(TRANSCRIPT_SPENDERS, provider) ? TRANSCRIPT_SPENDERS[provider] : null;
      tree.push({ thread, spender, spend: await threadSpend(thread, spender) });
    }
    const bySession = await transcriptSpends(tree);

    let currency: string | null = null;
    let amount = 0;
    let estimated = 0;
    let threads = 0;
    for (const { spender, spend } of tree) {
      const found = spender ? (spend.sessions?.ids ?? []).flatMap((id) => bySession.get(`${spender.method}:${id}`) ?? []) : [];
      const spent: (SessionSpend & Cost) | null =
        found.length > 0
          ? {
              amount: found.reduce((sum, add) => sum + add.amount, 0),
              estimated: found.reduce((sum, add) => sum + add.estimated, 0),
              // omp and Pi price transcripts in USD.
              currency: "USD",
            }
          : spend.reported && { ...spend.reported, estimated: 0 };
      if (!spent || (currency !== null && spent.currency !== currency)) continue;
      currency = spent.currency;
      amount += spent.amount;
      estimated += spent.estimated;
      threads += 1;
    }
    return { cost: currency === null ? null : { amount, currency }, estimated, threads };
  }

  /**
   * Session facts for a card, or null when bb has recorded neither options nor usage yet and the tree has spent
   * nothing. `descendants` are the live ones on the board, for the refresh cadence; the tree cost reads archived
   * ones too. The tree cost never holds up the board: it shows up on a later poll.
   */
  async function sessionFor(thread: LiveThread, descendants: readonly LiveThread[]): Promise<BoardSession | null> {
    const running = isRunningSelf(thread);
    const treeRunning = running || descendants.some(isRunningSelf);
    const treeKey = Math.max(thread.updatedAt ?? 0, ...descendants.map((entry) => entry.updatedAt ?? 0));
    const [raw, catalog, tree] = await Promise.all([
      cached(threads, thread.id, thread.updatedAt, running ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS, () => fetchRaw(thread.id), true),
      thread.providerId ? catalogFor(thread.providerId, thread.hostId) : null,
      cached(trees, thread.id, treeKey, treeRunning ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS, () => fetchTreeCost(thread), false),
    ]);
    if (!raw?.options && !raw?.usage && !tree?.cost) return null;
    const options = raw?.options ?? null;
    const usage = raw?.usage ?? null;
    const model = options ? catalog?.models.get(options.model) : undefined;
    const level = options?.reasoningLevel ?? null;
    const tier = options?.serviceTier ?? null;
    return {
      modelId: options?.model ?? null,
      model: model?.name ?? options?.model ?? null,
      reasoning: level === null ? null : model?.efforts.get(level) ?? catalog?.reasoningLevels.get(level) ?? level,
      serviceTier: tier === null || tier === "default" ? null : catalog?.serviceTiers.get(tier) ?? tier,
      access: options ? ACCESS_LABELS[options.permissionMode] ?? options.permissionMode : null,
      cost: tree?.cost ?? null,
      costEstimated: tree?.estimated ?? 0,
      costThreads: tree?.threads ?? 0,
      usedTokens: usage?.usedTokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      estimated: usage?.estimated ?? false,
    };
  }

  /** Drop cached facts for threads that left the board, and spend reads no remaining card's tree holds. */
  function retain(ids: ReadonlySet<string>) {
    for (const id of threads.keys()) if (!ids.has(id)) threads.delete(id);
    for (const id of trees.keys()) if (!ids.has(id)) trees.delete(id);
    for (const id of treeIds.keys()) if (!ids.has(id)) treeIds.delete(id);
    const held = new Set([...treeIds.values()].flat());
    for (const id of spends.keys()) if (!held.has(id)) spends.delete(id);
  }

  return { sessionFor, retain };
}
