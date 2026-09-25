//! 同步的 `#[tauri::command]`（v1.1.3 契約 §4；invoke 名稱＝函式名，參數名＝JS args 物件的鍵）。
//!
//! v1.1.3 改了什麼（契約 §4.1 對照表；契約席 2026-09-21）：
//!   * `sync_configure` **拿掉** → `sync_join`（單一入口：填憑證→先列桶→第一台／直接拉／問一次／重接）。
//!   * `sync_apply_pairing_code` **改名** `sync_decode_pairing_code`（降為便利：只解碼回四欄，無副作用）。
//!   * `sync_begin_new_epoch` **改名** `sync_finish_restore`（讀標記檔的 choice：回到過去／接上現在）。
//!   * 新增 `sync_change_passphrase`（兩層鑰匙：重包 `<root>/KEY`）、`sync_restore_choice`（對話框的選擇先落檔）。
//!   * 其餘（status／set_enabled／push／pull／reset_local／make_pairing_code／adopt_epoch／read_wizard_env）同名。
//!
//! **v1.1.4（契約席 2026-09-22；契約 §4）**：`sync_change_passphrase` 多一個 `rotate: bool`（勾了「同時換掉資料鑰匙」
//!   走七步輪替）；新增六支——`sync_cloud_snapshot_now`／`sync_cloud_snapshot_auto`／`sync_cloud_snapshot_list`／
//!   `sync_cloud_restore`（雲端備份，殼在這裡、機制在 `snapshot.rs`）、`sync_export_to_file`（Android SAF 匯出）、
//!   `sync_finish_rotation`（boot 續跑換鑰匙）。既有 command 名一個都不改。
//!
//! 全部回 `Result<T, String>`，Err 一律**人話**（沿 backup.rs 的口吻），且**不夾帶憑證與密語**。
//! 兩端（桌機／Android）都註冊（`lib.rs` 兩份 `generate_handler!`）。
//!
//! 這一層只做三件事：把 JS 的 args 轉成 engine 的型別、呼叫 engine、把結果原樣回去。
//! 所有判斷（雲端空不空、本機空不空、血統對不對、in-flight、LWW）都在 engine——command 薄一點，換 engine 不必動這裡。

use serde::Deserialize;
use tauri::AppHandle;

use super::engine::{
    self, AdoptReport, JoinArgs, JoinMode, JoinReport, PairingFields, PassphraseReport, PullReport, PushReport,
    RestoreChoice, RestoreReport, RotationReport, SyncStatus, WizardEnv,
};
use super::snapshot::{self, ExportReport, SnapshotEntry, SnapshotKind};

/// `sync_join` 的參數（JS：`invoke("sync_join", { input: {...} })`；契約 §4.2）。**不 derive Debug**。
#[derive(Deserialize)]
pub struct JoinInput {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// 第一台＝設定它；其餘＝用它拆 KEY（或舊血統直接派生，契約 §7 ⑤）
    pub passphrase: String,
    /// 省略＝`v1`；沙盒用 `v1-sb-<run>`（DEV 版表單才露出）
    pub root: Option<String>,
    /// 兩邊都有料且第一次呼叫沒帶 ⇒ 回 `needs_choice`；UI 問完再帶回來
    pub mode: Option<JoinMode>,
}

impl From<JoinInput> for JoinArgs {
    fn from(i: JoinInput) -> Self {
        JoinArgs {
            endpoint: i.endpoint,
            bucket: i.bucket,
            access_key_id: i.access_key_id,
            secret_access_key: i.secret_access_key,
            passphrase: i.passphrase,
            root: i.root,
            mode: i.mode,
        }
    }
}

/// 讀狀態（契約 §4.3）。副作用只有三件、值變了才寫：`schema_gate`、`role`→`joined` 遷移、device_id 快取回寫。
#[tauri::command]
pub async fn sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    engine::status(&app).await
}

