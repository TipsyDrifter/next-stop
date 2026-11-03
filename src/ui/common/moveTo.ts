/**
 * 「移動到…」的動作與入口協調（磨光⑤ B1；契約 §1 B1）——桌機側板、大綱 ⋯、手機票卡 ⋯ 共用。
 *
 * 動作：`moveNodeTo(id, dest)` ＝ 算落點（新父節點的最後一個，D-主-56）→ `nodeStore.moveNode`
 *   → toast「已移到「路線・父節點」」＋「復原」（搬回原父、原本的上下鄰居之間：回饋乙起復原記鄰居、不記整數 position）。
 *   底層 `nodeRepo.move` 已會擋父子種類、擋搬進自己子樹、改寫子樹的 line_id／route_id；同步不用改（接收端重算快取）。
 * 協調：大綱列 ⋯ 選單的「移動到…」只負責「選中那列、開側板、請側板打開挑選器」——挑選器只有側板一個家，
 *   不在大綱列旁再長一份（`useMoveRequest`）。
 */
import { create } from "zustand";
import { nodeRepo } from "../../data";
import { appendIndex, destParentId, isSameParent, moveToastText, type MoveDest } from "../../domain/moveTo";
import { anchorAround } from "../../domain/nodeOrder";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { APPEND } from "../../store/batchActions";

const toast = (message: string) => useUiStore.getState().showToast({ message }, 4000);

/**
 * 把 id 搬到 dest 的最後一位。成功回 true（toast 已出）；挑到目前位置、或被擋下 ⇒ toast 一句、回 false。
 */
export async function moveNodeTo(id: string, dest: MoveDest): Promise<boolean> {
  const ns = () => useNodeStore.getState();
  const node = await nodeRepo.getNode(id);
  if (!node || node.deleted_at) {
    toast("找不到這個項目");
    return false;
  }
  if (isSameParent(dest, node.parent_id)) {
    toast("已經在這裡了");
    return false;
  }
  const parentId = destParentId(dest);
  if (!parentId || !dest.routeId) return false;

  // 落點＝新父節點那份清單（顯示群組）的尾端。路線最上層＝路線直屬的非車站＋掛這條路線標籤的根層臨時車票
  // （listRouteTree 撈的就是這條路線的列，根層那幾張 parent_id 是 null）
  const tree = await nodeRepo.listRouteTree(dest.routeId);
  const siblings = tree.filter((n) => n.parent_id === parentId || (dest.nodeId === null && n.parent_id === null));
  const index = appendIndex(siblings);

  const parentName = dest.nodeId ? (tree.find((n) => n.id === dest.nodeId)?.name ?? null) : null;
  const routeName = ns().routes.find((r) => r.id === dest.routeId)?.name ?? null;

  // 復原用：原本那份清單裡的上下鄰居（不記整數 position——#119：路線最上層的列車和臨時車票是兩套編號）。
  // 原父節點：根層車票＝它的路線標籤（moveToAnchor 的慣例：路線 id＝掛這條路線的臨時車票，null＝收件匣）
  const anchor = anchorAround(await nodeRepo.listSiblingIds(id), id);
  const origParent = node.parent_id ?? (node.kind === "ticket" ? node.route_id : null);
  // 丁 D-主-245：車票搬到「路線」＝掛那條路線標籤的根層車票（路線底下的車票就是這種存法；moveToAnchor 換標籤）
  const r =
    node.kind === "ticket" && dest.nodeId === null
      ? await ns().moveToAnchor([id], dest.routeId, APPEND)
      : await ns().moveNode(id, parentId, index);
  if (!r.ok) {
    toast(r.reason ?? "沒有搬成功——請再試一次");
    return false;
  }

  useUiStore.getState().showToast({
    message: moveToastText(routeName, parentName),
    actionLabel: "復原",
    onAction: () =>
      void (async () => {
        // 一筆寫入：搬回原父、原鄰居之間；臨時車票的路線標籤一起還原（moveToAnchor 依 origParent 換標籤）
        const back = await ns().moveToAnchor([id], origParent, anchor);
        if (!back.ok) toast(back.reason ?? "復原失敗——請再試一次");
      })(),
  });
  return true;
}

/* ───────── 大綱 ⋯ →側板挑選器 ───────── */

interface MoveRequest {
  /** 請側板替這個節點打開「移動到…」挑選器；側板接手後清回 null */
  id: string | null;
  ask(id: string): void;
  clear(): void;
}

export const useMoveRequest = create<MoveRequest>((set) => ({
  id: null,
  ask: (id) => set({ id }),
  clear: () => set({ id: null }),
}));

/** 大綱 ⋯ 選單用：選中、開側板、請側板開挑選器 */
export function requestMoveTo(id: string): void {
  const ui = useUiStore.getState();
  ui.select(id);
  ui.setPanelOpen(true);
  useMoveRequest.getState().ask(id);
}
