/**
 * 售票口算式解析與小算盤引擎單元測試（v1.28 功能 3）。
 * 執行：`node --test scripts/tests/ticket-calc.test.ts`
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCalcInput,
  hasCalcOperator,
  evaluateCalcExpression,
  commitCalcInput,
  formatCalcValue,
} from "../../src/domain/ticketCalc.ts";
import { parseAmount } from "../../src/domain/ticket.ts";

describe("ticketCalc：四則運算與小算盤引擎", () => {
  test("1. 基本加減乘除、先乘除後加減與括號", () => {
    const r1 = evaluateCalcExpression("120+45+80");
    assert.deepEqual(r1, { ok: true, value: 245, formatted: "245", isExpression: true });

    const r2 = evaluateCalcExpression("500-120");
    assert.deepEqual(r2, { ok: true, value: 380, formatted: "380", isExpression: true });

    const r3 = evaluateCalcExpression("150*3");
    assert.deepEqual(r3, { ok: true, value: 450, formatted: "450", isExpression: true });

    const r4 = evaluateCalcExpression("1000/4");
    assert.deepEqual(r4, { ok: true, value: 250, formatted: "250", isExpression: true });

    const r5 = evaluateCalcExpression("100+50*2");
    assert.deepEqual(r5, { ok: true, value: 200, formatted: "200", isExpression: true });

    const r6 = evaluateCalcExpression("(120+30)*2");
    assert.deepEqual(r6, { ok: true, value: 300, formatted: "300", isExpression: true });

    const r7 = evaluateCalcExpression("((10+20)*3-15)/5");
    assert.deepEqual(r7, { ok: true, value: 15, formatted: "15", isExpression: true });
  });

  test("2. 全形數字與 × ÷ ＋ － 符號正規化", () => {
    assert.equal(normalizeCalcInput("１２０＋４５×２abc"), "120+45×2");
    assert.equal(hasCalcOperator("１２０＋４５"), true);
    assert.equal(hasCalcOperator("150×3"), true);
    assert.equal(hasCalcOperator("1000÷4"), true);
    assert.equal(hasCalcOperator("350"), false);
    assert.equal(hasCalcOperator("-350"), false);
    assert.equal(hasCalcOperator("-350+50"), true);

    const rFull = evaluateCalcExpression("（１２０＋３０）×２÷３－１０");
    assert.deepEqual(rFull, { ok: true, value: 90, formatted: "90", isExpression: true });
  });

  test("3. 尾端未完成運算子與未閉合括號容錯", () => {
    const r1 = evaluateCalcExpression("120+45+");
    assert.deepEqual(r1, { ok: true, value: 165, formatted: "165", isExpression: true });

    const r2 = evaluateCalcExpression("120+45*");
    assert.deepEqual(r2, { ok: true, value: 165, formatted: "165", isExpression: true });

    const r3 = evaluateCalcExpression("(120+30");
    assert.deepEqual(r3, { ok: true, value: 150, formatted: "150", isExpression: true });

    const r4 = evaluateCalcExpression("(120+30)*");
    assert.deepEqual(r4, { ok: true, value: 150, formatted: "150", isExpression: true });

    assert.equal(commitCalcInput("120+45+"), "165");
    assert.equal(commitCalcInput("120+45="), "165");
  });

  test("4. 小數精度收斂與除以零防護", () => {
    const rFloat = evaluateCalcExpression("0.1+0.2");
    assert.deepEqual(rFloat, { ok: true, value: 0.3, formatted: "0.3", isExpression: true });

    const rDiv3 = evaluateCalcExpression("100/3");
    assert.deepEqual(rDiv3, { ok: true, value: 33.33, formatted: "33.33", isExpression: true });

    const rDiv0 = evaluateCalcExpression("120/0");
    assert.equal(rDiv0.ok, false);
    if (!rDiv0.ok) assert.match(rDiv0.error, /除以 0/);
    assert.equal(commitCalcInput("120/0"), "120/0");

    // 預設不允許負數收斂，但 allowNegative: true 時可收斂負數（如退款或精算）
    assert.equal(commitCalcInput("100-250"), "100-250");
    assert.equal(commitCalcInput("100-250", { allowNegative: true }), "-150");
    assert.equal(formatCalcValue(12.345, 2), "12.35");
  });

  test("5. 與 ticket.ts parseAmount 整合：未失焦直接存檔也能算出正確金額", () => {
    const twd = { code: "TWD", decimals: 2 };
    assert.equal(parseAmount("120+45+80", twd, { allowNegative: true }), 24500);
    assert.equal(parseAmount("120+45+", twd, { allowNegative: true }), 16500);
    assert.equal(parseAmount("(120+30)×2", twd, { allowNegative: false }), 30000);
    assert.equal(parseAmount("100-250", twd, { allowNegative: true }), -15000);
    assert.throws(
      () => parseAmount("100-250", twd, { allowNegative: false }),
      /收入和轉帳金額要大於 0/,
    );
  });
});
