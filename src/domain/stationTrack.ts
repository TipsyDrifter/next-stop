/**
 * 路線主畫面「站點軌道條」與單站篩選（回饋專卷 第三梯 3A）。
 *
 * 純函式、不碰 store／DOM；import 一律帶 `.ts`（scripts/tests 直接載入）。
 */
import { NO_STATION_COL, effectiveStation, type StationParentNode } from "./board.ts";
import type { NodeKind, NodeRow, NodeStatus } from "./node.ts";
import { compareSiblings } from "./nodeOrder.ts";
import { isTaskDone, type OccurrenceLike } from "./taskFilter.ts";

export interface StationTrackStation {
  id: string;
  parent_id: string | null;
  name: string;
  arrived_on: string | null;
  expected_on: string | null;
  position?: number;
  sort_key?: string | null;
  created_at?: string;
  deleted_at?: string | null;
}

export interface StationTrackNode extends StationParentNode {
  kind: NodeKind;
  status: NodeStatus;
}

export interface StationTrackStop<S extends StationTrackStation = StationTrackStation> {
  station: S;
  ticketDone: number;
  ticketTotal: number;
  /** 0–100 整數；ticketTotal === 0 時為 0 */
  ticketPct: number;
  isArrived: boolean;
  isNext: boolean;
}

export interface StationTrackResult<S extends StationTrackStation = StationTrackStation> {
  stops: StationTrackStop<S>[];
  unassignedDone: number;
  unassignedTotal: number;
}

export interface BuildStationTrackOptions<
  S extends StationTrackStation = StationTrackStation,
  N extends StationTrackNode = StationTrackNode,
> {
  routeId: string;
  stations: readonly S[];
  /** 此路線相關節點（可傳全站 nodes 陣列或路線子樹＋根層臨時票；函式內會依 route_id 過濾） */
  nodes: readonly N[];
  /** 供 `effectiveStation` 沿 `parent_id` 向上繼承；省略時以 `nodes` 建立索引 */
  byId?: Readonly<Record<string, StationParentNode>> | ReadonlyMap<string, StationParentNode>;
  occurrences?: Readonly<Record<string, OccurrenceLike | undefined>>;
  isDone?: (node: N) => boolean;
  /** 路線本身是否已收進車庫（`arrived_on != null` 時全站皆不標為下一站） */
  routeArrived?: boolean;
}

function sortTrackStations<S extends StationTrackStation>(stations: readonly S[], routeId: string): S[] {
  return stations
    .filter((s) => s.parent_id === routeId && (s.deleted_at === undefined || s.deleted_at === null))
    .slice()
    .sort((a, b) =>
      compareSiblings(
        { id: a.id, position: a.position ?? 0, sort_key: a.sort_key ?? null, created_at: a.created_at ?? "" },
        { id: b.id, position: b.position ?? 0, sort_key: b.sort_key ?? null, created_at: b.created_at ?? "" },
      ),
    );
}

/** 計算路線各站軌道進度（含經祖先鏈繼承歸屬該站的未封存車票 `done/total`）與未排站車票數 */
export function buildStationTrack<
  S extends StationTrackStation = StationTrackStation,
  N extends StationTrackNode = StationTrackNode,
>(opts: BuildStationTrackOptions<S, N>): StationTrackResult<S> {
  const ordered = sortTrackStations(opts.stations, opts.routeId);
  const nextId = opts.routeArrived ? null : (ordered.find((s) => s.arrived_on === null)?.id ?? null);

  const stationMap = new Map(ordered.map((s) => [s.id, s]));
  const byId = opts.byId ?? Object.fromEntries(opts.nodes.map((n) => [n.id, n]));
  const counts = new Map<string, { done: number; total: number }>(ordered.map((s) => [s.id, { done: 0, total: 0 }]));
  let unassignedDone = 0;
  let unassignedTotal = 0;

  for (const n of opts.nodes) {
    if (n.deleted_at !== undefined && n.deleted_at !== null) continue;
    if (n.route_id !== opts.routeId || n.kind !== "ticket") continue;
    const done = opts.isDone ? opts.isDone(n) : isTaskDone(n, opts.occurrences?.[n.id]);
    if (n.status === "paused" && !done) continue;
    const stId = effectiveStation(n, stationMap, byId);
    const bucket = stId ? counts.get(stId) : undefined;
    if (bucket) {
      bucket.total++;
      if (done) bucket.done++;
    } else {
      unassignedTotal++;
      if (done) unassignedDone++;
    }
  }

  const stops: StationTrackStop<S>[] = ordered.map((station) => {
    const c = counts.get(station.id)!;
    return {
      station,
      ticketDone: c.done,
      ticketTotal: c.total,
      ticketPct: c.total > 0 ? Math.round((c.done / c.total) * 100) : 0,
      isArrived: station.arrived_on !== null,
      isNext: station.id === nextId,
    };
  });

  return { stops, unassignedDone, unassignedTotal };
}

/**
 * 單站篩選判定（供大綱與看板點擊站點時單篩該站子樹與繼承項）：
 * - `filterStationId === null`：未開啟篩選，回傳 `true`
 * - `filterStationId === NO_STATION_COL`（`"$none"`）：篩選「還沒排站」（有效車站為 `null`）
 * - 其餘站 id：節點自身或繼承有效車站符合，或底下任一子孫節點符合（保留大綱祖先路徑）
 */
export function matchesStationFilter<
  N extends Pick<NodeRow, "id" | "kind" | "parent_id" | "name" | "station_id" | "route_id"> &
    Partial<Pick<NodeRow, "deleted_at">>,
  S extends Pick<NodeRow, "id" | "parent_id"> & Partial<Pick<NodeRow, "deleted_at">>,
>(
  nodeId: string,
  filterStationId: string | null,
  tree: {
    byId: Readonly<Record<string, N>>;
    childrenOf: Readonly<Record<string, readonly string[] | undefined>>;
  },
  stations: readonly S[] | ReadonlyMap<string, S>,
): boolean {
  if (filterStationId === null) return true;
  const root = tree.byId[nodeId];
  if (!root || (root.deleted_at !== undefined && root.deleted_at !== null)) return false;

  const stationMap: ReadonlyMap<string, S> = Array.isArray(stations)
    ? new Map((stations as readonly S[]).map((s) => [s.id, s]))
    : (stations as ReadonlyMap<string, S>);
  const target = filterStationId === NO_STATION_COL ? null : filterStationId;

  const selfMatches = (n: N): boolean => {
    if (n.kind === "station") return target !== null && n.id === target;
    if (n.kind === "line" || n.kind === "route") return false;
    return effectiveStation(n, stationMap, tree.byId) === target;
  };

  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const n = tree.byId[id];
    if (!n || (n.deleted_at !== undefined && n.deleted_at !== null)) return false;
    if (selfMatches(n)) return true;
    for (const childId of tree.childrenOf[id] ?? []) {
      if (visit(childId)) return true;
    }
    return false;
  };

  return visit(nodeId);
}
