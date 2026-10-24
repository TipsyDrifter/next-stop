/**
 * dayKeys——旅客筆記手機版共用的幾支日期 key 小工具（`shortDay`／`nextMonday`／`shiftIsoToDay`）。
 * 呼叫端：MobileNoteInbox、MobileNoteList、MobileNotePage。
 *
 * 來歷：原本放在 `MobileDatePick.tsx`（車次①的手機「挑一天」面板；本體在車次② 搬到 common/MobileDatePicker），
 * UI 丙-7 T5 刪掉薄殼後檔裡只剩這幾支，名不副實，丙-7 第二輪搬來這裡、舊檔刪掉。
 */
import { addDays } from "../../../lib/date";

/** "2026-10-05" → "10/5" */
export function shortDay(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return m && d ? `${m}/${d}` : key;
}

/** 兩個日期 key 相差幾天（a − b）；不經 Date.parse，避免 date-only 被當 UTC 而跨日 */
function diffDayKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()) / 86_400_000);
}

/** 下一個週一（今天是週一＝下週一） */
export function nextMonday(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return addDays(key, (8 - dow) % 7 || 7);
}

/**
 * 改筆記日期時保留原本的時刻：把 iso 平移 (toDay − fromDay) 天。
 * 以「日界線換算後的日」相減，所以凌晨 1 點（日界線 3 點之前）記的那則改到 10/5，換算後仍落在 10/5。
 */
export function shiftIsoToDay(iso: string, fromDay: string, toDay: string): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + diffDayKeys(toDay, fromDay));
  return d.toISOString();
}
