import type { BacklogItem } from "./backlog";
import type { Category } from "./classify";
import { CONFIG } from "./config";
import type { Problem } from "./registry";
import type { LeadershipSignal, TractionSample } from "./score";
import type { Picked } from "./watch";

export interface DigestItem {
  id: string;
  ts: string;
  ideaKey: string;
  permalink: string;
  category: Category;
  title: string;
  summary: string;
  whatIsNew: string;
  author: string;
  links: string[];
  leadership: LeadershipSignal;
  engagement: TractionSample;
  confirmations: number;
  traction: number;
  resurfaced: boolean;
}

export interface Pairing extends DigestItem {
  problem: Pick<Problem, "id" | "title" | "kind">;
  priority: "P0" | "P1";
  strength: number;
  why: string;
  tryThis: string;
  score: number;
}

export interface Digest {
  date: string;
  generatedAt: string;
  scanned: number;
  qualified: number;
  pairings: Pairing[];
  others: DigestItem[];
  backlog: BacklogItem[];
  watch: DigestWatch;
}

export interface DigestWatch {
  scanned: number;
  opportunities: Picked[];
  skipped: string[];
  error?: string;
}

export const NO_WATCH: DigestWatch = { scanned: 0, opportunities: [], skipped: [] };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const CATEGORY_EMOJI: Partial<Record<Category, string>> = { new_tech: "🛠️", new_finding: "🔬", leadership_push: "📣" };

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function signals(it: DigestItem): string {
  return [
    it.engagement.reactors ? count(it.engagement.reactors, "reactor") : "",
    it.engagement.replyUsers ? count(it.engagement.replyUsers, "replier") : "",
    it.confirmations ? `${it.confirmations} tried it` : "",
    it.leadership.headline,
    it.resurfaced ? "gaining momentum since last report" : "",
  ].filter(Boolean).join(", ");
}

function ideaBullet(it: DigestItem, priority: string, detail = ""): string {
  const label = `**${priority}** ${CATEGORY_EMOJI[it.category] ?? "💡"} [${it.title}](${it.permalink})${detail}`;
  return [label, signals(it), `\`${it.id}\``].filter(Boolean).join(" · ");
}

function dueLabel(it: BacklogItem): string {
  if (it.fixDue === null || it.daysLeft === null) return "no fix-due date";
  const on = shortDate(it.fixDue);
  if (it.overdue) return `overdue (due ${on})`;
  if (it.daysLeft === 0) return `due today (${on})`;
  if (it.daysLeft === 1) return `due tomorrow (${on})`;
  return `due in ${it.daysLeft}d (${on})`;
}

function backlogBullet(it: BacklogItem): string {
  const others = it.assignees.filter((a) => a.id !== CONFIG.me.vaultId).map((a) => a.name);
  const who = [...(it.mine ? ["you"] : []), ...others].join(", ") || "unassigned";
  return `**${it.priority}** [${it.title}](${it.url}) · ${dueLabel(it)} · ${who}`;
}

function opportunityBullet(o: Picked): string {
  const owner = o.owner === "unowned" ? "unowned" : "partly owned";
  const again = o.resurfaced ? " (again: more evidence)" : "";
  return [
    `**${o.title}**${again} · ask ${o.ask}/5 · ${owner}: ${o.problem} [source](${o.evidence[0].url})`,
    ...o.solutions.map((s, i) => `   ${i + 1}. ${s.idea} (fit ${s.fit} · buy-in ${s.buyIn} · big ${s.ambition})`),
  ].join("\n");
}

export function renderMarkdown(d: Digest): string {
  const section = (title: string, bullets: string[]) => ["", `### ${title.toUpperCase()}`, "", ...bullets.map((b) => `- ${b}`)];
  const watch = d.watch.error
    ? [`Watch sweep failed (${d.watch.error}); see the run log.`]
    : [
        ...d.watch.opportunities.map(opportunityBullet),
        ...(d.watch.skipped.length ? [`Not swept (retried next run): ${d.watch.skipped.join(", ")}`] : []),
      ];
  const ideas = [
    ...d.pairings.map((p) => ideaBullet(p, p.priority, ` → ${p.problem.title} (fit ${p.strength.toFixed(2)}). Try: ${p.tryThis}`)),
    ...d.others.map((o) => ideaBullet(o, "P2")),
  ];
  return [
    ...(d.backlog.length ? section("Resiliency backlog", d.backlog.map(backlogBullet)) : []),
    ...(watch.length ? section("Opportunities", watch) : []),
    ...section(`Ideas from #${CONFIG.channel.name}`, ideas.length ? ideas : ["No new ideas cleared the bar."]),
  ].slice(1).join("\n") + "\n";
}
