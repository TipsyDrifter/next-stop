/**
 * 桌機進完整搜尋頁的唯一一支（完整搜尋班 D-主-111）：Ctrl+Shift+F、Ctrl+P 的「在完整搜尋看全部」都走這裡。
 * 帶字＝用那個字立刻查；不帶字＝沿用上次的字與篩選（D-主-118），重查一次。
 * 不 import React 元件（useGlobalHotkeys 在 App 的 import 清單裡排得早）。
 */
import { useUiStore } from "../../store/uiStore";
import { useSearchStore } from "../../store/searchStore";

export function openFullSearch(term?: string) {
  const ui = useUiStore.getState();
  const search = useSearchStore.getState();
  ui.setQuickJumpOpen(false);
  if (term !== undefined) search.openWith(term);
  else search.refresh();
  ui.setPage("search");
  search.requestFocus();
}
