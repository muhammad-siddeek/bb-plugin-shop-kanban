// Shopify AI proxy spend for the signed-in user, read from the proxy's own per-user counter
// (GET https://proxy.shopify.ai/apis/proxy/v1/usage.json), so it covers every tool on the proxy, not just bb threads.
//
// Auth: a personal proxy key. One from the environment (SHOPIFY_PROXY_KEY / PI_PROXY_API_KEY) when the bb server has
// it; otherwise minted like the proxy's own CLIs do: a gcloud identity token exchanged at /hmac/personal.
//
// Only Shopify credentials ever leave the machine: an environment key must be a Shopify proxy key, and a token is
// minted only for a gcloud account on shopify.com. Anyone else gets no chip and no requests beyond a local check.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AiUsage } from "./schema";
import { errorMessage, safe } from "./text";

const USAGE_URL = "https://proxy.shopify.ai/apis/proxy/v1/usage.json";
const HMAC_URL = "https://proxy.shopify.io/hmac/personal";
/** The proxy's counter is precomputed; once a minute is plenty, and every open board shares the read. */
const CACHE_MS = 60_000;
/** After a failure, wait this long before trying again rather than hammering gcloud and the proxy. */
const ERROR_CACHE_MS = 30_000;
/** Without Shopify credentials, check again this rarely: the user may sign in later. */
const NO_ACCOUNT_CACHE_MS = 60 * 60_000;
/** The prefix every Shopify proxy key carries (`shopify-<payload>-<sig>`); keys for any other proxy don't. */
const SHOPIFY_KEY_PREFIX = "shopify-";
const SHOPIFY_ACCOUNT = /@shopify\.com$/iu;
/** Minted keys carry an expiry; without one, mint again after this long. */
const KEY_FALLBACK_TTL_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GCLOUD_TIMEOUT_MS = 15_000;
/**
 * The proxy reports today and a "seven days" total (really today plus the 7 days before it) but no per-day figures.
 * The 7-day graph takes past days from the data warehouse's hourly rollup of proxy spend (the layer tokentally reads),
 * cut at local midnight, with today from the proxy. The rollup lands about 90 minutes behind, so the server also
 * records each day's last proxy reading, and a day shows whichever is higher: yesterday is whole just after midnight.
 * Read in the background too, so days are recorded while no board is open.
 */
const DAYS_KEY = "ai-spend-days-v1";
const BACKGROUND_READ_MS = 5 * 60_000;
/** The graph's days, today included. */
const GRAPH_DAYS = 7;
/** Past days are settled; rereading the warehouse more often only catches up yesterday's last hours. */
const WAREHOUSE_CACHE_MS = 30 * 60_000;
const WAREHOUSE_ERROR_CACHE_MS = 5 * 60_000;
const WAREHOUSE_TIMEOUT_MS = 60_000;
/** The first warehouse read may hold the spend read up to this long; past it the graph arrives on a later poll. */
const WAREHOUSE_FIRST_WAIT_MS = 10_000;
const WAREHOUSE_PROJECT = "shopify-dw";
/** Realtime signal that the spend read changed outside a poll (the warehouse's days landed late). */
export const AI_USAGE_CHANGED = "ai-usage-changed";
const WAREHOUSE_TABLE = "shopify-dw.mart_infrastructure_data.ai_proxy_model_hourly_aggregation";
/** Daily personal proxy spend over the local days before today. `request_date` is UTC, so it is padded a day. */
const WAREHOUSE_SQL = `
SELECT FORMAT_DATE('%F', DATE(request_hour, @tz)) AS day, SUM(total_cost_usd) AS cost
FROM \`${WAREHOUSE_TABLE}\`
WHERE mode = 'personal' AND LOWER(email) = @email
  AND request_date BETWEEN DATE_SUB(CURRENT_DATE(@tz), INTERVAL ${GRAPH_DAYS} DAY) AND DATE_ADD(CURRENT_DATE(@tz), INTERVAL 1 DAY)
  AND DATE(request_hour, @tz) BETWEEN DATE_SUB(CURRENT_DATE(@tz), INTERVAL ${GRAPH_DAYS - 1} DAY) AND DATE_SUB(CURRENT_DATE(@tz), INTERVAL 1 DAY)
GROUP BY day`;
/** Recorded days kept past the graph, so a timezone change or clock skew doesn't lose them. */
const KEEP_DAYS = 14;

const GCLOUD_CANDIDATES = [
  "gcloud",
  `${homedir()}/.local/state/tec/toolchain/base_profile/bin/gcloud`,
  "/opt/homebrew/bin/gcloud",
  "/usr/local/bin/gcloud",
  `${homedir()}/google-cloud-sdk/bin/gcloud`,
];

type Key = { value: string; expiresAt: number; fromEnv: boolean };

type UsageResponse = {
  timezone?: string;
  totals?: { hour_cost?: number; today_cost?: number; seven_days_cost?: number };
  pricing_stale?: boolean;
};

