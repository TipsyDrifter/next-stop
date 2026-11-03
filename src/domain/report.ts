/**
 * report——運行報告的純函式（② 運行報告；契約 `docs/research/2026-11-02-主線-運行報告-契約.md` §3、§4、§7）。
 *
 * `buildOperationReport(facts, now)`：吃一包已經讀好的事實（`data/reportFacts.ts` 讀），吐整頁要畫的東西——
 * 上半五張卡（只答今天）、今日小結、下半「每日運行實績」的每一列（含每週合計）。不碰 store、不碰 DB、不讀時鐘（now 由呼叫端給）。
 *
 * 口徑（契約）：
 *   - 済＝domain/seals.ts（D-主-181）；照日界線歸日。
 *   - 卡片的比較＝「比上週同一天」到同一個時刻為止（今天還沒過完，拿整天比會永遠落後；同時刻表統計的環比口徑 D-時-45）。
 *   - 誤點按日歸屬（D-主-187）：今日頁誤點區的每張票歸到原本排的那天；今天那列不標。
 *   - 每週合計（D-主-186）：目前這週一定有、過去的週要完整七天；目前這週沒過完時比上週同一段（同樣天數）。
 *
 * 本檔只 import lib/date（日期換算）；probe 與 node 測試直接載入。
 */
import { addDays, dayKeyOf, dayWindow } from "../lib/date.ts";

/* ═══════════ 事實（讀進來的東西） ═══════════ */

export interface ReportRouteRef {
  id: string;
  name: string;
  code: string | null;
  color: string | null;
}

/** 接下來 7 天的一個締切（未完成） */
export interface ReportDue {
  day: string;
  nodeId: string;
  name: string;
  routeId: string | null;
  /** 臨時車票（沒有 parent）：圓牌畫虛線「臨」 */
  temp: boolean;
}

/** 時刻表（沒通車＝null）：每天的已記錄（同時刻表統計：不含待確認與碎塊） */
export interface ReportTimeFacts {
  byDay: Readonly<Record<string, number>>;
  /** 今天的分類（已記錄 ms，大到小） */
  todayCats: readonly { id: string; name: string; ms: number }[];
  /** 上週同一天、到同一個時刻為止的已記錄 */
  prevSameSpanMs: number;
}

/** 售票口（沒通車＝null） */
export interface ReportMoneyFacts {
  /** 支出（主幣別淨額；退款是負的）：一筆一列 */
  expenses: readonly { day: string; at: string; minor: number; category: string }[];
  /** 主幣別的小數位 */
  decimals: number;
  /** 這個月的總預算（沒設＝null） */
  budget: { month: string; budget: number; used: number; remaining: number } | null;
}

/** 旅客筆記（沒通車＝null） */
export interface ReportNotesFacts {
  /** 筆記（kind='note'，含收件匣的一句）的寫下時刻 */
  notedAt: readonly string[];
  /** 有日記的日子 */
  diaryDays: readonly string[];
}

export interface ReportFacts {
  /** 今天（日界線日） */
  today: string;
  dayStartHour: number;
  weekStart: 0 | 1;
  /** 表格天數 */
  days: 7 | 30;
  /** 済章（seals.ts 口徑、已去重）：從 `factsFrom(today)` 到今天 */
  seals: readonly { at: string; nodeId: string; routeId: string | null }[];
  /** 今日頁誤點區的票，歸到原本排的那天 */
  late: readonly { day: string }[];
  /** 今天起 7 天內的締切（未完成），日期升冪 */
  dueSoon: readonly ReportDue[];
  /** 每天到締切的票數（不分完成與否） */
  dueByDay: Readonly<Record<string, number>>;
  routes: Readonly<Record<string, ReportRouteRef>>;
  time: ReportTimeFacts | null;
  money: ReportMoneyFacts | null;
  notes: ReportNotesFacts | null;
  /** 一年前的今天（沒有＝null） */
  yearAgo: { day: string; text: string } | null;
  /** 記事欄（③ 的 stamps）；沒有任何來源＝null（整欄不畫） */
  dayNotes: Readonly<Record<string, readonly string[]>> | null;
}

/** 事實要從哪一天讀起：近 30 天＋最舊那個完整週的上一週（37 天前） */
export const FACTS_BACK_DAYS = 36;
export function factsFrom(today: string): string {
  return addDays(today, -FACTS_BACK_DAYS);
}

