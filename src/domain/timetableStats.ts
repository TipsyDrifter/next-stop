/**
 * 時刻表線・統計與環比的純函式層（車次③ 契約 §3.1、0-8～0-10；甲席）。
 *
 * 鐵則：**只准 import `./timetable.ts` 與 `../lib/date.ts`**（牙齒：`scripts/tests/timetable-stats.test.ts` 第 12 項），
 * 相對路徑一律帶 `.ts`（`node --test` 直載）；只用可剝除語法。時間一律毫秒；日界線日 key 是 `YYYY-MM-DD`。
 *
 * 內容：
 *   1. 目標 `Goal`（`parseGoal`／`goalScopeJson`／`expandScope`／`goalWindow`／`goalProgress`／`goalPace`）
 *   2. 期的窗與環比（`periodWindow`／`shiftPeriod`／`compareWindow`／`trendKeys`）
 *   3. 碎塊與待確認（`classifySpans`）、一個窗的數字（`windowTotals`；切片規則只在 `timetable.ts` 的 `sliceSpans` 寫一次）
 *   4. 顯示字（`fmtDelta`／`fmtPct`）
 *   5. 整頁的計算（`buildStats`／`buildWeek`；store 只負責「讀資料、叫它、存結果」）
 *
 * 判定都「以現在為準」（0-8）：今天確認了上個月那塊，上個月的統計就跟著回到分類。
 */
import {
  MIN,
  durOf,
  fmtDur,
  msOf,
  segmentsOfDay,
  sliceSpans,
  totalsByGroup,
  weekStartKey,
  type AxisItem,
  type Span,
  type TimeBlockSlim,
  type TimeCategoryRow,
  type TimeGoalRow,
} from "./timetable.ts";
import { addDays, dayWindow, toDateKey, todayKey } from "../lib/date.ts";

/* ───────────────────────── 1. 型別 ───────────────────────── */

export type StatsPeriod = "day" | "week" | "month";
/** 期間型態（D-時-42 修訂）：day／week／month＝週期重複；since＝從某天起；until＝到某天為止；range＝單一區間 */
export type GoalPeriod = StatsPeriod | "since" | "until" | "range";
export type GoalDirection = "atLeast" | "atMost";

export interface Goal {
  id: string;
  name: string;
  /** scope.categories（原樣，已刪除的也在；展開與略過在 `expandScope`） */
  categoryIds: string[];
  period: GoalPeriod;
  targetMin: number;
  direction: GoalDirection;
  /** since／until／range 的起點（含，日界線日）；週期重複＝null */
  startOn: string | null;
  /** until／range 的終點（含當天整天，日界線日）；其餘 null */
  endOn: string | null;
  position: number;
  archived: boolean;
}

/** 統計用的時間塊：Span ＋ 預估、連結 */
export interface StatsSpan extends Span {
  estimateMin: number | null;
  nodeId: string | null;
  routeId: string | null;
}

export function toStatsSpan(r: TimeBlockSlim): StatsSpan {
  return {
    id: r.id,
    categoryId: r.category_id,
    start: msOf(r.started_at),
    end: r.ended_at === null ? null : msOf(r.ended_at),
    ack: r.long_run_ack === 1,
    estimateMin: r.estimate_min,
    nodeId: r.node_id,
    routeId: r.route_id,
  };
}

/** 一期的窗；key＝期的第一個日界線日 */
export interface PeriodWindow {
  key: string;
  start: number;
  end: number;
}

/** 路線鍵的兩個保留值（`routeOf` 回路線 id，或這兩個） */
export const ROUTE_NONE = "__none";
export const ROUTE_GONE = "__gone";

/** 一個節點解出來的路線（store 以 `nodeRepo.getNode` 解、快取）；gone＝節點找不到或已刪除，routeId＝它所屬路線（路線節點＝自己） */
export interface NodeRoute {
  gone: boolean;
  routeId: string | null;
}

/**
 * 依路線（0-9）：節點 → 它的路線；節點已刪／找不到而塊上有 `route_id` ⇒ 算 route_id，否則 ROUTE_GONE（「（已刪除的任務）」）；
 * 沒連節點 ⇒ 塊上的 route_id（只連路線），再沒有 ⇒ ROUTE_NONE（「沒連任務」）。活節點沒掛路線（臨時車票）：退回塊上的 route_id，再沒有算沒連。
 * `node`＝s.nodeId 解出來的結果；undefined（沒解到）當作節點不在。
 */
export function routeKeyOf(s: StatsSpan, node: NodeRoute | undefined): string {
  if (s.nodeId !== null) {
    if (node && !node.gone) return node.routeId ?? s.routeId ?? ROUTE_NONE;
    return s.routeId ?? ROUTE_GONE;
  }
  return s.routeId ?? ROUTE_NONE;
}

