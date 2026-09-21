/**
 * BackupRepository——M3 ⑥ 備份三件套的資料層契約（Wave A · WP0 立，Wave B 三席照這份編譯）。
 *
 * 拍板依據：`docs/決策記錄.md`〈⑥ 備份三件套實施計畫拍板〉（全照推薦）
 *           ＋`docs/research/2026-09-14-M3⑥備份三件套-實施計畫草案.md` §4。
 *
 * 三件套：①App 內還原頁（列備份→一鍵還原→還原前保險→換檔重啟）
 *         ②預設 `%APPDATA%\app.shitetsu.nextstop\backups\`＋設定頁自訂第二位置（異地保險）
 *         ③失敗 toast＋設定頁常駐「上次成功備份」＋連敗 3 次啟動橫幅。
 *
 * 分工（本檔只有契約與空殼，機制不在這裡）：
 *   WP1 Rust  ─ `src-tauri/src/backup.rs` 的七支 command 實作；JSON shape 必須與本檔型別同名同形。
 *   WP2 資料層 ─ 填 `TauriBackupRepository`／`MemoryBackupRepository` 兩實作＋`src/store/backupStore.ts`。
 *   WP3 UI    ─ `src/ui/settings/BackupTab.tsx` 只認本檔型別，不碰 invoke。
 *
 * 紀律：UI 與 store 不直接寫 SQL／不直接 invoke，資料存取一律收在 repository 介面後（產品規格書 §157、§44）。
 */

import { invoke } from "@tauri-apps/api/core";

/* ═══════════════════════════════════════════════════════════════════════
   型別（與 Rust `src-tauri/src/backup.rs` 的 serde 型別同名同形）
   ═══════════════════════════════════════════════════════════════════════ */

/** 備份的來源：自動（啟動時當日未備即備）／手動（設定頁「立即備份」）／保險（還原前自動另存） */
export type BackupKind = "auto" | "manual" | "safety";

/** 備份所在位置：主位置（app 目錄 backups/）／第二位置（主人自選的異地資料夾） */
export type BackupLocation = "primary" | "secondary";

/** 清單一列＝一個實體檔案。檔名即 metadata，不做 manifest（D-⑥-2）。 */
export interface BackupEntry {
  /** 檔名，如 `next-stop-v2_2026-09-14_0312_auto.db` */
  file_name: string;
  /** 絕對路徑（還原／驗證都吃這個） */
  path: string;
  location: BackupLocation;
  kind: BackupKind;
  /** 建立時刻，UTC ISO 8601（顯示時轉本地；日界線不套用於備份） */
  created_at: string;
  size_bytes: number;
  /**
   * 同分鐘序號（檔名 `-2` 那一截；無後綴＝1，舊版 Rust 端沒有這個欄位＝undefined）。
   * 檔名只到分鐘，同一分鐘拍兩份時兩列的時刻一模一樣——清單靠這個欄位標「第 2 份」
   * （⑥ 沙盒真機第 4 條）。**不改顯示到秒**：檔名本身只有分鐘，秒數只能拿檔案 mtime 湊，
   * 而 mtime 一被鏡射複製就變、跟檔名對不起來；seq 則直接來自檔名，與主人在檔案總管看到的同一件事。
   */
  seq?: number;
}

/**
 * 一次備份動作的結果（discriminated union，判別欄位＝`status`）。
 * Rust 端＝`#[serde(tag = "status", rename_all = "snake_case")]` 的 enum。
 *   skipped_today ─ 今天（本地日曆日）已經有自動備份，沒再備一份
 *   ok            ─ 備成功，`path`＝新檔絕對路徑
 *   error         ─ 備失敗，`message`＝給主人看的人話
 *   no_db         ─ DB 檔還不存在（首次啟動、migration 尚未建檔），不算失敗
 */
export type BackupReport =
  | { status: "skipped_today" }
  | { status: "ok"; path: string }
  | { status: "error"; message: string }
  | { status: "no_db" };

/** 第二位置（鏡射）的結果；`null`＝主人沒設第二位置，這次沒做鏡射 */
export type SecondaryReport = { ok: true; path: string } | { ok: false; message: string };

