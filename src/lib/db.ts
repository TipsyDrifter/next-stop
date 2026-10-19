import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { isCaptureWindow } from "../ui/notes/capture-window/shell";

/**
 * 私鐵手帳 · SQLite connection helper
 *
 * 一個 App 只開一條 connection（singleton），所有 repository 共用。
 * tauri-plugin-sql 第一次 load 會自動跑 migrations（在 src-tauri/src/lib.rs 註冊）。
 * DB 檔：next-stop-v2.db（v2 schema）；v0.1 的 next-stop.db 原地保留不讀。
 */
const DB_URL = "sqlite:next-stop-v2.db";

let dbPromise: Promise<Database> | null = null;

/**
 * 第二個視窗（捕捉小窗）一律用這支：只拿主視窗已經 load 好的那條連線（plugin-sql 靠 path 查表），
 * 不呼叫 Database.load——load 會新建 pool 並覆蓋同名項，備份還原與同步引擎正拿著的連線會被抽掉
 * （docs/research/2026-10-16-旅客筆記-車次⑤-技術查證.md Q3）。前提：主視窗先啟動（tauri.conf.json 視窗順序）。
 */
export function getDbAttached(): Database {
  return Database.get(DB_URL);
}

/**
 * 降版閘門（主線④ #80）：每個頁面第一次要庫時先請 Rust 照 sqlx 的規則驗一次（庫裡有這版不認得的 migration、
 * checksum 不符、上次升級沒做完 ⇒ 拒開），**過了才連線**。
 * 為什麼要自己驗：plugin-sql 只在進程裡第一次 `load` 帶 migrations 去驗（驗完就從表裡拿掉），頁面重新載入後的
 * 第二次 `load` 直接連——舊版就會在新 schema 上讀寫。這支每次載頁都跑（F5、關掉重開都一樣），不存任何狀態。
 * 被拒＝這一頁的 `getDb()` 一律 reject 同一句人話（不重試；要換版本或重開才會再驗）。
 */
async function openDb(): Promise<Database> {
  // 捕捉小窗（階段⑤，契約 §4.2）：附著主視窗的連線，不 load（attach＝不算「交出過 load」，見 db_gate.rs）。
  // 其餘視窗照舊 load（一個 App 一條連線）。
  const attach = isCaptureWindow();
  await invoke("db_gate_check", { attach });
  return attach ? getDbAttached() : Database.load(DB_URL);
}

export function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

/**
 * 這一頁能不能開庫（閘門與 load 都過）。被拒 ⇒ false：App 據此**不** boot 備份與同步——被擋的舊版若照常 boot，
 * 備份輪替會拿預設份數刪掉主人多留的備份（反駁報告 Y1），同步也只會冒出「找不到已連線的資料庫」。
 */
export function dbUsable(): Promise<boolean> {
  return getDb().then(
    () => true,
    () => false,
  );
}

/** UUID v4（Web Crypto，瀏覽器與 Tauri WebView 都有）。 */
export function uuid(): string {
  return crypto.randomUUID();
}

/** 當下時間的 UTC ISO 8601 字串（毫秒精度，與 SQLite strftime 預設對齊）。 */
export function nowUtcIso(): string {
  return new Date().toISOString();
}
