/**
 * 時刻表線・車次⑦「作息範本」與「某一天的預定」的純函式層（⑦ 契約 §2、§3、§4；資料層）。
 *
 * 鐵則：只准 import `./timetable.ts`、`./timetableSchedule.ts`、`../lib/date.ts`、`../lib/uuidv5.ts`（其餘只准 `import type`；
 * 牙齒：`scripts/tests/timetable-routine.test.ts`），相對路徑一律帶 `.ts`（`node --test` 直載）；只用可剝除語法。
 * 時間一律毫秒；日界線日 key 是 `YYYY-MM-DD`；段的起訖是營業日表記（"25:00"＝隔天 01:00，`lib/date.ts`）。
 *
 * 內容：
 *   1. 型別：`TimeRoutineRow`（time_routines 一列）、`TimePlanRow`（time_plans 一列）、`RoutineItem`（範本的一段）
 *   2. 範本的段 JSON：`parseRoutineItems`／`serializeRoutineItems`／`checkRoutineItems`（`{"v":1,"items":[{cat,s,e}]}`；讀不懂＝null，同 `parseGoal`）
 *   3. 週幾位元（bit0＝週一 … bit6＝週日）：`weekdayBitOf`／`hasWeekday`／預設三組／`weekdaysSummary`／`weekdayOwners`
 *   4. 落地（D-時-160）：`autoRoutineFor`、`isMaterialized`、`routinePlanId`（uuid v5 決定性 id）、`materializeRows`、`dayWinnerRoutine`、
 *      `dayRoutineOf`（畫面要的那一天：已落地＝列、虛擬＝自動範本的段）、`planApplyRoutine`／`planEnsureMaterialized`／`planFillRoutine`
 *      （後兩支算「只寫本機、不送 op」的列：自動落地與收到就補齊）
 *   5. 對照（D-時-157、D-時-161）：`compareRoutineItem`、`fmtRoutineDelta`、`routineSummaryText`
 *   6. 從某天的記錄帶入：`routineFromDay`
 *   7. 車票多時段（D-時-162）：`assignSpansToSegments`、`slotsOfNode`
 */
import { MIN, sliceSpans, type Span } from "./timetable.ts";
import { DUR_SAME_MIN, ON_TIME_LATE_MIN, PLAN_TEXT, SCHED_TINY_MS } from "./timetableSchedule.ts";
import { clockInstant, clockMinutes, clockText, dayWindow, type ClockText } from "../lib/date.ts";
import { uuidv5 } from "../lib/uuidv5.ts";

/* ───────────────────────── 1. 型別 ───────────────────────── */

/** time_routines 一列（作息範本；欄位語義見 ⑦ 契約 §2） */
export interface TimeRoutineRow {
  id: string;
  name: string;
  /** JSON：`{"v":1,"items":[{"cat":"<子分類 id>","s":"HH:MM","e":"HH:MM","n":"名字"}]}`（`parseRoutineItems`；n 選填） */
  items: string;
  /** 位元：bit0＝週一 … bit6＝週日；0＝不自動帶 */
  weekdays: number;
  position: number;
  archived_at: string | null;
  account_id: string | null;
  device_id: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
}

/** time_plans 一列（某一天的預定：作息落地的段＝node_id NULL；車票第二段起＝node_id 非 NULL） */
export interface TimePlanRow {
  id: string;
  /** 'YYYY-MM-DD' 日界線日 */
  day: string;
  start_hm: ClockText;
  end_hm: ClockText;
  /** 作息段：分類；車票段：NULL */
  category_id: string | null;
  /** 車票段：車票；作息段：NULL */
  node_id: string | null;
  /** 從哪套範本落地（手動加的作息段、車票段＝NULL） */
  routine_id: string | null;
  /** 作息段的名字（D-時-167；早餐／午餐分得開）；NULL＝用分類名。0014 定稿前的測資沒有這欄 ⇒ undefined 當 null */
  label: string | null;
  account_id: string | null;
  device_id: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
}

/** 範本的一段：子分類＋起訖（營業日表記；可 ≥24）＋選填的名字（D-時-167；沒填＝分類名） */
export interface RoutineItem {
  cat: string;
  s: ClockText;
  e: ClockText;
  n?: string;
}

/** 寫入一列預定用（`insertPlans` 收這個：upsert by id、送完整列；`deleted` true＝寫成已刪——「這天不套」的標記） */
export interface PlanUpsert {
  id: string;
  day: string;
  start_hm: ClockText;
  end_hm: ClockText;
  category_id: string | null;
  node_id: string | null;
  routine_id: string | null;
  /** 段的名字（null＝用分類名；車票段一律 null） */
  label: string | null;
  deleted?: boolean;
  /** 只有本機落地（`materializePlans`）看：補齊的列沿用這天那套已有的列的 created_at（「最新套的是哪一套」不被補齊打亂）；沒給＝現在 */
  created_at?: string;
}

