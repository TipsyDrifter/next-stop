//! 同步引擎——快照／push／pull／apply 的機制（v1.1.1 契約 §4、§7；**v1.1.2 起雙向**，
//! 延伸規格＝`docs/research/2026-09-19-v1.1.2-雙向同步契約.md` §2 雙向協定／§3 衝突／§4 還原紀元／§5 HLC 種子）。
//!
//! v1.1.2 改了什麼（拍板依據：D-1.1-4 還原＝新紀元、D-1.1-5 欄位級 LWW＋敗方入乘務記錄；
//! 〈v1.1.2 實施計畫補充〉自決 1～6；v1.1.1 回報 §6 #1／#7、§7）：
//!   * **兩端都 push、都 pull**：`push_inner`／`pull_inner` 拿掉 role 檢查；role 只剩
//!     「紀元權威（primary 才能開新紀元／產配對碼）」與「配對須空庫（replica）」兩個語義。
//!   * **游標 per-device**（`sync_meta.last_pull_key:<device_id>`）＋每趟 `list_prefixes` 發現裝置。
//!     為什麼不用單一游標：S3 的 list 是全域字典序，`…/<devA>/…` 永遠排在 `…/<devB>/…` 前面，
//!     單一游標推到 devB 之後就再也看不到 devA 新增的物件（契約 §2.2）。
//!   * **`OplogObject.seen`**：推送方把自己「已套用的各裝置最大 hlc」一起送出去，收到方才判得出
//!     「對方改這一欄時看過我這一版沒有」＝真併發（記 conflict）還是我單純落後（照套不記）。
//!   * **衝突＝敗方寫進該節點的乘務記錄**（`work_logs.event='conflict'`，Rust 直寫、天然不進 outbox）；
//!     **編輯勝刪除**兩個方向（收到刪除 vs 本機併發編輯 ⇒ 不套 deleted_at；本機已刪 vs 收到併發編輯 ⇒ 復活）。
//!   * **還原＝新紀元**：`backup_restore` 換檔後留標記檔 → 重啟 → primary 自動 `begin_new_epoch`
//!     （清游標／cells、epoch 換新、寫 `v1/<epoch>/EPOCH.bin`、全庫快照重上傳）；replica 偵測到更大的
//!     數字紀元且 EPOCH.bin 的 primary 是自己的正本 ⇒ `pending_epoch` → `phase=epoch_changed` → 主人確認
//!     → `adopt_epoch`（未推的 outbox 先匯出 JSON、清本機資料、換紀元、重拉全量）。
//!
//! 資料形狀（serde 欄位名＝TS `src/data/syncRepository.ts` 同名同形，snake_case 不轉 camel）：
//!   * `OplogObject` ＝ 一個 R2 物件拆封後的 JSON：{version:1, epoch, device_id, hlc_from, hlc_to, schema:4, ops:[…]}
//!   * `Op`          ＝ {hlc, tbl, row_id, op:'upsert'|'delete', cols:{col: value}}——與 sync_outbox 一列同形
//!   * `SyncStatus`  ＝ `sync_status()` 回給 UI 的全部（契約 §5.1）
//!
//! 機制摘要（契約 §7；WP7 已填）：
//!   * 啟用（primary）：`snapshot_into_outbox`——三張表**全部列（含 tombstone）**＋settings 白名單，每列一個
//!     upsert op、cols＝白名單全欄、hlc＝同一個新 hlc；同交易內 seed sync_cells。nodes 以遞迴 CTE 父先子後排序。
//!   * push（primary）：讀 outbox 依 seq → 組 `OplogObject`（hlc_from＝第一筆、hlc_to＝最後一筆）→ JSON → zstd →
//!     seal(aad=key) → put(key=`v1/<epoch>/<device_id>/<hlc_from>.bin`) → 同一交易 DELETE outbox WHERE seq<=max、
//!     sync_meta.last_push_hlc／last_sync_at。PUT 前先落 `inflight_key`／`inflight_max_seq`，PUT 成功而
//!     DB 失敗時下次憑它重組**同一段 op**＝同 key 同內容（評審 B2；不看它會用新內容蓋掉舊物件、靜默吃資料）。
//!   * pull（replica）：list_after(`v1/<epoch>/<primary_device_id>/`, last_pull_key) → 逐物件 get → open → 解 JSON
//!     → `schema > SCHEMA_VERSION` ⇒ 信号待ち（不推進游標、狀態 gated；**較舊**的物件照套＝前向相容，評審 S1）
//!     → 否則 `apply_object` 一個物件一個交易
//!     （`PRAGMA defer_foreign_keys = ON`；逐 op 逐欄比 sync_cells；COMMIT 前 `prune_fk_violations` 撤掉
//!       這趟剛塞進去的孤兒列；最後重算 line_id／route_id；更新 last_pull_key）。
//!   * apply 不觸發任何業務邏輯（不寫 issued／punched／done 事件、不跑 syncRepeats）；缺 NOT NULL 欄的 INSERT 跳過並記數。
//!
//! 狀態機（`phase`）：off（從沒設定）／paused（設定好但總開關關著）／running（運行中）／
//!   stopped（停車中：憑證缺或上次失敗）／gated（信号待ち）。
//! 總開關關著＝**只停網路**，變更照樣記進 outbox／cells（閘門看 `role` 不看 `enabled`，見
//!   `src/data/syncRepository.ts`）——開回來就補送，不會像評審 B1 指出的那樣整段丟掉。

/// oplog 物件格式版本（key 前綴 `v1/` 同步）
pub const OPLOG_VERSION: u32 = 1;

/// 一個物件最多帶幾筆 op（契約 §7.4）。太大就分多個物件，失敗重推的成本才有上限。
pub const PUSH_BATCH: i64 = 2000;

/// settings 只同步這幾把鑰匙（契約 §2.2／D-1.1-3）
pub const SYNC_SETTINGS_KEYS: &[&str] = &["day_start_hour"];

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Pool, Row, Sqlite};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

use super::credstore::{self, SyncCredentials};
use super::crypto;
use super::hlc;
use super::r2::{R2Client, R2Config};
use super::SCHEMA_VERSION;

/// 非空庫配對被擋時錯誤訊息的前綴記號（TS 端 `syncStore.pairReplica` 認這個字串來問確認）
pub const NEEDS_WIPE_MARK: &str = "NEEDS_WIPE:";

// ─────────────────────────────────────────────────────────────
// 欄白名單（契約 §2.2）
// ─────────────────────────────────────────────────────────────

/// 「主人資料」欄白名單。第二個欄位＝是不是整數欄（apply 時走 i64，其餘走文字或 NULL）。
///
/// 為什麼要有白名單：快取（`line_id`）與推導（有 repeat_rule 的 `scheduled_on`、lazy `today_position`）
/// 各台自算，搬過去只會互相打架；`account_id／device_id／synced_at` 這輪不用。
/// `route_id` 在表裡是快取，**只有根層臨時車票**那一筆是資料（路線標籤）——這個例外在快照端過濾（§2.2）。
pub fn columns_of(tbl: &str) -> Option<&'static [(&'static str, bool)]> {
    const NODES: &[(&str, bool)] = &[
        ("kind", false),
        ("parent_id", false),
        ("name", false),
        ("description", false),
        ("position", true),
        ("color", false),
        ("code", false),
        ("status", false),
        ("scheduled_on", false),
        ("due_on", false),
        ("priority", false),
        ("estimate_min", true),
        ("progress", true),
        ("time_spent_min", true),
        ("mood", false),
        ("repeat_rule", false),
        ("completed_at", false),
        ("expected_on", false),
        ("arrived_on", false),
        ("today_position", true),
        ("carried_from", false),
        ("route_id", false),
        ("created_at", false),
        ("updated_at", false),
        ("deleted_at", false),
    ];
    const WORK_LOGS: &[(&str, bool)] = &[
        ("node_id", false),
        ("body", false),
        ("logged_at", false),
        ("event", false),
        ("created_at", false),
        ("updated_at", false),
        ("deleted_at", false),
    ];
    const OCCURRENCES: &[(&str, bool)] = &[
        ("node_id", false),
        ("due_on", false),
        ("status", false),
        ("completed_at", false),
        ("mood", false),
        ("created_at", false),
        ("updated_at", false),
        ("deleted_at", false),
    ];
    const SETTINGS: &[(&str, bool)] = &[("value", false)];
    match tbl {
        "nodes" => Some(NODES),
        "work_logs" => Some(WORK_LOGS),
        "occurrences" => Some(OCCURRENCES),
        "settings" => Some(SETTINGS),
        _ => None,
    }
}

/// INSERT 時非有不可的欄（NOT NULL 且沒有 DEFAULT）。缺了就跳過整筆並計數（契約 §7.4）——
/// 這種情形只會出現在「replica 先收到子孫的 op、卻永遠收不到那一列的建立 op」的破碎狀態，
/// 硬塞會撞 NOT NULL 讓整個交易爆掉，寧可跳過一筆、其餘照收。
fn required_of(tbl: &str) -> &'static [&'static str] {
    match tbl {
        "nodes" => &["kind", "name"],
        "work_logs" => &["node_id", "body", "logged_at"],
        "occurrences" => &["node_id", "due_on", "status"],
        _ => &[],
    }
}

/// 主鍵欄名（settings 用 key，其餘用 id）
fn pk_of(tbl: &str) -> &'static str {
    if tbl == "settings" {
        "key"
    } else {
        "id"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Primary,
    Replica,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Primary => "primary",
            Role::Replica => "replica",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "primary" => Some(Role::Primary),
            "replica" => Some(Role::Replica),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Off,
    /// 已設定好、但總開關關著（評審 S1：「未啟用」以前同時代表「從沒設定」與「關著」，
    /// 主人看不出差別。關著＝只停網路，變更照樣記進 outbox，開回來就補送。）
    Paused,
    Running,
    Stopped,
    Gated,
    /// v1.1.2（D-1.1-4）：正本開了新紀元（還原後全庫重上傳）、這台還盯著舊紀元——等主人確認「以桌機版本重置」。
    /// 只有 replica 會進到這一態；`sync_meta.pending_epoch` 記著新紀元號（重啟後仍記得）。
    EpochChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    Upsert,
    Delete,
}

/// 一筆變更（＝sync_outbox 一列；payload 解成 cols）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Op {
    pub hlc: String,
    pub tbl: String,
    pub row_id: String,
    pub op: OpKind,
    pub cols: Map<String, Value>,
}

/// 一個 R2 物件拆封後的內容
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OplogObject {
    pub version: u32,
    pub epoch: String,
    pub device_id: String,
    pub hlc_from: String,
    pub hlc_to: String,
    pub schema: u32,
    /// v1.1.2 雙向：推送這個物件時，本機**已套用**的各裝置最大 hlc（`sync_meta.seen:<device_id>` 全部）。
    /// 衝突判定的依據（v1.1.2 契約 §3）：收到方的某一格若由自己寫、且 hlc 晚於對方 `seen[自己]`，
    /// 代表對方改那一欄時**沒看過**我這一版＝真的併發＝記 conflict 事件；否則只是我落後、照套不記。
    /// v1.1.1 的舊物件沒有這欄（serde default＝空 map）＝一律視為「對方什麼都沒看過」。
    #[serde(default)]
    pub seen: std::collections::BTreeMap<String, String>,
    pub ops: Vec<Op>,
}

/// 物件的**前兩個版號**，單獨解一次（評審 S7）。
///
/// 為什麼要分兩段解：信号待ち的閘門本來排在 `from_slice::<OplogObject>` 之後，可是「對方比較新」
/// 最可能的表現方式就是 `ops` 的形狀變了——那時整包解析先失敗、回「格式看不懂」、游標不推進，
/// 每 60 秒重炸同一顆物件，閘門永遠到不了＝前向相容名存實亡。先只解這兩個數字（serde 會忽略
/// 其餘欄位），判得出「該等對方」就乾淨地停在信号待ち。
#[derive(Deserialize)]
struct OplogHead {
    version: u32,
    schema: u32,
}

/// `sync_status()` 的回傳（契約 §5.1）
#[derive(Debug, Clone, Serialize)]
pub struct SyncStatus {
    pub enabled: bool,
    pub role: Option<Role>,
    pub device_id: String,
    pub epoch: Option<String>,
    /// credstore 有憑證
    pub configured: bool,
    pub phase: Phase,
    /// 目前有 push／pull 在飛
    pub busy: bool,
    /// UTC ISO；null＝還沒成功過
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    /// outbox 待上傳筆數。v1.1.2 起**兩端都照實回報**（v1.1.1 的「replica 恆 0」作廢——
    /// 那時副本永遠不送、數字只會往上跳；現在會送出去，數字會歸零，報實數才有意義）。
    pub pending_ops: u64,
    pub schema: u32,
    /// 信号待ち時對方物件的 schema
    pub remote_schema: Option<u32>,
    /// v1.1.2：還原剛完成、尚未開新紀元（`app_data_dir/sync/epoch-pending` 標記檔在）；
    /// primary 端 boot 看到就叫 `sync_begin_new_epoch`（契約 §4）
    pub restore_pending: bool,
    /// v1.1.2：replica 偵測到的新紀元號（`sync_meta.pending_epoch`）；非 null ⇒ phase=epoch_changed
    pub pending_epoch: Option<String>,
    /// v1.1.2 產品評審 B1：上一次「改用桌機的版本」另存了幾筆未送出的修改、存在哪、什麼時候。
    /// 同步頁常駐一行——不然這件事只在一聲 10 秒的 toast 裡講過，錯過就再也查不到。
    pub last_orphans: Option<LastOrphans>,
}

/// 上一次重置時另存的未同步修改（見 `SyncStatus::last_orphans`）
#[derive(Debug, Clone, Serialize)]
pub struct LastOrphans {
    pub count: u64,
    pub path: String,
    /// UTC ISO
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PushReport {
    pub pushed_ops: u64,
    pub object_key: Option<String>,
    /// 另一趟 push／pull 正在飛、這趟什麼都沒做（v1.1.1 回報 §6 #1：UI 要能說「另一趟進行中」而不是「沒東西」）
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullReport {
    pub objects: u64,
    pub applied_ops: u64,
    pub skipped_ops: u64,
    pub gated: bool,
    /// 有被改到的表（UI 據此決定重載什麼：nodes／work_logs／occurrences／settings）
    pub changed_tables: Vec<String>,
    /// 另一趟正在飛、這趟什麼都沒做（同 PushReport.busy）
    pub busy: bool,
    /// v1.1.2：這趟記了幾筆 conflict 事件（乘務記錄）
    pub conflicts: u64,
    /// v1.1.2：這趟收到的最大 hlc（TS 端 `seedHlc` 用；None＝沒收到東西）
    pub max_hlc: Option<String>,
}

/// managed state。
///
/// 與契約 §5.2 的小差異（不影響 TS）：`busy` 從 `Runtime` 提到外面當 `AtomicBool`，
/// `Runtime` 改用 `std::sync::Mutex`、也不再快取憑證。理由有二：
///   ① `sync_status()` 必須**永遠不被阻塞**——push 一跑就是好幾秒的網路往返，UI 每 60 秒還要問狀態；
///      把 busy 放進同一把鎖裡，status 就得等 push 做完才答得出「正在忙」，等於自相矛盾。
///   ② 憑證每次從 credstore 現讀（keyring 讀取是毫秒級），少一份記憶體副本、也不會在
///      `sync_reset_local` 之後留下失效的快取。鎖內不跨 await。
#[derive(Default)]
pub struct SyncState {
    pub busy: AtomicBool,
    pub inner: std::sync::Mutex<Runtime>,
}

#[derive(Default)]
pub struct Runtime {
    /// 上次 pull 撞到「對方 schema 不同」時記下的對方 schema（＝信号待ち的理由）
    pub gated_remote_schema: Option<u32>,
}

impl SyncState {
    fn read_gate(&self) -> Option<u32> {
        self.inner.lock().ok().and_then(|r| r.gated_remote_schema)
    }
    fn set_gate(&self, v: Option<u32>) {
        if let Ok(mut r) = self.inner.lock() {
            r.gated_remote_schema = v;
        }
    }
}

/// in-flight 守衛：push／pull 同時只跑一趟（契約 §5.2；搶不到就回空報告，UI 不必特判）
struct BusyGuard<'a>(&'a AtomicBool);

impl<'a> BusyGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| BusyGuard(flag))
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// 從 plugin-sql 的 `DbInstances` 借 pool（與 backup.rs 同一手法；沒有＝前端還沒 `Database.load()`）
pub async fn pool(app: &AppHandle) -> Result<Pool<Sqlite>, String> {
    use tauri_plugin_sql::{DbInstances, DbPool};
    let instances = app
        .try_state::<DbInstances>()
        .ok_or_else(|| "資料庫還沒載入（sql plugin 尚未連線）。".to_string())?;
    let lock = instances.0.read().await;
    let pool = lock
        .get(crate::sync::DB_URL)
        .ok_or_else(|| format!("找不到已連線的資料庫 {}。", crate::sync::DB_URL))?;
    let DbPool::Sqlite(pool) = pool;
    Ok(pool.clone())
}

fn db_err(e: sqlx::Error) -> String {
    format!("同步的資料庫操作失敗：{e}")
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ─────────────────────────────────────────────────────────────
// sync_meta 小工具
// ─────────────────────────────────────────────────────────────

async fn meta_all<'e, E>(ex: E) -> Result<HashMap<String, String>, String>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    let rows = sqlx::query("SELECT key, value FROM sync_meta")
        .fetch_all(ex)
        .await
        .map_err(db_err)?;
    let mut map = HashMap::new();
    for r in rows {
        let k: String = r.try_get("key").map_err(db_err)?;
        let v: String = r.try_get("value").map_err(db_err)?;
        map.insert(k, v);
    }
    Ok(map)
}

async fn meta_set<'e, E>(ex: E, key: &str, value: &str) -> Result<(), String>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO sync_meta (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(ex)
    .await
    .map_err(db_err)?;
    Ok(())
}

/// 只有值真的變了才寫。
///
/// 為什麼要這一層：`sync_status()` 每 60 秒被問一次，而 `schema_gate`／`last_error` 絕大多數時候
/// 根本沒變；每次都 INSERT…ON CONFLICT 等於每分鐘開一次寫入交易、讓 WAL 白白長大。
/// 同步關著的桌機更不該因為「被問了狀態」就動到資料庫（鐵則：既有行為零改變）。
async fn meta_set_if_changed(
    pool: &Pool<Sqlite>,
    current: Option<&String>,
    key: &str,
    value: &str,
) -> Result<(), String> {
    if current.map(String::as_str) == Some(value) {
        return Ok(());
    }
    meta_set(pool, key, value).await
}

/// device_id 的**唯一誕生點**（契約 §3）：首次呼叫 `sync_status()` 時 INSERT OR IGNORE。
/// `sync_reset_local` 保留它——重設之後還是同一台車。
async fn ensure_device_id(pool: &Pool<Sqlite>) -> Result<String, String> {
    if let Some(row) = sqlx::query("SELECT value FROM sync_meta WHERE key = 'device_id'")
        .fetch_optional(pool)
        .await
        .map_err(db_err)?
    {
        return row.try_get::<String, _>("value").map_err(db_err);
    }
    let fresh = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('device_id', ?)")
        .bind(&fresh)
        .execute(pool)
        .await
        .map_err(db_err)?;
    let row = sqlx::query("SELECT value FROM sync_meta WHERE key = 'device_id'")
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    row.try_get::<String, _>("value").map_err(db_err)
}

/// 本機已知最大的 hlc（outbox ∪ cells）——Rust 產 hlc 的種子（契約 §3）
async fn max_hlc(pool: &Pool<Sqlite>) -> Result<Option<String>, String> {
    let row = sqlx::query(
        "SELECT MAX(m) AS m FROM (SELECT MAX(hlc) AS m FROM sync_outbox \
         UNION ALL SELECT MAX(hlc) AS m FROM sync_cells)",
    )
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    row.try_get::<Option<String>, _>("m").map_err(db_err)
}

