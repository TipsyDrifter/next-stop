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
 *   售票口④：視圖多「願望」、統計多「依荷札」切面、搜尋篩選多「荷札」（選父含子、多選＝任一）、關鍵字也比對荷札名。
 *   售票口④ 第二輪：分類不限層數（占比以某分類為根 `breakdown(…, { catRoot })`＋`statsCrumbs`、含子孫的口徑走 `categorySubtreeIds`）；
 *   §4.7 帳戶頁（視圖多「帳戶」；`accountCards`：餘額、本月進出、近六個月月底餘額）。
 *   荷札資料不在帳列上：呼叫端把 tagStore.index 換成 `ViewCtx.entryTags`（帳 id → 荷札 keys）與 `tagName` 傳進來（`ticketTags.ts` 的 `entryTagMap`）。
 */
import {
  MAIN_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  addMonths,
  catKey,
  categoryForest,
  categoryLabel,
  categoryParentMap,
  categoryPath,
  categorySubtreeIds,
  flattenForest,
  monthOf,
  monthRange,
  monthTitle,
  moneyText,
  normalizeInput,
  orderAccounts,
  type AccountRow,
  type CategoryRow,
  type DayGroup,
  type EntryCtx,
  type EntryKind,
  type EntryRow,
} from "./ticket";
import type { NodeRow } from "./node";
import { isUnder, lastSeg, segsOf } from "./tags";

/* ───────────────────────── §4.1 型別與常數 ───────────────────────── */

/** 售票口④（D-票-69）：「願望」；第二輪（D-票-77）：「帳戶」——頁首五格順序「清單｜月曆｜統計｜帳戶｜願望」 */
export type TicketView = "list" | "calendar" | "stats" | "accounts" | "wish";
export type StatsSpan = "month" | "year";
/** 售票口④（D-票-73）：多「依荷札」 */
export type Facet = "category" | "account" | "route" | "tag";
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
export const UNSPLIT_KEY = "__unsplit__"; // 直接記在主分類本身（荷札切面：直接掛在父荷札本身）
export const NO_TAG_KEY = "__notag__"; // 荷札切面：沒掛任何荷札的帳

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
  /** 售票口④：帳 id → 掛的荷札 keys（沒給＝當作都沒掛；篩選荷札、依荷札統計、關鍵字比對荷札名要用） */
  entryTags?: Readonly<Record<string, readonly string[]>>;
  /** 售票口④：荷札 key → 顯示名（沒給＝用 key） */
  tagName?: (key: string) => string;
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
  /** 分類切面（售票口④ 第二輪 D-票-78）：這一列的分類底下還有更深的帳（記在它的子孫上）⇒ UI 畫「進入 ›」，以它為根（`setStatsRoot`） */
  deeper?: boolean;
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
  /** 售票口④：荷札 keys（選父含子、多選＝任一）；不進 SQL，查完在 TS 篩（`matchesTagFilter`） */
  tagKeys: readonly string[];
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
  tagKeys: [],
};

/** 看帳的文案（契約 §3.4 TK_TEXT 新鍵、§5.5）；store 的 TK_TEXT 引用這一份，顯示端不手抄 */
export const VIEW_TEXT = {
  found: (n: number, exp: string, inc: string) => `找到 ${n} 筆 · 支出 ${exp} · 收入 ${inc}`,
  noDay: (d: string) => `${d} 沒有紀錄`,
  spend: (m: string, t: string) => `本月 ${m}／累計 ${t}`,
  /** 路線列尾（手機）：跟時刻表的「本月 3h」並排，帶「花」才分得出是錢（磨光③ 2-6、D-票-59） */
  aside: (m: string) => `本月花 ${m}`,
  spendDetail: "看明細",
  noRoute: "無路線",
  routeGone: "（路線已刪）",
  catGone: "（分類已刪除）",
  accGone: "（帳戶已刪除）",
  unsplit: "未細分",
  /** 售票口④ 第二輪：統計麵包屑的第一段（D-票-78） */
  allCats: "全部分類",
  refunds: "退回",
  emptyStats: "這段期間沒有收支",
  emptyResults: "沒有符合的帳",
  more: (n: number) => `再顯示 ${n} 筆`,
  /* 售票口④ */
  noTag: "沒掛荷札",
  /** 依荷札的說明（D-票-73：一筆掛多個荷札各算一次） */
  tagNote: (kind: "expense" | "income") => `一筆掛了幾個荷札就各算一次，加起來可能比總${kind === "income" ? "收入" : "支出"}多`,
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
  /** 分類切面：底下還有更深的帳（→ BreakdownRow.deeper） */
  deep?: boolean;
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
  if (a.deep) row.deeper = true;
  return row;
}

