import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";
import { GatewayError, runCode } from "../../host/radar/gateway";
import { withRadarContext } from "../../host/radar/runtime";

const executeCode = <T>(code: string): Promise<T> => withRadarContext(
  { dataDir: tmpdir(), signal: new AbortController().signal },
  () => runCode<T>(code),
);

const RATE_LIMITED =
  'Code exited with a non-zero status (exit_code=1).\n\nstderr:\nError: {"ok":false,"error":"rate_limited","status":429,"retry_after":"10"}';

const rpc = (body: object) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), { headers: { "Content-Type": "application/json" } });

let replies: Response[] = [];
let calls = 0;
const realFetch = globalThis.fetch;
const realToken = process.env.TOOL_GATEWAY_TOKEN;

beforeEach(() => {
  calls = 0;
  process.env.TOOL_GATEWAY_TOKEN = "test";
  globalThis.fetch = async () => {
    calls++;
    const next = replies.shift();
    if (!next) throw new Error("unexpected extra gateway call");
    return next;
  };
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.TOOL_GATEWAY_TOKEN;
  else process.env.TOOL_GATEWAY_TOKEN = realToken;
});

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(90_000);
  }
  return p;
}

test("runCode retries a Slack rate limit reported as a JSON-RPC error", async () => {
  replies = [
    rpc({ error: { code: -32000, message: RATE_LIMITED } }),
    rpc({ result: { content: [{ type: "text", text: '{"ok":1}' }] } }),
  ];
  assert.deepEqual(await settle(executeCode("return 1;")), { ok: 1 });
  assert.equal(calls, 2);
});

test("runCode fails fast on an auth failure reported as a JSON-RPC error", async () => {
  replies = [rpc({ error: { code: -32000, message: "Error: not_authed" } })];
  await assert.rejects(settle(executeCode("return 1;")), (e) => e instanceof GatewayError && e.kind === "auth");
  assert.equal(calls, 1);
});

test("runCode survives gateway redaction of bearer tokens in program results", async () => {
  globalThis.fetch = async (_url, init) => {
    const { params } = JSON.parse(String(init?.body)) as { params: { arguments: { code: string } } };
    const program = new Function(`return ${stripTypeScriptTypes(`(async () => {${params.arguments.code}})()`)}`);
    const text = JSON.stringify(await program()).replace(/bearer +[^\s"]+/gi, "Bearer [REDACTED]");
    return rpc({ result: { content: [{ type: "text", text }] } });
  };
  const msg = 'try:\ncurl -H "Authorization: Bearer $OPENAI_API_KEY" \\\n  https://proxy.shopify.ai/v1/responses';
  const got = await executeCode<{ text: string }[]>(`return [{ text: ${JSON.stringify(msg)} }, { text: 'after' }];`);
  assert.deepEqual(got, [
    { text: 'try:\ncurl -H "Authorization: [REDACTED]" \\\n  https://proxy.shopify.ai/v1/responses' },
    { text: "after" },
  ]);
});
