/**
 * report——運行報告的純函式（② 運行報告 ＋ v1.33 3A「運行報告完全體」＋ G6 方針回顧轉日記）。
 *
 * `buildOperationReport(facts, now)`：吃一包已經讀好的事實（`data/reportFacts.ts` 讀），吐整頁要畫的東西——
 *   - 上半五張卡（答今天，或套用跨模組篩選後的今天）＋ 今日小結
 *   - 下半「每日運行實績」表格列（含每週合計、期間合計）＋ **3A-1 單日運行全貌原地展開明細（`dayDetails`）**
 *   - **3A-2 彈性期間解析（`今日 ｜ 近 7 天 ｜ 近 30 天 ｜ 按月翻頁 ｜ 自訂區間`）**
 *   - **3A-2 跨模組篩選（幹線／路線 ＋ `#荷札` 多選 AND 交集）**
 *   - **3A-2 路線實績排行卡（`routeRanks`，支援依蓋済車票／投入時數／相關支出排序）**
 *   - **3A-2 已完成車票歷史明細流（`completedGroups`，依營業日倒序分組含一般車票與定期券各回班次，支援關鍵字過濾）**
 *   - **3A-3 G6 方針回顧轉日記純函式（`formatAimsReviewDiary`、`appendReviewToDiaryBody`）**
 *
 * 鐵則：零 UI／Store／Tauri 執行期依賴；相對路徑帶 `.ts` 供 `node --test` 直載。
 */
import { addDays, dayKeyOf, dayWindow } from "../lib/date.ts";
import { WINDOW_CATEGORY_LABEL, type IdealReflectionRow, type WindowPromptCategory } from "./idealTecho.ts";
import { isUnder, keyOf } from "./tags.ts";
import { MASK_STARS, formatDisplayMoney, moneyText } from "./ticket.ts";
import { slicePreparedTime, topFourCats, type ReportPreparedSpan } from "./reportTime.ts";

/* ═══════════ 期間與跨模組篩選型別（v1.33 3A-2） ═══════════ */

export type ReportPeriodMode = "today" | "7d" | "30d" | "month" | "custom";

export interface ReportPeriodSpec {
  mode: ReportPeriodMode;
  /** mode === "month" 時的 YYYY-MM（省略＝today 所在月份） */
  month?: string;
  /** mode === "custom" 時的起日 YYYY-MM-DD */
  customFrom?: string;
  /** mode === "custom" 時的迄日 YYYY-MM-DD */
  customTo?: string;
}

export interface ResolvedReportRange {
  mode: ReportPeriodMode;
  from: string;
  to: string;
  month: string;
  label: string;
}

export type ReportScopeFilter =
  | { kind: "all" }
  | { kind: "line"; lineId: string }
  | { kind: "route"; routeId: string }
  | { kind: "none" };

export interface ReportFilter {
  scope: ReportScopeFilter;
  /** `#荷札` name_key 陣列（多選 AND 交集，父荷札含子荷札） */
  tagKeys: readonly string[];
}

export const DEFAULT_REPORT_FILTER: ReportFilter = {
  scope: { kind: "all" },
  tagKeys: [],
};

export type RouteRankSort = "seals" | "time" | "money";

/* ═══════════ 事實（讀進來的東西） ═══════════ */

export interface ReportRouteRef {
  id: string;
  name: string;
  code: string | null;
  color: string | null;
  /** 所屬幹線 id（v1.33 幹線篩選用；省略＝null） */
  lineId?: string | null;
  /** 已收進車庫的到站日（省略＝null） */
  arrivedOn?: string | null;
}

/** 接下來 7 天的一個締切（未完成） */
export interface ReportDue {
  day: string;
  nodeId: string;
  name: string;
  routeId: string | null;
  /** 臨時車票（沒有 parent）：圓牌畫虛線「臨」 */
  temp: boolean;
  tagKeys?: readonly string[];
}

/** 時刻表（沒通車＝null）：每天的已記錄（同時刻表統計：不含待確認與碎塊） */
export interface ReportTimeFacts {
  byDay: Readonly<Record<string, number>>;
  /** 今天的分類（已記錄 ms，大到小） */
  todayCats: readonly { id: string; name: string; ms: number }[];
  /** 上週同一天、到同一個時刻為止的已記錄 */
  prevSameSpanMs: number;
  /** v1.33 3A：預處理時間塊切片來源（有提供時支援即時篩選、單日時間塊明細與路線時數排行） */
  preparedSpans?: readonly ReportPreparedSpan[];
}

export interface ReportExpenseFact {
  day: string;
  at: string;
  minor: number;
  category: string;
  id?: string;
  item?: string;
  note?: string;
  routeId?: string | null;
  tagKeys?: readonly string[];
}

/** 售票口（沒通車＝null） */
export interface ReportMoneyFacts {
  /** 支出（主幣別淨額；退款是負的）：一筆一列 */
  expenses: readonly ReportExpenseFact[];
  /** 主幣別的小數位 */
  decimals: number;
  /** 這個月的總預算（沒設＝null） */
  budget: { month: string; budget: number; used: number; remaining: number } | null;
}

export interface ReportNoteFactItem {
  id: string;
  at: string;
  routeId: string | null;
  tagKeys?: readonly string[];
}

export interface ReportDiarySummaryFact {
  id: string;
  text: string;
  tagKeys?: readonly string[];
}

/** 旅客筆記（沒通車＝null） */
export interface ReportNotesFacts {
  /** 筆記（kind='note'，含收件匣的一句）的寫下時刻 */
  notedAt: readonly string[];
  /** 有日記的日子 */
  diaryDays: readonly string[];
  /** v1.33 3A：帶路線與荷札的筆記明細（有提供時支援依路線／#荷札篩選筆記數） */
  noteItems?: readonly ReportNoteFactItem[];
  /** v1.33 3A-1：各營業日的日記單行摘要預覽 */
  diarySummaries?: Readonly<Record<string, ReportDiarySummaryFact>>;
}

