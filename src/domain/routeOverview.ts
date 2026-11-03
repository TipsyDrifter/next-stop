/**
 * 路線一覽（丁 D-主-240／241）：一次算完所有路線卡片的數字。桌機「路線一覽」卡片與手機路線圖第一層的那一行同一支。
 *
 * 每條路線：
 *   - 車票 d/t 済：同大綱頁首（`routeHead.ts`）——只數 kind==='ticket'（含掛這條路線標籤的臨時車票），済由呼叫端的 `isDone` 判
 *     （活著的定期券看目前班次）。
 *   - 近 30 天時間：連到這條路線的時間塊（塊直接連路線，或連到這條路線樹裡的節點）在窗內的聯集長度（`unionMs`，重疊不重複計；
 *     運行中算到 now）——同時刻表側板「時間」列路線那一份的算法，只是期間換成近 30 天。
 *   - 近 30 天花費：直掛這條路線的支出（主幣別最小單位，`main_minor` 加總）——同售票口 `routeSpend` 的口徑。
 *   - 誤點：今日切片裡還沒交代的誤點（`dayCount.lateCount`，今日頁同一把尺）。
 *   - 下一站：還沒到站的第一個車站（兄弟順序）；車站進度＝到站數÷車站數（③ 統一的紀念章口徑）。
 * 期間＝依日界線的今天往前 29 天（共 30 天）到現在（呼叫端給窗）。月初「本月」幾乎都是 0，所以不用本月（丙定案）。
 *
 * 純函式、不碰 store；import 一律帶 `.ts`（scripts/tests 直接載入）。
 */
import { lateCount, type LateCountRow } from "./dayCount.ts";
import { compareSiblings } from "./nodeOrder.ts";
import { unionMs } from "./timetableLink.ts";

/** 路線樹裡一個節點的最小形狀（`nodeRepo.listRouteMembers()` 回的） */
export interface RouteMember {
  id: string;
  kind: string;
  status: string;
  route_id: string | null;
}

/** 車站（sidebar 的 stations 直接吃得進來） */
export interface OverviewStation {
  id: string;
  parent_id: string | null;
  name: string;
  arrived_on: string | null;
  expected_on: string | null;
  position: number;
  sort_key: string | null;
  created_at: string;
}

/** 時間塊的連結＋區間（`toLinkedSpan` 的輸出直接吃得進來） */
export interface OverviewSpan {
  start: number;
  end: number | null;
  nodeId: string | null;
  routeId: string | null;
}

export interface OverviewSpend {
  route_id: string | null;
  main_minor: number;
}

export interface RouteSummary {
  ticketDone: number;
  ticketTotal: number;
  /** 近 30 天時間（毫秒） */
  timeMs: number;
  /** 近 30 天花費（主幣別最小單位） */
  spendMinor: number;
  /** 還沒交代的誤點 */
  late: number;
  nextStation: { name: string; expectedOn: string | null } | null;
  stationsArrived: number;
  stationsTotal: number;
}

export interface OverviewInput {
  routeIds: readonly string[];
  members: readonly RouteMember[];
  isDone: (m: RouteMember) => boolean;
  stations: readonly OverviewStation[];
  spans: readonly OverviewSpan[];
  spend: readonly OverviewSpend[];
  todayRows: readonly (LateCountRow & { route_id: string | null })[];
  today: string;
  window: { start: number; end: number };
  now: number;
}

export interface OverviewResult {
  byRoute: Record<string, RouteSummary>;
  /** 全部路線加總（頁首那一句「近 30 天 6h50m・花 4,357」）；時間是各路線聯集的和（不同路線的塊不會是同一塊） */
  totalTimeMs: number;
  totalSpendMinor: number;
}

export const EMPTY_SUMMARY: RouteSummary = {
  ticketDone: 0,
  ticketTotal: 0,
  timeMs: 0,
  spendMinor: 0,
  late: 0,
  nextStation: null,
  stationsArrived: 0,
  stationsTotal: 0,
};

export function buildRouteOverview(input: OverviewInput): OverviewResult {
  const byRoute: Record<string, RouteSummary> = {};
  const wanted = new Set(input.routeIds);
  for (const id of input.routeIds) byRoute[id] = { ...EMPTY_SUMMARY };

  // 節點 → 所屬路線（時間塊連到節點時用）；車票數
  const routeOf = new Map<string, string>();
  for (const m of input.members) {
    if (m.route_id === null) continue;
    routeOf.set(m.id, m.route_id);
    const s = byRoute[m.route_id];
    if (!s || m.kind !== "ticket") continue;
    s.ticketTotal++;
    if (input.isDone(m)) s.ticketDone++;
  }

  // 時間：各路線自己的區間聯集
  const spansBy = new Map<string, OverviewSpan[]>();
  for (const sp of input.spans) {
    const rid = sp.routeId ?? (sp.nodeId === null ? null : (routeOf.get(sp.nodeId) ?? (wanted.has(sp.nodeId) ? sp.nodeId : null)));
    if (rid === null || !wanted.has(rid)) continue;
    const list = spansBy.get(rid);
    if (list) list.push(sp);
    else spansBy.set(rid, [sp]);
  }
  let totalTimeMs = 0;
  for (const [rid, list] of spansBy) {
    const ms = unionMs(list, input.now, input.window);
    byRoute[rid].timeMs = ms;
    totalTimeMs += ms;
  }

  // 花費
  let totalSpendMinor = 0;
  for (const e of input.spend) {
    if (e.route_id === null || !wanted.has(e.route_id)) continue;
    byRoute[e.route_id].spendMinor += e.main_minor;
    totalSpendMinor += e.main_minor;
  }

  // 誤點（今日切片，按路線分組再數）
  const lateRows = new Map<string, (LateCountRow & { route_id: string | null })[]>();
  for (const r of input.todayRows) {
    if (r.route_id === null || !wanted.has(r.route_id)) continue;
    const list = lateRows.get(r.route_id);
    if (list) list.push(r);
    else lateRows.set(r.route_id, [r]);
  }
  for (const [rid, rows] of lateRows) byRoute[rid].late = lateCount(rows, input.today).count;

  // 車站：下一站＋進度
  const stationsBy = new Map<string, OverviewStation[]>();
  for (const st of input.stations) {
    if (st.parent_id === null || !wanted.has(st.parent_id)) continue;
    const list = stationsBy.get(st.parent_id);
    if (list) list.push(st);
    else stationsBy.set(st.parent_id, [st]);
  }
  for (const [rid, list] of stationsBy) {
    const s = byRoute[rid];
    s.stationsTotal = list.length;
    s.stationsArrived = list.filter((x) => x.arrived_on !== null).length;
    const next = list.filter((x) => x.arrived_on === null).sort(compareSiblings)[0];
    s.nextStation = next ? { name: next.name, expectedOn: next.expected_on } : null;
  }

  return { byRoute, totalTimeMs, totalSpendMinor };
}
