import { test } from "node:test";
import assert from "node:assert/strict";
import type { ForgePrProgress } from "../contract";
import { prStage } from "../server/stage";

const base: ForgePrProgress = { headSha: "abc", mergeState: "blocked", approvals: 0, changesRequested: 0, pendingReviewers: 0, ci: "success", failing: [] };
const step = (patch: Partial<ForgePrProgress>, draft = false) => prStage({ ...base, ...patch }, draft).step;

test("problems the author must fix outrank approvals and pending reviewers", () => {
  assert.equal(step({ mergeState: "dirty", ci: "failure", approvals: 2 }), "conflict");
  assert.equal(step({ ci: "failure", changesRequested: 1, approvals: 1 }), "ci_failing");
  assert.equal(step({ changesRequested: 1, approvals: 1, pendingReviewers: 0 }), "changes_requested");
  assert.equal(prStage({ ...base, ci: "failure", failing: ["lint", "tests"] }, false).label, "CI failing · lint, tests");
});

test("an approval is the user's merge once nobody else is pending, or the forge says clean", () => {
  assert.equal(step({ approvals: 1, pendingReviewers: 2 }), "in_review");
  assert.equal(step({ approvals: 1, pendingReviewers: 2, mergeState: "clean" }), "ready");
  assert.equal(step({ approvals: 2, pendingReviewers: 0 }), "ready");
  // CI still running holds an approved pull request in waiting rather than ready.
  assert.equal(step({ approvals: 2, ci: "pending" }), "ci_running");
});

test("drafts stay idle, and an unread status says so instead of guessing", () => {
  assert.equal(step({ mergeState: "dirty", ci: "failure" }, true), "draft");
  assert.deepEqual(prStage(null, false), { step: "unknown", tone: "waiting", label: "Reading status…" });
  assert.equal(prStage({ ...base }, false).tone, "you");
});
