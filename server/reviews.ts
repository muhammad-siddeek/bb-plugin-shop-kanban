import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, type Forge, type ForgePr, type ForgePrDetail } from "../contract";
import { indexHostId } from "./hosts";
import { hashText } from "./labels";
import { REVIEW_SUMMARY_VERSION, REVIEW_SYSTEM, draftPrompt, parseReviewSummary, reviewPrompt } from "./review-prompt";
import { reviewScopeSchema, type ReviewCard, type ReviewRisk, type ReviewScope, type ReviewSource, type ReviewState } from "./schema";
import { safe } from "./text";

// Review queue: open pull requests waiting on the user's review, read through the forge CLIs (`dt`, `gh`) on the
// user's persistent host and listed at the top of the board's Queue column. The searches come from settings, so
// each user gets their own and their teams' requests; pull requests they already reviewed drop off. The labeler
// model writes each one a "[risk] what, why" first read, cached per head commit. Read, archived and reviewed
// marks and the summaries live in KV.

export const REVIEWS_CHANGED = "reviews-changed";
const MARKS_KEY = "reviews-v1";
const POLL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 8_000;
/** Newest pull requests read per search. */
const SEARCH_LIMIT = 30;
/** The user's own reviews among a search's matches, subtracted from it. */
const REVIEWED_LIMIT = 100;
const QUERY_MAX = 900;
const DETAIL_CONCURRENCY = 3;
const SUMMARY_CONCURRENCY = 2;
const SUMMARY_TIMEOUT_MS = 20_000;
const SUMMARY_RETRY_MS = 10 * 60_000;
/** Read, archived, reviewed and summary entries kept per kind, newest first. */
const MARKS_MAX = 1_000;
/** Delta hosts shop/world; a Delta search that names no repository searches it. */
const DELTA_DEFAULT_REPO = "shop/world";
const NO_HOST = "No connected persistent host to read pull requests on.";
const INVALID_LINE = "Start the line with delta: or github:";

/**
 * Delta's `review-requested:@me` is requests of the user by name only. GitHub's also matches their teams'
 * requests; its `user-review-requested:@me` is the by-name half.
 */
const DEFAULT_SEARCHES: Record<ReviewScope, string> = {
  me: ["delta: review-requested:@me -author:@me -is:draft", "github: user-review-requested:@me -author:@me -is:draft"].join("\n"),
  team: [
    "delta: team-review-requested:@me -author:@me -is:draft",
    "github: review-requested:@me -user-review-requested:@me -author:@me -is:draft",
  ].join("\n"),
};
const LINE_SYNTAX =
  "One search per line: `delta: <query>` reads Delta through `dt` (shop/world unless the query names a `repo:`), `github: <query>` reads GitHub through `gh`. GitHub search syntax with `is:pr is:open` implied; pull requests you already reviewed drop off until new commits land.";

type Labeler = { complete(hostId: string, system: string, prompt: string, timeoutMs: number): Promise<string> };
type Search = { line: string; scope: ReviewScope; forge: Forge; repo: string | null; query: string };
type SearchResult = { prs: ForgePr[]; total: number; error: string | null; missing: boolean };
/**
 * A listed pull request, the search lines that found it, whether one's `reviewed-by:@me` lists it, and its scope:
 * Me when any search for the user found it.
 */
type Entry = ForgePr & { id: string; forge: Forge; lines: string[]; reviewed: boolean; scope: ReviewScope };
type Summary = { sig: string; risk: ReviewRisk | null; text: string | null; at: number; failedAt?: number };
type Marks = {
  /** Head commit when last opened from the board; null when it was opened before its head was read. */
  read: Record<string, { sha: string | null; at: number }>;
  archived: Record<string, number>;
  /** Reviewed from the board, at that head commit: hidden at once, before the forge's search and reviews list it. */
  reviewed: Record<string, { sha: string | null; at: number }>;
  summaries: Record<string, Summary>;
};

/**
 * Setting lines as searches: `delta: <query>` or `github: <query>` in GitHub search syntax. `is:pr is:open` is
 * implied, GitHub skips archived repositories, and a Delta line without `repo:` searches shop/world. Blank lines
 * and `#` comments are skipped; anything else is returned as invalid.
 */
