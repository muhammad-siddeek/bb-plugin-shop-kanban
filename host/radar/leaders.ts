// Weekly leadership context: your management chain (Slack IDs) and what leadership is pushing.
import { CONFIG, PATHS } from "./config";
import { lit, runCode } from "./gateway";
import { structured } from "./llm";
import { ageDays, readJson, writeJson } from "./store";

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
}

interface Gathered {
  chain: ChainMember[];
  contributions: { name: string; text: string }[];
}

async function gather(): Promise<Gathered> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
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
const contributions = await Promise.all(chain.map(async (c) => ({
  name: c.name + ' (' + c.title + ')',
  text: str(await vault.get_user_contributions(c.vaultUrl, { start_date: ${lit(since)} })).slice(0, 7000),
})));
return { chain, contributions };`);
}

const SYSTEM = `You extract what Shopify leadership is actively pushing, from the last 30 days of Vault
contributions (projects, posts, PRs, decisions) by the reader's management chain, from the CEO down.
The reader is a senior engineer on ExP (Experiments Platform) and wants to know which directions are
leadership-backed so they can align new tools/ideas with them.
Return 4-10 priorities. Each: id (short kebab-case, stable), theme (<= 8 words), description (<= 40 words:
what leadership wants to happen and why), evidence (titles + URLs copied verbatim from the sources, with who).
Prefer org-wide directions (e.g. agent automation of backlogs, AI adoption programs, platform shifts) over
one person's routine PRs. Do not invent anything not supported by the sources.`;

export async function loadLeaders(force = false): Promise<Leaders> {
  const cached = readJson<Leaders | null>(PATHS.leaders, null);
  if (cached && !force && ageDays(cached.refreshedAt) < CONFIG.leadersMaxAgeDays) return cached;

  const g = await gather();
  const out = await structured<{ priorities: Priority[] }>({
    system: SYSTEM,
    user: g.contributions.map((c) => `# ${c.name}\n${c.text}`).join("\n\n"),
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
    refreshedAt: new Date().toISOString(),
    chain: g.chain.filter((c) => c.slackId !== CONFIG.me.slackId),
    priorities: out.priorities,
  };
  writeJson(PATHS.leaders, leaders);
  return leaders;
}
