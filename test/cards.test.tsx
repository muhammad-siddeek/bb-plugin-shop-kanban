import "./dom";
import React from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TaskCard } from "../ui/card";
import { WorkGroup, useWorkItems } from "../ui/work";
import type { WorkApi } from "../ui/hooks";
import { groupTasksByColumn, type BoardState, type BoardTask, type WorkItem } from "../ui/model";

const at = "2026-11-17T12:00:00Z", now = Date.parse(at);
afterEach(cleanup);
const task: BoardTask = {
  threadId: "thread-test", shortName: "[test] Finish task", titleChain: "[test] Finish task", status: "done", column: "done",
  parentThreadId: null, projectId: null, description: null, result: null, note: "Finished", childCount: 0, runningChildCount: 0,
  statusReason: "Completed", startable: false, unread: false, domain: "shopify", createdAt: at, updatedAt: at,
  lastUserInputAt: at, completedAt: at, missingThread: false, thread: null, session: null,
};
const item: WorkItem = {
  id: "github:test/repo#1", list: "shipped", forge: "github", repo: "test/repo", number: 1,
  url: "https://github.com/test/repo/pull/1", title: "Ship a change", author: "author", draft: false, labels: [],
  createdAt: at, updatedAt: at, mergedAt: at, measured: false, demoed: false, stage: null,
};

test("direct unread and archive controls do not open the parent thread", () => {
  const opened: string[] = [], unread: string[] = [], archived: string[] = [];
  const slot = renderSlot({ component: TaskCard }, {
    task, now, unread: false, selected: false, dragging: false, starting: false,
    onArchive: id => archived.push(id), onPark: () => {}, onMarkUnread: id => unread.push(id), onStart: () => {}, onDragChange: () => {}, onOpen: id => opened.push(id),
  });
  fireEvent.click(slot.getByRole("button", { name: "Mark thread unread" }));
  fireEvent.click(slot.getByRole("button", { name: "Archive thread" }));
  assert.deepEqual(unread, [task.threadId]);
  assert.deepEqual(archived, [task.threadId]);
  assert.deepEqual(opened, []);
  assert.equal(document.querySelector("dialog"), null);
});

test("start control starts the thread directly without a popup or opening the thread", () => {
  const started: string[] = [], opened: string[] = [];
  const slot = renderSlot({ component: TaskCard }, {
    task: { ...task, status: "queue", column: "queue", startable: true }, now, unread: false, selected: false, dragging: false, starting: false,
    onArchive: () => {}, onPark: () => {}, onMarkUnread: () => {}, onStart: id => started.push(id), onDragChange: () => {}, onOpen: id => opened.push(id),
  });
  fireEvent.click(slot.getByRole("button", { name: "Start thread now" }));
  assert.deepEqual(started, [task.threadId]);
  assert.deepEqual(opened, []);
  assert.equal(document.querySelector("dialog"), null);
});

test("failed shipped follow-up rolls back and both successful follow-ups remove the item", async () => {
  let fail = true;
  const calls: string[] = [];
  const api: WorkApi = {
    state: { items: [item], lists: ["shipped"], sources: [], refreshedAt: at, refreshing: false, error: null }, error: null,
    mark: async (_id, mark) => { calls.push(mark); if (fail) throw new Error("Offline"); },
  };
  function Cards() { return <WorkGroup list="shipped" work={useWorkItems(api)} now={now} />; }
  const slot = renderSlot({ component: Cards }, {});
  fireEvent.click(slot.getByRole("button", { name: "Measured" }));
  await waitFor(() => {
    assert.equal(slot.getByRole("button", { name: "Measured" }).getAttribute("aria-pressed"), "false");
    assert.match(slot.getByRole("alert").textContent ?? "", /Offline/);
  });
  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Measured" }));
  await waitFor(() => assert.equal(slot.getByRole("button", { name: "Measured" }).getAttribute("aria-pressed"), "true"));
  fireEvent.click(slot.getByRole("button", { name: "Demoed" }));
  await waitFor(() => assert.equal(Boolean(slot.queryByText(item.title)), false, "Shipped card remains after both follow-ups"));
  assert.deepEqual(calls, ["measured", "measured", "demoed"]);
});

test("Done keeps a card's place when it is read or marked unread", () => {
  const done = (threadId: string, completedAt: string, unread: boolean): BoardTask => ({ ...task, threadId, completedAt, unread });
  const order = (tasks: BoardTask[]) =>
    groupTasksByColumn({ columns: [], tasks, wipLimit: null } as unknown as BoardState, new Map()).get("done")?.map((card) => card.threadId);
  const newest = "2026-11-17T12:00:00Z", middle = "2026-11-17T11:00:00Z", oldest = "2026-11-17T10:00:00Z";
  const before = order([done("old", oldest, true), done("new", newest, false), done("mid", middle, true)]);
  const after = order([done("old", oldest, false), done("new", newest, true), done("mid", middle, false)]);
  assert.deepEqual(before, ["new", "mid", "old"]);
  assert.deepEqual(after, before);
});
