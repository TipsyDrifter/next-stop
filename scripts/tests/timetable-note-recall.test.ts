/**
 * 時刻表⑦：時間塊備註的候選（src/domain/timetableNoteRecall.ts；BlockPanel 的 RecallInput 用）。
 * 跑法：`node --test scripts/tests/timetable-note-recall.test.ts`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockNoteItems } from "../../src/domain/timetableNoteRecall.ts";
import { rankRecall } from "../../src/domain/recall.ts";

const ROWS = [
  { note: "讀論文", category_id: "study", count: 6, last: "2026-10-20T01:00:00.000Z" },
  { note: "讀《三體》", category_id: "read", count: 2, last: "2026-10-30T12:00:00.000Z" },
  { note: "讀《三體》", category_id: "study", count: 1, last: "2026-10-31T12:00:00.000Z" },
  { note: "  ", category_id: "read", count: 3, last: "2026-10-31T12:00:00.000Z" },
];

test("同一句寫在好幾個分類 ⇒ 併成一個：次數相加、最近取最大；空白略過", () => {
  const items = blockNoteItems(ROWS, null);
  assert.equal(items.length, 2);
  const three = items.find((x) => x.text === "讀《三體》");
  assert.ok(three);
  assert.equal(three.count, 3);
  assert.equal(three.last, "2026-10-31T12:00:00.000Z");
  assert.ok(items.every((x) => x.boost === 0));
});

test("面板選的分類寫過的排前面（次數少也一樣）", () => {
  const hits = rankRecall(blockNoteItems(ROWS, "read"), "讀");
  assert.deepEqual(
    hits.map((h) => h.item.text),
    ["讀《三體》", "讀論文"],
  );
  const hits2 = rankRecall(blockNoteItems(ROWS, null), "讀");
  assert.deepEqual(
    hits2.map((h) => h.item.text),
    ["讀論文", "讀《三體》"],
  );
});
