/**
 * 期間自由券 `[scheduled_on, scheduled_end]` 與區間快捷（第四梯 4B · D-FB-7）。
 *
 * 純函式、零副作用、不碰 store／DOM；import 一律帶 `.ts`（`node --test` 直載）。
 */
import type { Priority } from "./node";
import { addDays } from "../lib/date.ts";

export interface NormalizedDateRange {
  scheduledOn: string | null;
  scheduledEnd: string | null;
}

/**
 * 正規化乘車日與乘車訖日：
 * - 無起日 ⇒ `{ scheduledOn: null, scheduledEnd: null }`（沒有起日不能單獨留訖日）
 * - 無訖日或起訖同日 ⇒ `{ scheduledOn: start, scheduledEnd: null }`（收斂為單日票）
 * - 訖早於起 ⇒ 自動交換為 `[end, start]`
 */
export function normalizeDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
): NormalizedDateRange {
  const s = start ?? null;
  const e = end ?? null;
  if (!s) return { scheduledOn: null, scheduledEnd: null };
  if (!e || e === s) return { scheduledOn: s, scheduledEnd: null };
  return e < s ? { scheduledOn: e, scheduledEnd: s } : { scheduledOn: s, scheduledEnd: e };
}

/** 是否為有效的期間自由券（有起日、有訖日且訖日嚴格大於起日） */
export function isRangeTicket(n: { scheduled_on: string | null; scheduled_end: string | null }): boolean {
  return n.scheduled_on !== null && n.scheduled_end !== null && n.scheduled_end > n.scheduled_on;
}

/** 此期間自由券的閉區間是否涵蓋 `dayKey` */
export function isRangeCoveringDay(
  n: { scheduled_on: string | null; scheduled_end: string | null },
  dayKey: string,
): boolean {
  return isRangeTicket(n) && n.scheduled_on! <= dayKey && dayKey <= n.scheduled_end!;
}

/** 期間自由券是否已過期進入誤點區（唯有 `dayKey > scheduled_end` 且未結案才算誤點） */
export function isRangeOverdue(
  n: { scheduled_on: string | null; scheduled_end: string | null; status: string },
  dayKey: string,
): boolean {
  return isRangeTicket(n) && n.status !== "done" && n.status !== "paused" && dayKey > n.scheduled_end!;
}

export type DateRangePreset = "weekend" | "thisWeek" | "nextWeek" | "thisMonth";

export const DATE_RANGE_PRESET_LABEL: Record<DateRangePreset, string> = {
  weekend: "週末",
  thisWeek: "本週",
  nextWeek: "下週",
  thisMonth: "本月",
};

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

function dowOf(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 區間快捷：週末、本週、下週、本月（尊重 `weekStart`：0 週日／1 週一） */
export function dateRangePreset(
  preset: DateRangePreset,
  today: string,
  weekStart: 0 | 1 = 1,
): { from: string; to: string } {
  if (preset === "thisMonth") {
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${pad2(lastDay)}` };
  }
  const dow = dowOf(today);
  const thisWeekStart = addDays(today, -((dow - weekStart + 7) % 7));
  if (preset === "thisWeek") {
    return { from: thisWeekStart, to: addDays(thisWeekStart, 6) };
  }
  if (preset === "nextWeek") {
    const nextStart = addDays(thisWeekStart, 7);
    return { from: nextStart, to: addDays(nextStart, 6) };
  }
  // 週末：週一～週六為本週六～週日；週日起算為週一（weekStart=1）涵蓋昨天週六～今天週日，週日起算為週日（weekStart=0）取即將到來的週六～週日
  if (dow === 0 && weekStart === 1) {
    return { from: addDays(today, -1), to: today };
  }
  if (dow === 0) {
    return { from: addDays(today, 6), to: addDays(today, 7) };
  }
  return { from: addDays(today, 6 - dow), to: addDays(today, 7 - dow) };
}

/** 距離區間結束還剩幾天（0＝今天最後一天；負數＝已過期天數） */
export function rangeRemainingDays(scheduledEnd: string, today: string): number {
  const toUtc = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((toUtc(scheduledEnd) - toUtc(today)) / 86_400_000);
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, mid: 1, low: 2 };

/** 「期間自由券」抽屜預設排序：結束日由近到遠 → 優先順序 → 兄弟排序鍵 → 建立時刻 → id */
export function compareRangeDrawerRows<
  T extends {
    id: string;
    scheduled_end: string | null;
    priority: Priority;
    sort_key?: string | null;
    created_at: string;
  },
>(a: T, b: T): number {
  const ea = a.scheduled_end ?? "9999-12-31";
  const eb = b.scheduled_end ?? "9999-12-31";
  if (ea !== eb) return ea.localeCompare(eb);
  const pa = PRIORITY_RANK[a.priority] ?? 1;
  const pb = PRIORITY_RANK[b.priority] ?? 1;
  if (pa !== pb) return pa - pb;
  const sa = a.sort_key ?? "";
  const sb = b.sort_key ?? "";
  if (sa !== sb) {
    if (!sa) return 1;
    if (!sb) return -1;
    return sa < sb ? -1 : 1;
  }
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/** 區間顯示字（例 `"10/2–10/4"`；沒訖日只顯示 `"10/2"`） */
export function formatDateRangeBadge(scheduledOn: string, scheduledEnd: string | null): string {
  const md = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
  if (!scheduledEnd || scheduledEnd <= scheduledOn) return md(scheduledOn);
  if (scheduledOn.slice(0, 4) !== scheduledEnd.slice(0, 4)) {
    return `${scheduledOn.slice(0, 4)}/${md(scheduledOn)}–${scheduledEnd.slice(0, 4)}/${md(scheduledEnd)}`;
  }
  return `${md(scheduledOn)}–${md(scheduledEnd)}`;
}
