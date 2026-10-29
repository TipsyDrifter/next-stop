/**
 * 收官磨光（v1.21.1 磨光班，2026-10-28）的純函式測試：
 *   A4 守門日讀設定值（parseDayStartHour）、組四 b 面板副標跨日帶日期（clockRangeLabel）。
 * 跑法：`node --test scripts/tests/polish-close.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻（同 timetable-clock-input.test.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DAY_START_HOUR, parseDayStartHour } from "../../src/lib/date.ts";
import { clockRangeLabel } from "../../src/domain/timetableClockInput.ts";

const at = (d: number, h: number, mi = 0): number => new Date(2026, 9, d, h, mi).getTime();

test("parseDayStartHour：設定值照讀；沒設／空字串／壞值＝App 預設（06:00），不是寫死的 3", () => {
  assert.equal(DEFAULT_DAY_START_HOUR, 6);
  assert.equal(parseDayStartHour("4"), 4);
  assert.equal(parseDayStartHour("0"), 0); // 午夜是合法值（舊的 `Number(x) || 3` 會吃掉）
  assert.equal(parseDayStartHour(null), 6);
  assert.equal(parseDayStartHour(undefined), 6);
  assert.equal(parseDayStartHour(""), 6);
  assert.equal(parseDayStartHour("abc"), 6);
});

test("clockRangeLabel：同一天＝只寫時刻（照舊）", () => {
  assert.equal(clockRangeLabel(at(27, 9), at(27, 12, 30), "2026-10-27"), "09:00 – 12:30");
});

test("clockRangeLabel：跨到隔天＝終點帶日期（時刻框旁同格式 M/D（週））", () => {
  // 體檢原句「17:00 – 03:00 ・ 10h」看不出隔天
  assert.equal(clockRangeLabel(at(27, 17), at(28, 3), "2026-10-27"), "17:00 – 10/28（三）03:00");
});

test("clockRangeLabel：整塊在參考日之後的凌晨＝起點帶日期、終點同一天不重寫", () => {
  assert.equal(clockRangeLabel(at(28, 3, 10), at(28, 4, 50), "2026-10-27"), "10/28（三）03:10 – 04:50");
});

test("clockRangeLabel：起點在參考日前一天（從隔天的軸點開過夜的塊）", () => {
  assert.equal(clockRangeLabel(at(26, 23), at(27, 7), "2026-10-27"), "10/26（一）23:00 – 10/27（二）07:00");
});
