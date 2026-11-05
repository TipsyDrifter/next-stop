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
import { addDays, dayKeyOf } from "../lib/date.ts";
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
  /** 每 N 期（⑥ D-主-294）；基準＝起算日，週以週一為開頭，不跟 week_start 偏好（偏好不同步，跟了兩台會算出不同班次） */
  interval: number;
  /** freq='weekly' 用；JS getDay()，0＝日。null＝未指定（describeRule 退回「每週重複」） */
  byweekday: number[] | null;
  /** freq='monthly' 用；1–31，超過當月天數夾到月底。null＝未指定 */
  bymonthday: number[] | null;
  /** 起算日 YYYY-MM-DD（D-④-6：＝掛規則當下的原執行日，無則今天） */
  start: string;
  /** 結束日（含當天） */
  until: string | null;
  /** 做滿 N 次（只數済，運休與漏班不算；D-主-292） */
  count: number | null;
  /** 單次改日期（D-主-295）：{ 原班次日: 新日子 }；寫入的唯一入口是 repository 的 moveOccurrence */
  moves?: RunMoves;
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
  moves?: RunMoves;
}

/** 單次改日期：{ 原班次日: 新日子 }。完成後間隔的原班次日＝引擎當時算出的那一班，錨點一變自動失效 */
export type RunMoves = Record<string, string>;

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

/** 間隔上限（D-主-294）：掃描窗 SCAN_LIMIT 要跨得過最大的間隔 */
export const REPEAT_INTERVAL_MAX: Readonly<Record<RepeatFreq, number>> = { daily: 365, weekly: 52, monthly: 12 };

/** 沒有合法項＝不帶 moves 這一格（沒改過日期的規則 JSON 跟以前逐字相同） */
function parseMoves(v: unknown): { moves?: RunMoves } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: RunMoves = {};
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
    if (isDateKey(k) && isDateKey(t) && k !== t) out[k] = t;
  }
  return Object.keys(out).length ? { moves: out } : {};
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
  const moves = parseMoves(o.moves);

  if (o.mode === "after") {
    const days = typeof o.days === "number" && Number.isInteger(o.days) && o.days >= 1 ? o.days : null;
    if (days === null) return null;
    return { v: 1, mode: "after", days, start: o.start, until, count, ...moves };
  }
  if (o.mode === "fixed") {
    const freq = o.freq;
    if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") return null;
    // 超過上限夾回：掃描窗裡找不到班次會被當成「跑完了」，壞值不能讓票自己到站
    const interval =
      typeof o.interval === "number" && Number.isInteger(o.interval) && o.interval >= 1
        ? Math.min(o.interval, REPEAT_INTERVAL_MAX[freq])
        : 1;
    const byweekday = freq === "weekly" ? intList(o.byweekday, 0, 6) : null;
    const bymonthday = freq === "monthly" ? intList(o.bymonthday, 1, 31) : null;
    // 每週／每月沒指定日子＝規則不完整（永遠算不出班次）→ 當成沒有規則
    if (freq === "weekly" && !byweekday) return null;
    if (freq === "monthly" && !bymonthday) return null;
    return { v: 1, mode: "fixed", freq, interval, byweekday, bymonthday, start: o.start, until, count, ...moves };
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
  const n = rule.interval;
  switch (rule.freq) {
    case "daily":
      return n > 1 ? `每 ${n} 天` : "每天重複";
    case "weekly": {
      const days = rule.byweekday;
      const head = n > 1 ? `每 ${n} 週` : "每週";
      if (!days || !days.length) return n > 1 ? head : "每週重複";
      const label = [...days].sort((a, b) => orderIndex(a) - orderIndex(b)).map((d) => WEEKDAY_LABEL[d] ?? "?");
      return `${head}${n > 1 ? " " : ""}${label.join("・")}`;
    }
    case "monthly": {
      const days = rule.bymonthday;
      const head = n > 1 ? `每 ${n} 個月` : "每月";
      if (!days || !days.length) return n > 1 ? head : "每月重複";
      if (days.length > 3) return `${head} ${days.length} 天`;
      return `${head} ${[...days].sort((a, b) => a - b).join("・")} 號`;
    }
  }
}

