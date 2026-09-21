/**
 * 🎫 重複任務引擎（M3 ④ WP1）——規則 JSON 與班次推算的**單一真相**。
 *
 * 純函式、零依賴（只用 lib/date 的 date-key 算術），兩種 repository 與 UI 共用同一套語義。
 * 規格：docs/research/2026-09-11-M3④重複任務引擎-實施計畫草案.md §4
 * 決策：docs/決策記錄.md「④ 重複任務引擎實施計畫拍板」
 *
 * 兩層分工（D-④-2）：
 *   nodes.status ＝系列狀態（done＝退役，引擎不再排班）
 *   occurrences  ＝班次結果（done／skipped）
 *   nodes.scheduled_on ＝引擎維護的「目前班次日」（D-④-6；起算日在 JSON 的 start）
 *
 * 日期一律「本地 date-key 字串」YYYY-MM-DD，算術只走 lib/date 的 addDays（本地 new Date(y,m-1,d+n)，
 * 跨月／閏年安全），**不經 Date.parse**（③ 的坑：`DeferPopover.tsx` 那次）。
 */
import { addDays, dayKeyOf } from "../lib/date";
import type { Mood } from "./node";
import type { SyncFields } from "./sync";

// ───────────────────────── 型別 ─────────────────────────

export type RepeatMode = "fixed" | "after";
export type RepeatFreq = "daily" | "weekly" | "monthly";

/** 固定排程：每日／每週指定星期／每月指定日（M3-5b） */
export interface FixedRepeatRule {
  v: 1;
  mode: "fixed";
  freq: RepeatFreq;
  /** 每 N 期；v1 恆 1（schema 預留，UI 不出） */
  interval: number;
  /** freq='weekly' 用；JS getDay()，0＝日。null＝未指定（describeRule 退回「每週重複」） */
  byweekday: number[] | null;
  /** freq='monthly' 用；1–31，超過當月天數夾到月底。null＝未指定 */
  bymonthday: number[] | null;
  /** 起算日 YYYY-MM-DD（D-④-6：＝掛規則當下的原執行日，無則今天） */
  start: string;
  /** 終止日；v1 無 UI（D-④-5 甲），引擎照樣認 */
  until: string | null;
  /** 共 N 次；v1 無 UI 也未實作（引擎忽略，只當欄位保留） */
  count: number | null;
}

/** 完成後間隔：做完（或運休）之後 N 天再來一班 */
export interface AfterRepeatRule {
  v: 1;
  mode: "after";
  /** 間隔天數，>= 1 */
  days: number;
  start: string;
  until: string | null;
  count: number | null;
}

export type RepeatRule = FixedRepeatRule | AfterRepeatRule;

export type OccurrenceStatus = "done" | "skipped";

/** 班次記錄（occurrences 一列）；反悔＝soft delete，同一班次可再蓋 */
export interface Occurrence extends SyncFields {
  id: string;
  node_id: string;
  /** 班次日 YYYY-MM-DD */
  due_on: string;
  status: OccurrenceStatus;
  /** done 的蓋章時刻（UTC ISO）；skipped 恆 NULL */
  completed_at: string | null;
  /** 班次心情（列車／車廂完成卡）；鏡射到 nodes.mood＝最近一班 */
  mood: Mood | null;
}

/** currentDue／pick 只需要這幾格（memory／SQLite／probe 都餵得出來） */
export type OccurrenceSeed = Pick<Occurrence, "due_on" | "status" | "completed_at" | "updated_at">;

// ───────────────────────── 星期語彙 ─────────────────────────

/** 以 JS getDay() 索引（0＝日）；describeRule 與 WP3 的七顆 chip 吃同一份，別各算各的（雷區 8） */
export const WEEKDAY_LABEL: readonly string[] = ["日", "一", "二", "三", "四", "五", "六"];

/** 畫面上的星期排列順序（一…六・日）；JSON 裡存的永遠是 getDay() 的 0–6 */
export const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

