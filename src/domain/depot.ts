/**
 * 車庫（第五本第一梯 ③；契約 `docs/research/2026-11-02-主線-車庫與回顧-契約.md` §一、§三）——純函式，零 IO。
 *
 * 到站沿用 `nodes.arrived_on`（每種節點都有、早就在同步白名單）：路線／幹線到站＝`arrived_on`＝那天＋`status='done'`，
 * 回到運行＝清回 NULL＋`'todo'`（D-主-201）。「還在跑」的口徑只有這一份（D-主-203）：
 *   - 路線＝`arrived_on` 是 NULL；
 *   - 幹線＝沒到站、**或底下還有在跑的路線**（一台把幹線收進車庫、另一台同時在底下開新路線，新路線不會消失）；
 *   - 任務在不在車庫＝它的 `route_id`（樹裡的快取、或臨時車票的路線標籤）指向已到站的路線。
 * SQLite 端用 `inDepotSql()`、記憶體與畫面用 `inDepot()`——同一句話的兩種寫法。
 */
import type { NodeRow, NodeStatus } from "./node";

/** 到站／回到運行要寫的一列（只會是 line 或 route） */
export interface ArrivalWrite {
  id: string;
  arrived_on: string | null;
  status: NodeStatus;
}

/** 一次到站／回到運行的計畫：`writes` 照寫、`undo` 是 toast「復原」要寫回去的原值 */
export interface ArrivalPlan {
  writes: ArrivalWrite[];
  undo: ArrivalWrite[];
  /** 這次一起動到的路線（幹線到站＝底下還在跑的那幾條；給確認框數沒済的票） */
  routeIds: string[];
}

type Arrivable = Pick<NodeRow, "id" | "kind" | "arrived_on" | "status" | "line_id">;

export function isLiveRoute(r: Pick<NodeRow, "arrived_on">): boolean {
  return r.arrived_on === null;
}

/** 還在跑的路線（保持原順序） */
export function liveRoutesOf<T extends Pick<NodeRow, "arrived_on">>(routes: readonly T[]): T[] {
  return routes.filter(isLiveRoute);
}

/** 還在跑的幹線＝沒到站、或底下還有在跑的路線（保持原順序） */
export function liveLinesOf<L extends Pick<NodeRow, "id" | "arrived_on">>(
  lines: readonly L[],
  routes: readonly Pick<NodeRow, "line_id" | "arrived_on">[],
): L[] {
  return lines.filter((l) => l.arrived_on === null || routes.some((r) => r.line_id === l.id && r.arrived_on === null));
}

/** 已到站路線的 id 集合 */
export function depotRouteIds(routes: readonly Pick<NodeRow, "id" | "arrived_on">[]): Set<string> {
  return new Set(routes.filter((r) => r.arrived_on !== null).map((r) => r.id));
}

/**
 * 已到站的路線不在車庫裡發券（O-3）：發券列、空狀態的新增鈕藏起來，選單裡的新增項淡掉說這句；
 * 要加先回到運行。桌機大綱、手機路線圖同一句。
 */
export const PARKED_ADD_WHY = "已收進車庫——要加先回到運行";

/** 這個節點在不在車庫（路線本身看 arrived_on；其他看 route_id 指到的路線） */
export function inDepot(node: Pick<NodeRow, "id" | "kind" | "route_id" | "arrived_on">, depotIds: ReadonlySet<string>): boolean {
  if (node.kind === "route") return node.arrived_on !== null;
  if (node.kind === "line") return false;
  return node.route_id !== null && depotIds.has(node.route_id);
}

/**
 * SQL 版：`alias.route_id` 指到已到站的路線＝在車庫。用法 `AND NOT ${inDepotSql("r")}`。
 * route_id 是 NULL（收件匣、沒掛標籤的臨時票）＝不在車庫。
 */
export function inDepotSql(alias: string): string {
  return `(${alias}.route_id IS NOT NULL AND ${alias}.route_id IN (SELECT id FROM nodes WHERE kind = 'route' AND arrived_on IS NOT NULL))`;
}

const snap = (n: Arrivable): ArrivalWrite => ({ id: n.id, arrived_on: n.arrived_on, status: n.status });

/**
 * 到站（D-主-201／202）。路線＝那一條；幹線＝幹線＋底下還在跑的路線同一天。已經到站的什麼都不寫。
 */
