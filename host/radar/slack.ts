import { CONFIG, PATHS } from "./config";
import { GatewayError, lit, OUTPUT_BUDGET, runCode, TIME_BUDGET_MS } from "./gateway";
import { delay } from "./runtime";
import { ageDays, readJson, writeJson } from "./store";

interface Reaction {
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
  latestReply?: string;
}

export interface Reply {
  ts: string;
  user: string;
  userName: string;
  text: string;
}

export interface SlackChannelState {
  threads: Record<string, { message: Message; replies: Reply[] }>;
}

interface ChannelScan {
  messages: Message[];
  updates: Record<string, Reply[]>;
  state: SlackChannelState;
}

export interface UserInfo {
  name: string;
  title: string;
  at: string;
}

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

const PACED = `
let throttled = false;
const deadline = Date.now() + ${TIME_BUDGET_MS};
const open = () => !throttled && Date.now() < deadline;
const unthrottled = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof Error) || !/^ratelimited$|"error":"rate_limited"/.test(error.message)) throw error;
    }
  }
  throttled = true;
  return undefined;
};`;

const THROTTLE_PAUSE_MS = [5_000, 15_000, 45_000, 90_000];
const PROFILE_PAUSE_MS = THROTTLE_PAUSE_MS.slice(0, 2);

function pacer(pauses = THROTTLE_PAUSE_MS): (stopped: { throttled: boolean }, progressed: boolean) => Promise<void> {
  let stalls = 0;
  return async ({ throttled }, progressed) => {
    if (progressed) stalls = 0;
    if (!throttled) return;
    if (stalls >= pauses.length) throw new GatewayError("ratelimit", "Slack stayed rate-limited");
    await delay(pauses[stalls++]);
  };
}

const SKIP_SUBTYPES: Record<string, true> = {
  channel_join: true,
  channel_leave: true,
  channel_topic: true,
  channel_purpose: true,
  bot_message: true,
};

const THREADS_PER_PROGRAM = 50;

export async function fetchMessages(channelId: string, oldestSec: number, opts: { includeBots?: boolean; latest?: number } = {}): Promise<Message[]> {
  const rows: (Message & { subtype: string })[] = [];
  const seen = new Set<string>();
  const pace = pacer();
  let cursor: string | null = null;
  for (;;) {
    const page: { messages: (Message & { subtype: string })[]; cursor: string | null; done: boolean; pages: number; throttled: boolean } = await runCode(`
${PACED}
${RAW_TYPES}
const out: SlimMessage[] = [];
const seen = new Set<string>(${lit([...seen])});
let cursor: string | undefined = ${cursor === null ? "undefined" : lit(cursor)};
let size = 0;
let pages = 0;
while (open() && size < ${OUTPUT_BUDGET}) {
  const r = (await unthrottled(() => slack.read_channel(${lit(channelId)}, {
    limit: 100, oldest: ${lit(String(oldestSec))}, format: 'json',
    ...${lit(opts.latest === undefined ? {} : { latest: String(opts.latest) })}, ...(cursor ? { cursor } : {}),
  }))) as unknown as RawPage | undefined;
  if (!r) break;
  if (!r.ok) throw new Error('read_channel failed: ' + JSON.stringify(r).slice(0, 300));
  pages++;
  const page = (r.messages ?? []).map(slim);
  out.push(...page);
  size += JSON.stringify(page).length;
  const next = r.response_metadata?.next_cursor?.trim();
  if (!next && !r.has_more) return { messages: out, cursor: null, done: true, pages, throttled };
  if (!next || seen.has(next)) throw new Error('Slack channel pagination did not finish');
  seen.add(next);
  cursor = next;
}
return { messages: out, cursor: cursor ?? null, done: false, pages, throttled };`);
    rows.push(...page.messages);
    if (page.done) break;
    cursor = page.cursor;
    if (cursor !== null) seen.add(cursor);
    await pace(page, page.pages > 0);
  }
  return rows
    .filter((m) => !SKIP_SUBTYPES[m.subtype] || (opts.includeBots && m.subtype === "bot_message"))
    .map(({ subtype: _, ...m }) => m);
}

