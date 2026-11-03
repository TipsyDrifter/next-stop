/**
 * reportTime——運行報告的時刻表數字（② 運行報告；契約 §3「時刻表」、§4）。純函式。
 *
 * 口徑＝時刻表統計「日」的已記錄：先丟碎塊、待確認另計（`classifySpans`＋`windowTotals`，門檻由呼叫端給——
 * 跟統計頁同一支 `blockThresholdOf`），每天一個日界線窗。比較＝上週同一天、到同一個時刻為止（同統計頁環比 D-時-45）。
 */
import { classifySpans, windowTotals, ROUTE_NONE, type StatsSpan } from "./timetableStats.ts";
import { msOf } from "./timetable.ts";
import { addDays, dayWindow } from "../lib/date.ts";
import type { ReportTimeFacts } from "./report.ts";

export function reportTimeFacts(input: {
  spans: readonly StatsSpan[];
  /** 這一塊的門檻分鐘（null＝沒有門檻） */
  threshold: (s: StatsSpan) => number | null;
  /**
   * 分類 id → 它在統計裡歸到的那一類（子分類歸主分類，同時刻表統計的「占比」第一層）；不在＝null（寫「已刪除的分類」）
   */
  catTop: (id: string) => { id: string; name: string } | null;
  from: string;
  today: string;
  dayStartHour: number;
  now: number;
}): ReportTimeFacts {
  const { spans, threshold, catTop, from, today, dayStartHour: h, now } = input;
  const cls = classifySpans(spans, now, threshold);
  const win = (day: string) => {
    const w = dayWindow(day, h);
    return { start: msOf(w.start), end: msOf(w.end) };
  };
  const route = () => ROUTE_NONE;
  const byDay: Record<string, number> = {};
  let todayCats: { id: string; name: string; ms: number }[] = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const t = windowTotals(spans, cls, win(d), now, route);
    byDay[d] = t.recordedMs;
    if (d === today) {
      const by = new Map<string, { id: string; name: string; ms: number }>();
      for (const id of Object.keys(t.byCategory)) {
        const top = catTop(id) ?? { id, name: "已刪除的分類" };
        const cur = by.get(top.id);
        if (cur) cur.ms += t.byCategory[id];
        else by.set(top.id, { ...top, ms: t.byCategory[id] });
      }
      todayCats = [...by.values()].sort((a, b) => b.ms - a.ms);
    }
  }
  const prevStart = win(addDays(today, -7)).start;
  const elapsed = Math.max(0, now - win(today).start);
  const prev = windowTotals(spans, cls, { start: prevStart, end: prevStart + elapsed }, now, route);
  return { byDay, todayCats, prevSameSpanMs: prev.recordedMs };
}
