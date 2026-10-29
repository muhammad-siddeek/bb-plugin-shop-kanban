import { withoutToolHelp } from "./agents";
import { oneLine } from "./text";

export const LABEL_PROMPT_VERSION = 6;
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

/** A `@thread:<id>` mention in a user message; the mentioned thread's title tells the labeler what "this" means. */
export const THREAD_MENTION = /@thread:(thr_\w+)/gu;

/**
 * A harness notice (`<irc>…`, `<system-notice>…`, `<system-reminder>…`): harnesses send these as user turns, but
 * they aren't the user's words, so they neither describe the thread nor retitle it.
 */
export const HARNESS_NOTICE = /^\s*<[a-z][\w-]*[\s>]/iu;

function userHistory(messages: string[]): string {
  const last = messages.length - 1;
  // Opening and latest messages carry the most intent; middle ones are trimmed hard. The latest one is shown once,
  // here, so it doesn't outweigh the rest of the thread when the model picks a title.
  const lines = messages.map((text, index) => `${index + 1}. ${clip(oneLine(text), index === last ? 1_500 : index === 0 ? 700 : 220)}`);
  let joined = lines.join("\n");
  while (joined.length > 5_000 && lines.length > 3) {
    lines.splice(1, 1);
    joined = [lines[0], "…", ...lines.slice(1)].join("\n");
  }
  return joined || "(none)";
}

export function labelPrompt(input: {
  /** The title the labeler last wrote for this thread. */
  currentTitle: string | null;
  firstPrompt: string | null;
  prompts: string[];
  output: string | null;
  running: boolean;
  /** "[category] intent" titles of the other threads on the board. */
  board: string[];
  /** Titles of threads the user's messages mention, by thread id. */
  mentionTitles: Record<string, string>;
}): string {
  // The user's own words: without harness notices or the board instructions appended to spawned threads'
  // prompts, and with each mentioned thread's title.
  const user = (text: string) =>
    withoutToolHelp(text).replace(THREAD_MENTION, (mention, id: string) =>
      input.mentionTitles[id] ? `${mention} ("${input.mentionTitles[id]}")` : mention,
    );
  const messages = input.firstPrompt && input.prompts[0] !== input.firstPrompt ? [input.firstPrompt, ...input.prompts] : input.prompts;
  const written = messages.filter((text) => !HARNESS_NOTICE.test(text)).map(user);
  return [
    input.board.length
      ? `Other threads on the board:\n${input.board.map((title) => `- ${title}`).join("\n")}`
      : "No other threads on the board.",
    `Current title of this thread, written from its earlier messages: ${input.currentTitle ?? "(none yet)"}`,
    `User messages in this thread, oldest first; the last one is the latest exchange:\n"""\n${userHistory(written)}\n"""`,
    input.running
      ? "The agent is still working on the last user message."
      : `Agent's latest reply (it has finished):\n"""\n${clip(input.output, 3_500) || "(none)"}\n"""`,
    "",
    'Return JSON: {"category": string, "intent": string, "summary": string, "needsInput": boolean}',
    '- category: what the thread is about, named the way the user\'s messages name it: the product, repo, project, tool or topic, in 1-2 lowercase words, e.g. "checkout api", "docs site", "ci pipeline". A name, not an activity. Other threads\' categories only settle spelling: reuse one when it names this same thing, never for anything else.',
    '- intent: at most 5 words, lowercase imperative, the user\'s overall goal across all their messages, e.g. "refine UI", "fix flaky checkout test". Keep acronyms and proper nouns; don\'t repeat the category. Most messages are steps toward the goal earlier ones set, and the latest one usually is too: keep the current title if it still names that goal. Replace it only if it is wrong or the user now wants something different (e.g. from explaining a problem to fixing it). Commit, release, review, test, "keep going" and "try again" are steps, never the goal.',
    // Room for about one more card line than the old 18 words: the card shows two lines, and hovering it adds a third.
    input.running
      ? '- summary: one sentence, at most 24 words, saying what the agent is doing now for the last user message and what that involves, present progressive, e.g. "Making board clicks scroll to the latest message and keeping the selected card in view."'
      : '- summary: one sentence, at most 24 words, saying what happened in the latest exchange: the main changes or findings, past tense, no "I", e.g. "Made the board denser, synced titles with bb threads, and added a blocked reason; typecheck passes." Only if it stopped to ask the user something, end with what it needs, e.g. "…; asks whether to merge duplicates."',
    "- needsInput: true only if the reply directly asks the user a question (or says it is waiting on them) and the agent cannot continue the work until they answer. False when the work is finished, even if the reply lists suggested next steps, recommendations, decisions for later, things to review or verify, or optional offers (\"I can also…\", \"let me know if you want…\").",
    'Example: {"category": "checkout api", "intent": "fix flaky payment test", "summary": "…", "needsInput": false}',
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
  // The model's phrase, whole: one cut short ("rank and", "add PR queue with") reads as a typo, and small models
  // often run a word or two past the asked length. The caps only stop runaway replies, at a word boundary.
  const phrase = (value: unknown, maxChars: number) => {
    if (typeof value !== "string") return "";
    const text = oneLine(value.replace(/[\[\]"]/g, ""));
    if (text.length <= maxChars) return text;
    const cut = text.slice(0, maxChars + 1);
    const space = cut.lastIndexOf(" ");
    // One word longer than the limit has no boundary to cut at; keep its first maxChars characters.
    return (space > 0 ? cut.slice(0, space) : text.slice(0, maxChars)).trim();
  };
  const category = phrase(raw.category, 32).toLowerCase();
  const intent = phrase(raw.intent, 60).replace(/[.!]+$/u, "");
  const summary = typeof raw.summary === "string" ? oneLine(raw.summary).slice(0, 280) : "";
  if (!category || !intent || !summary) return null;
  return { category, intent, summary, needsInput: raw.needsInput === true };
}