/** 改一列預定（只送真的變了的欄；undefined＝不動） */
export interface PlanPatch {
  day?: string;
  start_hm?: ClockText;
  end_hm?: ClockText;
  category_id?: string | null;
  /** null／空白＝清掉（用分類名） */
  label?: string | null;
}

/** 新建／改範本（repository 收這個；`items` 照 `checkRoutineItems` 驗） */
export interface RoutineInput {
  name: string;
  items: readonly RoutineItem[];
  weekdays: number;
}

/** 寫入前驗一列預定的日子與起訖（repository 用；不驗日界線範圍）。不對 ⇒ RangeError（人話） */
export function checkPlanTimes(day: string, s: string, e: string): void {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError("日期不對");
  const a = clockMinutes(s);
  const b = clockMinutes(e);
  if (a === null || b === null) throw new RangeError("時刻要像 14:00 這樣");
  if (!(b > a)) throw new RangeError("結束時間要晚於開始時間");
}

/** 段的名字存的值（D-時-167）：去前後空白、換行變空白；空／null／undefined＝null（用分類名） */
export function planLabelOf(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/[\r\n\t]+/g, " ").trim();
  return t ? t : null;
}

/** 作息段（node_id NULL）；車票段（node_id 非 NULL）。 */
export const isRoutineRow = (r: Pick<TimePlanRow, "node_id">): boolean => r.node_id === null;
export const isSlotRow = (r: Pick<TimePlanRow, "node_id">): boolean => r.node_id !== null;

/* ───────────────────────── 2. 範本的段 JSON ───────────────────────── */

export const ROUTINE_ITEMS_VERSION = 1;
export const EMPTY_ROUTINE_ITEMS = '{"v":1,"items":[]}';

const itemStartMin = (it: RoutineItem): number => clockMinutes(it.s) ?? 0;

/** 名字：去前後空白；空＝沒有（undefined） */
function itemName(n: unknown): string | undefined {
  if (typeof n !== "string") return undefined;
  const t = n.trim();
  return t ? t : undefined;
}

/** 一段只留 cat／s／e（＋有名字才帶 n）——鍵順序固定，兩台寫出同一個字串 */
function cleanItem(it: { cat: string; s: string; e: string; n?: unknown }): RoutineItem {
  const n = itemName(it.n);
  return n === undefined ? { cat: it.cat, s: it.s, e: it.e } : { cat: it.cat, s: it.s, e: it.e, n };
}

/** 一段長得對不對：分類非空、兩個時刻都是 "HH:MM"、結束晚於開始（不驗日界線範圍——那要日界線，交給呼叫端） */
function itemOk(x: unknown): x is RoutineItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.cat !== "string" || !o.cat) return false;
  if (typeof o.s !== "string" || typeof o.e !== "string") return false;
  const s = clockMinutes(o.s);
  const e = clockMinutes(o.e);
  return s !== null && e !== null && e > s;
}

/**
 * 讀範本的段（寬鬆）：外殼不是 `{"v":1,"items":[…]}`（新版寫的、壞掉的）⇒ null（顯示端略過、編輯端擋「這一版改不了」，同 `parseGoal`）；
 * 外殼對、個別一段壞掉 ⇒ 略過那一段。回傳依開始時刻排序（同時刻依結束、再依分類 id）。
 */
export function parseRoutineItems(json: string | null | undefined): RoutineItem[] | null {
  if (typeof json !== "string") return null;
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  if (rec.v !== ROUTINE_ITEMS_VERSION || !Array.isArray(rec.items)) return null;
  const out: RoutineItem[] = [];
  for (const x of rec.items) if (itemOk(x)) out.push(cleanItem(x));
  return sortItems(out);
}

function sortItems(items: RoutineItem[]): RoutineItem[] {
  return items.sort(
    (a, b) =>
      itemStartMin(a) - itemStartMin(b) ||
      (clockMinutes(a.e) ?? 0) - (clockMinutes(b.e) ?? 0) ||
      (a.cat < b.cat ? -1 : a.cat > b.cat ? 1 : 0),
  );
}

/** 範本的段 → JSON（依開始時刻排好；只留 cat／s／e／n，鍵順序固定＝兩台寫出同一個字串；沒名字不寫 n） */
export function serializeRoutineItems(items: readonly RoutineItem[]): string {
  const sorted = sortItems(items.map(cleanItem));
  return JSON.stringify({ v: ROUTINE_ITEMS_VERSION, items: sorted });
}

