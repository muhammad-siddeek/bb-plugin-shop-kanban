import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const commandInput = z.string().trim().min(1).max(200);
const threadIdInput = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * Server ↔ host contract. The host runs a small model through a pi-compatible CLI to label threads, and keeps
 * the thread search index: one markdown file per thread in the plugin's host data dir, indexed by qmd.
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
});
