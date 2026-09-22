/**
 * syncRepository——同步的 TS 端契約層（契約席立；store／UI 只認這裡的型別）。
 *
 * 拍板依據：`docs/決策記錄.md`〈v1.1 Plan 草案拍板〉D-1.1-3（只搬主人資料）／D-1.1-5（欄位級 LWW＋HLC）
 *           ＋〈同步與備份規則重整拍板＝v1.1.3 開工〉（三條規則、密語可改）
 *           ＋《2026-09-21-v1.1.3-同步規則重整契約.md》§4（command）、§3.2（閘門鍵）。
 *
 * v1.1.3 改了什麼（契約 §4.1 對照表）：
 *   * `configure`／`applyPairingCode`／`beginNewEpoch` 退場 → `join`（單一入口）／`decodePairingCode`（只解碼填表）／
 *     `finishRestore`（讀標記檔的 choice：回到過去／接上現在）。
 *   * 新增 `changePassphrase`（兩層鑰匙：只重包雲端上的 KEY）、`restoreChoice`（還原對話框的選擇先落檔）。
 *   * `SyncStatus` 拿掉 `role`（正本／副本退場），多 `root／pending_span／restore_choice／pending_epoch_info／locked／
 *     key_sealed／last_export`；`SyncPhase` 多 `locked`（鍵違い）。
 *   * 閘門鍵 `role` → `joined`（`JOINED_GATE`）：Rust `status()` 會把舊 DB 的 `role` 一次性補成 `joined='1'`。
 *
 * 本檔三件事：
 *   ① 型別與 invoke 名稱（與 Rust `src-tauri/src/sync/{engine,commands}.rs` 的 serde 型別同名同形，snake_case）。
 *   ② `TauriSyncRepository`／`MemorySyncRepository`（`?mock=1`）——UI／store 一律經 `syncRepo`，不直接 invoke。
 *   ③ 寫入層的純函式：`nextHlc()`（HLC 字串）、`occurrenceId()`（uuid v5）、`syncSideStatements()`（一筆 op →
 *      outbox＋cells 兩句 INSERT）、`runWriteBatch()`（把「資料語句＋同步語句」包成 **一次 execute** 的
 *      `BEGIN IMMEDIATE … COMMIT`）。
 *
 * 為什麼「一次 execute」：tauri-plugin-sql 的 pool 預設 10 條連線，分開呼叫 `execute("BEGIN")`／`execute(...)`
 *   會落在不同連線上——交易根本不成立。sqlx-sqlite 允許一個 query 字串含多句、逐句執行在**同一條**連線
 *   （已讀原始碼確認：`connection/execute.rs` 的 `ExecuteIter` 逐句 `prepare_next`），且 `$N` 是**整批絕對編號**
 *   （`arguments.rs` 直接用 N 索引 values），所以本檔負責把各句的 `$1..$k` 重新編成全域號。
 *   代價（v1.1.1 契約 §2.6）：批次中途失敗時那條連線會留著未收的交易——`runWriteBatch` 失敗後執行
 *   `recoverOpenTransaction()`：連續 `ROLLBACK` 最多 10 次（pool 上限），idle 佇列是 FIFO、逐次輪到每一條，
 *   直到某次 ROLLBACK 成功（＝找到那條）為止。
 *
 * 閘門（`JOINED_GATE`）：outbox／cells 兩句都是 `INSERT … SELECT … WHERE EXISTS(...)`，SQL 層自己判斷、
 *   TS 不留狀態。**看的是 `sync_meta.joined`（＝這台加入過同步沒有），不是總開關 `enabled`**：
 *   總開關關著只該停網路，不該讓那段時間的變更永遠傳不過去。沒加入過同步的桌機＝一列都不會多寫，
 *   既有路徑除了多包一層交易之外行為不變。
 */

import type Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

/* ═══════════════════════════════════════════════════════════════════════
   型別（與 Rust serde 同名同形）
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * off＝從沒加入過／paused＝加入了但總開關關著／running＝運行中／
 * stopped＝停車中（憑證缺或上次失敗）／gated＝信号待ち（對方版本較新）／
 * epoch_changed＝改正待ち（另一台從備份「回到過去」開了新紀元，這台等主人確認「改用那份」）／
 * locked＝鍵違い（v1.1.3：雲端上有這台的密語打不開的東西——血統被別的密語重建；出路是重新加入）
 */
export type SyncPhase = "off" | "paused" | "running" | "stopped" | "gated" | "epoch_changed" | "locked";

/** 還原對話框的二選一（契約 §6；提案規則②） */
export type RestoreChoice = "past" | "present";

/** `<root>/<epoch>/EPOCH.bin` 的內容（契約 §2.2；v1 的 primary_device_id 由 Rust alias 成 opener） */
export interface EpochInfo {
  version: number;
  epoch: string;
  opener_device_id: string;
  created_at: string;
  /** first／restore／backfill */
  reason: string;
  /** 還原時的備份檔名；first／backfill 為 null */
  label: string | null;
}

