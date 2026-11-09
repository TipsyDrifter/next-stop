/**
 * 資料匯出的純函式（失物招領 §4；D-主-322、323）：範圍與表的分類、清掉不該帶的列與欄、JSON、CSV（RFC 4180＋公式注入防護）、
 * 檔名、zip 裝箱。零副作用、不碰 Tauri／React／SQLite，node 測試直接載入（值 import 一律帶 `.ts`）。
 * 讀資料庫與寫檔在 `data/dataExport.ts`。
 *
 * 匯出的是「活著的資料」：不含已刪（tombstone）、競合日誌、快取欄、settings、同步簿記。要存底請用備份檔。
 *   * JSON：`{ app, schema, exported_at, scope, tables }`，欄照資料庫、留 id，方便別的工具處理。
 *   * CSV：給人讀、給試算表開的——欄名中文、id 換成名稱（路線、上層、分類、帳戶、荷札…），UTF-8 BOM＋CRLF。
 *
 * 表的分類（`EXPORT_SCOPES`）要和同步表清單 `SYNC_TABLE_NAMES` 對帳（測試守著）：以後新增一張同步表，
 * 沒有被分進任何範圍（也沒列進「不匯出」）測試就會紅，不會悄悄漏匯。
 */
import type { ZipFile } from "./storeZip.ts";
import { buildStoreZip } from "./storeZip.ts";
import { effectiveStation } from "./board.ts";
import { KIND_LABEL, WORK_LOG_EVENT_LABEL } from "./node.ts";
import type { NodeKind, WorkLogEvent } from "./node.ts";
import { ACCOUNT_GROUPS, WISH_ACTION_LABEL } from "./ticket.ts";
import type { WishAction } from "./ticket.ts";
import { describeRule, parseRule } from "./repeat.ts";
import { periodLabel, periodOfKey, stationIdOfKey } from "./weekAims.ts";
import { dayKeyOf } from "../lib/date.ts";

/* ═══════════════════════ 範圍與表 ═══════════════════════ */

export type ExportScope = "all" | "tasks" | "notes" | "timetable" | "ticket";
export type ExportFormat = "json" | "csv";
export type ExportRow = Record<string, unknown>;
export type ExportTables = Record<string, ExportRow[]>;

/** 荷札兩張表跟著每個範圍走（各範圍的 CSV 有「荷札」欄、JSON 也要能對回名稱）；掛在哪些東西上則依範圍過濾 */
const TAG_TABLES = ["tags", "taggings"] as const;
const TASK_TABLES = ["nodes", "work_logs", "occurrences", "node_time_overrides", "week_aims", "stamps"] as const;
const NOTE_TABLES = ["notes"] as const;
const TIMETABLE_TABLES = ["time_categories", "time_blocks", "time_goals", "time_routines", "time_plans"] as const;
const TICKET_TABLES = [
  "tk_currencies",
  "tk_accounts",
  "tk_categories",
  "tk_entries",
  "tk_budgets",
  "tk_repeats",
  "wr_kinds",
  "tk_wishes",
  "tk_templates",
] as const;

/** 有意不匯出的同步表（裝置本地設定，不是主人的資料） */
export const EXPORT_SKIPPED_TABLES: readonly string[] = ["settings"];

