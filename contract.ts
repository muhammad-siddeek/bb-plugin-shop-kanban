import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { radarActionSchema, radarDigestSchema, radarRankItemSchema, radarRankingSchema } from "./server/radar-schema";

const commandInput = z.string().trim().min(1).max(200);
const threadIdInput = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** An omp session id (a UUID), as its transcript file names carry it. */
export const sessionIdInput = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** A Pi session's bb provider thread id, limited to what bb's bridge keeps as is when it names the transcript. */
export const piSessionIdInput = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/);
/**
 * What a session spent, in USD. `estimated` is the part of `amount` for replies saved without a price, priced at
 * the average rates the same provider and model charged across the host's other transcripts.
 */
const spendsOutput = z.object({ spends: z.record(z.string(), z.object({ amount: z.number(), estimated: z.number() }).strict()) }).strict();

/** A pull request host: Delta (shop/world, through `dt`) or GitHub (through `gh`). */
export const forgeInput = z.enum(["delta", "github"]);
export type Forge = z.infer<typeof forgeInput>;
const repoInput = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const prNumberInput = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** A pull request or issue as a search lists it. Delta's pull request rows carry the head commit; GitHub's don't. */
const forgePrSchema = z
  .object({
    kind: z.enum(["pr", "issue"]),
    repo: z.string(),
    number: z.number(),
    title: z.string(),
    url: z.string(),
    /** Display name: a bot's brand, or the login without its email domain or `[bot]` suffix. */
    author: z.string(),
    bot: z.boolean(),
    draft: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    labels: z.array(z.string()),
    headSha: z.string().nullable(),
    /** When the pull request merged; null while open, for one closed unmerged, and for issues. */
    mergedAt: z.string().nullable(),
  })
  .strict();
export type ForgePr = z.infer<typeof forgePrSchema>;
/**
 * Where an open pull request stands: its merge state as the forge reports it (`clean`, `blocked`, `dirty`, `behind`,
 * `unstable`, `unknown`...), the reviewers' latest standing verdicts, reviews still requested, and CI on its head.
 */
const forgePrProgressSchema = z
  .object({
    headSha: z.string(),
    mergeState: z.string().nullable(),
    /** Reviewers other than the author whose latest standing review approves, or requests changes. */
    approvals: z.number(),
    changesRequested: z.number(),
    /** Users and teams whose review is still requested. */
    pendingReviewers: z.number(),
    /** Commit statuses and check runs on the head together: any failure wins, then anything still running. */
    ci: z.enum(["success", "failure", "pending", "none"]),
    /** Names of up to three failing checks. */
    failing: z.array(z.string()),
  })
  .strict();
export type ForgePrProgress = z.infer<typeof forgePrProgressSchema>;

/**
 * A River session or Torrent ticket the user is part of that is live: an agent working it (`wip`), or it waiting on
 * the user (`blocked`).
 */
export const remoteItemSchema = z
  .object({
    /** `torrent:<ticket id>` or `river:<session id>` */
    id: z.string(),
    source: z.enum(["torrent", "river"]),
    /** The ticket's key (`EXP-203`), or `River`. */
    key: z.string(),
    title: z.string(),
    /** The ticket on Torrent, or the session's Slack thread. */
    url: z.string(),
    status: z.enum(["wip", "blocked"]),
    /** Torrent's state name (`In Progress`, `Human Review`) or Aquifer's session status (`running`). */
    detail: z.string(),
    updatedAt: z.string(),
    /** What the ticket's agent sessions spent, in USD; null when unknown (always, for River). */
    cost: z.number().nullable(),
  })
  .strict();
export type RemoteItem = z.infer<typeof remoteItemSchema>;
/** How one remote source's read went; `missing` when it can't work here (no gcloud, signed out, not a Shopify account). */
export const remoteSourceSchema = z.object({ source: remoteItemSchema.shape.source, error: z.string().nullable(), missing: z.boolean() }).strict();
export type RemoteSource = z.infer<typeof remoteSourceSchema>;

