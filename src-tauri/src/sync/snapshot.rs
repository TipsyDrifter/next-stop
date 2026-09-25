//! 雲端快照——上傳／列表／階梯清理／JSON 匯入／雲端還原／匯出到手機（v1.1.4 **WP-B**；契約席 2026-09-22 立骨架）。
//!
//! 拍板：`docs/決策記錄.md`〈v1.1.4 開工拍板〉D-1（階梯稀釋）／D-2（兩殼同一套還原 UI）＋自決（Android 匯出走 SAF）；
//!       規格＝`docs/research/2026-09-22-v1.1.4-雲端備份與真撤銷契約.md` §2（桶內佈局）／§3（匯入規則）／§4（command）。
//!
//! 為什麼另立一支而不塞進 `engine.rs`：手機沒有 `backup.rs`（`#[cfg(not(mobile))]`），雲端快照兩殼都要，
//! 所以不能掛在 backup 模組；而 engine.rs 已經六千行、WP-A 同時要改它（輪替＋掃地工＋小尾巴）——
//! 拆開才做得到三席零重疊。本檔只跟 engine 借零件（`keyed_client`／`build_full_json`／`stamp_missing_cells`／
//! `restore_choice`＋`mark_restore_pending`），**不動 engine.rs**。
//!
//! 機制摘要（契約 §2／§3）：
//!   * 物件鍵 `<root>/snapshots/<UTC戳 YYYYMMDDTHHMMSSZ>_<device_id>_<auto|manual>.bin`；內容＝
//!     `engine::build_full_json` 那份 JSON 用**目前資料鑰匙** `crypto::seal`（AAD＝物件鍵）封起來。
//!     列表只 `list_objects` 一次（拿 size），時間／裝置／種類從鍵名解析，**不下載**。
//!   * 自動：每台每日第一次同步成功後一份（`sync_meta.last_cloud_snapshot_day`＝本地日曆日）；手動隨按。
//!     上傳成功後由上傳者順手 `prune`（階梯：14 天全留 → 每週 1 份留 3 個月 → 每月 1 份留 1 年）。
//!   * 還原（任何裝置）：GET → open → 驗 schema 與三表 → 留底（桌機 safety 備份／手機先拍一份 manual 雲端快照）
//!     → `import_full_json`（單一交易：清三表＋其 cells → 灌入 → settings 白名單 upsert → `stamp_missing_cells`）
//!     → 寫既有還原標記（`restore_choice`＋`mark_restore_pending`）→ `app.restart()` → 既有 `finish_restore` 收尾。
//!     **不新增第三種還原流程**：雲端快照只是多一個備份來源。
//!   * 匯出到手機：JS 用 `@tauri-apps/plugin-dialog` 的 `save()`（SAF）拿到 `content://` URI 交給 `export_to_file`，
//!     Rust 用 `tauri_plugin_fs::FsExt` 開檔寫入；沒帶 target（桌機／退路）走 `engine::write_export_file`。
//!
//! 鐵則：所有入口先過 `engine::keyed_client`（含 `guard_sandbox_root`）；刪除前先列鍵、逐顆刪、log **只印鍵名**；
//!   只碰自己 `root` 底下的鍵；憑證與鑰匙不進 log。
//!
//! **WP-B 實作時的兩處自決**（契約沒寫，理由都寫在各自的函式上；回報已記）：
//!   ① `upload` 拆成「外層拿 `BusyGuard`」與 `upload_held`（無守衛）兩支——輪替前置 0.5 與雲端還原步驟 2
//!      都在守衛**裡面**呼叫，叫外層必定撞自己的鎖。封裝與 PUT 那一段共用 `engine::put_cloud_snapshot`。
//!   ② `import_full_json` 在「真的跳過了列」時多跑一道孤兒清除（`prune_orphans`，手法沿 `apply_object`
//!      的 `prune_fk_violations`）——不然一份只壞了一列 node 的備份會因為子列變孤兒而整趟 COMMIT 失敗，
//!      一筆都還不回來。正常快照跳過 0 列，這一道不會跑到。
#![allow(dead_code)]

use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Pool, Row, Sqlite};
use std::collections::BTreeSet;
use tauri::{AppHandle, Manager};

use super::crypto;
use super::engine::{self, BusyGuard, RestoreChoice, SyncState};
use super::r2::R2Client;
use super::SCHEMA_VERSION;

/* ═══════════════════════════════════════════════════════════════════════
   常數（契約 §2.2 階梯；v1.1.4 不做設定 UI）
   ═══════════════════════════════════════════════════════════════════════ */

/// 最近 N 天：每一份都留
pub const KEEP_ALL_DAYS: i64 = 14;
/// 之後到 N 天：每 ISO 週留最新 1 份（3 個月 ≈ 13 週）
pub const WEEKLY_UNTIL_DAYS: i64 = 91;
/// 之後到 N 天：每日曆月留最新 1 份（1 年）；再舊全刪
pub const MONTHLY_UNTIL_DAYS: i64 = 365;

/// 鍵名裡的 UTC 戳格式（字典序＝時間序）
pub const STAMP_FMT: &str = "%Y%m%dT%H%M%SZ";

/* ═══════════════════════════════════════════════════════════════════════
   型別（serde 欄位名＝TS `src/data/syncRepository.ts` 同名同形）
   ═══════════════════════════════════════════════════════════════════════ */

/// 快照種類：自動（每日第一次同步後）／手動（「立即備份到雲端」）／留底（產品評審 S2）。
///
/// **v1.1.4 修正席（產品評審 S2）新增 `Safety`**：還原前、改用另一台之前、換鑰匙之前那三份是程式自己拍的，
/// 與主人按鈕拍的「手動」一樣寫成 `manual` 的話，主人還原完回來看列表會多一顆「這台・手動」卻不知道它是什麼。
/// 桌機本機備份清單早就有「保險」這個 chip，雲端這邊只是把同一個字補上（鍵名第三格本來就是給種類用的）。
/// 舊桶裡既有的 `manual` 鍵照樣解得開（`parse` 沒有動它），只是不會再有新的被誤標成手動。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotKind {
    Auto,
    Manual,
    Safety,
}

impl SnapshotKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SnapshotKind::Auto => "auto",
            SnapshotKind::Manual => "manual",
            SnapshotKind::Safety => "safety",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "auto" => Some(SnapshotKind::Auto),
            "manual" => Some(SnapshotKind::Manual),
            "safety" => Some(SnapshotKind::Safety),
            _ => None,
        }
    }
}

/// 列表一列（契約 §4）：從鍵名解析，不下載
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotEntry {
    /// 完整物件鍵（還原時原樣帶回）
    pub key: String,
    /// UTC ISO（由鍵名的戳記還原）
    pub at: String,
    pub device_id: String,
    pub kind: SnapshotKind,
    /// 密文大小（bytes）
    pub size: u64,
}

/// `import_full_json` 的回傳（診斷用；UI 不顯示）
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportReport {
    pub nodes: u64,
    pub work_logs: u64,
    pub occurrences: u64,
    pub settings: u64,
    /// 缺 NOT NULL 欄而跳過的列（契約 §3；正常快照＝0）
    pub skipped_rows: u64,
    /// `stamp_missing_cells` 補了幾格
    pub stamped_cells: u64,
}

/// `sync_export_to_file` 的回傳（契約 §4）
#[derive(Debug, Clone, Serialize)]
pub struct ExportReport {
    /// 桌機＝檔案完整路徑；Android＝SAF 回傳的 `content://` URI（主人自選的位置）；退路＝app 私有目錄路徑
    pub path: String,
    /// true＝寫到主人自選的位置（SAF）；false＝退路（下載夾或 app 私有目錄）
    pub picked: bool,
}

/* ═══════════════════════════════════════════════════════════════════════
   純函式：鍵名與階梯（契約 §2.1／§2.2；單測在檔尾，沙盒癸9 拿同一份期望值）
   ═══════════════════════════════════════════════════════════════════════ */

