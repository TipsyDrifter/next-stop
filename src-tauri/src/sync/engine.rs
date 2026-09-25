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
//!   * **還原＝新紀元**：`backup_restore` 換檔後留標記檔 → 重啟 → 收尾（清游標／cells、epoch 換新、
//!     寫 `<root>/<epoch>/EPOCH.bin`、全庫快照重上傳）；另一台偵測到更大的數字紀元 ⇒ `pending_epoch`
//!     → `phase=epoch_changed` → 主人確認 → `adopt_epoch`（未推的 outbox 先匯出 JSON、清本機資料、換紀元、重拉全量）。
//!
//! **v1.1.3 同步規則重整**（WP-A 已填；規格＝`docs/research/2026-09-21-v1.1.3-同步規則重整契約.md`；
//! 拍板＝決策記錄〈同步與備份規則重整拍板〉＋《同步與備份-提案》三條規則＋《…反駁評審》B1–B4）：
//!   * **單一入口 `join`**（§4.2，評審 B3）：填憑證→先列桶——空＝第一台（開紀元、寫 SALT／KEY）；非空→
//!     這台空＝直接拉、兩邊有料問一次（兩邊都保留／改用另一台的）；紀元＋鹽一致＝同一份資料重接、
//!     只更新憑證不問。`configure`／`apply_pairing_code`／`begin_new_epoch` 與 `Role` 全部退場。
//!   * **兩層鑰匙**（§2.1）：隨機**資料鑰匙**加密所有物件；密語 argon2id 派生的**包裝鑰匙**只把資料鑰匙
//!     包成 `<root>/KEY`（自帶 kdf 鹽）。改密語＝重寫那一顆物件、資料不重傳；其他裝置不受影響
//!     （它們鑰匙圈存的是資料鑰匙）。舊血統（v1.1.2）的派生金鑰升級後**就是**資料鑰匙（§7 ①）。
//!   * **血統放桶裡**（§2）：`<root>/SALT` 是唯一來源；配對碼降為「省手打」的便利、不再帶鹽與身分。
//!     桶內根 `<root>` 由 credstore 決定（正式 `v1`、沙盒 `v1-sb-<run>`），所有物件 key 都吃它。
//!   * **身分放鑰匙圈**（§3.1，評審 B4）：沒鑰匙圈＝新的一台（複製資料夾也是）；還原不換身分只清游標。
//!     閘門鍵 `role` → `joined`。
//!   * **合併用原始時間戳**（§5，評審 B1）：`stamp_missing_cells` 用 `updated_at` 派生沒同步過的格子；
//!     快照**讀格子**（一列可拆多筆 op），對 cells 零寫入；物件名改成 **push 戳記**（§5.4）。
//!   * **還原二選一**（§6，評審 B2）：回到過去（開新紀元、cells 不清）／接上現在（只清游標）；
//!     標記檔帶 choice 過重啟。
//!   * **紀元偵測「拆得開即承認」**（§5.6，評審 S1／N2）：兩端都偵測、不再比對 opener；拆不開的更大紀元
//!     ＝鍵違い（`locked`，可見狀態）。
//!
//! 資料形狀（serde 欄位名＝TS `src/data/syncRepository.ts` 同名同形，snake_case 不轉 camel）：
//!   * `OplogObject` ＝ 一個 R2 物件拆封後的 JSON：{version:1, epoch, device_id, hlc_from, hlc_to, schema:4, ops:[…]}
//!   * `Op`          ＝ {hlc, tbl, row_id, op:'upsert'|'delete', cols:{col: value}}——與 sync_outbox 一列同形
//!   * `SyncStatus`  ＝ `sync_status()` 回給 UI 的全部（契約 §5.1）
//!
//! 機制摘要：
//!   * 加入／還原：`stamp_missing_cells` 先把沒同步過的格子補上**原始時間戳**，再
//!     `snapshot_into_outbox`——三張表**全部列（含 tombstone）**＋settings 白名單，每一欄的 hlc 取自格子、
//!     同列同戳的欄合成一筆 op。nodes 以遞迴 CTE 父先子後排序。
//!   * push（兩端）：讀 outbox 依 seq → 組 `OplogObject`（hlc_from／hlc_to＝這批的最小／最大）→ JSON → zstd →
//!     seal(aad=key) → put(key=`<root>/<epoch>/<device_id>/<推送戳記>.bin`) → 同一交易 DELETE outbox
//!     WHERE seq<=max、sync_meta.last_push_hlc／last_sync_at。PUT 前先落 `inflight_key`／`inflight_max_seq`／
//!     `last_object_stamp`，PUT 成功而 DB 失敗時下次憑它重組**同一段 op**＝同 key 同內容（評審 B2；
//!     不看它會用新內容蓋掉舊物件、靜默吃資料）。
//!   * pull（兩端）：每台一個游標 `last_pull_key:<dev>`，全部裝置的物件收齊後依檔名全域排序再套 → 逐物件 get → open → 解 JSON
//!     → `schema > SCHEMA_VERSION` ⇒ 信号待ち（不推進游標、狀態 gated；**較舊**的物件照套＝前向相容，評審 S1）
//!     → 否則 `apply_object` 一個物件一個交易
//!     （`PRAGMA defer_foreign_keys = ON`；逐 op 逐欄比 sync_cells；COMMIT 前 `prune_fk_violations` 撤掉
//!       這趟剛塞進去的孤兒列；最後重算 line_id／route_id；更新 last_pull_key）。
//!   * apply 不觸發任何業務邏輯（不寫 issued／punched／done 事件、不跑 syncRepeats）；缺 NOT NULL 欄的 INSERT 跳過並記數。
//!
//! **v1.1.4 雲端備份＋真撤銷密語**（契約席 2026-09-22 立骨架；規格＝
//! `docs/research/2026-09-22-v1.1.4-雲端備份與真撤銷契約.md`；拍板＝決策記錄〈v1.1.4 開工拍板〉D-1／D-2／D-3）：
//!   * **雲端快照**的機制（上傳／列表／階梯清理／JSON 匯入／雲端還原）拆到新模組 `snapshot.rs`（WP-B），
//!     本檔只提供零件：`build_full_json`（純字串）、`write_export_file`、`keyed_client`（取鑰匙＋client＋圍籬）、
//!     `switch_epoch_local`（`finish_restore(Past)` 抽出來的「切紀元」共用段）、`sweep_old_epochs`（掃地工）。
//!   * **真撤銷密語**＝`change_passphrase(…, rotate=true)` → `rotate_data_key`（七步，契約 §5）：產 K2 → 鎖 E2 →
//!     PUT KEY（提交點）→ 本機切 E2／K2 → 重加密快照 → 刪舊紀元 → 清標記。標記檔 `sync/rotation-pending`
//!     帶階段，boot 看到就 `finish_rotation` 續跑；提交點之前斷掉＝回滾（新密語沒存、不能續）。
//!   * 別台看到拆不開的新紀元＝既有 `locked=<E2>`；`<root>/<E2>/ROTATED` 旗標在 ⇒ `locked_reason=rotated`（文案分流）。
//!   * `skipped_missing`：必填欄不齊的新列另計，累進 `sync_meta.skipped_missing_total`。
//!   * `sync_meta.role`／`primary_device_id` 一次 DELETE（從此不能退回 1.1.2，拍板接受）。
//!
//! 狀態機（`phase`，契約 §4.3 的判定順序）：off（從沒加入）／paused（加入了但總開關關著）／
//!   epoch_changed（改正待ち）／locked（鍵違い）／gated（信号待ち）／stopped（停車中：憑證缺或上次失敗）／
//!   running（運行中）。
//! 總開關關著＝**只停網路**，變更照樣記進 outbox／cells（閘門看 `joined` 不看 `enabled`，見
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
    /// v1.1.3（契約 §8.5「鍵違い」）：雲端上有這台的密語打不開的東西——`sync_meta.locked`＝`salt`
    /// （桶裡的 SALT 與這台不同＝血統已被別的密語重建）或紀元號（更大的紀元、EPOCH.bin 拆不開）。
    /// 朱點，同信号待ち；出路是「重新加入」並輸入新密語。
    Locked,
    /// v1.1.4（契約 §5）：這台正在換資料鑰匙（`sync/rotation-pending` 標記檔在）。push／pull 都擋；
    /// boot 看到就 `finish_rotation` 續跑。文案「換鑰匙中」。
    Rotating,
}

/// v1.1.4（契約 §4）：`locked=<紀元>` 的原因——`rotated`＝那個紀元有 `<root>/<E>/ROTATED` 旗標（另一台換過鑰匙，
/// 出路是用新密語重新加入）；`stale`＝沒旗標（殘留或竄改，沿 v1.1.3 的舊文案）。`locked='salt'` 時為 None。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LockedReason {
    Rotated,
    Stale,
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

/// `sync_status()` 的回傳（v1.1.3 契約 §4.3；`role` 已退場）
#[derive(Debug, Clone, Serialize)]
pub struct SyncStatus {
    pub enabled: bool,
    /// credstore 為準的身分；沒鑰匙圈時給 sync_meta 的快取（從沒加入過的桌機＝v1.1.2 的 ensure_device_id 那一列）
    pub device_id: String,
    pub epoch: Option<String>,
    /// 鑰匙圈有資料鑰匙＝這台加入了（正本／副本退場後，「加入」只有這一個判準）
    pub configured: bool,
    /// 這顆 DB 記得自己加入過（`sync_meta.joined='1'`）。**與 `configured` 分開報**是工程評審 B-1 的要求：
    /// 鑰匙圈「讀取失敗」與「沒有鑰匙圈」在 `configured` 上長得一樣，但後果天差地遠——
    /// `joined && !configured && last_error` ⇒ 憑證庫讀不到，UI 不准露出「加入同步」表單
    /// （露出來主人一按就變成新的一台、整包資料再推一份）。
    pub joined: bool,
    /// 桶內根前綴（credstore.root；沙盒對帳用）
    pub root: Option<String>,
    pub phase: Phase,
    /// 目前有 push／pull 在飛
    pub busy: bool,
    /// UTC ISO；null＝還沒成功過
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    /// outbox 待上傳筆數。v1.1.2 起**兩端都照實回報**（v1.1.1 的「replica 恆 0」作廢——
    /// 那時副本永遠不送、數字只會往上跳；現在會送出去，數字會歸零，報實數才有意義）。
    pub pending_ops: u64,
    /// v1.1.3（提案 S4）：outbox 最早／最晚 op 的時刻——改正待ち文案要講「這 N 筆是幾點到幾點之間改的」
    pub pending_span: Option<PendingSpan>,
    pub schema: u32,
    /// 信号待ち時對方物件的 schema
    pub remote_schema: Option<u32>,
    /// v1.1.2：還原剛完成、尚未收尾（`app_data_dir/sync/epoch-pending` 標記檔在且這台有鑰匙圈）；
    /// boot 看到就叫 `sync_finish_restore`（契約 §6）
    pub restore_pending: bool,
    /// v1.1.3：標記檔裡主人選的還原方式；`restore_pending` 為 true 時非 null
    pub restore_choice: Option<RestoreChoice>,
    /// v1.1.2：偵測到的新紀元號（`sync_meta.pending_epoch`）；非 null ⇒ phase=epoch_changed
    pub pending_epoch: Option<String>,
    /// v1.1.3：那個紀元的 `EPOCH.bin` 內容（誰開的、何時、哪份備份）——文案用
    pub pending_epoch_info: Option<EpochInfo>,
    /// v1.1.3：`sync_meta.locked`（`salt` 或紀元號）；非 null ⇒ phase=locked（除非同時有可換的 pending_epoch）
    pub locked: Option<String>,
    /// v1.1.3：桶裡有沒有 `<root>/KEY`（改密語頁與加入提示用）；null＝還沒查過
    pub key_sealed: Option<bool>,
    /// v1.1.2 產品評審 B1：上一次「改用那份」另存了幾筆未送出的修改、存在哪、什麼時候。
    /// 同步頁常駐一行——不然這件事只在一聲 10 秒的 toast 裡講過，錯過就再也查不到。
    pub last_orphans: Option<LastOrphans>,
    /// v1.1.3：手機「改用另一台的」之前匯出的全量 JSON（桌機是拍 manual 備份，這欄為 null）
    pub last_export: Option<LastExport>,
    /// v1.1.4：`locked` 是紀元號時的原因（`rotated`／`stale`）；`locked` 為 null 或 `salt` 時為 null
    pub locked_reason: Option<LockedReason>,
    /// v1.1.4：累計「必填欄不齊而跳過的新列」（`sync_meta.skipped_missing_total`）；UI >0 才顯示一行
    pub skipped_missing_total: u64,
    /// v1.1.4：上一次雲端快照上傳成功的時刻（`sync_meta.last_cloud_snapshot_at`，UTC ISO）
    pub last_cloud_snapshot_at: Option<String>,
    /// v1.1.4：換鑰匙進行到哪一步（標記檔 `sync/rotation-pending` 的 `stage`）；非 null ⇒ phase=rotating
    pub rotation_stage: Option<String>,
}

/// 上一次重置時另存的未同步修改（見 `SyncStatus::last_orphans`）
#[derive(Debug, Clone, Serialize)]
pub struct LastOrphans {
    pub count: u64,
    pub path: String,
    /// UTC ISO
    pub at: String,
}

/// outbox 裡最早／最晚 op 的時刻（UTC ISO；由 hlc 的 13 位毫秒推回）
#[derive(Debug, Clone, Serialize)]
pub struct PendingSpan {
    pub from: String,
    pub to: String,
}

/// 手機「改用另一台的」之前匯出的全量 JSON（見 `SyncStatus::last_export`）
#[derive(Debug, Clone, Serialize)]
pub struct LastExport {
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
    /// v1.1.4：這趟「必填欄不齊而跳過的新列」（已含在 `skipped_ops` 裡；另計是為了讓 UI 講得出原因）
    pub skipped_missing: u64,
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
    /// v1.1.3 §4.7：這個進程已經對過桶裡的 `SALT`／`KEY`／`EPOCH.bin` 了（每台每個進程一次）
    pub bucket_meta_checked: bool,
    /// v1.1.4 §4.5：掃地工在這個進程「已經對哪個紀元掃過了」。
    /// 為什麼記紀元而不是一個 bool：換紀元（還原／改用那份／換鑰匙）之後舊紀元才真的變成垃圾，
    /// 那時要再掃一次；記 bool 就得等主人重開 App。
    pub swept_epoch: Option<String>,
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
    fn bucket_meta_done(&self) -> bool {
        self.inner.lock().map(|r| r.bucket_meta_checked).unwrap_or(false)
    }
    fn set_bucket_meta_done(&self) {
        if let Ok(mut r) = self.inner.lock() {
            r.bucket_meta_checked = true;
        }
    }
    /// 工程評審 S-9：`reset_local`／`join` 清的是 `sync_meta`，**進程旗標不會跟著清**。
    /// 不清的話重新加入之後 `ensure_bucket_meta` 會直接短路——新血統的 SALT 比對、`key_sealed`、
    /// 舊紀元的 `EPOCH.bin` 補寫全部要等主人重開 App 才會做。
    fn clear_bucket_meta_done(&self) {
        if let Ok(mut r) = self.inner.lock() {
            r.bucket_meta_checked = false;
        }
    }
    /// v1.1.4 §4.5：這個紀元還沒掃過就佔位（回 true＝這趟由我掃）。鎖內不跨 await。
    fn claim_sweep(&self, epoch: &str) -> bool {
        match self.inner.lock() {
            Ok(mut r) => {
                if r.swept_epoch.as_deref() == Some(epoch) {
                    false
                } else {
                    r.swept_epoch = Some(epoch.to_string());
                    true
                }
            }
            Err(_) => false,
        }
    }
    /// 掃地工失敗時把佔位還回去（下一趟再試；失敗不影響這趟 pull 的回報）
    fn release_sweep(&self) {
        if let Ok(mut r) = self.inner.lock() {
            r.swept_epoch = None;
        }
    }
}

/// in-flight 守衛：push／pull 同時只跑一趟（契約 §5.2；搶不到就回空報告，UI 不必特判）
pub(crate) struct BusyGuard<'a>(&'a AtomicBool);