/// 單一入口「加入同步」（契約 §4.2）。回 `needs_choice` 時本機零改變，UI 問完帶 `mode` 再呼叫一次。
#[tauri::command]
pub async fn sync_join(app: AppHandle, input: JoinInput) -> Result<JoinReport, String> {
    engine::join(&app, input.into()).await
}

/// v1.1.4 修正席（產品評審 B1）：**用新密語重新加入**——四欄沿用鑰匙圈現成那組，只帶密語。
/// 走的就是 `sync_join`（回 `needs_choice` 時同樣要帶 `mode` 再呼叫一次），所以回傳型別一樣。
#[tauri::command]
pub async fn sync_rejoin(
    app: AppHandle,
    passphrase: String,
    mode: Option<JoinMode>,
) -> Result<JoinReport, String> {
    engine::rejoin(&app, &passphrase, mode).await
}

/// 改密語（契約 §4.4）：只重包 `<root>/KEY`，資料不重傳；舊血統升級後第一次＝封存（`sealed_first_time`）。
/// v1.1.4：`rotate=true`（JS 可省略＝false）⇒ 連資料鑰匙一起換（七步輪替，契約 §5）；此時 `current` 必填。
#[tauri::command]
pub async fn sync_change_passphrase(
    app: AppHandle,
    current: String,
    next: String,
    rotate: Option<bool>,
) -> Result<PassphraseReport, String> {
    engine::change_passphrase(&app, &current, &next, rotate.unwrap_or(false)).await
}

/* ── v1.1.4 雲端備份（契約 §4；機制在 snapshot.rs） ── */

/// 立即拍一份快照上雲。`kind` 省略＝`manual`（JS：`invoke("sync_cloud_snapshot_now", { kind: "manual" })`）。
#[tauri::command]
pub async fn sync_cloud_snapshot_now(app: AppHandle, kind: Option<String>) -> Result<SnapshotEntry, String> {
    let kind = kind
        .as_deref()
        .map(|k| SnapshotKind::parse(k).ok_or_else(|| "快照種類只能是 auto／manual／safety。".to_string()))
        .transpose()?
        .unwrap_or(SnapshotKind::Manual);
    let pool = engine::pool(&app).await?;
    snapshot::upload(&app, &pool, kind).await
}

/// 每日一份（TS `runCycle` 成功後叫；引擎判「今天拍過就回 null」）。
#[tauri::command]
pub async fn sync_cloud_snapshot_auto(app: AppHandle) -> Result<Option<SnapshotEntry>, String> {
    let pool = engine::pool(&app).await?;
    snapshot::upload_auto(&app, &pool).await
}

/// 列出 `<root>/snapshots/`（只 list 不下載；新到舊）。
#[tauri::command]
pub async fn sync_cloud_snapshot_list(app: AppHandle) -> Result<Vec<SnapshotEntry>, String> {
    let pool = engine::pool(&app).await?;
    snapshot::list(&app, &pool).await
}

/// `sync_cloud_restore` 的參數（JS：`invoke("sync_cloud_restore", { input: { key, choice, label } })`）
#[derive(Deserialize)]
pub struct CloudRestoreInput {
    /// 列表回來的完整物件鍵
    pub key: String,
    /// 回到過去／接上現在——與桌機本機還原同義（契約 §6）
    pub choice: RestoreChoice,
    /// 給 EPOCH.bin 的 `label` 與改正待ち文案（UI 組「雲端快照 9/22 14:03」）
    pub label: Option<String>,
}

/// 從雲端快照還原：留底 → 匯入 → 寫既有還原標記 → `app.restart()`。成功**不會回來**；失敗＝本機零改變或已留底。
#[tauri::command]
pub async fn sync_cloud_restore(app: AppHandle, input: CloudRestoreInput) -> Result<(), String> {
    snapshot::cloud_restore(&app, &input.key, input.choice, input.label).await
}

/// `sync_export_to_file` 的參數（JS：`invoke("sync_export_to_file", { input: { target } })`；`input` 可整個省略）
#[derive(Deserialize, Default)]
pub struct ExportInput {
    /// Android：`plugin-dialog` `save()` 回傳的 `content://` URI；桌機／退路：省略
    #[serde(default)]
    pub target: Option<String>,
}

