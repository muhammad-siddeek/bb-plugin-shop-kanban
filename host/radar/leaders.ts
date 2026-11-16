// Leadership context is updated from durable per-leader contribution checkpoints, never a rolling lookback.
import { CONFIG, PATHS } from "./config";
import { lit, runCode } from "./gateway";
import { structured } from "./llm";
import { readJson, writeJson } from "./store";

export interface ChainMember {
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

async function gather(cached: Leaders | null, now: number): Promise<Gathered> {
  return runCode<Gathered>(`
const str = (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x));
const me = str(await vault.get_current_user());
const chart = me.split('**Organizational Chart:**')[1]?.split('\\n## ')[0] ?? '';
const links = [...chart.matchAll(/\\[([^\\]]+)\\]\\((https:\\/\\/vault\\.shopify\\.io\\/users\\/[^)]+)\\):\\s*(.+)/g)];
const chain = await Promise.all(links.map(async (m) => {
  const profile = str(await vault.get_user(m[2]));
  return {
    name: m[1],
    title: m[3].replace(/&amp;/g, '&').trim(),
    vaultUrl: m[2],
    slackId: profile.match(/Slack ID:\\s*([UW][A-Z0-9]+)/)?.[1] ?? '',
  };
}));
const cursors: Record<string, number> = ${lit(cached?.cursors ?? {})};
const contributions = await Promise.all(chain.filter((member) => member.slackId !== ${lit(CONFIG.me.slackId)}).map(async (member) => {
  const key = 'vault:contributions:' + member.vaultUrl;
  const start = new Date((cursors[key] ?? 0) * 1000).toISOString().slice(0, 10);
  const end = ${lit(new Date(now * 1000).toISOString().slice(0, 10))};
  const read = async (from: string, to: string): Promise<string> => {
    const text = str(await vault.get_user_contributions(member.vaultUrl, { start_date: from, end_date: to }));
    if (!/Results limited to|\\btruncated\\b/i.test(text)) return text;
    const lo = Date.parse(from), hi = Date.parse(to);
    if (lo >= hi) throw new Error('Vault returned truncated contributions for ' + member.name + ' on ' + from);
    const mid = Math.floor((lo + hi) / 2 / 86400000) * 86400000;
    const left = new Date(mid).toISOString().slice(0, 10);
    const right = new Date(mid + 86400000).toISOString().slice(0, 10);
    return await read(from, left) + '\\n' + await read(right, to);
  };
  return { key, name: member.name + ' (' + member.title + ')', text: await read(start, end) };
}));
return { chain, contributions };`);
}

const SYSTEM = `You maintain what Shopify leadership is actively pushing, from Vault contributions (projects,
posts, PRs, decisions) by the reader's management chain, from the CEO down.
The reader is a senior engineer on ExP (Experiments Platform) and wants to know which directions are
leadership-backed so they can align new tools/ideas with them.
Update the prior priorities using new contributions. Preserve prior supported priorities and stable ids unless
new evidence explicitly replaces or contradicts them. Do not expire priorities by age or impose an item limit.
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
  const out = await structured<{ priorities: Priority[] }>({
    system: SYSTEM,
    user: [
      `# Prior leadership priorities\n${JSON.stringify(cached?.priorities ?? [])}`,
      `# Current management chain\n${JSON.stringify(chain)}`,
      ...changed.map((contribution) => `# ${contribution.name}\n${contribution.text}`),
    ].join("\n\n"),
    schema: {
      type: "object",
      required: ["priorities"],
      properties: {
        priorities: {
          type: "array",
          items: {
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
        },
      },
    },
  });
  const leaders: Leaders = {
    ...cached,
    refreshedAt: new Date().toISOString(),
    chain,
    priorities: out.priorities,
    cursors,
    snapshots,
  };
  if (persist) writeJson(PATHS.leaders, leaders);
  return leaders;
}