impl<'a> BusyGuard<'a> {
    pub(crate) fn acquire(flag: &'a AtomicBool) -> Option<Self> {
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

pub(crate) fn db_err(e: sqlx::Error) -> String {
    format!("同步的資料庫操作失敗：{e}")
}

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ─────────────────────────────────────────────────────────────
// sync_meta 小工具
// ─────────────────────────────────────────────────────────────

pub(crate) async fn meta_all<'e, E>(ex: E) -> Result<HashMap<String, String>, String>
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

pub(crate) async fn meta_set<'e, E>(ex: E, key: &str, value: &str) -> Result<(), String>
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
pub(crate) async fn meta_set_if_changed(
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
pub(crate) async fn ensure_device_id(pool: &Pool<Sqlite>) -> Result<String, String> {
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
pub(crate) async fn record_error(pool: &Pool<Sqlite>, msg: &str) {
    let _ = meta_set(pool, "last_error", msg).await;
}

pub(crate) async fn record_success(pool: &Pool<Sqlite>) -> Result<(), String> {
    meta_set(pool, "last_sync_at", &now_iso()).await?;
    clear_error(pool).await
}

/// 清掉上次的錯誤（本來就是空的就什麼都不做——見 `meta_set_if_changed` 的理由）
pub(crate) async fn clear_error(pool: &Pool<Sqlite>) -> Result<(), String> {
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
    let mut meta = meta_all(&pool).await?;
    // 診斷用：把本機引擎的 schema 記在庫裡，日後看 DB 就知道這顆庫是哪一版引擎碰過的
    meta_set_if_changed(
        &pool,
        meta.get("schema_gate"),
        "schema_gate",
        &SCHEMA_VERSION.to_string(),
    )
    .await?;

    // 憑證壞掉不該讓 status 整個失敗——UI 要能顯示「停車中」＋原因，主人才知道要按重設
    let (creds, cred_error) = match credstore::load(app) {
        Ok(v) => (v, None),
        Err(e) => (None, Some(e)),
    };
    // 工程評審 B-1：「讀不到鑰匙圈」不等於「沒有鑰匙圈」。這一格是整支 status 的分水嶺——
    // 還原標記、phase、UI 要不要露出加入表單，三處都看它。
    let cred_read_failed = cred_error.is_some();
    let configured = creds.is_some();

    // v1.1.3 遷移（契約 §3.1／§7 ②）：身分與血統鹽從 sync_meta 搬進鑰匙圈——缺才搬、搬完存回。
    // 之後鑰匙圈為準、sync_meta 為快取：複製整個資料夾（DB 跟著走、鑰匙圈不跟）＝沒身分＝新的一台。
    let creds = match creds {
        Some(mut c) => {
            let mut dirty = false;
            if c.device_id.as_deref().map_or(true, str::is_empty) {
                if let Some(d) = meta.get("device_id").filter(|s| !s.is_empty()) {
                    c.device_id = Some(d.clone());
                    dirty = true;
                }
            }
            if c.salt_b64.as_deref().map_or(true, str::is_empty) {
                if let Some(s) = meta.get("salt").filter(|s| !s.is_empty()) {
                    c.salt_b64 = Some(s.clone());
                    dirty = true;
                }
            }
            // 工程評審 S-12：回寫失敗只 log、用記憶體裡這份繼續——寫不進憑證庫不該讓整頁變「橋接不通」，
            // 下一趟 `status()` 還會再試一次（本來就是「缺才搬」）。
            if dirty {
                if let Err(e) = credstore::save(app, &c) {
                    eprintln!("[sync] 鑰匙圈回寫失敗（這趟先用記憶體裡的，下次再試）：{e}");
                }
            }
            Some(c)
        }
        None => None,
    };

    // device_id：鑰匙圈為準、sync_meta 只是快取（TS 的閘門與 hlc 尾碼讀快取）。快取被換掉時順手把
    // 自己的舊格子改成新身分，免得之後被當成「別台寫的」。沒鑰匙圈時沿 v1.1.2 的 `ensure_device_id`
    // ——閘門的尾碼總要有東西，而且從沒加入過的桌機本來就會有這一列（既有行為不變）。
    let device_id = match creds.as_ref().and_then(|c| c.device_id.clone()) {
        Some(id) => {
            if meta.get("device_id") != Some(&id) {
                let old = meta.get("device_id").cloned().filter(|o| !o.is_empty());
                meta_set(&pool, "device_id", &id).await?;
                if let Some(old) = old {
                    sqlx::query("UPDATE sync_cells SET device_id = ? WHERE device_id = ?")
                        .bind(&id)
                        .bind(&old)
                        .execute(&pool)
                        .await
                        .map_err(db_err)?;
                }
                meta.insert("device_id".into(), id.clone());
            }
            id
        }
        None => ensure_device_id(&pool).await?,
    };

    // v1.1.3 遷移（契約 §3.2／§7 ③⑧）：閘門鍵 `role` → `joined`，`primary_device_id` 刪掉
    // ——正本／副本已經沒有任何讀取點了。刪之前先把 v1.1.1 留下的單一游標搬到
    // `last_pull_key:<primary>`（那把鍵的語義就是「正本那台我拉到哪」，不搬就得整包重拉一次）。
    //
    // 工程評審 S-6（遷移不是單行道）：**`role` 那一列留著不刪**。1.1.3 完全不讀它，但 1.1.2 的閘門讀，
    // 留著就是「裝了 1.1.3 又退回 1.1.2」時同步還活著的唯一一條退路（主人桌機 09-21 就因為它被刪而半殘）。
    // 真正要清是 v1.1.4 的事。判斷式因此不能再看 `role` 是否存在（會每 60 秒重跑一次），改看
    // 「有 role 但還沒有 joined」＋兩把真的要搬的鍵。
    // 條件只列「真的有事要做」的兩種：①有 role 沒 joined（補閘門鍵）②還有 primary_device_id（搬游標＋刪它）。
    // 舊碼的第三條（`last_pull_key` 存在）會讓這一段每 60 秒空跑一次——沒有 primary 就不知道那把游標是誰的，
    // `migrate_cursor` 什麼也做不了。那一列在 v1.1.3 已經沒有讀取點，留著無害。
    if (meta.contains_key("role") && !meta.contains_key("joined"))
        || meta.contains_key("primary_device_id")
    {
        if meta.contains_key("role") && !meta.contains_key("joined") {
            meta_set(&pool, "joined", "1").await?;
            meta.insert("joined".into(), "1".into());
        }
        if let Some(primary) = meta.get("primary_device_id").filter(|s| !s.is_empty()).cloned() {
            migrate_cursor(&pool, &meta, &primary).await?;
        }
        if meta.get("joined").map(String::as_str) == Some("1") {
            sqlx::query("DELETE FROM sync_meta WHERE key = 'primary_device_id'")
                .execute(&pool)
                .await
                .map_err(db_err)?;
        }
        meta = meta_all(&pool).await?;
    }
    // v1.1.4（契約 §3；決策記錄〈v1.1.4 開工拍板〉自決）：`role` 這一列**真的清掉**。它是 1.1.2 的閘門鍵，
    // 留著是「退回 1.1.2 同步還活著」的退路——v1.1.3 真機驗收已過，拍板接受「從此不能退回 1.1.2」。
    // 只在 `joined` 已補好之後刪（上面那段先跑），所以不會刪掉還沒遷移的閘門。
    if meta.contains_key("role") && meta.get("joined").map(String::as_str) == Some("1") {
        sqlx::query("DELETE FROM sync_meta WHERE key = 'role'")
            .execute(&pool)
            .await
            .map_err(db_err)?;
        meta.remove("role");
    }

    let pending_ops: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sync_outbox")
        .fetch_one(&pool)
        .await
        .map_err(db_err)?
        .try_get("n")
        .map_err(db_err)?;
    let pending_span = pending_span_of(&pool).await?;

    let (busy, remote_schema) = match app.try_state::<SyncState>() {
        Some(st) => (st.busy.load(Ordering::Acquire), st.read_gate()),
        None => (false, None),
    };

    let enabled = meta.get("enabled").map(String::as_str) == Some("1");
    let last_error = cred_error.or_else(|| {
        meta.get("last_error")
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    });
    let nonempty = |s: &&String| !s.is_empty();
    let pending_epoch = meta.get("pending_epoch").filter(nonempty).cloned();
    let locked = meta.get("locked").filter(nonempty).cloned();
    // v1.1.4：換鑰匙的標記檔（契約 §5）。有鑰匙圈才算數——沒鑰匙圈的機器（複製資料夾）連紀元都不是它的
    let rotation_stage = if configured {
        rotation_marker(app).map(|m| m.stage.as_str().to_string())
    } else {
        None
    };

    // 七態（契約 §4.3）：off／paused／epoch_changed（改正待ち）／locked（鍵違い）／gated（信号待ち）／stopped／running。
    // 改正待ち排在鍵違い前面：前者有動作可按（「改用那份」），後者只能重新加入。
    //
    // 產品評審 S1／工程評審 B-1：**沒有鑰匙圈一律 `off`**（不管 DB 裡的 `enabled` 是什麼）。
    // 「複製整個資料夾」會把 `enabled='1'` 一起複製過來、鑰匙圈卻不跟——舊判準會顯示朱點「停車中」
    // 而底下沒有任何原因行，主人第一眼以為壞了，實際上只是「這台還沒加入」。
    // 讀取**失敗**（Windows 認證管理員／Android 私有檔一時讀不到）才是真的停車中，原因行就是 `last_error`。
    let phase = if !configured {
        if cred_read_failed {
            Phase::Stopped
        } else {
            Phase::Off
        }
    } else if rotation_stage.is_some() {
        // v1.1.4（契約 §5）：換鑰匙中排在總開關之前——這是主人剛按下的一次性決定，關著的總開關擋不住它，
        // 而且 push／pull 這段期間本來就要擋（舊鑰匙推出去的物件下一步就會被刪）。
        Phase::Rotating
    } else if !enabled {
        Phase::Paused
    } else if pending_epoch.is_some() {
        Phase::EpochChanged
    } else if locked.is_some() {
        Phase::Locked
    } else if remote_schema.is_some() {
        Phase::Gated
    } else if last_error.is_some() {
        Phase::Stopped
    } else {
        Phase::Running
    };

    // 還原標記檔（契約 §6）：沒鑰匙圈＝這台沒加入同步＝還原不牽動任何裝置，標記順手刪掉
    //（評審 S2「從沒啟用過同步的桌機還原備份零動作」的一般化——正本／副本退場後，判準只剩「有沒有鑰匙圈」）。
    //
    // 工程評審 B-1：憑證庫**讀取失敗**時絕不刪標記。刪掉＝主人剛選的「回到過去」連同「有還原這件事」
    // 一起消失＝靜默降級成「接上現在」（這台默默回到舊紀元，下一趟把雲端較新的東西蓋回來，別台永遠不會被問）。
    let (restore_pending, restore_choice) = match restore_marker(app) {
        Some((choice, _label)) if configured || cred_read_failed => (true, Some(choice)),
        Some(_) => {
            clear_restore_pending(app);
            (false, None)
        }
        None => (false, None),
    };

    Ok(SyncStatus {
        enabled,
        device_id,
        epoch: meta.get("epoch").cloned(),
        configured,
        joined: meta.get("joined").map(String::as_str) == Some("1"),
        root: creds.as_ref().map(|c| c.root.clone()),
        phase,
        busy,
        last_sync_at: meta.get("last_sync_at").filter(|s| !s.is_empty()).cloned(),
        last_error,
        // v1.1.2：兩端照實回報（見欄位註解）
        pending_ops: pending_ops.max(0) as u64,
        pending_span,
        schema: SCHEMA_VERSION,
        remote_schema,
        restore_pending,
        restore_choice,
        pending_epoch,
        pending_epoch_info: meta
            .get("pending_epoch_info")
            .and_then(|s| serde_json::from_str::<EpochInfo>(s).ok()),
        locked,
        key_sealed: meta.get("key_sealed").map(|v| v == "1"),
        last_orphans: meta
            .get("last_orphans_count")
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .map(|count| LastOrphans {
                count,
                path: meta.get("last_orphans_path").cloned().unwrap_or_default(),
                at: meta.get("last_orphans_at").cloned().unwrap_or_default(),
            }),
        last_export: meta
            .get("last_export_path")
            .filter(nonempty)
            .map(|path| LastExport {
                path: path.clone(),
                at: meta.get("last_export_at").cloned().unwrap_or_default(),
            }),
        // v1.1.4：`locked` 是紀元號時才有原因；`sync_meta.locked_reason` 由紀元掃描寫（`rotated`／`stale`）
        locked_reason: meta
            .get("locked")
            .filter(nonempty)
            .filter(|l| l.as_str() != "salt")
            .and_then(|_| meta.get("locked_reason"))
            .and_then(|r| match r.as_str() {
                "rotated" => Some(LockedReason::Rotated),
                "stale" => Some(LockedReason::Stale),
                _ => None,
            }),
        skipped_missing_total: meta
            .get("skipped_missing_total")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0),
        last_cloud_snapshot_at: meta.get("last_cloud_snapshot_at").filter(nonempty).cloned(),
        rotation_stage,
    })
}

/// outbox 最早／最晚 op 的時刻（契約 §4.3 `pending_span`）；空 outbox ⇒ None
async fn pending_span_of(pool: &Pool<Sqlite>) -> Result<Option<PendingSpan>, String> {
    let row = sqlx::query("SELECT MIN(hlc) AS lo, MAX(hlc) AS hi FROM sync_outbox")
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    let lo: Option<String> = row.try_get("lo").map_err(db_err)?;
    let hi: Option<String> = row.try_get("hi").map_err(db_err)?;
    Ok(match (lo, hi) {
        (Some(lo), Some(hi)) => Some(PendingSpan { from: iso_of_hlc(&lo), to: iso_of_hlc(&hi) }),
        _ => None,
    })
}

/// hlc 的 13 位毫秒 → UTC ISO；形狀不對回空字串（UI 顯示時略過）
fn iso_of_hlc(h: &str) -> String {
    hlc::parse(h)
        .and_then(|p| chrono::DateTime::<chrono::Utc>::from_timestamp_millis(p.ms as i64))
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

// ─────────────────────────────────────────────────────────────
// 設定／重設／配對碼
// ─────────────────────────────────────────────────────────────

/// 總開關。
///
/// 語義（評審 B1 改判）：**關著＝只停網路，不是斷線**。outbox／cells 的閘門看的是 `sync_meta.joined`
/// （見 `src/data/syncRepository.ts` 的 `CONFIGURED_GATE`），所以關著期間的每一筆變更照樣入列，
/// 開回來就照原本的 hlc 補送上去——不必重拍快照，也不會像以前那樣把那段時間的修改永遠丟掉
/// （舊行為還會讓副本收到「父列從未建立」的子列 op，FK 在 COMMIT 時爆掉、游標卡死）。
pub async fn set_enabled(app: &AppHandle, enabled: bool) -> Result<SyncStatus, String> {
    let pool = pool(app).await?;
    meta_set(&pool, "enabled", if enabled { "1" } else { "0" }).await?;
    status(app).await
}

/// 重設本機（③重新加入的「拿掉」）：清憑證（**含身分**）／outbox／cells／整張 meta，總開關關閉。
/// **不碰資料列、不碰雲端**。放回去＝再按「加入同步」＝新的一台（契約 §3.1）。
pub async fn reset_local(app: &AppHandle) -> Result<SyncStatus, String> {
    // 工程評審 B-4：換鑰匙沒做完時「重新加入」＝清掉鑰匙圈裡唯一的那把 K2（桶裡的 KEY 已經是它包的）
    guard_not_rotating(app)?;
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
    // v1.1.3 §3.1：**整張** sync_meta（含 device_id）。credstore 也已經連身分一起清掉——
    // 「拿掉再放回」＝③重新加入＝**新的一台**（新身分、新游標），舊身分在雲端留下的物件
    // 照樣會被新身分拉回來（LWW 冪等）。
    sqlx::query("DELETE FROM sync_meta")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    meta_set(&mut *tx, "enabled", "0").await?;
    tx.commit().await.map_err(db_err)?;
    st.set_gate(None);
    st.clear_bucket_meta_done(); // 工程評審 S-9
    drop(_busy);
    status(app).await
}

/// 配對碼的內容。**不 derive Debug**：裡面有 R2 的 access key／secret。
///
/// v1.1.3（契約 §4.6）起配對碼**降為省手打的便利**：只帶憑證、根前綴與紀元（資訊用），
/// **不帶鹽、不帶資料鑰匙、不帶身分**——新裝置一律要打密語，血統由桶裡的 SALT／KEY 決定。
/// v1（v1.1.2）的欄位照樣解得開（多的 salt／primary_device_id 丟掉），主人桌機上的舊 QR 不會壞。
#[derive(Serialize, Deserialize)]
struct PairingCode {
    v: u32,
    endpoint: String,
    bucket: String,
    ak: String,
    sk: String,
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    epoch: Option<String>,
}

/// 配對碼的現行版本
pub const PAIRING_CODE_VERSION: u32 = 2;

/// `sync_decode_pairing_code` 的回傳（填表用；**不 derive Debug**：含 secret）
#[derive(Clone, Serialize)]
pub struct PairingFields {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub root: String,
    pub epoch: Option<String>,
}

/// 任何已加入的裝置都能產（v1.1.3 §4.6；D-1.1-6 改判「任何已加入裝置都能出示」，正本退場）。
pub async fn make_pairing_code(app: &AppHandle) -> Result<String, String> {
    let creds = credstore::load(app)?.ok_or_else(|| "這台還沒加入同步。".to_string())?;
    let pool = pool(app).await?;
    let meta = meta_all(&pool).await?;
    let code = PairingCode {
        v: PAIRING_CODE_VERSION,
        endpoint: creds.endpoint,
        bucket: creds.bucket,
        ak: creds.access_key_id,
        sk: creds.secret_access_key,
        root: Some(creds.root),
        epoch: meta.get("epoch").cloned(),
    };
    let json = serde_json::to_vec(&code).map_err(|_| "產生配對碼失敗。".to_string())?;
    Ok(crypto::b64_encode(&json))
}

/// 解配對碼回四欄（**無副作用**；v1／v2 都吃）。UI 拿回去填表，主人照樣按「加入同步」。
pub fn decode_pairing_code(code: &str) -> Result<PairingFields, String> {
    let broken = || "配對碼看起來不完整，請重新複製一次。".to_string();
    let raw = crypto::b64_decode(code.trim()).map_err(|_| broken())?;
    let parsed: PairingCode = serde_json::from_slice(&raw).map_err(|_| broken())?;
    if parsed.v > PAIRING_CODE_VERSION {
        return Err("這張配對碼是新版格式，請先把兩台都更新到同一版。".into());
    }
    if parsed.endpoint.trim().is_empty()
        || parsed.bucket.trim().is_empty()
        || parsed.ak.is_empty()
        || parsed.sk.is_empty()
    {
        return Err(broken());
    }
    Ok(PairingFields {
        endpoint: parsed.endpoint,
        bucket: parsed.bucket,
        access_key_id: parsed.ak,
        secret_access_key: parsed.sk,
        root: parsed
            .root
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| credstore::DEFAULT_ROOT.to_string()),
        epoch: parsed.epoch.filter(|e| !e.trim().is_empty()),
    })
}

// ─────────────────────────────────────────────────────────────
// 補戳格子＋快照（v1.1.3 契約 §5.1／§5.2：合併用**原始時間戳**）
// ─────────────────────────────────────────────────────────────

/// device_id 的 hlc 尾碼（與 `hlc::format` 同一規則：前 8 個字元）
fn dev8_of(device_id: &str) -> String {
    device_id.chars().take(8).collect()
}

/// 「沒同步過的列」的派生 hlc（契約 §5.1）：`updated_at`（缺則 `created_at`）的 13 位毫秒＋`0000`＋`-`＋dev8。
///
/// 為什麼不戳「現在」（評審 B1）：舊桌機壞了、在新桌機還原上週的備份再選「兩邊都保留」，
/// 快照若全戳現在，手機這週蓋的 30 個章、改的 10 個名就會被上週的值整包蓋回去、刪掉的票全部復活。
/// 派生出來的戳記一定早於「備份之後」發生的任何真編輯（那些戳的是當時的現在），
/// 所以另一台較晚的修改一律贏、另一台沒碰過的列則本機贏——正是「兩邊都保留、較晚改的為準」。
///
/// 這支是 `stamp_missing_cells` 那句 SQL 的 Rust 版（快照撿漏用）；兩者必須同值，
/// 單元測試 `派生戳記_sql與rust同值` 盯著。
fn derived_hlc(updated_at: Option<&str>, created_at: Option<&str>, dev8: &str) -> String {
    let ms = updated_at
        .filter(|s| !s.trim().is_empty())
        .or(created_at.filter(|s| !s.trim().is_empty()))
        .and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(s.trim())
                .ok()
                .map(|d| d.timestamp_millis())
        })
        .unwrap_or(0)
        .max(0) as u64;
    format!("{ms:013}0000-{dev8}")
}

/// SQLite 端的同一條派生規則（契約 §5.1 的參考 SQL）。`?1`＝dev8。
///
/// `julianday` 吃得下 `YYYY-MM-DDTHH:MM:SS.SSSZ`（含 T 與 Z）；`- 2440587.5` 是 julian day → unix 日，
/// 乘 86400000 得毫秒，`round` 補浮點誤差。`printf('%013d…')` 把它補成 13 位，與 `hlc::format` 同形。
fn derived_hlc_sql(alias: &str) -> String {
    format!(
        "printf('%013d0000-%s', CAST(round((julianday(COALESCE(NULLIF({alias}.updated_at,''), \
         NULLIF({alias}.created_at,''), '1970-01-01T00:00:00.000Z')) - 2440587.5) * 86400000.0) AS INTEGER), ?1)"
    )
}

/// 補戳「沒同步過」的格子（契約 §5.1；join 的 first／merged 與 `finish_restore(past)` 都先做）。
///
/// 為什麼非做不可：沒同步過的列在 `sync_cells` 裡一格都沒有，於是
///   (a) `pull_core` 套遠端物件時 `cells.get(col)` 是 None ⇒ **無條件採用**＝雲端整包蓋掉本機（B1 的反向）；
///   (b) 快照也無從取得「原始時間戳」。
/// 既有格子一律不動（`INSERT OR IGNORE`）——它們才是真正的最後修改時刻。
///
/// 回傳補了幾格（診斷用）。
pub(crate) async fn stamp_missing_cells(tx: &mut sqlx::Transaction<'_, Sqlite>, me: &str) -> Result<u64, String> {
    let dev8 = dev8_of(me);
    let mut total: u64 = 0;

    // 三張表：欄清單由白名單產生，排成 `SELECT 'kind' AS col UNION ALL SELECT 'parent_id' …`
    for (tbl, filter) in [
        // nodes：`route_id` 只有「根層臨時車票」那一列是資料（路線標籤），其餘是快取、不進同步（契約 §2.2）
        (
            "nodes",
            "WHERE NOT (c.col = 'route_id' AND NOT (n.parent_id IS NULL AND n.kind = 'ticket'))",
        ),
        // work_logs：競合日誌是各台自己記的「我這版被誰蓋掉了」，永不進同步
        ("work_logs", "WHERE n.event IS NULL OR n.event <> 'conflict'"),
        ("occurrences", ""),
    ] {
        let spec = columns_of(tbl).expect("表在白名單裡");
        let cols_sql = spec
            .iter()
            .map(|(c, _)| format!("SELECT '{c}' AS col"))
            .collect::<Vec<_>>()
            .join(" UNION ALL ");
        let sql = format!(
            "INSERT OR IGNORE INTO sync_cells (tbl, row_id, col, hlc, device_id) \
             SELECT '{tbl}', n.id, c.col, {stamp}, ?2 \
             FROM {tbl} n CROSS JOIN ({cols_sql}) c {filter}",
            stamp = derived_hlc_sql("n")
        );
        let r = sqlx::query(&sql)
            .bind(&dev8)
            .bind(me)
            .execute(&mut **tx)
            .await
            .map_err(db_err)?;
        total += r.rows_affected();
    }

    // settings 只有白名單那幾把鑰匙（`value` 一欄）
    for key in SYNC_SETTINGS_KEYS {
        let sql = format!(
            "INSERT OR IGNORE INTO sync_cells (tbl, row_id, col, hlc, device_id) \
             SELECT 'settings', n.key, 'value', {stamp}, ?2 FROM settings n WHERE n.key = ?3",
            stamp = format!(
                "printf('%013d0000-%s', CAST(round((julianday(COALESCE(NULLIF(n.updated_at,''), \
                 '1970-01-01T00:00:00.000Z')) - 2440587.5) * 86400000.0) AS INTEGER), ?1)"
            )
        );
        let r = sqlx::query(&sql)
            .bind(&dev8)
            .bind(me)
            .bind(key)
            .execute(&mut **tx)
            .await
            .map_err(db_err)?;
        total += r.rows_affected();
    }

    Ok(total)
}

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

/// 全量快照進 outbox（契約 §5.2）：三張表**全部列（含 tombstone）**＋settings 白名單。
///
/// **v1.1.3 語義改了**（簽名不變）：每一欄的 hlc 來自 `sync_cells` 的格子＝該欄**真正的最後修改時刻**；
/// 同一列裡 hlc 相同的欄合成一筆 op，所以一列可能拆成好幾筆（`name` 是上週改的、`status` 是昨天蓋的，
/// 各自帶各自的戳）。收到方照逐欄 LWW 判——較晚改的那一版贏，這就是「兩邊都保留」。
/// **對 `sync_cells` 零寫入**：格子是來源，不是產物（呼叫端先跑 `stamp_missing_cells` 補齊）。
///
/// 為什麼含 tombstone：不然主人之後「復原」某張票時，那筆 `deleted_at=NULL` 的 op 在對方機器上
/// 會找不到列可改（對方從來沒收過它），復原就傳不過去。
///
/// 為什麼不再「每筆各自一個新 hlc」（v1.1.2 的作法）：那等於把整份快照都戳成「現在」，
/// 合併時會整包蓋掉對方（評審 B1）。物件撞名的問題改由 push 端的**推送戳記**解決（§5.4）。
pub async fn snapshot_into_outbox(pool: &Pool<Sqlite>, device_id: &str) -> Result<u64, String> {
    let dev8 = dev8_of(device_id);

    // 一次撈完所有格子：`tbl → row_id → col → hlc`
    let mut cells: HashMap<(String, String), HashMap<String, String>> = HashMap::new();
    for row in sqlx::query("SELECT tbl, row_id, col, hlc FROM sync_cells")
        .fetch_all(pool)
        .await
        .map_err(db_err)?
    {
        let tbl: String = row.try_get("tbl").map_err(db_err)?;
        let row_id: String = row.try_get("row_id").map_err(db_err)?;
        let col: String = row.try_get("col").map_err(db_err)?;
        let hlc: String = row.try_get("hlc").map_err(db_err)?;
        cells.entry((tbl, row_id)).or_default().insert(col, hlc);
    }

    // 一列 → 依 hlc 分組的多筆 op（hlc 遞增）。`fallback`＝這一列一格都沒有時的派生戳記。
    let group = |tbl: &str, row_id: &str, cols: Map<String, Value>, fallback: &str| -> Vec<Op> {
        let stamps = cells.get(&(tbl.to_string(), row_id.to_string()));
        // 這一列所有格子裡最大的 hlc——沒有格子的欄併進這一筆（補戳之後理論上不存在，留著當保險）
        let biggest = stamps
            .and_then(|m| cols.keys().filter_map(|c| m.get(c)).max().cloned())
            .unwrap_or_else(|| fallback.to_string());
        // 這一列的必填欄（NOT NULL 又沒有 DEFAULT）的現值——補進**最小 hlc 那一筆** op。
        //
        // 為什麼（整合席沙盒壬8 抓到的資料遺失）：一列拆成多筆 op 之後，收到方若**還沒有這一列**
        // （「改用那份」wipe 過、或第一次拉這個紀元），`apply_object` 的新列分支會檢查 `required_of`，
        // 缺一欄就整筆跳過（`out.skipped`，不報錯）。票甲的 `name` 被另一台改過 ⇒ `name` 自成一筆 op ⇒
        // 第一筆沒有 name、第二筆沒有 kind ⇒ **兩筆都被跳過，整張票在別台靜默消失**。
        //
        // 只補最小的那一筆，不是每一筆：ops 依 hlc 遞增套用，建列的一定是第一筆，所以補它就夠；
        // 補到最大的那一筆反而會**高報戳記**——收到方若有一個介於兩筆之間、更新的 `name`，
        // 就會被這個借來的大 hlc 蓋掉。補在最小的那筆則是低報，同一個物件裡後面那筆真正的
        // `name` op 會把值與 hlc 一起蓋回正確的，收到方已有更新格子時也照樣被逐欄 LWW 擋掉。
        let required: Vec<(String, Value)> = required_of(tbl)
            .iter()
            .filter_map(|c| cols.get(*c).map(|v| ((*c).to_string(), v.clone())))
            .collect();
        let mut by_hlc: std::collections::BTreeMap<String, Map<String, Value>> = Default::default();
        for (col, v) in cols {
            let h = stamps
                .and_then(|m| m.get(&col))
                .cloned()
                .unwrap_or_else(|| biggest.clone());
            by_hlc.entry(h).or_default().insert(col, v);
        }
        if let Some((_, first)) = by_hlc.iter_mut().next() {
            for (c, v) in &required {
                if !first.contains_key(c) {
                    first.insert(c.clone(), v.clone());
                }
            }
        }
        by_hlc
            .into_iter()
            .map(|(hlc, cols)| Op {
                hlc,
                tbl: tbl.to_string(),
                row_id: row_id.to_string(),
                op: OpKind::Upsert,
                cols,
            })
            .collect()
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
        // route_id 只有「根層臨時車票」那一筆是資料；其餘是快取，對方自己重算（契約 §2.2）
        let is_root_ticket = row
            .try_get::<Option<String>, _>("parent_id")
            .map_err(db_err)?
            .is_none()
            && row.try_get::<String, _>("kind").map_err(db_err)? == "ticket";
        if !is_root_ticket {
            cols.remove("route_id");
        }
        let fallback = derived_hlc(
            row.try_get::<Option<String>, _>("updated_at").map_err(db_err)?.as_deref(),
            row.try_get::<Option<String>, _>("created_at").map_err(db_err)?.as_deref(),
            &dev8,
        );
        ops.extend(group("nodes", &id, cols, &fallback));
    }

    // work_logs 排除 `event='conflict'`（v1.1.2 契約 §3.4）：衝突日誌是**各台自己**在 apply 時記的
    // 「我這一版被誰蓋掉了」，本來就不進 outbox；快照若把它們一起搬走，另一台就會長出一堆不屬於它的競合紀錄。
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
            let fallback = derived_hlc(
                row.try_get::<Option<String>, _>("updated_at").map_err(db_err)?.as_deref(),
                row.try_get::<Option<String>, _>("created_at").map_err(db_err)?.as_deref(),
                &dev8,
            );
            ops.extend(group(tbl, &id, cols, &fallback));
        }
    }

    // settings 只搬白名單（day_start_hour）
    for key in SYNC_SETTINGS_KEYS {
        let row = sqlx::query("SELECT value, updated_at FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
        if let Some(row) = row {
            let value: String = row.try_get("value").map_err(db_err)?;
            let mut cols = Map::new();
            cols.insert("value".into(), Value::from(value));
            let fallback = derived_hlc(
                row.try_get::<Option<String>, _>("updated_at").map_err(db_err)?.as_deref(),
                None,
                &dev8,
            );
            ops.extend(group("settings", key, cols, &fallback));
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
// push（兩端；v1.1.3 起物件名＝推送戳記，見 §5.4）
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
    // v1.1.3（契約 §3.2）：閘門鍵從 `role` 換成 `joined`——正本／副本退場，「有沒有加入過」只剩這一條。
    // 沒加入過＝outbox 必空（TS 的閘門也看這一列），什麼都不做。
    if meta.get("joined").map(String::as_str) != Some("1") {
        return Ok(empty);
    }
    // v1.1.4（契約 §5.5）：換鑰匙中不推不拉。TS 的 `runCycle` 在 `phase=rotating` 時本來就不叫，
    // 這一行是**手動同步與競態**的保險：用舊鑰匙推上去的物件下一步就會被步驟 6 整顆刪掉。
    if rotation_marker(app).is_some() {
        return Ok(empty);
    }
    // 改正待ち（契約 §4.3）：另一台開了新紀元、這台還盯著舊的。推上去只會把 op 丟進一個
    // 沒人會再讀的舊紀元目錄；那些修改的正確去處是 `adopt_epoch` 的孤兒 JSON。
    // （TS 的 `runCycle` 也不會叫，這裡是手動同步與競態的保險。）
    if meta.get("pending_epoch").is_some_and(|e| !e.is_empty()) {
        return Ok(empty);
    }
    let epoch = meta
        .get("epoch")
        .cloned()
        .ok_or_else(|| "同步設定不完整，請重設後重新啟用。".to_string())?;
    let creds = credstore::load(app)?.ok_or_else(|| "找不到同步憑證，請重新加入同步。".to_string())?;
    // 身分以鑰匙圈為準（契約 §3.1）；`sync_meta.device_id` 只是給 TS 閘門用的快取
    let device_id = creds
        .device_id
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or(device_id);
    let key = crypto::key_from_b64(&creds.data_key_b64)?;
    let root = creds.root.clone();
    guard_sandbox_root(app, &root)?; // 工程評審 B-3：鑰匙圈裡已經是 `v1` 的沙盒也要擋住
    let client = client_of(&creds)?;

    // v1.1.3 §4.7／§7 ④⑥：桶裡的血統標記（`<root>/SALT`）與目前紀元的 `EPOCH.bin` 缺就補；
    // SALT 與這台不同＝血統被別的密語重建過 ⇒ `locked='salt'`（鍵違い），停在這裡等主人重新加入。
    if ensure_bucket_meta(app, pool, &client, &creds, &epoch, &device_id).await? {
        return Ok(empty);
    }

    // 評審 B2：紀元偵測以前只在 pull 做，而一趟同步是**先 push 再 pull**。
    // 時序：桌機還原 → 開新紀元；手機下一趟先把這段期間蓋的章 push 進**舊紀元**（成功、outbox 清空），
    // pull 才偵測到新紀元 ⇒ `adopt_epoch` 匯出的孤兒 JSON 是空的。那些章正本永遠 list 不到，
    // 檔案也沒有——D-1.1-4「未同步修改先存本機 JSON」在這個窗口（還原到手機下次前景，可能數小時）
    // 完全失守，而且零痕跡。所以副本推之前先看一眼雲端有沒有更新的紀元（一次 Class B list）。
    // v1.1.3 §5.6：**所有裝置都偵測**（沒有 replica 限定了），判準是「拆得開即承認」。
    if record_epoch_scan(
        pool,
        &client,
        &root,
        scan_new_epoch(&client, &key, &root, &epoch).await?,
    )
    .await?
    {
        clear_error(pool).await?;
        return Ok(empty);
    }

    // 工程評審 B-2：上一次加入做到一半就斷了（鑰匙圈已存、`joined=1`、outbox 已清、**快照沒做**）。
    // 補做的順序是硬的：**先完整拉取 → 再補戳格子 → 最後快照**。
    //   * 拉取要完整：快照在「拉到一半」時做，本機的舊墓碑會以舊戳推出去被對方套用，
    //     而這台又被對方的新值復活 ⇒ 兩邊永久分歧。
    //   * 補戳要在快照之前：沒有格子的列在合併時會被遠端無條件蓋掉。
    if meta.get("join_pending").is_some_and(|v| !v.is_empty()) {
        let st_ref = app.try_state::<SyncState>();
        let pulled = pull_core(pool, &client, &key, &root, &epoch, &device_id, st_ref.as_deref()).await?;
        // 信号待ち（對方的 schema 比較新）＝這一趟**沒有拉完整**。旗標留著，等主人更新那一台之後再補做；
        // 在這裡快照會把「只拉了一半」的狀態當成完整基準推出去。
        if pulled.gated {
            return Ok(empty);
        }
        let mut tx = pool.begin().await.map_err(db_err)?;
        stamp_missing_cells(&mut tx, &device_id).await?;
        tx.commit().await.map_err(db_err)?;
        snapshot_into_outbox(pool, &device_id).await?;
        sqlx::query("DELETE FROM sync_meta WHERE key = 'join_pending'")
            .execute(pool)
            .await
            .map_err(db_err)?;
    }

    // v1.1.4 修正席（工程評審 S-11）：推之前先確認**這個紀元還在**。
    // 輪替步驟 6 會把舊紀元整顆刪掉；在那之後、這台掃到 E2 之前的那一小段窗口裡，
    // 這台會把物件 PUT 進一個已經不存在的目錄（R2 會默默把目錄建回來，掃地工下次再刪），
    // 而本機的 outbox 已經清空＝它以為送出去了，其實沒有人會讀到。停手比較誠實：
    // 下一趟 pull 的紀元偵測會把它帶進鍵違い，出路是重新加入並「兩邊都保留」。
    // 代價＝每趟 push 多一次 Class B GET（只在真的有東西要推時）。
    if client
        .get_opt(&epoch_marker_key(&root, &epoch))
        .await?
        .is_none()
    {
        eprintln!("[sync:push] 目前紀元的標記不在了，這趟不推：{}", epoch_marker_key(&root, &epoch));
        return Ok(empty);
    }

    push_loop(pool, &client, &key, &root, &epoch, &device_id).await
}

/// 下一顆物件的名字（契約 §5.4 的推送戳記）：比 `last_object_stamp` 與本機 max(hlc) 都大的新鮮 hlc。
///
/// 純粹靠 `sync_meta.last_object_stamp` 不夠——它在 `EPOCH_SCOPED_META` 裡會被清掉（換紀元）；
/// 純粹靠 `max_hlc` 也不夠——outbox 推完就空了、格子的戳記可能是很舊的原始時間。兩個取大的才單調。
async fn next_object_stamp(
    pool: &Pool<Sqlite>,
    last_object_stamp: Option<&str>,
    device_id: &str,
) -> Result<String, String> {
    let seed = [last_object_stamp.map(str::to_string), max_hlc(pool).await?]
        .into_iter()
        .flatten()
        .max();
    Ok(hlc::next(seed.as_deref(), hlc::now_ms(), device_id))
}

/// push 的核心迴圈（不吃 `AppHandle`，所以測得到——評審 B2 的冪等就是靠這支的 in-flight 標記）。
pub(crate) async fn push_loop(
    pool: &Pool<Sqlite>,
    client: &R2Client,
    key: &[u8; crypto::KEY_LEN],
    root: &str,
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

        // v1.1.3：快照帶的是**原始時間戳**，一批 op 的 hlc 不再是遞增的 ⇒ 取這一批的最小／最大，
        // 對方的 `seen` 與 TS 的 hlc 種子才拿得到真正的上界。
        let hlc_from = ops.iter().map(|o| o.hlc.clone()).min().unwrap_or_default();
        let hlc_to = ops.iter().map(|o| o.hlc.clone()).max().unwrap_or_default();
        // v1.1.3 §5.4 **物件名＝推送戳記**。以前用「該批第一筆 op 的 hlc」命名，
        // 而 v1.1.3 的快照帶的是**原始時間戳**（不遞增、還可能重複）⇒ 第二批的名字會小於第一批，
        // 拉方的游標（`list_after` 是嚴格大於）就永遠看不到第二批＝靜默吃資料。
        // 改成「推的當下取一個比 `last_object_stamp` 與本機 max(hlc) 都大的新鮮 hlc」：
        // 同一台的物件名嚴格遞增，與 v1.1.2 的舊物件（首筆 hlc 命名）混排也無妨——
        // 單調性只需要在同一台之內成立，而舊物件名 ≤ 各自首筆 op 的 hlc ≤ max(cells)。
        // op 內的 hlc 才是 LWW 的依據；檔名只是「誰先推」的因果代理。
        let object_stamp = match inflight_key.as_deref() {
            Some(k) => stamp_of_object_key(k).unwrap_or_default(),
            None => {
                next_object_stamp(pool, meta_now.get("last_object_stamp").map(String::as_str), device_id)
                    .await?
            }
        };
        let object_key = inflight_key
            .clone()
            .unwrap_or_else(|| format!("{root}/{epoch}/{device_id}/{object_stamp}.bin"));
        // 評審 B1 第二層：同一趟裡兩批算出同一個 key ⇒ 第二批會 PUT 覆蓋第一批（對方永遠拿不到）。
        // 根因已由推送戳記修掉，這裡是守門：寧可停下來讓主人看見錯誤，也不要靜默覆蓋。
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
            // 戳記在 PUT **之前**落庫：中途掛掉最多浪費一個戳記（下一個一定更大），
            // 絕不會出現「兩顆物件同名」。
            meta_set(&mut *tx, "last_object_stamp", &object_stamp).await?;
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
        skipped_missing: 0,
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
    let empty = PullReport {
        objects: 0,
        applied_ops: 0,
        skipped_ops: 0,
        gated: false,
        changed_tables: vec![],
        busy: false,
        conflicts: 0,
        max_hlc: None,
        skipped_missing: 0,
    };
    let meta = meta_all(pool).await?;
    if meta.get("enabled").map(String::as_str) != Some("1") {
        return Ok(empty);
    }
    // v1.1.3（契約 §3.2）：閘門鍵 `role` → `joined`。兩端都拉（正本／副本退場）。
    if meta.get("joined").map(String::as_str) != Some("1") {
        return Ok(empty);
    }
    // v1.1.4（契約 §5.5）：換鑰匙中不推不拉（理由同 `push_inner`）
    if rotation_marker(app).is_some() {
        return Ok(empty);
    }
    let incomplete = || "同步設定不完整，請重設後重新加入。".to_string();
    let epoch = meta.get("epoch").cloned().ok_or_else(incomplete)?;
    let me = ensure_device_id(pool).await?;

    let creds = credstore::load(app)?.ok_or_else(|| "找不到同步憑證，請重新加入同步。".to_string())?;
    // 身分以鑰匙圈為準（契約 §3.1）
    let me = creds.device_id.clone().filter(|d| !d.is_empty()).unwrap_or(me);
    let key = crypto::key_from_b64(&creds.data_key_b64)?;
    let root = creds.root.clone();
    guard_sandbox_root(app, &root)?; // 工程評審 B-3
    let client = client_of(&creds)?;

    // ① v1.1.3 §4.7／§7 ④⑥：桶裡的 SALT／EPOCH.bin 缺就補；SALT 不同＝鍵違い，停在這裡。
    if ensure_bucket_meta(app, pool, &client, &creds, &epoch, &me).await? {
        return Ok(empty);
    }

    // ② 紀元偵測（契約 §5.6，**所有裝置都做**、拆得開即承認）。偵測到就不再拉舊紀元的東西，
    //    等主人在改正待ち按「改用那份」。
    if record_epoch_scan(
        pool,
        &client,
        &root,
        scan_new_epoch(&client, &key, &root, &epoch).await?,
    )
    .await?
    {
        st.set_gate(None);
        clear_error(pool).await?;
        return Ok(empty);
    }

    let report = pull_core(pool, &client, &key, &root, &epoch, &me, Some(st)).await?;

    if report.objects > 0 {
        record_success(pool).await?;
    } else if !report.gated {
        clear_error(pool).await?;
    }

    // ③ v1.1.4（契約 §4.5）掃地工：拉成功、而且這台真的在 running（沒有改正待ち／鍵違い／加入沒做完）
    //    ⇒ 順手把「比目前紀元小、且不在最近兩個」的舊紀元整顆刪掉。**每個進程每個紀元一次**。
    //
    //    為什麼掛在 pull 尾巴而不是另起排程：這裡是唯一「已經確定自己看得到目前紀元、而且沒有待處理狀態」
    //    的地方；別的裝置若還停在舊紀元（改正待ち），它 adopt 時只拉**最新**紀元，被刪的那些它本來就不讀。
    //    為什麼 `!gated`：信号待ち代表別台的 schema 比我新——那是「我該更新」，不是「我該掃別人的地」。
    if !report.gated {
        let m = meta_all(pool).await?;
        let idle = !m.contains_key("pending_epoch")
            && m.get("locked").is_none_or(|v| v.is_empty())
            && m.get("join_pending").is_none_or(|v| v.is_empty());
        if idle && st.claim_sweep(&epoch) {
            if let Err(e) = sweep_old_epochs(&client, &root, &epoch, SWEEP_KEEP_DEFAULT).await {
                // 失敗只 log、不影響這趟 pull 的回報（契約 §4.5）
                eprintln!("[sync:sweep] {e}");
                st.release_sweep();
            }
        }
    }
    Ok(report)
}

/// pull 的核心（契約 §4.7）：`pull_inner` 去掉「讀鑰匙圈／enabled／閘門／紀元偵測」之後的那一段，
/// 讓 `sync_join` 在同一趟裡直接拉全量（它已經握著憑證與資料鑰匙，也不該再被 `enabled` 擋住）。
///
/// `st` 為 None＝呼叫端自己管信号待ち（join 期間 UI 還在等回覆，`report.gated` 會照實回報）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn pull_core(
    pool: &Pool<Sqlite>,
    client: &R2Client,
    key: &[u8; crypto::KEY_LEN],
    root: &str,
    epoch: &str,
    me: &str,
    st: Option<&SyncState>,
) -> Result<PullReport, String> {
    let mut report = PullReport {
        objects: 0,
        applied_ops: 0,
        skipped_ops: 0,
        gated: false,
        changed_tables: vec![],
        busy: false,
        conflicts: 0,
        max_hlc: None,
        skipped_missing: 0,
    };
    let meta = meta_all(pool).await?;

    // ③ 裝置發現（契約 §2.2）：這個紀元底下有哪些 device 目錄。
    // `EPOCH.bin` 是直接放在該層的**物件**，不會混進 common prefixes。
    let dirs = client.list_prefixes(&format!("{root}/{epoch}/")).await?;
    // 主人真機 2026-09-20「重設後再配對，這台自己蓋過的章／改過的票不見了」：以前把自己的目錄跳過
    // （`*d != me`），理由是「自己推的自己早就有」——但清空後就沒有了，而另一台收進來的只是格子、
    // 不會再替這台重播一次。所以自己的目錄也要拉；平常不重複下載靠 push 成功時把
    // `last_pull_key:<me>` 推到剛推的那把 key（見 push_loop）。
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
    // 改成**所有裝置的物件先收齊，依檔名（推送戳記）全域排序再套**——因果順序才對得上。
    // 游標與 seen 仍在 apply_object 的交易裡逐物件推進，與順序無關。
    let mut queue: Vec<(String, String)> = Vec::new(); // (device, object_key)
    for dev in &devices {
        let cursor = meta
            .get(&format!("last_pull_key:{dev}"))
            .cloned()
            .unwrap_or_default();
        for k in client
            .list_after(&format!("{root}/{epoch}/{dev}/"), &cursor)
            .await?
        {
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
        let plain = crypto::open(key, &object_key, &blob)?;

        // 信号待ち：只有**對方比較新**才停在這裡、**不推進游標**，等這台更新到同一版再繼續。
        // 評審 S1：以前是 `!=`，於是 0005 上線後、R2 上還沒被拉走的 schema 4 舊物件，
        // 對已升級的那台永遠是信号待ち，唯一出口是重配對。白名單 apply 本來就前向相容
        // （未知欄整欄丟、缺欄吃 DEFAULT），舊物件照套才對。
        // 評審 S7：閘門排在**完整解析之前**——較新版本若真的改了 `ops` 的形狀，整包解析會先失敗，
        // 閘門就永遠到不了（見 `OplogHead` 的註解）。
        let head: OplogHead = serde_json::from_slice(&plain)
            .map_err(|_| "同步資料的格式看不懂（可能是較新版本產生的）。".to_string())?;
        if head.version > OPLOG_VERSION || head.schema > SCHEMA_VERSION {
            if let Some(st) = st {
                st.set_gate(Some(head.schema));
            }
            report.gated = true;
            gated_devices.insert(dev);
            continue;
        }

        let obj: OplogObject = serde_json::from_slice(&plain)
            .map_err(|_| "同步資料的格式看不懂（可能是較新版本產生的）。".to_string())?;

        let outcome = apply_object(pool, &obj, &object_key, me).await?;
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
        report.skipped_missing += outcome.skipped_missing;
        report.conflicts += outcome.conflicts;
        tables.extend(outcome.changed);
        // §5：把這趟收到的最大 hlc 回報給 TS 當種子（時鐘偏差防護）
        if report.max_hlc.as_deref().unwrap_or("") < obj.hlc_to.as_str() {
            report.max_hlc = Some(obj.hlc_to.clone());
        }
    }

    if !report.gated {
        if let Some(st) = st {
            st.set_gate(None);
        }
    }
    // v1.1.4（契約 §4）：必填欄不齊的新列累進 `skipped_missing_total`——這種列永遠不會再來一次
    //（對方的建立 op 早就過去了），只靠一趟 PullReport 講一次主人根本看不到。
    if report.skipped_missing > 0 {
        let prev = meta
            .get("skipped_missing_total")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        meta_set(pool, "skipped_missing_total", &(prev + report.skipped_missing).to_string()).await?;
    }
    report.changed_tables = tables.into_iter().collect();
    Ok(report)
}

/// v1.1.1 的單一游標 `last_pull_key` → v1.1.2 的 `last_pull_key:<primary_device_id>`（契約 §2.2）。
/// 回 `true`＝動過 sync_meta（呼叫端要重讀）。
///
/// 為什麼要搬而不是重頭拉：舊鍵記的就是「正本那一台我拉到哪」，語義完全相同；不搬的話升級後
/// 第一趟會把正本的全部物件重套一次（LWW 讓它無害，但那是幾十顆物件的網路與 CPU）。
/// 為什麼 primary 端不會誤搬：primary 在 v1.1.1 從不 pull，根本沒有這把舊鍵。
///
/// **v1.1.3**：`primary_device_id` 這把鍵本身要退場，所以這支從 `pull_inner` 移到 `status()`
/// 的遷移步驟——在刪掉舊鍵**之前**先把游標搬好（契約 §3.2）。
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

/// 紀元標記物件 `<root>/<epoch>/EPOCH.bin` 的內容（v1.1.3 契約 §2.2；v2）。
///
/// 為什麼是 `.bin` 不是 `.json`：它跟 oplog 物件一樣走 `crypto::seal`（AAD＝自己的 key），
/// 維持「雲端上只有密文」這條線——連「哪一台開的紀元」都不該裸奔。
/// v2 改了什麼：`primary_device_id` → `opener_device_id`（serde alias 讀舊物件；正本退場，只記誰開的），
/// 多 `label`（還原時的備份檔名，給改正待ち文案）。**拆得開即承認**（§5.6）——不再比對 opener。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpochInfo {
    pub version: u32,
    pub epoch: String,
    #[serde(alias = "primary_device_id")]
    pub opener_device_id: String,
    pub created_at: String,
    /// `first`／`restore`／`backfill`
    pub reason: String,
    /// 還原時的備份檔名；`first`／`backfill` 為 None
    #[serde(default)]
    pub label: Option<String>,
}

/// `EpochInfo.version` 的現行值
pub const EPOCH_INFO_VERSION: u32 = 2;

/// 從一串 `<root>/` 底下的目錄名裡挑出「比 `my_epoch` 大的**數字**紀元」，**由大到小**（契約 §5.6）。
///
/// 純函式，方便單測。非數字的紀元段一律忽略（舊沙盒的 `v1/sandbox-<run>/` 之類）；
/// `my_epoch` 自己不是數字時一律回空——寧可漏提示，也不要對一個看不懂的紀元亂下判斷。
fn newer_epochs_of<'a, I: IntoIterator<Item = &'a str>>(dirs: I, my_epoch: &str) -> Vec<u64> {
    let Ok(mine) = my_epoch.parse::<u64>() else {
        return Vec::new();
    };
    let mut v: Vec<u64> = dirs
        .into_iter()
        .filter_map(|d| d.trim_end_matches('/').rsplit('/').next())
        .filter_map(|seg| seg.parse::<u64>().ok())
        .filter(|n| *n > mine)
        .collect();
    v.sort_unstable();
    v.dedup();
    v.reverse();
    v
}

/// 紀元掃描的結果（契約 §5.6）。
/// `Debug` 只帶紀元號與 `EpochInfo`（誰開的、何時、哪份備份）——沒有憑證也沒有金鑰，測試印得起。
#[derive(Debug)]
pub(crate) enum EpochScan {
    /// 沒有比我新的紀元（或有、但 `EPOCH.bin` 還沒寫上去＝對方正在開，下一趟再看）
    None,
    /// 有一個比我新、而且**拆得開**的紀元＝同一把資料鑰匙＝是我這份資料的事 ⇒ 改正待ち
    Found(String, EpochInfo),
    /// 有比我新的紀元，但拆不開＝別的密語建的 ⇒ 鍵違い（可見狀態，出路是「重新加入」）。
    /// v1.1.4 修正席（工程評審 S-3）：帶**全部**拆不開的紀元（由大到小），不只最大那一個——
    /// 文案要分「換過鑰匙」與「殘留」，而換鑰匙開的 E2 上面可能還疊著別人「回到過去」開的 E3。
    /// 第 0 個是寫進 `sync_meta.locked` 的那一個（維持「承認最大的」語義）。
    Locked(Vec<String>),
}

/// 雲端上有沒有「比我新的紀元」（契約 §5.6；**所有裝置都做**）。
///
/// v1.1.2 的三道關卡是「數字 ∧ 拆得開 ∧ `EPOCH.bin` 的 primary 等於我認得的正本」。
/// 第三條隨正本／副本一起退場（評審 S1：紀元號是牆鐘，「編號大者勝」≠「資料較新」；
/// 自擬仲裁砍掉之後，偵測本來就只剩「看到更大且拆得開 ⇒ 問主人」，**後做的為準**）。
/// 兩台同時還原＝各開一個紀元、彼此看到對方更大的那個 ⇒ 較小那台進改正待ち ⇒ 自然收斂。
///
/// 沙盒不再靠「非數字紀元」躲偵測（那條在 v1.1.2 是安全保證），改靠**不同的 `root`**——
/// `v1-sb-<run>/` 與主人正本的 `v1/` 平級，兩邊的 `list_prefixes` 互相看不到對方。
/// `my_epoch` 自己不是數字時仍一律回 None（保守）。
pub(crate) async fn scan_new_epoch(
    client: &R2Client,
    key: &[u8; crypto::KEY_LEN],
    root: &str,
    my_epoch: &str,
) -> Result<EpochScan, String> {
    if my_epoch.parse::<u64>().is_err() {
        return Ok(EpochScan::None);
    }
    let dirs = client.list_prefixes(&format!("{root}/")).await?;
    // 由大到小：承認最大的那一個（後做的為準）
    let newer = newer_epochs_of(dirs.iter().map(String::as_str), my_epoch);

    let mut unopenable: Vec<String> = Vec::new();
    for n in newer {
        let e = n.to_string();
        // 沒有標記＝對方可能正在寫（EPOCH.bin 在快照 push 之前就寫上去，下一趟就看得到）
        let Some(blob) = client.get_opt(&epoch_marker_key(root, &e)).await? else {
            continue;
        };
        // 產品評審 B2(b)／工程評審 S-3(c)：**標記在、一個裝置目錄都沒有 ⇒ 當成「還在寫」跳過**。
        // `put_epoch_marker` 在快照 push 之前就寫了，中間那段窗口（可能好幾秒，網路差時更久）
        // 別台若先問到，會把主人推進「改用那份」→ wipe → pull 到 0 顆物件＝**畫面整個空掉**。
        // 副作用：兩台同時當第一台時，輸的那個空紀元也不會再把人鎖在 `locked=<紀元>` 出不來。
        // 代價：把「還原到一顆空庫」推給別台這件事會晚一趟才問（那份備份本來就沒有東西可拉）。
        if client.list_prefixes(&format!("{root}/{e}/")).await?.is_empty() {
            continue;
        }
        match epoch_marker_verdict(root, &e, key, &blob) {
            Some(info) => return Ok(EpochScan::Found(e, info)),
            None => unopenable.push(e),
        }
    }
    Ok(if unopenable.is_empty() {
        EpochScan::None
    } else {
        EpochScan::Locked(unopenable)
    })
}

/// 把掃描結果落進 sync_meta（契約 §3.2）。回 `true`＝這趟不要再 push／pull（改正待ち或鍵違い）。
///
/// `locked` 這把鍵由兩個人寫：`ensure_bucket_meta` 負責 `'salt'`（血統被別的密語重建），
/// 這裡負責紀元號。兩者不互相踩——走到這裡代表 SALT 是對的。
///
/// **v1.1.4（契約 §4.3／§5.5）**：鍵違い還要分「另一台換過鑰匙」與「殘留」。判準是那個紀元底下有沒有
/// `<root>/<E>/ROTATED` 這顆明文旗標（只有輪替開的紀元會寫）。為什麼要分：兩種的出路文案完全不同——
/// 換過鑰匙要主人「用**新密語**重新加入」（還會提醒未送出的修改會一起併進來），殘留只是「重新加入」。
/// 猜錯的代價是主人拿舊密語一直試。多一次 `get_opt`（Class B，只在 locked 這個少見分支）換文案正確。
async fn record_epoch_scan(
    pool: &Pool<Sqlite>,
    client: &R2Client,
    root: &str,
    scan: EpochScan,
) -> Result<bool, String> {
    let meta = meta_all(pool).await?;
    /// `locked` 被清掉時 `locked_reason` 一起清（它是那把鍵的形容詞，沒有主詞就不該留）
    async fn clear_locked(pool: &Pool<Sqlite>) -> Result<(), String> {
        sqlx::query("DELETE FROM sync_meta WHERE key IN ('locked','locked_reason')")
            .execute(pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }
    match scan {
        EpochScan::Found(e, info) => {
            meta_set(pool, "pending_epoch", &e).await?;
            let json = serde_json::to_string(&info).unwrap_or_default();
            meta_set(pool, "pending_epoch_info", &json).await?;
            // 改正待ち優先於鍵違い（前者有動作可按，後者只能重新加入）
            if meta.get("locked").is_some_and(|v| v != "salt") {
                clear_locked(pool).await?;
            }
            Ok(true)
        }
        EpochScan::Locked(epochs) => {
            let Some(top) = epochs.first() else { return Ok(false) };
            meta_set_if_changed(pool, meta.get("locked"), "locked", top).await?;
            // v1.1.4 修正席（工程評審 S-3）：**逐一**問旗標，任何一個在就是「換過鑰匙」。
            // 只看最大那一個會這樣出錯：A 換鑰匙開 E2（有旗標）→ 有人用新鑰匙「回到過去」開 E3（沒旗標）
            // → 還握著舊鑰匙的 B 兩個都拆不開，卻被判成「殘留」，文案叫主人去 Cloudflare 後台刪目錄。
            // 旗標讀失敗（網路）不該讓整趟 pull 變停車中：讀不到就維持上次的判斷、下一趟再問。
            let mut rotated = false;
            let mut all_read = true;
            for e in &epochs {
                match client.get_opt(&rotated_flag_key(root, e)).await {
                    Ok(Some(_)) => {
                        rotated = true;
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => all_read = false,
                }
            }
            if rotated || all_read {
                let reason = if rotated { "rotated" } else { "stale" };
                meta_set_if_changed(pool, meta.get("locked_reason"), "locked_reason", reason).await?;
            }
            Ok(true)
        }
        EpochScan::None => {
            // 之前記過的紀元鍵違い已經不成立（對方把 EPOCH.bin 補好了、或紀元被清掉）⇒ 清掉
            if meta.get("locked").is_some_and(|v| v != "salt") {
                clear_locked(pool).await?;
            }
            Ok(false)
        }
    }
}

/// `<root>/<E>/ROTATED` 的內容（契約 §2：小 JSON `{device_id, at}`）。
///
/// 讀的一方**要容忍空物件與壞 JSON**——拍板原本寫的是「明文空物件」，契約席才改成帶誰／何時；
/// 別台或舊版寫的空旗標一樣算旗標（只是不知道是誰寫的，回滾時就不敢刪它）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotatedFlag {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub at: String,
}

/// 旗標 bytes → `RotatedFlag`；空物件／壞 JSON ⇒ 欄位皆空的 flag（「旗標在，但不知道是誰」）
pub(crate) fn parse_rotated_flag(bytes: &[u8]) -> RotatedFlag {
    serde_json::from_slice::<RotatedFlag>(bytes).unwrap_or(RotatedFlag {
        device_id: String::new(),
        at: String::new(),
    })
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
    /// v1.1.4：`skipped` 裡「新列缺 NOT NULL 欄」那一種的筆數（契約 §4；只計新列，其餘四種跳過不算）
    pub skipped_missing: u64,
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
                out.skipped_missing += 1;
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

/// 主人在還原對話框選的方式（v1.1.3 契約 §6；提案規則②）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreChoice {
    /// 回到過去：所有裝置改用這份（開新紀元、全庫重上傳；別台未送出的修改另存、不自動併回）
    Past,
    /// 接上現在：只有這台換成備份（只清游標；雲端比備份新的修改下一趟蓋回來）
    Present,
}

/// 標記檔（`sync/epoch-pending`）與選擇檔（`sync/restore-choice`）共用的 JSON 形狀
#[derive(Serialize, Deserialize)]
struct RestoreMarker {
    at: String,
    choice: RestoreChoice,
    /// 還原的備份檔名（給 EPOCH.bin 的 `label` 與改正待ち文案）
    #[serde(default)]
    label: Option<String>,
}

/// 還原剛完成的標記檔：`backup_restore` 換檔成功後寫、`finish_restore` 收尾時刪。
///
/// 為什麼用檔不用 sync_meta：還原會把整顆 DB 換掉，DB 裡的任何旗標都跟著回到過去；app 資料目錄不會。
/// 桌機＝`%APPDATA%/<identifier>/sync/epoch-pending`（沙盒 identifier 天然隔離）。
/// v1.1.3：內容從純 ISO 字串改成 JSON（帶 `choice`／`label`）；舊格式讀成「回到過去」（＝v1.1.2 的唯一行為）。
fn restore_marker_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "找不到 app 資料目錄。".to_string())?
        .join("sync")
        .join("epoch-pending"))
}

