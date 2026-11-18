import { CONFIG } from "./config";
import { lit, runCode } from "./gateway";

interface BacklogIssue {
  id: string;
  title: string;
  url: string;
  priority: string;
  fixDue: string | null;
  overdue: boolean;
  assignees: { id: string; name: string }[];
}

export interface BacklogItem extends BacklogIssue {
  daysLeft: number | null;
  mine: boolean;
}

const DAY_MS = 86_400_000;

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function parseIssue(id: string, md: string): BacklogIssue {
  const field = (name: string) => md.match(new RegExp(`^- \\*\\*${name}\\*\\*: (.+)$`, "m"))?.[1].trim();
  const title = md.match(/^# (.+)$/m)?.[1].trim();
  const url = field("URL");
  if (!title || !url) throw new Error(`Vault issue ${id}: unexpected get_issue format`);
  const due = field("Fix Due")?.match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
  const assignees = md.split(/^## Assignees\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return {
    id,
    title: decode(title),
    url,
    priority: field("Priority") ?? "",
    fixDue: due?.[1] ?? null,
    overdue: /OVERDUE/.test(due?.[2] ?? ""),
    assignees: [...assignees.matchAll(/\[@([^\]]+)\]\([^)]*\/users\/(\d+)/g)].map((m) => ({ id: m[2], name: decode(m[1]) })),
  };
}

export async function fetchBacklog(): Promise<BacklogIssue[]> {
  const issues = await runCode<{ id: string; md: string }[]>(`
const list = str(await vault.get_issues({ team_id: ${lit(CONFIG.team.issuesUrl)}, status: 'open', limit: 200 }));
if (/Results limited to/.test(list)) throw new Error('Vault returned a truncated issue list for ' + ${lit(CONFIG.team.issuesUrl)});
const ids = [...list.matchAll(/^\\|\\s*(\\d+)\\s*\\|/gm)].map((m) => m[1]);
return await Promise.all(ids.map(async (id) => ({ id, md: str(await vault.get_issue(id)) })));`);
  return issues.map(({ id, md }) => parseIssue(id, md));
}

export function selectBacklog(issues: BacklogIssue[], date: string): BacklogItem[] {
  return issues
    .map((it) => {
      const daysLeft = it.fixDue === null ? null : Math.round((Date.parse(it.fixDue) - Date.parse(date)) / DAY_MS);
      const overdue = it.overdue || (daysLeft !== null && daysLeft < 0);
      return { ...it, daysLeft, overdue, mine: it.assignees.some((a) => a.id === CONFIG.me.vaultId) };
    })
    .filter((it) => it.mine || (!it.overdue && it.daysLeft !== null && it.daysLeft <= CONFIG.backlogDueWithinDays))
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
        Number(b.mine) - Number(a.mine) ||
        a.priority.localeCompare(b.priority),
    );
}
