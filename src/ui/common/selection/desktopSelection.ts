/**
 * 桌機多選的滑鼠與鍵盤接線（回饋乙 D-主-152；契約 §4）——大綱、今日、行程表串流三頁共用，狀態在 store/selectionStore.ts。
 *
 *   - Ctrl／⌘＋點＝加選或取消；Shift＋點＝範圍選（`selectionClick`）。還沒進多選時，游標停著的那一列一起算進去
 *     （先點一張、再 Ctrl 點兩張＝三張；同 Finder／檔案總管）。
 *   - 純點一列（點在票面、不是列裡的按鈕）＝取消多選、游標移過去（同檔案總管）。
 *   - 鍵盤：Ctrl＋A 選這一頁的列、Shift＋↑↓ 擴選（從游標起算，往回按會縮）、Esc 清掉多選（各頁的 escape 先問 `clearIfAny`）。
 * 鍵位登記在 ui/shell/hotkeys.ts（today／outline 兩組 wired；串流借 daylist 那組，同它其他鍵的做法）。
 */
import { selectionClick, useSelectionStore, type SelectionScope } from "../../../store/selectionStore";

type Mods = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: EventTarget | null };

/** 按下的地方是列裡的控件（章、chip、⋯、摺疊鈕、輸入框）＝不是「點這一列」 */
export function onControl(t: EventTarget | null): boolean {
  return !!(t as HTMLElement | null)?.closest?.("button, a, input, textarea, select, [contenteditable='true']");
}

/**
 * 列的 mousedown 先交給它：回 true＝這是多選的點（呼叫端不要再做單選）；false＝照列原本的單擊。
 * `cursor`＝游標停著的那一列（uiStore.selectedId 或頁面自己的選取鍵換成的節點 id）。
 */
export function pickClick(scope: SelectionScope, id: string, order: readonly string[], e: Mods, cursor: string | null): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const s = useSelectionStore.getState();
  if (!ctrl && !shift) {
    // 純點票面＝取消多選；點列裡的控件（章、⋯…）不動選取
    if (!onControl(e.target) && s.scope === scope && s.ids.length) s.clear();
    return false;
  }
  const active = s.scope === scope && s.ids.length > 0;
  if (!active && cursor && cursor !== id && order.includes(cursor)) s.start(scope, cursor);
  return selectionClick(scope, id, order, { ctrl, shift });
}

/** Ctrl＋A：選這一頁看得到的列 */
export function selectAll(scope: SelectionScope, order: readonly string[]): void {
  useSelectionStore.getState().set(scope, order);
}

/** Shift＋↑↓：游標往上／下一列，選取＝anchor 到新游標。回新游標（呼叫端移游標） */
export function extendBy(scope: SelectionScope, delta: 1 | -1, order: readonly string[], cursor: string | null): string | null {
  if (!order.length) return null;
  const i = cursor ? order.indexOf(cursor) : -1;
  const next = order[i < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(Math.max(i + delta, 0), order.length - 1)];
  useSelectionStore.getState().extendTo(scope, next, order, i < 0 ? next : cursor);
  return next;
}

/** Esc：這一頁有多選就清掉並回 true（呼叫端就不做原本的 Esc） */
export function clearIfAny(scope: SelectionScope): boolean {
  const s = useSelectionStore.getState();
  if (s.scope !== scope || !s.ids.length) return false;
  s.clear();
  return true;
}

/** 拖曳：拖起的那張在選取裡＝整批（照畫面順序、只留 `allowed` 允許的）；不在＝只有它 */
export function dragBatch(scope: SelectionScope, id: string, order: readonly string[], allowed?: (id: string) => boolean): string[] {
  const s = useSelectionStore.getState();
  if (s.scope !== scope || !s.ids.includes(id)) return [id];
  const want = new Set(s.ids);
  return order.filter((x) => want.has(x) && (x === id || !allowed || allowed(x)));
}