/// `<root>/snapshots/<YYYYMMDDTHHMMSSZ>_<device_id>_<auto|manual>.bin`
pub fn snapshot_key(root: &str, at: DateTime<Utc>, device_id: &str, kind: SnapshotKind) -> String {
    format!(
        "{}{}_{}_{}.bin",
        engine::snapshots_prefix(root),
        at.format(STAMP_FMT),
        device_id,
        kind.as_str()
    )
}

/// 鍵名 → (at, device_id, kind)；形狀不對回 None（外來物件不動它）
pub fn parse_snapshot_key(key: &str) -> Option<(DateTime<Utc>, String, SnapshotKind)> {
    let name = key.rsplit('/').next()?.strip_suffix(".bin")?;
    let mut parts = name.splitn(3, '_');
    let stamp = parts.next()?;
    let device_id = parts.next()?;
    let kind = SnapshotKind::parse(parts.next()?)?;
    let at = chrono::NaiveDateTime::parse_from_str(stamp, STAMP_FMT).ok()?.and_utc();
    if device_id.is_empty() {
        return None;
    }
    Some((at, device_id.to_string(), kind))
}

/// 階梯稀釋（契約 §2.2；D-1）：回**要刪**的鍵。規則以 `now - at` 的天數分層，**不分裝置、不分種類**：
///   * `< 14` 天：全留
///   * `< 91` 天：每 ISO 週（年＋週）只留最新一份
///   * `< 365` 天：每日曆月只留最新一份
///   * 其餘：刪
/// 最新的那一份永遠不刪（就算時鐘怪到讓它落在「其餘」）。鍵名解析不出來的不在輸入裡（呼叫端先過 `parse_snapshot_key`）。
pub fn retention_plan(entries: &[SnapshotEntry], now: DateTime<Utc>) -> Vec<String> {
    let mut items: Vec<(DateTime<Utc>, &str)> = entries
        .iter()
        .filter_map(|e| DateTime::parse_from_rfc3339(&e.at).ok().map(|d| (d.with_timezone(&Utc), e.key.as_str())))
        .collect();
    // 新到舊；同一刻以鍵名字典序倒排（穩定即可）
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(a.1)));

    let mut keep: BTreeSet<&str> = BTreeSet::new();
    let mut weeks: BTreeSet<(i32, u32)> = BTreeSet::new();
    let mut months: BTreeSet<(i32, u32)> = BTreeSet::new();
    for (i, (at, key)) in items.iter().enumerate() {
        let age_days = (now - *at).num_seconds() as f64 / 86_400.0;
        let hold = if i == 0 || age_days < KEEP_ALL_DAYS as f64 {
            true
        } else if age_days < WEEKLY_UNTIL_DAYS as f64 {
            let w = at.iso_week();
            weeks.insert((w.year(), w.week()))
        } else if age_days < MONTHLY_UNTIL_DAYS as f64 {
            months.insert((at.year(), at.month()))
        } else {
            false
        };
        if hold {
            keep.insert(key);
        }
    }
    items
        .iter()
        .filter(|(_, k)| !keep.contains(k))
        .map(|(_, k)| (*k).to_string())
        .collect()
}

/* ═══════════════════════════════════════════════════════════════════════
   上傳／列表／階梯清理／重加密（WP-B 2026-09-22 實作）
   ═══════════════════════════════════════════════════════════════════════ */

/// 本地日曆日 `YYYY-MM-DD`（「當日」的定義與備份三件套的「今天」同一把尺：主人的牆上時鐘，不是 UTC）
fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// 「今天拍過了嗎」的判準（純函式，單測用）：`sync_meta.last_cloud_snapshot_day` 與本地日曆日逐字相等。
///
/// 為什麼不用「上次上傳距今未滿 24 小時」：主人的直覺是「一天一份」＝日曆日，不是滾動 24 小時窗。
/// 昨天 23:50 拍過，今天 08:00 開 App 就該再拍一份（那是**新的一天**的備份）。
pub fn already_snapshotted_today(last_day: Option<&str>, today: &str) -> bool {
    last_day.map(|d| d == today).unwrap_or(false)
}

/// `SnapshotEntry.at` 的字串（秒精度 UTC ISO）——鍵名只記到秒，列表解回來也只有秒，
/// 上傳端若寫進毫秒，同一顆快照在「剛拍完」與「重讀列表」會長得不一樣（UI 會閃一下兩列）。
fn stamp_iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 拍一份快照上雲（契約 §4 `sync_cloud_snapshot_now`）：`engine::keyed_client` → `engine::build_full_json(kind)` →
/// `crypto::seal(data_key, aad=物件鍵)` → `client.put` → `sync_meta.last_cloud_snapshot_at`／`last_cloud_snapshot_day`
/// → `prune`（失敗只 log，不影響這次上傳的成敗）→ 回 `SnapshotEntry`。
///
/// 前置：鑰匙圈在（沒有＝Err「這台還沒加入同步」）。**不看** `enabled`／phase——還原前留底、輪替前留底都會在
/// 非 running 狀態下呼叫。`BusyGuard` 拿不到 ⇒ Err「同步正在進行中」。
pub async fn upload(app: &AppHandle, pool: &Pool<Sqlite>, kind: SnapshotKind) -> Result<SnapshotEntry, String> {
    let st = app
        .try_state::<SyncState>()
        .ok_or_else(|| "同步模組還沒初始化。".to_string())?;
    let _busy = BusyGuard::acquire(&st.busy).ok_or_else(|| "同步正在進行中，請稍候再試。".to_string())?;
    upload_held(app, pool, kind).await
}

/// `upload` 的無守衛版（WP-B 自決；理由寫在這裡）。
///
/// 為什麼要拆：`BusyGuard` 是**不可重入**的旗標，而「拍一份留底」的三個呼叫點裡有兩個是在守衛**裡面**——
/// 輪替前置 0.5（`rotate_data_key` 第 1 步就拿了守衛）與雲端還原步驟 2（`cloud_restore` 自己拿著）。
/// 若它們叫外層 `upload`，第二次 `acquire` 必定失敗、整條路徑在「還沒動任何東西」時回「同步正在進行中」。
/// 所以：**外面來的（command）用 `upload`，守衛裡面的用 `upload_held`**。
///
/// WP-A 接線提醒（契約 §6-6／§5.1）：`rotate_data_key` 的前置 0.5、`join(adopt_remote)` 與 `adopt_epoch` 的
/// 手機自動留底——若該處已持有 `BusyGuard` 就叫這支，沒持有就叫 `upload`。
pub(crate) async fn upload_held(
    app: &AppHandle,
    pool: &Pool<Sqlite>,
    kind: SnapshotKind,
) -> Result<SnapshotEntry, String> {
    // v1.1.4 修正席（工程評審 S-5）：**鑰匙已經不算數的裝置不准上傳。**
    // 別台換過鑰匙之後這台仍握著 K1；讓它拍一份 K1 封的快照上去，那顆永遠不會被重加密
    //（輪替的步驟 5 早就跑完了），列表上看得到、任何 K2 裝置點下去都「打不開」——
    // 一顆假的救命稻草比沒有更糟。而且它還會順手 `prune` 掉別台的 K2 快照。
    // `upload_auto` 已經被 phase 擋住（非 running 就回 None），這裡擋的是手動與各處的留底。
    let meta = engine::meta_all(pool).await?;
    let blocked = |k: &str| meta.get(k).is_some_and(|v| !v.is_empty());
    if blocked("locked") || blocked("pending_epoch") {
        return Err("這台的同步狀態還沒處理完（改正待ち／鍵違い）——先到同步頁處理，再備份到雲端。".into());
    }
    let k = engine::keyed_client(app, pool).await?;
    // 封裝與 PUT 的那一段＝`engine::put_cloud_snapshot`（WP-A 為輪替與 adopt 那三個呼叫點抽的共用核心：
    // 它們手上的鑰匙／根未必是鑰匙圈當下那一份）。這裡不另寫一份，免得兩邊的鍵名或 meta 哪天走岔。
    let entry = engine::put_cloud_snapshot(pool, &k.client, &k.data_key, &k.root, &k.device_id, kind).await?;

    // 上傳者順手清理（契約 §2.2）。清理失敗**不影響這次上傳的成敗**——快照已經在雲端了，
    // 多留幾顆舊的只是多佔一點空間，不值得把「備份成功」講成失敗。
    if let Err(e) = prune_except(&k.client, &k.root, Some(&entry.key)).await {
        eprintln!("[sync:snapshot] 階梯清理沒做完：{e}");
    }
    Ok(entry)
}

