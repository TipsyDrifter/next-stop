/**
 * 庚 D-主-420：站鐘錶盤跟打字走同一套規則（範圍、跨天、營業日表記），錶面幾何對得上。
 * 跑法：`node --test scripts/tests/time-pick.test.ts`。
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻，不寫 UTC 字面值。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { DIAL_INNER_R, DIAL_OUTER_R, dialAngle, dialHourAt, dialHourSlot, dialMinuteAt, dialPoint, dialStepHour, dialStepMinute, hourEnabled, minuteNearest, otherDayNote, timeCellMs, wallParts } = await import(
  "../../src/domain/timePick.ts"
);

const at = (d: number, h: number, mi: number) => new Date(2026, 9, d, h, mi).getTime();
/** 營業日 10/23、日界線 06:00：10/23 06:00 到 10/24 05:59 */
const day = { value: at(23, 14, 37), lo: at(23, 6, 0), hi: at(24, 5, 59), dayStartHour: 6, baseDay: "2026-10-23" };
/** 兩圈中間的半徑：這條線以內算內圈 */
const OUT = DIAL_OUTER_R;
const IN = DIAL_INNER_R;

test("隔天凌晨那一格換成隔天的毫秒（同打字 25:00）", () => {
  assert.equal(timeCellMs(1, 0, day), at(24, 1, 0));
  assert.equal(timeCellMs(14, 37, day), at(23, 14, 37));
});

test("範圍外回 null，範圍內的小時才能點", () => {
  const b = { ...day, lo: at(23, 14, 20), hi: at(23, 16, 10) };
  assert.equal(timeCellMs(14, 0, b), null);
  assert.equal(timeCellMs(14, 20, b), at(23, 14, 20));
  assert.equal(hourEnabled(13, b), false);
  assert.equal(hourEnabled(14, b), true);
  assert.equal(hourEnabled(16, b), true);
  assert.equal(hourEnabled(17, b), false);
});

test("範圍落在小時中間（兩端都不到 :00 與 :59）也算可選", () => {
  const b = { ...day, value: at(23, 14, 30), lo: at(23, 14, 20), hi: at(23, 14, 40) };
  assert.equal(hourEnabled(14, b), true);
  assert.equal(hourEnabled(15, b), false);
});

test("點小時時分鐘不在範圍內：換到那個小時裡最近可選的一分", () => {
  const b = { ...day, lo: at(23, 14, 20), hi: at(23, 16, 10) };
  assert.equal(minuteNearest(14, 5, b), at(23, 14, 20));
  assert.equal(minuteNearest(16, 37, b), at(23, 16, 10));
  assert.equal(minuteNearest(15, 37, b), at(23, 15, 37));
  assert.equal(minuteNearest(20, 37, b), null);
});

test("別天的格子照算出來的值標：補記往回開時，18 點是前一天、00 點是今天", () => {
  // 營業日 10/24、日界線 06:00，值 06:00，範圍往回開到前一晚（AVD 實測的情況）
  const b = { value: at(24, 6, 0), lo: at(23, 12, 0), hi: at(24, 10, 0), dayStartHour: 6, baseDay: "2026-10-24" };
  assert.equal(otherDayNote(timeCellMs(18, 0, b)!, "2026-10-24"), "前一天");
  assert.equal(otherDayNote(timeCellMs(0, 30, b)!, "2026-10-24"), null);
  assert.equal(otherDayNote(timeCellMs(8, 0, b)!, "2026-10-24"), null);
  // 一般的一天：00 點才是隔天
  assert.equal(otherDayNote(timeCellMs(1, 0, day)!, "2026-10-23"), "隔天");
  assert.equal(otherDayNote(timeCellMs(14, 0, day)!, "2026-10-23"), null);
});

test("牆鐘的時與分", () => {
  assert.deepEqual(wallParts(at(24, 1, 5)), { h: 1, m: 5 });
});

test("角度：從正上方順時針", () => {
  assert.equal(dialAngle(0, -10), 0);
  assert.equal(dialAngle(10, 0), 90);
  assert.equal(dialAngle(0, 10), 180);
  assert.equal(dialAngle(-10, 0), 270);
});

test("24 個小時各佔一個位置，點回去還是自己（外圈 1–12、內圈 00、13–23）", () => {
  const seen = new Set<string>();
  for (let h = 0; h < 24; h++) {
    const { slot, inner } = dialHourSlot(h);
    seen.add(`${slot}/${inner}`);
    assert.equal(dialHourAt(slot * 30, inner ? IN : OUT), h, `${h} 點`);
  }
  assert.equal(seen.size, 24);
  assert.equal(dialHourAt(0, OUT), 12);
  assert.equal(dialHourAt(0, IN), 0);
  assert.equal(dialHourAt(90, OUT), 3);
  assert.equal(dialHourAt(90, IN), 15);
  assert.equal(dialHourAt(359, OUT), 12, "快到正上方也算 12");
});

test("太靠近圓心不算點到", () => {
  assert.equal(dialHourAt(90, 0.02), null);
  assert.equal(dialMinuteAt(90, 0.02, false), null);
});

test("分鐘：點一下落到 5 分一格、拖到 1 分，每一分都到得了", () => {
  assert.equal(dialMinuteAt(222, OUT, false), 37);
  assert.equal(dialMinuteAt(222, OUT, true), 35);
  assert.equal(dialMinuteAt(359, OUT, true), 0, "快到正上方是 00，不是 60");
  assert.equal(dialMinuteAt(359, OUT, false), 0);
  const all = new Set<number>();
  for (let m = 0; m < 60; m++) all.add(dialMinuteAt(m * 6, OUT, false)!);
  assert.equal(all.size, 60);
});

test("位置：正上方與三點鐘方向", () => {
  const top = dialPoint(0, 12, OUT);
  assert.ok(Math.abs(top.x - 50) < 1e-9);
  assert.ok(Math.abs(top.y - 7) < 1e-9);
  const three = dialPoint(3, 12, OUT);
  assert.ok(Math.abs(three.x - 93) < 1e-9);
  assert.ok(Math.abs(three.y - 50) < 1e-9);
});

test("方向鍵走小時：跳過不能選的、繞一圈", () => {
  assert.equal(dialStepHour(14, 1, day), 15);
  assert.equal(dialStepHour(23, 1, day), 0);
  assert.equal(dialStepHour(0, -1, day), 23);
  const b = { ...day, lo: at(23, 14, 0), hi: at(23, 16, 59) };
  assert.equal(dialStepHour(16, 1, b), 14);
  assert.equal(dialStepHour(14, -1, b), 16);
});

test("方向鍵走分鐘：在這個小時裡繞圈、跳過不能選的", () => {
  assert.equal(dialStepMinute(14, 37, 1, day), at(23, 14, 38));
  assert.equal(dialStepMinute(14, 59, 1, day), at(23, 14, 0));
  assert.equal(dialStepMinute(14, 0, -1, day), at(23, 14, 59));
  assert.equal(dialStepMinute(14, 37, 5, day), at(23, 14, 42));
  const b = { ...day, value: at(23, 14, 30), lo: at(23, 14, 20), hi: at(23, 14, 40) };
  assert.equal(dialStepMinute(14, 40, 1, b), at(23, 14, 20));
});
