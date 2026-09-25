/**
 * 資料層入口——App 全域共用的 repository 單例。
 * 換儲存實作（手機端／同步）只改這裡的 new。
 *
 * 假資料模式（純瀏覽器預覽，不需 Tauri 橋接）：URL 帶 `?mock=1`、或 `VITE_MOCK=1`，
 * nodeRepo／settingsRepo 改用記憶體實作＋示範種子；否則維持 SQLite。
 */
import type { NodeRepository } from "./nodeRepository";
import { SqliteNodeRepository } from "./sqliteNodeRepository";
import type { SettingsRepository } from "./settingsRepository";
import { SqliteSettingsRepository } from "./settingsRepository";
import { MemoryNodeRepository, MemorySettingsRepository } from "./memoryRepository";
import type { BackupRepository, BackupMockMode } from "./backupRepository";
import { MemoryBackupRepository, TauriBackupRepository } from "./backupRepository";
import type { SyncRepository } from "./syncRepository";
import { MemorySyncRepository, TauriSyncRepository } from "./syncRepository";

function detectMockMode(): boolean {
  if (import.meta.env.VITE_MOCK === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  } catch {
    return false;
  }
}

function detectFlag(name: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get(name) === "1";
  } catch {
    return false;
  }
}

/** 目前是否跑在假資料模式（記憶體 repository＋示範種子） */
export const MOCK_MODE: boolean = detectMockMode();

/** `?mock=1&many=1`：今日視圖塞到 25 張上下，檢查留白 token 在真資料量下有沒有被擠壓 */
const MANY_MODE: boolean = MOCK_MODE && detectFlag("many");

/**
 * `?mock=1&today=empty|alldone`：只給評審／截圖用的兩個端點狀態（整合席加）。
 *   empty   → 今日清單清空，拍 1.0c「今天還沒有班次」
 *   alldone → 今天該出現的票全部蓋済，拍 1.0d「今天的班次都到站了」
 */
function todayMode(): "empty" | "alldone" | null {
  if (!MOCK_MODE || typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("today");
    return v === "empty" || v === "alldone" ? v : null;
  } catch {
    return null;
  }
}
const TODAY_MODE = todayMode();

/**
 * dev／mock 專用的起始狀態端點（M3 ⑤ WP1；草案 §6-10「`?page=` 目前不存在，WP1 新增」）。
 * **只在 `?mock=1` 或 vite DEV 生效**，正式打包三個欄位恆 null（沿 `uiStore` 的 THEME_OVERRIDE 模式）。
 *
 *   `?page=today|routemap|calendar`  起始頁 → `uiStore.page` 的初值
 *   `&view=month|week`               日曆視圖 → `uiStore.calendarView` 的初值（蓋過 settings，**不寫回**）
 *   `&day=YYYY-MM-DD`                直開該日的當日清單浮層（＝原型的 `?open=14`）→ WP3 自己讀
 *   `&backup=fail|streak3`           備份端點（M3 ⑥ WP0）→ `MemoryBackupRepository` 吃這個：
 *                                      fail    → 啟動 report 回 error，拍失敗 toast
 *                                      streak3 → 同上，且 backupStore 視為連敗 ≥3，拍啟動橫幅
 *
 * 讀法：`import { DEV_FLAGS } from "../../data";` → `DEV_FLAGS.day` 等；null＝沒帶這個參數。
 */
export interface DevFlags {
  page: "today" | "routemap" | "calendar" | null;
  view: "month" | "week" | null;
  day: string | null;
  backup: BackupMockMode;
}

function detectDevFlags(): DevFlags {
  const off: DevFlags = { page: null, view: null, day: null, backup: null };
  if (!import.meta.env.DEV && !MOCK_MODE) return off;
  if (typeof window === "undefined") return off;
  try {
    const q = new URLSearchParams(window.location.search);
    const page = q.get("page");
    const view = q.get("view");
    const day = q.get("day");
    const backup = q.get("backup");
    return {
      page: page === "today" || page === "routemap" || page === "calendar" ? page : null,
      view: view === "month" || view === "week" ? view : null,
      day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
      backup: backup === "fail" || backup === "streak3" ? backup : null,
    };
  } catch {
    return off;
  }
}

export const DEV_FLAGS: DevFlags = detectDevFlags();

