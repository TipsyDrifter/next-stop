/**
 * 時刻表・補記跨日變長塊——純函式測試（磨光⑤ 契約 §8 甲′；D-主-64、65）。
 * 跑法：`node --test scripts/tests/timetable-long-block.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 使用者 10-21 回報的情境（日界線 06:00、看的是週一 10/19、隔天週二 11:00 才補記）：
 * 補記面板開在週一那段空白 = 週一 06:00 – 週二 06:00（兩端畫面上都寫「06:00」）。
 * 発車用鈕從 06:00 往前轉到 01:30、到着往後轉到 10:30 ⇒ 到着其實是**週二** 10:30，存成 33 小時的一塊。
 * 步進穿過日界線本身是對的（真的跨天是正當的）；要修的是「看不到哪一天」「沒人問就存」——
 * 這裡驗：日期標籤標得出另一天、超過 12 小時要確認、12 小時內不多一步、打字那條路的解讀不變。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi).getTime()` 造本地時刻（同 timetable-clock-input.test.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MIN, planEdit, planFill, type Span } from "../../src/domain/timetable.ts";
import {
  LONG_BLOCK_MS,
  clockDateLabel,
  clockInputRefDay,
  longBlockAsk,
  resolveClockInput,
  stepClockValue,
} from "../../src/domain/timetableClockInput.ts";

const at = (d: number, h: number, mi = 0): number => new Date(2026, 9, d, h, mi).getTime();
const DSH = 6;
const MON = "2026-10-19";

/** 照 Stepper 的路徑一下一下按（每一步都重新夾 [lo, hi]；lo／hi 隨另一端即時變，同 BlockPanel） */
function press(value: number, steps: readonly number[], lo: number, hi: number): number {
  let v = value;
  for (const d of steps) v = stepClockValue(v, d, lo, hi);
  return v;
}

describe("使用者情境：週一補記睡覺 01:30–10:30（面板開在 06:00–隔天 06:00）", () => {
  const now = at(20, 11, 0); // 週二 11:00 才補
  const sheet = { start: at(19, 6), end: at(20, 6) }; // 週一那段空白＝整個營業日
  const ref = clockInputRefDay(sheet.start, MON, DSH);

  test("面板參考日＝看的那一天（週一）", () => {
    assert.equal(ref, MON);
  });

  // 発車：lo 0、hi 到着−1 分；到着：lo 発車+1 分、hi 現在（BlockPanel）
  const start = press(sheet.start, [-60, -60, -60, -60, -15, -15], 0, sheet.end - MIN);
  const end = press(sheet.end, [60, 60, 60, 60, 15, 15], start + MIN, now);

  test("步進值本身照算：発車週一 01:30、到着週二 10:30（穿過日界線是正當的，不夾掉）", () => {
    assert.equal(start, at(19, 1, 30));
    assert.equal(end, at(20, 10, 30));
  });

  test("時間欄旁的日期：発車同一天（淡）、到着是另一天（赭），不再只有 10:30", () => {
    assert.deepEqual(clockDateLabel(start, ref), { text: "10/19（一）", other: false });
    assert.deepEqual(clockDateLabel(end, ref), { text: "10/20（二）", other: true });
  });

  test("33 小時的塊不能默默存：要確認，句子寫出多長、跨到哪天", () => {
    assert.equal(longBlockAsk(start, end), "這一塊有 33 小時，跨到 10/20（二）——確定嗎？");
  });

  test("照使用者本意（週一 01:30–10:30，9 小時）＝不多一步", () => {
    assert.equal(longBlockAsk(at(19, 1, 30), at(19, 10, 30)), null);
  });

  test("打字那條路不變：到着框打 1030 ⇒ 週一 10:30（12 小時解讀規則照舊）", () => {
    const r = resolveClockInput("1030", {
      value: sheet.end,
      lo: start + MIN,
      hi: now,
      dayStartHour: DSH,
      baseDay: clockInputRefDay(sheet.end, MON, DSH),
    });
    assert.deepEqual(r, { ms: at(19, 10, 30) });
  });
});

