import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, type Forge, type ForgePr } from "../contract";
import { CALL_TIMEOUT_MS, NO_HOST, createPoller, message, parseSearch, prId, searchLines, type ForgeSearch, type SearchKind } from "./forge-search";
import { indexHostId } from "./hosts";
import type { WorkItem, WorkList, WorkMark, WorkSource, WorkState } from "./schema";
import { safe } from "./text";

// Work lists in the Queue column's tabs: the user's open pull requests and their recently merged ones (Out),
// and issues assigned to them (In, beside the review queue). Read through the forge CLIs on the user's
// persistent host from searches in settings. Merging is as close to deployed as the forges say, so a shipped pull
// request stays listed until the user marks its impact measured and its change demoed, or archives it. Marks live
// in KV.

const MARKS_KEY = "work-v1";
/** Newest matches read per search. */
const SEARCH_LIMIT = 30;
/** Marks kept per kind, newest first; one KV value holds all three. */
const MARKS_MAX = 500;
const LIST_KIND: Record<WorkList, SearchKind> = {
  open: { is: "pr", state: "open" },
  shipped: { is: "pr", state: "merged" },
  assigned: { is: "issue", state: "open" },
};
const LIST_ORDER: WorkList[] = ["open", "shipped", "assigned"];
const LINE_SYNTAX =
  "One search per line: `delta: <query>` reads Delta through `dt` (shop/world unless the query names a `repo:`), `github: <query>` reads GitHub through `gh`, in GitHub search syntax.";

type Search = ForgeSearch & { list: WorkList };
type Entry = ForgePr & { id: string; forge: Forge; list: WorkList; lines: string[] };
const marksSchema = z.object({
  archived: z.record(z.string(), z.number()).catch({}),
  measured: z.record(z.string(), z.number()).catch({}),
  demoed: z.record(z.string(), z.number()).catch({}),
});
type Marks = z.infer<typeof marksSchema>;
type Values = { outgoingSearches: string; shippedSearches: string; shippedDays: number; assignedSearches: string };

function failedSource(search: { line: string; list: WorkList }, error: string, missing: boolean): WorkSource {
  return { search: search.line, list: search.list, count: 0, total: 0, error, missing };
}