/**
 * 輪替＋鏡射的結果。第二位置失敗**不算主備份失敗**、不進連敗計數（D-⑥-4）。
 *   removed   ─ 這次輪替刪掉的檔名（保險份獨立配額、不在此列）
 *   secondary ─ 鏡射結果；未設第二位置＝null
 */
export interface PolicyReport {
  removed: string[];
  secondary: SecondaryReport | null;
}

/** `validateFile` 的回傳：檔頭 magic＋`PRAGMA integrity_check`＋表存在都過了才回這個 */
export interface FileInfo {
  path: string;
  size_bytes: number;
  /** `PRAGMA page_count`；取不到就省略 */
  page_count?: number;
  /** 檔內的表名（至少要有 `settings` 與 `nodes` 才算合格） */
  tables: string[];
}

/* ═══════════════════════════════════════════════════════════════════════
   介面
   ═══════════════════════════════════════════════════════════════════════ */

export interface BackupRepository {
  /** 讀 Rust 在啟動（migration 之前）那一次快照的結果；純讀 managed state，不會再備一次。 */
  startupReport(): Promise<BackupReport>;

  /** 立即備份一份 `manual`，接著套用輪替＋鏡射；`secondaryDir` 為 null＝沒設第二位置。 */
  backupNow(keep: number, secondaryDir: string | null): Promise<BackupReport>;

  /** 只做輪替與鏡射（啟動快照完成後由前端補做，因為 Rust 不讀 settings）；保留 `keep` 份。 */
  applyPolicy(keep: number, secondaryDir: string | null): Promise<PolicyReport>;

  /** 列清單：主位置＋（有設就加）第二位置，只認 `next-stop-v2_` 前綴的檔（舊 DB 不碰）。 */
  list(secondaryDir: string | null): Promise<BackupEntry[]>;

  /** 驗一個 `.db` 能不能還原（magic＋integrity_check＋表存在）；不合格 reject，訊息是人話。 */
  validateFile(path: string): Promise<FileInfo>;

  /** 還原：驗檔→另存保險份→關 pool→換檔→`app.restart()`。**成功不會回來**（App 重啟）；失敗才 reject。 */
  restore(path: string): Promise<never>;

  /** 選第二備份位置的資料夾（dialog plugin）；取消＝null。 */
  pickDirectory(): Promise<string | null>;

  /** 「從檔案還原…」選任意 `.db`（dialog plugin，filter `db`）；取消＝null。 */
  pickDbFile(): Promise<string | null>;

  /** 在檔案總管開啟備份資料夾（opener 的 revealItemInDir）。 */
  revealBackupsDir(): Promise<void>;

  /** ⑧ 清場步驟二：清空 nodes／occurrences／work_logs 但保留 settings。**DEV 限定**，正式版無此 UI。 */
  resetDatabaseKeepSettings?(): Promise<void>;
}

/* ═══════════════════════════════════════════════════════════════════════
   settings 鍵與常數（前端讀寫；Rust 不讀 settings）
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * 備份相關的 settings 鍵（sqlite `settings` 表，鍵值字串；命名沿 `today_late_collapsed` 的 snake_case）。
 * 全部走既有 `settingsRepo.get/set`，不需 migration。
 */
export const BACKUP_SETTING_KEYS = {
  /** 保留份數，`"3"|"7"|"14"|"30"`，預設 `"7"` */
  keep: "backup_keep",
  /** 第二備份位置絕對路徑；空字串＝未設 */
  secondaryDir: "backup_dir_secondary",
  /** 上次成功備份時刻（UTC ISO） */
  lastOkAt: "backup_last_ok_at",
  /** 上次失敗原因（文字；空字串＝無） */
  lastError: "backup_last_error",
  /** 連續失敗次數（`"0"`..）；成功歸零，≥3 出啟動橫幅 */
  failStreak: "backup_fail_streak",
  /** 第二位置上次鏡射成功時刻（UTC ISO） */
  secondaryLastOkAt: "backup_secondary_last_ok_at",
  /** 第二位置上次鏡射失敗原因（文字；空字串＝無） */
  secondaryLastError: "backup_secondary_last_error",
} as const;

