/**
 * statsJumps——時刻表統計「依路線」與路線詳情面板之間的雙向原子跳轉（v1.33 操作 2）。
 * 一律經 `navHistoryStore.runAtomicNav(...)` 包覆，確保跨頁導航與狀態更新合併為單一返回紀錄，雙端（Windows 桌機＋Android 手機）一致。
 */
import { nodeRepo } from "../../../data";
import { gotoTimetable } from "../../../lines/timetableTagEntities";
import { runAtomicNav } from "../../../store/navHistoryStore";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { jumpToNode } from "../../common/QuickJump";
import { jumpToNodeMobile, revealOnRouteMap } from "../../mobile/routeMapReveal";

export const STATS_ROUTE_FOCUS_EVENT = "ns-tt-stats-route-focus";
let pendingRouteFocusId: string | null = null;

/** 標記統計頁「依路線」要自動展開並閃爍定位的路線 ID */
export function focusStatsRoute(routeId: string): void {
  pendingRouteFocusId = routeId;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(STATS_ROUTE_FOCUS_EVENT));
  }
}

export function peekFocusedStatsRoute(): string | null {
  return pendingRouteFocusId;
}

export function clearFocusedStatsRoute(): void {
  pendingRouteFocusId = null;
}

/**
 * 從時刻表統計「依路線」樹狀列點 `↗` 原子跳轉至路線圖對應路線／節點：
 * - nodeId === null：打開該路線（已入庫路線則開乘車記錄簿）
 * - nodeId !== null：定位展開至該支線／列車／車廂／車票
 */
export async function jumpFromStatsToRouteNode(
  routeId: string,
  nodeId: string | null,
  shell: "desktop" | "mobile",
): Promise<void> {
  await runAtomicNav(async () => {
    const ui = useUiStore.getState();
    if (!nodeId) {
      const route = await nodeRepo.getNode(routeId).catch(() => null);
      if (!route || route.deleted_at !== null) {
        ui.showToast({ message: "找不到這條路線（可能已經刪除）" });
        return;
      }
      if (shell === "desktop") {
        await jumpToNode(route);
      } else {
        await jumpToNodeMobile(route);
      }
      return;
    }

    const node = await nodeRepo.getNode(nodeId).catch(() => null);
    if (!node || node.deleted_at !== null) {
      ui.showToast({ message: "找不到這個項目（可能已經刪除）" });
      return;
    }

    if (shell === "mobile") {
      if (node.parent_id !== null && node.route_id) {
        revealOnRouteMap(node.route_id, node.id);
      } else {
        await jumpToNodeMobile(node);
      }
      return;
    }

    await jumpToNode(node);
  });
}

/**
 * 從路線側板／手機路線詳情點 `↗` 原子跳轉至時刻表統計，並自動展開定位該路線
 */
export async function jumpFromRouteToTimetableStats(
  routeId: string,
  shell: "desktop" | "mobile",
): Promise<void> {
  await runAtomicNav(async () => {
    try {
      await gotoTimetable(shell);
    } catch (e) {
      console.warn("路線側板：打開時刻表統計失敗", e);
      return;
    }
    useTimetableStore.getState().setView("stats");
    focusStatsRoute(routeId);
  });
}
