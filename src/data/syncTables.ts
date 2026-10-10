/**
 * 同步表名與 settings 白名單（並行地基・契約 §5.2；純資料）。
 *
 * 唯一真相：核心四張表寫在這裡，三線的表名與 settings 鍵各自寫在 `src/lines/<line>.manifest.ts`。
 * Rust 端的同一份清單在 `src-tauri/src/sync/tables/{core,notes,timetable,ticket}.rs`；
 * 兩邊靠 `pnpm probe:registry` 對帳（含順序），不靠人對。
 *
 * probe 在 node 直接載入本檔：不得 import React／store／Tauri API，值 import 一律含 `.ts`。
 */
import { LINE_MANIFESTS, type LineSyncTable } from "../lines/index.ts";

/** 核心四張表（順序與 Rust `tables/core.rs` 相同） */
export const CORE_SYNC_TABLES = ["nodes", "work_logs", "occurrences", "settings"] as const;

/** 會進 oplog 的表（settings 只有白名單 key） */
export type SyncTable = (typeof CORE_SYNC_TABLES)[number] | LineSyncTable;

/** 順序：核心四張 → notes → timetable → ticket（與 Rust 登記表相同） */
export const SYNC_TABLE_NAMES: readonly string[] = [
  ...CORE_SYNC_TABLES,
  ...LINE_MANIFESTS.flatMap((m) => m.syncTables),
];

/** 核心的 settings 白名單（D-1.1-3：只同步日界線；其餘 key 是裝置本地） */
export const CORE_SYNC_SETTINGS_KEYS = ["day_start_hour"] as const;

/** settings 白名單：核心 → notes → timetable → ticket */
export const SYNC_SETTINGS_KEYS: readonly string[] = [
  ...CORE_SYNC_SETTINGS_KEYS,
  ...LINE_MANIFESTS.flatMap((m) => m.syncSettingsKeys),
];
