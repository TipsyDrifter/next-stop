/**
 * 搜尋結果「排序」的選擇（磨光⑥ 契約 §2-4；D-票-64；兩殼共用）：桌機 FilterChips 的排序 chip／頁首 SortButton、
 * 手機 SearchRow 的排序 chip／月份列「排序」／MobileSearchSheet 的「排序」段都走這一支。
 *
 * 沒有任何條件（一般清單）時選「日期・新到舊」以外的 ⇒ 開搜尋、期間＝現在看的那個月、套上排序（store.searchMonthSorted；
 * 金額排序要一個有邊界的範圍，逐月往前載的清單沒有）。已經有條件 ⇒ 只換排序（不重查）。
 */
import { useTicketStore } from "../../../store/ticketStore";
import { DEFAULT_ENTRY_SORT, isFilterActive, type EntrySort } from "../../../domain/ticketView";

export function chooseSort(sort: EntrySort): void {
  const s = useTicketStore.getState();
  if (sort === DEFAULT_ENTRY_SORT && !isFilterActive(s.filter)) s.setResultSort(sort);
  else void s.searchMonthSorted(sort);
}
