import { realpathSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { hostContract } from "./contract";
import { prDetail, prReview, prSearch } from "./host/forge";
import { failure, run } from "./host/run";
import { ompSpend, piSpend } from "./host/spend";

const LABELER_FLAGS = [
  "-p",
  "--no-session",
  "--no-tools",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-mcp",
  "--thinking",
  "off",
];

/**
 * qmd named index owned by the plugin. qmd places it: `shop-kanban.yml` in `$XDG_CONFIG_HOME/qmd` (`~/.config/qmd`),
 * `shop-kanban.sqlite` in `$XDG_CACHE_HOME/qmd` (`~/.cache/qmd`).
 */
const QMD_INDEX = ["--index", "shop-kanban"];
const QMD_COLLECTION = "threads";
/** One `<threadId>.md` per thread, under the plugin's host data dir. */
const THREADS_DIR = "threads";
const QMD_UPDATE_TIMEOUT_MS = 120_000;
const QMD_SEARCH_TIMEOUT_MS = 10_000;

/** Points the collection at `dir`: added when missing, re-added when it indexes another path. */
async function ensureCollection(command: string, dir: string, signal: AbortSignal): Promise<string | null> {
  const show = await run(command, [...QMD_INDEX, "collection", "show", QMD_COLLECTION], QMD_SEARCH_TIMEOUT_MS, signal);
  if (show.code === 0) {
    // qmd stores `realpathSync(resolve(path))` (e.g. /private/var/… for /var/…). Same call here, not the native
    // `fs.promises.realpath`, so the strings agree on every platform; a mismatch would re-add and re-index each sync.
    const indexed = show.stdout.match(/^\s*Path:\s*(.+?)\s*$/m)?.[1];
    if (indexed === realpathSync(dir)) return null;
    await run(command, [...QMD_INDEX, "collection", "remove", QMD_COLLECTION], QMD_SEARCH_TIMEOUT_MS, signal);
  } else if (show.code === -1) {
    return failure(command, show);
  }
  const add = await run(command, [...QMD_INDEX, "collection", "add", dir, "--name", QMD_COLLECTION], QMD_UPDATE_TIMEOUT_MS, signal);
  return add.code === 0 ? null : failure(command, add);
}

/** The exported thread files' directory, created on first use. */
async function threadsDir(dataDir: string): Promise<string> {
  const dir = join(dataDir, THREADS_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** `qmd search --json` rows; `file` is `qmd://threads/<threadId>.md?index=shop-kanban`. */
const qmdHitsSchema = z.array(
  z.object({ file: z.string(), title: z.string().nullish(), snippet: z.string().nullish() }).loose(),
);

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    complete: async ({ command, system, prompt, models, timeoutMs }, context) => {
      let lastError: string | null = null;
      for (const model of models) {
        const result = await run(command, [...LABELER_FLAGS, "--model", model, "--system-prompt", system, prompt], timeoutMs, context.signal);
        const text = result.stdout.trim();
        if (result.code === 0 && text) return { text, model, error: null };
        lastError = failure(command, result);
        if (context.signal.aborted) break;
      }
      return { text: null, model: null, error: lastError };
    },
    // The data dir may be unwritable or full: report it like a qmd failure instead of throwing.
    index_status: async ({ command }, context) => {
      try {
        const dir = await threadsDir(context.experimental_paths.dataDir);
        const error = await ensureCollection(command, dir, context.signal);
        const threadIds = (await readdir(dir)).flatMap((name) => (name.endsWith(".md") ? [name.slice(0, -3)] : []));
        return { threadIds, error };
      } catch (error) {
        return { threadIds: [], error: String(error) };
      }
    },
    index_write: async ({ command, docs, remove }, context) => {
      try {
        const dir = await threadsDir(context.experimental_paths.dataDir);
        for (const doc of docs) await writeFile(join(dir, `${doc.threadId}.md`), doc.markdown);
        for (const threadId of remove) await rm(join(dir, `${threadId}.md`), { force: true });
      } catch (error) {
        return { error: String(error) };
      }
      const update = await run(command, [...QMD_INDEX, "update"], QMD_UPDATE_TIMEOUT_MS, context.signal);
      return { error: update.code === 0 ? null : failure(command, update) };
    },
    index_search: async ({ command, query, limit }, context) => {
      const args = [...QMD_INDEX, "search", "--json", "-n", String(limit), "-c", QMD_COLLECTION, "--", query];
      const result = await run(command, args, QMD_SEARCH_TIMEOUT_MS, context.signal);
      if (result.code !== 0) return { hits: [], error: failure(command, result) };
      let rows: z.infer<typeof qmdHitsSchema>;
      try {
        rows = qmdHitsSchema.parse(JSON.parse(result.stdout));
      } catch {
        return { hits: [], error: `${command} returned unexpected output: ${result.stdout.trim().slice(0, 200)}` };
      }
      const seen = new Set<string>();
      const hits = rows.flatMap((row) => {
        const threadId = row.file.match(/([^/?#]+)\.md(?:[?#].*)?$/)?.[1];
        if (!threadId || seen.has(threadId)) return [];
        seen.add(threadId);
        return [{ threadId, title: row.title ?? null, snippet: row.snippet ?? null }];
      });
      return { hits, error: null };
    },
    omp_spend: async ({ sessionIds }) => ({ spends: await ompSpend(sessionIds) }),
    pi_spend: async ({ sessionIds }) => ({ spends: await piSpend(sessionIds) }),
    pr_search: (input, context) => prSearch(input, context.signal),
    pr_detail: (input, context) => prDetail(input, context.signal),
    pr_review: (input, context) => prReview(input, context.signal),
  },
});
