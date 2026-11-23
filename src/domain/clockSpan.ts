/**
 * 起訖時刻 ⇄ 持續時長雙向連動純函式底座（操作 10 · D-FB-3）：
 * 統一全站 13 處「開始時刻 startHm ⇄ 結束時刻 endHm ⇄ 持續時長 durationMin」雙向互推，
 * 對齊營業日（dayStartHour）與跨午夜表記（25:00+ 與 nextDayNote）。
 *
 * 零 React / Store / DOM / Tauri 依賴；import 一律帶 `.ts` 副檔名以供 `node --test` 直接載入。
 */
import {
  arrivalClock,
  clockMinutes,
  clockRange,
  clockText,
  nextDayNote,
  parseClockInput,
  type ClockText,
} from "../lib/date.ts";
import { DURATION_DEFAULT_MAX, formatDurationShort } from "./duration.ts";

export const CLOCK_SPAN_MAX_MIN = DURATION_DEFAULT_MAX;
/** 結束時刻小於開始時刻時，允許自動跨夜換成 24:00+ 的最大時長（12 小時；避免把白天的打錯早時刻誤當成 23 小時跨夜） */
export const CLOCK_SPAN_CROSS_MIDNIGHT_MAX_MIN = 720;

export interface ClockSpanValue {
  startHm: ClockText | null;
  endHm: ClockText | null;
  durationMin: number | null;
}

export interface ClockSpanResult extends ClockSpanValue {
  ok: boolean;
  error?: string;
  startNextDayNote: string | null;
  endNextDayNote: string | null;
}

function makeOk(
  startHm: ClockText | null,
  endHm: ClockText | null,
  durationMin: number | null,
): ClockSpanResult {
  return {
    ok: true,
    startHm,
    endHm,
    durationMin,
    startNextDayNote: startHm ? nextDayNote(startHm) : null,
    endNextDayNote: endHm ? nextDayNote(endHm) : null,
  };
}

function makeErr(
  prev: Partial<ClockSpanValue>,
  error: string,
): ClockSpanResult {
  const startHm = prev.startHm ?? null;
  const endHm = prev.endHm ?? null;
  const durationMin = prev.durationMin ?? null;
  return {
    ok: false,
    error,
    startHm,
    endHm,
    durationMin,
    startNextDayNote: startHm ? nextDayNote(startHm) : null,
    endNextDayNote: endHm ? nextDayNote(endHm) : null,
  };
}

function validDuration(min: number | null | undefined): number | null {
  if (typeof min !== "number" || !Number.isFinite(min)) return null;
  const r = Math.round(min);
  return r >= 1 && r <= CLOCK_SPAN_MAX_MIN ? r : null;
}

function resolveDurationFromPrev(prev: Partial<ClockSpanValue>): number | null {
  const d = validDuration(prev.durationMin);
  if (d !== null) return d;
  if (prev.startHm && prev.endHm) {
    const s = clockMinutes(prev.startHm);
    const e = clockMinutes(prev.endHm);
    if (s !== null && e !== null && e > s && e - s <= CLOCK_SPAN_MAX_MIN) {
      return e - s;
    }
  }
  return null;
}

/** 由目前儲存的「開始時刻＋持續時長」推導完整三欄位與跨日提示 */
export function deriveClockSpan(
  startHm: string | null,
  durationMin: number | null,
): ClockSpanResult {
  const s = startHm && clockMinutes(startHm) !== null ? startHm : null;
  const dur = validDuration(durationMin);
  const endHm = s && dur !== null ? arrivalClock(s, dur) : null;
  return makeOk(s, endHm, dur);
}

/** 改開始時刻：平移結束時刻（保留既有持續時長）；清空開始時刻時同步清掉結束時刻 */
export function applyStartClock(
  prev: Partial<ClockSpanValue>,
  nextStartRaw: string | null,
  dayStartHour: number,
): ClockSpanResult {
  const dur = resolveDurationFromPrev(prev);
  if (nextStartRaw === null || nextStartRaw.trim() === "") {
    return makeOk(null, null, dur);
  }
  const parsed = parseClockInput(nextStartRaw, dayStartHour);
  if (parsed === null) {
    return makeErr(prev, "開始時刻格式不對或超出營業日範圍");
  }
  const endHm = dur !== null ? arrivalClock(parsed, dur) : null;
  return makeOk(parsed, endHm, dur);
}

/** 改持續時長：有開始時刻時正推結束時刻；尚無開始時刻時僅存時長 */
export function applyDurationMin(
  prev: Partial<ClockSpanValue>,
  nextDurationMin: number | null,
): ClockSpanResult {
  const startHm = prev.startHm && clockMinutes(prev.startHm) !== null ? prev.startHm : null;
  if (nextDurationMin === null) {
    return makeOk(startHm, null, null);
  }
  const dur = validDuration(nextDurationMin);
  if (dur === null) {
    return makeErr(prev, `持續時長須介於 1 分鐘到 ${CLOCK_SPAN_MAX_MIN / 60} 小時之間`);
  }
  const endHm = startHm ? arrivalClock(startHm, dur) : null;
  return makeOk(startHm, endHm, dur);
}

