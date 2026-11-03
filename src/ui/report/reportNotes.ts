/**
 * 運行報告「記事」欄的來源（② 運行報告 D-主-189；契約 §6）——插槽，現在是空的。
 *
 * ③ 車庫與回顧合進來後在這裡登記一個來源（讀 `stamps`：車站到着、路線到站、第 1000 枚済章…）：
 *   `REPORT_NOTE_SOURCES.push({ id: "depot.stamps", load: (from, to) => … })`，或直接把陣列初值改成含它。
 * 每個來源回 `{ [YYYY-MM-DD]: 一行一行的字 }`；同一天多個來源依登記順序接起來。
 * 沒有任何來源＝記事欄整欄不畫（桌機那一欄與圖例那一項都不出現；手機日期格下那一行也沒有）。
 */
export interface ReportNoteSource {
  id: string;
  /** `from`～`to`（含兩端）每天的記事 */
  load(from: string, to: string): Promise<Record<string, string[]>>;
}

export const REPORT_NOTE_SOURCES: ReportNoteSource[] = [];

/** 給 `loadReportFacts` 的 `dayNotes`：沒有來源＝null；一個來源讀失敗只少它那幾行 */
export function reportDayNotesLoader(): ((from: string, to: string) => Promise<Record<string, string[]>>) | null {
  if (!REPORT_NOTE_SOURCES.length) return null;
  return async (from, to) => {
    const out: Record<string, string[]> = {};
    for (const src of REPORT_NOTE_SOURCES) {
      try {
        const got = await src.load(from, to);
        for (const day of Object.keys(got)) (out[day] ??= []).push(...got[day]);
      } catch (e) {
        console.warn(`運行報告：記事來源「${src.id}」讀取失敗`, e);
      }
    }
    return out;
  };
}
