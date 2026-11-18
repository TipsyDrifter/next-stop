/**
 * 清單與搜尋結果「排序」的選擇（磨光⑥ 契約 §2-4；v1.32 2B-2 升級當月就地排序）：
 *   - 平常在清單視圖瀏覽月份（`!searchOpen`）：直接更新 `store.setListSort(sort)`，就地重排當前瀏覽月份（翻月自然沿用，不跳進跨月搜尋模式）；
 *   - 跨月搜尋開著時（`searchOpen`）：有條件則就地更新 `store.setResultSort(sort)`；尚未帶條件時走 `searchMonthSorted(sort)`。
 */
import { useTicketStore } from "../../../store/ticketStore";
import { DEFAULT_ENTRY_SORT, isFilterActive, type EntrySort } from "../../../domain/ticketView";

export function chooseSort(sort: EntrySort): void {
  const s = useTicketStore.getState();
  if (!s.searchOpen) {
    s.setListSort(sort);
    return;
  }
  if (sort === DEFAULT_ENTRY_SORT && !isFilterActive(s.filter)) s.setResultSort(sort);
  else if (isFilterActive(s.filter)) s.setResultSort(sort);
  else void s.searchMonthSorted(sort);
}
