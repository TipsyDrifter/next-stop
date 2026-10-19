import Database from "@tauri-apps/plugin-sql";
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

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    // 捕捉小窗（階段⑤，契約 §4.2）：附著主視窗的連線，不 load。其餘視窗照舊 load（一個 App 一條連線）。
    dbPromise = isCaptureWindow() ? Promise.resolve(getDbAttached()) : Database.load(DB_URL);
  }
  return dbPromise;
}

/** UUID v4（Web Crypto，瀏覽器與 Tauri WebView 都有）。 */
export function uuid(): string {
  return crypto.randomUUID();
}

/** 當下時間的 UTC ISO 8601 字串（毫秒精度，與 SQLite strftime 預設對齊）。 */
export function nowUtcIso(): string {
  return new Date().toISOString();
}