/** repeat_rule 欄的值 → 一句人話（同步清單用）；清成不重複＝「不重複」；看不懂＝null（呼叫端退回原值） */
export function ruleValueText(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return "不重複";
  if (typeof v !== "string") return null;
  const rule = parseRule(v);
  if (!rule) return null;
  const end = describeEnd(rule);
  const moved = Object.keys(rule.moves ?? {}).length;
  return [describeRule(rule), end, moved ? `改過 ${moved} 班日期` : null].filter(Boolean).join(" · ");
}

/** 規則的結束條件一句（重複段段頭用，不進今日與大綱列）；沒有結束條件＝null。done＝已做幾次，給了才寫「還剩」 */
export function describeEnd(rule: RepeatRule, done?: number): string | null {
  if (rule.count !== null) {
    return done === undefined ? `共 ${rule.count} 次` : `還剩 ${Math.max(rule.count - done, 0)} 班`;
  }
  if (rule.until === null) return null;
  const [y, m, d] = rule.until.split("-").map(Number);
  return `到 ${y === Number(rule.start.slice(0, 4)) ? "" : `${y}/`}${m}/${d}`;
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

/** panelRules 這類 node 直載的純規則要算日期時用（lib/date 沒副檔名，它載不動） */
export const addDaysKey = addDays;

/** 從 1970-01-01 起的第幾天（只拿來算差幾天，用 UTC 避開日光節約） */
function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** b 比 a 晚幾天（可為負） */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** 以週一為開頭的第幾週（1970-01-01 是週四，所以位移 3 天） */
function weekNumber(key: string): number {
  return Math.floor((dayNumber(key) + 3) / 7);
}

/** 這一期有沒有輪到（基準＝起算日；D-主-294） */
function onInterval(rule: FixedRepeatRule, key: string): boolean {
  const n = rule.interval;
  if (n <= 1) return true;
  let diff: number;
  switch (rule.freq) {
    case "daily":
      diff = daysBetween(rule.start, key);
      break;
    case "weekly":
      diff = weekNumber(key) - weekNumber(rule.start);
      break;
    case "monthly":
      diff =
        Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - (Number(rule.start.slice(0, 4)) * 12 + Number(rule.start.slice(5, 7)));
      break;
  }
  return ((diff % n) + n) % n === 0;
}

/** dateKey 符不符合規則本身的排程（不管 start／until／moves） */
function matchesFixed(rule: FixedRepeatRule, key: string): boolean {
  if (!onInterval(rule, key)) return false;
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

const movedAway = (rule: RepeatRule, key: string): boolean => rule.moves?.[key] !== undefined;
const movedIn = (rule: RepeatRule, key: string): boolean => !!rule.moves && Object.values(rule.moves).includes(key);

/** dateKey 是不是班次日：符合排程又沒被改走，或別班改到這天（EXDATE＋RDATE，呼叫端零特判） */
function isFixedRun(rule: FixedRepeatRule, key: string): boolean {
  return (matchesFixed(rule, key) && !movedAway(rule, key)) || movedIn(rule, key);
}

/** 掃描上限：一年半的天數（間隔上限 12 個月、52 週也跨得過；這是防呆不是效能邊界） */
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
    if (isFixedRun(rule, key)) return key;
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
    if (isFixedRun(rule, key)) return key;
    key = addDays(key, -1);
  }
  return null;
}

/**
 * dateKey 當天或之前最後一個「排程落點」：含被改走的原班次日。currentDue 從這裡往後走——
 * 今天那班改到週五時，不能倒回去抓上週漏掉的那班當目前班次。
 */
function lastFixedSlot(rule: FixedRepeatRule, dateKey: string): string | null {
  if (dateKey < rule.start) return null;
  let key = beyondUntil(rule, dateKey) ? rule.until! : dateKey;
  for (let i = 0; i < SCAN_LIMIT; i++) {
    if (key < rule.start) return null;
    if (matchesFixed(rule, key) || movedIn(rule, key)) return key;
    key = addDays(key, -1);
  }
  return null;
}

