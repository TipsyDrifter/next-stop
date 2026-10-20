/**
 * 日期欄「該不該送出」的判斷（純函式；DatePicker 桌機版的原生 `<input type="date">` 用，D-主-36）。
 * 不 import 任何東西，`node --test` 直接載（scripts/tests/date-pick-rules.test.ts）。
 *
 * 規則：
 *   - 用月曆點選造成的 change（沒有鍵盤旗標）＝立即送出（值要合格、且跟開啟時的值不同）
 *   - 鍵盤造成的 change（數字、↑↓、Backspace／Delete）＝只更新欄位，不送——打到一半湊出的合法日期不算「選好了」
 *   - Enter＝檢查目前的值：合格 ⇒ 送出；不合格 ⇒ 還原成開啟時的值＋一行小字說為什麼
 *   - 失焦／點外面關閉＝不送出（呼叫端什麼都不做就是了）
 */

/** 日期欄的值能不能當成「選好了」：完整 YYYY-MM-DD、年份 ≥ 1970（逐位輸入會先經過 0002／0020）、落在 min／max 內 */
export function isPickableDay(d: string, min?: string, max?: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number(d.slice(0, 4)) >= 1970 && (!min || d >= min) && (!max || d <= max);
}

export const DATE_HINT_INCOMPLETE = "日期不完整，已還原";
export const DATE_HINT_OUT_OF_RANGE = "不在可選的範圍內，已還原";

/** 這個按鍵會改日期欄的值嗎（數字、↑↓、Backspace／Delete）；Alt+↓ 是開月曆，不算 */
export function isDateEditKey(key: string, altKey = false): boolean {
  if (altKey) return false;
  return /^\d$/.test(key) || key === "ArrowUp" || key === "ArrowDown" || key === "Backspace" || key === "Delete";
}

/** change 事件要不要立刻送出：沒有鍵盤旗標、值合格、且跟開啟時的值不同 */
export function shouldPickOnChange(
  v: string,
  keyboardEdit: boolean,
  original: string,
  min?: string,
  max?: string,
): boolean {
  return !keyboardEdit && isPickableDay(v, min, max) && v !== original;
}

export type DateEnterOutcome = { kind: "pick"; day: string } | { kind: "revert"; hint: string };

/** Enter：值合格 ⇒ 送出；不完整（含年 < 1970）⇒ 還原＋「日期不完整」；完整但超出 min／max ⇒ 還原＋「不在可選的範圍內」 */
export function resolveDateEnter(v: string, min?: string, max?: string): DateEnterOutcome {
  if (isPickableDay(v, min, max)) return { kind: "pick", day: v };
  const complete = /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1970;
  return { kind: "revert", hint: complete ? DATE_HINT_OUT_OF_RANGE : DATE_HINT_INCOMPLETE };
}
