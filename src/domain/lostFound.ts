/**
 * 失物招領的純函式（第五本第二梯 ⑦；契約 `docs/research/2026-11-04-主線-失物招領-契約.md` §2、§3）。
 *
 * 兩個入口共用這一份：「最近刪除」（窗內的 tombstone）與「從雲端快照撿回」（快照活著、現在不在或已刪）。
 *   - `LOST_KINDS`：全部種類的唯一登記表（表名、分類、顯示、帶誰一起回來、外鍵依賴）。
 *   - `groupDeleted`：一刀一列（同一次刪除＝同一個 deleted_at）。
 *   - `placementFor`／`planNodeRestore`：上層也不在時放哪裡（D-主-314）。
 *   - `snapshotDiff`：快照與現況的差異（不在或已刪；筆記、日記、車票另算「內容不同」，§3.5）。
 *   - `planRescue`：快照撿回要寫哪些列、op 長怎樣；repository 只負責把它落成 SQL。
 *   - `mergeSnapshotDiff`：重算差異時保留「已撿回」「已改回」的打勾。
 *
 * 快照撿回的核心規則（對抗審查 2026-11-05 問題 1、8，契約 §3.3）：本機已有 tombstone 的列，**tombstone 就是最新版**——
 * 照本機內容復活、整列 op，不拿快照內容蓋（蓋了就丟掉快照之後的編輯，而且會同步到另一台）。只有本機根本沒有這一列才用快照列。
 * 使用者真要舊內容：復活後它會出現在「內容不同」，走改回（筆記、日記、車票）。
 *
 * 零副作用、不 import Tauri／React；node 測試直接載入，值 import 一律帶 `.ts`。
 */
import { KIND_LABEL, allowedChildKinds, type NodeKind } from "./node.ts";
import { moneyText } from "./ticket.ts";
import { periodLabel, stationIdOfKey } from "./weekAims.ts";

/** 「最近刪除」顯示幾天內的東西。窗口只是顯示範圍，不刪任何東西（tombstone 同步要用，品味 3） */
export const LOST_FOUND_DAYS = 30;

const DAY_MS = 86_400_000;

export type LostCategory = "tasks" | "notes" | "timetable" | "ticket";
export const LOST_CATEGORY_LABEL: Record<LostCategory, string> = { tasks: "任務", notes: "筆記", timetable: "時刻表", ticket: "售票口" };

export type LostKindKey =
  | NodeKind
  | "week_aim"
  | "note"
  | "diary"
  | "tag"
  | "time_block"
  | "time_goal"
  | "time_routine"
  | "tk_entry"
  | "tk_repeat"
  | "tk_wish"
  | "tk_template"
  | "tk_budget";

/** 一列資料（資料庫或快照 JSON 來的；欄位依表而異） */
export type LostRow = { id: string; deleted_at?: string | null; [col: string]: unknown };
/** 表名 → 列 */
export type LostTables = Partial<Record<string, readonly LostRow[]>>;
/** 「現在」：毫秒或 ISO 字串 */
export type LostNow = number | string;

/** 查名字用（路線名、分類名、幣別小數位）；`namesFromTables` 從資料列組出來 */
export interface LostNames {
  nodes: Record<string, { name: string; kind: string; parent_id: string | null }>;
  timeCategories: Record<string, string>;
  tkCategories: Record<string, string>;
  decimals: Record<string, number>;
  mainCode: string | null;
  mainDecimals: number;
}

/** 外鍵（或幣別代碼）依賴：現在沒有這一列就從快照一起帶回 */
export interface LostDep {
  col: string;
  table: string;
  /** 用哪一欄對（幣別用 code，不是主鍵）；省略＝id */
  by?: "code";
}

/** 跟著一起回來的子表列 */
export interface LostChildTable {
  table: string;
  col: string;
  /** false＝不帶（競合日誌是各台自己記的，永不進同步） */
  keep?: (row: LostRow) => boolean;
}

export interface LostKindDef {
  key: LostKindKey;
  table: string;
  category: LostCategory;
  label: string;
  title(row: LostRow, names: LostNames): string;
  detail(row: LostRow, names: LostNames): string | null;
  /** 掛在這一列上的 taggings 種類（entity_type） */
  tagTypes: readonly string[];
  /** 撿回時一起帶的子表 */
  children: readonly LostChildTable[];
  /** 撿回前要先在的列 */
  requires: readonly LostDep[];
}

/** 清單一列（一刀） */
export interface LostItem {
  key: string;
  kind: LostKindKey;
  table: string;
  category: LostCategory;
  kindLabel: string;
  /** 這一刀的代表列 */
  id: string;
  /** 這一刀全部的列（節點＝子樹裡同刀的；荷札＝含子荷札；預算＝預設列＋月覆寫） */
  ids: string[];
  title: string;
  detail: string | null;
  deletedAt: string;
  childCount: number;
}

/** 快照差異裡「不在或已刪」的一列（平鋪；`ids`＝這一筆撿回會帶回來的同種列） */
export interface SnapshotItem extends Omit<LostItem, "deletedAt"> {
  /** 現在已刪的時間；null＝這台根本沒有這一列 */
  deletedAt: string | null;
  status: "gone" | "deleted";
}

/** 內容不同的一欄（兩邊的值，並排顯示用） */
export interface ChangedField {
  col: string;
  label: string;
  snapshot: string | null;
  current: string | null;
}

/** 快照與現在都活著、比對欄不同的一筆（只有筆記、日記、車票，§3.5） */
export interface ChangedItem {
  key: string;
  kind: "note" | "diary" | "ticket";
  table: "notes" | "nodes";
  category: LostCategory;
  kindLabel: string;
  id: string;
  title: string;
  detail: string | null;
  /** 只放真的不同的欄 */
  fields: ChangedField[];
}

export interface SnapshotDiff {
  missing: SnapshotItem[];
  changed: ChangedItem[];
}

/** Rust `sync_cloud_snapshot_read` 的回傳 */
export interface CloudSnapshot {
  exported_at: string;
  schema: number;
  tables: Record<string, LostRow[]>;
  /** 表名 → 同步欄（Rust 登記表；TS 不再抄一份） */
  columns: Record<string, string[]>;
}