/// 清掉 push 的 in-flight 標記（評審 B2；`inflight_key`／`inflight_max_seq` 兩把一起）
async fn clear_inflight(pool: &Pool<Sqlite>) -> Result<(), String> {
    sqlx::query("DELETE FROM sync_meta WHERE key IN ('inflight_key','inflight_max_seq')")
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

/// 失敗時把人話寫進 `sync_meta.last_error`（重啟後 UI 還看得到「停車中」的理由）
async fn record_error(pool: &Pool<Sqlite>, msg: &str) {
    let _ = meta_set(pool, "last_error", msg).await;
}

async fn record_success(pool: &Pool<Sqlite>) -> Result<(), String> {
    meta_set(pool, "last_sync_at", &now_iso()).await?;
    clear_error(pool).await
}

/// 清掉上次的錯誤（本來就是空的就什麼都不做——見 `meta_set_if_changed` 的理由）
async fn clear_error(pool: &Pool<Sqlite>) -> Result<(), String> {
    let current = sqlx::query("SELECT value FROM sync_meta WHERE key = 'last_error'")
        .fetch_optional(pool)
        .await
        .map_err(db_err)?
        .map(|r| r.try_get::<String, _>("value"))
        .transpose()
        .map_err(db_err)?;
    meta_set_if_changed(pool, current.as_ref(), "last_error", "").await
}

// ─────────────────────────────────────────────────────────────
// 狀態
// ─────────────────────────────────────────────────────────────

pub async fn status(app: &AppHandle) -> Result<SyncStatus, String> {
    let pool = pool(app).await?;
    let device_id = ensure_device_id(&pool).await?;
    let meta = meta_all(&pool).await?;
    // 診斷用：把本機引擎的 schema 記在庫裡，日後看 DB 就知道這顆庫是哪一版引擎碰過的
    meta_set_if_changed(
        &pool,
        meta.get("schema_gate"),
        "schema_gate",
        &SCHEMA_VERSION.to_string(),
    )
    .await?;

    // 憑證壞掉不該讓 status 整個失敗——UI 要能顯示「停車中」＋原因，主人才知道要按重設
    let (configured, cred_error) = match credstore::load(app) {
        Ok(v) => (v.is_some(), None),
        Err(e) => (false, Some(e)),
    };

    let pending_ops: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sync_outbox")
        .fetch_one(&pool)
        .await
        .map_err(db_err)?
        .try_get("n")
        .map_err(db_err)?;

    let (busy, remote_schema) = match app.try_state::<SyncState>() {
        Some(st) => (st.busy.load(Ordering::Acquire), st.read_gate()),
        None => (false, None),
    };

    let enabled = meta.get("enabled").map(String::as_str) == Some("1");
    let role = meta.get("role").and_then(|s| Role::parse(s));
    let last_error = cred_error.or_else(|| {
        meta.get("last_error")
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    });

    // 四→五態（評審 S1）：從沒設定＝off、設定好但關著＝paused，兩者不再共用同一個字。
    let phase = if !enabled && !configured {
        Phase::Off
    } else if !enabled {
        Phase::Paused
    } else if meta.get("pending_epoch").is_some_and(|e| !e.is_empty()) {
        Phase::EpochChanged
    } else if remote_schema.is_some() {
        Phase::Gated
    } else if !configured || last_error.is_some() {
        Phase::Stopped
    } else {
        Phase::Running
    };

    // 還原標記檔（契約 §4.1）：只有正本開得了新紀元。
    // **replica 身上的標記順手刪掉**——桌機 replica 沙盒還原舊備份時會留下它，留著只會讓 TS 每次
    // boot 都白問一次。`role` 還沒設定（＝還原的備份早於啟用同步）的標記**要留著**：那一台的
    // `begin_new_epoch` 會走 Reenable 分支（清掉失效的憑證與設定、請主人重新啟用），刪了就沒人清。
    // 評審 S2：**從沒啟用過同步**的桌機（role 缺、憑證也缺）還原備份時，以前這個標記照樣留著，
    // TS 的 `boot()` 看 `role !== "replica"` 就叫 `begin_new_epoch`，Rust 那邊走 Reenable 分支：
    // 寫 `enabled=0`、碰鑰匙圈、跳一句「還原的備份早於啟用同步——請重新啟用同步，手機也要重新配對」。
    // 主人根本沒設定過同步，卻被告知同步壞了——違反「同步關著時桌機零改變」。
    // 契約 §4.1 的 Reenable 針對的是「role 缺**但**憑證還在」（設定過、只是還原到更早的備份）。
    let mut restore_pending = is_restore_pending(app);
    if restore_pending && (role == Some(Role::Replica) || (role.is_none() && !configured)) {
        clear_restore_pending(app);
        restore_pending = false;
    }

    Ok(SyncStatus {
        enabled,
        role,
        device_id,
        epoch: meta.get("epoch").cloned(),
        configured,
        phase,
        busy,
        last_sync_at: meta.get("last_sync_at").filter(|s| !s.is_empty()).cloned(),
        last_error,
        // v1.1.2：兩端照實回報（見欄位註解）
        pending_ops: pending_ops.max(0) as u64,
        schema: SCHEMA_VERSION,
        remote_schema,
        restore_pending,
        pending_epoch: meta.get("pending_epoch").filter(|s| !s.is_empty()).cloned(),
        last_orphans: meta
            .get("last_orphans_count")
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .map(|count| LastOrphans {
                count,
                path: meta.get("last_orphans_path").cloned().unwrap_or_default(),
                at: meta.get("last_orphans_at").cloned().unwrap_or_default(),
            }),
    })
}

// ─────────────────────────────────────────────────────────────
// 設定／重設／配對碼
// ─────────────────────────────────────────────────────────────

/// `sync_configure` 的參數（commands.rs 的 `ConfigureInput` 轉過來）
pub struct ConfigureArgs {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub passphrase: String,
    pub salt: Option<String>,
    pub epoch: Option<String>,
    pub role: Role,
    pub primary_device_id: Option<String>,
}

pub async fn configure(app: &AppHandle, args: ConfigureArgs) -> Result<SyncStatus, String> {
    // 評審 S3：configure／reset_local 以前沒有 in-flight 守衛——pull 在飛時重設，
    // 那趟 pull 的交易會把 `last_pull_key` 寫回剛被清掉的 sync_meta，留下孤兒游標。
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    let pool = pool(app).await?;
    let device_id = ensure_device_id(&pool).await?;

    let endpoint = args.endpoint.trim().to_string();
    let bucket = args.bucket.trim().to_string();
    let access_key_id = args.access_key_id.trim().to_string();
    let secret_access_key = args.secret_access_key.trim().to_string();
    if endpoint.is_empty() || bucket.is_empty() || access_key_id.is_empty() || secret_access_key.is_empty()
    {
        return Err("雲端置物櫃的四個欄位都要填。".into());
    }

    // salt／epoch：primary 省略＝現生；replica 一定是配對碼帶來的（兩台必須同一組，否則金鑰與路徑都對不上）
    let salt_bytes = match args.salt.as_deref() {
        Some(s) if !s.trim().is_empty() => {
            let v = crypto::b64_decode(s)?;
            if v.len() != crypto::SALT_LEN {
                return Err("配對碼裡的鹽長度不對。".into());
            }
            v
        }
        _ => crypto::random_salt()?.to_vec(),
    };
    let epoch = match args.epoch.as_deref() {
        Some(e) if !e.trim().is_empty() => e.trim().to_string(),
        _ => hlc::now_ms().to_string(),
    };
    let primary_device_id = match args.primary_device_id.as_deref() {
        Some(d) if !d.trim().is_empty() => d.trim().to_string(),
        _ => device_id.clone(),
    };

    // ① 派生金鑰（argon2id，19 MiB／數百 ms）②驗憑證（一次 list，Class B）——兩件都成了才動資料庫。
    // 評審 S7：argon2 是 CPU 密集的同步工作，直接跑在 tokio worker 上會卡住整個 runtime
    // （手機低階機最明顯），故丟 spawn_blocking。
    let key = {
        let passphrase = args.passphrase.clone();
        let salt = salt_bytes.clone();
        tauri::async_runtime::spawn_blocking(move || crypto::derive_key(&passphrase, &salt))
            .await
            .map_err(|_| "金鑰派生被中斷了，請再試一次。".to_string())??
    };
    let client = R2Client::new(R2Config {
        endpoint: endpoint.clone(),
        bucket: bucket.clone(),
        access_key_id: access_key_id.clone(),
        secret_access_key: secret_access_key.clone(),
    })?;
    client.probe("v1/").await?;

    credstore::save(
        app,
        &SyncCredentials {
            endpoint,
            bucket,
            access_key_id,
            secret_access_key,
            key_b64: crypto::b64_encode(&key),
        },
    )?;

    meta_set(&pool, "role", args.role.as_str()).await?;
    meta_set(&pool, "epoch", &epoch).await?;
    meta_set(&pool, "salt", &crypto::b64_encode(&salt_bytes)).await?;
    meta_set(&pool, "primary_device_id", &primary_device_id).await?;
    meta_set(&pool, "last_error", "").await?;
    // 評審 S2：重新 configure 會換 epoch，舊游標拿到新 epoch 的前綴上會被當 offset 用（r2.rs 的
    // `list_with_offset` 是「嚴格大於」），等於一開始就跳過一段。換一組設定就把游標與 in-flight 全清掉。
    // v1.1.2：游標與 `seen` 都是 per-device（`last_pull_key:<dev>`／`seen:<dev>`），一併清——
    // 共用同一句 `EPOCH_SCOPED_META`，免得日後多一把鍵時漏掉其中一處。
    sqlx::query(EPOCH_SCOPED_META)
        .execute(&pool)
        .await
        .map_err(db_err)?;

    // 快照寫完才開總開關（評審 S2）：以前 `enabled='1'` 在快照之前，快照失敗就留下
    // 「開著卻沒有快照」的半套狀態。outbox 的閘門看的是 `role`（不是 `enabled`），
    // 所以這個順序不會讓快照寫不進去。
    if args.role == Role::Primary {
        snapshot_into_outbox(&pool, &device_id).await?;
    }
    meta_set(&pool, "enabled", "1").await?;

    st.set_gate(None);
    drop(_busy); // 先放掉守衛，`status()` 才不會把自己回報成「忙碌中」
    status(app).await
}

/// 總開關。
///
/// 語義（評審 B1 改判）：**關著＝只停網路，不是斷線**。outbox／cells 的閘門看的是 `sync_meta.role`
/// （見 `src/data/syncRepository.ts` 的 `CONFIGURED_GATE`），所以關著期間的每一筆變更照樣入列，
/// 開回來就照原本的 hlc 補送上去——不必重拍快照，也不會像以前那樣把那段時間的修改永遠丟掉
/// （舊行為還會讓副本收到「父列從未建立」的子列 op，FK 在 COMMIT 時爆掉、游標卡死）。
pub async fn set_enabled(app: &AppHandle, enabled: bool) -> Result<SyncStatus, String> {
    let pool = pool(app).await?;
    meta_set(&pool, "enabled", if enabled { "1" } else { "0" }).await?;
    status(app).await
}

/// 重設本機：清憑證／outbox／cells／meta（保留 device_id），總開關關閉。**不碰資料列、不碰雲端**。
pub async fn reset_local(app: &AppHandle) -> Result<SyncStatus, String> {
    // 評審 S3：同 configure——pull／push 在飛時重設會留下孤兒 meta
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    let pool = pool(app).await?;
    credstore::clear(app)?;
    let mut tx = pool.begin().await.map_err(db_err)?;
    sqlx::query("DELETE FROM sync_outbox")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM sync_cells")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM sync_meta WHERE key <> 'device_id'")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    meta_set(&mut *tx, "enabled", "0").await?;
    tx.commit().await.map_err(db_err)?;
    st.set_gate(None);
    drop(_busy);
    status(app).await
}

/// 配對碼的內容（契約 §6）。**不 derive Debug**：裡面有 R2 的 access key／secret。
#[derive(Serialize, Deserialize)]
struct PairingCode {
    v: u32,
    endpoint: String,
    bucket: String,
    ak: String,
    sk: String,
    salt: String,
    epoch: String,
    primary_device_id: String,
}

pub async fn make_pairing_code(app: &AppHandle) -> Result<String, String> {
    let pool = pool(app).await?;
    let meta = meta_all(&pool).await?;
    if meta.get("role").map(String::as_str) != Some("primary") {
        return Err("只有正本（桌機）能產生配對碼。".into());
    }
    let creds = credstore::load(app)?.ok_or_else(|| "這台還沒啟用同步。".to_string())?;
    let incomplete = || "同步設定不完整，請重設後重新啟用。".to_string();
    let code = PairingCode {
        v: 1,
        endpoint: creds.endpoint,
        bucket: creds.bucket,
        ak: creds.access_key_id,
        sk: creds.secret_access_key,
        salt: meta.get("salt").cloned().ok_or_else(incomplete)?,
        epoch: meta.get("epoch").cloned().ok_or_else(incomplete)?,
        primary_device_id: meta.get("primary_device_id").cloned().ok_or_else(incomplete)?,
    };
    let json = serde_json::to_vec(&code).map_err(|_| "產生配對碼失敗。".to_string())?;
    Ok(crypto::b64_encode(&json))
}

pub async fn apply_pairing_code(
    app: &AppHandle,
    code: &str,
    passphrase: &str,
    wipe: bool,
) -> Result<SyncStatus, String> {
    let broken = || "配對碼看起來不完整，請重新複製一次。".to_string();
    let raw = crypto::b64_decode(code.trim()).map_err(|_| broken())?;
    let parsed: PairingCode = serde_json::from_slice(&raw).map_err(|_| broken())?;
    if parsed.v != 1 {
        return Err("這張配對碼是新版格式，請先把兩台都更新到同一版。".into());
    }

    // 空庫檢查（快問拍板）：手機是副本，配對會把正本整包蓋過來；先有資料就一定要主人自己決定怎麼辦
    let pool = pool(app).await?;
    let alive: i64 = sqlx::query("SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL")
        .fetch_one(&pool)
        .await
        .map_err(db_err)?
        .try_get("n")
        .map_err(db_err)?;
    if alive > 0 && !wipe {
        // 主人真機驗收（2026-09-20）：重設後再配對被擋、文案叫人解除安裝——太重。
        // 改成回一個帶記號的錯，UI 接到就問「要改用桌機的版本嗎？」，同意再帶 wipe=true 回來。
        return Err(format!(
            "{NEEDS_WIPE_MARK}這台已經有 {alive} 筆資料。配對會改用桌機的版本——這台的車票與記錄會被取代，還沒送出的修改會先存檔。"
        ));
    }
    if alive > 0 {
        // 同 adopt_epoch 的兩步：先把 outbox 匯出成檔（不靜默丟），再整表清空。
        let meta = meta_all(&pool).await?;
        let device_id = meta.get("device_id").cloned().unwrap_or_default();
        let old_epoch = meta.get("epoch").cloned().unwrap_or_default();
        let (orphan_ops, orphans_path) =
            export_outbox_orphans(app, &pool, &device_id, &old_epoch, &parsed.epoch).await?;
        let mut tx = pool.begin().await.map_err(db_err)?;
        wipe_local_data(&mut tx).await?;
        if orphan_ops > 0 {
            meta_set(&mut *tx, "last_orphans_count", &orphan_ops.to_string()).await?;
            meta_set(&mut *tx, "last_orphans_path", orphans_path.as_deref().unwrap_or("")).await?;
            meta_set(&mut *tx, "last_orphans_at", &now_iso()).await?;
        }
        tx.commit().await.map_err(db_err)?;
    }

    configure(
        app,
        ConfigureArgs {
            endpoint: parsed.endpoint,
            bucket: parsed.bucket,
            access_key_id: parsed.ak,
            secret_access_key: parsed.sk,
            passphrase: passphrase.to_string(),
            salt: Some(parsed.salt),
            epoch: Some(parsed.epoch),
            role: Role::Replica,
            primary_device_id: Some(parsed.primary_device_id),
        },
    )
    .await
}

// ─────────────────────────────────────────────────────────────
// 快照（primary 啟用時）
// ─────────────────────────────────────────────────────────────

