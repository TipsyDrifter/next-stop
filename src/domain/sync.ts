/**
 * 同步預備欄位 · Shared SyncFields
 *
 * 所有 entity 都會帶這幾個欄位，方便 v1.0+ 雲端同步：
 * - account_id / device_id：v1.0+ 多帳號多裝置時用，現在永遠 NULL
 * - 時間戳：全部 UTC ISO 8601 字串
 * - deleted_at：soft delete 標記（不是真的刪 row）
 */
export interface SyncFields {
  account_id: string | null;
  device_id: string | null;
  created_at: string; // UTC ISO 8601
  updated_at: string; // UTC ISO 8601
  synced_at: string | null;
  deleted_at: string | null;
}
