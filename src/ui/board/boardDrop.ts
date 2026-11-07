/**
 * 路線看板的落點（⑫；契約 §1）——桌機 RouteBoard 與手機看板共用：換欄怎麼寫、依列車能不能放。
 *
 * 依狀態＝改現況、依車站＝改 station_id、依列車＝寫 sort_key（有鄰居錨照鄰居放；手機底部落點沒有縫，排到那一欄最後）。
 * 寫入都走 boardActions／moveWithUndo，附復原；這裡只把「放到哪一欄」翻成那幾支。
 */
import type { NodeRow } from "../../domain";
import { resolveTrainDrop, type BoardGroup, type BoardStatus } from "../../domain/board";
import { dropVerdict } from "../../domain/dropRules";
import { APPEND, moveWithUndo } from "../../store/batchActions";
import { useNodeStore, type TreeIndex } from "../../store/nodeStore";
import { moveCardToHolder, moveCardsToStatus, setCardsStation } from "./boardActions";
import { NO_STATION_COL, type BoardColumnModel } from "./useRouteBoard";

export interface BoardMoveCtx {
  group: BoardGroup;
  columns: readonly BoardColumnModel[];
  tree: TreeIndex;
  routeId: string;
  /** 依列車的最上層（聚焦的那一節，否則路線） */
  topId: string;
  /** 只有一張進済欄（播章動畫） */
  onStamped?(id: string): void;
}

export function moveBoardCards(ctx: BoardMoveCtx, ids: readonly string[], colKey: string, anchor?: { after: string | null; before: string | null }): void {
  const col = ctx.columns.find((c) => c.key === colKey);
  if (!col) return;
  const nodes = ids.flatMap((id) => ctx.tree.byId[id] ?? []);
  if (ctx.group === "status") {
    const to = colKey as BoardStatus;
    if (to === "done" && nodes.length === 1) ctx.onStamped?.(nodes[0].id);
    void moveCardsToStatus(nodes, to);
  } else if (ctx.group === "station") {
    void setCardsStation(nodes, colKey === NO_STATION_COL ? null : colKey, colKey === NO_STATION_COL ? "還沒排站" : `「${col.title}」`);
  } else if (anchor) {
    const p = resolveTrainDrop(ctx.tree, ctx.topId, colKey, anchor.after, anchor.before);
    const parentOf = (id: string) => ctx.tree.byId[id]?.parent_id ?? ctx.routeId;
    const same = ids.every((id) => parentOf(id) === p.parentId);
    if (same) void moveWithUndo(ids, p.parentId, { after: p.after, before: p.before }, ids.length > 1 ? `已移動 ${ids.length} 張` : "已移動");
    else void moveCardToHolder(ids, p.parentId, { after: p.after, before: p.before }, col.title);
  } else {
    void moveCardToHolder(ids, col.holder?.id ?? ctx.topId, APPEND, col.title);
  }
}

/** 依列車放不放得下（讀最新的樹：拖曳途中可能同步進來）；能放回 true，不能放回一句理由 */
export function trainDropVerdict(top: { id: string; kind: NodeRow["kind"] }, ids: readonly string[], colKey: string, after: string | null, before: string | null): true | string {
  const t = useNodeStore.getState().tree;
  const p = resolveTrainDrop(t, top.id, colKey, after, before);
  const v = dropVerdict(t, top, ids, p.parentId === top.id ? null : p.parentId);
  return v.ok ? true : v.why;
}
