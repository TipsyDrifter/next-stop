/**
 * 售票口線・第②階段「看帳」的純函式（契約 2026-10-15 §4；甲席 Stage 0 全文實作）。
 *
 * 只讀 `EntryRow`、不產生寫入；與 ①b 修正會動的 `ticket.ts` 分檔（契約 0-5）。
 * 鐵則同 ①§4：只用可剝除語法；金額一律最小單位整數（`share` 是比例才用浮點）；日 key 字串運算不經 `Date.parse`；
 * lib 目標 ES2020。只 `import` 自 `./ticket`、`import type` 自 `./node`——`scripts/tests/ticket-view-logic.test.ts` 以 node 直接載入。
 *
 * 數字口徑（契約 0-7）：只算未刪；轉帳與校正不入收支；支出＝expense 的 `main_minor` 合計（退款是負的、自然抵回，
 * 所以支出可能為負）；收入＝income 的 `main_minor` 合計；淨額＝收入 − 支出；外幣一律 `main_minor`（不用現在的匯率重算）；
 * 封存的帳戶與分類照算。這一條口徑統計、月曆、趨勢、路線花費共用，與 ①的 `groupByDay`／`monthSum` 同義。
 *
 * 內容：
 *   §4.1 型別、常數、文案（VIEW_TEXT：store 的 TK_TEXT 引用同一份）
 *   §4.2 期間          §4.3 統計（總覽、趨勢、占比）
 *   §4.4 月曆          §4.5 搜尋與篩選（結構五欄＋關鍵字）
 *   §4.6 路線花費
 */
import {
  MAIN_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  addMonths,
  catKey,
  categoryLabel,
  categoryTree,
  monthOf,
  monthRange,
  monthTitle,
  moneyText,
  normalizeInput,
  orderAccounts,
  type CategoryRow,
  type DayGroup,
  type EntryCtx,
  type EntryKind,
  type EntryRow,
} from "./ticket";
import type { NodeRow } from "./node";

/* ───────────────────────── §4.1 型別與常數 ───────────────────────── */

export type TicketView = "list" | "calendar" | "stats";
export type StatsSpan = "month" | "year";
export type Facet = "category" | "account" | "route";
/** key：月＝"2026-10"、年＝"2026" */
export interface Period {
  span: StatsSpan;
  key: string;
}
export const TREND_MONTHS = 12;
export const RESULT_PAGE = 300; // 0-14 一次畫幾筆
export const COMPACT_FROM = 100_000; // 0-22：主單位 ≥ 這個數就縮寫
export const NO_ROUTE_KEY = "__none__";
export const GONE_KEY = "__gone__"; // 分類／帳戶／路線已不在
export const UNSPLIT_KEY = "__unsplit__"; // 直接記在主分類本身

/** 路線的最小形狀（從 nodeStore.routes 抄過來；不依賴 NodeRow 全欄） */
export interface RouteRef {
  id: string;
  name: string;
  code: string | null;
  color: string | null;
}
export interface ViewCtx extends EntryCtx {
  routeById: Readonly<Record<string, RouteRef>>;
  routeOrder: readonly string[];
}

