/**
 * 同一天的完成數（磨光⑤ N11；src/domain/dayCount.ts）＋誤點數（手機殼班，接縫 #104）。
 * 跑法：`node --test scripts/tests/day-count.test.ts`（node 24，型別剝除；零依賴）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  dayCount,
  dayCountParts,
  dayCountText,
  lateCount,
  lateCountText,
  type DayCountItem,
  type LateCountRow,
} from "../../src/domain/dayCount.ts";

const DONE: DayCountItem = { done: true, settled: true };
const SKIP: DayCountItem = { done: false, settled: true };
const OPEN: DayCountItem = { done: false, settled: false };

describe("dayCount：済才算完成、済＋運休算結清", () => {
  test("空：全 0，不顯示", () => {
    const c = dayCount([]);
    assert.deepEqual(c, { done: 0, total: 0, left: 0 });
    assert.equal(dayCountParts(c), null);
    assert.equal(dayCountText(c), "");
  });

  test("含済：完成 1/3・還有 2 張", () => {
    const c = dayCount([DONE, OPEN, OPEN]);
    assert.deepEqual(c, { done: 1, total: 3, left: 2 });
    assert.equal(dayCountText(c), "完成 1/3・還有 2 張");
  });

  test("含運休：運休不算完成，但從「還有」扣掉（串流舊算法把它算進完成）", () => {
    const c = dayCount([DONE, SKIP, OPEN]);
    assert.deepEqual(c, { done: 1, total: 3, left: 1 });
    assert.equal(dayCountText(c), "完成 1/3・還有 1 張");
  });

  test("全結清（済＋運休）：left=0 ⇒「全部結清」，done 仍只數済", () => {
    const c = dayCount([DONE, DONE, SKIP]);
    assert.deepEqual(c, { done: 2, total: 3, left: 0 });
    assert.equal(dayCountText(c), "完成 2/3・全部結清");
  });

  test("全部済：完成 n/n・全部結清", () => {
    assert.equal(dayCountText(dayCount([DONE, DONE])), "完成 2/2・全部結清");
  });

  test("done 一定算結清，就算呼叫端忘了把 settled 設成 true", () => {
    const c = dayCount([{ done: true, settled: false }, OPEN]);
    assert.deepEqual(c, { done: 1, total: 2, left: 1 });
  });

  test("全是運休：完成 0/n・全部結清", () => {
    assert.equal(dayCountText(dayCount([SKIP, SKIP])), "完成 0/2・全部結清");
  });

  test("parts 與 text 同一份數字", () => {
    const c = dayCount([DONE, OPEN]);
    assert.deepEqual(dayCountParts(c), { done: 1, total: 2, tail: "還有 1 張" });
  });
});

const TODAY = "2026-10-25";
const row = (o: Partial<LateCountRow>): LateCountRow => ({
  bucket: "late",
  status: "todo",
  scheduled_on: "2026-10-20",
  due_on: null,
  occurrence: null,
  ...o,
});

describe("lateCount：誤點＝還沒交代（今日頁與行程表同一支，接縫 #104）", () => {
  test("接縫 #104 原案：誤點區 5 列、其中 1 張今天補済 ⇒ 兩頁都數 4", () => {
    const rows = [
      row({ scheduled_on: "2026-10-18" }),
      row({ scheduled_on: "2026-10-19" }),
      row({ scheduled_on: "2026-10-20", status: "done" }), // 今天補済、留在誤點區原位
      row({ scheduled_on: "2026-10-21" }),
      row({ bucket: "due", scheduled_on: null, due_on: "2026-10-24" }),
      row({ bucket: "today", scheduled_on: TODAY }),
    ];
    assert.deepEqual(lateCount(rows, TODAY), { count: 4, earliest: "2026-10-18" });
    assert.equal(lateCountText(lateCount(rows, TODAY)), "4 件");
  });

  test("定期券的誤點班次：済或運休都算交代；有效日＝班次日", () => {
    const c = lateCount(
      [
        row({ occurrence: { status: "done", due_on: "2026-10-22" }, scheduled_on: "2026-10-27" }),
        row({ occurrence: { status: "skipped", due_on: "2026-10-23" }, scheduled_on: "2026-10-27" }),
        row({ scheduled_on: "2026-10-23" }),
      ],
      TODAY,
    );
    assert.deepEqual(c, { count: 1, earliest: "2026-10-23" });
  });

  test("有效日晚於今天的不算（今日切片過期的防線）", () => {
    assert.deepEqual(lateCount([row({ scheduled_on: "2026-10-26" })], TODAY), { count: 0, earliest: null });
  });

  test("誤點區的票都交代了：0 ⇒「已交代」", () => {
    const c = lateCount([row({ status: "done" })], TODAY);
    assert.deepEqual(c, { count: 0, earliest: null });
    assert.equal(lateCountText(c), "已交代");
  });
});
