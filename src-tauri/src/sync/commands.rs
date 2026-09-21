//! 同步的八支 `#[tauri::command]`（v1.1.1 契約 §5；invoke 名稱＝函式名，參數名＝JS args 物件的鍵）
//! ＋ v1.1.2 三支（`sync_begin_new_epoch`／`sync_adopt_epoch`／`sync_read_wizard_env`；
//!   契約 docs/research/2026-09-19-v1.1.2-雙向同步契約.md §4、§7）。
//!
//! 全部回 `Result<T, String>`，Err 一律**人話**（沿 backup.rs 的口吻），且**不夾帶憑證與密語**。
//! 兩端（桌機／Android）都註冊。v1.1.2 起 `sync_push`／`sync_pull` **兩端都真的做事**
//!   （v1.1.1 的「副本不推、正本不拉」已作廢）；TS 的 invoke 名稱與 args 一個字都沒改。
//!
//! 這一層只做三件事：把 JS 的 args 轉成 engine 的型別、呼叫 engine、把結果原樣回去。
//! 所有判斷（角色、總開關、in-flight、LWW）都在 engine——command 薄一點，v1.1.2 換 engine 不必動這裡。

use serde::Deserialize;
use tauri::AppHandle;

use super::engine::{self, AdoptReport, ConfigureArgs, EpochReport, PullReport, PushReport, Role, SyncStatus, WizardEnv};

/// `sync_configure` 的參數（JS：`invoke("sync_configure", { input: {...} })`）
#[derive(Deserialize)]
pub struct ConfigureInput {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub passphrase: String,
    /// base64url 16B；primary 省略＝新生；replica 必填（來自配對碼）
    pub salt: Option<String>,
    /// primary 省略＝新生（13 位毫秒字串）；replica 必填
    pub epoch: Option<String>,
    pub role: Role,
    /// replica 必填（配對碼帶來）；primary 省略＝自己
    pub primary_device_id: Option<String>,
}

impl From<ConfigureInput> for ConfigureArgs {
    fn from(i: ConfigureInput) -> Self {
        ConfigureArgs {
            endpoint: i.endpoint,
            bucket: i.bucket,
            access_key_id: i.access_key_id,
            secret_access_key: i.secret_access_key,
            passphrase: i.passphrase,
            salt: i.salt,
            epoch: i.epoch,
            role: i.role,
            primary_device_id: i.primary_device_id,
        }
    }
}

/// 讀狀態；**首次呼叫順手 INSERT OR IGNORE `sync_meta.device_id`**（uuid v4）——這是 device_id 的唯一誕生點。
#[tauri::command]
pub async fn sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    engine::status(&app).await
}

/// 設定並啟用（primary：先 probe R2 → 派生金鑰 → 存 credstore → 寫 sync_meta → 全量快照進 outbox；
/// replica：同前四步＋空庫檢查在 `sync_apply_pairing_code` 已做）。成功回新狀態。
#[tauri::command]
pub async fn sync_configure(app: AppHandle, input: ConfigureInput) -> Result<SyncStatus, String> {
    engine::configure(&app, input.into()).await
}

/// 總開關（enabled '0'|'1'）。關＝不 push 不 pull、TS 端 outbox／cells 也停（SQL 端 WHERE EXISTS 看同一列）。
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

/// 重設本機：清 credstore、sync_outbox、sync_cells、sync_meta（**保留 device_id**）、enabled='0'。
/// 不碰 nodes／work_logs／occurrences／settings，不碰雲端。
#[tauri::command]
pub async fn sync_reset_local(app: AppHandle) -> Result<SyncStatus, String> {
    engine::reset_local(&app).await
}

/// primary 才能叫：回配對碼字串（契約 §6）。replica 叫回 Err。
#[tauri::command]
pub async fn sync_make_pairing_code(app: AppHandle) -> Result<String, String> {
    engine::make_pairing_code(&app).await
}

/// replica：解配對碼 → **空庫檢查**（`SELECT COUNT(*) FROM nodes WHERE deleted_at IS NULL` > 0 ⇒ Err 人話）
/// → `sync_configure(role=replica)` → 回狀態。之後由 UI 呼叫 `sync_pull` 拉全量。
#[tauri::command]
pub async fn sync_apply_pairing_code(
    app: AppHandle,
    code: String,
    passphrase: String,
    wipe: Option<bool>,
) -> Result<SyncStatus, String> {
    // wipe＝主人已確認「改用桌機的版本」（非空庫配對；v1.1.2 真機驗收後加）
    engine::apply_pairing_code(&app, &code, &passphrase, wipe.unwrap_or(false)).await
}

// ─── v1.1.2 ───

/// primary：還原之後「開新紀元」（D-1.1-4 甲）——清 outbox／cells、epoch＝新號、寫 EPOCH 標記物件、全庫快照進 outbox。
/// 不 push（TS 接著叫 `sync_push`）。replica 叫回 Err；還原的備份早於啟用同步 ⇒ 回 `outcome:"reenable"`
/// （本機同步設定已清掉，請主人重新啟用＋手機重新配對）。
#[tauri::command]
pub async fn sync_begin_new_epoch(app: AppHandle) -> Result<EpochReport, String> {
    engine::begin_new_epoch(&app).await
}

/// replica：主人確認「以桌機版本重置」——未推的 outbox 先匯出 JSON、清資料表與同步表、換上 pending_epoch。
/// 不 pull（TS 接著叫 `sync_pull` 拉全量）。沒有 pending_epoch 時回 Err。
#[tauri::command]
pub async fn sync_adopt_epoch(app: AppHandle) -> Result<AdoptReport, String> {
    engine::adopt_epoch(&app).await
}

/// 桌機：讀精靈寫的 `%LOCALAPPDATA%/NextStop/r2.env`，回四欄填表（主人仍要自己按「啟用」）。手機回 Err。
#[tauri::command]
pub async fn sync_read_wizard_env(app: AppHandle) -> Result<WizardEnv, String> {
    engine::read_wizard_env(&app)
}