describe("longBlockAsk：超過 12 小時才問", () => {
  test("門檻＝12 小時整（含）不問，多 1 分就問", () => {
    assert.equal(LONG_BLOCK_MS, 12 * 60 * MIN);
    assert.equal(longBlockAsk(at(19, 8), at(19, 20)), null);
    assert.equal(longBlockAsk(at(19, 8), at(19, 20, 1)), "這一塊有 12 小時 1 分——確定嗎？");
  });

  test("同一天內的長塊不寫「跨到」；跨天才寫結束那天", () => {
    assert.equal(longBlockAsk(at(19, 0, 30), at(19, 13, 45)), "這一塊有 13 小時 15 分——確定嗎？");
    assert.equal(longBlockAsk(at(19, 20), at(20, 9, 5)), "這一塊有 13 小時 5 分，跨到 10/20（二）——確定嗎？");
  });

  test("跨好幾天也照算（真的超過一天也能記，只是要確認）", () => {
    assert.equal(longBlockAsk(at(19, 10), at(21, 12)), "這一塊有 50 小時，跨到 10/21（三）——確定嗎？");
  });

  test("秒數不足一分不寫（顯示取整到分）", () => {
    assert.equal(longBlockAsk(at(19, 8), at(19, 20) + 30_000), "這一塊有 12 小時——確定嗎？");
  });
});

describe("clockDateLabel：月/日（星期），跟參考日比日曆日", () => {
  test("前一晚（改出發時間往前到前一晚）＝另一天", () => {
    assert.deepEqual(clockDateLabel(at(18, 23, 40), MON), { text: "10/18（日）", other: true });
  });

  test("日界線前的凌晨仍是同一個日曆日 ⇒ 不算另一天（跟「＝隔天」預覽同一把尺）", () => {
    // 01:30 屬於前一個營業日，但使用者說的「週一 01:30」就是這一天的日曆日
    assert.deepEqual(clockDateLabel(at(19, 1, 30), MON), { text: "10/19（一）", other: false });
  });

  test("跨月", () => {
    assert.deepEqual(clockDateLabel(new Date(2026, 10, 1, 9).getTime(), "2026-10-31"), { text: "11/1（日）", other: true });
  });
});

describe("stepClockValue：夾在 [lo, hi]", () => {
  test("到頭就停", () => {
    assert.equal(stepClockValue(at(19, 10), 60, 0, at(19, 10, 30)), at(19, 10, 30));
    assert.equal(stepClockValue(at(19, 10), -15, at(19, 9, 50), at(20, 0)), at(19, 9, 50));
  });

  test("區間退化（lo > hi）回 lo（同 controls.clamp）", () => {
    assert.equal(stepClockValue(at(19, 10), 1, at(19, 12), at(19, 11)), at(19, 12));
  });
});

// 磨光⑤ 收尾（沙盒 O1）：按「確定記這麼長」存的塊不該再標「長時間運行・待確認」——planFill／planEdit 的 ack
describe("確認過的長塊記成已確認（planFill／planEdit 的 ack）", () => {
  const now = at(21, 12);
  const prev: Span = { id: "p", categoryId: "work", start: at(18, 8), end: at(18, 20), ack: false };

  test("補記：ack true ⇒ 新塊 ack true；不給 ⇒ false（照舊）", () => {
    const yes = planFill([prev], { categoryId: "sleep", start: at(19, 10, 30), end: at(20, 1), now, ack: true });
    assert.equal(yes.inserts.at(-1)?.ack, true);
    const no = planFill([prev], { categoryId: "sleep", start: at(19, 10, 30), end: at(20, 1), now });
    assert.equal(no.inserts.at(-1)?.ack, false);
  });

  test("改一塊：ack true ⇒ patch 帶 ack true（換分類的歸 0 也被蓋過）", () => {
    const s: Span = { id: "s", categoryId: "work", start: at(19, 10, 30), end: at(19, 20), ack: false };
    const p1 = planEdit([s], { id: "s", categoryId: "work", start: at(19, 10, 30), end: at(20, 1), now, ack: true });
    assert.deepEqual(p1.patches.at(-1), { id: "s", end: at(20, 1), ack: true });
    const p2 = planEdit([s], { id: "s", categoryId: "sleep", start: at(19, 10, 30), end: at(20, 1), now, ack: true });
    assert.equal(p2.patches.at(-1)?.ack, true);
  });

  test("改一塊：本來就已確認的不重寫 ack；不給 ack ⇒ 照舊（換分類歸 0）", () => {
    const s: Span = { id: "s", categoryId: "work", start: at(19, 10, 30), end: at(19, 20), ack: true };
    const same = planEdit([s], { id: "s", categoryId: "work", start: at(19, 10, 30), end: at(20, 1), now, ack: true });
    assert.equal("ack" in (same.patches.at(-1) ?? {}), false);
    const recat = planEdit([s], { id: "s", categoryId: "sleep", start: at(19, 10, 30), end: at(19, 20), now });
    assert.equal(recat.patches.at(-1)?.ack, false);
  });
});
