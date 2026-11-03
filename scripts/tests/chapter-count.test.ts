/**
 * 支線章節列尾的數字（丁 D-主-247；src/domain/chapterCount.ts）。跑法：`node --test scripts/tests/chapter-count.test.ts`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterCount, chapterParts } from "../../src/domain/chapterCount.ts";

const n = (kind: string, done = false) => ({ kind, done });

test("數直屬：列車（含車廂）＝班、車票＝張、支線＝條；済只算列車與車票", () => {
  const c = chapterCount([n("train", true), n("train"), n("ticket", true), n("ticket"), n("branch", true)], (x) => x.done);
  assert.deepEqual(c, { trains: 2, tickets: 2, branches: 1, done: 2 });
  assert.deepEqual(chapterParts(c), ["1 條支線", "2 班", "2 張"]);
});

test("空的支線", () => {
  assert.deepEqual(chapterParts(chapterCount([], () => false)), ["還沒有內容"]);
});