/* ═══════════ 產出（畫面要的東西） ═══════════ */

export interface ReportBrief {
  seals: number;
  /** 時刻表沒通車＝null */
  recordedMs: number | null;
  /** 售票口沒通車＝null */
  spent: number | null;
  decimals: number;
}

export interface ReportRideCard {
  seals: number;
  late: number;
  /** 今天跑的路線：済按路線分組、多到少，最多 4 列；routeId null＝臨時車票 */
  routes: readonly { routeId: string | null; n: number }[];
  /** 比上週同一天（到同一個時刻） */
  cmp: number;
}
export interface ReportTimeCard {
  ms: number;
  /** 前三個分類＋「其他」（id "__other"） */
  cats: readonly { id: string; name: string; ms: number }[];
  cmp: number;
}
export interface ReportMoneyCard {
  spent: number;
  /** 今天最大的兩個分類 */
  topCats: readonly { name: string; minor: number }[];
  budget: ReportMoneyFacts["budget"];
  decimals: number;
  cmp: number;
}
export interface ReportNotesCard {
  count: number;
  diary: boolean;
  cmp: number;
}
export interface ReportDueCard {
  count: number;
  items: readonly ReportDue[];
}

export interface ReportDayRow {
  kind: "day";
  day: string;
  isToday: boolean;
  seals: number;
  /** 歸到這天的誤點（今天恆 0） */
  late: number;
  timeMs: number | null;
  spent: number | null;
  notes: number | null;
  diary: boolean;
  due: number;
  dayNotes: readonly string[];
}

export interface ReportSumRow {
  kind: "sum";
  /** this＝本週、last＝上週、week＝更早的週（weekOf＝那週第一天） */
  which: "this" | "last" | "week";
  weekOf: string;
  /** 近 7 天最後的「上週合計」參考列（不比較） */
  reference: boolean;
  seals: number;
  timeMs: number | null;
  spent: number | null;
  notes: number | null;
  diaryDays: number;
  due: number;
  /** null＝不比較（參考列、或上一週不在讀進來的範圍） */
  cmp: { seals: number; timeMs: number | null; spent: number | null; notes: number | null } | null;
  /** 「比上週」或「比上週同期」（目前這週還沒過完） */
  cmpLabel: string | null;
}

export type ReportRow = ReportDayRow | ReportSumRow;

export interface OperationReport {
  today: string;
  brief: ReportBrief;
  ride: ReportRideCard;
  time: ReportTimeCard | null;
  money: ReportMoneyCard | null;
  notes: ReportNotesCard | null;
  due: ReportDueCard;
  yearAgo: { day: string; text: string } | null;
  rows: readonly ReportRow[];
  /** 記事欄要不要畫 */
  hasDayNotes: boolean;
  /** 表格細長條的分母（表裡最大的那天；0＝不畫） */
  max: { seals: number; timeMs: number; spent: number };
}

/* ═══════════ 小工具 ═══════════ */

/** YYYY-MM-DD 是星期幾（0＝日） */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** 這一天所在那週的第一天（weekStart：0＝週日、1＝週一） */
export function weekStartOf(day: string, weekStart: 0 | 1): string {
  return addDays(day, -((weekdayOf(day) - weekStart + 7) % 7));
}

const startMs = (day: string, h: number): number => new Date(dayWindow(day, h).start).getTime();

/** 「到同一個時刻為止」：時刻戳離那天日界線開頭的毫秒數 ≤ cut */
function withinCut(iso: string, day: string, h: number, cut: number): boolean {
  return new Date(iso).getTime() - startMs(day, h) <= cut;
}

function bump(map: Record<string, number>, k: string, n = 1): void {
  map[k] = (map[k] ?? 0) + n;
}

/* ═══════════ 主函式 ═══════════ */

