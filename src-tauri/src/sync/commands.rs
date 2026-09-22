//! 同步的 `#[tauri::command]`（v1.1.3 契約 §4；invoke 名稱＝函式名，參數名＝JS args 物件的鍵）。
//!
//! v1.1.3 改了什麼（契約 §4.1 對照表；契約席 2026-09-21）：
//!   * `sync_configure` **拿掉** → `sync_join`（單一入口：填憑證→先列桶→第一台／直接拉／問一次／重接）。
//!   * `sync_apply_pairing_code` **改名** `sync_decode_pairing_code`（降為便利：只解碼回四欄，無副作用）。
//!   * `sync_begin_new_epoch` **改名** `sync_finish_restore`（讀標記檔的 choice：回到過去／接上現在）。
//!   * 新增 `sync_change_passphrase`（兩層鑰匙：重包 `<root>/KEY`）、`sync_restore_choice`（對話框的選擇先落檔）。
//!   * 其餘（status／set_enabled／push／pull／reset_local／make_pairing_code／adopt_epoch／read_wizard_env）同名。
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
    RestoreChoice, RestoreReport, SyncStatus, WizardEnv,
};

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

/// 改密語（契約 §4.4）：只重包 `<root>/KEY`，資料不重傳；舊血統升級後第一次＝封存（`sealed_first_time`）。
#[tauri::command]
pub async fn sync_change_passphrase(
    app: AppHandle,
    current: String,
    next: String,
) -> Result<PassphraseReport, String> {
    engine::change_passphrase(&app, &current, &next).await
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
