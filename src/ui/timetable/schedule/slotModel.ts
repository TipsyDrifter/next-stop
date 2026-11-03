/**
 * 時刻表⑦（D-時-162）：日程上車票的第二段起——純函式（從 `timetableScheduleStore` 抽出來，整合席；node 測試直接載）。
 *   - `slotItemsOf`：那一天的 time_plans 車票段 → SlotItem（key `${date}-${nodeId}-seg-${planId}`；票刪了不畫、蓋済＝段也済）
 *   - `schedBlocksOf`：第一段（timeGridModel 的 blocks）＋第二段起，一起排 lane（同 timeGridModel.assignLanes 的掃法）
 *   - `segmentSpansOf`：同一天有好幾段的票，連到它的塊分給各段（`assignSpansToSegments`）
 */
import type { NodeRow } from "../../../domain/node";
import type { LinkedSpan, PlanItem } from "../../../domain/timetableSchedule";
import { assignSpansToSegments, type TicketSegment, type TimePlanRow } from "../../../domain/timetableRoutine.ts";
import { clockInstant, clockMinutes, type ClockText } from "../../../lib/date.ts";
import { LANE_MIN_MIN, NO_ESTIMATE_MIN, type TimeGridDay } from "../../schedule/timeGridModel.ts";

/**
 * 車票的第二段起（time_plans 一列）畫在預定欄上的那一張——長相同第一段，所以借 PlanItem 的形狀：
 * time＝開始、estimateMin＝這一段的長度（分）、done＝票蓋済（D-時-162「票蓋済＝各段也済」）。
 */
export interface SlotItem extends PlanItem {
  planId: string;
  end: ClockText;
}

/** 預定欄的一張卡（第一段＝timeGridModel 的 block、第二段起＝SlotItem）——兩種一起排 lane（契約 §4「同一套 lane」） */
export interface SchedBlock {
  key: string;
  nodeId: string;
  /** 第二段起＝time_plans 的 id；第一段＝null */
  slotId: string | null;
  startMin: number;
  endMin: number;
  noEstimate: boolean;
  lane: number;
  lanes: number;
}

export const slotKeyOf = (date: string, nodeId: string, planId: string): string => `${date}-${nodeId}-seg-${planId}`;

/** 那一天的 time_plans 車票段 → SlotItem（票刪了＝nodes 裡沒有 ⇒ 不畫；票蓋済＝段也済） */
export function slotItemsOf(
  date: string,
  rows: readonly TimePlanRow[],
  nodes: Readonly<Record<string, NodeRow>>,
  items: Readonly<Record<string, PlanItem>>,
): Record<string, SlotItem> {
  const out: Record<string, SlotItem> = {};
  for (const r of rows) {
    const nodeId = r.node_id;
    if (nodeId === null || r.deleted_at !== null) continue;
    const n = nodes[nodeId];
    if (!n || n.deleted_at !== null) continue;
    const s = clockMinutes(r.start_hm);
    const e = clockMinutes(r.end_hm);
    if (s === null || e === null || e <= s) continue;
    const main = items[`${date}-${nodeId}`];
    const key = slotKeyOf(date, nodeId, r.id);
    out[key] = {
      key,
      nodeId,
      date,
      kind: "single",
      time: r.start_hm,
      overridden: false,
      estimateMin: e - s,
      done: main ? main.done : n.status === "done",
      skipped: false,
      lateFrom: null,
      carriedFrom: null,
      planId: r.id,
      end: r.end_hm,
    };
  }
  return out;
}

/**
 * 預定欄的卡：第一段（timeGridModel 的 blocks）＋第二段起，一起重排 lane（同 timeGridModel.assignLanes 的掃法：
 * 依開始 → lane 尾遞減 → key；cluster 內放第一個空出來的 lane；lane 的長度保底 LANE_MIN_MIN）。軸外的段不畫（側板照列）。
 */
