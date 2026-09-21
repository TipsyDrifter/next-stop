/**
 * 日期工具——執行日／締切日一律用「本地日期 key」YYYY-MM-DD（date-only，不帶時區）。
 * 日界線（決策 D9）：一天的開始預設 03:00，現在本地時間尚未過日界線 → 算前一天。
 */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayKey(dayStartHour = 3, now: Date = new Date()): string {
  const d = new Date(now);
  if (d.getHours() < dayStartHour) d.setDate(d.getDate() - 1);
  return toDateKey(d);
}

/**
 * 某個時刻戳（UTC ISO）落在哪一個「日界線日」——todayKey 的通用版。
 * 用途：M3 ④ 把 occurrences.completed_at／updated_at 換算成班次的錨點日（完成後 N 天要從哪天起算）。
 */
export function dayKeyOf(iso: string, dayStartHour = 3): string {
  return todayKey(dayStartHour, new Date(iso));
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return toDateKey(new Date(y, m - 1, d + n));
}

/**
 * 某個「日界線日」的時間視窗，回傳 UTC ISO 上下界（[start, end)）。
 * dateKey 這一天＝本地 dateKey 的 dayStartHour 點 起，到隔天同一時刻止。
 * 用途：判斷 completed_at／logged_at 這種時刻戳「算不算今天」（M3 ③ 今日聚合的第四條 OR）。
 */
export function dayWindow(dateKey: string, dayStartHour = 3): { start: string; end: string } {
  const [y, m, d] = dateKey.split("-").map(Number);
  return {
    start: new Date(y, m - 1, d, dayStartHour).toISOString(),
    end: new Date(y, m - 1, d + 1, dayStartHour).toISOString(),
  };
}

/** 時刻戳（UTC ISO）落在 dateKey 這個日界線日之內？ */
export function isInDay(iso: string | null, dateKey: string, dayStartHour = 3): boolean {
  if (!iso) return false;
  const { start, end } = dayWindow(dateKey, dayStartHour);
  return iso >= start && iso < end;
}