/** 主幣別；count＝收支筆數（轉帳校正不算） */
export interface Overview {
  income: number;
  expense: number;
  net: number;
  count: number;
}
export interface TrendPoint {
  month: string;
  income: number;
  expense: number;
}
export interface BreakdownRow {
  key: string; // 分類 id／帳戶 id／路線 id／NO_ROUTE_KEY／GONE_KEY／UNSPLIT_KEY
  label: string; // 分類名（子分類不帶父名）／帳戶名／路線名（代碼由 UI 畫 roundel）
  minor: number; // 淨額（主幣別）
  share: number; // 0～1；淨額 ≤ 0 ⇒ 0
  count: number;
  children?: BreakdownRow[]; // 分類切面、且有子分類列的主分類才有（含 UNSPLIT_KEY 那列）
  color?: string | null; // 路線切面給路線色
}
/** total＝分母（所有淨額 > 0 的主列合計）；refunds＝淨額 ≤ 0 的主列（淨退回小字區） */
export interface Breakdown {
  rows: BreakdownRow[];
  total: number;
  refunds: BreakdownRow[];
}
export interface StatsData {
  period: Period;
  overview: Overview;
  trend: TrendPoint[];
  breakdown: Breakdown;
}
export interface CalendarCell {
  dayKey: string;
  inMonth: boolean;
  isToday: boolean;
  income: number;
  expense: number;
  count: number;
}
export interface EntryFilter {
  text: string;
  from: string | null;
  toExcl: string | null;
  accountId: string | null;
  categoryIds: readonly string[]; // 使用者勾的（主分類勾＝只存主分類 id；給 SQL 時用 categoryIdsIncluding 展開）
  kinds: readonly EntryKind[];
  routeId: string | null | "none";
}
/** 結構條件的查詢（契約 §3.2；`TicketRepository.queryEntries` 的參數）。全部為空＝全部未刪的帳 */
export interface EntryQuery {
  from: string | null; // occurred_on >= from
  toExcl: string | null; // occurred_on <  toExcl
  accountId: string | null; // account_id = ? OR to_account_id = ?
  categoryIds: readonly string[]; // 空＝不限；已展開成含子分類
  kinds: readonly EntryKind[]; // 空＝不限
  routeId: string | null | "none"; // null＝不限；"none"＝route_id IS NULL
}
/** 關鍵字的一個 token（契約 §4.5「數字 token 另記 { raw, isNumber }」）：key＝catKey 化的比對鍵 */
export interface KeywordToken {
  key: string;
  raw: string;
  isNumber: boolean;
}

export const EMPTY_FILTER: EntryFilter = {
  text: "",
  from: null,
  toExcl: null,
  accountId: null,
  categoryIds: [],
  kinds: [],
  routeId: null,
};

/** 看帳的文案（契約 §3.4 TK_TEXT 新鍵、§5.5）；store 的 TK_TEXT 引用這一份，顯示端不手抄 */
export const VIEW_TEXT = {
  found: (n: number, exp: string, inc: string) => `找到 ${n} 筆 · 支出 ${exp} · 收入 ${inc}`,
  noDay: (d: string) => `${d} 沒有紀錄`,
  spend: (m: string, t: string) => `本月 ${m}／累計 ${t}`,
  aside: (m: string) => `本月 ${m}`,
  spendDetail: "看明細",
  noRoute: "未掛路線",
  routeGone: "（路線已刪除）",
  catGone: "（分類已不在）",
  accGone: "（帳戶已不在）",
  unsplit: "未細分",
  refunds: "淨退回",
  emptyStats: "這段期間沒有收支",
  emptyResults: "沒有符合的帳",
  more: (n: number) => `再顯示 ${n} 筆`,
} as const;

const KIND_LABEL: Readonly<Record<EntryKind, string>> = { expense: "支出", income: "收入", transfer: "轉帳", adjust: "校正" };
const KIND_ORDER: readonly EntryKind[] = ["expense", "income", "transfer", "adjust"];

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isUncat = (id: string): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;
const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;

/** 主幣別的小數位（curByCode 找 is_main；沒有＝2） */
function mainDecimals(ctx: EntryCtx): number {
  for (const code in ctx.curByCode) {
    const c = ctx.curByCode[code];
    if (c.is_main === 1) return c.decimals;
  }
  return ctx.curByCode[MAIN_CURRENCY]?.decimals ?? 2;
}

/** nodeStore.routes → ViewCtx 的路線兩欄（側欄順序） */
export function routeCtx(routes: readonly NodeRow[]): { routeById: Record<string, RouteRef>; routeOrder: string[] } {
  const routeById: Record<string, RouteRef> = {};
  const routeOrder: string[] = [];
  for (const r of routes) {
    if (r.deleted_at !== null) continue;
    routeById[r.id] = { id: r.id, name: r.name, code: r.code, color: r.color };
    routeOrder.push(r.id);
  }
  return { routeById, routeOrder };
}

/* ───────────────────────── §4.2 期間（0-6） ───────────────────────── */

export function periodOf(month: string, span: StatsSpan): Period {
  return span === "year" ? { span, key: month.slice(0, 4) } : { span, key: month };
}

function yearKey(y: number): string {
  return String(y).padStart(4, "0");
}

export function periodRange(p: Period): { from: string; toExcl: string } {
  if (p.span === "month") return monthRange(p.key);
  const y = parseInt(p.key, 10);
  return { from: `${p.key}-01-01`, toExcl: `${yearKey(y + 1)}-01-01` };
}

/** "2026 年 10 月"／"2026 年" */
export function periodTitle(p: Period): string {
  return p.span === "month" ? monthTitle(p.key) : `${parseInt(p.key, 10)} 年`;
}