export function planArrival(
  targetId: string,
  lines: readonly Arrivable[],
  routes: readonly Arrivable[],
  day: string,
): ArrivalPlan {
  const target = [...lines, ...routes].find((n) => n.id === targetId);
  const empty: ArrivalPlan = { writes: [], undo: [], routeIds: [] };
  if (!target) return empty;
  if (target.kind === "route") {
    if (target.arrived_on !== null) return empty;
    return { writes: [{ id: target.id, arrived_on: day, status: "done" }], undo: [snap(target)], routeIds: [target.id] };
  }
  if (target.kind !== "line") return empty;
  const live = routes.filter((r) => r.line_id === target.id && r.arrived_on === null);
  const all = target.arrived_on === null ? [target, ...live] : live;
  if (!all.length) return empty;
  return {
    writes: all.map((n) => ({ id: n.id, arrived_on: day, status: "done" as const })),
    undo: all.map(snap),
    routeIds: live.map((r) => r.id),
  };
}

/**
 * 回到運行（D-主-202）。路線＝那一條（它的幹線已到站＝幹線也回來，其他路線留在車庫）；
 * 幹線＝幹線＋跟它同一天到站的路線。
 */
export function planDeparture(targetId: string, lines: readonly Arrivable[], routes: readonly Arrivable[]): ArrivalPlan {
  const target = [...lines, ...routes].find((n) => n.id === targetId);
  const empty: ArrivalPlan = { writes: [], undo: [], routeIds: [] };
  if (!target || target.arrived_on === null) return empty;
  const back = (n: Arrivable): ArrivalWrite => ({ id: n.id, arrived_on: null, status: "todo" });
  if (target.kind === "route") {
    const line = lines.find((l) => l.id === target.line_id && l.arrived_on !== null);
    const all = line ? [target, line] : [target];
    return { writes: all.map(back), undo: all.map(snap), routeIds: [target.id] };
  }
  if (target.kind !== "line") return empty;
  const together = routes.filter((r) => r.line_id === target.id && r.arrived_on === target.arrived_on);
  const all = [target, ...together];
  return { writes: all.map(back), undo: all.map(snap), routeIds: together.map((r) => r.id) };
}

/* ───────── 書架（D-主-217） ───────── */

export type ShelfItem =
  | { type: "book"; route: NodeRow }
  | { type: "group"; line: NodeRow; routes: NodeRow[] };

/**
 * 書架：到站的路線依到站日排（舊的在左、新的在右）；已到站幹線底下的路線夾成一組，組的位置＝幹線到站日。
 * 同一天依原順序（側欄序）。
 */
export function buildShelf(lines: readonly NodeRow[], routes: readonly NodeRow[]): ShelfItem[] {
  const arrived = routes.filter((r) => r.arrived_on !== null);
  const arrivedLines = new Map(lines.filter((l) => l.arrived_on !== null).map((l) => [l.id, l] as const));
  const groups = new Map<string, NodeRow[]>();
  const singles: NodeRow[] = [];
  for (const r of arrived) {
    if (r.line_id && arrivedLines.has(r.line_id)) (groups.get(r.line_id) ?? groups.set(r.line_id, []).get(r.line_id)!).push(r);
    else singles.push(r);
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const items: { day: string; idx: number; item: ShelfItem }[] = [];
  singles.forEach((r) => items.push({ day: r.arrived_on!, idx: routes.indexOf(r), item: { type: "book", route: r } }));
  for (const [lineId, rs] of groups) {
    const line = arrivedLines.get(lineId)!;
    const sorted = [...rs].sort((a, b) => order(a.arrived_on!, b.arrived_on!) || routes.indexOf(a) - routes.indexOf(b));
    items.push({ day: line.arrived_on!, idx: lines.indexOf(line), item: { type: "group", line, routes: sorted } });
  }
  return items.sort((a, b) => order(a.day, b.day) || a.idx - b.idx).map((x) => x.item);
}

/* ───────── 日期小工具 ───────── */

/** "YYYY-MM-DD" → "M.D"（書背、印譜帳的日期寫法） */
export function fmtMD(day: string | null): string {
  if (!day) return "";
  const [, m, d] = day.split("-").map(Number);
  return `${m}.${d}`;
}

/** "YYYY-MM-DD" → "M月D日" */
export function fmtZhMD(day: string | null): string {
  if (!day) return "";
  const [, m, d] = day.split("-").map(Number);
  return `${m}月${d}日`;
}

/** "YYYY-MM-DD" → "YYYY-MM" */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}
