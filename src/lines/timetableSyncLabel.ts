/**
 * timetableSyncLabel——同步頁「最近兩台撞到的」清單列：時刻表三張表的名字、欄名、值格式（③ 契約 0-13、D-時-58；丙席）。
 *
 * **純函式**：只准 import `../domain/timetable.ts`、`../lib/date.ts` 與型別（`scripts/tests/timetable-synclabel.test.ts`
 * 以 node 直接載入）。查列、查名字、文案（TT_TEXT）、跳轉都由呼叫端（`timetable.mount.tsx` 的 `syncRowLabel`）注入；
 * 這裡只把「一列」組成 `{ label, cols, fmt, note }`，`open` 由呼叫端補。
 *
 * 規則（0-13）：
 *   time_blocks     label＝`{M/D }{分類} {HH:MM}–{HH:MM}`（日界線日＝今天省日期；運行中「{HH:MM} 起」）；
 *                   已刪除（被整理掉／刪掉）⇒ note＝D-時-58 那句。
 *                   fmt：時刻欄＝本地 `M/D HH:MM`；category_id＝分類名（找不到「已刪除的分類」）；node_id＝節點名
 *                   （找不到「一張車票」）；route_id＝路線名（找不到「一條路線」）；estimate_min＝fmtDur；long_run_ack＝已確認／待確認。
 *   time_categories label＝`分類「{name}」`；fmt：parent_id＝分組名（null＝頂層）、default_min＝fmtDur、archived_at＝已封存／沒封存。
 *   time_goals      label＝`目標「{name}」`；fmt：scope＝分類名以「・」串（v1、⑥ 的 v2 都認）、period＝期間字、start_on／end_on＝M/D、
 *                   target_min＝fmtDur、direction＝至少／至多、archived_at＝已封存／沒封存。
 *   ⑦ time_routines label＝`作息範本「{name}」`；fmt：items＝「N 段」（讀不懂＝null）、weekdays＝週幾摘要、archived_at＝已封存／沒封存。
 *   ⑦ time_plans    label＝作息段 `{M/D} {名字或分類} {HH:MM}–{HH:MM}`；車票段 `{M/D} {車票} 第 N 段 {HH:MM}–{HH:MM}`（N 由呼叫端算；不知道就省掉）；
 *                   fmt：day＝M/D、category_id＝分類名、node_id＝車票名、routine_id＝範本名（null＝手動加的）。
 *   週幾摘要與段數由呼叫端注入（`text.syncWeekdays`／`syncRoutineItems`；本檔只准 import 兩支）。
 * fmt 對不認得的欄、或值的型別不對 ⇒ 回 null（退回核心的 `fmtMergeValue`）。null 值另有字的欄（例 ended_at＝運行中）照印字。
 */
import { MIN, fmtClock, fmtDur, msOf, type TimeBlockRow, type TimeCategoryRow, type TimeGoalRow } from "../domain/timetable.ts";
import type { TimePlanRow, TimeRoutineRow } from "../domain/timetableRoutine.ts";
import { todayKey } from "../lib/date.ts";
import type { SyncRowLabel } from "./types.ts";

/** 呼叫端注入的文案（＝`TT_TEXT` 的 sync 段；顯示端不手抄） */
export interface SyncLabelText {
  syncBlockGone: string;
  syncRunningFrom: string;
  syncCatLabel: (name: string) => string;
  syncGoalLabel: (name: string) => string;
  syncCatGone: string;
  syncNodeGone: string;
  syncRouteGone: string;
  syncTopLevel: string;
  syncNoEstimate: string;
  syncNoDefault: string;
  syncNoScope: string;
  syncRunning: string;
  syncAck: string;
  syncPending: string;
  syncArchived: string;
  syncNotArchived: string;
  syncCols: {
    time_blocks: Readonly<Record<string, string>>;
    time_categories: Readonly<Record<string, string>>;
    time_goals: Readonly<Record<string, string>>;
    /** ⑦（舊測資沒給＝undefined：只是沒有中文欄名） */
    time_routines?: Readonly<Record<string, string>>;
    time_plans?: Readonly<Record<string, string>>;
  };
  /** ⑦ */
  syncRoutineLabel?: (name: string) => string;
  syncRoutineGone?: string;
  syncRoutineManual?: string;
  syncWeekdays?: (mask: number) => string;
  syncRoutineItems?: (json: string) => string | null;
  syncSlotOrdinal?: (n: number) => string;
  goalPeriodWord: Readonly<Record<string, string>>;
  goalDirectionWord: Readonly<Record<string, string>>;
}

/** 呼叫端注入的查名字（同步、讀快取；查不到回 null） */
export interface SyncLabelLookup {
  now: number;
  dayStartHour: number;
  /** 分類名（含封存；已刪除也能給就給） */
  categoryName(id: string): string | null;
  /** 節點名（車票／列車／車廂…） */
  nodeName(id: string): string | null;
  /** 路線名 */
  routeName(id: string): string | null;
  /** ⑦：範本名（含已刪；沒給＝查不到） */
  routineName?(id: string): string | null;
}

const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));

