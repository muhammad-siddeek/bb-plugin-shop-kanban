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

/** Every known parent is retained, including quiet threads that may receive their first reply years later. */
export interface SlackChannelState {
  threads: Record<string, { message: Message; replies: Reply[] }>;
}

export interface ChannelScan {
  messages: Message[];
  /** Only replies newer than the caller's checkpoint, for opportunity evidence. */
  updates: Record<string, Reply[]>;
  state: SlackChannelState;
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
  text: String(m.text ?? ''),
  replyCount: Number(m.reply_count ?? 0),
  replyUsers: (m.reply_users ?? []).map(String),
  reactions: (m.reactions ?? []).map((r) => ({ name: String(r.name), count: Number(r.count), users: (r.users ?? []).map(String) })),
  attachments: (m.attachments ?? []).map((a) =>
    [a.author_name, a.title, a.text ?? a.fallback, a.from_url ?? a.original_url].filter(Boolean).join(' | ')),
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
export async function fetchMessages(channelId: string, oldestSec: number, opts: { includeBots?: boolean; latest?: number } = {}): Promise<Message[]> {
  const rows = await runCode<(Message & { subtype: string })[]>(`
await slack.who_am_i();
${RAW_TYPES}
const out: SlimMessage[] = [];
let cursor: string | undefined;
const seen = new Set<string>();
for (;;) {
  const r = (await slack.read_channel(${lit(channelId)}, {
    limit: 100, oldest: ${lit(String(oldestSec))}, format: 'json',
    ...${lit(opts.latest === undefined ? {} : { latest: String(opts.latest) })}, ...(cursor ? { cursor } : {}),
  })) as unknown as RawPage;
  if (!r.ok) throw new Error('read_channel failed: ' + JSON.stringify(r).slice(0, 300));
  out.push(...(r.messages ?? []).map(slim));
  const next = r.response_metadata?.next_cursor?.trim();
  if (!next && !r.has_more) break;
  if (!next || seen.has(next)) throw new Error('Slack channel pagination did not finish');
  seen.add(next);
  cursor = next;
}
return out;`);
  return rows
    .filter((m) => !SKIP_SUBTYPES[m.subtype] || (opts.includeBots && m.subtype === "bot_message"))
    .map(({ subtype: _, ...m }) => m);
}

/** Read every reply after `oldest`, following all pages; the parent is excluded. */
export async function fetchThreads(
  channelId: string,
  parents: string[],
  opts: { oldest?: string; latest?: string } = {},
): Promise<Record<string, Reply[]>> {
  if (parents.length === 0) return {};
  return runCode<Record<string, Reply[]>>(`
await slack.who_am_i();
${RAW_TYPES}
const parents: string[] = ${lit(parents)};
const out: Record<string, { ts: string; user: string; userName: string; text: string }[]> = {};
for (let i = 0; i < parents.length; i += 5) {
  await Promise.all(parents.slice(i, i + 5).map(async (ts) => {
    const replies = new Map<string, { ts: string; user: string; userName: string; text: string }>();
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const r = (await slack.read_thread(${lit(channelId)}, ts, {
        limit: 100, format: 'json', ...${lit(opts)}, ...(cursor ? { cursor } : {}),
      })) as unknown as RawPage;
      if (!r.ok) throw new Error('read_thread failed: ' + JSON.stringify(r).slice(0, 300));
      for (const m of r.messages ?? []) if (m.ts !== ts) replies.set(String(m.ts), {
        ts: String(m.ts), user: String(m.user ?? m.bot_id ?? ''), userName: authorName(m), text: String(m.text ?? ''),
      });
      const next = r.response_metadata?.next_cursor?.trim();
      if (!next && !r.has_more) break;
      if (!next || seen.has(next)) throw new Error('Slack thread pagination did not finish');
      seen.add(next);
      cursor = next;
    }
    out[ts] = [...replies.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  }));
}
return out;`);
}

/** A one-message header read refreshes edits and reactions without rereading old reply pages. */
async function fetchParents(channelId: string, parents: string[], now: number): Promise<Record<string, Message>> {
  if (!parents.length) return {};
  return runCode<Record<string, Message>>(`
await slack.who_am_i();
${RAW_TYPES}
const parents: string[] = ${lit(parents)};
const out: Record<string, Omit<SlimMessage, 'subtype'>> = {};
for (let index = 0; index < parents.length; index += 5) {
  await Promise.all(parents.slice(index, index + 5).map(async (ts) => {
    const result = (await slack.read_thread(${lit(channelId)}, ts, { limit: 1, latest: ${lit(String(now))}, format: 'json' })) as unknown as RawPage;
    if (!result.ok) throw new Error('read_thread parent failed: ' + JSON.stringify(result).slice(0, 300));
    const parent = result.messages?.find((message) => message.ts === ts);
    if (!parent) throw new Error('Slack did not return thread parent ' + ts);
    const { subtype, ...message } = slim(parent);
    out[ts] = message;
  }));
}
return out;`);
}

/**
 * Resume channel history at its durable checkpoint and poll every retained parent for newer replies. An imported
 * cursor without a thread index bootstraps that index from the beginning, but only newer activity is rediscovered.
 * Nothing is persisted here: callers commit this state only after all judging and inbox publication succeed.
 */
export async function scanChannel(
  channelId: string,
  since: number,
  now: number,
  previous?: SlackChannelState,
  opts: { includeBots?: boolean } = {},
): Promise<ChannelScan> {
  const history = await fetchMessages(channelId, previous ? since : 0, { ...opts, latest: now });
  const threads = { ...previous?.threads };
  for (const message of history) {
    if (Number(message.ts) > now) continue;
    threads[message.ts] = { message, replies: threads[message.ts]?.replies ?? [] };
  }
  const parents = Object.keys(threads);
  const headers = await fetchParents(channelId, parents, now);
  const fetched = await fetchThreads(channelId, parents, { oldest: String(previous ? since : 0), latest: String(now) });
  const messages: Message[] = [];
  const updates: Record<string, Reply[]> = {};
  for (const [ts, thread] of Object.entries(threads)) {
    const added = (fetched[ts] ?? []).filter((reply) => Number(reply.ts) <= now);
    let all = thread.replies;
    if (added.length) {
      const replies = new Map(all.map((reply) => [reply.ts, reply]));
      for (const reply of added) replies.set(reply.ts, reply);
      all = [...replies.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
    }
    const fresh = added.filter((reply) => Number(reply.ts) > since);
    const parent = headers[ts];
    const last = all.at(-1)?.ts;
    const latestReply = Number(parent.latestReply ?? 0) > Number(last ?? 0) ? parent.latestReply : last;
    const message: Message = {
      ...parent,
      replyCount: Math.max(parent.replyCount, all.length),
      replyUsers: !added.length && parent.replyUsers.every((user) => thread.message.replyUsers.includes(user))
        ? thread.message.replyUsers
        : [...new Set([...parent.replyUsers, ...all.map((reply) => reply.user).filter(Boolean)])],
      ...(latestReply ? { latestReply } : {}),
    };
    const changed = JSON.stringify(message) !== JSON.stringify(thread.message);
    if (changed || all !== thread.replies) threads[ts] = { message, replies: all };
    if (Number(ts) > since || fresh.length || (previous?.threads[ts] && changed)) {
      messages.push(message);
      updates[ts] = fresh;
    }
  }
  return { messages, updates, state: { threads } };
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
