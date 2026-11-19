import { z } from "zod";
import type { Forge, ForgePr, ForgePrProgress } from "../contract";
import { failure, parseOutput, run, type RunResult } from "./run";

// Pull requests through the forge CLIs the user already signed in to: `dt` for Delta, `gh` for GitHub. Both speak
// GitHub's REST shapes, so one set of schemas reads either.

const CLI: Record<Forge, string> = { delta: "dt", github: "gh" };
/** Reviews read per pull request; the API lists them oldest first and cannot sort. */
const REVIEWS_PAGE = 100;
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
          /** Present on pull request rows only. */
          pull_request: z.object({ merged_at: z.string().nullish() }).loose().nullish(),
        })
        .loose(),
    ),
  })
  .loose();

/** Chronological, oldest first. */
const reviewsSchema = z.array(
  z
    .object({
      user: z.object({ id: z.number() }).loose().nullish(),
      state: z.string(),
    })
    .loose(),
);

type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; missing: boolean };

/** `gh` says "gh auth login" when signed out or its token went bad; `dt` says "run `dt auth login` first". */
const SIGNED_OUT = /\b(?:gh|dt) auth login\b/;

/** Why a forge command failed; `missing` when the CLI cannot work on this host at all: not installed or signed out. */
function failed(command: string, result: RunResult): { error: string; missing: boolean } {
  // Code -1: the CLI could not start, i.e. it is not installed here (Node says ENOENT, Bun "Executable not found").
  if (result.code === -1) return { error: `${command} is not installed on this host.`, missing: true };
  if (SIGNED_OUT.test(result.stderr)) return { error: `${command} is not signed in on this host; run \`${command} auth login\`.`, missing: true };
  // No exit code: `run` stopped it at its timeout or when the call was cancelled.
  if (result.code === null) return { error: `${command} did not answer in time.`, missing: false };
  return { error: failure(command, result), missing: false };
}

/** One GET through the forge's `api` command. `dt` finds the host from the repository, so Delta calls name it. */
async function api<T>(forge: Forge, repo: string | null, endpoint: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<ApiResult<T>> {
  const command = CLI[forge];
  const args = forge === "delta" && repo ? ["api", "-R", repo, endpoint] : ["api", endpoint];
  const result = await run(command, args, 30_000, signal);
  if (result.code !== 0) return { ok: false, ...failed(command, result) };
  const parsed = parseOutput(`${command} api`, result.stdout, schema);
  return parsed.ok ? parsed : { ...parsed, missing: false };
}

export async function prSearch(input: { forge: Forge; repo: string | null; query: string; limit: number }, signal: AbortSignal) {
  const params = `q=${encodeURIComponent(input.query)}&sort=updated&order=desc&per_page=${input.limit}`;
  const endpoint = input.forge === "delta" ? `/api/v3/search/issues?${params}` : `search/issues?${params}`;
  const result = await api(input.forge, input.repo, endpoint, searchSchema, signal);
  if (!result.ok) return { prs: [], total: 0, error: result.error, missing: result.missing };
  const prs = result.value.items.flatMap((item): ForgePr[] => {
    // Search rows are pull requests (`/<owner>/<repo>/pull/<n>`) or issues (`/<owner>/<repo>/issues/<n>`).
    const page = item.html_url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(pulls?|issues)\/\d+/);
    if (!page) return [];
    const repo = page[1];
    const kind = page[2] === "issues" && !item.pull_request ? "issue" : "pr";
    const brand = item.user?.service_brand?.display_name;
    const login = item.user?.login ?? "";
    // Delta logins are email addresses; their local part is the name people know.
    const author = brand ?? login.replace(/\[bot\]$/, "").replace(/@.*$/, "");
    return [
      {
        kind,
        repo,
        number: item.number,
        title: item.title,
        url: item.html_url,
        author: author || login || "unknown",
        bot: Boolean(brand) || item.user?.type === "Bot" || login.endsWith("[bot]"),
        draft: item.draft === true,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        labels: (item.labels ?? []).map((label) => label.name),
        headSha: item.head?.sha ?? null,
        mergedAt: item.pull_request?.merged_at ?? null,
      },
    ];
  });
  return { prs, total: result.value.total_count, error: null, missing: false };
}

