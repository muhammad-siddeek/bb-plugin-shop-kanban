import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

// What harness sessions spent, from the transcripts the harnesses write on this host.
//
// omp:
//   <agent dir>/sessions/<cwd>/<time>_<session id>.jsonl   the session bb talks to
//   <that path without .jsonl>/<Agent>.jsonl                its subagents: task (inline and background), eval
//   <that path without .jsonl>/<Agent>/<Sub>.jsonl          agent(), workpool, advisor, /tan; nested the same way
// Pi, through bb's bridge:
//   <bridge dir>/<provider thread id>.jsonl                 one per session; Pi's subagents are bb threads of their own
//
// Both write one JSON entry per line after a `{"type":"session"}` header; omp puts a `{"type":"title"}` slot
// before it. A transcript's spend is its assistant replies' `usage.cost` plus the `usage.cost` other entries
// carry for model calls of their own: omp's `model_usage` (judgments, completion probes, find), Pi's compactions
// and cache warms. A `task` result repeats the child's reply spend, which the child's transcript already holds,
// so results are never counted. omp's own figure (ACP `usage_update`) counts only its direct children's replies;
// Pi reports none to bb.
//
// A reply saved with tokens but no price is estimated: priced at the average rate, per token bucket, of the same
// provider and model's priced replies across every transcript on this host. omp 18.13 saves every Shopify Auto
// (`shopify-router-*`) reply at $0, as it no longer takes the price its router-cost plugin works out from the
// model that served the turn; that model is never saved, so the mix of models the router served before is the
// best guess. A provider and model with no priced reply here stays at $0.
//
// A fork starts with a copy of its source's entries, all older than its header. They are the source's spend and
// count in the source's transcript; once the source is gone (a Pi rewind deletes its staging copy, omp's
// `previousSessionFiles` get cleaned up), the fork counts them.

const SESSION = ".jsonl";
/** `omp gc` compresses old transcripts in place; the subagent directory keeps the uncompressed name. */
const COMPRESSED = ".jsonl.gz";
const OMP_SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.gz)?$/i;
/** bb's Pi bridge keeps transcripts here unless `BB_PI_BRIDGE_SESSION_DIR` points elsewhere. */
const PI_SESSION_DIR_ENV = "BB_PI_BRIDGE_SESSION_DIR";
/** New sessions get a transcript after the index was built; look again at most this often. */
const INDEX_TTL_MS = 30_000;
/** Re-read the host's priced replies for the estimate rates at most this often; later reads parse only what was appended. */
const RATES_TTL_MS = 10 * 60_000;
/** Bytes before a file's parsed offset that must be unchanged to parse only what was appended since. */
const TAIL_BYTES = 64;
/** Forget files no request has asked about for this long. */
const FORGET_MS = 60 * 60_000;

const BUCKETS = ["input", "output", "cacheRead", "cacheWrite"] as const;
/** A number per token bucket: token counts, USD, or USD per token. */
type Buckets = Record<(typeof BUCKETS)[number], number>;
/** Spend on some of a transcript's entries, plus the tokens of replies saved without a price, by `provider/model`. */
type Part = { amount: number; unpriced: Map<string, Buckets> };
/** What a provider/model's priced replies used and cost. */
type Priced = { tokens: Buckets; cost: Buckets };

/** Where a fork's copied entries came from, and when the fork began: entries older than that are copies. */
type Fork = { source: string; at: number };

type FileSpend = {
  /** Harnesses rewrite a transcript by renaming a new copy over it: a new inode means read it all again. */
  ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes parsed: up to the last complete line. */
  offset: number;
  /** The `TAIL_BYTES` before `offset`; guards against a file rewritten in place under the same inode. */
  tail: Buffer;
  fork: Fork | null;
  /** The transcript's own entries. */
  own: Part;
  /** Entries a fork copied from its source. */
  copied: Part;
  /** The own priced replies, by `provider/model`: what the estimate rates are made of. */
  priced: Map<string, Priced>;
  seenAt: number;
};

/** What sessions spent, in USD; `estimated` is the part of `amount` priced from other replies' rates. */
export type Spend = { amount: number; estimated: number };

/** The fixed-width slot omp writes as a transcript's first line and rewrites in place when the title changes. */
const titleSlotSchema = z.object({ type: z.literal("title") });
/** The session header: a transcript's first line, or its second after a title slot. */
const headerSchema = z.object({ type: z.literal("session"), timestamp: z.string().optional(), parentSession: z.string().optional() });
const usageSchema = z.object({
  input: z.number().nullish(),
  output: z.number().nullish(),
  cacheRead: z.number().nullish(),
  cacheWrite: z.number().nullish(),
  cost: z.object({
    total: z.number().nullish(),
    input: z.number().nullish(),
    output: z.number().nullish(),
    cacheRead: z.number().nullish(),
    cacheWrite: z.number().nullish(),
  }),
});
const entrySchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  usage: usageSchema.optional(),
  message: z
    .object({ role: z.string(), provider: z.string().optional(), model: z.string().optional(), usage: usageSchema.optional() })
    .optional(),
});