/* ───────── 小工具 ───────── */

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const nullable = (v: unknown): string | null => (typeof v === "string" ? v : null);
const pad2 = (n: number): string => String(n).padStart(2, "0");
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD → M/D（不經 Date：本地日期字串不是時刻） */
function ymdShort(day: unknown): string | null {
  const m = typeof day === "string" ? YMD_RE.exec(day) : null;
  return m ? `${Number(m[2])}/${Number(m[3])}` : null;
}
function isoShort(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getMonth() + 1}/${d.getDate()}`;
}
function isoHm(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function pushTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
const toMs = (now: LostNow): number => (typeof now === "number" ? now : Date.parse(now));

/** 窗口下緣（毫秒） */
export function lostWindowFloor(now: LostNow): number {
  return toMs(now) - LOST_FOUND_DAYS * DAY_MS;
}

export const EMPTY_LOST_NAMES: LostNames = { nodes: {}, timeCategories: {}, tkCategories: {}, decimals: {}, mainCode: null, mainDecimals: 2 };

/** 從資料列組名字表：真機讀窄欄、快照用它自己那幾張表，走同一支 */
export function namesFromTables(tables: LostTables): LostNames {
  const out: LostNames = { nodes: {}, timeCategories: {}, tkCategories: {}, decimals: {}, mainCode: null, mainDecimals: 2 };
  for (const n of tables.nodes ?? []) {
    out.nodes[n.id] = { name: text(n.name) ?? "", kind: text(n.kind) ?? "", parent_id: text(n.parent_id) };
  }
  for (const c of tables.time_categories ?? []) out.timeCategories[c.id] = text(c.name) ?? "";
  for (const c of tables.tk_categories ?? []) out.tkCategories[c.id] = text(c.name) ?? "";
  for (const c of tables.tk_currencies ?? []) {
    const code = text(c.code);
    if (!code) continue;
    const dec = typeof c.decimals === "number" ? c.decimals : 2;
    out.decimals[code] = dec;
    if (c.is_main) {
      out.mainCode = code;
      out.mainDecimals = dec;
    }
  }
  return out;
}

function amountText(minor: unknown, code: unknown, names: LostNames): string | null {
  if (typeof minor !== "number") return null;
  const cur = text(code);
  if (!cur || cur === names.mainCode) return moneyText(minor, cur ? (names.decimals[cur] ?? names.mainDecimals) : names.mainDecimals);
  return `${moneyText(minor, names.decimals[cur] ?? 2)} ${cur}`;
}
const joinParts = (...parts: (string | null | undefined)[]): string | null => parts.filter(Boolean).join("・") || null;

/** 筆記的標題：有標題用標題；沒有就取內文前兩行（§2.5） */
function noteTitle(r: LostRow, empty: string): string {
  const t = text(r.title);
  if (t) return t;
  const lines = (nullable(r.body) ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return lines.slice(0, 2).join(" ").slice(0, 80) || empty;
}

function nodeDetail(r: LostRow, names: LostNames): string | null {
  const nameOf = (id: unknown) => (typeof id === "string" ? (names.nodes[id]?.name ?? null) : null);
  if (!r.parent_id && r.kind === "ticket") return nameOf(r.route_id) ?? "臨時車票";
  if (r.kind === "route" || r.kind === "line") return nameOf(r.parent_id);
  return nameOf(r.route_id) ?? nameOf(r.parent_id);
}

/** 方針的 week_on 是期間鍵（週＝日期，月 `M2026-11`、年 `Y2026`、站 `S<車站id>`），字走 `periodLabel` */
export function aimPeriodText(weekOn: unknown, names?: Pick<LostNames, "nodes">): string | null {
  const s = text(weekOn);
  if (!s) return null;
  const sid = stationIdOfKey(s);
  return periodLabel(s, sid ? names?.nodes[sid]?.name : null);
}

function budgetTitle(r: LostRow, names: LostNames): string {
  if (r.kind === "total") return "總預算";
  const name = typeof r.category_id === "string" ? names.tkCategories[r.category_id] : undefined;
  return name ? `「${name}」的預算` : "分類預算";
}
function budgetDetail(r: LostRow, names: LostNames): string | null {
  return joinParts(text(r.month) ?? "每月", amountText(r.amount_minor, null, names));
}

const ENTRY_KIND_LABEL: Record<string, string> = { income: "收入", expense: "支出", transfer: "轉帳", adjust: "調整" };
function entryTitle(r: LostRow, names: LostNames): string {
  const cat = typeof r.category_id === "string" ? names.tkCategories[r.category_id] : undefined;
  return text(r.note) ?? (cat || ENTRY_KIND_LABEL[String(r.kind)] || "一筆帳");
}

const NODE_CHILDREN: readonly LostChildTable[] = [
  { table: "work_logs", col: "node_id", keep: (r) => r.event !== "conflict" },
  { table: "occurrences", col: "node_id" },
  { table: "node_time_overrides", col: "node_id" },
];

const DEP_ACCOUNT: LostDep = { col: "account_id", table: "tk_accounts" };
const DEP_TO_ACCOUNT: LostDep = { col: "to_account_id", table: "tk_accounts" };
const DEP_TK_CATEGORY: LostDep = { col: "category_id", table: "tk_categories" };
const DEP_CURRENCY: LostDep = { col: "currency", table: "tk_currencies", by: "code" };

function nodeKindDef(key: NodeKind): LostKindDef {
  return {
    key,
    table: "nodes",
    category: "tasks",
    label: KIND_LABEL[key],
    title: (r) => text(r.name) ?? "（沒有名字）",
    detail: nodeDetail,
    tagTypes: ["node"],
    children: NODE_CHILDREN,
    requires: [],
  };
}

/**
 * 全部種類（§2.1 盤點的全集）。最近刪除與快照撿回共用這一份，要加種類只改這裡。
 * 不列（理由見契約）：taggings、occurrences、node_time_overrides、time_plans、stamps、work_logs；帳戶、分類、幣別只有封存。
 */
export const LOST_KINDS: readonly LostKindDef[] = [
  nodeKindDef("line"),
  nodeKindDef("route"),
  nodeKindDef("branch"),
  nodeKindDef("train"),
  nodeKindDef("car"),
  nodeKindDef("ticket"),
  nodeKindDef("station"),
  {
    key: "week_aim",
    table: "week_aims",
    category: "tasks",
    label: "方針",
    title: (r) => text(r.text) ?? "（空白方針）",
    detail: (r, names) => aimPeriodText(r.week_on, names),
    tagTypes: [],
    children: [],
    requires: [],
  },
  {
    key: "note",
    table: "notes",
    category: "notes",
    label: "筆記",
    title: (r) => noteTitle(r, "（空白筆記）"),
    detail: (r, names) => (typeof r.node_id === "string" ? (names.nodes[r.node_id]?.name ?? null) : null),
    tagTypes: ["note"],
    children: [],
    requires: [],
  },
  {
    key: "diary",
    table: "notes",
    category: "notes",
    label: "日記",
    title: (r) => noteTitle(r, "（空白日記）"),
    detail: (r) => ymdShort(r.entry_date),
    tagTypes: ["note"],
    children: [],
    requires: [],
  },
  {
    key: "tag",
    table: "tags",
    category: "notes",
    label: "荷札",
    title: (r) => `#${text(r.name) ?? ""}`,
    detail: () => null,
    tagTypes: [],
    children: [],
    requires: [],
  },
  {
    key: "time_block",
    table: "time_blocks",
    category: "timetable",
    label: "時間塊",
    title: (r, names) => (typeof r.category_id === "string" ? names.timeCategories[r.category_id] : "") || "時間塊",
    detail: (r) => {
      const end = isoHm(r.ended_at);
      return joinParts(isoShort(r.started_at), `${isoHm(r.started_at) ?? ""}${end ? `–${end}` : ""}`);
    },
    tagTypes: ["timetable:block", "timetable:block-off"],
    children: [],
    requires: [{ col: "category_id", table: "time_categories" }],
  },
  {
    key: "time_goal",
    table: "time_goals",
    category: "timetable",
    label: "時間目標",
    title: (r) => text(r.name) ?? "（沒有名字）",
    detail: () => null,
    tagTypes: ["timetable:goal"],
    children: [],
    requires: [],
  },
  {
    key: "time_routine",
    table: "time_routines",
    category: "timetable",
    label: "作息範本",
    title: (r) => text(r.name) ?? "（沒有名字）",
    detail: () => null,
    tagTypes: [],
    children: [],
    requires: [],
  },
  {
    key: "tk_entry",
    table: "tk_entries",
    category: "ticket",
    label: "帳目",
    title: entryTitle,
    detail: (r, names) => joinParts(ymdShort(r.occurred_on), amountText(r.amount_minor, r.currency, names)),
    tagTypes: ["ticket:entry"],
    children: [],
    requires: [DEP_ACCOUNT, DEP_TO_ACCOUNT, DEP_TK_CATEGORY, DEP_CURRENCY],
  },
  {
    key: "tk_repeat",
    table: "tk_repeats",
    category: "ticket",
    label: "定期帳",
    title: entryTitle,
    detail: (r, names) => amountText(r.amount_minor, r.currency, names),
    tagTypes: ["ticket:repeat"],
    children: [],
    requires: [DEP_ACCOUNT, DEP_TO_ACCOUNT, DEP_TK_CATEGORY, DEP_CURRENCY],
  },
  {
    key: "tk_wish",
    table: "tk_wishes",
    category: "ticket",
    label: "願望",
    title: (r) => text(r.name) ?? "（沒有名字）",
    detail: (r, names) => amountText(r.amount_minor, null, names),
    tagTypes: ["ticket:wish"],
    children: [],
    requires: [DEP_TK_CATEGORY],
  },
  {
    key: "tk_template",
    table: "tk_templates",
    category: "ticket",
    label: "常用票種",
    title: (r) => text(r.name) ?? "（沒有名字）",
    detail: (r, names) => amountText(r.amount_minor, r.currency, names),
    tagTypes: ["ticket:template"],
    children: [],
    requires: [DEP_ACCOUNT, DEP_TO_ACCOUNT, DEP_TK_CATEGORY, DEP_CURRENCY],
  },
  {
    key: "tk_budget",
    table: "tk_budgets",
    category: "ticket",
    label: "預算",
    title: budgetTitle,
    detail: budgetDetail,
    tagTypes: [],
    children: [],
    requires: [DEP_TK_CATEGORY],
  },
];