const orderIndex = (dow: number): number => {
  const i = WEEKDAY_ORDER.indexOf(dow);
  return i < 0 ? 99 : i;
};

// ───────────────────────── 解析與序列化 ─────────────────────────

const isDateKey = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function intList(v: unknown, lo: number, hi: number): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi)
    .filter((x, i, a) => a.indexOf(x) === i);
  return out.length ? out.sort((a, b) => a - b) : null;
}

/**
 * repeat_rule 欄位（JSON 字串）→ 規則物件。
 * 壞字串、舊的自由文字、不認得的形狀 → **null**（＝視為沒有規則，票就是一張乘車券）。
 * 引擎裡任何「這是不是定期券」的判斷都只認 parseRule 的結果，不看欄位是否非空。
 */
export function parseRule(json: string | null | undefined): RepeatRule | null {
  if (!json) return null;
  const text = json.trim();
  if (!text.startsWith("{")) return null; // 舊的自由文字（0003 migration 已搬走，這裡是保險）
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (!isDateKey(o.start)) return null;
  const until = isDateKey(o.until) ? o.until : null;
  const count = typeof o.count === "number" && Number.isInteger(o.count) && o.count > 0 ? o.count : null;

  if (o.mode === "after") {
    const days = typeof o.days === "number" && Number.isInteger(o.days) && o.days >= 1 ? o.days : null;
    if (days === null) return null;
    return { v: 1, mode: "after", days, start: o.start, until, count };
  }
  if (o.mode === "fixed") {
    const freq = o.freq;
    if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") return null;
    const interval =
      typeof o.interval === "number" && Number.isInteger(o.interval) && o.interval >= 1 ? o.interval : 1;
    const byweekday = freq === "weekly" ? intList(o.byweekday, 0, 6) : null;
    const bymonthday = freq === "monthly" ? intList(o.bymonthday, 1, 31) : null;
    // 每週／每月沒指定日子＝規則不完整（永遠算不出班次）→ 當成沒有規則
    if (freq === "weekly" && !byweekday) return null;
    if (freq === "monthly" && !bymonthday) return null;
    return { v: 1, mode: "fixed", freq, interval, byweekday, bymonthday, start: o.start, until, count };
  }
  return null;
}

/** 規則物件 → repeat_rule 欄位字串（永遠以 '{' 開頭，與 0003 的 legacy 判斷同一把尺） */
export function serializeRule(rule: RepeatRule): string {
  return JSON.stringify(rule);
}

/** 建一條固定排程規則（欄位補滿預設值，省得呼叫端到處寫 until:null） */
export function fixedRule(
  freq: RepeatFreq,
  start: string,
  opts: { byweekday?: number[] | null; bymonthday?: number[] | null; interval?: number } = {},
): FixedRepeatRule {
  return {
    v: 1,
    mode: "fixed",
    freq,
    interval: opts.interval ?? 1,
    byweekday: freq === "weekly" ? (opts.byweekday ?? null) : null,
    bymonthday: freq === "monthly" ? (opts.bymonthday ?? null) : null,
    start,
    until: null,
    count: null,
  };
}

/** 建一條「完成後 N 天」規則 */
export function afterRule(days: number, start: string): AfterRepeatRule {
  return { v: 1, mode: "after", days, start, until: null, count: null };
}

// ───────────────────────── 一句話收據 ─────────────────────────

/**
 * 規則的一句話（側板區段 aside、今日列／大綱列 meta 都印這句）。
 *   每日重複／每週一・三・五／每月 15 日／每月 1・15・28 日／每月 4 天／完成後 3 天
 * monthly 超過三個日子改印「每月 N 天」——別讓長規則把票撐成兩行（雷區 10）。
 */