/// 一列 → cols（只取白名單欄；型別由白名單第二欄決定）
fn row_to_cols(
    row: &sqlx::sqlite::SqliteRow,
    spec: &[(&'static str, bool)],
) -> Result<Map<String, Value>, String> {
    let mut cols = Map::new();
    for (name, is_int) in spec {
        let v = if *is_int {
            match row.try_get::<Option<i64>, _>(*name).map_err(db_err)? {
                Some(n) => Value::from(n),
                None => Value::Null,
            }
        } else {
            match row.try_get::<Option<String>, _>(*name).map_err(db_err)? {
                Some(s) => Value::from(s),
                None => Value::Null,
            }
        };
        cols.insert((*name).to_string(), v);
    }
    Ok(cols)
}

/// 全量快照進 outbox（契約 §4.3）：三張表**全部列（含 tombstone）**＋settings 白名單，
/// 每列一筆 upsert op、**各自一個遞增的 hlc**；同一交易順手 seed `sync_cells`。
///
/// 為什麼含 tombstone：不然主人之後「復原」某張票時，那筆 `deleted_at=NULL` 的 op 在副本上
/// 會找不到列可改（副本從來沒收過它），復原就傳不過去。
///
/// 為什麼每筆各自一個 hlc（v1.1.2 評審 B1）：以前整份快照共用同一個 `stamp`。push 的物件名＝
/// `v1/<epoch>/<device>/<該批第一筆 hlc>.bin`，於是快照超過 `PUSH_BATCH` 筆時，第二批的第一筆 hlc
/// 與第一批**完全相同** ⇒ 同一個 key 被 PUT 覆蓋。副本若已拉過第一批（游標就是那個 key，
/// `list_after` 嚴格大於）就再也 list 不到第二批＝**靜默吃掉資料**。改成沿著 `hlc::next` 往下鏈
/// （同毫秒靠 count 遞增，65535／毫秒綽綽有餘），順序就是快照順序（父先子後），key 自然唯一。
pub async fn snapshot_into_outbox(pool: &Pool<Sqlite>, device_id: &str) -> Result<u64, String> {
    let mut stamp = max_hlc(pool).await?;
    let now = hlc::now_ms();
    // 取下一個 hlc 並把游標往前推（三個產生點共用；`now` 只讀一次，其餘靠 count 遞增）
    let next_stamp = |prev: &mut Option<String>| -> String {
        let h = hlc::next(prev.as_deref(), now, device_id);
        *prev = Some(h.clone());
        h
    };

    let mut ops: Vec<Op> = Vec::new();

    // nodes：父先子後（遞迴 CTE；孤兒列＝父不存在的，也當根層收進來，不漏）
    let node_spec = columns_of("nodes").expect("nodes 在白名單裡");
    let rows = sqlx::query(
        "WITH RECURSIVE tree(id, depth) AS ( \
            SELECT id, 0 FROM nodes WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM nodes) \
            UNION ALL \
            SELECT n.id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id WHERE t.depth < 50 \
         ) \
         SELECT n.*, t.depth AS _depth FROM nodes n JOIN tree t ON t.id = n.id ORDER BY t.depth, n.position",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    for row in &rows {
        let id: String = row.try_get("id").map_err(db_err)?;
        let mut cols = row_to_cols(row, node_spec)?;
        // route_id 只有「根層臨時車票」那一筆是資料（路線標籤）；其餘是快取，副本自己重算（契約 §2.2）
        let is_root_ticket = row
            .try_get::<Option<String>, _>("parent_id")
            .map_err(db_err)?
            .is_none()
            && row.try_get::<String, _>("kind").map_err(db_err)? == "ticket";
        if !is_root_ticket {
            cols.remove("route_id");
        }
        ops.push(Op {
            hlc: next_stamp(&mut stamp),
            tbl: "nodes".into(),
            row_id: id,
            op: OpKind::Upsert,
            cols,
        });
    }

    // work_logs 排除 `event='conflict'`（v1.1.2 契約 §3.4）：衝突日誌是**各台自己**在 apply 時記的
    // 「我這一版被誰蓋掉了」，本來就不進 outbox；快照若把它們一起搬走，開新紀元或重新配對之後
    // 另一台就會長出一堆不屬於它的競合紀錄。
    for (tbl, order, filter) in [
        ("work_logs", "logged_at", " WHERE event IS NULL OR event <> 'conflict'"),
        ("occurrences", "due_on", ""),
    ] {
        let spec = columns_of(tbl).expect("表在白名單裡");
        let rows = sqlx::query(&format!("SELECT * FROM {tbl}{filter} ORDER BY {order}"))
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
        for row in &rows {
            let id: String = row.try_get("id").map_err(db_err)?;
            let cols = row_to_cols(row, spec)?;
            ops.push(Op {
                hlc: next_stamp(&mut stamp),
                tbl: tbl.to_string(),
                row_id: id,
                op: OpKind::Upsert,
                cols,
            });
        }
    }

    // settings 只搬白名單（day_start_hour）
    for key in SYNC_SETTINGS_KEYS {
        let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
        if let Some(row) = row {
            let value: String = row.try_get("value").map_err(db_err)?;
            let mut cols = Map::new();
            cols.insert("value".into(), Value::from(value));
            ops.push(Op {
                hlc: next_stamp(&mut stamp),
                tbl: "settings".into(),
                row_id: (*key).to_string(),
                op: OpKind::Upsert,
                cols,
            });
        }
    }

    let mut tx = pool.begin().await.map_err(db_err)?;
    for op in &ops {
        let payload = serde_json::to_string(&op.cols).map_err(|_| "快照序列化失敗。".to_string())?;
        sqlx::query(
            "INSERT INTO sync_outbox (hlc, tbl, row_id, op, payload) VALUES (?, ?, ?, 'upsert', ?)",
        )
        .bind(&op.hlc)
        .bind(&op.tbl)
        .bind(&op.row_id)
        .bind(&payload)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        for col in op.cols.keys() {
            stamp_cell(&mut tx, &op.tbl, &op.row_id, col, &op.hlc, device_id).await?;
        }
    }
    tx.commit().await.map_err(db_err)?;
    Ok(ops.len() as u64)
}

/// 戳一格 `sync_cells`（較舊的 hlc 不覆蓋較新——LWW 在本機也成立）
async fn stamp_cell(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    tbl: &str,
    row_id: &str,
    col: &str,
    hlc: &str,
    device_id: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO sync_cells (tbl, row_id, col, hlc, device_id) VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(tbl, row_id, col) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id \
         WHERE excluded.hlc > sync_cells.hlc",
    )
    .bind(tbl)
    .bind(row_id)
    .bind(col)
    .bind(hlc)
    .bind(device_id)
    .execute(&mut **tx)
    .await
    .map_err(db_err)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// push（primary）
// ─────────────────────────────────────────────────────────────

pub async fn push(app: &AppHandle) -> Result<PushReport, String> {
    let empty = PushReport {
        pushed_ops: 0,
        object_key: None,
        busy: false,
    };
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Ok(PushReport { busy: true, ..empty }); // 已經有一趟在飛：回空報告＋busy（UI 說「另一趟進行中」）
    };
    let pool = pool(app).await?;
    match push_inner(app, &pool).await {
        Ok(report) => Ok(report),
        Err(e) => {
            record_error(&pool, &e).await;
            Err(e)
        }
    }
}

async fn push_inner(app: &AppHandle, pool: &Pool<Sqlite>) -> Result<PushReport, String> {
    let empty = PushReport {
        pushed_ops: 0,
        object_key: None,
        busy: false,
    };
    let device_id = ensure_device_id(pool).await?;
    let meta = meta_all(pool).await?;
    if meta.get("enabled").map(String::as_str) != Some("1") {
        return Ok(empty);
    }
    // v1.1.2 雙向（契約 §2.3）：**拿掉 role 檢查**——副本也推自己的物件。
    // 只剩「設定不完整就不動」這一關：沒有 role＝根本沒設定過同步（閘門也沒開，outbox 必空）。
    let Some(role) = meta.get("role").and_then(|s| Role::parse(s)) else {
        return Ok(empty);
    };
    // 改正待ち（契約 §4.3）：正本已經開了新紀元、這台還盯著舊的。推上去只會把 op 丟進一個
    // 沒人會再讀的舊紀元目錄；那些修改的正確去處是 `adopt_epoch` 的孤兒 JSON。
    // （TS 的 `runCycle` 也不會叫，這裡是手動同步與競態的保險。）
    if meta.get("pending_epoch").is_some_and(|e| !e.is_empty()) {
        return Ok(empty);
    }
    let epoch = meta
        .get("epoch")
        .cloned()
        .ok_or_else(|| "同步設定不完整，請重設後重新啟用。".to_string())?;
    let creds = credstore::load(app)?.ok_or_else(|| "找不到同步憑證，請重新啟用同步。".to_string())?;
    let key = crypto::key_from_b64(&creds.key_b64)?;
    let client = R2Client::new(R2Config {
        endpoint: creds.endpoint,
        bucket: creds.bucket,
        access_key_id: creds.access_key_id,
        secret_access_key: creds.secret_access_key,
    })?;

    // 評審 B2：紀元偵測以前只在 pull 做，而一趟同步是**先 push 再 pull**。
    // 時序：桌機還原 → 開新紀元；手機下一趟先把這段期間蓋的章 push 進**舊紀元**（成功、outbox 清空），
    // pull 才偵測到新紀元 ⇒ `adopt_epoch` 匯出的孤兒 JSON 是空的。那些章正本永遠 list 不到，
    // 檔案也沒有——D-1.1-4「未同步修改先存本機 JSON」在這個窗口（還原到手機下次前景，可能數小時）
    // 完全失守，而且零痕跡。所以副本推之前先看一眼雲端有沒有更新的紀元（一次 Class B list）。
    if role == Role::Replica {
        if let Some(primary) = meta.get("primary_device_id").filter(|s| !s.is_empty()) {
            if let Some(newer) = detect_new_epoch(&client, &key, &epoch, primary).await? {
                meta_set(pool, "pending_epoch", &newer).await?;
                clear_error(pool).await?;
                return Ok(empty);
            }
        }
    }

    push_loop(pool, &client, &key, &epoch, &device_id).await
}

/// push 的核心迴圈（不吃 `AppHandle`，所以測得到——評審 B2 的冪等就是靠這支的 in-flight 標記）。
pub(crate) async fn push_loop(
    pool: &Pool<Sqlite>,
    client: &R2Client,
    key: &[u8; crypto::KEY_LEN],
    epoch: &str,
    device_id: &str,
) -> Result<PushReport, String> {
    let mut pushed: u64 = 0;
    let mut last_key: Option<String> = None;
    loop {
        // 評審 B2：上一趟「PUT 成功、DB 交易失敗」時留下的 in-flight 標記。
        // 不看它就會用「同一個 key、當下 outbox 的新內容」重推——key 相同、內容卻多了幾筆，
        // 副本若已拉過舊版（游標＝那個 key），多出來的 op 永遠不會再被 list 到＝靜默吃掉資料。
        // 看了它就把重推限制在 `seq <= inflight_max_seq`，內容必定與上次逐位元組相同（真冪等）。
        let meta_now = meta_all(pool).await?;
        let inflight_key = meta_now.get("inflight_key").filter(|s| !s.is_empty()).cloned();
        let inflight_max_seq: Option<i64> = meta_now
            .get("inflight_max_seq")
            .and_then(|s| s.parse::<i64>().ok());
        let resuming = inflight_key.is_some() && inflight_max_seq.is_some();

        // v1.1.2 §2.1：把「我已經套用到各裝置的哪一版」一起送出去。收到方憑它判別
        //   `本機那一格的 hlc > seen[寫那一格的裝置]` ⇒ 我改的時候沒看過那一版 ⇒ 真併發 ⇒ 記 conflict。
        // 每一圈重讀（同一趟 push 中間不會有 pull，但重推／多物件時多讀一次的成本可忽略）。
        let seen: std::collections::BTreeMap<String, String> = meta_now
            .iter()
            .filter_map(|(k, v)| k.strip_prefix("seen:").map(|d| (d.to_string(), v.clone())))
            .collect();

        let rows = match inflight_max_seq.filter(|_| resuming) {
            Some(cap) => sqlx::query(
                "SELECT seq, hlc, tbl, row_id, op, payload FROM sync_outbox WHERE seq <= ? ORDER BY seq LIMIT ?",
            )
            .bind(cap)
            .bind(PUSH_BATCH)
            .fetch_all(pool)
            .await
            .map_err(db_err)?,
            None => {
                sqlx::query("SELECT seq, hlc, tbl, row_id, op, payload FROM sync_outbox ORDER BY seq LIMIT ?")
                    .bind(PUSH_BATCH)
                    .fetch_all(pool)
                    .await
                    .map_err(db_err)?
            }
        };
        if rows.is_empty() {
            if resuming {
                // 標記還在、但該批已經不在 outbox 裡＝那趟其實整個成功了（或被重設清掉），清掉標記再跑一圈
                clear_inflight(pool).await?;
                continue;
            }
            break;
        }

        let mut ops = Vec::with_capacity(rows.len());
        let mut max_seq: i64 = 0;
        for row in &rows {
            max_seq = max_seq.max(row.try_get::<i64, _>("seq").map_err(db_err)?);
            let payload: String = row.try_get("payload").map_err(db_err)?;
            let cols: Map<String, Value> = serde_json::from_str(&payload)
                .map_err(|_| "待上傳佇列裡有一筆內容損壞，請重設同步後重新啟用。".to_string())?;
            let kind: String = row.try_get("op").map_err(db_err)?;
            ops.push(Op {
                hlc: row.try_get("hlc").map_err(db_err)?,
                tbl: row.try_get("tbl").map_err(db_err)?,
                row_id: row.try_get("row_id").map_err(db_err)?,
                op: if kind == "delete" {
                    OpKind::Delete
                } else {
                    OpKind::Upsert
                },
                cols,
            });
        }

        let hlc_from = ops.first().map(|o| o.hlc.clone()).unwrap_or_default();
        let hlc_to = ops.last().map(|o| o.hlc.clone()).unwrap_or_default();
        let object_key = inflight_key
            .clone()
            .unwrap_or_else(|| format!("v1/{epoch}/{device_id}/{hlc_from}.bin"));
        // 評審 B1 第二層：同一趟裡兩批算出同一個 key ⇒ 第二批會 PUT 覆蓋第一批（副本永遠拿不到）。
        // 根因已在 `snapshot_into_outbox` 修掉（每筆各自 hlc），這裡是守門：寧可停下來讓主人看見錯誤，
        // 也不要靜默覆蓋。能走到這裡代表 outbox 裡有重複 hlc，那是資料層的 bug，不是網路問題。
        if last_key.as_deref() == Some(object_key.as_str()) {
            return Err("待上傳佇列裡有重複的時間戳，同步先停在這裡（請回報這個訊息）。".into());
        }
        let obj = OplogObject {
            version: OPLOG_VERSION,
            epoch: epoch.to_string(),
            device_id: device_id.to_string(),
            hlc_from,
            hlc_to: hlc_to.clone(),
            schema: SCHEMA_VERSION,
            seen,
            ops,
        };
        let plain = serde_json::to_vec(&obj).map_err(|_| "同步資料序列化失敗。".to_string())?;
        let blob = crypto::seal(&key, &object_key, &plain)?;

        // PUT 之前先把「這個 key 帶到哪一個 seq 為止」落庫（評審 B2）：PUT 成功而下面的交易失敗時，
        // 下一趟才知道要用同一段 op 重組同一份內容，而不是把後來新增的 op 一起塞進同一個 key。
        if !resuming {
            let mut tx = pool.begin().await.map_err(db_err)?;
            meta_set(&mut *tx, "inflight_key", &object_key).await?;
            meta_set(&mut *tx, "inflight_max_seq", &max_seq.to_string()).await?;
            tx.commit().await.map_err(db_err)?;
        }

        client.put(&object_key, blob).await?;

        // PUT 成功但 DB 失敗＝下次憑 in-flight 標記重推同一個 key、逐位元組同樣的內容（冪等）
        let mut tx = pool.begin().await.map_err(db_err)?;
        sqlx::query("DELETE FROM sync_outbox WHERE seq <= ?")
            .bind(max_seq)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        meta_set(&mut *tx, "last_push_hlc", &hlc_to).await?;
        // 自己剛推的物件不必再拉回來：把自己的 per-device 游標直接推到這把 key（pull 現在也會看自己的目錄）
        meta_set(&mut *tx, &format!("last_pull_key:{device_id}"), &object_key).await?;
        sqlx::query("DELETE FROM sync_meta WHERE key IN ('inflight_key','inflight_max_seq')")
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        tx.commit().await.map_err(db_err)?;

        pushed += obj.ops.len() as u64;
        last_key = Some(object_key);
        // 重推的那一批本來就可能不滿一批，不能拿它當「outbox 已清空」的證據——再跑一圈由查詢決定
        if !resuming && (rows.len() as i64) < PUSH_BATCH {
            break;
        }
    }

    if pushed > 0 {
        record_success(pool).await?;
    } else {
        clear_error(pool).await?;
    }
    Ok(PushReport {
        pushed_ops: pushed,
        object_key: last_key,
        busy: false,
    })
}

// ─────────────────────────────────────────────────────────────
// pull（replica）
// ─────────────────────────────────────────────────────────────

pub async fn pull(app: &AppHandle) -> Result<PullReport, String> {
    let empty = PullReport {
        objects: 0,
        applied_ops: 0,
        skipped_ops: 0,
        gated: false,
        changed_tables: vec![],
        busy: false,
        conflicts: 0,
        max_hlc: None,
    };
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Ok(PullReport { busy: true, ..empty });
    };
    let pool = pool(app).await?;
    match pull_inner(app, &pool, &st).await {
        Ok(report) => Ok(report),
        Err(e) => {
            record_error(&pool, &e).await;
            Err(e)
        }
    }
}

async fn pull_inner(app: &AppHandle, pool: &Pool<Sqlite>, st: &SyncState) -> Result<PullReport, String> {
    let mut report = PullReport {
        objects: 0,
        applied_ops: 0,
        skipped_ops: 0,
        gated: false,
        changed_tables: vec![],
        busy: false,
        conflicts: 0,
        max_hlc: None,
    };
    let mut meta = meta_all(pool).await?;
    if meta.get("enabled").map(String::as_str) != Some("1") {
        return Ok(report);
    }
    // v1.1.2 雙向（契約 §2.3）：正本也拉（副本的物件）。role 只剩「紀元權威」這個語義，
    // 沒有 role＝根本沒設定過同步。
    let Some(role) = meta.get("role").and_then(|s| Role::parse(s)) else {
        return Ok(report);
    };
    let incomplete = || "同步設定不完整，請重設後重新配對。".to_string();
    let epoch = meta.get("epoch").cloned().ok_or_else(incomplete)?;
    let primary = meta.get("primary_device_id").cloned().ok_or_else(incomplete)?;
    let me = ensure_device_id(pool).await?;

    let creds = credstore::load(app)?.ok_or_else(|| "找不到同步憑證，請重新配對。".to_string())?;
    let key = crypto::key_from_b64(&creds.key_b64)?;
    let client = R2Client::new(R2Config {
        endpoint: creds.endpoint,
        bucket: creds.bucket,
        access_key_id: creds.access_key_id,
        secret_access_key: creds.secret_access_key,
    })?;

    // ① v1.1.1 → v1.1.2 的游標搬家（契約 §2.2）：舊的單一 `last_pull_key` 就是「正本那一台的游標」。
    // 第一趟 pull 自動搬到 `last_pull_key:<primary_device_id>`，主人的手機不必重新配對。
    if migrate_cursor(pool, &meta, &primary).await? {
        meta = meta_all(pool).await?;
    }

    // ② replica：紀元偵測（契約 §4.3）。偵測到就**不再拉舊紀元的東西**，等主人按「改用桌機的版本」。
    if role == Role::Replica {
        if let Some(newer) = detect_new_epoch(&client, &key, &epoch, &primary).await? {
            meta_set(pool, "pending_epoch", &newer).await?;
            st.set_gate(None);
            clear_error(pool).await?;
            return Ok(report);
        }
    }

    // ③ 裝置發現（契約 §2.2）：這個紀元底下有哪些 device 目錄，去掉自己。
    // `EPOCH.bin` 是直接放在該層的**物件**，不會混進 common prefixes。
    let dirs = client.list_prefixes(&format!("v1/{epoch}/")).await?;
    // 主人真機 2026-09-20「重設後再配對，這台自己蓋過的章／改過的票不見了」：以前把自己的目錄跳過
    // （`*d != me`），理由是「自己推的自己早就有」——但清空後就沒有了，而桌機收進來的只是格子、
    // 不會再替這台重播一次。所以自己的目錄也要拉；平常不重複下載靠 push 成功時把
    // `last_pull_key:<me>` 推到剛推的那把 key（見 push_inner）。
    let mut devices: Vec<String> = dirs
        .iter()
        .filter_map(|p| p.rsplit('/').next())
        .filter(|d| !d.is_empty())
        .map(str::to_string)
        .collect();
    devices.sort();
    devices.dedup();

    // 主人真機 2026-09-20 第二回合：自己的目錄拉回來了，票還是不見——因為以前是「一台一台輪流套」，
    // 手機（2d7c…）排在桌機（edcf…）前面：手機 18:03:26 蓋章的那一筆先到，票卻要等桌機 18:03:10 的
    // 建立指令才存在 ⇒ 蓋章被當孤兒跳過；接著桌機 18:03:31 的刪除照套，「編輯勝刪除」根本沒機會發生。
    // 改成**所有裝置的物件先收齊，依檔名（hlc_from）全域排序再套**——因果順序才對得上。
    // 游標與 seen 仍在 apply_object 的交易裡逐物件推進，與順序無關。
    let mut queue: Vec<(String, String)> = Vec::new(); // (device, object_key)
    for dev in &devices {
        let cursor = meta
            .get(&format!("last_pull_key:{dev}"))
            .cloned()
            .unwrap_or_default();
        for k in client.list_after(&format!("v1/{epoch}/{dev}/"), &cursor).await? {
            queue.push((dev.clone(), k));
        }
    }
    queue.sort_by(|a, b| {
        let fa = a.1.rsplit('/').next().unwrap_or("");
        let fb = b.1.rsplit('/').next().unwrap_or("");
        fa.cmp(fb).then_with(|| a.0.cmp(&b.0))
    });

    let mut tables: BTreeSet<String> = BTreeSet::new();
    let mut gated_devices: BTreeSet<String> = BTreeSet::new();
    for (dev, object_key) in queue {
        // 信号待ち只擋**那一台**之後的物件，其他裝置照套
        if gated_devices.contains(&dev) {
            continue;
        }
        let blob = client.get(&object_key).await?;
        let plain = crypto::open(&key, &object_key, &blob)?;

        // 信号待ち：只有**對方比較新**才停在這裡、**不推進游標**，等這台更新到同一版再繼續。
        // 評審 S1：以前是 `!=`，於是 0005 上線後、R2 上還沒被拉走的 schema 4 舊物件，
        // 對已升級的副本永遠是信号待ち，唯一出口是重配對。白名單 apply 本來就前向相容
        // （未知欄整欄丟、缺欄吃 DEFAULT），舊物件照套才對。
        // 評審 S7：閘門排在**完整解析之前**——較新版本若真的改了 `ops` 的形狀，整包解析會先失敗，
        // 閘門就永遠到不了（見 `OplogHead` 的註解）。
        let head: OplogHead = serde_json::from_slice(&plain)
            .map_err(|_| "同步資料的格式看不懂（可能是較新版本產生的）。".to_string())?;
        if head.version > OPLOG_VERSION || head.schema > SCHEMA_VERSION {
            st.set_gate(Some(head.schema));
            report.gated = true;
            gated_devices.insert(dev);
            continue;
        }

        let obj: OplogObject = serde_json::from_slice(&plain)
            .map_err(|_| "同步資料的格式看不懂（可能是較新版本產生的）。".to_string())?;

        let outcome = apply_object(pool, &obj, &object_key, &me).await?;
        // 診斷線（主人真機 2026-09-20「配對後車票不見」）：release 版讀不到 DB，只能靠 logcat 的
        // RustStdoutStderr 看每個物件套了幾筆、跳了幾筆。不印任何資料內容，只印計數與物件名。
        eprintln!(
            "[sync:pull] {object_key} ops={} applied={} skipped={} conflicts={} tables={:?}",
            obj.ops.len(),
            outcome.applied,
            outcome.skipped,
            outcome.conflicts,
            outcome.changed
        );
        report.objects += 1;
        report.applied_ops += outcome.applied;
        report.skipped_ops += outcome.skipped;
        report.conflicts += outcome.conflicts;
        tables.extend(outcome.changed);
        // §5：把這趟收到的最大 hlc 回報給 TS 當種子（時鐘偏差防護）
        if report.max_hlc.as_deref().unwrap_or("") < obj.hlc_to.as_str() {
            report.max_hlc = Some(obj.hlc_to.clone());
        }
    }

    if !report.gated {
        st.set_gate(None);
    }
    report.changed_tables = tables.into_iter().collect();
    if report.objects > 0 {
        record_success(pool).await?;
    } else if !report.gated {
        clear_error(pool).await?;
    }
    Ok(report)
}

/// v1.1.1 的單一游標 `last_pull_key` → v1.1.2 的 `last_pull_key:<primary_device_id>`（契約 §2.2）。
/// 回 `true`＝動過 sync_meta（呼叫端要重讀）。
///
/// 為什麼要搬而不是重頭拉：舊鍵記的就是「正本那一台我拉到哪」，語義完全相同；不搬的話升級後
/// 第一趟會把正本的全部物件重套一次（LWW 讓它無害，但那是幾十顆物件的網路與 CPU）。
/// 為什麼 primary 端不會誤搬：primary 在 v1.1.1 從不 pull，根本沒有這把舊鍵。
async fn migrate_cursor(
    pool: &Pool<Sqlite>,
    meta: &HashMap<String, String>,
    primary: &str,
) -> Result<bool, String> {
    if !meta.contains_key("last_pull_key") {
        return Ok(false);
    }
    let fresh = format!("last_pull_key:{primary}");
    let old = meta.get("last_pull_key").cloned().unwrap_or_default();
    let mut tx = pool.begin().await.map_err(db_err)?;
    if !old.is_empty() && !meta.contains_key(&fresh) {
        meta_set(&mut *tx, &fresh, &old).await?;
    }
    sqlx::query("DELETE FROM sync_meta WHERE key = 'last_pull_key'")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(true)
}

/// 紀元標記物件 `v1/<epoch>/EPOCH.bin` 的內容（契約 §4.1 步驟 4）。
///
/// 為什麼是 `.bin` 不是 `.json`：它跟 oplog 物件一樣走 `crypto::seal`（AAD＝自己的 key），
/// 維持「雲端上只有密文」這條線——連「哪一台是正本」都不該裸奔。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpochInfo {
    pub version: u32,
    pub epoch: String,
    pub primary_device_id: String,
    pub created_at: String,
    pub reason: String,
}

