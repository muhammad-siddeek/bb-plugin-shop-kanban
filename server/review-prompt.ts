import type { Forge, ForgePr, ForgePrDetail } from "../contract";
import type { ReviewRisk } from "./schema";
import { oneLine } from "./text";

// What the review queue asks of models: the small labeler model's "[risk] what, why" first read of a pull
// request, and the prompt that seeds a new thread explaining it.

export const REVIEW_SUMMARY_VERSION = 1;
const CHANGED_FILES_MAX = 80;
const SENTENCE_MAX = 220;

const FORGE_NAME: Record<Forge, string> = { delta: "Delta", github: "GitHub" };

export const REVIEW_SYSTEM = [
  "You give a code reviewer a first read of a pull request before they open it.",
  "Reply with only one JSON object and nothing else:",
  '{"risk":"low|medium|high","what":"...","why":"...","risk_reason":"..."}',
  "- what: one sentence on what the change does, concrete (name the feature, API or area), at most 25 words.",
  "- why: one sentence on the problem it solves or what it enables, at most 20 words. Infer cautiously when the description does not say.",
  "- risk: how likely merging it breaks production, users or other teams.",
  "  high: money, auth, permissions, security, data migrations or deletion, shared infrastructure, or large behavior changes without tests.",
  "  medium: behavior changes in production code with a moderate blast radius.",
  "  low: docs, tests, comments, dev tooling, isolated additive code, or changes behind an off-by-default flag.",
  "- risk_reason: one sentence on what could break, or why little can, at most 20 words.",
  "Plain sentences without markdown. Do not restate the title.",
].join("\n");

type ReviewPr = ForgePr & { forge: Forge };

function sizeLine(detail: ForgePrDetail | null): string | null {
  if (!detail || detail.additions === null || detail.deletions === null) return null;
  const files = detail.changedFiles ?? detail.files.length;
  return `+${detail.additions} −${detail.deletions} in ${files} file${files === 1 ? "" : "s"}`;
}

export function reviewPrompt(pr: ReviewPr, detail: ForgePrDetail | null): string {
  const files = detail?.files ?? [];
  const patches = files.filter((file) => file.patch);
  const size = sizeLine(detail);
  return [
    `Pull request: ${pr.repo}#${pr.number} on ${FORGE_NAME[pr.forge]}`,
    `Title: ${pr.title}`,
    `Author: ${pr.author}${pr.bot ? " (an agent or bot)" : ""}`,
    pr.labels.length ? `Labels: ${pr.labels.join(", ")}` : null,
    size ? `Size: ${size}` : null,
    "",
    "Description:",
    detail?.body || "(none)",
    files.length ? "\nChanged files:" : null,
    ...files.slice(0, CHANGED_FILES_MAX).map((file) => `${file.status ?? "changed"} ${file.path} (+${file.additions ?? "?"} −${file.deletions ?? "?"})`),
    files.length > CHANGED_FILES_MAX ? `… and ${files.length - CHANGED_FILES_MAX} more` : null,
    patches.length ? "\nDiff excerpt:" : null,
    ...patches.map((file) => `--- ${file.path}\n${file.patch}`),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** The model's JSON as a risk and up to three sentences: what, why, what could break. */
export function parseReviewSummary(text: string): { risk: ReviewRisk; text: string } | null {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const fields = raw as Record<string, unknown>;
  const risk = fields.risk;
  if (risk !== "low" && risk !== "medium" && risk !== "high") return null;
  const sentences = [fields.what, fields.why, fields.risk_reason].flatMap((value) => {
    // One sentence per field keeps the first read at three sentences at most.
    const first = typeof value === "string" ? oneLine(value).split(/(?<=[.!?])\s+/u)[0] : "";
    const sentence = first.slice(0, SENTENCE_MAX).replace(/[\s.!?;:,]+$/u, "");
    return sentence ? [`${sentence}.`] : [];
  });
  return sentences.length ? { risk, text: sentences.join(" ") } : null;
}

/**
 * Seeds a new thread that explains the pull request; the user reads and sends it. `reviewedSha` is the commit the
 * user last reviewed, when commits landed since.
 */
export function draftPrompt(
  pr: ReviewPr,
  detail: ForgePrDetail | null,
  summary: { risk: ReviewRisk | null; text: string | null },
  reviewedSha: string | null,
): string {
  const { repo, number } = pr;
  const read =
    pr.forge === "delta"
      ? `\`dt pr view ${number} -R ${repo}\` for the description and \`dt api -R ${repo} 'repos/${repo}/pulls/${number}/files?per_page=100'\` for the diff`
      : `\`gh pr view ${number} -R ${repo}\` for the description and \`gh pr diff ${number} -R ${repo}\` for the diff`;
  const size = sizeLine(detail);
  const firstRead = summary.text ? `${summary.risk ? `[${summary.risk}] ` : ""}${summary.text}` : null;
  return [
    "Explain this pull request so I can review it.",
    "",
    pr.url,
    `"${pr.title}" by ${pr.author}${size ? ` · ${size}` : ""}`,
    firstRead ? `First read: ${firstRead}` : null,
    reviewedSha ? `I last reviewed it at commit ${reviewedSha}; lead with what changed since then.` : null,
    "",
    `Read it with ${read}, then answer in three short parts:`,
    "- **What changed**: the behavior that differs after it merges, not a file list.",
    "- **Why**: the problem it solves or what it enables.",
    "- **Risk**: low, medium or high; what could break, and what I should check before approving.",
    "",
    "Don't approve, request changes or comment on the pull request.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