export type BackupSettingKey = (typeof BACKUP_SETTING_KEYS)[keyof typeof BACKUP_SETTING_KEYS];

/** 保留份數選單（自動＋手動合計；保險份不佔配額） */
export const BACKUP_KEEP_OPTIONS = [3, 7, 14, 30] as const;

/** 保留份數預設值 */
export const BACKUP_KEEP_DEFAULT = 7;

/** 保險份（`_safety`）的獨立配額——不佔 keep，最近 3 份 */
export const BACKUP_SAFETY_KEEP = 3;

/** 只認這個前綴的檔（c11：舊 `next-stop.db` 與 `.bak-20260806` 原地保留不讀） */
export const BACKUP_FILE_PREFIX = "next-stop-v2_";

/** 把 settings 讀回來的字串收斂成合法的保留份數 */
export function parseKeep(raw: string | null | undefined): number {
  const n = Number(raw);
  return (BACKUP_KEEP_OPTIONS as readonly number[]).includes(n) ? n : BACKUP_KEEP_DEFAULT;
}

/* ═══════════════════════════════════════════════════════════════════════
   檔名規則（純函式；Rust 端寫檔、TS 端解析，兩邊同一份規格）
   `next-stop-v2_YYYY-MM-DD_HHMM_{auto|manual|safety}.db`，同分鐘第 2 份加 `-2`
   時刻用**本地時間**（字串序＝時間序）
   ═══════════════════════════════════════════════════════════════════════ */

const NAME_RE = /^next-stop-v2_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_(auto|manual|safety)(?:-(\d+))?\.db$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 組備份檔名。
 * @param kind 來源
 * @param date 本地時間（預設現在）
 * @param seq  同分鐘序號，1＝無後綴，2＝`-2`（`VACUUM INTO` 目標已存在必失敗，故需序號）
 */
