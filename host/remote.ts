import { z } from "zod";
import type { RemoteItem, RemoteSource } from "../contract";
import { failure, run } from "./run";

// Remote work the user is part of, read with their own Google identity token (`gcloud auth print-identity-token`):
// Torrent tickets from Torrent's "Your work" (`GET /me/work`), and River sessions they have spoken in from Aquifer,
// the platform River runs on (`POST /v1/sessions/query`, the query Omarchy's River widget uses). Only what is live
// is kept: tickets an agent is working or that wait on the user, and River sessions with a turn in progress or
// blocked.

const TORRENT_API = "https://torrent-api.shopify.io/api/v1";
const TORRENT_UI = "https://torrent.shopify.io/issues/";
const AQUIFER = "https://aquifer.shopify.io";
const COVE = "https://cove-ng.quick.shopify.io/sessions/";
const SLACK_ARCHIVES = "https://shopify.enterprise.slack.com/archives/";
const CALL_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 15_000;
/** A token is minted again this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** River sessions the user spoke in within this window are read. */
const RIVER_WINDOW_MS = 7 * 86_400_000;
/** The gateway's own page cap. */
const RIVER_LIMIT = 200;
/** The opening prompt sits behind `session.created` and a status event or two. */
const PROMPT_SCAN = 25;
/**
 * An idle session holding an unconsumed command is about to start a turn, but only while the command is fresh: most
 * idle River sessions carry one forever (Omarchy's River widget, QUEUED_WINDOW_MS).
 */
const QUEUED_WINDOW_MS = 120_000;
const TITLE_MAX = 110;
/** Torrent ticket state types still in play; backlog, unstarted, completed and canceled ones aren't. */
const LIVE_TICKET_TYPES: Record<string, true> = { started: true, waiting: true };

type Source = RemoteSource["source"];
type Token = { value: string; email: string; expiresAt: number };
type Fetched<T> = { ok: true; value: T } | { ok: false; error: string; missing: boolean };

let token: Token | null = null;
/** Opening-prompt titles by River session id; a session's opening prompt never changes. */
const riverTitles = new Map<string, string>();

function jwtClaims(jwt: string): { email?: unknown; exp?: unknown } | null {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** The user's identity token and email, minted by gcloud and kept until shortly before it expires. */
async function identity(signal: AbortSignal): Promise<Fetched<Token>> {
  if (token && token.expiresAt - TOKEN_MARGIN_MS > Date.now()) return { ok: true, value: token };
  const result = await run("gcloud", ["auth", "print-identity-token"], TOKEN_TIMEOUT_MS, signal);
  if (result.code === -1) return { ok: false, error: "gcloud is not installed on this host.", missing: true };
  const value = result.stdout.trim();
  const claims = result.code === 0 ? jwtClaims(value) : null;
  if (!claims || typeof claims.email !== "string" || typeof claims.exp !== "number") {
    // Signed out, or an account that needs `gcloud auth login` again: quiet, like a forge CLI that isn't signed in.
    return { ok: false, error: `gcloud has no identity token; run \`gcloud auth login\`. ${failure("gcloud", result)}`, missing: true };
  }
  token = { value, email: claims.email, expiresAt: claims.exp * 1000 };
  return { ok: true, value: token };
}

/** One JSON call with the bearer. Unreachable hosts and refused tokens are `missing`: not a Shopify machine or account. */
async function call<T>(bearer: string, url: string, init: { method?: string; body?: unknown }, schema: z.ZodType<T>, signal: AbortSignal): Promise<Fetched<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, error: timedOut ? `${new URL(url).host} did not answer in time.` : `Couldn't reach ${new URL(url).host}: ${String(error)}`, missing: !timedOut };
  }
  if (response.status === 401 || response.status === 403) {
    if (response.status === 401) token = null;
    return { ok: false, error: `${new URL(url).host} refused the token (${response.status}).`, missing: true };
  }
  const text = await response.text();
  if (!response.ok) return { ok: false, error: `${new URL(url).host} answered ${response.status}: ${text.trim().slice(0, 200)}`, missing: false };
  try {
    return { ok: true, value: schema.parse(JSON.parse(text)) };
  } catch {
    return { ok: false, error: `${new URL(url).host} returned unexpected output: ${text.trim().slice(0, 200)}`, missing: false };
  }
}