export interface ReportSealItemFact {
  at: string;
  nodeId: string;
  routeId: string | null;
  /** 單發票＝nodeId；定期券班次＝occurrences.id */
  id?: string;
  name?: string;
  kind?: "train" | "car" | "ticket";
  /** 定期券班次日 YYYY-MM-DD；一般單發票為 null */
  dueOn?: string | null;
  /** 跟著済章讀的心情燈號（nodes.mood 或 occurrences.mood）；沒點＝null */
  mood?: "green" | "yellow" | "red" | null;
  tagKeys?: readonly string[];
}

export interface ReportLateFact {
  day: string;
  nodeId?: string;
  routeId?: string | null;
  tagKeys?: readonly string[];
}

export interface ReportDueDayItemFact {
  id: string;
  day: string;
  routeId: string | null;
  tagKeys?: readonly string[];
}

export interface ReportFacts {
  /** 今天（日界線日） */
  today: string;
  dayStartHour: number;
  weekStart: 0 | 1;
  /** 表格天數（舊介面相容：未傳 `period` 時依 `days` 決定 7d / 30d） */
  days: 7 | 30;
  /** v1.33 3A-2：彈性期間規格（優先於 `days`） */
  period?: ReportPeriodSpec;
  /** v1.33 3A-2：跨模組篩選條件 */
  filter?: ReportFilter;
  /** 資料實際載入的最早日（預設 `factsFrom(today)`） */
  loadedFrom?: string;
  /** 済章（seals.ts 口徑、已去重） */
  seals: readonly ReportSealItemFact[];
  /** 今日頁誤點區的票，歸到原本排的那天 */
  late: readonly ReportLateFact[];
  /** 今天起 7 天內的締切（未完成），日期升冪 */
  dueSoon: readonly ReportDue[];
  /** 每天到締切的票數（不分完成與否） */
  dueByDay: Readonly<Record<string, number>>;
  /** v1.33 3A-2：帶路線與荷札的締切明細（有提供時支援篩選後重算每日締切數） */
  dueItems?: readonly ReportDueDayItemFact[];
  routes: Readonly<Record<string, ReportRouteRef>>;
  time: ReportTimeFacts | null;
  money: ReportMoneyFacts | null;
  notes: ReportNotesFacts | null;
  /** 一年前的今天（沒有＝null） */
  yearAgo: { day: string; text: string } | null;
  /** 記事欄（③ 的 stamps）；沒有任何來源＝null（整欄不畫） */
  dayNotes: Readonly<Record<string, readonly string[]>> | null;
}

/** 事實預設要從哪一天讀起：近 30 天＋最舊那個完整週的上一週（37 天前） */
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
  /** this＝本週、last＝上週、week＝更早的週、period＝按月／自訂區間總計 */
  which: "this" | "last" | "week" | "period";
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

/* ── 3A-1：單日運行全貌原地展開明細 ── */

export interface ReportDaySealItem {
  id: string;
  nodeId: string;
  name: string;
  kind: "train" | "car" | "ticket";
  routeId: string | null;
  at: string;
  clock: string;
  /** 定期券班次日（非 null 代表定期券某回班次） */
  dueOn: string | null;
  /** 蓋章時的心情燈號（順暢 green／平穩 yellow／吃力 red） */
  mood?: "green" | "yellow" | "red" | null;
  tagKeys: readonly string[];
}

export interface ReportDayBlockItem {
  id: string;
  startClock: string;
  /** 運行中為 null */
  endClock: string | null;
  running: boolean;
  durMs: number;
  categoryName: string;
  taskName: string | null;
  routeId: string | null;
  note: string;
}

export interface ReportDayTimeDetail {
  totalMs: number;
  cats: readonly { id: string; name: string; ms: number }[];
  blocks: readonly ReportDayBlockItem[];
}

export interface ReportDayExpenseItem {
  id: string;
  category: string;
  item?: string;
  note: string;
  minor: number;
  routeId: string | null;
  at: string;
  clock: string;
  tagKeys?: readonly string[];
}

export interface ReportDayMoneyDetail {
  totalSpent: number;
  decimals: number;
  entries: readonly ReportDayExpenseItem[];
}

export interface ReportDayDiaryInfo {
  hasDiary: boolean;
  summary: string | null;
}

export interface ReportDayDetail {
  day: string;
  seals: readonly ReportDaySealItem[];
  time: ReportDayTimeDetail | null;
  money: ReportDayMoneyDetail | null;
  diary: ReportDayDiaryInfo | null;
}

/* ── v1.33：一日運行專頁（手帳跨頁 Daily Spread）型別 ── */

export interface ReportSpreadDiaryEntry {
  id: string;
  entryDate: string;
  title: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  clock: string;
  /** 補記（寫下那天的日界線日 ≠ 歸屬日） */
  isBackfilled: boolean;
}

export interface ReportSpreadReflection {
  id: string;
  promptKey: string;
  category: WindowPromptCategory;
  categoryLabel: string;
  question: string;
  answer: string;
  answeredOn: string;
  createdAt: string;
}

export interface ReportWorkLogFact {
  id: string;
  nodeId: string;
  nodeName: string;
  body: string;
  at: string;
  nodeMissing: boolean;
}

export interface ReportWorkLogItem extends ReportWorkLogFact {
  clock: string;
}

