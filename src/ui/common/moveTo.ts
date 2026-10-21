/**
 * 「移動到…」的動作與入口協調（磨光⑤ B1；契約 §1 B1）——桌機側板、大綱 ⋯、手機票卡 ⋯ 共用。
 *
 * 動作：`moveNodeTo(id, dest)` ＝ 算落點（新父節點的最後一個，D-主-56）→ `nodeStore.moveNode`
 *   → toast「已移到「路線・父節點」」＋「復原」（搬回原父、原位置）。
 *   底層 `nodeRepo.move` 已會擋父子種類、擋搬進自己子樹、改寫子樹的 line_id／route_id；同步不用改（接收端重算快取）。
 * 協調：大綱列 ⋯ 選單的「移動到…」只負責「選中那列、開側板、請側板打開挑選器」——挑選器只有側板一個家，
 *   不在大綱列旁再長一份（`useMoveRequest`）。
 */
import { create } from "zustand";
import { nodeRepo } from "../../data";
import { appendIndex, destParentId, isSameParent, moveToastText, type MoveDest } from "../../domain/moveTo";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";

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

  // 落點＝新父節點現有子節點的 max(position)+1。路線直屬的子節點連車站一起算（listRouteTree 不含車站，站在 sidebar 那份）
  const tree = await nodeRepo.listRouteTree(dest.routeId);
  const siblings = [
    ...tree.filter((n) => n.parent_id === parentId),
    ...ns().stations.filter((s) => s.parent_id === parentId),
  ];
  const index = appendIndex(siblings);

  const parentName = dest.nodeId ? (tree.find((n) => n.id === dest.nodeId)?.name ?? null) : null;
  const routeName = ns().routes.find((r) => r.id === dest.routeId)?.name ?? null;

  const orig = { parentId: node.parent_id, position: node.position, routeId: node.route_id };
  const r = await ns().moveNode(id, parentId, index);
  if (!r.ok) {
    toast(r.reason ?? "沒有搬成功——請再試一次");
    return false;
  }

  useUiStore.getState().showToast({
    message: moveToastText(routeName, parentName),
    actionLabel: "復原",
    onAction: () =>
      void (async () => {
        const back = await ns().moveNode(id, orig.parentId, orig.position);
        if (!back.ok) {
          toast(back.reason ?? "復原失敗——請再試一次");
          return;
        }
        // 臨時車票搬回根層時，move 會把新路線留成「路線標籤」（臨時車票保留路線標籤的規則）；還原成原本的標籤
        if (orig.parentId === null && node.kind === "ticket") {
          const now = await nodeRepo.getNode(id);
          if (now && now.route_id !== orig.routeId) await ns().setRouteTag(id, orig.routeId);
        }
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
