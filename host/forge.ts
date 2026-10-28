import { z } from "zod";
import type { Forge, ForgePr, ForgePrDetail } from "../contract";
import { failure, run } from "./run";

// Pull requests through the forge CLIs the user already signed in to: `dt` for Delta, `gh` for GitHub. Both speak
// GitHub's REST shapes, so one set of schemas reads either.

const CLI: Record<Forge, string> = { delta: "dt", github: "gh" };
const API_TIMEOUT_MS = 30_000;
const REVIEW_TIMEOUT_MS = 60_000;
const FILES_PAGE = 100;
/** Reviews read per pull request; the API lists them oldest first and cannot sort. */
const REVIEWS_PAGE = 100;
/** Diff kept per file and per pull request: enough for a model's first read, not for a review. */
const PATCH_FILE_MAX = 2_000;
const PATCH_TOTAL_MAX = 12_000;
const BODY_MAX = 8_000;
/** Lockfiles, snapshots and generated dumps say little about intent and would crowd out the real change. */
const NOISY_PATH =
  /(?:^|\/)(?:[^/]*\.lock|package-lock\.json|pnpm-lock\.yaml|go\.sum|schema\.json|schema\.graphql|[^/]*\.snap|[^/]*\.min\.(?:js|css))$/;

const userSchema = z
  .object({
    login: z.string(),
    type: z.string().nullish(),
    /** Delta's agents (River) post under a service account and carry the brand they show as. */
    service_brand: z.object({ display_name: z.string() }).loose().nullish(),
  })
  .loose();

const searchSchema = z
  .object({
    total_count: z.number(),
    items: z.array(
      z
        .object({
          number: z.number().int(),
          title: z.string(),
          html_url: z.string(),
          user: userSchema.nullish(),
          draft: z.boolean().nullish(),
          created_at: z.string(),
          updated_at: z.string(),
          labels: z.array(z.object({ name: z.string() }).loose()).nullish(),
          head: z.object({ sha: z.string() }).loose().nullish(),
        })
        .loose(),
    ),
  })
  .loose();

const pullSchema = z
  .object({
    head: z.object({ sha: z.string() }).loose(),
    body: z.string().nullish(),
    additions: z.number().nullish(),
    deletions: z.number().nullish(),
    changed_files: z.number().nullish(),
  })
  .loose();

const filesSchema = z.array(
  z
    .object({
      filename: z.string(),
      status: z.string().nullish(),
      additions: z.number().nullish(),
      deletions: z.number().nullish(),
      patch: z.string().nullish(),
    })
    .loose(),
);

const meSchema = z.object({ id: z.number() }).loose();

/** Chronological, oldest first. */
const reviewsSchema = z.array(
  z
    .object({
      user: z.object({ id: z.number() }).loose().nullish(),
      state: z.string(),
      commit_id: z.string().nullish(),
    })
    .loose(),
);

/**
 * The signed-in user's id per forge, read once. Ids, not logins: Delta's `/user` says `name` where its reviews
 * say `name@shopify.com`.
 */
const myIds = new Map<Forge, number>();

type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; missing: boolean };