/** 清單裡有的表（去重、照登記順序） */
export const LOST_TABLES: readonly string[] = Array.from(new Set(LOST_KINDS.map((k) => k.table)));

/** 只會被當依賴帶回來的表（不進清單）自己的依賴 */
const DEP_ONLY: Record<string, { requires: readonly LostDep[]; tagTypes: readonly string[] }> = {
  time_categories: { requires: [{ col: "parent_id", table: "time_categories" }], tagTypes: ["timetable:category"] },
  tk_categories: { requires: [{ col: "parent_id", table: "tk_categories" }], tagTypes: [] },
  tk_accounts: { requires: [DEP_CURRENCY], tagTypes: [] },
  tk_currencies: { requires: [], tagTypes: [] },
};

/** 這一列屬於哪個種類；不認得（比 App 新的 kind）回 null，不列 */
export function lostKindOf(table: string, row: LostRow): LostKindDef | null {
  const hits = LOST_KINDS.filter((k) => k.table === table);
  if (table === "nodes" || table === "notes") return hits.find((k) => k.key === row.kind) ?? null;
  return hits[0] ?? null;
}

function lostItem(def: LostKindDef, row: LostRow, names: LostNames, ids: string[], deletedAt: string): LostItem {
  return {
    key: `${def.table}:${row.id}`,
    kind: def.key,
    table: def.table,
    category: def.category,
    kindLabel: def.label,
    id: row.id,
    ids,
    title: def.title(row, names),
    detail: def.detail(row, names),
    deletedAt,
    childCount: ids.length - 1,
  };
}

/* ───────── 一刀一列（§2.2） ───────── */

/** 這一列往下、只走同一個 deleted_at 的節點（含自己，父先子後） */
function cutIds(root: LostRow, kids: ReadonlyMap<string, readonly LostRow[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: LostRow) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n.id);
    for (const k of kids.get(n.id) ?? []) if (k.deleted_at === root.deleted_at) walk(k);
  };
  walk(root);
  return out;
}

function childrenIndex(rows: readonly LostRow[]): Map<string, LostRow[]> {
  const kids = new Map<string, LostRow[]>();
  for (const r of rows) if (typeof r.parent_id === "string") pushTo(kids, r.parent_id, r);
  return kids;
}

/**
 * 把各表窗內的 tombstone 組成清單（新到舊）。窗外的不列；荷札 `renamed_to` 不是 null＝改名或併入，不是刪除，不列。
 * `rows` 給多了也沒關係（窗口在這裡再篩一次），mock 與真機走同一條。
 */
