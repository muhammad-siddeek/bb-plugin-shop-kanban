import type { Forge } from "../contract";

// Forge searches the board's pull request lists share: setting lines as searches, ids, and the poll that keeps a
// list fresh.

/** Delta hosts shop/world; a Delta search that names no repository searches it. */
const DELTA_DEFAULT_REPO = "shop/world";
export const NO_HOST = "No connected persistent host to read pull requests on.";
/** Host calls end a little after the host's own 30s CLI timeout, so its clearer error wins. */
export const CALL_TIMEOUT_MS = 35_000;
/** Searches re-run once the last run is this old. */
const POLL_MS = 5 * 60_000;
/** ...or this old when a search failed (offline, no host, a CLI timeout), so the list recovers soon after. */
const RETRY_MS = 60_000;
/** A board read re-runs searches older than this, so a board on screen trails the forges by about a minute. */
const READ_FRESH_MS = 60_000;
/**
 * How often the poll checks the age of the last run. Ages are wall-clock: timers stop while the machine sleeps,
 * so a plain 5-minute interval left lists up to 5 minutes stale after waking.
 */
const POLL_TICK_MS = 30_000;

export type ForgeSearch = { line: string; forge: Forge; repo: string | null; query: string };
/** What a line's query implies unless it says otherwise: pull requests or issues, open or merged. */
export type SearchKind = { is: "pr" | "issue"; state: "open" | "merged" };

/** A multi-line setting's search lines; blank lines and `#` comments are skipped. */
export function searchLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

/**
 * A setting line as a search: `delta: <query>` or `github: <query>` in GitHub search syntax. `kind` is implied unless
 * the query names its own `is:pr`/`is:issue` or state, GitHub skips archived repositories, and a Delta line without
 * `repo:` searches shop/world. Null for any other line.
 */
export function parseSearch(line: string, kind: SearchKind): ForgeSearch | null {
  const match = line.match(/^(delta|github)\s*:\s*(\S.*)$/iu);
  if (!match || line.length > 900) return null;
  const forge: Forge = match[1].toLowerCase() === "delta" ? "delta" : "github";
  const query = match[2].trim();
  const named = query.match(/(?:^|\s)repo:(\S+)/u)?.[1] ?? null;
  const implied = [
    forge === "delta" && !named ? `repo:${DELTA_DEFAULT_REPO}` : null,
    /(?:^|\s)is:(?:pr|issue)\b/u.test(query) ? null : `is:${kind.is}`,
    /(?:^|\s)is:(?:open|closed|merged|unmerged)\b/u.test(query) ? null : `is:${kind.state}`,
    forge === "github" && !/(?:^|\s)archived:/u.test(query) ? "archived:false" : null,
  ].filter((part): part is string => part !== null);
  return { line, forge, repo: forge === "delta" ? named ?? DELTA_DEFAULT_REPO : null, query: [...implied, query].join(" ") };
}

export function prId(forge: Forge, pr: { repo: string; number: number }): string {
  return `${forge}:${pr.repo}#${pr.number}`;
}

export function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Keeps a list fresh: runs `run` `startupMs` after load, then whenever the last run is older than the poll (or the
 * retry, when `run` resolved true: a search failed in a way worth retrying soon), and on `readFresh` when it is over
 * a minute old. A refresh while one runs joins it and queues one more run. `onChange` fires as runs start and end.
 */
export function createPoller(run: () => Promise<boolean>, onChange: () => void, startupMs: number) {
  let refreshing: Promise<void> | null = null;
  let again = false;
  let retrySoon = false;
  let refreshedAt: number | null = null;
  /** An unexpected failure of the last run. */
  let error: string | null = null;
  let disposed = false;

  /** No run has finished yet, or the last one ended at least `maxAgeMs` ago (or in the future: the clock moved back). */
  function due(maxAgeMs: number): boolean {
    if (refreshedAt === null) return true;
    const age = Date.now() - refreshedAt;
    return age >= maxAgeMs || age < 0;
  }

  function refresh(): Promise<void> {
    if (refreshing) {
      again = true;
      return refreshing;
    }
    onChange();
    refreshing = run()
      .then((failed) => {
        retrySoon = failed;
        error = null;
      })
      .catch((cause) => {
        error = message(cause);
        retrySoon = true;
      })
      .finally(() => {
        refreshing = null;
        refreshedAt = Date.now();
        onChange();
        if (again && !disposed) {
          again = false;
          void refresh();
        }
      });
    return refreshing;
  }

  const startupTimer = setTimeout(() => void refresh(), startupMs);
  const pollTimer = setInterval(() => {
    if (!refreshing && due(retrySoon ? RETRY_MS : POLL_MS)) void refresh();
  }, POLL_TICK_MS);

  return {
    refresh,
    /** For board reads (opening it, the page showing again after the machine wakes, its poll): re-run stale searches. */
    readFresh() {
      if (!refreshing && due(READ_FRESH_MS)) void refresh();
    },
    get refreshing() {
      return refreshing !== null;
    },
    get refreshedAt() {
      return refreshedAt;
    },
    get error() {
      return error;
    },
    dispose() {
      disposed = true;
      clearTimeout(startupTimer);
      clearInterval(pollTimer);
    },
  };
}