/// 主人的選擇（對話框按下去、換檔**之前**寫）：`sync/restore-choice`。
/// 換檔成功時 `mark_restore_pending` 把它併進標記檔並刪掉；還原失敗它會留著，但下一次還原一定又經過對話框重寫，
/// 所以不會用到過期的選擇。
fn restore_choice_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "找不到 app 資料目錄。".to_string())?
        .join("sync")
        .join("restore-choice"))
}

/// 解標記檔內容：JSON（v1.1.3）或純 ISO 字串（v1.1.2 舊格式＝回到過去）。純函式，單測用。
fn parse_restore_marker(text: &str) -> (RestoreChoice, Option<String>) {
    match serde_json::from_str::<RestoreMarker>(text.trim()) {
        Ok(m) => (m.choice, m.label.filter(|l| !l.is_empty())),
        Err(_) => (RestoreChoice::Past, None),
    }
}

/// `sync_restore_choice`（契約 §4.5）：鑰匙圈缺 ⇒ Err（UI 據此不問、直接還原）；`None` ⇒ 清掉選擇檔。
///
/// 工程評審 B-1：憑證庫**讀不到**時回的是另一句 Err——前端的 `prepareRestore` 會再問一次狀態，
/// 看到 `configured=false` 就判成「這台沒加入、照常還原」。讀不到卻照常還原＝主人選的「回到過去」
/// 靜默變成「接上現在」，所以這條路必須與「真的沒加入」分得開（`status()` 此時 `joined=1`、`last_error` 非空）。
pub fn restore_choice(app: &AppHandle, choice: Option<RestoreChoice>, label: Option<String>) -> Result<(), String> {
    // 工程評審 B-4：還原會換掉整顆 DB 並重啟，boot 的 `finish_restore` 會先開一個 K1 的新紀元
    //（> E2）再輪到 `finish_rotation` 把這台切回 E2 ⇒ 自己開的紀元變成自己的「殘留」。
    // 清選擇（`None`）不動任何東西，放行。
    if choice.is_some() {
        guard_not_rotating(app)?;
    }
    match credstore::load(app) {
        Ok(Some(_)) => {}
        Ok(None) => return Err("這台還沒加入同步——還原不會影響其他裝置。".into()),
        Err(e) => return Err(format!("{e}讀不到這台的同步身分，還原先停在這裡——請重新啟動後再試。")),
    }
    let p = restore_choice_path(app)?;
    match choice {
        None => {
            let _ = std::fs::remove_file(&p);
            Ok(())
        }
        Some(c) => {
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir).map_err(|_| "建立同步目錄失敗。".to_string())?;
            }
            let doc = RestoreMarker {
                at: now_iso(),
                choice: c,
                label: label.filter(|l| !l.trim().is_empty()),
            };
            let text = serde_json::to_string(&doc).map_err(|_| "寫入還原選擇失敗。".to_string())?;
            std::fs::write(&p, text).map_err(|_| "寫入還原選擇失敗。".to_string())
        }
    }
}

/// 還原成功後留標記（backup.rs 在換檔之後呼叫；**簽名不變**；失敗只 log，不擋重啟）。
/// 讀 `restore-choice`（沒有＝回到過去，與 v1.1.2 行為一致）併進標記檔，然後刪掉選擇檔。
///
/// 目錄在**這裡**才建，不在 `restore_marker_path`：`sync_status()` 每 60 秒會叫一次 `restore_marker`，
/// 沒加入同步的桌機不該只因為「被問了狀態」就在 `%APPDATA%` 長出一個空資料夾（鐵則：同步關著時桌機零改變）。
pub fn mark_restore_pending(app: &AppHandle) -> Result<(), String> {
    let p = restore_marker_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "建立同步目錄失敗。".to_string())?;
    }
    // 工程評審 S-5：**先讀不刪**。舊碼是「讀→刪選擇檔→寫標記」，標記寫失敗時主人的選擇連同
    // 「有還原這件事」一起消失（＝靜默變成沒有收尾的還原）。改成寫成功之後才刪選擇檔。
    let choice_path = restore_choice_path(app).ok();
    let (choice, label) = choice_path
        .as_ref()
        .and_then(|cp| Some(parse_restore_marker(&std::fs::read_to_string(cp).ok()?)))
        // 產品評審 S-4：沒有選擇檔時退到**接上現在**（只動這一台），不是「回到過去」（動所有裝置）。
        // 走到這裡而沒有選擇檔＝前端沒問成或沒寫成，此時該選的是後果最小的那一個。
        //（正常路徑一定有選擇檔：加入了同步才問，問完才落檔、落檔失敗前端就不還原。）
        .unwrap_or((RestoreChoice::Present, None));
    let doc = RestoreMarker { at: now_iso(), choice, label };
    let text = serde_json::to_string(&doc).map_err(|_| "寫入還原標記失敗。".to_string())?;
    std::fs::write(&p, text).map_err(|_| "寫入還原標記失敗。".to_string())?;
    if let Some(cp) = choice_path.as_ref() {
        let _ = std::fs::remove_file(cp);
    }
    Ok(())
}

/// 讀標記檔：None＝沒有還原待收尾；Some((choice, label))
pub fn restore_marker(app: &AppHandle) -> Option<(RestoreChoice, Option<String>)> {
    let p = restore_marker_path(app).ok()?;
    let text = std::fs::read_to_string(&p).ok()?;
    Some(parse_restore_marker(&text))
}

pub fn is_restore_pending(app: &AppHandle) -> bool {
    restore_marker(app).is_some()
}

pub fn clear_restore_pending(app: &AppHandle) {
    if let Ok(p) = restore_marker_path(app) {
        let _ = std::fs::remove_file(p);
    }
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
    /// v1.1.3 產品評審 S2：手機換掉整顆庫之前匯出的全量 JSON（桌機是 TS 先拍 manual 備份，這欄為 None）
    pub export_path: Option<String>,
}

