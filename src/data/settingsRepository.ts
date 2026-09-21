/**
 * 鍵值設定（主題、日界線……）——同樣走 repository 介面。
 *
 * v1.1.1（同步地基・WP5）：settings 是四張表裡唯一的「同步孤島」（沒有 id／deleted_at／created_at），
 * 而 11 個 key 裡有 10 個是裝置本地的事實（主題、備份路徑與成敗、摺疊狀態……）。
 * 所以不動 schema，改在**白名單**上做取捨——只有 `day_start_hour` 進 oplog（D-1.1-3）：
 * 日界線決定「哪些票算今天」，兩台不一致會讓同一筆資料在兩台落在不同日。
 * 白名單常數住在 `syncRepository.ts`（`SYNC_SETTINGS_KEYS`），Rust 端 apply 時用同一份名單再濾一次。
 */
import { getDb, nowUtcIso } from "../lib/db";
import { runWriteBatch, SYNC_SETTINGS_KEYS } from "./syncRepository";

export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class SqliteSettingsRepository implements SettingsRepository {
  async get(key: string): Promise<string | null> {
    const db = await getDb();
    const rows = await db.select<{ value: string }[]>(`SELECT value FROM settings WHERE key = $1`, [key]);
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const db = await getDb();
    const sql = `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
    const args = [key, value, nowUtcIso()];
    if (!SYNC_SETTINGS_KEYS.includes(key)) {
      // 裝置本地的 key：照 v1.1.0 原樣一句 execute，連交易都不多包一層
      await db.execute(sql, args);
      return;
    }
    // row_id＝key（settings 沒有 id 欄）；cols 只有 value——updated_at 由對面那台自己蓋當下時刻
    await runWriteBatch(db, [{ sql, args }], [{ tbl: "settings", row_id: key, op: "upsert", cols: { value } }]);
  }
}
