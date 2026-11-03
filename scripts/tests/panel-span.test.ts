/**
 * 回饋甲 D-主-129：詳情側板／手機詳情頁的「時段」（開始 → 結束）與「長度」的純規則。
 * 結束＝開始＋長度（算出來的）；改結束＝重算長度；結束等於或早於開始＝擋下（結束格的範圍從開始後一分起）。
 * 跑法：`node --test scripts/tests/panel-span.test.ts`。
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

const { clockBounds, clockToMs, msToClock, spanEnd, spanEndBounds, spanEndSeed, spanLen } = await import(
  "../../src/ui/panel/clockValue.ts"
);
const { LEN_MAX, LEN_PRESETS, lenText, parseLenInput } = await import("../../src/ui/panel/panelRules.ts");

const MIN = 60_000;
const DAY = "2026-11-02";

test("spanEnd：開始＋長度；沒開始或沒長度＝null；過午夜寫營業日表記", () => {
  assert.equal(spanEnd("14:00", 90), "15:30");
  assert.equal(spanEnd("23:30", 90), "25:00");
  assert.equal(spanEnd(null, 90), null);
  assert.equal(spanEnd("14:00", null), null);
  assert.equal(spanEnd("14:00", 0), null);
});

test("spanLen：結束−開始；等於或早於開始＝null（不寫）", () => {
  assert.equal(spanLen("14:00", "15:30"), 90);
  assert.equal(spanLen("23:30", "25:00"), 90);
  assert.equal(spanLen("14:00", "14:00"), null);
  assert.equal(spanLen("14:00", "13:00"), null);
  assert.equal(spanLen("14:00", "壞"), null);
});

test("改開始＝整段平移：長度不動，結束跟著走", () => {
  const len = spanLen("14:00", spanEnd("14:00", 90)!)!;
  assert.equal(len, 90);
  assert.equal(spanEnd("16:15", len), "17:45");
});

test("spanEndBounds：開始後一分起、到這一天的終點；現有結束更晚就放寬到它", () => {
  const b = spanEndBounds("14:00", "15:30", DAY, 3)!;
  assert.equal(b.lo, clockToMs("14:01", DAY));
  assert.equal(b.hi, clockBounds(DAY, 3).hi);
  // 開始 26:00、長度 3 小時＝29:00，超過日界線 03:00 的終點 26:59 ⇒ hi 放寬到 29:00
  const late = spanEndBounds("26:00", "29:00", DAY, 3)!;
  assert.equal(late.hi, clockToMs("29:00", DAY));
  assert.equal(spanEndBounds("壞", null, DAY, 3), null);
});

test("spanEndSeed：沒長度時從開始後 60 分起，夾在範圍裡", () => {
  const b = spanEndBounds("14:00", null, DAY, 3)!;
  assert.equal(msToClock(spanEndSeed(b), DAY), "15:00");
  const edge = spanEndBounds("26:30", null, DAY, 3)!;
  assert.equal(spanEndSeed(edge), edge.hi);
  assert.ok(spanEndSeed(edge) >= edge.lo - MIN);
});

test("長度：分段 15／30／60／90／120；字 ≥60 寫 1h30", () => {
  assert.deepEqual([...LEN_PRESETS], [15, 30, 60, 90, 120]);
  assert.equal(lenText(45), "45 分");
  assert.equal(lenText(60), "1h");
  assert.equal(lenText(90), "1h30");
  assert.equal(lenText(125), "2h05");
});

test("parseLenInput：空白＝清掉、看不懂或 ≤0＝不送、超過上限夾回", () => {
  assert.equal(parseLenInput(""), null);
  assert.equal(parseLenInput("  "), null);
  assert.equal(parseLenInput("45"), 45);
  assert.equal(parseLenInput("abc"), undefined);
  assert.equal(parseLenInput("0"), undefined);
  assert.equal(parseLenInput("-5"), undefined);
  assert.equal(parseLenInput("9999"), LEN_MAX);
});