export async function fetchThreads(
  channelId: string,
  parents: string[],
  opts: { oldest?: string; latest?: string } = {},
): Promise<Record<string, Reply[]>> {
  const out: Record<string, Reply[]> = {};
  const pace = pacer();
  let queue: { ts: string; cursor?: string }[] = parents.map((ts) => ({ ts }));
  while (queue.length) {
    const batch = queue.slice(0, THREADS_PER_PROGRAM);
    const result = await runCode<{
      replies: Record<string, Reply[]>;
      resume: { ts: string; cursor?: string }[];
      read: number;
      pages: number;
      throttled: boolean;
    }>(`
${PACED}
${RAW_TYPES}
type Reply = { ts: string; user: string; userName: string; text: string };
const batch: { ts: string; cursor?: string }[] = ${lit(batch)};
const replies: Record<string, Reply[]> = {};
const resume: { ts: string; cursor?: string }[] = [];
let size = 0;
let read = 0;
let pages = 0;
while (read < batch.length && open() && size < ${OUTPUT_BUDGET}) {
  const group = batch.slice(read, read + 5);
  read += group.length;
  await Promise.all(group.map(async ({ ts, cursor: start }) => {
    const rows: Reply[] = (replies[ts] = []);
    const seen = new Set<string>(start ? [start] : []);
    let cursor = start;
    for (;;) {
      const r = (await unthrottled(() => slack.read_thread(${lit(channelId)}, ts, {
        limit: 100, format: 'json', ...${lit(opts)}, ...(cursor ? { cursor } : {}),
      }))) as unknown as RawPage | undefined;
      if (!r) {
        resume.push(cursor ? { ts, cursor } : { ts });
        return;
      }
      if (!r.ok) throw new Error('read_thread failed: ' + JSON.stringify(r).slice(0, 300));
      pages++;
      const page = (r.messages ?? []).filter((m) => m.ts !== ts).map((m) => ({
        ts: String(m.ts), user: String(m.user ?? m.bot_id ?? ''), userName: authorName(m), text: String(m.text ?? ''),
      }));
      rows.push(...page);
      size += JSON.stringify(page).length;
      const next = r.response_metadata?.next_cursor?.trim();
      if (!next && !r.has_more) return;
      if (!next || seen.has(next)) throw new Error('Slack thread pagination did not finish');
      seen.add(next);
      if (!open() || size >= ${OUTPUT_BUDGET}) {
        resume.push({ ts, cursor: next });
        return;
      }
      cursor = next;
    }
  }));
}
return { replies, resume, read, pages, throttled };`);
    for (const [ts, replies] of Object.entries(result.replies)) (out[ts] ??= []).push(...replies);
    queue = [...result.resume, ...queue.slice(result.read)];
    await pace(result, result.pages > 0);
  }
  for (const [ts, replies] of Object.entries(out)) {
    out[ts] = [...new Map(replies.map((reply) => [reply.ts, reply])).values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  }
  return out;
}

async function fetchParents(channelId: string, parents: string[], now: number): Promise<Record<string, Message>> {
  const out: Record<string, Message> = {};
  const pace = pacer();
  let pending = parents;
  while (pending.length) {
    const result = await runCode<{ parents: Record<string, Message>; throttled: boolean }>(`
${PACED}
${RAW_TYPES}
const batch: string[] = ${lit(pending.slice(0, THREADS_PER_PROGRAM))};
const out: Record<string, Omit<SlimMessage, 'subtype'>> = {};
let size = 0;
let read = 0;
while (read < batch.length && open() && size < ${OUTPUT_BUDGET}) {
  const group = batch.slice(read, read + 5);
  read += group.length;
  await Promise.all(group.map(async (ts) => {
    const result = (await unthrottled(() => slack.read_thread(${lit(channelId)}, ts, { limit: 1, latest: ${lit(String(now))}, format: 'json' }))) as unknown as RawPage | undefined;
    if (!result) return;
    if (!result.ok) throw new Error('read_thread parent failed: ' + JSON.stringify(result).slice(0, 300));
    const parent = result.messages?.find((message) => message.ts === ts);
    if (!parent) throw new Error('Slack did not return thread parent ' + ts);
    const { subtype, ...message } = slim(parent);
    out[ts] = message;
    size += JSON.stringify(message).length;
  }));
}
return { parents: out, throttled };`);
    Object.assign(out, result.parents);
    pending = pending.filter((ts) => !Object.hasOwn(result.parents, ts));
    await pace(result, Object.keys(result.parents).length > 0);
  }
  return out;
}

export async function scanChannel(
  channelId: string,
  since: number,
  now: number,
  previous?: SlackChannelState,
  opts: { includeBots?: boolean } = {},
): Promise<ChannelScan> {
  const history = await fetchMessages(channelId, since, { ...opts, latest: now });
  const threads = { ...previous?.threads };
  for (const message of history) {
    if (Number(message.ts) > now) continue;
    threads[message.ts] = { message, replies: threads[message.ts]?.replies ?? [] };
  }
  const parents = Object.keys(threads);
  const headers = await fetchParents(channelId, parents, now);
  const fetched = await fetchThreads(channelId, parents, { oldest: String(since), latest: String(now) });
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

export async function resolveUsers(ids: Iterable<string>): Promise<Record<string, UserInfo>> {
  const cache = readJson<Record<string, UserInfo>>(PATHS.users, {});
  const pace = pacer(PROFILE_PAUSE_MS);
  let pending = [...new Set(ids)]
    .filter((id) => /^[UW][A-Z0-9]+$/.test(id) && ageDays(cache[id]?.at) > CONFIG.userCacheMaxAgeDays)
    .sort((a, b) => ageDays(cache[b]?.at) - ageDays(cache[a]?.at) || 0);
  try {
    while (pending.length) {
      const got = await runCode<{ users: Record<string, { name: string; title: string }>; throttled: boolean }>(`
${PACED}
const ids: string[] = ${lit(pending.slice(0, 25))};
const users: Record<string, { name: string; title: string }> = {};
for (const id of ids) {
  if (!open()) break;
  const p: unknown = await unthrottled(() => slack.read_user_profile({ user_id: id, response_format: 'detailed' }));
  if (p === undefined) break;
  const t = typeof p === 'string' ? p : String((p as { result?: unknown }).result ?? '');
  const field = (k: string) => (t.match(new RegExp('^' + k + ':[ \\\\t]*(.*)$', 'm'))?.[1] ?? '').trim();
  users[id] = { name: field('Real Name') || field('Display Name'), title: field('Title') };
}
return { users, throttled };`);
      const at = new Date().toISOString();
      for (const [id, u] of Object.entries(got.users)) cache[id] = { ...u, at };
      if (Object.keys(got.users).length) writeJson(PATHS.users, cache);
      pending = pending.filter((id) => !Object.hasOwn(got.users, id));
      await pace(got, Object.keys(got.users).length > 0);
    }
  } catch (error) {
    if (!(error instanceof GatewayError && error.kind === "ratelimit")) throw error;
    console.error(`[radar] user profiles: ${pending.length} left for the next run, Slack rate-limited`);
  }
  return cache;
}

export const permalink = (channelId: string, ts: string): string =>
  `${CONFIG.slackHost}/archives/${channelId}/p${ts.replace(".", "")}`;