/// 從一串 `v1/` 底下的目錄名裡挑出「比 `my_epoch` 大的最大**數字**紀元」（契約 §4.2）。
///
/// 純函式，方便單測。**非數字的紀元段一律忽略**——沙盒測試用的 `v1/sandbox-<run>/` 就是靠這條
/// 永遠不會觸發主人真機的紀元提示；`my_epoch` 自己不是數字（沙盒）時也一律回 None。
fn newer_epoch_of<'a, I: IntoIterator<Item = &'a str>>(dirs: I, my_epoch: &str) -> Option<u64> {
    let mine = my_epoch.parse::<u64>().ok()?;
    let mut best: Option<u64> = None;
    for d in dirs {
        let seg = d.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        if let Ok(n) = seg.parse::<u64>() {
            if n > mine {
                best = Some(best.map_or(n, |m: u64| m.max(n)));
            }
        }
    }
    best
}

/// replica 專用：雲端上有沒有「自己的正本開的、比我新的紀元」（契約 §4.3）。
///
/// 三道關卡缺一不可：① 目錄名是數字且大於我的 ② `EPOCH.bin` 拆得開（＝同一組密語）
/// ③ 裡面的 `primary_device_id` 等於我認得的正本。沙盒與正本共用同一個 bucket 時，
/// 這三條保證沙盒的 `v1/sandbox-*/` 永遠不會讓主人的手機跳出「改正待ち」。
async fn detect_new_epoch(
    client: &R2Client,
    key: &[u8; crypto::KEY_LEN],
    my_epoch: &str,
    primary: &str,
) -> Result<Option<String>, String> {
    if my_epoch.parse::<u64>().is_err() {
        return Ok(None);
    }
    let dirs = client.list_prefixes("v1/").await?;
    let Some(n) = newer_epoch_of(dirs.iter().map(String::as_str), my_epoch) else {
        return Ok(None);
    };
    let marker = format!("v1/{n}/EPOCH.bin");
    // 沒有標記＝可能正本正在寫，下一趟再看（契約 §4.3：當沒看到）
    let Some(blob) = client.get_opt(&marker).await? else {
        return Ok(None);
    };
    let Ok(plain) = crypto::open(key, &marker, &blob) else {
        return Ok(None); // 拆不開＝不是同一組密語的東西，不是我的事
    };
    let Ok(info) = serde_json::from_slice::<EpochInfo>(&plain) else {
        return Ok(None);
    };
    if info.primary_device_id != primary || info.epoch != n.to_string() {
        return Ok(None);
    }
    Ok(Some(n.to_string()))
}

// ─────────────────────────────────────────────────────────────
// apply（兩端；一個物件＝一個交易）
// ─────────────────────────────────────────────────────────────

/// 要綁進 SQL 的一個值（`serde_json::Value` 不能直接 bind，型別也要照白名單分流）
enum Bound {
    Null,
    Int(i64),
    Text(String),
}

fn bound_of(v: &Value, is_int: bool) -> Bound {
    match v {
        Value::Null => Bound::Null,
        _ if is_int => match v.as_i64() {
            Some(n) => Bound::Int(n),
            // 整數偶爾會被包成字串（JSON 來源不只一處）；能轉就轉，轉不動當 NULL
            None => v
                .as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .map(Bound::Int)
                .unwrap_or(Bound::Null),
        },
        Value::String(s) => Bound::Text(s.clone()),
        Value::Bool(b) => Bound::Text(if *b { "1".into() } else { "0".into() }),
        other => Bound::Text(other.to_string()),
    }
}

/// 兩個值「算不算一樣」（契約 §3.2 最後一條：值相同不記事件）。
///
/// 為什麼不直接比 `Value`：整數欄的值偶爾會被包成字串（JSON 來源不只一處），
/// `1` 與 `"1"` 在 `Value` 眼裡不同、在 SQLite 眼裡卻是同一個值。統一走 `bound_of` 再比。
fn same_value(a: &Value, b: &Value, is_int: bool) -> bool {
    fn norm(v: &Value, is_int: bool) -> Option<String> {
        match bound_of(v, is_int) {
            Bound::Null => None,
            Bound::Int(n) => Some(n.to_string()),
            Bound::Text(s) => Some(s),
        }
    }
    norm(a, is_int) == norm(b, is_int)
}

fn bind_all<'q>(
    mut q: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    binds: Vec<Bound>,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for b in binds {
        q = match b {
            Bound::Null => q.bind(None::<String>),
            Bound::Int(n) => q.bind(n),
            Bound::Text(s) => q.bind(s),
        };
    }
    q
}

/// `apply_object` 的結果（v1.1.2 契約 §3.1；v1.1.1 的三元組加了 `conflicts` 之後改成具名結構，
/// 免得呼叫端要記「第幾個是什麼」）。
#[derive(Debug, Clone, Default)]
pub struct ApplyOutcome {
    /// 真的寫到資料列的 op 數
    pub applied: u64,
    /// 一欄都沒採用的 op 數（LWW 判舊、表／欄／settings 鑰匙不在白名單、hlc 形狀不對、INSERT 缺 NOT NULL 欄、
    /// 或遠端的 conflict 日誌）
    pub skipped: u64,
    /// 這個物件讓本機記下幾筆競合（乘務記錄 `event='conflict'`）
    pub conflicts: u64,
    /// 有被改到的表
    pub changed: Vec<String>,
}

/// 一格 `sync_cells` 的戳記
#[derive(Debug, Clone)]
struct CellStamp {
    hlc: String,
    device_id: String,
}

/// 一列的全部格子（一次查完，取代 v1.1.1 的「逐欄一次 SELECT」——衝突判定要看 `device_id`，
/// 而且 §3.3 的「本列有沒有併發編輯」本來就得看整列）
async fn load_cells(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    tbl: &str,
    row_id: &str,
) -> Result<HashMap<String, CellStamp>, String> {
    let rows = sqlx::query("SELECT col, hlc, device_id FROM sync_cells WHERE tbl = ? AND row_id = ?")
        .bind(tbl)
        .bind(row_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(db_err)?;
    let mut m = HashMap::new();
    for r in rows {
        let col: String = r.try_get("col").map_err(db_err)?;
        m.insert(
            col,
            CellStamp {
                hlc: r.try_get("hlc").map_err(db_err)?,
                device_id: r.try_get("device_id").map_err(db_err)?,
            },
        );
    }
    Ok(m)
}

/// 一筆待寫的競合（敗方留痕）
/// 只負責記帳、不值得打擾主人的欄：衝突時照樣走 LWW，但**不**寫進乘務記錄（見 `apply_object` ③）。
///
/// `completed_at` 在列（產品評審 S3）：它是「蓋章」這個動作的副產品，主人從不手改。
/// 兩台早上都蓋同一班（己-10，最可能真的發生的併發）時 `status` 兩邊都是 done、不算衝突，
/// 偏偏 `completed_at` 差幾百毫秒 ⇒ 乘務記錄長出「完成時刻：這台改的「…245Z」讓給另一台的「…469Z」」，
/// ISO 字串既不可讀、主人也無從處置。值照走 LWW，只是不記事件。
const BOOKKEEPING_COLS: [&str; 3] = ["updated_at", "created_at", "completed_at"];

struct PendingConflict {
    col: String,
    /// 本機原本的值（`winner_is_mine=false` 時＝敗方；true 時＝實際留下的贏方）
    mine: Value,
    /// 對方帶來的值（`winner_is_mine=false` 時＝實際生效；true 時＝被擋下的敗方）
    theirs: Value,
    /// 本機那一格原本的 hlc
    mine_hlc: String,
    /// 贏的是本機那一版嗎（評審 S3 的「還沒 push 的贏家」；預設 false＝對方贏、本機讓位）
    winner_is_mine: bool,
}

/// 套用一個物件（一個交易）。
///
/// 與 v1.1.1 的差異（v1.1.2 契約 §3）：
///   * 多吃一個 `my_device_id`——「復活」要戳**本機**的新 hlc（§3.3），不能用對方的 op.hlc
///     （它可能比 `deleted_at` 那格還小，`stamp_cell` 的 `WHERE excluded.hlc > hlc` 會直接拒收）。
///   * 逐欄 LWW 之後多一層**併發判定**：那一格是別台寫的、而且對方推這個物件時還沒套用到那一版
///     （`cell.hlc > obj.seen[cell.device_id]`）⇒ 對方是在沒看過我這版的情況下改的＝真併發。
///     值真的不同才記競合（雙蓋同班兩邊都是 done ⇒ 零噪音）。
///   * **編輯勝刪除**兩個方向（§3.3）。
///   * 游標改 per-device：交易尾寫 `last_pull_key:<obj.device_id>` 與 `seen:<obj.device_id>`。
pub async fn apply_object(
    pool: &Pool<Sqlite>,
    obj: &OplogObject,
    object_key: &str,
    my_device_id: &str,
) -> Result<ApplyOutcome, String> {
    // 「復活」用的本機戳記種子（§3.3／§5）：取 max(本機已知最大 hlc, 這個物件的 hlc_to)，
    // 保證戳出來的 hlc 比本機與這批遠端資料都新，stamp_cell 才吃得下。
    let mut local_stamp: Option<String> = max_hlc(pool).await?;
    if local_stamp.as_deref().unwrap_or("") < obj.hlc_to.as_str() {
        local_stamp = Some(obj.hlc_to.clone());
    }
    // 評審 S3 用：「這台推到哪一版為止」。比它新的本機格子＝對方不可能看過的版本。
    let last_push_hlc = meta_all(pool)
        .await?
        .get("last_push_hlc")
        .cloned()
        .unwrap_or_default();

    let mut tx = pool.begin().await.map_err(db_err)?;
    // 父先子後的順序在快照裡有保證，增量 op 卻不保證（例如先收到子的 update、後收到父的 insert）。
    // 延後 FK 檢查到 COMMIT，整個物件套完再一次驗（契約 §7.2）。
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

    let mut out = ApplyOutcome::default();
    let mut tables: BTreeSet<String> = BTreeSet::new();
    // 這個交易裡新 INSERT 的列（評審 B1 第二層的救援名單；只有自己剛塞的才敢回退）
    let mut inserted: BTreeSet<(String, String)> = BTreeSet::new();
    // 這趟自己記的競合日誌。FK 救援撤掉某一列時它們要跟著被撤（否則 COMMIT 撞 FK），
    // 但**不計進 applied／skipped**——它們不是 op。
    let mut conflict_rows: BTreeSet<(String, String)> = BTreeSet::new();

    for op in &obj.ops {
        if !hlc::is_valid(&op.hlc) {
            out.skipped += 1;
            continue;
        }
        let Some(spec) = columns_of(&op.tbl) else {
            out.skipped += 1;
            continue;
        };
        if op.tbl == "settings" && !SYNC_SETTINGS_KEYS.contains(&op.row_id.as_str()) {
            out.skipped += 1;
            continue;
        }
        // 遠端的競合日誌不套用（§3.6 #8）：競合是「我這一版被誰蓋掉了」，各台自己記；
        // 別台的競合搬過來只會變成看不懂的雜訊（而且它本來就不該進 outbox，收到＝對方版本有問題）。
        if op.tbl == "work_logs" && op.cols.get("event").and_then(|v| v.as_str()) == Some("conflict") {
            out.skipped += 1;
            continue;
        }

        // 這一列目前的格子與目前的值（一次各查一次，取代 v1.1.1 的「逐欄查格子＋查存在」）
        let cells = load_cells(&mut tx, &op.tbl, &op.row_id).await?;
        let pk = pk_of(&op.tbl);
        let existing: Option<Map<String, Value>> = if op.tbl == "settings" {
            None
        } else {
            match sqlx::query(&format!("SELECT * FROM {} WHERE {pk} = ?", op.tbl))
                .bind(&op.row_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_err)?
            {
                Some(row) => Some(row_to_cols(&row, spec)?),
                None => None,
            }
        };

        // 「對方改這一格時，看過我這一版沒有」——§3.2 把「晚於上次同步」具體化成這一句
        let concurrent = |c: &CellStamp| -> bool {
            c.device_id != obj.device_id
                && c.hlc.as_str() > obj.seen.get(&c.device_id).map(String::as_str).unwrap_or("")
        };

        // ① 逐欄比 LWW：沒有格子（第一次見到）或本 op 比較新才採用；白名單外的欄整欄丟掉（不是整筆丟）
        let mut taken: Vec<(&'static str, bool, &Value)> = Vec::new();
        // 輸掉的欄（評審 S3 要用）：對方這一格比較舊、被這台現有的值擋下來
        let mut lost: Vec<(&'static str, bool, &Value)> = Vec::new();
        for (col, is_int) in spec {
            let Some(v) = op.cols.get(*col) else { continue };
            let win = match cells.get(*col) {
                None => true,
                Some(c) => op.hlc.as_str() > c.hlc.as_str(),
            };
            if win {
                taken.push((*col, *is_int, v));
            } else {
                lost.push((*col, *is_int, v));
            }
        }

        let mut pending: Vec<PendingConflict> = Vec::new();

        // ② 編輯勝刪除（§3.3），兩個方向。只有既存的列才談得上。
        let mut resurrect = false;
        if op.tbl != "settings" {
            if let Some(row) = existing.as_ref() {
                let incoming_delete = op.cols.get("deleted_at").is_some_and(|v| !v.is_null());
                if incoming_delete {
                    // 收到刪除：本列若有「別台寫的、對方沒看過」的非 deleted_at 編輯 ⇒ 不套 deleted_at
                    let edited = cells.iter().any(|(col, c)| col != "deleted_at" && concurrent(c));
                    if edited {
                        if let Some(pos) = taken.iter().position(|(c, _, _)| *c == "deleted_at") {
                            taken.remove(pos);
                            pending.push(PendingConflict {
                                col: "deleted_at".into(),
                                mine: Value::Null,
                                theirs: op.cols.get("deleted_at").cloned().unwrap_or(Value::Null),
                                mine_hlc: cells
                                    .get("deleted_at")
                                    .map(|c| c.hlc.clone())
                                    .unwrap_or_default(),
                                winner_is_mine: true, // 這台的編輯擋下了對方的刪除
                            });
                        }
                    }
                } else if !op.cols.contains_key("deleted_at")
                    && row.get("deleted_at").is_some_and(|v| !v.is_null())
                    && !taken.is_empty()
                {
                    // 本機已刪、收到併發編輯 ⇒ 復活（對方從沒套用過這個刪除，它是併發的；
                    // 對方那台 pull 我的刪除時會走上一條規則拒收，兩台自然收斂）
                    if let Some(d) = cells.get("deleted_at") {
                        if concurrent(d) {
                            resurrect = true;
                            pending.push(PendingConflict {
                                col: "deleted_at".into(),
                                mine: row.get("deleted_at").cloned().unwrap_or(Value::Null),
                                theirs: Value::Null,
                                mine_hlc: d.hlc.clone(),
                                winner_is_mine: false, // 對方的編輯把這台刪掉的票救回來了
                            });
                        }
                    }
                }
            }
        }

        // ③ 一般欄的併發判定（§3.2）：採用了、對方沒看過我這一版、而且值真的不同 ⇒ 記一筆競合
        if op.tbl != "settings" {
            if let Some(row) = existing.as_ref() {
                for (col, is_int, v) in &taken {
                    // 記帳欄不記事件（整合席沙盒情境②抓到）：兩台改同一格時 `updated_at` **必然**也不同，
                    // 於是每次衝突都會多出一行「updated_at：這台改的「2026-09-19T15:52:37.245Z」讓給…」。
                    // 那一行既沒有 `CONFLICT_COL_LABEL`、主人也無從處置，真正該讀的 `name` 那行反而被稀釋。
                    // 值照走 LWW（不在這裡 continue 之前擋），只是不寫進乘務記錄。
                    if BOOKKEEPING_COLS.contains(col) {
                        continue;
                    }
                    let Some(c) = cells.get(*col) else { continue };
                    if !concurrent(c) {
                        continue;
                    }
                    let mine = row.get(*col).cloned().unwrap_or(Value::Null);
                    if same_value(&mine, v, *is_int) {
                        continue; // 雙蓋同班：值一樣就不是衝突（自決 3）
                    }
                    pending.push(PendingConflict {
                        col: (*col).to_string(),
                        mine,
                        theirs: (*v).clone(),
                        mine_hlc: c.hlc.clone(),
                        winner_is_mine: false,
                    });
                }

                // ③ʹ 評審 S3：**這台是還沒 push 的贏家**時，兩台都不會記事件。
                // 時序：A 改 h15 推出去；B 這趟 pull 正在飛（幾秒），主人剛好在 B 改同一格 h20；
                // 套 A 的 h15 時被 h20 判舊、跳過（上面的 `win` 為 false）；B 下一趟 push 帶的
                // `seen[A]` 已含 h15 ⇒ A 收到 h20 時 `concurrent` 為 false，也不記。A 的值靜默消失。
                // 判準＝「這一格是我寫的、而且我還沒把它推出去」（`hlc > last_push_hlc`）——
                // 這正是「對方不可能看過、所以對方也判不出來」的充要條件，所以整體仍恰好一筆。
                for (col, is_int, v) in &lost {
                    if BOOKKEEPING_COLS.contains(col) {
                        continue;
                    }
                    let Some(c) = cells.get(*col) else { continue };
                    if c.device_id != my_device_id || c.hlc.as_str() <= last_push_hlc.as_str() {
                        continue;
                    }
                    let mine = row.get(*col).cloned().unwrap_or(Value::Null);
                    if same_value(&mine, v, *is_int) {
                        continue; // 雙蓋同班：值一樣就不是衝突
                    }
                    pending.push(PendingConflict {
                        col: (*col).to_string(),
                        mine,
                        theirs: (*v).clone(),
                        mine_hlc: c.hlc.clone(),
                        winner_is_mine: true,
                    });
                }
            }
        }

        // ④ 寫入。`delete` 與 `upsert` 走同一條規則——`deleted_at` 只是一個欄（v1.1.1 契約 §7.3）
        let writes_row = !taken.is_empty() || resurrect;
        let wrote = if !writes_row {
            false
        } else if op.tbl == "settings" {
            match taken
                .iter()
                .find(|(c, _, _)| *c == "value")
                .map(|(_, is_int, v)| bound_of(v, *is_int))
            {
                Some(v) => {
                    let q = sqlx::query(
                        "INSERT INTO settings (key, value, updated_at) \
                         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    )
                    .bind(&op.row_id);
                    bind_all(q, vec![v]).execute(&mut *tx).await.map_err(db_err)?;
                    true
                }
                None => false,
            }
        } else if existing.is_some() {
            if !taken.is_empty() {
                let sets = taken
                    .iter()
                    .map(|(c, _, _)| format!("{c} = ?"))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!("UPDATE {} SET {sets} WHERE {pk} = ?", op.tbl);
                let mut binds: Vec<Bound> = taken.iter().map(|(_, i, v)| bound_of(v, *i)).collect();
                binds.push(Bound::Text(op.row_id.clone()));
                bind_all(sqlx::query(&sql), binds)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
            }
            if resurrect {
                sqlx::query(&format!("UPDATE {} SET deleted_at = NULL WHERE {pk} = ?", op.tbl))
                    .bind(&op.row_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
            }
            true
        } else {
            // 新列：NOT NULL 又沒有 DEFAULT 的欄一定要有，缺了就跳過整筆（不中斷整個交易）
            let missing = required_of(&op.tbl)
                .iter()
                .any(|need| !taken.iter().any(|(c, _, v)| c == need && !v.is_null()));
            if missing {
                false
            } else {
                let names = std::iter::once(pk.to_string())
                    .chain(taken.iter().map(|(c, _, _)| (*c).to_string()))
                    .collect::<Vec<_>>()
                    .join(", ");
                let marks = vec!["?"; taken.len() + 1].join(", ");
                let sql = format!("INSERT INTO {} ({names}) VALUES ({marks})", op.tbl);
                let mut binds: Vec<Bound> = vec![Bound::Text(op.row_id.clone())];
                binds.extend(taken.iter().map(|(_, i, v)| bound_of(v, *i)));
                bind_all(sqlx::query(&sql), binds)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
                inserted.insert((op.tbl.clone(), op.row_id.clone()));
                true
            }
        };

        // ⑤ 戳格子（採用了才戳；沒採用的欄留著舊 hlc）
        if wrote {
            for (col, _, _) in &taken {
                stamp_cell(&mut tx, &op.tbl, &op.row_id, col, &op.hlc, &obj.device_id).await?;
            }
            if resurrect {
                // 復活那一格戳**本機新 hlc**（§3.3）：用 op.hlc 會被 stamp_cell 的
                // `WHERE excluded.hlc > hlc` 拒收（刪除那一格的 hlc 可能比 op.hlc 還大）。
                //
                // 評審 S4：`now_ms` 換成 0（＝只在 `max(本機最大, hlc_to)` 上加一個 count，不吃物理時鐘）。
                // 這一格**不進 outbox**，對方的 HLC 種子永遠吃不到它；本機時鐘若快，戳出來的 hlc 會遠遠
                // 跑在前面，之後對方（看過這批之後）真的要刪 h30 時 `h30 < fresh` ⇒ 刪除不採用、也不記事件，
                // 兩台從此分歧。加一個 count 就同時滿足「> 刪除那一格」與「< 任何一方之後的真編輯」
                // （兩邊的種子都 ≥ hlc_to）。
                let fresh = hlc::next(local_stamp.as_deref(), 0, my_device_id);
                stamp_cell(&mut tx, &op.tbl, &op.row_id, "deleted_at", &fresh, my_device_id).await?;
                local_stamp = Some(fresh);
            }
            out.applied += 1;
            tables.insert(op.tbl.clone());
        } else {
            out.skipped += 1;
        }

        // ⑥ 競合留痕（§3.4）：Rust 直寫 work_logs，天然不進 outbox（TS 的閘門不在這條路上）
        for pc in &pending {
            let node_id: Option<String> = match op.tbl.as_str() {
                "nodes" => Some(op.row_id.clone()),
                "work_logs" | "occurrences" => existing
                    .as_ref()
                    .and_then(|r| r.get("node_id"))
                    .and_then(|v| v.as_str().map(str::to_string))
                    .or_else(|| {
                        op.cols
                            .get("node_id")
                            .and_then(|v| v.as_str().map(str::to_string))
                    }),
                _ => None, // settings 沒有節點可掛，不記
            };
            let Some(node_id) = node_id else { continue };
            let body = serde_json::json!({
                "col": pc.col,
                "mine": pc.mine,
                "theirs": pc.theirs,
                // 誰的值留下來了（評審 S3）：舊版沒有這一欄，TS 端缺欄一律當 "theirs"（本機讓位）
                "winner": if pc.winner_is_mine { "mine" } else { "theirs" },
                "their_device": obj.device_id,
                "hlc": op.hlc,
                "mine_hlc": pc.mine_hlc,
                "tbl": op.tbl,
                "row_id": op.row_id,
            })
            .to_string();
            let log_id = uuid::Uuid::new_v4().to_string();
            let now = now_iso();
            let done = sqlx::query(
                "INSERT INTO work_logs (id, node_id, body, logged_at, event, created_at, updated_at) \
                 SELECT ?, ?, ?, ?, 'conflict', ?, ? WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?)",
            )
            .bind(&log_id)
            .bind(&node_id)
            .bind(&body)
            .bind(&now)
            .bind(&now)
            .bind(&now)
            .bind(&node_id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?
            .rows_affected();
            if done > 0 {
                conflict_rows.insert(("work_logs".to_string(), log_id));
                tables.insert("work_logs".to_string());
                out.conflicts += 1;
            }
        }
    }

    // ⑦ FK 救援（評審 B1 第二層）：`defer_foreign_keys` 把檢查延到 COMMIT，所以一筆孤兒 INSERT
    // 會讓**整個物件**的交易在 COMMIT 當下爆掉；`pull_inner` 回 Err、游標不推進，於是每 60 秒
    // 重炸同一個物件，副本從此收不到任何新東西。COMMIT 前先自己驗一次，把「這趟剛塞進去、
    // 卻沒有父列」的那幾筆撤掉（連同它們的格子，讓日後補到父列時還能重收），其餘照收。
    if !inserted.is_empty() || !conflict_rows.is_empty() {
        let (pruned_ops, pruned_conflicts) =
            prune_fk_violations(&mut tx, &inserted, &conflict_rows).await?;
        out.applied = out.applied.saturating_sub(pruned_ops);
        out.skipped += pruned_ops;
        out.conflicts = out.conflicts.saturating_sub(pruned_conflicts);
    }

    // ⑧ 快取重算＋推進 per-device 游標與 seen，全在同一個交易裡（契約 §3.5）
    if tables.contains("nodes") {
        recompute_caches_tx(&mut tx).await?;
    }
    meta_set(
        &mut *tx,
        &format!("last_pull_key:{}", obj.device_id),
        object_key,
    )
    .await?;
    meta_set(&mut *tx, &format!("seen:{}", obj.device_id), &obj.hlc_to).await?;
    tx.commit().await.map_err(db_err)?;

    out.changed = tables.into_iter().collect();
    Ok(out)
}

/// 把「這個交易剛 INSERT、卻違反外鍵」的列撤掉；回傳 (撤掉的 op 列數, 撤掉的競合日誌數)（評審 B1 第二層）。
///
/// 為什麼只撤自己剛塞的：既有列不可能違反 FK（平常寫入時 FK 是開著的），所以違規一定出自這一趟；
/// 但穩妥起見仍只碰 `inserted`／`conflict_rows` 名單裡的列——名單外的違規寧可讓 COMMIT 照爆，
/// 也不亂刪主人的資料。
/// 為什麼要迭代：撤掉一列 node 會讓剛剛掛在它底下的 work_logs 變成新的孤兒。
/// 為什麼競合日誌也要進名單（v1.1.2）：它掛在某個 node 上，而那個 node 有可能正是這一趟被撤掉的孤兒；
/// 兩份名單分開回報，是因為競合日誌不是 op，不該去動 `applied`／`skipped` 的帳。
async fn prune_fk_violations(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    inserted: &BTreeSet<(String, String)>,
    conflict_rows: &BTreeSet<(String, String)>,
) -> Result<(u64, u64), String> {
    const CHECKED: &[&str] = &["nodes", "work_logs", "occurrences"];
    let mut pruned: u64 = 0;
    let mut pruned_conflicts: u64 = 0;
    for _ in 0..5 {
        let mut hit = false;
        for tbl in CHECKED {
            if !inserted.iter().any(|(t, _)| t == tbl)
                && !conflict_rows.iter().any(|(t, _)| t == tbl)
            {
                continue;
            }
            // pragma 的欄：0=表名 1=rowid 2=父表 3=fkid（表名是自家常數，不是外來字串）
            let rows = sqlx::query(&format!("PRAGMA foreign_key_check({tbl})"))
                .fetch_all(&mut **tx)
                .await
                .map_err(db_err)?;
            for row in &rows {
                let Ok(Some(rowid)) = row.try_get::<Option<i64>, _>(1) else {
                    continue;
                };
                let id: Option<String> = sqlx::query(&format!("SELECT id FROM {tbl} WHERE rowid = ?"))
                    .bind(rowid)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(db_err)?
                    .map(|r| r.try_get::<String, _>("id"))
                    .transpose()
                    .map_err(db_err)?;
                let Some(id) = id else { continue };
                let key = ((*tbl).to_string(), id.clone());
                let is_op = inserted.contains(&key);
                let is_conflict = conflict_rows.contains(&key);
                if !is_op && !is_conflict {
                    continue;
                }
                sqlx::query(&format!("DELETE FROM {tbl} WHERE id = ?"))
                    .bind(&id)
                    .execute(&mut **tx)
                    .await
                    .map_err(db_err)?;
                sqlx::query("DELETE FROM sync_cells WHERE tbl = ? AND row_id = ?")
                    .bind(*tbl)
                    .bind(&id)
                    .execute(&mut **tx)
                    .await
                    .map_err(db_err)?;
                if is_op {
                    pruned += 1;
                } else {
                    pruned_conflicts += 1;
                }
                hit = true;
            }
        }
        if !hit {
            break;
        }
    }
    Ok((pruned, pruned_conflicts))
}

/// 重算 line_id／route_id 快取（契約 §7.3 的兩句 SQL 迭代到不動點）
///
/// 為什麼要迭代：一句 UPDATE 只把「兒子對齊爸爸」，而爸爸自己這一輪可能也才剛被對齊，
/// 所以要反覆跑到沒有列再變（樹深 ≤7，實測 3 輪收斂；上限 10 輪純粹是保險）。
async fn recompute_caches_tx(tx: &mut sqlx::Transaction<'_, Sqlite>) -> Result<(), String> {
    const CASCADE: &str = "UPDATE nodes SET \
          line_id  = (SELECT CASE WHEN p.kind='line'  THEN p.id ELSE p.line_id  END FROM nodes p WHERE p.id = nodes.parent_id), \
          route_id = (SELECT CASE WHEN p.kind='route' THEN p.id ELSE p.route_id END FROM nodes p WHERE p.id = nodes.parent_id) \
        WHERE parent_id IS NOT NULL \
          AND (line_id  IS NOT (SELECT CASE WHEN p.kind='line'  THEN p.id ELSE p.line_id  END FROM nodes p WHERE p.id = nodes.parent_id) \
            OR route_id IS NOT (SELECT CASE WHEN p.kind='route' THEN p.id ELSE p.route_id END FROM nodes p WHERE p.id = nodes.parent_id))";
    const ROOT_TICKET: &str = "UPDATE nodes SET line_id = (SELECT r.line_id FROM nodes r WHERE r.id = nodes.route_id) \
        WHERE parent_id IS NULL AND kind='ticket' \
          AND line_id IS NOT (SELECT r.line_id FROM nodes r WHERE r.id = nodes.route_id)";

    for _ in 0..10 {
        let n = sqlx::query(CASCADE)
            .execute(&mut **tx)
            .await
            .map_err(db_err)?
            .rows_affected();
        if n == 0 {
            break;
        }
    }
    sqlx::query(ROOT_TICKET)
        .execute(&mut **tx)
        .await
        .map_err(db_err)?;
    Ok(())
}

/// 重算快取（獨立交易版；給 v1.1.2 的合併路徑與沙盒腳本用）
pub async fn recompute_caches(pool: &Pool<Sqlite>) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    recompute_caches_tx(&mut tx).await?;
    tx.commit().await.map_err(db_err)
}

// ─────────────────────────────────────────────────────────────
// v1.1.2 還原紀元／換紀元／精靈匯入（契約席 2026-09-19 立 stub；**WP10a 填**——
// 規格：docs/research/2026-09-19-v1.1.2-雙向同步契約.md §4、§7）
// ─────────────────────────────────────────────────────────────

/// 還原剛完成的標記檔：`backup_restore` 換檔成功後寫、`begin_new_epoch` 收尾時刪。
///
/// 為什麼用檔不用 sync_meta：還原會把整顆 DB 換掉，DB 裡的任何旗標都跟著回到過去；app 資料目錄不會。
/// 桌機＝`%APPDATA%/<identifier>/sync/epoch-pending`（沙盒 identifier 天然隔離）。
fn restore_marker_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "找不到 app 資料目錄。".to_string())?
        .join("sync")
        .join("epoch-pending"))
}

/// 還原成功後留標記（backup.rs 在換檔之後呼叫；失敗只 log，不擋重啟）。
///
/// 目錄在**這裡**才建，不在 `restore_marker_path`：`sync_status()` 每 60 秒會叫一次 `is_restore_pending`，
/// 沒啟用同步的桌機不該只因為「被問了狀態」就在 `%APPDATA%` 長出一個空資料夾（鐵則：同步關著時桌機零改變）。
pub fn mark_restore_pending(app: &AppHandle) -> Result<(), String> {
    let p = restore_marker_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "建立同步目錄失敗。".to_string())?;
    }
    std::fs::write(&p, now_iso()).map_err(|_| "寫入還原標記失敗。".to_string())
}

