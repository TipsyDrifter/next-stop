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
 *
 * ⑥ 荷札接軌（⑥ 契約 §3.1、0-4、0-10；只加）：`StatsSpan.tagKeys`（store 填）→ `WindowTotals.byTag`／`untaggedMs`、
 * `StatsResult.tags`／`untagged`、`TrendBar.byTag`；目標範圍＝分類 ∪ 荷札（`Goal.tagKeys`、`goalMember`、`goalProgressIn` 逐塊判），
 * scope 認 v1／v2（`parseGoal`、`goalScopeJson`、`goalScopeNext`）。荷札的推導規則在 `timetableTags.ts`（這支檔不 import 它）。
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
  /** v1.29 D-時-192：跨層級範圍——路線 ID（向上匯總路線本身＋路線下所有節點） */
  routeIds?: string[];
  /** v1.29 D-時-192：跨層級範圍——支線／列車／車廂／車票節點 ID（向上匯總該節點＋其下所有子孫節點） */
  nodeIds?: string[];
  period: GoalPeriod;
  targetMin: number;
  direction: GoalDirection;
  /** since／until／range 的起點（含，日界線日）；週期重複＝null */
  startOn: string | null;
  /** until／range 的終點（含當天整天，日界線日）；其餘 null */
  endOn: string | null;
  position: number;
  archived: boolean;
  /**
   * ⑥（0-4）：目標綁的荷札 keys——**由 store 從 taggings（`timetable:goal`）填**，不看 scope 是 v1 還是 v2；
   * `parseGoal` 一律給 `[]`。範圍＝分類 ∪ 路線 ∪ 節點（含子樹） ∪ 荷札（`goalMember`）。
   */
  tagKeys: string[];
}

/** 統計用的時間塊：Span ＋ 預估、連結 */
export interface StatsSpan extends Span {
  estimateMin: number | null;
  nodeId: string | null;
  routeId: string | null;
  /**
   * ⑥（0-9／0-10）：這一塊的全部荷札 keys（手動 ∪ 分類推導；`timetableTags.ts` 的 `blockTags`），
   * 由 store 在算之前填好（純函式不認得 tagStore）；`toStatsSpan` 給 `[]`。
   */
  tagKeys: readonly string[];
}

const NO_TAGS: readonly string[] = Object.freeze([]) as readonly string[];

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
    tagKeys: NO_TAGS,
  };
}

/** key 是不是落在 k 或它底下（同 `timetableTags.ts` 的 `underKey`；這支檔只准 import timetable.ts 與 lib/date.ts，所以自帶一份） */
function keyUnder(key: string, k: string): boolean {
  return key === k || key.startsWith(k + "/");
}

/** 一組 keys 的所有前綴（含自己；`a/b/c` ⇒ a、a/b、a/b/c），去重。同一個陣列只算一次（byTag 的「同塊同前綴只算一次」） */
const prefixCache = new WeakMap<readonly string[], readonly string[]>();
function prefixesOf(keys: readonly string[]): readonly string[] {
  let out = prefixCache.get(keys);
  if (out) return out;
  const set = new Set<string>();
  for (const k of keys) {
    let i = k.indexOf("/");
    while (i >= 0) {
      set.add(k.slice(0, i));
      i = k.indexOf("/", i + 1);
    }
    set.add(k);
  }
  out = Array.from(set);
  prefixCache.set(keys, out);
  return out;
}

/** 一期的窗；key＝期的第一個日界線日 */
export interface PeriodWindow {
  key: string;
  start: number;
  end: number;
}

/** 路線鍵的三個保留值（`routeOf` 回路線 id，或這三個） */
export const ROUTE_NONE = "__none";
export const ROUTE_GONE = "__gone";
/** 任務還在、但任務和塊都沒路線（臨時車票；磨光③ 2-5，D-時-139）——跟「沒連任務」分開列 */
export const ROUTE_NOROUTE = "__noroute";

/** 一個節點解出來的路線（store 以 `nodeRepo.getNode` 解、快取）；gone＝節點找不到或已刪除，routeId＝它所屬路線（路線節點＝自己） */
export interface NodeRoute {
  gone: boolean;
  routeId: string | null;
}

/**
 * 依路線（0-9）：節點 → 它的路線；節點已刪／找不到而塊上有 `route_id` ⇒ 算 route_id，否則 ROUTE_GONE（「（已刪除的任務）」）；
 * 沒連節點 ⇒ 塊上的 route_id（只連路線），再沒有 ⇒ ROUTE_NONE（「沒連任務」）。活節點沒掛路線（臨時車票）：退回塊上的 route_id，
 * 再沒有 ⇒ ROUTE_NOROUTE（「沒有路線的任務」；任務在，不算沒連）。
 * `node`＝s.nodeId 解出來的結果；undefined（沒解到）當作節點不在。
 */
