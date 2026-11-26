/**
 * reportTime——運行報告的時刻表數字與單日／路線切片（② 運行報告 ＋ v1.33 3A 完全體）。純函式。
 *
 * 口徑＝時刻表統計「日」的已記錄：先丟碎塊、待確認另計（`classifySpans`＋`windowTotals`／`sliceSpans`，
 * 門檻由呼叫端給——跟統計頁同一支 `blockThresholdOf`），每天一個日界線窗。
 * 比較＝上週同一天、到同一個時刻為止（同統計頁環比 D-時-45）。
 *
 * v1.33 3A 擴充：
 *   - 保留 `spans` 預處理結構（`ReportPreparedSpan`），支援不重查資料庫直接依「幹線／路線 ＋ #荷札」與「彈性期間」即時切片：
 *     ① 每日已記錄時數與今日分類占比
 *     ② 單日展開明細（當日總時數、主分類占比橫條、各時間塊起訖時刻與分類／任務／備註精簡明細）
 *     ③ 統計區間內各路線投入時數排行（`byRoute`）
 */
import { classifySpans, windowTotals, ROUTE_NONE, type StatsSpan } from "./timetableStats.ts";
import { msOf, sliceSpans, type Span } from "./timetable.ts";
import { addDays, dayWindow } from "../lib/date.ts";
import type { ReportDayBlockItem, ReportDayTimeDetail, ReportTimeFacts } from "./report.ts";

export interface ReportTimeBlockMeta {
  categoryName: string;
  taskName: string | null;
  note: string;
  /** v1.39 4A：時間塊地點（選填） */
  location?: string | null;
  /** 已解析的有效路線 id（連節點看節點所屬路線；只連路線看塊的 route_id；都沒有＝null） */
  routeId: string | null;
}

export interface ReportPreparedSpan {
  id: string;
  categoryId: string;
  topCatId: string;
  topCatName: string;
  categoryName: string;
  start: number;
  end: number | null;
  ack: boolean;
  pending: boolean;
  routeId: string | null;
  taskName: string | null;
  note: string;
  /** v1.39 4A：時間塊地點（選填） */
  location?: string | null;
  tagKeys: readonly string[];
}

function fmtWallHm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function winOf(day: string, h: number): { start: number; end: number } {
  const w = dayWindow(day, h);
  return { start: msOf(w.start), end: msOf(w.end) };
}