export function backupFileName(kind: BackupKind, date: Date = new Date(), seq = 1): string {
  const stamp =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `_${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  const tail = seq > 1 ? `-${seq}` : "";
  return `${BACKUP_FILE_PREFIX}${stamp}_${kind}${tail}.db`;
}

export interface ParsedBackupName {
  kind: BackupKind;
  /** 檔名裡的本地時刻（秒與毫秒為 0） */
  date: Date;
  /** 同分鐘序號，無後綴＝1 */
  seq: number;
}

/** 解析備份檔名；不是備份檔（含舊 DB、`.tmp` 半檔）回 null。 */
export function parseBackupFileName(name: string): ParsedBackupName | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, hh, mm, kind, seq] = m;
  return {
    kind: kind as BackupKind,
    date: new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm)),
    seq: seq ? Number(seq) : 1,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   實作一：Tauri（空殼——WP1 的 command 到位後由 WP2 填 invoke）
   ═══════════════════════════════════════════════════════════════════════ */

/** Rust command 名（`src-tauri/src/backup.rs` 的 `#[tauri::command]`，兩邊改名要一起改） */
export const BACKUP_COMMANDS = {
  startupReport: "backup_startup_report",
  backupNow: "backup_now",
  applyPolicy: "backup_apply_policy",
  list: "backup_list",
  validateFile: "backup_validate_file",
  restore: "backup_restore",
  resetDatabaseKeepSettings: "reset_database_keep_settings",
} as const;

/**
 * 真機實作（WP1 填）。每支對應一次 `invoke`，參數名即 args 物件的鍵（Rust 端同名參數）。
 * `pickDirectory`／`pickDbFile` 走 `@tauri-apps/plugin-dialog`（capability `dialog:allow-open`）；
 * `revealBackupsDir` 走已裝的 `@tauri-apps/plugin-opener` 的 `revealItemInDir`。
 *
 * `invoke` 靜態 import（`src/lib/db.ts` 已經靜態拉進 `@tauri-apps/plugin-sql`，core 本來就在初始 chunk 裡）；
 * dialog／opener／path 則動態 import——只有主人真的按下「選資料夾／從檔案還原／開啟備份資料夾」才載。
 */
export class TauriBackupRepository implements BackupRepository {
  async startupReport(): Promise<BackupReport> {
    return invoke<BackupReport>(BACKUP_COMMANDS.startupReport, {});
  }

  async backupNow(keep: number, secondaryDir: string | null): Promise<BackupReport> {
    return invoke<BackupReport>(BACKUP_COMMANDS.backupNow, {
      kind: "manual",
      keep,
      secondary: secondaryDir,
    });
  }

  async applyPolicy(keep: number, secondaryDir: string | null): Promise<PolicyReport> {
    return invoke<PolicyReport>(BACKUP_COMMANDS.applyPolicy, { keep, secondary: secondaryDir });
  }

  async list(secondaryDir: string | null): Promise<BackupEntry[]> {
    return invoke<BackupEntry[]>(BACKUP_COMMANDS.list, { secondary: secondaryDir });
  }

  async validateFile(path: string): Promise<FileInfo> {
    return invoke<FileInfo>(BACKUP_COMMANDS.validateFile, { path });
  }

  /** 成功不會回來（Rust 端 `app.restart()`）；這個 Promise 只會 reject 或永遠 pending。 */
  async restore(path: string): Promise<never> {
    await invoke<void>(BACKUP_COMMANDS.restore, { path });
    // 走到這裡代表 Rust 回來了卻沒重啟——當成失敗處理，別讓 UI 以為還原完成了
    throw new Error("還原指令回來了但 App 沒有重新啟動，請手動重開私鐵手帳確認資料。");
  }

  async pickDirectory(): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "選擇第二備份位置" });
    return typeof picked === "string" ? picked : null;
  }

  async pickDbFile(): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      directory: false,
      title: "選一個備份檔還原",
      filters: [{ name: "備份檔", extensions: ["db"] }],
    });
    return typeof picked === "string" ? picked : null;
  }

  /**
   * 在檔案總管開啟備份資料夾。`revealItemInDir` 吃的是「檔案或資料夾」路徑：
   * 清單裡有 primary 份就指那個檔（總管會順便把它選起來），一份都沒有就指資料夾本身。
   * 先呼叫 `list()` 有兩個作用——拿到檔案路徑，以及讓 Rust 端順手 `create_dir_all` 出 `backups/`
   * （不然第一次按這顆鈕時資料夾還不存在，總管會開不起來）。
   */
  async revealBackupsDir(): Promise<void> {
    const rows = await this.list(null);
    const primary = rows.find((r) => r.location === "primary");
    let target = primary?.path;
    if (!target) {
      // 空資料夾：用 core 的 path API 自己組（`app_config_dir()/backups`，與 Rust 端同一處）
      const { appConfigDir, join } = await import("@tauri-apps/api/path");
      target = await join(await appConfigDir(), "backups");
    }
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(target);
  }

  async resetDatabaseKeepSettings(): Promise<void> {
    return invoke<void>(BACKUP_COMMANDS.resetDatabaseKeepSettings, {});
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   實作二：記憶體（`?mock=1` 純瀏覽器預覽；WP3 靠這個跑 UI 與截圖）
   ═══════════════════════════════════════════════════════════════════════ */

/** `?mock=1&backup=fail|streak3` 的端點（DEV_FLAGS.backup 傳進來）；null＝一切順利 */
export type BackupMockMode = "fail" | "streak3" | null;

const MOCK_PRIMARY_DIR = "C:\\Users\\User\\AppData\\Roaming\\app.shitetsu.nextstop\\backups";

function mockEntry(
  kind: BackupKind,
  daysAgo: number,
  hour: number,
  minute: number,
  size: number,
  location: BackupLocation,
  dir: string,
): BackupEntry {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  const file_name = backupFileName(kind, d);
  return { file_name, path: `${dir}\\${file_name}`, location, kind, created_at: d.toISOString(), size_bytes: size };
}

/** `?backup=fail|streak3` 兩個端點共用的假失敗原因——主位置與第二位置各一句人話 */
const MOCK_FAIL_MESSAGE = "（假資料）備份資料夾寫不進去：拒絕存取";
const MOCK_SECONDARY_FAIL_MESSAGE = "（假資料）第二位置找不到：D:\\ 沒有掛上";

/**
 * 假資料實作：固定 3 筆清單＋成功 report；設了第二位置就再鏡射一筆（讓 WP3 看得到來源欄）。
 * `mode`＝`?backup=` 端點（WP2 補齊行為，兩個 mode 目前同款失敗，差別只在 backupStore 的連敗起算）：
 *   fail    → `startupReport`／`backupNow` 回 error、`applyPolicy` 的第二位置也 `ok:false`
 *   streak3 → 同上；再加上 `backupStore` 把 `failStreak` 從 2 起算，這一次失敗就踩到橫幅門檻 3
 * 清單筆數固定（3＋第二位置 1）是 WP0 契約，WP3 的版面與截圖依這個數，勿動。
 */
export class MemoryBackupRepository implements BackupRepository {
  constructor(private readonly mode: BackupMockMode = null) {}

  /** 兩個端點目前都代表「主備份失敗」；之後要分家就改這裡一處 */
  private get failing(): boolean {
    return this.mode === "fail" || this.mode === "streak3";
  }

  async startupReport(): Promise<BackupReport> {
    if (this.failing) return { status: "error", message: MOCK_FAIL_MESSAGE };
    return { status: "ok", path: `${MOCK_PRIMARY_DIR}\\${backupFileName("auto")}` };
  }

  async backupNow(_keep: number, _secondaryDir: string | null): Promise<BackupReport> {
    if (this.failing) return { status: "error", message: MOCK_FAIL_MESSAGE };
    return { status: "ok", path: `${MOCK_PRIMARY_DIR}\\${backupFileName("manual")}` };
  }

  async applyPolicy(keep: number, secondaryDir: string | null): Promise<PolicyReport> {
    // 假輪替：清單固定 3 筆，keep 調到 3 以下才看得到「刪最舊」的效果（最舊的排在最後）
    const rows = await this.list(null);
    const removed = rows.slice(keep).map((r) => r.file_name);
    if (!secondaryDir) return { removed, secondary: null };
    return {
      removed,
      secondary: this.failing
        ? { ok: false, message: MOCK_SECONDARY_FAIL_MESSAGE }
        : { ok: true, path: secondaryDir },
    };
  }

  async list(secondaryDir: string | null): Promise<BackupEntry[]> {
    const rows: BackupEntry[] = [
      mockEntry("auto", 0, 3, 12, 114_688, "primary", MOCK_PRIMARY_DIR),
      mockEntry("manual", 1, 21, 40, 114_688, "primary", MOCK_PRIMARY_DIR),
      mockEntry("auto", 2, 9, 5, 110_592, "primary", MOCK_PRIMARY_DIR),
    ];
    if (secondaryDir) rows.push(mockEntry("auto", 0, 3, 12, 114_688, "secondary", secondaryDir));
    return rows;
  }

  async validateFile(path: string): Promise<FileInfo> {
    return { path, size_bytes: 114_688, page_count: 28, tables: ["settings", "nodes", "occurrences", "work_logs"] };
  }

  async restore(_path: string): Promise<never> {
    throw new Error("（假資料模式）還原要換檔＋重啟 App，瀏覽器預覽做不到——請在真機驗收。");
  }

  async pickDirectory(): Promise<string | null> {
    return "D:\\pCloud Drive\\私鐵手帳備份";
  }

  async pickDbFile(): Promise<string | null> {
    return `D:\\pCloud Drive\\私鐵手帳備份\\${backupFileName("auto")}`;
  }

  async revealBackupsDir(): Promise<void> {
    console.info("[next-stop] （假資料）開啟備份資料夾：", MOCK_PRIMARY_DIR);
  }

  async resetDatabaseKeepSettings(): Promise<void> {
    console.info("[next-stop] （假資料）重置空庫、保留 settings");
  }
}