export function schedBlocksOf(grid: TimeGridDay | null, slots: Readonly<Record<string, SlotItem>>, h: number): SchedBlock[] {
  const axisMin = h * 60;
  const axisMax = axisMin + 1440;
  const out: SchedBlock[] = (grid?.blocks ?? []).map((b) => ({
    key: b.key,
    nodeId: b.entry.node_id,
    slotId: null,
    startMin: b.startMin,
    endMin: b.endMin,
    noEstimate: b.noEstimate,
    lane: 0,
    lanes: 1,
  }));
  const laneEnd = new Map<string, number>();
  for (const b of grid?.blocks ?? []) laneEnd.set(b.key, b.startMin + Math.max(b.noEstimate ? NO_ESTIMATE_MIN : b.endMin - b.startMin, LANE_MIN_MIN));
  for (const it of Object.values(slots)) {
    const s = clockMinutes(it.time as ClockText);
    if (s === null || s < axisMin || s >= axisMax) continue;
    const len = it.estimateMin ?? NO_ESTIMATE_MIN;
    out.push({ key: it.key, nodeId: it.nodeId, slotId: it.planId, startMin: s, endMin: Math.min(s + len, axisMax), noEstimate: false, lane: 0, lanes: 1 });
    laneEnd.set(it.key, s + Math.max(len, LANE_MIN_MIN));
  }
  const cmpKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const order = [...out].sort((a, b) => a.startMin - b.startMin || (laneEnd.get(b.key) ?? 0) - (laneEnd.get(a.key) ?? 0) || cmpKey(a.key, b.key));
  let cluster: SchedBlock[] = [];
  let clusterEnd = -Infinity;
  const flush = (): void => {
    const lanes = cluster.reduce((m, x) => Math.max(m, x.lane + 1), 1);
    for (const x of cluster) x.lanes = lanes;
    cluster = [];
  };
  for (const x of order) {
    if (cluster.length && x.startMin >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    const used = new Set(cluster.filter((c) => (laneEnd.get(c.key) ?? 0) > x.startMin).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    x.lane = lane;
    cluster.push(x);
    clusterEnd = Math.max(clusterEnd, laneEnd.get(x.key) ?? 0);
  }
  if (cluster.length) flush();
  return out.sort((a, b) => a.startMin - b.startMin || cmpKey(a.key, b.key));
}

/**
 * 同一天有好幾段的票，連到它的塊分給各段（`assignSpansToSegments`）；回 預定項／段的 key → 它那一份 spans。
 * 只有一段的票不在表裡（照舊吃整天連到它的塊）。第一段的長度＝預計（沒填 45 分，同畫卡）。
 */
export function segmentSpansOf(
  items: readonly PlanItem[],
  slots: readonly SlotItem[],
  spans: readonly LinkedSpan[],
  now: number,
): Map<string, LinkedSpan[]> {
  const byNode = new Map<string, TicketSegment[]>();
  const add = (nodeId: string, seg: TicketSegment): void => {
    const list = byNode.get(nodeId) ?? [];
    list.push(seg);
    byNode.set(nodeId, list);
  };
  for (const it of [...items, ...slots]) {
    if (it.time === null || it.lateFrom || it.skipped) continue;
    const start = clockInstant(it.date, it.time);
    if (start === null) continue;
    add(it.nodeId, { key: it.key, start, end: start + (it.estimateMin ?? NO_ESTIMATE_MIN) * 60_000 });
  }
  const out = new Map<string, LinkedSpan[]>();
  for (const [nodeId, segs] of byNode) {
    if (segs.length < 2) continue;
    const mine = spans.filter((s) => s.nodeId === nodeId);
    const byId = new Map(mine.map((s) => [s.id, s]));
    const assigned = assignSpansToSegments(mine, segs, now);
    for (const g of segs) out.set(g.key, (assigned[g.key] ?? []).map((id) => byId.get(id)).filter((x): x is LinkedSpan => !!x));
  }
  return out;
}