/// 精靈（scripts/setup-r2.sh）寫進 `%LOCALAPPDATA%/NextStop/r2.env` 的四欄。**不 derive Debug**（含 secret）。
#[derive(Clone, Serialize)]
pub struct WizardEnv {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

/// 開新紀元時要清掉的「跟舊紀元綁定」的 sync_meta 鍵（游標、seen、push 進度、物件戳記、in-flight、待換紀元、鍵違い）。
/// `epoch`／`joined`／`salt`／`root`／`device_id` 不在此列——那是身分，不是進度（v1.1.3 契約 §3.2）。
/// `join_pending` 也在此列（工程評審 B-2）：換紀元的三條路（加入／回到過去／改用那份）都會
/// 自己重新快照或整批換掉資料，上一次沒做完的那次快照已經沒有意義了。
/// **順序要注意**：`join` 的落地交易是「先跑這句、再視結局重新立旗」。
/// v1.1.4（契約 §4.3）：`locked_reason` 跟著 `locked` 一起清——它是「那個鍵違い的原因」，
/// 紀元一換就沒有主詞了；留著會讓下一次真的殘留（`stale`）被上一次的「換過鑰匙」文案蓋掉。
/// `last_cloud_snapshot_*`／`skipped_missing_total` **不在此列**（它們跨紀元累計）。
pub(crate) const EPOCH_SCOPED_META: &str = "DELETE FROM sync_meta WHERE key LIKE 'last_pull_key%' OR key LIKE 'seen:%' \
     OR key IN ('last_push_hlc','last_object_stamp','inflight_key','inflight_max_seq','pending_epoch','pending_epoch_info','locked','locked_reason','join_pending')";

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
pub(crate) async fn wipe_local_data(tx: &mut sqlx::Transaction<'_, Sqlite>) -> Result<(), String> {
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
pub(crate) async fn export_outbox_orphans(
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

/// v1.1.4（契約 §6）：「把本機資料整批換掉」之前的雲端留底——用**鑰匙圈當下那把**鑰匙拍一份 manual 快照。
/// 只給 `adopt_epoch` 用（`join` 那條路手上已經有剛解出來的鑰匙與根，直接叫 `put_cloud_snapshot`）。
async fn cloud_backup_before_switch(
    app: &AppHandle,
    pool: &Pool<Sqlite>,
    device_id: &str,
) -> Result<(), String> {
    let creds = credstore::load(app)?.ok_or_else(|| "這台還沒加入同步。".to_string())?;
    guard_sandbox_root(app, &creds.root)?;
    let key = crypto::key_from_b64(&creds.data_key_b64)?;
    let client = client_of(&creds)?;
    put_cloud_snapshot(
        pool,
        &client,
        &key,
        &creds.root,
        device_id,
        super::snapshot::SnapshotKind::Safety,
    )
    .await?;
    Ok(())
}

/// replica 專用：把未推的 outbox 匯出成 JSON → 清 nodes／work_logs／occurrences ＋ outbox／cells／游標 →
/// epoch＝pending_epoch → 清 pending_epoch。**不 pull**（TS 端接著叫 `sync_pull` 拉全量）。規格見契約 §4.4。
pub async fn adopt_epoch(app: &AppHandle) -> Result<AdoptReport, String> {
    // 工程評審 B-4：換鑰匙沒做完時切紀元會與步驟 4 打架
    guard_not_rotating(app)?;
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

    // 產品評審 S2：桌機「改用那份」之前由 TS 拍一份 manual 備份，**手機沒有備份三件套**——
    // 舊碼只匯出 outbox 孤兒（未送出的那幾筆），這台原有的整份資料是靜默丟掉的。
    // 提案第三節本來就寫「手機匯出全量 JSON 到下載目錄」，加入時的「改用另一台的」也已經這麼做了，
    // 只有這條（改正待ち→改用那份）漏了。
    //
    // **v1.1.4（契約 §6）**：手機的留底改成「先拍一份 manual 雲端快照」。理由是查證結果——
    // Android 的 `download_dir()` 回的是 app 專屬目錄（`Android/data/<pkg>/files/Download`），
    // 主人在檔案管理員看不到、移除 App 就一起消失＝那份「留底」其實留不住。雲端那份任何裝置都還原得回來。
    // 雲端拍不成（沒網路／桶壞了）才退回既有的 JSON 落檔，路徑照舊回報。
    let mut export_path: Option<String> = None;
    if cfg!(mobile) {
        // 成功＝`last_cloud_snapshot_*` 已經寫好（`put_cloud_snapshot` 自己記），`export_path` 留 None
        if let Err(e) = cloud_backup_before_switch(app, &pool, &device_id).await {
            eprintln!("[sync:adopt] cloud safety snapshot failed: {e}");
            export_path = Some(export_full_json(app, &pool).await?);
        }
    }
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
    if let Some(p) = export_path.as_deref() {
        meta_set(&mut *tx, "last_export_path", p).await?;
        meta_set(&mut *tx, "last_export_at", &now_iso()).await?;
    }
    tx.commit().await.map_err(db_err)?;
    st.set_gate(None);

    Ok(AdoptReport {
        orphan_ops,
        orphans_path,
        epoch: new_epoch,
        export_path,
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

// ─────────────────────────────────────────────────────────────
// v1.1.3 單一入口／兩層鑰匙／還原二選一
// 規格：docs/research/2026-09-21-v1.1.3-同步規則重整契約.md §4（command）、§5（合併）、§6（還原）、§7（遷移）
// 拍板：docs/決策記錄.md〈同步與備份規則重整拍板〉＋《同步與備份-提案》三條規則＋《…反駁評審》B1–B4
// ─────────────────────────────────────────────────────────────

/// 兩邊都有資料時主人的選擇（契約 §4.2；按鈕字＝「兩邊都保留」／「改用另一台的」）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinMode {
    /// 兩邊都保留：補戳格子 → 拉全量（LWW 以格子為準）→ 快照（原始時間戳）→ push
    Merge,
    /// 改用另一台的：桌機先由 TS 拍 manual 備份／手機匯出全量 JSON → 清本機 → 拉全量
    AdoptRemote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinOutcome {
    /// 雲端空 ⇒ 這台是第一台（開紀元、寫 SALT／KEY、全庫快照）
    First,
    /// 雲端有資料、這台空 ⇒ 直接拉下來
    Pulled,
    /// 兩邊都有資料且沒帶 mode ⇒ 什麼都沒動，等 UI 問完帶 mode 再來
    NeedsChoice,
    Merged,
    Adopted,
    /// 鑰匙圈的血統（SALT）與桶裡一致 ⇒ 只更新憑證，其餘不動、不問
    Reconnected,
}

/// `sync_join` 的參數（commands.rs 的 `JoinInput` 轉過來）。**不 derive Debug**：含 secret 與密語。
pub struct JoinArgs {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub passphrase: String,
    /// 省略＝`credstore::DEFAULT_ROOT`
    pub root: Option<String>,
    pub mode: Option<JoinMode>,
}

/// `sync_join` 的回傳（契約 §4.2）
#[derive(Debug, Clone, Serialize)]
pub struct JoinReport {
    pub outcome: JoinOutcome,
    /// 本機活節點數（needs_choice 文案）
    pub local_alive: u64,
    /// 雲端目前紀元（first＝新開的那個）
    pub remote_epoch: Option<String>,
    /// 目前紀元底下的裝置目錄數（needs_choice 文案）
    pub remote_devices: u64,
    /// first／merged：進 outbox 的 op 數（TS 接著 push）
    pub snapshot_ops: u64,
    /// pulled／merged／adopted：join 內部已拉下來套用的報告（TS 據此 refreshAfterPull＋seedHlc）
    pub pull: Option<PullReport>,
    /// adopted 且手機：全量 JSON 落點；桌機＝None（備份由 TS 先拍）
    pub export_path: Option<String>,
    /// toast 一句
    pub message: String,
}

/// `sync_change_passphrase` 的回傳（契約 §4.4；v1.1.4 契約 §4 加三欄）
#[derive(Debug, Clone, Serialize)]
pub struct PassphraseReport {
    /// 之前桶裡沒有 KEY（舊血統升級後第一次）⇒ 這次是「封存」不是「更改」
    pub sealed_first_time: bool,
    /// v1.1.4：這次有沒有連資料鑰匙一起換（勾了「同時換掉資料鑰匙」）
    pub rotated: bool,
    /// v1.1.4：輪替步驟 5 重加密了幾顆雲端快照（沒輪替＝0）
    pub reencrypted_snapshots: u64,
    /// v1.1.4：輪替步驟 6 刪掉幾個舊紀元目錄（沒輪替＝0）
    pub deleted_epochs: u64,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreOutcome {
    /// 回到過去：開了新紀元、快照已進 outbox（TS 接著 push）
    Renewed,
    /// 接上現在：只清了游標（TS 接著跑一趟）
    Resumed,
    /// 這台沒鑰匙圈：標記已清、零同步動作
    NotJoined,
}

/// `sync_finish_restore` 的回傳（契約 §4.5）
#[derive(Debug, Clone, Serialize)]
pub struct RestoreReport {
    pub outcome: RestoreOutcome,
    /// renewed：新紀元號
    pub epoch: Option<String>,
    /// renewed：進 outbox 的 op 數
    pub snapshot_ops: u64,
    pub message: String,
}

// ── 桶內佈局與小工具（契約 §2）──

/// `<root>/SALT`：16B 鹽的 base64url，**明文**。它是「血統識別」——兩台的 SALT 一樣才是同一份資料。
/// 舊血統（v1.1.2 升上來）另外還是資料鑰匙的派生鹽（§7 ⑤）。
pub(crate) fn salt_object_key(root: &str) -> String {
    format!("{root}/SALT")
}

/// `<root>/KEY`：資料鑰匙被「密語派生的包裝鑰匙」封起來的那一顆（`crypto::wrap_data_key`）。
pub(crate) fn key_object_key(root: &str) -> String {
    format!("{root}/KEY")
}

/// 沙盒／開發建置不准碰正本的桶內根（工程評審 B-3）。
///
/// 為什麼要有這道：2026-09-21 沙盒 exe 用預設 `root="v1"` 加入，把一顆與主人資料無關的
/// `v1/KEY` 寫進正本根目錄——主人的桌機從此在改密語頁看到「現在的密語不對」。
/// 判準是 **app identifier**：正本是 `app.shitetsu.nextstop`，沙盒與 dev 一律帶尾碼
///（`…​.sandbox-<run>`／`…​.dev`）。帶尾碼的建置只准用帶尾碼的根。
pub(crate) fn guard_sandbox_root(app: &AppHandle, root: &str) -> Result<(), String> {
    let id = app.config().identifier.trim().to_string();
    let is_release_identity = id.is_empty() || id == credstore::SERVICE;
    if !is_release_identity && root == credstore::DEFAULT_ROOT {
        return Err(format!(
            "這是沙盒／開發建置（{id}），不准用正本的桶內根「{root}」——請填一個自己的根前綴。"
        ));
    }
    Ok(())
}

/// `<root>/<epoch>/EPOCH.bin`
pub(crate) fn epoch_marker_key(root: &str, epoch: &str) -> String {
    format!("{root}/{epoch}/EPOCH.bin")
}

/// v1.1.4（契約 §2）：`<root>/<epoch>/ROTATED`——**明文**旗標，換鑰匙開的紀元才有。
/// 別台看到「拆不開的新紀元＋這顆旗標」＝另一台換過鑰匙（不是殘留），文案走「用新密語重新加入」。
/// 內容是小 JSON `{"device_id","at"}`（誰、何時開始換；讀的一方也要容忍空物件）。
pub(crate) fn rotated_flag_key(root: &str, epoch: &str) -> String {
    format!("{root}/{epoch}/ROTATED")
}

/// v1.1.4（工程評審 B-1／B-2／S-7 的共用守門）：**別台是不是已經把資料鑰匙換掉了？**
///
/// 判準（兩條都要成立才算）：桶裡有一個紀元 `> my_epoch`（`None`＝不比、全掃）、它帶著明文 `ROTATED` 旗標、
/// 而且它的 `EPOCH.bin` 用**我手上這把鑰匙拆不開**。回那個紀元號（由大到小第一個），沒有就是 `None`。
///
/// 為什麼要抽成一支：三條路都會在「這台的 K1 其實已經作廢」時做出毀滅性的事——
///   * `change_passphrase`（不勾換鑰匙）會把桶裡的 `KEY` 從 K2 蓋回 K1 ⇒ K2 從世上消失、真撤銷變真斷線；
///   * `join` ④ 的舊血統自癒（`Err(_)` 分支）在主人正本那種舊血統桶裡同樣會把 KEY 蓋回 K1；
///   * `finish_restore(Past)` 會用 K1 開一個比 E2 還大的紀元 ⇒ 兩個血統永久分裂。
/// 三處各寫一次掃描太容易走岔，所以一支到底；成本是「只有在真的有更新紀元時」才多兩次 Class B GET。
///
/// 注意 `EPOCH.bin` **拆得開**就不算（那是我自己的紀元，或同血統的新紀元），旗標是必要條件不是充分條件——
/// 輪替完成後自己那台再看自己的 E2 也有旗標，但它拆得開，不該把自己擋住。
pub(crate) async fn rotated_elsewhere(
    client: &R2Client,
    root: &str,
    key: &[u8; crypto::KEY_LEN],
    my_epoch: Option<&str>,
) -> Result<Option<String>, String> {
    let mine = my_epoch.and_then(|e| e.parse::<u64>().ok());
    for n in list_epochs(client, root).await? {
        if let Some(mine) = mine {
            if n <= mine {
                continue;
            }
        }
        let e = n.to_string();
        if client.get_opt(&rotated_flag_key(root, &e)).await?.is_none() {
            continue;
        }
        let openable = match client.get_opt(&epoch_marker_key(root, &e)).await? {
            Some(blob) => epoch_marker_verdict(root, &e, key, &blob).is_some(),
            None => false,
        };
        if !openable {
            return Ok(Some(e));
        }
    }
    Ok(None)
}

/// v1.1.4（契約 §2）：雲端快照的目錄前綴 `<root>/snapshots/`（物件鍵格式見 `snapshot::snapshot_key`）
pub(crate) fn snapshots_prefix(root: &str) -> String {
    format!("{root}/snapshots/")
}

/// 物件 key → 檔名去掉 `.bin`（＝推送戳記；重推 in-flight 時要拿回它）
fn stamp_of_object_key(object_key: &str) -> Option<String> {
    object_key
        .rsplit('/')
        .next()
        .and_then(|f| f.strip_suffix(".bin"))
        .map(str::to_string)
}

/// 憑證 → R2 client（四欄都要 clone，`R2Config` 是 by-value）
pub(crate) fn client_of(creds: &SyncCredentials) -> Result<R2Client, String> {
    R2Client::new(R2Config {
        endpoint: creds.endpoint.clone(),
        bucket: creds.bucket.clone(),
        access_key_id: creds.access_key_id.clone(),
        secret_access_key: creds.secret_access_key.clone(),
    })
}

/// argon2id 是 CPU 密集的同步工作（19 MiB／數百 ms），直接跑在 tokio worker 上會卡住整個 runtime
/// （手機低階機最明顯）⇒ 一律 `spawn_blocking`（評審 S7）。
pub(crate) async fn derive_blocking(passphrase: &str, salt: &[u8]) -> Result<[u8; crypto::KEY_LEN], String> {
    let passphrase = passphrase.to_string();
    let salt = salt.to_vec();
    tauri::async_runtime::spawn_blocking(move || crypto::derive_key(&passphrase, &salt))
        .await
        .map_err(|_| "金鑰派生被中斷了，請再試一次。".to_string())?
}

/// `<root>/` 底下的數字紀元，**由大到小**
pub(crate) async fn list_epochs(client: &R2Client, root: &str) -> Result<Vec<u64>, String> {
    let dirs = client.list_prefixes(&format!("{root}/")).await?;
    let mut v: Vec<u64> = dirs
        .iter()
        .filter_map(|d| d.trim_end_matches('/').rsplit('/').next())
        .filter_map(|seg| seg.parse::<u64>().ok())
        .collect();
    v.sort_unstable();
    v.dedup();
    v.reverse();
    Ok(v)
}

/// 「目前紀元」＝數字紀元由大到小，第一個**拆得開**的（契約 §4.2 步驟 7）。
///
/// 判準有兩條退路：① `EPOCH.bin` 拆得開（v1.1.3 之後開的紀元都有）
/// ② 沒有 `EPOCH.bin`（v1.1.1／v1.1.2 開的）但第一個裝置目錄的第一顆物件拆得開。
/// 兩條都不成立就換下一個更小的紀元；全部都不成立 ⇒ None（＝這把資料鑰匙在這個桶裡沒有資料）。
pub(crate) async fn resolve_current_epoch(
    client: &R2Client,
    key: &[u8; crypto::KEY_LEN],
    root: &str,
) -> Result<Option<String>, String> {
    for n in list_epochs(client, root).await? {
        let e = n.to_string();
        let marker = epoch_marker_key(root, &e);
        if let Some(blob) = client.get_opt(&marker).await? {
            if epoch_marker_verdict(root, &e, key, &blob).is_some() {
                return Ok(Some(e));
            }
            continue;
        }
        // 沒有 EPOCH.bin：拿第一個裝置目錄的第一顆物件試拆
        let dirs = client.list_prefixes(&format!("{root}/{e}/")).await?;
        let Some(dir) = dirs.first() else { continue };
        let keys = client.list_after(&format!("{dir}/"), "").await?;
        let Some(k) = keys.first() else { continue };
        let blob = client.get(k).await?;
        if crypto::open(key, k, &blob).is_ok() {
            return Ok(Some(e));
        }
    }
    Ok(None)
}

/// 一顆 `EPOCH.bin` 認不認（契約 §5.6「拆得開即承認」）：用這把資料鑰匙拆得開、解得出 `EpochInfo`、
/// 而且裡面的 `epoch` 與目錄名相符 ⇒ 承認。拆不開＝別的密語建的，不是我的事（呼叫端記成鍵違い）。
///
/// v1.1.2 還有第三道關卡「`primary_device_id` 等於我認得的正本」，隨正本／副本一起退場（評審 S1）。
pub(crate) fn epoch_marker_verdict(
    root: &str,
    epoch: &str,
    key: &[u8; crypto::KEY_LEN],
    blob: &[u8],
) -> Option<EpochInfo> {
    crypto::open(key, &epoch_marker_key(root, epoch), blob)
        .ok()
        .and_then(|p| serde_json::from_slice::<EpochInfo>(&p).ok())
        .filter(|info| info.epoch == epoch)
}

/// 寫 `<root>/<epoch>/EPOCH.bin`（`reason`＝`first`／`restore`／`backfill`）
pub(crate) async fn put_epoch_marker(
    client: &R2Client,
    key: &[u8; crypto::KEY_LEN],
    root: &str,
    epoch: &str,
    opener: &str,
    reason: &str,
    label: Option<String>,
) -> Result<(), String> {
    let marker = epoch_marker_key(root, epoch);
    let info = EpochInfo {
        version: EPOCH_INFO_VERSION,
        epoch: epoch.to_string(),
        opener_device_id: opener.to_string(),
        created_at: now_iso(),
        reason: reason.to_string(),
        label: label.filter(|l| !l.trim().is_empty()),
    };
    let plain = serde_json::to_vec(&info).map_err(|_| "產生紀元標記失敗。".to_string())?;
    let blob = crypto::seal(key, &marker, &plain)?;
    client.put(&marker, blob).await
}

/// 用密語把資料鑰匙封成 `<root>/KEY` 並 PUT（新的 kdf 鹽）。改密語＝重跑這一支（契約 §2.1）。
pub(crate) async fn seal_key_object(
    client: &R2Client,
    root: &str,
    passphrase: &str,
    data_key: &[u8; crypto::KEY_LEN],
) -> Result<(), String> {
    let (obj, bytes) = wrapped_key_bytes(root, passphrase, data_key).await?;
    client.put(&obj, bytes).await
}

/// 同上，但**只有桶裡還沒有 KEY 時才寫**（工程評審 S-3(b)）。
///
/// 差別在「誰按的」：主人在〈密語〉頁按下「改密語」是明確動作，覆蓋是對的；
/// 加入／重接時的「順手封存」是程式自己決定的，不該把別台剛用新密語改好的那顆蓋回舊密語。
async fn seal_key_object_if_absent(
    client: &R2Client,
    root: &str,
    passphrase: &str,
    data_key: &[u8; crypto::KEY_LEN],
) -> Result<(), String> {
    let (obj, bytes) = wrapped_key_bytes(root, passphrase, data_key).await?;
    client.put_if_absent(&obj, bytes).await.map(|_| ())
}

/// `<root>/KEY` 的 key 與封好的位元組（新的 kdf 鹽、新的 nonce）
pub(crate) async fn wrapped_key_bytes(
    root: &str,
    passphrase: &str,
    data_key: &[u8; crypto::KEY_LEN],
) -> Result<(String, Vec<u8>), String> {
    let kdf_salt = crypto::random_salt()?;
    let wrap = derive_blocking(passphrase, &kdf_salt).await?;
    let obj = key_object_key(root);
    let bytes = crypto::wrap_data_key(&wrap, &obj, data_key, &kdf_salt)?;
    Ok((obj, bytes))
}

/// 拆 `<root>/KEY`：先讀物件自帶的 kdf 鹽派生包裝鑰匙，再拆出資料鑰匙。
pub(crate) async fn unseal_key_object(
    root: &str,
    passphrase: &str,
    bytes: &[u8],
) -> Result<[u8; crypto::KEY_LEN], String> {
    let wk = crypto::parse_wrapped_key(bytes)?;
    let kdf_salt = crypto::b64_decode(&wk.salt)?;
    let wrap = derive_blocking(passphrase, &kdf_salt).await?;
    crypto::unwrap_data_key(&wrap, &key_object_key(root), bytes)
}

/// 本機活著的節點數（契約 §2.3 的「空」）。設定、日誌、墓碑都不算。
async fn local_alive_count(pool: &Pool<Sqlite>) -> Result<u64, String> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL")
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(row.try_get::<i64, _>("n").map_err(db_err)?.max(0) as u64)
}

/// 每台每個進程一次：確認桶裡有 `<root>/SALT`（缺就補）、記下有沒有 `KEY`、目前紀元缺 `EPOCH.bin` 就補寫。
/// 契約 §4.7／§7 ④⑥。
///
/// 回 `true`＝**鍵違い**（桶裡的 SALT 與這台不同＝這份資料已被別的密語重建）⇒ 呼叫端停手。
///
/// 為什麼要有 SALT 這顆物件：v1.1.2 的鹽只活在配對碼與 `sync_meta` 裡，於是「第二台桌機手填四欄」
/// 會產生一組不同的鹽、兩台互相看不見卻都以為自己在同步（評審 B3）。把鹽放進桶裡，血統就有了唯一來源。
async fn ensure_bucket_meta(
    app: &AppHandle,
    pool: &Pool<Sqlite>,
    client: &R2Client,
    creds: &SyncCredentials,
    epoch: &str,
    me: &str,
) -> Result<bool, String> {
    let meta = meta_all(pool).await?;
    let done = app
        .try_state::<SyncState>()
        .is_some_and(|st| st.bucket_meta_done());
    if done {
        return Ok(meta.get("locked").map(String::as_str) == Some("salt"));
    }

    let root = creds.root.as_str();
    let mine = creds
        .salt_b64
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| meta.get("salt").filter(|s| !s.is_empty()).cloned());

    // ① 血統標記
    let salt_obj = salt_object_key(root);
    match client.get_opt(&salt_obj).await? {
        None => {
            if let Some(mine) = mine.as_deref() {
                client.put(&salt_obj, mine.as_bytes().to_vec()).await?;
            }
        }
        Some(bytes) => {
            let theirs = String::from_utf8_lossy(&bytes).trim().to_string();
            match mine.as_deref() {
                Some(mine) if mine != theirs => {
                    meta_set(pool, "locked", "salt").await?;
                    return Ok(true);
                }
                _ => {
                    if meta.get("locked").map(String::as_str) == Some("salt") {
                        sqlx::query("DELETE FROM sync_meta WHERE key = 'locked'")
                            .execute(pool)
                            .await
                            .map_err(db_err)?;
                    }
                }
            }
        }
    }

    // ② 桶裡有沒有 KEY（改密語頁要據此決定「第一次要先打現密語」）
    let sealed = client.get_opt(&key_object_key(root)).await?.is_some();
    meta_set_if_changed(pool, meta.get("key_sealed"), "key_sealed", if sealed { "1" } else { "0" })
        .await?;

    // ③ 目前紀元缺 EPOCH.bin（v1.1.1／v1.1.2 開的紀元都沒有）⇒ 補寫，之後別台的偵測才有依據
    if !epoch.is_empty() && client.get_opt(&epoch_marker_key(root, epoch)).await?.is_none() {
        let key = crypto::key_from_b64(&creds.data_key_b64)?;
        put_epoch_marker(client, &key, root, epoch, me, "backfill", None).await?;
    }

    meta_set_if_changed(pool, meta.get("bucket_meta_checked"), "bucket_meta_checked", "1").await?;
    if let Some(st) = app.try_state::<SyncState>() {
        st.set_bucket_meta_done();
    }
    Ok(false)
}

/// 手機「改用另一台的」之前，把整顆庫匯出成人看得懂的 JSON（契約 §4.7）。
///
/// 為什麼手機要匯出而桌機是拍備份：手機沒有〈備份與還原〉（v1.1.0 拍板的不對等），
/// 「改用另一台的」會把這台現有的東西全部換掉——不留一份就是靜默丟資料（評審 S2）。
/// 落點先試「下載／NextStop」（主人用檔案管理員讀得到），寫不進去才退回 app 私有目錄。
///
/// **v1.1.4**：拆成 `build_full_json`（純字串；雲端快照也封這一份）＋ `write_export_file`（原本的落檔行為）。
/// 這支保留給既有呼叫者（`adopt_epoch`／`join(adopt_remote)` 的手機退路）；v1.1.4 起手機的自動留底改走
/// 「先拍一份 manual 雲端快照」（`snapshot::upload`），只有雲端拍不成才退回這裡（契約 §6-6）。
pub async fn export_full_json(app: &AppHandle, pool: &Pool<Sqlite>) -> Result<String, String> {
    let text = build_full_json(pool, super::snapshot::SnapshotKind::Manual).await?;
    write_export_file(app, &text)
}

/// v1.1.4（契約 §2.3）：整顆庫 → 全量 JSON 字串。三表**全欄**（不是白名單：這是存底，不是 op）＋settings 白名單，
/// 頂層欄位固定＝`schema`／`snapshot_kind`／`exported_at`／`device_id`／`epoch`／`nodes`／`work_logs`／`occurrences`／`settings`。
/// 雲端快照＝這份字串 `crypto::seal(資料鑰匙, aad=物件鍵)` 後 PUT；匯入端（`snapshot::import_full_json`）照契約 §3 逐欄對齊。
pub(crate) async fn build_full_json(
    pool: &Pool<Sqlite>,
    kind: super::snapshot::SnapshotKind,
) -> Result<String, String> {
    use sqlx::Column;

    /// 一列 → JSON 物件（**全欄**，不是白名單：這是給主人看的存底，不是 op）
    fn row_json(row: &sqlx::sqlite::SqliteRow) -> Map<String, Value> {
        let mut m = Map::new();
        for (i, c) in row.columns().iter().enumerate() {
            let v = if let Ok(Some(n)) = row.try_get::<Option<i64>, _>(i) {
                Value::from(n)
            } else if let Ok(Some(f)) = row.try_get::<Option<f64>, _>(i) {
                Value::from(f)
            } else if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
                Value::from(s)
            } else {
                Value::Null
            };
            m.insert(c.name().to_string(), v);
        }
        m
    }

    let meta = meta_all(pool).await?;
    let mut doc = Map::new();
    doc.insert("schema".into(), Value::from(SCHEMA_VERSION));
    doc.insert("snapshot_kind".into(), Value::from(kind.as_str()));
    doc.insert("exported_at".into(), Value::from(now_iso()));
    doc.insert(
        "device_id".into(),
        Value::from(meta.get("device_id").cloned().unwrap_or_default()),
    );
    doc.insert(
        "epoch".into(),
        Value::from(meta.get("epoch").cloned().unwrap_or_default()),
    );
    for (tbl, order) in [
        ("nodes", "created_at"),
        ("work_logs", "logged_at"),
        ("occurrences", "due_on"),
    ] {
        let rows = sqlx::query(&format!("SELECT * FROM {tbl} ORDER BY {order}"))
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
        doc.insert(
            tbl.into(),
            Value::Array(rows.iter().map(|r| Value::Object(row_json(r))).collect()),
        );
    }
    let mut settings = Map::new();
    for key in SYNC_SETTINGS_KEYS {
        if let Some(row) = sqlx::query("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?
        {
            settings.insert(
                (*key).to_string(),
                Value::from(row.try_get::<String, _>("value").map_err(db_err)?),
            );
        }
    }
    doc.insert("settings".into(), Value::Object(settings));

    serde_json::to_string_pretty(&Value::Object(doc)).map_err(|_| "匯出資料失敗。".to_string())
}

/// v1.1.4：把整顆庫拍成一顆雲端快照 PUT 上去——**鑰匙、client、root、身分全部由呼叫端給**。
///
/// 為什麼 engine 這邊也要一支（而不是一律叫 `snapshot::upload`）：engine 的三個呼叫點
///（輪替步驟 0.5、`join(adopt_remote)`、`adopt_epoch`）都**已經握著 `BusyGuard`**，而 `snapshot::upload`
/// 的入口是 `keyed_client`＋`BusyGuard`（它自己去拿）——從這三處呼叫必定撞自己的鎖。
/// 而且這三處手上的鑰匙／根未必等於鑰匙圈當下那一份：`join` 還沒存鑰匙圈，輪替期間鑰匙圈有兩把。
/// 所以「組鍵 → `build_full_json` → seal → PUT → 記 `last_cloud_snapshot_*`」這段做成共用核心，
/// `snapshot::upload` 只要在外層補 `keyed_client`＋`BusyGuard`＋`prune` 就是同一件事（差異記回報）。
pub(crate) async fn put_cloud_snapshot(
    pool: &Pool<Sqlite>,
    client: &R2Client,
    data_key: &[u8; crypto::KEY_LEN],
    root: &str,
    device_id: &str,
    kind: super::snapshot::SnapshotKind,
) -> Result<super::snapshot::SnapshotEntry, String> {
    let at = chrono::Utc::now();
    let key = super::snapshot::snapshot_key(root, at, device_id, kind);
    let text = build_full_json(pool, kind).await?;
    let blob = crypto::seal(data_key, &key, text.as_bytes())?;
    let size = blob.len() as u64;
    client.put(&key, blob).await?;
    // 鍵名的戳記只到秒，`at` 也記到秒——列表是從鍵名反推的，兩邊不該差一個小數點
    let at_iso = at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    meta_set(pool, "last_cloud_snapshot_at", &at_iso).await?;
    // 「當日」與備份三件套同義＝**本地**日曆日（主人眼裡的今天），不是 UTC 日
    meta_set(
        pool,
        "last_cloud_snapshot_day",
        &chrono::Local::now().format("%Y-%m-%d").to_string(),
    )
    .await?;
    Ok(super::snapshot::SnapshotEntry {
        key,
        at: at_iso,
        device_id: device_id.to_string(),
        kind,
        size,
    })
}

/// 全量 JSON 落成檔案（`export_full_json` 原本的後半）：`download_dir()/NextStop/nextstop-export-<ts>.json`，
/// 寫不進去退回 app 資料目錄；回完整路徑。
///
/// **已知（v1.1.4 查證 `…-Android下載目錄寫入查證.md`）**：Android 的 `download_dir()` 回的是 app 專屬外部目錄
/// `Android/data/<pkg>/files/Download`——主人在檔案管理員看不到、移除 App 就消失。所以這支在手機上只當
/// **退路**（雲端拍不成、或 SAF 選擇器用不了時）；主動「匯出到手機」走 `snapshot::export_to_file`（SAF）。
pub(crate) fn write_export_file(app: &AppHandle, text: &str) -> Result<String, String> {
    let name = format!(
        "nextstop-export-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    );
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(d) = app.path().download_dir() {
        candidates.push(d.join("NextStop"));
    }
    candidates.push(
        app.path()
            .app_data_dir()
            .map_err(|_| "找不到 app 資料目錄。".to_string())?,
    );
    for dir in &candidates {
        if std::fs::create_dir_all(dir).is_err() {
            continue;
        }
        let path = dir.join(&name);
        if std::fs::write(&path, text).is_ok() {
            return Ok(path.to_string_lossy().to_string());
        }
    }
    Err("寫入匯出檔失敗。".into())
}

/// v1.1.4：鑰匙圈＋資料鑰匙＋client＋圍籬一次取齊（`snapshot.rs` 的每支入口都從這裡開始，WP-B 不必碰鑰匙圈）。
///
/// 回 Err 的三種：沒鑰匙圈（「這台還沒加入同步」）、鑰匙圈讀不到（原句）、沙盒用了正本的根（`guard_sandbox_root`）。
/// `epoch`＝`sync_meta.epoch`（可能是 None：還原到加入之前的備份）。
pub(crate) struct KeyedClient {
    pub client: R2Client,
    pub data_key: [u8; crypto::KEY_LEN],
    pub root: String,
    pub device_id: String,
    pub epoch: Option<String>,
    pub creds: SyncCredentials,
}

pub(crate) async fn keyed_client(app: &AppHandle, pool: &Pool<Sqlite>) -> Result<KeyedClient, String> {
    let creds = credstore::load(app)?.ok_or_else(|| "這台還沒加入同步。".to_string())?;
    let root = creds.root.clone();
    guard_sandbox_root(app, &root)?;
    let data_key = crypto::key_from_b64(&creds.data_key_b64)?;
    let client = client_of(&creds)?;
    let meta = meta_all(pool).await?;
    let device_id = match creds.device_id.clone().filter(|d| !d.is_empty()) {
        Some(d) => d,
        None => ensure_device_id(pool).await?,
    };
    Ok(KeyedClient {
        client,
        data_key,
        root,
        device_id,
        epoch: meta.get("epoch").filter(|e| !e.is_empty()).cloned(),
        creds,
    })
}

/// v1.1.4：「切紀元」共用段——`finish_restore(Past)` 的那個交易抽出來給鑰匙輪替（契約 §5 步驟 4）共用。
///
/// 做的事（一個交易）：`DELETE FROM sync_outbox`、清 `EPOCH_SCOPED_META`、`epoch=new_epoch`、
/// 強制 `joined/enabled='1'`、`salt/root/device_id` 回寫、`sync_cells.device_id` 舊身分→鑰匙圈身分、
/// `stamp_missing_cells`。**cells 不清**（原始時間戳的來源）。回補了幾格。
/// 不做的事：`put_epoch_marker`、`snapshot_into_outbox`、push——呼叫端自己排（順序各有不同）。
pub(crate) async fn switch_epoch_local(
    pool: &Pool<Sqlite>,
    creds: &SyncCredentials,
    device_id: &str,
    old_device_id: &str,
    new_epoch: &str,
) -> Result<u64, String> {
    let root = creds.root.as_str();
    let mut tx = pool.begin().await.map_err(db_err)?;
    sqlx::query("DELETE FROM sync_outbox")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query(EPOCH_SCOPED_META)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    meta_set(&mut *tx, "epoch", new_epoch).await?;
    // 還原的備份若早於「加入同步」那一刻，這顆 DB 裡沒有 joined／salt／root——
    // 鑰匙圈還在（它不在 DB 裡），所以照樣接得回去（v1.1.2 的 Reenable 分支退場）。
    meta_set(&mut *tx, "joined", "1").await?;
    if let Some(s) = creds.salt_b64.as_deref().filter(|s| !s.is_empty()) {
        meta_set(&mut *tx, "salt", s).await?;
    }
    meta_set(&mut *tx, "root", root).await?;
    meta_set(&mut *tx, "device_id", device_id).await?;
    // 產品評審 B2：**總開關一定要打開**。還原到「同步關著那段期間拍的備份」（或加入同步之前拍的）
    // 會把 `enabled='0'` 一起還原回來 ⇒ 這台不推、別台卻已經看到新紀元 ⇒ 別台「改用那份」之後
    // 拉到 0 顆物件＝**手機整個變空**，而這台的 toast 還寫著「正把整份資料重新上傳」。
    // 邏輯與總開關的語義一致：關的是日常節奏，不是主人剛按下的這個一次性決定。
    meta_set(&mut *tx, "enabled", "1").await?;
    // 工程評審 S-6 的對稱面：身分是鑰匙圈的，備份裡的格子可能掛著**別台**的 device_id
    //（換電腦還原舊機備份）。不改的話 seen 判定會把自己寫的格子當成別台寫的、多記競合。
    sqlx::query("UPDATE sync_cells SET device_id = ? WHERE device_id = ?")
        .bind(device_id)
        .bind(old_device_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    // **cells 不清**（契約 §6）：它們帶著備份時刻的原始戳記，正是快照要用的時間
    let stamped = stamp_missing_cells(&mut tx, device_id).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(stamped)
}

// ─────────────────────────────────────────────────────────────
// v1.1.4 掃地工與鑰匙輪替（WP-A 填；契約 §5）——本段只有簽名、型別與標記檔的讀寫
// ─────────────────────────────────────────────────────────────

/// 掃地工的預設保留數（契約 §5.6）：目前紀元＋前一個；輪替用 1（只留 E2）
pub const SWEEP_KEEP_DEFAULT: usize = 2;

/// v1.1.4（契約 §5.6）：刪掉 `<root>/` 底下「數字小於 `my_epoch`、且不在最近 `keep` 個」的紀元目錄（整顆目錄逐鍵刪）。
///
/// 呼叫點：`pull_inner` 拉成功且 phase=running 之後（每個進程一次，`Runtime.swept_epoch`）；輪替步驟 6（`keep=1`）。
/// 鐵則：刪之前先 `list_after` 把鍵列齊、逐顆 `delete`、log **只印鍵名**；只刪自己 `root` 底下的鍵；
/// 呼叫端已過 `guard_sandbox_root`。回刪掉的紀元數。
///
/// 三道自保（刪除碼的鐵則；`guard_sandbox_root` 在呼叫端，這裡是第二道）：
///   ① `my_epoch` 不是數字 ⇒ 一顆都不刪（保守：算不出「小於我」就不該動手）。
///   ② 只看 `list_epochs` 認得的**數字**目錄 ⇒ `snapshots/`、`SALT`、`KEY` 與任何非數字前綴天然不在名單裡。
///   ③ 每一把要刪的鍵都必須以 `<root>/<e>/` 開頭（`list_after` 理論上保證，但刪除不留退路，值得再確認一次）。
pub(crate) async fn sweep_old_epochs(
    client: &R2Client,
    root: &str,
    my_epoch: &str,
    keep: usize,
) -> Result<u64, String> {
    let Ok(mine) = my_epoch.parse::<u64>() else {
        return Ok(0);
    };
    let epochs = list_epochs(client, root).await?; // 由大到小
    let victims = sweep_victims(&epochs, mine, keep);
    let mut deleted = 0u64;
    for e in victims {
        let prefix = format!("{root}/{e}/");
        // 先列齊再逐顆刪（鐵則：log 只印鍵名）
        let keys = client.list_after(&prefix, "").await?;
        let mut any = false;
        for k in keys {
            if !k.starts_with(&prefix) {
                // 不可能發生；真的發生就跳過，絕不刪自己 root 以外的東西
                eprintln!("[sync:sweep] skip out-of-root {k}");
                continue;
            }
            eprintln!("[sync:sweep] delete {k}");
            client.delete(&k).await?;
            any = true;
        }
        if any {
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// 掃地工的「該刪哪幾個紀元」純函式（單測直接餵清單，不必打網路）。
///
/// `epochs` 由大到小、`mine`＝目前紀元、`keep`＝最近幾個一律保護。回要刪的紀元（由大到小）。
/// 規則：**前 `keep` 個保護** ∧ `< mine` ——所以「比我大的別台新紀元」與「我自己」永遠不刪。
pub(crate) fn sweep_victims(epochs: &[u64], mine: u64, keep: usize) -> Vec<u64> {
    epochs
        .iter()
        .copied()
        .enumerate()
        .filter(|(i, e)| *i >= keep && *e < mine)
        .map(|(_, e)| e)
        .collect()
}

/// 換鑰匙的階段（契約 §5 狀態表；標記檔 `sync/rotation-pending` 的 `stage`）。
/// 提交點＝`committed`：之前斷掉一律**回滾**（新密語沒存下來、續不了），之後斷掉一律**續跑**（4–7 冪等）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RotationStage {
    /// 步驟 1 完成：K2 已存鑰匙圈 `data_key_next_b64`、標記檔已寫
    Prepared,
    /// 步驟 2 完成：`<root>/E2/ROTATED`＋`<root>/E2/EPOCH.bin` 都寫上去了（鎖到手）
    Locked,
    /// **步驟 3 進行中**（v1.1.4 修正席／工程評審 B-3）：KEY 的位元組已經封好、指紋已經寫進標記，
    /// 但那一發 PUT 的結果還不知道。續跑時 GET 回來比指紋：一樣 ⇒ 當成 `Committed` 往下走；
    /// 不一樣或不存在 ⇒ 回滾。**沒有這一階段的話**「PUT 成功、標記沒寫成」就會被判成
    /// 「提交點之前」而回滾——鑰匙圈的 K2 被丟掉，桶裡的 KEY 卻已經是 K2，K2 於是從世上消失。
    Committing,
    /// 步驟 3 完成：`<root>/KEY`＝K2 用新密語包（**提交點**）
    Committed,
    /// 步驟 4 完成：本機已切到 E2／K2、全量快照已推上去
    Switched,
    /// 步驟 5 完成：`snapshots/` 全部 K2 拆得開
    Reencrypted,
    /// 步驟 6 完成：`<root>/` 底下只剩 E2 一個數字紀元
    Swept,
}

impl RotationStage {
    pub fn as_str(self) -> &'static str {
        match self {
            RotationStage::Prepared => "prepared",
            RotationStage::Locked => "locked",
            RotationStage::Committing => "committing",
            RotationStage::Committed => "committed",
            RotationStage::Switched => "switched",
            RotationStage::Reencrypted => "reencrypted",
            RotationStage::Swept => "swept",
        }
    }
    /// 階段的序（續跑時「做完第 n 步了沒」全部用它比，不用 match 疊 match）。
    /// `Committed` 是**提交點**：`rank < rank(Committed)` ⇒ 回滾，`>=` ⇒ 續跑。
    pub fn rank(self) -> u8 {
        match self {
            RotationStage::Prepared => 1,
            RotationStage::Locked => 2,
            RotationStage::Committing => 3,
            RotationStage::Committed => 4,
            RotationStage::Switched => 5,
            RotationStage::Reencrypted => 6,
            RotationStage::Swept => 7,
        }
    }
    /// 提交點之前＝新密語還沒存進桶裡，續跑也拆不開 ⇒ 只能回滾（契約 §5.4）。
    /// `Committing` **不算**在內：它要先用指紋去問桶裡那顆 KEY 才知道該回滾還是該續跑（工程評審 B-3）。
    pub fn before_commit(self) -> bool {
        self.rank() < RotationStage::Committing.rank()
    }
}

/// 標記檔 `app_data_dir/sync/rotation-pending` 的內容（契約 §5.3）。**用檔不用 sync_meta**：步驟 4 會清紀元範圍 meta、
/// 步驟 6 之後也可能還原——app 資料目錄不會跟著回到過去。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotationMarker {
    /// UTC ISO：開始換鑰匙的時刻
    pub at: String,
    /// 舊紀元（E1；步驟 6 要刪它）
    pub old_epoch: String,
    /// 新紀元（E2＝桶裡最大數字紀元＋1，**不是** now_ms——兩台同時換鑰匙才會撞同一把鎖）
    pub new_epoch: String,
    pub stage: RotationStage,
    /// v1.1.4 修正席（工程評審 B-3）：`stage=committing` 時，那一發要 PUT 的 `<root>/KEY` 位元組（base64）。
    /// 續跑時 GET 回來逐位元組比對——**這是唯一不需要新密語就做得出的判準**（沒有密語就拆不開 KEY，
    /// 也就無從得知桶裡那顆是不是自己寫的）。舊版標記沒有這一欄 ⇒ `serde(default)` ⇒ None ⇒ 保守回滾。
    ///
    /// 不是祕密：一模一樣的位元組下一秒就要公開放進桶裡，而且它是「K2 被新密語 argon2id 包起來」的結果。
    /// 步驟 7 清標記時一起消失。
    #[serde(default)]
    pub key_object_b64: Option<String>,
}

fn rotation_marker_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "找不到 app 資料目錄。".to_string())?
        .join("sync")
        .join("rotation-pending"))
}

/// 讀換鑰匙標記：None＝沒有在換
pub(crate) fn rotation_marker(app: &AppHandle) -> Option<RotationMarker> {
    let p = rotation_marker_path(app).ok()?;
    let text = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str::<RotationMarker>(text.trim()).ok()
}

/// v1.1.4 修正席（工程評審 B-4）：**換鑰匙沒做完之前，任何會動到鑰匙圈／紀元／整顆庫的入口都要停手。**
///
/// 提交點之後（stage ≥ committed）K2 只存在於這台的鑰匙圈 `data_key_next_b64` 裡，而桶裡的 KEY 已經是 K2。
/// 這時主人若不耐煩按下「重新加入」（`reset_local` 清整個鑰匙圈）、「加入同步」（`join` 寫 `data_key_next_b64: None`）
/// 或雲端還原（`cloud_restore` 用 K1 灌庫再重啟、boot 先開一個 K1 的新紀元），K2 就消失或紀元被切亂
/// ——輪替續跑再也接不回去。擋住幾秒鐘，比救不回來好。
///
/// 呼叫點：`join`／`reset_local`／`adopt_epoch`／`restore_choice`／`snapshot::upload`／`snapshot::cloud_restore`。
/// **不含** `rotate_data_key`／`finish_rotation`（它們就是那條路本身；前者另有「已經有一場」的守門）。
pub(crate) fn guard_not_rotating(app: &AppHandle) -> Result<(), String> {
    if rotation_marker(app).is_some() {
        return Err("換鑰匙還沒做完——請先讓它接著做完（打開 App 稍等一下就好）。".into());
    }
    Ok(())
}

/// 寫換鑰匙標記（每完成一步就改 `stage` 重寫一次；先寫 `.tmp` 再 rename，半個檔會讓 boot 誤判成「沒在換」）
pub(crate) fn write_rotation_marker(app: &AppHandle, marker: &RotationMarker) -> Result<(), String> {
    let p = rotation_marker_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "建立同步目錄失敗。".to_string())?;
    }
    let tmp = p.with_extension("tmp");
    let text = serde_json::to_string(marker).map_err(|_| "寫入換鑰匙標記失敗。".to_string())?;
    std::fs::write(&tmp, text).map_err(|_| "寫入換鑰匙標記失敗。".to_string())?;
    std::fs::rename(&tmp, &p).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        "寫入換鑰匙標記失敗。".to_string()
    })
}

pub(crate) fn clear_rotation_marker(app: &AppHandle) {
    if let Ok(p) = rotation_marker_path(app) {
        let _ = std::fs::remove_file(p);
    }
}

/// `sync_finish_rotation`／`rotate_data_key` 的回傳（契約 §4）
#[derive(Debug, Clone, Serialize)]
pub struct RotationReport {
    /// finished＝七步走完／rolled_back＝提交點之前斷掉、已回滾／none＝沒有在換（boot 空跑）
    pub outcome: RotationOutcome,
    /// 新紀元 E2（rolled_back／none 為 None）
    pub epoch: Option<String>,
    pub reencrypted_snapshots: u64,
    pub deleted_epochs: u64,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RotationOutcome {
    Finished,
    RolledBack,
    None,
}

/// v1.1.4（契約 §5）：真撤銷密語＝換資料鑰匙 K1→K2 開新紀元的七步。`change_passphrase(rotate=true)` 走這裡。
///
/// 前置：鑰匙圈在、phase=running（沒有改正待ち／鍵違い／還原待收尾／另一場輪替）、outbox 已推空、
/// `current` **必填且驗得過**（拆得開 KEY 或舊血統法）、`next` ≥ 8 字。任何前置不過＝Err、本機零改變。
/// 步驟 0.5：先拍一份 manual 雲端快照（K1 封；步驟 5 會重加密）。
///
/// 死鎖判定門檻（契約 §5.5 的「可視為死鎖」）：`ROTATED` 的 `at` 比現在早這麼多小時，
/// 就允許接手那把鎖。沒有這一條，一台在步驟 2 之後永遠不回來的裝置會讓**所有**裝置再也換不了鑰匙。
pub const ROTATION_LOCK_STALE_HOURS: i64 = 24;

pub async fn rotate_data_key(app: &AppHandle, current: &str, next: &str) -> Result<RotationReport, String> {
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    // 與 join／還原收尾同一把：輪替期間絕不能有 push／pull 在飛（它們會用 K1 推進正要被刪的紀元）
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };

    // ── 前置（契約 §5.1；任何一條不過＝Err、本機零改變）──
    let creds = credstore::load(app)?.ok_or_else(|| "這台還沒加入同步。".to_string())?;
    let root = creds.root.clone();
    guard_sandbox_root(app, &root)?;
    let next = next.trim();
    if next.chars().count() < 8 {
        return Err("新密語至少 8 個字。".into());
    }
    let current = current.trim();
    if current.is_empty() {
        // 2026-09-25 主人問「忘了密語怎麼辦」：舊文案指向「重新加入」是錯的（那條路也要密語）。
        // 救援＝先不勾換鑰匙、現密語留白設新密語（鑰匙圈有資料鑰匙），再用新密語回來換鑰匙。
        return Err("要換鑰匙得先打現在的密語。忘了？先把這格勾掉、現密語留白設一個新密語，再用新密語回來勾「換鑰匙」。".into());
    }
    if rotation_marker(app).is_some() {
        // 已經有一場沒做完的（boot 會自己續跑）——再開一場會把 K2 蓋掉、續不回去
        return Err("先處理同步頁上的狀態再換鑰匙。".into());
    }
    if is_restore_pending(app) {
        return Err("先處理同步頁上的狀態再換鑰匙。".into());
    }
    let pool = pool(app).await?;
    let meta = meta_all(&pool).await?;
    if meta.get("joined").map(String::as_str) != Some("1") {
        return Err("這台還沒加入同步。".into());
    }
    let busy_state = |k: &str| meta.get(k).is_some_and(|v| !v.is_empty());
    if busy_state("pending_epoch") || busy_state("locked") || busy_state("join_pending") {
        return Err("先處理同步頁上的狀態再換鑰匙。".into());
    }
    let e1 = meta
        .get("epoch")
        .filter(|e| !e.is_empty())
        .cloned()
        .ok_or_else(|| "同步設定不完整，請重設後重新加入。".to_string())?;
    // outbox 必須是空的：步驟 4 會 `DELETE FROM sync_outbox`，沒推出去的修改會**永遠消失**
    //（換紀元那條路有孤兒 JSON 兜底，這條沒有——因為它不該發生）
    let pending: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sync_outbox")
        .fetch_one(&pool)
        .await
        .map_err(db_err)?
        .try_get("n")
        .map_err(db_err)?;
    if pending > 0 {
        return Err("還有沒送出的修改，先同步完再換鑰匙。".into());
    }

    let k1 = crypto::key_from_b64(&creds.data_key_b64)?;
    let client = client_of(&creds)?;
    let me = creds
        .device_id
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or(ensure_device_id(&pool).await?);

    // 現密語**必驗**：桶裡有 KEY ⇒ 拆得開且等於鑰匙圈那把；沒 KEY（舊血統）⇒ argon2id(密語, SALT) == K1
    let wrong = || "現在的密語不對。".to_string();
    match client.get_opt(&key_object_key(&root)).await? {
        Some(bytes) => match unseal_key_object(&root, current, &bytes).await {
            Ok(k) if k == k1 => {}
            _ => return Err(wrong()),
        },
        None => {
            let salt_b64 = creds
                .salt_b64
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(wrong)?;
            let salt = crypto::b64_decode(salt_b64)?;
            if derive_blocking(current, &salt).await? != k1 {
                return Err(wrong());
            }
        }
    }

    // ── 步驟 0.5：換鑰匙前先拍一份 manual 雲端快照（K1 封；步驟 5 會把它重加密成 K2）──
    // 為什麼一定要：步驟 6 會把 E1 整顆刪掉。這份快照是「輪替做壞了還救得回來」的唯一一條線。
    if let Err(e) = put_cloud_snapshot(
        &pool,
        &client,
        &k1,
        &root,
        &me,
        super::snapshot::SnapshotKind::Safety,
    )
    .await
    {
        return Err(format!("換鑰匙前的雲端備份沒拍成：{e}"));
    }

    // ── 步驟 1：產 K2、存進鑰匙圈的 `data_key_next_b64`、寫標記（`data_key_b64` **仍是 K1**）──
    let k2 = crypto::random_data_key()?;
    // E2＝`max(桶內數字紀元, E1) + 1`（**不是** now_ms）：兩台同時換鑰匙要算出同一個 E2 才會撞同一把鎖
    let e2 = list_epochs(&client, &root)
        .await?
        .first()
        .copied()
        .unwrap_or(0)
        .max(e1.parse::<u64>().unwrap_or(0))
        .saturating_add(1)
        .to_string();
    let mut creds_next = creds.clone();
    creds_next.data_key_next_b64 = Some(crypto::b64_encode(&k2));
    credstore::save(app, &creds_next)?;
    let marker = RotationMarker {
        at: now_iso(),
        old_epoch: e1,
        new_epoch: e2,
        stage: RotationStage::Prepared,
        key_object_b64: None,
    };
    write_rotation_marker(app, &marker)?;

    run_rotation(app, &pool, &st, marker, creds_next, k1, k2, Some(next), &me).await
}

/// v1.1.4（契約 §5）：boot 看到 `status.rotation_stage` 就叫——從標記記錄的階段續跑。
/// `prepared`／`locked` ⇒ 回滾（刪 E2 的 ROTATED／EPOCH.bin、鑰匙圈丟 K2、清標記）；
/// `committed`…`swept` ⇒ 從下一步續到 7。沒有標記 ⇒ `outcome=none`。
pub async fn finish_rotation(app: &AppHandle) -> Result<RotationReport, String> {
    let Some(marker) = rotation_marker(app) else {
        return Ok(RotationReport {
            outcome: RotationOutcome::None,
            epoch: None,
            reencrypted_snapshots: 0,
            deleted_epochs: 0,
            message: "沒有在換鑰匙。".into(),
        });
    };
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    // 鑰匙圈不見了（主人手動清了憑證庫）＝續不了也回滾不了；把標記收掉，不然 phase 永遠卡在「換鑰匙中」。
    //
    // 工程評審 B-4：**這句話要看階段**。提交點之前（K2 還沒進過桶）確實是「密語沒有變」；
    // 提交點之後桶裡的 KEY 已經是新密語包的 K2，而 K2 只存在於剛剛被清掉的那個鑰匙圈裡
    // ——這台再也拆不開自己的資料，唯一的出路是用**新**密語重新加入（桶裡的 KEY 拆得出 K2）。
    // 說成「密語沒有變」會讓主人拿舊密語一直試。
    let Some(creds) = credstore::load(app)? else {
        let after_commit = !marker.stage.before_commit() && marker.stage != RotationStage::Committing;
        clear_rotation_marker(app);
        return Ok(RotationReport {
            outcome: RotationOutcome::RolledBack,
            epoch: None,
            reencrypted_snapshots: 0,
            deleted_epochs: 0,
            message: if after_commit {
                "上次換鑰匙做到一半，這台的同步身分卻被清掉了——新鑰匙找不回來。請改用新密語「重新加入同步」。"
                    .into()
            } else {
                "上次換鑰匙沒做完，已取消；密語沒有變，請再試一次。".into()
            },
        });
    };
    guard_sandbox_root(app, &creds.root)?;
    let pool = pool(app).await?;
    let k1 = crypto::key_from_b64(&creds.data_key_b64)?;
    // 步驟 7 只做了一半（鑰匙圈已搬、標記沒刪）＝ `data_key_next_b64` 是 None 而 `data_key_b64` 已經是 K2。
    // 這時把 K1 也當成 K2：步驟 5 的「K2 拆得開就跳過」會讓重加密整段空跑，6、7 照樣冪等。
    let k2 = match creds.data_key_next_b64.as_deref() {
        Some(b) => crypto::key_from_b64(b)?,
        None => k1,
    };
    let me = creds
        .device_id
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or(ensure_device_id(&pool).await?);
    run_rotation(app, &pool, &st, marker, creds, k1, k2, None, &me).await
}

/// 七步的共用跑者：`rotate_data_key`（從步驟 1 之後開跑）與 `finish_rotation`（從標記的階段續跑）都走這裡。
///
/// `next_passphrase`＝`Some` 只有第一次呼叫才有（步驟 3 要用它包 KEY）。續跑時是 `None`——
/// **提交點之前**沒有新密語就接不下去（新密語沒存在任何地方），所以一律回滾；提交點之後根本不需要它。
#[allow(clippy::too_many_arguments)]
async fn run_rotation(
    app: &AppHandle,
    pool: &Pool<Sqlite>,
    st: &SyncState,
    mut marker: RotationMarker,
    creds: SyncCredentials,
    k1: [u8; crypto::KEY_LEN],
    k2: [u8; crypto::KEY_LEN],
    next_passphrase: Option<&str>,
    me: &str,
) -> Result<RotationReport, String> {
    let root = creds.root.clone();
    let client = client_of(&creds)?;
    let e2 = marker.new_epoch.clone();
    let mut reencrypted = 0u64;
    let mut deleted_epochs = 0u64;

    // 提交點之前、又沒有新密語 ⇒ 回滾（契約 §5.4）
    if marker.stage.before_commit() && next_passphrase.is_none() {
        rollback_rotation(app, &client, &root, me, &e2).await;
        return Ok(RotationReport {
            outcome: RotationOutcome::RolledBack,
            epoch: None,
            reencrypted_snapshots: 0,
            deleted_epochs: 0,
            message: "上次換鑰匙沒做完，已取消；密語沒有變，請再試一次。".into(),
        });
    }

    // ── 步驟 2：`put_if_absent <root>/E2/ROTATED` 當鎖，拿到才寫 EPOCH.bin（K2 封、reason="rotate"）──
    if marker.stage.rank() < RotationStage::Locked.rank() {
        let flag_key = rotated_flag_key(&root, &e2);
        let body = serde_json::json!({ "device_id": me, "at": marker.at }).to_string();
        let won = client.put_if_absent(&flag_key, body.into_bytes()).await?;
        if !won {
            // 已經有旗標：是自己上一趟寫的（重試）⇒ 當作拿到。
            //
            // v1.1.4 修正席（工程評審 S-8）：**別台的旗標在這裡幾乎撞不到**——`list_epochs` 走的是
            // `list_prefixes`，而 `<root>/E2/ROTATED` 這顆鍵本身就讓 E2 成為一個 common prefix，
            // 所以第二台算出來的 E2 一定是 `max+1`＝E2+1，兩台不會撞同一把鎖。真正撞得到的只有
            // 「兩台都在對方寫旗標之前 list 完」的毫秒級競態——那時對方的 `at` 必定新鮮，一律讓它。
            // 「死在提交點之後、那台永遠不回來」造成的死鎖不是靠這裡解，而是 `join` 的守門放行接手（見那裡）。
            let existing = client.get_opt(&flag_key).await?.map(|b| parse_rotated_flag(&b));
            let mine = existing.as_ref().is_some_and(|f| f.device_id == me);
            if !mine {
                rollback_rotation(app, &client, &root, me, &e2).await;
                return Err("另一台正在換鑰匙，請稍後再試。".into());
            }
        }
        // 提交點之前的任何失敗都要回滾（工程評審 B-3 後半）：讓「回了 Err」永遠等於「已經清乾淨」，
        // 不必倚賴「下次開機會補回滾」——主人可能當場就再按一次。
        if let Err(e) = put_epoch_marker(&client, &k2, &root, &e2, me, "rotate", None).await {
            rollback_rotation(app, &client, &root, me, &e2).await;
            return Err(e);
        }
        marker.stage = RotationStage::Locked;
        if let Err(e) = write_rotation_marker(app, &marker) {
            rollback_rotation(app, &client, &root, me, &e2).await;
            return Err(e);
        }
    }

    // ── 步驟 3：PUT `<root>/KEY`＝K2 用**新密語**包。**提交點**（這之後不可逆）──
    //
    // v1.1.4 修正席（工程評審 B-3）：順序是「先寫 `committing`＋指紋 → PUT → 再寫 `committed`」。
    // 舊順序（PUT → 寫標記）在「PUT 成功、寫標記失敗／中間斷電」時會留下一個 `locked` 的標記，
    // 下次啟動判成「提交點之前」⇒ 回滾 ⇒ 鑰匙圈丟掉 K2，而桶裡的 KEY 已經是 K2 包的——
    // K2 於是在世上任何地方都不存在了（新裝置用新密語加入會拆出 K2 卻找不到任何拆得開的紀元）。
    if marker.stage.rank() < RotationStage::Committing.rank() {
        let Some(next) = next_passphrase else {
            // 理論上走不到（上面已經擋過）；保守回滾勝過留下半套
            rollback_rotation(app, &client, &root, me, &e2).await;
            return Err("換鑰匙沒有完成，已取消；請再試一次。".into());
        };
        let (obj, bytes) = wrapped_key_bytes(&root, next, &k2).await?;
        marker.stage = RotationStage::Committing;
        marker.key_object_b64 = Some(crypto::b64_encode(&bytes));
        // 指紋寫不下去就不要 PUT：寧可停在「什麼都沒做」，也不要 PUT 完之後沒有任何憑據判斷
        if let Err(e) = write_rotation_marker(app, &marker) {
            rollback_rotation(app, &client, &root, me, &e2).await;
            return Err(e);
        }
        if let Err(e) = client.put(&obj, bytes).await {
            // S-10：PUT 的回應掉了但其實寫成功了。用新密語重 GET 試拆，拆得出 K2 就當成功。
            let recovered = match client.get_opt(&obj).await {
                Ok(Some(b)) => matches!(unseal_key_object(&root, next, &b).await, Ok(k) if k == k2),
                _ => false,
            };
            if !recovered {
                rollback_rotation(app, &client, &root, me, &e2).await;
                return Err(e);
            }
        }
        marker.stage = RotationStage::Committed;
        marker.key_object_b64 = None;
        write_rotation_marker(app, &marker)?;
    } else if marker.stage == RotationStage::Committing {
        // 續跑：上一趟死在「指紋已寫、PUT 生死未卜」。**不需要新密語**就判得出來——
        // 桶裡那顆 KEY 與指紋逐位元組相同 ⇒ 那一發 PUT 成功過 ⇒ 已經提交，往下續跑；
        // 不同（別台改過密語）或不存在 ⇒ 沒提交 ⇒ 回滾（K2 沒進過桶，丟掉它是安全的）。
        let committed = match (&marker.key_object_b64, client.get_opt(&key_object_key(&root)).await) {
            (Some(fp), Ok(Some(bytes))) => crypto::b64_encode(&bytes) == *fp,
            _ => false,
        };
        if !committed {
            rollback_rotation(app, &client, &root, me, &e2).await;
            return Ok(RotationReport {
                outcome: RotationOutcome::RolledBack,
                epoch: None,
                reencrypted_snapshots: 0,
                deleted_epochs: 0,
                message: "上次換鑰匙沒做完，已取消；密語沒有變，請再試一次。".into(),
            });
        }
        marker.stage = RotationStage::Committed;
        marker.key_object_b64 = None;
        write_rotation_marker(app, &marker)?;
    }

    // ── 步驟 4：本機切到 E2／K2 → 全量快照進 outbox → 用 K2 推到 E2 推空 ──
    if marker.stage.rank() < RotationStage::Switched.rank() {
        let meta = meta_all(pool).await?;
        let done = meta.get("epoch").map(String::as_str) == Some(e2.as_str())
            && sqlx::query("SELECT COUNT(*) AS n FROM sync_outbox")
                .fetch_one(pool)
                .await
                .map_err(db_err)?
                .try_get::<i64, _>("n")
                .map_err(db_err)?
                == 0;
        if !done {
            switch_epoch_local(
                pool,
                &creds,
                me,
                meta.get("device_id").map(String::as_str).unwrap_or(""),
                &e2,
            )
            .await?;
            snapshot_into_outbox(pool, me).await?;
            push_loop(pool, &client, &k2, &root, &e2, me).await?;
        }
        marker.stage = RotationStage::Switched;
        write_rotation_marker(app, &marker)?;
        // 紀元換了：桶內標記的進程旗標要重對一次（工程評審 S-9 的同一個理由）
        st.clear_bucket_meta_done();
    }

    // ── 步驟 5：重加密 `snapshots/`（K2 拆得開的跳過＝冪等）──
    if marker.stage.rank() < RotationStage::Reencrypted.rank() {
        reencrypted = super::snapshot::reencrypt_all(&client, &root, &k1, &k2).await?;
        marker.stage = RotationStage::Reencrypted;
        write_rotation_marker(app, &marker)?;
    }

    // ── 步驟 6：刪掉 `<root>/` 底下所有 ≠E2 的數字紀元（含 E1）──
    if marker.stage.rank() < RotationStage::Swept.rank() {
        deleted_epochs = sweep_old_epochs(&client, &root, &e2, 1).await?;
        marker.stage = RotationStage::Swept;
        write_rotation_marker(app, &marker)?;
    }

    // ── 步驟 7：鑰匙圈 K2 上位、清標記 ──
    let mut done = creds.clone();
    if done.data_key_next_b64.is_some() {
        done.data_key_b64 = crypto::b64_encode(&k2);
        done.data_key_next_b64 = None;
        credstore::save(app, &done)?;
    }
    meta_set(pool, "key_sealed", "1").await?;
    clear_error(pool).await?;
    clear_rotation_marker(app);
    st.set_gate(None);

    Ok(RotationReport {
        outcome: RotationOutcome::Finished,
        epoch: Some(e2),
        reencrypted_snapshots: reencrypted,
        deleted_epochs,
        message: format!(
            "密語已更改，資料鑰匙也換新了——其他裝置要用新密語重新加入。重加密 {reencrypted} 顆雲端快照、清掉 {deleted_epochs} 個舊紀元。"
        ),
    })
}

/// 回滾（契約 §5.4）：只刪**自己寫的**那兩顆物件，鑰匙圈丟掉 K2，標記清掉。密語沒有變。
///
/// 為什麼判 device_id 才刪：E2 這個號碼兩台會算出同一個，旗標若是別台的，刪掉就等於把它的鎖撬開。
/// 旗標是空物件／壞 JSON（拍板原本的「空物件」寫法）時 `device_id` 是空字串 ⇒ 不是自己的 ⇒ 不刪。
async fn rollback_rotation(app: &AppHandle, client: &R2Client, root: &str, me: &str, e2: &str) {
    let flag_key = rotated_flag_key(root, e2);
    let mine = match client.get_opt(&flag_key).await {
        Ok(Some(b)) => parse_rotated_flag(&b).device_id == me,
        _ => false,
    };
    if mine {
        for k in [epoch_marker_key(root, e2), flag_key] {
            eprintln!("[sync:rotate] rollback delete {k}");
            let _ = client.delete(&k).await;
        }
    }
    if let Ok(Some(mut creds)) = credstore::load(app) {
        if creds.data_key_next_b64.is_some() {
            creds.data_key_next_b64 = None;
            let _ = credstore::save(app, &creds);
        }
    }
    clear_rotation_marker(app);
}

/// v1.1.4 修正席（產品評審 B1）：**用新密語重新加入**——四欄沿用鑰匙圈裡現成的那組，只問密語。
///
/// 為什麼要有這一支：別台勾了「同時換掉資料鑰匙」之後，這台進「鍵違い」，狀態列叫主人
/// 「用新密語『重新加入同步』」。但畫面上那顆「重新加入同步」按下去是 `reset_local`——它連身分與
/// 憑證一起清掉，於是表單四欄空白，主人得回桌機開配對碼重掃一次；而旁邊那顆「更新憑證…」的表單
/// 又寫著「密語打**現在這一句**……資料、身分與紀元都不會動」，照字打舊密語只會得到「密語不對」。
/// 文案指的路與畫面給的鈕互相打架——這是 v1.1.4 要挑掉的那個矛盾。
///
/// 實際做的事**就是既有的 `join`**（不新增第三條規則、不新增狀態）：憑證從鑰匙圈原樣拿出來，
/// 密語換成主人剛打的新的。`join` 的 ④ 會發現「拆得開但不是我那把＋有 ROTATED 旗標」而跳過重接，
/// 落到 ⑤ 解 KEY 得 K2 → ⑥ 找到 E2 → 兩邊有料 → 回 `needs_choice` → 主人選「兩邊都保留」
/// ⇒ merged（這台還沒送出的修改靠格子的原始時間戳併回去）。**身分也不必換**（鑰匙圈還在）。
///
/// 沒有鑰匙圈（真的沒加入過）＝這支沒有意義，Err 請主人走正常的「加入同步」。
pub async fn rejoin(app: &AppHandle, passphrase: &str, mode: Option<JoinMode>) -> Result<JoinReport, String> {
    let creds = credstore::load(app)?
        .ok_or_else(|| "這台還沒加入同步——請用下面的「加入同步」填四欄。".to_string())?;
    join(
        app,
        JoinArgs {
            endpoint: creds.endpoint,
            bucket: creds.bucket,
            access_key_id: creds.access_key_id,
            secret_access_key: creds.secret_access_key,
            passphrase: passphrase.trim().to_string(),
            root: Some(creds.root),
            mode,
        },
    )
    .await
}