export interface ExportScopeInfo {
  id: ExportScope;
  /** 按鈕與檔名用的字 */
  label: string;
  /** 整份 CSV 時這一段放的子資料夾；單一範圍的 zip 直接放根目錄 */
  folder: string | null;
  tables: readonly string[];
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

const SCOPE_TABLES: Record<Exclude<ExportScope, "all">, readonly string[]> = {
  tasks: [...TASK_TABLES, ...TAG_TABLES],
  notes: [...NOTE_TABLES, ...TAG_TABLES],
  timetable: [...TIMETABLE_TABLES, ...TAG_TABLES],
  ticket: [...TICKET_TABLES, ...TAG_TABLES],
};

export const EXPORT_SCOPES: readonly ExportScopeInfo[] = [
  { id: "all", label: "整份", folder: null, tables: uniq([...SCOPE_TABLES.tasks, ...SCOPE_TABLES.notes, ...SCOPE_TABLES.timetable, ...SCOPE_TABLES.ticket]) },
  { id: "tasks", label: "任務", folder: "任務", tables: SCOPE_TABLES.tasks },
  { id: "notes", label: "筆記", folder: "筆記", tables: SCOPE_TABLES.notes },
  { id: "timetable", label: "時刻表", folder: "時刻表", tables: SCOPE_TABLES.timetable },
  { id: "ticket", label: "售票口", folder: "售票口", tables: SCOPE_TABLES.ticket },
];

export function scopeInfo(scope: ExportScope): ExportScopeInfo {
  return EXPORT_SCOPES.find((s) => s.id === scope) ?? EXPORT_SCOPES[0];
}

export function tablesOfScope(scope: ExportScope): readonly string[] {
  return scopeInfo(scope).tables;
}

/** 荷札掛的東西 → 屬於哪個範圍；認不得的種類（以後新增的）只在「整份」裡帶 */
function taggingScope(entityType: string): Exclude<ExportScope, "all"> | null {
  if (entityType === "node") return "tasks";
  if (entityType === "note") return "notes";
  if (entityType.startsWith("timetable:")) return "timetable";
  if (entityType.startsWith("ticket:")) return "ticket";
  return null;
}

/** 荷札掛的東西 → 它存在哪張表（用來丟掉掛在已刪東西上的荷札）；不認得 → 不檢查 */
const ENTITY_TABLE: Readonly<Record<string, string>> = {
  node: "nodes",
  note: "notes",
  "timetable:block": "time_blocks",
  "timetable:block-off": "time_blocks",
  "timetable:category": "time_categories",
  "timetable:goal": "time_goals",
  "ticket:entry": "tk_entries",
  "ticket:repeat": "tk_repeats",
  "ticket:wish": "tk_wishes",
  "ticket:template": "tk_templates",
};

/* ═══════════════════════ 清理：只留活著的、拿掉快取欄 ═══════════════════════ */

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** 同步簿記與沒在用的欄：每張表都拿掉 */
const BOOKKEEPING_COLS = ["synced_at", "device_id", "account_id"] as const;
/** 這幾張表的 account_id 是「記在哪個帳戶」的資料，不是簿記欄，要留 */
const ACCOUNT_ID_IS_DATA: readonly string[] = ["tk_entries", "tk_repeats", "tk_templates"];

function stripColumns(table: string, row: ExportRow): ExportRow {
  const out: ExportRow = {};
  // nodes.line_id 是快取；route_id 只有「根層臨時車票」那一列是資料（路線標籤），其餘是快取（同 sync/tables/core.rs 的口徑）
  const isRootTicket = table === "nodes" && row.parent_id == null && row.kind === "ticket";
  for (const [k, v] of Object.entries(row)) {
    if ((BOOKKEEPING_COLS as readonly string[]).includes(k) && !(k === "account_id" && ACCOUNT_ID_IS_DATA.includes(table))) continue;
    if (table === "nodes" && (k === "line_id" || (k === "route_id" && !isRootTicket))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 原始列 → 該範圍要匯出的表（順序照 `EXPORT_SCOPES`）。資料層的 SQL 已經先濾過一次，這裡再濾一次是雙保險，
 * 同時讓「已刪、競合日誌、沒有活節點」這些規則能不靠資料庫就測：
 *   * 已刪（`deleted_at` 非空）的列不帶。
 *   * `work_logs` 的競合日誌（`event='conflict'`）不帶；乘務記錄、班次、時刻覆寫掛在已刪節點上的也不帶。
 *   * 荷札：已刪的不帶；只帶「掛在這個範圍的東西、且那個東西還活著」的。
 */
export function prepareExportTables(scope: ExportScope, raw: ExportTables): ExportTables {
  const names = tablesOfScope(scope);
  const live = (t: string): ExportRow[] => (raw[t] ?? []).filter((r) => r.deleted_at == null);

  const out: ExportTables = {};
  const liveByTable: Record<string, ExportRow[]> = {};
  for (const t of names) liveByTable[t] = live(t);

  const nodeIds = names.includes("nodes") ? new Set(liveByTable.nodes.map((r) => str(r.id))) : null;
  if (nodeIds) {
    liveByTable.work_logs = liveByTable.work_logs.filter((r) => r.event !== "conflict" && nodeIds.has(str(r.node_id)));
    liveByTable.occurrences = liveByTable.occurrences.filter((r) => nodeIds.has(str(r.node_id)));
    liveByTable.node_time_overrides = liveByTable.node_time_overrides.filter((r) => nodeIds.has(str(r.node_id)));
  } else if (liveByTable.work_logs) {
    liveByTable.work_logs = liveByTable.work_logs.filter((r) => r.event !== "conflict");
  }

  if (names.includes("taggings")) {
    const tagIds = new Set(liveByTable.tags.map((r) => str(r.id)));
    const aliveIds: Record<string, Set<string>> = {};
    for (const t of new Set(Object.values(ENTITY_TABLE))) {
      if (names.includes(t)) aliveIds[t] = new Set(liveByTable[t].map((r) => str(r.id)));
    }
    liveByTable.taggings = liveByTable.taggings.filter((g) => {
      const type = str(g.entity_type);
      if (!tagIds.has(str(g.tag_id))) return false;
      if (scope !== "all" && taggingScope(type) !== scope) return false;
      const home = ENTITY_TABLE[type];
      const alive = home ? aliveIds[home] : undefined;
      return !alive || alive.has(str(g.entity_id));
    });
  }

  for (const t of names) out[t] = liveByTable[t].map((r) => stripColumns(t, r));
  return out;
}

/* ═══════════════════════ JSON ═══════════════════════ */

export interface ExportMeta {
  /** 資料庫的 schema 版本（migration 數）；讀不到就 null */
  schema: number | null;
  /** UTC ISO */
  exportedAt: string;
}

export interface ExportDoc {
  app: "next-stop";
  schema: number | null;
  exported_at: string;
  scope: ExportScope;
  tables: ExportTables;
}

export function buildExportDoc(scope: ExportScope, tables: ExportTables, meta: ExportMeta): ExportDoc {
  const ordered: ExportTables = {};
  for (const t of tablesOfScope(scope)) ordered[t] = tables[t] ?? [];
  return { app: "next-stop", schema: meta.schema, exported_at: meta.exportedAt, scope, tables: ordered };
}

/** 縮排兩格：這份檔主人會打開來看，可讀比小幾個 KB 重要 */
export function buildJson(scope: ExportScope, tables: ExportTables, meta: ExportMeta): string {
  return JSON.stringify(buildExportDoc(scope, tables, meta), null, 2);
}

/* ═══════════════════════ CSV ═══════════════════════ */

export type CsvCell = string | number | null | undefined;

/**
 * 一格 CSV（RFC 4180）：含 `"`、`,`、換行的包雙引號、`"` 寫成 `""`。
 * 試算表公式注入：**文字**開頭是 `= + - @`（以及 Tab、CR）時前面補一個 `'`，Excel 就不會當公式執行。
 * 數字（金額、分鐘…）不算文字：負數金額照原樣輸出，不加引號、不加 `'`。日期與時刻是 `2026-…` 開頭，不會碰到。
 */
export function csvEscape(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 一張表 → 文字（UTF-8 BOM 開頭讓 Excel 認得是 UTF-8；列與列之間 CRLF，結尾也有） */
export function csvText(rows: readonly (readonly CsvCell[])[]): string {
  return "﻿" + rows.map((r) => r.map(csvEscape).join(",") + "\r\n").join("");
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** UTC ISO → 本地時間「YYYY-MM-DD HH:mm」（試算表直接認得；讀不懂的原樣給） */
export function localStamp(iso: unknown): string {
  const s = str(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 最小單位 → 帶小數的數字（decimals＝幣別小數位） */
export function minorToNumber(minor: unknown, decimals: number): number | null {
  const n = num(minor);
  if (n === null) return null;
  return decimals > 0 ? Number((n / 10 ** decimals).toFixed(decimals)) : n;
}

export interface CsvContext {
  /** 日界線（時），算時間塊的「日期（日界線）」用 */
  dayStartHour: number;
  /**
   * 活著的節點（原始列，含 parent_id／kind／route_id）：把路線、上層、車票的 id 換成名稱用。
   * 不是每個範圍都匯出 nodes 這張表（筆記、時刻表、售票口只要名稱），所以另外給。
   */
  nodes: readonly ExportRow[];
}

interface Sheet {
  name: string;
  rows: CsvCell[][];
}

const STATUS_TEXT: Record<string, string> = { todo: "未開始", doing: "進行中", paused: "途中下車", done: "已完成" };
const PRIORITY_TEXT: Record<string, string> = { low: "低", mid: "中", high: "高" };
const ENTRY_KIND_TEXT: Record<string, string> = { expense: "支出", income: "收入", transfer: "轉帳", adjust: "校正" };
const CAT_KIND_TEXT: Record<string, string> = { expense: "支出", income: "收入" };
const GOAL_PERIOD_TEXT: Record<string, string> = {
  day: "每天",
  week: "每週",
  month: "每月",
  since: "從某天起",
  until: "到某天為止",
  range: "一段期間",
};
const GOAL_DIR_TEXT: Record<string, string> = { atLeast: "至少", atMost: "至多" };
const WEEKDAY_CHARS = ["一", "二", "三", "四", "五", "六", "日"];
const yesNo = (v: unknown): string => (v == null || v === "" ? "否" : "是");

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpPos = (a: ExportRow, b: ExportRow): number =>
  (num(a.position) ?? 0) - (num(b.position) ?? 0) || cmpStr(str(a.created_at), str(b.created_at)) || cmpStr(str(a.id), str(b.id));

/** 節點兄弟的順序：sort_key（有的話）→ position → 建立時間 */
const cmpSibling = (a: ExportRow, b: ExportRow): number => cmpStr(str(a.sort_key), str(b.sort_key)) || cmpPos(a, b);

/** 樹的深度優先順序：幹線在前（路線、支線、列車…跟在底下），根層臨時車票排後面 */
function nodeTreeOrder(nodes: readonly ExportRow[]): ExportRow[] {
  const ids = new Set(nodes.map((n) => str(n.id)));
  const kids = new Map<string, ExportRow[]>();
  const roots: ExportRow[] = [];
  for (const n of nodes) {
    const p = str(n.parent_id);
    if (p && ids.has(p)) {
      const list = kids.get(p);
      if (list) list.push(n);
      else kids.set(p, [n]);
    } else roots.push(n); // 孤兒（上層不在清單裡）也當根，不漏
  }
  roots.sort((a, b) => Number(a.kind !== "line") - Number(b.kind !== "line") || cmpSibling(a, b));
  const out: ExportRow[] = [];
  const seen = new Set<string>();
  const walk = (n: ExportRow, depth: number) => {
    const id = str(n.id);
    if (seen.has(id) || depth > 60) return;
    seen.add(id);
    out.push(n);
    for (const c of (kids.get(id) ?? []).sort(cmpSibling)) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * 兩層分類的顯示順序：頂層（依 topCmp）一個接一個，每個頂層後面跟著它的子分類（依 position）。
 * 上層不在清單裡的當頂層；萬一有第三層（理論上沒有）也補在最後，不漏。
 */
function twoLevelOrder(rows: readonly ExportRow[], topCmp: (a: ExportRow, b: ExportRow) => number = cmpPos): ExportRow[] {
  const ids = new Set(rows.map((r) => str(r.id)));
  const kids = new Map<string, ExportRow[]>();
  const tops: ExportRow[] = [];
  for (const r of rows) {
    const p = str(r.parent_id);
    if (p && ids.has(p)) {
      const list = kids.get(p);
      if (list) list.push(r);
      else kids.set(p, [r]);
    } else tops.push(r);
  }
  const out: ExportRow[] = [];
  for (const t of tops.sort(topCmp)) out.push(t, ...(kids.get(str(t.id)) ?? []).sort(cmpPos));
  const placed = new Set(out.map((r) => str(r.id)));
  for (const r of rows) if (!placed.has(str(r.id))) out.push(r);
  return out;
}

/** 從 `scope` JSON 抽出分類 id 清單（v1 `categories`、v2 `cats` 都認；讀不懂＝空） */
function goalCategoryIds(scopeJson: unknown): string[] {
  try {
    const o = JSON.parse(str(scopeJson)) as { categories?: unknown; cats?: unknown } | null;
    const list = o?.cats ?? o?.categories;
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

function routineText(itemsJson: unknown, catName: (id: string) => string): string {
  try {
    const o = JSON.parse(str(itemsJson)) as { items?: unknown } | null;
    if (!o || !Array.isArray(o.items)) return "";
    return o.items
      .map((it: { cat?: unknown; s?: unknown; e?: unknown; n?: unknown }) =>
        `${str(it.s)}–${str(it.e)} ${str(it.n) || catName(str(it.cat))}`.trim(),
      )
      .join("；");
  } catch {
    return "";
  }
}

function weekdaysText(bits: unknown): string {
  const b = num(bits) ?? 0;
  if (b === 0) return "不自動帶";
  return WEEKDAY_CHARS.filter((_, i) => b & (1 << i)).join("");
}

function repeatText(ruleJson: unknown): string {
  const r = parseRule(str(ruleJson));
  return r ? describeRule(r) : "";
}

/** 各範圍的 CSV 表。`tables` 是 `prepareExportTables` 的結果（沒帶的表當空） */
function sheetsOf(section: Exclude<ExportScope, "all">, tables: ExportTables, ctx: CsvContext): Sheet[] {
  const tb = (n: string): ExportRow[] => tables[n] ?? [];
  const nodeById = new Map(ctx.nodes.map((n) => [str(n.id), n]));
  const nodeName = (id: unknown): string => str(nodeById.get(str(id))?.name);
  const stationById = new Map(ctx.nodes.filter((n) => n.kind === "station").map((n) => [str(n.id), { parent_id: n.parent_id ? str(n.parent_id) : null }]));
  /** 同畫面的口徑：車站還在、而且跟票同一條路線才算（搬到別路線的票不印別條路線的站名）。route_id 在表裡清掉了（快取），從 ctx 的整列拿 */
  const stationOf = (n: ExportRow): string => {
    const full = nodeById.get(str(n.id)) ?? n;
    const station_id = full.station_id ? str(full.station_id) : null;
    return nodeName(effectiveStation({ station_id, route_id: full.route_id ? str(full.route_id) : null }, stationById));
  };

  // 荷札：「種類|id」→ 名稱們
  const tagName = new Map(tb("tags").map((t) => [str(t.id), str(t.name)]));
  const tagIndex = new Map<string, string[]>();
  for (const g of tb("taggings")) {
    const name = tagName.get(str(g.tag_id));
    if (!name) continue;
    const key = `${str(g.entity_type)}|${str(g.entity_id)}`;
    const list = tagIndex.get(key);
    if (list) list.push(name);
    else tagIndex.set(key, [name]);
  }
  const tagsOf = (type: string, id: unknown): string => (tagIndex.get(`${type}|${str(id)}`) ?? []).sort().join("、");

  /** 從某個節點往上爬，找所屬的路線與幹線；根層臨時車票的 route_id 是路線標籤 */
  const climb = (start: ExportRow | undefined): { line: string; route: string } => {
    let route = "";
    let line = "";
    const walk = (from: ExportRow | undefined) => {
      let cur = from;
      for (let i = 0; cur && i < 64; i++) {
        if (cur.kind === "route" && !route) route = str(cur.name);
        if (cur.kind === "line") {
          if (!line) line = str(cur.name);
          return;
        }
        cur = nodeById.get(str(cur.parent_id));
      }
    };
    walk(start);
    if (!route && start?.route_id) walk(nodeById.get(str(start.route_id)));
    return { line, route };
  };

  switch (section) {
    case "tasks": {
      const nodes = nodeTreeOrder(tb("nodes"));
      const withCtx = (n: ExportRow) => climb(nodeById.get(str(n.id)) ?? n);
      return [
        {
          name: "車票.csv",
          rows: [
            ["幹線", "路線", "上層", "車站", "種類", "名稱", "概要", "優先順序", "狀態", "乘車日", "幾點", "長度（分）", "締切日", "完成時刻", "重複", "荷札", "建立時刻"],
            ...nodes
              .filter((n) => n.kind !== "line" && n.kind !== "route")
              .map((n): CsvCell[] => {
                const a = withCtx(n);
                return [
                  a.line,
                  a.route,
                  nodeName(n.parent_id),
                  stationOf(n),
                  KIND_LABEL[n.kind as NodeKind] ?? str(n.kind),
                  str(n.name),
                  str(n.description),
                  PRIORITY_TEXT[str(n.priority)] ?? str(n.priority),
                  STATUS_TEXT[str(n.status)] ?? str(n.status),
                  str(n.scheduled_on),
                  str(n.scheduled_time),
                  num(n.estimate_min),
                  str(n.due_on),
                  localStamp(n.completed_at),
                  repeatText(n.repeat_rule),
                  tagsOf("node", n.id),
                  localStamp(n.created_at),
                ];
              }),
          ],
        },
        {
          name: "路線.csv",
          rows: [
            ["幹線", "路線", "代碼", "顏色", "到站日"],
            ...nodes
              .filter((n) => n.kind === "line" || n.kind === "route")
              .map((n): CsvCell[] => [
                n.kind === "line" ? str(n.name) : withCtx(n).line,
                n.kind === "route" ? str(n.name) : "",
                str(n.code),
                str(n.color),
                str(n.arrived_on),
              ]),
          ],
        },
        {
          name: "乘務記錄.csv",
          rows: [
            ["車票", "時刻", "內容"],
            ...[...tb("work_logs")]
              .sort((a, b) => cmpStr(str(a.logged_at), str(b.logged_at)) || cmpStr(str(a.id), str(b.id)))
              .map((w): CsvCell[] => [
                nodeName(w.node_id),
                localStamp(w.logged_at),
                str(w.body) || WORK_LOG_EVENT_LABEL[str(w.event) as WorkLogEvent] || "",
              ]),
          ],
        },
        {
          name: "方針.csv",
          rows: [
            ["期間", "內容", "路線", "済"],
            ...[...tb("week_aims")]
              .sort((a, b) => cmpStr(str(a.week_on), str(b.week_on)) || cmpPos(a, b))
              .map((w): CsvCell[] => {
                const key = str(w.week_on);
                const sid = stationIdOfKey(key);
                // 週留日期（好排序、好對照）；月、年、站寫人看得懂的字，不露期間鍵
                return [periodOfKey(key) === "week" ? key : periodLabel(key, sid ? nodeName(sid) : null), str(w.text), nodeName(w.node_id), yesNo(w.done_at)];
              }),
          ],
        },
      ];
    }

    case "notes": {
      const notes = tb("notes");
      return [
        {
          name: "筆記.csv",
          rows: [
            ["建立時刻", "標題", "內容", "荷札", "掛在"],
            ...notes
              .filter((n) => n.kind !== "diary")
              .sort((a, b) => cmpStr(str(a.noted_at), str(b.noted_at)) || cmpStr(str(a.id), str(b.id)))
              .map((n): CsvCell[] => [localStamp(n.noted_at), str(n.title), str(n.body), tagsOf("note", n.id), nodeName(n.node_id)]),
          ],
        },
        {
          name: "日記.csv",
          rows: [
            ["日期", "標題", "內容", "荷札"],
            ...notes
              .filter((n) => n.kind === "diary")
              .sort((a, b) => cmpStr(str(a.entry_date), str(b.entry_date)) || cmpStr(str(a.noted_at), str(b.noted_at)))
              .map((n): CsvCell[] => [str(n.entry_date), str(n.title), str(n.body), tagsOf("note", n.id)]),
          ],
        },
      ];
    }

    case "timetable": {
      const cats = new Map(tb("time_categories").map((c) => [str(c.id), c]));
      const catName = (id: unknown): string => str(cats.get(str(id))?.name);
      const parentOf = (id: unknown): ExportRow | undefined => cats.get(str(cats.get(str(id))?.parent_id));
      return [
        {
          name: "時間塊.csv",
          rows: [
            ["日期（日界線）", "開始", "結束", "分鐘", "分類", "組", "車票／路線", "荷札", "備註"],
            ...[...tb("time_blocks")]
              .sort((a, b) => cmpStr(str(a.started_at), str(b.started_at)) || cmpStr(str(a.id), str(b.id)))
              .map((b): CsvCell[] => {
                const start = str(b.started_at);
                const end = str(b.ended_at);
                const mins = end ? Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000) : null;
                const parent = parentOf(b.category_id);
                // 掛在車票上顯示車票名；只連路線時顯示路線名
                const link = b.node_id ? nodeName(b.node_id) : nodeName(b.route_id);
                return [
                  dayKeyOf(start, ctx.dayStartHour),
                  localStamp(start),
                  end ? localStamp(end) : "進行中",
                  mins !== null && Number.isFinite(mins) ? mins : null,
                  // 塊的分類（可能是子分類，也可能直接記在頂層組上）＋它的上層組
                  catName(b.category_id),
                  parent ? str(parent.name) : "",
                  link,
                  tagsOf("timetable:block", b.id),
                  str(b.note),
                ];
              }),
          ],
        },
        {
          name: "分類.csv",
          rows: [
            ["組", "分類", "顏色", "預設長度（分）", "已封存"],
            ...twoLevelOrder(tb("time_categories")).map((c): CsvCell[] => {
                const parent = parentOf(c.id);
                // 頂層是「組」：組欄放自己、分類欄空；子分類：組欄放上層、分類欄放自己
                return [parent ? str(parent.name) : str(c.name), parent ? str(c.name) : "", num(c.color_idx), num(c.default_min), yesNo(c.archived_at)];
            }),
          ],
        },
        {
          name: "目標.csv",
          rows: [
            ["名稱", "範圍", "週期", "目標（分）", "方向", "起", "迄", "荷札", "已封存"],
            ...[...tb("time_goals")].sort(cmpPos).map((g): CsvCell[] => [
              str(g.name),
              goalCategoryIds(g.scope).map(catName).filter(Boolean).join("、"),
              GOAL_PERIOD_TEXT[str(g.period)] ?? str(g.period),
              num(g.target_min),
              GOAL_DIR_TEXT[str(g.direction)] ?? str(g.direction),
              str(g.start_on),
              str(g.end_on),
              tagsOf("timetable:goal", g.id),
              yesNo(g.archived_at),
            ]),
          ],
        },
        {
          name: "作息範本.csv",
          rows: [
            ["名稱", "自動帶的星期", "內容", "已封存"],
            ...[...tb("time_routines")].sort(cmpPos).map((r): CsvCell[] => [
              str(r.name),
              weekdaysText(r.weekdays),
              routineText(r.items, catName),
              yesNo(r.archived_at),
            ]),
          ],
        },
      ];
    }

    case "ticket": {
      const currencies = tb("tk_currencies");
      const decimalsOf = new Map(currencies.map((c) => [str(c.code), num(c.decimals) ?? 2]));
      const mainDecimals = num(currencies.find((c) => c.is_main === 1 || c.is_main === "1")?.decimals) ?? 2;
      const decOf = (code: unknown): number => decimalsOf.get(str(code)) ?? 2;
      const accs = new Map(tb("tk_accounts").map((a) => [str(a.id), a]));
      const cats = new Map(tb("tk_categories").map((c) => [str(c.id), c]));
      const kinds = new Map(tb("wr_kinds").map((k) => [str(k.id), k]));
      const accName = (id: unknown): string => str(accs.get(str(id))?.name);
      const catName = (id: unknown): string => str(cats.get(str(id))?.name);
      const kindName = (id: unknown): string => str(kinds.get(str(id))?.name);
      const catParent = (id: unknown): string => catName(cats.get(str(id))?.parent_id);
      const groupLabel = (key: unknown): string => ACCOUNT_GROUPS.find((g) => g.key === key)?.label ?? str(key);
      const groupIdx = (key: unknown): number => {
        const i = ACCOUNT_GROUPS.findIndex((g) => g.key === key);
        return i >= 0 ? i : ACCOUNT_GROUPS.length;
      };
      const route = (r: ExportRow): string => nodeName(r.route_id);

      return [
        {
          name: "帳目.csv",
          rows: [
            ["日期", "類型", "金額", "幣別", "帳戶", "轉入帳戶", "轉入金額", "分類", "上層分類", "備註", "荷札", "路線"],
            ...[...tb("tk_entries")]
              .sort((a, b) => cmpStr(str(a.occurred_on), str(b.occurred_on)) || cmpStr(str(a.occurred_at), str(b.occurred_at)) || cmpStr(str(a.id), str(b.id)))
              .map((e): CsvCell[] => [
                str(e.occurred_on),
                ENTRY_KIND_TEXT[str(e.kind)] ?? str(e.kind),
                minorToNumber(e.amount_minor, decOf(e.currency)),
                str(e.currency),
                accName(e.account_id),
                accName(e.to_account_id),
                // 跨幣別轉帳才有：用轉入帳戶的幣別算小數位
                minorToNumber(e.to_amount_minor, decOf(accs.get(str(e.to_account_id))?.currency)),
                catName(e.category_id),
                catParent(e.category_id),
                str(e.note),
                tagsOf("ticket:entry", e.id),
                route(e),
              ]),
          ],
        },
        {
          name: "帳戶.csv",
          rows: [
            ["名稱", "群組", "幣別", "已封存"],
            ...[...tb("tk_accounts")]
              .sort((a, b) => groupIdx(a.group_key) - groupIdx(b.group_key) || cmpPos(a, b))
              .map((a): CsvCell[] => [str(a.name), groupLabel(a.group_key), str(a.currency), yesNo(a.archived_at)]),
          ],
        },
        {
          name: "分類.csv",
          rows: [
            ["種類", "分類", "上層分類", "已封存"],
            ...twoLevelOrder(tb("tk_categories"), (a, b) => cmpStr(str(a.kind), str(b.kind)) || cmpPos(a, b)).map((c): CsvCell[] => [CAT_KIND_TEXT[str(c.kind)] ?? str(c.kind), str(c.name), catName(c.parent_id), yesNo(c.archived_at)]),
          ],
        },
        {
          name: "定期帳.csv",
          rows: [
            ["類型", "金額", "幣別", "帳戶", "轉入帳戶", "分類", "上層分類", "備註", "重複", "時刻", "下一班", "已暫停", "路線"],
            ...[...tb("tk_repeats")].sort(cmpPos).map((r): CsvCell[] => [
              ENTRY_KIND_TEXT[str(r.kind)] ?? str(r.kind),
              minorToNumber(r.amount_minor, decOf(r.currency)),
              str(r.currency),
              accName(r.account_id),
              accName(r.to_account_id),
              catName(r.category_id),
              catParent(r.category_id),
              str(r.note),
              repeatText(r.rule),
              str(r.hhmm),
              str(r.next_on),
              yesNo(r.paused_at),
              route(r),
            ]),
          ],
        },
        {
          name: "預算.csv",
          rows: [
            ["種類", "分類", "上層分類", "月份", "金額"],
            ...[...tb("tk_budgets")]
              .sort((a, b) => cmpStr(str(a.kind), str(b.kind)) || cmpStr(str(a.month), str(b.month)) || cmpPos(a, b))
              .map((b): CsvCell[] => [
                b.kind === "total" ? "總預算" : "分類預算",
                catName(b.category_id),
                catParent(b.category_id),
                b.month ? str(b.month) : "每月預設",
                minorToNumber(b.amount_minor, mainDecimals),
              ]),
          ],
        },
        {
          name: "願望.csv",
          rows: [
            ["名稱", "種類", "預估金額", "分類", "備註", "實現時刻"],
            ...[...tb("tk_wishes")].sort(cmpPos).map((w): CsvCell[] => [
              str(w.name),
              kindName(w.kind_id),
              minorToNumber(w.amount_minor, mainDecimals),
              catName(w.category_id),
              str(w.note),
              localStamp(w.bought_at),
            ]),
          ],
        },
        {
          name: "候車室種類.csv",
          rows: [
            ["番線", "名稱", "實現動作"],
            ...[...tb("wr_kinds")].sort(cmpPos).map((k, i): CsvCell[] => [i + 1, str(k.name), WISH_ACTION_LABEL[k.action as WishAction] ?? str(k.action)]),
          ],
        },
        {
          name: "常用票種.csv",
          rows: [
            ["名稱", "類型", "金額", "幣別", "帳戶", "轉入帳戶", "分類", "上層分類", "備註", "路線"],
            ...[...tb("tk_templates")].sort(cmpPos).map((t): CsvCell[] => {
              // 沒指定幣別就跟著帳戶；帳戶也沒指定就用主幣別
              const cur = str(t.currency) || str(accs.get(str(t.account_id))?.currency);
              return [
                str(t.name),
                ENTRY_KIND_TEXT[str(t.kind)] ?? str(t.kind),
                minorToNumber(t.amount_minor, cur ? decOf(cur) : mainDecimals),
                cur,
                accName(t.account_id),
                accName(t.to_account_id),
                catName(t.category_id),
                catParent(t.category_id),
                str(t.note),
                route(t),
              ];
            }),
          ],
        },
      ];
    }
  }
}

const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * 該範圍的 CSV 檔們（可直接交給 `buildStoreZip`）。單一範圍的檔放根目錄；「整份」放進 `任務/`、`筆記/`、`時刻表/`、`售票口/`。
 * 空的表也會有檔（只有欄名那一列），打開時看得出「這類資料是空的」而不是「漏了」。
 */
export function buildCsvFiles(scope: ExportScope, tables: ExportTables, ctx: CsvContext): ZipFile[] {
  const sections = EXPORT_SCOPES.filter((s) => s.id !== "all" && (scope === "all" || s.id === scope));
  const files: ZipFile[] = [];
  for (const s of sections) {
    for (const sheet of sheetsOf(s.id as Exclude<ExportScope, "all">, tables, ctx)) {
      files.push({ path: scope === "all" ? `${s.folder}/${sheet.name}` : sheet.name, bytes: textBytes(csvText(sheet.rows)) });
    }
  }
  return files;
}

/* ═══════════════════════ 裝箱與檔名 ═══════════════════════ */

export interface ExportInput {
  /** 資料庫讀出的原始列（`readExportRows`；還沒清理） */
  tables: ExportTables;
  /** 活著的節點原始列（CSV 換名稱用；任務範圍就是 tables.nodes） */
  nodes: ExportRow[];
  dayStartHour: number;
}

export interface ExportPayload {
  bytes: Uint8Array;
  /** zip 裡有幾個檔；JSON 為 1 */
  fileCount: number;
  /** 各表匯出幾列（清理後） */
  counts: Record<string, number>;
}

/** 組出要寫進檔案的位元組：JSON 是一個檔、CSV 是一個 zip */
export function buildExportPayload(scope: ExportScope, format: ExportFormat, input: ExportInput, meta: ExportMeta): ExportPayload {
  const tables = prepareExportTables(scope, input.tables);
  const counts: Record<string, number> = {};
  for (const [t, rows] of Object.entries(tables)) counts[t] = rows.length;
  if (format === "json") return { bytes: textBytes(buildJson(scope, tables, meta)), fileCount: 1, counts };
  const files = buildCsvFiles(scope, tables, { dayStartHour: input.dayStartHour, nodes: input.nodes });
  return { bytes: buildStoreZip(files, { date: new Date(meta.exportedAt) }), fileCount: files.length, counts };
}

/** 預設檔名：`私鐵手帳-<範圍>-<YYYYMMDD>.json｜zip`（日期是本地日） */
export function exportFileName(scope: ExportScope, format: ExportFormat, now: Date = new Date()): string {
  const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  return `私鐵手帳-${scopeInfo(scope).label}-${ymd}.${format === "json" ? "json" : "zip"}`;
}

/** 位元組 → base64（標準字母、有補 =）；分塊轉字串，大檔不會爆呼叫堆疊 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