/** 寫入前驗（repository 用）：任何一段不對 ⇒ RangeError（人話）；回排好的新陣列 */
export function checkRoutineItems(items: readonly RoutineItem[]): RoutineItem[] {
  for (const it of items) {
    if (!it || typeof it.cat !== "string" || !it.cat) throw new RangeError("每一段都要選分類");
    const s = clockMinutes(it.s);
    const e = clockMinutes(it.e);
    if (s === null || e === null) throw new RangeError("時刻要像 14:00 這樣");
    if (!(e > s)) throw new RangeError("結束時間要晚於開始時間");
  }
  return sortItems(items.map(cleanItem));
}

/** 一段要顯示的名字：自己的名字，沒有就分類名（`catName` 由呼叫端給；查不到＝null） */
export function segName(seg: { label?: string | null; n?: string }, catName: string | null): string | null {
  return seg.label ?? seg.n ?? catName;
}

/* ───────────────────────── 3. 週幾位元 ───────────────────────── */

/** 每天／平日（一～五）／週末（六日） */
export const WEEKDAYS_EVERY = 0b1111111;
export const WEEKDAYS_WORK = 0b0011111;
export const WEEKDAYS_WEEKEND = 0b1100000;
/** bit0＝週一 … bit6＝週日 的一個字 */
export const WEEKDAY_CHARS = ["一", "二", "三", "四", "五", "六", "日"] as const;

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD'（日界線日）→ 位元序號 0（週一）… 6（週日）；格式不對 ⇒ -1。牆鐘算法（本地日期，不看時區位移） */
export function weekdayBitOf(dayKey: string): number {
  const m = typeof dayKey === "string" ? DATE_KEY_RE.exec(dayKey) : null;
  if (!m) return -1;
  const dow = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay(); // 0＝週日
  return (dow + 6) % 7;
}

/** 這一套的週幾含不含這一天 */
export function hasWeekday(mask: number, dayKey: string): boolean {
  const b = weekdayBitOf(dayKey);
  return b >= 0 && (mask & (1 << b)) !== 0;
}

/** 切換某一顆（bit 0–6）；回新的位元 */
export function toggleWeekday(mask: number, bit: number): number {
  if (!(bit >= 0 && bit <= 6)) return mask & WEEKDAYS_EVERY;
  return (mask ^ (1 << bit)) & WEEKDAYS_EVERY;
}

/** 範本清單上的週幾摘要：「每天」「平日」「週末」「週一、三、五」「不自動帶」 */
export function weekdaysSummary(mask: number): string {
  const m = mask & WEEKDAYS_EVERY;
  if (m === 0) return "不自動帶";
  if (m === WEEKDAYS_EVERY) return "每天";
  if (m === WEEKDAYS_WORK) return "平日";
  if (m === WEEKDAYS_WEEKEND) return "週末";
  const chars: string[] = [];
  for (let b = 0; b < 7; b++) if (m & (1 << b)) chars.push(WEEKDAY_CHARS[b]);
  return `週${chars.join("、")}`;
}

const byPosition = (a: TimeRoutineRow, b: TimeRoutineRow): number =>
  a.position - b.position || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 自動帶得到的範本（未刪、未封存），依 position → created_at → id */
function activeRoutines(routines: readonly TimeRoutineRow[]): TimeRoutineRow[] {
  return routines.filter((r) => r.deleted_at === null && r.archived_at === null).sort(byPosition);
}

/**
 * 每個週幾給了哪一套（index 0＝週一）；沒有＝null。編輯器在後面那套的週一旁寫「週一已給『工作日』」用：
 * `owners[b] !== null && owners[b] !== 自己` ⇒ 那一天被前面那套拿走了。
 */
export function weekdayOwners(routines: readonly TimeRoutineRow[]): (string | null)[] {
  const out: (string | null)[] = [null, null, null, null, null, null, null];
  for (const r of activeRoutines(routines)) {
    for (let b = 0; b < 7; b++) if (out[b] === null && r.weekdays & (1 << b)) out[b] = r.id;
  }
  return out;
}

/* ───────────────────────── 4. 落地（D-時-160） ───────────────────────── */

/**
 * uuid v5(DNS, "routine-plan.timetable.nextstop.shitetsu.app")（固定常數，寫法同 `TIMETABLE_ID_NAMESPACE`）；作息落地的預定列 id 從它算
 * （⑦ 契約 §3）。改了它＝兩台新舊版落地同一天會算出兩批列，**永不改**。
 */
export const ROUTINE_PLAN_NS = "6b8ea256-29fa-58fc-be3f-5d2208ab644e";

/**
 * 作息落地的那一列的 id：uuid v5(ROUTINE_PLAN_NS, `${day}|${routineId}|${cat}|${s}|${e}|${k}`)，k＝同一套裡一模一樣的段（分類＋起訖都同）
 * 的第幾個（從 0）。跟段的內容綁、不跟位置綁（反方評審 #2）：兩台用不同版本的範本落地同一天，同一段算出同一個 id，
 * 不同的段算出不同的 id——不會把一段的內容寫到另一段的 id 上。段的名字不進 id（改名不算另一段）。
 */