const files = new Map<string, FileSpend>();
const reading = new Map<string, Promise<FileSpend | null>>();
let ompRoots: { at: number; paths: Map<string, string> } | null = null;
let indexing: Promise<Map<string, string>> | null = null;
/** USD per token, per bucket, by `provider/model`. */
let rates: { at: number; byModel: Map<string, Buckets> } | null = null;
let rating: Promise<Map<string, Buckets>> | null = null;

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const zero = (): Buckets => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function addInto(map: Map<string, Buckets>, key: string, add: Buckets) {
  const into = map.get(key) ?? zero();
  for (const bucket of BUCKETS) into[bucket] += add[bucket];
  map.set(key, into);
}

/** A deep copy, so a failed read can't leave a half-updated cache entry. */
function copyPart(part: Part): Part {
  return { amount: part.amount, unpriced: new Map([...part.unpriced].map(([key, tokens]) => [key, { ...tokens }])) };
}

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

/** Every transcript under `dir`, at any depth. Dot names are omp's staging files (`.x.jsonl.123.tmp`) and `omp gc` scratch dirs. */
async function transcriptsUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const next = stack.pop()!;
    for (const entry of await entries(next)) {
      if (entry.name.startsWith(".")) continue;
      const path = join(next, entry.name);
      if (entry.isDirectory()) stack.push(path);
      // `.bak` backups don't match.
      else if (entry.isFile() && (entry.name.endsWith(SESSION) || entry.name.endsWith(COMPRESSED))) out.push(path);
    }
  }
  return out;
}

function ompSessionsDir(): string {
  // Profiles and XDG relocation of omp's agent dir aren't followed.
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), "sessions");
}

function piSessionsDir(): string {
  const dir = process.env[PI_SESSION_DIR_ENV]?.trim();
  return dir ? resolve(dir) : join(homedir(), ".bb", "pi-bridge-sessions");
}

/** Session id → transcript path, for every session under omp's sessions dir (one directory per cwd). */
async function indexOmpRoots(): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const base = ompSessionsDir();
  for (const dir of await entries(base)) {
    if (!dir.isDirectory()) continue;
    for (const file of await entries(join(base, dir.name))) {
      const id = file.isFile() ? OMP_SESSION_FILE.exec(file.name)?.[1]?.toLowerCase() : undefined;
      if (id) paths.set(id, join(base, dir.name, file.name));
    }
  }
  return paths;
}

async function ompRoot(sessionId: string): Promise<string | null> {
  const id = sessionId.toLowerCase();
  const known = ompRoots?.paths.get(id);
  if (known && (await stat(known).catch(() => null))) return known;
  // Missing, or moved by compression: rebuild, but not on every request for a session that has no transcript here.
  if (ompRoots && !known && Date.now() - ompRoots.at < INDEX_TTL_MS) return null;
  indexing ??= indexOmpRoots().finally(() => {
    indexing = null;
  });
  const paths = await indexing;
  ompRoots = { at: Date.now(), paths };
  return paths.get(id) ?? null;
}

function time(iso: string | undefined): number | null {
  const at = iso === undefined ? NaN : Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

type LineSpend = {
  amount: number;
  at: number | null;
  /** An assistant reply's model, tokens and, when priced in every bucket, cost per bucket. */
  reply: { model: string; tokens: Buckets; cost: Buckets | null } | null;
};

/** The entry's spend, or null when it records no model call. */
function lineSpend(line: string): LineSpend | null {
  // Most lines (user turns, tool output) carry no cost; skip parsing them.
  if (!line.includes('"cost"')) return null;
  const entry = entrySchema.safeParse(parseJson(line));
  if (!entry.success) return null;
  const { type, message, usage: entryUsage, timestamp } = entry.data;
  // Messages other than assistant replies (tool results) only repeat spend recorded elsewhere.
  const isReply = type === "message" && message?.role === "assistant";
  const usage = type === "message" ? (isReply ? message.usage : undefined) : entryUsage;
  if (!usage) return null;
  const { cost } = usage;
  // Harnesses complete a missing total from its parts when they load a transcript.
  const parts: Buckets = { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 };
  const amount = cost.total ?? parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
  const reply =
    isReply && message.provider && message.model
      ? {
          model: `${message.provider}/${message.model}`,
          tokens: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 },
          cost: amount > 0 && parts.input + parts.output + parts.cacheRead + parts.cacheWrite > 0 ? parts : null,
        }
      : null;
  return { amount, at: time(timestamp), reply };
}

