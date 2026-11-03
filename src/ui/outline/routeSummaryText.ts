/**
 * 路線一覽的字（丁 D-主-240／244）：桌機卡片與手機路線圖第一層同一套說法。純函式。
 */
import { moneyText } from "../../domain/ticket";
import { fmtDur } from "../../domain/timetable";
import type { RouteSummary } from "../../domain/routeOverview";

const WEEK = "日一二三四五六";

/** 「12/6（日）」 */
export function mdw(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${m}/${d}（${WEEK[new Date(y, m - 1, d).getDay()]}）`;
}

/** 一分鐘以上才算有時間 */
export const hasTime = (ms: number): boolean => ms >= 60_000;

export function spendText(minor: number, decimals: number): string {
  return moneyText(minor, decimals, { whole: true });
}

/**
 * 手機第一層那一行的各段：「車票 3/9 済」「近 30 天 3h20m」「花 3,117」「誤點 2」；沒有的段不出（0 不寫）。
 * 誤點那段另外標出來（赭字）。
 */
export function summaryParts(s: RouteSummary, decimals: number, days: number): { text: string; late?: boolean }[] {
  const out: { text: string; late?: boolean }[] = [];
  if (s.ticketTotal > 0) out.push({ text: `車票 ${s.ticketDone}/${s.ticketTotal} 済` });
  if (hasTime(s.timeMs)) out.push({ text: `近 ${days} 天 ${fmtDur(s.timeMs)}` });
  if (s.spendMinor !== 0) out.push({ text: `花 ${spendText(s.spendMinor, decimals)}` });
  if (s.late > 0) out.push({ text: `誤點 ${s.late}`, late: true });
  return out;
}

/** 頁首那一句的各段：「3 條路線運行中」「近 30 天 6h50m」「花 4,357」 */
export function headParts(routes: number, totalTimeMs: number, totalSpendMinor: number, decimals: number, days: number, short = false): string[] {
  const out = [short ? `${routes} 條路線` : `${routes} 條路線運行中`];
  if (hasTime(totalTimeMs)) out.push(`近 ${days} 天 ${fmtDur(totalTimeMs)}`);
  if (totalSpendMinor !== 0) out.push(`花 ${spendText(totalSpendMinor, decimals)}`);
  return out;
}