export function reportTimeFacts(input: {
  spans: readonly StatsSpan[];
  /** 這一塊的門檻分鐘（null＝沒有門檻） */
  threshold: (s: StatsSpan) => number | null;
  /**
   * 分類 id → 它在統計裡歸到的那一類（子分類歸主分類，同時刻表統計的「占比」第一層）；不在＝null（寫「已刪除的分類」）
   */
  catTop: (id: string) => { id: string; name: string } | null;
  from: string;
  /** 省略＝today */
  to?: string;
  today: string;
  dayStartHour: number;
  now: number;
  blockMeta?: Readonly<Record<string, ReportTimeBlockMeta>>;
}): ReportTimeFacts {
  const { spans, threshold, catTop, from, today, dayStartHour: h, now, blockMeta } = input;
  const endDay = input.to && input.to > today ? input.to : today;
  const cls = classifySpans(spans, now, threshold);
  const route = () => ROUTE_NONE;
  const byDay: Record<string, number> = {};
  let todayCats: { id: string; name: string; ms: number }[] = [];

  for (let d = from; d <= endDay; d = addDays(d, 1)) {
    const t = windowTotals(spans, cls, winOf(d, h), now, route);
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

  const prevStart = winOf(addDays(today, -7), h).start;
  const elapsed = Math.max(0, now - winOf(today, h).start);
  const prev = windowTotals(spans, cls, { start: prevStart, end: prevStart + elapsed }, now, route);

  const prepared: ReportPreparedSpan[] = [];
  for (const s of spans) {
    if (cls.tiny.has(s.id)) continue;
    const top = catTop(s.categoryId) ?? { id: s.categoryId, name: "已刪除的分類" };
    const meta = blockMeta?.[s.id];
    prepared.push({
      id: s.id,
      categoryId: s.categoryId,
      topCatId: top.id,
      topCatName: top.name,
      categoryName: meta?.categoryName ?? top.name,
      start: s.start,
      end: s.end,
      ack: s.ack,
      pending: cls.pending.has(s.id),
      routeId: meta !== undefined ? meta.routeId : s.routeId,
      taskName: meta?.taskName ?? null,
      note: meta?.note ?? "",
      location: meta?.location ?? null,
      tagKeys: s.tagKeys ?? [],
    });
  }

  return {
    byDay,
    todayCats,
    prevSameSpanMs: prev.recordedMs,
    preparedSpans: prepared,
  };
}

/** 將單日或今日的主分類清單收斂為「前 3 大分類 ＋ 其他（多於 4 個時）」 */
export function topFourCats(cats: readonly { id: string; name: string; ms: number }[]): { id: string; name: string; ms: number }[] {
  const sorted = [...cats].filter((c) => c.ms > 0).sort((a, b) => b.ms - a.ms);
  if (sorted.length <= 4) return sorted;
  return [
    ...sorted.slice(0, 3),
    { id: "__other", name: "其他", ms: sorted.slice(3).reduce((a, c) => a + c.ms, 0) },
  ];
}

/**
 * 依彈性區間與跨模組篩選條件，由 `preparedSpans` 即時切出：
 *   - `byDay`（區間內＋比較週的每日已記錄 ms）
 *   - `todayCats`、`prevSameSpanMs`（上方時刻表卡）
 *   - `dayDetails`（區間內每一天的分類占比與時間塊精簡明細，供單日手風琴展開）
 *   - `byRouteInRange`（區間 `[rangeFrom, rangeTo]` 各路線投入時數，供路線實績排行卡；key 為 routeId 或 `"__none"`）
 */
export function slicePreparedTime(input: {
  spans: readonly ReportPreparedSpan[];
  filter?: (s: ReportPreparedSpan) => boolean;
  today: string;
  rangeFrom: string;
  rangeTo: string;
  tableFloor: string;
  dayStartHour: number;
  now: number;
}): {
  byDay: Record<string, number>;
  todayCats: { id: string; name: string; ms: number }[];
  prevSameSpanMs: number;
  dayDetails: Record<string, ReportDayTimeDetail>;
  byRouteInRange: Record<string, number>;
} {
  const { filter, today, rangeFrom, rangeTo, tableFloor, dayStartHour: h, now } = input;
  const eligible = filter ? input.spans.filter(filter) : input.spans;
  const byId = new Map<string, ReportPreparedSpan>();
  const rawSpans: Span[] = [];
  for (const s of eligible) {
    byId.set(s.id, s);
    rawSpans.push({ id: s.id, categoryId: s.categoryId, start: s.start, end: s.end, ack: s.ack });
  }

  const loDay = tableFloor < rangeFrom ? tableFloor : rangeFrom;
  const hiDay = today > rangeTo ? today : rangeTo;

  const byDay: Record<string, number> = {};
  const dayDetails: Record<string, ReportDayTimeDetail> = {};
  const byRouteInRange: Record<string, number> = {};
  let todayCats: { id: string; name: string; ms: number }[] = [];

  for (let d = loDay; d <= hiDay; d = addDays(d, 1)) {
    const w = winOf(d, h);
    const effEnd = Math.min(w.end, now);
    if (effEnd <= w.start) {
      byDay[d] = 0;
      if (d >= rangeFrom && d <= rangeTo) {
        dayDetails[d] = { totalMs: 0, cats: [], blocks: [] };
      }
      continue;
    }

    const dayEligible = rawSpans.filter((s) => s.start < effEnd && (s.end ?? now) > w.start);
    const slices = sliceSpans(dayEligible, { start: w.start, end: effEnd }, now);

    let recordedMs = 0;
    const catMap = new Map<string, { id: string; name: string; ms: number }>();
    const needDetail = d >= rangeFrom && d <= rangeTo;
    const blockAgg = needDetail
      ? new Map<string, { start: number; end: number; ms: number; running: boolean; src: ReportPreparedSpan }>()
      : null;

    for (const sl of slices) {
      const src = byId.get(sl.id);
      if (!src || src.pending) continue;
      recordedMs += sl.ms;

      const curCat = catMap.get(src.topCatId);
      if (curCat) curCat.ms += sl.ms;
      else catMap.set(src.topCatId, { id: src.topCatId, name: src.topCatName, ms: sl.ms });

      if (needDetail) {
        const rKey = src.routeId ?? "__none";
        byRouteInRange[rKey] = (byRouteInRange[rKey] ?? 0) + sl.ms;

        if (blockAgg) {
          const clipStart = Math.max(src.start, w.start);
          const clipEnd = Math.min(src.end ?? now, effEnd);
          const isRunning = src.end === null && effEnd >= now;
          const prev = blockAgg.get(sl.id);
          if (prev) {
            prev.start = Math.min(prev.start, clipStart);
            prev.end = Math.max(prev.end, clipEnd);
            prev.ms += sl.ms;
            if (isRunning) prev.running = true;
          } else {
            blockAgg.set(sl.id, { start: clipStart, end: clipEnd, ms: sl.ms, running: isRunning, src });
          }
        }
      }
    }

    byDay[d] = recordedMs;
    const sortedCats = [...catMap.values()].sort((a, b) => b.ms - a.ms);
    if (d === today) {
      todayCats = sortedCats;
    }
    if (needDetail && blockAgg) {
      const blocks: ReportDayBlockItem[] = [...blockAgg.values()]
        .sort((a, b) => a.start - b.start)
        .map((b) => ({
          id: b.src.id,
          startClock: fmtWallHm(b.start),
          endClock: b.running ? null : fmtWallHm(b.end),
          running: b.running,
          durMs: b.ms,
          categoryName: b.src.categoryName,
          taskName: b.src.taskName,
          routeId: b.src.routeId,
          note: b.src.note,
          location: b.src.location ?? null,
        }));
      dayDetails[d] = {
        totalMs: recordedMs,
        cats: topFourCats(sortedCats),
        blocks,
      };
    }
  }

  // 上週同一天、到同一個時刻為止
  const prevWin = winOf(addDays(today, -7), h);
  const elapsed = Math.max(0, now - winOf(today, h).start);
  const prevEnd = Math.min(prevWin.end, prevWin.start + elapsed, now);
  let prevSameSpanMs = 0;
  if (prevEnd > prevWin.start) {
    const prevEligible = rawSpans.filter((s) => s.start < prevEnd && (s.end ?? now) > prevWin.start);
    for (const sl of sliceSpans(prevEligible, { start: prevWin.start, end: prevEnd }, now)) {
      const src = byId.get(sl.id);
      if (src && !src.pending) prevSameSpanMs += sl.ms;
    }
  }

  return { byDay, todayCats, prevSameSpanMs, dayDetails, byRouteInRange };
}