export interface ReportDaySpreadData {
  day: string;
  isToday: boolean;
  detail: ReportDayDetail;
  routes: Readonly<Record<string, ReportRouteRef>>;
  /** 當日車站／路線到站等記事章 */
  dayNotes: readonly string[];
  /** 當日乘務記錄手記（手寫體正文，依時刻升冪；由原日記當天足跡無損交接） */
  workLogs: readonly ReportWorkLogItem[];
  /** 當日心情三色燈彙總列（依完成時刻升冪，不含 null） */
  moods: readonly ("green" | "yellow" | "red")[];
  /** 旅客筆記通車時為當日日記全文陣列（空陣列＝尚未寫日記）；未通車為 null */
  diaries: readonly ReportSpreadDiaryEntry[] | null;
  /** 當日「車窓の問い」問答手札（無回答時為空陣列） */
  reflections: readonly ReportSpreadReflection[];
}

export interface SingleDaySpreadFacts {
  day: string;
  today: string;
  dayStartHour: number;
  routes: Readonly<Record<string, ReportRouteRef>>;
  seals: readonly ReportSealItemFact[];
  /** 當日乘務記錄手記原始列（未傳預設空陣列） */
  workLogs?: readonly ReportWorkLogFact[];
  time: ReportTimeFacts | null;
  money: { expenses: readonly ReportExpenseFact[]; decimals: number } | null;
  /** 旅客筆記通車時傳入當日日記列；未通車傳 null */
  diaries:
    | readonly {
        id: string;
        entryDate: string;
        title: string | null;
        body: string;
        createdAt: string;
        updatedAt: string;
      }[]
    | null;
  /** 理想手札問答列（此處統一過濾 deleted_at === null && answered_on === day 並排序） */
  reflections: readonly Pick<
    IdealReflectionRow,
    "id" | "prompt_key" | "category" | "question" | "answer" | "answered_on" | "created_at" | "deleted_at"
  >[];
  dayNotes: readonly string[];
}

/* ── 3A-2：路線實績排行卡與已完成車票歷史明細流 ── */

export interface ReportRouteRankRow {
  /** null＝未掛路線／臨時車票 */
  routeId: string | null;
  name: string;
  code: string | null;
  color: string | null;
  inDepot: boolean;
  seals: number;
  timeMs: number | null;
  spent: number | null;
}

export interface ReportCompletedDayGroup {
  day: string;
  isToday: boolean;
  items: readonly ReportDaySealItem[];
}

export interface OperationReport {
  today: string;
  range: ResolvedReportRange;
  filterActive: boolean;
  brief: ReportBrief;
  ride: ReportRideCard;
  time: ReportTimeCard | null;
  money: ReportMoneyCard | null;
  notes: ReportNotesCard | null;
  due: ReportDueCard;
  yearAgo: { day: string; text: string } | null;
  rows: readonly ReportRow[];
  /** 3A-1：區間內各營業日的完整展開明細 */
  dayDetails: Readonly<Record<string, ReportDayDetail>>;
  /** 3A-2：區間內各路線的實績排行（預設依 seals 排序；前端可用 `sortRouteRanks` 秒切排序基準） */
  routeRanks: readonly ReportRouteRankRow[];
  /** 3A-2：區間內已完成車票歷史明細流（依營業日倒序分組） */
  completedGroups: readonly ReportCompletedDayGroup[];
  completedTotal: number;
  /** 記事欄要不要畫 */
  hasDayNotes: boolean;
  /** 表格細長條的分母（表裡最大的那天；0＝不畫） */
  max: { seals: number; timeMs: number; spent: number };
}