/// 匯出全量 JSON 到檔案（手機「匯出到手機」；桌機沿用下載夾）。**不看**鑰匙圈。
#[tauri::command]
pub async fn sync_export_to_file(app: AppHandle, input: Option<ExportInput>) -> Result<ExportReport, String> {
    let pool = engine::pool(&app).await?;
    snapshot::export_to_file(&app, &pool, input.unwrap_or_default().target).await
}

/// boot 看到 `status.rotation_stage` 就叫：從標記記錄的階段續跑換鑰匙（提交點之前＝回滾）。
#[tauri::command]
pub async fn sync_finish_rotation(app: AppHandle) -> Result<RotationReport, String> {
    engine::finish_rotation(&app).await
}

/// 還原對話框的選擇先落檔（契約 §4.5／§6 步驟 2）；`choice` 為 null ⇒ 清掉。鑰匙圈缺 ⇒ Err（UI 據此不問）。
#[tauri::command]
pub async fn sync_restore_choice(
    app: AppHandle,
    choice: Option<RestoreChoice>,
    label: Option<String>,
) -> Result<(), String> {
    engine::restore_choice(&app, choice, label)
}

/// 重啟後的還原收尾（契約 §6 步驟 5）：past＝開新紀元（**不 push**，TS 接著叫 `sync_push`）；present＝只清游標。
#[tauri::command]
pub async fn sync_finish_restore(app: AppHandle) -> Result<RestoreReport, String> {
    engine::finish_restore(&app).await
}

/// 總開關（enabled '0'|'1'）。關＝不 push 不 pull、TS 端 outbox／cells 照記（SQL 端 WHERE EXISTS 看 `joined`）。
#[tauri::command]
pub async fn sync_set_enabled(app: AppHandle, enabled: bool) -> Result<SyncStatus, String> {
    engine::set_enabled(&app, enabled).await
}

#[tauri::command]
pub async fn sync_push(app: AppHandle) -> Result<PushReport, String> {
    engine::push(&app).await
}

#[tauri::command]
pub async fn sync_pull(app: AppHandle) -> Result<PullReport, String> {
    engine::pull(&app).await
}

/// 重設本機（③重新加入的「拿掉」）：清 credstore（**含身分**）、sync_outbox、sync_cells、整張 sync_meta、enabled='0'。
/// 不碰 nodes／work_logs／occurrences／settings，不碰雲端。放回去＝再按「加入同步」＝新的一台。
#[tauri::command]
pub async fn sync_reset_local(app: AppHandle) -> Result<SyncStatus, String> {
    engine::reset_local(&app).await
}

/// 任何已加入的裝置都能產配對碼（契約 §4.6；payload v2：憑證＋root＋epoch，不含鹽與身分）。
#[tauri::command]
pub async fn sync_make_pairing_code(app: AppHandle) -> Result<String, String> {
    engine::make_pairing_code(&app).await
}

/// 解配對碼回四欄填表（**無副作用**；v1／v2 都吃）。主人照樣按「加入同步」。
#[tauri::command]
pub async fn sync_decode_pairing_code(_app: AppHandle, code: String) -> Result<PairingFields, String> {
    engine::decode_pairing_code(&code)
}

/// 改正待ち→「改用那份」：未推的 outbox 先匯出 JSON、清資料表與同步表、換上 pending_epoch。
/// 不 pull（TS 接著叫 `sync_pull` 拉全量）。沒有 pending_epoch 時回 Err。
#[tauri::command]
pub async fn sync_adopt_epoch(app: AppHandle) -> Result<AdoptReport, String> {
    engine::adopt_epoch(&app).await
}

/// 桌機：讀精靈寫的 `%LOCALAPPDATA%/NextStop/r2.env`，回四欄填表（主人仍要自己按「加入」）。手機回 Err。
#[tauri::command]
pub async fn sync_read_wizard_env(app: AppHandle) -> Result<WizardEnv, String> {
    engine::read_wizard_env(&app)
}
