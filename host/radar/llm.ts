// Anthropic Messages API via Shopify AI Proxy, using native JSON-schema structured output.
import { CONFIG } from "./config";
import { delay, safeMessage, throwIfAborted, token, withTimeout } from "./runtime";

const ENDPOINT = "https://proxy.shopify.ai/apis/anthropic/v1/messages";
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000];
const MAX_CONCURRENT = 4;

export interface StructuredRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/** Structured output requires every object node to forbid extra keys. */
function strict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strict);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = strict(value);
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

function parseResponse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("AI proxy returned invalid JSON");
  }
}

export async function structured<T>(req: StructuredRequest): Promise<T> {
  const credential = await token("llm");
  const body = JSON.stringify({
    model: CONFIG.model,
    max_tokens: req.maxTokens ?? 16_000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    output_config: { format: { type: "json_schema", schema: strict(req.schema) } },
  });

  for (let attempt = 0; ; attempt++) {
    throwIfAborted();
    const response = await withTimeout(300_000, async (signal): Promise<{ ok: true; value: T } | { ok: false; status: number; detail: string }> => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body,
        signal,
      });
      if (res.ok) {
        const json = parseResponse(await res.text()) as { stop_reason: string; content: { type: string; text?: string }[] };
        if (json.stop_reason === "max_tokens") throw new Error("LLM output truncated; raise maxTokens or shrink the batch");
        const text = json.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
        return { ok: true, value: parseResponse<T>(text) };
      }
      return { ok: false, status: res.status, detail: safeMessage(await res.text()).slice(0, 500) };
    });
    if (response.ok) return response.value;
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AI proxy rejected the token (HTTP ${response.status}). Run \`dev tokens acquire\`, then retry.`);
    }
    const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
    if (!retryable || attempt >= RETRY_BACKOFF_MS.length) throw new Error(`AI proxy HTTP ${response.status}: ${response.detail}`);
    await delay(RETRY_BACKOFF_MS[attempt]);
  }
}

/** Run `fn` over fixed-size chunks, a few at a time; results keep input order. */
export async function inBatches<T, R>(items: T[], size: number, fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  const out: R[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      throwIfAborted();
      const index = next++;
      out[index] = await fn(chunks[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, chunks.length) }, worker));
  return out.flat();
}