export function groupDeleted(rows: LostTables, now: LostNow, names: LostNames = EMPTY_LOST_NAMES): LostItem[] {
  const floor = lostWindowFloor(now);
  const inWindow = (table: string): LostRow[] =>
    (rows[table] ?? []).filter((r) => typeof r.deleted_at === "string" && Date.parse(r.deleted_at) >= floor);
  const items: LostItem[] = [];

  for (const table of LOST_TABLES) {
    const list = inWindow(table);
    if (table === "nodes") {
      const byId = new Map(list.map((r) => [r.id, r] as const));
      const kids = childrenIndex(list);
      for (const r of list) {
        const parent = typeof r.parent_id === "string" ? byId.get(r.parent_id) : undefined;
        // 父不在窗內的 tombstone 裡（活著、不存在、或更早就刪了）或刪除時刻不同：它自己是一刀的頭
        if (parent && parent.deleted_at === r.deleted_at) continue;
        const def = lostKindOf(table, r);
        if (def) items.push(lostItem(def, r, names, cutIds(r, kids), r.deleted_at as string));
      }
    } else if (table === "tags") {
      // 不修（對抗審查問題 15）：兩台同一毫秒各刪一枚才會併成一列，代價只是一起撿回
      const groups = new Map<string, LostRow[]>();
      for (const r of list) if (!r.renamed_to) pushTo(groups, r.deleted_at as string, r);
      const def = lostKindOf(table, { id: "" });
      for (const [at, g] of groups) {
        const sorted = [...g].sort((a, b) => keyLen(a) - keyLen(b) || (String(a.name_key) < String(b.name_key) ? -1 : 1));
        if (def) items.push(lostItem(def, sorted[0], names, sorted.map((r) => r.id), at));
      }
    } else if (table === "tk_budgets") {
      // removeBudget 一次只動一個對象；對象也放進分組鍵，免得兩個對象剛好同一毫秒被併成一列
      const groups = new Map<string, LostRow[]>();
      for (const r of list) pushTo(groups, `${r.deleted_at as string}|${String(r.kind)}|${String(r.category_id ?? "")}`, r);
      const def = lostKindOf(table, { id: "" });
      for (const g of groups.values()) {
        // 預設列（month NULL）當代表；只刪了月覆寫就用最早那個月
        const sorted = [...g].sort((a, b) => String(a.month ?? "").localeCompare(String(b.month ?? "")));
        if (def) items.push(lostItem(def, sorted[0], names, sorted.map((r) => r.id), sorted[0].deleted_at as string));
      }
    } else {
      for (const r of list) {
        const def = lostKindOf(table, r);
        if (def) items.push(lostItem(def, r, names, [r.id], r.deleted_at as string));
      }
    }
  }
  return items.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
}

const keyLen = (r: LostRow): number => String(r.name_key ?? "").length;

/* ───────── 上層也被刪了（§2.3，D-主-314） ───────── */

/** 判斷放哪裡要用到的節點欄 */
export type PlaceNode = Pick<LostRow, "id" | "deleted_at"> & {
  kind?: unknown;
  name?: unknown;
  parent_id?: unknown;
  line_id?: unknown;
  route_id?: unknown;
};

export interface LostParentInfo {
  id: string;
  name: string;
  kind: string | null;
}

export type Placement =
  | { type: "inPlace" }
  /** 放到臨時車票：parent_id 清掉；routeId＝原路線活著就掛路線標籤 */
  | { type: "loose"; routeId: string | null }
  /** 列車、車廂等沒有「無上層」的存法：問要不要連同上層一起撿回 */
  | { type: "needsParent"; parent: LostParentInfo };

const isAlive = (n: PlaceNode | null | undefined): boolean => !!n && (n.deleted_at === null || n.deleted_at === undefined);

/**
 * 撿回這一列時放哪裡。兩個入口同一條規則。
 * @param row     要撿回的節點（快照那份或 tombstone）
 * @param parent  它的上層現在的樣子；null＝這台根本沒有這一列
 * @param route   row.route_id 指到的節點現在的樣子
 * @param fallbackParent  上層這台沒有時，拿快照那一列當顯示名字的來源
 */
export function placementFor(row: PlaceNode, parent: PlaceNode | null, route: PlaceNode | null, fallbackParent?: PlaceNode | null): Placement {
  const liveRoute = (): string | null => (route && isAlive(route) && route.kind === "route" ? route.id : null);
  if (typeof row.parent_id !== "string") {
    // 根層臨時車票的路線不在了：標籤留著的話收件匣（route_id IS NULL）與路線圖都沒有它，只有搜尋找得到（問題 9）
    if (row.kind === "ticket" && typeof row.route_id === "string" && !liveRoute()) return { type: "loose", routeId: null };
    return { type: "inPlace" }; // 幹線、根層臨時車票
  }
  const kind = row.kind as NodeKind;
  const looseRoute = (): Placement => ({ type: "loose", routeId: liveRoute() });
  if (parent && isAlive(parent)) {
    // 上層活著但已經轉成放不了票的種類：車票照樣有去處；其他種類沒有「無上層」可放，照原位（樹的顯示吃得下）
    if (kind === "ticket" && !allowedChildKinds(parent.kind as NodeKind).includes("ticket")) return looseRoute();
    return { type: "inPlace" };
  }
  if (kind === "ticket") return looseRoute();
  const src = parent ?? fallbackParent ?? null;
  return { type: "needsParent", parent: { id: row.parent_id, name: text(src?.name) ?? "", kind: text(src?.kind) } };
}

export interface NodeRestorePlan {
  /** 要清 deleted_at 的節點 */
  ids: string[];
  /** 有值＝走 restoreAsLoose */
  loose?: { routeId: string | null };
  /** 有值＝還沒寫，要先問使用者 */
  needsParent?: LostParentInfo;
}

/**
 * 「最近刪除」撿回節點的計畫。`nodes`＝全部節點的窄欄（含活的與窗外的：上層那一刀可能更早）。
 * withParent：一路往上，把每一層上層所在的那一刀都帶回來（路線也刪了就連路線那一刀）。
 */
export function planNodeRestore(item: Pick<LostItem, "id" | "ids">, nodes: readonly PlaceNode[], opts?: { withParent?: boolean }): NodeRestorePlan {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const row = byId.get(item.id);
  if (!row) throw new RangeError("找不到這一筆");
  const get = (id: unknown): PlaceNode | null => (typeof id === "string" ? (byId.get(id) ?? null) : null);
  const p = placementFor(row, get(row.parent_id), get(row.route_id));
  if (p.type === "inPlace") return { ids: item.ids };
  if (p.type === "loose") return { ids: item.ids, loose: { routeId: p.routeId } };
  if (!opts?.withParent) return { ids: [], needsParent: p.parent };

  const kids = childrenIndex(nodes as readonly LostRow[]);
  const ids = [...item.ids];
  const seen = new Set(ids);
  let cur = get(row.parent_id);
  while (cur && !isAlive(cur)) {
    // 爬到那一刀的頭，整刀帶回來
    let head = cur;
    for (let up = get(head.parent_id); up && up.deleted_at === head.deleted_at; up = get(up.parent_id)) head = up;
    for (const id of cutIds(head as LostRow, kids)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    cur = get(head.parent_id);
  }
  return { ids };
}

/* ───────── 快照差異（§3.2、§3.5） ───────── */

/**
 * 比對時讀**活著的列**要哪些欄（`SELECT ${欄} FROM ${表}`）；只有 id、deleted_at 的表不必列。
 * tombstone 一律讀整列：撿回時要照它的內容復活（問題 1、8）。
 */
export const CURRENT_COLUMNS: Record<string, string> = {
  nodes: "id, kind, name, description, parent_id, line_id, route_id, deleted_at",
  notes: "id, kind, body, deleted_at",
  tags: "id, name, name_key, renamed_to, deleted_at",
  occurrences: "id, node_id, due_on, deleted_at",
  tk_currencies: "id, code, is_main, deleted_at",
};

/** 撿回會碰到、要讀現況的表（LOST 表＋子表＋依賴表＋taggings） */
export const RESCUE_TABLES: readonly string[] = Array.from(
  new Set([
    ...LOST_TABLES,
    ...LOST_KINDS.flatMap((k) => k.children.map((c) => c.table)),
    ...Object.keys(DEP_ONLY),
    "taggings",
  ]),
);

function indexTables(tables: LostTables): Map<string, Map<string, LostRow>> {
  const out = new Map<string, Map<string, LostRow>>();
  for (const t of Object.keys(tables)) out.set(t, new Map((tables[t] ?? []).map((r) => [r.id, r] as const)));
  return out;
}

const COMPARED: Partial<Record<LostKindKey, readonly { col: string; label: string }[]>> = {
  note: [{ col: "body", label: "內文" }],
  diary: [{ col: "body", label: "內文" }],
  ticket: [
    { col: "name", label: "名稱" },
    { col: "description", label: "概要" },
  ],
};

/**
 * 「內容不同」只比內文、名稱、概要（§3.5）：排程、狀態、順序每天都在變，比了整段都是雜訊。
 * NULL 與空字串算一樣；舊快照沒有這一欄就不比。
 */
function changedFields(key: LostKindKey, snap: LostRow, cur: LostRow): ChangedField[] {
  const out: ChangedField[] = [];
  for (const f of COMPARED[key] ?? []) {
    if (!(f.col in snap)) continue;
    const a = nullable(snap[f.col]);
    const b = nullable(cur[f.col]);
    if ((a ?? "") !== (b ?? "")) out.push({ col: f.col, label: f.label, snapshot: a, current: b });
  }
  return out;
}

/** 快照子樹裡「現在不在或已刪」的節點（含根，父先子後）。走到現在還活著的節點就停：它和它底下都不動 */
function rescueSubtree(rootId: string, kids: ReadonlyMap<string, readonly LostRow[]>, cur: ReadonlyMap<string, LostRow> | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const k of kids.get(id) ?? []) {
      if (k.deleted_at) continue;
      if (isAlive(cur?.get(k.id))) continue;
      walk(k.id);
    }
  };
  walk(rootId);
  return out;
}