/**
 * Adds the spend in `bytes` (file content from `start`) to `into`, counting complete lines only, and returns
 * the offset parsed to. Read from the start, the header must open the file and tells whether it is a fork; any
 * other file spends nothing (null). Appended lines are judged against the `into.fork` found then. omp's title
 * slot carries no spend, so its in-place rewrites need no re-read.
 */
function parse(path: string, bytes: Buffer, start: number, into: Pick<FileSpend, "fork" | "own" | "copied" | "priced">): number | null {
  const end = bytes.lastIndexOf(0x0a) + 1;
  if (end === 0) return start === 0 ? null : start;
  const lines = bytes.toString("utf8", 0, end).split("\n");
  if (start === 0) {
    const first = parseJson(lines[0]);
    const header = headerSchema.safeParse(titleSlotSchema.safeParse(first).success ? parseJson(lines[1]) : first);
    if (!header.success) return null;
    const { parentSession, timestamp } = header.data;
    const at = time(timestamp);
    into.fork = parentSession && at !== null ? { source: resolve(dirname(path), parentSession), at } : null;
  }
  for (const line of lines) {
    const spend = lineSpend(line);
    if (!spend) continue;
    const copy = into.fork !== null && spend.at !== null && spend.at < into.fork.at;
    const part = copy ? into.copied : into.own;
    part.amount += spend.amount;
    const reply = spend.reply;
    if (!reply) continue;
    if (reply.cost && !copy) {
      const priced = into.priced.get(reply.model) ?? { tokens: zero(), cost: zero() };
      for (const bucket of BUCKETS) {
        priced.tokens[bucket] += reply.tokens[bucket];
        priced.cost[bucket] += reply.cost[bucket];
      }
      into.priced.set(reply.model, priced);
    } else if (spend.amount === 0 && BUCKETS.some((bucket) => reply.tokens[bucket] > 0)) {
      addInto(part.unpriced, reply.model, reply.tokens);
    }
  }
  return start + end;
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(end - start);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/**
 * A transcript's spend; null when the file is missing. Reads only what was appended since the last request when
 * the file just grew. Only omp's title slot changes in place, and it carries no spend.
 */
async function fileSpend(path: string, now: number): Promise<FileSpend | null> {
  const info = await stat(path).catch(() => null);
  if (!info) {
    files.delete(path);
    return null;
  }
  const known = files.get(path);
  if (known && known.ino === info.ino && known.size === info.size && known.mtimeMs === info.mtimeMs) {
    known.seenAt = now;
    return known;
  }

  // `bytes` starts at file offset `base`; its first `skip` bytes were parsed before.
  let bytes: Buffer | null = null;
  let base = 0;
  let skip = 0;
  let previous: FileSpend | null = null;
  if (path.endsWith(COMPRESSED)) {
    bytes = gunzipSync(await readFile(path));
  } else if (known && known.ino === info.ino && known.offset > 0 && info.size >= known.offset) {
    const from = known.offset - known.tail.length;
    const chunk = await readRange(path, from, info.size);
    if (chunk.subarray(0, known.tail.length).equals(known.tail)) {
      bytes = chunk;
      base = from;
      skip = known.tail.length;
      previous = known;
    }
  }
  bytes ??= await readFile(path);

  const into = {
    fork: previous?.fork ?? null,
    own: previous ? copyPart(previous.own) : { amount: 0, unpriced: new Map() },
    copied: previous ? copyPart(previous.copied) : { amount: 0, unpriced: new Map() },
    priced: new Map([...(previous?.priced ?? [])].map(([key, { tokens, cost }]) => [key, { tokens: { ...tokens }, cost: { ...cost } }])),
  };
  // Null only for a full read that found no header, which leaves `into` as empty as it started.
  const parsed = parse(path, bytes.subarray(skip), base + skip, into);
  const offset = parsed ?? 0;
  // Copy the tail: a subarray would pin the whole file's buffer.
  const tail = Buffer.from(bytes.subarray(Math.max(0, offset - base - TAIL_BYTES), offset - base));
  const spend: FileSpend = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, offset, tail, ...into, seenAt: now };
  files.set(path, spend);
  return spend;
}

