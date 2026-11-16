// Reader feedback on digest items; recent entries are fed back into the classify/match prompts.
import { CONFIG, PATHS } from "./config";
import { appendJsonl, readJsonl } from "./store";

export interface FeedbackEntry {
  at: string;
  id: string;
  vote: "up" | "down";
  note: string;
  category: string;
  ideaTitle: string;
  problemTitle: string;
}

export function recordFeedback(entry: FeedbackEntry): void {
  appendJsonl(PATHS.feedback, entry);
}

/** Prompt block with the most recent feedback, or "" when there is none. */
export function feedbackPrompt(): string {
  const recent = readJsonl<FeedbackEntry>(PATHS.feedback).slice(-CONFIG.feedbackExamples);
  if (recent.length === 0) return "";
  const lines = recent.map((f) => {
    const target = f.problemTitle ? ` -> ${f.problemTitle}` : "";
    const note = f.note ? ` (reader note: ${f.note})` : "";
    return `- [${f.vote === "up" ? "useful" : "NOT useful"}] [${f.category}] ${f.ideaTitle}${target}${note}`;
  });
  return `\n\nThe reader rated past digest items. Learn their taste from this:\n${lines.join("\n")}`;
}
