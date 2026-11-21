import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { domainSchema, type Domain } from "./schema";
import type { LiveThread } from "./status";
import { errorMessage, throttledLog } from "./text";

// Domains: the title bar's tabs. A thread joins one when it is created and stays there: a child thread its parent's,
// any other the tab open at the time. The domain lives in the thread's plugin metadata, so it survives archiving and
// restoring, and leaves with the thread when it is deleted.

/** The open tab, kept on the server so threads started outside the board join the domain the user is looking at. */
const ACTIVE_KEY = "active-domain-v1";
/** Set once every thread that predates domains has one. */
const SEEDED_KEY = "domains-seeded-v1";
const METADATA_KEY = "domain";
/**
 * The labeler's record, whose `workstream` (shopify or other) split Done into work and Other before domains. Read once
 * at startup, before the labeler rewrites the record without it, to seed the threads that predate domains.
 */
const LEGACY_LABELS_KEY = "labels-v2";
/** Threads per plugin-metadata list request (bb's maximum). */
const METADATA_PAGE = 200;
const WRITE_CONCURRENCY = 8;
const LOG_REPEAT_MS = 60 * 60_000;

export function createDomains(bb: BbPluginApi, onChange: () => void) {
  /** Thread id → its domain, as stored in its metadata; threads not read yet are missing. */
  const known = new Map<string, Domain>();
  let active: Domain = "shopify";
  const loaded = bb.storage.kv
    .get<unknown>(ACTIVE_KEY)
    .then((value) => {
      const parsed = domainSchema.safeParse(value);
      if (parsed.success) active = parsed.data;
    })
    .catch((error: unknown) => bb.log.warn(`reading the open domain failed: ${errorMessage(error)}`));
  const readLegacyShopify = () =>
    bb.storage.kv.get<unknown>(LEGACY_LABELS_KEY).then(
      (raw) =>
        new Set(
          Object.entries(raw && typeof raw === "object" ? raw : {})
            .filter(([, label]) => (label as { workstream?: unknown } | null)?.workstream === "shopify")
            .map(([threadId]) => threadId),
        ),
      (error: unknown) => {
        bb.log.warn(`reading the old thread labels failed: ${errorMessage(error)}`);
        return null;
      },
    );
  let legacyShopify = readLegacyShopify();
  const logOnce = throttledLog(bb, LOG_REPEAT_MS);
  /** One assignment at a time, so overlapping board reads and new threads don't assign the same thread twice. */
  let assigning: Promise<unknown> = Promise.resolve();
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const run = assigning.then(task);
    assigning = run.catch(() => undefined);
    return run;
  }

  async function readStored(threadIds: string[]) {
    for (let start = 0; start < threadIds.length; start += METADATA_PAGE) {
      const { threads } = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: threadIds.slice(start, start + METADATA_PAGE) });
      for (const { threadId, metadata } of threads) {
        const parsed = domainSchema.safeParse(metadata[METADATA_KEY]);
        if (parsed.success) known.set(threadId, parsed.data);
      }
    }
  }

  async function store(threadId: string, domain: Domain) {
    await bb.sdk.threads.updatePluginMetadata({ threadId, set: { [METADATA_KEY]: domain } });
    known.set(threadId, domain);
  }

  /** A thread's stored domain, reading it if not known yet; undefined when it has none or the read fails. */
  async function lookup(threadId: string): Promise<Domain | undefined> {
    if (!known.has(threadId)) await readStored([threadId]).catch(() => undefined);
    return known.get(threadId);
  }

  /** Store each assignment; false when any write failed (those threads are tried again on the next pass). */
  async function storeAll(assignments: [string, Domain][]): Promise<boolean> {
    let ok = true;
    for (let start = 0; start < assignments.length; start += WRITE_CONCURRENCY) {
      await Promise.all(
        assignments.slice(start, start + WRITE_CONCURRENCY).map(([threadId, domain]) =>
          store(threadId, domain).catch((error: unknown) => {
            ok = false;
            logOnce(`storing a thread's domain failed: ${errorMessage(error)}`);
          }),
        ),
      );
    }
    return ok;
  }

  /**
   * Every open thread's domain, giving one to each thread that has none: its parent's, or the open tab's. The first
   * pass ever also covers threads from before domains: given the threads the labeler called Shopify work, `seedOther`
   * names the top-level threads that go to Other, every other one goes to Shopify, and children follow their parent.
   */
  function assign(
    threads: LiveThread[],
    seedOther: (shopifyLabeled: ReadonlySet<string>) => Promise<ReadonlySet<string>>,
  ): Promise<ReadonlyMap<string, Domain>> {
    return serially(async () => {
      await loaded;
      const open = threads.filter((thread) => thread.archivedAt === null);
      const unread = open.filter((thread) => !known.has(thread.id)).map((thread) => thread.id);
      const current = () => new Map(open.map((thread) => [thread.id, known.get(thread.id) ?? "shopify"] as const));
      try {
        if (unread.length) await readStored(unread);
      } catch (error) {
        // Assigning without knowing what is stored could overwrite a thread's domain; wait for the next pass.
        logOnce(`reading threads' domains failed: ${errorMessage(error)}`);
        return current();
      }
      const missing = open.filter((thread) => !known.has(thread.id));
      if (missing.length) {
        const seeded = (await bb.storage.kv.get<unknown>(SEEDED_KEY)) === true;
        const shopifyLabeled = seeded ? null : await legacyShopify;
        if (!seeded && !shopifyLabeled) {
          // Without the old labels, seeding would send every old thread to Other; try again on the next pass.
          legacyShopify = readLegacyShopify();
          return current();
        }
        const other = shopifyLabeled ? await seedOther(shopifyLabeled) : null;
        const byId = new Map(open.map((thread) => [thread.id, thread]));
        const decided = new Map<string, Domain>();
        const domainOf = (thread: LiveThread, seen: Set<string>): Domain => {
          const stored = known.get(thread.id) ?? decided.get(thread.id);
          if (stored) return stored;
          const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : undefined;
          seen.add(thread.id);
          const domain =
            parent && !seen.has(parent.id) ? domainOf(parent, seen) : other ? (other.has(thread.id) ? "other" : "shopify") : active;
          decided.set(thread.id, domain);
          return domain;
        };
        for (const thread of missing) domainOf(thread, new Set());
        const ok = await storeAll([...decided]);
        if (!seeded && ok) await bb.storage.kv.set(SEEDED_KEY, true);
      }
      return current();
    });
  }

  /** The domain a new thread joins: its parent's, or the open tab's. */
  async function forNewThread(parentThreadId: string | null): Promise<Domain> {
    await loaded;
    return (parentThreadId ? await lookup(parentThreadId) : undefined) ?? active;
  }

  /** Give a just-created thread its domain unless it was created with one: its parent's, or the open tab's. */
  function claim(threadId: string, parentThreadId: string | null): Promise<void> {
    return serially(async () => {
      if (!known.has(threadId)) await readStored([threadId]);
      if (!known.has(threadId)) await store(threadId, await forNewThread(parentThreadId));
    });
  }

  /** One thread's domain; Shopify while it has none yet. */
  async function of(threadId: string): Promise<Domain> {
    return (await lookup(threadId)) ?? "shopify";
  }

  /** Remember a domain just seeded into a new thread's metadata. */
  function created(threadId: string, domain: Domain) {
    known.set(threadId, domain);
  }

  async function view(): Promise<Domain> {
    await loaded;
    return active;
  }

  async function setActive(domain: Domain): Promise<{ domain: Domain }> {
    await loaded;
    if (domain !== active) {
      active = domain;
      await bb.storage.kv.set(ACTIVE_KEY, domain);
      onChange();
    }
    return { domain };
  }

  /** Forget a deleted thread. */
  function forget(threadId: string) {
    known.delete(threadId);
  }

  return { assign, claim, forNewThread, of, created, view, setActive, forget, metadataKey: METADATA_KEY };
}
