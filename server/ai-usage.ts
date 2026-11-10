// Shopify AI proxy spend for the signed-in user, read from the proxy's own per-user counter
// (GET https://proxy.shopify.ai/apis/proxy/v1/usage.json), so it covers every tool on the proxy, not just bb threads.
//
// Auth: a personal proxy key. One from the environment (SHOPIFY_PROXY_KEY / PI_PROXY_API_KEY) when the bb server has
// it; otherwise minted like the proxy's own CLIs do: a gcloud identity token exchanged at /hmac/personal.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AiUsage } from "./schema";

const USAGE_URL = "https://proxy.shopify.ai/apis/proxy/v1/usage.json";
const HMAC_URL = "https://proxy.shopify.io/hmac/personal";
/** The proxy's counter is precomputed; once a minute is plenty, and every open board shares the read. */
const CACHE_MS = 60_000;
/** After a failure, wait this long before trying again rather than hammering gcloud and the proxy. */
const ERROR_CACHE_MS = 30_000;
/** Minted keys carry an expiry; without one, mint again after this long. */
const KEY_FALLBACK_TTL_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GCLOUD_TIMEOUT_MS = 15_000;
const TOP_MODELS = 5;

const GCLOUD_CANDIDATES = [
  "gcloud",
  `${homedir()}/.local/state/tec/toolchain/base_profile/bin/gcloud`,
  "/opt/homebrew/bin/gcloud",
  "/usr/local/bin/gcloud",
  `${homedir()}/google-cloud-sdk/bin/gcloud`,
];

type Key = { value: string; expiresAt: number; fromEnv: boolean };

type ModelEntry = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  cache_write_tokens?: number;
  cost?: number;
};
type UsageResponse = {
  timezone?: string;
  totals?: { hour_cost?: number; today_cost?: number; seven_days_cost?: number };
  today?: Record<string, ModelEntry>;
  pricing_stale?: boolean;
};

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: GCLOUD_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) =>
        resolve(error ? null : stdout.trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

async function gcloudIdentityToken(): Promise<string> {
  for (const bin of GCLOUD_CANDIDATES) {
    const token = await run(bin, ["auth", "print-identity-token"]);
    if (token) return token;
  }
  throw new Error("No gcloud identity token. Run `gcloud auth login` on the bb machine.");
}

/** `shopify-<base64 json with expiry>-<sig>`: the expiry in ms, if it decodes and is still ahead. */
function keyExpiry(key: string): number | null {
  try {
    const payload = key.match(/^shopify-([^-]+)-/)?.[1];
    if (!payload) return null;
    const { expiry } = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { expiry?: unknown };
    return typeof expiry === "number" && expiry * 1000 > Date.now() ? expiry * 1000 : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function mintKey(): Promise<Key> {
  const idToken = await gcloudIdentityToken();
  const response = await fetchWithTimeout(HMAC_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Shopify AI proxy sign-in failed (${response.status}).`);
  const { key } = (await response.json()) as { key?: unknown };
  if (typeof key !== "string" || !key) throw new Error("Shopify AI proxy sign-in returned no key.");
  return { value: key, expiresAt: keyExpiry(key) ?? Date.now() + KEY_FALLBACK_TTL_MS, fromEnv: false };
}

function envKey(): Key | null {
  const value = process.env.SHOPIFY_PROXY_KEY || process.env.PI_PROXY_API_KEY;
  return value ? { value, expiresAt: Infinity, fromEnv: true } : null;
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toUsage(body: UsageResponse, sampledAt: number): AiUsage {
  const models = Object.entries(body.today ?? {}).map(([name, entry]) => ({
    name,
    cost: num(entry.cost),
    inputTokens: num(entry.input_tokens),
    cachedInputTokens: num(entry.cached_input_tokens),
    outputTokens: num(entry.output_tokens),
    cacheWriteTokens: num(entry.cache_write_tokens),
  }));
  const sum = (pick: (model: (typeof models)[number]) => number) => models.reduce((total, model) => total + pick(model), 0);
  return {
    sampledAt,
    timezone: body.timezone ?? "UTC",
    todayCost: num(body.totals?.today_cost),
    hourCost: num(body.totals?.hour_cost),
    sevenDaysCost: num(body.totals?.seven_days_cost),
    todayTokens: {
      input: sum((model) => model.inputTokens),
      cachedInput: sum((model) => model.cachedInputTokens),
      output: sum((model) => model.outputTokens),
      cacheWrite: sum((model) => model.cacheWriteTokens),
    },
    topModels: models
      .filter((model) => model.cost > 0 || model.inputTokens > 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, TOP_MODELS)
      .map(({ name, cost, inputTokens, outputTokens }) => ({ name, cost, tokens: inputTokens + outputTokens })),
    pricingStale: body.pricing_stale === true,
    error: null,
  };
}

export function createAiUsage(bb: BbPluginApi) {
  let key: Key | null = null;
  let envKeyRejected = false;
  let cached: { at: number; value: AiUsage } | null = null;
  let pending: Promise<AiUsage> | null = null;

  async function currentKey(forceMint: boolean): Promise<Key> {
    if (!forceMint && key && key.expiresAt > Date.now() + 60_000) return key;
    const fromEnv = envKeyRejected ? null : envKey();
    key = !forceMint && fromEnv ? fromEnv : await mintKey();
    return key;
  }

  async function request(): Promise<AiUsage> {
    const url = `${USAGE_URL}?tz=${encodeURIComponent(localTimezone())}`;
    for (const retry of [false, true]) {
      const { value, fromEnv } = await currentKey(retry);
      const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${value}`, Accept: "application/json" } });
      if (response.status === 401 || response.status === 403) {
        // A stale environment key or an expired minted one: mint a fresh key once.
        if (fromEnv) envKeyRejected = true;
        key = null;
        if (!retry) continue;
      }
      if (!response.ok) throw new Error(`Shopify AI proxy usage failed (${response.status}).`);
      return toUsage((await response.json()) as UsageResponse, Date.now());
    }
    throw new Error("Shopify AI proxy rejected the key.");
  }

  return {
    read(): Promise<AiUsage> {
      const now = Date.now();
      if (cached && now - cached.at < (cached.value.error ? ERROR_CACHE_MS : CACHE_MS)) return Promise.resolve(cached.value);
      pending ??= request()
        .catch((error: unknown): AiUsage => {
          const message = error instanceof Error ? error.message : String(error);
          bb.log.warn(`ai usage read failed: ${message}`);
          // Keep the last good figures, flagged with the error, so a blip doesn't blank the chip.
          const last = cached?.value;
          return last
            ? { ...last, error: message }
            : {
                sampledAt: Date.now(),
                timezone: localTimezone(),
                todayCost: null,
                hourCost: null,
                sevenDaysCost: null,
                todayTokens: null,
                topModels: [],
                pricingStale: false,
                error: message,
              };
        })
        .then((value) => {
          cached = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
