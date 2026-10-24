/**
 * 路線換幹線（UI 丙-3 C2；E12）：側板「所屬幹線」欄呼叫這支。
 * 邏輯在 `./routeLine.ts`（純、可單測）；這裡只接 store 與 toast：
 *   `nodeStore.moveNode(routeId, lineId, 新幹線最後一位)` → toast「已移到幹線「X」」＋「復原」（搬回原幹線、原位置）。
 * moveNode 成功後會 refresh（loadSidebar），書封的幹線分組立刻跟著變；目前開著的路線 routeId 不變，路線圖眉標自動跟新幹線。
 * 已知（契約 §2）：路線標籤指向這條路線的**根層臨時車票**，它們的 line_id 快取不在子樹裡、本機不跟著改；
 *   UI 沒有讀它的地方。下一次同步拉取到含 nodes 的物件時，engine.rs 的 recompute_caches_tx 會整表重算。
 */
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { runRouteMove, type RouteLinePorts } from "./routeLine";

const ports: RouteLinePorts = {
  routes: () => useNodeStore.getState().routes,
  move: (id, parentId, index) => useNodeStore.getState().moveNode(id, parentId, index),
};

const shortToast = (message: string) => useUiStore.getState().showToast({ message }, 4000);

/** 把路線搬到 lineId 那條幹線的最後；成功出 toast＋復原，回 true */
export async function moveRouteToLine(routeId: string, lineId: string): Promise<boolean> {
  const lineName = (id: string) => useNodeStore.getState().lines.find((l) => l.id === id)?.name ?? "";
  const r = await runRouteMove(ports, routeId, lineId);
  if (!r.ok) {
    shortToast(r.reason ?? "沒有搬成功——請再試一次");
    return false;
  }
  if (r.same || !r.undo) return false;
  const undo = r.undo;
  useUiStore.getState().showToast({
    message: `已移到幹線「${lineName(lineId)}」`,
    actionLabel: "復原",
    onAction: () =>
      void undo().then((back) => {
        if (!back.ok) shortToast(back.reason ?? "復原失敗——請再試一次");
      }),
  });
  return true;
}