/**
 * 占比（0-8）：只取 `kind` 那種、期間內、未刪的帳，依切面分組。
 * 分類切面（售票口④ 第二輪 D-票-78：不限層數）：主列＝這一層的分類（含底下所有子孫的帳）、children＝它的直屬下一層
 * （更深的併進那一層；直接記在主列本身的另出「未細分」，只有它一種就不出）；某列底下還有更深的帳 ⇒ `deeper`（UI 畫「進入 ›」）。
 * `opts.catRoot`（「進入 ›」以那層為根）：只算那個分類整棵的帳，主列＝它的直屬下一層，直接記在它本身的帳是最後一列「未細分」
 * （排在一般列之後）；沒給或 null＝全部分類：主列＝頂層，未分類固定在一般列之後、GONE 在未分類之後。
 * 其他切面金額大到小、同額照自然順序。
 * total＝所有 minor > 0 的主列合計（以某分類為根時＝那一層的合計）；minor ≤ 0 的主列（連同 children）移到 refunds、share 0。
 */
export function breakdown(
  entries: readonly EntryRow[],
  r: { from: string; toExcl: string },
  facet: Facet,
  kind: "expense" | "income",
  ctx: ViewCtx,
  opts?: { catRoot?: string | null },
): Breakdown {
  if (facet === "tag") return tagBreakdown(entries, r, kind, ctx);
  const map: Record<string, Acc> = {};
  const big = Number.MAX_SAFE_INTEGER;

  // 自然順序（分類＝樹的前序）；分類的路徑（頂層 → 自己的 id 串）
  const catOrder: Record<string, number> = {};
  const pathCache: Record<string, string[]> = {};
  let parentOf: Record<string, string | null> = {};
  if (facet === "category") {
    const cats = Object.keys(ctx.catById).map((k) => ctx.catById[k]);
    flattenForest(categoryForest(cats, kind, { includeArchived: true })).forEach((n, i) => (catOrder[n.cat.id] = i));
    parentOf = categoryParentMap(cats);
  }
  const pathOf = (id: string): string[] => {
    let p = pathCache[id];
    if (!p) {
      p = [id];
      for (let x = parentOf[id] ?? null, guard = 0; x !== null && guard < 64; x = parentOf[x] ?? null, guard++) p.unshift(x);
      pathCache[id] = p;
    }
    return p;
  };
  const catRoot = facet === "category" && opts?.catRoot ? opts.catRoot : null;
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
        if (catRoot === null) bump(map, GONE_KEY, () => ({ key: GONE_KEY, label: VIEW_TEXT.catGone, order: big, tail: 2 }), v);
        continue;
      }
      // 主列在路徑上的位置：全部分類＝頂層（0）；以 catRoot 為根＝它的下一層（父已不在的比照 categoryForest 升為頂層）
      const path = pathOf(cat.id);
      let at = 0;
      if (catRoot !== null) {
        const j = path.indexOf(catRoot);
        if (j < 0) continue;
        at = j + 1;
      }
      if (at >= path.length) {
        // 直接記在根本身
        bump(map, UNSPLIT_KEY, () => ({ key: UNSPLIT_KEY, label: VIEW_TEXT.unsplit, order: big, tail: 1 }), v);
        continue;
      }
      const mid = path[at];
      const mc = ctx.catById[mid];
      const main = bump(map, mid, () => ({ key: mid, label: mc ? mc.name : VIEW_TEXT.catGone, order: catOrder[mid] ?? big, tail: isUncat(mid) ? 1 : 0 }), v);
      const kids = (main.kids = main.kids ?? {});
      if (at + 1 >= path.length) {
        bump(kids, UNSPLIT_KEY, () => ({ key: UNSPLIT_KEY, label: VIEW_TEXT.unsplit, order: big, tail: 0 }), v);
      } else {
        const kid = path[at + 1];
        const kc = ctx.catById[kid];
        const k = bump(kids, kid, () => ({ key: kid, label: kc ? kc.name : VIEW_TEXT.catGone, order: catOrder[kid] ?? big - 1, tail: 0 }), v);
        main.deep = true;
        if (at + 2 < path.length) k.deep = true;
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
  return finishBreakdown(mains, total);
}