function parseSearches(value: string, scope: ReviewScope): { searches: Search[]; invalid: string[] } {
  const searches: Search[] = [];
  const invalid: string[] = [];
  for (const raw of value.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(delta|github)\s*:\s*(\S.*)$/iu);
    if (!match || line.length > QUERY_MAX) {
      invalid.push(line);
      continue;
    }
    const forge = match[1].toLowerCase() as Forge;
    const query = match[2].trim();
    const named = query.match(/(?:^|\s)repo:(\S+)/u)?.[1] ?? null;
    const implied = [
      forge === "delta" && !named ? `repo:${DELTA_DEFAULT_REPO}` : null,
      /(?:^|\s)is:pr\b/u.test(query) ? null : "is:pr",
      /(?:^|\s)is:(?:open|closed|merged|unmerged)\b/u.test(query) ? null : "is:open",
      forge === "github" && !/(?:^|\s)archived:/u.test(query) ? "archived:false" : null,
    ].filter((part): part is string => part !== null);
    searches.push({
      line,
      scope,
      forge,
      repo: forge === "delta" ? named ?? DELTA_DEFAULT_REPO : null,
      query: [...implied, query].join(" "),
    });
  }
  return { searches, invalid };
}

type SearchSettings = { reviewSearchesMe: string; reviewSearchesTeam: string };
const SETTING_KEY: Record<ReviewScope, keyof SearchSettings> = { me: "reviewSearchesMe", team: "reviewSearchesTeam" };