/// 每日一份（契約 §4 `sync_cloud_snapshot_auto`；TS `runCycle` 成功後叫）：
/// `sync_meta.last_cloud_snapshot_day == 今天（本地日曆日 YYYY-MM-DD）` ⇒ `Ok(None)`；phase 非 running ⇒ `Ok(None)`；
/// 否則 `upload(Auto)`。
///
/// 三道「回 None」都不是錯誤：這是背景動作，主人沒按任何鈕，任何一個「現在不適合」都該安靜地什麼都不做。
/// 搶不到 `BusyGuard` 也一樣（下一趟 runCycle 還會再問一次）。
pub async fn upload_auto(app: &AppHandle, pool: &Pool<Sqlite>) -> Result<Option<SnapshotEntry>, String> {
    // phase 由引擎算（契約 §4.2 的判定順序）；非 running＝改正待ち／鍵違い／換鑰匙中／停車中，都不該拍
    if engine::status(app).await?.phase != engine::Phase::Running {
        return Ok(None);
    }
    let meta = engine::meta_all(pool).await?;
    if already_snapshotted_today(meta.get("last_cloud_snapshot_day").map(String::as_str), &today_local()) {
        return Ok(None);
    }
    let st = app
        .try_state::<SyncState>()
        .ok_or_else(|| "同步模組還沒初始化。".to_string())?;
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Ok(None);
    };
    upload_held(app, pool, SnapshotKind::Auto).await.map(Some)
}

/// 列表（契約 §4 `sync_cloud_snapshot_list`）：`client.list_objects("<root>/snapshots/")` 一次，逐顆 `parse_snapshot_key`
///（解不開的略過），**新到舊**排序。
pub async fn list(app: &AppHandle, pool: &Pool<Sqlite>) -> Result<Vec<SnapshotEntry>, String> {
    let k = engine::keyed_client(app, pool).await?;
    list_entries(&k.client, &k.root).await
}

/// `list` 的內層（`prune`／`reencrypt_all` 共用；它們手上只有 client 與 root，沒有 AppHandle）
async fn list_entries(client: &R2Client, root: &str) -> Result<Vec<SnapshotEntry>, String> {
    let prefix = engine::snapshots_prefix(root);
    let mut out: Vec<SnapshotEntry> = client
        .list_objects(&prefix)
        .await?
        .into_iter()
        // 形狀不對的（主人自己丟進去的檔、未來版本的新東西）**略過不動**，不進列表也不會被清理碼看到
        .filter_map(|(key, size)| {
            parse_snapshot_key(&key).map(|(at, device_id, kind)| SnapshotEntry {
                key,
                at: stamp_iso(at),
                device_id,
                kind,
                size,
            })
        })
        .collect();
    // 新到舊；同一刻以鍵名倒排（穩定即可）
    out.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.key.cmp(&a.key)));
    Ok(out)
}

/// 階梯清理（`upload` 成功後順手做）：`list` → `retention_plan(now)` → 逐顆 `delete`（log 只印鍵名）。回刪掉幾顆。
///
/// 鐵則（契約 §0-2／§0-3）：先列鍵再逐顆刪、log **只印鍵名**；而且每一顆都再檢查一次「確實在自己的
/// `<root>/snapshots/` 底下」——`retention_plan` 是純函式，這道圍籬放在真正動手的地方才擋得住未來的誤用。
/// 單顆刪失敗只 log 不中斷（下次上傳還會再清一次）。
pub async fn prune(client: &R2Client, root: &str) -> Result<u64, String> {
    prune_except(client, root, None).await
}

/// 一趟清理最多可以刪掉的比例（工程評審 S-4 的煞車）：超過就整個跳過。
/// 正常階梯一次只會刪個位數（每天最多兩三顆到期），要刪掉一半以上只有一種解釋——**某台的時鐘壞了**。
const PRUNE_MAX_RATIO_DENOM: usize = 2;
/// 煞車只在列表夠長時才有意義（剛開始用的時候顆數本來就少，一次刪兩顆就超過一半了）
const PRUNE_MIN_ENTRIES: usize = 8;

/// `prune` 的內層：`just_uploaded` 是這一趟剛拍上去那顆的鍵，**一定不刪**。
///
/// 為什麼要排除（工程評審 S-4）：`retention_plan` 只保護列表裡**最新**的那一顆。上傳者的時鐘若落後，
/// 它剛拍的那顆戳記就不是最新的，於是「備份成功」之後自己把自己剛拍的那份刪掉——
/// 主人按了「立即備份到雲端」、看到成功、列表裡卻沒有它。
pub(crate) async fn prune_except(
    client: &R2Client,
    root: &str,
    just_uploaded: Option<&str>,
) -> Result<u64, String> {
    let prefix = engine::snapshots_prefix(root);
    let entries = list_entries(client, root).await?;
    let mut doomed = retention_plan(&entries, Utc::now());
    if let Some(k) = just_uploaded {
        doomed.retain(|d| d != k);
    }
    // 煞車（工程評審 S-4）：快照是主人資料的最後一道，單一台裝置的時鐘錯亂不該一次燒掉全部。
    // 一台手機日期跳到明年，它算出來的「age > 365 天」會涵蓋所有裝置一年內的每一顆。
    // 寧可這一趟不清（下次上傳、由時鐘正常的裝置再清），也不要刪過頭。
    if doomed.len() * PRUNE_MAX_RATIO_DENOM > entries.len() && entries.len() >= PRUNE_MIN_ENTRIES {
        eprintln!(
            "[sync:snapshot] 這一趟要刪 {} / {} 顆（過半），多半是某台的時鐘不對——先不清理",
            doomed.len(),
            entries.len()
        );
        return Ok(0);
    }
    let mut deleted = 0u64;
    for key in doomed {
        if !key.starts_with(&prefix) {
            eprintln!("[sync:snapshot] 不在自己的根底下，跳過 {key}");
            continue;
        }
        eprintln!("[sync:snapshot] prune delete {key}");
        match client.delete(&key).await {
            Ok(()) => deleted += 1,
            Err(e) => eprintln!("[sync:snapshot] 刪不掉 {key}：{e}"),
        }
    }
    Ok(deleted)
}

/// 輪替步驟 5（契約 §5；WP-A 從 `rotate_data_key` 呼叫，WP-B 實作）：`snapshots/` 逐顆 GET →
/// `crypto::open(new_key)` 拆得開 ⇒ 跳過（冪等）→ 否則 `open(old_key)` → `seal(new_key)` → PUT **同鍵**。
/// 兩把都拆不開的（外來／壞掉）跳過並 log 鍵名。回重加密了幾顆。
///
/// 為什麼「先用新鑰匙試拆」而不是記進度：輪替可能在任何一顆中間斷電，重跑時前 N 顆已經是 K2 封的。
/// 「拆得開就跳過」把冪等性寫進資料本身，不必額外的進度檔（契約 §5.2 步驟 5 的冪等條件）。
pub async fn reencrypt_all(
    client: &R2Client,
    root: &str,
    old_key: &[u8; crypto::KEY_LEN],
    new_key: &[u8; crypto::KEY_LEN],
) -> Result<u64, String> {
    let mut done = 0u64;
    for entry in list_entries(client, root).await? {
        let Some(blob) = client.get_opt(&entry.key).await? else {
            continue; // 列完之後被別人清掉了（階梯清理）——不是錯
        };
        if crypto::open(new_key, &entry.key, &blob).is_ok() {
            continue; // 已經是新鑰匙封的（續跑）
        }
        let Ok(plain) = crypto::open(old_key, &entry.key, &blob) else {
            // 兩把都拆不開＝更早的血統留下的、或壞掉的——不動它、也不讓整趟輪替失敗
            eprintln!("[sync:snapshot] 兩把鑰匙都拆不開，跳過 {}", entry.key);
            continue;
        };
        let sealed = crypto::seal(new_key, &entry.key, &plain)?;
        client.put(&entry.key, sealed).await?;
        done += 1;
    }
    Ok(done)
}