/** `YYYY-MM-DD` of `days` days ago, UTC: the cutoff for shipped searches. */
function sinceDate(days: number, now: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every list's lines as searches, the invalid ones as failed sources, and the lists that have any line. Shipped
 * searches gain `merged:>=` the cutoff unless they name their own `merged:`.
 */
function configuredSearches(values: Values, now: number) {
  const searches: Search[] = [];
  const invalid: WorkSource[] = [];
  const lists: WorkList[] = [];
  const days = Math.max(1, Math.round(values.shippedDays));
  const settingOf: Record<WorkList, string> = { open: values.outgoingSearches, shipped: values.shippedSearches, assigned: values.assignedSearches };
  for (const list of LIST_ORDER) {
    const lines = searchLines(settingOf[list]);
    if (lines.length > 0) lists.push(list);
    for (const line of lines) {
      const search = parseSearch(line, LIST_KIND[list]);
      if (!search) {
        invalid.push(failedSource({ line, list }, "Start the line with delta: or github:", false));
        continue;
      }
      const query = list === "shipped" && !/(?:^|\s)merged:/u.test(search.query) ? `${search.query} merged:>=${sinceDate(days, now)}` : search.query;
      searches.push({ ...search, query, list });
    }
  }
  return { searches, invalid, lists };
}

function capped(record: Record<string, number>): Record<string, number> {
  const rows = Object.entries(record);
  if (rows.length <= MARKS_MAX) return record;
  return Object.fromEntries(rows.sort((a, b) => b[1] - a[1]).slice(0, MARKS_MAX));
}

export function createWorkLists(bb: BbPluginApi) {
  const settings = bb.settings.define({
    outgoingSearches: {
      type: "string",
      label: "Out: your open pull requests",
      description: `Listed under Open in the Queue column's Out tab, drafts included. ${LINE_SYNTAX} \`is:pr is:open\` is implied. Leave empty to hide Open.`,
      default: "delta: author:@me\ngithub: author:@me",
      experimental_multiline: true,
    },
    shippedSearches: {
      type: "string",
      label: "Out: your merged pull requests",
      description: `Listed under Shipped in the Queue column's Out tab until you mark each one measured and demoed, or archive it. ${LINE_SYNTAX} \`is:pr is:merged\` and a \`merged:>=\` cutoff from the setting below are implied. Leave empty to hide Shipped.`,
      default: "delta: author:@me\ngithub: author:@me",
      experimental_multiline: true,
    },
    shippedDays: {
      type: "number",
      label: "Out: days a merged pull request stays listed",
      description: "Shipped lists pull requests merged within this many days.",
      default: 30,
      experimental_schema: z.number().int().min(1).max(365),
    },
    assignedSearches: {
      type: "string",
      label: "In: issues assigned to you",
      description: `Listed under Assigned in the Queue column's In tab. ${LINE_SYNTAX} \`is:issue is:open\` is implied; Delta has no issues. Leave empty to hide Assigned.`,
      default: "github: assignee:@me",
      experimental_multiline: true,
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });

  let marksLoad: Promise<Marks> | null = null;
  let marksWrite: Promise<unknown> = Promise.resolve();
  let entries: Entry[] = [];
  let sources: WorkSource[] = [];
  let hostId: string | null = null;
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  const poller = createPoller(runRefresh, changed, 10_000);

  function changed() {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      bb.realtime.publish("work-changed", { at: Date.now() });
    }, 300);
  }

  function load(): Promise<Marks> {
    marksLoad ??= (async () => {
      const parsed = marksSchema.safeParse(await safe(async () => bb.storage.kv.get<unknown>(MARKS_KEY)));
      return parsed.success ? parsed.data : marksSchema.parse({});
    })();
    return marksLoad;
  }

  function persist(marks: Marks) {
    marks.archived = capped(marks.archived);
    marks.measured = capped(marks.measured);
    marks.demoed = capped(marks.demoed);
    marksWrite = marksWrite.then(() => safe(async () => bb.storage.kv.set(MARKS_KEY, marks)));
    changed();
  }

  async function runRefresh(): Promise<boolean> {
    const { searches, invalid } = configuredSearches(await settings.get(), Date.now());
    if (searches.length === 0) {
      entries = [];
      sources = invalid;
      return false;
    }
    hostId = await indexHostId(bb, hostId);
    const target = hostId;
    if (!target) {
      // Quiet like a missing CLI; the last lists stay up until a host connects again.
      sources = [...searches.map((search) => failedSource(search, NO_HOST, true)), ...invalid];
      return true;
    }
    const results = await Promise.all(
      searches.map(async (search) => ({
        search,
        result: await host
          .call("pr_search", { forge: search.forge, repo: search.repo, query: search.query, limit: SEARCH_LIMIT }, { hostId: target, timeoutMs: CALL_TIMEOUT_MS })
          .catch((cause: unknown) => ({ prs: [], total: 0, error: message(cause), missing: false })),
      })),
    );
    // Keyed per list: a pull request can be both open in one search and, say, merged in another's stale row.
    const next = new Map<string, Entry>();
    const searched = results.map(({ search, result }): WorkSource => {
      const found =
        result.error === null
          ? result.prs.map((pr) => ({ ...pr, id: prId(search.forge, pr), forge: search.forge, list: search.list }))
          : // Keep what this search listed last time instead of flickering it away on a transient failure.
            entries.filter((entry) => entry.lines.includes(search.line) && entry.list === search.list);
      for (const pr of found) {
        const key = `${pr.list}:${pr.id}`;
        const existing = next.get(key);
        if (existing) {
          if (!existing.lines.includes(search.line)) existing.lines.push(search.line);
        } else {
          next.set(key, { ...pr, lines: [search.line] });
        }
      }
      if (result.error !== null) return failedSource(search, result.error, result.missing);
      return { search: search.line, list: search.list, count: result.prs.length, total: result.total, error: null, missing: false };
    });
    const sortTime = (entry: Entry) => Date.parse((entry.list === "shipped" ? entry.mergedAt : null) ?? entry.updatedAt) || 0;
    entries = [...next.values()].sort((a, b) => sortTime(b) - sortTime(a));
    sources = [...searched, ...invalid];
    return searched.some((source) => source.error !== null && !source.missing);
  }

  function item(entry: Entry, marks: Marks): WorkItem {
    return {
      id: entry.id,
      list: entry.list,
      forge: entry.forge,
      kind: entry.kind,
      repo: entry.repo,
      number: entry.number,
      url: entry.url,
      title: entry.title,
      author: entry.author,
      draft: entry.draft,
      labels: entry.labels,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      mergedAt: entry.mergedAt,
      measured: entry.id in marks.measured,
      demoed: entry.id in marks.demoed,
    };
  }

  function hidden(entry: Entry, marks: Marks): boolean {
    if (entry.id in marks.archived) return true;
    return entry.list === "shipped" && entry.id in marks.measured && entry.id in marks.demoed;
  }

  async function list(): Promise<WorkState> {
    const [marks, values] = await Promise.all([load(), settings.get()]);
    poller.readFresh();
    return {
      lists: configuredSearches(values, Date.now()).lists,
      items: entries.flatMap((entry) => (hidden(entry, marks) ? [] : [item(entry, marks)])),
      sources,
      refreshing: poller.refreshing,
      refreshedAt: poller.refreshedAt,
      error: poller.error,
    };
  }

  async function mark(id: string, kind: WorkMark, on: boolean) {
    const marks = await load();
    if (on) marks[kind][id] = Date.now();
    else delete marks[kind][id];
    persist(marks);
    return { ok: true };
  }

  settings.onChange((next, prev) => {
    if (
      next.outgoingSearches !== prev.outgoingSearches ||
      next.shippedSearches !== prev.shippedSearches ||
      next.shippedDays !== prev.shippedDays ||
      next.assignedSearches !== prev.assignedSearches
    ) {
      void poller.refresh();
    }
  });

  function dispose() {
    poller.dispose();
    clearTimeout(changedTimer);
  }

  return { list, mark, dispose };
}
