// Tool Gateway code-mode client: runs a TypeScript program against Slack/Vault/GitHub backends.
import { delay, safeMessage, throwIfAborted, token, withTimeout } from "./runtime";

const ENDPOINT = "https://tool-gateway.shopify.io/codemode/mcp";
const RETRY_BACKOFF_MS = [15_000, 45_000, 90_000];

export class GatewayError extends Error {
  kind: "auth" | "ratelimit" | "transient" | "tool" | "http";
  constructor(kind: GatewayError["kind"], message: string) {
    super(safeMessage(message));
    this.kind = kind;
  }
}

let rpcId = 0;

/** The gateway reports backend failures either as a JSON-RPC error or as an `isError` result; classify both alike. */
function failure(text: string): GatewayError {
  text = safeMessage(text);
  if (/rate_?limit|rate limit|\b429\b/i.test(text)) return new GatewayError("ratelimit", text.slice(0, 300));
  // Vault refresh/reconnect races and temporary backend connection failures are safe to retry.
  if (/(please|safe to) retry|error executing tool: fetch failed/i.test(text)) return new GatewayError("transient", text.slice(0, 300));
  if (/not_authed|invalid_auth|token_expired|unauthori[sz]ed|reconnect slack/i.test(text)) {
    return new GatewayError("auth", text.slice(0, 300));
  }
  return new GatewayError("tool", text.slice(0, 1500));
}

function parseResponse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Native JSON errors can quote response fragments containing credentials.
    throw new GatewayError("http", "Tool Gateway returned invalid JSON");
  }
}

async function callOnce(code: string): Promise<string> {
  const credential = await token("gateway");
  return withTimeout(180_000, async (signal) => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name: "code_mode_execute", arguments: { code } },
      }),
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new GatewayError("auth", `Tool Gateway rejected the token (HTTP ${res.status}). Run \`dev tokens acquire\`, then retry.`);
    }
    if (res.status === 429) throw new GatewayError("ratelimit", "HTTP 429");
    if (!res.ok) throw new GatewayError("http", `Tool Gateway HTTP ${res.status}: ${safeMessage(await res.text()).slice(0, 300)}`);

    const raw = await res.text();
    // Streamable HTTP may answer as SSE; take the last JSON-RPC payload.
    const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).pop() ?? ""
      : raw;
    const body = parseResponse(payload) as {
      error?: { message: string };
      result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    };
    if (body.error) throw failure(body.error.message);
    const text = (body.result?.content ?? []).map((part) => part.text ?? "").join("");
    if (body.result?.isError || text.startsWith("Error:")) throw failure(text);
    return text;
  });
}

// The gateway's bearer redactor can swallow the escaping quote in serialized Slack text. Scrub each
// result string before it reaches that redactor, keeping the returned JSON parseable.
// `Json` is the gateway's ambient type for program results.
const SCRUB_PRELUDE = `
function scrubResult(v: unknown): Json {
  if (typeof v === 'string') return v.replace(/bearer\\s+[^\\s"]*/gi, '[REDACTED]');
  if (Array.isArray(v)) return v.map(scrubResult);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubResult(x)]));
  return v as Json;
}`;

/** Run a code-mode program and parse its JSON return value. Retry only rate limits and transient backend errors. */
export async function runCode<T>(code: string): Promise<T> {
  const program = `${SCRUB_PRELUDE}
return scrubResult(await (async () => {
${code}
})());`;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted();
    try {
      const text = await callOnce(program);
      return parseResponse<T>(text);
    } catch (error) {
      throwIfAborted();
      const retryable = error instanceof GatewayError && (error.kind === "ratelimit" || error.kind === "transient");
      if (!retryable || attempt >= RETRY_BACKOFF_MS.length) throw error;
      await delay(RETRY_BACKOFF_MS[attempt]);
    }
  }
}

/** Embed a JS value as a literal inside a code-mode program. */
export const lit = (value: unknown): string => JSON.stringify(value);
