/**
 * 刪一個節點的共用流程（失物招領 §5-6，D-主-321）：大綱、今日、行程表、側板、手機三頁與詳情頁、收件匣都走這一支。
 * 判準與流程本體在 `./deleteNodeRules.ts`（有單元測試）；這裡只接 repository、store、確認框與 toast。
 *
 * 子項數一律向 repository 問（`listSubtreeIds`，跟 softDelete 同一條查詢）：路線樹只載得到開著的那條路線、
 *   今日切片只有直屬數，以前各頁各數一種，手機不知道就一律問、桌機今日只數直屬會少問。問資料庫就只有一個數。
 * 路線、幹線、車站另走 `panel/routeFlows.ts`（要切路線、一律先問，形狀不同）。
 *
 * 各頁的差異用選項接，流程本體不分頁：`around`＝真的要刪的那一刻包住刪除；`onRestored`＝復原做完之後。
 */
import { nodeRepo } from "../../data";
import type { NodeRow } from "../../domain";
import { collectDeleteHints } from "../../lines/deleteHints";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { runDeleteNode, type DeleteNodeHooks } from "./deleteNodeRules";

export type { DeleteNodeHooks } from "./deleteNodeRules";

const ns = () => useNodeStore.getState();
const ui = () => useUiStore.getState();

/**
 * 節點從切片找（樹＞今日），都沒有才問 repository（行程表串流、收件匣的票不一定在切片裡）。
 * 找不到＝已經不在了，什麼都不做。
 */
async function findNode(id: string): Promise<NodeRow | null> {
  const s = ns();
  const hit = s.tree.byId[id] ?? s.today.byId[id];
  if (hit) return hit;
  try {
    return await nodeRepo.getNode(id);
  } catch (e) {
    console.warn("刪除：讀節點失敗", e);
    return null;
  }
}

export async function confirmAndDeleteNode(id: string, hooks: DeleteNodeHooks = {}): Promise<void> {
  const node = await findNode(id);
  if (!node) return;
  await runDeleteNode(
    {
      subtreeIds: (x) => nodeRepo.listSubtreeIds(x),
      hints: collectDeleteHints,
      confirm: (text, onConfirm) => ui().askConfirm({ ...text, danger: true, onConfirm }),
      remove: (x) => ns().deleteNode(x), // 失敗：store 已寫 error（App 殼顯示）、回 []
      restore: (ids) => ns().restoreNodes(ids),
      toast: (message, onUndo) => ui().showToast({ message, actionLabel: "復原", onAction: onUndo }),
    },
    node,
    hooks,
  );
}