/**
 * 快照與現況的差異。`missing`＝快照活著、現在不在或已刪（平鋪）；`changed`＝快照活著、現在也活著、比對欄不同。
 * 只看 `LOST_KINDS` 登記的種類，所以競合日誌等子表不會出現；`current` 用 `CURRENT_COLUMNS` 的欄就夠。
 */
export function snapshotDiff(snapshot: Pick<CloudSnapshot, "tables">, current: LostTables): SnapshotDiff {
  const names = namesFromTables(snapshot.tables);
  const cur = indexTables(current);
  const nodeKids = childrenIndex(snapshot.tables.nodes ?? []);
  const missing: { item: SnapshotItem; at: number }[] = [];
  const changed: { item: ChangedItem; at: number }[] = [];
  for (const table of LOST_TABLES) {
    for (const row of snapshot.tables[table] ?? []) {
      if (row.deleted_at) continue;
      const at = typeof row.updated_at === "string" ? Date.parse(row.updated_at) : 0;
      const now = cur.get(table)?.get(row.id);
      // 有 tombstone 就顯示 tombstone 的字：撿回的就是這一版（問題 1）
      const shown = now && !isAlive(now) ? now : row;
      const def = lostKindOf(table, shown);
      if (!def) continue;
      if (now && isAlive(now)) {
        // 車票轉成列車之後不算同一種東西，不比
        if (table === "nodes" && now.kind !== row.kind) continue;
        const fields = changedFields(def.key, row, now);
        if (fields.length && (table === "notes" || def.key === "ticket")) {
          changed.push({
            at,
            item: {
              key: `${table}:${row.id}`,
              kind: def.key as ChangedItem["kind"],
              table: table as ChangedItem["table"],
              category: def.category,
              kindLabel: def.label,
              id: row.id,
              title: def.title(row, names),
              detail: def.detail(row, names),
              fields,
            },
          });
        }
        continue;
      }
      // 改名或併入的荷札不是刪除（§2.1）：快照裡的殼、或現在已改名的都不列
      if (table === "tags" && (row.renamed_to || now?.renamed_to)) continue;
      const ids = table === "nodes" ? rescueSubtree(row.id, nodeKids, cur.get("nodes")) : [row.id];
      const deletedAt = typeof now?.deleted_at === "string" ? now.deleted_at : null;
      missing.push({
        at,
        item: { ...lostItem(def, shown, names, ids, ""), deletedAt, status: now ? "deleted" : "gone" },
      });
    }
  }
  const byNew = (a: { at: number }, b: { at: number }) => b.at - a.at;
  return { missing: missing.sort(byNew).map((x) => x.item), changed: changed.sort(byNew).map((x) => x.item) };
}

/**
 * 重算差異（每次撿回、同步拉到東西之後）接回畫面狀態（問題 2）：清單跟現況一致，但已撿回、已改回的列留著打勾。
 *   - 現在不在差異裡的列：打勾的留著，其他（別台撿回了）消失。
 *   - 打勾的列又回到差異裡（又被刪、又被改）：取消打勾，可以再撿一次。
 *   - `sweep`：這一次撿回順手帶回的列（上層、子節點、荷札）也算撿回了。
 */
export function mergeSnapshotDiff<R>(
  prev: SnapshotDiff | null,
  next: SnapshotDiff,
  picked: Readonly<Record<string, true>>,
  reverted: Readonly<Record<string, R>>,
  opts?: { sweep?: boolean },
): { diff: SnapshotDiff; picked: Record<string, true>; reverted: Record<string, R> } {
  const missingNow = new Map(next.missing.map((x) => [x.key, x] as const));
  const changedNow = new Map(next.changed.map((x) => [x.key, x] as const));
  const outPicked: Record<string, true> = {};
  for (const k of Object.keys(picked)) if (!missingNow.has(k)) outPicked[k] = true;
  if (opts?.sweep) for (const x of prev?.missing ?? []) if (!missingNow.has(x.key)) outPicked[x.key] = true;
  const outReverted: Record<string, R> = {};
  for (const k of Object.keys(reverted)) if (!changedNow.has(k)) outReverted[k] = reverted[k];

  const merge = <T extends { key: string }>(before: readonly T[], now: ReadonlyMap<string, T>, keep: (k: string) => boolean): T[] => {
    const out: T[] = [];
    const placed = new Set<string>();
    for (const x of before) {
      const fresh = now.get(x.key);
      if (fresh) {
        out.push(fresh);
        placed.add(x.key);
      } else if (keep(x.key)) out.push(x);
    }
    for (const [k, x] of now) if (!placed.has(k)) out.push(x);
    return out;
  };
  return {
    diff: {
      missing: merge(prev?.missing ?? [], missingNow, (k) => !!outPicked[k]),
      changed: merge(prev?.changed ?? [], changedNow, (k) => k in outReverted),
    },
    picked: outPicked,
    reverted: outReverted,
  };
}