/** One read per file at a time; requests for the same tree overlap while a turn is running. */
function spendOnce(path: string, now: number): Promise<FileSpend | null> {
  let pending = reading.get(path);
  if (!pending) {
    pending = fileSpend(path, now).finally(() => reading.delete(path));
    reading.set(path, pending);
  }
  return pending;
}

/** Average USD per token, per bucket, of each provider/model's priced replies in every transcript on this host. */
async function readRates(now: number): Promise<Map<string, Buckets>> {
  const totals = new Map<string, Priced>();
  const paths = [...(await transcriptsUnder(ompSessionsDir())), ...(await transcriptsUnder(piSessionsDir()))];
  for (const path of paths) {
    // A file that vanishes or can't be read just leaves its replies out of the averages.
    const spend = await spendOnce(path, now).catch(() => null);
    for (const [model, { tokens, cost }] of spend?.priced ?? []) {
      const total = totals.get(model) ?? { tokens: zero(), cost: zero() };
      for (const bucket of BUCKETS) {
        total.tokens[bucket] += tokens[bucket];
        total.cost[bucket] += cost[bucket];
      }
      totals.set(model, total);
    }
  }
  const byModel = new Map<string, Buckets>();
  for (const [model, { tokens, cost }] of totals) {
    const rate = zero();
    for (const bucket of BUCKETS) rate[bucket] = tokens[bucket] > 0 ? cost[bucket] / tokens[bucket] : 0;
    byModel.set(model, rate);
  }
  return byModel;
}

/** The estimate rates; the first read waits (seconds, for a large history), later ones refresh in the background. */
function estimateRates(now: number): Promise<Map<string, Buckets>> {
  if (!rates || now - rates.at > RATES_TTL_MS) {
    rating ??= readRates(now)
      .then((byModel) => {
        rates = { at: Date.now(), byModel };
        return byModel;
      })
      .finally(() => {
        rating = null;
      });
  }
  return rates ? Promise.resolve(rates.byModel) : rating!;
}

/** What the transcripts spent together; null when none of them exists. */
async function sumSpend(paths: readonly string[], now: number): Promise<Spend | null> {
  let amount: number | null = null;
  const unpriced = new Map<string, Buckets>();
  // One file at a time: a first read loads whole transcripts, and a long session's tree runs to tens of MB.
  for (const path of paths) {
    const spend = await spendOnce(path, now);
    if (!spend) continue;
    // A source that still exists counts the copies itself; recheck each time, as sources get deleted.
    const copies = spend.copied.amount > 0 || spend.copied.unpriced.size > 0;
    const sourceCounts = copies && spend.fork !== null && (await stat(spend.fork.source).catch(() => null)) !== null;
    for (const part of sourceCounts ? [spend.own] : [spend.own, spend.copied]) {
      amount = (amount ?? 0) + part.amount;
      for (const [model, tokens] of part.unpriced) addInto(unpriced, model, tokens);
    }
  }
  if (amount === null) return null;
  let estimated = 0;
  if (unpriced.size > 0) {
    const byModel = await estimateRates(now);
    for (const [model, tokens] of unpriced) {
      const rate = byModel.get(model);
      if (rate) for (const bucket of BUCKETS) estimated += tokens[bucket] * rate[bucket];
    }
  }
  return { amount: amount + estimated, estimated };
}

async function spendBy(sessionIds: readonly string[], locate: (id: string) => Promise<string[]>): Promise<Record<string, Spend>> {
  const now = Date.now();
  const spends: Record<string, Spend> = {};
  for (const sessionId of new Set(sessionIds)) {
    const spend = await sumSpend(await locate(sessionId), now);
    if (spend) spends[sessionId] = spend;
  }
  for (const [path, entry] of files) if (now - entry.seenAt > FORGET_MS) files.delete(path);
  return spends;
}

/** What each omp session and every subagent below it spent; sessions with no transcript here are left out. */
export function ompSpend(sessionIds: readonly string[]): Promise<Record<string, Spend>> {
  return spendBy(sessionIds, async (id) => {
    const root = await ompRoot(id);
    if (!root) return [];
    const subagents = root.endsWith(COMPRESSED) ? root.slice(0, -COMPRESSED.length) : root.slice(0, -SESSION.length);
    return [root, ...(await transcriptsUnder(subagents))];
  });
}

/**
 * What each Pi session (bb provider thread id) spent; sessions with no transcript here are left out. bb's bridge
 * names a transcript after the id; the contract admits only ids it keeps as they are.
 */
export function piSpend(providerThreadIds: readonly string[]): Promise<Record<string, Spend>> {
  return spendBy(providerThreadIds, async (id) => [join(piSessionsDir(), `${id}${SESSION}`)]);
}