export interface SyncStatus {
  enabled: boolean;
  /** credstore 為準的身分；沒鑰匙圈時給 sync_meta 的快取 */
  device_id: string;
  epoch: string | null;
  /** 鑰匙圈有資料鑰匙＝這台加入了（正本／副本退場後唯一的判準） */
  configured: boolean;
  /**
   * 這顆 DB 記得自己加入過（`sync_meta.joined='1'`）。v1.1.3 修正席（工程評審 B-1）：
   * `joined && !configured && last_error` ＝**憑證庫讀不到**（不是「沒加入」）——
   * UI 此時不准露出「加入同步」表單，露了主人一按就變成新的一台、整包資料再推一份。
   */
  joined: boolean;
  /** 桶內根前綴（沙盒對帳用） */
  root: string | null;
  phase: SyncPhase;
  busy: boolean;
  /** UTC ISO；null＝還沒成功過 */
  last_sync_at: string | null;
  last_error: string | null;
  /** outbox 待上傳筆數（兩端照實回報） */
  pending_ops: number;
  /** outbox 最早／最晚 op 的時刻（改正待ち文案：「這 N 筆是幾點到幾點之間改的」） */
  pending_span: { from: string; to: string } | null;
  schema: number;
  remote_schema: number | null;
  /** 還原剛完成、尚未收尾（標記檔在且這台有鑰匙圈）；boot 看到就 `finishRestore()` */
  restore_pending: boolean;
  /** 標記檔裡主人選的還原方式；restore_pending 為 true 時非 null */
  restore_choice: RestoreChoice | null;
  /** 偵測到的新紀元號；非 null ⇒ phase='epoch_changed' */
  pending_epoch: string | null;
  /** 那個紀元的 EPOCH.bin（誰開的、何時、哪份備份）——文案用 */
  pending_epoch_info: EpochInfo | null;
  /** 'salt'（桶裡的 SALT 與這台不同）或紀元號（更大的紀元、拆不開）；非 null ⇒ phase='locked' */
  locked: string | null;
  /** 桶裡有沒有 KEY（改密語頁提示用）；null＝還沒查過 */
  key_sealed: boolean | null;
  /** 上一次「改用那份」另存了幾筆未送出的修改、存在哪、什麼時候（同步頁常駐一行） */
  last_orphans: { count: number; path: string; at: string } | null;
  /** 手機「改用另一台的」之前匯出的全量 JSON（桌機是拍 manual 備份，這欄為 null） */
  last_export: { path: string; at: string } | null;
}

/** 兩邊都有資料時主人的選擇（契約 §4.2；按鈕字＝「兩邊都保留」／「改用另一台的」） */
export type JoinMode = "merge" | "adopt_remote";

export type JoinOutcome = "first" | "pulled" | "needs_choice" | "merged" | "adopted" | "reconnected";

/** `sync_join` 的參數（契約 §4.2） */
export interface JoinInput {
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  /** 第一台＝設定它；其餘＝用它拆 KEY */
  passphrase: string;
  /** 省略＝"v1"；沙盒用 "v1-sb-<run>"（DEV 版表單才露出） */
  root?: string;
  /** 兩邊都有料且第一次呼叫沒帶 ⇒ 回 needs_choice；UI 問完再帶回來 */
  mode?: JoinMode;
}

export interface JoinReport {
  outcome: JoinOutcome;
  /** 本機活節點數（needs_choice 文案） */
  local_alive: number;
  /** 雲端目前紀元（first＝新開的那個） */
  remote_epoch: string | null;
  /** 目前紀元底下的裝置目錄數（needs_choice 文案） */
  remote_devices: number;
  /** first／merged：進 outbox 的 op 數（呼叫端接著 push） */
  snapshot_ops: number;
  /** pulled／merged／adopted：join 內部已拉下來套用的報告（呼叫端據此 refreshAfterPull） */
  pull: PullReport | null;
  /** adopted 且手機：全量 JSON 落點；桌機＝null */
  export_path: string | null;
  message: string;
}

/** `sync_change_passphrase`（契約 §4.4） */
export interface PassphraseReport {
  /** 之前桶裡沒有 KEY（舊血統升級後第一次）⇒ 這次是「封存」不是「更改」 */
  sealed_first_time: boolean;
  message: string;
}

/** `sync_finish_restore`（契約 §4.5）：renewed＝回到過去開了新紀元（接著 push）／resumed＝接上現在只清了游標／not_joined＝零動作 */
export interface RestoreReport {
  outcome: "renewed" | "resumed" | "not_joined";
  epoch: string | null;
  snapshot_ops: number;
  message: string;
}

/** `sync_decode_pairing_code`（契約 §4.6）：只用來填表，不存、不 log */
export interface PairingFields {
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  root: string;
  epoch: string | null;
}

export interface PushReport {
  pushed_ops: number;
  object_key: string | null;
  /** 另一趟 push／pull 正在飛、這趟什麼都沒做（UI 說「另一趟進行中」，不是「沒東西」） */
  busy: boolean;
}

export interface PullReport {
  objects: number;
  applied_ops: number;
  skipped_ops: number;
  gated: boolean;
  /** 有被改到的表：nodes／work_logs／occurrences／settings（UI 據此決定重載什麼） */
  changed_tables: string[];
  /** 另一趟正在飛、這趟什麼都沒做 */
  busy: boolean;
  /** 這趟記了幾筆 conflict 事件（乘務記錄） */
  conflicts: number;
  /** 這趟收到的最大 hlc（餵 `seedHlc`；null＝沒收到東西） */
  max_hlc: string | null;
}

/** `sync_adopt_epoch`（改正待ち→「改用那份」）：未推的 op 匯出到 `orphans_path`（0 筆＝null） */
export interface AdoptReport {
  orphan_ops: number;
  orphans_path: string | null;
  epoch: string;
  /** 手機換掉整顆庫之前匯出的全量 JSON（桌機是 TS 先拍 manual 備份，這欄為 null）——產品評審 S2 */
  export_path: string | null;
}