/* ───────── 快照撿回的計畫（§3.3） ───────── */

/** entity_type → 實體所在的表（判斷實體還在不在） */
const ENTITY_TABLE: Record<string, string> = {
  node: "nodes",
  note: "notes",
  "timetable:block": "time_blocks",
  "timetable:block-off": "time_blocks",
  "timetable:goal": "time_goals",
  "timetable:category": "time_categories",
  "ticket:entry": "tk_entries",
  "ticket:repeat": "tk_repeats",
  "ticket:wish": "tk_wishes",
  "ticket:template": "tk_templates",
};

export interface RescueWrite {
  table: string;
  id: string;
  /** INSERT … ON CONFLICT(id) DO UPDATE 的值（還沒跟現行表欄取交集；舊快照缺的欄吃表預設） */
  row: Record<string, unknown>;
  /** op 的 cols：同步欄整列（對面可能根本沒有這一列） */
  op: Record<string, unknown>;
  opType: "upsert" | "delete";
}

export interface RescuePlan {
  /** 依序寫（外鍵父先子後） */
  writes: RescueWrite[];
  placedAsLoose: boolean;
  /** 目標現在活著（清單過期了）：目標本身不寫。節點的 `writes` 只有它底下不在的子節點 */
  alreadyHere: boolean;
  /** 有值＝還沒寫，要先問使用者 */
  needsParent: LostParentInfo | null;
  /** 荷札撿回：這些活著的筆記內文要補回 `#名稱`（§2.4，不補的話下次存檔又被摘掉） */
  tagBodies: { noteId: string; key: string; name: string }[];
  /** 帶著 repeat_id 的帳：撿回要把那一班從 skipped_days 拿掉，不然下次實體化又補刪 */
  entries: LostRow[];
  /** 時間塊：先寫成 tombstone，再走 timetable.restore（跑 planCover，同 §2.1）；null＝沒有 */
  restoreBlockId: string | null;
}

const occKey = (o: LostRow): string => `${String(o.node_id)}|${String(o.due_on)}`;

/**
 * 快照裡每一班的決定性 id（node|due → occurrenceId）。uuid v5 是非同步的、`planRescue` 是純同步函式，所以先算好帶進去；
 * `idOf` 由 repository 給（`occurrenceId`，本檔不 import 資料層）。
 */
export async function rescueOccurrenceIds(snapshot: Pick<CloudSnapshot, "tables">, idOf: (nodeId: string, dueOn: string) => Promise<string>): Promise<Map<string, string>> {
  const rows = (snapshot.tables.occurrences ?? []).filter((o) => !o.deleted_at);
  const ids = await Promise.all(rows.map((o) => idOf(String(o.node_id), String(o.due_on))));
  return new Map(rows.map((o, i) => [occKey(o), ids[i]] as const));
}

/**
 * 撿回一筆要寫什麼。現況 `current`：活著的列用 `CURRENT_COLUMNS`，tombstone 整列（`RESCUE_TABLES` 全部）。
 *
 * 帶誰：節點＝快照子樹裡不在或已刪的節點＋它們的日誌（不含競合）、班次、逐班時刻、荷札；其他＝自己＋荷札；
 * 外鍵依賴現在沒有＝一起帶。都只帶「快照裡活著、現在不在或已刪」的列：現在還活著的一律不動；目標自己活著回 `alreadyHere`。
 *
 * 內容：本機有 tombstone＝照本機內容復活（op 仍送整列，對面可能沒有這一列）；本機沒有這一列才用快照列（問題 1、8）。
 * 子列同一個道理：本體有 tombstone 時，子列的 tombstone 時刻跟本體不同＝使用者刪之前就拿掉的（摘荷札、撤済章），不帶（`removedEarlier`）。
 * 限制（問題 16，不修）：兩台離線各刪同一枚荷札時，荷札的 deleted_at 經 LWW 收斂到較晚那刀，只在較早那刀裡的掛載比不到、不帶。
 */