export function stepPeriod(p: Period, n: number): Period {
  return p.span === "month" ? { span: "month", key: addMonths(p.key, n) } : { span: "year", key: yearKey(parseInt(p.key, 10) + n) };
}

/** 月＝選中月往前 11 個月到選中月（舊到新）；年＝該年 1～12 月 */
export function trendMonths(p: Period): string[] {
  const out: string[] = [];
  if (p.span === "month") {
    for (let i = TREND_MONTHS - 1; i >= 0; i--) out.push(addMonths(p.key, -i));
  } else {
    for (let m = 1; m <= 12; m++) out.push(`${p.key}-${pad2(m)}`);
  }
  return out;
}

/** trendMonths 第一個月的 from 到最後一個月的 toExcl（一定涵蓋 periodRange） */
export function trendRange(p: Period): { from: string; toExcl: string } {
  const ms = trendMonths(p);
  return { from: monthRange(ms[0]).from, toExcl: monthRange(ms[ms.length - 1]).toExcl };
}

export function inRange(dayKey: string, r: { from: string; toExcl: string }): boolean {
  return dayKey >= r.from && dayKey < r.toExcl;
}

/* ───────────────────────── §4.3 統計（0-7～0-9） ───────────────────────── */

/** 期間內的收入／支出／淨額／收支筆數；與 `monthSum(entries, month)` 同義 */
export function statsOverview(entries: readonly EntryRow[], r: { from: string; toExcl: string }): Overview {
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const e of entries) {
    if (e.deleted_at !== null || !inRange(e.occurred_on, r)) continue;
    if (e.kind === "income") {
      income += e.main_minor;
      count++;
    } else if (e.kind === "expense") {
      expense += e.main_minor;
      count++;
    }
  }
  return { income, expense, net: income - expense, count };
}

/** 每月一點，口徑同 statsOverview；沒帳的月 0／0；順序＝months 的順序 */
export function monthlyTrend(entries: readonly EntryRow[], months: readonly string[]): TrendPoint[] {
  const byMonth: Record<string, TrendPoint> = {};
  const out: TrendPoint[] = months.map((m) => (byMonth[m] = { month: m, income: 0, expense: 0 }));
  for (const e of entries) {
    if (e.deleted_at !== null) continue;
    const p = byMonth[monthOf(e.occurred_on)];
    if (!p) continue;
    if (e.kind === "income") p.income += e.main_minor;
    else if (e.kind === "expense") p.expense += e.main_minor;
  }
  return out;
}

interface Acc {
  key: string;
  label: string;
  minor: number;
  count: number;
  color?: string | null;
  kids?: Record<string, Acc>;
  /** 同額時的自然順序（越小越前） */
  order: number;
  /** 0＝一般、1＝未分類、2＝GONE（分類切面固定排在最後；其他切面恆 0） */
  tail: number;
}

function bump(map: Record<string, Acc>, key: string, init: () => Omit<Acc, "minor" | "count">, minor: number): Acc {
  let a = map[key];
  if (!a) {
    a = { ...init(), minor: 0, count: 0 };
    map[key] = a;
  }
  a.minor += minor;
  a.count++;
  return a;
}

const byAmount = (a: Acc, b: Acc): number => a.tail - b.tail || b.minor - a.minor || a.order - b.order || cmpStr(a.key, b.key);

function toRow(a: Acc, total: number, positiveParent: boolean): BreakdownRow {
  const row: BreakdownRow = {
    key: a.key,
    label: a.label,
    minor: a.minor,
    // 子列的分母是整個切面的 total：主分類為正、某兄弟子分類淨退回時，正的子列會大於 total ⇒ 夾到 1（§4.1 share 0～1）
    share: positiveParent && a.minor > 0 && total > 0 ? Math.min(1, a.minor / total) : 0,
    count: a.count,
  };
  if (a.color !== undefined) row.color = a.color;
  return row;
}

/**
 * 占比（0-8）：只取 `kind` 那種、期間內、未刪的帳，依切面分組。
 * 分類切面兩層（主分類列＝自己＋子分類；有子分類列時另出「未細分」＝直接記在主分類本身的帳）；
 * 未分類固定在一般列之後、GONE 在未分類之後；其他切面金額大到小、同額照自然順序。
 * total＝所有 minor > 0 的主列合計；minor ≤ 0 的主列（連同 children）移到 refunds、share 0。
 */