export function routinePlanId(day: string, routineId: string, item: Pick<RoutineItem, "cat" | "s" | "e">, k = 0): Promise<string> {
  return uuidv5(ROUTINE_PLAN_NS, `${day}|${routineId}|${item.cat}|${item.s}|${item.e}|${k}`);
}

/** 這套範本有沒有能落地的段（0 段、讀不懂＝沒有：套上去那天什麼都不會出現） */
export function routineHasItems(routine: TimeRoutineRow): boolean {
  return (parseRoutineItems(routine.items)?.length ?? 0) > 0;
}

/** 某天 D 的自動範本：沒封存、`weekdays` 含 D 的週幾、`position` 最前的那一套；沒有＝null */
export function autoRoutineFor(dayKey: string, routines: readonly TimeRoutineRow[]): TimeRoutineRow | null {
  for (const r of activeRoutines(routines)) if (hasWeekday(r.weekdays, dayKey)) return r;
  return null;
}

/** D 有任何 routine_id 不是 NULL 的作息列（含已刪）＝已落地 */
export function isMaterialized(rowsOfDay: readonly TimePlanRow[]): boolean {
  return rowsOfDay.some((r) => r.node_id === null && r.routine_id !== null);
}

/** 一套範本落到某一天的列（依範本的段順序；id 見 `routinePlanId`）。範本讀不懂 ⇒ [] */
export async function materializeRows(day: string, routine: TimeRoutineRow): Promise<PlanUpsert[]> {
  const items = parseRoutineItems(routine.items) ?? [];
  const out: PlanUpsert[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const sig = `${items[i].cat}|${items[i].s}|${items[i].e}`;
    const k = seen.get(sig) ?? 0;
    seen.set(sig, k + 1);
    out.push({
      id: await routinePlanId(day, routine.id, items[i], k),
      day,
      start_hm: items[i].s,
      end_hm: items[i].e,
      category_id: items[i].cat,
      node_id: null,
      routine_id: routine.id,
      label: items[i].n ?? null, // D-時-167：範本那段的名字跟著落地
    });
  }
  return out;
}

/** 畫面上的一段作息（已落地的列、或虛擬的範本段） */
export interface RoutineSeg {
  /** 列 id；虛擬段也有（＝落地後會用的那個 id，`routinePlanId`），所以 UI 一律拿 id 叫 store */
  id: string;
  /** true＝還沒寫進資料庫（自動範本的段）；store 動它之前會先把整天落地 */
  virtual: boolean;
  cat: string | null;
  s: ClockText;
  e: ClockText;
  /** 從哪一套來（手動加的＝null） */
  routineId: string | null;
  /** 段的名字（null＝用分類名；`segName`） */
  label: string | null;
}

/** 那一天的作息（store 的 `rowsForDay` 回這個） */
export interface DayRoutine {
  day: string;
  /** 已落地（D-時-160 的判定） */
  materialized: boolean;
  /**
   * 這天套的是哪一套：已落地＝還活著的段的 routine_id（全刪了＝「這天不套」或逐段刪光 ⇒ null）；
   * 虛擬＝自動範本（過去的日子不落地也不畫＝null）
   */
  routineId: string | null;
  /** 活著的作息段，依開始時刻 */
  segs: RoutineSeg[];
}