/** Both settings' lines as searches, Me first, and the scopes that have any line. */
function configuredSearches(values: SearchSettings) {
  const searches: Search[] = [];
  const invalid: { line: string; scope: ReviewScope }[] = [];
  const scopes: ReviewScope[] = [];
  for (const scope of reviewScopeSchema.options) {
    const parsed = parseSearches(values[SETTING_KEY[scope]], scope);
    searches.push(...parsed.searches);
    invalid.push(...parsed.invalid.map((line) => ({ line, scope })));
    if (parsed.searches.length + parsed.invalid.length > 0) scopes.push(scope);
  }
  return { searches, invalid, scopes };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The newest `MARKS_MAX` entries of a mark record. */
function capped<T>(record: Record<string, T>, at: (value: T) => number): Record<string, T> {
  const rows = Object.entries(record);
  if (rows.length <= MARKS_MAX) return record;
  return Object.fromEntries(rows.sort((a, b) => at(b[1]) - at(a[1])).slice(0, MARKS_MAX));
}

export function createReviewQueue(bb: BbPluginApi, labeler: Labeler) {
  const settings = bb.settings.define({
    reviewSearchesMe: {
      type: "string",
      label: "Review queue: requested of you",
      description: `Open pull requests asking for your review by name, under Me in the board's Reviews section. ${LINE_SYNTAX} Delta's \`review-requested:@me\` and GitHub's \`user-review-requested:@me\` leave out your teams' requests. Leave empty to hide Me.`,
      default: DEFAULT_SEARCHES.me,
      experimental_multiline: true,
    },
    reviewSearchesTeam: {
      type: "string",
      label: "Review queue: requested of your teams",
      description: `Open pull requests asking your teams for review, under Team in the board's Reviews section; one a search for you also finds is listed under Me only. ${LINE_SYNTAX} Delta's \`team-review-requested:@me\` matches every team you are on; on GitHub, \`review-requested:@me -user-review-requested:@me\` does. For one team, Delta takes the team slug (\`team-review-requested:exp\`) and GitHub \`team-review-requested:<org>/<team>\`. Leave empty to hide Team.`,
      default: DEFAULT_SEARCHES.team,
      experimental_multiline: true,
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });

  let marksLoad: Promise<Marks> | null = null;
  let marksWrite: Promise<unknown> = Promise.resolve();
  let entries: Entry[] = [];
  let sources: ReviewSource[] = [];
  let error: string | null = null;
  let refreshedAt: number | null = null;
  let refreshing: Promise<void> | null = null;
  let refreshAgain = false;
  let hostId: string | null = null;
  let disposed = false;
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Details per pull request, keyed by the `updatedAt` they were read at, and when that read started. */
  const details = new Map<string, { updatedAt: string; detail: ForgePrDetail; at: number }>();
  const detailQueue: Entry[] = [];
  const detailPending = new Set<string>();
  let detailActive = 0;
  const summaryQueue: Entry[] = [];
  const summaryPending = new Set<string>();
  let summaryActive = 0;

  function load(): Promise<Marks> {
    marksLoad ??= (async () => {
      const raw = await safe(async () => bb.storage.kv.get<Partial<Marks>>(MARKS_KEY));
      return { read: raw?.read ?? {}, archived: raw?.archived ?? {}, reviewed: raw?.reviewed ?? {}, summaries: raw?.summaries ?? {} };
    })();
    return marksLoad;
  }

  function persist(marks: Marks) {
    marks.read = capped(marks.read, (mark) => mark.at);
    marks.archived = capped(marks.archived, (at) => at);
    marks.reviewed = capped(marks.reviewed, (mark) => mark.at);
    marks.summaries = capped(marks.summaries, (summary) => summary.at);
    marksWrite = marksWrite.then(() => safe(async () => bb.storage.kv.set(MARKS_KEY, marks)));
  }

  function changed() {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      bb.realtime.publish(REVIEWS_CHANGED, { at: Date.now() });
    }, 300);
  }

  /**
   * Hidden when archived, or while its head is the commit the user last reviewed; new commits bring it back
   * with `reviewedSha` set. The board's own review mark wins over details read before it.
   */
  function reviewState(entry: Entry, marks: Marks): { hidden: boolean; reviewedSha: string | null } {
    if (entry.id in marks.archived) return { hidden: true, reviewedSha: null };
    const known = details.get(entry.id);
    const mark = marks.reviewed[entry.id];
    const reviewedSha = mark && (!known || mark.at > known.at) ? mark.sha : (known?.detail.reviewedSha ?? null);
    // Reviewed at a commit not known yet: hidden until the details name it.
    if (reviewedSha === null) return { hidden: entry.reviewed || mark !== undefined, reviewedSha: null };
    const head = known?.detail.headSha ?? entry.headSha;
    return { hidden: head === null || head === reviewedSha, reviewedSha };
  }

  function summarySig(entry: Entry, detail: ForgePrDetail): string {
    return `v${REVIEW_SUMMARY_VERSION}:${detail.headSha ?? entry.updatedAt}:${hashText(entry.title)}`;
  }

  async function callSearch(target: string, input: { forge: Forge; repo: string | null; query: string; limit: number }): Promise<SearchResult> {
    try {
      return await host.call("pr_search", input, { hostId: target });
    } catch (cause) {
      return { prs: [], total: 0, error: message(cause), missing: false };
    }
  }

  async function runRefresh() {
    changed();
    const { searches, invalid } = configuredSearches(await settings.get());
    const invalidSources = invalid.map(({ line, scope }) => ({ search: line, scope, count: 0, total: 0, error: INVALID_LINE, missing: false }));
    if (searches.length === 0) {
      entries = [];
      sources = invalidSources;
      error = null;
      return;
    }
    hostId = await indexHostId(bb, hostId);
    const target = hostId;
    if (!target) {
      error = NO_HOST;
      return;
    }
    const results = await Promise.all(
      searches.map(async (search) => {
        const input = { forge: search.forge, repo: search.repo, query: search.query, limit: SEARCH_LIMIT };
        const [open, reviewed] = await Promise.all([
          callSearch(target, input),
          callSearch(target, { ...input, query: `${search.query} reviewed-by:@me`, limit: REVIEWED_LIMIT }),
        ]);
        return { search, open, reviewed };
      }),
    );
    const marks = await load();
    const previous = entries;
    const next = new Map<string, Entry>();
    const nextSources: ReviewSource[] = [];
    for (const { search, open, reviewed } of results) {
      if (open.error !== null) {
        // Keep what this search listed last time instead of flickering it away on a transient failure.
        for (const entry of previous) {
          if (!entry.lines.includes(search.line)) continue;
          const existing = next.get(entry.id);
          if (!existing) next.set(entry.id, entry);
          else if (search.scope === "me") existing.scope = "me";
        }
        nextSources.push({ search: search.line, scope: search.scope, count: 0, total: 0, error: open.error, missing: open.missing });
        continue;
      }
      const done = new Set(reviewed.prs.map((pr) => `${search.forge}:${pr.repo}#${pr.number}`));
      for (const pr of open.prs) {
        const id = `${search.forge}:${pr.repo}#${pr.number}`;
        const existing = next.get(id);
        if (existing) {
          if (!existing.lines.includes(search.line)) existing.lines.push(search.line);
          existing.reviewed ||= done.has(id);
          if (search.scope === "me") existing.scope = "me";
        } else {
          next.set(id, { ...pr, id, forge: search.forge, lines: [search.line], reviewed: done.has(id), scope: search.scope });
        }
      }
      nextSources.push({ search: search.line, scope: search.scope, count: open.prs.length, total: open.total, error: reviewed.error, missing: false });
    }
    entries = [...next.values()].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    sources = [...nextSources, ...invalidSources];
    error = null;
    for (const id of details.keys()) if (!next.has(id)) details.delete(id);
    for (const entry of entries) {
      // Reviewed ones too: their details say whether commits landed after the user's review.
      if (entry.id in marks.archived) continue;
      if (details.get(entry.id)?.updatedAt === entry.updatedAt) queueSummary(entry, marks);
      else if (!detailPending.has(entry.id)) {
        detailPending.add(entry.id);
        detailQueue.push(entry);
      }
    }
    pumpDetails();
  }

  /** Re-reads every search; a call while one runs joins it and queues one more run. */
  function refresh(): Promise<void> {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = runRefresh()
      .catch((cause) => {
        error = message(cause);
      })
      .finally(() => {
        refreshing = null;
        refreshedAt = Date.now();
        changed();
        if (refreshAgain && !disposed) {
          refreshAgain = false;
          void refresh();
        }
      });
    return refreshing;
  }

  function pumpDetails() {
    while (!disposed && detailActive < DETAIL_CONCURRENCY && detailQueue.length > 0) {
      const entry = detailQueue.shift()!;
      detailActive += 1;
      void readDetail(entry).finally(() => {
        detailActive -= 1;
        detailPending.delete(entry.id);
        changed();
        pumpDetails();
      });
    }
  }

  async function readDetail(entry: Entry) {
    const target = hostId;
    if (!target) return;
    const at = Date.now();
    const result = await host
      .call("pr_detail", { forge: entry.forge, repo: entry.repo, number: entry.number }, { hostId: target })
      .catch((cause: unknown) => ({ detail: null, error: message(cause) }));
    if (!result.detail) {
      bb.log.info(`review details failed for ${entry.id}: ${result.error}`);
      return;
    }
    details.set(entry.id, { updatedAt: entry.updatedAt, detail: result.detail, at });
    const marks = await load();
    // Opened before its head was known: that head is the one the user saw.
    const read = marks.read[entry.id];
    if (read && read.sha === null && result.detail.headSha) {
      marks.read[entry.id] = { ...read, sha: result.detail.headSha };
      persist(marks);
    }
    queueSummary(entry, marks);
  }

  function queueSummary(entry: Entry, marks: Marks) {
    const known = details.get(entry.id);
    // Hidden ones wait: a reviewed pull request gets its model read only once new commits bring it back.
    if (!known || summaryPending.has(entry.id) || reviewState(entry, marks).hidden) return;
    const current = marks.summaries[entry.id];
    const backingOff = current?.failedAt !== undefined && Date.now() - current.failedAt < SUMMARY_RETRY_MS;
    if (current?.sig === summarySig(entry, known.detail) && (current.failedAt === undefined || backingOff)) return;
    summaryPending.add(entry.id);
    summaryQueue.push(entry);
    pumpSummaries();
  }

  function pumpSummaries() {
    while (!disposed && summaryActive < SUMMARY_CONCURRENCY && summaryQueue.length > 0) {
      const entry = summaryQueue.shift()!;
      summaryActive += 1;
      void summarize(entry).finally(() => {
        summaryActive -= 1;
        summaryPending.delete(entry.id);
        changed();
        pumpSummaries();
      });
    }
  }

  async function summarize(entry: Entry) {
    const target = hostId;
    const known = details.get(entry.id);
    if (!target || !known) return;
    const marks = await load();
    const sig = summarySig(entry, known.detail);
    const previous = marks.summaries[entry.id];
    try {
      const parsed = parseReviewSummary(await labeler.complete(target, REVIEW_SYSTEM, reviewPrompt(entry, known.detail), SUMMARY_TIMEOUT_MS));
      if (!parsed) throw new Error("The model returned no usable JSON.");
      marks.summaries[entry.id] = { sig, risk: parsed.risk, text: parsed.text, at: Date.now() };
    } catch (cause) {
      bb.log.info(`review summary failed for ${entry.id}: ${message(cause)}`);
      // The last head's summary stays on the card until this one succeeds.
      marks.summaries[entry.id] = { sig, risk: previous?.risk ?? null, text: previous?.text ?? null, at: Date.now(), failedAt: Date.now() };
    }
    persist(marks);
  }

  function card(entry: Entry, marks: Marks, reviewedSha: string | null): ReviewCard {
    const detail = details.get(entry.id)?.detail ?? null;
    const sha = detail?.headSha ?? entry.headSha;
    const read = marks.read[entry.id];
    const summary = marks.summaries[entry.id];
    return {
      id: entry.id,
      forge: entry.forge,
      repo: entry.repo,
      number: entry.number,
      url: entry.url,
      title: entry.title,
      author: entry.author,
      bot: entry.bot,
      draft: entry.draft,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      additions: detail?.additions ?? null,
      deletions: detail?.deletions ?? null,
      changedFiles: detail?.changedFiles ?? null,
      risk: summary?.risk ?? null,
      summary: summary?.text ?? null,
      summarizing: summaryPending.has(entry.id) || (detailPending.has(entry.id) && !summary?.text),
      unread: !read || (read.sha !== null && sha !== null && read.sha !== sha),
      rereview: reviewedSha !== null,
      scope: entry.scope,
    };
  }

  async function list(): Promise<ReviewState> {
    const [marks, values] = await Promise.all([load(), settings.get()]);
    // The first board read starts the first search instead of waiting for the startup timer.
    if (refreshedAt === null && !refreshing) void refresh();
    return {
      scopes: configuredSearches(values).scopes,
      reviews: entries.flatMap((entry) => {
        const state = reviewState(entry, marks);
        return state.hidden ? [] : [card(entry, marks, state.reviewedSha)];
      }),
      sources,
      refreshing: refreshing !== null,
      refreshedAt,
      error,
    };
  }

  function find(id: string): Entry {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error("That pull request is no longer in the review queue.");
    return entry;
  }

  async function markRead(id: string) {
    const entry = find(id);
    const marks = await load();
    marks.read[id] = { sha: details.get(id)?.detail.headSha ?? entry.headSha ?? null, at: Date.now() };
    persist(marks);
    changed();
    return { ok: true };
  }

  async function draft(id: string) {
    const entry = find(id);
    await markRead(id);
    const marks = await load();
    const summary = marks.summaries[id];
    const { reviewedSha } = reviewState(entry, marks);
    return {
      prompt: draftPrompt(entry, details.get(id)?.detail ?? null, { risk: summary?.risk ?? null, text: summary?.text ?? null }, reviewedSha),
    };
  }

  async function archive(id: string) {
    const marks = await load();
    marks.archived[id] = Date.now();
    persist(marks);
    changed();
    return { ok: true };
  }

  async function submit(id: string, verdict: "approve" | "request_changes", body: string) {
    const entry = find(id);
    if (verdict === "request_changes" && !body) throw new Error("Say what needs to change.");
    hostId = await indexHostId(bb, hostId);
    if (!hostId) throw new Error(NO_HOST);
    const result = await host.call("pr_review", { forge: entry.forge, repo: entry.repo, number: entry.number, verdict, body }, { hostId });
    if (result.error) throw new Error(result.error);
    const marks = await load();
    marks.reviewed[id] = { sha: details.get(id)?.detail.headSha ?? entry.headSha ?? null, at: Date.now() };
    persist(marks);
    changed();
    // Re-read which commit the review landed on: the head may have moved since the card last read it.
    void readDetail(entry).finally(changed);
    return { ok: true };
  }

  settings.onChange((next, prev) => {
    if (next.reviewSearchesMe !== prev.reviewSearchesMe || next.reviewSearchesTeam !== prev.reviewSearchesTeam) void refresh();
  });
  const startupTimer = setTimeout(() => void refresh(), STARTUP_DELAY_MS);
  const pollTimer = setInterval(() => void refresh(), POLL_MS);

  function dispose() {
    disposed = true;
    clearTimeout(startupTimer);
    clearInterval(pollTimer);
    clearTimeout(changedTimer);
    detailQueue.length = 0;
    summaryQueue.length = 0;
  }

  return { list, refresh, draft, markRead, archive, submit, dispose };
}
