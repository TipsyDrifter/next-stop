/**
 * notesDeleteHint——刪除確認框的附加句（桌機；旅客筆記車次④契約 §5.3、0-4 乙／D-筆-52）。
 *
 * mount 的 `nodeDeleteHints`：核心 `collectDeleteHints` 在四個刪除入口（路線面板、路線／幹線對話框、任務側板子項、大綱）
 * 彈確認框之前問一次；回字串＝接在原句後面、回 null＝原句一字不動。
 *   - 路線／支線／列車／車廂：被刪節點自己＋呼叫端給的子孫 id；呼叫端沒載到樹（路線對話框傳 `[]`）時，路線自己 `listRouteTree` 補查
 *   - 幹線（kind="line"）：底下所有路線（`listSidebar().routes` 裡 line_id 相同的）各補查一棵樹
 *   - 筆記不會跟著刪（D-筆-6／22）：之後顯示「原節點已刪除」，可以再掛到別處；掛 0 則不出句
 */
import type { NodeRow } from "../../domain";
import { nodeRepo } from "../../data";
import { noteRepo } from "../../data/noteRepo";

/** 這個節點與底下所有節點的 id（呼叫端的 descendantIds 為空而節點是路線／幹線時自己補查） */
async function idsToCount(node: NodeRow, descendantIds: readonly string[]): Promise<string[]> {
  if (node.kind === "line") {
    const { routes } = await nodeRepo.listSidebar();
    const mine = routes.filter((r) => r.line_id === node.id);
    const trees = await Promise.all(mine.map((r) => nodeRepo.listRouteTree(r.id)));
    return [node.id, ...mine.map((r) => r.id), ...trees.flat().map((n) => n.id)];
  }
  if (node.kind === "route" && descendantIds.length === 0) {
    const tree = await nodeRepo.listRouteTree(node.id);
    return [node.id, ...tree.map((n) => n.id)];
  }
  return [node.id, ...descendantIds];
}

export async function notesDeleteHint(node: NodeRow, descendantIds: readonly string[]): Promise<string | null> {
  const ids = Array.from(new Set(await idsToCount(node, descendantIds)));
  const n = await noteRepo.countByNodes(ids);
  if (!n) return null;
  return `有 ${n} 則筆記掛在這裡（含底下的節點）。筆記不會跟著刪，之後會顯示「原節點已刪除」，可以再掛到別處。`;
}
