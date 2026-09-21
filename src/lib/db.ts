import Database from "@tauri-apps/plugin-sql";

/**
 * 私鐵手帳 · SQLite connection helper
 *
 * 一個 App 只開一條 connection（singleton），所有 repository 共用。
 * tauri-plugin-sql 第一次 load 會自動跑 migrations（在 src-tauri/src/lib.rs 註冊）。
 * DB 檔：next-stop-v2.db（v2 schema）；v0.1 的 next-stop.db 原地保留不讀。
 */
const DB_URL = "sqlite:next-stop-v2.db";

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
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
