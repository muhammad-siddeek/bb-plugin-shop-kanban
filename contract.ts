import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
/** A pull request as a search lists it. Delta's rows carry the head commit; GitHub's need `pr_detail`. */
const forgePrSchema = z
  .object({
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
  })
  .strict();
export type ForgePr = z.infer<typeof forgePrSchema>;
const forgePrDetailSchema = z
  .object({
    headSha: z.string().nullable(),
    /** Commit of the signed-in user's latest standing review; null when they left none, or it could not be read. */
    reviewedSha: z.string().nullable(),
    /** Clipped description. */
    body: z.string(),
    additions: z.number().nullable(),
    deletions: z.number().nullable(),
    changedFiles: z.number().nullable(),
    /** The first page of changed files; `patch` is clipped, and null for lockfiles and generated dumps. */
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.string().nullable(),
          additions: z.number().nullable(),
          deletions: z.number().nullable(),
          patch: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ForgePrDetail = z.infer<typeof forgePrDetailSchema>;

/**
 * Server ↔ host contract. The host runs a small model through a pi-compatible CLI to label threads, keeps
 * the thread search index (one markdown file per thread in the plugin's host data dir, indexed by qmd),
 * reads what omp and Pi sessions spent from their transcripts, and reads and reviews pull requests through
 * the user's signed-in `dt` and `gh`.
 */
export const hostContract = defineRpcContract({
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
   * Open pull requests matching a forge search (GitHub search syntax), most recently updated first. `missing` is
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
  /** A pull request's head, size, description and a clipped diff of its first changed files. */
  pr_detail: {
    input: z.object({ forge: forgeInput, repo: repoInput, number: prNumberInput }).strict(),
    output: z.object({ detail: forgePrDetailSchema.nullable(), error: z.string().nullable() }).strict(),
  },
  /** Approve, or request changes with `body` as the reason, as the CLI's signed-in user. */
  pr_review: {
    input: z
      .object({
        forge: forgeInput,
        repo: repoInput,
        number: prNumberInput,
        verdict: z.enum(["approve", "request_changes"]),
        body: z.string().max(10_000),
      })
      .strict(),
    output: z.object({ error: z.string().nullable() }).strict(),
  },
});