/** 主列 → 排序、分 rows／refunds、帶 children（breakdown 與 tagBreakdown 共用） */
function finishBreakdown(mains: Acc[], total: number): Breakdown {
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

/**
 * 依荷札（售票口④ D-票-73）：主列＝最上層荷札（父荷札含子：掛 #旅行/京都 也算進 #旅行）、children＝下一層
 * （更深的併進那一層；直接掛在父荷札本身的另出「未細分」，只有它一種就不出）。一筆掛多個荷札各算一次——同一個
 * 主列（或同一個子列）裡一筆只算一次。沒掛荷札的帳一列「沒掛荷札」排在最後。
 * total＝期間內這種 kind 的帳的淨額（每筆只算一次）；share＝列淨額 ÷ total（夾到 1），所以各列加總可能超過 100%（頁上寫 tagNote）。
 */
export function tagBreakdown(entries: readonly EntryRow[], r: { from: string; toExcl: string }, kind: "expense" | "income", ctx: ViewCtx): Breakdown {
  const map: Record<string, Acc> = {};
  const big = Number.MAX_SAFE_INTEGER;
  const tagsOf = ctx.entryTags ?? {};
  const nameOf = (k: string): string => (ctx.tagName ? ctx.tagName(k) : k);
  let total = 0;
  for (const e of entries) {
    if (e.deleted_at !== null || e.kind !== kind || !inRange(e.occurred_on, r)) continue;
    const v = e.main_minor;
    total += v;
    const keys = tagsOf[e.id] ?? [];
    if (!keys.length) {
      bump(map, NO_TAG_KEY, () => ({ key: NO_TAG_KEY, label: VIEW_TEXT.noTag, order: big, tail: 1 }), v);
      continue;
    }
    const byRoot: Record<string, Record<string, true>> = {};
    for (const k of keys) {
      const segs = segsOf(k);
      const root = segs[0];
      const kid = segs.length > 1 ? `${root}/${segs[1]}` : UNSPLIT_KEY;
      (byRoot[root] = byRoot[root] ?? {})[kid] = true;
    }
    for (const root of Object.keys(byRoot)) {
      const main = bump(map, root, () => ({ key: root, label: nameOf(root), order: 0, tail: 0 }), v);
      const kids = (main.kids = main.kids ?? {});
      for (const kid of Object.keys(byRoot[root])) {
        if (kid === UNSPLIT_KEY) bump(kids, UNSPLIT_KEY, () => ({ key: UNSPLIT_KEY, label: VIEW_TEXT.unsplit, order: big, tail: 0 }), v);
        else bump(kids, kid, () => ({ key: kid, label: lastSeg(nameOf(kid)), order: 0, tail: 0 }), v);
      }
    }
  }
  return finishBreakdown(
    Object.keys(map).map((k) => map[k]),
    total > 0 ? total : 0,
  );
}

/** 四捨五入到整數；0 < share < 0.5% ⇒ "<1%"；0 ⇒ "0%" */
export function shareText(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/**
 * 每個 id 展開成它＋底下所有未刪的子孫（含封存的；D-票-78「選一個分類＝含子孫」，任何一層都一樣，葉子＝只有自己）；
 * 去重、照輸入順序（各自的子孫照前序跟在後面）
 */
export function categoryIdsIncluding(ids: readonly string[], cats: readonly CategoryRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const x of categorySubtreeIds(id, cats)) {
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * 統計「進入 ›」的麵包屑（D-票-78）：第一段「全部分類」（id null）、接著從頂層到 root 的每一層（label＝那一層自己的名字）。
 * root null 或已不在 ⇒ 只有「全部分類」。
 */
export function statsCrumbs(root: string | null, catById: Readonly<Record<string, CategoryRow>>): { id: string | null; label: string }[] {
  const out: { id: string | null; label: string }[] = [{ id: null, label: VIEW_TEXT.allCats }];
  const r = root ? catById[root] : undefined;
  if (r) for (const c of categoryPath(r, catById)) out.push({ id: c.id, label: c.name });
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
    f.routeId !== null ||
    (f.tagKeys ?? []).length > 0 // 舊呼叫端（測試、早期存的物件）沒有這欄＝不限
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

/* ── 搜尋結果的排序（磨光⑥ 契約 §2-4；D-票-64） ── */

/** 搜尋結果的排序條件；預設（也是一般清單的樣子）是 dateDesc */
export type EntrySort = "dateDesc" | "dateAsc" | "amountDesc" | "amountAsc";
export const ENTRY_SORTS: readonly EntrySort[] = ["dateDesc", "dateAsc", "amountDesc", "amountAsc"];
export const DEFAULT_ENTRY_SORT: EntrySort = "dateDesc";

/** 排序選項的字（兩殼同一份；磨光⑥ 契約 §2-4） */
export const ENTRY_SORT_TEXT: Readonly<Record<EntrySort, string>> = {
  dateDesc: "日期・新到舊",
  dateAsc: "日期・舊到新",
  amountDesc: "金額・大到小",
  amountAsc: "金額・小到大",
};

/** 平面清單（金額排序）每列的日期字：「10/21（三）」；跨年的結果加年「2025/10/21（二）」 */
export function flatDayText(dayKey: string, withYear: boolean): string {
  const [y, m, d] = splitDay(dayKey);
  const w = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  return `${withYear ? `${y}/` : ""}${m}/${d}（${w}）`;
}

/** 金額排序畫平面清單（不分日）；日期排序照舊按日分組 */
export function isAmountSort(s: EntrySort): boolean {
  return s === "amountDesc" || s === "amountAsc";
}

/** 讀本機設定值：不認得（壞值、沒存過）⇒ 預設 */
export function parseEntrySort(raw: string | null | undefined): EntrySort {
  return ENTRY_SORTS.find((s) => s === raw) ?? DEFAULT_ENTRY_SORT;
}

/** 日期舊到新：newestFirst 反過來（發生日、發生時刻、建立時刻、id 全部反向） */
function oldestFirst(a: EntryRow, b: EntryRow): number {
  return newestFirst(b, a);
}

/**
 * 依條件排好（回新陣列，不改輸入）。金額比的是 `main_minor` 的絕對值——跟日小計（groupByDay）同一欄，外幣已換成主幣別、
 * 退款（負的）與收入、轉帳、校正都照絕對值比；同金額用日期新到舊、再 id，所以結果穩定。
 * 日期舊到新時，餵給 groupByDay 會自然開出「舊的日在前、組內舊的在前」的分組（groupByDay 依輸入順序開組）。
 */
export function sortEntries(entries: readonly EntryRow[], sort: EntrySort): EntryRow[] {
  const out = entries.slice();
  switch (sort) {
    case "dateAsc":
      return out.sort(oldestFirst);
    case "amountDesc":
      return out.sort((a, b) => Math.abs(b.main_minor) - Math.abs(a.main_minor) || newestFirst(a, b));
    case "amountAsc":
      return out.sort((a, b) => Math.abs(a.main_minor) - Math.abs(b.main_minor) || newestFirst(a, b));
    default:
      return out.sort(newestFirst);
  }
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

/** 全部 token 都要命中（AND）。文字：備註、分類名與每一層上層的名字、帳戶名與轉入帳戶名、路線名與代碼——包含即中；數字另比金額（完全相符） */
export function matchesKeyword(e: EntryRow, tokens: readonly KeywordToken[], ctx: ViewCtx): boolean {
  if (!tokens.length) return true;
  const hay: string[] = [catKey(e.note)];
  const cat = e.category_id ? ctx.catById[e.category_id] : undefined;
  if (cat) for (const c of categoryPath(cat, ctx.catById)) hay.push(catKey(c.name)); // 自己與每一層上層（D-票-78）
  const acc = ctx.accById[e.account_id];
  if (acc) hay.push(catKey(acc.name));
  const to = e.to_account_id ? ctx.accById[e.to_account_id] : undefined;
  if (to) hay.push(catKey(to.name));
  const rt = e.route_id ? ctx.routeById[e.route_id] : undefined;
  if (rt) {
    hay.push(catKey(rt.name));
    if (rt.code) hay.push(catKey(rt.code));
  }
  // 售票口④：荷札名也比（「京都」找得到掛 #旅行/京都 的帳）
  const tags = ctx.entryTags ? ctx.entryTags[e.id] : undefined;
  if (tags) for (const k of tags) hay.push(catKey(ctx.tagName ? ctx.tagName(k) : k));
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

/**
 * 荷札篩選（售票口④）：want 空＝不限；否則這筆掛的任一個荷札在 want 任一個之下（含它自己；選父含子）就算。
 * 帳的荷札從 ctx.entryTags 讀（沒給＝都沒掛 ⇒ 有 want 就一律不中）。
 */
export function matchesTagFilter(e: Pick<EntryRow, "id">, want: readonly string[], ctx: Pick<ViewCtx, "entryTags">): boolean {
  if (!want.length) return true;
  const keys = ctx.entryTags ? ctx.entryTags[e.id] : undefined;
  if (!keys || !keys.length) return false;
  for (const k of keys) for (const w of want) if (isUnder(k, w)) return true;
  return false;
}

/** 結構五欄＋關鍵字＋荷札一次做完（mock 與測試用；≡ queryEntries(filterToQuery(f)) 再 matchesKeyword、matchesTagFilter）；新到舊 */
export function filterEntries(entries: readonly EntryRow[], f: EntryFilter, ctx: ViewCtx): EntryRow[] {
  const q = filterToQuery(
    f,
    Object.keys(ctx.catById).map((k) => ctx.catById[k]),
  );
  const tokens = keywordTokens(f.text);
  return entries.filter((e) => matchesQuery(e, q) && matchesKeyword(e, tokens, ctx) && matchesTagFilter(e, f.tagKeys ?? [], ctx)).sort(newestFirst);
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
    // chip 擠：只寫最後兩段（D-票-78；兩層時與完整路徑相同）
    out.push({ key: "categoryIds", label: `分類 ${categoryLabel(ctx.catById[f.categoryIds[0]] ?? null, ctx.catById, { short: true })}` });
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
  const tagKeys = f.tagKeys ?? [];
  if (tagKeys.length === 1) {
    out.push({ key: "tagKeys", label: `荷札 #${ctx.tagName ? ctx.tagName(tagKeys[0]) : tagKeys[0]}` });
  } else if (tagKeys.length > 1) {
    out.push({ key: "tagKeys", label: `荷札 ${tagKeys.length} 個` });
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

/** 手機路線列尾：0 ⇒ null；否則「本月花 1,230」 */
export function asideText(inRangeMinor: number, decimals: number): string | null {
  return inRangeMinor === 0 ? null : VIEW_TEXT.aside(moneyText(inRangeMinor, decimals));
}

/* ───────────────────────── §4.7 帳戶頁（售票口④ 第二輪 D-票-77、79） ───────────────────────── */

/** 帳戶卡的走勢看幾個月（含本月） */
export const ACCOUNT_TREND_MONTHS = 6;
/** 「到最後」的日 key 上界（比任何 YYYY-MM-DD 都大）：帳戶頁要讀到未來日的帳，月底餘額才扣得對 */
export const FAR_DAY = "9999-99-99";

/**
 * 一個帳戶在一段期間的進出（同一種幣別）。口徑：
 * - income／expense＝記在這個帳戶上的收支（＝統計 0-7 的收支口徑：退款是負的、自然抵回；轉帳與校正不算收支）；
 * - transferOut＝從這個帳戶轉出（來源那一頭）、transferIn＝轉進這個帳戶（目的那一頭）——同一筆轉帳兩頭各記一次，
 *   各在自己的帳戶上；整體統計裡轉帳兩頭互相抵消、不入收支，帳戶頁才分開給；
 * - adjust＝餘額調整（精算、初始餘額；帶正負號）。
 * 帳戶幣別（own）：收支與轉出用 `account_minor`、轉入用 `to_amount_minor`——跟餘額公式（balancesOf）一致；
 * 主幣別（main）：一律用那筆的 `main_minor`（轉帳兩頭同一個值）。
 */
export interface AccountFlow {
  income: number;
  expense: number;
  transferIn: number;
  transferOut: number;
  adjust: number;
}
export interface AccountCard {
  id: string;
  /** 現在的餘額（帳戶幣別；＝store.balances，含未來日的帳） */
  balance: number;
  /** 本月（呼叫端給的 month）的進出：帳戶幣別與主幣別 */
  month: { own: AccountFlow; main: AccountFlow };
  /** 近 ACCOUNT_TREND_MONTHS 個月每月**月底餘額**（帳戶幣別），舊到新；最後一點＝本月底（本月之後沒有帳時＝balance） */
  trend: { month: string; balance: number }[];
}

const zeroFlow = (): AccountFlow => ({ income: 0, expense: 0, transferIn: 0, transferOut: 0, adjust: 0 });

/**
 * 帳戶卡「本月」那一行要印的幾項（兩殼同一套）：收、支、轉入、轉出、調整，照這個順序；是 0 的那項不印，全空＝「本月沒有進出」。
 * 轉帳要印：信用卡、銀行帳戶的變動大多是轉帳（繳卡費、提款），只印收支會寫「沒有進出」但餘額明明動了；調整（精算、開帳）同理。
 */
export function accountFlowParts(flow: AccountFlow): { key: keyof AccountFlow; label: string; minor: number }[] {
  const all: { key: keyof AccountFlow; label: string }[] = [
    { key: "income", label: "收" },
    { key: "expense", label: "支" },
    { key: "transferIn", label: "轉入" },
    { key: "transferOut", label: "轉出" },
    { key: "adjust", label: "調整" },
  ];
  return all.filter((p) => flow[p.key] !== 0).map((p) => ({ ...p, minor: flow[p.key] }));
}

/** 帳戶頁要讀的帳：走勢第一個月的月初到最後（含未來日；月底餘額＝現在的餘額扣回之後的帳） */
export function accountsRange(month: string): { from: string; toExcl: string } {
  return { from: monthRange(addMonths(month, 1 - ACCOUNT_TREND_MONTHS)).from, toExcl: FAR_DAY };
}

/** 一筆帳對某帳戶餘額的影響（帳戶幣別；＝balancesOf 的公式） */
function balanceDelta(e: EntryRow, accountId: string): number {
  let d = 0;
  if (e.account_id === accountId) d += e.kind === "expense" || e.kind === "transfer" ? -e.account_minor : e.account_minor;
  if (e.kind === "transfer" && e.to_account_id === accountId) d += e.to_amount_minor ?? 0;
  return d;
}

/**
 * 帳戶頁每張卡的數字（一次算完所有帳戶，不逐帳戶查）：`entries`＝`accountsRange(month)` 讀出來的帳（全部帳戶），
 * `balances`＝現在的餘額（repository.balances）。走勢選**月底餘額**而不是每月淨額：卡片的主角就是餘額，
 * 小圖說的是「這個數字怎麼走到現在」；負債帳戶（信用卡）也直接看得出欠款升降；淨額每月跳上跳下，小圖讀不出東西。
 * 月底餘額＝現在的餘額 − 那個月之後的帳的影響（所以要讀到最後、含未來日）。含封存帳戶（分組由 UI 用 groupAccounts／archivedAccounts）。
 */
export function accountCards(
  accounts: readonly AccountRow[],
  balances: Readonly<Record<string, number>>,
  entries: readonly EntryRow[],
  month: string,
): Record<string, AccountCard> {
  const months: string[] = [];
  for (let i = ACCOUNT_TREND_MONTHS - 1; i >= 0; i--) months.push(addMonths(month, -i));
  const ends = months.map((m) => monthRange(m).toExcl);
  const cur = monthRange(month);
  const out: Record<string, AccountCard> = {};
  // after[id][i]＝occurred_on ≥ ends[i] 的帳對它的影響合計
  const after: Record<string, number[]> = {};
  for (const a of accounts) {
    if (a.deleted_at !== null) continue;
    out[a.id] = { id: a.id, balance: balances[a.id] ?? 0, month: { own: zeroFlow(), main: zeroFlow() }, trend: [] };
    after[a.id] = months.map(() => 0);
  }
  const touch = (e: EntryRow, id: string | null): void => {
    if (id === null || !out[id]) return;
    const d = balanceDelta(e, id);
    const acc = after[id];
    for (let i = 0; i < ends.length; i++) if (e.occurred_on >= ends[i]) acc[i] += d;
    if (!inRange(e.occurred_on, cur)) return;
    const own = out[id].month.own;
    const main = out[id].month.main;
    if (e.kind === "transfer") {
      if (e.account_id === id) {
        own.transferOut += e.account_minor;
        main.transferOut += e.main_minor;
      }
      if (e.to_account_id === id) {
        own.transferIn += e.to_amount_minor ?? 0;
        main.transferIn += e.main_minor;
      }
    } else if (e.account_id === id) {
      const k = e.kind === "adjust" ? "adjust" : e.kind;
      own[k] += e.account_minor;
      main[k] += e.main_minor;
    }
  };
  for (const e of entries) {
    if (e.deleted_at !== null) continue;
    touch(e, e.account_id);
    // 自己轉給自己（理論上表單擋掉）只算一次
    if (e.kind === "transfer" && e.to_account_id !== e.account_id) touch(e, e.to_account_id);
  }
  for (const id in out) {
    const c = out[id];
    c.trend = months.map((m, i) => ({ month: m, balance: c.balance - after[id][i] }));
  }
  return out;
}