const ticketSchema = z
  .object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.string().nullish(),
    state: z.object({ name: z.string(), type: z.string() }).loose(),
    updated_at: z.string(),
    needs: z.boolean().nullish(),
    blocked: z.boolean().nullish(),
    session: z.object({ id: z.string(), status: z.string() }).loose().nullish(),
  })
  .loose();
const workSchema = z.object({ groups: z.array(z.object({ issues: z.array(ticketSchema) }).loose()) }).loose();
const ticketSessionsSchema = z.object({ data: z.array(z.object({ cost_usd: z.number().nullish() }).loose()) }).loose();

async function torrentItems(bearer: string, signal: AbortSignal): Promise<Fetched<RemoteItem[]>> {
  const work = await call(bearer, `${TORRENT_API}/me/work`, {}, workSchema, signal);
  if (!work.ok) return work;
  // A ticket can sit in several groups (yours, requested by you, subscribed).
  const tickets = new Map<string, z.infer<typeof ticketSchema>>();
  for (const group of work.value.groups) {
    for (const ticket of group.issues) {
      if (LIVE_TICKET_TYPES[ticket.state.type] || ticket.needs || ticket.blocked) tickets.set(ticket.id, ticket);
    }
  }
  const items = await Promise.all(
    [...tickets.values()].map(async (ticket): Promise<RemoteItem> => {
      // What the ticket's agents spent, every session summed; unknown when Torrent won't say.
      const sessions = ticket.session ? await call(bearer, `${TORRENT_API}/issues/${encodeURIComponent(ticket.identifier)}/sessions`, {}, ticketSessionsSchema, signal) : null;
      const costs = sessions?.ok ? sessions.value.data.flatMap((session) => (typeof session.cost_usd === "number" ? [session.cost_usd] : [])) : [];
      return {
        id: `torrent:${ticket.id}`,
        source: "torrent",
        key: ticket.identifier,
        title: ticket.title,
        url: ticket.url ?? `${TORRENT_UI}${encodeURIComponent(ticket.identifier)}`,
        status: ticket.needs || ticket.blocked ? "blocked" : "wip",
        detail: ticket.state.name,
        updatedAt: ticket.updated_at,
        cost: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
      };
    }),
  );
  return { ok: true, value: items };
}

const riverSessionSchema = z
  .object({
    id: z.string(),
    profile: z.string().nullish(),
    status: z.string(),
    updated_at: z.string(),
    pending_commands: z.number().nullish(),
    metadata: z.object({ slack_channel: z.string().nullish(), slack_thread: z.string().nullish() }).loose().nullish(),
  })
  .loose();
const riverQuerySchema = z.object({ sessions: z.array(riverSessionSchema) }).loose();
const eventsSchema = z
  .object({
    events: z.array(
      z.object({ type: z.string(), data: z.object({ content: z.array(z.object({ text: z.string().nullish() }).loose()).nullish() }).loose().nullish() }).loose(),
    ),
  })
  .loose();

/** What a River session is doing, for the board: working, blocked, or neither (left off). */
function riverStatus(session: z.infer<typeof riverSessionSchema>, now: number): "wip" | "blocked" | null {
  if (session.status === "running" || session.status === "scheduling") return "wip";
  if (session.status === "blocked") return "blocked";
  if (session.status === "idle" && (session.pending_commands ?? 0) > 0 && now - Date.parse(session.updated_at) < QUEUED_WINDOW_MS) return "wip";
  return null;
}