/**
 * 解析結束時刻輸入：先依 dayStartHour 解析；若為明確 24:00+ 表記（如 "25:00"）在 dayStartHour 較小時
 * 亦允許以跨午夜表記解析（與 arrivalClock 一致）。
 */
function parseEndClockRaw(raw: string, dayStartHour: number): ClockText | null {
  const direct = parseClockInput(raw, dayStartHour);
  if (direct !== null) return direct;
  // 若為明確 ≥24 小時之表記（例如日界線 0 時打 "25:00"），改以寬鬆牆鐘試解
  const norm = raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[：．.]/g, ":");
  const m = /^(\d{1,2}):(\d{2})$/.exec(norm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 24 || h > 47 || mi > 59) return null;
  return clockText(h * 60 + mi);
}

/**
 * 改結束時刻：反推持續時長。
 * - 結束早於開始時，若在合理跨夜範圍（<= 12 小時）自動換跨夜營業日時數（如 22:00 → 01:00 轉為 25:00 / 180 分）；
 * - 否則（同時刻或早於開始且不屬合理跨夜，或超過 24 小時）回傳 `{ ok: false, error }` 擋下理由。
 */
export function applyEndClock(
  prev: Partial<ClockSpanValue>,
  nextEndRaw: string | null,
  dayStartHour: number,
): ClockSpanResult {
  const startHm = prev.startHm && clockMinutes(prev.startHm) !== null ? prev.startHm : null;
  if (nextEndRaw === null || nextEndRaw.trim() === "") {
    return makeOk(startHm, null, null);
  }
  if (!startHm) {
    return makeErr(prev, "請先設定開始時刻，再設定結束時刻");
  }
  const startMin = clockMinutes(startHm)!;
  const parsedEnd = parseEndClockRaw(nextEndRaw, dayStartHour);
  if (parsedEnd === null) {
    return makeErr(prev, "結束時刻格式不對或超出營業日範圍");
  }
  let endMin = clockMinutes(parsedEnd)!;

  if (endMin === startMin) {
    return makeErr(prev, "結束時刻須晚於開始時刻");
  }

  if (endMin < startMin) {
    // 合理跨夜：start 與 end 皆在 24:00 內且跨夜後不超過 12 小時，自動換算成 24:00+ 營業日表記
    const wrappedEnd = endMin + 1440;
    const wrappedDur = wrappedEnd - startMin;
    if (startMin < 1440 && endMin < 1440 && wrappedDur <= CLOCK_SPAN_CROSS_MIDNIGHT_MAX_MIN) {
      endMin = wrappedEnd;
    } else {
      return makeErr(prev, "結束時刻早於開始時刻");
    }
  }

  const dur = endMin - startMin;
  if (dur > CLOCK_SPAN_MAX_MIN) {
    return makeErr(prev, `持續時長不能超過 ${CLOCK_SPAN_MAX_MIN / 60} 小時`);
  }

  // 若未跨出可寫範圍上限（clockText 支援至 99:59），輸出標準營業日表記
  const finalEnd = clockText(endMin);
  if (!finalEnd) {
    return makeErr(prev, "結束時刻超出可表示範圍");
  }
  // 確保 start 在營業日範圍內時，end 至少不早於日界線起點
  void clockRange(dayStartHour);
  return makeOk(startHm, finalEnd, dur);
}

const SPAN_SEP_RE = /^(.+?)\s*[-~～〜–—]\s*(.+)$/;

/** 解析文字時段區間（如 "14:00-15:30"、"14:00~16:00"、"23:30-25:00"）；不合則回 null */
export function parseClockSpanInput(
  raw: string,
  dayStartHour: number,
): { startHm: ClockText; endHm: ClockText; durationMin: number } | null {
  const m = SPAN_SEP_RE.exec(raw.trim());
  if (!m) return null;
  const startHm = parseClockInput(m[1], dayStartHour);
  if (!startHm) return null;
  const res = applyEndClock({ startHm }, m[2], dayStartHour);
  if (!res.ok || !res.endHm || !res.durationMin) return null;
  return { startHm, endHm: res.endHm, durationMin: res.durationMin };
}

/** 時間膠囊精簡摘要：同時有開始與時長顯示 `14:00–15:30 · 1h30`；單邊只顯示該邊 */
export function formatClockSpanSummary(
  startHm: string | null,
  durationMin: number | null,
): string | null {
  const s = startHm && clockMinutes(startHm) !== null ? startHm : null;
  const dur = validDuration(durationMin);
  if (s && dur !== null) {
    const endHm = arrivalClock(s, dur);
    const durText = formatDurationShort(dur);
    return endHm ? `${s}–${endHm} · ${durText}` : `${s} · ${durText}`;
  }
  if (s) return s;
  if (dur !== null) return formatDurationShort(dur);
  return null;
}
