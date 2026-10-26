/**
 * 幹線／路線／車站的寫入流程（手機殼班第四輪 D-主-84：兩殼共用一支）。
 * 桌機 RouteDialog（新增幹線、新增路線、編輯幹線的刪除）、RoutePanel（刪除路線）、StationList（車站）與
 * 手機路線圖（幹線 ⋯、新增幹線／路線）、手機路線詳情頁（MobileRouteBody）都呼叫這裡——寫入與守門只有一處。
 * 純規則（文案組字、預設色、代碼、刪完切去哪）在 `./routeFlowRules.ts`，有單元測試；這裡只接 store、確認框與 toast。
 * 換幹線另有 `./moveRouteToLine.ts`（E12，本來就是共用的）。
 *
 * 兩殼不同的地方用選項接，流程本體不分殼：
 *   - `onConfirmed`：確認框按下「刪除」的那一刻（桌機＝收起 RouteDialog；手機＝關路線詳情頁），在真正刪除之前叫。
 *   - `onRestored`：刪除路線的「復原」做完之後（手機＝回到那條路線的第二層；桌機不給，側板本來就畫目前路線）。
 * 刪到目前開著的路線（或它所屬的幹線）就切到剩下的第一條（沒有＝null）、zoom／選取歸零——桌機大綱靠這個不留空頁；
 *   手機路線圖的第二層自己看「開著的路線還在不在」退回清單（MobileRouteMap）。
 */
import type { NodeRow } from "../../domain";
import { todayKey } from "../../lib/date";
import { collectDeleteHints, withDeleteHints } from "../../lines/deleteHints";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import {
  childRouteCount,
  lineDeleteConfirm,
  lineDeletedToast,
  lineHasCurrent,
  nextRouteAfterDelete,
  routeDeleteConfirm,
  routeDeletedToast,
  stationDeletedToast,
} from "./routeFlowRules";

const ns = () => useNodeStore.getState();
const ui = () => useUiStore.getState();

/**
 * 切到某條路線（或 null）並把 zoom／選取歸零（桌機大綱的狀態；手機殼不讀它們，歸零無害）。
 * 兩種時序照桌機原本的寫法各留一支：新增路線、刪幹線＝不等樹載完就歸零；刪路線與它的復原＝等 openRoute 完才歸零。
 */
function switchRouteNow(routeId: string | null): void {
  void ns().openRoute(routeId);
  ui().setZoom(null);
  ui().select(null);
}
async function switchRoute(routeId: string | null): Promise<void> {
  await ns().openRoute(routeId);
  ui().setZoom(null);
  ui().select(null);
}

/* ═══════════════ 幹線 ═══════════════ */

/** 新增幹線（只有名稱）；失敗回 null（store 已記 error） */
export function createLine(name: string): Promise<NodeRow | null> {
  return ns().createNode({ kind: "line", name, parentId: null, color: null, code: null });
}

/** 幹線改名 */
export async function renameLine(id: string, name: string): Promise<void> {
  await ns().updateNode(id, { name });
}

export interface DeleteFlowOptions {
  /** 確認框按下刪除、真正刪之前（桌機收 RouteDialog、手機關詳情頁） */
  onConfirmed?: () => void;
}

/**
 * 刪除幹線（連同子樹；repository soft delete，6 秒內可由 toast 復原）：
 * askConfirm（danger，寫明連同底下幾條路線＋別線附加句）→ deleteNode → 刪到目前路線所屬的幹線就切到剩下的第一條 → toast「復原」。
 * 別線的附加句（接縫 #62）：這裡沒載底下的樹 ⇒ descendantIds 傳 []，由該線自己補查；沒有線填＝空字串、框的字不變。
 */
export async function requestDeleteLine(line: NodeRow, opts: DeleteFlowOptions = {}): Promise<void> {
  const { routes, routeId } = ns();
  // 刪到目前路線所屬的幹線 → 確認後要換路線（按下確認的當下以這一刻為準，同桌機原本 render 時算好的值）
  const affectsCurrent = lineHasCurrent(routes, line.id, routeId);
  const text = lineDeleteConfirm(line, childRouteCount(routes, line.id));
  const hints = await collectDeleteHints(line, []);
  ui().askConfirm({
    title: text.title,
    body: withDeleteHints(text.body, hints),
    confirmLabel: text.confirmLabel,
    danger: true,
    onConfirm: () => void performDeleteLine(line.id, line.name, affectsCurrent, opts),
  });
}

