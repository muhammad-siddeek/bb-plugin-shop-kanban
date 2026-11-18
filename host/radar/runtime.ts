import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";

export interface RadarContext {
  dataDir: string;
  signal: AbortSignal;
}

type TokenKind = "gateway" | "llm";
interface Runtime extends RadarContext {
  tokens: Map<TokenKind, Promise<string>>;
  inherited: Record<TokenKind, string | undefined>;
  devBin: string | undefined;
  shell: string;
  secrets: Set<string>;
}

const storage = new AsyncLocalStorage<Runtime>();
const execFileAsync = promisify(execFile);
const queues = new Map<string, Promise<void>>();

function runtime(): Runtime {
  const current = storage.getStore();
  if (!current) throw new Error("Radar requires an executeRadar invocation context");
  return current;
}

export const radarPath = (name: string): string => join(runtime().dataDir, name);
export const radarSignal = (): AbortSignal => runtime().signal;
export const throwIfAborted = (): void => radarSignal().throwIfAborted();

export function safeMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of storage.getStore()?.secrets ?? []) message = message.split(secret).join("[REDACTED]");
  return message
    .replace(/https:\/\/hooks\.slack\.com\/(?:triggers|services)\/[^\s\"'<>]+/gi, "[REDACTED Slack webhook]")
    .replace(/\bbearer\s+[^\s\"'<>]+/gi, "Bearer [REDACTED]");
}

export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const parent = radarSignal();
  parent.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Radar request timed out")), ms);
  timer.unref?.();
  try {
    const value = await fn(controller.signal);
    controller.signal.throwIfAborted();
    return value;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  }
}

export function delay(ms: number): Promise<void> {
  const signal = radarSignal();
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, ms);
  signal.addEventListener("abort", abort, { once: true });
  return promise;
}

export async function retry<T>(backoff: number[], retryable: (error: unknown) => boolean, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      throwIfAborted();
      if (attempt >= backoff.length || !retryable(error)) throw error;
      await delay(backoff[attempt]);
    }
  }
}

function secretCommand(file: string, args: string[], failure: string): Promise<string> {
  return withTimeout(30_000, async (signal) => {
    try {
      const { stdout } = await execFileAsync(file, args, {
        cwd: homedir(),
        encoding: "utf8",
        maxBuffer: 1_000_000,
        signal,
        windowsHide: true,
      });
      signal.throwIfAborted();
      return stdout.trim();
    } catch {
      signal.throwIfAborted();
      throw new Error(failure);
    }
  });
}

export function token(kind: TokenKind): Promise<string> {
  const current = runtime();
  current.signal.throwIfAborted();
  let pending = current.tokens.get(kind);
  if (!pending) {
    pending = (async () => {
      const service = kind === "gateway" ? "tool_gateway/personal" : "llm_gateway/personal";
      let value = current.inherited[kind]?.trim();
      if (!value) {
        const failure = "Radar could not load a dev token. Run `dev tokens acquire`, then retry; RADAR_DEV_BIN can select the dev executable.";
        value = current.devBin
          ? await secretCommand(current.devBin, ["tokens", "get", service], failure)
          : await secretCommand(current.shell, ["-lc", `exec dev tokens get ${service}`], failure);
      }
      if (!value) throw new Error("Radar dev token is empty. Run `dev tokens acquire`, then retry.");
      current.secrets.add(value);
      return value;
    })();
    current.tokens.set(kind, pending);
  }
  return pending;
}

function storeKey(context: RadarContext): string {
  if (!isAbsolute(context.dataDir)) throw new Error("Radar dataDir must be an absolute plugin storage path");
  return normalize(context.dataDir);
}

export async function withRadarContext<T>(context: RadarContext, fn: () => Promise<T>): Promise<T> {
  const dataDir = storeKey(context);
  context.signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener("abort", abort, { once: true });
  const inherited = { gateway: process.env.TOOL_GATEWAY_TOKEN, llm: process.env.LLM_PROXY_TOKEN };
  const current: Runtime = {
    dataDir,
    signal: controller.signal,
    inherited,
    devBin: process.env.RADAR_DEV_BIN,
    shell: process.env.SHELL || "/bin/zsh",
    tokens: new Map(),
    secrets: new Set(Object.values(inherited).filter((value): value is string => Boolean(value))),
  };
  try {
    return await storage.run(current, async () => {
      try {
        return await fn();
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    });
  } finally {
    context.signal.removeEventListener("abort", abort);
  }
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  void previous.then(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  });
  return promise;
}

export async function serializeRadar<T>(context: RadarContext, fn: () => Promise<T>): Promise<T> {
  const key = storeKey(context);
  const previous = queues.get(key) ?? Promise.resolve();
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const queued = previous.then(() => held);
  queues.set(key, queued);
  try {
    await waitForTurn(previous, context.signal);
    return await withRadarContext(context, fn);
  } finally {
    release();
    void queued.then(() => {
      if (queues.get(key) === queued) queues.delete(key);
    });
  }
}