const segOrder = (a: RoutineSeg, b: RoutineSeg): number =>
  (clockMinutes(a.s) ?? 0) - (clockMinutes(b.s) ?? 0) || (clockMinutes(a.e) ?? 0) - (clockMinutes(b.e) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const segOfRow = (r: TimePlanRow): RoutineSeg => ({
  id: r.id,
  virtual: false,
  cat: r.category_id,
  s: r.start_hm,
  e: r.end_hm,
  routineId: r.routine_id,
  label: r.label ?? null,
});

/**
 * 已落地的一天以哪一套為準（沙盒 F-1：兩台離線時同一天各換一套，同步後兩套的列都活著）：
 * 每一套取它**活著的**作息列裡最大的 `created_at`，最大的那套＝後換的那一套（同樣大＝routine_id 大的）。
 * 只看列本身（不看本機狀態），兩台收到同一批列就算出同一套；讀的時候判斷、不為這件事多送任何 op。
 * 沒有活著的範本列（這天不套、逐段刪光、只剩手動段）⇒ null。車票段、別天的列不看。
 */
export function dayWinnerRoutine(rowsOfDay: readonly TimePlanRow[]): string | null {
  const newest = new Map<string, string>();
  for (const r of rowsOfDay) {
    if (r.node_id !== null || r.deleted_at !== null || r.routine_id === null) continue;
    const cur = newest.get(r.routine_id);
    if (cur === undefined || r.created_at > cur) newest.set(r.routine_id, r.created_at);
  }
  let win: string | null = null;
  let winAt = "";
  for (const [rid, at] of newest) {
    if (win === null || at > winAt || (at === winAt && rid > win)) {
      win = rid;
      winAt = at;
    }
  }
  return win;
}

/**
 * 那一天要畫的作息（D-時-160）。`rowsOfDay`＝這一天的 time_plans 列（**含已刪**；車票段會被略過）；`today`＝今天的日界線日。
 * - 已落地 ⇒ 畫活著的作息列；活著的列屬於好幾套時只畫 `dayWinnerRoutine` 那一套＋手動段（沙盒 F-1：後換的那一套為準），
 *   `routineId`＝那一套。作息帶、選單、總結、對照都從這裡讀，所以一起只看那一套；輸的那套等使用者下一次
 *   換一套／重新套用／這天不套時一起軟刪（`planApplyRoutine` 刪的是這天所有活著的段），資料就收成一套。
 * - 虛擬、而且 D ≥ 今天 ⇒ 畫自動範本的段（id 先算好；不寫資料）＋活著的手動段。
 * - 虛擬、D 是過去 ⇒ 只畫活著的手動段（使用者那天沒開過＝那天沒有作息）。
 */
export async function dayRoutineOf(
  day: string,
  rowsOfDay: readonly TimePlanRow[],
  routines: readonly TimeRoutineRow[],
  today: string,
): Promise<DayRoutine> {
  const mine = rowsOfDay.filter((r) => r.day === day && r.node_id === null);
  const alive = mine.filter((r) => r.deleted_at === null);
  if (isMaterialized(mine)) {
    const routineId = dayWinnerRoutine(alive);
    const shown = alive.filter((r) => r.routine_id === null || r.routine_id === routineId);
    return { day, materialized: true, routineId, segs: shown.map(segOfRow).sort(segOrder) };
  }
  const segs = alive.map(segOfRow);
  const auto = day >= today ? autoRoutineFor(day, routines) : null;
  if (auto) {
    for (const u of await materializeRows(day, auto)) {
      segs.push({ id: u.id, virtual: true, cat: u.category_id, s: u.start_hm, e: u.end_hm, routineId: auto.id, label: u.label });
    }
  }
  return { day, materialized: false, routineId: auto ? auto.id : null, segs: segs.sort(segOrder) };
}

/** 一次預定寫入（store 交給 repository：`insertPlans(upserts)`、逐筆 `deletePlan`） */
export interface PlanWrite {
  upserts: PlanUpsert[];
  deletes: string[];
}

/**
 * 自動落地（D-時-160：今天在載入、換日時；其他日子在使用者動它之前）要寫的列——**只寫本機、不送 op**
 * （`materializePlans`：本機已有那一列就不碰）。落地是每台各自照範本算出來的，同步只帶使用者真的動過的段；
 * 這樣落後的那台冷啟動時落地，也不會把另一台今天的改動蓋回範本原樣（反方評審 #1）。
 * 已落地、或沒有自動範本、或範本沒有段 ⇒ []。
 */
export async function planEnsureMaterialized(
  day: string,
  rowsOfDay: readonly TimePlanRow[],
  routines: readonly TimeRoutineRow[],
): Promise<PlanUpsert[]> {
  if (isMaterialized(rowsOfDay.filter((r) => r.day === day))) return [];
  const auto = autoRoutineFor(day, routines);
  if (!auto) return [];
  return materializeRows(day, auto);
}

/**
 * 收到就補齊（只寫本機、不送 op，同 `planEnsureMaterialized`）：另一台落地是只寫它本機的，同步過來的只有它動過的那幾段；
 * 這一天出現過（活著或已刪）某一套 R 的列 ⇒ 把 R 現在那套裡、本機還沒有的段補上，畫面才是完整的一天。
 * 補的列沿用這天 R 已有的列裡最早的 created_at。下面幾種不補：
 * - R 已刪、讀不懂或 0 段（封存的照補）。
 * - R 不是這天為準的那一套（`dayWinnerRoutine`）：R 只剩墓碑而另一套還有活著的段＝這天已經換成那一套了；
 *   兩套都還活著（兩台離線各換一套，沙盒 F-1）＝R 是輸的那套、畫面不畫它。補了就疊兩套（或把輸的那套補完整）。
 * - 版本對不上：這天 R 的列有不在「R 現在那套」裡的 id（範本改過段），或 R 在這些列落地之後改過（`updated_at` 較晚）——
 *   改範本只影響還沒落地的日子（D-時-160），已落地的那天不跟著長出新段；這時只畫收到的段，要整套就「重新套用」。
 * 這天完全沒有 R 的列 ⇒ 不補（過去沒開過的日子照樣沒有作息）。
 */
export async function planFillRoutine(
  day: string,
  rowsOfDay: readonly TimePlanRow[],
  routines: readonly TimeRoutineRow[],
): Promise<PlanUpsert[]> {
  const mine = rowsOfDay.filter((r) => r.day === day && r.node_id === null);
  const have = new Set(mine.map((r) => r.id));
  const byRoutine = new Map<string, TimePlanRow[]>();
  for (const r of mine) {
    if (r.routine_id === null) continue;
    const list = byRoutine.get(r.routine_id) ?? [];
    list.push(r);
    byRoutine.set(r.routine_id, list);
  }
  const winner = dayWinnerRoutine(mine);
  const out: PlanUpsert[] = [];
  for (const [rid, rows] of byRoutine) {
    const routine = routines.find((x) => x.id === rid);
    if (!routine || routine.deleted_at !== null || !routineHasItems(routine)) continue;
    if (winner !== null && rid !== winner) continue;
    const created = rows.reduce((m, r) => (r.created_at < m ? r.created_at : m), rows[0].created_at);
    if (routine.updated_at > created) continue;
    const full = await materializeRows(day, routine);
    const ids = new Set(full.map((u) => u.id));
    if (rows.some((r) => !ids.has(r.id))) continue;
    for (const u of full) if (!have.has(u.id)) out.push({ ...u, created_at: created });
  }
  return out;
}

/**
 * 換成某一套／重新套用／這天不套（`routine` null）——使用者動手，一般寫入、照常送 op：
 * - 這一天活著的作息段（含手動加的）全部軟刪，再寫新那套的列（決定性 id；跟舊列同 id 的＝直接 upsert 復活、不先刪）。
 *   「全部」看的是 `rowsOfDay` 本身、不是畫面：兩台離線各換一套留下的、畫面沒畫的那套（`dayWinnerRoutine` 輸的）也在這裡一起刪，
 *   使用者下一次在這天換一套／重新套用／這天不套，資料就收成一套（沙盒 F-1）。
 * - 這天不套而且還沒落地 ⇒ 把自動範本的列寫成「已刪」（標記還在，同一天不會再冒出來）；沒有自動範本＝沒東西要擋。
 * store 會先把那天在本機落地（`planEnsureMaterialized`／`planFillRoutine`）再叫這支，所以另一台本機落地的那套也會收到墓碑、不會疊兩套。
 * 車票段不動。
 * 範本還沒有段（0 段、讀不懂）⇒ RangeError：套上去那天什麼都不會出現，選單也停用它（反方評審 #4）。
 */
export async function planApplyRoutine(
  day: string,
  rowsOfDay: readonly TimePlanRow[],
  routine: TimeRoutineRow | null,
  routines: readonly TimeRoutineRow[],
): Promise<PlanWrite> {
  const mine = rowsOfDay.filter((r) => r.day === day && r.node_id === null);
  let upserts: PlanUpsert[] = [];
  if (routine) {
    if (!routineHasItems(routine)) throw new RangeError(`「${routine.name}」還沒有段`);
    upserts = await materializeRows(day, routine);
  } else if (!isMaterialized(mine)) {
    const auto = autoRoutineFor(day, routines);
    if (auto) upserts = (await materializeRows(day, auto)).map((u) => ({ ...u, deleted: true }));
  }
  const keep = new Set(upserts.filter((u) => !u.deleted).map((u) => u.id));
  const deletes = mine.filter((r) => r.deleted_at === null && !keep.has(r.id)).map((r) => r.id);
  return { upserts, deletes };
}

/* ───────────────────────── 5. 對照（D-時-157、D-時-161） ───────────────────────── */

export type RoutineState = "upcoming" | "running" | "onTime" | "late" | "notStarted" | "missed";

export interface RoutineCompare {
  state: RoutineState;
  /** 第一塊（重疊、同分類、不算碎塊）的開始 − 段的開始，取整分；沒實績＝null */
  startDeltaMin: number | null;
  /** 重疊合計（扣碎塊與待確認；運行中算到 now；夾在 [s, e]） */
  actualMs: number;
  /** 預定長度 */
  plannedMs: number;
  /** 實際（分）− 預定（分）；只在有實績、不是運行中、段已經結束時有值 */
  durDeltaMin: number | null;
  /** 照表＝準點開始（晚 ≤10 分或提早）而且做滿一半以上 */
  onSchedule: boolean;
  /** 描金用：算到這一段的塊 id（含碎塊與待確認），依開始 */
  blockIds: string[];
}

/** 實績那邊的一塊：Span＋待確認（store 用 blockIsLongRun 算好；不給＝false） */
export type RoutineSpan = Span & { pending?: boolean };

const roundSym = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/** 一段的 [開始, 結束)（ms）；時刻讀不懂 ⇒ null */
export function itemWindow(day: string, item: { s: ClockText; e: ClockText }): { start: number; end: number } | null {
  const start = clockInstant(day, item.s);
  const end = clockInstant(day, item.e);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

/**
 * 一段作息對實績（D-時-161）：當天跟 [s, e] 重疊、**同一個分類**的塊（原型回報 ✎2：段只能選子分類，不再有「組＝底下任一子分類」）。
 * - 還沒到開始時刻 ⇒ upcoming（不比）。
 * - 第一塊比開始：晚 ≤ 10 分或任何提早＝準點（D-時-81 同一把尺 `ON_TIME_LATE_MIN`）；> 10 分＝晚。
 * - 重疊合計比預定長度；碎塊（已結束、< 60 秒）不算開始也不算時長；待確認算開始、不算時長（同車票）。
 * - 沒有重疊：段還沒結束＝notStarted（還沒開始），結束了＝missed（沒記到）。
 * - 長短（`durDeltaMin`）只在段結束之後才有（now ≥ 結束）：段還在進行中只判開始（「準點」「晚 N 分開始」）。
 */
export function compareRoutineItem(
  day: string,
  item: { cat: string | null; s: ClockText; e: ClockText },
  spans: readonly RoutineSpan[],
  now: number,
): RoutineCompare {
  const w = itemWindow(day, item);
  const empty: RoutineCompare = { state: "upcoming", startDeltaMin: null, actualMs: 0, plannedMs: 0, durDeltaMin: null, onSchedule: false, blockIds: [] };
  if (!w) return empty;
  const plannedMs = w.end - w.start;
  if (now < w.start) return { ...empty, plannedMs };
  const mine = spans
    .filter((s) => item.cat !== null && s.categoryId === item.cat)
    .filter((s) => {
      const end = s.end ?? Math.max(now, s.start);
      return s.start < w.end && end > w.start;
    })
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const blockIds = mine.map((s) => s.id);
  const real = mine.filter((s) => s.end === null || s.end - s.start >= SCHED_TINY_MS);
  const counted = real.filter((s) => !s.pending);
  const actualMs = sliceSpans(counted, w, now).reduce((t, x) => t + x.ms, 0);
  const running = real.some((s) => s.end === null);
  const first = real[0] ?? null;
  const startDeltaMin = first ? roundSym((first.start - w.start) / MIN) : null;
  let state: RoutineState;
  if (running) state = "running";
  else if (first) state = startDeltaMin !== null && startDeltaMin > ON_TIME_LATE_MIN ? "late" : "onTime";
  else state = now < w.end ? "notStarted" : "missed";
  const startOk = startDeltaMin !== null && startDeltaMin <= ON_TIME_LATE_MIN;
  const onSchedule = startOk && actualMs * 2 >= plannedMs;
  // 段還沒結束不比長短（沙盒 O-2：23:00–25:00 那段 00:00 就寫「少 1h10m」，讀起來像已經定案）——只留開始那一半，結束後才寫完整的
  const durDeltaMin =
    first && !running && counted.length > 0 && now >= w.end ? roundSym(actualMs / MIN) - Math.round(plannedMs / MIN) : null;
  return { state, startDeltaMin, actualMs, plannedMs, durDeltaMin, onSchedule, blockIds };
}

/** 作息段的字（車票那套 `PLAN_TEXT` 之外多的） */
export const ROUTINE_TEXT = {
  missed: "沒記到",
  summary: (total: number, ok: number) => `作息 ${total} 段・照表 ${ok}`,
} as const;

/**
 * 段旁的差多少（寫法照車票 `fmtPlanDelta`）：「準點・少 30m」「晚 20 分開始・多花 15m」「運行中・準點」「還沒開始」「沒記到」；
 * upcoming ⇒ null（還沒到開始時刻不比）
 */
export function fmtRoutineDelta(c: RoutineCompare): string | null {
  if (c.state === "upcoming") return null;
  const parts: string[] = [];
  const d = c.startDeltaMin;
  switch (c.state) {
    case "onTime":
      parts.push(PLAN_TEXT.onTime);
      break;
    case "late":
      parts.push(PLAN_TEXT.lateStart(d ?? 0));
      break;
    case "running":
      parts.push(PLAN_TEXT.running);
      if (d !== null) parts.push(d > ON_TIME_LATE_MIN ? PLAN_TEXT.lateStart(d) : PLAN_TEXT.onTime);
      parts.push(PLAN_TEXT.soFar(c.actualMs, c.plannedMs));
      break;
    case "notStarted":
      parts.push(PLAN_TEXT.notStarted);
      break;
    case "missed":
      parts.push(ROUTINE_TEXT.missed);
      break;
  }
  if (c.state !== "running" && c.durDeltaMin !== null) {
    if (c.durDeltaMin >= DUR_SAME_MIN) parts.push(PLAN_TEXT.over(c.durDeltaMin * MIN));
    else if (c.durDeltaMin <= -DUR_SAME_MIN) parts.push(PLAN_TEXT.under(-c.durDeltaMin * MIN));
  }
  return parts.join(PLAN_TEXT.sep);
}

/** 頂端總結的作息那一句：「作息 8 段・照表 5」；0 段 ⇒ null（不印） */
export function routineSummaryText(cmps: readonly RoutineCompare[]): string | null {
  if (!cmps.length) return null;
  return ROUTINE_TEXT.summary(cmps.length, cmps.filter((c) => c.onSchedule).length);
}

/* ───────────────────────── 6. 從某天的記錄帶入 ───────────────────────── */

/** 帶入範本的門檻：那一天裡 ≥ 10 分的塊 */
export const ROUTINE_FROM_DAY_MIN = 10;

/** 瞬時 → 這一天軸上的牆鐘分鐘（自 dayKey 本地 00:00 起，可 ≥ 1440；秒捨去） */
function wallMinOf(dayKey: string, ms: number): number {
  const m = DATE_KEY_RE.exec(dayKey);
  if (!m) return 0;
  const n = new Date(ms);
  const days = Math.round((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) / 86400000);
  return days * 1440 + n.getHours() * 60 + n.getMinutes();
}

/**
 * 「從某天的記錄帶入…」：那一天（日界線窗內，夾窗）≥ 10 分的塊照開始順序帶成段，同分類相鄰的併成一段
 * （中間被 < 10 分的塊或空白隔開也算相鄰——那些本來就不帶）。運行中的塊算到 now。
 */
export function routineFromDay(blocks: readonly Span[], dayKey: string, dayStartHour: number, now: number): RoutineItem[] {
  const win = dayWindow(dayKey, dayStartHour);
  const w = { start: Date.parse(win.start), end: Date.parse(win.end) };
  const clipped = blocks
    .map((b) => ({ cat: b.categoryId, start: Math.max(b.start, w.start), end: Math.min(b.end ?? now, w.end), id: b.id }))
    .filter((b) => b.end - b.start >= ROUTINE_FROM_DAY_MIN * MIN)
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: { cat: string; s: number; e: number }[] = [];
  for (const b of clipped) {
    const s = wallMinOf(dayKey, b.start);
    const e = wallMinOf(dayKey, b.end);
    const last = out[out.length - 1];
    if (last && last.cat === b.cat) last.e = Math.max(last.e, e);
    else out.push({ cat: b.cat, s, e });
  }
  const items: RoutineItem[] = [];
  for (const x of out) {
    const s = clockText(x.s);
    const e = clockText(x.e);
    if (s !== null && e !== null && x.e > x.s) items.push({ cat: x.cat, s, e });
  }
  return items;
}

/* ───────────────────────── 7. 車票多時段（D-時-162） ───────────────────────── */

/** 一張票在某一天的一段（第一段＝主線的「幾點＋預計」，第二段起＝time_plans） */
export interface TicketSegment {
  key: string;
  start: number;
  end: number;
}

/**
 * 同一天有好幾段的票，連到它的塊分給哪一段：跟哪一段重疊最多就給哪一段（同樣多＝開始早的那段）；
 * 都沒重疊＝離開始最近的那一段（|塊的開始 − 段的開始| 最小；同樣近＝開始早的）。運行中的塊算到 now。
 * 回 段 key → 塊 id（依塊的開始）。段是空的 ⇒ {}。
 */
export function assignSpansToSegments(
  spans: readonly Span[],
  segments: readonly TicketSegment[],
  now: number,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!segments.length) return out;
  const segs = segments.slice().sort((a, b) => a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const g of segs) out[g.key] = [];
  const sorted = spans.slice().sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const s of sorted) {
    const end = s.end ?? Math.max(now, s.start);
    let best: TicketSegment | null = null;
    let bestOv = 0;
    for (const g of segs) {
      const ov = Math.min(end, g.end) - Math.max(s.start, g.start);
      if (ov > bestOv) {
        bestOv = ov;
        best = g;
      }
    }
    if (!best) {
      let bestD = Infinity;
      for (const g of segs) {
        const d = Math.abs(s.start - g.start);
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
    }
    if (best) out[best.key].push(s.id);
  }
  return out;
}

/** 一張票的第二段起（活著的），依日子、開始時刻；第 N 段＝index + 2（第一段是主線的時刻） */
export function slotsOfNode(rows: readonly TimePlanRow[], nodeId: string): TimePlanRow[] {
  return rows
    .filter((r) => r.node_id === nodeId && r.deleted_at === null)
    .sort(
      (a, b) =>
        (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
        (clockMinutes(a.start_hm) ?? 0) - (clockMinutes(b.start_hm) ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
