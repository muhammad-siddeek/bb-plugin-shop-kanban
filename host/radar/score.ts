import { CONFIG } from "./config";
import type { Message, UserInfo } from "./slack";

export interface Baseline {
  reactorsP90: number;
  replyUsersP90: number;
}

export interface TractionSample {
  reactors: number;
  replyUsers: number;
}

export interface LeadershipSignal {
  score: number;
  reasons: string[];
  headline: string;
}

export interface ReportedIdea {
  ts: string;
  date: string;
  traction: number;
  title: string;
}

const DEFAULT_BASELINE: Baseline = { reactorsP90: 25, replyUsersP90: 8 };

export function computeBaseline(samples: TractionSample[]): Baseline {
  if (samples.length < 30) return DEFAULT_BASELINE;
  const p90 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(0.9 * (xs.length - 1))];
  return {
    reactorsP90: Math.max(1, p90(samples.map((s) => s.reactors))),
    replyUsersP90: Math.max(1, p90(samples.map((s) => s.replyUsers))),
  };
}

export function engagement(msg: Message): TractionSample {
  const reactors = new Set(msg.reactions.flatMap((r) => r.users));
  reactors.delete(msg.user);
  return { reactors: reactors.size, replyUsers: msg.replyUsers.filter((u) => u !== msg.user).length };
}

export function tractionScore(e: TractionSample, confirmations: number, b: Baseline): number {
  return (
    0.5 * Math.min(1, e.reactors / b.reactorsP90) +
    0.3 * Math.min(1, e.replyUsers / b.replyUsersP90) +
    0.2 * Math.min(1, confirmations / 2)
  );
}

function titleWeight(title: string): number {
  if (!title || /\bassistant\b/i.test(title)) return 0;
  if (/\b(CEO|CTO|COO|CFO|CPO|Chief|President|VP|Vice President|Head of)\b/i.test(title)) return 1;
  if (/\b(Director|Distinguished|Fellow)\b/i.test(title)) return 0.8;
  if (/\bPrincipal\b/i.test(title)) return 0.6;
  return 0;
}

const CHAIN_WEIGHT = 0.8;
const ROLE_FACTOR = { author: 1, reply: 0.7, reaction: 0.5 };
const ROLE_PAST = { author: "posted", reply: "replied", reaction: "reacted" };
const PRIORITY_BONUS = 0.3;

export function leadershipSignal(
  msg: Message,
  users: Record<string, UserInfo>,
  chainIds: Set<string>,
  alignedPriorities: string[],
): LeadershipSignal {
  const weightOf = (id: string) =>
    Math.max(titleWeight(users[id]?.title ?? ""), chainIds.has(id) ? CHAIN_WEIGHT : 0);
  const label = (id: string) => {
    const u = users[id];
    const who = u ? `${u.name}${u.title ? ` (${u.title})` : ""}` : id;
    return chainIds.has(id) ? `${who}, your chain` : who;
  };

  let best = 0;
  let strongest = "";
  const reasons: string[] = [];
  const seen = new Set<string>();
  const consider = (ids: string[], role: keyof typeof ROLE_FACTOR, verb: string) => {
    const leaders = [...new Set(ids)]
      .filter((id) => !seen.has(id) && weightOf(id) > 0)
      .sort((a, b) => weightOf(b) - weightOf(a));
    if (leaders.length === 0) return;
    for (const id of leaders) seen.add(id);
    const weight = weightOf(leaders[0]) * ROLE_FACTOR[role];
    if (weight > best) {
      best = weight;
      const u = users[leaders[0]];
      strongest = `${u?.name ?? leaders[0]}${chainIds.has(leaders[0]) ? " (your chain)" : ""} ${ROLE_PAST[role]}`;
    }
    reasons.push(`${verb}: ${leaders.slice(0, 3).map(label).join("; ")}`);
  };
  consider([msg.user], "author", "posted by");
  consider(msg.replyUsers, "reply", "replied");
  consider(msg.reactions.flatMap((r) => r.users), "reaction", "reacted");
  const aligned = alignedPriorities.length > 0;
  if (aligned) reasons.push(`aligns with leadership priority: ${alignedPriorities.join(", ")}`);
  return {
    score: Math.min(1, best + (aligned ? PRIORITY_BONUS : 0)),
    reasons,
    headline: [strongest, aligned ? "leadership priority" : ""].filter(Boolean).join(", "),
  };
}

export function passesEngagement(e: TractionSample, leadership: LeadershipSignal): boolean {
  return e.reactors >= CONFIG.minReactors || e.replyUsers >= 1 || leadership.score >= 0.6;
}

export function novelty(
  ideaKey: string,
  traction: number,
  reported: Record<string, ReportedIdea>,
): { novel: boolean; resurfaced: boolean } {
  const prev = reported[ideaKey];
  if (!prev) return { novel: true, resurfaced: false };
  const resurfaced = traction >= Math.max(prev.traction, 0.1) * CONFIG.resurfaceFactor;
  return { novel: resurfaced, resurfaced };
}

export function rankScore(matchStrength: number, leadership: number, traction: number): number {
  const w = CONFIG.weights;
  return w.match * matchStrength + w.leadership * leadership + w.traction * traction;
}
