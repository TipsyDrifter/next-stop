/**
 * 預定時刻的領域規則（主線階段②；契約 §3.2）。
 *
 * 純函式、結構型別，**不 import data/**——時刻表線④與 `node --test` 都直接用路徑 import 這一檔
 * （只 import type ＋ 帶副檔名的 lib，規則同 streamModel.ts）。
 *
 * 兩個欄位（nodes.scheduled_time／NodeRow.time_overrides）的讀取一律經 `effectiveTime`；
 * UI 不准讀改寫 time_overrides 的 JSON，寫入的唯一入口是 repository 的 setRunTime／clearRunTime。
 *
 * 同步引擎班（D-主-120）：逐班覆寫的**儲存**從 `nodes.time_overrides` 整欄 JSON 拆成 `node_time_overrides` 一班一列
 * （整欄 LWW 會讓兩台改不同班互相吃掉，#86）。讀取面保形：repository 讀節點時把存活列摺回同一種 JSON 字串放進
 * `NodeRow.time_overrides`，所以 effectiveTime 與 UI 一行不改。舊欄原地保留、沒人讀也沒人寫（舊版物件的整欄寫入照套到舊欄）。
 */
import { isClockInRange, type ClockText } from "../lib/date.ts";
import { uuidv5 } from "../lib/uuidv5.ts";
import type { NodeRow } from "./node";

/** 逐班覆寫表（NodeRow.time_overrides 的形狀）：班次日 → 時刻；值 null＝「這一班沒有時刻」（蓋掉規則時刻） */
export type TimeOverrides = Record<string, ClockText | null>;

/**
 * `node_time_overrides.id` 的 uuid v5 命名空間（固定常數；兩台對同一張票的同一班算出同一個 id，
 * 逐列 LWW 才有「同一列」可談——同 occurrences／taggings 的慣例）。
 */
export const OVERRIDE_ID_NAMESPACE = "e6b1c4d2-8f3a-5d7e-9b20-4c6a1f8e3d57";

/** `node_time_overrides` 一列裡讀取要用的欄（repository 撈出來直接餵） */
export interface TimeOverrideRow {
  node_id: string;
  due_on: string;
  hhmm: string | null;
  deleted_at?: string | null;
}

/** `node_time_overrides.id` ＝ uuid v5(OVERRIDE_ID_NAMESPACE, `${nodeId}|${dueOn}`) */
export function overrideId(nodeId: string, dueOn: string): Promise<string> {
  return uuidv5(OVERRIDE_ID_NAMESPACE, `${nodeId}|${dueOn}`);
}

/**
 * 一張票的覆寫列 → 表。已軟刪、日期或時刻不合格式的列靜默丟掉（同 parseTimeOverrides 的寬容）。
 * `keep`＝讀取守門（呼叫端依目前規則決定哪些班次日算數，見 nodeRepository 的 `overrideKeepOf`）：
 * 換規則時只軟刪得到這台看過的未來列，另一台併發設的覆寫會活下來；落在新規則的非班次日就在這裡被忽略。
 */
