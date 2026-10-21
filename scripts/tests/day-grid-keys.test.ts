// 共用日期挑選器月格（DayGrid）的鍵盤規則（磨光⑤ S8，D-主-54：日期挑選統一成 App 自畫）
// 跑法：node --test scripts/tests/day-grid-keys.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridKeyAction } from "../../src/ui/common/monthGridMath.ts";

test("方向鍵移日：±1 天、±7 天，跨月照走", () => {
  assert.deepEqual(gridKeyAction("2026-10-21", "ArrowRight"), { type: "move", day: "2026-10-22" });
  assert.deepEqual(gridKeyAction("2026-10-21", "ArrowLeft"), { type: "move", day: "2026-10-20" });
  assert.deepEqual(gridKeyAction("2026-10-21", "ArrowUp"), { type: "move", day: "2026-10-14" });
  assert.deepEqual(gridKeyAction("2026-10-29", "ArrowDown"), { type: "move", day: "2026-11-05" });
  assert.deepEqual(gridKeyAction("2026-10-01", "ArrowLeft"), { type: "move", day: "2026-09-30" });
  // 跨年
  assert.deepEqual(gridKeyAction("2026-12-31", "ArrowRight"), { type: "move", day: "2027-01-01" });
});

test("PageUp／PageDown 換月（同一個日，月底夾住）；Home／End＝月初／月底", () => {
  assert.deepEqual(gridKeyAction("2026-10-21", "PageDown"), { type: "move", day: "2026-11-21" });
  assert.deepEqual(gridKeyAction("2026-10-21", "PageUp"), { type: "move", day: "2026-09-21" });
  assert.deepEqual(gridKeyAction("2026-01-31", "PageDown"), { type: "move", day: "2026-02-28" });
  assert.deepEqual(gridKeyAction("2026-12-15", "PageDown"), { type: "move", day: "2027-01-15" });
  assert.deepEqual(gridKeyAction("2026-10-21", "Home"), { type: "move", day: "2026-10-01" });
  assert.deepEqual(gridKeyAction("2026-10-21", "End"), { type: "move", day: "2026-10-31" });
});

test("Enter 選焦點日；焦點日在範圍外＝只吃掉", () => {
  assert.deepEqual(gridKeyAction("2026-10-21", "Enter"), { type: "pick", day: "2026-10-21" });
  assert.deepEqual(gridKeyAction("2026-10-21", "Enter", "2026-10-21", "2026-10-21"), { type: "pick", day: "2026-10-21" });
  assert.deepEqual(gridKeyAction("2026-10-01", "Enter", "2026-10-21"), { type: "swallow" });
  assert.deepEqual(gridKeyAction("2026-10-30", "Enter", undefined, "2026-10-21"), { type: "swallow" });
});

test("範圍邊界：方向鍵走不動＝吃掉（不捲頁面）；PageDown 越界夾到邊界", () => {
  // min＝今天（推遲小卡）：往前一天走不動
  assert.deepEqual(gridKeyAction("2026-10-21", "ArrowLeft", "2026-10-21"), { type: "swallow" });
  assert.deepEqual(gridKeyAction("2026-10-21", "ArrowUp", "2026-10-21"), { type: "swallow" });
  // max＝今天（售票口日期）：往後走不動、下一月夾到今天；已在今天再 PageDown＝吃掉
  assert.deepEqual(gridKeyAction("2026-10-21", "ArrowRight", undefined, "2026-10-21"), { type: "swallow" });
  assert.deepEqual(gridKeyAction("2026-09-25", "PageDown", undefined, "2026-10-21"), { type: "move", day: "2026-10-21" });
  assert.deepEqual(gridKeyAction("2026-10-21", "PageDown", undefined, "2026-10-21"), { type: "swallow" });
  assert.deepEqual(gridKeyAction("2026-10-25", "Home", "2026-10-20"), { type: "move", day: "2026-10-20" });
});

test("其他鍵不處理（Esc 交給外層挑選器收起、Tab 照常移焦點、字母不吃）", () => {
  assert.equal(gridKeyAction("2026-10-21", "Escape"), null);
  assert.equal(gridKeyAction("2026-10-21", "Tab"), null);
  assert.equal(gridKeyAction("2026-10-21", "a"), null);
  assert.equal(gridKeyAction("2026-10-21", " "), null);
  assert.equal(gridKeyAction("2026-10-21", "ArrowLeftX"), null);
});
