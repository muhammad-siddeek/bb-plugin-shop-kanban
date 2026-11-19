import type { ForgePrProgress } from "../contract";
import type { WorkStage } from "./schema";

// Where an open pull request stands, and whose move it is, in the words its row shows. `you`: waiting on the user,
// drawn like a blocked thread; `ready`: approved, the user can merge; `waiting`: on reviewers or CI; `idle`: a draft.

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * An open pull request of the user's. Problems they must fix come first (conflict, failing CI, changes requested),
 * then whether it can merge, then who it waits on. Without progress (not read yet, or the read failed) it says so.
 */
export function prStage(progress: ForgePrProgress | null, draft: boolean): WorkStage {
  if (!progress) return { step: "unknown", tone: "waiting", label: "Reading status…" };
  const { ci, mergeState, approvals, changesRequested, pendingReviewers, failing } = progress;
  if (draft) return { step: "draft", tone: "idle", label: ci === "failure" ? "Draft · CI failing" : "Draft" };
  if (mergeState === "dirty") return { step: "conflict", tone: "you", label: "Merge conflict" };
  if (ci === "failure") return { step: "ci_failing", tone: "you", label: failing.length > 0 ? `CI failing · ${failing.join(", ")}` : "CI failing" };
  if (changesRequested > 0) return { step: "changes_requested", tone: "you", label: "Changes requested" };
  if (ci === "pending") return { step: "ci_running", tone: "waiting", label: approvals > 0 ? "CI running · approved" : "CI running" };
  // Approved and the forge would merge it, or nobody else asked: the merge is the user's. A forge that still blocks it
  // says why on its page.
  if (approvals > 0 && (pendingReviewers === 0 || mergeState === "clean")) {
    return { step: "ready", tone: "ready", label: mergeState === "blocked" ? "Approved · merge blocked" : "Approved · ready to merge" };
  }
  if (mergeState === "behind") return { step: "behind", tone: "you", label: "Behind its base branch" };
  if (pendingReviewers > 0) return { step: "in_review", tone: "waiting", label: `Awaiting ${plural(pendingReviewers, "review")}` };
  return { step: "no_reviewers", tone: "you", label: "No reviewers requested" };
}