/* ───────────────────────── 2. 目標 ───────────────────────── */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` 而且是真實存在的日期（2026-02-31 不算；評審 #5） */
export function isRealDateKey(k: unknown): k is string {
  if (typeof k !== "string" || !DATE_KEY_RE.test(k)) return false;
  const y = Number(k.slice(0, 4));
  const m = Number(k.slice(5, 7));
  const d = Number(k.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * 一列 `time_goals` → `Goal`。**不認得 ⇒ null**（前向相容，0-5）：period／direction 不在清單、scope 解不開或形狀不對、
 * target_min 不是正整數；日期欄不是真實存在的日期（含 2026-02-31）；until／range 缺 end_on、end_on < start_on；range 缺 start_on。
 * since／until 而 start_on **缺**（null／空字串）⇒ 退回建立日（資料壞了的保險，我們自己寫的不會空）——用**日界線日**
 * （`todayKey(h, 建立時刻)`，不是 UTC 日期；評審 #5）；有填但格式錯 ⇒ null。週期重複一律忽略 start_on／end_on。
 * `h`＝日界線小時（顯示端傳設定值；repository 改寫既有目標時不傳——那條路徑缺起點本來就會被 `normalizeGoalInput` 擋下）。
 */
export function parseGoal(r: TimeGoalRow, h = 6): Goal | null {
  const period = r.period;
  if (period !== "day" && period !== "week" && period !== "month" && period !== "since" && period !== "until" && period !== "range") return null;
  const direction = r.direction;
  if (direction !== "atLeast" && direction !== "atMost") return null;
  let scope: unknown;
  try {
    scope = JSON.parse(r.scope);
  } catch {
    return null;
  }
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return null;
  const cats = (scope as { categories?: unknown }).categories;
  if (!Array.isArray(cats)) return null;
  const categoryIds: string[] = [];
  for (const c of cats) if (typeof c === "string" && !categoryIds.includes(c)) categoryIds.push(c);
  if (typeof r.target_min !== "number" || !Number.isInteger(r.target_min) || r.target_min <= 0) return null;
  let startOn: string | null = null;
  let endOn: string | null = null;
  if (period === "since" || period === "until" || period === "range") {
    const missing = r.start_on === null || r.start_on === undefined || r.start_on === "";
    if (!missing && !isRealDateKey(r.start_on)) return null;
    if (missing) {
      if (period === "range") return null;
      const created = new Date(r.created_at);
      if (Number.isNaN(created.getTime())) return null;
      startOn = todayKey(h, created);
    } else {
      startOn = r.start_on as string;
    }
  }
  if (period === "until" || period === "range") {
    if (!isRealDateKey(r.end_on)) return null;
    if (startOn !== null && r.end_on < startOn) return null; // YYYY-MM-DD 字串比較＝日期比較
    endOn = r.end_on;
  }
  return {
    id: r.id,
    name: r.name,
    categoryIds,
    period,
    targetMin: r.target_min,
    direction,
    startOn,
    endOn,
    position: r.position,
    archived: r.archived_at !== null,
  };
}

/** `scope` 欄的 JSON（⑥ 荷札進站後加 "tags"，不加欄） */
export function goalScopeJson(categoryIds: readonly string[]): string {
  const ids: string[] = [];
  for (const id of categoryIds) if (!ids.includes(id)) ids.push(id);
  return JSON.stringify({ categories: ids });
}

/** 寫入用的目標欄位（面板送進來的；`normalizeGoalInput` 驗過才落地） */
export interface GoalInput {
  name: string;
  categoryIds: readonly string[];
  period: GoalPeriod;
  targetMin: number;
  direction: GoalDirection;
  /** since／until／range 必填（日界線日）；週期重複一律存 null。until 的預設是建立當天（面板填，repository 不猜） */
  startOn: string | null;
  /** until／range 必填（含當天整天，須 ≥ startOn）；其餘一律存 null */
  endOn: string | null;
}

export const GOAL_NAME_MAX = 24;

/**
 * 驗證並整理（兩個 repository 共用，訊息逐字相同）。不合法 ⇒ `RangeError("<人話>")`（store 接住後 toast 它的 message）。
 * 名字 trim 後 1–24 字；分類至少一個（去重）；期間、方向要認得；目標時數 > 0 的整數分鐘；
 * since／until／range 要有起點、until／range 要有終點且終點 ≥ 起點；其餘欄存 null。
 */
export function normalizeGoalInput(input: GoalInput): GoalInput {
  const name = input.name.trim();
  if (!name) throw new RangeError("目標名稱不能是空的");
  if (Array.from(name).length > GOAL_NAME_MAX) throw new RangeError(`目標名稱最多 ${GOAL_NAME_MAX} 個字`);
  const categoryIds: string[] = [];
  for (const id of input.categoryIds) if (typeof id === "string" && id && !categoryIds.includes(id)) categoryIds.push(id);
  if (!categoryIds.length) throw new RangeError("至少選一個分類");
  const p = input.period;
  if (p !== "day" && p !== "week" && p !== "month" && p !== "since" && p !== "until" && p !== "range") {
    throw new RangeError("期間要選每日、每週、每月、從某天起、到某天為止或單一區間");
  }
  if (input.direction !== "atLeast" && input.direction !== "atMost") throw new RangeError("方向要選至少或至多");
  if (!Number.isInteger(input.targetMin) || input.targetMin <= 0) throw new RangeError("目標時數要大於 0");
  let startOn: string | null = null;
  let endOn: string | null = null;
  if (p === "since" || p === "until" || p === "range") {
    if (!isRealDateKey(input.startOn)) throw new RangeError("要選一個起點日期");
    startOn = input.startOn;
  }
  if (p === "until" || p === "range") {
    if (!isRealDateKey(input.endOn)) throw new RangeError("要選一個截止日期");
    if (startOn !== null && input.endOn < startOn) throw new RangeError("截止日期不能早於起點");
    endOn = input.endOn;
  }
  return { name, categoryIds, period: p, targetMin: input.targetMin, direction: input.direction, startOn, endOn };
}

/** `Goal` → 可編輯欄位（編輯面板的初值；patch 合併用） */
export function goalToInput(g: Goal): GoalInput {
  return { name: g.name, categoryIds: g.categoryIds.slice(), period: g.period, targetMin: g.targetMin, direction: g.direction, startOn: g.startOn, endOn: g.endOn };
}

/**
 * 目標的 scope → 實際要加總的分類 id 集合：頂層 id＝它自己＋底下所有（未刪除的）子分類（算的時候展開，所以含之後新增的）；
 * 子分類 id＝它自己。已刪除的、找不到的 id 略過；已封存的照算（封存的分類仍有歷史塊）。
 */
export function expandScope(categoryIds: readonly string[], cats: readonly TimeCategoryRow[]): Set<string> {
  const byId = new Map<string, TimeCategoryRow>();
  const kids = new Map<string, string[]>();
  for (const c of cats) {
    byId.set(c.id, c);
    if (c.parent_id !== null && c.deleted_at === null) {
      const arr = kids.get(c.parent_id);
      if (arr) arr.push(c.id);
      else kids.set(c.parent_id, [c.id]);
    }
  }
  const out = new Set<string>();
  for (const id of categoryIds) {
    const c = byId.get(id);
    if (!c || c.deleted_at !== null) continue;
    out.add(id);
    if (c.parent_id === null) for (const k of kids.get(id) ?? []) out.add(k);
  }
  return out;
}

/**
 * 進度：`ms`＝scope 內各分類時數加總；`ratio`＝ms ÷ 目標（目標 ≤ 0 ⇒ 0）。
 * atLeast：met＝ms ≥ 目標、over 恆 false；atMost：over＝ms > 目標、met＝!over。
 */
export function goalProgress(
  g: Goal,
  byCategory: Record<string, number>,
  cats: readonly TimeCategoryRow[],
): { ms: number; ratio: number; met: boolean; over: boolean } {
  const scope = expandScope(g.categoryIds, cats);
  let ms = 0;
  for (const id of scope) ms += byCategory[id] ?? 0;
  const target = g.targetMin * MIN;
  const ratio = target > 0 ? ms / target : 0;
  if (g.direction === "atLeast") return { ms, ratio, met: ms >= target, over: false };
  const over = ms > target;
  return { ms, ratio, met: !over, over };
}

/** 兩個 YYYY-MM-DD 相差幾天（b − a） */
function dayDiff(aKey: string, bKey: string): number {
  const t = (k: string): number => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((t(bKey) - t(aKey)) / 86_400_000);
}

/**
 * 目標的有效窗（D-時-42 修訂、0-9）：
 *   週期重複＝含今天的那一期（state 恆 active）；
 *   since＝[start_on 日界線, null)（今天 < start_on ⇒ upcoming）；
 *   until／range＝[start_on 日界線, end_on 隔天日界線)——終點含當天整天（今天 < start_on ⇒ upcoming、今天 > end_on ⇒ ended）。
 * `end` null＝沒有終點。state 用日界線日 key 比，不看時分。
 */
export function goalWindow(
  g: Goal,
  todayKeyStr: string,
  h: number,
  weekStart: 0 | 1,
): { start: number; end: number | null; state: "upcoming" | "active" | "ended" } {
  if (g.period === "day" || g.period === "week" || g.period === "month") {
    const w = periodWindow(g.period, todayKeyStr, h, weekStart);
    return { start: w.start, end: w.end, state: "active" };
  }
  const startKey = g.startOn ?? todayKeyStr;
  const start = startMsOfKey(startKey, h);
  const end = g.endOn !== null ? startMsOfKey(addDays(g.endOn, 1), h) : null;
  const state = todayKeyStr < startKey ? "upcoming" : g.endOn !== null && todayKeyStr > g.endOn ? "ended" : "active";
  return { start, end, state };
}

/** 週期重複目標的上一整期（其餘型態沒有） */
export function goalPrevWindow(g: Goal, todayKeyStr: string, h: number, weekStart: 0 | 1): { start: number; end: number } | null {
  if (g.period !== "day" && g.period !== "week" && g.period !== "month") return null;
  const cur = periodWindow(g.period, todayKeyStr, h, weekStart);
  const prev = periodWindow(g.period, shiftPeriod(g.period, cur.key, -1, weekStart), h, weekStart);
  return { start: prev.start, end: prev.end };
}

/** 從今天（含）到終點（含）還剩幾個日界線日；沒有終點／已結束 ⇒ null */
export function goalDaysLeft(g: Goal, todayKeyStr: string): number | null {
  if (g.endOn === null || todayKeyStr > g.endOn) return null;
  return dayDiff(todayKeyStr, g.endOn) + 1;
}

/**
 * 節奏（D-時-62）：至少＋有終點＋進行中＋還沒達成 ⇒ 平均每天還要幾毫秒（剩下的時數 ÷ 剩下的日界線日數，含今天）；其餘 null。
 * `ms`＝目前已累計；`_h` 保留給簽名（日界線日 key 已由呼叫端算好，這裡不需要）。
 */
export function goalPace(g: Goal, ms: number, todayKeyStr: string, _h: number): number | null {
  if (g.direction !== "atLeast" || g.endOn === null) return null;
  const startKey = g.startOn ?? todayKeyStr;
  if (todayKeyStr < startKey) return null; // 還沒開始
  const days = goalDaysLeft(g, todayKeyStr);
  if (days === null) return null; // 已結束
  const left = g.targetMin * MIN - ms;
  if (left <= 0) return null; // 已達成
  return left / days;
}

/* ───────────────────────── 3. 期的窗與環比 ───────────────────────── */

function monthFirstKey(key: string): string {
  return key.slice(0, 7) + "-01";
}

function addMonthsKey(firstKey: string, n: number): string {
  const y = Number(firstKey.slice(0, 4));
  const m = Number(firstKey.slice(5, 7));
  return toDateKey(new Date(y, m - 1 + n, 1));
}

/** 該日界線日所在的期的第一天 */
function periodFirstKey(p: StatsPeriod, dateKey: string, weekStart: 0 | 1): string {
  if (p === "day") return dateKey;
  if (p === "week") return weekStartKey(dateKey, weekStart);
  return monthFirstKey(dateKey);
}

function nextPeriodFirstKey(p: StatsPeriod, firstKey: string): string {
  if (p === "day") return addDays(firstKey, 1);
  if (p === "week") return addDays(firstKey, 7);
  return addMonthsKey(firstKey, 1);
}

const startMsOfKey = (key: string, h: number): number => msOf(dayWindow(key, h).start);

/**
 * 期的窗（0-9）：日＝日界線日；週＝`weekStartKey` 起 7 天；月＝當月 1 日起到下月 1 日。
 * 窗是整期 `[start, end)`；「有效段」（`min(end, now)`）由 `windowTotals` 套。
 */
export function periodWindow(p: StatsPeriod, dateKey: string, h: number, weekStart: 0 | 1): PeriodWindow {
  const key = periodFirstKey(p, dateKey, weekStart);
  return { key, start: startMsOfKey(key, h), end: startMsOfKey(nextPeriodFirstKey(p, key), h) };
}

/** 前後翻 `delta` 期；回新的期的第一天（`key` 沒對齊期的開頭也行，先對齊） */
export function shiftPeriod(p: StatsPeriod, key: string, delta: number, weekStart: 0 | 1): string {
  const first = periodFirstKey(p, key, weekStart);
  if (p === "day") return addDays(first, delta);
  if (p === "week") return addDays(first, 7 * delta);
  return addMonthsKey(first, delta);
}

/**
 * 環比的上期窗（D-時-45）：本期進行中（`now` 落在窗內）⇒ 上期取「上期開始 ＋ (now − 本期開始)」為截止，夾在上期結尾
 * （月份天數不同時一樣用經過的毫秒數，夾到上月月底），`compare:"sameSpan"`；本期已過完（或還沒開始）⇒ 上期整期，`"whole"`。
 */
export function compareWindow(
  p: StatsPeriod,
  cur: PeriodWindow,
  now: number,
  h: number,
  weekStart: 0 | 1,
): { prev: { start: number; end: number }; compare: "sameSpan" | "whole" } {
  const prev = periodWindow(p, shiftPeriod(p, cur.key, -1, weekStart), h, weekStart);
  if (now >= cur.start && now < cur.end) {
    return { prev: { start: prev.start, end: Math.min(prev.end, prev.start + (now - cur.start)) }, compare: "sameSpan" };
  }
  return { prev: { start: prev.start, end: prev.end }, compare: "whole" };
}

export const TREND_COUNT: Readonly<Record<StatsPeriod, number>> = { day: 14, week: 8, month: 6 };

/** 趨勢的各期第一天：日 14、週 8、月 6 個，由舊到新，最後一個＝key 所在的期 */
export function trendKeys(p: StatsPeriod, key: string, weekStart: 0 | 1): string[] {
  const n = TREND_COUNT[p];
  const last = periodFirstKey(p, key, weekStart);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftPeriod(p, last, -i, weekStart));
  return out;
}

/* ───────────────────────── 4. 碎塊、待確認、一個窗的數字 ───────────────────────── */

/** 碎塊：整塊長度 < 60 秒（0-8；運行中＝now − start） */
export const TINY_MS = 60_000;

export interface Classified {
  /** 待確認：`!ack` 且 `durOf > 門檻` */
  pending: Set<string>;
  /** 碎塊：不進任何統計 */
  tiny: Set<string>;
}

/**
 * 判定碎塊與待確認（0-8）。`th(s)`＝這一塊的門檻分鐘（null＝沒有門檻、永遠不會待確認）；
 * 已結束的塊由呼叫端用 `thresholdOf(estimate_min, 分類, 全域)`、運行中那班用含任務預計的版本。碎塊優先（碎塊不會是待確認）。
 */
export function classifySpans(spans: readonly StatsSpan[], now: number, th: (s: StatsSpan) => number | null): Classified {
  const pending = new Set<string>();
  const tiny = new Set<string>();
  for (const s of spans) {
    const dur = durOf(s, now);
    if (dur < TINY_MS) {
      tiny.add(s.id);
      continue;
    }
    if (s.ack) continue;
    const t = th(s);
    if (t !== null && dur > t * MIN) pending.add(s.id);
  }
  return { pending, tiny };
}

export interface WindowTotals {
  /** 分類 id → ms（已記錄；不含待確認、碎塊） */
  byCategory: Record<string, number>;
  /** 路線鍵 → ms（已記錄；路線鍵＝路線 id 或 ROUTE_NONE／ROUTE_GONE） */
  byRoute: Record<string, number>;
  recordedMs: number;
  pendingMs: number;
  /** 切進這個窗的待確認塊（班數＝length） */
  pendingIds: string[];
  /** 待確認的分布：分類 id → { 班數, ms }（目標卡的「另有 N 班待確認」用） */
  pendingByCategory: Record<string, { count: number; ms: number }>;
  /** 有效段長 − 已記錄 − 待確認，不為負 */
  unrecordedMs: number;
  /** 有效段長＝max(0, min(w.end, now) − w.start)；未來的窗＝0 */
  effectiveMs: number;
}

/**
 * 一個窗的數字（0-9）：先丟掉碎塊；其餘（含待確認）一起丟進 `sliceSpans`（重疊歸較晚開始者，與 `totalsByCategory` 同一條規則），
 * 切到的時間：屬於待確認塊 ⇒ `pendingMs`（不算分類、路線、目標）；其餘 ⇒ 分類與路線。
 * `routeOf` 回路線 id 或 ROUTE_NONE／ROUTE_GONE。
 */
export function windowTotals(
  spans: readonly StatsSpan[],
  cls: Classified,
  w: { start: number; end: number },
  now: number,
  routeOf: (s: StatsSpan) => string,
): WindowTotals {
  const effEnd = Math.min(w.end, now);
  const effectiveMs = Math.max(0, effEnd - w.start);
  const out: WindowTotals = {
    byCategory: {},
    byRoute: {},
    recordedMs: 0,
    pendingMs: 0,
    pendingIds: [],
    pendingByCategory: {},
    unrecordedMs: 0,
    effectiveMs,
  };
  if (effectiveMs <= 0) return out;
  // 先濾掉碎塊與不相交的（大資料時省掉切片的前置成本）
  const eligible: StatsSpan[] = [];
  const byId = new Map<string, StatsSpan>();
  for (const s of spans) {
    if (cls.tiny.has(s.id)) continue;
    if (s.start >= effEnd || (s.end ?? now) <= w.start) continue;
    eligible.push(s);
    byId.set(s.id, s);
  }
  // 待確認的班數：與窗相交就算一班（時數照切片，可能 0——被較晚開始的塊整段蓋住的髒資料也不會從清單消失；評審 #6）。
  // 一塊被切成好幾片也只算一班
  const seenPending = new Set<string>();
  const addPending = (id: string, categoryId: string, ms: number): void => {
    const pc = out.pendingByCategory[categoryId];
    if (seenPending.has(id)) {
      if (pc) pc.ms += ms;
      return;
    }
    seenPending.add(id);
    out.pendingIds.push(id);
    if (pc) {
      pc.count += 1;
      pc.ms += ms;
    } else {
      out.pendingByCategory[categoryId] = { count: 1, ms };
    }
  };
  for (const sl of sliceSpans(eligible, w, now)) {
    if (cls.pending.has(sl.id)) {
      out.pendingMs += sl.ms;
      addPending(sl.id, sl.categoryId, sl.ms);
      continue;
    }
    out.recordedMs += sl.ms;
    out.byCategory[sl.categoryId] = (out.byCategory[sl.categoryId] ?? 0) + sl.ms;
    const r = routeOf(byId.get(sl.id)!);
    out.byRoute[r] = (out.byRoute[r] ?? 0) + sl.ms;
  }
  for (const s of eligible) if (cls.pending.has(s.id) && !seenPending.has(s.id)) addPending(s.id, s.categoryId, 0);
  out.unrecordedMs = Math.max(0, effectiveMs - out.recordedMs - out.pendingMs);
  return out;
}

/* ───────────────────────── 5. 顯示字 ───────────────────────── */

/** 環比差（〈原型定案〉1）：「▲3h10m」「▼45m」（▲▼ 中性墨色，D-時-49）；|ms| < 1 分＝「持平」 */
export function fmtDelta(ms: number): string {
  if (!(Math.abs(ms) >= MIN)) return "持平";
  return (ms > 0 ? "▲" : "▼") + fmtDur(Math.abs(ms));
}

/** 百分比：「27%」「<1%」；part ≤ 0 ⇒ 「0%」；whole ≤ 0 ⇒ 「—」 */
export function fmtPct(part: number, whole: number): string {
  if (!(whole > 0)) return "—";
  if (!(part > 0)) return "0%";
  const pct = (part / whole) * 100;
  if (pct < 1) return "<1%";
  return Math.round(pct) + "%";
}

/* ───────────────────────── 6. 整頁的計算 ───────────────────────── */

export interface ShareChild {
  id: string;
  ms: number;
  prevMs: number;
}
/** 占比清單的一列：頂層（孤兒分類保留自己的 key 當頂層）；children 是它底下有數字的子分類 */
export interface ShareGroup {
  id: string;
  ms: number;
  prevMs: number;
  children: ShareChild[];
}

export interface TrendBar {
  /** 這一期的第一天 */
  key: string;
  start: number;
  end: number;
  byCategory: Record<string, number>;
  /** 頂層（totalsByGroup）；過濾到頂層分類、堆疊上色都用它 */
  byGroup: Record<string, number>;
  recordedMs: number;
  /** 最後一根（＝正在看的這一期） */
  isCurrent: boolean;
  /** `now` 落在這一期內（上緣畫虛線） */
  inProgress: boolean;
}

export interface RouteShare {
  /** 路線 id，或 ROUTE_GONE／ROUTE_NONE */
  key: string;
  ms: number;
  prevMs: number;
}

export interface PendingItem {
  id: string;
  categoryId: string;
  start: number;
  end: number | null;
  /** 整塊跑了多久（不夾窗；運行中算到 now） */
  durMs: number;
}

export interface GoalPeriodResult {
  start: number;
  end: number;
  ms: number;
  ratio: number;
  met: boolean;
  over: boolean;
  /** scope 內、切進這一期的待確認塊班數 */
  pendingCount: number;
  pendingMs: number;
  /** 同上那幾班（新到舊；目標卡「看看 ›」只列這個目標範圍的待確認，〈原型定案〉1） */
  pendingItems: PendingItem[];
}

export interface GoalView {
  goal: Goal;
  /** goal.categoryIds 裡還活著的（順序同 goal；卡片寫範圍用） */
  liveCategoryIds: string[];
  /** 期間狀態（D-時-60／61）：upcoming＝還沒開始（進度 0、卡灰）、active、ended＝已結束（蓋最後結果的章） */
  state: "upcoming" | "active" | "ended";
  /** 有效窗；end null＝沒有終點（since） */
  window: { start: number; end: number | null };
  /** 目前所在的期的結果：週期重複＝含今天的期；since＝start_on 起到現在；until／range＝整個區間（夾到現在；已結束＝整段） */
  cur: GoalPeriodResult;
  /** 上一整期的結果；只有週期重複有 */
  prev: GoalPeriodResult | null;
  /** D-時-62：平均每天還要幾毫秒（見 `goalPace`）；不顯示＝null */
  paceMs: number | null;
  /** 從今天（含）到終點（含）還剩幾天；沒有終點或已結束＝null */
  daysLeft: number | null;
}

export interface StatsResult {
  period: StatsPeriod;
  /** 正在看的期的第一天 */
  key: string;
  window: PeriodWindow;
  /** 算的時候的「今天」（日界線日）與 now */
  todayKey: string;
  now: number;
  /** 正在看的是含今天的那一期 */
  isCurrent: boolean;
  /** `now` 落在這一期內（＝isCurrent；未來的期不會被畫，store 夾住不讓翻過去） */
  inProgress: boolean;
  /** 沒有任何有效段（未來的期） */
  future: boolean;
  cur: WindowTotals;
  prev: WindowTotals;
  prevWindow: { start: number; end: number };
  compare: "sameSpan" | "whole";
  groups: ShareGroup[];
  trend: TrendBar[];
  routes: RouteShare[];
  /** 待確認的塊（切進這一期的），由新到舊 */
  pending: PendingItem[];
  /** 這一期完全沒有紀錄（已記錄與待確認都是 0） */
  empty: boolean;
}

export interface StatsInput {
  spans: readonly StatsSpan[];
  cats: readonly TimeCategoryRow[];
  /** 沒封存的目標 */
  goals: readonly Goal[];
  period: StatsPeriod;
  /** 正在看的期的第一天（或該期內任一天，會對齊） */
  key: string;
  now: number;
  /** 日界線小時 */
  h: number;
  weekStart: 0 | 1;
  /** 門檻分鐘（見 `classifySpans`） */
  thresholdMin: (s: StatsSpan) => number | null;
  routeOf: (s: StatsSpan) => string;
}

/**
 * 統計頁要的資料範圍起點（ms）：趨勢最早那期（環比上期一定落在它之後）。store 用它 `listBlocks(起點 → 現在)`。
 * **不含目標**（評審 #4）：目標跟正在看的期無關，另用 `goalsFromMs` 算、另讀；since 目標起點可能是一年前，
 * 不能讓它把整段歷史（連同節點查詢）拉進每次翻期的重算。
 */
export function statsFromMs(period: StatsPeriod, key: string, h: number, weekStart: 0 | 1): number {
  const keys = trendKeys(period, key, weekStart);
  return periodWindow(period, keys[0], h, weekStart).start;
}

/** 各目標要用到的最早時刻（週期重複＝上一整期的開頭、其餘＝有效窗的開頭）；沒有目標 ⇒ null */
export function goalsFromMs(goals: readonly Goal[], now: number, h: number, weekStart: 0 | 1): number | null {
  const today = todayKey(h, new Date(now));
  let from: number | null = null;
  for (const g of goals) {
    const prev = goalPrevWindow(g, today, h, weekStart);
    const s = prev ? prev.start : goalWindow(g, today, h, weekStart).start;
    from = from === null ? s : Math.min(from, s);
  }
  return from;
}

function groupRows(cats: readonly TimeCategoryRow[], cur: Record<string, number>, prev: Record<string, number>): ShareGroup[] {
  const byId = new Map<string, TimeCategoryRow>();
  for (const c of cats) byId.set(c.id, c);
  const ids = new Set<string>([...Object.keys(cur), ...Object.keys(prev)]);
  const groups = new Map<string, ShareGroup>();
  const topOf = (id: string): string => {
    const c = byId.get(id);
    return c && c.parent_id !== null ? c.parent_id : id;
  };
  for (const id of ids) {
    const ms = cur[id] ?? 0;
    const prevMs = prev[id] ?? 0;
    if (ms <= 0 && prevMs <= 0) continue;
    const top = topOf(id);
    let g = groups.get(top);
    if (!g) {
      g = { id: top, ms: 0, prevMs: 0, children: [] };
      groups.set(top, g);
    }
    g.ms += ms;
    g.prevMs += prevMs;
    // 頂層自己直接有塊（沒分到子分類）不出子列；子分類才出
    if (top !== id) g.children.push({ id, ms, prevMs });
  }
  const pos = (id: string): number => byId.get(id)?.position ?? 0;
  const cmp = (a: { id: string; ms: number; prevMs: number }, b: { id: string; ms: number; prevMs: number }): number =>
    b.ms - a.ms || b.prevMs - a.prevMs || pos(a.id) - pos(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const out = Array.from(groups.values());
  for (const g of out) g.children.sort(cmp);
  out.sort(cmp);
  return out;
}

function routeRows(cur: Record<string, number>, prev: Record<string, number>): RouteShare[] {
  const keys = new Set<string>([...Object.keys(cur), ...Object.keys(prev)]);
  const rows: RouteShare[] = [];
  for (const key of keys) {
    const ms = cur[key] ?? 0;
    const prevMs = prev[key] ?? 0;
    if (ms <= 0 && prevMs <= 0) continue;
    rows.push({ key, ms, prevMs });
  }
  const rank = (k: string): number => (k === ROUTE_NONE ? 2 : k === ROUTE_GONE ? 1 : 0); // 已刪除的任務在「沒連任務」之前
  rows.sort((a, b) => rank(a.key) - rank(b.key) || b.ms - a.ms || b.prevMs - a.prevMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

/** 一整頁統計的計算（純函式；效能量測的對象就是它裡面的 `windowTotals`） */
export function buildStats(input: StatsInput): StatsResult {
  const { spans, cats, period, now, h, weekStart } = input;
  const cls = classifySpans(spans, now, input.thresholdMin);
  const today = todayKey(h, new Date(now));
  const curWin = periodWindow(period, input.key, h, weekStart);
  const cmp = compareWindow(period, curWin, now, h, weekStart);
  const cur = windowTotals(spans, cls, curWin, now, input.routeOf);
  const prev = windowTotals(spans, cls, cmp.prev, now, input.routeOf);

  const keys = trendKeys(period, curWin.key, weekStart);
  const trend: TrendBar[] = keys.map((k, i) => {
    const w = i === keys.length - 1 ? curWin : periodWindow(period, k, h, weekStart);
    const t = i === keys.length - 1 ? cur : windowTotals(spans, cls, w, now, input.routeOf);
    return {
      key: w.key,
      start: w.start,
      end: w.end,
      byCategory: t.byCategory,
      byGroup: totalsByGroup(t.byCategory, cats),
      recordedMs: t.recordedMs,
      isCurrent: i === keys.length - 1,
      inProgress: now >= w.start && now < w.end,
    };
  });

  // 待確認清單：切進這一期的待確認塊，由新到舊（目標由 buildGoals 另算——目標跟正在看的期無關）
  const inWindow = new Set(cur.pendingIds);
  const pending: PendingItem[] = spans
    .filter((s) => inWindow.has(s.id))
    .map((s) => ({ id: s.id, categoryId: s.categoryId, start: s.start, end: s.end, durMs: durOf(s, now) }))
    .sort((a, b) => b.start - a.start || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  return {
    period,
    key: curWin.key,
    window: curWin,
    todayKey: today,
    now,
    isCurrent: now >= curWin.start && now < curWin.end,
    inProgress: now >= curWin.start && now < curWin.end,
    future: cur.effectiveMs === 0,
    cur,
    prev,
    prevWindow: cmp.prev,
    compare: cmp.compare,
    groups: groupRows(cats, cur.byCategory, prev.byCategory),
    trend,
    routes: routeRows(cur.byRoute, prev.byRoute),
    pending,
    empty: cur.recordedMs <= 0 && cur.pendingMs <= 0,
  };
}

/** 各目標的進度（跟正在看的期無關，永遠是「現在」所在的那一期；0-9 目標進度） */
export function buildGoals(
  goals: readonly Goal[],
  spans: readonly StatsSpan[],
  cats: readonly TimeCategoryRow[],
  opts: {
    now: number;
    h: number;
    weekStart: 0 | 1;
    thresholdMin: (s: StatsSpan) => number | null;
    /** 目標用不到路線；不傳＝一律 ROUTE_NONE（呼叫端不必為了目標去解節點，評審 #4） */
    routeOf?: (s: StatsSpan) => string;
  },
): GoalView[] {
  if (!goals.length) return [];
  const cls = classifySpans(spans, opts.now, opts.thresholdMin);
  const today = todayKey(opts.h, new Date(opts.now));
  const catById = new Map<string, TimeCategoryRow>();
  for (const c of cats) catById.set(c.id, c);
  const spanById = new Map<string, StatsSpan>();
  for (const s of spans) spanById.set(s.id, s);
  const routeOf = opts.routeOf ?? ((): string => ROUTE_NONE);
  const one = (g: Goal, scope: Set<string>, w: { start: number; end: number }): GoalPeriodResult => {
    const t = windowTotals(spans, cls, w, opts.now, routeOf);
    const p = goalProgress(g, t.byCategory, cats);
    let pendingCount = 0;
    let pendingMs = 0;
    for (const id of Object.keys(t.pendingByCategory)) {
      if (!scope.has(id)) continue;
      pendingCount += t.pendingByCategory[id].count;
      pendingMs += t.pendingByCategory[id].ms;
    }
    const pendingItems: PendingItem[] = [];
    for (const id of t.pendingIds) {
      const s = spanById.get(id);
      if (s && scope.has(s.categoryId)) pendingItems.push({ id: s.id, categoryId: s.categoryId, start: s.start, end: s.end, durMs: durOf(s, opts.now) });
    }
    pendingItems.sort((a, b) => b.start - a.start || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return { start: w.start, end: w.end, ...p, pendingCount, pendingMs, pendingItems };
  };
  const views = goals.map((g): GoalView => {
    const scope = expandScope(g.categoryIds, cats);
    const win = goalWindow(g, today, opts.h, opts.weekStart);
    const prevWin = goalPrevWindow(g, today, opts.h, opts.weekStart);
    const live = g.categoryIds.filter((id) => {
      const c = catById.get(id);
      return !!c && c.deleted_at === null;
    });
    const cur = one(g, scope, { start: win.start, end: win.end ?? Number.MAX_SAFE_INTEGER });
    return {
      goal: g,
      liveCategoryIds: live,
      state: win.state,
      window: { start: win.start, end: win.end },
      cur,
      prev: prevWin ? one(g, scope, prevWin) : null,
      paceMs: win.state === "active" ? goalPace(g, cur.ms, today, opts.h) : null,
      daysLeft: win.state === "active" ? goalDaysLeft(g, today) : null,
    };
  });
  // 排序（5.2-5）：進行中 → 未開始 → 已結束，同類照 position（Array.sort 在 ES2019+ 穩定，原順序＝store 給的 position 序）
  const rank = { active: 0, upcoming: 1, ended: 2 } as const;
  return views.sort((a, b) => rank[a.state] - rank[b.state] || a.goal.position - b.goal.position);
}

/* ───────────────────────── 7. 週視圖 ───────────────────────── */

export interface WeekDay {
  dateKey: string;
  start: number;
  end: number;
  /** `segmentsOfDay` 的輸出（塊與空白；碎塊照畫）。gap 給「點空白＝補記」用 */
  items: AxisItem[];
  /** 欄頭的「已記錄時數」（統計規則：不含碎塊、待確認） */
  recordedMs: number;
  isToday: boolean;
}

export interface WeekResult {
  /** 這一週的第一天 */
  key: string;
  window: PeriodWindow;
  days: WeekDay[];
  /** 待確認的塊 id（週視圖畫赭色斜紋；判定同統計） */
  pendingIds: string[];
  isCurrent: boolean;
  todayKey: string;
  now: number;
}

export function buildWeek(input: {
  spans: readonly StatsSpan[];
  key: string;
  now: number;
  h: number;
  weekStart: 0 | 1;
  thresholdMin: (s: StatsSpan) => number | null;
}): WeekResult {
  const { spans, now, h, weekStart } = input;
  const cls = classifySpans(spans, now, input.thresholdMin);
  const win = periodWindow("week", input.key, h, weekStart);
  const today = todayKey(h, new Date(now));
  const days: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const dateKey = addDays(win.key, i);
    const dw = periodWindow("day", dateKey, h, weekStart);
    const items = segmentsOfDay(spans, { start: dw.start, end: dw.end }, now);
    const t = windowTotals(spans, cls, dw, now, () => ROUTE_NONE);
    days.push({ dateKey, start: dw.start, end: dw.end, items, recordedMs: t.recordedMs, isToday: dateKey === today });
  }
  return {
    key: win.key,
    window: win,
    days,
    pendingIds: Array.from(cls.pending),
    isCurrent: now >= win.start && now < win.end,
    todayKey: today,
    now,
  };
}

/* ───────────────────────── 8. 看哪一期（store 的純邏輯，抽出來才測得到；評審 #7、#10） ───────────────────────── */

/**
 * 正在看的那一期的第一天。`follow`（停在本期）＝今天所在的期；否則＝**參考日**所在的期，再夾到不超過本期。
 * 參考日是「使用者翻到的那一期裡的某一天」，store 只存它、不把這裡算出來的對齊後的 key 寫回去——
 * 週起點／日界線設定來回改，才會回到原來那一期而不漂移（評審 #7：10/5 週一 → 週日起 → 週一起 ＝ 同一週）。
 */
export function resolveViewKey(p: StatsPeriod, follow: boolean, ref: string, today: string, h: number, weekStart: 0 | 1): string {
  const cur = periodWindow(p, today, h, weekStart).key;
  if (follow) return cur;
  const k = periodWindow(p, ref, h, weekStart).key;
  return k > cur ? cur : k; // YYYY-MM-DD 字串比較＝日期比較
}

/**
 * 翻期：`delta` 期（+1 下一期、−1 上一期），不能翻到未來（到本期就停）。
 * 回新的參考日（＝新那一期的第一天）、是否停在本期、新那一期的第一天；沒變 ⇒ null。
 */
export function stepView(
  p: StatsPeriod,
  follow: boolean,
  ref: string,
  today: string,
  delta: number,
  h: number,
  weekStart: 0 | 1,
): { ref: string; follow: boolean; key: string } | null {
  const cur = periodWindow(p, today, h, weekStart).key;
  const base = resolveViewKey(p, follow, ref, today, h, weekStart);
  let next = shiftPeriod(p, base, delta, weekStart);
  if (next > cur) next = cur;
  const nextFollow = next === cur;
  if (next === base && nextFollow === follow) return null;
  return { ref: next, follow: nextFollow, key: next };
}

/**
 * 一趟計算算完回來，使用者看的期已經換了嗎（換了 ⇒ 這份結果作廢）。`computed`＝開算時看的是哪一期（period、follow、解出來的 key），
 * `cur`＝現在 store 裡的狀態。`today` 用開算時的今天（跨日的重算由 checkDay／rev 另排）。
 */
export function viewChangedSince(
  computed: { period: StatsPeriod; follow: boolean; key: string },
  cur: { period: StatsPeriod; follow: boolean; ref: string },
  today: string,
  h: number,
  weekStart: 0 | 1,
): boolean {
  return (
    cur.period !== computed.period ||
    cur.follow !== computed.follow ||
    resolveViewKey(cur.period, cur.follow, cur.ref, today, h, weekStart) !== computed.key
  );
}

/** #72 換日：算的時候的「今天」跟現在的今天不同 ⇒ 該重算（只比字串） */
export function dayRolledOver(computedToday: string | null | undefined, nowToday: string): boolean {
  return !!computedToday && computedToday !== nowToday;
}

/** 解路線只用得到的節點欄位（`NodeRow` 的子集） */
export interface NodeRouteFields {
  id: string;
  kind: string;
  route_id: string | null;
  deleted_at: string | null;
}

/** 節點列 → 它的路線（同 store 的 getNode 解法）；沒有這一列 ⇒ null */
export function nodeRouteOf(n: NodeRouteFields | null | undefined): NodeRoute | null {
  if (!n) return null;
  if (n.deleted_at !== null) return { gone: true, routeId: null };
  return { gone: false, routeId: n.kind === "route" ? n.id : n.route_id };
}

/**
 * nodeStore.tree 變了：快取裡「窗內出現過的節點」有哪些要重解（評審 #10）。
 * 新的樹裡有這個節點 ⇒ 比它解出來的路線跟快取一不一樣；新的樹沒有但舊的有（被刪、搬走、換了路線樹）⇒ 當作變了；
 * 兩邊都沒有 ⇒ 樹跟這個節點無關（它是 getNode 讀來的，不在目前打開的路線裡），維持快取。
 */
export function staleNodeIds(
  ids: Iterable<string>,
  cache: ReadonlyMap<string, NodeRoute>,
  prev: Readonly<Record<string, NodeRouteFields | undefined>>,
  next: Readonly<Record<string, NodeRouteFields | undefined>>,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const n = next[id];
    if (n) {
      const want = nodeRouteOf(n)!;
      const have = cache.get(id);
      if (!have || have.gone !== want.gone || have.routeId !== want.routeId) out.push(id);
    } else if (prev[id]) {
      out.push(id);
    }
  }
  return out;
}

/** nodeStore.routes 變了：統計用到的那幾條路線的名字、刪除狀態有變嗎（沒用到的路線改名不重算） */
export function routesChanged(
  used: Iterable<string>,
  prev: readonly { id: string; name: string; deleted_at: string | null }[],
  next: readonly { id: string; name: string; deleted_at: string | null }[],
): boolean {
  const a = new Map(prev.map((r) => [r.id, r] as const));
  const b = new Map(next.map((r) => [r.id, r] as const));
  for (const id of used) {
    const x = a.get(id);
    const y = b.get(id);
    if (!x && !y) continue;
    if (!x || !y || x.name !== y.name || (x.deleted_at === null) !== (y.deleted_at === null)) return true;
  }
  return false;
}