pub fn is_restore_pending(app: &AppHandle) -> bool {
    restore_marker_path(app).map(|p| p.exists()).unwrap_or(false)
}

pub fn clear_restore_pending(app: &AppHandle) {
    if let Ok(p) = restore_marker_path(app) {
        let _ = std::fs::remove_file(p);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EpochOutcome {
    /// 開了新紀元、快照已進 outbox（TS 接著 push）
    Renewed,
    /// 還原的備份早於啟用同步（sync_meta 沒有 role／salt，或鹽與鑰匙圈不合）：已清掉本機同步設定，請重新啟用＋重新配對
    Reenable,
}

/// `sync_begin_new_epoch` 的回傳
#[derive(Debug, Clone, Serialize)]
pub struct EpochReport {
    pub outcome: EpochOutcome,
    /// 新紀元號（Reenable 時 None）
    pub epoch: Option<String>,
    /// 快照進 outbox 的 op 數
    pub snapshot_ops: u64,
    /// 給 toast 的一句人話
    pub message: String,
}

/// `sync_adopt_epoch` 的回傳（replica）
#[derive(Debug, Clone, Serialize)]
pub struct AdoptReport {
    /// 未推出去、被匯出到 JSON 檔的 op 數（0＝沒有孤兒、不建檔）
    pub orphan_ops: u64,
    /// 匯出檔的完整路徑（`app_data_dir/sync-orphans-<ts>.json`）；None＝沒有孤兒
    pub orphans_path: Option<String>,
    /// 換上的新紀元號
    pub epoch: String,
}

/// 精靈（scripts/setup-r2.sh）寫進 `%LOCALAPPDATA%/NextStop/r2.env` 的四欄。**不 derive Debug**（含 secret）。
#[derive(Clone, Serialize)]
pub struct WizardEnv {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

/// 開新紀元時要清掉的「跟舊紀元綁定」的 sync_meta 鍵（游標、seen、push 進度、in-flight、待換紀元）。
/// `epoch`／`role`／`salt`／`primary_device_id`／`device_id` 不在此列——那是身分，不是進度。
const EPOCH_SCOPED_META: &str = "DELETE FROM sync_meta WHERE key LIKE 'last_pull_key%' OR key LIKE 'seen:%' \
     OR key IN ('last_push_hlc','inflight_key','inflight_max_seq','pending_epoch')";

/// primary 專用：清 outbox／cells → epoch＝新號 → 寫 sync_meta ＋ `v1/<epoch>/EPOCH.bin` → 全庫快照進 outbox →
/// 刪還原標記。**不 push**（TS 端接著叫 `sync_push`）。規格見契約 §4.1。
///
/// 為什麼不是在 BackupTab 的還原流程末尾直接叫：`backup_restore` 換檔之後會 `app.restart()`，
/// 進程不會回來。改成 backup.rs 換檔成功後留標記檔，重啟後 `status().restore_pending=true`，由 TS 的
/// `boot()` 叫這一支。用檔不用 sync_meta，是因為還原把整顆 DB 換掉、DB 裡的旗標會一起回到過去。
pub async fn begin_new_epoch(app: &AppHandle) -> Result<EpochReport, String> {
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    let pool = pool(app).await?;
    let device_id = ensure_device_id(&pool).await?;
    let meta = meta_all(&pool).await?;
    let role = meta.get("role").and_then(|s| Role::parse(s));
    if role == Some(Role::Replica) {
        return Err("只有正本（桌機）能開新紀元。".into());
    }

    // ① 還原的備份早於「啟用同步」那一刻 ⇒ 這顆 DB 裡沒有 role／salt／epoch（或鑰匙圈已對不上）。
    // 沒有鹽就算不出同一把金鑰、沒有 epoch 就不知道舊紀元是哪個——唯一乾淨的出路是整組重來。
    let creds = credstore::load(app).unwrap_or(None);
    let old_epoch = meta.get("epoch").filter(|s| !s.is_empty()).cloned();
    let has_salt = meta.get("salt").is_some_and(|s| !s.is_empty());
    if role != Some(Role::Primary) || !has_salt || old_epoch.is_none() || creds.is_none() {
        credstore::clear(app)?;
        let mut tx = pool.begin().await.map_err(db_err)?;
        sqlx::query("DELETE FROM sync_meta WHERE key <> 'device_id'")
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        meta_set(&mut *tx, "enabled", "0").await?;
        tx.commit().await.map_err(db_err)?;
        st.set_gate(None);
        clear_restore_pending(app);
        return Ok(EpochReport {
            outcome: EpochOutcome::Reenable,
            epoch: None,
            snapshot_ops: 0,
            message: "還原的備份早於啟用同步——請重新啟用同步，手機也要重新配對。".into(),
        });
    }
    let old_epoch = old_epoch.unwrap_or_default();
    let creds = creds.expect("上面已判過 None");

    // ② 新紀元號：13 位毫秒字串，而且**一定大於舊的**（時鐘被撥回也不能倒退，
    //    否則副本的「比我大才提示」永遠不會觸發）。
    let new_epoch = hlc::now_ms()
        .max(old_epoch.parse::<u64>().unwrap_or(0) + 1)
        .to_string();

    // ③ 清掉跟舊紀元綁定的一切（一個交易）。cells 也清：新紀元＝全庫重上傳，
    //    舊的格子戳記留著只會讓自己的快照被自己的舊 hlc 判舊。
    let mut tx = pool.begin().await.map_err(db_err)?;
    sqlx::query("DELETE FROM sync_outbox")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM sync_cells")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query(EPOCH_SCOPED_META)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    meta_set(&mut *tx, "epoch", &new_epoch).await?;
    tx.commit().await.map_err(db_err)?;

    // ④ 紀元標記物件。網路失敗就回 Err——標記檔**留著**，下次啟動再試一次
    //    （epoch 已經換掉也無妨：再換一次就是，反正副本認的是「更大的那個」）。
    let key = crypto::key_from_b64(&creds.key_b64)?;
    let client = R2Client::new(R2Config {
        endpoint: creds.endpoint,
        bucket: creds.bucket,
        access_key_id: creds.access_key_id,
        secret_access_key: creds.secret_access_key,
    })?;
    let marker = format!("v1/{new_epoch}/EPOCH.bin");
    let info = EpochInfo {
        version: 1,
        epoch: new_epoch.clone(),
        primary_device_id: device_id.clone(),
        created_at: now_iso(),
        reason: "restore".into(),
    };
    let plain = serde_json::to_vec(&info).map_err(|_| "產生紀元標記失敗。".to_string())?;
    let blob = crypto::seal(&key, &marker, &plain)?;
    if let Err(e) = client.put(&marker, blob).await {
        record_error(&pool, &e).await;
        return Err(e);
    }

    // ⑤ 全庫快照重新排隊（含 tombstone、排除別台的競合日誌）
    let snapshot_ops = snapshot_into_outbox(&pool, &device_id).await?;
    clear_restore_pending(app);
    st.set_gate(None);
    record_success(&pool).await?;

    Ok(EpochReport {
        outcome: EpochOutcome::Renewed,
        epoch: Some(new_epoch),
        snapshot_ops,
        // 產品評審 S2：toast 不用「紀元」這個內部語彙，講主人看得見的後果
        message: "還原完成——這台正把整份資料重新上傳；手機下次同步會被要求改用桌機的版本。".into(),
    })
}

/// 清空「這台的主人資料＋同步進度」（`adopt_epoch` 的 ② ；**settings 不動**）。
///
/// 順序與 pragma 的理由：
///   ① **子表先刪**（work_logs／occurrences 指向 nodes），這條是硬要求。
///   ② `nodes.parent_id／line_id／route_id` 是**自我參照**的外鍵（0001 baseline，沒有 ON DELETE）。
///      實測「整表 `DELETE FROM nodes`」在 FK 開著時也過得去（SQLite 對無 WHERE 的整表刪除有
///      truncate 最佳化，不會一列一列檢查），所以 `PRAGMA defer_foreign_keys = ON` 這裡**不是**必要條件，
///      而是保險：哪天這幾句多了 WHERE、或 SQLite 換了策略，才不會變成「刪到一半撞 FK、換紀元卡死」。
///      這個 pragma 是**交易內**的，COMMIT 之後自動復原，不影響別的連線。
/// **settings 不動**：白名單只有 `day_start_hour`（快照會蓋回來），其餘十把鑰匙（主題、書封……）
/// 是這台自己的偏好，不該被別台的還原抹掉。
async fn wipe_local_data(tx: &mut sqlx::Transaction<'_, Sqlite>) -> Result<(), String> {
    for sql in [
        "PRAGMA defer_foreign_keys = ON",
        "DELETE FROM occurrences",
        "DELETE FROM work_logs",
        "DELETE FROM nodes",
        "DELETE FROM sync_outbox",
        "DELETE FROM sync_cells",
    ] {
        sqlx::query(sql).execute(&mut **tx).await.map_err(db_err)?;
    }
    Ok(())
}

/// 把還沒送出去的 outbox 匯出成人看得懂的 JSON（D-1.1-4「未同步修改先存本機」）。
/// 回 (筆數, 檔案路徑)；沒有孤兒＝(0, None)。adopt_epoch 與「非空庫配對」共用——
/// 兩者都是「這台要改用正本的版本」，差別只在觸發原因。
async fn export_outbox_orphans(
    app: &AppHandle,
    pool: &Pool<Sqlite>,
    device_id: &str,
    old_epoch: &str,
    new_epoch: &str,
) -> Result<(u64, Option<String>), String> {
    // 不自動重播：它們是舊紀元的 hlc／舊樹形，硬套回新紀元只會生出主人沒下過的指令。
    let rows = sqlx::query("SELECT seq, hlc, tbl, row_id, op, payload FROM sync_outbox ORDER BY seq")
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
    let mut orphans_path: Option<String> = None;
    let orphan_ops = rows.len() as u64;
    if !rows.is_empty() {
        let mut ops: Vec<Value> = Vec::with_capacity(rows.len());
        for r in &rows {
            let payload: String = r.try_get("payload").map_err(db_err)?;
            ops.push(serde_json::json!({
                "seq": r.try_get::<i64, _>("seq").map_err(db_err)?,
                "hlc": r.try_get::<String, _>("hlc").map_err(db_err)?,
                "tbl": r.try_get::<String, _>("tbl").map_err(db_err)?,
                "row_id": r.try_get::<String, _>("row_id").map_err(db_err)?,
                "op": r.try_get::<String, _>("op").map_err(db_err)?,
                // payload 解成物件，主人事後打開看得懂；解不開就原字串留著
                "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::String(payload)),
            }));
        }
        let doc = serde_json::json!({
            "exported_at": now_iso(),
            "device_id": device_id,
            "old_epoch": old_epoch,
            "new_epoch": new_epoch,
            "ops": ops,
        });
        // 落點（產品評審 B1）：手機先試「下載」目錄底下的 `NextStop/`——app 私有目錄
        // （Android release 是 `/data/data/<pkg>/files/`）主人用檔案管理員或線材都讀不到，
        // 檔案存了等於沒存，D-1.1-4 甲「不靜默丟」就只是一句安慰。寫不進去（權限、無外部儲存）
        // 再退回 app 資料目錄——**退回也比失敗好**，至少 `adopt_epoch` 不會整個卡住。
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if cfg!(mobile) {
            if let Ok(d) = app.path().download_dir() {
                candidates.push(d.join("NextStop"));
            }
        }
        candidates.push(
            app.path()
                .app_data_dir()
                .map_err(|_| "找不到 app 資料目錄。".to_string())?,
        );
        let name = format!(
            "sync-orphans-{}.json",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        );
        let text = serde_json::to_string_pretty(&doc).map_err(|_| "匯出未同步修改失敗。".to_string())?;
        for dir in &candidates {
            if std::fs::create_dir_all(dir).is_err() {
                continue;
            }
            let path = dir.join(&name);
            if std::fs::write(&path, &text).is_ok() {
                orphans_path = Some(path.to_string_lossy().to_string());
                break;
            }
        }
        if orphans_path.is_none() {
            return Err("寫入未同步修改的檔案失敗。".into());
        }
    }

    Ok((orphan_ops, orphans_path))
}

/// replica 專用：把未推的 outbox 匯出成 JSON → 清 nodes／work_logs／occurrences ＋ outbox／cells／游標 →
/// epoch＝pending_epoch → 清 pending_epoch。**不 pull**（TS 端接著叫 `sync_pull` 拉全量）。規格見契約 §4.4。
pub async fn adopt_epoch(app: &AppHandle) -> Result<AdoptReport, String> {
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    let pool = pool(app).await?;
    let device_id = ensure_device_id(&pool).await?;
    let meta = meta_all(&pool).await?;
    let Some(new_epoch) = meta.get("pending_epoch").filter(|s| !s.is_empty()).cloned() else {
        return Err("沒有待換的紀元。".into());
    };
    let old_epoch = meta.get("epoch").cloned().unwrap_or_default();

    let (orphan_ops, orphans_path) =
        export_outbox_orphans(app, &pool, &device_id, &old_epoch, &new_epoch).await?;

    // ② 清空本機資料與同步進度，換上新紀元（一個交易）。
    let mut tx = pool.begin().await.map_err(db_err)?;
    wipe_local_data(&mut tx).await?;
    sqlx::query(EPOCH_SCOPED_META)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    meta_set(&mut *tx, "epoch", &new_epoch).await?;
    meta_set(&mut *tx, "last_error", "").await?;
    // 產品評審 B1：以前「另存了幾筆、在哪」只在一聲 10 秒的 toast 裡講過一次，
    // 錯過就永遠查不到（手機更是連路徑都看不到）。記進 sync_meta，同步頁常駐一行。
    if orphan_ops > 0 {
        meta_set(&mut *tx, "last_orphans_count", &orphan_ops.to_string()).await?;
        meta_set(&mut *tx, "last_orphans_path", orphans_path.as_deref().unwrap_or("")).await?;
        meta_set(&mut *tx, "last_orphans_at", &now_iso()).await?;
    }
    tx.commit().await.map_err(db_err)?;
    st.set_gate(None);

    Ok(AdoptReport {
        orphan_ops,
        orphans_path,
        epoch: new_epoch,
    })
}

/// 桌機專用：讀 `%LOCALAPPDATA%/NextStop/r2.env`（KEY=VALUE 一行一個），只回四欄、**不落 log**。
/// 規格見契約 §7（留置線二節：「表單要手填四欄、沒說明去哪找值」）。
///
/// 為什麼是這個路徑：`scripts/setup-r2.sh`（精靈）的 `R2_ENV_FILE` 預設就寫在這裡；
/// 精靈已經帶主人在 Cloudflare 建好 bucket 與 token，沒道理再叫他手抄一次。
#[cfg(not(mobile))]
pub fn read_wizard_env(app: &AppHandle) -> Result<WizardEnv, String> {
    let path = app
        .path()
        .local_data_dir()
        .map_err(|_| "找不到本機資料目錄。".to_string())?
        .join("NextStop")
        .join("r2.env");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Err(
            "找不到精靈寫的設定（%LOCALAPPDATA%\\NextStop\\r2.env）——先在專案跑 bash scripts/setup-r2.sh。"
                .into(),
        );
    };
    let mut map: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // `export KEY=VALUE` 也吃得下（精靈寫的是純 KEY=VALUE，但主人可能自己補過）
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        // 去掉成對引號
        let v = if v.len() >= 2
            && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
        {
            &v[1..v.len() - 1]
        } else {
            v
        };
        map.insert(k.trim().to_string(), v.to_string());
    }
    let need = |k: &str| -> Result<String, String> {
        map.get(k)
            .filter(|s| !s.is_empty())
            .cloned()
            .ok_or_else(|| format!("r2.env 缺 {k}——請重跑 bash scripts/setup-r2.sh。"))
    };
    Ok(WizardEnv {
        endpoint: need("R2_ENDPOINT")?,
        bucket: need("R2_BUCKET")?,
        access_key_id: need("R2_ACCESS_KEY_ID")?,
        secret_access_key: need("R2_SECRET_ACCESS_KEY")?,
    })
}

/// 手機沒有精靈（`scripts/setup-r2.sh` 是桌機的 Git Bash 腳本），配對碼本來就會把四欄帶過來。
#[cfg(mobile)]
pub fn read_wizard_env(_app: &AppHandle) -> Result<WizardEnv, String> {
    Err("手機沒有精靈——請改用桌機的配對碼。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::atomic::AtomicU32;

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// 開一顆跑完 0001–0004 的臨時 DB（**絕不碰主人正本**：檔案在系統暫存目錄，測完就刪）。
    /// `foreign_keys(true)` 是故意的——要驗 apply 的 `defer_foreign_keys` 真的有在放行。
    async fn make_pool(tag: &str) -> (Pool<Sqlite>, std::path::PathBuf) {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "ns-wp7-synctest-{tag}-{}-{n}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        for sql in [
            include_str!("../../migrations/0001_baseline.sql"),
            include_str!("../../migrations/0002_today.sql"),
            include_str!("../../migrations/0003_repeat.sql"),
            include_str!("../../migrations/0004_sync.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&pool).await.unwrap();
        }
        (pool, path)
    }

    async fn drop_pool(pool: Pool<Sqlite>, path: std::path::PathBuf) {
        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }

    async fn count(pool: &Pool<Sqlite>, sql: &str) -> i64 {
        sqlx::query(sql)
            .fetch_one(pool)
            .await
            .unwrap()
            .try_get::<i64, _>(0)
            .unwrap()
    }

    async fn text(pool: &Pool<Sqlite>, sql: &str) -> Option<String> {
        sqlx::query(sql)
            .fetch_optional(pool)
            .await
            .unwrap()
            .and_then(|r| r.try_get::<Option<String>, _>(0).unwrap())
    }

    /// 一棵小樹：幹線 L1 →路線 R1 →列車 T1，外加一張掛 R1 標籤的根層臨時車票 K1
    async fn seed_tree(pool: &Pool<Sqlite>) {
        for (id, kind, parent, line, route, name, pos) in [
            ("L1", "line", None, None, None, "月見坂線", 0),
            ("R1", "route", Some("L1"), Some("L1"), None, "普通", 0),
            ("T1", "train", Some("R1"), Some("L1"), Some("R1"), "今日の列車", 0),
            ("K1", "ticket", None, Some("L1"), Some("R1"), "臨時券", 1),
        ] {
            sqlx::query(
                "INSERT INTO nodes (id, kind, parent_id, line_id, route_id, name, position) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(kind)
            .bind(parent)
            .bind(line)
            .bind(route)
            .bind(name)
            .bind(pos)
            .execute(pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO work_logs (id, node_id, body, logged_at, event) \
             VALUES ('W1','T1','発車','2026-09-18T00:00:00.000Z','issued')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO occurrences (id, node_id, due_on, status) VALUES ('O1','T1','2026-09-18','done')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES ('day_start_hour','4'), ('theme','sepia')")
            .execute(pool)
            .await
            .unwrap();
    }

    /// 把一顆 DB 的 outbox 讀成一個 OplogObject（＝push 會送出去的東西，少掉網路那一段）
    async fn drain_outbox(pool: &Pool<Sqlite>, device_id: &str) -> OplogObject {
        let rows = sqlx::query("SELECT hlc, tbl, row_id, op, payload FROM sync_outbox ORDER BY seq")
            .fetch_all(pool)
            .await
            .unwrap();
        let ops: Vec<Op> = rows
            .iter()
            .map(|r| Op {
                hlc: r.try_get("hlc").unwrap(),
                tbl: r.try_get("tbl").unwrap(),
                row_id: r.try_get("row_id").unwrap(),
                op: if r.try_get::<String, _>("op").unwrap() == "delete" {
                    OpKind::Delete
                } else {
                    OpKind::Upsert
                },
                cols: serde_json::from_str(&r.try_get::<String, _>("payload").unwrap()).unwrap(),
            })
            .collect();
        make_obj(device_id, ops)
    }

    fn mk_op(hlc: &str, tbl: &str, row_id: &str, kind: OpKind, cols: &[(&str, Value)]) -> Op {
        let mut m = Map::new();
        for (k, v) in cols {
            m.insert((*k).to_string(), v.clone());
        }
        Op {
            hlc: hlc.into(),
            tbl: tbl.into(),
            row_id: row_id.into(),
            op: kind,
            cols: m,
        }
    }

    fn make_obj(device: &str, ops: Vec<Op>) -> OplogObject {
        OplogObject {
            version: OPLOG_VERSION,
            epoch: "1758153600000".into(),
            device_id: device.into(),
            hlc_from: ops.first().map(|o| o.hlc.clone()).unwrap_or_default(),
            hlc_to: ops.last().map(|o| o.hlc.clone()).unwrap_or_default(),
            schema: SCHEMA_VERSION,
            seen: Default::default(),
            ops,
        }
    }

    /// 同上，但帶著「推送方已經看過各裝置的哪一版」（v1.1.2 §2.1 的 `seen`）。
    /// `seen` 空＝「對方什麼都沒看過」＝一切都算併發（安全側：多記事件、不漏）。
    fn make_obj_seen(device: &str, seen: &[(&str, &str)], ops: Vec<Op>) -> OplogObject {
        let mut o = make_obj(device, ops);
        o.seen = seen
            .iter()
            .map(|(d, h)| ((*d).to_string(), (*h).to_string()))
            .collect();
        o
    }

    /// 測試用的 apply：本機 device 固定 `dev-self`（＝「我」，跟 op 的來源台不同）
    async fn apply(pool: &Pool<Sqlite>, obj: &OplogObject, key: &str) -> ApplyOutcome {
        apply_object(pool, obj, key, "dev-self").await.unwrap()
    }

    /// 某個節點目前的競合日誌（body 解成 JSON），依寫入順序
    async fn conflicts_of(pool: &Pool<Sqlite>, node_id: &str) -> Vec<Value> {
        sqlx::query("SELECT body FROM work_logs WHERE node_id = ? AND event = 'conflict' ORDER BY rowid")
            .bind(node_id)
            .fetch_all(pool)
            .await
            .unwrap()
            .iter()
            .map(|r| serde_json::from_str(&r.try_get::<String, _>("body").unwrap()).unwrap())
            .collect()
    }

    #[test]
    fn 快照到套用_整棵樹搬過去且快取自己重算() {
        tauri::async_runtime::block_on(async {
            let (src, src_path) = make_pool("snap-src").await;
            let (dst, dst_path) = make_pool("snap-dst").await;
            seed_tree(&src).await;

            let n = snapshot_into_outbox(&src, "dev-primary").await.unwrap();
            // 4 個節點＋1 筆日誌＋1 筆班次＋1 把設定鑰匙（theme 不在白名單）
            assert_eq!(n, 7);
            assert_eq!(count(&src, "SELECT COUNT(*) FROM sync_outbox").await, 7);
            assert!(
                count(&src, "SELECT COUNT(*) FROM sync_cells").await > 0,
                "快照要順手 seed cells"
            );

            // line_id 不進 oplog；route_id 只有根層臨時車票那一筆帶
            let payloads: Vec<String> = sqlx::query("SELECT payload FROM sync_outbox WHERE tbl='nodes'")
                .fetch_all(&src)
                .await
                .unwrap()
                .iter()
                .map(|r| r.try_get::<String, _>("payload").unwrap())
                .collect();
            assert!(
                payloads.iter().all(|p| !p.contains("line_id")),
                "line_id 是快取，不該進 oplog"
            );
            assert_eq!(
                payloads.iter().filter(|p| p.contains("route_id")).count(),
                1,
                "只有根層臨時車票帶 route_id"
            );

            let object = drain_outbox(&src, "dev-primary").await;
            let r = apply(&dst, &object, "v1/e/d/a.bin").await;
            assert_eq!(r.applied, 7);
            assert_eq!(r.skipped, 0);
            assert_eq!(r.conflicts, 0, "空庫第一次收，沒有東西可衝突");
            assert_eq!(r.changed, vec!["nodes", "occurrences", "settings", "work_logs"]);

            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes").await, 4);
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM work_logs").await, 1);
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM occurrences").await, 1);
            assert_eq!(
                text(&dst, "SELECT value FROM settings WHERE key='day_start_hour'").await.as_deref(),
                Some("4")
            );
            assert_eq!(
                text(&dst, "SELECT value FROM settings WHERE key='theme'").await,
                None,
                "白名單外的設定不搬"
            );

            // 快取由副本自己重算（oplog 裡根本沒有 line_id）
            assert_eq!(text(&dst, "SELECT line_id FROM nodes WHERE id='T1'").await.as_deref(), Some("L1"));
            assert_eq!(text(&dst, "SELECT route_id FROM nodes WHERE id='T1'").await.as_deref(), Some("R1"));
            assert_eq!(text(&dst, "SELECT line_id FROM nodes WHERE id='R1'").await.as_deref(), Some("L1"));
            assert_eq!(
                text(&dst, "SELECT route_id FROM nodes WHERE id='K1'").await.as_deref(),
                Some("R1"),
                "根票的路線標籤是資料"
            );
            assert_eq!(
                text(&dst, "SELECT line_id FROM nodes WHERE id='K1'").await.as_deref(),
                Some("L1"),
                "根票的 line_id 跟著標籤重算"
            );

            // per-device 游標與 seen 都推進了（v1.1.2 §3.5）
            assert_eq!(
                text(&dst, "SELECT value FROM sync_meta WHERE key='last_pull_key:dev-primary'")
                    .await
                    .as_deref(),
                Some("v1/e/d/a.bin")
            );
            assert_eq!(
                text(&dst, "SELECT value FROM sync_meta WHERE key='seen:dev-primary'").await,
                Some(object.hlc_to.clone())
            );

            // 再套一次同一個物件＝完全冪等（全被 LWW 判舊）
            let r2 = apply(&dst, &object, "v1/e/d/a.bin").await;
            assert_eq!((r2.applied, r2.skipped, r2.conflicts), (0, 7, 0));
            assert!(r2.changed.is_empty());
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes").await, 4);

            drop_pool(src, src_path).await;
            drop_pool(dst, dst_path).await;
        });
    }

    #[test]
    fn 逐欄_lww_較舊的不覆蓋較新的() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("lww").await;
            let base = make_obj(
                "dev-a",
                vec![mk_op(
                    "17581536000000010-aaaaaaaa",
                    "nodes",
                    "N1",
                    OpKind::Upsert,
                    &[
                        ("kind", "train".into()),
                        ("name", "第一版".into()),
                        ("position", 1.into()),
                    ],
                )],
            );
            apply(&dst, &base, "k1").await;

            // 這一支只驗純 LWW，所以之後的 dev-b 物件都帶 `seen={dev-a: …010}`
            // ＝「dev-b 已經看過 dev-a 那一版才改的」＝不是併發、不該記競合（併發另有專門測試）。
            const SEEN_A: &[(&str, &str)] = &[("dev-a", "17581536000000010-aaaaaaaa")];

            // 較舊的 op：整筆被判舊 → skipped，名字不動
            let older = make_obj_seen(
                "dev-b",
                SEEN_A,
                vec![mk_op(
                    "17581536000000005-bbbbbbbb",
                    "nodes",
                    "N1",
                    OpKind::Upsert,
                    &[("name", "更舊的名字".into())],
                )],
            );
            let r = apply(&dst, &older, "k2").await;
            assert_eq!((r.applied, r.skipped, r.conflicts), (0, 1, 0));
            assert_eq!(text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(), Some("第一版"));

            // 較新的 op 只帶 name：只有 name 換掉，position 保留
            let newer = make_obj_seen(
                "dev-b",
                SEEN_A,
                vec![mk_op(
                    "17581536000000020-bbbbbbbb",
                    "nodes",
                    "N1",
                    OpKind::Upsert,
                    &[("name", "第二版".into())],
                )],
            );
            let r = apply(&dst, &newer, "k3").await;
            assert_eq!((r.applied, r.skipped, r.conflicts), (1, 0, 0));
            assert_eq!(text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(), Some("第二版"));
            assert_eq!(count(&dst, "SELECT position FROM nodes WHERE id='N1'").await, 1);

            // delete 與 upsert 同一條規則：deleted_at 只是一個欄
            let del = make_obj_seen(
                "dev-b",
                SEEN_A,
                vec![mk_op(
                    "17581536000000030-bbbbbbbb",
                    "nodes",
                    "N1",
                    OpKind::Delete,
                    &[("deleted_at", "2026-09-18T01:00:00.000Z".into())],
                )],
            );
            apply(&dst, &del, "k4").await;
            assert_eq!(
                count(&dst, "SELECT COUNT(*) FROM nodes WHERE id='N1' AND deleted_at IS NOT NULL").await,
                1
            );
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes").await, 1, "soft delete 不刪列");

            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 破碎的op跳過但交易照走_白名單外的欄與表也擋掉() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("skip").await;
            let ops = vec![
                // ① 新列但缺 NOT NULL 的 name → 跳過
                mk_op("17581536000000010-aaaaaaaa", "nodes", "BAD", OpKind::Upsert, &[("kind", "train".into())]),
                // ② 不在白名單的表 → 跳過
                mk_op("17581536000000011-aaaaaaaa", "sync_meta", "device_id", OpKind::Upsert, &[("value", "x".into())]),
                // ③ 不在白名單的 settings 鑰匙 → 跳過
                mk_op("17581536000000012-aaaaaaaa", "settings", "theme", OpKind::Upsert, &[("value", "sepia".into())]),
                // ④ hlc 形狀不對 → 跳過
                mk_op("nope", "nodes", "N2", OpKind::Upsert, &[("kind", "train".into()), ("name", "壞鐘".into())]),
                // ⑤ 正常的一筆，外加一個白名單外的欄（該欄丟掉、整筆照收）
                mk_op(
                    "17581536000000013-aaaaaaaa",
                    "nodes",
                    "OK",
                    OpKind::Upsert,
                    &[("kind", "train".into()), ("name", "好的".into()), ("line_id", "L9".into())],
                ),
            ];
            let r = apply(&dst, &make_obj("dev-a", ops), "k1").await;
            assert_eq!((r.applied, r.skipped), (1, 4));
            assert_eq!(r.changed, vec!["nodes"]);
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes").await, 1);
            assert_eq!(text(&dst, "SELECT name FROM nodes WHERE id='OK'").await.as_deref(), Some("好的"));
            assert_eq!(
                text(&dst, "SELECT line_id FROM nodes WHERE id='OK'").await,
                None,
                "白名單外的欄不該被寫進來"
            );
            assert_eq!(
                text(&dst, "SELECT value FROM sync_meta WHERE key='device_id'").await,
                None,
                "機制表不可被 oplog 改"
            );
            // 游標照樣推進（這個物件已經處理完了）
            assert_eq!(
                text(&dst, "SELECT value FROM sync_meta WHERE key='last_pull_key:dev-a'").await.as_deref(),
                Some("k1")
            );

            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 子先父後也能_commit_延後外鍵檢查有效() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("fk").await;
            // 故意先送兒子（parent_id 指向還不存在的 P）、再送爸爸
            let ops = vec![
                mk_op(
                    "17581536000000010-aaaaaaaa",
                    "nodes",
                    "C",
                    OpKind::Upsert,
                    &[("kind", "train".into()), ("name", "兒子".into()), ("parent_id", "P".into())],
                ),
                mk_op(
                    "17581536000000011-aaaaaaaa",
                    "nodes",
                    "P",
                    OpKind::Upsert,
                    &[("kind", "route".into()), ("name", "爸爸".into())],
                ),
                mk_op(
                    "17581536000000012-aaaaaaaa",
                    "work_logs",
                    "W",
                    OpKind::Upsert,
                    &[
                        ("node_id", "C".into()),
                        ("body", "発車".into()),
                        ("logged_at", "2026-09-18T00:00:00.000Z".into()),
                    ],
                ),
            ];
            let r = apply(&dst, &make_obj("dev-a", ops), "k1").await;
            assert_eq!((r.applied, r.skipped), (3, 0));
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes").await, 2);
            assert_eq!(
                text(&dst, "SELECT route_id FROM nodes WHERE id='C'").await.as_deref(),
                Some("P"),
                "快取重算要認得剛進來的爸爸"
            );

            drop_pool(dst, path).await;
        });
    }

    /// 評審 B2：「PUT 成功、本機 DELETE 失敗」之後重推，必須是**同 key 同內容**。
    ///
    /// 舊行為：key＝首筆 op 的 hlc、內容＝當下整個 outbox ⇒ 中間又寫了新的 op 的話，重推會用
    /// 「同一個 key、更多的內容」蓋掉 R2 上那顆物件；副本若已拉過舊版（游標就停在那個 key），
    /// 新增的那幾筆永遠不會再被 `list_after` 看到＝靜默吃掉資料。
    /// 新行為：PUT 前先落 `inflight_key`／`inflight_max_seq`，重推只取 `seq <= inflight_max_seq`。
    ///
    /// 這支要打**真的** R2（跑法同 `sync::r2::tests`）：
    /// ```text
    /// set -a && source "$LOCALAPPDATA/NextStop/r2.env" && set +a
    /// cargo test --lib sync::engine::tests::重推 -- --ignored --nocapture
    /// ```
    /// 鐵則：物件放自己的一次性 epoch 之下，測完逐一刪掉；憑證一個字都不印。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 重推同一批_同_key_同內容_不會吃掉後來的_op() {
        tauri::async_runtime::block_on(async {
            let client = R2Client::new(R2Config {
                endpoint: std::env::var("R2_ENDPOINT").expect("缺 R2_ENDPOINT（請先 source r2.env）"),
                bucket: std::env::var("R2_BUCKET").expect("缺 R2_BUCKET"),
                access_key_id: std::env::var("R2_ACCESS_KEY_ID").expect("缺 R2_ACCESS_KEY_ID"),
                secret_access_key: std::env::var("R2_SECRET_ACCESS_KEY").expect("缺 R2_SECRET_ACCESS_KEY"),
            })
            .expect("建 client 失敗");
            let key = crypto::derive_key("sandbox-passphrase", &[7u8; crypto::SALT_LEN]).unwrap();

            let (pool, path) = make_pool("push-idem").await;
            let device = "dev-idem";
            let mut stamp = [0u8; 8];
            crypto::fill_random(&mut stamp).unwrap();
            let epoch = format!("t{}", crypto::b64_encode(&stamp));

            // 先排兩筆 op（＝主人做的第一手），送出去
            for (i, name) in ["第一筆", "第二筆"].iter().enumerate() {
                sqlx::query(
                    "INSERT INTO sync_outbox (hlc, tbl, row_id, op, payload) VALUES (?, 'nodes', ?, 'upsert', ?)",
                )
                .bind(format!("175815360000{:05}-aaaaaaaa", i))
                .bind(format!("N{i}"))
                .bind(format!("{{\"kind\":\"train\",\"name\":\"{name}\"}}"))
                .execute(&pool)
                .await
                .unwrap();
            }
            let first = push_loop(&pool, &client, &key, &epoch, device).await.unwrap();
            let object_key = first.object_key.clone().expect("第一趟要推出一顆物件");
            assert_eq!(first.pushed_ops, 2);

            // 模擬「PUT 成功、DB 交易失敗」：把那兩筆放回 outbox、重新掛上 in-flight 標記，
            // 然後**在中間又寫了一筆新的 op**（舊行為就是在這裡把新的一併塞進同一個 key）。
            for (i, name) in ["第一筆", "第二筆"].iter().enumerate() {
                sqlx::query(
                    "INSERT INTO sync_outbox (hlc, tbl, row_id, op, payload) VALUES (?, 'nodes', ?, 'upsert', ?)",
                )
                .bind(format!("175815360000{:05}-aaaaaaaa", i))
                .bind(format!("N{i}"))
                .bind(format!("{{\"kind\":\"train\",\"name\":\"{name}\"}}"))
                .execute(&pool)
                .await
                .unwrap();
            }
            let max_seq = count(&pool, "SELECT MAX(seq) FROM sync_outbox").await;
            meta_set(&pool, "inflight_key", &object_key).await.unwrap();
            meta_set(&pool, "inflight_max_seq", &max_seq.to_string()).await.unwrap();
            sqlx::query(
                "INSERT INTO sync_outbox (hlc, tbl, row_id, op, payload) \
                 VALUES ('17581536000009999-aaaaaaaa', 'nodes', 'N9', 'upsert', '{\"kind\":\"train\",\"name\":\"後來才寫的\"}')",
            )
            .execute(&pool)
            .await
            .unwrap();

            let second = push_loop(&pool, &client, &key, &epoch, device).await.unwrap();
            assert_eq!(second.pushed_ops, 3, "重推兩筆＋後來那一筆另起一顆物件");

            // 重推的那顆＝原 key，內容仍是**兩筆**（不是三筆）
            let blob = client.get(&object_key).await.unwrap();
            let obj: OplogObject =
                serde_json::from_slice(&crypto::open(&key, &object_key, &blob).unwrap()).unwrap();
            assert_eq!(obj.ops.len(), 2, "重推不可以把後來的 op 塞進同一個 key");

            // 後來那一筆必須自己成一顆**新** key（副本的游標才看得到它）
            let keys = client.list_after(&format!("v1/{epoch}/{device}/"), "").await.unwrap();
            assert_eq!(keys.len(), 2, "應該有兩顆物件");
            assert!(keys.iter().any(|k| k != &object_key));
            assert_eq!(count(&pool, "SELECT COUNT(*) FROM sync_outbox").await, 0);
            assert_eq!(
                count(&pool, "SELECT COUNT(*) FROM sync_meta WHERE key LIKE 'inflight%'").await,
                0,
                "推完要把 in-flight 標記清乾淨"
            );

            for k in keys {
                client.delete(&k).await.unwrap();
            }
            drop_pool(pool, path).await;
        });
    }

    // ─────────────────────────────────────────────────────────
    // v1.1.2 雙向往返（打真的 R2；沙盒紀元＝**非數字**，紀元偵測一律忽略 ⇒ 絕不干擾主人正本）
    // ─────────────────────────────────────────────────────────

    /// 建 R2 client（四把都從環境變數讀；**一個字都不印**）
    fn sandbox_client() -> R2Client {
        R2Client::new(R2Config {
            endpoint: std::env::var("R2_ENDPOINT").expect("缺 R2_ENDPOINT（請先 source r2.env）"),
            bucket: std::env::var("R2_BUCKET").expect("缺 R2_BUCKET"),
            access_key_id: std::env::var("R2_ACCESS_KEY_ID").expect("缺 R2_ACCESS_KEY_ID"),
            secret_access_key: std::env::var("R2_SECRET_ACCESS_KEY").expect("缺 R2_SECRET_ACCESS_KEY"),
        })
        .expect("建 client 失敗")
    }

    /// 本機寫一筆（＝TS 寫入路徑：改值＋戳格子＋排進 outbox），給雙向往返測試用
    async fn local_op(pool: &Pool<Sqlite>, device: &str, row_id: &str, col: &str, value: &str, hlc: &str) {
        sqlx::query(&format!("UPDATE nodes SET {col} = ? WHERE id = ?"))
            .bind(value)
            .bind(row_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sync_cells (tbl, row_id, col, hlc, device_id) VALUES ('nodes', ?, ?, ?, ?) \
             ON CONFLICT(tbl, row_id, col) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id",
        )
        .bind(row_id)
        .bind(col)
        .bind(hlc)
        .bind(device)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sync_outbox (hlc, tbl, row_id, op, payload) VALUES (?, 'nodes', ?, 'upsert', ?)")
            .bind(hlc)
            .bind(row_id)
            .bind(format!("{{\"{col}\":\"{value}\"}}"))
            .execute(pool)
            .await
            .unwrap();
    }

    /// `pull_inner` §2.3 ③ 的離線版：裝置發現 → per-device 游標 → get／open／apply。
    /// （`pull_inner` 本身要 `AppHandle`＋credstore，測試裡拿不到；這裡走的是同一組 r2 與 apply_object。）
    async fn pull_all(
        pool: &Pool<Sqlite>,
        client: &R2Client,
        key: &[u8; crypto::KEY_LEN],
        epoch: &str,
        me: &str,
    ) -> ApplyOutcome {
        let mut total = ApplyOutcome::default();
        let dirs = client.list_prefixes(&format!("v1/{epoch}/")).await.unwrap();
        let mut devices: Vec<String> = dirs
            .iter()
            .filter_map(|p| p.rsplit('/').next())
            .filter(|d| !d.is_empty() && *d != me)
            .map(str::to_string)
            .collect();
        devices.sort();
        for dev in devices {
            let cursor = text(
                pool,
                &format!("SELECT value FROM sync_meta WHERE key='last_pull_key:{dev}'"),
            )
            .await
            .unwrap_or_default();
            for k in client
                .list_after(&format!("v1/{epoch}/{dev}/"), &cursor)
                .await
                .unwrap()
            {
                let blob = client.get(&k).await.unwrap();
                let obj: OplogObject =
                    serde_json::from_slice(&crypto::open(key, &k, &blob).unwrap()).unwrap();
                let o = apply_object(pool, &obj, &k, me).await.unwrap();
                total.applied += o.applied;
                total.skipped += o.skipped;
                total.conflicts += o.conflicts;
            }
        }
        total
    }

    /// 兩台互推互拉（契約 §2）＋同列同欄併發記競合（§3）。**打真的 R2**。
    ///
    /// 跑法（Git Bash）：
    /// ```text
    /// set -a && source "$LOCALAPPDATA/NextStop/r2.env" && set +a
    /// cargo test --lib sync::engine::tests::兩台互推互拉 -- --ignored --nocapture
    /// ```
    /// 鐵則：物件全在 `v1/sandbox-<random>/` 底下（epoch 段非數字 ⇒ replica 的紀元偵測會忽略，
    /// 永遠碰不到主人正本的 `v1/<13 位數字>/`），收工逐一刪除；憑證一個字都不印。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 兩台互推互拉_雙向往返並記下競合() {
        tauri::async_runtime::block_on(async {
            let client = sandbox_client();
            let key = crypto::derive_key("sandbox-passphrase", &[11u8; crypto::SALT_LEN]).unwrap();
            let mut stamp = [0u8; 8];
            crypto::fill_random(&mut stamp).unwrap();
            // **非數字**紀元段：這是「不干擾主人正本」的機制保證，不是命名習慣
            let epoch = format!("sandbox-{}", crypto::b64_encode(&stamp));
            let root = format!("v1/{epoch}/");
            const A: &str = "dev-aaaa";
            const B: &str = "dev-bbbb";

            let (a, pa) = make_pool("bidir-a").await;
            let (b, pb) = make_pool("bidir-b").await;

            // 本機修改的 hlc 必須**比快照的還新**——快照走 `hlc::now_ms()`，寫死的 175815…
            // 早就變成過去式了（2025-09），會整批被 LWW 判舊。一律從現在起跳。
            let t0 = hlc::now_ms();
            let at = |bump: u64, dev: &str| hlc::format(hlc::Hlc { ms: t0 + bump, count: 0 }, dev);

            // ① A 建一棵樹、快照進 outbox、推上去；B 拉下來（＝v1.1.1 的單向那一段）
            seed_tree(&a).await;
            snapshot_into_outbox(&a, A).await.unwrap();
            let up = push_loop(&a, &client, &key, &epoch, A).await.unwrap();
            assert_eq!(up.pushed_ops, 7);

            let down = pull_all(&b, &client, &key, &epoch, B).await;
            assert_eq!(down.applied, 7);
            assert_eq!(down.conflicts, 0);
            assert_eq!(count(&b, "SELECT COUNT(*) FROM nodes").await, 4);
            assert_eq!(
                text(&b, "SELECT line_id FROM nodes WHERE id='T1'").await.as_deref(),
                Some("L1"),
                "快取由收到方自己重算"
            );

            // ② **副本也推**：B 改一張票的名字，推上去；A 拉回來（v1.1.1 做不到的那一段）
            local_op(&b, B, "T1", "name", "手機改的", &at(1_000, B)).await;
            let up_b = push_loop(&b, &client, &key, &epoch, B).await.unwrap();
            assert_eq!(up_b.pushed_ops, 1);

            let back = pull_all(&a, &client, &key, &epoch, A).await;
            assert_eq!(back.applied, 1);
            assert_eq!(
                text(&a, "SELECT name FROM nodes WHERE id='T1'").await.as_deref(),
                Some("手機改的"),
                "雙向：手機的修改要回得了桌機"
            );
            assert_eq!(
                back.conflicts, 0,
                "A 那一格是 A 自己在快照時戳的，B 的 seen 已含它 ⇒ 不是併發"
            );

            // ③ 同列同欄併發：A 與 B 各自改 K1 的名字，兩邊都沒看過對方那一版
            local_op(&a, A, "K1", "name", "桌機版", &at(2_000, A)).await;
            local_op(&b, B, "K1", "name", "手機版", &at(3_000, B)).await;
            push_loop(&a, &client, &key, &epoch, A).await.unwrap();
            push_loop(&b, &client, &key, &epoch, B).await.unwrap();

            // A 拉 B 的：B 的 hlc 較大 ⇒ A 的值讓位、A 記一筆競合
            let ra = pull_all(&a, &client, &key, &epoch, A).await;
            assert_eq!(
                text(&a, "SELECT name FROM nodes WHERE id='K1'").await.as_deref(),
                Some("手機版")
            );
            assert_eq!(ra.conflicts, 1, "敗方（A）要留痕");
            let cf = conflicts_of(&a, "K1").await;
            assert_eq!(cf[0]["mine"], "桌機版");
            assert_eq!(cf[0]["theirs"], "手機版");

            // B 拉 A 的：A 的 hlc 較小 ⇒ 整筆判舊、B 零事件（敗方在 A 那邊已經記過了）
            let rb = pull_all(&b, &client, &key, &epoch, B).await;
            assert_eq!(
                text(&b, "SELECT name FROM nodes WHERE id='K1'").await.as_deref(),
                Some("手機版")
            );
            assert_eq!(rb.conflicts, 0, "勝方不記");
            assert!(conflicts_of(&b, "K1").await.is_empty());

            // ④ per-device 游標與 seen 都寫在對的鍵上（§2.4）
            assert!(
                text(&a, &format!("SELECT value FROM sync_meta WHERE key='last_pull_key:{B}'"))
                    .await
                    .is_some()
            );
            assert!(
                text(&a, &format!("SELECT value FROM sync_meta WHERE key='seen:{B}'"))
                    .await
                    .is_some()
            );
            assert!(
                text(&a, "SELECT value FROM sync_meta WHERE key='last_pull_key'").await.is_none(),
                "v1.1.2 不再用單一游標"
            );

            // ⑤ 收工：把這一輪的沙盒物件逐一刪掉
            let left = client.list_after(&root, "").await.unwrap();
            for k in &left {
                client.delete(k).await.unwrap();
            }
            let after = client.list_after(&root, "").await.unwrap();
            assert!(after.is_empty(), "收工要把沙盒物件刪乾淨");

            drop_pool(a, pa).await;
            drop_pool(b, pb).await;
        });
    }

    /// 評審 B1 第二層：爸爸那一筆**永遠不會來**（例如舊版在總開關關著時把它漏掉了）。
    /// 舊行為＝COMMIT 撞 FK ⇒ `apply_object` 回 Err ⇒ 游標不推進 ⇒ 副本從此收不到任何新物件。
    /// 新行為＝孤兒列在 COMMIT 前被撤掉、記進 skipped，其餘照收，**游標照推**。
    #[test]
    fn 父列永遠不來的孤兒_不會讓整個物件卡死() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("fk-orphan").await;
            let ops = vec![
                // 孤兒：parent_id 指向一個這輩子都不會到的 GHOST
                mk_op(
                    "17581536000000010-aaaaaaaa",
                    "nodes",
                    "C",
                    OpKind::Upsert,
                    &[("kind", "train".into()), ("name", "孤兒".into()), ("parent_id", "GHOST".into())],
                ),
                // 掛在孤兒身上的乘務記錄：NOT NULL 欄齊全，會先寫進去，撤爸爸時要跟著被撤
                mk_op(
                    "17581536000000011-aaaaaaaa",
                    "work_logs",
                    "W",
                    OpKind::Upsert,
                    &[
                        ("node_id", "C".into()),
                        ("body", "発車".into()),
                        ("logged_at", "2026-09-18T00:00:00.000Z".into()),
                    ],
                ),
                // 正常的一筆：不該被孤兒連累
                mk_op(
                    "17581536000000012-aaaaaaaa",
                    "nodes",
                    "OK",
                    OpKind::Upsert,
                    &[("kind", "route".into()), ("name", "沒事的".into())],
                ),
            ];
            let r = apply_object(&dst, &make_obj("dev-a", ops), "k-orphan", "dev-self")
                .await
                .expect("孤兒不該讓整個物件回 Err");
            assert_eq!((r.applied, r.skipped), (1, 2), "只有正常那一筆算採用，孤兒兩筆算跳過");
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes WHERE id='C'").await, 0);
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM work_logs WHERE id='W'").await, 0);
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes WHERE id='OK'").await, 1);
            assert_eq!(
                count(&dst, "SELECT COUNT(*) FROM sync_cells WHERE row_id IN ('C','W')").await,
                0,
                "撤掉的列要連格子一起清，日後爸爸補到了才收得回來"
            );
            assert_eq!(
                text(&dst, "SELECT value FROM sync_meta WHERE key='last_pull_key:dev-a'").await.as_deref(),
                Some("k-orphan"),
                "游標一定要推進——不然每 60 秒重炸同一個物件"
            );
            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 快照含_tombstone_復原才傳得過去() {
        tauri::async_runtime::block_on(async {
            let (src, src_path) = make_pool("tomb-src").await;
            sqlx::query(
                "INSERT INTO nodes (id, kind, name, deleted_at) \
                 VALUES ('D1','train','已作廢','2026-09-01T00:00:00.000Z')",
            )
            .execute(&src)
            .await
            .unwrap();
            snapshot_into_outbox(&src, "dev-primary").await.unwrap();
            let object = drain_outbox(&src, "dev-primary").await;
            assert_eq!(object.ops.len(), 1, "tombstone 也要進快照");

            let (dst, dst_path) = make_pool("tomb-dst").await;
            apply(&dst, &object, "k1").await;
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes WHERE deleted_at IS NOT NULL").await, 1);

            // 之後主人在正本「復原」它：deleted_at=NULL 的 op 在副本找得到列可改
            let restore = make_obj(
                "dev-primary",
                // 快照的 hlc 用的是「現在」，所以復原這一筆必須比現在還新才贏得了 LWW
                vec![mk_op(
                    "29991536000000010-aaaaaaaa",
                    "nodes",
                    "D1",
                    OpKind::Upsert,
                    &[("deleted_at", Value::Null)],
                )],
            );
            let r = apply(&dst, &restore, "k2").await;
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes WHERE deleted_at IS NULL").await, 1);
            assert_eq!(
                r.conflicts, 0,
                "明確的『復原』op（deleted_at:null 在 cols 裡）走一般 LWW，不是復活、不記競合（§3.3 末條）"
            );

            drop_pool(src, src_path).await;
            drop_pool(dst, dst_path).await;
        });
    }

    // ─────────────────────────────────────────────────────────
    // v1.1.2 §3.6：LWW 判定表／編輯勝刪除／紀元比較
    // ─────────────────────────────────────────────────────────

    /// 本機（dev-self）自己改了一格：寫值＋戳格子（＝TS 寫入路徑做的兩件事）。
    /// `col` 是測試裡的字面常數，不是外來字串。
    async fn local_edit(pool: &Pool<Sqlite>, row_id: &str, col: &str, value: Option<&str>, hlc: &str) {
        sqlx::query(&format!("UPDATE nodes SET {col} = ? WHERE id = ?"))
            .bind(value)
            .bind(row_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sync_cells (tbl, row_id, col, hlc, device_id) VALUES ('nodes', ?, ?, ?, 'dev-self') \
             ON CONFLICT(tbl, row_id, col) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id",
        )
        .bind(row_id)
        .bind(col)
        .bind(hlc)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 一張本機的票（N1），外加一個掛得住競合日誌的節點
    async fn seed_one(pool: &Pool<Sqlite>) {
        sqlx::query("INSERT INTO nodes (id, kind, name) VALUES ('N1','train','本機版')")
            .execute(pool)
            .await
            .unwrap();
    }

    const H10: &str = "17581536000000010-cccccccc"; // 本機（dev-self）的一版
    const H20: &str = "17581536000000020-bbbbbbbb"; // 對方（dev-b）較新的一版
    const H05: &str = "17581536000000005-bbbbbbbb"; // 對方較舊的一版

    #[test]
    fn 同列同欄併發_值換成對方的且記一筆競合() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-race").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "name", Some("本機版"), H10).await;

            // dev-b 沒看過本機那一版（seen 空）⇒ 真併發
            let obj = make_obj(
                "dev-b",
                vec![mk_op(H20, "nodes", "N1", OpKind::Upsert, &[("name", "對方版".into())])],
            );
            let r = apply(&dst, &obj, "k1").await;

            assert_eq!((r.applied, r.conflicts), (1, 1));
            assert_eq!(text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(), Some("對方版"));
            assert!(r.changed.contains(&"work_logs".to_string()), "側板要重載才看得到競合");

            let cf = conflicts_of(&dst, "N1").await;
            assert_eq!(cf.len(), 1);
            assert_eq!(cf[0]["col"], "name");
            assert_eq!(cf[0]["mine"], "本機版");
            assert_eq!(cf[0]["theirs"], "對方版");
            assert_eq!(cf[0]["their_device"], "dev-b");
            assert_eq!(cf[0]["mine_hlc"], H10);
            assert_eq!(cf[0]["hlc"], H20);
            assert_eq!(cf[0]["tbl"], "nodes");
            assert_eq!(cf[0]["row_id"], "N1");

            drop_pool(dst, path).await;
        });
    }

    /// 整合席沙盒情境②的回歸：真的寫入路徑每次都會帶 `updated_at`，
    /// 若記帳欄也記事件，主人的乘務記錄每次衝突都會多一行讀不懂的 ISO 時刻。
    #[test]
    fn 記帳欄不記事件_只留真正該讀的那一行() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-book").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "name", Some("本機版"), H10).await;
            local_edit(&dst, "N1", "updated_at", Some("2026-09-19T00:00:00.000Z"), H10).await;

            let obj = make_obj(
                "dev-b",
                vec![mk_op(
                    H20,
                    "nodes",
                    "N1",
                    OpKind::Upsert,
                    &[
                        ("name", "對方版".into()),
                        ("updated_at", "2026-09-19T01:00:00.000Z".into()),
                    ],
                )],
            );
            let r = apply(&dst, &obj, "k1").await;

            // 兩欄都照 LWW 採用，但只有 name 進乘務記錄
            assert_eq!(r.conflicts, 1, "記帳欄不該多記一筆");
            assert_eq!(
                text(&dst, "SELECT updated_at FROM nodes WHERE id='N1'").await.as_deref(),
                Some("2026-09-19T01:00:00.000Z"),
                "updated_at 仍要照 LWW 更新"
            );
            let cf = conflicts_of(&dst, "N1").await;
            assert_eq!(cf.len(), 1);
            assert_eq!(cf[0]["col"], "name");

            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 對方已看過我這一版_照套但零事件() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-seen").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "name", Some("本機版"), H10).await;

            // seen 說「dev-self 的 …010 我已經套過了」⇒ 對方是在看過之後才改的＝我單純落後
            let obj = make_obj_seen(
                "dev-b",
                &[("dev-self", H10)],
                vec![mk_op(H20, "nodes", "N1", OpKind::Upsert, &[("name", "對方版".into())])],
            );
            let r = apply(&dst, &obj, "k1").await;

            assert_eq!((r.applied, r.conflicts), (1, 0));
            assert_eq!(text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(), Some("對方版"));
            assert!(conflicts_of(&dst, "N1").await.is_empty());

            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 較舊的op_跳過且零事件() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-old").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "name", Some("本機版"), H10).await;
            // 評審 S3 起，「不記」的前提是**這一版已經推出去了**——對方收得到，會自己記一筆。
            // 還沒推出去的贏家反而要由這台記（見 `本機是還沒push的贏家_也要記一筆競合`）。
            meta_set(&dst, "last_push_hlc", H10).await.unwrap();

            let obj = make_obj(
                "dev-b",
                vec![mk_op(H05, "nodes", "N1", OpKind::Upsert, &[("name", "更舊的".into())])],
            );
            let r = apply(&dst, &obj, "k1").await;

            assert_eq!((r.applied, r.skipped, r.conflicts), (0, 1, 0));
            assert_eq!(text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(), Some("本機版"));
            assert!(
                conflicts_of(&dst, "N1").await.is_empty(),
                "敗方是對方——他那台 pull 我的物件時會自己記，這裡不該記"
            );

            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 值相同_雙蓋同班零噪音() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-same").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "status", Some("done"), H10).await;

            // 兩台各自把同一張票蓋成 done：值一樣，不是衝突（自決 3）
            let obj = make_obj(
                "dev-b",
                vec![mk_op(H20, "nodes", "N1", OpKind::Upsert, &[("status", "done".into())])],
            );
            let r = apply(&dst, &obj, "k1").await;

            assert_eq!((r.applied, r.conflicts), (1, 0));
            assert!(conflicts_of(&dst, "N1").await.is_empty());

            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 收到刪除_本機有併發編輯_保留這張票() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-del-vs-edit").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "name", Some("本機改的").into(), H10).await;

            // dev-b 沒看過我這一版就把票刪了 ⇒ 編輯勝刪除：deleted_at 不套，其餘欄照 LWW
            let obj = make_obj(
                "dev-b",
                vec![mk_op(
                    H20,
                    "nodes",
                    "N1",
                    OpKind::Delete,
                    &[
                        ("deleted_at", "2026-09-19T01:00:00.000Z".into()),
                        ("updated_at", "2026-09-19T01:00:00.000Z".into()),
                    ],
                )],
            );
            let r = apply(&dst, &obj, "k1").await;

            assert_eq!(r.conflicts, 1);
            assert_eq!(
                count(&dst, "SELECT COUNT(*) FROM nodes WHERE id='N1' AND deleted_at IS NULL").await,
                1,
                "編輯勝刪除：票要活著"
            );
            assert_eq!(
                text(&dst, "SELECT updated_at FROM nodes WHERE id='N1'").await.as_deref(),
                Some("2026-09-19T01:00:00.000Z"),
                "其餘欄照 LWW"
            );
            assert_eq!(
                text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(),
                Some("本機改的")
            );
            assert!(
                text(&dst, "SELECT hlc FROM sync_cells WHERE row_id='N1' AND col='deleted_at'")
                    .await
                    .is_none(),
                "沒採用就不該戳 deleted_at 的格子"
            );
            let cf = conflicts_of(&dst, "N1").await;
            assert_eq!(cf[0]["col"], "deleted_at");
            assert_eq!(cf[0]["mine"], Value::Null);
            assert_eq!(cf[0]["theirs"], "2026-09-19T01:00:00.000Z");

            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 本機已刪_收到併發編輯_復活並戳本機新hlc() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-edit-vs-del").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "deleted_at", Some("2026-09-01T00:00:00.000Z"), H10).await;

            // dev-b 沒看過我這個刪除就改了名字 ⇒ 復活（對方那台 pull 我的刪除時會走上一條規則拒收）
            let obj = make_obj(
                "dev-b",
                vec![mk_op(H20, "nodes", "N1", OpKind::Upsert, &[("name", "對方改的".into())])],
            );
            let r = apply(&dst, &obj, "k1").await;

            assert_eq!(r.conflicts, 1);
            assert_eq!(
                count(&dst, "SELECT COUNT(*) FROM nodes WHERE id='N1' AND deleted_at IS NULL").await,
                1,
                "要復活"
            );
            assert_eq!(text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(), Some("對方改的"));

            // 復活那一格必須是**本機的新 hlc**（用 op.hlc 會被 stamp_cell 的 `excluded.hlc > hlc` 拒收）
            let fresh =
                text(&dst, "SELECT hlc FROM sync_cells WHERE row_id='N1' AND col='deleted_at'").await.unwrap();
            let owner = text(
                &dst,
                "SELECT device_id FROM sync_cells WHERE row_id='N1' AND col='deleted_at'",
            )
            .await
            .unwrap();
            assert!(fresh.as_str() > H20, "復活戳記要比收到的那一批都新：{fresh}");
            assert!(fresh.ends_with("-dev-self"), "戳的是本機 device：{fresh}");
            assert_eq!(owner, "dev-self");
            assert_eq!(
                count(&dst, "SELECT COUNT(*) FROM sync_outbox").await,
                0,
                "復活不進 outbox（對方從沒套用過這個刪除，兩台自然收斂）"
            );

            let cf = conflicts_of(&dst, "N1").await;
            assert_eq!(cf[0]["col"], "deleted_at");
            assert_eq!(cf[0]["mine"], "2026-09-01T00:00:00.000Z");
            assert_eq!(cf[0]["theirs"], Value::Null);

            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 遠端的競合日誌不套用() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-remote-log").await;
            seed_one(&dst).await;
            let obj = make_obj(
                "dev-b",
                vec![mk_op(
                    H20,
                    "work_logs",
                    "WX",
                    OpKind::Upsert,
                    &[
                        ("node_id", "N1".into()),
                        ("body", "{\"col\":\"name\"}".into()),
                        ("logged_at", "2026-09-19T00:00:00.000Z".into()),
                        ("event", "conflict".into()),
                    ],
                )],
            );
            let r = apply(&dst, &obj, "k1").await;
            assert_eq!((r.applied, r.skipped, r.conflicts), (0, 1, 0));
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM work_logs").await, 0);
            drop_pool(dst, path).await;
        });
    }

    #[test]
    fn 快照不搬競合日誌() {
        tauri::async_runtime::block_on(async {
            let (src, path) = make_pool("snap-no-conflict").await;
            seed_one(&src).await;
            sqlx::query(
                "INSERT INTO work_logs (id, node_id, body, logged_at, event) VALUES \
                 ('W1','N1','発車','2026-09-19T00:00:00.000Z','issued'), \
                 ('W2','N1','{}','2026-09-19T00:00:01.000Z','conflict')",
            )
            .execute(&src)
            .await
            .unwrap();
            let n = snapshot_into_outbox(&src, "dev-self").await.unwrap();
            assert_eq!(n, 2, "一個節點＋一筆 issued 日誌；conflict 那筆不搬");
            assert_eq!(
                count(&src, "SELECT COUNT(*) FROM sync_outbox WHERE row_id='W2'").await,
                0
            );
            drop_pool(src, path).await;
        });
    }

    /// `adopt_epoch` 的「清空本機」那一步：一棵完整的樹（含自我參照的 parent_id）＋子表＋同步表
    /// 要能一次清乾淨、settings 要留著。`make_pool` 的 `foreign_keys(true)` 跟 plugin-sql 的 pool 同條件，
    /// 所以這支也順便守住「刪除順序不能改」。
    #[test]
    fn 清空本機資料_自我參照外鍵不會擋住() {
        tauri::async_runtime::block_on(async {
            let (pool, path) = make_pool("wipe").await;
            seed_tree(&pool).await;
            sqlx::query("INSERT INTO sync_outbox (hlc, tbl, row_id, op, payload) VALUES ('h','nodes','L1','upsert','{}')")
                .execute(&pool)
                .await
                .unwrap();

            let mut tx = pool.begin().await.unwrap();
            wipe_local_data(&mut tx).await.expect("整表刪除不該撞外鍵");
            tx.commit().await.expect("COMMIT 時全表已空，外鍵檢查要過");

            for sql in [
                "SELECT COUNT(*) FROM nodes",
                "SELECT COUNT(*) FROM work_logs",
                "SELECT COUNT(*) FROM occurrences",
                "SELECT COUNT(*) FROM sync_outbox",
                "SELECT COUNT(*) FROM sync_cells",
            ] {
                assert_eq!(count(&pool, sql).await, 0, "{sql}");
            }
            assert_eq!(
                count(&pool, "SELECT COUNT(*) FROM settings").await,
                2,
                "settings 不動（主題／書封是這台自己的偏好）"
            );
            drop_pool(pool, path).await;
        });
    }

    #[test]
    fn 紀元比較_只認數字且要比自己大() {
        let dirs = [
            "v1/1758153600000",
            "v1/1758153600001",
            "v1/sandbox-abc",   // 沙盒：非數字，一律忽略
            "v1/1758153500000", // 比自己舊
            "v1/EPOCH-nope",
        ];
        assert_eq!(
            newer_epoch_of(dirs, "1758153600000"),
            Some(1_758_153_600_001),
            "要挑比自己大的最大數字紀元"
        );
        assert_eq!(newer_epoch_of(dirs, "1758153600001"), None, "自己已經是最大的");
        assert_eq!(
            newer_epoch_of(dirs, "sandbox-abc"),
            None,
            "自己的紀元非數字（沙盒）⇒ 整個偵測跳過，絕不干擾主人正本"
        );
        assert_eq!(newer_epoch_of(["v1/1758153600001/"], "1758153600000"), Some(1_758_153_600_001));
    }

    #[test]
    fn 值相同判定_整數欄的字串包裝也算一樣() {
        assert!(same_value(&Value::from(3), &Value::from("3"), true));
        assert!(!same_value(&Value::from(3), &Value::from(4), true));
        assert!(same_value(&Value::Null, &Value::Null, false));
        assert!(!same_value(&Value::Null, &Value::from(""), false));
        assert!(same_value(&Value::from("done"), &Value::from("done"), false));
    }

    #[test]
    fn 白名單不含快取欄與同步預備欄() {
        let nodes: Vec<&str> = columns_of("nodes").unwrap().iter().map(|(c, _)| *c).collect();
        for banned in ["line_id", "account_id", "device_id", "synced_at", "id"] {
            assert!(!nodes.contains(&banned), "{banned} 不該進 oplog");
        }
        assert!(
            nodes.contains(&"route_id"),
            "route_id 要在（根層臨時車票用），例外在快照端過濾"
        );
        assert!(columns_of("sync_meta").is_none(), "機制表不可同步");
        assert!(columns_of("sync_outbox").is_none(), "機制表不可同步");
    }

    #[test]
    fn 整數欄標記正確() {
        let ints: Vec<&str> = columns_of("nodes")
            .unwrap()
            .iter()
            .filter(|(_, i)| *i)
            .map(|(c, _)| *c)
            .collect();
        assert_eq!(
            ints,
            vec![
                "position",
                "estimate_min",
                "progress",
                "time_spent_min",
                "today_position"
            ]
        );
    }

    #[test]
    fn 值轉綁定() {
        assert!(matches!(bound_of(&Value::Null, false), Bound::Null));
        assert!(matches!(bound_of(&Value::from(3), true), Bound::Int(3)));
        assert!(matches!(bound_of(&Value::from("7"), true), Bound::Int(7)));
        match bound_of(&Value::from("hi"), false) {
            Bound::Text(s) => assert_eq!(s, "hi"),
            _ => panic!("字串欄應該綁字串"),
        }
    }

    #[test]
    fn op_序列化成契約字面值() {
        let op = Op {
            hlc: "17581536001230000-3f9c2b1e".into(),
            tbl: "nodes".into(),
            row_id: "n1".into(),
            op: OpKind::Delete,
            cols: Map::new(),
        };
        let s = serde_json::to_string(&op).unwrap();
        assert!(s.contains("\"op\":\"delete\""), "{s}");
        let back: Op = serde_json::from_str(&s).unwrap();
        assert!(matches!(back.op, OpKind::Delete));
    }

    #[test]
    fn 物件序列化成契約形狀() {
        let obj = OplogObject {
            version: OPLOG_VERSION,
            epoch: "1758153600000".into(),
            device_id: "dev".into(),
            hlc_from: "17581536001230000-3f9c2b1e".into(),
            hlc_to: "17581536001230001-3f9c2b1e".into(),
            schema: SCHEMA_VERSION,
            seen: Default::default(),
            ops: vec![],
        };
        let s = serde_json::to_string(&obj).unwrap();
        for needle in ["\"version\":1", "\"schema\":4", "\"hlc_from\"", "\"device_id\""] {
            assert!(s.contains(needle), "{needle} 不見了：{s}");
        }
    }

    // ── v1.1.2 評審修正的回歸測試 ──

    /// 評審 B1：快照超過 `PUSH_BATCH` 筆時，每一批的第一筆 hlc 都必須不同
    /// ——物件名＝`…/<該批第一筆 hlc>.bin`，相同就是第二批 PUT 覆蓋第一批＝靜默吃資料。
    #[test]
    fn 快照每筆各自一個hlc_超過一批也不會撞出同名物件() {
        tauri::async_runtime::block_on(async {
            let (src, path) = make_pool("snap-uniq").await;
            seed_one(&src).await;
            let extra = PUSH_BATCH + 5;
            let mut tx = src.begin().await.unwrap();
            for i in 0..extra {
                sqlx::query(
                    "INSERT INTO work_logs (id, node_id, body, logged_at) VALUES (?, 'N1', ?, ?)",
                )
                .bind(format!("W{i:05}"))
                .bind(format!("第 {i} 筆"))
                .bind(format!("2026-09-19T00:00:{:02}.000Z", i % 60))
                .execute(&mut *tx)
                .await
                .unwrap();
            }
            tx.commit().await.unwrap();

            let n = snapshot_into_outbox(&src, "dev-primary").await.unwrap();
            assert_eq!(n, (extra + 1) as u64, "一張票＋{extra} 筆日誌");
            assert_eq!(
                count(&src, "SELECT COUNT(DISTINCT hlc) FROM sync_outbox").await,
                count(&src, "SELECT COUNT(*) FROM sync_outbox").await,
                "每一筆都要有自己的 hlc"
            );

            // push_loop 會依 seq 切批；每一批的第一筆就是那個物件的名字
            let firsts: Vec<String> = sqlx::query(&format!(
                "SELECT hlc FROM (SELECT hlc, ROW_NUMBER() OVER (ORDER BY seq) AS rn FROM sync_outbox) \
                 WHERE (rn - 1) % {PUSH_BATCH} = 0"
            ))
            .fetch_all(&src)
            .await
            .unwrap()
            .iter()
            .map(|r| r.try_get::<String, _>("hlc").unwrap())
            .collect();
            assert!(firsts.len() >= 2, "要真的切成兩批以上：{}", firsts.len());
            assert_ne!(firsts[0], firsts[1], "兩批的物件名不能相同");

            drop_pool(src, path).await;
        });
    }

    /// 產品評審 S3：雙蓋同班時 `completed_at` 差幾百毫秒是常態，不該長成一行讀不懂的競合。
    #[test]
    fn 完成時刻不記競合事件() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-completed").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "status", Some("done"), H10).await;
            local_edit(&dst, "N1", "completed_at", Some("2026-09-20T01:02:03.245Z"), H10).await;

            let obj = make_obj(
                "dev-b",
                vec![mk_op(
                    H20,
                    "nodes",
                    "N1",
                    OpKind::Upsert,
                    &[
                        ("status", "done".into()),
                        ("completed_at", "2026-09-20T01:02:03.469Z".into()),
                    ],
                )],
            );
            let r = apply(&dst, &obj, "k1").await;

            assert_eq!(r.conflicts, 0, "兩台都蓋同一班＝零噪音");
            assert_eq!(conflicts_of(&dst, "N1").await.len(), 0);
            // 值本身照走 LWW
            assert_eq!(
                text(&dst, "SELECT completed_at FROM nodes WHERE id='N1'").await.as_deref(),
                Some("2026-09-20T01:02:03.469Z")
            );

            drop_pool(dst, path).await;
        });
    }

    /// 評審 S3：本機這一格比較新**而且還沒 push** ⇒ 對方判不出併發，由這台記一筆（winner=mine）。
    #[test]
    fn 本機是還沒push的贏家_也要記一筆競合() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("cf-unpushed-winner").await;
            seed_one(&dst).await;
            local_edit(&dst, "N1", "name", Some("這台改的"), H20).await; // 本機較新

            // dev-b 較舊的一版（H05）——被 LWW 擋下，但對方那台永遠不會知道
            let obj = make_obj(
                "dev-b",
                vec![mk_op(H05, "nodes", "N1", OpKind::Upsert, &[("name", "對方改的".into())])],
            );
            let r = apply(&dst, &obj, "k1").await;

            assert_eq!(r.conflicts, 1);
            assert_eq!(
                text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(),
                Some("這台改的"),
                "值不變——贏的是本機"
            );
            let cf = conflicts_of(&dst, "N1").await;
            assert_eq!(cf[0]["col"], "name");
            assert_eq!(cf[0]["winner"], "mine");
            assert_eq!(cf[0]["mine"], "這台改的");
            assert_eq!(cf[0]["theirs"], "對方改的");

            drop_pool(dst, path).await;
        });
    }

    /// 評審 S7：較新版本改了 `ops` 形狀（整包解不開）時，閘門仍要判得出來。
    #[test]
    fn 版號閘門先於完整解析() {
        let newer = serde_json::json!({
            "version": 1,
            "epoch": "1758153600000",
            "device_id": "dev-b",
            "hlc_from": "17581536000000010-bbbbbbbb",
            "hlc_to": "17581536000000010-bbbbbbbb",
            "schema": SCHEMA_VERSION + 1,
            // v1.2 假想的新形狀：ops 從陣列變成物件 ⇒ `OplogObject` 解不開
            "ops": { "nodes": [] },
        });
        let bytes = serde_json::to_vec(&newer).unwrap();
        assert!(
            serde_json::from_slice::<OplogObject>(&bytes).is_err(),
            "前提：整包確實解不開"
        );
        let head: OplogHead = serde_json::from_slice(&bytes).expect("前兩個版號要解得出來");
        assert!(head.schema > SCHEMA_VERSION, "才擋得住");
    }
}