/** 'YYYY-MM-DD' → 'M/D'（不經 Date.parse） */
export function mdOfKey(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
}

/** 毫秒 → 本地 `M/D HH:MM` */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isoMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const ms = msOf(v);
  return Number.isFinite(ms) ? ms : null;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/* ───────── time_blocks ───────── */

/** 清單列名：`{M/D }{分類} {HH:MM}–{HH:MM}`；日界線日＝今天省日期；運行中「{HH:MM} 起」 */
export function blockLabel(row: TimeBlockRow, look: SyncLabelLookup, text: SyncLabelText): string {
  const start = msOf(row.started_at);
  const cat = look.categoryName(row.category_id) ?? text.syncCatGone;
  const day = todayKey(look.dayStartHour, new Date(start));
  const today = todayKey(look.dayStartHour, new Date(look.now));
  const date = day === today ? "" : mdOfKey(day) + " ";
  const span =
    row.ended_at === null ? `${fmtClock(start)} ${text.syncRunningFrom}` : `${fmtClock(start)}–${fmtClock(msOf(row.ended_at))}`;
  return `${date}${cat} ${span}`;
}

export function blockFmt(look: SyncLabelLookup, text: SyncLabelText): (col: string, v: unknown) => string | null {
  return (col, v) => {
    switch (col) {
      case "started_at": {
        const ms = isoMs(v);
        return ms === null ? null : localStamp(ms);
      }
      case "ended_at": {
        if (v === null || v === undefined) return text.syncRunning;
        const ms = isoMs(v);
        return ms === null ? null : localStamp(ms);
      }
      case "category_id":
        return typeof v === "string" ? (look.categoryName(v) ?? text.syncCatGone) : null;
      case "node_id":
        if (v === null || v === undefined) return null;
        return typeof v === "string" ? (look.nodeName(v) ?? text.syncNodeGone) : null;
      case "route_id":
        if (v === null || v === undefined) return null;
        return typeof v === "string" ? (look.routeName(v) ?? text.syncRouteGone) : null;
      case "estimate_min": {
        if (v === null || v === undefined) return text.syncNoEstimate;
        const n = asNum(v);
        return n === null ? null : fmtDur(n * MIN);
      }
      case "long_run_ack": {
        const n = asNum(v);
        return n === 1 ? text.syncAck : n === 0 ? text.syncPending : null;
      }
      default:
        return null;
    }
  };
}

/** 一塊的清單列（不含 open）；已刪除 ⇒ note（D-時-58，0-3：往下併後又被整理掉也是這一句） */
export function blockSyncLabel(row: TimeBlockRow, look: SyncLabelLookup, text: SyncLabelText): SyncRowLabel {
  const out: SyncRowLabel = { label: blockLabel(row, look, text), cols: text.syncCols.time_blocks, fmt: blockFmt(look, text) };
  if (row.deleted_at !== null) out.note = text.syncBlockGone;
  return out;
}

/* ───────── time_categories ───────── */

export function categorySyncLabel(row: TimeCategoryRow, look: SyncLabelLookup, text: SyncLabelText): SyncRowLabel {
  return {
    label: text.syncCatLabel(row.name),
    cols: text.syncCols.time_categories,
    fmt: (col, v) => {
      switch (col) {
        case "parent_id":
          if (v === null || v === undefined) return text.syncTopLevel;
          return typeof v === "string" ? (look.categoryName(v) ?? text.syncCatGone) : null;
        case "default_min": {
          if (v === null || v === undefined) return text.syncNoDefault;
          const n = asNum(v);
          return n === null ? null : fmtDur(n * MIN);
        }
        case "archived_at":
          return v === null || v === undefined ? text.syncNotArchived : text.syncArchived;
        default:
          return null;
      }
    },
  };
}

/* ───────── time_goals ───────── */

/**
 * scope JSON → 分類名以「・」串（已刪除、找不到的略過；全部找不到＝「（沒有分類）」）；解不開 ⇒ null。
 * ⑥ 0-4／§5.7：認 v1 `{"categories":[…]}` 與 v2 `{"v":2,"cats":[…]}`（規則同 `timetableStats.ts` 的 `parseGoal`：有 `v` 鍵但不是 2、
 * 或只有 `cats` 沒有 `v` ⇒ null）。荷札在 taggings、不在這欄，不另印。
 */
export function scopeNames(v: unknown, look: SyncLabelLookup, text: SyncLabelText): string | null {
  if (typeof v !== "string") return null;
  let ids: unknown;
  let routeIds: unknown = [];
  let nodeIds: unknown = [];
  try {
    const o: unknown = JSON.parse(v);
    if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
    const s = o as { v?: unknown; cats?: unknown; categories?: unknown; routes?: unknown; nodes?: unknown };
    ids = "v" in s ? (s.v === 2 ? s.cats : null) : s.categories;
    if ("v" in s && s.v === 2) {
      if (Array.isArray(s.routes)) routeIds = s.routes;
      if (Array.isArray(s.nodes)) nodeIds = s.nodes;
    }
  } catch {
    return null;
  }
  if (!Array.isArray(ids)) return null;
  const names: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const n = look.categoryName(id);
    if (n !== null) names.push(n);
  }
  for (const id of routeIds as unknown[]) {
    if (typeof id !== "string") continue;
    const n = look.routeName(id);
    if (n !== null) names.push(n);
  }
  for (const id of nodeIds as unknown[]) {
    if (typeof id !== "string") continue;
    const n = look.nodeName(id);
    if (n !== null) names.push(n);
  }
  return names.length ? names.join("・") : text.syncNoScope;
}

