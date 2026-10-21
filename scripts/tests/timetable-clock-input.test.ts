/**
 * 時刻表・可打字的時刻框與連續補——純函式測試（磨光⑥ 契約 §1-1、§1-4、§1-5½、§3；D-時-143、145、148）。
 * 跑法：`node --test scripts/tests/timetable-clock-input.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi).getTime()` 造本地時刻（同 timetable-logic.test.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MIN } from "../../src/domain/timetable.ts";
import {
  CLOCK_STEPS,
  HOLD_DELAY_MS,
  clockInputErrText,
  clockInputPreview,
  clockInputRefDay,
  clockStepLabel,
  holdGapMs,
  resolveClockInput,
  type ClockInputResult,
} from "../../src/domain/timetableClockInput.ts";
import { fillContinuation } from "../../src/domain/timetableFillCont.ts";

const at = (d: number, h: number, mi = 0, s = 0): number => new Date(2026, 9, d, h, mi, s).getTime();
const ms = (r: ClockInputResult): number => {
  assert.ok("ms" in r, `應該解得開：${JSON.stringify(r)}`);
  return r.ms;
};

describe("resolveClockInput：打的字 → 毫秒（取 [lo, hi] 內離目前值最近的那一天）", () => {
  // 基準情境（契約 §1-5）：10/21 一段 07:10–15:42 的未記錄
  const fillStart = { value: at(21, 7, 10), lo: 0, hi: at(21, 15, 41), dayStartHour: 6 };
  const fillEnd = { value: at(21, 15, 42), lo: at(21, 7, 11), hi: at(21, 15, 42), dayStartHour: 6 };

  test("各種寫法都認得（重用 parseClockInput）", () => {
    for (const raw of ["0830", "830", "8:30", "08:30", "8.30", "８：３０", "０８３０", "8．30"]) {
      assert.equal(ms(resolveClockInput(raw, fillStart)), at(21, 8, 30), raw);
    }
    assert.equal(ms(resolveClockInput("9", fillEnd)), at(21, 9, 0));
    assert.equal(ms(resolveClockInput("0915", fillEnd)), at(21, 9, 15));
  });

  test("看不懂 ⇒ bad；格式對但不在這一天 ⇒ range", () => {
    assert.deepEqual(resolveClockInput("abc", fillStart), { err: "bad" });
    assert.deepEqual(resolveClockInput("2:3", fillStart), { err: "bad" });
    assert.deepEqual(resolveClockInput("12345", fillStart), { err: "bad" });
    assert.deepEqual(resolveClockInput("下午3點", fillStart), { err: "bad" });
    // 日界線 06：30:00 是隔天 06:00 之後，不是這一天的時刻
    assert.equal((resolveClockInput("30:00", fillEnd) as { err: string }).err, "range");
  });

  test("範圍外：到着不能早於発車+1、不能晚於現在", () => {
    assert.deepEqual(resolveClockInput("0700", fillEnd), { err: "range", side: "early" });
    assert.deepEqual(resolveClockInput("1600", fillEnd), { err: "range", side: "late" });
    assert.equal(clockInputErrText({ err: "range", side: "late" }, fillEnd.lo, fillEnd.hi), "要在 07:11–15:42 之間");
    assert.equal(clockInputErrText({ err: "bad" }, fillEnd.lo, fillEnd.hi), "看不懂，例：0830、8:30、25:00");
  });

  test("lo 遠在一天以前（補記発車 lo＝0）：最近的合法那天；範圍說明只寫綁住的那一側", () => {
    // 到着已改成 09:15 時発車打 1000（晚於到着，多半是手滑）：當天的 10:00 不行；前一天 10:00 離目前值 21 小時、超過 12 小時不取 ⇒ range
    assert.deepEqual(resolveClockInput("1000", { ...fillStart, hi: at(21, 9, 14) }), { err: "range", side: "late" });
    // 前一天晚上（12 小時內）照取：発車 07:10 打 2300 ⇒ 前一天 23:00（蓋到前一晚，W1 會警告）
    assert.equal(ms(resolveClockInput("2300", { ...fillStart, hi: at(21, 9, 14) })), at(20, 23, 0));
    // 當天的候選不限 12 小時：整天空白、発車停在日界線 06:00，打 2000 ⇒ 當天 20:00
    assert.equal(ms(resolveClockInput("2000", { value: at(21, 6, 0), lo: 0, hi: at(21, 21, 0), dayStartHour: 6 })), at(21, 20, 0));
    assert.equal(ms(resolveClockInput("0830", { ...fillStart, hi: at(21, 9, 14) })), at(21, 8, 30));
    assert.equal(clockInputErrText({ err: "range", side: "late" }, 0, fillStart.hi), "不能晚於 15:41");
    assert.equal(clockInputErrText({ err: "range", side: "early" }, at(19, 9), at(21, 9)), "不能早於 09:00");
    // T4 改出發時間：[現在−1 天−1 分, 現在−1 分]，正在跑的那班 00:30 発車、現在 01:42；打 2350 ⇒ 前一天 23:50
    const restart = { value: at(22, 0, 30), lo: at(21, 0, 30), hi: at(22, 1, 41), dayStartHour: 6 };
    assert.equal(ms(resolveClockInput("2350", restart)), at(21, 23, 50));
  });

  test("跨午夜（日界線 06）：23:00 起的空白，打 0030 ⇒ 隔天 00:30；打 2330 ⇒ 當天 23:30", () => {
    const b = { value: at(21, 23, 0), lo: at(21, 23, 1), hi: at(22, 1, 0), dayStartHour: 6 };
    assert.equal(ms(resolveClockInput("0030", b)), at(22, 0, 30));
    assert.equal(ms(resolveClockInput("030", b)), at(22, 0, 30));
    assert.equal(ms(resolveClockInput("2330", b)), at(21, 23, 30));
    assert.equal(ms(resolveClockInput("24:30", b)), at(22, 0, 30));
    assert.equal(ms(resolveClockInput("25:00", b)), at(22, 1, 0));
    assert.deepEqual(resolveClockInput("0130", b), { err: "range", side: "late" });
  });

  test("目前值在午夜之後（還算前一個營業日）：打 2350 ⇒ 前一天 23:50", () => {
    const b = { value: at(22, 0, 40), lo: at(21, 22, 41), hi: at(22, 1, 41), dayStartHour: 6 };
    assert.equal(ms(resolveClockInput("2350", b)), at(21, 23, 50));
    assert.equal(ms(resolveClockInput("0100", b)), at(22, 1, 0));
  });

  test("日界線 03：凌晨 02:30 的値、打 0200／2659／0400", () => {
    const b = { value: at(22, 2, 30), lo: at(21, 20, 0), hi: at(22, 5, 0), dayStartHour: 3 };
    assert.equal(ms(resolveClockInput("0200", b)), at(22, 2, 0)); // 02:00 ＝ 26:00（營業日 21 號）
    assert.equal(ms(resolveClockInput("2659", b)), at(22, 2, 59));
    assert.equal(ms(resolveClockInput("0400", b)), at(22, 4, 0)); // 04:00 是 22 號營業日的時刻，也在範圍裡
    assert.equal(ms(resolveClockInput("2100", b)), at(21, 21, 0));
    // 日界線 03 下 27:00 不是這一天 ⇒ range
    assert.equal((resolveClockInput("2700", b) as { err: string }).err, "range");
  });

  test("25:00 寫法：日界線 06 認、日界線 00 拒收", () => {
    const b6 = { value: at(21, 23, 0), lo: at(21, 20, 0), hi: at(22, 3, 0), dayStartHour: 6 };
    assert.equal(ms(resolveClockInput("25:00", b6)), at(22, 1, 0));
    assert.equal(ms(resolveClockInput("2500", b6)), at(22, 1, 0));
    const b0 = { ...b6, dayStartHour: 0 };
    assert.equal((resolveClockInput("25:00", b0) as { err: string }).err, "range");
  });

  test("lo 不在整分上：打同一分鐘的 08:31 ⇒ 拉到 lo", () => {
    const b = { value: at(21, 9, 0), lo: at(21, 8, 31, 20), hi: at(21, 10), dayStartHour: 6 };
    assert.equal(ms(resolveClockInput("0831", b)), at(21, 8, 31, 20));
    assert.deepEqual(resolveClockInput("0830", b), { err: "range", side: "early" });
  });
});

describe("clockInputPreview／clockInputRefDay：說明行的「→ 08:30」／「＝隔天 01:00」", () => {
  test("以看的那一天比：同一天、過午夜＝隔天、前一天", () => {
    assert.deepEqual(clockInputPreview(at(21, 8, 30), "2026-10-21"), ["→ ", "08:30"]);
    assert.deepEqual(clockInputPreview(at(22, 1, 0), "2026-10-21"), ["＝隔天 ", "01:00"]);
    assert.deepEqual(clockInputPreview(at(20, 23, 50), "2026-10-21"), ["＝前一天 ", "23:50"]);
  });
  test("基準日：值在看的那一天（含窗尾）⇒ 看的那天；不在 ⇒ 值所在的營業日", () => {
    // 日界線 03：10/21 的窗＝10/21 03:00～10/22 03:00；到着停在窗尾 03:00 也算看的那天（打 1515 ⇒「→ 15:15」，不是「前一天」）
    assert.equal(clockInputRefDay(at(22, 3, 0), "2026-10-21", 3), "2026-10-21");
    assert.equal(clockInputRefDay(at(22, 2, 0), "2026-10-21", 3), "2026-10-21");
    assert.equal(clockInputRefDay(at(22, 9, 0), "2026-10-21", 3), "2026-10-22");
    assert.equal(clockInputRefDay(at(22, 2, 0), "2026-10-18", 6), "2026-10-21");
  });
});

describe("長按加速與鈕", () => {
  test("先停 0.42 秒，間隔 170ms 起逐步縮到 45ms 為止", () => {
    assert.equal(HOLD_DELAY_MS, 420);
    assert.equal(holdGapMs(0), 170);
    for (let n = 1; n < 40; n++) assert.ok(holdGapMs(n) <= holdGapMs(n - 1));
    assert.equal(holdGapMs(100), 45);
  });

  test("一排八顆：−1h −15 −5 −1 ｜ +1 +5 +15 +1h", () => {
    assert.deepEqual(CLOCK_STEPS.map(clockStepLabel), ["−1h", "−15", "−5", "−1", "+1", "+5", "+15", "+1h"]);
  });
});

describe("fillContinuation：補完那段還有剩就換到剩下那段（後面優先）", () => {
  const now = at(21, 15, 42);
  const piece = { start: at(21, 7, 10), end: now };

  test("補在中間 ⇒ 換到後面那段，前面那段帶在 rest", () => {
    const r = fillContinuation(piece, { start: at(21, 8, 30), end: at(21, 9, 15) }, [], now);
    assert.deepEqual(r.next, { start: at(21, 9, 15), end: now });
    assert.deepEqual(r.rest, [{ start: at(21, 7, 10), end: at(21, 8, 30) }]);
  });

  test("往後補到底 ⇒ 回頭補 rest 裡最近的那段；全補完 ⇒ null", () => {
    const rest = [{ start: at(21, 7, 10), end: at(21, 8, 30) }];
    const r = fillContinuation({ start: at(21, 9, 15), end: now }, { start: at(21, 9, 15), end: now }, rest, now);
    assert.deepEqual(r.next, rest[0]);
    assert.deepEqual(r.rest, []);
    const r2 = fillContinuation(rest[0], rest[0], [], now);
    assert.equal(r2.next, null);
  });

  test("從頭補 ⇒ 換到後面；只剩前面 ⇒ 取前面", () => {
    const r = fillContinuation(piece, { start: at(21, 7, 10), end: at(21, 8, 0) }, [], now);
    assert.deepEqual(r.next, { start: at(21, 8, 0), end: now });
    const r2 = fillContinuation(piece, { start: at(21, 12, 0), end: now }, [], now);
    assert.deepEqual(r2.next, { start: at(21, 7, 10), end: at(21, 12, 0) });
  });

  test("剩不到 1 分不算；補的範圍超出那段（往前蓋到既有紀錄）也照算", () => {
    const r = fillContinuation(piece, { start: at(21, 7, 10, 30), end: now }, [], now);
    assert.equal(r.next, null);
    const r2 = fillContinuation(piece, { start: at(21, 6, 0), end: at(21, 9, 0) }, [], now);
    assert.deepEqual(r2.next, { start: at(21, 9, 0), end: now });
  });

  test("段尾晚於 now（那段一路到現在）：長度量到 now", () => {
    const later = { start: at(21, 15, 0), end: now + 5 * MIN };
    const r = fillContinuation(later, { start: at(21, 15, 0), end: now }, [], now);
    assert.equal(r.next, null);
  });
});

describe("真機代驗 D1：過去那天最後一段空白，到着停在日界線那一刻", () => {
  // 日界線 06，看 10/20；那段 12:30–10/21 06:00，発車已打 13:30 ⇒ 到着 [13:31, 隔天 06:00]，目前值＝10/21 06:00（日界線那一刻）
  const end = { value: at(21, 6, 0), lo: at(20, 13, 31), hi: at(21, 6, 0), dayStartHour: 6 };
  test("基準日＝看的那一天（clockInputRefDay）⇒ 打 1415 取 10/20 14:15", () => {
    const baseDay = clockInputRefDay(end.value, "2026-10-20", 6);
    assert.equal(baseDay, "2026-10-20");
    assert.equal(ms(resolveClockInput("1415", { ...end, baseDay })), at(20, 14, 15));
    assert.equal(ms(resolveClockInput("1745", { ...end, baseDay })), at(20, 17, 45));
    assert.equal(ms(resolveClockInput("0130", { ...end, baseDay })), at(21, 1, 30));
  });
  test("不給 baseDay 時 dayKeyOf 把日界線那一刻算成 10/21 ⇒ 14:15 被 12 小時擋掉（所以 UI 一定要給）", () => {
    assert.equal((resolveClockInput("1415", end) as { err: string }).err, "range");
  });
});