export function overridesFromRows(
  rows: readonly TimeOverrideRow[],
  keep?: (dueOn: string) => boolean,
): TimeOverrides {
  const out: TimeOverrides = {};
  for (const r of rows) {
    if (r.deleted_at) continue;
    if (!DATE_RE.test(r.due_on)) continue;
    if (r.hhmm !== null && !CLOCK_RE.test(r.hhmm)) continue;
    if (keep && !keep(r.due_on)) continue;
    out[r.due_on] = r.hhmm as ClockText | null;
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^\d{2}:\d{2}$/;

/** 欄位字串 → 表（讀取面的 JSON，以及存量搬移時讀舊欄）。null／空字串／壞 JSON／不是物件 ⇒ {}；只收 key 合 /^\d{4}-\d{2}-\d{2}$/、值是 /^\d{2}:\d{2}$/ 或 null 的項，其餘靜默丟掉 */
export function parseTimeOverrides(json: string | null | undefined): TimeOverrides {
  if (typeof json !== "string" || json === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TimeOverrides = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!DATE_RE.test(k)) continue;
    if (v === null || (typeof v === "string" && CLOCK_RE.test(v))) out[k] = v;
  }
  return out;
}

/** 表 → 欄位字串。空表 ⇒ null（欄位清空、不存 "{}"）；key 排序後 JSON.stringify（兩台對同一表產同一字） */
export function serializeTimeOverrides(o: TimeOverrides): string | null {
  const keys = Object.keys(o).sort();
  if (keys.length === 0) return null;
  const sorted: TimeOverrides = {};
  for (const k of keys) sorted[k] = o[k];
  return JSON.stringify(sorted);
}

/**
 * 丟掉班次日 ≥ from 的項（換規則時清未來覆寫，§0-1 第 13 條 (b)）。回新物件。
 * 過去班次的覆寫一律保留——那是歷史（D-主-32；曾有 pruneTimeOverrides 在 setRunTime 時丟「過去且有結局」的項，
 * 結果過去那天的日程退回規則時刻、「差多少」被改寫，已拿掉）。
 */
export function dropFutureOverrides(o: TimeOverrides, from: string): TimeOverrides {
  const out: TimeOverrides = {};
  for (const [k, v] of Object.entries(o)) {
    if (k >= from) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 這張票有沒有重複規則（覆寫表的前提）。null／空字串／純空白 ⇒ 沒有。
 * 刻意不 import repeat.ts 的 parseRule：repeat.ts 帶無副檔名的 import，`node --test` 載不動這一檔。
 * 壞掉的規則字串在這裡算「有規則」（只多讀一次覆寫表，無害）；寫入端另有 parseRule 擋壞字串。
 */
export function hasRepeatRule(repeatRule: string | null | undefined): boolean {
  return typeof repeatRule === "string" && repeatRule.trim() !== "";
}

/**
 * 某張票在某一天的有效時刻（唯一真相；時刻表線④、票卡、排序都吃這支）：
 *   有重複規則 ∧ date 非 null ∧ 覆寫表有這一天 ⇒ 用它（含 null＝本班無時刻）；否則 scheduled_time。
 * **沒有規則的票覆寫表一律不讀**（B1：跨機並發「A 清規則、B 設本班時刻」會在無規則票上留下殘留覆寫，
 * 讀它會讓畫面和編輯入口對不上、又沒入口能清）。單發票也走這支，等於直接回 scheduled_time。
 */
export function effectiveTime(
  node: Pick<NodeRow, "scheduled_time" | "time_overrides" | "repeat_rule">,
  date: string | null,
): ClockText | null {
  if (date !== null && node.time_overrides && hasRepeatRule(node.repeat_rule)) {
    const o = parseTimeOverrides(node.time_overrides);
    if (Object.prototype.hasOwnProperty.call(o, date)) return o[date];
  }
  return node.scheduled_time ?? null;
}

/** 這一天的時刻來自覆寫表（UI 標「本班」）；沒有規則的票永遠 false（同 effectiveTime） */
export function isTimeOverridden(
  node: Pick<NodeRow, "time_overrides" | "repeat_rule">,
  date: string | null,
): boolean {
  if (date === null || !node.time_overrides || !hasRepeatRule(node.repeat_rule)) return false;
  return Object.prototype.hasOwnProperty.call(parseTimeOverrides(node.time_overrides), date);
}

/** 今日列的最小形狀（不 import data/）：TodayRow 滿足它 */
export interface TodayLike
  extends Pick<NodeRow, "id" | "scheduled_time" | "time_overrides" | "repeat_rule" | "scheduled_on"> {
  bucket: "late" | "due" | "today";
  occurrence: { due_on: string } | null;
}

/** 今日列的有效時刻＝effectiveTime(row, row.occurrence?.due_on ?? row.scheduled_on)（railDate 同一把尺；due 分區沒有執行日 ⇒ 退到 scheduled_time） */
export function timeOfRow(row: TodayLike): ClockText | null {
  return effectiveTime(row, row.occurrence?.due_on ?? row.scheduled_on);
}

/** 手排座標系（三處同一條）：沒時刻的 today 列 id，依傳入順序 */
export function manualOrderIds(rows: readonly TodayLike[]): string[] {
  return rows.filter((r) => r.bucket === "today" && timeOfRow(r) === null).map((r) => r.id);
}

/** 畫面列序（含有時刻的列）→ 手排座標：displayIndex 之前「沒時刻的 today 列」的個數 */
export function manualIndexOfDisplay(rows: readonly TodayLike[], displayIndex: number): number {
  let n = 0;
  const end = Math.min(displayIndex, rows.length);
  for (let i = 0; i < end; i++) {
    const r = rows[i];
    if (r.bucket === "today" && timeOfRow(r) === null) n++;
  }
  return n;
}

export const TIME_FORMAT_MSG = "時刻要像 14:00 這樣——比日界線早的凌晨寫成 25:00";
export const TIME_REPEAT_ONLY_MSG = "只有定期券能改單一班次的時刻";
export const TIME_FIXED_ORDER_MSG = "有時刻的票照時刻排——要換順序請改時刻";

/**
 * 寫入前的守門（update() 的 scheduled_time 與 setRunTime 的 time 兩種實作共用同一句）：
 * value 為 null／undefined＝清除，放行；非 null ⇒ dayStartHour 必須有值（沒有就直接 throw，不拿預設值當範圍，§0-1 第 17 條）
 * 且 isClockInRange，否則 throw `TIME_FORMAT_MSG`。
 */
export function assertClockWritable(value: string | null | undefined, dayStartHour: number | undefined): void {
  if (value === null || value === undefined) return;
  if (dayStartHour === undefined || !isClockInRange(value, dayStartHour)) throw new Error(TIME_FORMAT_MSG);
}