/* ═══════════════════════════════════════════════════════════════════════
   匯入與雲端還原（WP-B 2026-09-22 實作）
   ═══════════════════════════════════════════════════════════════════════ */

/// 全量 JSON 灌回本機（契約 §3 逐欄規則）。**單一交易**：
///   ① 驗 `schema`（> `SCHEMA_VERSION` ⇒ Err「這份備份來自較新的版本，請先更新 App。」；缺 ⇒ 視為 0）、
///      三個陣列 `nodes`／`work_logs`／`occurrences` 都在（缺 ⇒ Err「這份備份的內容不完整。」）
///   ② `PRAGMA defer_foreign_keys = ON`
///   ③ `DELETE FROM sync_cells WHERE tbl IN ('nodes','work_logs','occurrences') OR (tbl='settings' AND row_id IN 白名單)`
///   ④ `DELETE FROM occurrences`／`work_logs`／`nodes`（子表先）
///   ⑤ 逐列 INSERT：只取「本機表真的有的欄」（`PRAGMA table_info`）∩ JSON 有的鍵；缺的欄不寫 ⇒ 吃 DEFAULT；
///      NOT NULL 且無 DEFAULT 的欄缺 ⇒ 跳過整列、`skipped_rows += 1`
///   ⑥ settings 白名單 upsert（`updated_at = exported_at`——格子才會派生出「快照那一刻」）
///   ⑦ `engine::stamp_missing_cells(tx, me)`（用列的 `updated_at` 派生 hlc ⇒ 「接上現在」是真的原始時間戳 LWW）
///   ⑧ COMMIT
/// outbox 由呼叫端先 `export_outbox_orphans` 再清（見 `cloud_restore`）。
pub async fn import_full_json(pool: &Pool<Sqlite>, json: &str, me: &str) -> Result<ImportReport, String> {
    let doc = validate_full_json(json)?;
    // settings 的 `updated_at` 用快照那一刻（契約 §3.3-5），不是「現在」
    let exported_at = doc
        .get("exported_at")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(engine::now_iso);

    let mut report = ImportReport::default();
    let mut tx = pool.begin().await.map_err(engine::db_err)?;

    // ② 父子列在同一個交易裡先刪後灌，中途必然出現「孤兒」——延到 COMMIT 才驗（apply_object 同法）
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .map_err(engine::db_err)?;

    // ③ 格子：三表全清＋settings 白名單那幾把（其餘 settings 的格子是這台本地的偏好，不在快照裡、不能清）
    let settings_in = engine::SYNC_SETTINGS_KEYS
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(",");
    sqlx::query(&format!(
        "DELETE FROM sync_cells WHERE tbl IN ('nodes','work_logs','occurrences') \
         OR (tbl = 'settings' AND row_id IN ({settings_in}))"
    ))
    .execute(&mut *tx)
    .await
    .map_err(engine::db_err)?;

    // ④ 子表先（occurrences／work_logs 都指向 nodes）
    for tbl in ["occurrences", "work_logs", "nodes"] {
        sqlx::query(&format!("DELETE FROM {tbl}"))
            .execute(&mut *tx)
            .await
            .map_err(engine::db_err)?;
    }

    // ⑤ 灌三表（父通常先於子：快照是 created_at 序；`defer_foreign_keys` 保底）
    for tbl in ["nodes", "work_logs", "occurrences"] {
        let cols = table_cols(&mut tx, tbl).await?;
        let rows = doc.get(tbl).and_then(Value::as_array).expect("已驗過是陣列");
        let mut inserted = 0u64;
        for row in rows {
            let Some(obj) = row.as_object() else {
                report.skipped_rows += 1;
                continue;
            };
            match insert_row(&mut tx, tbl, &cols, obj).await? {
                true => inserted += 1,
                false => report.skipped_rows += 1,
            }
        }
        match tbl {
            "nodes" => report.nodes = inserted,
            "work_logs" => report.work_logs = inserted,
            _ => report.occurrences = inserted,
        }
    }

    // ⑤ʹ 孤兒清除（**WP-B 自決**，契約 §3 沒寫；理由：）
    //    ⑤ 跳掉一列 node 之後，掛在它底下的 work_logs／occurrences 就成了孤兒，COMMIT 時
    //    `defer_foreign_keys` 會讓**整趟**失敗——一份只壞了一列的備份於是一筆都還不回來，
    //    而主人按下「還原」時多半正是資料出了事的時候。既然 ⑤ 已經決定「壞的那列跳過、其餘照收」，
    //    連帶的孤兒也該照同一條規則處理。只在**真的跳過了東西**時才跑（正常快照一毛錢都不花），
    //    手法沿 `apply_object` 的 `prune_fk_violations`：`PRAGMA foreign_key_check` 逐輪撤，
    //    撤掉的列一起計進 `skipped_rows`（帳目對得起來：報告說跳過 N 列，庫裡就少 N 列）。
    if report.skipped_rows > 0 {
        report.skipped_rows += prune_orphans(&mut tx).await?;
    }

    // ⑥ settings 白名單 upsert（其餘鍵——主題、書封、backup_*——一個字都不動）
    let settings = doc.get("settings").and_then(Value::as_object);
    for key in engine::SYNC_SETTINGS_KEYS {
        let Some(value) = settings.and_then(|s| s.get(*key)).and_then(json_text) else {
            continue;
        };
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(&value)
        .bind(&exported_at)
        .execute(&mut *tx)
        .await
        .map_err(engine::db_err)?;
        report.settings += 1;
    }

    // ⑦ 補戳格子：hlc 由每一列的 `updated_at` 派生 ⇒「接上現在」比的是**備份那一刻**，不是「匯入這一刻」
    report.stamped_cells = engine::stamp_missing_cells(&mut tx, me).await?;

    tx.commit().await.map_err(engine::db_err)?;
    Ok(report)
}

/// 匯入前的驗證（契約 §3.1）——**動本機之前**就要判得出來，所以與灌庫分開：
/// `cloud_restore` 在留底之前先叫這支，壞檔時本機零改變。回解析好的頂層物件（`import_full_json` 直接用）。
pub fn validate_full_json(json: &str) -> Result<Map<String, Value>, String> {
    let incomplete = || "這份備份的內容不完整。".to_string();
    let doc: Value = serde_json::from_str(json).map_err(|_| incomplete())?;
    let Value::Object(doc) = doc else {
        return Err(incomplete());
    };
    // 缺 schema＝0（更舊的版本）：缺的欄吃本機 DEFAULT
    let schema = doc.get("schema").and_then(Value::as_u64).unwrap_or(0);
    if schema > SCHEMA_VERSION as u64 {
        return Err("這份備份來自較新的版本，請先更新 App。".into());
    }
    for tbl in ["nodes", "work_logs", "occurrences"] {
        if !doc.get(tbl).map(Value::is_array).unwrap_or(false) {
            return Err(incomplete());
        }
    }
    Ok(doc)
}

/// 撤掉三表裡違反外鍵的列，回撤掉幾列（手法沿 `engine::apply_object` 的 `prune_fk_violations`）。
///
/// 這裡不必像那邊一樣比對「是不是自己剛塞的」：`import_full_json` 的交易已經把三表清空重灌，
/// 表裡每一列都是這一趟塞的。迭代是必要的——撤掉一列 node 會讓掛在它底下的日誌變成新的孤兒。
/// 孤兒清除的迭代上限（工程評審 S-10）：一輪撤掉一層，樹有多深就要跑幾輪。
/// 本專案的鐵道樹是 線→路線→支線→列車→車廂→車票→乘務記錄（≥6 層），固定 5 輪清不完 ⇒
/// COMMIT 撞 FK、整趟失敗，而且錯誤訊息不是人話。改成「跑到一輪零命中為止」，上限只是防無窮迴圈。
const PRUNE_ORPHAN_ROUNDS: usize = 32;

