// 分頁籤獨立一列的排法（src/ui/common/tabsLayout.ts；視覺規範 §2.2 段數欄、D-主-285）
// 跑法：node --test scripts/tests/tabs-layout.test.ts（node 24 直接剝除型別；零 runtime import）
// 數字取自 ?mock=1 手機殼實量：兩字籤字寬約 37.2px（14px 襯線 700＋字距 .22em）；
//   售票口籤列在 375 寬扣掉「管帳」剩 318、412 寬剩 355；時刻表六段「發車台｜軸｜週｜日程｜方眼｜統計」字寬約 54.3／20.2／20.2／37.2×3。
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOBILE_TABS_PER_ROW, peekPad, tabRowLayout } from "../../src/ui/common/tabsLayout.ts";

const MIN = 12; // --tab-pad-min＝--sp-3
const BASE = 16; // --tab-pad-peek＝--sp-4
const TWO = 37.2;

test("放得下→不 peek：五個兩字籤在 375 寬（籤列 318）平分", () => {
  assert.deepEqual(tabRowLayout([TWO, TWO, TWO, TWO, TWO], 318, MIN, BASE), { fit: true });
});

test("放得下→不 peek：412 寬（籤列 355）同樣平分", () => {
  assert.deepEqual(tabRowLayout([TWO, TWO, TWO, TWO, TWO], 355, MIN, BASE), { fit: true });
});

test("放不下→peek：時刻表六段在 375 寬（籤列 317）露半格，補白跟舊算法一致", () => {
  const content = [54.3, 20.2, 20.2, TWO, TWO, TWO];
  const lay = tabRowLayout(content, 317, MIN, BASE);
  assert.equal(lay.fit, false);
  if (lay.fit) return;
  assert.equal(lay.pad, peekPad(content.map((c) => c + 2 * BASE), 317));
  assert.ok(lay.pad >= 0);
});

test("放不下→peek：長籤字（四字）五格在 375 寬落回露半格", () => {
  const FOUR = 4 * 14 * 1.22 + 14 * 0.22; // 約 71.4
  const lay = tabRowLayout([FOUR, FOUR, FOUR, FOUR, FOUR], 318, MIN, BASE);
  assert.equal(lay.fit, false);
});

test("剛好卡在邊界：差不到 1px 也算放不下（免得平分後多出 1px 可捲）", () => {
  const need = 5 * (TWO + 2 * MIN); // 306
  assert.equal(tabRowLayout([TWO, TWO, TWO, TWO, TWO], need + 0.5, MIN, BASE).fit, false);
  assert.equal(tabRowLayout([TWO, TWO, TWO, TWO, TWO], need + 1, MIN, BASE).fit, true);
});

test("段數 ≤ perRow 一律平分；列寬量不到回露半格、補白 0", () => {
  assert.deepEqual(tabRowLayout([200, 200], 100, MIN, BASE), { fit: true });
  assert.equal(MOBILE_TABS_PER_ROW, 4);
  assert.deepEqual(tabRowLayout([TWO, TWO, TWO, TWO, TWO], 0, MIN, BASE), { fit: false, pad: 0 });
});

test("peekPad：前 4 格完整＋第 5 格剛好露一半", () => {
  const w = [69.2, 69.2, 69.2, 69.2, 69.2];
  const p = peekPad(w, 318);
  const shown = 4 * (69.2 + 2 * p) + (69.2 + 2 * p) / 2;
  assert.ok(p > 0);
  assert.ok(Math.abs(shown - 318) < 1e-9);
});
