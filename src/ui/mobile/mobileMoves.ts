/**
 * mobileMoves——手機拖曳放下與「上移／下移」的寫入（回饋乙；路線圖第二層、路線清單第一層、車站清單共用）。
 *
 * 寫入一律 `nodeStore.moveToAnchor`（一批寫入、一次同步；parentId 慣例：路線 id＝路線最上層、null＝根層、其他＝那個節點底下）。
 * 復原＝每張搬回原父節點、原本那份清單裡的上下鄰居之間（不記整數 position——#119；同 common/moveTo.ts 的復原）：
 *   照傳進來的順序（＝畫面順序）一張一張放回，前一張放回去之後就是後一張的錨，不會落錯格。
 * （桌機那邊 store/batchActions 也在長同一種 helper；本檔不依賴它，免得兩條線互等。）
 */
import { nodeRepo } from "../../data";
import { anchorAround, type SlotAnchor } from "../../domain/nodeOrder";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";

const toast = (message: string) => useUiStore.getState().showToast({ message }, 4000);

/** ids 搬到 parentId 底下、落點錨之間；成功出 `message`＋「復原」。被擋下＝toast 理由、回 false */
export async function moveNodesWithUndo(
  ids: readonly string[],
  parentId: string | null,
  anchor: SlotAnchor,
  message: string,
): Promise<boolean> {
  const origins: { id: string; parent: string | null; anchor: SlotAnchor }[] = [];
  for (const id of ids) {
    const n = await nodeRepo.getNode(id);
    if (!n) continue;
    // 根層車票的「父節點」＝它的路線標籤（moveToAnchor 慣例：路線 id＝掛這條路線的臨時車票，null＝收件匣）
    const parent = n.parent_id ?? (n.kind === "ticket" ? n.route_id : null);
    origins.push({ id, parent, anchor: anchorAround(await nodeRepo.listSiblingIds(id), id) });
  }
  const r = await useNodeStore.getState().moveToAnchor([...ids], parentId, anchor);
  if (!r.ok) {
    toast(r.reason ?? "沒有搬成功——請再試一次");
    return false;
  }
  useUiStore.getState().showToast({
    message,
    actionLabel: "復原",
    onAction: () =>
      void (async () => {
        for (const o of origins) {
          const back = await useNodeStore.getState().moveToAnchor([o.id], o.parent, o.anchor);
          if (!back.ok) {
            toast(back.reason ?? "復原失敗——請再試一次");
            return;
          }
        }
      })(),
  });
  return true;
}

/**
 * 清單裡往上（-1）／往下（+1）一格的落點錨；到頂／到底回 null。
 * 往上＝插在「上上一張」與「上一張」之間；往下＝插在「下一張」與「下下一張」之間。
 */
export function stepAnchor(order: readonly string[], id: string, delta: -1 | 1): SlotAnchor | null {
  const i = order.indexOf(id);
  if (i < 0) return null;
  if (delta < 0) return i === 0 ? null : { after: order[i - 2] ?? null, before: order[i - 1] };
  return i >= order.length - 1 ? null : { after: order[i + 1], before: order[i + 2] ?? null };
}