const progressPullSchema = z
  .object({
    head: z.object({ sha: z.string() }).loose(),
    user: z.object({ id: z.number() }).loose().nullish(),
    mergeable_state: z.string().nullish(),
    requested_reviewers: z.array(z.unknown()).nullish(),
    requested_teams: z.array(z.unknown()).nullish(),
  })
  .loose();

/** The combined commit status. With no statuses at all GitHub still says `pending`, so `total_count` decides. */
const combinedStatusSchema = z
  .object({
    state: z.string(),
    total_count: z.number().nullish(),
    statuses: z.array(z.object({ context: z.string(), state: z.string() }).loose()).nullish(),
  })
  .loose();

const checkRunsSchema = z
  .object({
    check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullish() }).loose()),
  })
  .loose();

/** Check run conclusions that fail the head, as GitHub's own rollup counts them. */
const FAILED_CONCLUSIONS: Record<string, true> = { failure: true, timed_out: true, cancelled: true, action_required: true, startup_failure: true };
/** Delta's review gate is a check run that stays in progress until reviewers approve: a review, not CI. */
const DELTA_REVIEW_GATE = "reviews";

export async function prProgress(input: { forge: Forge; repo: string; number: number }, signal: AbortSignal) {
  const base = `repos/${input.repo}/pulls/${input.number}`;
  const [pull, reviews] = await Promise.all([
    api(input.forge, input.repo, base, progressPullSchema, signal),
    api(input.forge, input.repo, `${base}/reviews?per_page=${REVIEWS_PAGE}`, reviewsSchema, signal),
  ]);
  if (!pull.ok) return { progress: null, error: pull.error };
  const sha = pull.value.head.sha;
  const commit = `repos/${input.repo}/commits/${sha}`;
  const [status, checks] = await Promise.all([
    api(input.forge, input.repo, `${commit}/status`, combinedStatusSchema, signal),
    api(input.forge, input.repo, `${commit}/check-runs?per_page=100`, checkRunsSchema, signal),
  ]);

  // Each reviewer's latest standing verdict; comments leave it as it was, a dismissal clears it.
  const author = pull.value.user?.id ?? null;
  const verdicts = new Map<number, string>();
  for (const review of reviews.ok ? reviews.value : []) {
    const id = review.user?.id;
    if (id === undefined || id === author) continue;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") verdicts.set(id, review.state);
    else if (review.state === "DISMISSED") verdicts.delete(id);
  }
  const standing = [...verdicts.values()];

  const failing: string[] = [];
  let running = false;
  let any = false;
  if (status.ok && (status.value.total_count ?? status.value.statuses?.length ?? 0) > 0) {
    any = true;
    for (const entry of status.value.statuses ?? []) {
      if (entry.state === "failure" || entry.state === "error") failing.push(entry.context);
      else if (entry.state === "pending") running = true;
    }
  }
  for (const check of checks.ok ? checks.value.check_runs : []) {
    if (input.forge === "delta" && check.name === DELTA_REVIEW_GATE) continue;
    any = true;
    if (check.status !== "completed") running = true;
    else if (check.conclusion && FAILED_CONCLUSIONS[check.conclusion]) failing.push(check.name);
  }
  const ci: ForgePrProgress["ci"] = failing.length > 0 ? "failure" : running ? "pending" : any ? "success" : "none";

  return {
    progress: {
      headSha: sha,
      mergeState: pull.value.mergeable_state ?? null,
      approvals: standing.filter((state) => state === "APPROVED").length,
      changesRequested: standing.filter((state) => state === "CHANGES_REQUESTED").length,
      pendingReviewers: (pull.value.requested_reviewers?.length ?? 0) + (pull.value.requested_teams?.length ?? 0),
      ci,
      failing: [...new Set(failing)].slice(0, 3),
    },
    // Without reviews or CI the verdict is a guess; say why so the list header can.
    error: !reviews.ok ? reviews.error : !status.ok ? status.error : !checks.ok ? checks.error : null,
  };
}