export function describeRule(rule: RepeatRule): string {
  if (rule.mode === "after") return `完成後 ${rule.days} 天`;
  switch (rule.freq) {
    case "daily":
      return "每日重複";
    case "weekly": {
      const days = rule.byweekday;
      if (!days || !days.length) return "每週重複";
      const label = [...days].sort((a, b) => orderIndex(a) - orderIndex(b)).map((d) => WEEKDAY_LABEL[d] ?? "?");
      return `每週${label.join("・")}`;
    }
    case "monthly": {
      const days = rule.bymonthday;
      if (!days || !days.length) return "每月重複";
      if (days.length > 3) return `每月 ${days.length} 天`;
      return `每月 ${[...days].sort((a, b) => a - b).join("・")} 日`;
    }
  }
}

// ───────────────────────── 固定排程的日期算術 ─────────────────────────

/** 這個 date-key 是星期幾（0＝日）；只用本地 new Date(y,m-1,d)，不經 Date.parse */
function dowOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** 這個 date-key 是幾號 */
function domOf(key: string): number {
  return Number(key.slice(8, 10));
}

/** 該月天數 */
function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate(); // month1＝1..12；第 0 天＝上個月最後一天
}

/** bymonthday 的日子在這個月夾到月底後是幾號（例：31 在 2 月＝28／29） */
function clampMonthday(key: string, day: number): number {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return Math.min(day, daysInMonth(y, m));
}

/** dateKey 是不是這條固定規則的班次日（不管 start／until） */
function matchesFixed(rule: FixedRepeatRule, key: string): boolean {
  switch (rule.freq) {
    case "daily":
      return true;
    case "weekly":
      return !!rule.byweekday?.includes(dowOf(key));
    case "monthly": {
      const days = rule.bymonthday;
      if (!days) return false;
      const dom = domOf(key);
      // 夾月底：31 日的規則在 2 月落在 28（或 29）；同一天可能被兩個規則日夾到，只需命中一次
      return days.some((d) => clampMonthday(key, d) === dom);
    }
  }
}

/** 掃描上限：一年半的天數（週／月規則最遠也只隔一個月，這是防呆不是效能邊界） */
const SCAN_LIMIT = 550;

/** 規則日的搜尋範圍上界（until 之後就沒有班次了） */
function beyondUntil(rule: RepeatRule, key: string): boolean {
  return rule.until !== null && key > rule.until;
}

/**
 * afterDateKey **之後**（不含當天）的第一個規則日；沒有（超過 until）回 null。
 * 起算日以前的日子不算班次。
 */
export function nextFixedDate(rule: FixedRepeatRule, afterDateKey: string): string | null {
  let key = addDays(afterDateKey < rule.start ? addDays(rule.start, -1) : afterDateKey, 1);
  for (let i = 0; i < SCAN_LIMIT; i++) {
    if (beyondUntil(rule, key)) return null;
    if (matchesFixed(rule, key)) return key;
    key = addDays(key, 1);
  }
  return null;
}

/** dateKey **當天或之前**的最後一個規則日（不早於 start）；沒有回 null */
export function lastFixedDate(rule: FixedRepeatRule, dateKey: string): string | null {
  if (dateKey < rule.start) return null;
  let key = beyondUntil(rule, dateKey) ? rule.until! : dateKey;
  for (let i = 0; i < SCAN_LIMIT; i++) {
    if (key < rule.start) return null;
    if (matchesFixed(rule, key)) return key;
    key = addDays(key, -1);
  }
  return null;
}

/** dateKey **當天或之後**的第一個規則日（不早於 start）；沒有回 null */
export function firstFixedDate(rule: FixedRepeatRule, dateKey: string): string | null {
  const from = dateKey < rule.start ? rule.start : dateKey;
  if (beyondUntil(rule, from)) return null;
  if (matchesFixed(rule, from)) return from;
  return nextFixedDate(rule, from);
}

/**
 * 把固定排程投影成 [from, to] 之間的班次日清單（日曆用，**不落庫**；WP5）。
 * 範圍很大時自己節流——這裡上限 400 天，超過就到此為止。
 */
export function projectFixed(rule: FixedRepeatRule, from: string, to: string): string[] {
  const out: string[] = [];
  if (to < from) return out;
  let key = firstFixedDate(rule, from);
  for (let i = 0; i < 400 && key !== null && key <= to; i++) {
    out.push(key);
    key = nextFixedDate(rule, key);
  }
  return out;
}

