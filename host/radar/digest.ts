// Inbox-compatible discovery snapshot and its local markdown rendering.
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
  /** P0: fit ≥ CONFIG.p0MatchStrength; P1: any other pairing. Unpaired ideas are P2. */
  priority: "P0" | "P1";
  strength: number;
  why: string;
  tryThis: string;
  score: number;
}

export interface Digest {
  date: string;
  generatedAt: string;
  /** Elapsed time covered by this incremental scan; not a discovery lookback limit. */
  windowHours: number;
  scanned: number;
  qualified: number;
  /** ExP pairings, most promising first. */
  pairings: Pairing[];
  /** Less relevant: unpaired ideas, most promising first. */
  others: DigestItem[];
  /** Retained for imported snapshots; new scans keep every qualified idea and report zero hidden. */
  othersHidden: number;
  /** Resiliency backlog: my open issues and anyone's issues about to breach their fix-due SLA, most urgent first. */
  backlog: BacklogItem[];
  /** Opportunity watch: big unowned asks with three ranked solutions; `error` when the sweep failed. */
  watch: DigestWatch;
}

export interface DigestWatch {
  scanned: number;
  opportunities: Picked[];
  /** Sources that failed this sweep; the next run retries them. */
  skipped: string[];
  error?: string;
}

export const NO_WATCH: DigestWatch = { scanned: 0, opportunities: [], skipped: [] };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Compact traction line; zero counts are omitted. */
function signals(it: DigestItem): string {
  const parts = [
    it.engagement.reactors ? count(it.engagement.reactors, "reactor") : "",
    it.engagement.replyUsers ? count(it.engagement.replyUsers, "replier") : "",
    it.confirmations ? `${it.confirmations} tried it` : "",
    it.leadership.headline,
    it.resurfaced ? "gaining momentum since last report" : "",
  ];
  return parts.filter(Boolean).join(", ");
}

interface Format {
  link: (url: string, text: string) => string;
  bold: (s: string) => string;
  code: (s: string) => string;
  heading: (s: string) => string;
  bullet: string;
}

const CATEGORY_EMOJI: Partial<Record<Category, string>> = { new_tech: "🛠️", new_finding: "🔬", leadership_push: "📣" };

const ideaLabel = (it: DigestItem, priority: string, f: Format) =>
  `${f.bold(priority)} ${CATEGORY_EMOJI[it.category] ?? "💡"} ${f.link(it.permalink, it.title)}`;

/** One bullet per idea: P0/P1 for ExP pairings, then P2 for the best unpaired ideas. */
function ideaBullets(d: Digest, f: Format): string[] {
  const join = (parts: string[]) => parts.filter(Boolean).join(" · ");
  const out = [
    ...d.pairings.map((p) =>
      join([
        `${ideaLabel(p, p.priority, f)} → ${p.problem.title} (fit ${p.strength.toFixed(2)}). Try: ${p.tryThis}`,
        signals(p),
        f.code(p.id),
      ]),
    ),
    ...d.others.map((o) => join([ideaLabel(o, "P2", f), signals(o), f.code(o.id)])),
  ];
  if (d.othersHidden) out.push(`+${count(d.othersHidden, "more idea")}`);
  if (!out.length) out.push("No new ideas cleared the bar.");
  return out;
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function dueLabel(it: BacklogItem): string {
  if (it.fixDue === null || it.daysLeft === null) return "no fix-due date";
  const on = shortDate(it.fixDue);
  if (it.overdue) return `overdue (due ${on})`;
  if (it.daysLeft === 0) return `due today (${on})`;
  if (it.daysLeft === 1) return `due tomorrow (${on})`;
  return `due in ${it.daysLeft}d (${on})`;
}

function backlogBullet(it: BacklogItem, f: Format): string {
  const others = it.assignees.filter((a) => a.id !== CONFIG.me.vaultId).map((a) => a.name);
  const who = [...(it.mine ? ["you"] : []), ...others].join(", ") || "unassigned";
  return `${f.bold(it.priority)} ${f.link(it.url, it.title)} · ${dueLabel(it)} · ${who}`;
}

/** One bullet per opportunity: title, ask and problem, then its three solutions, best-ranked first. */
function opportunityBullet(o: Picked, f: Format): string {
  const owner = o.owner === "unowned" ? "unowned" : "partly owned";
  const again = o.resurfaced ? " (again: more evidence)" : "";
  const solutions = o.solutions.map(
    (s, i) => `   ${i + 1}. ${s.idea} (fit ${s.fit} · buy-in ${s.buyIn} · big ${s.ambition})`,
  );
  return [
    `${f.bold(o.title)}${again} · ask ${o.ask}/5 · ${owner}: ${o.problem} ${f.link(o.evidence[0].url, "source")}`,
    ...solutions,
  ].join("\n");
}

/** Render the complete backlog, opportunities and ideas without delivery-specific limits. */
function lines(d: Digest, f: Format): string[] {
  const section = (title: string, bullets: string[]) => ["", f.heading(title.toUpperCase()), "", ...bullets.map((b) => `${f.bullet}${b}`)];
  const watch = d.watch.error
    ? [`Watch sweep failed (${d.watch.error}); see the run log.`]
    : [
        ...d.watch.opportunities.map((o) => opportunityBullet(o, f)),
        ...(d.watch.skipped.length ? [`Not swept (retried next run): ${d.watch.skipped.join(", ")}`] : []),
      ];
  return [
    ...(d.backlog.length ? section("Resiliency backlog", d.backlog.map((it) => backlogBullet(it, f))) : []),
    ...(watch.length ? section("Opportunities", watch) : []),
    ...section(`Ideas from #${CONFIG.channel.name}`, ideaBullets(d, f)),
  ].slice(1);
}

export function renderMarkdown(d: Digest): string {
  const out = lines(d, {
    link: (url, text) => `[${text}](${url})`,
    bold: (s) => `**${s}**`,
    code: (s) => `\`${s}\``,
    heading: (s) => `### ${s}`,
    bullet: "- ",
  });
  return out.join("\n") + "\n";
}

