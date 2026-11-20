/**
 * 運行報告「記事」欄與一日運行專頁記事章來源（② 運行報告 D-主-189；③ 車庫駅スタンプ；v1.33 手帳跨頁）。
 *
 * 每個來源回 `{ [YYYY-MM-DD]: 一行一行的字 }`；同一天多個來源依登記順序接起來並去重。
 * 若該期間內完全沒有任何記事（回傳 `null`），外層表格自動收合記事欄不佔空位。
 */
export interface ReportNoteSource {
  id: string;
  /** `from`～`to`（含兩端）每天的記事 */
  load(from: string, to: string): Promise<Record<string, string[]>>;
}

export function pushUniqueReportNote(bucket: Record<string, string[]>, day: string, text: string): void {
  const clean = text.trim();
  if (!clean) return;
  const list = (bucket[day] ??= []);
  if (!list.includes(clean)) list.push(clean);
}

export const REPORT_NOTE_SOURCES: ReportNoteSource[] = [];

export function registerReportNoteSource(source: ReportNoteSource): void {
  if (!REPORT_NOTE_SOURCES.some((s) => s.id === source.id)) {
    REPORT_NOTE_SOURCES.push(source);
  }
}

/** 給 `loadReportFacts`／`loadSingleDaySpread` 的 `dayNotes`：區間內無記事回傳 null；單一來源失敗不阻塞報表 */
export function reportDayNotesLoader(): ((from: string, to: string) => Promise<Record<string, string[]> | null>) | null {
  if (!REPORT_NOTE_SOURCES.length) return null;
  return async (from, to) => {
    const out: Record<string, string[]> = {};
    for (const src of REPORT_NOTE_SOURCES) {
      try {
        const got = await src.load(from, to);
        for (const day of Object.keys(got)) {
          for (const line of got[day]) pushUniqueReportNote(out, day, line);
        }
      } catch (e) {
        console.warn(`運行報告：記事來源「${src.id}」讀取失敗`, e);
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  };
}