/// 單一入口「加入同步」（契約 §4.2 的九步）。
///
/// 為什麼要單一入口（評審 B3）：v1.1.2 有「開始同步（正本）」與「配對並拉取（副本）」兩個口，
/// 於是第二台桌機手填四欄會產生不同的鹽（兩台互相看不見）、換 R2 token 會開新紀元（手機失聯）、
/// 同機重裝要主人自己判斷該按哪一個。改成一個口，剩下的由**桶裡有什麼**決定：
///   空＝第一台／這台空＝直接拉／兩邊有料＝問一次／紀元＋鹽一致＝重接（只換憑證，不問）。
///
/// 「存 credstore」之前的任何失敗都保證**本機零改變**（可以直接重按）。
pub async fn join(app: &AppHandle, args: JoinArgs) -> Result<JoinReport, String> {
    // 工程評審 B-4：`save_creds` 寫死 `data_key_next_b64: None`——換鑰匙沒做完時走這條會把 K2 抹掉
    guard_not_rotating(app)?;
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    // 評審 S3：加入／重設期間不能有 push／pull 在飛，否則那趟的交易會把游標寫回剛清掉的 sync_meta
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    let pool = pool(app).await?;

    // ① 四欄＋密語
    let endpoint = args.endpoint.trim().to_string();
    let bucket = args.bucket.trim().to_string();
    let access_key_id = args.access_key_id.trim().to_string();
    let secret_access_key = args.secret_access_key.trim().to_string();
    if endpoint.is_empty() || bucket.is_empty() || access_key_id.is_empty() || secret_access_key.is_empty()
    {
        return Err("雲端置物櫃的四個欄位都要填。".into());
    }
    let passphrase = args.passphrase.trim().to_string();
    if passphrase.is_empty() {
        return Err("密語不能是空的。".into());
    }
    let root = args
        .root
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .unwrap_or(credstore::DEFAULT_ROOT)
        .trim_end_matches('/')
        .to_string();
    // 工程評審 N-1：根前綴限一段、限安全字元。DEV 表單本來填得進 `v1/1789827441815`——
    // 那會把這台的物件直接寫進主人正本的紀元目錄裡。
    if !root
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err("桶內根前綴只能用英數字與 . _ -（不能有斜線）。".into());
    }
    // 工程評審 B-3 的圍籬：沙盒／開發建置**不准**用正本的根。09-21 桶裡那顆壞掉的 `v1/KEY`
    // 就是少了這一行——沙盒 exe 沿用預設 `v1`，把自己的鑰匙物件寫進主人的根目錄。
    guard_sandbox_root(app, &root)?;

    // ② 憑證能不能用（一次 list，Class B）
    let client = R2Client::new(R2Config {
        endpoint: endpoint.clone(),
        bucket: bucket.clone(),
        access_key_id: access_key_id.clone(),
        secret_access_key: secret_access_key.clone(),
    })?;
    client.probe(&format!("{root}/")).await?;

    // ③ 先列桶
    let remote_salt = client
        .get_opt(&salt_object_key(&root))
        .await?
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty());
    let key_object = client.get_opt(&key_object_key(&root)).await?;
    let epochs = list_epochs(&client, &root).await?;

    let meta = meta_all(&pool).await?;
    // 工程評審 B-1：讀取失敗**不准**折成「沒有鑰匙圈」。折了就會現生一個新身分、把這台當新的一台
    //（雲端多一個裝置目錄、seen／游標全部重來、整包資料再推一次）——正是這一輪禁止的事。
    let existing = match credstore::load(app) {
        Ok(v) => v,
        Err(e) => return Err(format!("{e}讀不到這台的同步身分，先不加入——請重新啟動後再試。")),
    };
    // 身分＝鑰匙圈（契約 §3.1）：沒有就現生一個。複製整個資料夾＝鑰匙圈沒跟著＝新的一台。
    //
    // `sync_meta.device_id` 只在**鑰匙圈本來就在**（v1.1.2 的舊 JSON 沒有 device_id 這一欄）時才拿來用
    // ——那是契約 §7 ② 的遷移路徑，主人升級不該換身分。**沒有鑰匙圈就不准搬**：整合席沙盒壬4 實測到，
    // 複製整個資料夾時 `sync_meta.device_id` 會跟著過來，沿用它會讓兩台共用同一個身分＝共用雲端同一個
    // 裝置目錄——兩邊各自算各自的 `last_object_stamp`，同一毫秒就會推出同名物件互相覆蓋（靜默掉資料），
    // 而且 `seen:`／`last_pull_key:` 兩把 per-device 鍵也會被當成同一台而互相誤判。
    // 新身分存進鑰匙圈之後，下一趟 `status()` 會把快取換掉並順手把舊格子改成新身分（見該處註解）。
    let device_id = existing
        .as_ref()
        .and_then(|c| c.device_id.clone())
        .filter(|d| !d.is_empty())
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|_| meta.get("device_id").filter(|d| !d.is_empty()).cloned())
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let local_alive = local_alive_count(&pool).await?;

    let save_creds = |data_key: &[u8; crypto::KEY_LEN], salt_b64: &str| -> Result<(), String> {
        credstore::save(
            app,
            &SyncCredentials {
                endpoint: endpoint.clone(),
                bucket: bucket.clone(),
                access_key_id: access_key_id.clone(),
                secret_access_key: secret_access_key.clone(),
                root: root.clone(),
                data_key_b64: crypto::b64_encode(data_key),
                salt_b64: Some(salt_b64.to_string()),
                device_id: Some(device_id.clone()),
                // v1.1.4：加入／重接時不可能在換鑰匙（前置擋掉），K2 一律空
                data_key_next_b64: None,
            },
        )
    };

    // ④ 重接（在任何本機改動之前）：鑰匙圈的血統與桶裡一致、而且這台真的加入過（有 joined＋epoch）
    //    ⇒ 同一份資料，只是換了 token／重裝／重填四欄。只更新憑證，**不問、不動資料**。
    let joined_before = meta.get("joined").map(String::as_str) == Some("1")
        && meta.get("epoch").is_some_and(|e| !e.is_empty());
    if joined_before {
        if let (Some(c), Some(theirs)) = (existing.as_ref(), remote_salt.as_deref()) {
            let mine = c.salt_b64.as_deref().filter(|s| !s.is_empty());
            if mine == Some(theirs) && !c.data_key_b64.is_empty() {
                let stored = crypto::key_from_b64(&c.data_key_b64)?;
                let data_key = match key_object.as_deref() {
                    Some(bytes) => match unseal_key_object(&root, &passphrase, bytes).await {
                        // 工程評審 S-1：拆得開還不夠，**拆出來的要與鑰匙圈裡那把一樣**。
                        // 不比對的話，桶裡若有一顆包著別把鑰匙的 KEY（09-21 就有），
                        // 用那顆的密語重接會把這台的資料鑰匙覆蓋成錯的、自己的舊物件從此拆不開。
                        Ok(k) if k == stored => Some(k),
                        Ok(_) => {
                            // v1.1.4（整合席沙盒 癸5 抓到）：拆出來的不是鑰匙圈那把，還有**第二種**成因——
                            // 別台勾了「同時換掉資料鑰匙」，桶裡的 KEY 已經是 K2、這台鑰匙圈裡還是 K1。
                            // 那不是「鑰匙壞了」而是「鑰匙換了」，出路正是 `describeLocked(rotated)` 叫主人做的
                            // 「用新密語重新加入同步」。S-1 那句 Err 會把這條唯一的出路整個擋死，
                            // 所以看到任何紀元帶著 `ROTATED` 旗標時就跳過重接分支，落到 ⑤ 走正規 join
                            //（紀元不一致 → 解 KEY 得 K2 → 找到 E2 → 兩邊有料 → 二選一 → merged）。
                            // 沒有旗標＝真的是壞掉的 KEY，維持原本的 Err。
                            // v1.1.4 修正席（工程評審 B-2）：掃描換成共用的 `rotated_elsewhere`
                            //（「比我新 ∧ 有旗標 ∧ 我拆不開」三條），與下面 `Err(_)` 那半用同一把尺。
                            if rotated_elsewhere(&client, &root, &stored, meta.get("epoch").map(String::as_str))
                                .await?
                                .is_none()
                            {
                                return Err(
                                    "雲端上那顆鑰匙與這台的資料對不起來——請到〈密語〉頁重新設一次密語（現密語可留白）。"
                                        .into(),
                                );
                            }
                            None
                        }
                        // 工程評審 B-3 自癒：拆不開、但舊血統法 `argon2id(密語, SALT)` 等於鑰匙圈那把
                        // ⇒ 這顆 KEY 必定是別人寫壞的（同一個 SALT 不可能包出不同資料鑰匙）⇒ 重封蓋掉。
                        Err(_) => {
                            // v1.1.4 修正席（工程評審 B-2）：**舊血統桶**（主人正本就是這種）踩得到的死路——
                            // 別台換過鑰匙之後，這台照著鍵違い文案來「重新加入」卻打了**舊**密語：
                            // K2 包的 KEY 拆不開 ⇒ 落到這個自癒分支 ⇒ `argon2id(舊密語, SALT) == K1` 成立
                            // ⇒ 把 KEY 蓋回 K1、還回一句「憑證已更新，資料照舊」。K2 就這樣沒了（同 B-1 的後果）。
                            // 所以自癒之前先問一次「是不是別台換過鑰匙」——是的話這只是打錯密語。
                            if rotated_elsewhere(&client, &root, &stored, meta.get("epoch").map(String::as_str))
                                .await?
                                .is_some()
                            {
                                return Err("密語不對（這份資料已在另一台換過鑰匙，請改用新密語）。".into());
                            }
                            let salt = crypto::b64_decode(theirs)?;
                            let derived = derive_blocking(&passphrase, &salt).await?;
                            if derived != stored {
                                return Err("密語不對。".into());
                            }
                            seal_key_object(&client, &root, &passphrase, &derived).await?;
                            Some(derived)
                        }
                    },
                    None => {
                        // 舊血統：資料鑰匙本身＝argon2id(密語, SALT)
                        let salt = crypto::b64_decode(theirs)?;
                        let derived = derive_blocking(&passphrase, &salt).await?;
                        if derived != stored {
                            return Err("密語不對。".into());
                        }
                        // 順手封 KEY（遷移 §7 ⑤）——之後改密語就不必再走舊血統法。
                        // 自動封存用條件寫（工程評審 S-3(b)）
                        seal_key_object_if_absent(&client, &root, &passphrase, &derived).await?;
                        Some(derived)
                    }
                };
                // None＝「別台換過鑰匙」，重接不適用：什麼都不寫，落到 ⑤ 走正規 join
                if let Some(data_key) = data_key {
                    save_creds(&data_key, theirs)?;
                    meta_set(&pool, "root", &root).await?;
                    meta_set(&pool, "salt", theirs).await?;
                    meta_set(&pool, "key_sealed", "1").await?;
                    meta_set(&pool, "last_error", "").await?;
                    st.set_gate(None);
                    st.clear_bucket_meta_done(); // 工程評審 S-9
                    drop(_busy);
                    // 工程評審 B-2：上一次加入在「存鑰匙圈之後、快照之前」斷掉時會留下 `join_pending`。
                    // 重接分支不補做（它刻意不動資料），但也**不能把旗標吃掉**——下一趟 push 會先補一次
                    // 完整拉取＋補戳＋快照。文案照實講，免得主人以為已經結束了。
                    let pending_snapshot = meta.get("join_pending").is_some_and(|v| !v.is_empty());
                    return Ok(JoinReport {
                        outcome: JoinOutcome::Reconnected,
                        local_alive,
                        remote_epoch: meta.get("epoch").cloned(),
                        remote_devices: 0,
                        snapshot_ops: 0,
                        pull: None,
                        export_path: None,
                        message: if pending_snapshot {
                            "憑證已更新——上次加入沒做完的那一半會在下一趟同步補上。".into()
                        } else {
                            "憑證已更新，資料照舊。".into()
                        },
                    });
                }
            }
        }
    }

    // ⑤ 解出資料鑰匙（兩層鑰匙，契約 §2.1）
    let cloud_empty = remote_salt.is_none() && epochs.is_empty();
    let wrong_pass = || "密語不對（與雲端那份資料的密語不同）。".to_string();
    let (data_key, salt_b64, need_put_salt, need_seal_key) = if cloud_empty {
        // 第一台：資料鑰匙隨機產（不由密語決定），密語只負責把它包成 KEY
        (
            crypto::random_data_key()?,
            crypto::b64_encode(&crypto::random_salt()?),
            true,
            true,
        )
    } else {
        match key_object.as_deref() {
            Some(bytes) => {
                let dk = unseal_key_object(&root, &passphrase, bytes)
                    .await
                    .map_err(|_| wrong_pass())?;
                // 工程評審 S-2：SALT 理論上一定在（KEY 是 v1.1.3 才有的物件）。缺了**不准自造一顆**——
                // 自造的鹽與別台鑰匙圈裡的不同，它們下一趟 `ensure_bucket_meta` 會全部 `locked='salt'`，
                // 一個「補救」把所有裝置鎖死。正解是讓任何已加入的裝置連一次線（它們會把自己的鹽補回去）。
                let Some(salt) = remote_salt.clone() else {
                    return Err(
                        "雲端上這份資料的鹽不見了——請先讓任何一台已加入的裝置連一次線（它會自動補回去），再用這台加入。"
                            .into(),
                    );
                };
                (dk, salt, false, false)
            }
            None => {
                // 舊血統（v1.1.2 的桶）：資料鑰匙＝argon2id(密語, SALT)
                let Some(salt_b64) = remote_salt.clone() else {
                    return Err(
                        "雲端上找不到這份資料的鹽——請先讓已加入的裝置連一次線（它會把鹽補上去），再用這台加入。"
                            .into(),
                    );
                };
                // 工程評審 N-11：只有 SALT、沒有 KEY、**一個紀元都沒有**＝沒有任何既有物件要拆
                //（多半是殘留的孤兒 SALT）。這時若照舊血統法派生，等於把新資料倒退回「單層鑰匙」
                // ——密語一旦外流，桶裡明文的 SALT 就能再推出資料鑰匙。沒有舊資料要相容，就用隨機的。
                if epochs.is_empty() {
                    (crypto::random_data_key()?, salt_b64, false, true)
                } else {
                    let salt = crypto::b64_decode(&salt_b64)?;
                    let dk = derive_blocking(&passphrase, &salt).await?;
                    (dk, salt_b64, false, true)
                }
            }
        }
    };

    // ⑥ 目前紀元＝由大到小第一個拆得開的（§4.2 步驟 7）。拆不開任何一個＝這把鑰匙在這桶裡沒有資料。
    let current_epoch = if cloud_empty {
        None
    } else {
        let e = resolve_current_epoch(&client, &data_key, &root).await?;
        // 舊血統又一個紀元都拆不開＝密語真的錯了（新血統的 KEY 已經驗過，不必再判）
        if e.is_none() && key_object.is_none() && !epochs.is_empty() {
            return Err(wrong_pass());
        }
        e
    };

    // 這個紀元底下有沒有裝置目錄（§2.3「雲端有資料」）
    let (remote_devices, remote_has_data) = match current_epoch.as_deref() {
        Some(e) => {
            let n = client.list_prefixes(&format!("{root}/{e}/")).await?.len() as u64;
            (n, n > 0)
        }
        None => (0, false),
    };

    // v1.1.4（契約 §5.5 的 join 新守門）：目前紀元有 `ROTATED`、底下卻一個裝置目錄都沒有
    // ＝另一台正卡在輪替的步驟 3～4 之間（KEY 已經是新密語、E2 還沒推東西上去）。
    // 不擋的話這台會判成「雲端沒資料」⇒ 開出**第三個**紀元，把正在換鑰匙那台推進改正待ち，
    // 它下一步的「切到 E2 再推全量」就變成往一個沒人看的目錄推。等它做完（幾秒）再加入就好。
    //
    // v1.1.4 修正席（工程評審 S-8）：守門要有**時效**。那台若死在提交點之後永遠不回來，桶裡就永遠是
    // 「KEY＝K2、E2 沒有任何裝置目錄」——沒有時效的話所有新裝置都會被這句話擋到天荒地老，
    // 而舊裝置（K1）又換不了鑰匙（現密語已經不是 KEY 的密語了）＝整份資料再也加不進新裝置。
    // 旗標的 `at` 超過 `ROTATION_LOCK_STALE_HOURS` ⇒ 這台**接手收尾**：它手上就是 K2，
    // 直接把 E2 當成自己的紀元推上去即可（`opening_new_epoch=false`）。原本那台回來續跑步驟 4 時
    // `switch_epoch_local` 是冪等的，步驟 6 也只刪 < E2，不會打架。
    let mut adopt_stale_rotation = false;
    if let Some(e) = current_epoch.as_deref() {
        if !remote_has_data {
            if let Some(flag) = client.get_opt(&rotated_flag_key(&root, e)).await? {
                let f = parse_rotated_flag(&flag);
                let stale = chrono::DateTime::parse_from_rfc3339(&f.at)
                    .map(|t| {
                        (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_hours()
                            >= ROTATION_LOCK_STALE_HOURS
                    })
                    .unwrap_or(false);
                if !stale {
                    drop(_busy);
                    return Err("另一台正在換鑰匙，請稍後再加入。".into());
                }
                adopt_stale_rotation = true;
            }
        }
    }

    // ⑦ 兩邊都有料而 UI 還沒問 ⇒ 什麼都不寫（密語已驗過，主人按完鈕再呼叫一次）
    if remote_has_data && local_alive > 0 && args.mode.is_none() {
        drop(_busy);
        return Ok(JoinReport {
            outcome: JoinOutcome::NeedsChoice,
            local_alive,
            remote_epoch: current_epoch,
            remote_devices,
            snapshot_ops: 0,
            pull: None,
            export_path: None,
            message: "雲端上已經有一份資料，這台也有資料——請選一種做法。".into(),
        });
    }

    // 工程評審 S-4：「改用另一台的」而雲端其實沒資料 ⇒ 停手。`wipe_local_data` 只看 mode，不看
    // `remote_has_data`——問二選一與按下鈕之間雲端被清掉／換成別的血統，就會把本機清空換來一片空白。
    if args.mode == Some(JoinMode::AdoptRemote) && !remote_has_data {
        drop(_busy);
        return Err("雲端上已經沒有資料可以改用了——請重新按一次「加入同步」重看一次現況。".into());
    }

    // ⑧ 定案：紀元（沿用或新開）與模式
    // 接手死掉的輪替（S-8）＝沿用 E2，不另開紀元（EPOCH.bin 已經是那台用 K2 寫好的）
    let opening_new_epoch = !remote_has_data && !adopt_stale_rotation;
    let epoch = match (&current_epoch, opening_new_epoch) {
        (Some(e), false) => e.clone(),
        _ => {
            // 第一台，或桶裡有血統但沒有資料（紀元全空／全拆不開）⇒ 開一個比既有全部都大的紀元
            let floor = epochs.first().copied().unwrap_or(0).saturating_add(1);
            hlc::now_ms().max(floor).to_string()
        }
    };

    // ⑨ 網路動作先做完（存 credstore 之前失敗＝本機零改變）
    if need_put_salt {
        // 工程評審 S-3：血統標記用**條件寫**。兩台同時當第一台時，輸的那台不會把贏家的鹽蓋掉——
        // 它當場收到人話、重按一次就會走「雲端已經有一份」那條正常路。
        let won = client
            .put_if_absent(&salt_object_key(&root), salt_b64.as_bytes().to_vec())
            .await?;
        if !won {
            drop(_busy);
            return Err(
                "就在剛剛，另一台裝置先把這個置物櫃用起來了——請再按一次「加入同步」（這次會接到那一份）。"
                    .into(),
            );
        }
    }
    if need_seal_key {
        // 舊血統走到這裡＝密語已用「開得了紀元」驗過 ⇒ 順手封 KEY，遷移完成（§7 ⑤b）。
        // 工程評審 S-3(b)：這是**自動**封存（主人沒按「改密語」），所以也用條件寫——
        // 別台剛用新密語改好的 KEY 不該被這台的舊密語蓋回去。寫不進去＝已經有人封好了，直接放行。
        seal_key_object_if_absent(&client, &root, &passphrase, &data_key).await?;
    }
    if opening_new_epoch {
        put_epoch_marker(&client, &data_key, &root, &epoch, &device_id, "first", None).await?;
    }

    // 手機「改用另一台的」：換掉之前先留底（桌機是 TS 先拍 manual 備份）。
    // **v1.1.4（契約 §6）**：留底改成「先拍一份 manual 雲端快照」，用的就是這條路上剛解出來的
    // `data_key`／`root`（鑰匙圈這時還沒存，所以不能走 `keyed_client`）。雲端拍不成才退回 JSON 落檔——
    // 手機的 `download_dir()` 是 app 專屬目錄，主人看不到也帶不走（查證：Android 下載目錄寫入）。
    let mut export_path: Option<String> = None;
    if args.mode == Some(JoinMode::AdoptRemote) && cfg!(mobile) {
        if let Err(e) = put_cloud_snapshot(
            &pool,
            &client,
            &data_key,
            &root,
            &device_id,
            super::snapshot::SnapshotKind::Safety,
        )
        .await
        {
            eprintln!("[sync:join] cloud safety snapshot failed: {e}");
            export_path = Some(export_full_json(app, &pool).await?);
        }
    }
    // 未推出去的 outbox 另存（改用那份時才有意義）
    let orphans = if args.mode == Some(JoinMode::AdoptRemote) {
        export_outbox_orphans(
            app,
            &pool,
            &device_id,
            meta.get("epoch").map(String::as_str).unwrap_or(""),
            &epoch,
        )
        .await?
    } else {
        (0, None)
    };

    // 結局先定下來：⑩ 的交易要據此留 `join_pending`（工程評審 B-2），⑪ 只是照著做
    let outcome = match (args.mode, remote_has_data, local_alive) {
        (Some(JoinMode::AdoptRemote), _, _) => JoinOutcome::Adopted,
        (Some(JoinMode::Merge), _, _) => JoinOutcome::Merged,
        (None, true, _) => JoinOutcome::Pulled,
        _ => JoinOutcome::First,
    };

    // ⑩ 落地：鑰匙圈 → sync_meta → 資料表
    save_creds(&data_key, &salt_b64)?;

    let mut tx = pool.begin().await.map_err(db_err)?;
    sqlx::query("DELETE FROM sync_outbox")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    match args.mode {
        // 改用另一台的：本機資料整批換掉（settings 不動——主題、書封是這台自己的偏好）
        Some(JoinMode::AdoptRemote) => wipe_local_data(&mut tx).await?,
        // 這台是空的：格子清掉，雲端全贏（留著只會讓遠端的值被本機的舊戳擋下來）
        _ if !remote_has_data || local_alive == 0 => {
            if local_alive == 0 && remote_has_data {
                sqlx::query("DELETE FROM sync_cells")
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
            }
        }
        // 兩邊都保留：**格子不清**，它們是原始時間戳的來源（契約 §5.1）
        _ => {}
    }
    sqlx::query(EPOCH_SCOPED_META)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    meta_set(&mut *tx, "joined", "1").await?;
    meta_set(&mut *tx, "epoch", &epoch).await?;
    meta_set(&mut *tx, "salt", &salt_b64).await?;
    meta_set(&mut *tx, "root", &root).await?;
    meta_set(&mut *tx, "device_id", &device_id).await?;
    meta_set(&mut *tx, "key_sealed", "1").await?;
    meta_set(&mut *tx, "last_error", "").await?;
    // 工程評審 S-6：`role` 留到 v1.1.4 再清（1.1.3 不讀它，但退回 1.1.2 時它就是同步的閘門）
    sqlx::query("DELETE FROM sync_meta WHERE key = 'primary_device_id'")
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    // 工程評審 B-2：outbox 在這個交易的開頭就清空了，而快照要等到 ⑪（拉完之後）才做。
    // 中間任何一步失敗（pull 的網路、快照的 SQL）＝鑰匙圈與 `joined` 已落地、本機那份資料卻永遠不會上雲，
    // 而且主人重按「加入」會命中重接分支、回「憑證已更新，資料照舊」——看起來成功、其實靜默失效。
    // 留一面旗，下一趟 `push_inner` 補做（**先完整拉取、再補戳、最後快照**，順序是硬的）。
    if matches!(outcome, JoinOutcome::First | JoinOutcome::Merged) {
        meta_set(&mut *tx, "join_pending", "snapshot").await?;
    }
    if orphans.0 > 0 {
        meta_set(&mut *tx, "last_orphans_count", &orphans.0.to_string()).await?;
        meta_set(&mut *tx, "last_orphans_path", orphans.1.as_deref().unwrap_or("")).await?;
        meta_set(&mut *tx, "last_orphans_at", &now_iso()).await?;
    }
    if let Some(p) = export_path.as_deref() {
        meta_set(&mut *tx, "last_export_path", p).await?;
        meta_set(&mut *tx, "last_export_at", &now_iso()).await?;
    }
    // 身分換了的話，把自己的舊格子也改成新身分（免得之後被當成別台寫的、誤判成併發）
    if meta.get("device_id").map(String::as_str) != Some(device_id.as_str()) {
        if let Some(old) = meta.get("device_id").filter(|s| !s.is_empty()) {
            sqlx::query("UPDATE sync_cells SET device_id = ? WHERE device_id = ?")
                .bind(&device_id)
                .bind(old)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
        }
    }
    // 補戳格子要在同一個交易裡：合併時「先補戳、後拉」是硬順序（不補戳，遠端會無條件蓋掉本機）
    if matches!(args.mode, Some(JoinMode::Merge)) || (!remote_has_data && local_alive > 0) {
        stamp_missing_cells(&mut tx, &device_id).await?;
    }
    tx.commit().await.map_err(db_err)?;

    // ⑪ 拉／快照
    let mut pull_report = None;
    let mut snapshot_ops = 0u64;
    if remote_has_data {
        pull_report = Some(pull_core(&pool, &client, &data_key, &root, &epoch, &device_id, Some(&st)).await?);
    }
    if matches!(outcome, JoinOutcome::First | JoinOutcome::Merged) {
        snapshot_ops = snapshot_into_outbox(&pool, &device_id).await?;
        // 快照做完了，旗降下（工程評審 B-2）
        sqlx::query("DELETE FROM sync_meta WHERE key = 'join_pending'")
            .execute(&pool)
            .await
            .map_err(db_err)?;
    }
    meta_set(&pool, "enabled", "1").await?;
    st.set_gate(None);
    // 刻意**不**標記 `bucket_meta_done`：加入時若沿用的是 v1.1.1／v1.1.2 開的舊紀元（沒有 EPOCH.bin），
    // 要靠第一趟 push／pull 的 `ensure_bucket_meta` 去補寫它，別台的紀元偵測才有依據（§7 ⑥）。
    // 反過來，**上一個進程留下的 true 要清掉**（工程評審 S-9）：不清的話新血統的 SALT 比對、
    // `key_sealed`、`EPOCH.bin` 補寫全部會被短路，要等主人重開 App 才會做。
    st.clear_bucket_meta_done();
    drop(_busy);

    let message = match outcome {
        JoinOutcome::First => "已加入——這台是第一台，資料正在上傳。",
        JoinOutcome::Pulled => "已加入——雲端的資料已拉下來。",
        JoinOutcome::Merged => "已加入——兩邊的資料已合併，較晚改的為準。",
        JoinOutcome::Adopted => "已改用另一台的資料。",
        _ => "已加入同步。",
    };
    Ok(JoinReport {
        outcome,
        local_alive,
        remote_epoch: Some(epoch),
        remote_devices,
        snapshot_ops,
        pull: pull_report,
        export_path,
        message: message.into(),
    })
}

/// 改密語（契約 §4.4）：**只重寫 `<root>/KEY` 一顆物件**——新的 kdf 鹽、新的 nonce、新密語，
/// 包的還是同一把資料鑰匙。資料一個位元都不重傳，其他已加入的裝置完全不受影響
/// （它們鑰匙圈裡存的是資料鑰匙，不是密語派生的東西）。
///
/// 舊血統（v1.1.2 升上來、桶裡還沒有 KEY）第一次進來時是「封存」：把鑰匙圈裡的資料鑰匙封起來，
/// 順手把 SALT 補上桶（§7 ④⑤a）。
///
/// **現密語是可選的**（產品評審 B4）：資料鑰匙本來就在這台的鑰匙圈裡，重封 KEY 一次也用不到舊密語
/// ——舊碼那道「先驗現密語」擋不住任何拿得到解鎖桌機的人（他已經能匯出整顆 DB），卻讓「忘了密語」
/// 在 App 內完全沒有出口（改不了密語、加不了第三台、重新加入也回同一句）。現在打了就驗（自我檢查、
/// 順便自癒壞掉的 KEY），留白就直接重封。
///
/// 自癒（工程評審 B-3）：桶裡的 KEY 拆不開、而舊血統法 `argon2id(現密語, SALT)` 卻等於鑰匙圈裡的資料鑰匙
/// ⇒ 那顆 KEY 必定是別人寫壞的（同一個 SALT 不可能包出不同的資料鑰匙）⇒ 直接覆蓋，不是回「密語不對」。
///
/// 已知限制（寫進 README）：舊密語＋舊 KEY 物件的**副本**仍能解出資料鑰匙；**舊血統更徹底**——
/// SALT 明文在桶裡，舊密語＋桶就能再推一次資料鑰匙，改密語只擋新裝置、擋不住拿過舊密語的人
/// （工程評審 S-7）。要真正撤銷得換資料鑰匙＝全部重新加密（排 v1.1.4）。
/// 競態：兩台同時改密語＝後 PUT 的贏、前一台的新密語靜默作廢。
pub async fn change_passphrase(
    app: &AppHandle,
    current: &str,
    next: &str,
    rotate: bool,
) -> Result<PassphraseReport, String> {
    // v1.1.4（契約 §5；D-3）：勾了「同時換掉資料鑰匙」⇒ 走七步輪替，不走下面的「只重包 KEY」。
    // `current` 在這條路上**必填**（自決 4：忘密語走「重新加入」不走輪替）——輪替裡驗。
    if rotate {
        let r = rotate_data_key(app, current, next).await?;
        return Ok(PassphraseReport {
            sealed_first_time: false,
            rotated: true,
            reencrypted_snapshots: r.reencrypted_snapshots,
            deleted_epochs: r.deleted_epochs,
            message: r.message,
        });
    }
    let creds = credstore::load(app)?.ok_or_else(|| "這台還沒加入同步。".to_string())?;
    let next = next.trim();
    if next.chars().count() < 8 {
        return Err("新密語至少 8 個字。".into());
    }
    let current = current.trim();
    let root = creds.root.clone();
    let data_key = crypto::key_from_b64(&creds.data_key_b64)?;
    let client = client_of(&creds)?;

    // ── 工程評審 B-1（v1.1.4 修正席）：**這台的鑰匙還是現役的嗎？** ──
    //
    // 「只重包 KEY」這條路會無條件把 `<root>/KEY` 寫成「新密語包著**這台鑰匙圈裡那把**」。
    // 在 v1.1.3 那是安全的（全桶只有一把資料鑰匙）；v1.1.4 有了輪替就不是了：
    // 別台勾過「同時換掉資料鑰匙」之後，桶裡的 KEY 是 K2，而這台手上還是 K1——
    // 這時改密語會把 KEY 蓋回 K1，**K2 從世上消失**（它只在那台的鑰匙圈裡），
    // 之後任何用新密語加入的裝置都會拆出 K1、找不到 E2、開出第三個紀元＝兩個血統永久分裂。
    // 「真撤銷」於是變成「真斷線」。三條子路（留白不驗／打新密語判成殘留／舊血統法驗得過）全都會踩到，
    // 所以守門放在最前面、在碰 KEY 之前。出路與 `describeLocked(rotated)` 同一句話。
    let rotated_note = || {
        "這份資料已在另一台換過鑰匙——這台的鑰匙已經不算數了，改密語會把別台的新鑰匙蓋掉。\
         請用新密語「重新加入同步」。"
            .to_string()
    };
    if rotation_marker(app).is_some() {
        return Err("換鑰匙還沒做完——請先讓它接著做完（打開 App 稍等即可）。".into());
    }
    // 守門不准被靜默跳過（它擋的是「資料再也接不回來」），所以 pool 拿不到就整支失敗
    let pass_pool = pool(app).await?;
    let pass_meta = meta_all(&pass_pool).await?;
    // `locked` 是紀元號、而且原因是「換過鑰匙」＝這台已經被雲端的新紀元擋下來了，先處理那個
    if pass_meta.get("locked").is_some_and(|v| !v.is_empty() && v != "salt")
        && pass_meta.get("locked_reason").map(String::as_str) == Some("rotated")
    {
        return Err(rotated_note());
    }
    // 還沒掃到（這台離線期間別台換的）也要擋——掃描是每趟 pull 才做，改密語不會等它
    if rotated_elsewhere(
        &client,
        &root,
        &data_key,
        pass_meta.get("epoch").filter(|e| !e.is_empty()).map(String::as_str),
    )
    .await?
    .is_some()
    {
        return Err(rotated_note());
    }

    let wrong = || "現在的密語不對。留白也可以——這台的鑰匙還在，可以直接設一個新的。".to_string();
    /// 舊血統法：`argon2id(密語, 血統鹽)` 是不是就是這台的資料鑰匙
    async fn is_old_lineage(
        creds: &SyncCredentials,
        passphrase: &str,
        data_key: &[u8; crypto::KEY_LEN],
    ) -> Result<bool, String> {
        let Some(salt_b64) = creds.salt_b64.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(false);
        };
        let salt = crypto::b64_decode(salt_b64)?;
        Ok(&derive_blocking(passphrase, &salt).await? == data_key)
    }

    let key_object = client.get_opt(&key_object_key(&root)).await?;
    let sealed_first_time = key_object.is_none();
    // 桶裡那顆 KEY 與這份資料不符（拆不開，或拆出來是別把鑰匙）＝殘留／被寫壞的物件，覆蓋掉並告訴主人
    let mut healed = false;
    match key_object.as_deref() {
        Some(bytes) if !current.is_empty() => match unseal_key_object(&root, current, bytes).await {
            Ok(opened) if opened == data_key => {}
            // 拆得開、裡面卻是另一把鑰匙 ⇒ 這顆 KEY 屬於別份資料（工程評審 S-1 的對稱面）
            Ok(_) => healed = true,
            // 拆不開：舊血統法驗得過就是「KEY 被寫壞了」，否則才是真的打錯密語
            Err(_) => {
                if is_old_lineage(&creds, current, &data_key).await? {
                    healed = true;
                } else {
                    return Err(wrong());
                }
            }
        },
        Some(_) => {} // 留白＝不驗，直接重封（鑰匙圈就是權威）
        None => {
            // 舊血統：桶裡還沒有 KEY。打了現密語就驗一次（自我檢查），留白就跳過
            if !current.is_empty() && !is_old_lineage(&creds, current, &data_key).await? {
                return Err(wrong());
            }
            // SALT 還沒上桶就順手補（§7 ④）——別台要靠它認血統
            if let Some(salt_b64) = creds.salt_b64.as_deref().filter(|s| !s.is_empty()) {
                let salt_obj = salt_object_key(&root);
                if client.get_opt(&salt_obj).await?.is_none() {
                    client.put(&salt_obj, salt_b64.as_bytes().to_vec()).await?;
                }
            }
        }
    }

    // 工程評審 S-10：PUT 的回應掉了會讓主人看到「失敗」、其實已經改好；重試又會回「現在的密語不對」。
    // 失敗時再 GET 一次用**新**密語試拆，拆得出同一把資料鑰匙就當成功。
    if let Err(e) = seal_key_object(&client, &root, next, &data_key).await {
        let recovered = match client.get_opt(&key_object_key(&root)).await {
            Ok(Some(bytes)) => matches!(unseal_key_object(&root, next, &bytes).await, Ok(k) if k == data_key),
            _ => false,
        };
        if !recovered {
            return Err(e);
        }
    }
    if let Ok(pool) = pool(app).await {
        let _ = meta_set(&pool, "key_sealed", "1").await;
    }
    Ok(PassphraseReport {
        sealed_first_time,
        rotated: false,
        reencrypted_snapshots: 0,
        deleted_epochs: 0,
        message: if healed {
            "密語已更改——雲端上那顆鑰匙與這份資料對不起來（多半是殘留），已重新封存。".into()
        } else if sealed_first_time {
            "密語已封存到雲端。".into()
        } else {
            "密語已更改。".into()
        },
    })
}