export function buildOperationReport(f: ReportFacts, now: number): OperationReport {
  const { today, dayStartHour: h } = f;
  const lastWeekDay = addDays(today, -7);
  const cut = Math.max(0, now - startMs(today, h)); // 今天已經過了多久

  /* ── 每天的數字 ── */
  const sealsByDay: Record<string, number> = {};
  for (const s of f.seals) bump(sealsByDay, dayKeyOf(s.at, h));
  const lateByDay: Record<string, number> = {};
  for (const l of f.late) if (l.day < today) bump(lateByDay, l.day);
  const spentByDay: Record<string, number> = {};
  if (f.money) for (const e of f.money.expenses) bump(spentByDay, e.day, e.minor);
  const notesByDay: Record<string, number> = {};
  if (f.notes) for (const at of f.notes.notedAt) bump(notesByDay, dayKeyOf(at, h));
  const diarySet = new Set(f.notes?.diaryDays ?? []);

  /* ── 上半：卡片（只答今天；比較＝上週同一天到同一個時刻） ── */
  const todaySeals = f.seals.filter((s) => dayKeyOf(s.at, h) === today);
  const prevSeals = f.seals.filter((s) => dayKeyOf(s.at, h) === lastWeekDay && withinCut(s.at, lastWeekDay, h, cut)).length;
  const byRoute = new Map<string | null, number>();
  for (const s of todaySeals) {
    const k = s.routeId !== null && f.routes[s.routeId] ? s.routeId : null;
    byRoute.set(k, (byRoute.get(k) ?? 0) + 1);
  }
  const routes = [...byRoute.entries()]
    .map(([routeId, n]) => ({ routeId, n }))
    // 多到少；同數時有路線的在前、再照路線名
    .sort((a, b) => b.n - a.n || (a.routeId === null ? 1 : 0) - (b.routeId === null ? 1 : 0) || nameOf(f, a.routeId).localeCompare(nameOf(f, b.routeId)))
    .slice(0, 4);
  const ride: ReportRideCard = { seals: todaySeals.length, late: f.late.length, routes, cmp: todaySeals.length - prevSeals };

  let time: ReportTimeCard | null = null;
  if (f.time) {
    const ms = f.time.byDay[today] ?? 0;
    const sorted = [...f.time.todayCats].filter((c) => c.ms > 0).sort((a, b) => b.ms - a.ms);
    const cats = sorted.length > 4 ? [...sorted.slice(0, 3), { id: "__other", name: "其他", ms: sorted.slice(3).reduce((a, c) => a + c.ms, 0) }] : sorted;
    time = { ms, cats, cmp: ms - f.time.prevSameSpanMs };
  }

  let money: ReportMoneyCard | null = null;
  if (f.money) {
    const todayExp = f.money.expenses.filter((e) => e.day === today);
    const spent = todayExp.reduce((a, e) => a + e.minor, 0);
    const prev = f.money.expenses.filter((e) => e.day === lastWeekDay && withinCut(e.at, lastWeekDay, h, cut)).reduce((a, e) => a + e.minor, 0);
    const byCat = new Map<string, number>();
    for (const e of todayExp) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.minor);
    const topCats = [...byCat.entries()]
      .filter(([, minor]) => minor > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([name, minor]) => ({ name, minor }));
    money = { spent, topCats, budget: f.money.budget, decimals: f.money.decimals, cmp: spent - prev };
  }

  let notes: ReportNotesCard | null = null;
  if (f.notes) {
    const count = notesByDay[today] ?? 0;
    const prev = f.notes.notedAt.filter((at) => dayKeyOf(at, h) === lastWeekDay && withinCut(at, lastWeekDay, h, cut)).length;
    notes = { count, diary: diarySet.has(today), cmp: count - prev };
  }

  const dueSoon = f.dueSoon.filter((d) => d.day >= today && d.day <= addDays(today, 6));
  const due: ReportDueCard = { count: dueSoon.length, items: dueSoon.slice(0, 3) };

  /* ── 下半：每日運行實績 ── */
  const dayRow = (day: string): ReportDayRow => ({
    kind: "day",
    day,
    isToday: day === today,
    seals: sealsByDay[day] ?? 0,
    late: day < today ? lateByDay[day] ?? 0 : 0,
    timeMs: f.time ? f.time.byDay[day] ?? 0 : null,
    spent: f.money ? spentByDay[day] ?? 0 : null,
    notes: f.notes ? notesByDay[day] ?? 0 : null,
    diary: diarySet.has(day),
    due: f.dueByDay[day] ?? 0,
    dayNotes: f.dayNotes?.[day] ?? [],
  });
  const floor = factsFrom(today);
  /** 一段日子（含兩端）的合計；超出讀進來的範圍＝null */
  const sumOf = (from: string, to: string) => {
    if (from < floor) return null;
    let seals = 0;
    let timeMs = 0;
    let spent = 0;
    let notesN = 0;
    let diaryDays = 0;
    let dueN = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = dayRow(d);
      seals += r.seals;
      timeMs += r.timeMs ?? 0;
      spent += r.spent ?? 0;
      notesN += r.notes ?? 0;
      if (r.diary) diaryDays++;
      dueN += r.due;
    }
    return {
      seals,
      timeMs: f.time ? timeMs : null,
      spent: f.money ? spent : null,
      notes: f.notes ? notesN : null,
      diaryDays,
      due: dueN,
    };
  };
  const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);

  const rows: ReportRow[] = [];
  const thisWeek = weekStartOf(today, f.weekStart);
  const oldest = addDays(today, -(f.days - 1));
  let cursor = today;
  while (cursor >= oldest) {
    const wk = weekStartOf(cursor, f.weekStart);
    const groupEnd = cursor;
    const groupStart = wk > oldest ? wk : oldest;
    for (let d = groupEnd; d >= groupStart; d = addDays(d, -1)) rows.push(dayRow(d));
    const complete = groupStart === wk && addDays(wk, 6) === groupEnd;
    const isThis = wk === thisWeek;
    if (isThis || complete) {
      const cur = sumOf(groupStart, groupEnd)!;
      // 目前這週沒過完：比上週同樣天數；完整的週：比上一整週
      const span = isThis ? Math.round((new Date(groupEnd).getTime() - new Date(wk).getTime()) / 86_400_000) : 6;
      const prevStart = addDays(wk, -7);
      const prev = sumOf(prevStart, addDays(prevStart, span));
      rows.push({
        kind: "sum",
        which: isThis ? "this" : wk === addDays(thisWeek, -7) ? "last" : "week",
        weekOf: wk,
        reference: false,
        ...cur,
        cmp: prev
          ? { seals: cur.seals - prev.seals, timeMs: diff(cur.timeMs, prev.timeMs), spent: diff(cur.spent, prev.spent), notes: diff(cur.notes, prev.notes) }
          : null,
        cmpLabel: prev ? (span < 6 ? "比上週同期" : "比上週") : null,
      });
    }
    cursor = addDays(groupStart, -1);
  }
  if (f.days === 7) {
    const lw = addDays(thisWeek, -7);
    const ref = sumOf(lw, addDays(lw, 6));
    if (ref) rows.push({ kind: "sum", which: "last", weekOf: lw, reference: true, ...ref, cmp: null, cmpLabel: null });
  }

  const dayRows = rows.filter((r): r is ReportDayRow => r.kind === "day");
  const max = {
    seals: Math.max(0, ...dayRows.map((r) => r.seals)),
    timeMs: Math.max(0, ...dayRows.map((r) => r.timeMs ?? 0)),
    spent: Math.max(0, ...dayRows.map((r) => r.spent ?? 0)),
  };

  return {
    today,
    brief: {
      seals: ride.seals,
      recordedMs: time ? time.ms : null,
      spent: money ? money.spent : null,
      decimals: f.money?.decimals ?? 0,
    },
    ride,
    time,
    money,
    notes,
    due,
    yearAgo: f.yearAgo,
    rows,
    hasDayNotes: f.dayNotes !== null,
    max,
  };
}

function nameOf(f: ReportFacts, routeId: string | null): string {
  return routeId === null ? "" : f.routes[routeId]?.name ?? "";
}

/* ═══════════ 一年前的今天 ═══════════ */

/** 去年同月同日；去年沒有這一天（2/29）＝null */
export function yearAgoDay(today: string): string | null {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(y - 1, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 一則筆記／日記的一行：標題，沒有就取內文第一個非空行（去掉 Markdown 的開頭記號） */
export function oneLine(title: string | null | undefined, body: string | null | undefined): string {
  const t = (title ?? "").trim();
  if (t) return t;
  for (const raw of (body ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)/, "").trim();
    if (line) return line;
  }
  return "";
}

/* ═══════════ 顯示字 ═══════════ */

/** 比較的寫法：「▲3」「▼65」，差 0「持平」；fmt 把絕對值排成字 */
export function deltaText(n: number, fmt: (abs: number) => string = String): string {
  if (n === 0) return "持平";
  return (n > 0 ? "▲" : "▼") + fmt(Math.abs(n));
}
