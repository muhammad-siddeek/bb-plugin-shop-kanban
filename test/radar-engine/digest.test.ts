import assert from "node:assert/strict";
import { test } from "node:test";
import { splitLines } from "../../host/radar/digest";

const text = [
  "RESILIENCY BACKLOG",
  "",
  "• backlog one",
  "• backlog two",
  "",
  "OPPORTUNITIES",
  "",
  "• opportunity",
  "   1. fix",
  "   2. platform",
  "   3. agent",
  "",
  "IDEAS FROM #AI-CENTAURS",
  "",
  "• idea",
].join("\n");

test("splitLines sends everything, breaking only between whole items", () => {
  assert.deepEqual(splitLines(text, text.length), [text]);
  // 70 fits the largest block (the opportunity with its heading and solutions) but not two sections together.
  const parts = splitLines(text, 70);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 70));
  // Nothing dropped: rejoining gives back every non-blank line in order.
  const nonBlank = (s: string) => s.split("\n").filter((l) => l.trim());
  assert.deepEqual(parts.flatMap(nonBlank), nonBlank(text));
  // An opportunity keeps its solutions; a heading stays with its first item; no part starts blank.
  assert.ok(parts.some((p) => p.includes("• opportunity\n   1. fix\n   2. platform\n   3. agent")));
  assert.ok(parts.some((p) => p.startsWith("IDEAS FROM #AI-CENTAURS\n\n• idea")));
  assert.ok(parts.every((p) => p.trim() && !p.startsWith("\n")));
});
