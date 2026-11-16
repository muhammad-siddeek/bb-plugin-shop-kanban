// Slack reads via Tool Gateway. All programs slim payloads server-side before returning.
import { CONFIG, PATHS } from "./config";
import { lit, runCode } from "./gateway";
import { ageDays, readJson, writeJson } from "./store";

export interface Reaction {
  name: string;
  count: number;
  users: string[];
}

export interface Message {
  ts: string;
  user: string;
  userName: string;
  text: string;
  replyCount: number;
  replyUsers: string[];
  reactions: Reaction[];
  attachments: string[];
  files: string[];
  /** ts of the newest thread reply; absent when the message has no replies. */
  latestReply?: string;
}

export interface Reply {
  ts: string;
  user: string;
  userName: string;
  text: string;
}

export interface UserInfo {
  name: string;
  title: string;
  at: string;
}

// Raw Slack Web API shapes (subset) used inside code-mode programs. The gateway types these
// responses as opaque JSON, so programs cast once at the boundary.
const RAW_TYPES = `
interface RawReaction { name: string; count: number; users?: string[] }
interface RawAttachment { author_name?: string; title?: string; text?: string; fallback?: string; from_url?: string; original_url?: string }
interface RawFile { name?: string; title?: string }
interface RawMessage {
  ts: string; user?: string; bot_id?: string; user_name?: string; username?: string; subtype?: string;
  user_profile?: { real_name?: string }; text?: string; reply_count?: number; reply_users?: string[]; latest_reply?: string;
  reactions?: RawReaction[]; attachments?: RawAttachment[]; files?: RawFile[];
}
interface RawPage { ok: boolean; messages?: RawMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }
type SlimMessage = {
  ts: string; user: string; userName: string; text: string; replyCount: number; replyUsers: string[];
  reactions: { name: string; count: number; users: string[] }[]; attachments: string[]; files: string[]; subtype: string;
  latestReply?: string;
};
const authorName = (m: RawMessage) => String(m.user_name ?? m.user_profile?.real_name ?? m.username ?? '');
const slim = (m: RawMessage): SlimMessage => ({
  ts: String(m.ts),
  user: String(m.user ?? m.bot_id ?? ''),
  userName: authorName(m),
  text: String(m.text ?? '').slice(0, 2000),
  replyCount: Number(m.reply_count ?? 0),
  replyUsers: (m.reply_users ?? []).map(String),
  reactions: (m.reactions ?? []).map((r) => ({ name: String(r.name), count: Number(r.count), users: (r.users ?? []).map(String) })),
  attachments: (m.attachments ?? []).map((a) =>
    [a.author_name, a.title, a.text ?? a.fallback, a.from_url ?? a.original_url].filter(Boolean).join(' | ').slice(0, 800)),
  files: (m.files ?? []).map((f) => String(f.name ?? f.title ?? '')),
  subtype: String(m.subtype ?? ''),
  ...(m.latest_reply ? { latestReply: String(m.latest_reply) } : {}),
});`;

const SKIP_SUBTYPES: Record<string, true> = {
  channel_join: true,
  channel_leave: true,
  channel_topic: true,
  channel_purpose: true,
  bot_message: true,
};

/**
 * Top-level channel messages newer than `oldestSec` (unix seconds), newest first. Bot posts are dropped unless
 * `includeBots` (alert channels, where recurring alerts are the signal).
 */
export async function fetchMessages(channelId: string, oldestSec: number, opts: { includeBots?: boolean } = {}): Promise<Message[]> {
  const rows = await runCode<(Message & { subtype: string })[]>(`
await slack.who_am_i();
${RAW_TYPES}
const out: SlimMessage[] = [];
let cursor: string | undefined;
for (let page = 0; page < 20; page++) {
  const r = (await slack.read_channel(${lit(channelId)}, { limit: 100, oldest: ${lit(String(oldestSec))}, format: 'json', ...(cursor ? { cursor } : {}) })) as unknown as RawPage;
  if (!r.ok) throw new Error('read_channel failed: ' + JSON.stringify(r).slice(0, 300));
  out.push(...(r.messages ?? []).map(slim));
  cursor = r.response_metadata?.next_cursor;
  if (!r.has_more || !cursor) break;
}
return out;`);
  return rows
    .filter((m) => !SKIP_SUBTYPES[m.subtype] || (opts.includeBots && m.subtype === "bot_message"))
    .map(({ subtype: _, ...m }) => m);
}

/**
 * Thread replies (parent excluded) for the given parent timestamps, oldest first: the first `limit` replies, or with
 * `oldest` (Slack ts) only the replies after it.
 */
export async function fetchThreads(
  channelId: string,
  parents: string[],
  opts: { limit?: number; oldest?: string } = {},
): Promise<Record<string, Reply[]>> {
  const { limit = CONFIG.maxRepliesPerThread + 1, oldest } = opts;
  if (parents.length === 0) return {};
  return runCode<Record<string, Reply[]>>(`
await slack.who_am_i();
${RAW_TYPES}
const parents: string[] = ${lit(parents)};
const out: Record<string, { ts: string; user: string; userName: string; text: string }[]> = {};
for (let i = 0; i < parents.length; i += 5) {
  await Promise.all(parents.slice(i, i + 5).map(async (ts) => {
    const r = (await slack.read_thread(${lit(channelId)}, ts, ts, { limit: ${lit(limit)}, format: 'json', ...${lit(oldest ? { oldest } : {})} })) as unknown as RawPage;
    out[ts] = (r.messages ?? []).filter((m) => m.ts !== ts).map((m) => ({
      ts: String(m.ts),
      user: String(m.user ?? ''),
      userName: authorName(m),
      text: String(m.text ?? '').slice(0, 400),
    }));
  }));
}
return out;`);
}

/** Resolve Slack user IDs to name + title, cached on disk. */
export async function resolveUsers(ids: Iterable<string>): Promise<Record<string, UserInfo>> {
  const cache = readJson<Record<string, UserInfo>>(PATHS.users, {});
  const missing = [...new Set(ids)].filter(
    (id) => /^[UW][A-Z0-9]+$/.test(id) && ageDays(cache[id]?.at) > CONFIG.userCacheMaxAgeDays,
  );
  for (let i = 0; i < missing.length; i += 25) {
    const batch = missing.slice(i, i + 25);
    const got = await runCode<Record<string, { name: string; title: string }>>(`
await slack.who_am_i();
const ids: string[] = ${lit(batch)};
const out: Record<string, { name: string; title: string }> = {};
await Promise.all(ids.map(async (id) => {
  const p: unknown = await slack.read_user_profile({ user_id: id, response_format: 'detailed' });
  const t = typeof p === 'string' ? p : String((p as { result?: unknown }).result ?? '');
  const field = (k: string) => (t.match(new RegExp('^' + k + ':[ \\\\t]*(.*)$', 'm'))?.[1] ?? '').trim();
  out[id] = { name: field('Real Name') || field('Display Name'), title: field('Title') };
}));
return out;`);
    const at = new Date().toISOString();
    for (const [id, u] of Object.entries(got)) cache[id] = { ...u, at };
    writeJson(PATHS.users, cache);
  }
  return cache;
}

export const permalink = (channelId: string, ts: string): string =>
  `${CONFIG.slackHost}/archives/${channelId}/p${ts.replace(".", "")}`;