/**
 * Server ↔ host contract. The host runs a small model through a pi-compatible CLI to label threads, keeps
 * the thread search index (one markdown file per thread in the plugin's host data dir, indexed by qmd),
 * reads what omp and Pi sessions spent from their transcripts, reads and reviews pull requests through
 * the user's signed-in `dt` and `gh`, and reads the user's live River sessions and Torrent tickets with their gcloud
 * identity.
 */
export const hostContract = defineRpcContract({
  radar_snapshot: { input: z.object({}).strict(), output: z.object({ digest: radarDigestSchema.nullable(), dataDir: z.string() }) },
  radar_import: { input: z.object({ source: z.string().min(1) }).strict(), output: z.object({ digest: radarDigestSchema.nullable(), dataDir: z.string() }) },
  radar_execute: { input: radarActionSchema, output: z.object({ digest: radarDigestSchema.nullable(), text: z.string() }) },
  radar_rank: { input: z.object({ items: z.array(radarRankItemSchema) }).strict(), output: radarRankingSchema },
  complete: {
    input: z
      .object({
        command: commandInput,
        system: z.string().max(8_000),
        prompt: z.string().max(60_000),
        models: z.array(z.string().min(1)).min(1).max(4),
        timeoutMs: z.number().int().min(1_000).max(25_000),
      })
      .strict(),
    output: z
      .object({
        text: z.string().nullable(),
        model: z.string().nullable(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  /**
   * Point qmd's collection at the exported thread files (adding it indexes them), then list which threads have
   * a file. Lets the server notice a wiped qmd index or data dir instead of trusting its own bookkeeping.
   */
  index_status: {
    input: z.object({ command: commandInput }).strict(),
    output: z.object({ threadIds: z.array(z.string()), error: z.string().nullable() }).strict(),
  },
  /** Write and delete thread files, then re-index the collection. */
  index_write: {
    input: z
      .object({
        command: commandInput,
        docs: z.array(z.object({ threadId: threadIdInput, markdown: z.string().max(200_000) }).strict()).max(50),
        remove: z.array(threadIdInput).max(1_000),
      })
      .strict(),
    output: z.object({ error: z.string().nullable() }).strict(),
  },
  /** BM25 search over the threads collection; one hit per thread, best first. */
  index_search: {
    input: z.object({ command: commandInput, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50) }).strict(),
    output: z
      .object({
        hits: z.array(z.object({ threadId: z.string(), title: z.string().nullable(), snippet: z.string().nullable() }).strict()),
        error: z.string().nullable(),
      })
      .strict(),
  },
  /**
   * What omp sessions spent, read from their transcripts on this host: each session's own model calls plus every
   * subagent transcript nested under it, at any depth, in USD. Sessions without a transcript here are left out.
   */
  omp_spend: {
    input: z.object({ sessionIds: z.array(sessionIdInput).min(1).max(500) }).strict(),
    output: spendsOutput,
  },
  /**
   * What Pi sessions spent, read from the transcripts bb's Pi bridge keeps on this host, in USD. Sessions without
   * a transcript here are left out.
   */
  pi_spend: {
    input: z.object({ sessionIds: z.array(piSessionIdInput).min(1).max(500) }).strict(),
    output: spendsOutput,
  },
  /**
   * Pull requests or issues matching a forge search (GitHub search syntax), most recently updated first. `missing` is
   * true when the forge's CLI is not installed or not signed in on this host. Delta searches one repository, so it
   * needs `repo`.
   */
  pr_search: {
    input: z
      .object({
        forge: forgeInput,
        repo: repoInput.nullable(),
        query: z.string().trim().min(1).max(1_000),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    output: z
      .object({ prs: z.array(forgePrSchema), total: z.number(), error: z.string().nullable(), missing: z.boolean() })
      .strict(),
  },
  /** Where an open pull request stands: merge state, review verdicts and CI on its head. */
  pr_progress: {
    input: z.object({ forge: forgeInput, repo: repoInput, number: prNumberInput }).strict(),
    output: z.object({ progress: forgePrProgressSchema.nullable(), error: z.string().nullable() }).strict(),
  },
  /** The user's live Torrent tickets and the River sessions they have spoken in this week that are live. */
  remote_work: {
    input: z.object({}).strict(),
    output: z.object({ items: z.array(remoteItemSchema), sources: z.array(remoteSourceSchema) }).strict(),
  },
});
