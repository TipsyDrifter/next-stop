/**
 * routeMapActions——手機路線圖第二層樹的寫入動作（手機殼班 D-主-71／72；契約 §一A）。
 *
 * 紀律：**不另發明寫入路徑**。每一條都接到桌機大綱同一支 store 動作與守門——
 *   蓋済／取消済／取消運休、運休 ＝ outline/nodeFlows（completeNodeFlow／suspendNodeFlow，桌機大綱也改叫它）
 *   停用理由（降層／升層／新增車票／上移／下移）＝ outline/rowGuards（桌機 menuFor 同一支；手機只換兩句到頂的話）
 *   升降層／上移下移 ＝ nodeStore.indent／outdent／reorder（失敗吐 reason，同 useOutlineController.indentNode／reorderSelected）
 *   新增 ＝ nodeStore.createNode（落點同大綱草稿：同層＝接在自己後面、新增車票＝列車／車廂底下最後一張）
 *   改名／記乘務記錄／刪除 ＝ useMobileToday 的 renameTicket／logTicket／deleteTicket（今日、行程表同一條；刪除＝toast＋復原）
 *   改期／時刻 ＝ scheduleActions（行程表手機版同一組；以「締切卡」形狀 `{ kind: "due", node }` 傳節點本身）
 *   移動到 ＝ common/moveTo.moveNodeTo
 * 本檔不 import React；狀態（收合、閃一下）由 MobileRouteMap 給回呼。
 */
import { KIND_LABEL, defaultChildKind, describeRule, isTaskKind, parseRule, type NodeKind, type NodeRow } from "../../../domain";
import type { CurrentOccurrence } from "../../../data";
import { effectiveTime, isTimeOverridden } from "../../../domain/scheduledTime";
import { adaptKind, descendantCount, siblingsOf, useNodeStore, type TreeIndex } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { MOBILE_GUARD_WORDS, rowGuards, type RowGuards } from "../../outline/rowGuards";
import type { TicketCardModel } from "../../schedule/ticketCard";
import { deleteTicket } from "../useMobileToday";

const ns = () => useNodeStore.getState();
const toast = (message?: string) => {
  if (message) useUiStore.getState().showToast({ message }, 3600);
};

/** 樹上一個節點 → 票卡模型（⋯ sheet 吃這個形狀）。済／運休口徑同 MobileRouteMap 檔頭那把尺；班次日＝occurrence?.due_on ?? scheduled_on */
export function cardFromTreeNode(node: NodeRow, occ: CurrentOccurrence | undefined, serial: string | null): TicketCardModel {
  const rule = parseRule(node.repeat_rule);
  const done = occ ? occ.status === "done" : node.status === "done";
  const suspended = occ?.status === "skipped";
  const railDate = occ?.due_on ?? node.scheduled_on;
  return {
    key: node.id,
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    routeId: node.route_id,
    serial: serial || null,
    fare: rule ? "定期券" : node.parent_id === null ? "臨時券" : "乘車券",
    ruleText: rule ? describeRule(rule) : null,
    isRepeat: rule !== null,
    scheduledOn: node.scheduled_on,
    railDate,
    dueOn: node.due_on,
    carriedFrom: node.carried_from,
    done,
    suspended,
    paused: node.status === "paused" && !done && !suspended,
    late: null,
    children: null,
    stampable: true,
    stampHint: null,
    readOnly: false,
    time: effectiveTime(node, railDate),
    timeOverridden: isTimeOverridden(node, railDate),
    ruleTime: node.scheduled_time,
    estimateMin: node.estimate_min,
    doing: node.status === "doing",
  };
}

/** 停用理由（手機那兩句到頂的話；zoomId＝本地縮放，不是桌機 uiStore.zoomId） */
export function guardsFor(tree: TreeIndex, routeId: string, zoomId: string | null, id: string): RowGuards | null {
  return rowGuards(tree, routeId, zoomId, id, { siblingsOf, adaptKind }, MOBILE_GUARD_WORDS);
}

/** 節點的父鍵：路線直屬＝routeId，其餘＝parent_id（useOutlineController.parentKey 同一條） */
function parentKey(tree: TreeIndex, routeId: string, n: NodeRow): string {
  return n.parent_id && n.parent_id !== routeId && tree.byId[n.parent_id] ? n.parent_id : routeId;
}

/** 一次新增的落點與種類（MobileTextSheet 命名後交給 createAt） */
export interface AddPlan {
  kind: NodeKind;
  parentId: string;
  afterId: string | null;
}

/** 同層新增：同種類、接在自己後面（大綱 keys.addSibling） */
export function siblingPlan(tree: TreeIndex, routeId: string, n: NodeRow): AddPlan {
  return { kind: n.kind, parentId: parentKey(tree, routeId, n), afterId: n.id };
}

/** 新增車票：列車／車廂＝掛在底下最後一張；車票＝接在自己後面（大綱 keys.addTicket；能不能做由 guards.ticketWhy 先擋） */
export function ticketPlan(tree: TreeIndex, routeId: string, n: NodeRow): AddPlan {
  return isTaskKind(n.kind)
    ? { kind: "ticket", parentId: n.id, afterId: null }
    : { kind: "ticket", parentId: parentKey(tree, routeId, n), afterId: n.id };
}

/** 空路線／空縮放層的「新增第一班」：路線頂層＝列車；縮放進去＝那一層的預設子種類（大綱沒有選取時的 addSibling） */
export function firstPlan(routeId: string, zoom: NodeRow | null): AddPlan {
  return zoom
    ? { kind: defaultChildKind(zoom.kind) ?? "car", parentId: zoom.id, afterId: null }
    : { kind: "train", parentId: routeId, afterId: null };
}

/** 照 plan 建一個節點；失敗吐大綱同一句。回傳新列（呼叫端展開父節點、捲過去閃一下） */
export async function createAt(plan: AddPlan, name: string): Promise<NodeRow | null> {
  const row = await ns().createNode({ kind: plan.kind, name, parentId: plan.parentId, afterId: plan.afterId ?? undefined });
  if (!row) toast("新增失敗——請再試一次");
  return row;
}

/** 新增子面板的標題（同層新增列車／新增車票…） */
export function addTitle(plan: AddPlan, sibling: boolean): string {
  return sibling ? `同層新增${KIND_LABEL[plan.kind]}` : `新增${KIND_LABEL[plan.kind]}`;
}

/** 降層：成功回新父節點 id（呼叫端把它展開）；失敗吐 reason */
export async function indentRow(id: string): Promise<string | null> {
  const r = await ns().indent(id);
  if (!r.ok) {
    toast(r.reason);
    return null;
  }
  return ns().tree.byId[id]?.parent_id ?? null;
}

export async function outdentRow(id: string): Promise<boolean> {
  const r = await ns().outdent(id);
  if (!r.ok) toast(r.reason);
  return r.ok;
}

export async function reorderRow(id: string, delta: -1 | 1): Promise<boolean> {
  const r = await ns().reorder(id, delta);
  if (!r.ok) toast(r.reason);
  return r.ok;
}

/** 刪除：今日頁同一支（≥5 個子項先問、toast「已刪除」＋復原）。子項數＝樹上的子孫數（大綱 deleteNodeFlow 同一個數） */
export function deleteRow(tree: TreeIndex, id: string): void {
  const n = tree.byId[id];
  if (!n) return;
  deleteTicket(id, n.name, descendantCount(tree, id));
}