/* ═══════════ 期間與篩選純函式（3A-2） ═══════════ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function isValidDateKey(s: string | undefined | null): s is string {
  if (!s || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function monthLastDay(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

export function shiftReportMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** 解析彈性期間設定為明確的 `[from, to]` 營業日區間（迄日不超過 `today`） */
export function resolveReportRange(today: string, spec: ReportPeriodSpec): ResolvedReportRange {
  const curMonth = today.slice(0, 7);
  switch (spec.mode) {
    case "today":
      return { mode: "today", from: today, to: today, month: curMonth, label: "今日" };
    case "7d":
      return { mode: "7d", from: addDays(today, -6), to: today, month: curMonth, label: "近 7 天" };
    case "30d":
      return { mode: "30d", from: addDays(today, -29), to: today, month: curMonth, label: "近 30 天" };
    case "month": {
      const m = spec.month && MONTH_RE.test(spec.month) && spec.month <= curMonth ? spec.month : curMonth;
      const from = `${m}-01`;
      const last = monthLastDay(m);
      const to = m === curMonth && today < last ? today : last;
      const [yy, mm] = m.split("-").map(Number);
      return { mode: "month", from, to, month: m, label: `${yy}年${mm}月` };
    }
    case "custom": {
      let a = isValidDateKey(spec.customFrom) ? spec.customFrom : addDays(today, -13);
      let b = isValidDateKey(spec.customTo) ? spec.customTo : today;
      if (a > b) [a, b] = [b, a];
      if (b > today) b = today;
      if (a > b) a = b;
      const fmt = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
      return {
        mode: "custom",
        from: a,
        to: b,
        month: b.slice(0, 7),
        label: a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`,
      };
    }
  }
}

/** 計算要向資料層撈取的事實窗：同時涵蓋上方「今天 vs 上週」卡片、近 30 天預設與當前自選區間（含前一週比較緩衝） */
export function reportFetchWindow(today: string, weekStart: 0 | 1, range: { from: string; to: string }): { from: string; to: string } {
  const baseFrom = factsFrom(today);
  const rangeBufFrom = addDays(weekStartOf(range.from, weekStart), -7);
  return {
    from: rangeBufFrom < baseFrom ? rangeBufFrom : baseFrom,
    to: range.to > today ? range.to : today,
  };
}

/** 本機記憶期間模式的編解碼（相容舊版 `"7"`／`"30"` 字串） */
export function parseReportPeriodPref(raw: string | null | undefined, today: string): ReportPeriodSpec {
  if (!raw) return { mode: "7d" };
  if (raw === "30") return { mode: "30d" };
  if (raw === "7") return { mode: "7d" };
  try {
    const o = JSON.parse(raw) as Partial<ReportPeriodSpec>;
    if (!o || typeof o !== "object") return { mode: "7d" };
    if (o.mode === "today" || o.mode === "7d" || o.mode === "30d") return { mode: o.mode };
    if (o.mode === "month") return { mode: "month", month: today.slice(0, 7) };
    if (o.mode === "custom") {
      const r = resolveReportRange(today, { mode: "custom", customFrom: o.customFrom, customTo: o.customTo });
      return { mode: "custom", customFrom: r.from, customTo: r.to };
    }
    return { mode: "7d" };
  } catch {
    return { mode: "7d" };
  }
}

export function serializeReportPeriodPref(spec: ReportPeriodSpec): string {
  if (spec.mode === "custom") {
    return JSON.stringify({ mode: "custom", customFrom: spec.customFrom, customTo: spec.customTo });
  }
  return JSON.stringify({ mode: spec.mode });
}

export function normalizeReportTagKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const k = keyOf(raw) ?? raw.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

export function isReportFilterActive(filter: ReportFilter | undefined): boolean {
  if (!filter) return false;
  return filter.scope.kind !== "all" || filter.tagKeys.length > 0;
}

/**
 * 判斷單筆事實是否符合「幹線／路線 ＋ #荷札（多選 AND，父含子）」跨模組篩選條件。
 */
export function matchesReportFilter(
  item: { routeId: string | null | undefined; tagKeys?: readonly string[] },
  filter: ReportFilter | undefined,
  routes: Readonly<Record<string, ReportRouteRef>>,
): boolean {
  if (!filter) return true;
  const rId = item.routeId && routes[item.routeId] ? item.routeId : null;
  switch (filter.scope.kind) {
    case "all":
      break;
    case "none":
      if (rId !== null) return false;
      break;
    case "route":
      if (rId !== filter.scope.routeId) return false;
      break;
    case "line":
      if (rId === null || routes[rId]?.lineId !== filter.scope.lineId) return false;
      break;
  }
  if (filter.tagKeys.length > 0) {
    const norm = normalizeReportTagKeys(filter.tagKeys);
    if (norm.length > 0) {
      const entityKeys = item.tagKeys ?? [];
      if (entityKeys.length === 0) return false;
      for (const fk of norm) {
        if (!entityKeys.some((ek) => isUnder(ek, fk))) return false;
      }
    }
  }
  return true;
}

/** 路線實績排行排序切換（支援依蓋済車票數、投入時數、相關支出排序） */
export function sortRouteRanks(rows: readonly ReportRouteRankRow[], sortBy: RouteRankSort): ReportRouteRankRow[] {
  const metric = (r: ReportRouteRankRow): number => {
    if (sortBy === "time") return r.timeMs ?? 0;
    if (sortBy === "money") return r.spent ?? 0;
    return r.seals;
  };
  return [...rows].sort((a, b) => {
    const d = metric(b) - metric(a);
    if (d !== 0) return d;
    if (b.seals !== a.seals) return b.seals - a.seals;
    if ((b.timeMs ?? 0) !== (a.timeMs ?? 0)) return (b.timeMs ?? 0) - (a.timeMs ?? 0);
    if ((b.spent ?? 0) !== (a.spent ?? 0)) return (b.spent ?? 0) - (a.spent ?? 0);
    const aNull = a.routeId === null ? 1 : 0;
    const bNull = b.routeId === null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    return a.name.localeCompare(b.name);
  });
}

/** 已完成車票歷史明細流：關鍵字快速過濾（比對車票名、路線名／代碼、`#荷札`、「定期」） */
export function filterCompletedGroups(
  groups: readonly ReportCompletedDayGroup[],
  query: string,
  routes: Readonly<Record<string, Pick<ReportRouteRef, "name" | "code">>>,
  tagDisplayName?: (key: string) => string,
): { groups: ReportCompletedDayGroup[]; total: number } {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    const total = groups.reduce((acc, g) => acc + g.items.length, 0);
    return { groups: [...groups], total };
  }
  const out: ReportCompletedDayGroup[] = [];
  let total = 0;
  for (const g of groups) {
    const matched = g.items.filter((it) => {
      const r = it.routeId ? routes[it.routeId] : undefined;
      const tagsText = it.tagKeys
        .map((k) => (tagDisplayName ? tagDisplayName(k) : k))
        .join(" ")
        .toLowerCase();
      const hay = [
        it.name.toLowerCase(),
        (r?.name ?? "臨時車票").toLowerCase(),
        (r?.code ?? "").toLowerCase(),
        it.dueOn ? `定期 ${it.dueOn}` : "",
        tagsText,
      ].join(" ");
      return tokens.every((tk) => hay.includes(tk));
    });
    if (matched.length > 0) {
      out.push({ ...g, items: matched });
      total += matched.length;
    }
  }
  return { groups: out, total };
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

function wallClockOfIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ═══════════ 主函式 ═══════════ */

export function buildOperationReport(f: ReportFacts, now: number): OperationReport {
  const { today, dayStartHour: h } = f;
  const spec: ReportPeriodSpec = f.period ?? { mode: f.days === 30 ? "30d" : "7d" };
  const range = resolveReportRange(today, spec);
  const filter = f.filter;
  const filterActive = isReportFilterActive(filter);
  const floor = f.loadedFrom ?? factsFrom(today);

  const lastWeekDay = addDays(today, -7);
  const cut = Math.max(0, now - startMs(today, h)); // 今天已經過了多久

  /* ── 套用跨模組篩選（未啟用篩選時零損耗保留原陣列） ── */
  const seals = filterActive ? f.seals.filter((s) => matchesReportFilter(s, filter, f.routes)) : f.seals;
  const lates = filterActive ? f.late.filter((l) => matchesReportFilter({ routeId: l.routeId ?? null, tagKeys: l.tagKeys }, filter, f.routes)) : f.late;
  const dueSoonRaw = filterActive ? f.dueSoon.filter((d) => matchesReportFilter(d, filter, f.routes)) : f.dueSoon;
  const expenses = f.money
    ? filterActive
      ? f.money.expenses.filter((e) => matchesReportFilter({ routeId: e.routeId ?? null, tagKeys: e.tagKeys }, filter, f.routes))
      : f.money.expenses
    : null;

  /* ── 時刻表切片（若有 preparedSpans 則即時切片出每日明細與路線時數；否則相容舊版靜態欄位） ── */
  const slicedTime =
    f.time?.preparedSpans !== undefined
      ? slicePreparedTime({
          spans: f.time.preparedSpans,
          filter: filterActive
            ? (s) => matchesReportFilter({ routeId: s.routeId, tagKeys: s.tagKeys }, filter, f.routes)
            : undefined,
          today,
          rangeFrom: range.from,
          rangeTo: range.to,
          tableFloor: floor,
          dayStartHour: h,
          now,
        })
      : null;

  const timeByDay: Readonly<Record<string, number>> | null = slicedTime ? slicedTime.byDay : f.time?.byDay ?? null;

  /* ── 每天的數字與分日桶 ── */
  const sealsByDay: Record<string, number> = {};
  const sealItemsByDay = new Map<string, ReportDaySealItem[]>();
  for (const s of seals) {
    const d = dayKeyOf(s.at, h);
    bump(sealsByDay, d);
    if (d >= range.from && d <= range.to) {
      const item: ReportDaySealItem = {
        id: s.id ?? `${s.nodeId}:${s.at}`,
        nodeId: s.nodeId,
        name: s.name ?? "車票",
        kind: s.kind ?? "ticket",
        routeId: s.routeId !== null && f.routes[s.routeId] ? s.routeId : null,
        at: s.at,
        clock: wallClockOfIso(s.at),
        dueOn: s.dueOn ?? null,
        mood: s.mood ?? null,
        tagKeys: s.tagKeys ?? [],
      };
      const arr = sealItemsByDay.get(d);
      if (arr) arr.push(item);
      else sealItemsByDay.set(d, [item]);
    }
  }

  const lateByDay: Record<string, number> = {};
  for (const l of lates) if (l.day < today) bump(lateByDay, l.day);

  const spentByDay: Record<string, number> = {};
  const expItemsByDay = new Map<string, ReportDayExpenseItem[]>();
  if (expenses) {
    for (let idx = 0; idx < expenses.length; idx++) {
      const e = expenses[idx];
      bump(spentByDay, e.day, e.minor);
      if (e.day >= range.from && e.day <= range.to) {
        const item: ReportDayExpenseItem = {
          id: e.id ?? `${e.day}-${idx}`,
          category: e.category,
          item: e.item ?? "",
          note: e.note ?? "",
          minor: e.minor,
          routeId: e.routeId && f.routes[e.routeId] ? e.routeId : null,
          at: e.at,
          clock: wallClockOfIso(e.at),
          tagKeys: e.tagKeys ?? [],
        };
        const arr = expItemsByDay.get(e.day);
        if (arr) arr.push(item);
        else expItemsByDay.set(e.day, [item]);
      }
    }
  }

  const notesByDay: Record<string, number> = {};
  let filteredNoteTimes: readonly string[] = f.notes?.notedAt ?? [];
  if (f.notes) {
    if (filterActive && f.notes.noteItems) {
      filteredNoteTimes = f.notes.noteItems
        .filter((n) => matchesReportFilter({ routeId: n.routeId, tagKeys: n.tagKeys }, filter, f.routes))
        .map((n) => n.at);
    }
    for (const atIso of filteredNoteTimes) bump(notesByDay, dayKeyOf(atIso, h));
  }
  const diarySet = new Set(f.notes?.diaryDays ?? []);

  let effectiveDueByDay: Readonly<Record<string, number>> = f.dueByDay;
  if (filterActive && f.dueItems) {
    const m: Record<string, number> = {};
    for (const d of f.dueItems) {
      if (matchesReportFilter({ routeId: d.routeId, tagKeys: d.tagKeys }, filter, f.routes)) {
        bump(m, d.day);
      }
    }
    effectiveDueByDay = m;
  }

  /* ── 上半：卡片（答今天；比較＝上週同一天到同一個時刻） ── */
  const todaySeals = seals.filter((s) => dayKeyOf(s.at, h) === today);
  const prevSeals = seals.filter((s) => dayKeyOf(s.at, h) === lastWeekDay && withinCut(s.at, lastWeekDay, h, cut)).length;
  const byRoute = new Map<string | null, number>();
  for (const s of todaySeals) {
    const k = s.routeId !== null && f.routes[s.routeId] ? s.routeId : null;
    byRoute.set(k, (byRoute.get(k) ?? 0) + 1);
  }
  const routes = [...byRoute.entries()]
    .map(([routeId, n]) => ({ routeId, n }))
    .sort((a, b) => b.n - a.n || (a.routeId === null ? 1 : 0) - (b.routeId === null ? 1 : 0) || nameOf(f, a.routeId).localeCompare(nameOf(f, b.routeId)))
    .slice(0, 4);
  const ride: ReportRideCard = { seals: todaySeals.length, late: lates.length, routes, cmp: todaySeals.length - prevSeals };

  let time: ReportTimeCard | null = null;
  if (f.time) {
    const ms = timeByDay?.[today] ?? 0;
    const rawCats = slicedTime ? slicedTime.todayCats : f.time.todayCats;
    const prevSame = slicedTime ? slicedTime.prevSameSpanMs : f.time.prevSameSpanMs;
    const cats = topFourCats(rawCats);
    time = { ms, cats, cmp: ms - prevSame };
  }

  let money: ReportMoneyCard | null = null;
  if (f.money && expenses) {
    const todayExp = expenses.filter((e) => e.day === today);
    const spent = todayExp.reduce((a, e) => a + e.minor, 0);
    const prev = expenses.filter((e) => e.day === lastWeekDay && withinCut(e.at, lastWeekDay, h, cut)).reduce((a, e) => a + e.minor, 0);
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
    const prev = filteredNoteTimes.filter((atIso) => dayKeyOf(atIso, h) === lastWeekDay && withinCut(atIso, lastWeekDay, h, cut)).length;
    notes = { count, diary: diarySet.has(today), cmp: count - prev };
  }

  const dueSoon = dueSoonRaw.filter((d) => d.day >= today && d.day <= addDays(today, 6));
  const due: ReportDueCard = { count: dueSoon.length, items: dueSoon.slice(0, 3) };

  /* ── 下半：每日運行實績與 3A-1 單日明細組裝 ── */
  const dayRow = (day: string): ReportDayRow => ({
    kind: "day",
    day,
    isToday: day === today,
    seals: sealsByDay[day] ?? 0,
    late: day < today ? lateByDay[day] ?? 0 : 0,
    timeMs: timeByDay ? timeByDay[day] ?? 0 : null,
    spent: f.money ? spentByDay[day] ?? 0 : null,
    notes: f.notes ? notesByDay[day] ?? 0 : null,
    diary: diarySet.has(day),
    due: effectiveDueByDay[day] ?? 0,
    dayNotes: f.dayNotes?.[day] ?? [],
  });

  const sumOf = (from: string, to: string) => {
    if (from < floor) return null;
    let sealsN = 0;
    let timeMs = 0;
    let spent = 0;
    let notesN = 0;
    let diaryDays = 0;
    let dueN = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = dayRow(d);
      sealsN += r.seals;
      timeMs += r.timeMs ?? 0;
      spent += r.spent ?? 0;
      notesN += r.notes ?? 0;
      if (r.diary) diaryDays++;
      dueN += r.due;
    }
    return {
      seals: sealsN,
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

  if (range.mode === "today") {
    rows.push(dayRow(today));
  } else {
    let cursor = range.to;
    while (cursor >= range.from) {
      const wk = weekStartOf(cursor, f.weekStart);
      const groupEnd = cursor;
      const groupStart = wk > range.from ? wk : range.from;
      for (let d = groupEnd; d >= groupStart; d = addDays(d, -1)) rows.push(dayRow(d));
      const complete = groupStart === wk && addDays(wk, 6) === groupEnd;
      const isThis = wk === thisWeek && groupStart === wk;
      if (isThis || complete) {
        const cur = sumOf(groupStart, groupEnd);
        if (cur) {
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
      }
      cursor = addDays(groupStart, -1);
    }

    if (range.mode === "7d") {
      const lw = addDays(thisWeek, -7);
      const ref = sumOf(lw, addDays(lw, 6));
      if (ref) rows.push({ kind: "sum", which: "last", weekOf: lw, reference: true, ...ref, cmp: null, cmpLabel: null });
    } else if ((range.mode === "month" || range.mode === "custom") && range.from < range.to) {
      const totalCur = sumOf(range.from, range.to);
      if (totalCur) {
        rows.push({
          kind: "sum",
          which: "period",
          weekOf: range.from,
          reference: false,
          ...totalCur,
          cmp: null,
          cmpLabel: null,
        });
      }
    }
  }

  /* ── 3A-1：逐日運行全貌明細卡 ── */
  const dayDetails: Record<string, ReportDayDetail> = {};
  const decimals = f.money?.decimals ?? 0;
  for (let d = range.to; d >= range.from; d = addDays(d, -1)) {
    const daySealList = (sealItemsByDay.get(d) ?? []).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const dayTime: ReportDayTimeDetail | null = f.time
      ? slicedTime?.dayDetails[d] ?? {
          totalMs: timeByDay?.[d] ?? 0,
          cats: d === today ? topFourCats(f.time.todayCats) : [],
          blocks: [],
        }
      : null;
    const dayExpList = (expItemsByDay.get(d) ?? []).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const dayMoney: ReportDayMoneyDetail | null = f.money
      ? {
          totalSpent: spentByDay[d] ?? 0,
          decimals,
          entries: dayExpList,
        }
      : null;
    const hasDiary = diarySet.has(d);
    const summaryText = f.notes?.diarySummaries?.[d]?.text ?? null;
    const dayDiary: ReportDayDiaryInfo | null = f.notes
      ? {
          hasDiary,
          summary: hasDiary ? summaryText : null,
        }
      : null;
    dayDetails[d] = {
      day: d,
      seals: daySealList,
      time: dayTime,
      money: dayMoney,
      diary: dayDiary,
    };
  }

  /* ── 3A-2：區間內路線實績排行卡 ── */
  const rankMap = new Map<string | null, { seals: number; timeMs: number; spent: number }>();
  const ensureRank = (rId: string | null) => {
    const norm = rId !== null && f.routes[rId] ? rId : null;
    let rec = rankMap.get(norm);
    if (!rec) {
      rec = { seals: 0, timeMs: 0, spent: 0 };
      rankMap.set(norm, rec);
    }
    return rec;
  };

  for (const list of sealItemsByDay.values()) {
    for (const s of list) ensureRank(s.routeId).seals += 1;
  }
  if (slicedTime) {
    for (const [rKey, ms] of Object.entries(slicedTime.byRouteInRange)) {
      if (ms > 0) ensureRank(rKey === "__none" ? null : rKey).timeMs += ms;
    }
  }
  for (const list of expItemsByDay.values()) {
    for (const e of list) {
      if (e.minor !== 0) ensureRank(e.routeId).spent += e.minor;
    }
  }

  const rawRanks: ReportRouteRankRow[] = [];
  for (const [routeId, agg] of rankMap.entries()) {
    if (agg.seals === 0 && agg.timeMs === 0 && agg.spent === 0) continue;
    const ref = routeId ? f.routes[routeId] : null;
    rawRanks.push({
      routeId,
      name: ref?.name ?? "未掛路線／臨時",
      code: ref?.code ?? null,
      color: ref?.color ?? null,
      inDepot: !!ref?.arrivedOn,
      seals: agg.seals,
      timeMs: f.time ? agg.timeMs : null,
      spent: f.money ? agg.spent : null,
    });
  }
  const routeRanks = sortRouteRanks(rawRanks, "seals");

  /* ── 3A-2：已完成車票歷史明細流（依營業日倒序分組，日內依完成時刻新→舊） ── */
  const completedGroups: ReportCompletedDayGroup[] = [];
  let completedTotal = 0;
  for (let d = range.to; d >= range.from; d = addDays(d, -1)) {
    const items = sealItemsByDay.get(d);
    if (!items || items.length === 0) continue;
    const desc = items.slice().sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
    completedGroups.push({
      day: d,
      isToday: d === today,
      items: desc,
    });
    completedTotal += desc.length;
  }

  const dayRows = rows.filter((r): r is ReportDayRow => r.kind === "day");
  const max = {
    seals: Math.max(0, ...dayRows.map((r) => r.seals)),
    timeMs: Math.max(0, ...dayRows.map((r) => r.timeMs ?? 0)),
    spent: Math.max(0, ...dayRows.map((r) => r.spent ?? 0)),
  };

  return {
    today,
    range,
    filterActive,
    brief: {
      seals: ride.seals,
      recordedMs: time ? time.ms : null,
      spent: money ? money.spent : null,
      decimals,
    },
    ride,
    time,
    money,
    notes,
    due,
    yearAgo: f.yearAgo,
    rows,
    dayDetails,
    routeRanks,
    completedGroups,
    completedTotal,
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
    const line = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX済]\]\s+)?|>\s*|\d+[.)]\s+)/, "").trim();
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

/** 運行報告與今日小結統一金額格式化：尊重售票口隱私遮罩（開啟時一律顯示 `****`） */
export function formatReportMoney(minor: number, decimals: number, masked = false): string {
  return formatDisplayMoney(minor, decimals, { whole: true, masked, withSymbol: false });
}

/** 運行報告金額比較差值格式化：開啟隱私遮罩時不洩漏漲跌方向與差額，統一顯示 `****` */
export function formatReportMoneyDelta(cmp: number, decimals: number, masked = false): string {
  if (masked) return MASK_STARS;
  return deltaText(cmp, (n) => moneyText(n, decimals, { whole: true }));
}

/* ═══════════ 一日運行專頁（手帳跨頁 Daily Spread）純函式 ═══════════ */

const SPREAD_WEEK_ZH = "日一二三四五六";

/** 一日運行專頁翻日：往前／往後 delta 天，往後最多停在 today（不進入未來） */
export function stepReportDay(day: string, delta: number, today: string): string {
  const base = isValidDateKey(day) ? day : today;
  const next = addDays(base, delta);
  return next > today ? today : next;
}

/** 專頁導航列日期字樣：「2026年11月18日（週三）」 */
export function formatReportSpreadDate(day: string): string {
  if (!isValidDateKey(day)) return day;
  const [y, m, d] = day.split("-").map(Number);
  const wk = SPREAD_WEEK_ZH[weekdayOf(day)] ?? "";
  return `${y}年${m}月${d}日（週${wk}）`;
}

function buildDayDetailFromRaw(input: {
  day: string;
  today: string;
  dayStartHour: number;
  routes: Readonly<Record<string, ReportRouteRef>>;
  seals: readonly ReportSealItemFact[];
  time: ReportTimeFacts | null;
  money: { expenses: readonly ReportExpenseFact[]; decimals: number } | null;
  diary: ReportDayDiaryInfo | null;
  now: number;
}): ReportDayDetail {
  const { day, today, dayStartHour: h, routes, seals, time, money, diary, now } = input;

  const daySeals: ReportDaySealItem[] = [];
  for (const s of seals) {
    if (dayKeyOf(s.at, h) !== day) continue;
    daySeals.push({
      id: s.id ?? `${s.nodeId}:${s.at}`,
      nodeId: s.nodeId,
      name: s.name ?? "車票",
      kind: s.kind ?? "ticket",
      routeId: s.routeId !== null && routes[s.routeId] ? s.routeId : null,
      at: s.at,
      clock: wallClockOfIso(s.at),
      dueOn: s.dueOn ?? null,
      mood: s.mood ?? null,
      tagKeys: s.tagKeys ?? [],
    });
  }
  daySeals.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const effToday = day < today ? day : today;
  const dayTime: ReportDayTimeDetail | null = time
    ? time.preparedSpans !== undefined
      ? slicePreparedTime({
          spans: time.preparedSpans,
          today: effToday,
          rangeFrom: day,
          rangeTo: day,
          tableFloor: day,
          dayStartHour: h,
          now,
        }).dayDetails[day] ?? { totalMs: 0, cats: [], blocks: [] }
      : {
          totalMs: time.byDay[day] ?? 0,
          cats: day === today ? topFourCats(time.todayCats) : [],
          blocks: [],
        }
    : null;

  let dayMoney: ReportDayMoneyDetail | null = null;
  if (money) {
    const entries: ReportDayExpenseItem[] = [];
    let totalSpent = 0;
    for (let idx = 0; idx < money.expenses.length; idx++) {
      const e = money.expenses[idx];
      if (e.day !== day) continue;
      totalSpent += e.minor;
      entries.push({
        id: e.id ?? `${e.day}-${idx}`,
        category: e.category,
        item: e.item ?? "",
        note: e.note ?? "",
        minor: e.minor,
        routeId: e.routeId && routes[e.routeId] ? e.routeId : null,
        at: e.at,
        clock: wallClockOfIso(e.at),
        tagKeys: e.tagKeys ?? [],
      });
    }
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    dayMoney = {
      totalSpent,
      decimals: money.decimals,
      entries,
    };
  }

  return {
    day,
    seals: daySeals,
    time: dayTime,
    money: dayMoney,
    diary,
  };
}

/** 從既有已載入的 ReportFacts 即時抽出未篩選的單日客觀明細（供專頁 0ms 首屏墊底） */
export function buildSingleDayDetail(f: ReportFacts, day: string, now: number): ReportDayDetail {
  const hasDiary = f.notes ? f.notes.diaryDays.includes(day) : false;
  const summary = hasDiary ? f.notes?.diarySummaries?.[day]?.text ?? null : null;
  return buildDayDetailFromRaw({
    day,
    today: f.today,
    dayStartHour: f.dayStartHour,
    routes: f.routes,
    seals: f.seals,
    time: f.time,
    money: f.money ? { expenses: f.money.expenses, decimals: f.money.decimals } : null,
    diary: f.notes ? { hasDiary, summary } : null,
    now,
  });
}

/** 組裝「一日運行專頁（手帳跨頁）」完整資料（支援任意區間外的歷史單日） */
export function buildSingleDaySpread(input: SingleDaySpreadFacts, now: number): ReportDaySpreadData {
  const { day, today, dayStartHour: h, routes } = input;

  const diaries: ReportSpreadDiaryEntry[] | null = input.diaries
    ? [...input.diaries]
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .map((d) => ({
          id: d.id,
          entryDate: d.entryDate,
          title: d.title && d.title.trim() ? d.title.trim() : null,
          body: d.body ?? "",
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          clock: wallClockOfIso(d.createdAt),
          isBackfilled: dayKeyOf(d.createdAt, h) !== d.entryDate,
        }))
    : null;

  const diaryInfo: ReportDayDiaryInfo | null =
    diaries !== null
      ? {
          hasDiary: diaries.length > 0,
          summary: diaries.length > 0 ? oneLine(diaries[0].title, diaries[0].body) || null : null,
        }
      : null;

  const detail = buildDayDetailFromRaw({
    day,
    today,
    dayStartHour: h,
    routes,
    seals: input.seals,
    time: input.time,
    money: input.money,
    diary: diaryInfo,
    now,
  });

  const reflections: ReportSpreadReflection[] = input.reflections
    .filter((r) => r.deleted_at === null && r.answered_on === day && r.answer.trim().length > 0)
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .map((r) => ({
      id: r.id,
      promptKey: r.prompt_key,
      category: r.category,
      categoryLabel: WINDOW_CATEGORY_LABEL[r.category] ?? "車窓の問い",
      question: r.question,
      answer: r.answer,
      answeredOn: r.answered_on,
      createdAt: r.created_at,
    }));

  const uniqueNotes: string[] = [];
  const seenNote = new Set<string>();
  for (const raw of input.dayNotes) {
    const clean = raw.trim();
    if (!clean || seenNote.has(clean)) continue;
    seenNote.add(clean);
    uniqueNotes.push(clean);
  }

  const workLogs: ReportWorkLogItem[] = (input.workLogs ?? [])
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((l) => ({
      ...l,
      clock: wallClockOfIso(l.at),
    }));

  const moods: ("green" | "yellow" | "red")[] = [];
  for (const s of detail.seals) {
    if (s.mood === "green" || s.mood === "yellow" || s.mood === "red") {
      moods.push(s.mood);
    }
  }

  return {
    day,
    isToday: day === today,
    detail,
    routes,
    dayNotes: uniqueNotes,
    workLogs,
    moods,
    diaries,
    reflections,
  };
}

/* ═══════════ G6：方針回顧轉日記 Markdown 純函式（3A-3） ═══════════ */

export interface AimDiaryItem {
  text: string;
  done: boolean;
  /** 綁定的路線或「路線 › 支線」顯示名；未綁定為 null */
  routeLabel?: string | null;
}

/**
 * 將當期週／月／年／車站方針清單格式化為溫潤的手帳 Markdown 段落。
 */
export function formatAimsReviewDiary(input: {
  title: string;
  rangeText?: string | null;
  aims: readonly AimDiaryItem[];
}): string {
  const rangePart = input.rangeText?.trim() ? `（${input.rangeText.trim()}）` : "";
  const heading = `### ${input.title.trim()}${rangePart}`;
  const lines = input.aims.map((a) => {
    const mark = a.done ? "[済]" : "[ ]";
    const route = a.routeLabel?.trim() ? `（${a.routeLabel.trim()}）` : "";
    return `- ${mark} ${a.text.trim()}${route}`;
  });
  return [heading, "", ...lines].join("\n");
}

/**
 * 將方針回顧 Markdown 溫柔附加至既有日記文末（絕不覆蓋既有文字！）。
 * 若當日日記已包含完全相同的回顧段落，則標記 `alreadyPresent: true` 避免重複貼入。
 */
export function appendReviewToDiaryBody(
  existingBody: string | null | undefined,
  reviewMarkdown: string,
): { body: string; alreadyPresent: boolean } {
  const block = reviewMarkdown.trim();
  const cur = (existingBody ?? "").replace(/\s+$/, "");
  if (!cur) {
    return { body: `${block}\n\n`, alreadyPresent: false };
  }
  if (cur.includes(block)) {
    return { body: existingBody ?? cur, alreadyPresent: true };
  }
  return {
    body: `${cur}\n\n---\n\n${block}\n\n`,
    alreadyPresent: false,
  };
}
