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

/**
 * Server ↔ host contract. The host runs a small model through a pi-compatible CLI to label threads, keeps
 * the thread search index (one markdown file per thread in the plugin's host data dir, indexed by qmd),
 * and reads what omp and Pi sessions spent from their transcripts.
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
});