function makeNodeRepo(): NodeRepository {
  if (!MOCK_MODE) return new SqliteNodeRepository();
  const repo = new MemoryNodeRepository();
  repo.seedDemo({ many: MANY_MODE, empty: TODAY_MODE === "empty", allDone: TODAY_MODE === "alldone" });
  return repo;
}

function makeSettingsRepo(): SettingsRepository {
  return MOCK_MODE ? new MemorySettingsRepository() : new SqliteSettingsRepository();
}

function makeBackupRepo(): BackupRepository {
  // mock＝記憶體假清單（吃 `?backup=fail|streak3` 端點）；真機＝invoke Rust 的 backup_* 七支
  return MOCK_MODE ? new MemoryBackupRepository(DEV_FLAGS.backup) : new TauriBackupRepository();
}

if (MOCK_MODE) {
  console.info(
    `[next-stop] 假資料模式：記憶體 repository，重新整理即重置${MANY_MODE ? "（many=1：今日加量）" : ""}`,
  );
}

export const nodeRepo: NodeRepository = makeNodeRepo();
export const settingsRepo: SettingsRepository = makeSettingsRepo();
export const backupRepo: BackupRepository = makeBackupRepo();
// v1.1.1 同步（契約席）：mock＝記憶體狀態機（不碰網路）；真機＝invoke Rust 的 sync_* 八支
export const syncRepo: SyncRepository = MOCK_MODE ? new MemorySyncRepository() : new TauriSyncRepository();

export type {
  NodeRepository,
  CreateNodeInput,
  NodePatch,
  SidebarData,
  TodayRow,
  TodayBucket,
  CurrentOccurrence,
  ScheduleEntry,
  DateCount,
  RouteProgress,
  // M3 ⑤ 日曆契約層
  CalendarData,
  DueEntry,
} from "./nodeRepository";
export {
  todayBucketOf,
  compareTodayRows,
  formatSerial,
  reorderIds,
  pickTodayOccurrence,
  toCurrentOccurrence,
  countByDate,
  buildCalendar,
  // M3 ④ 重複引擎的共用常數（UI 的 toast 與 repository 擋下的那句話是同一份字）
  REPEATABLE_KINDS,
  REPEAT_DONE_MSG,
  REPEAT_ONLY_MSG,
  REPEAT_RESCHEDULE_MSG,
  REPEAT_FUTURE_ONLY_MSG,
} from "./nodeRepository";
export type { SettingsRepository } from "./settingsRepository";

// M3 ⑥ 備份三件套契約層（WP0）
export type {
  BackupRepository,
  BackupEntry,
  BackupReport,
  BackupKind,
  BackupLocation,
  BackupMockMode,
  BackupSettingKey,
  PolicyReport,
  SecondaryReport,
  FileInfo,
  ParsedBackupName,
} from "./backupRepository";
export {
  BACKUP_SETTING_KEYS,
  BACKUP_KEEP_OPTIONS,
  BACKUP_KEEP_DEFAULT,
  BACKUP_SAFETY_KEEP,
  BACKUP_FILE_PREFIX,
  BACKUP_COMMANDS,
  backupFileName,
  parseBackupFileName,
  parseKeep,
} from "./backupRepository";

// v1.1.1 同步地基契約層（契約席）；v1.1.3 換成單一入口／兩層鑰匙的型別（`SyncRole`／`SyncConfigureInput`／`PairingPayload` 退場）
export type {
  SyncRepository,
  SyncStatus,
  SyncPhase,
  RestoreChoice,
  EpochInfo,
  JoinMode,
  JoinOutcome,
  JoinInput,
  JoinReport,
  PassphraseReport,
  RestoreReport,
  PairingFields,
  AdoptReport,
  WizardEnv,
  PushReport,
  PullReport,
  LockedReason,
  SnapshotKind,
  SnapshotEntry,
  ExportReport,
  RotationReport,
  OutboxOp,
  WriteStmt,
  SyncTable,
} from "./syncRepository";
export {
  SYNC_COMMANDS,
  SYNC_SETTINGS_KEYS,
  SYNC_WRITE_EVENT,
  OCCURRENCE_ID_NAMESPACE,
  nextHlc,
  seedHlc,
  compareHlc,
  occurrenceId,
  syncSideStatements,
  composeBatch,
  runWriteBatch,
  recoverOpenTransaction,
} from "./syncRepository";