/** Slack's markup undone: `<url|label>` is its label, `<url>` its url, and the text is HTML-escaped. */
function unslack(text: string): string {
  return text
    .replace(/<(?:mailto:)?[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<(https?:\/\/[^>]*)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The line that names a River session. The slackbot wraps the request in a harness (who owns the session, how to
 * credit a pull request) and then a transcript of the thread; the request is the transcript's last entry. Fenced
 * code and lines that are only a link are context, not the request.
 */
function riverTitle(prompt: string): string {
  let body = prompt;
  const marker = body.indexOf("Thread transcript:");
  if (marker >= 0) {
    const entries = body.slice(marker + "Thread transcript:".length).split(/\n(?=\s*-\s*\[channel=)/).filter((entry) => entry.trim() !== "");
    body = (entries.at(-1) ?? "").replace(/^\s*-\s*\[[^\]]*\]\s*/, "");
  }
  body = unslack(body.replace(/```[\s\S]*?(?:```|$)/g, "\n"));
  for (const raw of body.split("\n")) {
    // A leading mention of River itself says nothing about the request.
    const line = raw.trim().replace(/\s+/g, " ").replace(/^@\S+ \([^)]*\),?\s*/, "");
    if (!line || /^<?https?:\/\/\S+>?$/.test(line)) continue;
    if (line.length <= TITLE_MAX) return line;
    const cut = line.slice(0, TITLE_MAX);
    const space = cut.lastIndexOf(" ");
    return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return "";
}

async function riverOpening(bearer: string, id: string, signal: AbortSignal): Promise<string> {
  const known = riverTitles.get(id);
  if (known !== undefined) return known;
  const events = await call(bearer, `${AQUIFER}/v1/sessions/${encodeURIComponent(id)}/events?after_seq=0&limit=${PROMPT_SCAN}`, {}, eventsSchema, signal);
  if (!events.ok) return "";
  const opening = events.value.events.find((event) => event.type === "user.message");
  const title = riverTitle((opening?.data?.content ?? []).map((block) => block.text ?? "").join("\n"));
  riverTitles.set(id, title);
  return title;
}

async function riverItems(bearer: string, email: string, signal: AbortSignal): Promise<Fetched<RemoteItem[]>> {
  const now = Date.now();
  // Who spoke, not who created: a Slack session's creator is the slackbot, and threads others started count too.
  // The event atom has to lead an `all` for the gateway's planner to use its events index.
  const body = {
    where: {
      all: [
        {
          "event.exists": {
            where: { all: [{ "event.author.principal_id": { eq: email } }, { "event.created_at": { gte: new Date(now - RIVER_WINDOW_MS).toISOString() } }] },
          },
        },
      ],
    },
    order: [{ "session.created_at": "desc" }],
    limit: RIVER_LIMIT,
  };
  const found = await call(bearer, `${AQUIFER}/v1/sessions/query`, { method: "POST", body }, riverQuerySchema, signal);
  if (!found.ok) return found;
  // Torrent's agent sessions show up here too; Torrent's own list has their tickets.
  const live = found.value.sessions.flatMap((session) => {
    const status = session.profile === "riverbed" ? riverStatus(session, now) : null;
    return status ? [{ session, status }] : [];
  });
  const items = await Promise.all(
    live.map(async ({ session, status }): Promise<RemoteItem> => {
      const { slack_channel: channel, slack_thread: thread } = session.metadata ?? {};
      return {
        id: `river:${session.id}`,
        source: "river",
        key: "River",
        title: (await riverOpening(bearer, session.id, signal)) || session.id,
        url: channel && thread ? `${SLACK_ARCHIVES}${channel}/p${thread.replace(".", "")}` : `${COVE}${session.id}`,
        status,
        detail: session.status,
        updatedAt: session.updated_at,
        cost: null,
      };
    }),
  );
  return { ok: true, value: items };
}

export async function remoteWork(signal: AbortSignal): Promise<{ items: RemoteItem[]; sources: RemoteSource[] }> {
  const sources: Source[] = ["torrent", "river"];
  const id = await identity(signal);
  if (!id.ok) return { items: [], sources: sources.map((source) => ({ source, error: id.error, missing: id.missing })) };
  const results = await Promise.all([torrentItems(id.value.value, signal), riverItems(id.value.value, id.value.email, signal)]);
  return {
    items: results.flatMap((result) => (result.ok ? result.value : [])),
    sources: results.map((result, index) => ({ source: sources[index]!, error: result.ok ? null : result.error, missing: !result.ok && result.missing })),
  };
}
