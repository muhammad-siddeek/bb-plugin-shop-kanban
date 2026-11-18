import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIssue, selectBacklog } from "../../host/radar/backlog";
import { CONFIG } from "../../host/radar/config";

const issueMd = (o: { title: string; due?: string; assignees: [id: string, name: string][] }) => `# ${o.title}

- **URL**: https://vault.shopify.io/teams/2902-ExP/issues/1-x
- **Status**: Acknowledged
- **Priority**: P1
- **Issue Type**: Dependency Vulnerability

## SLA Information
${o.due ? `- **Fix Due**: ${o.due}\n` : ""}- **Acknowledged By**: [@Charlie King](https://vault.shopify.io/users/20294-Charlie-King)

## Assignees
${o.assignees.map(([id, name]) => `- [@${name}](https://vault.shopify.io/users/${id}-${name.replace(" ", "-")})`).join("\n")}

## Timeline
- **Created**: 2026-10-07
`;

const ME = CONFIG.me.vaultId;
const OTHER: [string, string] = ["32361", "Yahya Massoud"];

test("parseIssue reads title, SLA verdict and assignees from Vault markdown", () => {
  const it = parseIssue("1", issueMd({ title: "Stale playbook: Experiment &amp; Flag", due: "2026-10-13 (OVERDUE)", assignees: [OTHER, [ME, "Me Myself"]] }));
  assert.deepEqual(
    { title: it.title, priority: it.priority, fixDue: it.fixDue, overdue: it.overdue, assignees: it.assignees.map((a) => a.id) },
    { title: "Stale playbook: Experiment & Flag", priority: "P1", fixDue: "2026-10-13", overdue: true, assignees: ["32361", ME] },
  );
});

test("selectBacklog keeps anyone's issue due within the window and all of mine, most urgent first", () => {
  const issue = (title: string, due: string | undefined, who: [string, string]) => parseIssue(title, issueMd({ title, due, assignees: [who] }));
  const today = "2026-10-13";
  const W = CONFIG.backlogDueWithinDays;
  const inDays = (n: number) => new Date(Date.parse(today) + n * 86_400_000).toISOString().slice(0, 10);
  const items = selectBacklog(
    [
      issue("theirs-past-window", inDays(W + 1), OTHER),
      issue("theirs-window-edge", inDays(W), OTHER),
      issue("theirs-overdue", `${today} (OVERDUE)`, OTHER),
      issue("theirs-no-sla", undefined, OTHER),
      issue("mine-later", inDays(W + 2), [ME, "Me"]),
      issue("mine-overdue", `${inDays(-7)} (OVERDUE)`, [ME, "Me"]),
      issue("mine-no-sla", undefined, [ME, "Me"]),
    ],
    today,
  );
  assert.deepEqual(
    items.map((it) => [it.title, it.daysLeft]),
    [
      ["mine-overdue", -7],
      ["theirs-window-edge", W],
      ["mine-later", W + 2],
      ["mine-no-sla", null],
    ],
  );
});
