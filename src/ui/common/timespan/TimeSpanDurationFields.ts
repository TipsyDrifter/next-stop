/**
 * TimeSpanDurationFields——全站「起訖時刻 ⇄ 持續時長 DurationPicker」雙向互推共用模組（操作 10 · D-FB-3）。
 *
 * 收納於 `src/ui/common/timespan/` 子目錄（平行工單期間不碰 `docs/程式庫索引.md` 頂層清單；收尾時統一補登）。
 * 提供兩層能力：
 *   1. 純函式橋接層（零 DOM／Store 依賴，供單元測試與各面板共用）：
 *      - 時鐘字串模式（轉發 `domain/clockSpan.ts`）
 *      - 牆鐘毫秒區間模式（`spanDurationMin`、`applySpanStartMs`、`applySpanEndMs`、`applySpanDurationMin`、`arrivalMsFromEst`、`estMinFromArrivalMs`）
 *   2. 共用 UI 元件（依《視覺規範》語意 Token，支援 compact / mobile 雙殼對齊）
 */
import { DURATION_DEFAULT_MAX } from "../../../domain/duration.ts";
import {
  applyDurationMin,
  applyEndClock,
  applyStartClock,
  deriveClockSpan,
  formatClockSpanSummary,
  parseClockSpanInput,
  type ClockSpanResult,
  type ClockSpanValue,
} from "../../../domain/clockSpan.ts";

export {
  applyDurationMin,
  applyEndClock,
  applyStartClock,
  deriveClockSpan,
  formatClockSpanSummary,
  parseClockSpanInput,
  type ClockSpanResult,
  type ClockSpanValue,
};

const MIN_MS = 60_000;

export interface SpanMsPair {
  startMs: number;
  endMs: number;
}

export interface SpanMsBounds {
  lo: number;
  hiEnd: number;
  maxMin?: number;
  /** 當 `startMs + dur > hiEnd`（例如過去補記上限為 `now`）時，改將 `startMs` 往前推以湊足目標時長 */
  shiftStartIfCapped?: boolean;
}

function clampMs(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 由毫秒區間推算分鐘長度（夾在 `[1, maxMin]`） */
export function spanDurationMin(startMs: number, endMs: number, maxMin: number = DURATION_DEFAULT_MAX): number {
  const raw = Math.round((endMs - startMs) / MIN_MS);
  return Math.max(1, Math.min(maxMin, raw));
}

/** 改開始毫秒：保留目前區間時長並平移結束毫秒（頂到 `hiEnd` 時夾住） */
export function applySpanStartMs(prev: SpanMsPair, nextStartMs: number, bounds: SpanMsBounds): SpanMsPair {
  const maxStart = Math.max(bounds.lo, bounds.hiEnd - MIN_MS);
  const startMs = clampMs(nextStartMs, bounds.lo, maxStart);
  const durMs = Math.max(MIN_MS, prev.endMs - prev.startMs);
  const endMs = clampMs(startMs + durMs, startMs + MIN_MS, bounds.hiEnd);
  return { startMs, endMs };
}

/** 改結束毫秒：確保晚於開始至少 1 分鐘且不超過 `hiEnd` */
export function applySpanEndMs(prev: SpanMsPair, nextEndMs: number, bounds: SpanMsBounds): SpanMsPair {
  const minEnd = Math.min(bounds.hiEnd, prev.startMs + MIN_MS);
  let candidate = nextEndMs;
  // 合理跨夜（12h 內）且未超出 hiEnd 時自動進位一天
  if (candidate <= prev.startMs && candidate + 1440 * MIN_MS <= bounds.hiEnd && candidate + 1440 * MIN_MS - prev.startMs <= 720 * MIN_MS) {
    candidate += 1440 * MIN_MS;
  }
  const endMs = clampMs(candidate, minEnd, bounds.hiEnd);
  return { startMs: prev.startMs, endMs };
}

/** 改持續時長（分鐘）：正推結束毫秒；若受 `hiEnd` 限制且允許 `shiftStartIfCapped`，回推開始毫秒以滿足所選時長 */
export function applySpanDurationMin(prev: SpanMsPair, nextDurationMin: number, bounds: SpanMsBounds): SpanMsPair {
  const maxMin = bounds.maxMin ?? DURATION_DEFAULT_MAX;
  const durMin = Math.max(1, Math.min(maxMin, Math.round(nextDurationMin)));
  const durMs = durMin * MIN_MS;
  const forwardEnd = prev.startMs + durMs;
  if (forwardEnd <= bounds.hiEnd) {
    return { startMs: prev.startMs, endMs: Math.max(prev.startMs + MIN_MS, forwardEnd) };
  }
  if (bounds.shiftStartIfCapped) {
    const endMs = bounds.hiEnd;
    const startMs = clampMs(endMs - durMs, bounds.lo, Math.max(bounds.lo, endMs - MIN_MS));
    return { startMs, endMs };
  }
  const endMs = Math.max(prev.startMs + MIN_MS, bounds.hiEnd);
  return { startMs: prev.startMs, endMs };
}

/** 運行中／発車預估：由開始毫秒＋預估分鐘推算預計到着毫秒（無預估預設以 60 分作錶盤種子） */
export function arrivalMsFromEst(startMs: number, estimateMin: number | null, seedMin = 60): number {
  const m = estimateMin !== null && estimateMin > 0 ? estimateMin : seedMin;
  return startMs + m * MIN_MS;
}

/** 運行中／発車預估：由預計到着毫秒反推預估分鐘（夾在 `[1, maxMin]`） */
export function estMinFromArrivalMs(startMs: number, arrivalMs: number, maxMin: number = DURATION_DEFAULT_MAX): number {
  let target = arrivalMs;
  if (target <= startMs) {
    target += 1440 * MIN_MS;
  }
  const diff = Math.round((target - startMs) / MIN_MS);
  return Math.max(1, Math.min(maxMin, diff));
}
