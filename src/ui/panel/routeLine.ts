/**
 * 路線換幹線的純邏輯（UI 丙-3 C2；E12，使用者 10-22 定做）——側板「所屬幹線」欄的底。
 * 零 runtime store／data import：`scripts/tests/route-line-move.test.ts` 用 node 直接載入本檔，配記憶體 repository 驗。
 * 接到 store 與 toast 的那一層在 `./moveRouteToLine.ts`。
 *
 * 規則：
 * - 落點＝新幹線的最後一位（`appendIndex`，同「移動到…」D-主-56）；挑到原本那條幹線＝不搬。
 * - 搬遷本身走既有 `nodeRepo.move(routeId, lineId, index)`：`line` 底下允許 `route`（domain/node.ts allowedChildKinds），
 *   整棵子樹（支線、列車、車廂、車票、車站）的 `line_id` 快取一起改；`route_id` 對路線本身不動。不新增 repository 函式、不碰 SQL。
 * - 復原＝搬回原幹線、原 position。原幹線搬走後不壓實（repository 不重編號），所以原位置空著，插回去後兄弟的相對順序不變。
 */
import { appendIndex } from "../../domain/moveTo";

/** 本模組用到的節點欄位（NodeRow 的子集，免得為了型別拉 domain/index） */
export interface RouteLike {
  id: string;
  kind: string;
  line_id: string | null;
  parent_id: string | null;
  position: number;
}

export interface MoveResult {
  ok: boolean;
  reason?: string;
}

/** 搬遷要用到的兩個口：目前的路線清單、搬一個節點（nodeStore.moveNode 或 repository 包一層） */
export interface RouteLinePorts {
  routes(): readonly RouteLike[];
  move(id: string, parentId: string, index: number): Promise<MoveResult>;
}

export type RouteMovePlan =
  | { kind: "same" }
  | { kind: "missing" }
  | { kind: "move"; index: number; back: { lineId: string; position: number } };

/** 算這一次要怎麼搬（純函式）：找不到路線／不是路線＝missing；同一條幹線＝same；其他＝新幹線的最後一位 */
export function planRouteMove(routeId: string, lineId: string, routes: readonly RouteLike[]): RouteMovePlan {
  const route = routes.find((r) => r.id === routeId);
  if (!route || route.kind !== "route" || !route.parent_id) return { kind: "missing" };
  if (route.parent_id === lineId) return { kind: "same" };
  const siblings = routes.filter((r) => r.id !== routeId && r.parent_id === lineId);
  return { kind: "move", index: appendIndex(siblings), back: { lineId: route.parent_id, position: route.position } };
}

export interface RouteMoveOutcome extends MoveResult {
  /** 搬成功才有：搬回原幹線、原位置 */
  undo?: () => Promise<MoveResult>;
  /** 這次沒有搬（同一條幹線） */
  same?: boolean;
}

/** 搬一條路線到另一條幹線；成功回帶 `undo` 的結果 */
export async function runRouteMove(ports: RouteLinePorts, routeId: string, lineId: string): Promise<RouteMoveOutcome> {
  const plan = planRouteMove(routeId, lineId, ports.routes());
  if (plan.kind === "missing") return { ok: false, reason: "找不到這條路線" };
  if (plan.kind === "same") return { ok: true, same: true };
  const r = await ports.move(routeId, lineId, plan.index);
  if (!r.ok) return r;
  const { back } = plan;
  return { ok: true, undo: () => ports.move(routeId, back.lineId, back.position) };
}