/** One GET through the forge's `api` command. `dt` finds the host from the repository, so Delta calls name it. */
async function api<T>(forge: Forge, repo: string | null, endpoint: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<ApiResult<T>> {
  const command = CLI[forge];
  const args = forge === "delta" ? ["api", "-R", repo ?? "", endpoint] : ["api", endpoint];
  const result = await run(command, args, API_TIMEOUT_MS, signal);
  if (result.code !== 0) {
    return { ok: false, error: failure(command, result), missing: result.code === -1 && result.stderr.includes("ENOENT") };
  }
  try {
    return { ok: true, value: schema.parse(JSON.parse(result.stdout)) };
  } catch {
    return { ok: false, error: `${command} api returned unexpected output: ${result.stdout.trim().slice(0, 200)}`, missing: false };
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}

export async function prSearch(
  input: { forge: Forge; repo: string | null; query: string; limit: number },
  signal: AbortSignal,
): Promise<{ prs: ForgePr[]; total: number; error: string | null; missing: boolean }> {
  if (input.forge === "delta" && !input.repo) return { prs: [], total: 0, error: "A Delta search needs a repository.", missing: false };
  const params = `q=${encodeURIComponent(input.query)}&sort=updated&order=desc&per_page=${input.limit}`;
  const endpoint = input.forge === "delta" ? `/api/v3/search/issues?${params}` : `search/issues?${params}`;
  const result = await api(input.forge, input.repo, endpoint, searchSchema, signal);
  if (!result.ok) return { prs: [], total: 0, error: result.error, missing: result.missing };
  const prs = result.value.items.flatMap((item): ForgePr[] => {
    // Search rows are issues too; a pull request's page is `/<owner>/<repo>/pull/<n>`.
    const repo = item.html_url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pulls?\/\d+/)?.[1];
    if (!repo) return [];
    const user = item.user;
    const brand = user?.service_brand?.display_name;
    const login = user?.login ?? "";
    // Delta logins are email addresses; their local part is the name people know.
    const author = brand ?? login.replace(/\[bot\]$/, "").replace(/@.*$/, "");
    return [
      {
        repo,
        number: item.number,
        title: item.title,
        url: item.html_url,
        author: author || login || "unknown",
        bot: Boolean(brand) || user?.type === "Bot" || login.endsWith("[bot]"),
        draft: item.draft === true,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        labels: (item.labels ?? []).map((label) => label.name),
        headSha: item.head?.sha ?? null,
      },
    ];
  });
  return { prs, total: result.value.total_count, error: null, missing: false };
}

/** The signed-in user's id; null when it cannot be read. */
async function myId(forge: Forge, repo: string, signal: AbortSignal): Promise<number | null> {
  const known = myIds.get(forge);
  if (known !== undefined) return known;
  const result = await api(forge, repo, forge === "delta" ? "/api/v3/user" : "user", meSchema, signal);
  if (!result.ok) return null;
  myIds.set(forge, result.value.id);
  return result.value.id;
}

/** Commit of the user's latest submitted review that still stands: pending drafts and dismissed reviews don't count. */
async function reviewedSha(forge: Forge, repo: string, base: string, signal: AbortSignal): Promise<string | null> {
  const [me, reviews] = await Promise.all([myId(forge, repo, signal), api(forge, repo, `${base}/reviews?per_page=${REVIEWS_PAGE}`, reviewsSchema, signal)]);
  if (me === null || !reviews.ok) return null;
  const mine = reviews.value.filter((review) => review.user?.id === me && review.commit_id && review.state !== "PENDING" && review.state !== "DISMISSED");
  return mine.at(-1)?.commit_id ?? null;
}

export async function prDetail(
  input: { forge: Forge; repo: string; number: number },
  signal: AbortSignal,
): Promise<{ detail: ForgePrDetail | null; error: string | null }> {
  const base = `repos/${input.repo}/pulls/${input.number}`;
  const [pull, files, reviewed] = await Promise.all([
    api(input.forge, input.repo, base, pullSchema, signal),
    api(input.forge, input.repo, `${base}/files?per_page=${FILES_PAGE}`, filesSchema, signal),
    reviewedSha(input.forge, input.repo, base, signal),
  ]);
  if (!pull.ok) return { detail: null, error: pull.error };
  let budget = PATCH_TOTAL_MAX;
  const rows = (files.ok ? files.value : []).map((file) => {
    const patch = file.patch && budget > 0 && !NOISY_PATH.test(file.filename) ? clip(file.patch, Math.min(PATCH_FILE_MAX, budget)) : null;
    if (patch) budget -= patch.length;
    return {
      path: file.filename,
      status: file.status ?? null,
      additions: file.additions ?? null,
      deletions: file.deletions ?? null,
      patch,
    };
  });
  return {
    detail: {
      headSha: pull.value.head.sha,
      reviewedSha: reviewed,
      body: clip((pull.value.body ?? "").trim(), BODY_MAX),
      additions: pull.value.additions ?? null,
      deletions: pull.value.deletions ?? null,
      changedFiles: pull.value.changed_files ?? null,
      files: rows,
    },
    // Without the file list the summary still has the description and size.
    error: files.ok ? null : files.error,
  };
}

export async function prReview(
  input: { forge: Forge; repo: string; number: number; verdict: "approve" | "request_changes"; body: string },
  signal: AbortSignal,
): Promise<{ error: string | null }> {
  const command = CLI[input.forge];
  const args = ["pr", "review", String(input.number), "-R", input.repo, input.verdict === "approve" ? "--approve" : "--request-changes"];
  const body = input.body.trim();
  if (body) args.push("--body", body);
  const result = await run(command, args, REVIEW_TIMEOUT_MS, signal);
  return { error: result.code === 0 ? null : failure(command, result) };
}
