import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Server ↔ host contract. The host runs a small model (via `pi -p`) to label cards. */
export const hostContract = defineRpcContract({
  complete: {
    input: z
      .object({
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
});