export function planRescue(
  snapshot: CloudSnapshot,
  item: Pick<SnapshotItem, "table" | "id">,
  current: LostTables,
  nowIso: string,
  occIds: ReadonlyMap<string, string>,
  opts?: { withParent?: boolean },
): RescuePlan {
  const snap = indexTables(snapshot.tables);
  const cur = indexTables(current);
  const plan: RescuePlan = { writes: [], placedAsLoose: false, alreadyHere: false, needsParent: null, tagBodies: [], entries: [], restoreBlockId: null };
  const seen = new Set<string>();
  const gone = (table: string, id: string): boolean => !isAlive(cur.get(table)?.get(id));
  const snapRows = (table: string): readonly LostRow[] => snapshot.tables[table] ?? [];
  /** 這一列的最新版：本機有 tombstone 就是它，否則快照那列 */
  const latest = (table: string, row: LostRow): LostRow => {
    const c = cur.get(table)?.get(row.id);
    return c && !isAlive(c) ? c : row;
  };
  /** 子列有 tombstone、時刻跟本體的 tombstone 不同＝刪本體之前就拿掉的；同一刀的（同 deleted_at）才算跟著本體走 */
  const removedEarlier = (child: LostRow | undefined, ownerTable: string, ownerId: string): boolean => {
    if (!child || isAlive(child)) return false;
    const owner = cur.get(ownerTable)?.get(ownerId);
    return !!owner && child.deleted_at !== owner.deleted_at;
  };

  const opOf = (table: string, row: Record<string, unknown>): Record<string, unknown> => {
    const cols: Record<string, unknown> = {};
    for (const c of snapshot.columns[table] ?? []) {
      if (c !== "id" && c in row) cols[c] = row[c] === undefined ? null : row[c];
    }
    return cols;
  };
  const push = (table: string, row: Record<string, unknown> & { id: string }, op = opOf(table, row), opType: RescueWrite["opType"] = "upsert") => {
    plan.writes.push({ table, id: row.id, row, op, opType });
  };
  const fresh = (table: string, row: LostRow): LostRow => ({ ...latest(table, row), deleted_at: null, updated_at: nowIso });

  /* 荷札 */
  const tagsByEntity = new Map<string, LostRow[]>();
  const tagsByTag = new Map<string, LostRow[]>();
  for (const g of snapRows("taggings")) {
    if (g.deleted_at) continue;
    pushTo(tagsByEntity, `${String(g.entity_type)}|${String(g.entity_id)}`, g);
    pushTo(tagsByTag, String(g.tag_id), g);
  }
  const reviveTag = (tagIdValue: string): boolean => {
    const c = cur.get("tags")?.get(tagIdValue);
    if (isAlive(c)) return true;
    // 現在已改名或併入：掛載照帶，由同步後的 reconcileRenamed 跟到新名字；這枚不復活
    if (c?.renamed_to) return true;
    const s = snap.get("tags")?.get(tagIdValue);
    if (!s || s.deleted_at) return false;
    if (!seen.has(`tags:${tagIdValue}`)) {
      seen.add(`tags:${tagIdValue}`);
      push("tags", { ...fresh("tags", s), renamed_to: null });
    }
    return true;
  };
  const bringTaggings = (ownerTable: string, id: string, types: readonly string[]) => {
    for (const type of types) {
      for (const g of tagsByEntity.get(`${type}|${id}`) ?? []) {
        if (!gone("taggings", g.id) || seen.has(`taggings:${g.id}`)) continue;
        if (removedEarlier(cur.get("taggings")?.get(g.id), ownerTable, id)) continue;
        if (!reviveTag(String(g.tag_id))) continue;
        seen.add(`taggings:${g.id}`);
        push("taggings", fresh("taggings", g));
      }
    }
  };

  /* 子表 */
  const childIndex = new Map<string, Map<string, LostRow[]>>();
  const childrenOf = (c: LostChildTable, parentId: string): LostRow[] => {
    let idx = childIndex.get(c.table);
    if (!idx) {
      idx = new Map();
      for (const r of snapRows(c.table)) pushTo(idx, String(r[c.col]), r);
      childIndex.set(c.table, idx);
    }
    return idx.get(parentId) ?? [];
  };
  const liveOcc = new Set<string>();
  for (const o of current.occurrences ?? []) if (isAlive(o)) liveOcc.add(occKey(o));
  /**
   * 班次一律寫決定性 id（問題 7）：快照裡可能是舊版的隨機 id，復活它再遇到另一台對同一班蓋的章（決定性 id）會撞部分唯一索引，
   * 整個同步物件回滾、每輪重炸。本機該班已有活列就不帶（留現在那一列）。
   */
  const bringOccurrence = (r: LostRow, ownerId: string) => {
    const k = occKey(r);
    const id = occIds.get(k);
    if (!id || liveOcc.has(k)) return;
    const occs = cur.get("occurrences");
    const tomb = occs?.get(id) ?? occs?.get(r.id);
    if (removedEarlier(tomb, "nodes", ownerId)) return;
    liveOcc.add(k);
    seen.add(`occurrences:${id}`);
    push("occurrences", { ...(tomb ?? r), id, deleted_at: null, updated_at: nowIso });
  };
  const bringChildren = (def: LostKindDef, id: string) => {
    for (const c of def.children) {
      for (const r of childrenOf(c, id)) {
        if (r.deleted_at || (c.keep && !c.keep(r))) continue;
        if (c.table === "occurrences") {
          bringOccurrence(r, id);
          continue;
        }
        if (!gone(c.table, r.id) || seen.has(`${c.table}:${r.id}`)) continue;
        if (removedEarlier(cur.get(c.table)?.get(r.id), def.table, id)) continue;
        seen.add(`${c.table}:${r.id}`);
        push(c.table, fresh(c.table, r));
      }
    }
  };

  /* 外鍵依賴 → 本列 → 帶子表與荷札（父先子後） */
  const defFor = (table: string, row: LostRow) => lostKindOf(table, row);
  const depsOf = (table: string, row: LostRow): readonly LostDep[] => defFor(table, row)?.requires ?? DEP_ONLY[table]?.requires ?? [];
  const bringDeps = (table: string, row: LostRow) => {
    for (const dep of depsOf(table, row)) {
      const val = row[dep.col];
      if (typeof val !== "string" || val === "") continue;
      if (dep.by === "code") {
        if ((current[dep.table] ?? []).some((r) => r.code === val && isAlive(r))) continue;
        const s = snapRows(dep.table).find((r) => r.code === val);
        if (s) visit(dep.table, s);
        continue; // 幣別不是外鍵：快照也沒有就算了
      }
      if (!gone(dep.table, val)) continue;
      const s = snap.get(dep.table)?.get(val);
      if (s) visit(dep.table, s);
      else if (!cur.get(dep.table)?.has(val)) throw new RangeError("這一筆用到的帳戶或分類，這份備份裡也沒有");
    }
  };
  const visit = (table: string, row: LostRow, override?: Record<string, unknown>, opType: RescueWrite["opType"] = "upsert") => {
    const k = `${table}:${row.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    const src = latest(table, row);
    bringDeps(table, src);
    const final: LostRow = { ...fresh(table, row), ...override };
    // 復活依賴幣別：這台已有活的主幣別就不能再多一個（問題 10；只有「重新開始」後換過主幣別才會碰到）
    if (table === "tk_currencies" && final.is_main && (current.tk_currencies ?? []).some((r) => isAlive(r) && r.is_main && r.id !== row.id)) final.is_main = 0;
    push(table, final, opOf(table, final), opType);
    const def = defFor(table, src);
    if (def) bringChildren(def, row.id);
    bringTaggings(table, row.id, def?.tagTypes ?? DEP_ONLY[table]?.tagTypes ?? []);
    if (table === "tk_entries" && src.repeat_id) plan.entries.push(src);
  };

  /* 節點：快取欄走建票同一支推導（line_id／route_id），不進 op；route_id 只有根層臨時車票是資料 */
  const planned = new Map<string, PlaceNode>();
  const nodeRef = (id: unknown): PlaceNode | null => (typeof id === "string" ? (planned.get(id) ?? cur.get("nodes")?.get(id) ?? null) : null);
  const emitNode = (row: LostRow, placed?: { parent_id: null; route_id: string | null; sort_key: null }) => {
    const k = `nodes:${row.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    const r: LostRow = { ...fresh("nodes", row), ...placed };
    const parent = nodeRef(r.parent_id);
    if (parent) {
      r.line_id = parent.kind === "line" ? parent.id : ((parent.line_id as string | null | undefined) ?? null);
      r.route_id = parent.kind === "route" ? parent.id : ((parent.route_id as string | null | undefined) ?? null);
    } else if (r.kind === "ticket") {
      // 路線標籤指到的路線這台要有（外鍵）；這台根本沒有就拿掉，整列留下
      const tag = nodeRef(r.route_id);
      r.route_id = tag?.id ?? null;
      r.line_id = (tag?.line_id as string | null | undefined) ?? null;
    } else {
      r.line_id = null;
      r.route_id = null;
    }
    planned.set(r.id, r);
    const op = opOf("nodes", r);
    if (!(r.parent_id === null && r.kind === "ticket")) delete op.route_id;
    push("nodes", r, op);
    const def = lostKindOf("nodes", r);
    if (def) bringChildren(def, r.id);
    bringTaggings("nodes", r.id, ["node"]);
  };

  const root = snap.get(item.table)?.get(item.id);
  if (!root) throw new RangeError("這份備份裡找不到這一筆");

  // 清單可能過期（背景同步拉到另一台撿回的、連同上層時順手帶回的）：用現況再判一次，活著的不動（問題 2）
  const here = cur.get(item.table)?.get(item.id);
  const hereAlive = isAlive(here);
  if (hereAlive) plan.alreadyHere = true;

  if (item.table === "nodes") {
    const curNodes = cur.get("nodes");
    if (hereAlive) seen.add(`nodes:${root.id}`); // 自己一個字不動，往下補子節點
    else {
      const src = latest("nodes", root);
      const parentId = src.parent_id;
      const placement = placementFor(
        src,
        typeof parentId === "string" ? (curNodes?.get(parentId) ?? null) : null,
        typeof src.route_id === "string" ? (curNodes?.get(src.route_id) ?? null) : null,
        typeof parentId === "string" ? (snap.get("nodes")?.get(parentId) ?? null) : null,
      );
      if (placement.type === "needsParent") {
        if (!opts?.withParent) {
          plan.needsParent = placement.parent;
          return plan;
        }
        // 連同上層：只帶上層那條鏈上的節點（本機有 tombstone 就用本機那列，沒有才用快照；一律整列，問題 8）
        const chain: LostRow[] = [];
        let pid: unknown = parentId;
        const guard = new Set<string>();
        while (typeof pid === "string" && gone("nodes", pid) && !guard.has(pid)) {
          guard.add(pid);
          const up = curNodes?.get(pid) ?? snap.get("nodes")?.get(pid);
          if (!up) throw new RangeError("找不到它的上層，撿不回來");
          chain.unshift(up);
          pid = up.parent_id;
        }
        for (const row of chain) emitNode(row);
      }
      if (placement.type === "loose") {
        plan.placedAsLoose = true;
        // 排序鍵清掉：群組換了，NULL＝排在有鍵的後面，啟動時的回填會補上
        emitNode(root, { parent_id: null, route_id: placement.routeId, sort_key: null });
      } else emitNode(root);
    }
    const ids = rescueSubtree(root.id, childrenIndex(snapRows("nodes")), curNodes);
    const snapNodes = snap.get("nodes");
    for (const id of ids) {
      const r = snapNodes?.get(id);
      if (!r) continue;
      // 本機 tombstone 記的上層跟快照不同（快照之後搬走又刪了），那裡也不在：復活了會看不見，留在清單上
      const p = latest("nodes", r).parent_id;
      if (typeof p === "string" && !planned.has(p) && gone("nodes", p)) continue;
      emitNode(r);
    }
    return plan;
  }

  if (hereAlive) return plan;

  if (item.table === "tags") {
    // 已改名或併入：不是刪除，這枚的掛載由 reconcileRenamed 跟到新名字
    if (here?.renamed_to) {
      plan.alreadyHere = true;
      return plan;
    }
    seen.add(`tags:${root.id}`);
    push("tags", { ...fresh("tags", root), renamed_to: null });
    for (const g of tagsByTag.get(root.id) ?? []) {
      if (!gone("taggings", g.id)) continue;
      // 本機有 tombstone、時刻跟荷札不同＝使用者自己摘的（問題 5）：不帶也不補內文。本機沒有這列才照快照帶
      if (removedEarlier(cur.get("taggings")?.get(g.id), "tags", root.id)) continue;
      const type = String(g.entity_type);
      const entityTable = ENTITY_TABLE[type];
      const entity = entityTable ? cur.get(entityTable)?.get(String(g.entity_id)) : undefined;
      // 實體這台已經沒有了就不掛（孤兒掛載沒有意義）；認不得的別線類型照帶
      if (entityTable && !entity) continue;
      seen.add(`taggings:${g.id}`);
      push("taggings", fresh("taggings", g));
      if (type === "note" && isAlive(entity)) {
        plan.tagBodies.push({ noteId: String(g.entity_id), key: String(root.name_key), name: String(root.name) });
      }
    }
    return plan;
  }

  if (item.table === "time_blocks") {
    // 本機有 tombstone：內容照本機、刪除時刻不動（restore 靠它算「刪掉時還在運行」的塊的結束時刻）。
    // 本機沒有：快照那時還在運行的塊結束在快照那一刻（不然從那天一路蓋到現在，還會多一班運行中）
    visit(item.table, root, here ? { deleted_at: here.deleted_at } : { deleted_at: nowIso, ended_at: root.ended_at ?? snapshot.exported_at }, "delete");
    plan.restoreBlockId = root.id;
    return plan;
  }

  visit(item.table, root);
  return plan;
}

/* ───────── 文案（短、口語；§2.5） ───────── */

export const LOST_INTRO = "這裡列出 30 天內刪掉的東西，點「撿回」就回到原位。";
export const LOST_EMPTY = "沒有最近刪除的東西";
export const LOST_MORE = "更早的？從雲端備份找";

/** 「含 N 個子項」那一段；沒有就 null */
export function lostChildLabel(item: Pick<LostItem, "kind" | "childCount">): string | null {
  if (item.childCount <= 0) return null;
  if (item.kind === "tag") return `和底下 ${item.childCount} 個`;
  if (item.kind === "tk_budget") return `含 ${item.childCount} 個月的設定`;
  return `含 ${item.childCount} 個子項`;
}

/** 每列的補充：路線或時段、金額＋子項數 */
export function lostSubline(item: Pick<LostItem, "kind" | "childCount" | "detail">): string | null {
  return joinParts(item.detail, lostChildLabel(item));
}

function dayDiff(iso: string, now: LostNow): number {
  const a = new Date(iso);
  const b = new Date(toMs(now));
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(b) - start(a)) / DAY_MS);
}