async fn prune_orphans(tx: &mut sqlx::Transaction<'_, Sqlite>) -> Result<u64, String> {
    let mut pruned = 0u64;
    let mut rounds = 0usize;
    loop {
        rounds += 1;
        if rounds > PRUNE_ORPHAN_ROUNDS {
            return Err("這份備份裡有太多互相依賴的壞資料，沒辦法安全地還原。".into());
        }
        let mut hit = false;
        for tbl in ["nodes", "work_logs", "occurrences"] {
            // pragma 的欄：0=表名 1=rowid 2=父表 3=fkid（表名是自家常數，不是外來字串）
            let rows = sqlx::query(&format!("PRAGMA foreign_key_check({tbl})"))
                .fetch_all(&mut **tx)
                .await
                .map_err(engine::db_err)?;
            for row in &rows {
                let Ok(Some(rowid)) = row.try_get::<Option<i64>, _>(1) else {
                    continue;
                };
                sqlx::query(&format!("DELETE FROM {tbl} WHERE rowid = ?"))
                    .bind(rowid)
                    .execute(&mut **tx)
                    .await
                    .map_err(engine::db_err)?;
                pruned += 1;
                hit = true;
            }
        }
        if !hit {
            break;
        }
    }
    Ok(pruned)
}

/* ── 逐欄灌入的零件（契約 §3.2）── */

/// 本機表真的有的一欄（`PRAGMA table_info`）——不寫死欄位清單，未來 migration 加欄不必回來改這裡
struct ColSpec {
    name: String,
    /// 整數欄（`position`／`estimate_min`／`progress`／`time_spent_min`／`today_position`）以 i64 綁
    is_int: bool,
    /// NOT NULL 且沒有 DEFAULT ⇒ 快照裡缺它就跳過整列（契約 §3.2 的 ★）
    required: bool,
}

async fn table_cols(tx: &mut sqlx::Transaction<'_, Sqlite>, tbl: &str) -> Result<Vec<ColSpec>, String> {
    let rows = sqlx::query(&format!("PRAGMA table_info({tbl})"))
        .fetch_all(&mut **tx)
        .await
        .map_err(engine::db_err)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let name: String = r.try_get("name").map_err(engine::db_err)?;
        let ty: String = r.try_get("type").map_err(engine::db_err)?;
        let notnull: i64 = r.try_get("notnull").map_err(engine::db_err)?;
        let dflt: Option<String> = r.try_get("dflt_value").map_err(engine::db_err)?;
        out.push(ColSpec {
            is_int: ty.to_ascii_uppercase().starts_with("INT"),
            required: notnull != 0 && dflt.is_none(),
            name,
        });
    }
    Ok(out)
}

/// JSON 值 → 文字欄的字串（數值與布林轉字串，契約 §3.2）；null 當作「沒有這一欄」
fn json_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

enum Bind {
    Int(i64),
    Text(String),
}

/// 灌一列。回 `false`＝必填欄不齊、整列跳過（`skipped_rows += 1`）。
/// INSERT 本身失敗（CHECK 違反＝壞檔）⇒ Err，整個交易一起回滾（契約 §3.2：不做半吊子相容）。
async fn insert_row(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    tbl: &str,
    cols: &[ColSpec],
    row: &Map<String, Value>,
) -> Result<bool, String> {
    let mut names: Vec<&str> = Vec::with_capacity(cols.len());
    let mut binds: Vec<Bind> = Vec::with_capacity(cols.len());
    for c in cols {
        // 本機有、快照沒有（或給 null）＝不寫這一欄 ⇒ 吃 DEFAULT；必填的話整列跳過
        let Some(v) = row.get(&c.name).filter(|v| !v.is_null()) else {
            if c.required {
                return Ok(false);
            }
            continue;
        };
        let bind = if c.is_int {
            match v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())) {
                Some(n) => Bind::Int(n),
                // 整數欄收到讀不成數字的東西：當成沒有這一欄（吃 DEFAULT）；必填的整數欄本專案沒有
                None if !c.required => continue,
                None => return Ok(false),
            }
        } else {
            match json_text(v) {
                Some(s) => Bind::Text(s),
                None if !c.required => continue,
                None => return Ok(false),
            }
        };
        names.push(&c.name);
        binds.push(bind);
    }
    if names.is_empty() {
        return Ok(false);
    }
    let sql = format!(
        "INSERT INTO {tbl} ({}) VALUES ({})",
        names.join(", "),
        vec!["?"; names.len()].join(", ")
    );
    let mut q = sqlx::query(&sql);
    for b in &binds {
        q = match b {
            Bind::Int(n) => q.bind(*n),
            Bind::Text(s) => q.bind(s.clone()),
        };
    }
    q.execute(&mut **tx).await.map_err(|_| {
        let id = row.get("id").and_then(Value::as_str).unwrap_or("?");
        format!("這份備份有一筆資料不合法（{tbl} {id}）。")
    })?;
    Ok(true)
}

