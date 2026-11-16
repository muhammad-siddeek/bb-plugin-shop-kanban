// Durable ExP context: fold changed Vault snapshots and new Slack activity into the prior problem registry.
import { CONFIG, PATHS } from "./config";
import { lit, runCode } from "./gateway";
import { structured } from "./llm";
import { permalink, scanChannel, type SlackChannelState } from "./slack";
import { readJson, writeJson } from "./store";

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
  cursors?: Record<string, number>;
  channels?: Record<string, SlackChannelState>;
  snapshots?: Record<string, string>;
}

interface Sources {
  changes: string[];
  cursors: Record<string, number>;
  channels: Record<string, SlackChannelState>;
  snapshots: Record<string, string>;
}

async function gatherSources(cached: Registry | null, now: number): Promise<Sources> {
  const snapshots = await runCode<Record<string, string>>(`
const str = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
const complete = (text: string, limit?: number) => {
  if (/Results limited to|\\btruncated\\b/i.test(text) || (limit !== undefined && [...text.matchAll(/^\\|\\s*\\d+\\s*\\|/gm)].length >= limit)) {
    throw new Error('Vault returned truncated registry context');
  }
  return text;
};
const team = complete(str(await vault.get_team(${lit(CONFIG.team.vaultId)})));
const list = complete(str(await vault.get_projects({ team_id: ${lit(CONFIG.team.vaultId)}, status: 'active', limit: 100 })), 100);
const ids = [...list.matchAll(/^\\|\\s*(\\d+)\\s*\\|/gm)].map((match) => match[1]);
const projects = await Promise.all(ids.map(async (id) => [id, complete(str(await vault.get_project(id)))] as const));
const issues = complete(str(await vault.get_issues({ team_id: ${lit(CONFIG.team.issuesUrl)}, status: 'open', limit: 200 })), 200);
return {
  ${lit(`vault:team:${CONFIG.team.vaultId}`)}: team,
  ${lit(`vault:projects:${CONFIG.team.vaultId}`)}: list,
  ${lit(`vault:issues:${CONFIG.team.issuesUrl}`)}: issues,
  ...Object.fromEntries(projects.map(([id, text]) => ['vault:project:' + id, text])),
};`);
  const changes = Object.entries(snapshots)
    .filter(([key, text]) => cached?.snapshots?.[key] !== text)
    .map(([key, text]) => `# ${key}\n${text}`);
  for (const key of Object.keys(cached?.snapshots ?? {})) {
    if (!(key in snapshots)) changes.push(`# ${key}\nThis source is no longer in the active project list.`);
  }
  const cursors = { ...cached?.cursors };
  const channels = { ...cached?.channels };
  for (const key of Object.keys(snapshots)) cursors[key] = Math.max(cursors[key] ?? 0, now);
  for (const channel of CONFIG.team.channels) {
    const key = `slack:${channel.id}`;
    const scanned = await scanChannel(channel.id, cursors[key] ?? 0, now, channels[key]);
    if (scanned.messages.length) changes.push(
      `# New #${channel.name} activity\n${scanned.messages.map((message) =>
        `${permalink(channel.id, message.ts)}\n${JSON.stringify(scanned.state.threads[message.ts])}`).join("\n\n")}`,
    );
    channels[key] = scanned.state;
    cursors[key] = Math.max(cursors[key] ?? 0, now);
  }
  return { changes, cursors, channels, snapshots };
}

const SYSTEM = `You maintain a problem registry for ExP (Shopify's Experiments Platform team).
The registry is used to match new AI tools, findings and leadership initiatives against what the team owns.
Update the prior registry using every changed source below. Retain all supported problem cards, covering:
- open problems inside each active GSD project (the hard parts, risks, blockers — not just the project title)
- recurring support asks and confusions in #help-exp (cluster repeated questions into one card)
- maintenance, toil, performance, reliability and security work (open issues, on-call pain, migrations)
Rules:
- Preserve prior problems and stable ids unless new evidence explicitly resolves, replaces or contradicts them.
- No age-based expiry, arbitrary card limit, or top-N selection: retain every supported problem.
- Only use facts present in the prior registry and sources. Do not invent problems.
- summary: what hurts and why, <= 50 words, concrete (systems, workflows, numbers when given).
- whatWouldHelp: the kinds of technology/approaches that could move it, <= 40 words.
- refs: URLs copied verbatim from the sources (Vault project/issue links, Slack permalinks if present). Empty if none.
- id: short kebab-case, stable across refreshes (derive from the problem, not the date).`;

export async function loadRegistry({ persist = true }: { persist?: boolean } = {}): Promise<Registry> {
  const cached = readJson<Registry | null>(PATHS.registry, null);
  const sources = await gatherSources(cached, Date.now() / 1000);
  if (cached && sources.changes.length === 0) {
    const registry = { ...cached, cursors: sources.cursors, channels: sources.channels, snapshots: sources.snapshots };
    if (persist) writeJson(PATHS.registry, registry);
    return registry;
  }
  const user = [
    `# Prior problem registry\n${JSON.stringify(cached?.problems ?? [])}`,
    ...sources.changes,
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
  const registry: Registry = {
    ...cached,
    refreshedAt: new Date().toISOString(),
    problems: out.problems,
    cursors: sources.cursors,
    channels: sources.channels,
    snapshots: sources.snapshots,
  };
  if (persist) writeJson(PATHS.registry, registry);
  return registry;
}