async function performDeleteLine(id: string, name: string, affectsCurrent: boolean, opts: DeleteFlowOptions): Promise<void> {
  opts.onConfirmed?.();
  const ids = await ns().deleteNode(id);
  if (ids.length === 0) return; // 失敗：store 已記 error（App 殼顯示），不出復原 toast
  if (affectsCurrent) switchRouteNow(nextRouteAfterDelete(ns().routes, null));
  ui().showToast({
    message: lineDeletedToast(name),
    actionLabel: "復原",
    onAction: () => void ns().undoDelete(),
  });
}

/* ═══════════════ 路線 ═══════════════ */

export interface NewRouteInput {
  lineId: string;
  name: string;
  /** "var(--route-preset-N)" 或自訂 #hex */
  color: string;
  /** 已正規化（routeFlowRules.codeValue）；null＝不設 */
  code: string | null;
}

/** 新增路線並直接切過去（接著就能鋪軌）；失敗回 null */
export async function createRoute(input: NewRouteInput): Promise<NodeRow | null> {
  const row = await ns().createNode({
    kind: "route",
    name: input.name,
    parentId: input.lineId,
    color: input.color,
    code: input.code,
  });
  if (row) switchRouteNow(row.id);
  return row;
}

export interface DeleteRouteOptions extends DeleteFlowOptions {
  /** 「復原」做完之後（路線已放回、也已切回它） */
  onRestored?: (routeId: string) => void;
}

/**
 * 刪除路線（同側欄語彙）：danger 確認 → soft delete → 若是目前路線就切到剩下的第一條（沒有＝null）、zoom／選取歸零
 * → 復原 toast（放回後切回這條路線）。
 */
export async function requestDeleteRoute(route: NodeRow, opts: DeleteRouteOptions = {}): Promise<void> {
  // 別線的附加句（接縫 #62；沒有線填＝空字串、框的字不變）
  const hints = await collectDeleteHints(
    route,
    Object.keys(ns().tree.byId).filter((id) => id !== route.id),
  );
  const text = routeDeleteConfirm(route);
  ui().askConfirm({
    title: text.title,
    body: withDeleteHints(text.body, hints),
    confirmLabel: text.confirmLabel,
    danger: true,
    onConfirm: () =>
      void (async () => {
        opts.onConfirmed?.();
        const ids = await ns().deleteNode(route.id);
        if (!ids.length) return;
        const s = ns();
        if (s.routeId === route.id) await switchRoute(nextRouteAfterDelete(s.routes, route.id));
        ui().showToast({
          message: routeDeletedToast(route.name),
          actionLabel: "復原",
          onAction: () =>
            void (async () => {
              await ns().undoDelete();
              await switchRoute(route.id);
              opts.onRestored?.(route.id);
            })(),
        });
      })(),
  });
}

/* ═══════════════ 車站 ═══════════════ */
// 車站的寫入很薄（createNode／updateNode／deleteNode），收在這裡是為了兩殼的到站日與刪除收據只有一個寫法。

/** 新增車站（接在路線最後）；成功回那一列 */
export function addStation(routeId: string, name: string): Promise<NodeRow | null> {
  return ns().createNode({ kind: "station", name, parentId: routeId });
}

/** 到站章：沒到＝寫今天（依日界線）；到了＝取消（null）。回傳切換後是不是到站 */
export function toggleStationArrived(st: NodeRow): boolean {
  const next = !st.arrived_on;
  void ns().updateNode(st.id, { arrived_on: next ? todayKey(ui().dayStartHour) : null });
  return next;
}

/** 刪除車站（soft delete＋復原 toast；車站不在大綱樹裡、沒有子孫，不二次確認） */
export async function removeStation(st: NodeRow): Promise<void> {
  const ids = await ns().deleteNode(st.id);
  if (!ids.length) return;
  ui().showToast({
    message: stationDeletedToast(st.name),
    actionLabel: "復原",
    onAction: () => void ns().undoDelete(),
  });
}