/** Run `command`, resolving to its stdout, or rejecting with the first line of what it printed about failing. */
function runOrExplain(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile(command, args, { timeout, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const said = `${stderr}\n${stdout}`.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("Waiting on"));
        reject(new Error(error.killed ? `${command} timed out` : (said ?? error.message).slice(0, 300)));
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** The same, but silent: null on any failure, for trying the next gcloud candidate. */
const run = (command: string, args: string[], timeout = GCLOUD_TIMEOUT_MS): Promise<string | null> =>
  runOrExplain(command, args, timeout).then((stdout) => stdout.trim() || null, () => null);

/** No Shopify credentials on this machine: nothing to read, so the chip stays hidden. */
class NoShopifyAccount extends Error {}

type GcloudAccount = { bin: string; account: string };

/** The first gcloud that answers, with its active account, when that account is a Shopify one. */
async function shopifyGcloud(): Promise<GcloudAccount | null> {
  for (const bin of GCLOUD_CANDIDATES) {
    const account = await run(bin, ["config", "get-value", "account"]);
    if (account === null) continue;
    return SHOPIFY_ACCOUNT.test(account) ? { bin, account: account.toLowerCase() } : null;
  }
  return null;
}

/** A gcloud identity token for the active account, only when that account is a Shopify one. */
async function gcloudIdentityToken(): Promise<string> {
  const gcloud = await shopifyGcloud();
  if (!gcloud) throw new NoShopifyAccount("No Shopify account: sign gcloud in with your shopify.com account, or set SHOPIFY_PROXY_KEY.");
  const token = await run(gcloud.bin, ["auth", "print-identity-token"]);
  if (token) return token;
  throw new Error("No gcloud identity token. Run `gcloud auth login` on the bb machine.");
}

/** Spend per local day (`YYYY-MM-DD` → USD) on the days before today, from the warehouse. */
async function warehouseDays(timezone: string): Promise<Record<string, number>> {
  const gcloud = await shopifyGcloud();
  if (!gcloud) throw new Error("No Shopify gcloud account to read the data warehouse with.");
  // bq ships beside gcloud in every SDK install.
  const bq = isAbsolute(gcloud.bin) ? join(dirname(gcloud.bin), "bq") : "bq";
  const out = await runOrExplain(
    bq,
    [
      "--headless",
      "--quiet",
      "query",
      `--project_id=${WAREHOUSE_PROJECT}`,
      "--use_legacy_sql=false",
      "--format=json",
      `--parameter=email:STRING:${gcloud.account}`,
      `--parameter=tz:STRING:${timezone}`,
      WAREHOUSE_SQL,
    ],
    WAREHOUSE_TIMEOUT_MS,
  );
  const start = out.indexOf("[");
  if (start < 0) throw new Error("bq returned no rows.");
  const rows = JSON.parse(out.slice(start)) as { day?: unknown; cost?: unknown }[];
  const days: Record<string, number> = {};
  for (const row of rows) {
    const cost = Number(row.cost);
    if (typeof row.day === "string" && Number.isFinite(cost)) days[row.day] = cost;
  }
  return days;
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
  const value = [process.env.SHOPIFY_PROXY_KEY, process.env.PI_PROXY_API_KEY].find((candidate) => candidate?.startsWith(SHOPIFY_KEY_PREFIX));
  return value ? { value, expiresAt: Infinity, fromEnv: true } : null;
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `YYYY-MM-DD` of `at` in `timeZone`. */
function dayOf(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** The `count` calendar days ending on `today` (`YYYY-MM-DD`), oldest first. */
function daysEnding(today: string, count: number): string[] {
  const end = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(end - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

/** The recorded last reading of each day (`YYYY-MM-DD` → USD spent so far that day). */
function parseDays(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [day, cost] of Object.entries(raw as Record<string, unknown>)) {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(day) && typeof cost === "number" && Number.isFinite(cost)) out[day] = cost;
  }
  return out;
}

/**
 * The graph's 7 days, today's from the proxy and the rest from the warehouse or the recorded readings, whichever
 * is higher (both only ever undercount a day). No graph unless every day is known: a gap would misdraw the week.
 */
function withDays(usage: AiUsage, warehouse: Record<string, number> | null, recorded: Record<string, number>, today: string): AiUsage {
  if (usage.todayCost === null) return usage;
  const days: { date: string; cost: number | null }[] = daysEnding(today, GRAPH_DAYS).map((date) => {
    if (date === today) return { date, cost: usage.todayCost };
    // A day the warehouse read but has no rows for had no spend.
    const fromWarehouse = warehouse ? (warehouse[date] ?? 0) : null;
    const fromRecord = recorded[date] ?? null;
    return { date, cost: fromWarehouse === null && fromRecord === null ? null : Math.max(fromWarehouse ?? 0, fromRecord ?? 0) };
  });
  if (days.some((day) => day.cost === null)) return usage;
  const complete = days as AiUsage["days"];
  return { ...usage, days: complete, weekCost: complete.reduce((total, day) => total + day.cost, 0) };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toUsage(body: UsageResponse, sampledAt: number): AiUsage {
  return {
    sampledAt,
    timezone: body.timezone ?? "UTC",
    todayCost: num(body.totals?.today_cost),
    hourCost: num(body.totals?.hour_cost),
    sevenDaysCost: num(body.totals?.seven_days_cost),
    pricingStale: body.pricing_stale === true,
    days: [],
    weekCost: null,
    daysLoading: false,
    daysError: null,
    error: null,
  };
}

export function createAiUsage(bb: BbPluginApi) {
  let key: Key | null = null;
  let envKeyRejected = false;
  let cached: { at: number; value: AiUsage; ttl: number } | null = null;
  let pending: Promise<AiUsage> | null = null;
  let recorded: Promise<Record<string, number>> | null = null;
  let recordWrite: Promise<unknown> = Promise.resolve();

  let warehouse: { at: number; timezone: string; days: Record<string, number> | null; error: string | null } | null = null;
  let warehousePending: Promise<Record<string, number> | null> | null = null;

  /**
   * The warehouse's past days: the last read straight away (refreshing it in the background once stale), or on the
   * first read, up to WAREHOUSE_FIRST_WAIT_MS of waiting for it. A read that lands later expires the spend cache and
   * signals AI_USAGE_CHANGED, so open boards read again at once.
   */
  async function readWarehouse(timezone: string): Promise<Record<string, number> | null> {
    const last = warehouse?.timezone === timezone ? warehouse : null;
    if (last && Date.now() - last.at < (last.days ? WAREHOUSE_CACHE_MS : WAREHOUSE_ERROR_CACHE_MS)) return last.days;
    warehousePending ??= warehouseDays(timezone)
      .then(
        (days) => ({ days, error: null }),
        (error: unknown) => {
          const message = errorMessage(error);
          bb.log.warn(`ai usage: warehouse daily read failed: ${message}`);
          return { days: null, error: message };
        },
      )
      .then(({ days, error }) => {
        // A failed reread keeps the last good days.
        warehouse = { at: Date.now(), timezone, days: days ?? (last?.days ?? null), error };
        if (cached) cached.at = 0;
        bb.realtime.publish(AI_USAGE_CHANGED, { at: Date.now() });
        return warehouse.days;
      })
      .finally(() => {
        warehousePending = null;
      });
    // A stale read serves its days while the refresh runs; only a first read is worth waiting for.
    if (last) return last.days;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), WAREHOUSE_FIRST_WAIT_MS).unref?.());
    return Promise.race([warehousePending, timeout]);
  }

  const loadDays = () => (recorded ??= safe(() => bb.storage.kv.get<unknown>(DAYS_KEY)).then(parseDays));

  /** Record `cost` as `day`'s spend so far (a day's spend only grows) and drop days long past. */
  async function recordDay(day: string, cost: number): Promise<Record<string, number>> {
    const days = await loadDays();
    if ((days[day] ?? -1) >= cost) return days;
    days[day] = cost;
    const oldest = daysEnding(day, KEEP_DAYS)[0]!;
    for (const past of Object.keys(days)) if (past < oldest) delete days[past];
    recordWrite = recordWrite.then(() => safe(() => bb.storage.kv.set(DAYS_KEY, days)));
    return days;
  }

  async function currentKey(forceMint: boolean): Promise<Key> {
    if (!forceMint && key && key.expiresAt > Date.now() + 60_000) return key;
    const fromEnv = envKeyRejected ? null : envKey();
    key = !forceMint && fromEnv ? fromEnv : await mintKey();
    return key;
  }

  async function request(): Promise<AiUsage> {
    const timezone = localTimezone();
    const day = dayOf(Date.now(), timezone);
    const [usage, pastDays] = await Promise.all([requestUsage(timezone), readWarehouse(timezone)]);
    // A read that straddled midnight can't tell which day its "today" was: graph it, but don't record it.
    const recordedDays = dayOf(Date.now(), timezone) === day && usage.todayCost !== null ? await recordDay(day, usage.todayCost) : await loadDays();
    const graphed = withDays(usage, pastDays, recordedDays, day);
    if (graphed.days.length > 0) return graphed;
    return { ...graphed, daysLoading: warehousePending !== null, daysError: warehousePending ? null : (warehouse?.error ?? null) };
  }

  async function requestUsage(timezone: string): Promise<AiUsage> {
    const url = `${USAGE_URL}?tz=${encodeURIComponent(timezone)}`;
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

  function read(): Promise<AiUsage> {
    const now = Date.now();
    if (cached && now - cached.at < cached.ttl) return Promise.resolve(cached.value);
    let ttl = CACHE_MS;
    pending ??= request()
      .catch((error: unknown): AiUsage => {
        const message = errorMessage(error);
        ttl = error instanceof NoShopifyAccount ? NO_ACCOUNT_CACHE_MS : ERROR_CACHE_MS;
        if (!(error instanceof NoShopifyAccount)) bb.log.warn(`ai usage read failed: ${message}`);
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
              pricingStale: false,
              days: [],
              weekCost: null,
              daysLoading: false,
              daysError: null,
              error: message,
            };
      })
      .then((value) => {
        cached = { at: Date.now(), value, ttl };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  const timer = setInterval(() => void read(), BACKGROUND_READ_MS);
  void read();

  return {
    read,
    dispose() {
      clearInterval(timer);
    },
  };
}
