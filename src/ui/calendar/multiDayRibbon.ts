/**
 * multiDayRibbon——月視圖與 2×4 週見開き共用之「多日乘車日色帶」純排版運算（v1.37 2A-2 / 2A-3）。
 *
 * 規格：
 *   - 僅為 `isMultiDayTicket(node)`（有跨日閉區間且 `is_multi_day === 1`）繪製連續橫跨色帶。
 *   - 期間自由券（`isFlexibleRangeTicket`）不參與色帶排版。
 *   - 支援任意欄數的列（月視圖 7 欄、週視圖上排 4 欄／下排 3 欄），自動依不重疊原則配置車道（lane）。
 *   - 跨週或跨排時標註 `continuesLeft` / `continuesRight`，供 UI 畫出圓角／斷接邊緣。
 *   - 純函式、零 React／Store／DOM 依賴，可直接由 `node --test` 執行單測。
 */
import type { NodeRow } from "../../domain/node";
import { isMultiDayTicket } from "../../domain/dateRange.ts";
import { formatDurationShort } from "../../domain/duration.ts";

export interface RibbonSegment {
  nodeId: string;
  node: NodeRow;
  /** 0-based 起始欄索引（含） */
  startCol: number;
  /** 橫跨欄數（>= 1） */
  span: number;
  /** 0-based 垂直車道索引（同列不重疊） */
  lane: number;
  /** 此多日行程在這一列左緣之前就已開始（跨週／跨排延續） */
  continuesLeft: boolean;
  /** 此多日行程在這一列右緣之後仍未結束（跨週／跨排延續） */
  continuesRight: boolean;
  /** 此段在這一列中涵蓋的第一天 YYYY-MM-DD */
  firstDay: string;
  /** 此段在這一列中涵蓋的最後一天 YYYY-MM-DD */
  lastDay: string;
  done: boolean;
  paused: boolean;
  late: boolean;
}

export interface RibbonRowLayout {
  segments: RibbonSegment[];
  laneCount: number;
  /** 本列已由色帶呈現的多日票 node_id 集合（單日格內清單用來去重） */
  coveredNodeIds: ReadonlySet<string>;
}

export interface LayoutRibbonOptions {
  /** 可見／有效區間起日（月視圖＝本月 1 日，用來裁切 `.is-out` 格） */
  rangeFrom?: string;
  /** 可見／有效區間訖日（月視圖＝本月底，用來裁切 `.is-out` 格） */
  rangeTo?: string;
}

/**
 * 計算單列（例如月視圖一週 7 天、週視圖上排 4 天或下排 3 天）的多日乘車日色帶配置。
 */
export function layoutMultiDayRibbons(
  rowDays: readonly string[],
  nodes: readonly NodeRow[],
  today: string,
  opts: LayoutRibbonOptions = {},
): RibbonRowLayout {
  if (rowDays.length === 0) {
    return { segments: [], laneCount: 0, coveredNodeIds: new Set() };
  }

  const { rangeFrom, rangeTo } = opts;
  const validCols: number[] = [];
  for (let i = 0; i < rowDays.length; i++) {
    const d = rowDays[i];
    if (rangeFrom && d < rangeFrom) continue;
    if (rangeTo && d > rangeTo) continue;
    validCols.push(i);
  }

  if (validCols.length === 0) {
    return { segments: [], laneCount: 0, coveredNodeIds: new Set() };
  }

  const minDay = rowDays[validCols[0]];
  const maxDay = rowDays[validCols[validCols.length - 1]];

  const candidates: Array<{
    node: NodeRow;
    startCol: number;
    endCol: number;
    firstDay: string;
    lastDay: string;
  }> = [];

  for (const node of nodes) {
    if (node.deleted_at !== null) continue;
    if (!isMultiDayTicket(node)) continue;
    const s = node.scheduled_on!;
    const e = node.scheduled_end!;
    if (e < minDay || s > maxDay) continue;

    let startCol = -1;
    let endCol = -1;
    for (const col of validCols) {
      const d = rowDays[col];
      if (d >= s && d <= e) {
        if (startCol === -1) startCol = col;
        endCol = col;
      }
    }
    if (startCol === -1 || endCol === -1) continue;

    candidates.push({
      node,
      startCol,
      endCol,
      firstDay: rowDays[startCol],
      lastDay: rowDays[endCol],
    });
  }

  if (candidates.length === 0) {
    return { segments: [], laneCount: 0, coveredNodeIds: new Set() };
  }

  // 穩定排序：較早開始者優先（跨週能穩居同一車道）→ 總跨距較長者居上 → 建立時間 → id
  candidates.sort((a, b) => {
    const sa = a.node.scheduled_on!;
    const sb = b.node.scheduled_on!;
    if (sa !== sb) return sa.localeCompare(sb);
    const ea = a.node.scheduled_end!;
    const eb = b.node.scheduled_end!;
    if (ea !== eb) return eb.localeCompare(ea);
    if (a.node.created_at !== b.node.created_at) return a.node.created_at.localeCompare(b.node.created_at);
    return a.node.id.localeCompare(b.node.id);
  });

  const laneEndCol: number[] = [];
  const segments: RibbonSegment[] = [];
  const covered = new Set<string>();

  for (const cand of candidates) {
    let lane = laneEndCol.findIndex((last) => last < cand.startCol);
    if (lane === -1) {
      lane = laneEndCol.length;
      laneEndCol.push(cand.endCol);
    } else {
      laneEndCol[lane] = cand.endCol;
    }

    const n = cand.node;
    const done = n.status === "done";
    const paused = n.status === "paused";
    const late = !done && !paused && n.scheduled_end! < today;

    segments.push({
      nodeId: n.id,
      node: n,
      startCol: cand.startCol,
      span: cand.endCol - cand.startCol + 1,
      lane,
      continuesLeft: n.scheduled_on! < cand.firstDay,
      continuesRight: n.scheduled_end! > cand.lastDay,
      firstDay: cand.firstDay,
      lastDay: cand.lastDay,
      done,
      paused,
      late,
    });
    covered.add(n.id);
  }

  return {
    segments,
    laneCount: laneEndCol.length,
    coveredNodeIds: covered,
  };
}

/** 兩日期字串（YYYY-MM-DD）相隔天數（UTC 計算，無夏令時誤差）：`a - b` */
export function diffCalendarDays(a: string, b: string): number {
  const toUtc = (k: string) =>
    Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

/**
 * 格式化日／週預估總時數：
 * - `0` 或非正數 → `""`
 * - `< 60` → `"45m"`
 * - 整小時或半小時（如 120 / 150）→ `"2h"` / `"2.5h"`
 * - 其餘 → 複用 `formatDurationShort`（如 `"1h20"`）
 */
export function formatEstHours(totalMin: number): string {
  if (!Number.isFinite(totalMin) || totalMin <= 0) return "";
  const rounded = Math.round(totalMin);
  if (rounded < 60) return `${rounded}m`;
  if (rounded % 60 === 0) return `${rounded / 60}h`;
  if (rounded % 30 === 0) return `${rounded / 60}h`;
  return formatDurationShort(rounded);
}