/// 雲端還原（契約 §4 `sync_cloud_restore`；D-2 兩殼同一套）。成功**不會回來**（`app.restart()`）。
///   0. `BusyGuard`；`keyed_client`；`parse_snapshot_key(key)` 形狀不對 ⇒ Err
///   1. GET → `crypto::open(data_key, aad=key)` → 驗 schema／三表（`import_full_json` 的 ①，先驗再動本機）
///   2. 留底：桌機 `crate::backup::safety_snapshot`；手機 `upload_held(Safety)`（用當下這把鑰匙）；失敗 ⇒ Err、本機零改變
///   3. `engine::export_outbox_orphans`（未送出的另存，**先不清 outbox**）
///   4. 還原標記（`restore_choice`＋`mark_restore_pending`）——**在匯入之前**（工程評審 S-2）
///   5. `import_full_json`；失敗 ⇒ 收回標記、Err、本機零改變
///   6. 匯入成功才 `DELETE FROM sync_outbox` 與寫 `last_orphans_*`（工程評審 S-1）
///   7. `app.restart()`
///
/// **兩處順序是修正席改的**（工程評審 S-1／S-2）：
///   * S-1：舊碼在匯入**之前**就把 outbox 清掉（而且在交易外）。匯入失敗回滾之後，DB 裡那些列還是改過的值、
///     格子也在，卻再也不會 push——「失敗＝資料未動」在那個版本並不成立。
///   * S-2：舊碼在匯入**之後**才寫還原標記。標記寫不進去（磁碟、權限）＝庫已經換成快照、卻沒有人收尾：
///     Present 的游標沒清（雲端較新的修改永遠不會蓋回來）、Past 不開新紀元（別台永遠不被問、這台也推不出去）。
///     標記檔在 app 資料目錄，與匯入的交易互不相干，所以先寫、失敗再收回是安全的。
pub async fn cloud_restore(
    app: &AppHandle,
    key: &str,
    choice: RestoreChoice,
    label: Option<String>,
) -> Result<(), String> {
    let st = app
        .try_state::<SyncState>()
        .ok_or_else(|| "同步模組還沒初始化。".to_string())?;
    let _busy = BusyGuard::acquire(&st.busy).ok_or_else(|| "同步正在進行中，請稍候再試。".to_string())?;
    let pool = engine::pool(app).await?;
    let k = engine::keyed_client(app, &pool).await?;

    // 0. 形狀與歸屬：只還原自己這個根底下、鍵名長得像快照的物件（UI 只會帶列表回來的鍵，這是保險）
    if parse_snapshot_key(key).is_none() || !key.starts_with(&engine::snapshots_prefix(&k.root)) {
        return Err("這不是一份雲端快照。".into());
    }

    // 1. 下載→拆→驗（**動本機之前**；拆不開＝這台的鑰匙已被輪替換掉，或物件壞了）
    let blob = k.client.get(key).await?;
    let plain = crypto::open(&k.data_key, key, &blob)
        .map_err(|_| "這份雲端快照用這台的鑰匙打不開（可能已在另一台換過鑰匙）。".to_string())?;
    let text = String::from_utf8(plain).map_err(|_| "這份備份的內容不完整。".to_string())?;
    validate_full_json(&text)?;

    // 2. 留底（D-2：桌機拍本機 safety 備份／手機先拍一份 manual 雲端快照，用當下這把鑰匙）。
    //    失敗 ⇒ Err、**本機零改變**——「還原前一定有一份現在的」是這條路的前提，不能靜默跳過。
    #[cfg(not(mobile))]
    crate::backup::safety_snapshot(app)
        .await
        .map_err(|e| format!("還原前的保險備份沒拍成：{e}"))?;
    #[cfg(mobile)]
    upload_held(app, &pool, SnapshotKind::Safety)
        .await
        .map_err(|e| format!("還原前的雲端備份沒拍成：{e}"))?;

    // 3. 未送出的另存（**只落檔，先不清 outbox、也先不寫 meta**；工程評審 S-1）。
    //    新紀元號要重啟後的 `finish_restore(Past)` 才決定得了，所以 JSON 裡的 `new_epoch` 留空。
    let old_epoch = k.epoch.clone().unwrap_or_default();
    let (orphan_ops, orphans_path) =
        engine::export_outbox_orphans(app, &pool, &k.device_id, &old_epoch, "").await?;

    // 4. 既有還原標記（**不新增第三種還原流程**）：choice 二選一與桌機本機還原同義，
    //    重啟後由既有 `finish_restore` 收尾（Past 開新紀元＋重上傳／Present 只清游標）。
    //    工程評審 S-2：**先寫再匯入**，匯入失敗就收回——庫換了卻沒有收尾標記是靜默分歧。
    engine::restore_choice(app, Some(choice), label)?;
    engine::mark_restore_pending(app)?;

    // 5. 灌回（單一交易；失敗＝本機停在留底之後、資料與 outbox 都沒動）
    if let Err(e) = import_full_json(&pool, &text, &k.device_id).await {
        engine::clear_restore_pending(app);
        let _ = engine::restore_choice(app, None, None);
        return Err(e);
    }

    // 6. 匯入成功了才動 outbox 與那三把 meta（工程評審 S-1）
    if let Some(path) = orphans_path.as_deref() {
        engine::meta_set(&pool, "last_orphans_count", &orphan_ops.to_string()).await?;
        engine::meta_set(&pool, "last_orphans_path", path).await?;
        engine::meta_set(&pool, "last_orphans_at", &engine::now_iso()).await?;
    }
    sqlx::query("DELETE FROM sync_outbox")
        .execute(&pool)
        .await
        .map_err(engine::db_err)?;

    // 7. 重啟（不回來）。
    //
    // **Android 的真相（工程評審 S-6，翻過 `tauri-2.11.2/src/process.rs:74-89`）**：`restart()` 在 Android
    // 等於 `exit(0)`——`current_binary()` 回的是 `app_process64`，`Command::spawn` 必定失敗、只寫一行 log，
    // 接著行程就結束了。**資料是安全的**（標記檔已經落地，主人重開 App 時 boot 的 `finish_restore` 會收尾），
    // 但主人眼裡看到的是「App 閃退」，所以手機端的確認窗文案寫的是「App 會關閉，請重新打開」。
    app.restart()
}

/// 匯出到檔案（契約 §4 `sync_export_to_file`）。
///   * `target = Some(content:// 或路徑)`（Android：JS 先用 `plugin-dialog` 的 `save()` 讓主人選位置）⇒
///     `tauri_plugin_fs::FsExt` 開檔寫入 `engine::build_full_json(Manual)`，回 `{path: target, picked: true}`。
///   * `target = None`（桌機／SAF 用不了的退路）⇒ `engine::write_export_file`，回 `{path, picked: false}`。
/// **不看**鑰匙圈：沒加入同步的手機也能匯出（這是它唯一的存底手段）。
pub async fn export_to_file(
    app: &AppHandle,
    pool: &Pool<Sqlite>,
    target: Option<String>,
) -> Result<ExportReport, String> {
    let text = engine::build_full_json(pool, SnapshotKind::Manual).await?;
    match target.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(path) => match write_picked(app, &path, &text) {
            Ok(()) => Ok(ExportReport { path, picked: true }),
            // 工程評審 S-9：SAF 的 `save()` 已經**先建好**那個文件了（`ACTION_CREATE_DOCUMENT`），
            // 寫入才失敗 ⇒ 主人選的位置留下一顆 0 byte 的空檔，而整支 Err 之後他手上一份存底都沒有。
            // 契約 §6 的退路只覆蓋「選擇器開不了」，這裡補上「選好了、寫不進去」：退回 app 私有目錄，
            // 路徑照實回報，`picked=false` 讓 UI 講清楚它不在主人選的地方。
            Err(e) => {
                eprintln!("[sync:snapshot] 寫不進你選的位置，改寫 app 目錄：{e}");
                Ok(ExportReport {
                    path: engine::write_export_file(app, &text)?,
                    picked: false,
                })
            }
        },
        // 桌機（下載夾／NextStop）與「選擇器開不了」的退路——落點由 engine 決定，路徑照實回報
        None => Ok(ExportReport {
            path: engine::write_export_file(app, &text)?,
            picked: false,
        }),
    }
}

/// 寫到主人自選的位置。Android 是 SAF 的 `content://` URI——`std::fs` 開不了它，只有
/// `tauri_plugin_fs` 的 `Fs::open` 會走 Android 端的 ContentResolver 拿 fd 回來（查證：
/// `docs/research/2026-09-22-v1.1.4-Android下載目錄寫入查證.md`，實作在 plugin-fs 2.5 `android.rs`）。
/// 桌機拿到的是普通路徑，同一支也寫得了（plugin 內部走 `std::fs::OpenOptions`）。
///
/// 為什麼 Rust 寫而不是 JS `writeTextFile`：整份 JSON 是主人的全部資料，讓它多穿越一次 IPC 只是多一次
/// 複製與一次序列化；而且「產字串」與「落檔」留在同一層，退路（`write_export_file`）才接得上（契約 §6）。
fn write_picked(app: &AppHandle, target: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::str::FromStr;
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    let path = FilePath::from_str(target).map_err(|_| "看不懂這個存檔位置。".to_string())?;
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    let mut file = app
        .fs()
        .open(path, opts)
        .map_err(|e| format!("打不開你選的位置：{e}"))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("寫入匯出檔失敗：{e}"))?;
    file.flush().map_err(|e| format!("寫入匯出檔失敗：{e}"))
}

