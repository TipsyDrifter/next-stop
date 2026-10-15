// 共用日期挑選器「自畫月格」的純函式單元測試（旅客筆記車次③ 0-6 甲、D-筆-46 修訂）
// 跑法：node --test scripts/tests/month-grid.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRID_CELLS,
  canShowMonth,
  dayInMonth,
  daysInMonth,
  focusDayOf,
  inRange,
  initialMonth,
  leadBlanks,
  monthCells,
  monthOfDay,
  monthTitle,
  moveFocus,
  shiftDay,
  shiftMonth,
  weekHeads,
} from "../../src/ui/common/monthGridMath.ts";

test("月份與天數", () => {
  assert.equal(monthOfDay("2026-10-05"), "2026-10");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(daysInMonth("2026-02"), 28);
  assert.equal(daysInMonth("2028-02"), 29);
  assert.equal(daysInMonth("2026-10"), 31);
  assert.equal(shiftDay("2026-10-31", 1), "2026-11-01");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(dayInMonth("2026-02", 31), "2026-02-28");
  assert.equal(dayInMonth("2026-10", 5), "2026-10-05");
  assert.equal(monthTitle("2026-10"), "2026 年 10 月");
});

test("週首：欄頭與前置空格（2026-10-01 是週四）", () => {
  assert.deepEqual(weekHeads(1), ["一", "二", "三", "四", "五", "六", "日"]);
  assert.deepEqual(weekHeads(0), ["日", "一", "二", "三", "四", "五", "六"]);
  assert.equal(leadBlanks("2026-10", 1), 3);
  assert.equal(leadBlanks("2026-10", 0), 4);
  // 2026-02-01 是週日
  assert.equal(leadBlanks("2026-02", 0), 0);
  assert.equal(leadBlanks("2026-02", 1), 6);
});

test("一頁固定 42 格：前置 null＋該月日＋尾端 null", () => {
  const cells = monthCells("2026-10", 1);
  assert.equal(cells.length, GRID_CELLS);
  assert.deepEqual(cells.slice(0, 4), [null, null, null, "2026-10-01"]);
  assert.equal(cells.filter(Boolean).length, 31);
  assert.equal(cells[3 + 30], "2026-10-31");
  assert.equal(cells[3 + 31], null);
  // 月首在週首且 28 天：前置 0、後面 14 格空
  const feb = monthCells("2026-02", 0);
  assert.equal(feb[0], "2026-02-01");
  assert.equal(feb.filter((c) => c === null).length, 14);
});

test("範圍與換月箭頭", () => {
  assert.ok(inRange("2026-10-05"));
  assert.ok(inRange("2026-10-05", "2026-10-05", "2026-10-05"));
  assert.ok(!inRange("2026-10-06", undefined, "2026-10-05"));
  assert.ok(!inRange("2026-10-04", "2026-10-05"));
  // max＝今天 10/13：11 月整個在未來 ⇒ 下個月不能按；10 月可以
  assert.ok(!canShowMonth("2026-11", undefined, "2026-10-13"));
  assert.ok(canShowMonth("2026-10", undefined, "2026-10-13"));
  // min＝10/31：9 月整個在之前 ⇒ 不能；10 月可以（月底剛好等於 min）
  assert.ok(!canShowMonth("2026-09", "2026-10-31"));
  assert.ok(canShowMonth("2026-10", "2026-10-31"));
});

test("開在哪個月、焦點落在哪一格", () => {
  assert.equal(initialMonth("2026-08-03", "2026-10-13"), "2026-08");
  assert.equal(initialMonth(null, "2026-10-13"), "2026-10");
  assert.equal(initialMonth("2027-01-01", "2026-10-13", undefined, "2026-10-13"), "2026-10");
  assert.equal(initialMonth(null, "2026-10-13", "2026-12-01"), "2026-12");
  // value 在這個月 → value；否則今天；否則第一個能點的日
  assert.equal(focusDayOf("2026-10", "2026-10-05", "2026-10-13"), "2026-10-05");
  assert.equal(focusDayOf("2026-10", "2026-08-05", "2026-10-13"), "2026-10-13");
  assert.equal(focusDayOf("2026-09", "2026-08-05", "2026-10-13"), "2026-09-01");
  assert.equal(focusDayOf("2026-10", null, "2026-09-01", "2026-10-20"), "2026-10-20");
  // value 不能點（超過 max）⇒ 不拿它
  assert.equal(focusDayOf("2026-10", "2026-10-20", "2026-10-13", undefined, "2026-10-13"), "2026-10-13");
});

test("方向鍵：±1 天、±7 天、跨月；越界不動", () => {
  assert.equal(moveFocus("2026-10-05", "ArrowRight"), "2026-10-06");
  assert.equal(moveFocus("2026-10-01", "ArrowLeft"), "2026-09-30");
  assert.equal(moveFocus("2026-10-29", "ArrowDown"), "2026-11-05");
  assert.equal(moveFocus("2026-10-03", "ArrowUp"), "2026-09-26");
  assert.equal(moveFocus("2026-10-13", "ArrowRight", undefined, "2026-10-13"), null);
  assert.equal(moveFocus("2026-10-10", "ArrowDown", undefined, "2026-10-13"), null);
  assert.equal(moveFocus("2026-10-05", "a"), null);
  assert.equal(moveFocus("2026-10-05", "Enter"), null);
});

test("PageUp／PageDown／Home／End：同一日、月底夾住、越界夾到邊界", () => {
  assert.equal(moveFocus("2026-03-31", "PageUp"), "2026-02-28");
  assert.equal(moveFocus("2026-10-05", "PageDown"), "2026-11-05");
  assert.equal(moveFocus("2026-10-17", "Home"), "2026-10-01");
  assert.equal(moveFocus("2026-02-03", "End"), "2026-02-28");
  // max＝10/13：9/20 往下一月＝10/20 在未來 ⇒ 停在 10/13；已在 10/13 再按＝不動
  assert.equal(moveFocus("2026-09-20", "PageDown", undefined, "2026-10-13"), "2026-10-13");
  assert.equal(moveFocus("2026-10-13", "PageDown", undefined, "2026-10-13"), null);
  assert.equal(moveFocus("2026-10-05", "End", undefined, "2026-10-13"), "2026-10-13");
  assert.equal(moveFocus("2026-10-25", "Home", "2026-10-20"), "2026-10-20");
});
