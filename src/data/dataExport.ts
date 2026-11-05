/**
 * 資料匯出的讀與寫（失物招領 §4）。組 JSON／CSV／zip 的純函式在 `domain/dataExport.ts`、`domain/storeZip.ts`；
 * 這裡只做三件有副作用的事：讀資料庫、問使用者存到哪、把位元組交給 Rust 寫檔。
 *
 *   readExportRows(scope)                    讀該範圍每張表「活著的列」（唯讀，不寫庫）
 *   pickExportTarget(scope, format)          存檔對話框（桌機）／系統存檔畫面（手機，SAF）；取消 → null
 *   exportData(scope, format, target)        讀 → 組 → 寫到 target
 *
 * 寫檔走 `export_write_picked`（Rust；桌機路徑與手機 `content://` 同一支）。位元組以 base64 過 IPC。
 * `?mock=1` 不碰 Tauri：選位置回假路徑、不寫檔，讓畫面能走完。
 */
import { getDb, nowUtcIso } from "../lib/db";
import { DEFAULT_DAY_START_HOUR, parseDayStartHour } from "../lib/date";
import { MOCK_MODE } from "./index";
import {
  buildExportPayload,
  bytesToBase64,
  exportFileName,
  tablesOfScope,
  type ExportFormat,
  type ExportInput,
  type ExportRow,
  type ExportScope,
  type ExportTables,
} from "../domain/dataExport";

/** 掛在節點底下的三張表：節點被刪了，它們的列留著也只是雜訊，不帶 */
const ON_LIVE_NODE = "node_id IN (SELECT id FROM nodes WHERE deleted_at IS NULL)";

/** 除了「沒刪」之外，個別表多一條規則（表名是程式常數，不是使用者輸入，直接串進 SQL） */
const EXTRA_WHERE: Readonly<Record<string, string>> = {
  // 競合日誌是各台自己記的「我這版被誰蓋掉了」，不是主人的資料
  work_logs: `(event IS NULL OR event <> 'conflict') AND ${ON_LIVE_NODE}`,
  occurrences: ON_LIVE_NODE,
  node_time_overrides: ON_LIVE_NODE,
};

type Db = Awaited<ReturnType<typeof getDb>>;

async function readTable(db: Db, name: string): Promise<ExportRow[]> {
  // 先問表有哪些欄：沒有 deleted_at 的表就不加那條（照實處理），表不存在（舊 schema）就當空
  const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(${name})`);
  if (cols.length === 0) return [];
  const has = (c: string) => cols.some((x) => x.name === c);
  const where = [has("deleted_at") ? "deleted_at IS NULL" : null, EXTRA_WHERE[name] ?? null].filter(Boolean).join(" AND ");
  const order = has("created_at") ? " ORDER BY created_at, id" : has("id") ? " ORDER BY id" : "";
  return db.select<ExportRow[]>(`SELECT * FROM ${name}${where ? ` WHERE ${where}` : ""}${order}`);
}

export interface ExportRows extends ExportInput {
  /** 資料庫的 schema 版本（已套用的 migration 最大版號）；讀不到 null */
  schema: number | null;
}

/** 讀該範圍每張表活著的列。純讀取。 */
export async function readExportRows(scope: ExportScope): Promise<ExportRows> {
  const tables: ExportTables = {};
  if (MOCK_MODE) {
    for (const t of tablesOfScope(scope)) tables[t] = [];
    return { tables, nodes: [], dayStartHour: DEFAULT_DAY_START_HOUR, schema: null };
  }
  const db = await getDb();
  for (const t of tablesOfScope(scope)) tables[t] = await readTable(db, t);

  // CSV 要把路線、上層、車票的 id 換成名稱：就算這個範圍不匯出 nodes 這張表，也要有節點名單
  const nodes = tables.nodes ?? (await readTable(db, "nodes"));

  let dayStartHour = DEFAULT_DAY_START_HOUR;
  try {
    const r = await db.select<{ value: string }[]>("SELECT value FROM settings WHERE key = $1", ["day_start_hour"]);
    dayStartHour = parseDayStartHour(r[0]?.value);
  } catch {
    /* 讀不到就用預設日界線 */
  }

  let schema: number | null = null;
  try {
    const r = await db.select<{ v: number | null }[]>("SELECT MAX(version) AS v FROM _sqlx_migrations WHERE success = 1");
    schema = r[0]?.v ?? null;
  } catch {
    /* 沒有這張表（測試庫等）就留 null */
  }

  return { tables, nodes, dayStartHour, schema };
}

/** Android（真平台，不看殼寬）：存檔走 SAF，filter 收 MIME（同 backupRepository／mcp/client） */
function onAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/**
 * 問使用者存到哪。回 `string`＝選好的位置（桌機是路徑、手機是 `content://` URI）；`null`＝使用者取消（零動作、不吵）。
 * 對話框開不了之類的錯會往上丟，由畫面行內報錯——手機沒有可以悄悄退回的落點（App 私有資料夾使用者看不到）。
 */
export async function pickExportTarget(scope: ExportScope, format: ExportFormat): Promise<string | null> {
  const name = exportFileName(scope, format);
  if (MOCK_MODE) return `mock://${name}`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const mime = format === "json" ? "application/json" : "application/zip";
  const ext = format === "json" ? "json" : "zip";
  const picked = await save({
    title: "匯出資料",
    defaultPath: name,
    // Android 的 filter 收 MIME（含「/」就原樣用），副檔名會被換成 MIME 而對不上；桌機用副檔名
    filters: onAndroid() ? [{ name: format === "json" ? "JSON" : "zip", extensions: [mime] }] : [{ name: format === "json" ? "JSON" : "zip", extensions: [ext] }],
  }).catch((e: unknown) => {
    // 手機按返回＝plugin reject「cancelled」，當成取消
    if (String(e).toLowerCase().includes("cancel")) return null;
    throw e;
  });
  return picked ?? null;
}

export interface ExportResult {
  /** 實際寫到哪（使用者選的位置） */
  target: string;
  bytes: number;
  /** 匯出的檔數（JSON 為 1；CSV 是 zip 裡的檔數） */
  fileCount: number;
  /** 各表匯出幾列 */
  counts: Record<string, number>;
}

/** 讀 → 組 → 寫到 `target`（`pickExportTarget` 的結果）。失敗丟 Error，訊息是人話。 */
export async function exportData(scope: ExportScope, format: ExportFormat, target: string): Promise<ExportResult> {
  const rows = await readExportRows(scope);
  const payload = buildExportPayload(scope, format, rows, { schema: rows.schema, exportedAt: nowUtcIso() });
  if (!MOCK_MODE) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke<void>("export_write_picked", { target, base64: bytesToBase64(payload.bytes) });
    } catch (e) {
      throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "寫入匯出檔失敗。");
    }
  }
  return { target, bytes: payload.bytes.length, fileCount: payload.fileCount, counts: payload.counts };
}