/** 依日期分段的標題：今天／昨天／M/D */
export function lostDaySection(deletedAt: string, now: LostNow): string {
  const n = dayDiff(deletedAt, now);
  if (n <= 0) return "今天";
  if (n === 1) return "昨天";
  return isoShort(deletedAt) ?? "";
}

/** 每列的「N 天前」 */
export function lostDaysAgo(deletedAt: string, now: LostNow): string {
  const n = dayDiff(deletedAt, now);
  return n <= 0 ? "今天" : `${n} 天前`;
}

export function lostRestoredToast(title: string, res?: { placedAsLoose?: boolean }): string {
  return res?.placedAsLoose ? `已撿回「${title}」，放到臨時車票` : `已撿回「${title}」`;
}

/** 撿回定期帳的 toast 小字（問題 4）：同暫停恢復的前例，刪除期間的班次不補 */
export const LOST_NO_BACKFILL = "中間的班次不補";

/** 按撿回時它已經在了（問題 2）；filled＝順手補回底下幾個不在的 */
export function lostAlreadyHereToast(title: string, filled: number): string {
  return filled > 0 ? `「${title}」已經在了，補回底下 ${filled} 個` : `「${title}」已經在了`;
}

export function lostParentConfirm(parentName: string): string {
  return parentName ? `它的上層「${parentName}」也刪了，要連同上層一起撿回嗎？` : "它的上層也刪了，要連同上層一起撿回嗎？";
}
