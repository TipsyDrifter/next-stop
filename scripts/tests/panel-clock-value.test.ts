/**
 * UI 丙-3 C5：側板「幾點」換成 ClockInput 之後，營業日表記（"25:00"）與毫秒的來回換算不能壞。
 * 跑法：`node --test scripts/tests/panel-clock-value.test.ts`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { clockBounds, clockSeed, clockToMs, msToClock } = await import("../../src/ui/panel/clockValue.ts");

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

test("25:00 來回：存回去還是 25:00，不是 01:00", () => {
  const ms = clockToMs("25:00", "2026-10-23")!;
  assert.equal(ms, at(2026, 10, 24, 1, 0));
  assert.equal(msToClock(ms, "2026-10-23"), "25:00");
});

test("同一天的時刻照字面；跨月也算得對", () => {
  assert.equal(msToClock(at(2026, 10, 23, 9, 30), "2026-10-23"), "09:30");
  assert.equal(msToClock(at(2026, 11, 1, 2, 5), "2026-10-31"), "26:05");
});

test("範圍＝日界線起 24 小時的最後一分", () => {
  const { lo, hi } = clockBounds("2026-10-23", 3);
  assert.equal(lo, at(2026, 10, 23, 3, 0));
  assert.equal(hi, at(2026, 10, 24, 2, 59));
  assert.equal(msToClock(hi, "2026-10-23"), "26:59");
});

test("起點：今天＝現在往後取整到 15 分；別天＝09:00；都夾在範圍裡", () => {
  const now = at(2026, 10, 23, 14, 7);
  assert.equal(msToClock(clockSeed("2026-10-23", "2026-10-23", 3, now), "2026-10-23"), "14:15");
  assert.equal(msToClock(clockSeed("2026-10-25", "2026-10-23", 3, now), "2026-10-25"), "09:00");
  // 日界線 03:00、凌晨 02:50 還算「昨天那一天」：取整到 03:00 會超出 ⇒ 夾在最後一分
  const late = at(2026, 10, 24, 2, 50);
  assert.equal(msToClock(clockSeed("2026-10-23", "2026-10-23", 3, late), "2026-10-23"), "26:59");
});