/** `sync_read_wizard_env`：精靈寫的四欄（只用來填表，不存、不 log） */
export interface WizardEnv {
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

/** invoke 名稱（Rust `#[tauri::command]` 函式名）——store／UI 不得手抄字串（契約 §4.1） */
export const SYNC_COMMANDS = {
  status: "sync_status",
  join: "sync_join",
  changePassphrase: "sync_change_passphrase",
  restoreChoice: "sync_restore_choice",
  finishRestore: "sync_finish_restore",
  setEnabled: "sync_set_enabled",
  push: "sync_push",
  pull: "sync_pull",
  resetLocal: "sync_reset_local",
  makePairingCode: "sync_make_pairing_code",
  decodePairingCode: "sync_decode_pairing_code",
  adoptEpoch: "sync_adopt_epoch",
  readWizardEnv: "sync_read_wizard_env",
} as const;

export interface SyncRepository {
  status(): Promise<SyncStatus>;
  /** 單一入口「加入同步」：回 needs_choice 時本機零改變，帶 mode 再叫一次 */
  join(input: JoinInput): Promise<JoinReport>;
  /** 改密語：只重包雲端上的 KEY，資料不重傳 */
  changePassphrase(current: string, next: string): Promise<PassphraseReport>;
  /** 還原對話框的選擇先落檔；null＝清掉。未加入 ⇒ 拒絕（人話） */
  restoreChoice(choice: RestoreChoice | null, label?: string): Promise<void>;
  /** 重啟後的還原收尾（past＝開新紀元，不 push；呼叫端接著 push） */
  finishRestore(): Promise<RestoreReport>;
  setEnabled(enabled: boolean): Promise<SyncStatus>;
  push(): Promise<PushReport>;
  pull(): Promise<PullReport>;
  /** 重設＝清鑰匙圈（含身分）、同步表；資料與雲端不動 */
  resetLocal(): Promise<SyncStatus>;
  /** 任何已加入裝置都能產（v2：憑證＋root＋epoch，不含鹽與身分） */
  makePairingCode(): Promise<string>;
  /** 解配對碼回四欄（無副作用） */
  decodePairingCode(code: string): Promise<PairingFields>;
  /** 改正待ち→「改用那份」（不 pull；呼叫端接著 pull） */
  adoptEpoch(): Promise<AdoptReport>;
  /** 桌機：讀精靈的 r2.env 填表 */
  readWizardEnv(): Promise<WizardEnv>;
}

/* ═══════════════════════════════════════════════════════════════════════
   實作一：真機（每支一次 invoke；參數名＝Rust 端同名參數）
   ═══════════════════════════════════════════════════════════════════════ */

export class TauriSyncRepository implements SyncRepository {
  status(): Promise<SyncStatus> {
    return invoke<SyncStatus>(SYNC_COMMANDS.status, {});
  }
  async join(input: JoinInput): Promise<JoinReport> {
    const report = await invoke<JoinReport>(SYNC_COMMANDS.join, { input });
    // join 內部若拉了東西（pulled／merged／adopted），遠端 hlc 已戳進 cells——同 `pull()` 的理由，這裡也要餵種子
    if (report.pull) seedHlc(report.pull.max_hlc);
    return report;
  }
  changePassphrase(current: string, next: string): Promise<PassphraseReport> {
    return invoke<PassphraseReport>(SYNC_COMMANDS.changePassphrase, { current, next });
  }
  restoreChoice(choice: RestoreChoice | null, label?: string): Promise<void> {
    return invoke<void>(SYNC_COMMANDS.restoreChoice, { choice, label: label ?? null });
  }
  finishRestore(): Promise<RestoreReport> {
    return invoke<RestoreReport>(SYNC_COMMANDS.finishRestore, {});
  }
  setEnabled(enabled: boolean): Promise<SyncStatus> {
    return invoke<SyncStatus>(SYNC_COMMANDS.setEnabled, { enabled });
  }
  push(): Promise<PushReport> {
    return invoke<PushReport>(SYNC_COMMANDS.push, {});
  }
  async pull(): Promise<PullReport> {
    const report = await invoke<PullReport>(SYNC_COMMANDS.pull, {});
    // v1.1.2 契約 §5：拉回來的 hlc 已戳進 sync_cells，但 TS 這邊的記憶體計數看不到它——
    // 不餵種子的話，下一次本機寫入會產出比遠端還小的 hlc，LWW 用「嚴格大於」判勝 ⇒ 剛改的東西
    // 被對方的舊值壓過去。餵在 repository 層（而不是各個呼叫端）：只要走 pull 就一定餵到。
    seedHlc(report.max_hlc);
    return report;
  }
  resetLocal(): Promise<SyncStatus> {
    return invoke<SyncStatus>(SYNC_COMMANDS.resetLocal, {});
  }
  makePairingCode(): Promise<string> {
    return invoke<string>(SYNC_COMMANDS.makePairingCode, {});
  }
  decodePairingCode(code: string): Promise<PairingFields> {
    return invoke<PairingFields>(SYNC_COMMANDS.decodePairingCode, { code });
  }
  adoptEpoch(): Promise<AdoptReport> {
    return invoke<AdoptReport>(SYNC_COMMANDS.adoptEpoch, {});
  }
  readWizardEnv(): Promise<WizardEnv> {
    return invoke<WizardEnv>(SYNC_COMMANDS.readWizardEnv, {});
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   實作二：記憶體（`?mock=1`；WP-C 靠這個跑 UI 與截圖——狀態機在記憶體裡走一遍，不碰網路）
   ═══════════════════════════════════════════════════════════════════════ */

const MOCK_DEVICE_ID = "3f9c2b1e-0000-4000-8000-000000000000";

/**
 * `?mock=1&sync=joined|gated|stopped|paused|epoch_changed|locked|needs_choice|restore_past|restore_present`
 * ——示範狀態端點，只給評審／截圖用。
 * 不帶參數＝未加入（`off`），也就是主人第一次打開「同步」分頁看到的樣子。
 *   joined          → 已加入（運行中，有待上傳筆數）
 *   gated           → 信号待ち（對方版本較新）
 *   stopped         → 停車中＋一句人話的錯誤
 *   paused          → 已加入、總開關關著（待上傳筆數會繼續長，那是正確回饋）
 *   epoch_changed   → 改正待ち：另一台「回到過去」開了新紀元，等主人按「改用那份」
 *   locked          → 鍵違い：雲端血統被別的密語重建
 *   needs_choice    → 未加入，但按「加入同步」會回「兩邊都有資料」讓頁面問一次
 *   restore_past    → 剛從備份還原（選「回到過去」）重啟：boot 會叫 `finishRestore()` ⇒ renewed ⇒ 重新上傳
 *   restore_present → 剛從備份還原（選「接上現在」）重啟：boot 會叫 `finishRestore()` ⇒ resumed ⇒ 只清游標
 * （舊端點 primary／replica 仍接受＝joined，免得書籤失效。）
 *
 * 為什麼要有 restore_* 兩個端點：還原的收尾發生在**重啟後的第一趟 boot**，真機要備份＋重啟才走得到；
 * 把它做成 mock 端點，WP-B／WP-C／評審不必動真 DB 就能把兩條路各走一遍（契約 §6 步驟 4–5）。
 */
type SyncMockMode =
  | "joined"
  | "gated"
  | "stopped"
  | "paused"
  | "epoch_changed"
  | "locked"
  | "needs_choice"
  | "restore_past"
  | "restore_present"
  /** v1.1.3 修正席（工程評審 B-1）：加入過、卻讀不到鑰匙圈——UI 此時不准露出加入表單 */
  | "cred_unreadable"
  /** v1.1.3 修正席（產品評審 S1）：複製整個資料夾（DB 的 enabled 跟來、鑰匙圈沒跟）＝未加入，不是停車中 */
  | "copied_folder"
  | null;

const SYNC_MOCK_MODES = [
  "joined",
  "gated",
  "stopped",
  "paused",
  "epoch_changed",
  "locked",
  "needs_choice",
  "restore_past",
  "restore_present",
  "cred_unreadable",
  "copied_folder",
] as const;

function detectSyncMock(): SyncMockMode {
  if (typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("sync");
    if (v === "primary" || v === "replica") return "joined";
    return (SYNC_MOCK_MODES as readonly string[]).includes(v ?? "") ? (v as SyncMockMode) : null;
  } catch {
    return null;
  }
}

const OFF_STATE: SyncStatus = {
  enabled: false,
  device_id: MOCK_DEVICE_ID,
  epoch: null,
  configured: false,
  joined: false,
  root: null,
  phase: "off",
  busy: false,
  last_sync_at: null,
  last_error: null,
  pending_ops: 0,
  pending_span: null,
  schema: 4,
  remote_schema: null,
  restore_pending: false,
  restore_choice: null,
  pending_epoch: null,
  pending_epoch_info: null,
  locked: null,
  key_sealed: null,
  last_orphans: null,
  last_export: null,
};

/** 示範狀態（同一顆 SyncStatus 的幾個切片；真機的 phase 一律由 Rust 算） */
function seedState(mode: SyncMockMode): SyncStatus {
  if (!mode || mode === "needs_choice") return { ...OFF_STATE };
  const base: SyncStatus = {
    ...OFF_STATE,
    enabled: true,
    configured: true,
    joined: true,
    root: "v1",
    epoch: "1758153600000",
    phase: "running",
    last_sync_at: new Date(Date.now() - 7 * 60_000).toISOString(),
    pending_ops: 3,
    pending_span: { from: new Date(Date.now() - 50 * 60_000).toISOString(), to: new Date(Date.now() - 7 * 60_000).toISOString() },
    key_sealed: true,
  };
  if (mode === "gated") return { ...base, phase: "gated", remote_schema: 5 };
  if (mode === "epoch_changed") {
    return {
      ...base,
      phase: "epoch_changed",
      pending_epoch: "1758240000000",
      pending_epoch_info: {
        version: 2,
        epoch: "1758240000000",
        opener_device_id: "edcf0000-0000-4000-8000-000000000000",
        created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        reason: "restore",
        label: "next-stop-v2_2026-09-20_0312_manual.db",
      },
      pending_ops: 2,
    };
  }
  if (mode === "locked") return { ...base, phase: "locked", locked: "salt", pending_ops: 0, pending_span: null };
  if (mode === "restore_past" || mode === "restore_present") {
    // 還原剛完成、標記檔還在：phase 照常（Rust 不因標記改 phase），由 boot 的 `finishRestore()` 收尾
    return {
      ...base,
      restore_pending: true,
      restore_choice: mode === "restore_past" ? "past" : "present",
      pending_ops: mode === "restore_past" ? 0 : 2,
      pending_span: mode === "restore_past" ? null : base.pending_span,
    };
  }
  if (mode === "paused") return { ...base, enabled: false, phase: "paused", pending_ops: 12 };
  if (mode === "stopped") {
    return { ...base, phase: "stopped", last_error: "連不上 R2（網路不通或憑證過期）", pending_ops: 8 };
  }
  // 工程評審 B-1：讀不到鑰匙圈。`configured=false` 但 `joined=true`＋有原因 ⇒ 顯示人話、不給加入表單
  if (mode === "cred_unreadable") {
    return { ...base, configured: false, phase: "stopped", last_error: "讀取系統憑證庫失敗。", root: null, key_sealed: null };
  }
  // 產品評審 S1：複製資料夾＝沒鑰匙圈也沒有錯誤 ⇒ `off`（朱點與「停車中」都不該出現）
  if (mode === "copied_folder") {
    return { ...base, configured: false, phase: "off", root: null, key_sealed: null, pending_ops: 2 };
  }
  // joined：舊血統升級後 KEY 尚未封存，改密語頁會多一行提示
  return { ...base, key_sealed: false };
}

const EMPTY_PULL: PullReport = {
  objects: 0,
  applied_ops: 0,
  skipped_ops: 0,
  gated: false,
  changed_tables: [],
  busy: false,
  conflicts: 0,
  max_hlc: null,
};

export class MemorySyncRepository implements SyncRepository {
  private mode: SyncMockMode = detectSyncMock();
  private state: SyncStatus = seedState(this.mode);

  async status(): Promise<SyncStatus> {
    return { ...this.state };
  }
  async join(input: JoinInput): Promise<JoinReport> {
    if (!input.endpoint.trim() || !input.bucket.trim()) throw new Error("雲端置物櫃的四個欄位都要填。");
    if (input.passphrase.trim().length < 8) throw new Error("密語至少 8 個字。");
    const root = input.root?.trim() || "v1";
    // 已加入且同一份資料 ⇒ 只更新憑證（換 token／重填四欄）
    if (this.state.configured) {
      this.state = { ...this.state, root };
      return { outcome: "reconnected", local_alive: 12, remote_epoch: this.state.epoch, remote_devices: 2, snapshot_ops: 0, pull: null, export_path: null, message: "憑證已更新，資料照舊" };
    }
    // `?sync=needs_choice`：兩邊都有料 ⇒ 第一次問、帶 mode 才做
    if (this.mode === "needs_choice" && !input.mode) {
      return { outcome: "needs_choice", local_alive: 12, remote_epoch: "1758153600000", remote_devices: 2, snapshot_ops: 0, pull: null, export_path: null, message: "" };
    }
    const epoch = this.mode === "needs_choice" ? "1758153600000" : String(Date.now());
    this.state = { ...seedState("joined"), enabled: true, configured: true, joined: true, root, epoch, key_sealed: true, pending_ops: input.mode === "adopt_remote" ? 0 : 12 };
    if (input.mode === "merge") {
      return { outcome: "merged", local_alive: 12, remote_epoch: epoch, remote_devices: 2, snapshot_ops: 12, pull: { ...EMPTY_PULL, objects: 3, applied_ops: 40, changed_tables: ["nodes"] }, export_path: null, message: "已加入——兩邊的資料已合併，較晚改的為準" };
    }
    if (input.mode === "adopt_remote") {
      const path = "<download>/NextStop/nextstop-export-mock.json";
      this.state = { ...this.state, last_export: { path, at: new Date().toISOString() } };
      return { outcome: "adopted", local_alive: 12, remote_epoch: epoch, remote_devices: 2, snapshot_ops: 0, pull: { ...EMPTY_PULL, objects: 3, applied_ops: 40, changed_tables: ["nodes"] }, export_path: path, message: "已改用另一台的資料" };
    }
    return { outcome: "first", local_alive: 12, remote_epoch: epoch, remote_devices: 1, snapshot_ops: 12, pull: null, export_path: null, message: "已加入——這台是第一台，資料正在上傳" };
  }
  async changePassphrase(_current: string, next: string): Promise<PassphraseReport> {
    if (!this.state.configured) throw new Error("這台還沒加入同步。");
    // 產品評審 B4：現密語可留白（鑰匙圈裡就有資料鑰匙，重包 KEY 用不到舊密語）
    if (next.trim().length < 8) throw new Error("新密語至少 8 個字。");
    const first = this.state.key_sealed === false;
    this.state = { ...this.state, key_sealed: true };
    return { sealed_first_time: first, message: first ? "密語已封存到雲端" : "密語已更改" };
  }
  async restoreChoice(choice: RestoreChoice | null, _label?: string): Promise<void> {
    if (!this.state.configured) throw new Error("這台還沒加入同步——還原不會影響其他裝置。");
    this.state = { ...this.state, restore_choice: choice };
  }
  async finishRestore(): Promise<RestoreReport> {
    if (!this.state.configured) return { outcome: "not_joined", epoch: null, snapshot_ops: 0, message: "這台還沒加入同步，還原不影響其他裝置。" };
    if (this.state.restore_choice === "present") {
      this.state = { ...this.state, restore_pending: false, restore_choice: null };
      return { outcome: "resumed", epoch: this.state.epoch, snapshot_ops: 0, message: "已接上現在——雲端比備份新的修改會在下一趟蓋回來" };
    }
    const epoch = String(Date.now());
    this.state = { ...this.state, epoch, restore_pending: false, restore_choice: null, pending_ops: 12 };
    return { outcome: "renewed", epoch, snapshot_ops: 12, message: "已回到過去——這台正把整份資料重新上傳，其他裝置下次同步會被要求改用這份" };
  }
  async setEnabled(enabled: boolean): Promise<SyncStatus> {
    // 關掉＝paused（設定還在），不是 off（從沒加入）
    this.state = { ...this.state, enabled, phase: enabled ? "running" : "paused" };
    return this.status();
  }
  async push(): Promise<PushReport> {
    const n = this.state.pending_ops;
    this.state = { ...this.state, pending_ops: 0, pending_span: null, last_sync_at: new Date().toISOString() };
    return { pushed_ops: n, object_key: n ? `${this.state.root ?? "v1"}/${this.state.epoch}/${MOCK_DEVICE_ID}/mock.bin` : null, busy: false };
  }
  async pull(): Promise<PullReport> {
    this.state = { ...this.state, last_sync_at: new Date().toISOString() };
    const report: PullReport = { ...EMPTY_PULL };
    seedHlc(report.max_hlc); // 與真機同一條路徑（mock 也不該有第二種行為）
    return report;
  }
  async resetLocal(): Promise<SyncStatus> {
    this.state = { ...OFF_STATE };
    return this.status();
  }
  async makePairingCode(): Promise<string> {
    const payload = {
      v: 2, endpoint: "https://example.r2.cloudflarestorage.com", bucket: "mock", ak: "AK", sk: "SK",
      root: this.state.root ?? "v1", epoch: this.state.epoch,
    };
    return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  }
  async decodePairingCode(code: string): Promise<PairingFields> {
    try {
      const raw = JSON.parse(new TextDecoder().decode(base64UrlDecode(code.trim()))) as Record<string, unknown>;
      const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
      if (!s("endpoint") || !s("bucket") || !s("ak") || !s("sk")) throw new Error("bad");
      return { endpoint: s("endpoint"), bucket: s("bucket"), access_key_id: s("ak"), secret_access_key: s("sk"), root: s("root") || "v1", epoch: s("epoch") || null };
    } catch {
      throw new Error("配對碼看起來不完整，請重新複製一次。");
    }
  }
  async adoptEpoch(): Promise<AdoptReport> {
    const epoch = this.state.pending_epoch;
    if (!epoch) throw new Error("沒有待換的紀元");
    const orphans = this.state.pending_ops;
    const path = orphans ? "<app-data>/sync-orphans-mock.json" : null;
    this.state = {
      ...this.state,
      epoch,
      pending_epoch: null,
      pending_epoch_info: null,
      phase: "running",
      pending_ops: 0,
      pending_span: null,
      last_orphans: orphans && path ? { count: orphans, path, at: new Date().toISOString() } : null,
    };
    // 產品評審 S2：真機在手機上會先匯出全量 JSON；mock 兩殼共用，這裡照樣給路徑（桌機殼不讀它）
    return { orphan_ops: orphans, orphans_path: path, epoch, export_path: null };
  }
  async readWizardEnv(): Promise<WizardEnv> {
    return { endpoint: "https://example.r2.cloudflarestorage.com", bucket: "mock-bucket", access_key_id: "AK-mock", secret_access_key: "SK-mock" };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   寫入層純函式（WP5 用）
   ═══════════════════════════════════════════════════════════════════════ */

/** 會進 oplog 的四張表（settings 只有白名單 key） */
export type SyncTable = "nodes" | "work_logs" | "occurrences" | "settings";

/** settings 白名單（D-1.1-3：只同步日界線；其餘 10 key 是裝置本地） */
export const SYNC_SETTINGS_KEYS: readonly string[] = ["day_start_hour"];

/**
 * 一筆待寫的 op（＝sync_outbox 一列）。cols 只放「主人資料」欄（契約 §7.4 白名單），
 * 快取（line_id／route_id 非根票）與推導（定期券的 scheduled_on、lazy today_position）**不放**。
 */
export interface OutboxOp {
  tbl: SyncTable;
  row_id: string;
  op: "upsert" | "delete";
  cols: Record<string, unknown>;
}

/** 一句 SQL＋它自己的 `$1..$k` 參數（局部編號；`runWriteBatch` 會重編成全域號） */
export interface WriteStmt {
  sql: string;
  args: unknown[];
}

/**
 * 一次公開 mutation 的累加器（WP5）：資料語句與 op 一路收集，最後 `runWriteBatch(db, b.stmts, b.ops)` 一次落。
 * 私有 helper（writeLog／stampOccurrence／dropOccurrence／…）收這個而不是自己 execute——
 * 「一次使用者手勢連動 3–4 張表」才有辦法落在同一個交易裡（寫入路徑盤點 §3(c)）。
 */
export interface WriteBatch {
  stmts: WriteStmt[];
  ops: OutboxOp[];
}

export function newWriteBatch(): WriteBatch {
  return { stmts: [], ops: [] };
}

/**
 * 寫入後通知（syncStore 去抖 2 秒跑一趟；Plan §6）。
 * `window.dispatchEvent(new CustomEvent(SYNC_WRITE_EVENT))`——資料層不知道 store 存在，只丟事件。
 */
export const SYNC_WRITE_EVENT = "ns:sync-write";

/* ── HLC ── */

let hlcLastMs = 0;
let hlcLastCount = 0;

/**
 * 產生 HLC 的**前 17 碼**（`<13位毫秒><4位hex計數>`）；device 尾碼由 SQL 端補
 * （`printf('%s-%s', $hlc, substr((SELECT value FROM sync_meta WHERE key='device_id'),1,8))`），
 * 這樣 TS 不必快取 device_id、加入同步的瞬間就對。程序內單調：同毫秒計數 +1；跨程序靠物理時鐘。
 * 啟動後第一次寫入前，WP5 應以 `seedHlc(MAX(hlc) FROM sync_outbox)` 餵一次種子（沒有列＝不餵）。
 */
export function nextHlc(nowMs: number = Date.now()): string {
  if (nowMs > hlcLastMs) {
    hlcLastMs = nowMs;
    hlcLastCount = 0;
  } else {
    hlcLastCount += 1;
    if (hlcLastCount > 0xffff) {
      hlcLastMs += 1;
      hlcLastCount = 0;
    }
  }
  return `${String(hlcLastMs).padStart(13, "0")}${hlcLastCount.toString(16).padStart(4, "0")}`;
}

/** 以本機已知最大 hlc（完整 26 碼或前 17 碼皆可）餵種子，保證之後產生的都比它大 */
export function seedHlc(maxHlc: string | null | undefined): void {
  if (!maxHlc || maxHlc.length < 17) return;
  const ms = Number(maxHlc.slice(0, 13));
  const count = parseInt(maxHlc.slice(13, 17), 16);
  if (!Number.isFinite(ms) || !Number.isFinite(count)) return;
  if (ms > hlcLastMs || (ms === hlcLastMs && count > hlcLastCount)) {
    hlcLastMs = ms;
    hlcLastCount = count;
  }
}

/** 完整 hlc 字串（含 device 尾碼）的比較：字典序即時序 */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ── occurrences 確定性 id（uuid v5）── */

/** uuid v5 的 namespace（固定常數；兩台裝置對同一班算出同一個 id 的前提） */
export const OCCURRENCE_ID_NAMESPACE = "8d3a2b1e-6f4c-5a7b-9c8d-0e1f2a3b4c5d";

/**
 * `occurrences.id` ＝ uuid v5(namespace, `${nodeId}|${dueOn}`)。用 Web Crypto 的 SHA-1（Tauri WebView 是
 * secure context，`crypto.subtle` 可用；`?mock=1` 在 http://localhost 也可用）。
 */
export async function occurrenceId(nodeId: string, dueOn: string): Promise<string> {
  const ns = hexToBytes(OCCURRENCE_ID_NAMESPACE.replace(/-/g, ""));
  const name = new TextEncoder().encode(`${nodeId}|${dueOn}`);
  const buf = new Uint8Array(ns.length + name.length);
  buf.set(ns, 0);
  buf.set(name, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ── 一筆 op → outbox＋cells 兩句 ── */

/**
 * 只在「這台已經加入過同步」時才真的插列（SQL 端判斷；TS 不留狀態）。
 *
 * 為什麼看 `joined` 而不是 `enabled`（v1.1.1 評審 B1 改判）：舊版看總開關，於是主人把開關關一下、
 * 改了十張票、再打開——那十張票在手機上永遠是舊的（狀態列卻寫「運行中」），而且副本會收到
 * 「父列從未建立」的子列 op，FK 在 COMMIT 時爆掉、游標卡死，之後什麼都拉不到。
 * 改看加入與否之後：關著＝只停網路，變更照記、開回來補送；`sync_reset_local` 清掉整張 sync_meta
 * 之後閘門自然關上，從沒加入過同步的桌機一列都不會多寫（鐵則「桌機既有行為零改變」照舊成立）。
 * v1.1.3：鍵名 `role` → `joined`（正本／副本退場；Rust `status()` 把舊 DB 的 `role` 一次性補成 `joined='1'`）。
 */
const JOINED_GATE = `EXISTS (SELECT 1 FROM sync_meta WHERE key = 'joined' AND value = '1')`;
const DEVICE_SUFFIX = `substr((SELECT value FROM sync_meta WHERE key = 'device_id'), 1, 8)`;

/**
 * 把一筆 op 展成兩句（局部編號 `$1..`）：
 *   ① `INSERT INTO sync_outbox(hlc, tbl, row_id, op, payload) SELECT … WHERE <gate>`
 *   ② `INSERT INTO sync_cells(tbl, row_id, col, hlc, device_id) SELECT … FROM (VALUES …) WHERE <gate>
 *       ON CONFLICT(tbl,row_id,col) DO UPDATE SET hlc=excluded.hlc, device_id=excluded.device_id WHERE excluded.hlc > sync_cells.hlc`
 * `hlc17`＝`nextHlc()` 的結果（同一批次裡多筆 op 可共用同一個 hlc17——同一次手勢＝同一時刻）。
 */
export function syncSideStatements(op: OutboxOp, hlc17: string): WriteStmt[] {
  const hlcExpr = (n: number) => `printf('%s-%s', $${n}, ${DEVICE_SUFFIX})`;
  const outbox: WriteStmt = {
    sql:
      `INSERT INTO sync_outbox (hlc, tbl, row_id, op, payload) ` +
      `SELECT ${hlcExpr(1)}, $2, $3, $4, $5 WHERE ${JOINED_GATE}`,
    args: [hlc17, op.tbl, op.row_id, op.op, JSON.stringify(op.cols)],
  };
  const cols = Object.keys(op.cols);
  if (!cols.length) return [outbox];
  // VALUES 每列：(tbl, row_id, col, hlc17)；device 尾碼由 SELECT 端一次補
  const rows = cols.map((_, i) => `($1, $2, $${i + 4}, $3)`).join(",");
  const cells: WriteStmt = {
    sql:
      `INSERT INTO sync_cells (tbl, row_id, col, hlc, device_id) ` +
      `SELECT column1, column2, column3, printf('%s-%s', column4, ${DEVICE_SUFFIX}), (SELECT value FROM sync_meta WHERE key = 'device_id') ` +
      `FROM (VALUES ${rows}) WHERE ${JOINED_GATE} ` +
      `ON CONFLICT(tbl, row_id, col) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id WHERE excluded.hlc > sync_cells.hlc`,
    args: [op.tbl, op.row_id, hlc17, ...cols],
  };
  return [outbox, cells];
}

/* ── 同步表的存在檢查＋HLC 種子（每個 session 一次）── */

/** 三張同步表的名字（0004 建；缺任一張＝這顆 DB 還沒升到 schema 4） */
const SYNC_TABLES = ["sync_meta", "sync_outbox", "sync_cells"] as const;

let syncTablesReady: Promise<boolean> | null = null;

/**
 * 第一次寫入前做兩件事，之後整個 session 快取結果：
 *   ① 確認 0004 的三張表都在。**缺表就一律不產同步語句**——否則整批（含資料語句）會一起失敗，
 *      等於「同步沒開卻把既有功能弄壞」。理論上 plugin-sql 載入時一定跑過 migration，
 *      但備份還原／手動換 DB 檔這類路徑不在我們手上，這一道是保命閥（任務書「或表不存在」）。
 *   ② `seedHlc(MAX(hlc))`（outbox 與 cells 各取一次最大值）——重開 App 後產生的 hlc 仍比上次大，
 *      即使系統時鐘被往回調（契約 §2.3）。
 */
async function probeSyncTables(db: Database): Promise<boolean> {
  try {
    const found = await db.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ($1, $2, $3)`,
      [...SYNC_TABLES],
    );
    if ((found[0]?.n ?? 0) < SYNC_TABLES.length) return false;
    const max = await db.select<{ m: string | null }[]>(
      `SELECT MAX(h) AS m FROM (SELECT MAX(hlc) AS h FROM sync_outbox UNION ALL SELECT MAX(hlc) AS h FROM sync_cells)`,
    );
    seedHlc(max[0]?.m);
    return true;
  } catch {
    // 讀 sqlite_master 都失敗＝DB 本身有問題，讓資料語句自己去撞真正的錯誤，同步語句不添亂
    return false;
  }
}

/** 同步表在不在（快取；第一次呼叫順便餵 HLC 種子） */
export function ensureSyncTables(db: Database): Promise<boolean> {
  if (!syncTablesReady) syncTablesReady = probeSyncTables(db);
  return syncTablesReady;
}

/** 測試／probe 用：忘掉快取，下次寫入重新探一次 */
export function resetSyncTablesProbe(): void {
  syncTablesReady = null;
}

/* ── sync_meta／sync_outbox 的 TS 端讀寫（診斷與 probe 用）── */
/* 正式的 push 由 Rust 直接讀這兩張表（契約 §7.4）；這裡這幾支是給 scripts/probes 與未來
   UI 診斷用的同形介面，語義與 Rust 端逐點對齊，不是第二條生產路徑。 */

/** 讀一個 sync_meta 值；沒有列＝null */
export async function readSyncMeta(db: Database, key: string): Promise<string | null> {
  const rows = await db.select<{ value: string }[]>(`SELECT value FROM sync_meta WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

/** 寫一個 sync_meta 值（upsert） */
export async function writeSyncMeta(db: Database, key: string, value: string): Promise<void> {
  await db.execute(
    `INSERT INTO sync_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** 同步總開關（`enabled='1'` 才算開；無列＝關） */
export async function isSyncEnabled(db: Database): Promise<boolean> {
  return (await readSyncMeta(db, "enabled")) === "1";
}

/** sync_outbox 一列（payload 仍是 JSON 字串，與 Rust 端同形） */
export interface OutboxRow {
  seq: number;
  hlc: string;
  tbl: string;
  row_id: string;
  op: "upsert" | "delete";
  payload: string;
  created_at: string;
}

/** 取一批待上傳 op（seq 遞增；LIMIT 與 Rust push 同為 2000） */
export function takeOutbox(db: Database, limit = 2000): Promise<OutboxRow[]> {
  return db.select<OutboxRow[]>(
    `SELECT seq, hlc, tbl, row_id, op, payload, created_at FROM sync_outbox ORDER BY seq ASC LIMIT $1`,
    [limit],
  );
}

/** push 成功後清掉已上傳的部分（含 maxSeq） */
export async function clearOutboxThrough(db: Database, maxSeq: number): Promise<void> {
  await db.execute(`DELETE FROM sync_outbox WHERE seq <= $1`, [maxSeq]);
}

/** 待上傳筆數（UI 的 pending_ops 同義） */
export async function countOutbox(db: Database): Promise<number> {
  const rows = await db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM sync_outbox`);
  return rows[0]?.n ?? 0;
}

/* ── 一次 execute 的交易批次 ── */

/** 把一句的 `$k` 全部加上 offset（`$1`→`$(1+offset)`）；只動 `$數字`，不碰字串字面值（本專案 SQL 沒有 `$` 字面值） */
export function renumber(sql: string, offset: number): string {
  return offset === 0 ? sql : sql.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`);
}

/** 組成單一 query 字串：`BEGIN IMMEDIATE; s1; s2; …; COMMIT;`＋合併後的 args（供測試與 runWriteBatch 共用） */
export function composeBatch(stmts: WriteStmt[]): WriteStmt {
  const parts: string[] = ["BEGIN IMMEDIATE"];
  const args: unknown[] = [];
  for (const s of stmts) {
    parts.push(renumber(s.sql, args.length));
    args.push(...s.args);
  }
  parts.push("COMMIT");
  return { sql: parts.join(";\n") + ";", args };
}

/**
 * 資料語句＋（每筆 op 的）同步語句，一次 execute、同一交易。
 * 失敗：先 `recoverOpenTransaction(db)`，再把原錯誤丟回去（呼叫端的錯誤處理與現在一樣）。
 * 成功：丟 `SYNC_WRITE_EVENT`（有 op 才丟；純快取寫入不吵 syncStore）。
 */
export async function runWriteBatch(db: Database, stmts: WriteStmt[], ops: OutboxOp[]): Promise<void> {
  if (!stmts.length && !ops.length) return;
  // 缺表（舊 DB／還原中途）＝當作沒有 op；有表才產同步語句，加入與否由 SQL 端的 WHERE EXISTS 再判一次
  const withSync = ops.length ? await ensureSyncTables(db) : false;
  if (!stmts.length && !withSync) return;
  const hlc17 = withSync ? nextHlc() : "";
  const all = [...stmts];
  if (withSync) for (const op of ops) all.push(...syncSideStatements(op, hlc17));
  const batch = composeBatch(all);
  try {
    await db.execute(batch.sql, batch.args);
  } catch (e) {
    await recoverOpenTransaction(db);
    throw e;
  }
  if (withSync && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SYNC_WRITE_EVENT));
  }
}

/**
 * 批次中途失敗後，那條連線會留著未收的交易（sqlx 歸還 pool 時不會替我們 ROLLBACK；已讀 `pool/connection.rs`）。
 * 連續 ROLLBACK 最多 10 次（pool 上限 10 條、idle 佇列 FIFO ⇒ 逐次輪到每一條）；成功一次＝找到了，停。
 * 其餘的 ROLLBACK 會回「cannot rollback - no transaction is active」，吞掉。
 */
export async function recoverOpenTransaction(db: Database): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      await db.execute("ROLLBACK");
      return;
    } catch {
      /* 這條連線沒有開著的交易，換下一條 */
    }
  }
}

/* ── 小工 ── */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
