/**
 * 分頁籤「獨立一列」形制的排法（純函式，零 runtime import；Tabs.tsx 量完 DOM 交給這裡算，單測直接打這支）。
 *
 * 規則（視覺規範 §2.2 段數欄；D-主-285）：段數超過 `MOBILE_TABS_PER_ROW` 時——
 *   各籤字寬＋每邊最小內距（`--tab-pad-min`＝--sp-3）加總放得下列寬 ⇒ 平分（不捲、照「每籤平分」撐滿）；
 *   放不下 ⇒ 露半格（`peekPad`：前 k 格完整、第 k+1 格露一半，當「還能捲」的提示）。
 *   不寫死段數：同一套規則下，五個兩字籤在 375 寬平分、六段長短籤在窄寬自己落回露半格。
 */

/** 手機殼一列「露半格」時最多完整露出幾段；段數超過它才需要判斷平分或露半格（§2.2 段數欄） */
export const MOBILE_TABS_PER_ROW = 4;

/**
 * 末段露半格的補白：籤的自然寬 `widths`（含露半格形制的基本內距、不含補白）、列寬 `rowW`，回每籤左右各要再補幾 px，
 * 讓第 k 籤（k ≤ perRow，取放得下的最大 k）剛好在列的右緣被切一半——前 k 格完整、第 k+1 格露半格。
 * 解 Σ_{i<k}(w_i+2p) + (w_k+2p)/2 = rowW ⇒ p = (rowW − Σ_{i<k} w_i − w_k/2) / (2k+1)；k 從大到小找第一個 p ≥ 0。
 * 籤數 ≤ perRow 或連第一格都放不下半格時回 0（照自然寬捲）。
 */
export function peekPad(widths: readonly number[], rowW: number, perRow = MOBILE_TABS_PER_ROW): number {
  if (widths.length <= perRow || rowW <= 0) return 0;
  for (let k = Math.min(perRow, widths.length - 1); k >= 1; k--) {
    let before = 0;
    for (let i = 0; i < k; i++) before += widths[i];
    const p = (rowW - before - widths[k] / 2) / (2 * k + 1);
    if (p >= 0) return p;
  }
  return 0;
}

/** 量測誤差的餘裕（px）：clientWidth 是整數、籤寬是小數，差 1px 以內當「放不下」，免得平分後多出 1px 可捲 */
const FIT_SLACK = 1;

export type TabRowLayout = { fit: true } | { fit: false; pad: number };

/**
 * 段數 > perRow 的獨立一列要平分還是露半格。
 * `contentWidths`＝各籤不含左右內距的寬（字＋字距）；`minPad`＝平分時每邊最少留的內距；
 * `peekBase`＝露半格形制的每邊基本內距（peekPad 在它之上再補）。
 * 段數 ≤ perRow 一律平分（本來就不露半格）；列寬量不到（≤ 0）回露半格、補白 0＝照舊捲，不猜。
 */
export function tabRowLayout(
  contentWidths: readonly number[],
  rowW: number,
  minPad: number,
  peekBase: number,
  perRow = MOBILE_TABS_PER_ROW,
): TabRowLayout {
  if (contentWidths.length <= perRow) return { fit: true };
  if (rowW <= 0) return { fit: false, pad: 0 };
  let need = 0;
  for (const c of contentWidths) need += c + 2 * minPad;
  if (need <= rowW - FIT_SLACK) return { fit: true };
  return { fit: false, pad: peekPad(contentWidths.map((c) => c + 2 * peekBase), rowW, perRow) };
}
