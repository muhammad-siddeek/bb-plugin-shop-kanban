// Weekly ExP problem registry: what the team owns and struggles with, distilled into problem cards.
import { CONFIG, PATHS } from "./config";
import { lit, runCode } from "./gateway";
import { structured } from "./llm";
import { ageDays, readJson, writeJson } from "./store";

export const PROBLEM_KINDS = [
  "project",
  "support",
  "maintenance",
  "toil",
  "performance",
  "reliability",
  "security",
  "other",
] as const;

export interface Problem {
  id: string;
  title: string;
  kind: (typeof PROBLEM_KINDS)[number];
  summary: string;
  whatWouldHelp: string;
  refs: { label: string; url: string }[];
}

export interface Registry {
  refreshedAt: string;
  problems: Problem[];
}

interface Sources {
  team: string;
  projects: string[];
  issues: string;
  channels: { name: string; text: string }[];
}

async function gatherSources(): Promise<Sources> {
  const oldest = String(Math.floor(Date.now() / 1000) - 30 * 86_400);
  return runCode<Sources>(`
await slack.who_am_i();
const str = (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x));
const team = str(await vault.get_team(${lit(CONFIG.team.vaultId)}));
const list = str(await vault.get_projects({ team_id: ${lit(CONFIG.team.vaultId)}, status: 'active', limit: 30 }));
const ids = [...list.matchAll(/\\|\\s*(\\d+)\\s*\\|\\s*\\[/g)].map((m) => m[1]);
const projects = await Promise.all(ids.map(async (id) =>
  str(await vault.get_project(id, { include_activity: true, activity_weeks: 4 })).slice(0, 7000)));
const issues = str(await vault.get_issues({ team_id: ${lit(CONFIG.team.issuesUrl)}, status: 'open', limit: 50 })).slice(0, 8000);
const channels = await Promise.all(${lit(CONFIG.team.channels)}.map(async (c: { id: string; name: string }) => {
  const r: unknown = await slack.read_channel(c.id, { limit: 100, oldest: ${lit(oldest)}, response_format: 'concise' });
  const text = typeof r === 'object' && r !== null && 'messages' in r ? str(r.messages) : str(r);
  return { name: c.name, text: text.slice(0, 25000) };
}));
return { team: team.slice(0, 4000), projects, issues, channels };`);
}

const SYSTEM = `You maintain a problem registry for ExP (Shopify's Experiments Platform team).
The registry is used to match new AI tools, findings and leadership initiatives against what the team owns.
Produce 8-15 problem cards covering, where the sources support it:
- open problems inside each active GSD project (the hard parts, risks, blockers — not just the project title)
- recurring support asks and confusions in #help-exp (cluster repeated questions into one card)
- maintenance, toil, performance, reliability and security work (open issues, on-call pain, migrations)
Rules:
- Only use facts present in the sources. Do not invent problems.
- summary: what hurts and why, <= 50 words, concrete (systems, workflows, numbers when given).
- whatWouldHelp: the kinds of technology/approaches that could move it, <= 40 words.
- refs: URLs copied verbatim from the sources (Vault project/issue links, Slack permalinks if present). Empty if none.
- id: short kebab-case, stable across refreshes (derive from the problem, not the date).`;

export async function loadRegistry(force = false): Promise<Registry> {
  const cached = readJson<Registry | null>(PATHS.registry, null);
  if (cached && !force && ageDays(cached.refreshedAt) < CONFIG.registryMaxAgeDays) return cached;

  const s = await gatherSources();
  const user = [
    `# Team\n${s.team}`,
    ...s.projects.map((p, i) => `# GSD project ${i + 1}\n${p}`),
    `# Open issues\n${s.issues}`,
    ...s.channels.map((c) => `# #${c.name} (last 30 days)\n${c.text}`),
  ].join("\n\n");

  const out = await structured<{ problems: Problem[] }>({
    system: SYSTEM,
    user,
    schema: {
      type: "object",
      required: ["problems"],
      properties: {
        problems: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "kind", "summary", "whatWouldHelp", "refs"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              kind: { type: "string", enum: [...PROBLEM_KINDS] },
              summary: { type: "string" },
              whatWouldHelp: { type: "string" },
              refs: {
                type: "array",
                items: {
                  type: "object",
                  required: ["label", "url"],
                  properties: { label: { type: "string" }, url: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  });
  const registry: Registry = { refreshedAt: new Date().toISOString(), problems: out.problems };
  writeJson(PATHS.registry, registry);
  return registry;
}