/// 還原收尾（契約 §6 步驟 5）：重啟後由 TS 的 boot 看到 `status.restore_pending` 叫這一支，
/// 讀標記檔裡主人在對話框選的方式——
///   * **回到過去**：所有裝置都改用這份 ⇒ 開新紀元、全庫快照重上傳。`sync_cells` **不清**
///     （它們是原始時間戳的來源；還原後的 DB 帶著備份時刻的格子），補戳之後快照讀格子。
///   * **接上現在**：只有這台換成備份 ⇒ 只清游標／seen／in-flight，outbox／cells／紀元都留。
///     下一趟 pull 從頭重列目前紀元：op hlc ≤ 格子 ⇒ 跳過，較新 ⇒ 蓋回（＝「雲端比備份新的修改會再蓋回來」）。
///   * 沒鑰匙圈 ＝ 這台沒加入同步 ⇒ 清標記、零動作（評審 S2 的一般化）。
///
/// 為什麼用檔不用 sync_meta：還原會把整顆 DB 換掉，DB 裡的任何旗標都跟著回到過去；app 資料目錄不會。
/// 為什麼不在 BackupTab 的還原流程末尾直接做：`backup_restore` 換檔之後會 `app.restart()`，進程不會回來。
pub async fn finish_restore(app: &AppHandle) -> Result<RestoreReport, String> {
    let Some((choice, label)) = restore_marker(app) else {
        return Err("沒有待處理的還原。".into());
    };
    // 工程評審 B-1：只有「讀得到、而且裡面沒東西」才是 NotJoined（＝清標記、零動作）。
    // 讀取失敗一律回 Err、**標記留著**——`runCycle` 每 60 秒會再叫一次，主人重啟之後就收得掉。
    let creds = match credstore::load(app) {
        Ok(Some(c)) => c,
        Ok(None) => {
            clear_restore_pending(app);
            return Ok(RestoreReport {
                outcome: RestoreOutcome::NotJoined,
                epoch: None,
                snapshot_ops: 0,
                message: "這台還沒加入同步，還原不影響其他裝置。".into(),
            });
        }
        Err(e) => return Err(format!("{e}還原後的同步收尾先停在這裡——請重新啟動後再試。")),
    };
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    let pool = pool(app).await?;
    let meta = meta_all(&pool).await?;
    let root = creds.root.clone();
    let data_key = crypto::key_from_b64(&creds.data_key_b64)?;
    let client = client_of(&creds)?;
    // 身分是鑰匙圈的（還原不換身分，契約 §3.1）
    let device_id = creds
        .device_id
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or(ensure_device_id(&pool).await?);
    let old_epoch = meta.get("epoch").filter(|s| !s.is_empty()).cloned();

    match choice {
        RestoreChoice::Past => {
            // v1.1.4 修正席（工程評審 S-7）：**別台已經換過鑰匙、這台還沒掃到**時不准開新紀元。
            // 這台手上是 K1，開出來的紀元號一定 > E2、卻只有 K1 拆得開 ⇒ 換過鑰匙那台掃到它會判成
            //「殘留」（locked=stale，文案叫主人去 Cloudflare 後台刪目錄），而這台自己看不到任何比它新的
            // 紀元、永遠 running ⇒ 兩邊互不承認、只剩手動刪桶目錄一條路。
            // 正解：還原後的資料**留在這台**，走既有的鍵違い出路（用新密語重新加入、選「兩邊都保留」）。
            if let Some(e) =
                rotated_elsewhere(&client, &root, &data_key, old_epoch.as_deref()).await?
            {
                clear_restore_pending(app);
                meta_set(&pool, "locked", &e).await?;
                meta_set(&pool, "locked_reason", "rotated").await?;
                st.set_gate(None);
                return Ok(RestoreReport {
                    outcome: RestoreOutcome::Resumed,
                    epoch: old_epoch,
                    snapshot_ops: 0,
                    message: "這份資料已在另一台換過鑰匙——還原後的資料留在這台，\
                              請用新密語「重新加入同步」並選「兩邊都保留」。"
                        .into(),
                });
            }
            // 新紀元號一定要大於「舊的」與「桶裡既有的全部」——別台的偵測是「比我大才提示」，
            // 小了就永遠不會觸發（時鐘被撥回也一樣）。
            let floor = list_epochs(&client, &root)
                .await?
                .first()
                .copied()
                .unwrap_or(0)
                .max(old_epoch.as_deref().and_then(|e| e.parse::<u64>().ok()).unwrap_or(0))
                .saturating_add(1);
            let new_epoch = hlc::now_ms().max(floor).to_string();

            // v1.1.4：交易段抽成 `switch_epoch_local`（鑰匙輪替步驟 4 共用），內容一字未動
            switch_epoch_local(
                &pool,
                &creds,
                &device_id,
                meta.get("device_id").map(String::as_str).unwrap_or(""),
                &new_epoch,
            )
            .await?;

            // 紀元標記。網路失敗就回 Err——標記檔**留著**，下次啟動再試（紀元號已換也無妨：再換一次就是）
            if let Err(e) =
                put_epoch_marker(&client, &data_key, &root, &new_epoch, &device_id, "restore", label)
                    .await
            {
                record_error(&pool, &e).await;
                return Err(e);
            }

            let snapshot_ops = snapshot_into_outbox(&pool, &device_id).await?;
            clear_restore_pending(app);
            st.set_gate(None);
            record_success(&pool).await?;
            Ok(RestoreReport {
                outcome: RestoreOutcome::Renewed,
                epoch: Some(new_epoch),
                snapshot_ops,
                // 產品評審 S2：toast 不用「紀元」這個內部語彙，講主人看得見的後果
                message: "還原完成——這台正把整份資料重新上傳；其他裝置下次同步會被問要不要改用這份。".into(),
            })
        }
        RestoreChoice::Present => {
            // 備份早於加入同步時這顆 DB 沒有 epoch——用資料鑰匙去桶裡找回目前紀元，
            // 不然下一趟 pull 只會回「同步設定不完整」。
            let epoch = match old_epoch {
                Some(e) => Some(e),
                None => resolve_current_epoch(&client, &data_key, &root).await?,
            };
            let mut tx = pool.begin().await.map_err(db_err)?;
            sqlx::query(
                "DELETE FROM sync_meta WHERE key LIKE 'last_pull_key%' OR key LIKE 'seen:%' \
                 OR key IN ('inflight_key','inflight_max_seq','pending_epoch','pending_epoch_info')",
            )
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
            meta_set(&mut *tx, "joined", "1").await?;
            meta_set(&mut *tx, "root", &root).await?;
            meta_set(&mut *tx, "device_id", &device_id).await?;
            // 產品評審 B2（同 Past）：還原到關著同步那段期間的備份也要把總開關打開，
            // 不然「接上現在」之後這台既不推也不拉，狀態列寫「已關閉」而 toast 說會蓋回來。
            meta_set(&mut *tx, "enabled", "1").await?;
            // 工程評審 S-6：`join`／`status` 都會把舊身分的格子改成新身分，只有這裡漏了——
            // 新機還原舊機備份之後，格子掛著那台死機的 device_id，`seen` 判定會把自己的寫入當成併發。
            sqlx::query("UPDATE sync_cells SET device_id = ? WHERE device_id = ?")
                .bind(&device_id)
                .bind(meta.get("device_id").map(String::as_str).unwrap_or(""))
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
            if let Some(s) = creds.salt_b64.as_deref().filter(|s| !s.is_empty()) {
                meta_set(&mut *tx, "salt", s).await?;
            }
            if let Some(e) = epoch.as_deref() {
                meta_set(&mut *tx, "epoch", e).await?;
            }
            tx.commit().await.map_err(db_err)?;
            clear_restore_pending(app);
            st.set_gate(None);
            Ok(RestoreReport {
                outcome: RestoreOutcome::Resumed,
                epoch,
                snapshot_ops: 0,
                message: "已接上現在——其他裝置比這份備份新的修改，下一趟同步會再蓋回來。".into(),
            })
        }
    }
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
            hlc_from: ops.iter().map(|o| o.hlc.clone()).min().unwrap_or_default(),
            hlc_to: ops.iter().map(|o| o.hlc.clone()).max().unwrap_or_default(),
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

    /// 補戳格子（v1.1.3 §5.1）：`join(first/merged)` 與 `finish_restore(past)` 在快照之前都會先做
    async fn stamp_all(pool: &Pool<Sqlite>, me: &str) -> u64 {
        let mut tx = pool.begin().await.unwrap();
        let n = stamp_missing_cells(&mut tx, me).await.unwrap();
        tx.commit().await.unwrap();
        n
    }

    /// 直接改一格的 hlc（模擬「這一欄是那時候改的」）
    async fn set_cell(pool: &Pool<Sqlite>, tbl: &str, row_id: &str, col: &str, hlc: &str, dev: &str) {
        sqlx::query(
            "INSERT INTO sync_cells (tbl, row_id, col, hlc, device_id) VALUES (?, ?, ?, ?, ?)              ON CONFLICT(tbl, row_id, col) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id",
        )
        .bind(tbl)
        .bind(row_id)
        .bind(col)
        .bind(hlc)
        .bind(dev)
        .execute(pool)
        .await
        .unwrap();
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

            // v1.1.3 §5.1／§5.2：格子先補（原始時間戳的來源），快照**只讀**格子
            let stamped = stamp_all(&src, "dev-primary").await;
            assert!(stamped > 0, "沒同步過的列要補出格子來");
            let cells_before = count(&src, "SELECT COUNT(*) FROM sync_cells").await;

            let n = snapshot_into_outbox(&src, "dev-primary").await.unwrap();
            // 4 個節點＋1 筆日誌＋1 筆班次＋1 把設定鑰匙（theme 不在白名單）；一列的欄同戳 ⇒ 一列一筆 op
            assert_eq!(n, 7);
            assert_eq!(count(&src, "SELECT COUNT(*) FROM sync_outbox").await, 7);
            assert_eq!(
                count(&src, "SELECT COUNT(*) FROM sync_cells").await,
                cells_before,
                "快照對 cells 零寫入——格子是來源不是產物（§5.2）"
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
            let root = sandbox_root();
            let epoch = hlc::now_ms().to_string();

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
            let first = push_loop(&pool, &client, &key, &root, &epoch, device).await.unwrap();
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

            let second = push_loop(&pool, &client, &key, &root, &epoch, device).await.unwrap();
            assert_eq!(second.pushed_ops, 3, "重推兩筆＋後來那一筆另起一顆物件");

            // 重推的那顆＝原 key，內容仍是**兩筆**（不是三筆）
            let blob = client.get(&object_key).await.unwrap();
            let obj: OplogObject =
                serde_json::from_slice(&crypto::open(&key, &object_key, &blob).unwrap()).unwrap();
            assert_eq!(obj.ops.len(), 2, "重推不可以把後來的 op 塞進同一個 key");

            // 後來那一筆必須自己成一顆**新** key（副本的游標才看得到它）
            let keys = client.list_after(&format!("{root}/{epoch}/{device}/"), "").await.unwrap();
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
    // v1.1.2 雙向往返（打真的 R2；v1.1.3 起沙盒靠**獨立的根** `v1-sb-<run>/` 隔離 ⇒ 絕不干擾主人正本）
    // ─────────────────────────────────────────────────────────

    /// 沙盒的**桶內根**（v1.1.3 契約 §0 鐵則 4）：`v1-sb-<run>`，與主人正本的 `v1/` 平級。
    ///
    /// 為什麼改用「不同的根」而不是 v1.1.2 的「非數字紀元」：v1.1.3 的紀元偵測改成
    /// 「拆得開即承認」，非數字那道保險沒了；改靠根前綴——`list_prefixes("v1/")` 與
    /// `list_prefixes("v1-sb-…/")` 互相看不到對方，沙盒永遠碰不到 `v1/SALT`、`v1/KEY`
    /// 與主人的數字紀元。收工由 `沙盒根已清空` 掃地。
    fn sandbox_root() -> String {
        let mut stamp = [0u8; 8];
        crypto::fill_random(&mut stamp).unwrap();
        format!("v1-sb-{}", crypto::b64_encode(&stamp))
    }

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
        root: &str,
        epoch: &str,
        me: &str,
    ) -> ApplyOutcome {
        let mut total = ApplyOutcome::default();
        let dirs = client.list_prefixes(&format!("{root}/{epoch}/")).await.unwrap();
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
                .list_after(&format!("{root}/{epoch}/{dev}/"), &cursor)
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

    /// v1.1.3 第一段沙盒的引擎版（契約 §9 壬1／壬2／壬10／壬11）：
    /// **A 當第一台 → B 兩邊都保留（合併）→ 改密語 → C 用新密語加入**。**打真的 R2**。
    ///
    /// 跑法（Git Bash）：
    /// ```text
    /// set -a && source "$LOCALAPPDATA/NextStop/r2.env" && set +a
    /// cargo test --lib sync::engine::tests::加入_合併_改密語 -- --ignored --nocapture
    /// ```
    /// 鐵則：全部物件都在**沙盒根** `v1-sb-<run>/` 底下（與主人正本的 `v1/` 平級、互相 list 不到，
    /// 所以 `v1/SALT`、`v1/KEY` 與主人的數字紀元一個字都碰不到），收工逐一刪除；憑證一個字都不印。
    ///
    /// `join()`／`change_passphrase()` 本身要 `AppHandle`＋鑰匙圈，單元測試裡拿不到；
    /// 這支走的是它們內部的同一組零件（`seal_key_object`／`unseal_key_object`／`resolve_current_epoch`／
    /// `stamp_missing_cells`／`snapshot_into_outbox`／`push_loop`／`apply_object`）。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 加入_合併_改密語_第三台用新密語加入() {
        tauri::async_runtime::block_on(async {
            let client = sandbox_client();
            let root = sandbox_root();
            let epoch = hlc::now_ms().to_string();
            const A: &str = "dev-sb-aaaa";
            const B: &str = "dev-sb-bbbb";
            const C: &str = "dev-sb-cccc";
            let pass1 = "沙盒密語第一版";
            let pass2 = "沙盒密語第二版";

            // ── ① A＝第一台（契約 §4.2 步驟 5）：隨機資料鑰匙＋隨機血統鹽，PUT SALT／KEY／EPOCH.bin
            let data_key = crypto::random_data_key().unwrap();
            let lineage_salt = crypto::b64_encode(&crypto::random_salt().unwrap());
            client
                .put(&salt_object_key(&root), lineage_salt.as_bytes().to_vec())
                .await
                .unwrap();
            seal_key_object(&client, &root, pass1, &data_key).await.unwrap();
            put_epoch_marker(&client, &data_key, &root, &epoch, A, "first", None)
                .await
                .unwrap();
            assert_eq!(
                resolve_current_epoch(&client, &data_key, &root).await.unwrap().as_deref(),
                Some(epoch.as_str()),
                "EPOCH.bin 拆得開 ⇒ 這就是目前紀元"
            );

            let (a, pa) = make_pool("sb-join-a").await;
            seed_tree(&a).await;
            stamp_all(&a, A).await;
            let up = snapshot_into_outbox(&a, A).await.unwrap();
            assert_eq!(up, 7, "4 節點＋1 日誌＋1 班次＋1 設定");
            push_loop(&a, &client, &data_key, &root, &epoch, A).await.unwrap();

            // ── ② B 離線建了自己的一張票 ⇒ 兩邊都有料 ⇒「兩邊都保留」＝補戳 → 拉全量 → 快照 → 推
            let (b, pb) = make_pool("sb-join-b").await;
            sqlx::query(
                "INSERT INTO nodes (id, kind, name, created_at, updated_at) \
                 VALUES ('K9','ticket','B 自己的票','2026-09-10T00:00:00.000Z','2026-09-10T00:00:00.000Z')",
            )
            .execute(&b)
            .await
            .unwrap();
            stamp_all(&b, B).await;
            let down = pull_all(&b, &client, &data_key, &root, &epoch, B).await;
            assert_eq!(down.applied, 7, "A 的東西全部套進來");
            assert_eq!(down.conflicts, 0, "不同的列，沒有併發");
            assert_eq!(count(&b, "SELECT COUNT(*) FROM nodes").await, 5, "A 的四張＋B 自己的一張");
            snapshot_into_outbox(&b, B).await.unwrap();
            push_loop(&b, &client, &data_key, &root, &epoch, B).await.unwrap();

            // A 拉回來：兩邊都保留 ⇒ A 也有 B 的票，而且 A 自己的值沒有被 B 推回來的同一份蓋掉
            let back = pull_all(&a, &client, &data_key, &root, &epoch, A).await;
            assert_eq!(count(&a, "SELECT COUNT(*) FROM nodes").await, 5);
            assert_eq!(
                text(&a, "SELECT name FROM nodes WHERE id='T1'").await.as_deref(),
                Some("今日の列車"),
                "B 推回來的是同一個戳記 ⇒ LWW 判平手、不覆蓋"
            );
            assert_eq!(back.conflicts, 0, "合併不該生出假的競合");

            // ── ③ 合併之後的日常：B 改 T1 的名字（較晚）⇒ A 要跟上
            let later = hlc::format(hlc::Hlc { ms: hlc::now_ms() + 5_000, count: 0 }, B);
            local_op(&b, B, "T1", "name", "B 後來改的", &later).await;
            push_loop(&b, &client, &data_key, &root, &epoch, B).await.unwrap();
            pull_all(&a, &client, &data_key, &root, &epoch, A).await;
            assert_eq!(
                text(&a, "SELECT name FROM nodes WHERE id='T1'").await.as_deref(),
                Some("B 後來改的"),
                "較晚改的為準"
            );

            // ── ④ 改密語（§4.4）：只重寫 KEY 一顆物件，資料一個位元都不重傳
            let key_bytes = client.get_opt(&key_object_key(&root)).await.unwrap().unwrap();
            assert_eq!(
                unseal_key_object(&root, pass1, &key_bytes).await.unwrap(),
                data_key,
                "改之前：舊密語拆得開"
            );
            let objects_before = client.list_after(&format!("{root}/{epoch}/"), "").await.unwrap();
            seal_key_object(&client, &root, pass2, &data_key).await.unwrap();
            assert_eq!(
                client.list_after(&format!("{root}/{epoch}/"), "").await.unwrap(),
                objects_before,
                "改密語不動任何資料物件"
            );

            // ── ⑤ C 用**新**密語加入（空庫 ⇒ 直接拉）
            let key_bytes = client.get_opt(&key_object_key(&root)).await.unwrap().unwrap();
            assert!(
                unseal_key_object(&root, pass1, &key_bytes).await.is_err(),
                "舊密語從此打不開（本機零改變、回人話）"
            );
            let c_key = unseal_key_object(&root, pass2, &key_bytes).await.unwrap();
            assert_eq!(c_key, data_key, "資料鑰匙沒變 ⇒ 舊物件照樣拆得開");
            assert_eq!(
                resolve_current_epoch(&client, &c_key, &root).await.unwrap().as_deref(),
                Some(epoch.as_str())
            );
            let (c, pc) = make_pool("sb-join-c").await;
            let got = pull_all(&c, &client, &c_key, &root, &epoch, C).await;
            assert!(got.applied > 0);
            assert_eq!(count(&c, "SELECT COUNT(*) FROM nodes").await, 5, "整棵樹都到齊");
            assert_eq!(
                text(&c, "SELECT name FROM nodes WHERE id='T1'").await.as_deref(),
                Some("B 後來改的")
            );
            assert_eq!(
                text(&c, "SELECT line_id FROM nodes WHERE id='T1'").await.as_deref(),
                Some("L1"),
                "快取由收到方自己重算"
            );

            // ── ⑥ 收工：沙盒根底下的物件（含 SALT／KEY／EPOCH.bin）逐一刪掉
            let left = client.list_after(&format!("{root}/"), "").await.unwrap();
            for k in &left {
                client.delete(k).await.unwrap();
            }
            assert!(
                client.list_after(&format!("{root}/"), "").await.unwrap().is_empty(),
                "沙盒根要清乾淨"
            );

            drop_pool(a, pa).await;
            drop_pool(b, pb).await;
            drop_pool(c, pc).await;
        });
    }

    /// v1.1.3 修正席（產品評審 B2(b)／工程評審 S-3(c)）：**紀元偵測要跳過「標記在、一個裝置目錄都沒有」的紀元**。
    ///
    /// 為什麼是 blocking：`put_epoch_marker` 在快照 push **之前**就寫了。別台若在那段窗口問到，
    /// 會被推進「改用那份」→ wipe → pull 到 0 顆物件＝畫面整個空掉。
    /// 順便驗 `locked=<紀元>` 的出路：拆不開、又沒有裝置目錄的殘留紀元不該把人鎖住。
    ///
    /// 跑法（Git Bash）：
    /// ```text
    /// set -a && source "$LOCALAPPDATA/NextStop/r2.env" && set +a
    /// cargo test --lib sync::engine::tests::紀元偵測跳過 -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 紀元偵測跳過還沒有任何裝置目錄的紀元() {
        tauri::async_runtime::block_on(async {
            let client = sandbox_client();
            let root = sandbox_root();
            let key = crypto::random_data_key().unwrap();
            let other_key = crypto::random_data_key().unwrap(); // 別的密語建的紀元
            let mine = hlc::now_ms();
            let e_mine = mine.to_string();
            let e_new = (mine + 1_000).to_string();
            let e_alien = (mine + 2_000).to_string();
            const ME: &str = "dev-sb-me";
            const THEM: &str = "dev-sb-them";

            // ① 我自己的紀元：標記＋一顆物件（有裝置目錄）
            put_epoch_marker(&client, &key, &root, &e_mine, ME, "first", None).await.unwrap();
            client
                .put(&format!("{root}/{e_mine}/{ME}/0000000000001-me.bin"), b"x".to_vec())
                .await
                .unwrap();
            assert!(
                matches!(scan_new_epoch(&client, &key, &root, &e_mine).await.unwrap(), EpochScan::None),
                "只有自己的紀元 ⇒ 沒有更新的"
            );

            // ② 別台剛寫下新紀元的標記、還沒推出任何物件 ⇒ **不能**提示（舊行為會回 Found）
            put_epoch_marker(&client, &key, &root, &e_new, THEM, "restore", Some("昨天.db".into()))
                .await
                .unwrap();
            assert!(
                matches!(scan_new_epoch(&client, &key, &root, &e_mine).await.unwrap(), EpochScan::None),
                "標記在但零裝置目錄＝對方還在寫 ⇒ 這一趟先不問"
            );

            // ③ 第一顆物件到了 ⇒ 這才是真的可以改用
            client
                .put(&format!("{root}/{e_new}/{THEM}/0000000000002-them.bin"), b"y".to_vec())
                .await
                .unwrap();
            match scan_new_epoch(&client, &key, &root, &e_mine).await.unwrap() {
                EpochScan::Found(e, info) => {
                    assert_eq!(e, e_new);
                    assert_eq!(info.label.as_deref(), Some("昨天.db"), "文案要講得出是哪一份備份");
                }
                other => panic!("該回 Found，實際 {other:?}"),
            }

            // ④ 更大、拆不開、又沒有裝置目錄的殘留紀元 ⇒ 跳過（仍然承認 ③ 那個拆得開的）
            put_epoch_marker(&client, &other_key, &root, &e_alien, "dev-sb-alien", "first", None)
                .await
                .unwrap();
            match scan_new_epoch(&client, &key, &root, &e_mine).await.unwrap() {
                EpochScan::Found(e, _) => assert_eq!(e, e_new, "跳過空的殘留紀元，仍然承認 ③ 那個"),
                other => panic!("該回 Found，實際 {other:?}"),
            }

            // ④ʹ 把 ③ 那個紀元整個收掉 ⇒ 剩下的只有「拆不開又空」的殘留 ⇒ **不該是鍵違い**。
            //    這是 S-3(c) 的重點：舊行為會回 `Locked(e_alien)`，而那一態清不掉
            //    （重設重加下一趟又記回來），等於把主人鎖在一條沒有出路的死巷裡。
            client.delete(&epoch_marker_key(&root, &e_new)).await.unwrap();
            client
                .delete(&format!("{root}/{e_new}/{THEM}/0000000000002-them.bin"))
                .await
                .unwrap();
            assert!(
                matches!(scan_new_epoch(&client, &key, &root, &e_mine).await.unwrap(), EpochScan::None),
                "只剩一個拆不開又沒有裝置目錄的殘留紀元 ⇒ 不鎖人"
            );

            // ⑤ 殘留紀元真的長出資料了才算鍵違い
            client
                .put(&format!("{root}/{e_alien}/dev-sb-alien/0000000000003-a.bin"), b"z".to_vec())
                .await
                .unwrap();
            assert!(
                matches!(
                    scan_new_epoch(&client, &key, &root, &e_mine).await.unwrap(),
                    EpochScan::Locked(ref v) if v.first().map(String::as_str) == Some(e_alien.as_str())
                ),
                "最大的那個拆不開 ⇒ 鍵違い"
            );

            // ⑥ 收工
            for k in client.list_after(&format!("{root}/"), "").await.unwrap() {
                client.delete(&k).await.unwrap();
            }
            assert!(
                client.list_after(&format!("{root}/"), "").await.unwrap().is_empty(),
                "沙盒根要清乾淨"
            );
        });
    }

    /// 兩台互推互拉（契約 §2）＋同列同欄併發記競合（§3）。**打真的 R2**。
    ///
    /// 跑法（Git Bash）：
    /// ```text
    /// set -a && source "$LOCALAPPDATA/NextStop/r2.env" && set +a
    /// cargo test --lib sync::engine::tests::兩台互推互拉 -- --ignored --nocapture
    /// ```
    /// 鐵則：物件全在 `v1-sb-<run>/` 底下（與主人正本的 `v1/` 平級、互相 list 不到），
    /// 收工逐一刪除；憑證一個字都不印。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 兩台互推互拉_雙向往返並記下競合() {
        tauri::async_runtime::block_on(async {
            let client = sandbox_client();
            let key = crypto::derive_key("sandbox-passphrase", &[11u8; crypto::SALT_LEN]).unwrap();
            // v1.1.3：隔離靠**沙盒根**（`v1-sb-<run>/`），紀元照正常用 13 位毫秒
            let root = sandbox_root();
            let epoch = hlc::now_ms().to_string();
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
            let up = push_loop(&a, &client, &key, &root, &epoch, A).await.unwrap();
            assert_eq!(up.pushed_ops, 7);

            let down = pull_all(&b, &client, &key, &root, &epoch, B).await;
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
            let up_b = push_loop(&b, &client, &key, &root, &epoch, B).await.unwrap();
            assert_eq!(up_b.pushed_ops, 1);

            let back = pull_all(&a, &client, &key, &root, &epoch, A).await;
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
            push_loop(&a, &client, &key, &root, &epoch, A).await.unwrap();
            push_loop(&b, &client, &key, &root, &epoch, B).await.unwrap();

            // A 拉 B 的：B 的 hlc 較大 ⇒ A 的值讓位、A 記一筆競合
            let ra = pull_all(&a, &client, &key, &root, &epoch, A).await;
            assert_eq!(
                text(&a, "SELECT name FROM nodes WHERE id='K1'").await.as_deref(),
                Some("手機版")
            );
            assert_eq!(ra.conflicts, 1, "敗方（A）要留痕");
            let cf = conflicts_of(&a, "K1").await;
            assert_eq!(cf[0]["mine"], "桌機版");
            assert_eq!(cf[0]["theirs"], "手機版");

            // B 拉 A 的：A 的 hlc 較小 ⇒ 整筆判舊、B 零事件（敗方在 A 那邊已經記過了）
            let rb = pull_all(&b, &client, &key, &root, &epoch, B).await;
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
            let left = client.list_after(&format!("{root}/"), "").await.unwrap();
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

    /// v1.1.3 §5.6：挑出「比我新」的數字紀元，**由大到小**（後做的為準；掃描時先問最大的那一個）
    #[test]
    fn 紀元比較_只認數字_由大到小_且要比自己大() {
        let dirs = [
            "v1/1758153600000",
            "v1/1758153600002",
            "v1/1758153600001",
            "v1/sandbox-abc",   // 非數字，一律忽略
            "v1/1758153500000", // 比自己舊
            "v1/EPOCH-nope",
            "v1/1758153600002", // 重複
        ];
        assert_eq!(
            newer_epochs_of(dirs, "1758153600000"),
            vec![1_758_153_600_002, 1_758_153_600_001],
            "比自己大的、由大到小、去重"
        );
        assert!(newer_epochs_of(dirs, "1758153600002").is_empty(), "自己已經是最大的");
        assert!(
            newer_epochs_of(dirs, "sandbox-abc").is_empty(),
            "自己的紀元非數字 ⇒ 整個偵測跳過（寧可漏提示也不亂判）"
        );
        assert_eq!(
            newer_epochs_of(["v1/1758153600001/"], "1758153600000"),
            vec![1_758_153_600_001],
            "尾斜線也要吃得下"
        );
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

    /// 整合席沙盒壬8 抓到的資料遺失回歸：一列拆成多筆 op、收到方**還沒有這一列**（「改用那份」
    /// 把本機清空之後拉全量）時，整列不可以消失。
    ///
    /// 原本的行為：`name` 被另一台改過 ⇒ 自成一筆 op ⇒ 第一筆沒有 `name`、第二筆沒有 `kind`，
    /// `apply_object` 的新列分支兩筆都判 `required_of` 缺欄 ⇒ 兩筆都 `skipped`，票在別台靜默不見。
    #[test]
    fn 快照拆多筆時_收到方沒有這一列也建得起來() {
        tauri::async_runtime::block_on(async {
            let (src, src_path) = make_pool("snap-split-src").await;
            let (dst, dst_path) = make_pool("snap-split-dst").await;
            seed_one(&src).await;
            stamp_all(&src, "dev-primary").await;
            // 另一台後來改過名字 ⇒ `name` 這一格的戳與其餘欄不同 ⇒ 快照拆成兩筆
            sqlx::query("UPDATE nodes SET name = '別台改的名' WHERE id='N1'")
                .execute(&src)
                .await
                .unwrap();
            set_cell(&src, "nodes", "N1", "name", H20, "dev-b").await;

            let n = snapshot_into_outbox(&src, "dev-primary").await.unwrap();
            assert_eq!(n, 2, "拆成兩筆（name 一筆、其餘欄一筆）");

            let object = drain_outbox(&src, "dev-primary").await;
            let r = apply(&dst, &object, "v1/e/d/a.bin").await;
            assert_eq!(r.skipped, 0, "一筆都不可以被跳過");
            assert_eq!(
                text(&dst, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(),
                Some("別台改的名"),
                "整列要建得起來，而且名字是最後那一版"
            );
            assert_eq!(
                text(&dst, "SELECT hlc FROM sync_cells WHERE row_id='N1' AND col='name'")
                    .await
                    .as_deref(),
                Some(H20),
                "name 的格子要落在它自己那一格的戳上（借來的那份不可以高報）"
            );

            drop_pool(src, src_path).await;
            drop_pool(dst, dst_path).await;
        });
    }

    /// v1.1.3 §5.2／§5.4（取代 v1.1.2 的「快照每筆各自一個 hlc」——那條前提已作廢）：
    ///   * op 的 hlc ＝該欄格子的 hlc（原始時間戳，不是「現在」）
    ///   * 同一列裡同 hlc 的欄合成一筆、不同 hlc 的欄各自一筆
    ///   * 物件撞名改由**推送戳記**擋：同一台的物件名嚴格遞增
    #[test]
    fn 快照讀格子_同戳合併_異戳拆開_推送戳記不撞名() {
        tauri::async_runtime::block_on(async {
            let (src, path) = make_pool("snap-cells").await;
            seed_one(&src).await;
            stamp_all(&src, "dev-primary").await;

            // N1 的 name 與 status 各自被改過（兩個不同的時刻）⇒ 拆成兩筆；其餘欄維持補戳那一個 hlc
            set_cell(&src, "nodes", "N1", "name", H05, "dev-primary").await;
            set_cell(&src, "nodes", "N1", "status", H10, "dev-primary").await;

            let n = snapshot_into_outbox(&src, "dev-primary").await.unwrap();
            assert_eq!(n, 3, "N1 拆成三筆：name（H05）、status（H10）、其餘欄（補戳那一個）");

            let by_hlc: Vec<(String, String)> = sqlx::query("SELECT hlc, payload FROM sync_outbox")
                .fetch_all(&src)
                .await
                .unwrap()
                .iter()
                .map(|r| {
                    (
                        r.try_get::<String, _>("hlc").unwrap(),
                        r.try_get::<String, _>("payload").unwrap(),
                    )
                })
                .collect();
            let of = |h: &str| -> String {
                by_hlc
                    .iter()
                    .find(|(k, _)| k == h)
                    .map(|(_, p)| p.clone())
                    .unwrap_or_default()
            };
            // H05 是這一列最小的 hlc ⇒ 它要順手帶上必填欄（`kind`），收到方才建得起這一列
            //（沙盒壬8：不帶的話整列被 `apply_object` 的 `required_of` 檢查跳過、靜默消失）。
            // `kind` 自己那一格的戳在「其餘欄」那一筆（比 H05 大），所以最後落在正確的 hlc 上。
            assert_eq!(
                of(H05),
                "{\"kind\":\"train\",\"name\":\"本機版\"}",
                "name 帶的是它自己那一格的戳，外加借一份必填的 kind"
            );
            assert!(of(H10).contains("status"), "status 自成一筆");
            assert!(
                !of(H10).contains("name"),
                "不同戳的欄不可以合在一起——必填欄只補在最小的那一筆，補到大的會高報戳記"
            );
            let rest = by_hlc
                .iter()
                .find(|(k, _)| k != H05 && k != H10)
                .expect("其餘欄要有一筆");
            assert!(
                rest.1.contains("kind") && rest.1.contains("created_at"),
                "同戳的欄要合併成一筆：{}",
                rest.1
            );

            // §5.4：推送戳記比「快照帶的原始時間戳」與上一顆物件名都大 ⇒ 同一台的物件名嚴格遞增
            let s1 = next_object_stamp(&src, None, "dev-primary").await.unwrap();
            assert!(s1.as_str() > H10, "推送戳記要比快照裡最大的原始戳記還大：{s1}");
            let s2 = next_object_stamp(&src, Some(&s1), "dev-primary").await.unwrap();
            assert!(s2 > s1, "第二顆物件名一定要大於第一顆");
            // outbox 推完清空之後（max_hlc 掉回格子的舊戳）照樣不能倒退
            sqlx::query("DELETE FROM sync_outbox").execute(&src).await.unwrap();
            let s3 = next_object_stamp(&src, Some(&s2), "dev-primary").await.unwrap();
            assert!(s3 > s2, "outbox 清空後要靠 last_object_stamp 頂住");
            assert_eq!(
                stamp_of_object_key(&format!("v1/1758153600000/dev/{s3}.bin")).as_deref(),
                Some(s3.as_str()),
                "重推 in-flight 時要從 key 拿回同一個戳記"
            );

            drop_pool(src, path).await;
        });
    }

    /// v1.1.3 §5.1：補戳用的是**原始時間**（updated_at／created_at），不是「現在」；既有格子一律不動。
    /// SQL 版（`stamp_missing_cells`）與 Rust 版（快照撿漏用的 `derived_hlc`）必須同值。
    #[test]
    fn 補戳格子_派生自原始時間_且不覆蓋既有格子() {
        tauri::async_runtime::block_on(async {
            let (pool, path) = make_pool("stamp-derive").await;
            sqlx::query(
                "INSERT INTO nodes (id, kind, name, created_at, updated_at) \
                 VALUES ('N1','train','舊票','2026-09-01T00:00:00.000Z','2026-09-14T08:30:00.123Z')",
            )
            .execute(&pool)
            .await
            .unwrap();
            // 已經同步過的那一格（比派生值更晚）：補戳不可以動它
            let later = "17999999999990000-dev-othe";
            set_cell(&pool, "nodes", "N1", "name", later, "dev-other").await;

            stamp_all(&pool, "dev-primary-xyz").await;

            let expect = derived_hlc(
                Some("2026-09-14T08:30:00.123Z"),
                Some("2026-09-01T00:00:00.000Z"),
                "dev-prim",
            );
            assert_eq!(&expect[..13], "1789374600123", "13 位毫秒＝updated_at（不是 created_at、不是現在）");
            assert_eq!(&expect[13..17], "0000");
            assert!(expect.ends_with("-dev-prim"), "尾碼＝device_id 前 8 碼");
            assert!(hlc::is_valid(&expect), "派生出來的要是合法 hlc：{expect}");

            assert_eq!(
                text(&pool, "SELECT hlc FROM sync_cells WHERE col='kind'").await.as_deref(),
                Some(expect.as_str()),
                "SQL 的派生要與 Rust 的 derived_hlc 同值"
            );
            assert_eq!(
                text(&pool, "SELECT hlc FROM sync_cells WHERE col='name'").await.as_deref(),
                Some(later),
                "既有格子一律不動（INSERT OR IGNORE）"
            );
            assert!(
                expect.as_str() < later,
                "沒同步過的列一定早於之後的真編輯——這就是 B1 的修法"
            );
            // 快取欄與非根票的 route_id 不補戳（它們不進同步）
            assert_eq!(count(&pool, "SELECT COUNT(*) FROM sync_cells WHERE col='line_id'").await, 0);
            assert_eq!(count(&pool, "SELECT COUNT(*) FROM sync_cells WHERE col='route_id'").await, 0);

            drop_pool(pool, path).await;
        });
    }

    /// 評審 B1 的完整情境（v1.1.3 §5.1／§5.2／§5.3）：舊桌機壞了、新桌機還原**上週**的備份選「兩邊都保留」。
    /// 手機這週改的名要贏、刪掉的票不可以復活、而且「先拉再推」之後不該冒出假的競合。
    #[test]
    fn 合併快照_較晚修改贏_刪除生效_seen不誤判() {
        tauri::async_runtime::block_on(async {
            let (desk, path) = make_pool("merge-b1").await;
            // 桌機還原的是上週的備份：兩張票，時間都停在 9/14
            for (id, name) in [("N1", "甲票"), ("N2", "乙票")] {
                sqlx::query(
                    "INSERT INTO nodes (id, kind, name, created_at, updated_at) \
                     VALUES (?, 'train', ?, '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')",
                )
                .bind(id)
                .bind(name)
                .execute(&desk)
                .await
                .unwrap();
            }
            // ①「加入 → 兩邊都保留」的第一步：補戳格子（帶的是 9/14，不是現在）
            stamp_all(&desk, "dev-desk").await;
            let desk_stamp = text(&desk, "SELECT hlc FROM sync_cells WHERE row_id='N1' AND col='name'")
                .await
                .unwrap();

            // ② 第二步：先拉全量。手機**之後**改了甲票的名、刪了乙票；
            //    手機推之前也拉過桌機的東西 ⇒ seen 帶著桌機那一版，不該被判成併發。
            let phone_hlc = hlc::next(Some(&desk_stamp), 0, "dev-phone");
            assert!(phone_hlc > desk_stamp);
            let phone = make_obj_seen(
                "dev-phone",
                &[("dev-desk", &desk_stamp)],
                vec![
                    mk_op(&phone_hlc, "nodes", "N1", OpKind::Upsert, &[("name", "手機改的".into())]),
                    mk_op(
                        &phone_hlc,
                        "nodes",
                        "N2",
                        OpKind::Upsert,
                        &[("deleted_at", "2026-09-20T10:00:00.000Z".into())],
                    ),
                ],
            );
            let r = apply_object(&desk, &phone, "k1", "dev-desk").await.unwrap();

            assert_eq!(
                text(&desk, "SELECT name FROM nodes WHERE id='N1'").await.as_deref(),
                Some("手機改的"),
                "較晚改的要贏——舊行為是快照戳「現在」、把手機那邊的修改整包蓋回去"
            );
            assert!(
                text(&desk, "SELECT deleted_at FROM nodes WHERE id='N2'").await.is_some(),
                "刪除要生效——舊行為是新身分 seen 為空、每格都算併發 ⇒ 刪除被「編輯勝刪除」擋下來、票復活"
            );
            assert_eq!(r.conflicts, 0, "對方拉過我這一版了，不是真併發 ⇒ 零噪音");

            // ③ 第三步：快照。甲票的 name 帶的是手機那一版的戳，不會再把舊值推回去
            let n = snapshot_into_outbox(&desk, "dev-desk").await.unwrap();
            assert!(n >= 2);
            // 最大的那一筆才是 name 自己那一格的 op（最小的那筆會借一份 name 當必填欄，見 `group`）
            let name_hlc = text(
                &desk,
                "SELECT MAX(hlc) FROM sync_outbox WHERE row_id='N1' AND payload LIKE '%手機改的%'",
            )
            .await;
            assert_eq!(
                name_hlc.as_deref(),
                Some(phone_hlc.as_str()),
                "快照帶的是那一格真正的最後修改時刻"
            );
            // 沙盒壬8 的回歸：拆開之後，**最小 hlc 那一筆**要帶齊必填欄，收到方才建得起這一列
            let first = text(
                &desk,
                "SELECT payload FROM sync_outbox WHERE row_id='N1' ORDER BY hlc LIMIT 1",
            )
            .await
            .unwrap();
            assert!(
                first.contains("\"kind\"") && first.contains("\"name\""),
                "第一筆要帶得起整列（kind／name 都在）：{first}"
            );

            drop_pool(desk, path).await;
        });
    }

    /// v1.1.3 §5.6「拆得開即承認」：對的資料鑰匙 ⇒ 承認；別的密語建的 ⇒ 拆不開（呼叫端記成鍵違い）；
    /// 拆得開但 `epoch` 欄與目錄名不符 ⇒ 當沒看到（寫壞的標記不該讓別台整批換紀元）。
    #[test]
    fn 紀元偵測_拆得開即承認_不再比對正本() {
        let root = "v1-sb-test";
        let epoch = "1758153600001";
        let data_key = crypto::random_data_key().unwrap();
        let other_key = crypto::random_data_key().unwrap();
        let info = EpochInfo {
            version: EPOCH_INFO_VERSION,
            epoch: epoch.into(),
            // 「別台開的」——v1.1.2 會因為 opener 不是我認得的正本而忽略，v1.1.3 照樣承認
            opener_device_id: "dev-someone-else".into(),
            created_at: "2026-09-20T03:12:00.000Z".into(),
            reason: "restore".into(),
            label: Some("next-stop-v2_2026-09-20_0312_manual.db".into()),
        };
        let marker = epoch_marker_key(root, epoch);
        assert_eq!(marker, "v1-sb-test/1758153600001/EPOCH.bin");
        let blob = crypto::seal(&data_key, &marker, &serde_json::to_vec(&info).unwrap()).unwrap();

        let got = epoch_marker_verdict(root, epoch, &data_key, &blob).expect("拆得開就要承認");
        assert_eq!(got.opener_device_id, "dev-someone-else");
        assert_eq!(got.label.as_deref(), Some("next-stop-v2_2026-09-20_0312_manual.db"));
        assert!(
            epoch_marker_verdict(root, epoch, &other_key, &blob).is_none(),
            "別的密語建的＝拆不開＝鍵違い"
        );
        assert!(
            epoch_marker_verdict(root, "1758153600002", &data_key, &blob).is_none(),
            "AAD 綁物件 key，換目錄名就拆不開"
        );
        // 拆得開、但內容裡的 epoch 與目錄名不符（寫壞的標記）
        let mut bad = info.clone();
        bad.epoch = "9999999999999".into();
        let blob2 = crypto::seal(&data_key, &marker, &serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(epoch_marker_verdict(root, epoch, &data_key, &blob2).is_none());
    }

    /// v1.1.3 §2.1／§4.4：改密語只重寫 `<root>/KEY` 一顆物件——**舊的資料物件照樣拆得開**
    /// （它們是資料鑰匙加密的，密語只包著資料鑰匙），所以「資料不重傳、其他裝置不受影響」。
    #[test]
    fn 改密語後舊物件仍可解_且舊密語打不開新的_key() {
        let root = "v1";
        let key_obj = key_object_key(root);
        assert_eq!(key_obj, "v1/KEY");
        assert_eq!(salt_object_key(root), "v1/SALT");

        let data_key = crypto::random_data_key().unwrap();
        // 這一顆是「改密語之前」就上傳的資料物件
        let obj_key = "v1/1758153600000/dev-a/17581536000000000-dev-a.bin";
        let plain = b"{\"version\":1,\"ops\":[]}";
        let blob = crypto::seal(&data_key, obj_key, plain).unwrap();

        // 舊密語封的 KEY
        let salt_a = crypto::random_salt().unwrap();
        let wrap_a = crypto::derive_key("月見坂 3 番線", &salt_a).unwrap();
        let sealed_a = crypto::wrap_data_key(&wrap_a, &key_obj, &data_key, &salt_a).unwrap();
        assert_eq!(
            crypto::unwrap_data_key(&wrap_a, &key_obj, &sealed_a).unwrap(),
            data_key
        );

        // 改密語＝新鹽＋新密語，包**同一把**資料鑰匙
        let salt_b = crypto::random_salt().unwrap();
        let wrap_b = crypto::derive_key("ひかり号 1 番線", &salt_b).unwrap();
        let sealed_b = crypto::wrap_data_key(&wrap_b, &key_obj, &data_key, &salt_b).unwrap();
        let reopened = crypto::unwrap_data_key(&wrap_b, &key_obj, &sealed_b).unwrap();
        assert_eq!(reopened, data_key, "資料鑰匙一個位元都沒變");
        assert_eq!(
            crypto::open(&reopened, obj_key, &blob).unwrap(),
            plain.to_vec(),
            "改密語之前上傳的物件照樣拆得開＝資料不必重傳"
        );
        assert!(
            crypto::unwrap_data_key(&wrap_a, &key_obj, &sealed_b).is_err(),
            "舊密語打不開新的 KEY"
        );

        // 舊血統（v1.1.2）：資料鑰匙本身＝argon2id(密語, SALT)。升級後它**就是**資料鑰匙（§7 ①），
        // 用新密語重包之後，舊物件一樣拆得開——主人不必重配、不必重傳。
        let lineage_salt = crypto::random_salt().unwrap();
        let legacy = crypto::derive_key("舊密語", &lineage_salt).unwrap();
        let legacy_blob = crypto::seal(&legacy, obj_key, b"legacy").unwrap();
        let kdf_salt = crypto::random_salt().unwrap();
        let sealed_legacy = crypto::wrap_data_key(
            &crypto::derive_key("新密語", &kdf_salt).unwrap(),
            &key_obj,
            &legacy,
            &kdf_salt,
        )
        .unwrap();
        let carried = crypto::b64_decode(&crypto::parse_wrapped_key(&sealed_legacy).unwrap().salt).unwrap();
        assert_eq!(carried, kdf_salt.to_vec(), "KEY 自帶 kdf 鹽（不共用 SALT，§2.1）");
        let back = crypto::unwrap_data_key(
            &crypto::derive_key("新密語", &carried).unwrap(),
            &key_obj,
            &sealed_legacy,
        )
        .unwrap();
        assert_eq!(back, legacy);
        assert_eq!(crypto::open(&back, obj_key, &legacy_blob).unwrap(), b"legacy".to_vec());
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

    // ── v1.1.3 契約席 stub 的純函式（§2.2 EPOCH.bin v2、§4.5 標記檔、§4.6 配對碼 v2、§4.3 pending_span）──

    #[test]
    fn 還原標記_json_與舊純字串都解得開() {
        let (c, l) = parse_restore_marker("2026-09-20T01:02:03.000Z");
        assert_eq!(c, RestoreChoice::Past, "v1.1.2 的純字串標記＝回到過去");
        assert!(l.is_none());
        let (c, l) = parse_restore_marker(
            r#"{"at":"2026-09-21T00:00:00.000Z","choice":"present","label":"next-stop-v2_2026-09-20_0312_manual.db"}"#,
        );
        assert_eq!(c, RestoreChoice::Present);
        assert_eq!(l.as_deref(), Some("next-stop-v2_2026-09-20_0312_manual.db"));
        let (c, l) = parse_restore_marker(r#"{"at":"x","choice":"past","label":""}"#);
        assert_eq!(c, RestoreChoice::Past);
        assert!(l.is_none(), "空 label 當沒有");
    }

    #[test]
    fn 配對碼_v1_v2_都解得開_且_v2_不帶鹽與身分() {
        let v1 = serde_json::json!({
            "v": 1, "endpoint": "https://x.r2.cloudflarestorage.com", "bucket": "b", "ak": "AK", "sk": "SK",
            "salt": "AAAAAAAAAAAAAAAAAAAAAA", "epoch": "1758153600000", "primary_device_id": "dev"
        });
        let f = decode_pairing_code(&crypto::b64_encode(&serde_json::to_vec(&v1).unwrap())).unwrap();
        assert_eq!(f.root, "v1", "v1 沒有 root ⇒ 預設");
        assert_eq!(f.epoch.as_deref(), Some("1758153600000"));
        assert_eq!(f.access_key_id, "AK");

        let v2 = serde_json::json!({
            "v": 2, "endpoint": "https://x", "bucket": "b", "ak": "AK", "sk": "SK", "root": "v1-sb-abc", "epoch": "1"
        });
        let f = decode_pairing_code(&crypto::b64_encode(&serde_json::to_vec(&v2).unwrap())).unwrap();
        assert_eq!(f.root, "v1-sb-abc");

        let v3 = serde_json::json!({"v": 3, "endpoint": "e", "bucket": "b", "ak": "a", "sk": "s"});
        assert!(decode_pairing_code(&crypto::b64_encode(&serde_json::to_vec(&v3).unwrap())).is_err());
        assert!(decode_pairing_code("not-a-code").is_err());

        let s = serde_json::to_string(&PairingCode {
            v: PAIRING_CODE_VERSION,
            endpoint: "e".into(),
            bucket: "b".into(),
            ak: "a".into(),
            sk: "s".into(),
            root: Some("v1".into()),
            epoch: None,
        })
        .unwrap();
        assert!(!s.contains("salt") && !s.contains("primary_device_id"), "配對碼不再是身分來源：{s}");
    }

    #[test]
    fn epoch_info_v1_物件仍讀得到() {
        let v1 = r#"{"version":1,"epoch":"1758153600000","primary_device_id":"dev-a","created_at":"2026-09-20T00:00:00.000Z","reason":"restore"}"#;
        let info: EpochInfo = serde_json::from_str(v1).unwrap();
        assert_eq!(info.opener_device_id, "dev-a", "舊欄名 primary_device_id 要 alias 成 opener");
        assert!(info.label.is_none());
        let v2 = serde_json::to_string(&EpochInfo {
            version: EPOCH_INFO_VERSION,
            epoch: "1".into(),
            opener_device_id: "me".into(),
            created_at: "t".into(),
            reason: "first".into(),
            label: None,
        })
        .unwrap();
        assert!(v2.contains("\"opener_device_id\""));
    }

    #[test]
    fn hlc_轉時刻() {
        assert_eq!(iso_of_hlc("17581536001230000-3f9c2b1e"), "2025-09-18T00:00:00.123Z");
        assert_eq!(iso_of_hlc("nope"), "");
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
    // ─────────────────────────────────────────────────────────
    // v1.1.4 掃地工與鑰匙輪替（契約 §4.5／§5；沙盒癸4／癸6／癸7／癸8／癸10 的引擎面）
    // ─────────────────────────────────────────────────────────

    /// 契約 §4.5：只刪「數字 < 目前紀元」而且「不在最近 keep 個」的紀元。
    /// 比我大的（別台剛開的新紀元）與我自己**永遠**不刪——刪了等於把還沒收斂的那台的資料清掉。
    #[test]
    fn 掃地工_只刪比我小且不在保護區的紀元() {
        // 由大到小，就是 `list_epochs` 的輸出形狀
        let epochs = [50u64, 40, 30, 20, 10];
        // 目前紀元＝50、keep=2 ⇒ 保護 50／40，其餘三個都比我小 ⇒ 刪
        assert_eq!(sweep_victims(&epochs, 50, SWEEP_KEEP_DEFAULT), vec![30, 20, 10]);
        // 輪替用 keep=1 ⇒ 只保護 E2，連前一個都刪（契約 §5 步驟 6）
        assert_eq!(sweep_victims(&epochs, 50, 1), vec![40, 30, 20, 10]);
        // 我還停在 30（改正待ち沒按）：40／50 比我大 ⇒ 一顆都不動
        assert_eq!(sweep_victims(&epochs, 30, 2), vec![20, 10]);
        // 我停在最小那個 ⇒ 沒有比我更小的可刪
        assert!(sweep_victims(&epochs, 10, 2).is_empty());
        // keep 大於總數 ⇒ 全保護
        assert!(sweep_victims(&epochs, 50, 9).is_empty());
        // 冪等：掃完之後再跑一次＝空
        assert!(sweep_victims(&[50u64, 40], 50, SWEEP_KEEP_DEFAULT).is_empty());
    }

    /// 契約 §5.3／§5.4：標記檔 JSON 往返，而「回滾還是續跑」的判準就是階段序（提交點＝`committed`）。
    #[test]
    fn 輪替標記檔_json往返_且提交點之前才回滾() {
        let m = RotationMarker {
            at: "2026-09-22T05:00:00.000Z".into(),
            old_epoch: "1758153600000".into(),
            new_epoch: "1758153600001".into(),
            stage: RotationStage::Committed,
            key_object_b64: None,
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains("\"stage\":\"committed\""), "階段是 snake_case 字面值：{s}");
        let back: RotationMarker = serde_json::from_str(&s).unwrap();
        assert_eq!(back.old_epoch, "1758153600000");
        assert_eq!(back.new_epoch, "1758153600001");
        assert_eq!(back.stage, RotationStage::Committed);
        assert_eq!(back.stage.as_str(), "committed");

        // 提交點之前＝新密語還沒存進桶裡，續跑也拆不開 ⇒ 一律回滾
        for st in [RotationStage::Prepared, RotationStage::Locked] {
            assert!(st.before_commit(), "{} 要回滾", st.as_str());
        }
        // 提交點之後＝新密語已經在桶裡（不再需要它）⇒ 4–7 冪等續跑
        for st in [
            RotationStage::Committed,
            RotationStage::Switched,
            RotationStage::Reencrypted,
            RotationStage::Swept,
        ] {
            assert!(!st.before_commit(), "{} 要續跑", st.as_str());
        }
        // v1.1.4 修正席（工程評審 B-3）：`committing`＝「指紋已寫、PUT 生死未卜」，
        // 它**不算**提交點之前（要拿指紋去問桶裡那顆 KEY 才知道該回滾還是續跑），也不算已提交。
        assert!(!RotationStage::Committing.before_commit());
        assert_eq!(RotationStage::Committing.as_str(), "committing");
        let committing = RotationMarker {
            at: "2026-09-22T05:00:00.000Z".into(),
            old_epoch: "1758153600000".into(),
            new_epoch: "1758153600001".into(),
            stage: RotationStage::Committing,
            key_object_b64: Some("Zm9vYmFy".into()),
        };
        let s2 = serde_json::to_string(&committing).unwrap();
        let back2: RotationMarker = serde_json::from_str(&s2).unwrap();
        assert_eq!(back2.key_object_b64.as_deref(), Some("Zm9vYmFy"));
        // 舊版標記（沒有那一欄）讀得回來、指紋是 None ⇒ 保守回滾
        let legacy: RotationMarker = serde_json::from_str(
            r#"{"at":"2026-09-22T05:00:00.000Z","old_epoch":"1","new_epoch":"2","stage":"committing"}"#,
        )
        .unwrap();
        assert!(legacy.key_object_b64.is_none());

        // 續跑的「跳過已完成的步」靠階段序遞增
        let order = [
            RotationStage::Prepared,
            RotationStage::Locked,
            RotationStage::Committing,
            RotationStage::Committed,
            RotationStage::Switched,
            RotationStage::Reencrypted,
            RotationStage::Swept,
        ];
        for w in order.windows(2) {
            assert!(w[0].rank() < w[1].rank(), "{} 要排在 {} 前面", w[0].as_str(), w[1].as_str());
        }
        // 解不開的標記（舊版／寫到一半）＝當成「沒在換」，phase 不會卡在換鑰匙中
        assert!(serde_json::from_str::<RotationMarker>("{\"stage\":\"nope\"}").is_err());
        assert!(serde_json::from_str::<RotationMarker>("{\"at\":\"t\"").is_err());
    }

    /// 契約 §2／§5.4：`ROTATED` 要容忍空物件與壞 JSON（拍板原句是「明文空物件」），
    /// 但**回滾只刪自己寫的那一顆**——不知道是誰寫的就不敢刪（E2 這個號碼兩台會算出同一個）。
    #[test]
    fn rotated旗標_空物件與壞json也算旗標_但不算是自己的() {
        assert_eq!(
            rotated_flag_key("v1-sb-test", "1758153600001"),
            "v1-sb-test/1758153600001/ROTATED"
        );
        let mine = parse_rotated_flag(br#"{"device_id":"dev-a","at":"2026-09-22T05:00:00.000Z"}"#);
        assert_eq!(mine.device_id, "dev-a");
        assert_eq!(mine.at, "2026-09-22T05:00:00.000Z");
        for raw in [&b""[..], b"{}", b"not json at all", b"{\"device_id\":123}"] {
            let f = parse_rotated_flag(raw);
            assert!(f.device_id.is_empty(), "解不出來＝不是自己的 ⇒ 回滾不刪它");
            assert!(f.at.is_empty());
        }
    }

    /// 契約 §4.3：`locked_reason` 跟著 `locked` 一起被「紀元範圍清除句」清掉；
    /// 而 `skipped_missing_total`／`last_cloud_snapshot_*` 是跨紀元累計的，**不能**跟著清。
    #[test]
    fn 紀元範圍meta_連locked_reason一起清_但累計值留著() {
        tauri::async_runtime::block_on(async {
            let (pool, path) = make_pool("epoch-meta").await;
            for (k, v) in [
                ("locked", "1758153600002"),
                ("locked_reason", "rotated"),
                ("last_pull_key:dev-a", "x"),
                ("skipped_missing_total", "3"),
                ("last_cloud_snapshot_at", "2026-09-22T05:00:00Z"),
                ("last_cloud_snapshot_day", "2026-09-22"),
                ("epoch", "1758153600001"),
            ] {
                meta_set(&pool, k, v).await.unwrap();
            }
            sqlx::query(EPOCH_SCOPED_META).execute(&pool).await.unwrap();
            let meta = meta_all(&pool).await.unwrap();
            assert!(!meta.contains_key("locked"));
            assert!(!meta.contains_key("locked_reason"), "沒有主詞的原因不該留著");
            assert!(!meta.contains_key("last_pull_key:dev-a"));
            assert_eq!(meta.get("skipped_missing_total").map(String::as_str), Some("3"));
            assert_eq!(
                meta.get("last_cloud_snapshot_at").map(String::as_str),
                Some("2026-09-22T05:00:00Z")
            );
            assert_eq!(meta.get("last_cloud_snapshot_day").map(String::as_str), Some("2026-09-22"));
            assert_eq!(meta.get("epoch").map(String::as_str), Some("1758153600001"));
            drop_pool(pool, path).await;
        });
    }

    /// 契約 §4.2（沙盒癸10 的引擎面）：必填欄不齊的**新列**另計 `skipped_missing`。
    /// 為什麼要跟一般的 `skipped` 分開：游標推過去之後這種列永遠不會再來一次，
    /// 跟「較舊的 op 被 LWW 判掉」是完全不同的事——前者是靜默掉資料，主人有權知道。
    #[test]
    fn skipped_missing_必填欄不齊的新列另計() {
        tauri::async_runtime::block_on(async {
            let (dst, path) = make_pool("skip-missing").await;
            let ops = vec![
                // nodes 缺 `name`
                mk_op(
                    "17581536000000010-aaaaaaaa",
                    "nodes",
                    "BAD",
                    OpKind::Upsert,
                    &[("kind", "train".into())],
                ),
                // work_logs 缺 `body`
                mk_op(
                    "17581536000000011-aaaaaaaa",
                    "work_logs",
                    "W",
                    OpKind::Upsert,
                    &[
                        ("node_id", "OK".into()),
                        ("logged_at", "2026-09-18T00:00:00.000Z".into()),
                    ],
                ),
                // 齊的那一筆照建
                mk_op(
                    "17581536000000012-aaaaaaaa",
                    "nodes",
                    "OK",
                    OpKind::Upsert,
                    &[("kind", "train".into()), ("name", "好的".into())],
                ),
            ];
            let r = apply(&dst, &make_obj("dev-a", ops), "k1").await;
            assert_eq!(r.skipped_missing, 2, "兩筆缺必填欄");
            assert_eq!(r.applied, 1);
            assert_eq!(r.skipped, 2, "它們同時也算一般的跳過（`skipped_ops` 照舊）");
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM nodes").await, 1);
            assert_eq!(count(&dst, "SELECT COUNT(*) FROM work_logs").await, 0);
            drop_pool(dst, path).await;
        });
    }

    /// 契約 §5：輪替之後**舊鑰匙拆不開任何新東西**（純密碼學面，不打網路；沙盒癸4／癸6 的核心斷言）。
    #[test]
    fn 輪替後_舊鑰匙拆不開新紀元與重包的key與重加密的快照() {
        let root = "v1-sb-test";
        let k1 = crypto::random_data_key().unwrap();
        let k2 = crypto::random_data_key().unwrap();
        let (old_pass, new_pass) = ("月見坂 3 番線", "ひかり号 1 番線");
        let key_obj = key_object_key(root);

        // 輪替前：KEY＝舊密語包 K1
        let salt_a = crypto::random_salt().unwrap();
        let wrap_a = crypto::derive_key(old_pass, &salt_a).unwrap();
        let sealed_a = crypto::wrap_data_key(&wrap_a, &key_obj, &k1, &salt_a).unwrap();
        assert_eq!(crypto::unwrap_data_key(&wrap_a, &key_obj, &sealed_a).unwrap(), k1);

        // 步驟 3（提交點）：同一顆 KEY 覆蓋成「**新**密語包 K2」
        let salt_b = crypto::random_salt().unwrap();
        let wrap_b = crypto::derive_key(new_pass, &salt_b).unwrap();
        let sealed_b = crypto::wrap_data_key(&wrap_b, &key_obj, &k2, &salt_b).unwrap();
        assert_eq!(crypto::unwrap_data_key(&wrap_b, &key_obj, &sealed_b).unwrap(), k2);
        assert!(
            crypto::unwrap_data_key(&wrap_a, &key_obj, &sealed_b).is_err(),
            "癸6：舊密語打不開新的 KEY ⇒ 第三台加不進來"
        );

        // 步驟 2：E2 的 EPOCH.bin 用 K2 封 ⇒ 還拿著 K1 的那台「拆不開」＝鍵違い
        let e2 = "1758153600002";
        let marker = epoch_marker_key(root, e2);
        let info = EpochInfo {
            version: EPOCH_INFO_VERSION,
            epoch: e2.into(),
            opener_device_id: "dev-a".into(),
            created_at: "2026-09-22T05:00:00.000Z".into(),
            reason: "rotate".into(),
            label: None,
        };
        let blob = crypto::seal(&k2, &marker, &serde_json::to_vec(&info).unwrap()).unwrap();
        assert!(epoch_marker_verdict(root, e2, &k2, &blob).is_some());
        assert!(
            epoch_marker_verdict(root, e2, &k1, &blob).is_none(),
            "舊鑰匙拆不開＝locked（旗標在就分流成 locked_reason=rotated）"
        );

        // 步驟 5：快照重加密（同一把鍵、K1 拆 → K2 封）⇒ K1 再也拆不開＝真撤銷
        let snap_key = crate::sync::snapshot::snapshot_key(
            root,
            chrono::Utc::now(),
            "dev-a",
            crate::sync::snapshot::SnapshotKind::Manual,
        );
        let plain = br#"{"schema":4,"nodes":[]}"#;
        let old_blob = crypto::seal(&k1, &snap_key, plain).unwrap();
        let reopened = crypto::open(&k1, &snap_key, &old_blob).unwrap();
        let new_blob = crypto::seal(&k2, &snap_key, &reopened).unwrap();
        assert_eq!(crypto::open(&k2, &snap_key, &new_blob).unwrap(), plain.to_vec());
        assert!(
            crypto::open(&k1, &snap_key, &new_blob).is_err(),
            "重加密之後舊鑰匙拆不開"
        );
        // 冪等：已經是 K2 封的，再跑一次會先用 K2 試拆 ⇒ 跳過（不會被 K1 誤拆成壞資料）
        assert!(crypto::open(&k2, &snap_key, &new_blob).is_ok());
    }

    /// 輪替的沙盒根：`v1-sb-0922a-<亂數>`（契約 §0 鐵則 2——只碰 `v1-sb-0922*`，與主人正本的 `v1/` 平級）
    fn rotation_sandbox_root() -> String {
        let mut stamp = [0u8; 6];
        crypto::fill_random(&mut stamp).unwrap();
        format!("v1-sb-0922a-{}", crypto::b64_encode(&stamp))
    }

    /// v1.1.4 沙盒癸4／癸5／癸6／癸8 的**桶面**整合測（打真的 R2）：
    /// 兩台同紀元 → A 走輪替七步的桶面動作 → B（還拿著 K1）＝`locked_reason=rotated`
    /// → 舊密語拆不開 KEY（第三台加不進來）→ 桶裡除了 SALT／KEY／ROTATED，K1 一顆都拆不開 → 舊紀元清光。
    ///
    /// 跑法（Git Bash）：
    /// ```text
    /// set -a && source "$LOCALAPPDATA/NextStop/r2.env" && set +a
    /// cargo test --lib sync::engine::tests::輪替七步 -- --ignored --nocapture
    /// ```
    /// 鐵則：全部物件都在**自己的沙盒根** `v1-sb-0922a-<亂數>/` 底下（與主人正本的 `v1/` 平級、
    /// 互相 list 不到），收工逐一刪光；憑證一個字都不印。
    /// `rotate_data_key()` 本身要 `AppHandle`＋鑰匙圈（單元測試裡拿不到），這支走的是它內部的同一組零件
    ///（`put_if_absent`／`put_epoch_marker`／`seal_key_object`／`switch_epoch_local`／`push_loop`／
    /// `record_epoch_scan`／`sweep_old_epochs`）——`AppHandle` 那一層歸沙盒席的癸4–癸7。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 輪替七步_桶面_舊鑰匙全拆不開_舊紀元清光() {
        tauri::async_runtime::block_on(async {
            let client = sandbox_client();
            let root = rotation_sandbox_root();
            let (old_pass, new_pass) = ("月見坂 3 番線 2026", "ひかり号 1 番線 2026");
            let (dev_a, dev_b) = ("dev-rot-a", "dev-rot-b");

            // ── 前置：A、B 同一個紀元 E1，各推一批 ──
            let k1 = crypto::random_data_key().unwrap();
            let salt_b64 = crypto::b64_encode(&crypto::random_salt().unwrap());
            client
                .put(&salt_object_key(&root), salt_b64.as_bytes().to_vec())
                .await
                .unwrap();
            seal_key_object(&client, &root, old_pass, &k1).await.unwrap();
            let e1 = hlc::now_ms().to_string();
            put_epoch_marker(&client, &k1, &root, &e1, dev_a, "first", None)
                .await
                .unwrap();

            let (pool_a, path_a) = make_pool("rot-a").await;
            let (pool_b, path_b) = make_pool("rot-b").await;
            for (pool, dev) in [(&pool_a, dev_a), (&pool_b, dev_b)] {
                seed_tree(pool).await;
                meta_set(pool, "epoch", &e1).await.unwrap();
                meta_set(pool, "device_id", dev).await.unwrap();
                meta_set(pool, "joined", "1").await.unwrap();
                stamp_all(pool, dev).await;
                snapshot_into_outbox(pool, dev).await.unwrap();
                push_loop(pool, &client, &k1, &root, &e1, dev).await.unwrap();
            }

            // ── 步驟 0.5：A 先拍一份 K1 封的雲端快照（輪替前留底；步驟 5 會把它重加密）──
            let snap = put_cloud_snapshot(
                &pool_a,
                &client,
                &k1,
                &root,
                dev_a,
                crate::sync::snapshot::SnapshotKind::Manual,
            )
            .await
            .unwrap();
            assert!(snap.key.starts_with(&snapshots_prefix(&root)), "{}", snap.key);
            assert!(
                crypto::open(&k1, &snap.key, &client.get(&snap.key).await.unwrap()).is_ok(),
                "這時還是 K1 封的"
            );

            // B 事前留一筆沒送出的修改（癸5：重新加入時要一起併進來）
            local_op(
                &pool_b,
                dev_b,
                "T1",
                "name",
                "還沒送出的改名",
                &format!("{}0000-bbbbbbbb", hlc::now_ms()),
            )
            .await;

            // ── 步驟 1–2：E2＝max+1；`put_if_absent ROTATED` 當鎖；EPOCH.bin 用 K2 封 ──
            let k2 = crypto::random_data_key().unwrap();
            let e2 = list_epochs(&client, &root)
                .await
                .unwrap()
                .first()
                .copied()
                .unwrap()
                .saturating_add(1)
                .to_string();
            let flag = rotated_flag_key(&root, &e2);
            let body = serde_json::json!({ "device_id": dev_a, "at": now_iso() }).to_string();
            assert!(
                client.put_if_absent(&flag, body.into_bytes()).await.unwrap(),
                "第一台拿得到鎖"
            );
            assert!(
                !client.put_if_absent(&flag, b"{}".to_vec()).await.unwrap(),
                "第二台撞鎖＝「另一台正在換鑰匙」"
            );
            assert_eq!(
                parse_rotated_flag(&client.get(&flag).await.unwrap()).device_id,
                dev_a,
                "旗標還是第一台寫的那份（條件寫沒被蓋掉）"
            );
            put_epoch_marker(&client, &k2, &root, &e2, dev_a, "rotate", None)
                .await
                .unwrap();

            // 這時 E2 底下還沒有裝置目錄 ⇒ 別台的掃描要「當成還在寫、跳過」（既有規則 S-3(c)）
            assert!(matches!(
                scan_new_epoch(&client, &k1, &root, &e1).await.unwrap(),
                EpochScan::None
            ));
            // v1.1.4 修正席（工程評審 B-1／B-2／S-7 的共用守門）：**鎖一掛上去，舊鑰匙就不算數了**。
            // `scan_new_epoch` 這時還刻意看不到 E2（它沒有裝置目錄），但 `rotated_elsewhere` 看得到——
            // 三條毀滅性的路（改密語重包 KEY／join 的舊血統自癒／還原「回到過去」開新紀元）
            // 正是在這個窗口裡最容易把 K2 蓋掉，所以它的判準只有「旗標在 ∧ 我拆不開」，不看裝置目錄。
            assert_eq!(
                rotated_elsewhere(&client, &root, &k1, Some(&e1)).await.unwrap().as_deref(),
                Some(e2.as_str()),
                "舊鑰匙看得到「別台換過鑰匙」"
            );
            assert!(
                rotated_elsewhere(&client, &root, &k2, Some(&e1)).await.unwrap().is_none(),
                "新鑰匙拆得開 E2 ⇒ 不該把換鑰匙的那台自己擋住"
            );

            // ── 步驟 3：PUT KEY＝新密語包 K2（提交點）──
            seal_key_object(&client, &root, new_pass, &k2).await.unwrap();
            let key_bytes = client.get(&key_object_key(&root)).await.unwrap();
            assert_eq!(
                unseal_key_object(&root, new_pass, &key_bytes).await.unwrap(),
                k2,
                "新密語拆得出 K2"
            );
            assert!(
                unseal_key_object(&root, old_pass, &key_bytes).await.is_err(),
                "癸6：舊密語打不開＝第三台用舊密語加不進來"
            );

            // ── 步驟 4：A 本機切到 E2／K2，全量快照用 K2 推到 E2 ──
            let creds = SyncCredentials {
                endpoint: String::new(),
                bucket: String::new(),
                access_key_id: String::new(),
                secret_access_key: String::new(),
                root: root.clone(),
                data_key_b64: crypto::b64_encode(&k1),
                salt_b64: Some(salt_b64.clone()),
                device_id: Some(dev_a.to_string()),
                data_key_next_b64: Some(crypto::b64_encode(&k2)),
            };
            switch_epoch_local(&pool_a, &creds, dev_a, dev_a, &e2).await.unwrap();
            snapshot_into_outbox(&pool_a, dev_a).await.unwrap();
            assert!(
                push_loop(&pool_a, &client, &k2, &root, &e2, dev_a)
                    .await
                    .unwrap()
                    .pushed_ops
                    > 0
            );
            assert_eq!(
                text(&pool_a, "SELECT value FROM sync_meta WHERE key='epoch'").await.as_deref(),
                Some(e2.as_str())
            );

            // ── 別台（B，還拿著 K1）：拆不開的新紀元＋ROTATED ⇒ `locked_reason=rotated` ──
            let scan = scan_new_epoch(&client, &k1, &root, &e1).await.unwrap();
            assert!(matches!(&scan, EpochScan::Locked(v) if v.first().map(String::as_str) == Some(e2.as_str())), "{scan:?}");
            assert!(record_epoch_scan(&pool_b, &client, &root, scan).await.unwrap());
            let meta_b = meta_all(&pool_b).await.unwrap();
            assert_eq!(meta_b.get("locked").map(String::as_str), Some(e2.as_str()));
            assert_eq!(
                meta_b.get("locked_reason").map(String::as_str),
                Some("rotated"),
                "有 ROTATED ⇒ 文案走「已在另一台換過鑰匙」"
            );

            // ── 步驟 5：重加密 `snapshots/`（正式路徑委託 `snapshot::reencrypt_all`；
            //    WP-B 還沒落地時用本地替身跑同一套語義，好讓這支測試自己站得住）──
            let reencrypted = match crate::sync::snapshot::reencrypt_all(&client, &root, &k1, &k2).await {
                Ok(n) => n,
                Err(_) => {
                    let mut n = 0u64;
                    for (k, _) in client.list_objects(&snapshots_prefix(&root)).await.unwrap() {
                        let blob = client.get(&k).await.unwrap();
                        if crypto::open(&k2, &k, &blob).is_ok() {
                            continue; // 已經是新鑰匙封的＝冪等跳過
                        }
                        let plain = crypto::open(&k1, &k, &blob).unwrap();
                        client.put(&k, crypto::seal(&k2, &k, &plain).unwrap()).await.unwrap();
                        n += 1;
                    }
                    n
                }
            };
            assert_eq!(reencrypted, 1, "只有步驟 0.5 那一顆");

            // ── 步驟 6：掃地工 keep=1 ⇒ E1 整顆不見、E2 留著；再跑一次＝0（冪等）──
            assert_eq!(sweep_old_epochs(&client, &root, &e2, 1).await.unwrap(), 1);
            assert!(
                client.list_after(&format!("{root}/{e1}/"), "").await.unwrap().is_empty(),
                "E1 一顆都不剩"
            );
            assert_eq!(
                list_epochs(&client, &root).await.unwrap(),
                vec![e2.parse::<u64>().unwrap()]
            );
            assert_eq!(sweep_old_epochs(&client, &root, &e2, 1).await.unwrap(), 0);

            // ── 驗收：桶裡除了 SALT／KEY／ROTATED（都是明文），K1 一顆都拆不開 ──
            let mut checked = 0;
            for k in client.list_after(&format!("{root}/"), "").await.unwrap() {
                if k == salt_object_key(&root) || k == key_object_key(&root) || k.ends_with("/ROTATED") {
                    continue;
                }
                let blob = client.get(&k).await.unwrap();
                assert!(crypto::open(&k1, &k, &blob).is_err(), "舊鑰匙還拆得開：{k}");
                assert!(crypto::open(&k2, &k, &blob).is_ok(), "新鑰匙要拆得開：{k}");
                checked += 1;
            }
            assert!(checked >= 3, "至少 EPOCH.bin＋一顆 oplog 物件＋一顆快照，實際 {checked}");

            // ── 癸5 的機械面：B 用**新**密語重新加入＝解 KEY 得 K2、目前紀元＝E2、那筆沒送出的還在 ──
            let reopened = unseal_key_object(&root, new_pass, &client.get(&key_object_key(&root)).await.unwrap())
                .await
                .unwrap();
            assert_eq!(reopened, k2);
            assert_eq!(
                resolve_current_epoch(&client, &reopened, &root).await.unwrap().as_deref(),
                Some(e2.as_str())
            );
            assert_eq!(
                count(&pool_b, "SELECT COUNT(*) FROM sync_outbox").await,
                1,
                "B 那一筆還沒送出的修改還在（重新加入選「兩邊都保留」會併進去）"
            );

            // ── 收工：沙盒根刪光（鐵則：先列鍵再逐顆刪、只印鍵名；圍籬再確認一次）──
            for k in client.list_after(&format!("{root}/"), "").await.unwrap() {
                assert!(k.starts_with("v1-sb-0922"), "只刪自己的沙盒根：{k}");
                eprintln!("[test:cleanup] delete {k}");
                client.delete(&k).await.unwrap();
            }
            assert!(client.list_after(&format!("{root}/"), "").await.unwrap().is_empty());
            drop_pool(pool_a, path_a).await;
            drop_pool(pool_b, path_b).await;
        });
    }
}
