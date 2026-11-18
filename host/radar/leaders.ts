import { CONFIG, PATHS } from "./config";
import { lit, OUTPUT_BUDGET, runCode } from "./gateway";
import { foldUpdates } from "./llm";
import { epochSeconds, readJson, writeJson } from "./store";

interface ChainMember {
  name: string;
  title: string;
  vaultUrl: string;
  slackId: string;
}

export interface Priority {
  id: string;
  theme: string;
  description: string;
  evidence: { title: string; url: string; who: string }[];
}

export interface Leaders {
  refreshedAt: string;
  chain: ChainMember[];
  priorities: Priority[];
  cursors?: Record<string, number>;
  snapshots?: Record<string, string>;
}

interface Gathered {
  chain: ChainMember[];
  contributions: { key: string; name: string; text: string }[];
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function contributions(member: ChainMember, from: string, to: string): Promise<string> {
  const { text } = await runCode<{ text: string | null }>(`
const read = async (from: string, to: string): Promise<string> => {
  const text = str(await vault.get_user_contributions(${lit(member.vaultUrl)}, { start_date: from, end_date: to }));
  if (!/Results limited to|\\btruncated\\b/i.test(text)) return text;
  const lo = Date.parse(from), hi = Date.parse(to);
  if (lo >= hi) throw new Error('Vault returned truncated contributions for ' + ${lit(member.name)} + ' on ' + from);
  const mid = Math.floor((lo + hi) / 2 / 86400000) * 86400000;
  const left = new Date(mid).toISOString().slice(0, 10);
  const right = new Date(mid + 86400000).toISOString().slice(0, 10);
  return await read(from, left) + '\\n' + await read(right, to);
};
const text = await read(${lit(from)}, ${lit(to)});
return { text: text.length > ${OUTPUT_BUDGET} ? null : text };`);
  if (text !== null) return text;
  const lo = Date.parse(from), hi = Date.parse(to);
  if (lo >= hi) throw new Error(`Vault contributions for ${member.name} on ${from} exceed the gateway output limit`);
  const mid = Math.floor((lo + hi) / 2 / DAY_MS) * DAY_MS;
  return `${await contributions(member, from, day(mid))}\n${await contributions(member, day(mid + DAY_MS), to)}`;
}

async function gather(cached: Leaders | null, now: number): Promise<Gathered> {
  const chain = await runCode<ChainMember[]>(`
const me = str(await vault.get_current_user());
const chart = me.split('**Organizational Chart:**')[1]?.split('\\n## ')[0] ?? '';
const links = [...chart.matchAll(/\\[([^\\]]+)\\]\\((https:\\/\\/vault\\.shopify\\.io\\/users\\/[^)]+)\\):\\s*(.+)/g)];
return await Promise.all(links.map(async (m) => {
  const profile = str(await vault.get_user(m[2]));
  return {
    name: m[1],
    title: m[3].replace(/&amp;/g, '&').trim(),
    vaultUrl: m[2],
    slackId: profile.match(/Slack ID:\\s*([UW][A-Z0-9]+)/)?.[1] ?? '',
  };
}));`);
  const legacy = cached && !cached.cursors ? epochSeconds(cached.refreshedAt) : 0;
  const bootstrap = legacy || now - CONFIG.leadersBootstrapDays * 86_400;
  const end = day(now * 1000);
  const read = await Promise.all(chain.filter((member) => member.slackId !== CONFIG.me.slackId).map(async (member) => {
    const key = `vault:contributions:${member.vaultUrl}`;
    const start = day((cached?.cursors?.[key] ?? bootstrap) * 1000);
    return { key, name: `${member.name} (${member.title})`, text: await contributions(member, start, end) };
  }));
  return { chain, contributions: read };
}

const SYSTEM = `You maintain what Shopify leadership is actively pushing, from Vault contributions (projects,
posts, PRs, decisions) by the reader's management chain, from the CEO down.
The reader is a senior engineer on ExP (Experiments Platform) and wants to know which directions are
leadership-backed so they can align new tools/ideas with them.
Update the prior priorities from the new contributions and return only changes: upserts holds every new priority
and every prior priority the sources change, as a full priority (reuse a prior id to update it); removed holds ids
of prior priorities new evidence explicitly replaces or contradicts. Prior priorities in neither list stay unchanged;
never repeat an unchanged one. Do not expire priorities by age or impose an item limit.
Each priority: id (short kebab-case, stable), theme (<= 8 words), description (<= 40 words:
what leadership wants to happen and why), evidence (titles + URLs copied verbatim from the sources, with who).
Prefer org-wide directions (e.g. agent automation of backlogs, AI adoption programs, platform shifts) over
one person's routine PRs. Do not invent anything not supported by the prior context or sources.`;

export async function loadLeaders({ persist = true }: { persist?: boolean } = {}): Promise<Leaders> {
  const cached = readJson<Leaders | null>(PATHS.leaders, null);
  const now = Date.now() / 1000;
  const gathered = await gather(cached, now);
  const chain = gathered.chain.filter((member) => member.slackId !== CONFIG.me.slackId);
  const cursors = { ...cached?.cursors };
  const snapshots = { ...cached?.snapshots };
  const changed = gathered.contributions.filter((contribution) => snapshots[contribution.key] !== contribution.text);
  for (const contribution of gathered.contributions) {
    cursors[contribution.key] = Math.max(cursors[contribution.key] ?? 0, now);
    snapshots[contribution.key] = contribution.text;
  }
  if (cached && !changed.length && JSON.stringify(chain) === JSON.stringify(cached.chain)) {
    const leaders = { ...cached, cursors, snapshots };
    if (persist) writeJson(PATHS.leaders, leaders);
    return leaders;
  }
  const priorities = await foldUpdates<Priority>({
    system: SYSTEM,
    prior: cached?.priorities ?? [],
    sections: changed.length
      ? changed.map((contribution) => `# ${contribution.name}\n${contribution.text}`)
      : [`# Previous management chain\n${JSON.stringify(cached?.chain ?? [])}`],
    user: (current, batch) => [
      `# Prior leadership priorities\n${JSON.stringify(current)}`,
      `# Current management chain\n${JSON.stringify(chain)}`,
      ...batch,
    ].join("\n\n"),
    item: {
      type: "object",
      required: ["id", "theme", "description", "evidence"],
      properties: {
        id: { type: "string" },
        theme: { type: "string" },
        description: { type: "string" },
        evidence: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "url", "who"],
            properties: { title: { type: "string" }, url: { type: "string" }, who: { type: "string" } },
          },
        },
      },
    },
  });
  const leaders: Leaders = {
    ...cached,
    refreshedAt: new Date().toISOString(),
    chain,
    priorities,
    cursors,
    snapshots,
  };
  if (persist) writeJson(PATHS.leaders, leaders);
  return leaders;
}
