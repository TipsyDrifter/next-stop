/**
 * 小窗的時間字（⑬ 外部入口）。
 *
 * 自帶一份、不 import `domain/timetable.ts` 的 `fmtDur`：兩個 Vite 入口共用的模組會被 Rollup 抽成共用 chunk，
 * 小窗只要這幾行卻得連帶載入主視窗用到的整包時刻表純函式——小窗要輕（契約 第三節效能守則）。
 * `scripts/tests/external-link.test.ts` 逐例對帳，改 `fmtDur` 時那裡會紅。
 */
export function fmtElapsed(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return m + "m";
  if (m === 0) return h + "h";
  return h + "h" + String(m).padStart(2, "0") + "m";
}

/** 距離下一個整分還有幾毫秒（經過時間每分鐘對齊整分更新一次，不每秒） */
export function msToNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}