export function breakdown(entries: readonly EntryRow[], r: { from: string; toExcl: string }, facet: Facet, kind: "expense" | "income", ctx: ViewCtx): Breakdown {
  const map: Record<string, Acc> = {};
  const big = Number.MAX_SAFE_INTEGER;

  // 自然順序
  const catOrder: Record<string, number> = {};
  if (facet === "category") {
    const tree = categoryTree(Object.keys(ctx.catById).map((k) => ctx.catById[k]), kind, { includeArchived: true });
    let i = 0;
    for (const t of tree) {
      catOrder[t.parent.id] = i++;
      for (const c of t.children) catOrder[c.id] = i++;
    }
  }
  const accOrder: Record<string, number> = {};
  if (facet === "account") {
    orderAccounts(Object.keys(ctx.accById).map((k) => ctx.accById[k])).forEach((a, i) => (accOrder[a.id] = i));
  }
  const routeOrder: Record<string, number> = {};
  if (facet === "route") ctx.routeOrder.forEach((id, i) => (routeOrder[id] = i));

  for (const e of entries) {
    if (e.deleted_at !== null || e.kind !== kind || !inRange(e.occurred_on, r)) continue;
    const v = e.main_minor;
    if (facet === "category") {
      const cat = e.category_id ? ctx.catById[e.category_id] : undefined;
      if (!cat) {
        bump(map, GONE_KEY, () => ({ key: GONE_KEY, label: VIEW_TEXT.catGone, order: big, tail: 2 }), v);
        continue;
      }
      const parent = cat.parent_id ? ctx.catById[cat.parent_id] : undefined;
      if (!parent || isUncat(parent.id)) {
        // 主分類本身（父已不在的子分類比照 categoryTree 升為主分類）
        const main = bump(map, cat.id, () => ({ key: cat.id, label: cat.name, order: catOrder[cat.id] ?? big, tail: isUncat(cat.id) ? 1 : 0 }), v);
        const kids = (main.kids = main.kids ?? {});
        bump(kids, UNSPLIT_KEY, () => ({ key: UNSPLIT_KEY, label: VIEW_TEXT.unsplit, order: big, tail: 0 }), v);
      } else {
        const main = bump(map, parent.id, () => ({ key: parent.id, label: parent.name, order: catOrder[parent.id] ?? big, tail: isUncat(parent.id) ? 1 : 0 }), v);
        const kids = (main.kids = main.kids ?? {});
        bump(kids, cat.id, () => ({ key: cat.id, label: cat.name, order: catOrder[cat.id] ?? big - 1, tail: 0 }), v);
      }
    } else if (facet === "account") {
      const a = ctx.accById[e.account_id];
      if (!a) bump(map, GONE_KEY, () => ({ key: GONE_KEY, label: VIEW_TEXT.accGone, order: big, tail: 0 }), v);
      else bump(map, a.id, () => ({ key: a.id, label: a.name, order: accOrder[a.id] ?? big - 1, tail: 0 }), v);
    } else {
      if (e.route_id === null) {
        bump(map, NO_ROUTE_KEY, () => ({ key: NO_ROUTE_KEY, label: VIEW_TEXT.noRoute, order: big - 1, tail: 0, color: null }), v);
      } else {
        const rt = ctx.routeById[e.route_id];
        if (!rt) bump(map, GONE_KEY, () => ({ key: GONE_KEY, label: VIEW_TEXT.routeGone, order: big, tail: 0, color: null }), v);
        else bump(map, rt.id, () => ({ key: rt.id, label: rt.name, order: routeOrder[rt.id] ?? big - 2, tail: 0, color: rt.color }), v);
      }
    }
  }

  const mains = Object.keys(map).map((k) => map[k]);
  let total = 0;
  for (const a of mains) if (a.minor > 0) total += a.minor;

  const rows: BreakdownRow[] = [];
  const refunds: BreakdownRow[] = [];
  for (const a of mains.slice().sort(byAmount)) {
    const positive = a.minor > 0;
    const row = toRow(a, total, positive);
    if (a.kids) {
      const kids = Object.keys(a.kids).map((k) => (a.kids as Record<string, Acc>)[k]);
      // 只有「直接掛主分類」一種 ⇒ 主分類本身就是那一列，不出「未細分」
      if (!(kids.length === 1 && kids[0].key === UNSPLIT_KEY)) {
        row.children = kids.sort(byAmount).map((k) => toRow(k, total, positive));
      }
    }
    (positive ? rows : refunds).push(row);
  }
  refunds.sort((a, b) => a.minor - b.minor || cmpStr(a.key, b.key));
  return { rows, total, refunds };
}