export function goalSyncLabel(row: TimeGoalRow, look: SyncLabelLookup, text: SyncLabelText): SyncRowLabel {
  return {
    label: text.syncGoalLabel(row.name),
    cols: text.syncCols.time_goals,
    fmt: (col, v) => {
      switch (col) {
        case "scope":
          return scopeNames(v, look, text);
        case "period":
          return typeof v === "string" && Object.prototype.hasOwnProperty.call(text.goalPeriodWord, v) ? text.goalPeriodWord[v] : null;
        case "direction":
          return typeof v === "string" && Object.prototype.hasOwnProperty.call(text.goalDirectionWord, v) ? text.goalDirectionWord[v] : null;
        case "start_on":
        case "end_on":
          return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? mdOfKey(v) : null;
        case "target_min": {
          const n = asNum(v);
          return n === null ? null : fmtDur(n * MIN);
        }
        case "archived_at":
          return v === null || v === undefined ? text.syncNotArchived : text.syncArchived;
        default:
          return null;
      }
    },
  };
}

/* ───────── ⑦ time_routines ───────── */

export function routineSyncLabel(row: TimeRoutineRow, _look: SyncLabelLookup, text: SyncLabelText): SyncRowLabel {
  return {
    label: text.syncRoutineLabel ? text.syncRoutineLabel(row.name) : row.name,
    cols: text.syncCols.time_routines,
    fmt: (col, v) => {
      switch (col) {
        case "items":
          return typeof v === "string" && text.syncRoutineItems ? text.syncRoutineItems(v) : null;
        case "weekdays": {
          const n = asNum(v);
          return n === null || !text.syncWeekdays ? null : text.syncWeekdays(n);
        }
        case "archived_at":
          return v === null || v === undefined ? text.syncNotArchived : text.syncArchived;
        default:
          return null;
      }
    },
  };
}

/* ───────── ⑦ time_plans ───────── */

/**
 * 一列預定的清單列名：作息段「11/3 創作 09:00–12:00」；車票段「11/3 期中報告 第 2 段 14:00–16:00」（`ordinal` 不知道＝省掉「第 N 段」）。
 * 日期一律印（預定常排在別天，省掉反而看不出是哪天）。
 */
export function planLabel(row: TimePlanRow, look: SyncLabelLookup, text: SyncLabelText, ordinal: number | null): string {
  const span = `${row.start_hm}–${row.end_hm}`;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(row.day) ? mdOfKey(row.day) + " " : "";
  if (row.kind === "adhoc") {
    const name =
      row.label ??
      (row.node_id !== null ? look.nodeName(row.node_id) : null) ??
      (row.route_id ? look.routeName(row.route_id) : null) ??
      (row.category_id !== null ? look.categoryName(row.category_id) : null) ??
      "臨時班次";
    return `${date}${name} ${span}`;
  }
  if (row.node_id !== null) {
    const name = look.nodeName(row.node_id) ?? text.syncNodeGone;
    const nth = ordinal !== null && text.syncSlotOrdinal ? ` ${text.syncSlotOrdinal(ordinal)}` : "";
    return `${date}${name}${nth} ${span}`;
  }
  // D-時-167：段有自己的名字就印名字（早餐／午餐），沒有才印分類名
  const cat = row.label ?? (row.category_id !== null ? (look.categoryName(row.category_id) ?? text.syncCatGone) : text.syncCatGone);
  return `${date}${cat} ${span}`;
}

export function planSyncLabel(row: TimePlanRow, look: SyncLabelLookup, text: SyncLabelText, ordinal: number | null = null): SyncRowLabel {
  return {
    label: planLabel(row, look, text, ordinal),
    cols: text.syncCols.time_plans,
    fmt: (col, v) => {
      switch (col) {
        case "day":
          return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? mdOfKey(v) : null;
        case "category_id":
          if (v === null || v === undefined) return null;
          return typeof v === "string" ? (look.categoryName(v) ?? text.syncCatGone) : null;
        case "node_id":
          if (v === null || v === undefined) return null;
          return typeof v === "string" ? (look.nodeName(v) ?? text.syncNodeGone) : null;
        case "route_id":
          if (v === null || v === undefined) return null;
          return typeof v === "string" ? (look.routeName(v) ?? text.syncRouteGone) : null;
        case "kind":
          if (v === "adhoc") return "臨時班次";
          return null;
        case "routine_id":
          if (v === null || v === undefined) return text.syncRoutineManual ?? null;
          return typeof v === "string" ? (look.routineName?.(v) ?? text.syncRoutineGone ?? null) : null;
        default:
          return null;
      }
    },
  };
}
