import { CONFIG } from "./config";
import { retry, safeMessage, throwIfAborted, token, withTimeout } from "./runtime";

const ENDPOINT = "https://proxy.shopify.ai/apis/anthropic/v1/messages";
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000];
const MAX_CONCURRENT = 4;

class ProxyError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`AI proxy HTTP ${status}: ${detail}`);
  }
}

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

export async function structured<T>(req: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<T> {
  const credential = await token("llm");
  const body = JSON.stringify({
    model: CONFIG.model,
    max_tokens: req.maxTokens ?? 16_000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    output_config: { format: { type: "json_schema", schema: strict(req.schema) } },
  });
  return retry(
    RETRY_BACKOFF_MS,
    (error) => error instanceof ProxyError && (error.status === 429 || error.status === 529 || error.status >= 500),
    () =>
      withTimeout(300_000, async (signal) => {
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
        if (res.status === 401 || res.status === 403) {
          throw new Error(`AI proxy rejected the token (HTTP ${res.status}). Run \`dev tokens acquire\`, then retry.`);
        }
        if (!res.ok) throw new ProxyError(res.status, safeMessage(await res.text()).slice(0, 500));
        const json = parseResponse<{ stop_reason: string; content: { type: string; text?: string }[] }>(await res.text());
        if (json.stop_reason === "max_tokens") throw new Error("LLM output truncated; raise maxTokens or shrink the batch");
        return parseResponse<T>(json.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""));
      }),
  );
}

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

export function bySize<T>(items: T[], size: (item: T) => number, limit: number): T[][] {
  const out: T[][] = [];
  let used = Infinity;
  for (const item of items) {
    if (used + size(item) > limit) {
      out.push([]);
      used = 0;
    }
    out[out.length - 1].push(item);
    used += size(item);
  }
  return out;
}

export async function foldUpdates<T extends { id: string }>(req: {
  system: string;
  prior: T[];
  sections: string[];
  user: (current: T[], batch: string[]) => string;
  item: Record<string, unknown>;
}): Promise<T[]> {
  const schema = {
    type: "object",
    required: ["upserts", "removed"],
    properties: { upserts: { type: "array", items: req.item }, removed: { type: "array", items: { type: "string" } } },
  };
  let current = req.prior;
  for (const batch of bySize(req.sections, (section) => section.length, CONFIG.updateBatchChars)) {
    const out = await structured<{ upserts: T[]; removed: string[] }>({ system: req.system, user: req.user(current, batch), schema });
    const removed = new Set(out.removed);
    const byId = new Map(current.filter((it) => !removed.has(it.id)).map((it) => [it.id, it]));
    for (const it of out.upserts) byId.set(it.id, it);
    current = [...byId.values()];
  }
  return current;
}
