/**
 * UI 丙-5 F1：售票口「時刻」換成 ClockInput 之後，帳日日界線、牆鐘往返、25:00 表記存回牆鐘不能壞。
 * 跑法：`node --test scripts/tests/ticket-clock.test.ts`。
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻，不寫 UTC 字面值。
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

const { ticketClockBounds, ticketClockValue, msToWallHHMM } = await import("../../src/ui/ticket/ticketClock.ts");
const { atOf, localTime } = await import("../../src/domain/ticket.ts");
const { resolveClockInput } = await import("../../src/domain/timetableClockInput.ts");

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

test("日界線 04:00、帳日 10/23 打 25:00：毫秒是 10/24 01:00，存回牆鐘 01:00、帳日仍是 10/23", () => {
  const dsh = 4;
  const { lo, hi } = ticketClockBounds("2026-10-23", dsh);
  // ClockInput 的打字解析（同一支 resolveClockInput），基準日＝帳日
  const r = resolveClockInput("25:00", { value: at(2026, 10, 23, 12, 0), lo, hi, dayStartHour: dsh, baseDay: "2026-10-23" });
  assert.ok("ms" in r);
  const ms = (r as { ms: number }).ms;
  assert.equal(ms, at(2026, 10, 24, 1, 0));
  const wall = msToWallHHMM(ms);
  assert.equal(wall, "01:00");
  // 存回：atOf(帳日 10/23, "01:00") 落回同一刻（01 < 日界線 04 ⇒ 隔一個日曆日）
  assert.equal(ticketClockValue("2026-10-23", wall, dsh), ms);
  assert.equal(Date.parse(atOf("2026-10-23", wall, dsh)), ms);
  // 還在 10/23 這個帳日的範圍裡
  assert.ok(ms >= lo && ms <= hi);
});

test("一般往返：牆鐘 → 毫秒 → 牆鐘照字面", () => {
  for (const hhmm of ["04:00", "09:30", "12:00", "23:59", "00:00", "03:59"]) {
    const ms = ticketClockValue("2026-10-23", hhmm, 4);
    assert.notEqual(ms, null);
    assert.equal(msToWallHHMM(ms!), hhmm);
    assert.equal(msToWallHHMM(ms!), localTime(new Date(ms!).toISOString()));
  }
  assert.equal(ticketClockValue("2026-10-23", "09:30", 4), at(2026, 10, 23, 9, 30));
  assert.equal(ticketClockValue("2026-10-23", "02:15", 4), at(2026, 10, 24, 2, 15));
});

test("範圍＝日界線那一刻起 24 小時的最後一分；跨月也對", () => {
  assert.deepEqual(ticketClockBounds("2026-10-23", 4), { lo: at(2026, 10, 23, 4, 0), hi: at(2026, 10, 24, 3, 59) });
  assert.deepEqual(ticketClockBounds("2026-10-31", 3), { lo: at(2026, 10, 31, 3, 0), hi: at(2026, 11, 1, 2, 59) });
  // 日界線 0 點：就是那一個日曆日
  assert.deepEqual(ticketClockBounds("2026-12-31", 0), { lo: at(2026, 12, 31, 0, 0), hi: at(2026, 12, 31, 23, 59) });
});

test("邊界：lo 與 hi 本身換回牆鐘、再用 atOf 存回都還在同一個帳日", () => {
  const dsh = 4;
  const { lo, hi } = ticketClockBounds("2026-10-23", dsh);
  assert.equal(msToWallHHMM(lo), "04:00");
  assert.equal(msToWallHHMM(hi), "03:59");
  assert.equal(ticketClockValue("2026-10-23", msToWallHHMM(lo), dsh), lo);
  assert.equal(ticketClockValue("2026-10-23", msToWallHHMM(hi), dsh), hi);
  // 日界線那一刻屬於當天（04:00 不算隔天）；前一分屬於前一個帳日的尾巴
  assert.equal(ticketClockValue("2026-10-24", "03:59", dsh), at(2026, 10, 25, 3, 59));
  // 超出範圍的打字由 ClockInput 擋（例：28:00 在日界線 04:00 下不屬於這一天）
  const r = resolveClockInput("28:00", { value: lo, lo, hi, dayStartHour: dsh, baseDay: "2026-10-23" });
  assert.ok(!("ms" in r));
});

test("看不懂的字串回 null（新票草稿的時刻可能是空字串）", () => {
  assert.equal(ticketClockValue("2026-10-23", "", 4), null);
  assert.equal(ticketClockValue("2026-10-23", "25:00", 4), null); // 營業日表記不是牆鐘：atOf 不收
  assert.equal(ticketClockValue("2026-10-23", "abc", 4), null);
});
