import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, type Forge, type ForgePr, type ForgePrDetail } from "../contract";
import { CALL_TIMEOUT_MS, NO_HOST, createPoller, message, parseSearch, prId, searchLines, type ForgeSearch } from "./forge-search";
import { indexHostId } from "./hosts";
import { hashText } from "./labels";
import { REVIEW_SUMMARY_VERSION, REVIEW_SYSTEM, draftPrompt, parseReviewSummary, reviewPrompt } from "./review-prompt";
import { reviewRiskSchema, type ReviewCard, type ReviewScope, type ReviewSource, type ReviewState } from "./schema";
import { safe } from "./text";

// Review queue: open pull requests waiting on the user's review, read through the forge CLIs (`dt`, `gh`) on the
// user's persistent host and listed in the Queue column's In tab. The searches come from settings, so each
// user gets their own and their teams' requests; pull requests they already reviewed drop off. The labeler model
// writes each one a "[risk] what, why" first read, cached per head commit. Read, archived and reviewed marks and
// the summaries live in KV.

const MARKS_KEY = "reviews-v1";
/** Newest pull requests read per search. */
const SEARCH_LIMIT = 30;
/** The user's own reviews among a search's matches, subtracted from it. */
const REVIEWED_LIMIT = 100;
const SUMMARY_RETRY_MS = 10 * 60_000;
/** Per-PR failures recur every poll; each distinct one is logged at most this often. */
const LOG_REPEAT_MS = 60 * 60_000;
/**
 * Read, archived and reviewed marks kept per kind, newest first. One KV value holds them all and KV caps values at
 * 256KB: three full kinds take ~110KB, leaving room for the summaries of every listed pull request.
 */
const MARKS_MAX = 500;
/** Reviews end a little after the host's own 60s CLI timeout, so its clearer error wins. */
const REVIEW_CALL_TIMEOUT_MS = 65_000;

const LINE_SYNTAX =
  "One search per line: `delta: <query>` reads Delta through `dt` (shop/world unless the query names a `repo:`), `github: <query>` reads GitHub through `gh`. GitHub search syntax with `is:pr is:open` implied; pull requests you already reviewed drop off until new commits land.";

type Labeler = { complete(hostId: string, system: string, prompt: string, timeoutMs: number): Promise<string> };
type Search = ForgeSearch & { scope: ReviewScope };
/**
 * A listed pull request, the search lines that found it, whether one's `reviewed-by:@me` lists it, and its scope:
 * Me when any search for the user found it.
 */
type Entry = ForgePr & { id: string; forge: Forge; lines: string[]; reviewed: boolean; scope: ReviewScope };
const shaMark = z.object({ sha: z.string().nullable(), at: z.number() });
/** Stored marks; a kind that fails to parse starts over empty rather than taking the others with it. */
const marksSchema = z.object({
  /** Head commit when last opened from the board; null when it was opened before its head was read. */
  read: z.record(z.string(), shaMark).catch({}),
  archived: z.record(z.string(), z.number()).catch({}),
  /** Reviewed from the board, at that head commit: hidden at once, before the forge's search and reviews list it. */
  reviewed: z.record(z.string(), shaMark).catch({}),
  summaries: z
    .record(
      z.string(),
      z.object({ sig: z.string(), risk: reviewRiskSchema.nullable(), text: z.string().nullable(), at: z.number(), failedAt: z.number().optional() }),
    )
    .catch({}),
});
type Marks = z.infer<typeof marksSchema>;

function failedSource(search: { line: string; scope: ReviewScope }, error: string, missing: boolean): ReviewSource {
  return { search: search.line, scope: search.scope, count: 0, total: 0, error, missing };
}

/**
 * Both settings' lines as searches, Me first, the invalid ones as failed sources, and the scopes that have any
 * line. Blank lines and `#` comments are skipped.
 */