/** 四捨五入到整數；0 < share < 0.5% ⇒ "<1%"；0 ⇒ "0%" */
export function shareText(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** 主分類 id 展開成它＋未刪的子分類 id（含封存的子）；子分類 id 原樣；去重、照輸入順序 */
export function categoryIdsIncluding(ids: readonly string[], cats: readonly CategoryRow[]): string[] {
  const byId: Record<string, CategoryRow> = {};
  const kids: Record<string, CategoryRow[]> = {};
  for (const c of cats) {
    if (c.deleted_at !== null) continue;
    byId[c.id] = c;
    if (c.parent_id) (kids[c.parent_id] = kids[c.parent_id] ?? []).push(c);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of ids) {
    push(id);
    const c = byId[id];
    if (!c || c.parent_id !== null) continue;
    const list = (kids[id] ?? []).slice().sort((a, b) => a.position - b.position || cmpStr(a.created_at, b.created_at) || cmpStr(a.id, b.id));
    for (const k of list) push(k.id);
  }
  return out;
}

/** 已篩帳戶且 facet＝account ⇒ "category"（0-8） */
export function facetAllowed(facet: Facet, filterAccountId: string | null): Facet {
  return filterAccountId !== null && facet === "account" ? "category" : facet;
}

/* ───────────────────────── §4.4 月曆（0-2、0-16、0-22） ───────────────────────── */

function splitDay(dayKey: string): [number, number, number] {
  return [parseInt(dayKey.slice(0, 4), 10), parseInt(dayKey.slice(5, 7), 10), parseInt(dayKey.slice(8, 10), 10)];
}

function keyOf(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地日期加減（lib/date 的 addDays 同義；本檔不 import lib） */
export function dayStep(dayKey: string, n: number): string {
  const [y, m, d] = splitDay(dayKey);
  return keyOf(new Date(y, m - 1, d + n));
}

function weekdayOf(dayKey: string): number {
  const [y, m, d] = splitDay(dayKey);
  return new Date(y, m - 1, d).getDay();
}

/** 兩個日 key 相差幾天（b − a；用 UTC 日數避開夏令時間） */
function dayDiff(a: string, b: string): number {
  const [ya, ma, da] = splitDay(a);
  const [yb, mb, db] = splitDay(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/**
 * 4～6 列 × 7 個日 key：從 1 號所在週的 weekStart 那天起，補到月底所在週的最後一天（原型 monthGrid 同法）。
 * 2 月剛好整齊排滿（平年、1 號正好是 weekStart）時只有 4 列——契約 §4.4 寫「5 或 6 列」是概略說法，演算法本身為準；UI 一週一列、不假設列數。
 */
export function monthGrid(month: string, weekStart: 0 | 1): string[][] {
  const first = `${month}-01`;
  const last = dayStep(`${addMonths(month, 1)}-01`, -1);
  const start = dayStep(first, -((weekdayOf(first) - weekStart + 7) % 7));
  const end = dayStep(last, (weekStart + 6 - weekdayOf(last) + 7) % 7);
  const rows: string[][] = [];
  let d = start;
  while (d <= end) {
    const row: string[] = [];
    for (let i = 0; i < 7; i++) {
      row.push(d);
      d = dayStep(d, 1);
    }
    rows.push(row);
  }
  return rows;
}

/** monthGrid 每格套 groupByDay 口徑（income／expense＝main_minor 合計、count＝收支筆數；轉帳校正不入） */
export function calendarCells(entries: readonly EntryRow[], month: string, weekStart: 0 | 1, today: string): CalendarCell[][] {
  const sums: Record<string, { income: number; expense: number; count: number }> = {};
  for (const e of entries) {
    if (e.deleted_at !== null || (e.kind !== "income" && e.kind !== "expense")) continue;
    const s = (sums[e.occurred_on] = sums[e.occurred_on] ?? { income: 0, expense: 0, count: 0 });
    if (e.kind === "income") s.income += e.main_minor;
    else s.expense += e.main_minor;
    s.count++;
  }
  return monthGrid(month, weekStart).map((row) =>
    row.map((dayKey) => {
      const s = sums[dayKey];
      return {
        dayKey,
        inMonth: monthOf(dayKey) === month,
        isToday: dayKey === today,
        income: s ? s.income : 0,
        expense: s ? s.expense : 0,
        count: s ? s.count : 0,
      };
    }),
  );
}

/**
 * 0-2 (a)：格內支出一個數＋有收入才多一行「＋N」（手機也是 ＋N，D-票-28）。
 * count 0 ⇒ 兩個都空；只有收入的天支出那格不印 0（同原型）；當日淨退 ⇒ "−350"。
 */
export function cellText(c: CalendarCell, decimals: number, compact: boolean): { expense: string; income: string | null } {
  if (c.count === 0) return { expense: "", income: null };
  const money = (v: number): string => (compact ? compactMoney(v, decimals) : moneyText(v, decimals, { whole: true }));
  return {
    expense: c.expense !== 0 || c.income === 0 ? money(c.expense) : "",
    income: c.income !== 0 ? "＋" + money(c.income) : null,
  };
}

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 0-22：|主單位| < 100,000 ⇒ moneyText(whole)；否則除以 10,000 取一位小數、去尾 0、接「萬」；負數 `−` */
export function compactMoney(minor: number, decimals: number): string {
  const abs = Math.abs(minor);
  let unit = 1;
  for (let i = 0; i < decimals; i++) unit *= 10;
  // 門檻用「四捨五入到整數主單位後」判斷：99,999.50 進位成 100,000 時不能再印 6 位數
  const whole = Math.floor((abs + unit / 2) / unit);
  if (whole < COMPACT_FROM) return moneyText(minor, decimals, { whole: true });
  const tenths = Math.round(abs / (unit * 1000)); // 以「0.1 萬」為單位的整數
  const int = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return `${minor < 0 ? "−" : ""}${groupThousands(String(int))}${frac ? "." + frac : ""}萬`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function weekdayHeads(weekStart: 0 | 1): string[] {
  return weekStart === 0 ? WEEKDAYS.slice() : WEEKDAYS.slice(1).concat(WEEKDAYS[0]);
}

/** 0-16：有 dayKey 那天 ⇒ 它；否則最接近的（同距離往前優先）；空 ⇒ null */
export function nearestDayWithEntries(days: readonly DayGroup[], dayKey: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const g of days) {
    if (!g.entries.length) continue;
    const dist = Math.abs(dayDiff(dayKey, g.dayKey));
    if (dist < bestDist || (dist === bestDist && best !== null && g.dayKey < best)) {
      best = g.dayKey;
      bestDist = dist;
    }
  }
  return best;
}

/** "10/8"（月曆跳轉的淡字、quickJump 的 aside） */
export function shortDay(dayKey: string): string {
  const [, m, d] = splitDay(dayKey);
  return `${m}/${d}`;
}

/* ───────────────────────── §4.5 搜尋與篩選（0-14、0-15） ───────────────────────── */

export function isFilterActive(f: EntryFilter): boolean {
  return (
    keywordTokens(f.text).length > 0 || // 只打 emoji／符號的字 catKey 後為空 ⇒ 不算有字（否則空 token 會比出整本帳）
    f.from !== null ||
    f.toExcl !== null ||
    f.accountId !== null ||
    f.categoryIds.length > 0 ||
    f.kinds.length > 0 ||
    f.routeId !== null
  );
}

/** 五欄轉 SQL 條件；categoryIds 經 categoryIdsIncluding；text 不進去 */
export function filterToQuery(f: EntryFilter, cats: readonly CategoryRow[]): EntryQuery {
  return {
    from: f.from,
    toExcl: f.toExcl,
    accountId: f.accountId,
    categoryIds: categoryIdsIncluding(f.categoryIds, cats),
    kinds: f.kinds.slice(),
    routeId: f.routeId,
  };
}

/** 結構條件（＝§3.2 SQL 的 WHERE）；mock 的 queryEntries 與 filterEntries 共用 */
export function matchesQuery(e: EntryRow, q: EntryQuery): boolean {
  if (e.deleted_at !== null) return false;
  if (q.from !== null && e.occurred_on < q.from) return false;
  if (q.toExcl !== null && e.occurred_on >= q.toExcl) return false;
  if (q.accountId !== null && e.account_id !== q.accountId && e.to_account_id !== q.accountId) return false;
  if (q.categoryIds.length > 0 && (e.category_id === null || q.categoryIds.indexOf(e.category_id) < 0)) return false;
  if (q.kinds.length > 0 && q.kinds.indexOf(e.kind) < 0) return false;
  if (q.routeId === "none") return e.route_id === null;
  if (q.routeId !== null && e.route_id !== q.routeId) return false;
  return true;
}

/** 新到舊（＝listEntries／queryEntries 的 ORDER BY occurred_on, occurred_at, created_at, id 全部 DESC） */
export function newestFirst(a: EntryRow, b: EntryRow): number {
  return cmpStr(b.occurred_on, a.occurred_on) || cmpStr(b.occurred_at, a.occurred_at) || cmpStr(b.created_at, a.created_at) || cmpStr(b.id, a.id);
}

const NUMBER_RE = /^\d[\d,]*(\.\d+)?$/;

/** 數字字串的正規形：去千分位、小數去尾 0（"80.00"→"80"、"80.50"→"80.5"、"1,200"→"1200"） */
function canonNumber(s: string): string {
  let t = s.replace(/,/g, "");
  if (t.indexOf(".") >= 0) t = t.replace(/0+$/, "").replace(/\.$/, "");
  t = t.replace(/^0+(?=\d)/, "");
  return t;
}

/** 最小單位整數的絕對值 → 正規十進位字串（整數不帶 .00） */
function minorDecimalText(minor: number, decimals: number): string {
  const digits = String(Math.abs(minor)).padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  return canonNumber(`${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}`);
}

/** normalizeInput → 以空白切、丟空、catKey 化；純數字 token 另記 isNumber（去開頭符號後才判，`$80` 不算數字） */
export function keywordTokens(text: string): KeywordToken[] {
  const out: KeywordToken[] = [];
  for (const raw of normalizeInput(text).split(/\s+/)) {
    if (!raw) continue;
    const key = catKey(raw);
    if (!key) continue;
    out.push({ key, raw, isNumber: NUMBER_RE.test(raw) });
  }
  return out;
}

/** 全部 token 都要命中（AND）。文字：備註、分類名與主分類名、帳戶名與轉入帳戶名、路線名與代碼——包含即中；數字另比金額（完全相符） */
export function matchesKeyword(e: EntryRow, tokens: readonly KeywordToken[], ctx: ViewCtx): boolean {
  if (!tokens.length) return true;
  const hay: string[] = [catKey(e.note)];
  const cat = e.category_id ? ctx.catById[e.category_id] : undefined;
  if (cat) {
    hay.push(catKey(cat.name));
    const p = cat.parent_id ? ctx.catById[cat.parent_id] : undefined;
    if (p) hay.push(catKey(p.name));
  }
  const acc = ctx.accById[e.account_id];
  if (acc) hay.push(catKey(acc.name));
  const to = e.to_account_id ? ctx.accById[e.to_account_id] : undefined;
  if (to) hay.push(catKey(to.name));
  const rt = e.route_id ? ctx.routeById[e.route_id] : undefined;
  if (rt) {
    hay.push(catKey(rt.name));
    if (rt.code) hay.push(catKey(rt.code));
  }
  let amounts: string[] | null = null;
  for (const t of tokens) {
    let hit = false;
    for (const h of hay) {
      if (h.indexOf(t.key) >= 0) {
        hit = true;
        break;
      }
    }
    if (!hit && t.isNumber) {
      if (amounts === null) {
        amounts = [
          minorDecimalText(e.amount_minor, ctx.curByCode[e.currency]?.decimals ?? 2),
          minorDecimalText(e.main_minor, mainDecimals(ctx)),
        ];
      }
      hit = amounts.indexOf(canonNumber(t.raw)) >= 0;
    }
    if (!hit) return false;
  }
  return true;
}

/** 結構五欄＋關鍵字一次做完（mock 與測試用；≡ queryEntries(filterToQuery(f)) 再 matchesKeyword）；新到舊 */
export function filterEntries(entries: readonly EntryRow[], f: EntryFilter, ctx: ViewCtx): EntryRow[] {
  const q = filterToQuery(
    f,
    Object.keys(ctx.catById).map((k) => ctx.catById[k]),
  );
  const tokens = keywordTokens(f.text);
  return entries.filter((e) => matchesQuery(e, q) && matchesKeyword(e, tokens, ctx)).sort(newestFirst);
}

/** 「找到 N 筆 · 支出 X · 收入 Y」：N＝全部筆數（含轉帳校正）、支出／收入照 0-7 */
export function resultSummary(results: readonly EntryRow[], decimals: number): string {
  let exp = 0;
  let inc = 0;
  for (const e of results) {
    if (e.deleted_at !== null) continue;
    if (e.kind === "expense") exp += e.main_minor;
    else if (e.kind === "income") inc += e.main_minor;
  }
  return VIEW_TEXT.found(results.length, moneyText(exp, decimals), moneyText(inc, decimals));
}

/** chips 列的字（期間／帳戶／分類／類型／路線；空的欄不出） */
export function filterChips(f: EntryFilter, ctx: ViewCtx): { key: keyof EntryFilter; label: string }[] {
  const out: { key: keyof EntryFilter; label: string }[] = [];
  if (f.from !== null || f.toExcl !== null) {
    const toIncl = f.toExcl !== null ? dayStep(f.toExcl, -1) : null;
    const sameYear = f.from === null || toIncl === null || f.from.slice(0, 4) === toIncl.slice(0, 4);
    const fmt = (d: string) => (sameYear ? shortDay(d) : `${parseInt(d.slice(0, 4), 10)}/${shortDay(d)}`);
    const label =
      f.from !== null && toIncl !== null ? `${fmt(f.from)}–${fmt(toIncl)}` : f.from !== null ? `${fmt(f.from)} 起` : `到 ${fmt(toIncl as string)}`;
    out.push({ key: "from", label: `期間 ${label}` });
  }
  if (f.accountId !== null) {
    const a = ctx.accById[f.accountId];
    out.push({ key: "accountId", label: `帳戶 ${a ? a.name : VIEW_TEXT.accGone}` });
  }
  if (f.categoryIds.length === 1) {
    out.push({ key: "categoryIds", label: `分類 ${categoryLabel(ctx.catById[f.categoryIds[0]] ?? null, ctx.catById)}` });
  } else if (f.categoryIds.length > 1) {
    out.push({ key: "categoryIds", label: `分類 ${f.categoryIds.length} 個` });
  }
  if (f.kinds.length > 0) {
    out.push({ key: "kinds", label: `類型 ${KIND_ORDER.filter((k) => f.kinds.indexOf(k) >= 0).map((k) => KIND_LABEL[k]).join("、")}` });
  }
  if (f.routeId === "none") {
    out.push({ key: "routeId", label: VIEW_TEXT.noRoute });
  } else if (f.routeId !== null) {
    const rt = ctx.routeById[f.routeId];
    out.push({ key: "routeId", label: `路線 ${rt ? (rt.code ? `●${rt.code} ${rt.name}` : rt.name) : VIEW_TEXT.routeGone}` });
  }
  return out;
}

/** 前 RESULT_PAGE × page 筆 */
export function pageResults<T>(results: readonly T[], page: number): T[] {
  return results.slice(0, RESULT_PAGE * Math.max(1, page));
}

/* ───────────────────────── §4.6 路線花費（0-11） ───────────────────────── */

/** 未刪、expense、route_id＝routeId 的 main_minor 淨額；inRange 另加期間（＝§3.2 routeSpend SQL） */
export function routeSpendOf(entries: readonly EntryRow[], routeId: string, r: { from: string; toExcl: string }): { inRange: number; allTime: number } {
  let inR = 0;
  let all = 0;
  for (const e of entries) {
    if (e.deleted_at !== null || e.kind !== "expense" || e.route_id !== routeId) continue;
    all += e.main_minor;
    if (inRange(e.occurred_on, r)) inR += e.main_minor;
  }
  return { inRange: inR, allTime: all };
}

/** 路線側板：「本月 1,230／累計 18,420」（moneyText 口徑：整數不顯示小數、有小數照印；負數 `−`；兩個都 0 仍出；§4.6） */
export function spendText(inRangeMinor: number, allTimeMinor: number, decimals: number): string {
  return VIEW_TEXT.spend(moneyText(inRangeMinor, decimals), moneyText(allTimeMinor, decimals));
}

/** 手機路線列尾：0 ⇒ null；否則「本月 1,230」 */
export function asideText(inRangeMinor: number, decimals: number): string | null {
  return inRangeMinor === 0 ? null : VIEW_TEXT.aside(moneyText(inRangeMinor, decimals));
}