export function routeKeyOf(s: StatsSpan, node: NodeRoute | undefined): string {
  if (s.nodeId !== null) {
    if (node && !node.gone) return node.routeId ?? s.routeId ?? ROUTE_NOROUTE;
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
  const cats = scopeCategoriesOf(scope);
  if (cats === null) return null;
  const categoryIds: string[] = [];
  for (const c of cats) if (typeof c === "string" && !categoryIds.includes(c)) categoryIds.push(c);
  const { routes, nodes } = scopeLinksOf(scope);
  const routeIds: string[] = [];
  for (const x of routes) if (typeof x === "string" && x && !routeIds.includes(x)) routeIds.push(x);
  const nodeIds: string[] = [];
  for (const x of nodes) if (typeof x === "string" && x && !nodeIds.includes(x)) nodeIds.push(x);
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
  const out: Goal = {
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
    tagKeys: [],
  };
  if (routeIds.length > 0) out.routeIds = routeIds;
  if (nodeIds.length > 0) out.nodeIds = nodeIds;
  return out;
}

/**
 * scope 物件 → 分類 id 陣列（原樣，還沒去重）；認不得 ⇒ null（0-4）：
 *   v1 `{"categories":[…]}`（多的鍵忽略）；v2 `{"v":2,"cats":[…]}`（有綁荷札／路線／任務的目標；舊版讀成 null）。
 *   有 `v` 鍵就照 v 判（v≠2 ⇒ null，給更新的版本用）；`{"cats":[…]}` 沒有 v ⇒ null。
 */
function scopeCategoriesOf(scope: unknown): unknown[] | null {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return null;
  const o = scope as { v?: unknown; cats?: unknown; categories?: unknown };
  if ("v" in o) return o.v === 2 && Array.isArray(o.cats) ? o.cats : null;
  return Array.isArray(o.categories) ? o.categories : null;
}

function scopeLinksOf(scope: unknown): { routes: unknown[]; nodes: unknown[] } {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return { routes: [], nodes: [] };
  const o = scope as { v?: unknown; routes?: unknown; nodes?: unknown };
  if (o.v !== 2) return { routes: [], nodes: [] };
  return {
    routes: Array.isArray(o.routes) ? o.routes : [],
    nodes: Array.isArray(o.nodes) ? o.nodes : [],
  };
}

/** scope 欄是哪一版：1＝`{"categories":[…]}`、2＝`{"v":2,"cats":[…]}`；解不開或認不得 ⇒ null */
export function goalScopeVersion(scopeJson: string): 1 | 2 | null {
  let scope: unknown;
  try {
    scope = JSON.parse(scopeJson);
  } catch {
    return null;
  }
  if (scopeCategoriesOf(scope) === null) return null;
  return "v" in (scope as object) ? 2 : 1;
}

export interface GoalScopeExtra {
  routeIds?: readonly string[];
  nodeIds?: readonly string[];
}

/**
 * `scope` 欄的 JSON（0-4、D-時-192）：只綁分類 ⇒ v1 `{"categories":[…]}`（舊版照常讀寫）；
 * `hasTags`（有綁荷札）或有綁路線／任務節點 ⇒ v2 `{"v":2,"cats":[…], ...}`、沒有 `categories` 鍵（舊版 `parseGoal` 讀成 null、不畫也不能改）。
 * 荷札本身不在這欄（在 `timetable:goal` 的 taggings）。寫既有目標請用 `goalScopeNext`（v2 有黏性）。
 */
export function goalScopeJson(categoryIds: readonly string[], hasTags = false, extra?: GoalScopeExtra): string {
  const ids: string[] = [];
  for (const id of categoryIds) if (!ids.includes(id)) ids.push(id);
  const routes: string[] = [];
  for (const id of extra?.routeIds ?? []) if (typeof id === "string" && id && !routes.includes(id)) routes.push(id);
  const nodes: string[] = [];
  for (const id of extra?.nodeIds ?? []) if (typeof id === "string" && id && !nodes.includes(id)) nodes.push(id);
  if (hasTags || routes.length > 0 || nodes.length > 0) {
    const obj: { v: 2; cats: string[]; routes?: string[]; nodes?: string[] } = { v: 2, cats: ids };
    if (routes.length > 0) obj.routes = routes;
    if (nodes.length > 0) obj.nodes = nodes;
    return JSON.stringify(obj);
  }
  return JSON.stringify({ categories: ids });
}

/**
 * 寫既有目標時的 scope（0-4「v2 有黏性」）：這次有荷札／路線／任務，**或**目標列現在的 scope 已經是 v2 ⇒ 寫 v2
 * （就算這次沒帶 tagNames、就算荷札全被摘了）；否則 v1。`prevScope`＝目標列現在的 scope 欄（新目標傳 null）。
 */
export function goalScopeNext(
  prevScope: string | null,
  categoryIds: readonly string[],
  hasTags: boolean,
  extra?: GoalScopeExtra,
): string {
  return goalScopeJson(categoryIds, hasTags || (prevScope !== null && goalScopeVersion(prevScope) === 2), extra);
}

/** 寫入用的目標欄位（面板送進來的；`normalizeGoalInput` 驗過才落地） */
export interface GoalInput {
  name: string;
  categoryIds: readonly string[];
  /** v1.29 D-時-192：跨層級範圍——路線 ID */
  routeIds?: readonly string[];
  /** v1.29 D-時-192：跨層級範圍——支線／列車／車廂／車票節點 ID */
  nodeIds?: readonly string[];
  period: GoalPeriod;
  targetMin: number;
  direction: GoalDirection;
  /** since／until／range 必填（日界線日）；週期重複一律存 null。until 的預設是建立當天（面板填，repository 不猜） */
  startOn: string | null;
  /** until／range 必填（含當天整天，須 ≥ startOn）；其餘一律存 null */
  endOn: string | null;
  /**
   * ⑥（0-4、0-11）：目標綁的荷札名稱（面板草稿；存檔時 repository 用 `tagRepo.setTags(TT_TAG_GOAL, id, tagNames)`）。
   * **沒給（undefined）＝不動荷札**；給了空陣列＝摘光。驗證只算「有幾個」（名稱合不合法由 tagRepo 判）。
   */
  tagNames?: readonly string[];
}

export const GOAL_NAME_MAX = 24;

/** 驗證字（0-4；`TT_TEXT.tags.goalScopeEmpty` 同字） */
export const GOAL_SCOPE_EMPTY = "請選至少一個分類或荷札";

/**
 * 驗證並整理（兩個 repository 共用，訊息逐字相同）。不合法 ⇒ `RangeError("<人話>")`（store 接住後 toast 它的 message）。
 * 名字 trim 後 1–24 字；分類／路線／任務／荷札**至少要有一個**（⑥ 0-4、D-時-192；`tagNames` 沒給算 0 個）；
 * 期間、方向要認得；目標時數 > 0 的整數分鐘；
 * since／until／range 要有起點、until／range 要有終點且終點 ≥ 起點；其餘欄存 null。
 * 回傳的 `tagNames`：輸入有給才有（沒給＝repository 不動荷札）。
 */
export function normalizeGoalInput(input: GoalInput): GoalInput {
  const name = input.name.trim();
  if (!name) throw new RangeError("請輸入目標名稱");
  if (Array.from(name).length > GOAL_NAME_MAX) throw new RangeError(`目標名稱最多 ${GOAL_NAME_MAX} 字`);
  const categoryIds: string[] = [];
  for (const id of input.categoryIds) if (typeof id === "string" && id && !categoryIds.includes(id)) categoryIds.push(id);
  const routeIds: string[] = [];
  for (const id of input.routeIds ?? []) if (typeof id === "string" && id && !routeIds.includes(id)) routeIds.push(id);
  const nodeIds: string[] = [];
  for (const id of input.nodeIds ?? []) if (typeof id === "string" && id && !nodeIds.includes(id)) nodeIds.push(id);
  let tagNames: string[] | undefined;
  if (input.tagNames !== undefined) {
    tagNames = [];
    for (const raw of input.tagNames) {
      if (typeof raw !== "string") continue;
      const t = raw.trim().replace(/^#/, "");
      if (t && !tagNames.includes(t)) tagNames.push(t);
    }
  }
  if (!categoryIds.length && !routeIds.length && !nodeIds.length && !(tagNames && tagNames.length)) {
    throw new RangeError(GOAL_SCOPE_EMPTY);
  }
  const p = input.period;
  if (p !== "day" && p !== "week" && p !== "month" && p !== "since" && p !== "until" && p !== "range") {
    throw new RangeError("請選擇目標期間");
  }
  if (input.direction !== "atLeast" && input.direction !== "atMost") throw new RangeError("請選擇「至少」或「至多」");
  if (!Number.isInteger(input.targetMin) || input.targetMin <= 0) throw new RangeError("目標時數要大於 0");
  let startOn: string | null = null;
  let endOn: string | null = null;
  if (p === "since" || p === "until" || p === "range") {
    if (!isRealDateKey(input.startOn)) throw new RangeError("請選開始日期");
    startOn = input.startOn;
  }
  if (p === "until" || p === "range") {
    if (!isRealDateKey(input.endOn)) throw new RangeError("要選一個截止日期");
    if (startOn !== null && input.endOn < startOn) throw new RangeError("截止日期不能早於起點");
    endOn = input.endOn;
  }
  const out: GoalInput = { name, categoryIds, period: p, targetMin: input.targetMin, direction: input.direction, startOn, endOn };
  if (input.routeIds !== undefined) out.routeIds = routeIds;
  if (input.nodeIds !== undefined) out.nodeIds = nodeIds;
  if (tagNames !== undefined) out.tagNames = tagNames;
  return out;
}

/** `Goal` → 可編輯欄位（編輯面板的初值；patch 合併用） */
export function goalToInput(g: Goal): GoalInput {
  const out: GoalInput = {
    name: g.name,
    categoryIds: g.categoryIds.slice(),
    period: g.period,
    targetMin: g.targetMin,
    direction: g.direction,
    startOn: g.startOn,
    endOn: g.endOn,
  };
  if (g.routeIds && g.routeIds.length > 0) out.routeIds = g.routeIds.slice();
  if (g.nodeIds && g.nodeIds.length > 0) out.nodeIds = g.nodeIds.slice();
  return out;
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

/** ms → 進度（目標 ≤ 0 ⇒ ratio 0）。atLeast：met＝ms ≥ 目標、over 恆 false；atMost：over＝ms > 目標、met＝!over */
function progressOf(g: Goal, ms: number): { ms: number; ratio: number; met: boolean; over: boolean } {
  const target = g.targetMin * MIN;
  const ratio = target > 0 ? ms / target : 0;
  if (g.direction === "atLeast") return { ms, ratio, met: ms >= target, over: false };
  const over = ms > target;
  return { ms, ratio, met: !over, over };
}

/**
 * 進度（**只看分類**的舊介面，③ 起）：`ms`＝scope 內各分類時數加總；`ratio`＝ms ÷ 目標（目標 ≤ 0 ⇒ 0）。
 * atLeast：met＝ms ≥ 目標、over 恆 false；atMost：over＝ms > 目標、met＝!over。
 * ⑥ 起目標可以綁荷札／路線／任務（範圍＝分類 ∪ 路線 ∪ 任務 ∪ 荷札，一塊只算一次），聯集沒辦法從加總表拼出來 ⇒ 正式計算改用 `goalProgressIn`
 * （逐塊判 `goalMember`；`buildGoals` 用它）。沒綁荷札／路線／任務的目標兩者結果相同。
 */
export function goalProgress(
  g: Goal,
  byCategory: Record<string, number>,
  cats: readonly TimeCategoryRow[],
): { ms: number; ratio: number; met: boolean; over: boolean } {
  const scope = expandScope(g.categoryIds, cats);
  let ms = 0;
  for (const id of scope) ms += byCategory[id] ?? 0;
  return progressOf(g, ms);
}

export interface GoalLinkContext {
  routes?: ReadonlySet<string>;
  nodes?: ReadonlySet<string>;
  /** 解出時間塊所屬的路線 ID（含透過節點向上匯總到路線） */
  routeOf?: (s: StatsSpan) => string;
  /** 節點在任務樹上的祖先 ID 列表（含節點自身，供支線／列車／車廂向上匯總） */
  ancestorsOfNode?: (nodeId: string) => readonly string[];
}

/**
 * ⑥ 0-10 & v1.29 D-時-192：一塊在不在目標的範圍裡——
 * 分類在 `catSet`（`expandScope` 展開過的）**或**荷札落在 `tagKeys` **或**路線在 `routes`（含該路線底下任何節點）**或**節點（含其祖先）在 `nodes`。
 */
export function goalMember(
  s: { categoryId: string; tagKeys?: readonly string[]; nodeId?: string | null; routeId?: string | null },
  catSet: ReadonlySet<string>,
  tagKeys: readonly string[],
  linkCtx?: GoalLinkContext,
): boolean {
  if (catSet.has(s.categoryId)) return true;
  if (tagKeys.length > 0) {
    const ks = s.tagKeys;
    if (ks && ks.length > 0) {
      for (const k of ks) for (const t of tagKeys) if (keyUnder(k, t)) return true;
    }
  }
  if (linkCtx?.routes && linkCtx.routes.size > 0) {
    if (s.routeId && linkCtx.routes.has(s.routeId)) return true;
    if (linkCtx.routeOf) {
      const rKey = linkCtx.routeOf(s as StatsSpan);
      if (linkCtx.routes.has(rKey)) return true;
    }
  }
  if (linkCtx?.nodes && linkCtx.nodes.size > 0 && s.nodeId) {
    if (linkCtx.nodes.has(s.nodeId)) return true;
    if (linkCtx.ancestorsOfNode) {
      for (const ancId of linkCtx.ancestorsOfNode(s.nodeId)) {
        if (linkCtx.nodes.has(ancId)) return true;
      }
    }
  }
  return false;
}

/** 目標實際的範圍（⑥ + v1.29）：展開過的分類集合＋荷札 keys＋路線集合＋節點集合；全部都空＝`empty` */
export function goalScopeOf(
  g: Goal,
  cats: readonly TimeCategoryRow[],
  liveFilter?: { liveRouteIds?: ReadonlySet<string>; liveNodeIds?: ReadonlySet<string> },
): { cats: Set<string>; tagKeys: readonly string[]; routes: Set<string>; nodes: Set<string>; empty: boolean } {
  const set = expandScope(g.categoryIds, cats);
  const tagKeys = g.tagKeys ?? [];
  const routes = new Set<string>(
    (g.routeIds ?? []).filter((id) => !liveFilter?.liveRouteIds || liveFilter.liveRouteIds.has(id)),
  );
  const nodes = new Set<string>(
    (g.nodeIds ?? []).filter((id) => !liveFilter?.liveNodeIds || liveFilter.liveNodeIds.has(id)),
  );
  return {
    cats: set,
    tagKeys,
    routes,
    nodes,
    empty: set.size === 0 && tagKeys.length === 0 && routes.size === 0 && nodes.size === 0,
  };
}

/**
 * ⑥ 0-10 目標進度（逐塊判）：窗內每一塊（`t.msById`，碎塊已排除）是範圍成員、而且不是待確認 ⇒ 它切進窗的 ms 加進去；
 * 一塊只算一次（分類＋路線＋任務＋荷札都中也一樣）。`spanById`＝算 `t` 用的那批 spans。
 */
export function goalProgressIn(
  g: Goal,
  t: WindowTotals,
  spanById: ReadonlyMap<string, StatsSpan>,
  cats: readonly TimeCategoryRow[],
  linkCtx?: Omit<GoalLinkContext, "routes" | "nodes"> & {
    liveRouteIds?: ReadonlySet<string>;
    liveNodeIds?: ReadonlySet<string>;
  },
): { ms: number; ratio: number; met: boolean; over: boolean } {
  const sc = goalScopeOf(g, cats, linkCtx);
  const pend = new Set(t.pendingIds);
  let ms = 0;
  if (!sc.empty) {
    const fullCtx: GoalLinkContext = {
      routes: sc.routes,
      nodes: sc.nodes,
      routeOf: linkCtx?.routeOf,
      ancestorsOfNode: linkCtx?.ancestorsOfNode,
    };
    for (const id of Object.keys(t.msById)) {
      if (pend.has(id)) continue;
      const s = spanById.get(id);
      if (s && goalMember(s, sc.cats, sc.tagKeys, fullCtx)) ms += t.msById[id];
    }
  }
  return progressOf(g, ms);
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
 * 呼叫端一律用 `blockThresholdOf`（已結束的塊不看分類預設長度，磨光⑦ D-時-151）。碎塊優先（碎塊不會是待確認）。
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
  /** 分類 id → 執行次數（已記錄且切片 > 0 ms 的不同時間塊數） */
  countByCategory: Record<string, number>;
  /** 路線鍵 → ms（已記錄；路線鍵＝路線 id 或 ROUTE_NOROUTE／ROUTE_GONE／ROUTE_NONE） */
  byRoute: Record<string, number>;
  /** 路線鍵 → 執行次數（已記錄且切片 > 0 ms 的不同時間塊數） */
  countByRoute: Record<string, number>;
  recordedMs: number;
  /** 已記錄且切片 > 0 ms 的總執行次數 */
  recordedCount: number;
  pendingMs: number;
  /** 切進這個窗的待確認塊（班數＝length） */
  pendingIds: string[];
  /** 待確認的分布：分類 id → { 班數, ms }（目標卡的「另有 N 班待確認」用） */
  pendingByCategory: Record<string, { count: number; ms: number }>;
  /** 有效段長 − 已記錄 − 待確認，不為負 */
  unrecordedMs: number;
  /** 有效段長＝max(0, min(w.end, now) − w.start)；未來的窗＝0 */
  effectiveMs: number;
  /**
   * ⑥ 0-10 依荷札：key → ms（已記錄；不含待確認、碎塊）。**不是分割**：一塊掛幾個荷札就進幾列；
   * key 含虛資料夾父層（每個前綴都累加），同一塊同一個前綴只算一次（`高效/深度`＋`高效` 都掛，`高效` 那列不重複算）。
   */
  byTag: Record<string, number>;
  /** 依荷札：key → 執行次數（同一塊同一前綴只算 1 次） */
  countByTag: Record<string, number>;
  /** ⑥：沒掛荷札（`tagKeys` 空）的已記錄 ms */
  untaggedMs: number;
  /** 沒掛荷札的已記錄執行次數 */
  untaggedCount: number;
  /** ⑥：每塊切進這個窗的 ms（含待確認、不含碎塊；0 ms 的不列）——目標逐塊判（`goalProgressIn`）用 */
  msById: Record<string, number>;
}

/**
 * 一個窗的數字（0-9）：先丟掉碎塊；其餘（含待確認）一起丟進 `sliceSpans`（重疊歸較晚開始者，與 `totalsByCategory` 同一條規則），
 * 切到的時間：屬於待確認塊 ⇒ `pendingMs`（不算分類、路線、目標）；其餘 ⇒ 分類與路線。
 * `routeOf` 回路線 id 或 ROUTE_NOROUTE／ROUTE_GONE／ROUTE_NONE。
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
    countByCategory: {},
    byRoute: {},
    countByRoute: {},
    recordedMs: 0,
    recordedCount: 0,
    pendingMs: 0,
    pendingIds: [],
    pendingByCategory: {},
    unrecordedMs: 0,
    effectiveMs,
    byTag: {},
    countByTag: {},
    untaggedMs: 0,
    untaggedCount: 0,
    msById: {},
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
  const seenRecorded = new Set<string>();
  for (const sl of sliceSpans(eligible, w, now)) {
    out.msById[sl.id] = (out.msById[sl.id] ?? 0) + sl.ms;
    if (cls.pending.has(sl.id)) {
      out.pendingMs += sl.ms;
      addPending(sl.id, sl.categoryId, sl.ms);
      continue;
    }
    out.recordedMs += sl.ms;
    out.byCategory[sl.categoryId] = (out.byCategory[sl.categoryId] ?? 0) + sl.ms;
    const s = byId.get(sl.id)!;
    const r = routeOf(s);
    out.byRoute[r] = (out.byRoute[r] ?? 0) + sl.ms;
    const firstSlice = sl.ms > 0 && !seenRecorded.has(sl.id);
    if (firstSlice) {
      seenRecorded.add(sl.id);
      out.recordedCount += 1;
      out.countByCategory[sl.categoryId] = (out.countByCategory[sl.categoryId] ?? 0) + 1;
      out.countByRoute[r] = (out.countByRoute[r] ?? 0) + 1;
    }
    // ⑥ 依荷札（舊呼叫端的 span 沒有 tagKeys ⇒ 當沒掛）
    const tk = s.tagKeys;
    if (!tk || !tk.length) {
      out.untaggedMs += sl.ms;
      if (firstSlice) out.untaggedCount += 1;
    } else {
      for (const k of prefixesOf(tk)) {
        out.byTag[k] = (out.byTag[k] ?? 0) + sl.ms;
        if (firstSlice) out.countByTag[k] = (out.countByTag[k] ?? 0) + 1;
      }
    }
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

/** 執行次數環比差：「▲3次」「▼2次」；0＝「持平」 */
export function fmtCountDelta(diff: number): string {
  if (!Number.isFinite(diff) || diff === 0) return "持平";
  return (diff > 0 ? "▲" : "▼") + `${Math.abs(Math.round(diff))}次`;
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

/** v1.33 功能 1：統計列表排序依據——依累積時數或依執行次數 */
export type StatsSortBy = "ms" | "count";

export interface ShareChild {
  id: string;
  ms: number;
  prevMs: number;
  count: number;
  prevCount: number;
}
/** 占比清單的一列：頂層（孤兒分類保留自己的 key 當頂層）；children 是它底下有數字的子分類 */
export interface ShareGroup {
  id: string;
  ms: number;
  prevMs: number;
  count: number;
  prevCount: number;
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
  /** ⑥：依荷札（同 `WindowTotals.byTag`；趨勢過濾到某個荷札時用它，單色墨） */
  byTag: Record<string, number>;
  recordedMs: number;
  recordedCount: number;
  /** 最後一根（＝正在看的這一期） */
  isCurrent: boolean;
  /** `now` 落在這一期內（上緣畫虛線） */
  inProgress: boolean;
}

export interface RouteShare {
  /** 路線 id，或 ROUTE_NOROUTE／ROUTE_GONE／ROUTE_NONE */
  key: string;
  ms: number;
  prevMs: number;
  count: number;
  prevCount: number;
}

/** v1.33 操作 2：依路線原地手風琴樹狀節點種類（路線 › 支線 › 列車 › 車廂 › 車票 ＋ 直屬與已刪歸戶） */
export type RouteTreeNodeKind = "branch" | "train" | "car" | "ticket" | "direct" | "gone";

/** 傳入路線樹計算的節點最小結構（NodeRow 的子集；保持 timetableStats 零外部依賴） */
export interface RouteTreeNodeInput {
  id: string;
  route_id: string | null;
  parent_id: string | null;
  kind: string;
  name: string;
  position: number;
  status?: string | null;
  deleted_at: string | null;
}

export interface RouteTreeNode {
  /** 唯一列 key（一般節點＝nodeId；直屬列＝`${ownerId}:__direct__`；已刪項目列＝`${routeId}:__gone__`） */
  id: string;
  /** 對應的真實節點 ID（跳轉路線圖定位用；路線直屬列／已刪列為 null ⇒ 跳路線本身） */
  nodeId: string | null;
  routeId: string;
  kind: RouteTreeNodeKind;
  name: string;
  /** parent_id === null 的活車票＝掛在路線上的臨時車票 */
  isTempTicket: boolean;
  done: boolean;
  position: number;
  ms: number;
  prevMs: number;
  count: number;
  prevCount: number;
  children: RouteTreeNode[];
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
  /** goal.routeIds 裡還活著的（順序同 goal） */
  liveRouteIds?: string[];
  /** goal.nodeIds 裡還活著的（順序同 goal） */
  liveNodeIds?: string[];
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
  /**
   * ⑥：範圍是空的——綁的分類／路線／任務都刪了、綁的荷札也都不在了（`goal.tagKeys` 空）。進度恆 0；
   * 卡上不畫條，`goal.categoryIds` 也空時寫「綁的荷札已經不在了」（`TT_TEXT.tags.goalTagsGone`）。
   */
  emptyScope: boolean;
}

/**
 * ⑥ 占比卡「荷札」面的一列（結構同 `timetableTags.ts` 的 `TagShareRow`；這支檔不准 import 它，所以各寫一份、結構相容）。
 * 由 `StatsInput.tagRows`（store 傳 `tagShareRows` 進來）產生，`buildStats` 自動補上 `count`／`prevCount`。
 */
export interface StatsTagRow {
  key: string;
  name: string;
  seg: string;
  depth: number;
  parent: string | null;
  hasKids: boolean;
  real: boolean;
  ms: number;
  prevMs: number;
  count: number;
  prevCount: number;
}

/** `StatsInput.tagRows` 回傳相容型別（允許舊版 `tagShareRows` 不帶 count／prevCount） */
export type StatsTagRowInput = Omit<StatsTagRow, "count" | "prevCount"> & {
  count?: number;
  prevCount?: number;
};

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
  /** v1.33 操作 2：各路線的原地展開樹（routeId → 子節點樹；各層加總嚴格等於父層） */
  routeTrees: Record<string, RouteTreeNode[]>;
  /** 待確認的塊（切進這一期的），由新到舊 */
  pending: PendingItem[];
  /** 這一期完全沒有紀錄（已記錄與待確認都是 0） */
  empty: boolean;
  /**
   * ⑥ 占比卡「荷札」面（D-時-118／119）：樹狀列（本期或上期 > 0 的；父層含子孫、同塊不重複）。
   * 數字來源＝`cur.byTag`／`prev.byTag`；名字與排序由 `StatsInput.tagRows` 給（沒給＝空陣列）。
   */
  tags: StatsTagRow[];
  /** ⑥ 最後一列「沒掛荷札」（0 也列）：本期／上期 ms（＝`cur.untaggedMs`／`prev.untaggedMs`；次數見 `cur.untaggedCount`／`prev.untaggedCount`） */
  untagged: { ms: number; prevMs: number };
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
  /**
   * ⑥：本期／上期的 byTag → 「荷札」面的列。store 傳 `(c, p) => tagShareRows(c, p, (k) => tagStore.index?.byKey[k])`
   * （`timetableTags.ts`）；不傳＝`tags` 空陣列。
   */
  tagRows?: (cur: Readonly<Record<string, number>>, prev: Readonly<Record<string, number>>) => StatsTagRowInput[];
  /** v1.33 操作 2：routeId → 該路線底下的節點清單（提供時一併算出 `routeTrees`） */
  nodesByRoute?: Readonly<Record<string, readonly RouteTreeNodeInput[]>>;
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

const ascStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 依時數或依次數重排分類占比（不變動傳入陣列） */
export function sortShareGroups(
  groups: readonly ShareGroup[],
  sortBy: StatsSortBy,
  cats: readonly TimeCategoryRow[] = [],
): ShareGroup[] {
  const byId = new Map<string, TimeCategoryRow>();
  for (const c of cats) byId.set(c.id, c);
  const pos = (id: string): number => byId.get(id)?.position ?? 0;
  const cmp =
    sortBy === "count"
      ? (a: { id: string; ms: number; prevMs: number; count: number; prevCount: number }, b: { id: string; ms: number; prevMs: number; count: number; prevCount: number }): number =>
          b.count - a.count ||
          b.ms - a.ms ||
          b.prevCount - a.prevCount ||
          b.prevMs - a.prevMs ||
          pos(a.id) - pos(b.id) ||
          ascStr(a.id, b.id)
      : (a: { id: string; ms: number; prevMs: number; count: number; prevCount: number }, b: { id: string; ms: number; prevMs: number; count: number; prevCount: number }): number =>
          b.ms - a.ms ||
          b.prevMs - a.prevMs ||
          pos(a.id) - pos(b.id) ||
          ascStr(a.id, b.id);
  return groups
    .map((g) => ({ ...g, children: g.children.slice().sort(cmp) }))
    .sort(cmp);
}

/** 依時數或依次數重排路線列表（保留特殊桶「沒有路線的任務／已刪除的任務／沒連任務」在底部） */
export function sortRouteShares(routes: readonly RouteShare[], sortBy: StatsSortBy): RouteShare[] {
  const rank = (k: string): number => (k === ROUTE_NONE ? 3 : k === ROUTE_GONE ? 2 : k === ROUTE_NOROUTE ? 1 : 0);
  const cmp =
    sortBy === "count"
      ? (a: RouteShare, b: RouteShare): number =>
          rank(a.key) - rank(b.key) ||
          b.count - a.count ||
          b.ms - a.ms ||
          b.prevCount - a.prevCount ||
          b.prevMs - a.prevMs ||
          ascStr(a.key, b.key)
      : (a: RouteShare, b: RouteShare): number =>
          rank(a.key) - rank(b.key) ||
          b.ms - a.ms ||
          b.prevMs - a.prevMs ||
          ascStr(a.key, b.key);
  return routes.slice().sort(cmp);
}

/** 依時數或依次數重排荷札樹狀列（同層兄弟依時數／次數排，嚴格維持父在子前的樹狀縮排結構） */
export function sortTagShareRows(rows: readonly StatsTagRow[], sortBy: StatsSortBy): StatsTagRow[] {
  if (rows.length <= 1) return rows.slice();
  const byKey = new Map<string, StatsTagRow>();
  const kids = new Map<string | null, StatsTagRow[]>();
  for (const r of rows) {
    byKey.set(r.key, r);
  }
  for (const r of rows) {
    const p = r.parent !== null && byKey.has(r.parent) ? r.parent : null;
    const arr = kids.get(p);
    if (arr) arr.push(r);
    else kids.set(p, [r]);
  }
  const cmp =
    sortBy === "count"
      ? (a: StatsTagRow, b: StatsTagRow): number =>
          b.count - a.count ||
          b.ms - a.ms ||
          b.prevCount - a.prevCount ||
          b.prevMs - a.prevMs ||
          ascStr(a.name, b.name) ||
          ascStr(a.key, b.key)
      : (a: StatsTagRow, b: StatsTagRow): number =>
          b.ms - a.ms ||
          b.count - a.count ||
          b.prevMs - a.prevMs ||
          b.prevCount - a.prevCount ||
          ascStr(a.name, b.name) ||
          ascStr(a.key, b.key);
  const out: StatsTagRow[] = [];
  const walk = (parent: string | null): void => {
    const list = kids.get(parent);
    if (!list) return;
    const sorted = list.slice().sort(cmp);
    for (const r of sorted) {
      out.push(r);
      walk(r.key);
    }
  };
  walk(null);
  return out;
}

/** 依時數或依次數遞迴重排路線手風琴樹（真實節點在前 → 直屬紀錄 → 已刪除項目） */
export function sortRouteTreeNodes(nodes: readonly RouteTreeNode[], sortBy: StatsSortBy): RouteTreeNode[] {
  const kindRank = (k: RouteTreeNodeKind): number => (k === "gone" ? 2 : k === "direct" ? 1 : 0);
  const cmp =
    sortBy === "count"
      ? (a: RouteTreeNode, b: RouteTreeNode): number =>
          kindRank(a.kind) - kindRank(b.kind) ||
          b.count - a.count ||
          b.ms - a.ms ||
          b.prevCount - a.prevCount ||
          b.prevMs - a.prevMs ||
          a.position - b.position ||
          ascStr(a.id, b.id)
      : (a: RouteTreeNode, b: RouteTreeNode): number =>
          kindRank(a.kind) - kindRank(b.kind) ||
          b.ms - a.ms ||
          b.count - a.count ||
          b.prevMs - a.prevMs ||
          b.prevCount - a.prevCount ||
          a.position - b.position ||
          ascStr(a.id, b.id);
  return nodes
    .map((n) => ({
      ...n,
      children: n.children.length > 0 ? sortRouteTreeNodes(n.children, sortBy) : [],
    }))
    .sort(cmp);
}

interface BucketAcc {
  ms: number;
  prevMs: number;
  count: number;
  prevCount: number;
}

function emptyAcc(): BucketAcc {
  return { ms: 0, prevMs: 0, count: 0, prevCount: 0 };
}

function buildRouteTreesFromTotals(
  spans: readonly StatsSpan[],
  cls: Classified,
  cur: WindowTotals,
  prev: WindowTotals,
  routeOf: (s: StatsSpan) => string,
  nodesByRoute?: Readonly<Record<string, readonly RouteTreeNodeInput[]>>,
  sortBy: StatsSortBy = "ms",
): Record<string, RouteTreeNode[]> {
  if (!nodesByRoute) return {};
  const byRouteSpans = new Map<string, { s: StatsSpan; cMs: number; pMs: number }[]>();
  for (const s of spans) {
    if (cls.tiny.has(s.id) || cls.pending.has(s.id)) continue;
    const cMs = cur.msById[s.id] ?? 0;
    const pMs = prev.msById[s.id] ?? 0;
    if (cMs <= 0 && pMs <= 0) continue;
    const rKey = routeOf(s);
    if (rKey === ROUTE_NONE || rKey === ROUTE_GONE || rKey === ROUTE_NOROUTE) continue;
    const list = byRouteSpans.get(rKey);
    const item = { s, cMs, pMs };
    if (list) list.push(item);
    else byRouteSpans.set(rKey, [item]);
  }
  const out: Record<string, RouteTreeNode[]> = {};
  const validKinds = new Set<string>(["branch", "train", "car", "ticket"]);
  for (const [routeId, items] of byRouteSpans) {
    const rawNodes = nodesByRoute[routeId] ?? [];
    const liveNodes = new Map<string, RouteTreeNodeInput>();
    for (const n of rawNodes) {
      if (n.deleted_at === null && n.id !== routeId && validKinds.has(n.kind)) {
        liveNodes.set(n.id, n);
      }
    }
    const selfAcc = new Map<string, BucketAcc>();
    const directAcc = emptyAcc();
    const goneAcc = emptyAcc();
    const addTo = (acc: BucketAcc, cMs: number, pMs: number): void => {
      if (cMs > 0) {
        acc.ms += cMs;
        acc.count += 1;
      }
      if (pMs > 0) {
        acc.prevMs += pMs;
        acc.prevCount += 1;
      }
    };
    for (const { s, cMs, pMs } of items) {
      if (s.nodeId === null || s.nodeId === routeId) {
        addTo(directAcc, cMs, pMs);
      } else if (liveNodes.has(s.nodeId)) {
        let acc = selfAcc.get(s.nodeId);
        if (!acc) {
          acc = emptyAcc();
          selfAcc.set(s.nodeId, acc);
        }
        addTo(acc, cMs, pMs);
      } else {
        addTo(goneAcc, cMs, pMs);
      }
    }

    // 組裝父子表（含環路保護：若有異常環路則掛回路線頂層）
    const childrenIds = new Map<string | null, string[]>();
    const hasCycle = (startId: string): boolean => {
      const seen = new Set<string>([startId]);
      let curId = liveNodes.get(startId)?.parent_id ?? null;
      while (curId && curId !== routeId && liveNodes.has(curId)) {
        if (seen.has(curId)) return true;
        seen.add(curId);
        curId = liveNodes.get(curId)?.parent_id ?? null;
      }
      return false;
    };
    for (const n of liveNodes.values()) {
      const parentKey =
        n.parent_id && n.parent_id !== routeId && liveNodes.has(n.parent_id) && !hasCycle(n.id)
          ? n.parent_id
          : null;
      const arr = childrenIds.get(parentKey);
      if (arr) arr.push(n.id);
      else childrenIds.set(parentKey, [n.id]);
    }

    const buildSubtree = (nid: string): RouteTreeNode | null => {
      const n = liveNodes.get(nid)!;
      const kids: RouteTreeNode[] = [];
      for (const cid of childrenIds.get(nid) ?? []) {
        const built = buildSubtree(cid);
        if (built) kids.push(built);
      }
      const own = selfAcc.get(nid) ?? emptyAcc();
      let ms = own.ms;
      let prevMs = own.prevMs;
      let count = own.count;
      let prevCount = own.prevCount;
      for (const k of kids) {
        ms += k.ms;
        prevMs += k.prevMs;
        count += k.count;
        prevCount += k.prevCount;
      }
      if (ms <= 0 && prevMs <= 0) return null;
      if (kids.length > 0 && (own.ms > 0 || own.prevMs > 0)) {
        kids.push({
          id: `${nid}:__direct__`,
          nodeId: nid,
          routeId,
          kind: "direct",
          name: "直屬紀錄（未指定子項）",
          isTempTicket: false,
          done: false,
          position: Number.MAX_SAFE_INTEGER,
          ms: own.ms,
          prevMs: own.prevMs,
          count: own.count,
          prevCount: own.prevCount,
          children: [],
        });
      }
      return {
        id: n.id,
        nodeId: n.id,
        routeId,
        kind: n.kind as RouteTreeNodeKind,
        name: n.name,
        isTempTicket: n.kind === "ticket" && n.parent_id === null,
        done: n.status === "done",
        position: n.position,
        ms,
        prevMs,
        count,
        prevCount,
        children: kids,
      };
    };

    const top: RouteTreeNode[] = [];
    for (const cid of childrenIds.get(null) ?? []) {
      const built = buildSubtree(cid);
      if (built) top.push(built);
    }
    if (directAcc.ms > 0 || directAcc.prevMs > 0) {
      top.push({
        id: `${routeId}:__direct__`,
        nodeId: null,
        routeId,
        kind: "direct",
        name: "路線直屬（臨時班次／未指定車票）",
        isTempTicket: false,
        done: false,
        position: Number.MAX_SAFE_INTEGER - 1,
        ms: directAcc.ms,
        prevMs: directAcc.prevMs,
        count: directAcc.count,
        prevCount: directAcc.prevCount,
        children: [],
      });
    }
    if (goneAcc.ms > 0 || goneAcc.prevMs > 0) {
      top.push({
        id: `${routeId}:__gone__`,
        nodeId: null,
        routeId,
        kind: "gone",
        name: "（已刪除的路線項目）",
        isTempTicket: false,
        done: false,
        position: Number.MAX_SAFE_INTEGER,
        ms: goneAcc.ms,
        prevMs: goneAcc.prevMs,
        count: goneAcc.count,
        prevCount: goneAcc.prevCount,
        children: [],
      });
    }
    out[routeId] = sortRouteTreeNodes(top, sortBy);
  }
  return out;
}

/** 獨立計算依路線手風琴樹（單元測試與按需呼叫共用） */
export function buildRouteTrees(input: {
  spans: readonly StatsSpan[];
  period: StatsPeriod;
  key: string;
  now: number;
  h: number;
  weekStart: 0 | 1;
  thresholdMin: (s: StatsSpan) => number | null;
  routeOf: (s: StatsSpan) => string;
  nodesByRoute: Readonly<Record<string, readonly RouteTreeNodeInput[]>>;
  sortBy?: StatsSortBy;
}): Record<string, RouteTreeNode[]> {
  const cls = classifySpans(input.spans, input.now, input.thresholdMin);
  const curWin = periodWindow(input.period, input.key, input.h, input.weekStart);
  const cmp = compareWindow(input.period, curWin, input.now, input.h, input.weekStart);
  const cur = windowTotals(input.spans, cls, curWin, input.now, input.routeOf);
  const prev = windowTotals(input.spans, cls, cmp.prev, input.now, input.routeOf);
  return buildRouteTreesFromTotals(input.spans, cls, cur, prev, input.routeOf, input.nodesByRoute, input.sortBy);
}

function groupRows(
  cats: readonly TimeCategoryRow[],
  cur: Record<string, number>,
  prev: Record<string, number>,
  curCount: Record<string, number>,
  prevCount: Record<string, number>,
): ShareGroup[] {
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
    const count = curCount[id] ?? 0;
    const pCount = prevCount[id] ?? 0;
    const top = topOf(id);
    let g = groups.get(top);
    if (!g) {
      g = { id: top, ms: 0, prevMs: 0, count: 0, prevCount: 0, children: [] };
      groups.set(top, g);
    }
    g.ms += ms;
    g.prevMs += prevMs;
    g.count += count;
    g.prevCount += pCount;
    // 頂層自己直接有塊（沒分到子分類）不出子列；子分類才出
    if (top !== id) g.children.push({ id, ms, prevMs, count, prevCount: pCount });
  }
  return sortShareGroups(Array.from(groups.values()), "ms", cats);
}

function routeRows(
  cur: Record<string, number>,
  prev: Record<string, number>,
  curCount: Record<string, number>,
  prevCount: Record<string, number>,
): RouteShare[] {
  const keys = new Set<string>([...Object.keys(cur), ...Object.keys(prev)]);
  const rows: RouteShare[] = [];
  for (const key of keys) {
    const ms = cur[key] ?? 0;
    const prevMs = prev[key] ?? 0;
    if (ms <= 0 && prevMs <= 0) continue;
    rows.push({ key, ms, prevMs, count: curCount[key] ?? 0, prevCount: prevCount[key] ?? 0 });
  }
  return sortRouteShares(rows, "ms");
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
      byTag: t.byTag,
      recordedMs: t.recordedMs,
      recordedCount: t.recordedCount,
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

  const rawTags = input.tagRows ? input.tagRows(cur.byTag, prev.byTag) : [];
  const tags: StatsTagRow[] = rawTags.map((r) => ({
    ...r,
    count: r.count ?? cur.countByTag[r.key] ?? 0,
    prevCount: r.prevCount ?? prev.countByTag[r.key] ?? 0,
  }));

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
    groups: groupRows(cats, cur.byCategory, prev.byCategory, cur.countByCategory, prev.countByCategory),
    trend,
    routes: routeRows(cur.byRoute, prev.byRoute, cur.countByRoute, prev.countByRoute),
    routeTrees: buildRouteTreesFromTotals(spans, cls, cur, prev, input.routeOf, input.nodesByRoute),
    pending,
    empty: cur.recordedMs <= 0 && cur.pendingMs <= 0,
    tags,
    untagged: {
      ms: cur.untaggedMs,
      prevMs: prev.untaggedMs,
    },
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
    /** 目標若有綁路線，用它解時間塊所屬路線；不傳＝一律 ROUTE_NONE */
    routeOf?: (s: StatsSpan) => string;
    /** v1.29 D-時-192：節點在任務樹上的祖先 ID 列表（含節點自身，供支線／列車／車廂向上匯總） */
    ancestorsOfNode?: (nodeId: string) => readonly string[];
    /** v1.29：還活著的路線 ID 集合（不傳＝目標裡的 routeIds 全算活著） */
    liveRouteIds?: ReadonlySet<string>;
    /** v1.29：還活著的節點 ID 集合（不傳＝目標裡的 nodeIds 全算活著） */
    liveNodeIds?: ReadonlySet<string>;
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
  const linkCtxBase = {
    routeOf,
    ancestorsOfNode: opts.ancestorsOfNode,
    liveRouteIds: opts.liveRouteIds,
    liveNodeIds: opts.liveNodeIds,
  };
  // ⑥ 0-10 & v1.29：進度與「另有 n 班待確認」都逐塊判（範圍＝分類 ∪ 路線 ∪ 任務 ∪ 荷札，一塊只算一次）
  const one = (g: Goal, scope: ReturnType<typeof goalScopeOf>, w: { start: number; end: number }): GoalPeriodResult => {
    const t = windowTotals(spans, cls, w, opts.now, routeOf);
    const p = goalProgressIn(g, t, spanById, cats, linkCtxBase);
    let pendingCount = 0;
    let pendingMs = 0;
    const pendingItems: PendingItem[] = [];
    if (!scope.empty) {
      const fullCtx: GoalLinkContext = {
        routes: scope.routes,
        nodes: scope.nodes,
        routeOf,
        ancestorsOfNode: opts.ancestorsOfNode,
      };
      for (const id of t.pendingIds) {
        const s = spanById.get(id);
        if (!s || !goalMember(s, scope.cats, scope.tagKeys, fullCtx)) continue;
        pendingCount += 1;
        pendingMs += t.msById[id] ?? 0;
        pendingItems.push({ id: s.id, categoryId: s.categoryId, start: s.start, end: s.end, durMs: durOf(s, opts.now) });
      }
    }
    pendingItems.sort((a, b) => b.start - a.start || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return { start: w.start, end: w.end, ...p, pendingCount, pendingMs, pendingItems };
  };
  const views = goals.map((g): GoalView => {
    const scope = goalScopeOf(g, cats, linkCtxBase);
    const win = goalWindow(g, today, opts.h, opts.weekStart);
    const prevWin = goalPrevWindow(g, today, opts.h, opts.weekStart);
    const live = g.categoryIds.filter((id) => {
      const c = catById.get(id);
      return !!c && c.deleted_at === null;
    });
    const liveRoutes = (g.routeIds ?? []).filter((id) => !opts.liveRouteIds || opts.liveRouteIds.has(id));
    const liveNodes = (g.nodeIds ?? []).filter((id) => !opts.liveNodeIds || opts.liveNodeIds.has(id));
    const cur = one(g, scope, { start: win.start, end: win.end ?? Number.MAX_SAFE_INTEGER });
    return {
      goal: g,
      liveCategoryIds: live,
      liveRouteIds: liveRoutes,
      liveNodeIds: liveNodes,
      state: win.state,
      window: { start: win.start, end: win.end },
      cur,
      prev: prevWin ? one(g, scope, prevWin) : null,
      paceMs: win.state === "active" ? goalPace(g, cur.ms, today, opts.h) : null,
      daysLeft: win.state === "active" ? goalDaysLeft(g, today) : null,
      emptyScope: scope.empty,
    };
  });
  // 排序（5.2-5）：進行中 → 未開始 → 已結束，同類照 position（Array.sort 在 ES2019+ 穩定，原順序＝store 給的 position 序）
  const rank = { active: 0, upcoming: 1, ended: 2 } as const;
  return views.sort((a, b) => rank[a.state] - rank[b.state] || a.goal.position - b.goal.position);
}

/* ───────────────────────── 6b. 釘選自訂統計專題 ＆ 專題獨立切日線（v1.33 功能 2 ＋ G1） ───────────────────────── */

/** `time_stat_topics` 資料列結構相容介面（維持 timetableStats 僅依賴 timetable.ts 與 lib/date.ts） */
export interface StatTopicRowLike {
  id: string;
  name: string;
  scope: string;
  day_start_hour: number | null;
  position: number;
  archived_at: string | null;
  deleted_at?: string | null;
}

export interface StatTopic {
  id: string;
  name: string;
  categoryIds: string[];
  routeIds: string[];
  nodeIds: string[];
  /** 荷札 name_key 陣列（NFKC＋英文小寫、不含 `#`） */
  tagKeys: string[];
  /** 荷札顯示名陣列（保留大小寫、不含 `#`） */
  tagNames: string[];
  /** null＝跟隨手帳全域日界線；0..23＝專題獨立切日整點（如 18 代表 18:00 切日的睡眠觀察） */
  dayStartHour: number | null;
  position: number;
  archived: boolean;
}

export interface StatTopicInput {
  name: string;
  categoryIds: readonly string[];
  routeIds?: readonly string[];
  nodeIds?: readonly string[];
  tagNames?: readonly string[];
  /** null＝跟隨全域；0..23＝專題獨立切日整點 */
  dayStartHour: number | null;
}

export interface StatTopicDayRow {
  dateKey: string;
  start: number;
  end: number;
  ms: number;
  count: number;
  inProgress: boolean;
  isToday: boolean;
  future: boolean;
}

export interface StatTopicView {
  topic: StatTopic;
  /** 實際採用的切日整點（`topic.dayStartHour ?? globalH`） */
  effectiveDayStartHour: number;
  period: StatsPeriod;
  /** 依專題切日線對齊後的本期第一天 */
  key: string;
  window: PeriodWindow;
  prevWindow: { start: number; end: number };
  compare: "sameSpan" | "whole";
  totalMs: number;
  count: number;
  prevMs: number;
  prevCount: number;
  /** 當期已經過的有效營業日數（用於日均分母） */
  elapsedDays: number;
  /** 當期日均時數（totalMs / elapsedDays） */
  avgDayMs: number;
  /** 迷你趨勢窗的日均時數（period="day" 時為近 7 日均；week／month 同 avgDayMs） */
  trendAvgDayMs: number;
  /** 迷你趨勢條與展開明細共用的逐日資料（week=7 天、month=整月各天、day=近 7 天） */
  days: StatTopicDayRow[];
  liveCategoryIds: string[];
  liveRouteIds: string[];
  liveNodeIds: string[];
  emptyScope: boolean;
}

export const TOPIC_NAME_MAX = 24;
export const TOPIC_SCOPE_EMPTY = "請選至少一個分類、路線、任務或荷札";
export const TOPIC_SCOPE_VERSION = 1;

/** 將輸入的荷札字串轉為與 `tags.ts` 對齊的 `{ name, key }`；空白或無效回 null */
export function topicTagNameAndKey(raw: unknown): { name: string; key: string } | null {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFKC").trim();
  if (s.startsWith("#")) s = s.slice(1).trim();
  if (!s) return null;
  const segs = s.split("/").map((x) => x.trim());
  if (segs.some((seg) => !seg)) return null;
  const name = segs.join("/");
  if (/\s/.test(name) || name.includes("#")) return null;
  const key = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return { name, key };
}

export function isValidDayStartHour(h: unknown): h is number {
  return typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23;
}

/** 序列化專題 scope JSON（`{"v":1,...}`，固定鍵序，確保跨裝置輸出一致） */
export function serializeTopicScope(input: {
  categoryIds: readonly string[];
  routeIds?: readonly string[];
  nodeIds?: readonly string[];
  tagNames?: readonly string[];
}): string {
  const cats: string[] = [];
  for (const id of input.categoryIds) if (typeof id === "string" && id && !cats.includes(id)) cats.push(id);
  const routes: string[] = [];
  for (const id of input.routeIds ?? []) if (typeof id === "string" && id && !routes.includes(id)) routes.push(id);
  const nodes: string[] = [];
  for (const id of input.nodeIds ?? []) if (typeof id === "string" && id && !nodes.includes(id)) nodes.push(id);
  const tags: string[] = [];
  const seenKeys = new Set<string>();
  for (const raw of input.tagNames ?? []) {
    const parsed = topicTagNameAndKey(raw);
    if (parsed && !seenKeys.has(parsed.key)) {
      seenKeys.add(parsed.key);
      tags.push(parsed.name);
    }
  }
  const obj: { v: 1; cats?: string[]; routes?: string[]; nodes?: string[]; tags?: string[] } = { v: TOPIC_SCOPE_VERSION };
  if (cats.length > 0) obj.cats = cats;
  if (routes.length > 0) obj.routes = routes;
  if (nodes.length > 0) obj.nodes = nodes;
  if (tags.length > 0) obj.tags = tags;
  return JSON.stringify(obj);
}

/** 驗證並正規化專題輸入；不合法 ⇒ RangeError（人話） */
export function normalizeStatTopicInput(input: StatTopicInput): {
  name: string;
  categoryIds: string[];
  routeIds: string[];
  nodeIds: string[];
  tagNames: string[];
  dayStartHour: number | null;
  scope: string;
} {
  const name = input.name.trim();
  if (!name) throw new RangeError("請輸入專題名稱");
  if (Array.from(name).length > TOPIC_NAME_MAX) {
    throw new RangeError(`專題名稱最多 ${TOPIC_NAME_MAX} 字`);
  }
  if (input.dayStartHour !== null && !isValidDayStartHour(input.dayStartHour)) {
    throw new RangeError("切日時間請選整點（00:00～23:00）");
  }
  const categoryIds: string[] = [];
  for (const id of input.categoryIds) if (typeof id === "string" && id && !categoryIds.includes(id)) categoryIds.push(id);
  const routeIds: string[] = [];
  for (const id of input.routeIds ?? []) if (typeof id === "string" && id && !routeIds.includes(id)) routeIds.push(id);
  const nodeIds: string[] = [];
  for (const id of input.nodeIds ?? []) if (typeof id === "string" && id && !nodeIds.includes(id)) nodeIds.push(id);
  const tagNames: string[] = [];
  const seenTagKeys = new Set<string>();
  for (const raw of input.tagNames ?? []) {
    const parsed = topicTagNameAndKey(raw);
    if (parsed && !seenTagKeys.has(parsed.key)) {
      seenTagKeys.add(parsed.key);
      tagNames.push(parsed.name);
    }
  }
  if (!categoryIds.length && !routeIds.length && !nodeIds.length && !tagNames.length) {
    throw new RangeError(TOPIC_SCOPE_EMPTY);
  }
  const scope = serializeTopicScope({ categoryIds, routeIds, nodeIds, tagNames });
  return {
    name,
    categoryIds,
    routeIds,
    nodeIds,
    tagNames,
    dayStartHour: input.dayStartHour,
    scope,
  };
}

/** 解析 `time_stat_topics` 一列；前向相容：不認得的版本或損壞欄位回傳 null */
export function parseStatTopic(row: StatTopicRowLike): StatTopic | null {
  if ((row.deleted_at ?? null) !== null) return null;
  if (typeof row.name !== "string" || !row.name.trim()) return null;
  if (row.day_start_hour !== null && !isValidDayStartHour(row.day_start_hour)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.scope);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as { v?: unknown; cats?: unknown; categories?: unknown; routes?: unknown; nodes?: unknown; tags?: unknown };
  if ("v" in o && o.v !== TOPIC_SCOPE_VERSION) return null;
  const rawCats = Array.isArray(o.cats) ? o.cats : Array.isArray(o.categories) ? o.categories : [];
  const rawRoutes = Array.isArray(o.routes) ? o.routes : [];
  const rawNodes = Array.isArray(o.nodes) ? o.nodes : [];
  const rawTags = Array.isArray(o.tags) ? o.tags : [];

  const categoryIds: string[] = [];
  for (const x of rawCats) if (typeof x === "string" && x && !categoryIds.includes(x)) categoryIds.push(x);
  const routeIds: string[] = [];
  for (const x of rawRoutes) if (typeof x === "string" && x && !routeIds.includes(x)) routeIds.push(x);
  const nodeIds: string[] = [];
  for (const x of rawNodes) if (typeof x === "string" && x && !nodeIds.includes(x)) nodeIds.push(x);
  const tagNames: string[] = [];
  const tagKeys: string[] = [];
  for (const x of rawTags) {
    const tk = topicTagNameAndKey(x);
    if (tk && !tagKeys.includes(tk.key)) {
      tagKeys.push(tk.key);
      tagNames.push(tk.name);
    }
  }
  return {
    id: row.id,
    name: row.name,
    categoryIds,
    routeIds,
    nodeIds,
    tagKeys,
    tagNames,
    dayStartHour: row.day_start_hour,
    position: row.position,
    archived: row.archived_at !== null,
  };
}

export function statTopicToInput(t: StatTopic): StatTopicInput {
  return {
    name: t.name,
    categoryIds: t.categoryIds.slice(),
    routeIds: t.routeIds.slice(),
    nodeIds: t.nodeIds.slice(),
    tagNames: t.tagNames.slice(),
    dayStartHour: t.dayStartHour,
  };
}

function topicDayKeysFor(period: StatsPeriod, alignedFirstKey: string): string[] {
  if (period === "day") {
    const keys: string[] = [];
    for (let i = 6; i >= 0; i--) keys.push(addDays(alignedFirstKey, -i));
    return keys;
  }
  if (period === "week") {
    const keys: string[] = [];
    for (let i = 0; i < 7; i++) keys.push(addDays(alignedFirstKey, i));
    return keys;
  }
  const endKey = nextPeriodFirstKey("month", alignedFirstKey);
  const keys: string[] = [];
  let cur = alignedFirstKey;
  let guard = 0;
  while (cur < endKey && guard++ < 35) {
    keys.push(cur);
    cur = addDays(cur, 1);
  }
  return keys;
}

/** 計算所有啟用中專題所需的最早查詢時間戳（涵蓋獨立切日線的上期與近 7 日趨勢）；無專題回 null */
export function topicsFromMs(
  topics: readonly StatTopic[],
  period: StatsPeriod,
  followCurrent: boolean,
  ref: string,
  now: number,
  globalH: number,
  weekStart: 0 | 1,
): number | null {
  if (!topics.length) return null;
  let earliest: number | null = null;
  for (const t of topics) {
    const th = t.dayStartHour ?? globalH;
    const topicToday = todayKey(th, new Date(now));
    const topicKey = resolveViewKey(period, followCurrent, ref, topicToday, th, weekStart);
    const curWin = periodWindow(period, topicKey, th, weekStart);
    const cmp = compareWindow(period, curWin, now, th, weekStart);
    const dayKeys = topicDayKeysFor(period, curWin.key);
    const firstTrendStart = dayKeys.length > 0 ? startMsOfKey(dayKeys[0], th) : curWin.start;
    const minStart = Math.min(curWin.start, cmp.prev.start, firstTrendStart);
    earliest = earliest === null ? minStart : Math.min(earliest, minStart);
  }
  return earliest;
}

/** 計算所有啟用中專題所需的最晚查詢時間戳；無專題回 null */
export function topicsEndMs(
  topics: readonly StatTopic[],
  period: StatsPeriod,
  followCurrent: boolean,
  ref: string,
  now: number,
  globalH: number,
  weekStart: 0 | 1,
): number | null {
  if (!topics.length) return null;
  let latest: number | null = null;
  for (const t of topics) {
    const th = t.dayStartHour ?? globalH;
    const topicToday = todayKey(th, new Date(now));
    const topicKey = resolveViewKey(period, followCurrent, ref, topicToday, th, weekStart);
    const curWin = periodWindow(period, topicKey, th, weekStart);
    latest = latest === null ? curWin.end : Math.max(latest, curWin.end);
  }
  return latest;
}

/**
 * 計算釘選自訂統計專題卡片（支援專題專屬切日線 `dayStartHour`，如 18:00 睡眠觀察）：
 * - 以 `th = topic.dayStartHour ?? opts.h` 決定專題自己的營業日邊界 `[D th:00, D+1 th:00)`；
 * - 昨晚 23:30 到今早 07:30（或凌晨 01:30 到 08:30）的睡眠塊，在 `18:00` 切日下完整落在同一睡眠日，不因 00:00 或全域 06:00 切斷；
 * - 範圍匹配複用 `goalMember`（分類 ∪ 路線 ∪ 任務子樹 ∪ `#荷札`，單塊不重複計入）。
 */
export function buildStatTopics(
  topics: readonly StatTopic[],
  spans: readonly StatsSpan[],
  cats: readonly TimeCategoryRow[],
  opts: {
    period: StatsPeriod;
    followCurrent: boolean;
    ref: string;
    now: number;
    h: number;
    weekStart: 0 | 1;
    thresholdMin: (s: StatsSpan) => number | null;
    routeOf?: (s: StatsSpan) => string;
    ancestorsOfNode?: (nodeId: string) => readonly string[];
    liveRouteIds?: ReadonlySet<string>;
    liveNodeIds?: ReadonlySet<string>;
  },
): StatTopicView[] {
  if (!topics.length) return [];
  const cls = classifySpans(spans, opts.now, opts.thresholdMin);
  const catById = new Map<string, TimeCategoryRow>();
  for (const c of cats) catById.set(c.id, c);
  const spanById = new Map<string, StatsSpan>();
  for (const s of spans) spanById.set(s.id, s);
  const routeOf = opts.routeOf ?? ((): string => ROUTE_NONE);

  const ordered = topics.slice().sort((a, b) => a.position - b.position || ascStr(a.id, b.id));

  return ordered.map((topic): StatTopicView => {
    const th = topic.dayStartHour ?? opts.h;
    const topicToday = todayKey(th, new Date(opts.now));
    const topicKey = resolveViewKey(opts.period, opts.followCurrent, opts.ref, topicToday, th, opts.weekStart);
    const curWin = periodWindow(opts.period, topicKey, th, opts.weekStart);
    const cmp = compareWindow(opts.period, curWin, opts.now, th, opts.weekStart);

    const catSet = expandScope(topic.categoryIds, cats);
    const liveRoutes = topic.routeIds.filter((id) => !opts.liveRouteIds || opts.liveRouteIds.has(id));
    const liveNodes = topic.nodeIds.filter((id) => !opts.liveNodeIds || opts.liveNodeIds.has(id));
    const liveCats = topic.categoryIds.filter((id) => {
      const c = catById.get(id);
      return !!c && c.deleted_at === null;
    });
    const routesSet = new Set<string>(liveRoutes);
    const nodesSet = new Set<string>(liveNodes);
    const emptyScope =
      catSet.size === 0 && topic.tagKeys.length === 0 && routesSet.size === 0 && nodesSet.size === 0;

    const fullCtx: GoalLinkContext = {
      routes: routesSet,
      nodes: nodesSet,
      routeOf,
      ancestorsOfNode: opts.ancestorsOfNode,
    };

    const measure = (w: { start: number; end: number }): { ms: number; count: number } => {
      if (emptyScope) return { ms: 0, count: 0 };
      const wt = windowTotals(spans, cls, w, opts.now, routeOf);
      const pend = new Set(wt.pendingIds);
      let ms = 0;
      let count = 0;
      for (const id of Object.keys(wt.msById)) {
        if (pend.has(id)) continue;
        const partMs = wt.msById[id] ?? 0;
        if (partMs <= 0) continue;
        const s = spanById.get(id);
        if (s && goalMember(s, catSet, topic.tagKeys, fullCtx)) {
          ms += partMs;
          count += 1;
        }
      }
      return { ms, count };
    };

    const cur = measure(curWin);
    const prev = measure(cmp.prev);
    const dayKeys = topicDayKeysFor(opts.period, curWin.key);
    const days: StatTopicDayRow[] = dayKeys.map((dk) => {
      const dw = periodWindow("day", dk, th, opts.weekStart);
      const m = measure(dw);
      return {
        dateKey: dk,
        start: dw.start,
        end: dw.end,
        ms: m.ms,
        count: m.count,
        inProgress: opts.now >= dw.start && opts.now < dw.end,
        isToday: dk === topicToday,
        future: opts.now <= dw.start,
      };
    });

    let elapsedDays: number;
    if (opts.period === "day") {
      elapsedDays = opts.now > curWin.start ? 1 : cur.ms > 0 ? 1 : 0;
    } else {
      const started = days.filter((d) => !d.future).length;
      elapsedDays = started > 0 ? started : cur.ms > 0 ? 1 : 0;
    }
    const avgDayMs = elapsedDays > 0 ? Math.round(cur.ms / elapsedDays) : 0;

    const trendStarted = days.filter((d) => !d.future).length;
    const trendSumMs = days.reduce((acc, d) => acc + d.ms, 0);
    const trendDenom = trendStarted > 0 ? trendStarted : trendSumMs > 0 ? 1 : 0;
    const trendAvgDayMs = trendDenom > 0 ? Math.round(trendSumMs / trendDenom) : 0;

    return {
      topic,
      effectiveDayStartHour: th,
      period: opts.period,
      key: curWin.key,
      window: curWin,
      prevWindow: cmp.prev,
      compare: cmp.compare,
      totalMs: cur.ms,
      count: cur.count,
      prevMs: prev.ms,
      prevCount: prev.count,
      elapsedDays,
      avgDayMs,
      trendAvgDayMs,
      days,
      liveCategoryIds: liveCats,
      liveRouteIds: liveRoutes,
      liveNodeIds: liveNodes,
      emptyScope,
    };
  });
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
