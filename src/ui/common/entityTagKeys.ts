/**
 * EntityTagField 鍵盤規則裡「選中列」的那一段（純函式；售票口④ P1，2026-11-03）。測試在 scripts/tests/ticket-4b-logic.test.ts。
 *
 * 選中列只在「打了字，或用 ↑↓ 動過」時才有：欄位空著、也沒動過 ⇒ 建議清單照列（常用荷札），但沒有哪一列被選中，
 * Enter 不攔、交給外層（例：售票口新的一筆＝存檔）。以前空著也預選第一列，打完一個荷札順手按 Enter 會多掛一個沒想要的。
 */

/** 有沒有選中列 */
export function hasPick(q: string, moved: boolean): boolean {
  return moved || q.trim() !== "";
}

/** Enter 做什麼：pass＝不攔（不 preventDefault）；pick＝掛選中列；typed＝照打的字掛（沒有列可選） */
export function enterAction(q: string, moved: boolean, n: number): "pass" | "pick" | "typed" {
  if (!q.trim() && (!moved || n === 0)) return "pass";
  return n ? "pick" : "typed";
}

/** ↑↓ 之後選中第幾列：還沒有選中列 ⇒ ↓ 第一列、↑ 最後一列；有 ⇒ 循環（同 TagSuggest.moveAct） */
export function arrowAct(act: number, delta: 1 | -1, n: number, picked: boolean): number {
  if (!n) return 0;
  if (!picked) return delta === 1 ? 0 : n - 1;
  return (act + delta + n) % n;
}
