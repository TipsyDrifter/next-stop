/**
 * timeGridModel——時段視圖的版面模型（主線階段②；契約 §3.8）。桌機「週・時段」與手機「3 天時段」共用。
 *
 * 一天的軸：`axisMin = dayStartHour*60`、`axisMax = axisMin + 1440`（自 00:00 起的牆鐘分鐘，可 ≥ 1440）。
 * 有時刻且落在軸內的票 ⇒ `blocks`（畫在幾點、用預計時間畫長度，重疊的並排成 lane）；
 * 沒時刻的、以及軸外的（改日界線前存的 03:30／29:30，契約 §0-1 第 4 條）⇒ `untimed`（欄頂「未定時」帶）。
 *
 * 純函式、不改輸入。**只准 `import type` ＋ 帶副檔名的 lib import**（`node --test` 直接載；同 streamModel.ts）。
 */
import type { DueEntry, ScheduleEntry } from "../../data/nodeRepository";
import type { NodeRow } from "../../domain";
import { clockMinutes } from "../../lib/date.ts";

/** 沒填預計的塊當多長畫（D-主-15）；lane 排列時也用它 */
export const NO_ESTIMATE_MIN = 45;
/** lane 排列的最小長度（原型 :1074 Math.max(est || 45, 15)）；畫的最小高度另在 CSS */
export const LANE_MIN_MIN = 15;

export interface TimeGridBlock {
  key: string; // `${date}-${node_id}`（＝dayRowModel.key）
  entry: ScheduleEntry;
  /** 自這一天 00:00 起的牆鐘分鐘（"25:30" ⇒ 1530）；軸以 dayStartHour*60 為 0 點，畫的人減掉 */
  startMin: number;
  /** startMin + (noEstimate ? NO_ESTIMATE_MIN : estimate_min)，再裁到 axisMax */
  endMin: number;
  /** !(estimate_min > 0)（estimate 0 也算沒填） */
  noEstimate: boolean;
  /** 原本的 end 超過 axisMax、被裁掉（塊右下「續→」） */
  contToNext: boolean;
  /** 重疊時的並排欄位：依 startMin → endMin 遞減 → key 掃，cluster 內放進第一個「end ≤ start」的 lane；lane 計算用 max(長度, LANE_MIN_MIN) */
  lane: number;
  lanes: number;
}
export interface TimeGridUntimed {
  entry: ScheduleEntry;
  /** 有時刻但落在軸外（改日界線前存的 03:30／29:30）；UI 籤上加註「軸外 03:30」 */
  outOfAxis: boolean;
}
export interface TimeGridDay {
  date: string;
  /** 有時刻且在軸內，依 startMin → key */
  blocks: TimeGridBlock[];
  /** 沒時刻的（順序＝entries 既有順序）＋軸外的（排在後面） */
  untimed: TimeGridUntimed[];
  dues: DueEntry[];
}
export interface TimeGridInput {
  days: readonly string[];
  /** calendar.entries（已含 time） */
  entries: readonly ScheduleEntry[];
  dues: readonly DueEntry[];
  /** 取 estimate_min */
  nodes: Record<string, NodeRow>;
  dayStartHour: number;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 一天的 blocks 做 lane 排列（原型 :1073-1085 layoutDay）；就地寫 lane／lanes */
function assignLanes(blocks: TimeGridBlock[], laneEndOf: Map<string, number>): void {
  const order = [...blocks].sort(
    (a, b) =>
      a.startMin - b.startMin ||
      (laneEndOf.get(b.key) ?? 0) - (laneEndOf.get(a.key) ?? 0) ||
      cmpStr(a.key, b.key),
  );
  let cluster: TimeGridBlock[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = cluster.reduce((m, x) => Math.max(m, x.lane + 1), 1);
    for (const x of cluster) x.lanes = lanes;
    cluster = [];
  };
  for (const x of order) {
    if (cluster.length && x.startMin >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    const used = new Set(cluster.filter((c) => (laneEndOf.get(c.key) ?? 0) > x.startMin).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    x.lane = lane;
    cluster.push(x);
    clusterEnd = Math.max(clusterEnd, laneEndOf.get(x.key) ?? 0);
  }
  if (cluster.length) flush();
}

export function timeGridModel(input: TimeGridInput): TimeGridDay[] {
  const { days, entries, dues, nodes, dayStartHour } = input;
  const axisMin = dayStartHour * 60;
  const axisMax = axisMin + 1440;

  const byDate = new Map<string, TimeGridDay>();
  for (const date of days) byDate.set(date, { date, blocks: [], untimed: [], dues: [] });
  const outOfAxis = new Map<string, TimeGridUntimed[]>();

  for (const e of entries) {
    const day = byDate.get(e.date);
    if (!day) continue;
    const startMin = e.time ? clockMinutes(e.time) : null;
    if (startMin === null) {
      day.untimed.push({ entry: e, outOfAxis: false });
      continue;
    }
    if (startMin < axisMin || startMin >= axisMax) {
      const list = outOfAxis.get(e.date) ?? [];
      list.push({ entry: e, outOfAxis: true });
      outOfAxis.set(e.date, list);
      continue;
    }
    const est = nodes[e.node_id]?.estimate_min ?? null;
    const noEstimate = !(typeof est === "number" && est > 0);
    const len = noEstimate ? NO_ESTIMATE_MIN : (est as number);
    day.blocks.push({
      key: `${e.date}-${e.node_id}`,
      entry: e,
      startMin,
      endMin: Math.min(startMin + len, axisMax),
      noEstimate,
      contToNext: startMin + len > axisMax,
      lane: 0,
      lanes: 1,
    });
  }

  for (const d of dues) byDate.get(d.date)?.dues.push(d);

  const out: TimeGridDay[] = [];
  for (const date of days) {
    const day = byDate.get(date) as TimeGridDay;
    // lane 的長度口徑：沒填預計當 45 分、再保底 15 分；不裁軸尾（裁掉的部分仍佔著位子）
    const laneEndOf = new Map<string, number>();
    for (const b of day.blocks) {
      const est = nodes[b.entry.node_id]?.estimate_min ?? null;
      const len = b.noEstimate ? NO_ESTIMATE_MIN : (est as number);
      laneEndOf.set(b.key, b.startMin + Math.max(len, LANE_MIN_MIN));
    }
    assignLanes(day.blocks, laneEndOf);
    day.blocks.sort((a, b) => a.startMin - b.startMin || cmpStr(a.key, b.key));
    day.untimed.push(...(outOfAxis.get(date) ?? []));
    out.push(day);
  }
  return out;
}

/** 軸刻度：h = dayStartHour … dayStartHour+24（25 個；第一個不印、最後一個是底線）；label＝"HH:00"；h ≥ 24 加 night: true、sub＝h===24 ? "深夜 0 時" : `${h-24} 時` */
export function hourTicks(dayStartHour: number): { h: number; min: number; label: string; night: boolean; sub: string | null }[] {
  const out: { h: number; min: number; label: string; night: boolean; sub: string | null }[] = [];
  for (let h = dayStartHour; h <= dayStartHour + 24; h++) {
    const night = h >= 24;
    out.push({
      h,
      min: h * 60,
      label: `${h < 10 ? "0" : ""}${h}:00`,
      night,
      sub: night ? (h === 24 ? "深夜 0 時" : `${h - 24} 時`) : null,
    });
  }
  return out;
}
