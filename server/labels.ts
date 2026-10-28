import { oneLine } from "./text";

export const LABEL_PROMPT_VERSION = 5;
/** Only in the summary signature: bumping it re-writes every card's summary but keeps the titles. */
export const SUMMARY_PROMPT_VERSION = 3;

export const LABEL_SYSTEM = [
  "You label threads on a Kanban board where each thread is a coding-agent session.",
  "Reply with only one JSON object and nothing else.",
].join(" ");

export function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function clip(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const text = value.replace(/```[\s\S]*?```/g, "[code]").trim();
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}

function userHistory(firstPrompt: string | null, prompts: string[]): string {
  const list = [...prompts];
  if (firstPrompt && list[0] !== firstPrompt) list.unshift(firstPrompt);
  const last = list.length - 1;
  // Opening and latest messages carry the most intent; middle ones are trimmed hard.
  const lines = list.map((text, index) => `${index + 1}. ${clip(oneLine(text), index === 0 || index === last ? 700 : 220)}`);
  let joined = lines.join("\n");
  while (joined.length > 5_000 && lines.length > 3) {
    lines.splice(1, 1);
    joined = [lines[0], "…", ...lines.slice(1)].join("\n");
  }
  return joined || "(none)";
}

export function labelPrompt(input: {
  title: string | null;
  currentTitle: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  prompts: string[];
  output: string | null;
  running: boolean;
  categories: string[];
}): string {
  return [
    input.categories.length
      ? `Categories already on the board: ${input.categories.join(", ")}`
      : "No categories on the board yet.",
    `Current thread title: ${input.currentTitle ?? input.title ?? "(none)"}`,
    `User messages in this thread, oldest first:\n"""\n${userHistory(input.firstPrompt, input.prompts)}\n"""`,
    `Latest user message (the latest exchange is about this):\n"""\n${clip(input.lastPrompt ?? input.firstPrompt, 1_500) || "(none)"}\n"""`,
    input.running
      ? "The agent is still working on the latest user message."
      : `Agent's latest reply (it has finished):\n"""\n${clip(input.output, 3_500) || "(none)"}\n"""`,
    "",
    'Return JSON: {"category": string, "intent": string, "summary": string, "needsInput": boolean}',
    '- category: 1-2 lowercase words naming the product, repo, plugin or tool the work is about, e.g. "checkout api", "docs site", "ci pipeline". Reuse a board category only if this thread is about that same thing; otherwise make a new one. Prefer names that appear in the request.',
    '- intent: the user\'s overall goal across the whole thread in 2-5 words, lowercase imperative, keep acronyms and proper nouns, e.g. "refine UI", "fix flaky checkout test". It must describe what the whole thread is about, not just the first or the latest message. Short follow-ups ("wait for them", "check on agents", "try again") do not change the goal. If later requests moved the work on (e.g. from writing docs to auditing coverage and running CI), the intent must name the broader goal. Keep the current thread title only if it already describes the whole thread; a title that names just the opening request after the work moved on is wrong.',
    // Room for about one more card line than the old 18 words: the card shows two lines, and hovering it adds a third.
    input.running
      ? '- summary: one sentence, at most 24 words, saying what the agent is doing now for the latest user message and what that involves, present progressive, e.g. "Making board clicks scroll to the latest message and keeping the selected card in view."'
      : '- summary: one sentence, at most 24 words, saying what happened in the latest exchange: the main changes or findings, past tense, no "I", e.g. "Made the board denser, synced titles with bb threads, and added a blocked reason; typecheck passes." Only if it stopped to ask the user something, end with what it needs, e.g. "…; asks whether to merge duplicates."',
    "- needsInput: true only if the reply directly asks the user a question (or says it is waiting on them) and the agent cannot continue the work until they answer. False when the work is finished, even if the reply lists suggested next steps, recommendations, decisions for later, things to review or verify, or optional offers (\"I can also…\", \"let me know if you want…\").",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function parseLabel(text: string): { category: string; intent: string; summary: string; needsInput: boolean } | null {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  let raw: Record<string, unknown>;
  try {
    // The match runs from `{` to `}`, so whatever parses is an object.
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Whole words only: a title cut mid-word ("check feasibili") reads as a typo.
  const words = (value: unknown, maxWords: number, maxChars: number) => {
    if (typeof value !== "string") return "";
    const kept = oneLine(value.replace(/[\[\]"]/g, "")).split(" ").slice(0, maxWords).join(" ");
    if (kept.length <= maxChars) return kept.trim();
    const cut = kept.slice(0, maxChars + 1);
    const space = cut.lastIndexOf(" ");
    // One word longer than the limit has no boundary to cut at; keep its first maxChars characters.
    return (space > 0 ? cut.slice(0, space) : kept.slice(0, maxChars)).trim();
  };
  const category = words(raw.category, 2, 24).toLowerCase();
  const intent = words(raw.intent, 6, 40).replace(/[.!]+$/u, "");
  const summary = typeof raw.summary === "string" ? oneLine(raw.summary).slice(0, 280) : "";
  if (!category || !intent || !summary) return null;
  return { category, intent, summary, needsInput: raw.needsInput === true };
}