/* ═══════════════════════════════════════════════════════════════════════
   單測（純函式；契約 §2.1／§2.2 的期望值，沙盒癸9 照抄）
   ═══════════════════════════════════════════════════════════════════════ */
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn entry(at: DateTime<Utc>, dev: &str, kind: SnapshotKind) -> SnapshotEntry {
        SnapshotEntry {
            key: snapshot_key("v1-sb-test", at, dev, kind),
            at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            device_id: dev.to_string(),
            kind,
            size: 1,
        }
    }

    #[test]
    fn 鍵名_組出來再解回去_同值() {
        let at = Utc.with_ymd_and_hms(2026, 9, 22, 14, 3, 9).unwrap();
        let k = snapshot_key("v1", at, "a1b2c3d4-0000-4000-8000-000000000000", SnapshotKind::Auto);
        assert_eq!(k, "v1/snapshots/20260922T140309Z_a1b2c3d4-0000-4000-8000-000000000000_auto.bin");
        let (at2, dev, kind) = parse_snapshot_key(&k).unwrap();
        assert_eq!(at2, at);
        assert_eq!(dev, "a1b2c3d4-0000-4000-8000-000000000000");
        assert_eq!(kind, SnapshotKind::Auto);
        // 外來物件：形狀不對就不認
        assert!(parse_snapshot_key("v1/snapshots/readme.txt").is_none());
        assert!(parse_snapshot_key("v1/snapshots/20260922T140309Z_dev_weird.bin").is_none());
        assert!(parse_snapshot_key("v1/1758153600000/EPOCH.bin").is_none());
    }

    /// 癸9 的期望值：40 顆每日 03:00Z 的快照（0～39 天前），now＝2026-09-22T12:00Z ⇒
    /// 0～13 天全留（14）＋ 14～39 天每 ISO 週留最新（09-08、09-06、08-30、08-23、08-16＝5）⇒ 留 19、刪 21。
    #[test]
    fn 階梯_四十顆每日快照_留十九刪二十一() {
        let now = Utc.with_ymd_and_hms(2026, 9, 22, 12, 0, 0).unwrap();
        let entries: Vec<SnapshotEntry> = (0..40)
            .map(|d| {
                let at = Utc.with_ymd_and_hms(2026, 9, 22, 3, 0, 0).unwrap() - Duration::days(d);
                entry(at, if d % 2 == 0 { "dev-a" } else { "dev-b" }, if d % 3 == 0 { SnapshotKind::Manual } else { SnapshotKind::Auto })
            })
            .collect();
        let doomed = retention_plan(&entries, now);
        assert_eq!(doomed.len(), 21, "刪的顆數");
        let kept: Vec<&str> = entries
            .iter()
            .filter(|e| !doomed.contains(&e.key))
            .map(|e| e.key.as_str())
            .collect();
        assert_eq!(kept.len(), 19, "留的顆數");
        // 每週留下的是那一週**最新**的那份
        for day in ["20260908", "20260906", "20260830", "20260823", "20260816"] {
            assert!(kept.iter().any(|k| k.contains(&format!("/{day}T"))), "{day} 應該留下");
        }
        for day in ["20260907", "20260905", "20260831", "20260824", "20260817", "20260814"] {
            assert!(!kept.iter().any(|k| k.contains(&format!("/{day}T"))), "{day} 應該被刪");
        }
        // 最近 14 天一顆都不少
        for d in 0..14 {
            let day = (now - Duration::days(d)).format("%Y%m%d").to_string();
            assert!(kept.iter().any(|k| k.contains(&format!("/{day}T"))), "{day} 在 14 天內應該留下");
        }
    }

    /// 月層與過期：100／110 天前同在 6 月 ⇒ 留 06-14 刪 06-04；120 天前 5 月 ⇒ 留；400 天前 ⇒ 刪。
    #[test]
    fn 階梯_月層留最新_一年外全刪() {
        let now = Utc.with_ymd_and_hms(2026, 9, 22, 12, 0, 0).unwrap();
        let base = Utc.with_ymd_and_hms(2026, 9, 22, 3, 0, 0).unwrap();
        let entries: Vec<SnapshotEntry> = [0i64, 100, 110, 120, 400]
            .iter()
            .map(|d| entry(base - Duration::days(*d), "dev-a", SnapshotKind::Auto))
            .collect();
        let doomed = retention_plan(&entries, now);
        let doomed_days: Vec<String> = doomed.iter().map(|k| k[k.rfind('/').unwrap() + 1..][..8].to_string()).collect();
        assert_eq!(doomed_days, vec!["20260604".to_string(), "20250818".to_string()]);
    }

    /// 只剩一顆而且很舊：最新那份永遠不刪
    #[test]
    fn 階梯_最新一份永不刪() {
        let now = Utc.with_ymd_and_hms(2026, 9, 22, 12, 0, 0).unwrap();
        let old = Utc.with_ymd_and_hms(2024, 1, 1, 3, 0, 0).unwrap();
        let entries = vec![entry(old, "dev-a", SnapshotKind::Auto)];
        assert!(retention_plan(&entries, now).is_empty());
    }

    /// 當日只拍一份（`upload_auto` 的閘門；整支要 AppHandle＋網路，所以只測判準本身——
    /// 真機那一格是沙盒癸1「A 再跑一趟不多拍」）
    #[test]
    fn 當日只拍一份_判準() {
        assert!(already_snapshotted_today(Some("2026-09-22"), "2026-09-22"));
        assert!(!already_snapshotted_today(Some("2026-09-21"), "2026-09-22"));
        // 還沒拍過（沒有這個 meta 鍵）＝要拍
        assert!(!already_snapshotted_today(None, "2026-09-22"));
        // 空字串（被清過的 meta）也不算拍過
        assert!(!already_snapshotted_today(Some(""), "2026-09-22"));
    }

    /* ═══════════════════════════════════════════════════════════════════
       匯入（臨時 sqlite；**絕不碰主人正本**：檔案在系統暫存目錄，測完就刪）
       ═══════════════════════════════════════════════════════════════════ */

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Pool, Row, Sqlite};
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    async fn make_pool(tag: &str) -> (Pool<Sqlite>, std::path::PathBuf) {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "ns-wpb-snaptest-{tag}-{}-{n}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    // FK 開著是故意的：要驗 `import_full_json` 的 `defer_foreign_keys` 真的有在放行
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

    /// 一棵小樹（形狀沿 engine 的 `seed_tree`，另外把「可 NULL 欄有值／整數欄有值／墓碑」都放進去，
    /// 逐欄比對才有東西可比）
    async fn seed(pool: &Pool<Sqlite>) {
        for (id, kind, parent, line, route, name, pos) in [
            ("L1", "line", None, None, None, "月見坂線", 0),
            ("R1", "route", Some("L1"), Some("L1"), None, "普通", 0),
            ("T1", "train", Some("R1"), Some("L1"), Some("R1"), "今日の列車", 0),
            ("K1", "ticket", None, Some("L1"), Some("R1"), "臨時券", 1),
        ] {
            sqlx::query(
                "INSERT INTO nodes (id, kind, parent_id, line_id, route_id, name, position, \
                 description, status, priority, progress, estimate_min, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, '說明', 'doing', 'high', 42, 30, \
                 '2026-09-18T01:02:03.004Z', '2026-09-19T05:06:07.008Z')",
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
        // 墓碑也要跟著走（不然對方「復原」那張票時找不到列）
        sqlx::query(
            "INSERT INTO nodes (id, kind, name, deleted_at, updated_at) \
             VALUES ('D1','ticket','消えた券','2026-09-20T00:00:00.000Z','2026-09-20T00:00:00.000Z')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO work_logs (id, node_id, body, logged_at, event) \
             VALUES ('W1','T1','発車','2026-09-18T00:00:00.000Z','issued'), \
                    ('W2','T1','競合','2026-09-19T00:00:00.000Z','conflict')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO occurrences (id, node_id, due_on, status, mood) \
             VALUES ('O1','T1','2026-09-18','done','green')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) \
             VALUES ('day_start_hour','4','2026-09-01T00:00:00.000Z'), \
                    ('theme','sepia','2026-09-01T00:00:00.000Z')",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// 三表逐列逐欄的快照（`SELECT *` 轉成可比較的字串；順序與 `build_full_json` 同）
    async fn dump(pool: &Pool<Sqlite>) -> Vec<Value> {
        let text = engine::build_full_json(pool, SnapshotKind::Manual).await.unwrap();
        let doc: Value = serde_json::from_str(&text).unwrap();
        ["nodes", "work_logs", "occurrences"]
            .iter()
            .map(|t| doc.get(*t).unwrap().clone())
            .collect()
    }

    async fn scalar(pool: &Pool<Sqlite>, sql: &str) -> Option<String> {
        sqlx::query(sql)
            .fetch_optional(pool)
            .await
            .unwrap()
            .and_then(|r| r.try_get::<Option<String>, _>(0).unwrap())
    }

    /// 匯入 round-trip：匯出 → 清三表與 settings → 匯入 → **逐表逐列逐欄**與原來相同
    #[test]
    fn 匯入_來回一趟_三表逐欄相同() {
        tauri::async_runtime::block_on(async {
            let (pool, path) = make_pool("roundtrip").await;
            seed(&pool).await;
            let before = dump(&pool).await;
            let json = engine::build_full_json(&pool, SnapshotKind::Manual).await.unwrap();

            // 把庫弄得跟快照完全不一樣：三表清掉、換上別的列、白名單設定也改掉
            for sql in [
                "DELETE FROM occurrences",
                "DELETE FROM work_logs",
                "DELETE FROM nodes",
                "INSERT INTO nodes (id, kind, name) VALUES ('X1','ticket','匯入前才長出來的')",
                "UPDATE settings SET value = '9' WHERE key = 'day_start_hour'",
            ] {
                sqlx::query(sql).execute(&pool).await.unwrap();
            }

            let report = import_full_json(&pool, &json, "dev-1").await.unwrap();
            assert_eq!(report.nodes, 5, "nodes 灌回的列數（含墓碑）");
            assert_eq!(report.work_logs, 2);
            assert_eq!(report.occurrences, 1);
            assert_eq!(report.settings, 1, "settings 只有白名單那一把");
            assert_eq!(report.skipped_rows, 0, "正常快照不該跳過任何一列");

            assert_eq!(dump(&pool).await, before, "三表逐列逐欄要與匯出當時相同");
            // 匯入前才長出來的那一列不該還在
            assert_eq!(
                scalar(&pool, "SELECT id FROM nodes WHERE id = 'X1'").await,
                None
            );
            // 白名單設定被蓋回快照那一份；`updated_at` 是**快照那一刻**，不是「現在」
            assert_eq!(
                scalar(&pool, "SELECT value FROM settings WHERE key = 'day_start_hour'").await,
                Some("4".into())
            );
            let exported_at: Value = serde_json::from_str::<Value>(&json)
                .unwrap()
                .get("exported_at")
                .unwrap()
                .clone();
            assert_eq!(
                scalar(&pool, "SELECT updated_at FROM settings WHERE key = 'day_start_hour'").await,
                exported_at.as_str().map(str::to_string)
            );
            // 白名單以外的設定一個字都不動
            assert_eq!(
                scalar(&pool, "SELECT value FROM settings WHERE key = 'theme'").await,
                Some("sepia".into())
            );

            // 格子：hlc 由列的 `updated_at` 派生（13 位毫秒＋0000－裝置尾碼），不是「匯入這一刻」
            assert!(report.stamped_cells > 0, "應該補了格子");
            let hlc = scalar(
                &pool,
                "SELECT hlc FROM sync_cells WHERE tbl = 'nodes' AND row_id = 'T1' AND col = 'name'",
            )
            .await
            .expect("T1.name 應該有格子");
            // 2026-09-19T05:06:07.008Z ⇒ 1789794367008（毫秒）＋0000 計數＋裝置尾碼
            assert!(hlc.starts_with("17897943670080000-"), "派生 hlc：{hlc}");
            // 競合日誌永不進同步（`stamp_missing_cells` 的既有規則，匯入之後照舊成立）
            assert_eq!(
                scalar(&pool, "SELECT hlc FROM sync_cells WHERE tbl='work_logs' AND row_id='W2'").await,
                None
            );

            drop_pool(pool, path).await;
        });
    }

    /// schema 比本機新 ⇒ 拒絕，而且**本機一個字都沒動**（驗證在動手之前）
    #[test]
    fn 匯入_較新的版本_拒絕且本機零改變() {
        tauri::async_runtime::block_on(async {
            let (pool, path) = make_pool("schema").await;
            seed(&pool).await;
            let before = dump(&pool).await;

            let mut doc: Value = serde_json::from_str(
                &engine::build_full_json(&pool, SnapshotKind::Manual).await.unwrap(),
            )
            .unwrap();
            doc["schema"] = Value::from(SCHEMA_VERSION + 1);
            let err = import_full_json(&pool, &doc.to_string(), "dev-1")
                .await
                .unwrap_err();
            assert!(err.contains("較新的版本"), "訊息：{err}");
            assert_eq!(dump(&pool).await, before, "拒絕時本機零改變");

            // 缺三表之一＝內容不完整（同樣在動手之前擋下）
            let mut broken: Value = serde_json::from_str(
                &engine::build_full_json(&pool, SnapshotKind::Manual).await.unwrap(),
            )
            .unwrap();
            broken.as_object_mut().unwrap().remove("occurrences");
            let err = import_full_json(&pool, &broken.to_string(), "dev-1")
                .await
                .unwrap_err();
            assert!(err.contains("不完整"), "訊息：{err}");
            assert_eq!(dump(&pool).await, before);

            // 整份不是 JSON
            assert!(import_full_json(&pool, "{ 壞掉的", "dev-1").await.is_err());
            // 比本機舊的 schema 要收（缺的欄吃 DEFAULT）
            let mut older: Value = serde_json::from_str(
                &engine::build_full_json(&pool, SnapshotKind::Manual).await.unwrap(),
            )
            .unwrap();
            older["schema"] = Value::from(1);
            assert!(import_full_json(&pool, &older.to_string(), "dev-1").await.is_ok());

            drop_pool(pool, path).await;
        });
    }

    /// 必填欄不齊的列跳過（`skipped_rows`），其餘照灌；多出來的未知欄丟掉不當錯
    #[test]
    fn 匯入_必填欄不齊的列跳過() {
        tauri::async_runtime::block_on(async {
            let (pool, path) = make_pool("skip").await;
            seed(&pool).await;
            let mut doc: Value = serde_json::from_str(
                &engine::build_full_json(&pool, SnapshotKind::Manual).await.unwrap(),
            )
            .unwrap();
            {
                let nodes = doc["nodes"].as_array_mut().unwrap();
                // ① 缺 `name`（★ NOT NULL 無 DEFAULT）
                nodes[3].as_object_mut().unwrap().remove("name");
                // ② `name` 給 null＝與「沒有這一欄」同義
                nodes[2]["name"] = Value::Null;
                // ③ 未來版本多出來的欄：丟掉，不能讓整趟失敗
                nodes[0]["未來的欄"] = Value::from("whatever");
                // ④ 可 NULL 欄給 null：照收（不是跳過）
                nodes[1]["description"] = Value::Null;
                // ⑤ 有 DEFAULT 的欄缺：吃 DEFAULT（position → 0）
                nodes[1].as_object_mut().unwrap().remove("position");
            }
            let report = import_full_json(&pool, &doc.to_string(), "dev-1").await.unwrap();
            assert_eq!(report.nodes, 3, "灌進去的 nodes（T1／K1 被跳過）");
            // 缺 name 與 name=null 各跳過一列（2）＋掛在 T1 底下的 W1／W2／O1 成了孤兒（3）
            assert_eq!(report.skipped_rows, 5, "跳過的列數（含連帶撤掉的孤兒）");
            assert_eq!(
                scalar(&pool, "SELECT id FROM work_logs WHERE id = 'W1'").await,
                None,
                "父列沒還回來，掛在它底下的日誌也不該留"
            );
            assert_eq!(
                scalar(&pool, "SELECT CAST(position AS TEXT) FROM nodes WHERE id = 'R1'").await,
                Some("0".into()),
                "缺的欄要吃 DEFAULT"
            );
            assert_eq!(
                scalar(&pool, "SELECT description FROM nodes WHERE id = 'R1'").await,
                None,
                "可 NULL 欄給 null 就是 NULL"
            );
            drop_pool(pool, path).await;
        });
    }

    /// CHECK 違反＝壞檔：整個交易回滾，本機停在原樣（不做半吊子相容）
    #[test]
    fn 匯入_不合法的值_整趟回滾() {
        tauri::async_runtime::block_on(async {
            let (pool, path) = make_pool("check").await;
            seed(&pool).await;
            let before = dump(&pool).await;
            let mut doc: Value = serde_json::from_str(
                &engine::build_full_json(&pool, SnapshotKind::Manual).await.unwrap(),
            )
            .unwrap();
            doc["nodes"][0]["kind"] = Value::from("宇宙船");
            let err = import_full_json(&pool, &doc.to_string(), "dev-1")
                .await
                .unwrap_err();
            assert!(err.contains("不合法"), "訊息：{err}");
            assert_eq!(dump(&pool).await, before, "壞檔＝整趟回滾，本機零改變");
            drop_pool(pool, path).await;
        });
    }
}
