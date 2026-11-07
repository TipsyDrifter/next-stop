/**
 * 手機從別處帶條件進篩選清單（⑫；契約 §7）：路線第一層的「誤點 N」、完整搜尋沒字時那句指路。
 * 桌機走 board/openFilter（openRouteMap）；手機的路線圖第一、二層是 MobileRouteMap 的本地狀態，所以多一個節拍叫它退回第一層。
 */
import { create } from "zustand";
import { DEFAULT_TASK_FILTER } from "../../../domain/taskFilter";
import { useBoardStore } from "../../../store/boardStore";
import { useUiStore } from "../../../store/uiStore";

/** 每次要求進篩選就換一個數（MobileRouteMap 看到換了就退回第一層） */
export const useFilterNavStore = create<{ seq: number }>(() => ({ seq: 0 }));

function toFirstLayer(): void {
  useUiStore.getState().setMobileTab("routemap");
  useFilterNavStore.setState((s) => ({ seq: s.seq + 1 }));
}

/** 路線圖還沒開過時偏好還沒讀回來：先等它，不然讀回來的舊值會蓋掉這次要去的分頁 */
const afterLoaded = (fn: () => void) => void useBoardStore.getState().ensureLoaded().then(fn);

export function openFilterTabMobile(): void {
  toFirstLayer();
  afterLoaded(() => useBoardStore.getState().setOverviewTab("filter"));
}

/** 路線列的「誤點 N」：這條路線＋誤點 */
export function openLateOfRouteMobile(routeId: string): void {
  toFirstLayer();
  afterLoaded(() => useBoardStore.getState().openFiltered({ ...DEFAULT_TASK_FILTER, routes: [routeId], late: true }));
}