/**
 * 把「完成後間隔」**假設準時**往後投影：firstDue、firstDue+N、firstDue+2N…（≤ to、不超過 until）。
 *
 * ⚠ 這串裡只有第一個是真的（＝目前班次）；後面幾班是「如果每一班都當天做完」的假想（草案 §6-6）。
 * 日曆要不要畫（虛線）由呼叫端決定——`listSchedule` 的 `opts.projectAfter` 預設 **false**，
 * 投出來的假想班次在 `ScheduleEntry.is_assumed` 標 true。
 * 上限 400 班（與 projectFixed 同一把尺，防呆不是效能邊界）。
 */
export function projectAfter(rule: AfterRepeatRule, firstDue: string, to: string): string[] {
  const out: string[] = [];
  let key = firstDue;
  for (let i = 0; i < 400 && key <= to; i++) {
    if (beyondUntil(rule, key)) break;
    out.push(key);
    key = addDays(key, rule.days);
  }
  return out;
}

// ───────────────────────── 目前班次 ─────────────────────────

/**
 * 「完成後間隔」的錨點日：這一班是哪一天被交代掉的。
 *   done    → completed_at 的日界線日（＝完成後 N 天的「完成」那天；沒有時刻就退回班次日）
 *   skipped → 運休當下的日界線日（updated_at）——D-④-3「這班不開、下一班從今天起算」
 *
 * ⚠ 偏離草案 §4 一處：草案寫「skipped 取 due_on」。但誤點班次在今天按運休時，due_on＋N 可能還在過去，
 *    下一班一生出來就又是誤點，與拍板的「下一班從今天起算」打架 → 改用運休當下那天（updated_at 不會再變，
 *    syncRepeats 仍然冪等）。班次準時運休時兩種算法同值。
 */
function anchorOf(occ: OccurrenceSeed, dayStartHour: number): string {
  if (occ.status === "done") return occ.completed_at ? dayKeyOf(occ.completed_at, dayStartHour) : occ.due_on;
  return occ.updated_at ? dayKeyOf(occ.updated_at, dayStartHour) : occ.due_on;
}

/**
 * 目前班次日——引擎的心臟（lazy 同步 D-④-7 的唯一計算來源）。
 *
 * fixed（漏班收斂為最新一班，D-④-4）：
 *   D ＝ dateKey 當天或之前的最後一個規則日（≥ start）
 *   D 不存在（start 在未來）→ start 當天或之後的第一個規則日
 *   D 沒有班次記錄 → 目前班次＝D（＝今天，或誤點的那一班；更早漏掉的只留統計缺口）
 *   D 已經有記錄（済／運休）→ 往後走到第一個還沒有記錄的規則日（提前蓋章＝蓋下一班，Things 同款）
 *
 * after：錨＝最新一筆班次記錄的 anchorOf（沒有記錄→start）；目前班次＝錨＋N 天。
 *
 * 回傳 null＝這條規則已經沒有下一班（until 之後）——呼叫端把 scheduled_on 留在原值。
 */
export function currentDue(
  rule: RepeatRule,
  occurrences: readonly OccurrenceSeed[],
  dateKey: string,
  dayStartHour = 3,
): string | null {
  if (rule.mode === "after") {
    let anchor: string | null = null;
    for (const o of occurrences) {
      const a = anchorOf(o, dayStartHour);
      if (anchor === null || a > anchor) anchor = a;
    }
    if (anchor === null) return rule.start;
    const next = addDays(anchor, rule.days);
    return beyondUntil(rule, next) ? null : next;
  }

  const taken = new Set(occurrences.map((o) => o.due_on));
  let key = lastFixedDate(rule, dateKey);
  if (key === null) return firstFixedDate(rule, rule.start);
  for (let i = 0; i < SCAN_LIMIT && key !== null && taken.has(key); i++) {
    key = nextFixedDate(rule, key);
  }
  return key;
}
