/**
 * 從別處帶條件進篩選清單（⑫；契約 §7）：路線一覽卡的「誤點 N」、書封常用篩選、完整搜尋沒字時那句指路。
 * 桌機的路線圖＝uiStore.openRouteMap（進一覽）＋boardStore 的分頁；手機殼切路線圖第一層由手機那邊接 `useBoardStore.openFiltered`。
 */
import { DEFAULT_TASK_FILTER } from "../../domain/taskFilter";
import { useBoardStore } from "../../store/boardStore";
import { useUiStore } from "../../store/uiStore";

export function openFilterTab(): void {
  useUiStore.getState().openRouteMap();
  useBoardStore.getState().setOverviewTab("filter");
}

/** 路線卡的「誤點 N」：這條路線＋誤點 */
export function openLateOfRoute(routeId: string): void {
  useUiStore.getState().openRouteMap();
  useBoardStore.getState().openFiltered({ ...DEFAULT_TASK_FILTER, routes: [routeId], late: true });
}

export function openSavedFilter(id: string): void {
  openFilterTab();
  useBoardStore.getState().applySaved(id);
}
