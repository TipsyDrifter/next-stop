/**
 * rowGuards——大綱一列的「做不到的理由」（手機殼班 D-主-71／72；從 useOutlineController.menuFor 抽出）。
 *
 * 桌機大綱 ⋯ 選單（磨光②）與手機路線圖 ⋯ sheet 同一把尺：降層／升層／新增車票／上移／下移五項的停用條件，
 *   逐條鏡射 nodeStore.indent／outdent／reorder 與 keys.addTicket 的拒絕理由；真的點下去仍由原本那條路把關。
 * 純函式（node test 直接載入：scripts/tests/row-guards.test.ts）：不 import store——`siblingsOf`／`adaptKind`
 *   住在 nodeStore（會連帶載入 repository），由呼叫端傳進來（`deps`），兩殼用的都是 store 那一份。
 *
 * 兩殼只差兩句話（`words`）：桌機「用下面的『移動到…』」「先按 Esc 退出聚焦」；手機沒有 Esc、⋯ sheet 的「移動到…」
 *   跟升降層同在「編排」裡，句子各寫各的，其餘字一字不差。
 */
import { canHaveChildren, isTaskKind, type NodeKind, type NodeRow } from "../../domain/node.ts";

/** 樹索引的最小形狀（＝nodeStore.TreeIndex；這裡只讀 byId） */
export interface GuardTree {
  byId: Record<string, NodeRow>;
  childrenOf: Record<string, string[]>;
  roots: string[];
}

export interface RowGuardDeps {
  siblingsOf(tree: GuardTree, routeId: string | null, id: string): { siblings: string[]; index: number };
  adaptKind(kind: NodeKind, newParentKind: NodeKind): NodeKind | null;
}

/** 兩殼不同的兩句（升層的兩種到頂） */
export interface RowGuardWords {
  /** 已在路線最上層 */
  routeTop: string;
  /** 已在聚焦範圍的頂層 */
  zoomTop: string;
}

export const DESKTOP_GUARD_WORDS: RowGuardWords = {
  routeTop: "已經在路線最上層——要換路線，用下面的「移動到…」",
  zoomTop: "已到聚焦範圍的頂層——先按 Esc 退出聚焦再升層",
};

export const MOBILE_GUARD_WORDS: RowGuardWords = {
  routeTop: "已經在路線最上層——要換路線，用「移動到…」",
  zoomTop: "已到聚焦範圍的頂層——先點上面的路徑退出聚焦再升層",
};

/** 每一項：null＝可以做；字串＝做不到的理由（停用＋說原因） */
export interface RowGuards {
  indentWhy: string | null;
  outdentWhy: string | null;
  /** 「新增車票」（車票列＝接在自己後面，列車／車廂＝掛在底下） */
  ticketWhy: string | null;
  upWhy: string | null;
  downWhy: string | null;
}

export function rowGuards(
  tree: GuardTree,
  routeId: string | null,
  zoomId: string | null,
  id: string,
  deps: RowGuardDeps,
  words: RowGuardWords,
): RowGuards | null {
  const n = tree.byId[id];
  if (!n) return null;
  const { siblings, index } = deps.siblingsOf(tree, routeId, id);
  const prev = index > 0 ? tree.byId[siblings[index - 1]] : undefined;
  const indentWhy = !prev
    ? "上面沒有可以掛靠的節點"
    : !canHaveChildren(prev.kind)
      ? "車票／車站底下不能掛東西"
      : !deps.adaptKind(n.kind, prev.kind)
        ? "這種節點不能掛在那裡"
        : null;
  const parent = n.parent_id && n.parent_id !== routeId ? tree.byId[n.parent_id] : undefined;
  const gpId = parent?.parent_id;
  const gpKind: NodeKind = gpId && gpId !== routeId && tree.byId[gpId] ? tree.byId[gpId].kind : "route";
  const outdentWhy = !parent
    ? words.routeTop
    : zoomId && n.parent_id === zoomId
      ? words.zoomTop
      : !deps.adaptKind(n.kind, gpKind)
        ? "這種節點不能升到那一層"
        : null;
  const ticketWhy = isTaskKind(n.kind) || n.kind === "ticket" ? null : "支線底下不能直接掛車票——先建一班列車";
  return {
    indentWhy,
    outdentWhy,
    ticketWhy,
    upWhy: index > 0 ? null : "已經在最上面",
    downWhy: index >= 0 && index < siblings.length - 1 ? null : "已經在最下面",
  };
}
