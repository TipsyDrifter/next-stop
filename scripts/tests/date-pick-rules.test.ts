/**
 * DatePicker 日期欄「該不該送出」的判斷（D-主-36；磨光② A11）。
 * 跑法：`node --test scripts/tests/date-pick-rules.test.ts`。純函式、零依賴。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DATE_HINT_INCOMPLETE,
  DATE_HINT_OUT_OF_RANGE,
  isDateEditKey,
  isPickableDay,
  resolveDateEnter,
  shouldPickOnChange,
} from "../../src/ui/common/datePickRules.ts";

const MIN = "2026-10-20";

describe("isPickableDay", () => {
  test("完整、年 ≥ 1970、在 min／max 內", () => {
    assert.equal(isPickableDay("2026-10-21", MIN), true);
    assert.equal(isPickableDay("2026-10-20", MIN), true); // min 含
    assert.equal(isPickableDay("2026-10-19", MIN), false);
    assert.equal(isPickableDay("2026-12-01", MIN, "2026-11-30"), false);
    assert.equal(isPickableDay("0002-10-21"), false); // 逐位輸入途中的年份
    assert.equal(isPickableDay("2026-10"), false);
    assert.equal(isPickableDay(""), false);
  });
});

describe("shouldPickOnChange：月曆點選立刻送出、鍵盤造成的不送", () => {
  test("沒有鍵盤旗標 + 合格 + 跟原值不同 ⇒ 送", () => {
    assert.equal(shouldPickOnChange("2026-10-25", false, "2026-10-20", MIN), true);
  });
  test("鍵盤旗標 ⇒ 不送（打到一半湊出合法日期，例：202607/12/14 的中途）", () => {
    assert.equal(shouldPickOnChange("2026-10-25", true, "2026-10-20", MIN), false);
    assert.equal(shouldPickOnChange("2027-07-12", true, "2026-10-20", MIN), false);
  });
  test("跟原值相同 ⇒ 不送；不合格 ⇒ 不送", () => {
    assert.equal(shouldPickOnChange("2026-10-20", false, "2026-10-20", MIN), false);
    assert.equal(shouldPickOnChange("2026-10-01", false, "2026-10-20", MIN), false);
    assert.equal(shouldPickOnChange("", false, "2026-10-20", MIN), false);
  });
});

describe("resolveDateEnter：Enter 合格送出、不合格還原＋小字", () => {
  test("合格 ⇒ pick", () => {
    assert.deepEqual(resolveDateEnter("2026-10-25", MIN), { kind: "pick", day: "2026-10-25" });
  });
  test("不完整（空字串、年 < 1970）⇒ 還原＋「日期不完整」", () => {
    assert.deepEqual(resolveDateEnter("", MIN), { kind: "revert", hint: DATE_HINT_INCOMPLETE });
    assert.deepEqual(resolveDateEnter("0002-10-25", MIN), { kind: "revert", hint: DATE_HINT_INCOMPLETE });
  });
  test("完整但超出 min／max ⇒ 還原＋「不在可選的範圍內」", () => {
    assert.deepEqual(resolveDateEnter("2026-10-01", MIN), { kind: "revert", hint: DATE_HINT_OUT_OF_RANGE });
    assert.deepEqual(resolveDateEnter("2027-01-01", MIN, "2026-12-31"), { kind: "revert", hint: DATE_HINT_OUT_OF_RANGE });
  });
  test("小字原文", () => {
    assert.equal(DATE_HINT_INCOMPLETE, "日期不完整，已還原");
    assert.equal(DATE_HINT_OUT_OF_RANGE, "不在可選的範圍內，已還原");
  });
});

describe("isDateEditKey", () => {
  test("數字、↑↓、Backspace／Delete 會改值；Tab、←→、Enter、Alt+↓ 不算", () => {
    for (const k of ["0", "5", "9", "ArrowUp", "ArrowDown", "Backspace", "Delete"]) assert.equal(isDateEditKey(k), true, k);
    for (const k of ["Tab", "ArrowLeft", "ArrowRight", "Enter", "Escape", "a"]) assert.equal(isDateEditKey(k), false, k);
    assert.equal(isDateEditKey("ArrowDown", true), false);
  });
});