function configuredSearches(values: { reviewSearchesMe: string; reviewSearchesTeam: string }) {
  const searches: Search[] = [];
  const invalid: ReviewSource[] = [];
  const scopes: ReviewScope[] = [];
  for (const [scope, value] of [["me", values.reviewSearchesMe], ["team", values.reviewSearchesTeam]] as const) {
    const lines = searchLines(value);
    if (lines.length > 0) scopes.push(scope);
    for (const line of lines) {
      const search = parseSearch(line, { is: "pr", state: "open" });
      if (search) searches.push({ ...search, scope });
      else invalid.push(failedSource({ line, scope }, "Start the line with delta: or github:", false));
    }
  }
  return { searches, invalid, scopes };
}

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
      description: `Open pull requests asking for your review by name, under Me in the Queue column's In tab. ${LINE_SYNTAX} Delta's \`review-requested:@me\` and GitHub's \`user-review-requested:@me\` leave out your teams' requests. Leave empty to hide Me.`,
      default: "delta: review-requested:@me -author:@me -is:draft\ngithub: user-review-requested:@me -author:@me -is:draft",
      experimental_multiline: true,
    },
    reviewSearchesTeam: {
      type: "string",
      label: "Review queue: requested of your teams",
      description: `Open pull requests asking your teams for review, under Team in the Queue column's In tab; one a search for you also finds is listed under Me only. ${LINE_SYNTAX} Delta's \`team-review-requested:@me\` matches every team you are on; on GitHub, \`review-requested:@me -user-review-requested:@me\` does. For one team, Delta takes the team slug (\`team-review-requested:exp\`) and GitHub \`team-review-requested:<org>/<team>\`. Leave empty to hide Team.`,
      default:
        "delta: team-review-requested:@me -author:@me -is:draft\ngithub: review-requested:@me -user-review-requested:@me -author:@me -is:draft",
      experimental_multiline: true,
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });

  let marksLoad: Promise<Marks> | null = null;
  let marksWrite: Promise<unknown> = Promise.resolve();
  let entries: Entry[] = [];
  let sources: ReviewSource[] = [];
  const poller = createPoller(runRefresh, changed, 8_000);
  let hostId: string | null = null;
  let disposed = false;
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Details per pull request, keyed by the `updatedAt` they were read at, and when that read started. */
  const details = new Map<string, { updatedAt: string; detail: ForgePrDetail; at: number }>();
  const detailQueue = workQueue(3, readDetail);
  const summaryQueue = workQueue(2, summarize);
  const logged = new Map<string, number>();

  function load(): Promise<Marks> {
    marksLoad ??= (async () => {
      const parsed = marksSchema.safeParse(await safe(async () => bb.storage.kv.get<unknown>(MARKS_KEY)));
      return parsed.success ? parsed.data : marksSchema.parse({});
    })();
    return marksLoad;
  }

  function persist(marks: Marks) {
    marks.read = capped(marks.read, (mark) => mark.at);
    marks.archived = capped(marks.archived, (at) => at);
    marks.reviewed = capped(marks.reviewed, (mark) => mark.at);
    // Summaries cache the listed pull requests' first reads; one no longer listed only eats into the KV value.
    if (poller.refreshedAt !== null) {
      const listed = new Set(entries.map((entry) => entry.id));
      marks.summaries = Object.fromEntries(Object.entries(marks.summaries).filter(([id]) => listed.has(id)));
    }
    marksWrite = marksWrite.then(() => safe(async () => bb.storage.kv.set(MARKS_KEY, marks)));
    changed();
  }

  function changed() {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      bb.realtime.publish("reviews-changed", { at: Date.now() });
    }, 300);
  }

  /** Logs a per-PR failure unless the same failure, for any pull request, was logged within `LOG_REPEAT_MS`. */
  function logFailure(kind: "details" | "summary", id: string, cause: string) {
    // A reload retires this generation mid-call ("worker exited", "generation is retired"): noise, not news.
    if (disposed) return;
    const now = Date.now();
    for (const [key, at] of logged) if (now - at >= LOG_REPEAT_MS) logged.delete(key);
    const key = `${kind}:${cause}`;
    if (logged.has(key)) return;
    logged.set(key, now);
    bb.log.info(`review ${kind} failed for ${id}: ${cause}`);
  }

  /** Runs `job` per entry, `concurrency` at a time; an entry already waiting or running is not queued again. */
  function workQueue(concurrency: number, job: (entry: Entry) => Promise<void>) {
    const waiting: Entry[] = [];
    const pending = new Set<string>();
    let active = 0;
    function pump() {
      while (!disposed && active < concurrency && waiting.length > 0) {
        const entry = waiting.shift()!;
        active += 1;
        void job(entry).finally(() => {
          active -= 1;
          pending.delete(entry.id);
          changed();
          pump();
        });
      }
    }
    return {
      pending,
      add(entry: Entry) {
        if (pending.has(entry.id)) return;
        pending.add(entry.id);
        waiting.push(entry);
        pump();
      },
    };
  }

  function currentHead(entry: Entry): string | null {
    return details.get(entry.id)?.detail.headSha ?? entry.headSha;
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
    const head = currentHead(entry);
    return { hidden: head === null || head === reviewedSha, reviewedSha };
  }

  function summarySig(entry: Entry, detail: ForgePrDetail): string {
    return `v${REVIEW_SUMMARY_VERSION}:${detail.headSha ?? entry.updatedAt}:${hashText(entry.title)}`;
  }

  function callSearch(target: string, input: { forge: Forge; repo: string | null; query: string; limit: number }) {
    return host
      .call("pr_search", input, { hostId: target, timeoutMs: CALL_TIMEOUT_MS })
      .catch((cause: unknown) => ({ prs: [], total: 0, error: message(cause), missing: false }));
  }

  /** Re-reads every search; resolves true when one failed in a way worth retrying soon. */
  async function runRefresh(): Promise<boolean> {
    const { searches, invalid } = configuredSearches(await settings.get());
    if (searches.length === 0) {
      entries = [];
      sources = invalid;
      return false;
    }
    hostId = await indexHostId(bb, hostId);
    const target = hostId;
    if (!target) {
      // Quiet like a missing CLI; the last list stays up until a host connects again.
      sources = [...searches.map((search) => failedSource(search, NO_HOST, true)), ...invalid];
      return true;
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
    const next = new Map<string, Entry>();
    const searched = results.map(({ search, open, reviewed }): ReviewSource => {
      const done = new Set(reviewed.prs.map((pr) => prId(search.forge, pr)));
      const found =
        open.error === null
          ? open.prs.map((pr) => {
              const id = prId(search.forge, pr);
              return { ...pr, id, forge: search.forge, reviewed: done.has(id) };
            })
          : // Keep what this search listed last time instead of flickering it away on a transient failure.
            entries.filter((entry) => entry.lines.includes(search.line));
      for (const pr of found) {
        const existing = next.get(pr.id);
        if (!existing) {
          next.set(pr.id, { ...pr, lines: [search.line], scope: search.scope });
          continue;
        }
        if (!existing.lines.includes(search.line)) existing.lines.push(search.line);
        existing.reviewed ||= pr.reviewed;
        if (search.scope === "me") existing.scope = "me";
      }
      if (open.error !== null) return failedSource(search, open.error, open.missing);
      return { search: search.line, scope: search.scope, count: open.prs.length, total: open.total, error: reviewed.error, missing: false };
    });
    entries = [...next.values()].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    sources = [...searched, ...invalid];
    for (const id of details.keys()) if (!next.has(id)) details.delete(id);
    const marks = await load();
    for (const entry of entries) {
      // Reviewed ones too: their details say whether commits landed after the user's review.
      if (entry.id in marks.archived) continue;
      if (details.get(entry.id)?.updatedAt === entry.updatedAt) queueSummary(entry, marks);
      else detailQueue.add(entry);
    }
    return searched.some((source) => source.error !== null && !source.missing);
  }

  async function readDetail(entry: Entry) {
    const target = hostId;
    if (!target) return;
    const at = Date.now();
    const result = await host
      .call("pr_detail", { forge: entry.forge, repo: entry.repo, number: entry.number }, { hostId: target, timeoutMs: CALL_TIMEOUT_MS })
      .catch((cause: unknown) => ({ detail: null, error: message(cause) }));
    if (!result.detail) {
      logFailure("details", entry.id, result.error ?? "no details");
      return;
    }
    if (disposed) return;
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
    if (!known || reviewState(entry, marks).hidden) return;
    const current = marks.summaries[entry.id];
    const backingOff = current?.failedAt !== undefined && Date.now() - current.failedAt < SUMMARY_RETRY_MS;
    if (current?.sig === summarySig(entry, known.detail) && (current.failedAt === undefined || backingOff)) return;
    summaryQueue.add(entry);
  }

  async function summarize(entry: Entry) {
    const target = hostId;
    const known = details.get(entry.id);
    if (!target || !known) return;
    const marks = await load();
    const sig = summarySig(entry, known.detail);
    const previous = marks.summaries[entry.id];
    try {
      const parsed = parseReviewSummary(await labeler.complete(target, REVIEW_SYSTEM, reviewPrompt(entry, known.detail), 20_000));
      if (!parsed) throw new Error("The model returned no usable JSON.");
      marks.summaries[entry.id] = { sig, risk: parsed.risk, text: parsed.text, at: Date.now() };
    } catch (cause) {
      if (disposed) return;
      logFailure("summary", entry.id, message(cause));
      // The last head's summary stays on the card until this one succeeds.
      marks.summaries[entry.id] = { sig, risk: previous?.risk ?? null, text: previous?.text ?? null, at: Date.now(), failedAt: Date.now() };
    }
    persist(marks);
  }

  function card(entry: Entry, marks: Marks, reviewedSha: string | null): ReviewCard {
    const { lines, reviewed, labels, headSha, kind, mergedAt, ...pr } = entry;
    const detail = details.get(entry.id)?.detail ?? null;
    const sha = currentHead(entry);
    const read = marks.read[entry.id];
    const summary = marks.summaries[entry.id];
    return {
      ...pr,
      additions: detail?.additions ?? null,
      deletions: detail?.deletions ?? null,
      changedFiles: detail?.changedFiles ?? null,
      risk: summary?.risk ?? null,
      summary: summary?.text ?? null,
      summarizing: summaryQueue.pending.has(entry.id) || (detailQueue.pending.has(entry.id) && !summary?.text),
      unread: !read || (read.sha !== null && sha !== null && read.sha !== sha),
      rereview: reviewedSha !== null,
    };
  }

  async function list(): Promise<ReviewState> {
    const [marks, values] = await Promise.all([load(), settings.get()]);
    // Any board read (opening it, the page showing again after the machine wakes, its 1-minute poll) re-runs
    // searches over a minute old, so a new request shows within one search round instead of at the next poll.
    poller.readFresh();
    return {
      scopes: configuredSearches(values).scopes,
      reviews: entries.flatMap((entry) => {
        const state = reviewState(entry, marks);
        return state.hidden ? [] : [card(entry, marks, state.reviewedSha)];
      }),
      sources,
      refreshing: poller.refreshing,
      refreshedAt: poller.refreshedAt,
      error: poller.error,
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
    marks.read[id] = { sha: currentHead(entry), at: Date.now() };
    persist(marks);
    return { ok: true };
  }

  async function draft(id: string) {
    const entry = find(id);
    await markRead(id);
    const marks = await load();
    const { reviewedSha } = reviewState(entry, marks);
    return { prompt: draftPrompt(entry, details.get(id)?.detail ?? null, marks.summaries[id], reviewedSha) };
  }

  async function archive(id: string) {
    const marks = await load();
    marks.archived[id] = Date.now();
    persist(marks);
    return { ok: true };
  }

  async function submit(id: string, verdict: "approve" | "request_changes", body: string) {
    const entry = find(id);
    if (verdict === "request_changes" && !body) throw new Error("Say what needs to change.");
    hostId = await indexHostId(bb, hostId);
    if (!hostId) throw new Error(NO_HOST);
    const result = await host.call(
      "pr_review",
      { forge: entry.forge, repo: entry.repo, number: entry.number, verdict, body },
      { hostId, timeoutMs: REVIEW_CALL_TIMEOUT_MS },
    );
    if (result.error) throw new Error(result.error);
    const marks = await load();
    marks.reviewed[id] = { sha: currentHead(entry), at: Date.now() };
    persist(marks);
    // Re-read which commit the review landed on: the head may have moved since the card last read it.
    void readDetail(entry).finally(changed);
    return { ok: true };
  }

  settings.onChange((next, prev) => {
    if (next.reviewSearchesMe !== prev.reviewSearchesMe || next.reviewSearchesTeam !== prev.reviewSearchesTeam) void poller.refresh();
  });

  function dispose() {
    disposed = true;
    poller.dispose();
    clearTimeout(changedTimer);
  }

  return { list, draft, markRead, archive, submit, dispose };
}
