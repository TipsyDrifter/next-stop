/**
 * stats/format——統計頁與目標面板共用的顯示換算（③ 契約 §5.2；乙席）。
 * 只做「資料 → 字／顏色」；字一律從 `TT_TEXT` 取（顯示端不手抄），日期換算用日界線日 key（YYYY-MM-DD）。
 */
import { useMemo } from "react";
import { colorSlot, fmtClock, fmtDur, type TimeCategoryRow } from "../../../domain/timetable";
import { periodWindow, type Goal, type StatsPeriod } from "../../../domain/timetableStats";
import { addDays, todayKey } from "../../../lib/date";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { useTagStore } from "../../../store/tagStore";

const T = TT_TEXT.statsUi;

const parts = (k: string): [number, number, number] => {
  const [y, m, d] = k.split("-").map(Number);
  return [y, m, d];
};

/** 「10/19」 */
export function md(k: string): string {
  const [, m, d] = parts(k);
  return `${m}/${d}`;
}

/** 「10/19（日）」 */
export function mdw(k: string): string {
  const [y, m, d] = parts(k);
  return `${m}/${d}（${T.weekdays[new Date(y, m - 1, d).getDay()]}）`;
}

/** 時刻戳 → 「10/19」（本地日曆日；給「10/5（一）06:00」這種用） */
export function mdwOfMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}（${T.weekdays[d.getDay()]}）`;
}

/** 分類色（D-時-63：一律用子分類自己的 color_idx；找不到＝第 8 色） */
export function catColor(c: TimeCategoryRow | null | undefined): string {
  return `var(--ns-tt-cat-${c ? colorSlot(c.color_idx) : 8})`;
}

/** 期名與小標（§5.2-1）：日「10/19（日）今天」、週「10/13–10/19 本週」、月「2026 年 10 月 本月」 */
export function periodName(p: StatsPeriod, key: string, today: string, h: number, ws: 0 | 1): { name: string; tag: string } {
  if (p === "day") return { name: mdw(key), tag: key === today ? T.tagToday : key === addDays(today, -1) ? T.tagYesterday : "" };
  const cur = periodWindow(p, today, h, ws).key;
  if (p === "week") {
    return { name: `${md(key)}–${md(addDays(key, 6))}`, tag: key === cur ? T.tagThisWeek : key === addDays(cur, -7) ? T.tagLastWeek : "" };
  }
  const [y, m] = parts(key);
  const [cy, cm] = parts(cur);
  const prev = cm === 1 ? [cy - 1, 12] : [cy, cm - 1];
  return { name: T.monthName(y, m), tag: key === cur ? T.tagThisMonth : y === prev[0] && m === prev[1] ? T.tagLastMonth : "" };
}

/** 趨勢直條的 x 軸字（日 M/D；週＝週首 M/D；月「10 月」） */
export function trendTick(p: StatsPeriod, key: string): string {
  return p === "month" ? T.monthShort(parts(key)[1]) : md(key);
}

/** 趨勢明細的期名（日「10/13（一）」、週「10/13–10/19」、月「2026 年 10 月」） */
export function trendLabel(p: StatsPeriod, key: string): string {
  if (p === "day") return mdw(key);
  if (p === "week") return `${md(key)}–${md(addDays(key, 6))}`;
  const [y, m] = parts(key);
  return T.monthName(y, m);
}

/**
 * 環比總述下一行的淡字（收官磨光 A4／體檢 S6 改成一句白話）：
 *   同期＝「比的是上週同一段時間：10/5（一）06:00 – 10/9（五）15:42」（同一天的起訖只寫一次日期：「10/27（二）06:00 – 18:22」）；
 *   整期＝「比的是上週整週：10/12–10/18」
 */
export function compareSpanText(p: StatsPeriod, prev: { start: number; end: number }, same: boolean, prevKey: string): string {
  if (same) {
    const d0 = mdwOfMs(prev.start);
    const d1 = mdwOfMs(prev.end - 1);
    const to = d1 === d0 ? fmtClock(prev.end) : `${d1} ${fmtClock(prev.end)}`;
    return T.cmpSame(p, `${d0} ${fmtClock(prev.start)} – ${to}`);
  }
  return T.cmpWhole(p, trendLabel(p, prevKey));
}

/** 目標的期間與方向（§5.2-5）：「每週至多 20h」「自 10/1 起至少 180h」「到 12/31 為止至少 60h」「11/1–11/30 至少 40h」 */
export function goalPeriodText(g: Pick<Goal, "period" | "direction" | "targetMin" | "startOn" | "endOn">): string {
  const target = T.goalTarget(TT_TEXT.goalDirectionWord[g.direction], fmtDur(g.targetMin * 60_000));
  if (g.period === "since") return T.goalSince(g.startOn ? md(g.startOn) : "？", target);
  if (g.period === "until") return T.goalUntil(g.endOn ? md(g.endOn) : "？", target);
  if (g.period === "range") return T.goalRange(g.startOn ? md(g.startOn) : "？", g.endOn ? md(g.endOn) : "？", target);
  return T.goalRepeat(TT_TEXT.goalPeriodWord[g.period], target);
}

/**
 * 範圍字：分類名「・」串；超過 3 個「創作・學習…等 4 類」。
 * ⑥ D-時-122：`tagNames`（荷札顯示名，不含 #）接在分類後面、帶 #：「創作・學習・#高效」；混了荷札超過 3 項「創作・學習…等 4 項」。
 */
export function scopeText(ids: readonly string[], catById: Record<string, TimeCategoryRow>, tagNames: readonly string[] = []): string {
  const names = ids.map((id) => catById[id]?.name ?? T.catGone).concat(tagNames.map((n) => TT_TEXT.tags.chip(n)));
  if (names.length <= 3) return names.join("・");
  const head = names.slice(0, 2).join("・");
  return tagNames.length ? TT_TEXT.tags.scopeMore(head, names.length) : T.scopeMore(head, names.length);
}

/**
 * ⑥：荷札 key → 顯示名（不含 #；`tagStore.index.byKey[k].name`，index 沒載或找不到＝key 本身）。
 * 換 index（改名、刪除、載入）才換函式。
 */
export function useTagNameOf(): (key: string) => string {
  const index = useTagStore((s) => s.index);
  return useMemo(() => (k: string) => index?.byKey[k]?.name ?? k, [index]);
}

/** 現在的日界線日、日界線、週起點（畫面算「本期」「今天」用；每分鐘跟著 now 變） */
export function useDayContext(now: number): { today: string; h: number; ws: 0 | 1 } {
  const h = useUiStore((s) => s.dayStartHour);
  const ws = useUiStore((s) => s.weekStart);
  const today = todayKey(h, new Date(now));
  return useMemo(() => ({ today, h, ws }), [today, h, ws]);
}

/** 分類 id → 列（含已刪除、已封存；找不到＝undefined） */
export function useCatById(): Record<string, TimeCategoryRow> {
  return useTimetableStore((s) => s.catById);
}