/** dateKey **當天或之後**的第一個規則日（不早於 start）；沒有回 null */
export function firstFixedDate(rule: FixedRepeatRule, dateKey: string): string | null {
  const from = dateKey < rule.start ? rule.start : dateKey;
  if (beyondUntil(rule, from)) return null;
  if (isFixedRun(rule, from)) return from;
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
 * 回傳 null＝這條規則跑完了（until 之後沒有班、或済滿 count 次）——呼叫端讓它到站（D-主-293）。
 * 還沒交代的最後一班不算跑完：它照舊是目前班次（進誤點區），交代了才回 null。
 */
export function currentDue(
  rule: RepeatRule,
  occurrences: readonly OccurrenceSeed[],
  dateKey: string,
  dayStartHour = 3,
): string | null {
  if (rule.count !== null && doneRuns(rule, occurrences) >= rule.count) return null;
  if (rule.mode === "after") {
    let anchor: string | null = null;
    for (const o of occurrences) {
      const a = anchorOf(o, dayStartHour);
      if (anchor === null || a > anchor) anchor = a;
    }
    if (anchor === null) return rule.moves?.[rule.start] ?? rule.start;
    const raw = addDays(anchor, rule.days);
    const next = rule.moves?.[raw] ?? raw;
    return beyondUntil(rule, next) ? null : next;
  }

  const taken = takenRuns(rule, occurrences);
  let key = lastFixedSlot(rule, dateKey);
  if (key === null) return firstFixedDate(rule, rule.start);
  for (let i = 0; i < SCAN_LIMIT && key !== null && (taken.has(key) || !isFixedRun(rule, key)); i++) {
    key = nextFixedDate(rule, key);
  }
  return key;
}

/**
 * 已經交代掉的班次日。原班次日有結局、又被改了日期（一台改期、另一台蓋章，同步後兩格都在）：改去的那天也算交代過，
 * 不然蓋過的那班會在新日子再出現一次。撤掉那個結局，改去的那天就回來。
 */
function takenRuns(rule: RepeatRule, occurrences: readonly Pick<OccurrenceSeed, "due_on">[]): Set<string> {
  const taken = new Set(occurrences.map((o) => o.due_on));
  for (const [from, to] of Object.entries(rule.moves ?? {})) if (taken.has(from)) taken.add(to);
  return taken;
}

/** 改去的日子裡已經交代掉的（投影不要畫；那天自己的結局由呼叫端另外補） */
export function settledMoveTargets(rule: RepeatRule, occurrences: readonly Pick<OccurrenceSeed, "due_on">[]): Set<string> {
  const out = new Set<string>();
  for (const [from, to] of Object.entries(rule.moves ?? {})) if (occurrences.some((o) => o.due_on === from)) out.add(to);
  return out;
}

/** 已經做了幾次（count 的那把尺，D-主-292）：只數済、只數班次日不早於起算日的 */
export function doneRuns(rule: RepeatRule, occurrences: readonly Pick<OccurrenceSeed, "due_on" | "status">[]): number {
  let n = 0;
  for (const o of occurrences) if (o.status === "done" && o.due_on >= rule.start) n++;
  return n;
}

/**
 * 把「做滿 N 次」換算成投影用的規則：until 收窄到最後會開的那一班，日曆與 bounds 才不會畫出做滿之後的假班次。
 * 從目前班次往後數還沒有結局的班（漏掉的舊班只留統計缺口，不佔名額；運休的班不佔名額）。沒有 count 原樣回傳。
 */
export function projectionRule(
  rule: FixedRepeatRule,
  occurrences: readonly OccurrenceSeed[],
  dateKey: string,
  dayStartHour = 3,
): FixedRepeatRule {
  if (rule.count === null) return rule;
  const left = rule.count - doneRuns(rule, occurrences);
  const taken = takenRuns(rule, occurrences);
  let key = left > 0 ? currentDue(rule, occurrences, dateKey, dayStartHour) : null;
  let last: string | null = null;
  for (let used = 0, i = 0; key !== null && used < left && i < SCAN_LIMIT; i++) {
    if (!taken.has(key)) {
      last = key;
      used++;
    }
    key = nextFixedDate(rule, key);
  }
  // 一班都不會再開：收到起算日前一天，規則投影是空的（歷史由 occurrences 補）
  const until = last ?? addDays(rule.start, -1);
  return { ...rule, until: rule.until !== null && rule.until < until ? rule.until : until };
}

// ───────────────────────── 單次改日期（D-主-295）─────────────────────────

/** 這一班原本是哪天（畫面的「原定 M/D」）；沒被改過＝null */
export function runOrigin(rule: RepeatRule, key: string): string | null {
  for (const [from, to] of Object.entries(rule.moves ?? {})) if (to === key) return from;
  return null;
}

/** 換上一組 moves；空的就不帶這一格（沒改過日期的規則 JSON 跟以前逐字相同） */
export function withMoves(rule: RepeatRule, moves: RunMoves): RepeatRule {
  const { moves: _old, ...rest } = rule;
  return (Object.keys(moves).length ? { ...rest, moves } : rest) as RepeatRule;
}

/** 這一班改日期之後的規則：已經改過的班接著改同一格；改回原日＝拿掉這一格 */
export function withRunMoved(rule: RepeatRule, from: string, to: string): RepeatRule {
  const moves: RunMoves = { ...rule.moves };
  const origin = runOrigin(rule, from) ?? from;
  delete moves[origin];
  if (origin !== to) moves[origin] = to;
  return withMoves(rule, moves);
}

/**
 * 這一班能不能改到 to；可以回 null，不行回原因（兩種實作與 UI 同一句）。
 * 歷史唯讀（同運休）：只能動目前班次與之後的，目標不能早於今天。一天一班：那天已經有班就擋下，要跳過請用運休。
 */
export function runMoveBlock(
  rule: RepeatRule,
  occurrences: readonly OccurrenceSeed[],
  from: string,
  to: string,
  dateKey: string,
  dayStartHour = 3,
): string | null {
  if (occurrences.some((o) => o.due_on === from)) return "這一班已經交代了，先取消済章或運休再改";
  const current = currentDue(rule, occurrences, dateKey, dayStartHour);
  if (current === null) return "這張定期券已經跑完了";
  if (rule.mode === "after") {
    if (from !== current) return "完成後間隔只能改目前這一班";
  } else if (from < current || firstFixedDate(rule, from) !== from) {
    return "這天不是接下來的班次";
  }
  // 改回原日不算改到過去：誤點那班挪到今天之後反悔，要回得去
  if (to < dateKey && runOrigin(rule, from) !== to) return "只能改到今天以後";
  if (to < rule.start) return "不能早於起算日";
  if (rule.until !== null && to > rule.until) return "不能晚於結束日";
  if (to === from) return null;
  const clash =
    occurrences.some((o) => o.due_on === to) || (rule.mode === "fixed" && isFixedRun(rule, to));
  return clash ? "那天已經有一班了；要跳過這一班請用運休" : null;
}

/** 兩條規則的班次排程一不一樣（只看排程，不看結束條件與 moves；D-主-296 換排程才清未來覆寫） */
export function sameSchedule(a: RepeatRule, b: RepeatRule): boolean {
  const key = (r: RepeatRule) =>
    r.mode === "after" ? ["after", r.days, r.start] : ["fixed", r.freq, r.interval, r.byweekday, r.bymonthday, r.start];
  return JSON.stringify(key(a)) === JSON.stringify(key(b));
}

/** 換排程時哪些改日期留著：落在今天以前、或那班已經有結局的是歷史（D-主-296），其他清掉 */
export function keptMoves(rule: RepeatRule, occurrences: readonly Pick<OccurrenceSeed, "due_on">[], dateKey: string): RunMoves {
  const out: RunMoves = {};
  for (const [from, to] of Object.entries(rule.moves ?? {})) {
    if (to < dateKey || occurrences.some((o) => o.due_on === to)) out[from] = to;
  }
  return out;
}
