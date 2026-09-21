//! 備份三件套的 Rust 端——**M3 ⑥ Wave B · WP1：機制實作**（WP0 立的簽名與 JSON shape 一個字沒動）。
//!
//! 拍板：`docs/決策記錄.md`〈⑥ 備份三件套實施計畫拍板〉；設計＝
//! `docs/research/2026-09-14-M3⑥備份三件套-實施計畫草案.md` §4。
//!
//! 契約鐵則（TS 端 `src/data/backupRepository.ts` 照這份編譯，欄位同名同形）：
//!   * `BackupReport` ＝ internally tagged enum，判別欄位 `status`：
//!     `{"status":"skipped_today"}` / `{"status":"ok","path":"…"}` /
//!     `{"status":"error","message":"…"}` / `{"status":"no_db"}`
//!   * `PolicyReport` ＝ `{"removed":["…"],"secondary":{"ok":true,"path":"…"}|{"ok":false,"message":"…"}|null}`
//!   * `BackupEntry`  ＝ `{file_name,path,location,kind,created_at,size_bytes}`（snake_case，不轉 camel）
//!   * `FileInfo`     ＝ `{path,size_bytes,page_count?,tables:[…]}`
//!
//! 機制摘要：
//!   * 快照＝`VACUUM INTO`（唯讀 sqlx 連線；WAL 下讀的是交易一致快照，不碰 `-wal`）→ 先寫 `.tmp` 再 rename。
//!   * 啟動 plugin（**註冊在 `tauri_plugin_sql` 之前**，見 `lib.rs`）在 `setup` 裡「當日未備即備」，
//!     結果存進 managed state 供 `backup_startup_report` 讀。順序有 `order_probe()` 兩行 log 實證。
//!   * 輪替：主位置 `backups/` 的 auto＋manual 合計保留 `keep` 份；`backups/safety/` 另計 3 份。
//!   * 鏡射：第二位置補齊「主位置 auto／manual 在 keep 配額內的全部份數」＋同 `keep` 輪替（冪等）；
//!     失敗只回 `SecondaryReport::err`，不影響主備份。
//!   * 還原：validate →保險快照→**先** copy 到 `next-stop-v2.db.tmp` →讀 `backup_*` 設定→關 pool
//!     →清 `-wal`／`-shm`→rename→設 WAL＋寫回設定→`app.restart()`。
//!     先 copy 再關 pool 是為了把「關了 pool 卻換檔失敗」的窗口壓到只剩 rename。
//!
//! ⑥ 沙盒真機情境鏈的七件修正（`docs/決策記錄.md`〈⑥ 沙盒真機情境鏈結論〉第 1–6、8 條）都在本檔與
//! `settings.css`／`BackupTab.tsx`：還原後補 WAL（第 1）、首開補備份（第 2，落在 `order_probe`）、
//! io_msg 補 kind 與去 `(os error N)`（第 3）、`BackupEntry.seq`（第 4）、鏡射全量（第 5）、
//! 還原保留 `backup_*` 設定（第 6）。
//!
//! 檔名規則（與 TS 的 `backupFileName` 同一份）：
//!   `next-stop-v2_YYYY-MM-DD_HHMM_{auto|manual|safety}.db`（本地時間；同分鐘第 2 份加 `-2`）

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, SecondsFormat, TimeZone, Utc};
use serde::Serialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Wry,
};
use tauri_plugin_sql::{DbInstances, DbPool};

/// DB 檔名（`app_config_dir()` 下）
const DB_FILE: &str = "next-stop-v2.db";
/// 前端 `src/lib/db.ts` 用的連線字串＝`DbInstances` map 的鍵
const DB_URL: &str = "sqlite:next-stop-v2.db";
/// 只認這個前綴的檔（c11：舊 `next-stop.db` 與 `.bak-20260806` 原地保留不讀）
const FILE_PREFIX: &str = "next-stop-v2_";
/// SQLite 檔頭 magic（含結尾的 NUL）
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
/// 保險份的獨立配額（TS 端 `BACKUP_SAFETY_KEEP` 同值）
const SAFETY_KEEP: usize = 3;

/* ═══════════════════════════════════════════════════════════════════════
   serde 型別
   ═══════════════════════════════════════════════════════════════════════ */

/// 備份來源：自動（啟動）／手動（設定頁）／保險（還原前另存，不佔保留配額）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupKind {
    Auto,
    Manual,
    Safety,
}

impl BackupKind {
    fn as_str(self) -> &'static str {
        match self {
            BackupKind::Auto => "auto",
            BackupKind::Manual => "manual",
            BackupKind::Safety => "safety",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(BackupKind::Auto),
            "manual" => Some(BackupKind::Manual),
            "safety" => Some(BackupKind::Safety),
            _ => None,
        }
    }
}

/// 備份位置：主位置（`app_config_dir()/backups/`）／第二位置（主人自選資料夾）
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupLocation {
    Primary,
    Secondary,
}

/// 清單一列＝一個實體檔案（檔名即 metadata，不做 manifest）
#[derive(Debug, Clone, Serialize)]
pub struct BackupEntry {
    pub file_name: String,
    pub path: String,
    pub location: BackupLocation,
    pub kind: BackupKind,
    /// UTC ISO 8601
    pub created_at: String,
    pub size_bytes: u64,
    /// 同分鐘序號（檔名 `-2` 那一截；無後綴＝1）。
    /// 檔名只到分鐘，同一分鐘拍兩份時清單兩列時刻一模一樣——這個欄位讓 UI 標得出「第 2 份」
    /// （⑥ 沙盒真機第 4 條）。
    pub seq: u32,
}

/// 一次備份動作的結果（TS：`BackupReport` discriminated union，判別欄位 `status`）
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BackupReport {
    /// 今天（本地日曆日）已經備過，沒再備一份
    SkippedToday,
    /// 備成功，path＝新檔絕對路徑
    Ok { path: String },
    /// 備失敗，message＝給主人看的人話
    Error { message: String },
    /// DB 檔還不存在（首次啟動、migration 尚未建檔），不算失敗
    NoDb,
}

/// 第二位置鏡射結果；`ok` 欄位恆為變體對應的布林值
/// （serde 的 internal tag 只吃字串，故用 untagged＋顯式 `ok` 欄位保住 TS 的 `{ok:true}|{ok:false}` 判別）
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum SecondaryReport {
    Ok(SecondaryOk),
    Err(SecondaryErr),
}

#[derive(Debug, Clone, Serialize)]
pub struct SecondaryOk {
    /// 恆 true
    pub ok: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecondaryErr {
    /// 恆 false
    pub ok: bool,
    pub message: String,
}

impl SecondaryReport {
    pub fn ok(path: impl Into<String>) -> Self {
        SecondaryReport::Ok(SecondaryOk { ok: true, path: path.into() })
    }

    pub fn err(message: impl Into<String>) -> Self {
        SecondaryReport::Err(SecondaryErr { ok: false, message: message.into() })
    }
}

/// 輪替＋鏡射的結果；第二位置失敗不算主備份失敗、不進連敗計數
#[derive(Debug, Clone, Serialize)]
pub struct PolicyReport {
    /// 這次輪替刪掉的檔名（保險份獨立配額，不在此列）
    pub removed: Vec<String>,
    /// 未設第二位置＝null
    pub secondary: Option<SecondaryReport>,
}

/// 驗檔通過後的檔案資訊（magic＋integrity_check＋表存在都過了才回這個）
#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
    /// 至少要有 `settings` 與 `nodes`
    pub tables: Vec<String>,
}

/// 啟動快照的結果，`app.manage` 進 managed state 給 `backup_startup_report` 讀。
///
/// 用 `Mutex` 是因為這個值會被改寫一次：全新安裝首開時 backup plugin 跑在建庫之前、只能回 `NoDb`，
/// 得等 DB 真的建好才補得到那一份（⑥ 沙盒真機第 2 條）。用 tokio 的（非 std 的）Mutex，
/// 是為了讓補備份那段（要 await）能整段握著鎖——同時到的第二個呼叫會等，而不是讀到還沒補完的 `NoDb`。
struct StartupState(tauri::async_runtime::Mutex<BackupReport>);

/* ═══════════════════════════════════════════════════════════════════════
   人話錯誤訊息
   ═══════════════════════════════════════════════════════════════════════ */

/// 還原走到「pool 已經關掉」之後才失敗時，錯誤訊息一律補這句尾巴。
/// DB 檔本身沒被動過，但這個進程已經沒有資料庫連線了——前端靠這句把設定頁鎖成
/// 「請重新啟動」不可操作態（`backupStore.RESTART_MARKER`），別讓主人繼續按一個寫不進去的 App。
/// **改動這句話要連前端那顆常數一起改。**
const POST_CLOSE_HINT: &str = "資料庫沒有被改動，但連線已經關掉了——請重新啟動私鐵手帳後再試一次。";

/// OS 錯誤訊息本文——把 Rust 加在尾巴的 `(os error N)` 剝掉，只留人看得懂的那句。
/// （⑥ 沙盒真機第 3 條：主人看到的是「…擋住了 (os error 183)」，那串編號對他沒有意義，
/// 但 OS 的英文原文仍是唯一能 Google 的線索，所以留本文、只去編號。）
fn os_text(e: &io::Error) -> String {
    let s = e.to_string();
    match s.rfind(" (os error ") {
        Some(i) if s.ends_with(')') => s[..i].trim_end().to_string(),
        _ => s,
    }
}

/// Windows 常見 raw error code 翻成人話（32/33 共用中、5 拒絕存取、112 空間不足、183/80 同名檔擋住）
fn io_msg(action: &str, path: &Path, e: &io::Error) -> String {
    let p = path.display();
    let detail = os_text(e);
    match e.raw_os_error() {
        Some(32) | Some(33) => {
            format!("{action}失敗：{p} 正被其他程式使用——另一個私鐵手帳可能還開著，或雲端同步軟體正在讀寫這個檔。")
        }
        Some(5) => format!("{action}失敗：沒有權限存取 {p}（資料夾權限或防毒擋住了）。"),
        Some(112) => format!("{action}失敗：磁碟空間不足（{p}）。"),
        Some(3) | Some(2) => format!("{action}失敗：找不到路徑 {p}（磁碟沒接上？資料夾被搬走了？）。"),
        // ERROR_ALREADY_EXISTS(183)／ERROR_FILE_EXISTS(80)：多半是有個同名的「檔案」佔著資料夾的位置
        Some(183) | Some(80) => already_exists_msg(action, &p.to_string(), &detail),
        _ => match e.kind() {
            io::ErrorKind::PermissionDenied => format!("{action}失敗：沒有權限存取 {p}。"),
            io::ErrorKind::NotFound => format!("{action}失敗：找不到 {p}。"),
            io::ErrorKind::AlreadyExists => already_exists_msg(action, &p.to_string(), &detail),
            io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => {
                format!("{action}失敗：{p} 這個路徑不合法（{detail}）。")
            }
            // Other 與其他所有 kind 的通用 fallback：句型一致，尾巴不帶 (os error N)
            _ => format!("{action}失敗：{p}（{detail}）"),
        },
    }
}

/// 同名檔案擋住去路的那句人話（資料夾位置被一個「檔案」佔著是最常見的情形）
fn already_exists_msg(action: &str, p: &str, detail: &str) -> String {
    format!("{action}失敗：同名檔案擋住了 {p}——那個位置已經有一個同名的檔案，請把它改名或移走再試一次（{detail}）。")
}

/// sqlx 的錯誤字串翻成人話（雲端佔位檔／被鎖住／不是 DB 檔）
fn sqlx_msg(action: &str, path: &Path, e: &sqlx::Error) -> String {
    let p = path.display();
    let s = e.to_string();
    let low = s.to_ascii_lowercase();
    if low.contains("unable to open database file") {
        format!("{action}失敗：打不開 {p}——路徑不存在、沒有權限，或這個檔還留在雲端沒下載下來（OneDrive／pCloud 的佔位檔）。")
    } else if low.contains("not a database") || low.contains("file is encrypted") {
        format!("{action}失敗：{p} 不是 SQLite 資料庫檔（或已經毀損）。")
    } else if low.contains("database is locked") || low.contains("busy") {
        format!("{action}失敗：資料庫被鎖住了（另一個私鐵手帳還開著？）。")
    } else if low.contains("readonly") || low.contains("read-only") {
        format!("{action}失敗：{p} 是唯讀的，寫不進去。")
    } else if low.contains("disk is full") {
        format!("{action}失敗：磁碟空間不足（{p}）。")
    } else {
        format!("{action}失敗：{p}（{s}）")
    }
}

/* ═══════════════════════════════════════════════════════════════════════
   路徑
   ═══════════════════════════════════════════════════════════════════════ */

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("找不到 App 設定資料夾（{e}）。"))
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(DB_FILE))
}

/// 主位置；順帶 `create_dir_all`（前端的「開啟備份資料夾」永遠有路徑可指）
fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_dir(app)?.join("backups");
    fs::create_dir_all(&dir).map_err(|e| io_msg("建立備份資料夾", &dir, &e))?;
    Ok(dir)
}

/// 保險份的子資料夾（獨立配額，不佔 keep）
fn safety_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = backups_dir(app)?.join("safety");
    fs::create_dir_all(&dir).map_err(|e| io_msg("建立保險備份資料夾", &dir, &e))?;
    Ok(dir)
}

/// `foo.db` → `foo.db.tmp`（`with_extension` 會吃掉原副檔名，這裡要的是「加一截」）
fn tmp_of(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".tmp");
    PathBuf::from(s)
}

/// `next-stop-v2.db` → `next-stop-v2.db-wal` ／ `-shm`
fn sidecar(db: &Path, suffix: &str) -> PathBuf {
    let mut s = db.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/* ═══════════════════════════════════════════════════════════════════════
   檔名（與 TS 的 backupFileName／parseBackupFileName 同一份規格）
   ═══════════════════════════════════════════════════════════════════════ */

fn file_name(kind: BackupKind, at: DateTime<Local>, seq: u32) -> String {
    let tail = if seq > 1 { format!("-{seq}") } else { String::new() };
    format!(
        "{FILE_PREFIX}{}_{}{}.db",
        at.format("%Y-%m-%d_%H%M"),
        kind.as_str(),
        tail
    )
}

#[derive(Debug, Clone)]
struct ParsedName {
    kind: BackupKind,
    /// `YYYY-MM-DD`（本地日曆日，`has_today` 直接比字串）
    day: String,
    y: i32,
    mo: u32,
    d: u32,
    h: u32,
    mi: u32,
    seq: u32,
}

impl ParsedName {
    /// 字串序＝時間序的排序鍵（seq 補零，避免 `auto-2` 排到 `auto` 前面）
    fn sort_key(&self) -> String {
        format!("{}_{:02}{:02}_{:03}", self.day, self.h, self.mi, self.seq)
    }

    /// 檔名裡的本地時刻 → UTC ISO 8601
    fn created_at_utc(&self) -> Option<String> {
        Local
            .with_ymd_and_hms(self.y, self.mo, self.d, self.h, self.mi, 0)
            .single()
            .map(|t| t.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true))
    }
}

/// 解析備份檔名；不是備份檔（舊 DB、`.tmp` 半檔、其他人的檔）回 None
fn parse_name(name: &str) -> Option<ParsedName> {
    let stem = name.strip_prefix(FILE_PREFIX)?.strip_suffix(".db")?;
    let mut it = stem.splitn(3, '_');
    let day = it.next()?; // YYYY-MM-DD
    let hhmm = it.next()?; // HHMM
    let tail = it.next()?; // auto | auto-2
    if day.len() != 10 || hhmm.len() != 4 {
        return None;
    }
    let db = day.as_bytes();
    if db[4] != b'-' || db[7] != b'-' {
        return None;
    }
    let y: i32 = day[0..4].parse().ok()?;
    let mo: u32 = day[5..7].parse().ok()?;
    let d: u32 = day[8..10].parse().ok()?;
    let h: u32 = hhmm[0..2].parse().ok()?;
    let mi: u32 = hhmm[2..4].parse().ok()?;
    let mut tail_it = tail.split('-');
    let kind = BackupKind::parse(tail_it.next()?)?;
    let seq: u32 = match tail_it.next() {
        Some(s) => s.parse().ok()?,
        None => 1,
    };
    if tail_it.next().is_some() {
        return None;
    }
    Some(ParsedName { kind, day: day.to_string(), y, mo, d, h, mi, seq })
}

/// 找一個還不存在的目標檔名（`VACUUM INTO` 目標已存在必失敗，故需同分鐘序號）
fn next_free(dir: &Path, kind: BackupKind, at: DateTime<Local>) -> Result<PathBuf, String> {
    for seq in 1..=99u32 {
        let p = dir.join(file_name(kind, at, seq));
        if !p.exists() && !tmp_of(&p).exists() {
            return Ok(p);
        }
    }
    Err(format!("同一分鐘內已經有 99 份備份了，請稍後再試（{}）。", dir.display()))
}

/* ═══════════════════════════════════════════════════════════════════════
   快照：唯讀 sqlx 連線 + VACUUM INTO + .tmp → rename
   ═══════════════════════════════════════════════════════════════════════ */

/// 開一條 sqlx 連線讀來源 DB。
/// `read_only=true` 是常態；上次沒乾淨關閉留下待回復的 WAL 時唯讀開不起來，外層會退回讀寫再試一次。
async fn open_source(db: &Path, read_only: bool) -> Result<sqlx::SqliteConnection, sqlx::Error> {
    SqliteConnectOptions::new()
        .filename(db)
        .create_if_missing(false)
        .read_only(read_only)
        .connect()
        .await
}

/// 一次 `VACUUM INTO` 嘗試。bind 參數優先（§4 的 probe 項）；被拒就退回單引號加倍的字面值。
async fn vacuum_into(db: &Path, tmp: &Path, read_only: bool) -> Result<(), String> {
    let mut conn = open_source(db, read_only)
        .await
        .map_err(|e| sqlx_msg("開啟資料庫", db, &e))?;

    let tmp_str = tmp.to_string_lossy().to_string();
    let bind_result = sqlx::query("VACUUM INTO ?1").bind(&tmp_str).execute(&mut conn).await;

    let outcome = match bind_result {
        Ok(_) => Ok(()),
        Err(bind_err) => {
            // bind 不被接受時的退路：半檔先清掉（目標已存在 VACUUM INTO 必失敗），再用字面值重來
            eprintln!("[backup] VACUUM INTO 的 bind 參數不被接受（{bind_err}），改用字面值重試");
            let _ = fs::remove_file(tmp);
            let escaped = tmp_str.replace('\'', "''");
            sqlx::query(&format!("VACUUM INTO '{escaped}'"))
                .execute(&mut conn)
                .await
                .map(|_| ())
                .map_err(|e| sqlx_msg("建立備份快照", tmp, &e))
        }
    };

    let _ = conn.close().await;
    outcome
}

/// 快照：`db` → `dest`（先寫 `dest.tmp` 再 rename，半檔不會被當成備份列出）
async fn snapshot(db: &Path, dest: &Path) -> Result<(), String> {
    if !db.exists() {
        return Err(format!("找不到資料庫檔 {}。", db.display()));
    }
    let tmp = tmp_of(dest);
    let mut last_err = String::new();

    // 先唯讀（常態），失敗再讀寫（WAL 待回復時唯讀連線開不起來）
    for read_only in [true, false] {
        let _ = fs::remove_file(&tmp);
        match vacuum_into(db, &tmp, read_only).await {
            Ok(()) => {
                fs::rename(&tmp, dest).map_err(|e| {
                    let _ = fs::remove_file(&tmp);
                    io_msg("把備份改名", dest, &e)
                })?;
                return Ok(());
            }
            Err(e) => {
                if read_only {
                    eprintln!("[backup] 唯讀快照失敗（{e}），改用讀寫連線重試一次");
                }
                last_err = e;
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(last_err)
}

/* ═══════════════════════════════════════════════════════════════════════
   掃描與輪替
   ═══════════════════════════════════════════════════════════════════════ */

/// 掃一個資料夾裡的備份檔（只認前綴＋合法檔名；`.tmp` 半檔天然被擋掉）
fn scan(dir: &Path, location: BackupLocation) -> Vec<(ParsedName, BackupEntry)> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(parsed) = parse_name(&name) else { continue };
        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let created_at = parsed.created_at_utc().unwrap_or_else(|| {
            // 檔名時刻落在 DST 缺口之類的極端狀況：退回檔案 mtime
            meta.modified()
                .map(|t| DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Secs, true))
                .unwrap_or_default()
        });
        let path = entry.path();
        out.push((
            parsed.clone(),
            BackupEntry {
                file_name: name,
                path: path.to_string_lossy().to_string(),
                location,
                kind: parsed.kind,
                created_at,
                size_bytes: meta.len(),
                seq: parsed.seq,
            },
        ));
    }
    // 新的排前面
    out.sort_by(|a, b| b.0.sort_key().cmp(&a.0.sort_key()));
    out
}

/// 輪替一個資料夾：只留最新 `keep` 份，回傳刪掉的檔名。
/// `only` 為 None＝全收；Some(&[…])＝只算這些 kind（主位置只輪替 auto／manual）。
fn rotate(dir: &Path, keep: usize, only: Option<&[BackupKind]>) -> Vec<String> {
    let rows = scan(dir, BackupLocation::Primary);
    let mut removed = Vec::new();
    let kept: Vec<_> = rows
        .into_iter()
        .filter(|(p, _)| only.map(|ks| ks.contains(&p.kind)).unwrap_or(true))
        .collect();
    for (_, e) in kept.into_iter().skip(keep.max(1)) {
        match fs::remove_file(&e.path) {
            Ok(()) => removed.push(e.file_name),
            Err(err) => eprintln!("[backup] 輪替刪檔失敗（{}）：{err}", e.path),
        }
    }
    removed
}

const PRIMARY_KINDS: [BackupKind; 2] = [BackupKind::Auto, BackupKind::Manual];

/* ═══════════════════════════════════════════════════════════════════════
   第二位置鏡射
   ═══════════════════════════════════════════════════════════════════════ */

/// 把主位置的 auto／manual **全部**（受 `keep` 上限，新→舊）鏡射到第二位置，
/// 再在第二位置套同一份 keep 輪替。保險份不鏡射。
/// 任何失敗都只回 `SecondaryReport::err`——不影響主備份，也不進連敗計數。
///
/// ⑥ 沙盒真機第 5 條：原本只搬「最新一份」，於是第二位置設定之後只會慢慢長出來，
/// 換機時手上那顆碟裡只有一份可還原。現在改成「第二位置缺的都補」——
/// 同名同大小視為已有（不重抄），所以這個函式是**冪等**的：第二次跑一個檔都不會動。
fn mirror(primary: &Path, secondary: &str, keep: usize) -> SecondaryReport {
    let dir = PathBuf::from(secondary);
    if let Err(e) = fs::create_dir_all(&dir) {
        return SecondaryReport::err(io_msg("開啟第二備份位置", &dir, &e));
    }

    // scan 已經由新到舊排好；只取 auto／manual，且最多 keep 份（第二位置的配額與主位置同一個）
    let wanted: Vec<BackupEntry> = scan(primary, BackupLocation::Primary)
        .into_iter()
        .filter(|(p, _)| PRIMARY_KINDS.contains(&p.kind))
        .map(|(_, e)| e)
        .take(keep.max(1))
        .collect();

    if wanted.is_empty() {
        // 主位置還沒有可鏡射的檔（例如首次啟動 no_db）——不算失敗
        return SecondaryReport::ok(dir.to_string_lossy().to_string());
    }

    // 新的先抄：中途失敗（碟滿、NAS 斷線）時手上至少有最新那份
    let mut newest_dest: Option<PathBuf> = None;
    let mut copied = 0usize;
    for e in &wanted {
        let dest = dir.join(&e.file_name);
        let already = fs::metadata(&dest).map(|m| m.len() == e.size_bytes).unwrap_or(false);
        if !already {
            if let Err(msg) = copy_with_retry(Path::new(&e.path), &dest) {
                return SecondaryReport::err(msg);
            }
            copied += 1;
        }
        if newest_dest.is_none() {
            newest_dest = Some(dest);
        }
    }
    if copied > 0 {
        eprintln!("[backup] 第二位置補齊 {copied} 份（共 {} 份在配額內）", wanted.len());
    }

    // 第二位置也輪替（同 keep；保險份本來就不在這裡）
    let removed = rotate(&dir, keep, Some(&PRIMARY_KINDS));
    if !removed.is_empty() {
        eprintln!("[backup] 第二位置輪替刪掉 {} 份", removed.len());
    }
    SecondaryReport::ok(
        newest_dest.unwrap_or_else(|| dir.clone()).to_string_lossy().to_string(),
    )
}

/// 複製到第二位置：先寫 `.tmp` 再 rename（雲端看到半檔就會開始上傳）；
/// 同步鎖檔（sharing violation）重試一次後放棄（§5-4）。
fn copy_with_retry(src: &Path, dest: &Path) -> Result<(), String> {
    let tmp = tmp_of(dest);
    let mut last: Option<io::Error> = None;
    for attempt in 0..2 {
        let _ = fs::remove_file(&tmp);
        match fs::copy(src, &tmp).and_then(|_| fs::rename(&tmp, dest)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if attempt == 0 {
                    eprintln!("[backup] 鏡射到第二位置失敗（{e}），重試一次");
                }
                last = Some(e);
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(io_msg("鏡射到第二備份位置", dest, &last.unwrap()))
}

/* ═══════════════════════════════════════════════════════════════════════
   驗檔
   ═══════════════════════════════════════════════════════════════════════ */

async fn validate(path: &Path) -> Result<FileInfo, String> {
    let meta = fs::metadata(path).map_err(|e| io_msg("讀取備份檔", path, &e))?;
    if !meta.is_file() {
        return Err(format!("{} 不是一個檔案。", path.display()));
    }
    let size = meta.len();
    if size < SQLITE_MAGIC.len() as u64 {
        return Err(format!("{} 太小了，不像是備份檔（{size} bytes）。", path.display()));
    }

    // ① 檔頭 magic
    let head = read_head(path, 16).map_err(|e| io_msg("讀取備份檔", path, &e))?;
    if &head[..] != SQLITE_MAGIC {
        return Err(if head.iter().all(|b| *b == 0) {
            format!(
                "{} 還留在雲端沒下載下來（檔頭全是 0 的佔位檔）——請先在檔案總管對它按「一律保留在此裝置上」，等同步完成再試一次。",
                path.display()
            )
        } else {
            format!("{} 不是 SQLite 備份檔（檔頭對不上）。", path.display())
        });
    }

    // ② PRAGMA integrity_check ＋ page_count ＋ 表存在
    let mut conn = open_source(path, true)
        .await
        .map_err(|e| sqlx_msg("開啟備份檔", path, &e))?;

    let verdict: Result<String, String> = async {
        let row = sqlx::query("PRAGMA integrity_check")
            .fetch_one(&mut conn)
            .await
            .map_err(|e| sqlx_msg("檢查備份檔完整性", path, &e))?;
        row.try_get::<String, _>(0)
            .map_err(|e| format!("檢查備份檔完整性失敗：{}（{e}）", path.display()))
    }
    .await;

    let page_count = sqlx::query("PRAGMA page_count")
        .fetch_one(&mut conn)
        .await
        .ok()
        .and_then(|r| r.try_get::<i64, _>(0).ok())
        .map(|n| n.max(0) as u32);

    let tables: Vec<String> = match sqlx::query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(&mut conn)
    .await
    {
        Ok(rows) => rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect(),
        Err(e) => {
            let _ = conn.close().await;
            return Err(sqlx_msg("讀取備份檔的表清單", path, &e));
        }
    };
    let _ = conn.close().await;

    match verdict? {
        v if v == "ok" => {}
        v => return Err(format!("{} 的資料已經毀損，不能用來還原（{v}）。", path.display())),
    }

    for need in ["settings", "nodes"] {
        if !tables.iter().any(|t| t == need) {
            return Err(format!(
                "{} 裡沒有 `{need}` 表——這不是私鐵手帳的備份檔。",
                path.display()
            ));
        }
    }

    Ok(FileInfo { path: path.to_string_lossy().to_string(), size_bytes: size, page_count, tables })
}

fn read_head(path: &Path, n: usize) -> io::Result<Vec<u8>> {
    use io::Read;
    let mut f = fs::File::open(path)?;
    let mut buf = vec![0u8; n];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/* ═══════════════════════════════════════════════════════════════════════
   commands（七支；簽名與回傳 shape 照 WP0 契約）
   ═══════════════════════════════════════════════════════════════════════ */

/// 讀啟動時（migration 之前）那一次快照的結果。
///
/// 幾乎總是純讀 managed state。**唯一的例外**是全新安裝的第一次：那時 backup plugin 跑在 DB 出生之前，
/// 存進去的只能是 `NoDb`，所以這裡先補一次（`backfill_first_run`，兩道守門：報告是 NoDb、DB 此刻存在），
/// 順便做一次 WAL 的冪等保證。兩件事都要等前端把 DB 載起來才做得到，而前端正是在載完 DB 之後才叫這支
/// ——所以落點在這裡，不在 plugin 的 setup（那時 `next-stop-v2.db` 根本還不存在，實測過）。
#[tauri::command]
pub async fn backup_startup_report(app: AppHandle) -> BackupReport {
    if app.try_state::<StartupState>().is_none() {
        return BackupReport::Error {
            message: "啟動備份的狀態不見了（backup plugin 沒掛上？）。".into(),
        };
    }
    ensure_wal(&app).await;
    backfill_first_run(&app).await;
    let state = app.state::<StartupState>();
    let report = state.0.lock().await.clone();
    report
}

/// 立即備份一份（`kind` 目前只會是 `"manual"`），接著套用輪替＋鏡射。
/// JS 參數：`{ kind, keep, secondary }`（`secondary` 為 null＝未設第二位置）
#[tauri::command]
pub async fn backup_now(
    app: AppHandle,
    kind: String,
    keep: u32,
    secondary: Option<String>,
) -> Result<BackupReport, String> {
    let kind = BackupKind::parse(&kind).unwrap_or(BackupKind::Manual);
    let db = db_path(&app)?;
    if !db.exists() {
        return Ok(BackupReport::NoDb);
    }
    let dir = backups_dir(&app)?;
    let dest = next_free(&dir, kind, Local::now())?;
    match snapshot(&db, &dest).await {
        Ok(()) => {
            // 輪替與鏡射跟著做；第二位置失敗不影響這次主備份的成敗
            let _ = apply_policy_inner(&app, keep, secondary).await;
            Ok(BackupReport::Ok { path: dest.to_string_lossy().to_string() })
        }
        Err(message) => Ok(BackupReport::Error { message }),
    }
}

/// 只做輪替與鏡射（Rust 不讀 settings，故由前端載入設定後補呼叫）。
/// JS 參數：`{ keep, secondary }`
#[tauri::command]
pub async fn backup_apply_policy(
    app: AppHandle,
    keep: u32,
    secondary: Option<String>,
) -> Result<PolicyReport, String> {
    apply_policy_inner(&app, keep, secondary).await
}

async fn apply_policy_inner(
    app: &AppHandle,
    keep: u32,
    secondary: Option<String>,
) -> Result<PolicyReport, String> {
    let dir = backups_dir(app)?;
    let keep = keep.max(1) as usize;

    // 主位置：auto＋manual 合計 keep 份
    let removed = rotate(&dir, keep, Some(&PRIMARY_KINDS));
    // 保險份：獨立配額 3 份，刪掉的不列進 removed（契約：removed 不含保險份）
    if let Ok(sdir) = safety_dir(app) {
        let _ = rotate(&sdir, SAFETY_KEEP, None);
    }

    // 第二位置：丟到背景 task 做（NAS 離線時 metadata() 可能卡秒級，別壓在 command 自己的 task 上）
    let secondary = match secondary.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        None => None,
        Some(target) => {
            let primary = dir.clone();
            let handle = tauri::async_runtime::spawn(async move {
                tauri::async_runtime::spawn_blocking(move || mirror(&primary, &target, keep))
                    .await
                    .unwrap_or_else(|e| SecondaryReport::err(format!("鏡射時發生非預期錯誤（{e}）。")))
            });
            Some(handle.await.unwrap_or_else(|e| {
                SecondaryReport::err(format!("鏡射時發生非預期錯誤（{e}）。"))
            }))
        }
    };

    Ok(PolicyReport { removed, secondary })
}

/// 列清單：主位置＋（有設就加）第二位置；只認 `next-stop-v2_` 前綴（舊 DB 不碰）。
/// 順帶保證 `backups/` 存在（`create_dir_all`），讓前端的「開啟備份資料夾」永遠有路徑可指。
/// JS 參數：`{ secondary }`
#[tauri::command]
pub async fn backup_list(app: AppHandle, secondary: Option<String>) -> Result<Vec<BackupEntry>, String> {
    let dir = backups_dir(&app)?;
    let sdir = safety_dir(&app)?;

    let mut rows: Vec<(ParsedName, BackupEntry)> = scan(&dir, BackupLocation::Primary);
    rows.extend(scan(&sdir, BackupLocation::Primary));

    if let Some(target) = secondary.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        rows.extend(scan(Path::new(&target), BackupLocation::Secondary));
    }

    rows.sort_by(|a, b| b.0.sort_key().cmp(&a.0.sort_key()));
    Ok(rows.into_iter().map(|(_, e)| e).collect())
}

/// 驗一個 `.db` 能不能還原：檔頭 magic `SQLite format 3\0`＋`PRAGMA integrity_check`＋表存在。
/// JS 參數：`{ path }`
#[tauri::command]
pub async fn backup_validate_file(_app: AppHandle, path: String) -> Result<FileInfo, String> {
    validate(Path::new(&path)).await
}

/// 還原：驗檔→另存保險份→關 pool（`DbInstances`）→清 `-wal`／`-shm`→換檔→`app.restart()`。
/// **成功不會回來**（進程重啟）；失敗回 `Err(人話)` 且 DB 檔未動。
/// JS 參數：`{ path }`
#[tauri::command]
pub async fn backup_restore(app: AppHandle, path: String) -> Result<(), String> {
    let src = PathBuf::from(&path);
    let db = db_path(&app)?;
    let sdir = safety_dir(&app)?;

    // ①②③ 換檔前的準備（驗檔→保險份→複製到 .tmp）——全都還沒動到現有 DB，失敗直接回頭
    let tmp = restore_prepare(&db, &sdir, &src).await?;

    // ③-b 先把 backup_* 設定讀出來（⑥ 沙盒真機第 6 條）。
    //     備份檔裡的 settings 是「拍快照當下」那一版，還原等於把第二位置、保留份數一起帶回過去；
    //     換機情境下那份設定才是現在這台機器的真相，所以換檔後要原樣寫回去。
    //     讀不到就算了（空 Vec＝不寫回），不擋還原。
    let saved_settings = read_backup_settings(&app).await;

    // ④ 關 pool 並從 DbInstances 移除（移除後 plugin-sql 的 RunEvent::Exit 不會再 close 一次）
    close_app_pool(&app).await;

    // ⑤ 乾淨關閉時 SQLite 會自己 checkpoint 並刪掉 -wal／-shm；沒刪掉就手動清，
    //    否則舊 WAL 的 frame 會被重放到還原後的新檔上（§5-1）
    for suffix in ["-wal", "-shm"] {
        let side = sidecar(&db, suffix);
        // 這一步已經在 pool 關掉之後：失敗要清掉 .tmp（不留垃圾），訊息也要說「請重新啟動」
        if let Err(e) = remove_sidecar(&side) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("{} {POST_CLOSE_HINT}", io_msg("清除 WAL 附屬檔", &side, &e)));
        }
    }

    // ⑥ 換檔（同磁碟 rename；Windows 的 MoveFileEx 會覆蓋既有檔）
    fs::rename(&tmp, &db).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{} {POST_CLOSE_HINT}", io_msg("換上備份檔", &db, &e))
    })?;

    // ⑥-a v1.1.2 D-1.1-4：還原＝開新紀元。DB 已換、寫 DB 沒意義，改在 app 資料目錄留一個標記檔，
    //     下次啟動由 sync 引擎（`sync_status().restore_pending` → `sync_begin_new_epoch`）收尾。失敗只 log。
    if let Err(e) = crate::sync::engine::mark_restore_pending(&app) {
        eprintln!("[backup] 還原後留同步標記失敗（若有啟用同步，請到設定→同步重設後重新啟用）：{e}");
    }

    // ⑥-b 換檔之後、重啟之前的收尾：WAL 模式＋把 backup_* 設定寫回去（同一條連線）。
    //     失敗只 log 不擋重啟——資料已經換好了，這裡再回錯只會讓主人以為還原失敗。
    if let Err(e) = finalize_restored_db(&db, &saved_settings).await {
        eprintln!("[backup] 還原後收尾沒做完（不影響資料，重啟後會自動補 WAL）：{e}");
    }

    // ⑦ 重啟（不會回來）
    app.restart()
}

/// 讀出目前 DB 的 `backup_%` 設定（走 plugin-sql 那條 pool，不另開連線搶鎖）。
/// 讀不到一律回空 Vec——這是「盡力保住設定」，不是還原的前置條件。
async fn read_backup_settings(app: &AppHandle) -> Vec<(String, String)> {
    let Some(instances) = app.try_state::<DbInstances>() else { return Vec::new() };
    let lock = instances.0.read().await;
    let Some(pool) = lock.get(DB_URL) else { return Vec::new() };
    let DbPool::Sqlite(pool) = pool;
    match sqlx::query("SELECT key, value FROM settings WHERE key LIKE 'backup\\_%' ESCAPE '\\'")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows
            .iter()
            .filter_map(|r| Some((r.try_get::<String, _>(0).ok()?, r.try_get::<String, _>(1).ok()?)))
            .collect(),
        Err(e) => {
            eprintln!("[backup] 還原前讀 backup_* 設定失敗（設定會跟著備份檔回到過去）：{e}");
            Vec::new()
        }
    }
}

/// 刪 `-wal`／`-shm`，**撞到還沒放乾淨的鎖就退一步再試**（整合席 v1.1.2 沙盒情境⑦抓到）。
///
/// 為什麼要重試：`pool.close().await` 回來時，SQLite 自己那一輪「checkpoint → 刪掉 -wal」還在路上，
/// 有一小段時間檔案**還在、而且還被抓著**。原本的寫法在那個瞬間 `remove_file` 會吃到
/// Windows 的共用違規（os error 32），整個還原就停在這裡——主人看到的是「請重新啟動後再試一次」，
/// 而且重啟後 WAL 早被清掉、下一次就好了，正是典型的間歇性失敗（沙盒實測：每次都踩得到）。
///
/// 每輪都重新看 `exists()`：SQLite 自己刪掉了就是成功，這是最常見的結局。
/// 用 `std::thread::sleep` 而不是非同步睡：最壞總共 770 ms、而且下一步就是 `app.restart()`，
/// 為了這段把整支改成 `spawn_blocking` 不划算。
fn remove_sidecar(side: &Path) -> Result<(), io::Error> {
    const WAITS_MS: [u64; 6] = [0, 20, 50, 100, 200, 400];
    let mut last: Option<io::Error> = None;
    for (i, wait) in WAITS_MS.iter().enumerate() {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(*wait));
        }
        if !side.exists() {
            return Ok(()); // SQLite 自己收乾淨了（含前一輪剛好成功）
        }
        match fs::remove_file(side) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("清不掉 WAL 附屬檔")))
}

/// 換檔之後、`app.restart()` 之前的收尾（**pool 已關，這裡是唯一一條連線**）：
///   ① `PRAGMA journal_mode=WAL` ─ `VACUUM INTO` 的產物是 rollback journal 模式，
///      sqlx 不會主動改，不補這一刀還原完的 DB 就永久掉出 WAL（⑥ 沙盒真機第 1 條）。
///   ② 把還原前讀到的 `backup_*` 設定 upsert 回去（第 6 條）。
async fn finalize_restored_db(db: &Path, settings: &[(String, String)]) -> Result<(), String> {
    let mut conn = SqliteConnectOptions::new()
        .filename(db)
        .create_if_missing(false)
        .connect()
        .await
        .map_err(|e| sqlx_msg("開啟還原後的資料庫", db, &e))?;

    let mode = sqlx::query("PRAGMA journal_mode=WAL")
        .fetch_optional(&mut conn)
        .await
        .map_err(|e| sqlx_msg("把還原後的資料庫設回 WAL 模式", db, &e))
        .map(|r| r.and_then(|row| row.try_get::<String, _>(0).ok()).unwrap_or_default());
    match &mode {
        Ok(m) => println!("[backup] 還原後 journal_mode＝{m}"),
        Err(e) => eprintln!("[backup] {e}"),
    }

    let mut written = 0usize;
    for (k, v) in settings {
        if let Err(e) = sqlx::query(
            "INSERT INTO settings(key, value, updated_at) \
             VALUES(?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        )
        .bind(k)
        .bind(v)
        .execute(&mut conn)
        .await
        {
            eprintln!("[backup] 還原後寫回設定 {k} 失敗：{e}");
        } else {
            written += 1;
        }
    }
    if !settings.is_empty() {
        println!("[backup] 還原後寫回 backup_* 設定 {written}/{} 筆", settings.len());
    }

    let _ = conn.close().await;
    mode.map(|_| ())
}

/// 還原的「還沒動到現有 DB」那一段，抽出來讓測試可以在 temp 目錄整段跑完：
/// ① 驗檔 → ② 保險快照＋保險份輪替 → ③ 把來源複製到 DB 旁的 `.tmp`。
/// 回傳那個 `.tmp` 的路徑；**任何一步失敗，現有 DB 一個 byte 都沒被碰過**。
/// 先複製再關 pool，是為了把「pool 已關卻換不了檔」的窗口壓到只剩最後那一次 rename。
async fn restore_prepare(db: &Path, safety: &Path, src: &Path) -> Result<PathBuf, String> {
    validate(src).await?;

    if db.exists() {
        let dest = next_free(safety, BackupKind::Safety, Local::now())?;
        snapshot(db, &dest).await?;
        let _ = rotate(safety, SAFETY_KEEP, None);
    }

    let tmp = tmp_of(db);
    let _ = fs::remove_file(&tmp);
    fs::copy(src, &tmp).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_msg("複製備份檔", &tmp, &e)
    })?;
    Ok(tmp)
}

/// ⑧ 清場步驟二：清空 nodes／occurrences／work_logs 但保留 settings。
/// **DEV 限定**——`tauri::generate_handler!` 不吃 `#[cfg]`，故 command 恆註冊、以 `cfg!` 在 body 擋下；
/// 正式打包時呼叫會拿到錯誤，且設定頁的那顆鈕本來就只在 DEV 出現。
#[tauri::command]
pub async fn reset_database_keep_settings(app: AppHandle) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("這支指令只在開發模式可用".into());
    }

    let instances = app
        .try_state::<DbInstances>()
        .ok_or_else(|| "資料庫還沒載入（sql plugin 尚未連線）。".to_string())?;
    let lock = instances.0.read().await;
    let pool = lock
        .get(DB_URL)
        .ok_or_else(|| format!("找不到已連線的資料庫 {DB_URL}。"))?;
    let DbPool::Sqlite(pool) = pool;

    // 順序：子表先清（occurrences／work_logs 指向 nodes），settings 完全不動
    for sql in [
        "DELETE FROM occurrences",
        "DELETE FROM work_logs",
        "DELETE FROM nodes",
        "VACUUM",
    ] {
        sqlx::query(sql)
            .execute(pool)
            .await
            .map_err(|e| format!("清場失敗（{sql}）：{e}"))?;
    }
    Ok(())
}

/// 關掉並移除前端那條 pool（還原專用；移除後 plugin-sql 的 Exit handler 不會 double close）
async fn close_app_pool(app: &AppHandle) {
    let Some(instances) = app.try_state::<DbInstances>() else { return };
    let mut map = instances.0.write().await;
    if let Some(pool) = map.remove(DB_URL) {
        let DbPool::Sqlite(pool) = pool;
        pool.close().await;
    }
}

/* ═══════════════════════════════════════════════════════════════════════
   plugin
   ═══════════════════════════════════════════════════════════════════════ */

/// 啟動快照（同步版，plugin setup 用）：plugin setup 跑在主執行緒、不在 tokio worker 上，block_on 安全。
fn run_startup(app: &AppHandle) -> BackupReport {
    tauri::async_runtime::block_on(run_startup_async(app))
}

/// 啟動快照：DB 存在且 `backups/` 裡沒有今天（本地日曆日）的 auto／manual 份就備一份。
async fn run_startup_async(app: &AppHandle) -> BackupReport {
    let db = match db_path(app) {
        Ok(p) => p,
        Err(message) => return BackupReport::Error { message },
    };
    if !db.exists() {
        return BackupReport::NoDb;
    }
    let dir = match backups_dir(app) {
        Ok(p) => p,
        Err(message) => return BackupReport::Error { message },
    };

    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let already = scan(&dir, BackupLocation::Primary)
        .iter()
        .any(|(p, _)| p.day == today && PRIMARY_KINDS.contains(&p.kind));
    if already {
        return BackupReport::SkippedToday;
    }

    let dest = match next_free(&dir, BackupKind::Auto, now) {
        Ok(p) => p,
        Err(message) => return BackupReport::Error { message },
    };
    match snapshot(&db, &dest).await {
        Ok(()) => BackupReport::Ok { path: dest.to_string_lossy().to_string() },
        Err(message) => BackupReport::Error { message },
    }
}

/// 啟動 plugin。**註冊順序＝在 `tauri_plugin_sql` 之前**（見 `lib.rs`）：
/// 在這裡的 `.setup()` 做「當日未備即備」的 `VACUUM INTO` 快照，
/// 好讓任何新 migration 跑之前一定先有前一版 schema 的快照（a28 蒸發抓回）。
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("backup")
        .setup(|app, _api| {
            // 順序實證 ①：此刻 sql plugin 還沒 manage 它的 DbInstances ⇒ 我們排在它前面
            let sql_ready = app.try_state::<DbInstances>().is_some();
            println!("[backup] plugin setup 開始：DbInstances 已就緒＝{sql_ready}（預期 false＝本 plugin 跑在 sql plugin 之前）");

            let report = run_startup(app);
            println!("[backup] 啟動快照結果：{report:?}");
            app.manage(StartupState(tauri::async_runtime::Mutex::new(report)));
            Ok(())
        })
        .build()
}

/* ═══════════════════════════════════════════════════════════════════════
   測試：不碰 `app_config_dir()`，全部在系統 temp 下自建 DB 與資料夾。
   （`backup_restore` 的換檔＋`app.restart()` 需要真的 AppHandle 與真的 pool，只能真機驗。）
   ═══════════════════════════════════════════════════════════════════════ */
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqliteJournalMode;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("next-stop-backup-test-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 建一個 WAL 模式的測試 DB，**連線故意不關**——模擬「App 開著、-wal 有未 checkpoint 的資料」
    async fn make_db(path: &Path) -> sqlx::SqliteConnection {
        let mut c = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .connect()
            .await
            .unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)").execute(&mut c).await.unwrap();
        sqlx::query("CREATE TABLE nodes (id TEXT PRIMARY KEY, title TEXT)").execute(&mut c).await.unwrap();
        for i in 0..50 {
            sqlx::query("INSERT INTO nodes VALUES (?1, ?2)")
                .bind(format!("n{i}"))
                .bind(format!("站 {i} 番線"))
                .execute(&mut c)
                .await
                .unwrap();
        }
        c
    }

    fn touch_backup(dir: &Path, name: &str) {
        fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn 檔名組解往返() {
        let at = Local.with_ymd_and_hms(2026, 9, 14, 3, 12, 0).single().unwrap();
        assert_eq!(file_name(BackupKind::Auto, at, 1), "next-stop-v2_2026-09-14_0312_auto.db");
        assert_eq!(file_name(BackupKind::Safety, at, 2), "next-stop-v2_2026-09-14_0312_safety-2.db");

        let p = parse_name("next-stop-v2_2026-09-14_0312_manual-3.db").unwrap();
        assert_eq!((p.kind, p.day.as_str(), p.h, p.mi, p.seq), (BackupKind::Manual, "2026-09-14", 3, 12, 3));

        // 不是備份檔的一律回 None（舊 DB、.tmp 半檔、亂寫的 kind）
        assert!(parse_name("next-stop.db").is_none());
        assert!(parse_name("next-stop-v2_2026-09-14_0312_auto.db.tmp").is_none());
        assert!(parse_name("next-stop-v2_2026-09-14_0312_bogus.db").is_none());
        // 同分鐘序號的排序鍵：-2 要排在無後綴之後（＝更新）
        let a = parse_name("next-stop-v2_2026-09-14_0312_auto.db").unwrap();
        let b = parse_name("next-stop-v2_2026-09-14_0312_auto-2.db").unwrap();
        assert!(b.sort_key() > a.sort_key());
    }

    #[test]
    fn 快照在_wal_下拍到一致內容且驗檔通過() {
        let dir = temp_dir("snap");
        let db = dir.join("next-stop-v2.db");
        tauri::async_runtime::block_on(async {
            let writer = make_db(&db).await;
            assert!(sidecar(&db, "-wal").exists(), "測試前提：WAL 檔應該存在");

            let dest = dir.join(file_name(BackupKind::Auto, Local::now(), 1));
            snapshot(&db, &dest).await.expect("快照應該成功");
            assert!(dest.exists());
            assert!(!tmp_of(&dest).exists(), ".tmp 半檔不該留下");

            let info = validate(&dest).await.expect("驗檔應該通過");
            assert!(info.tables.contains(&"settings".to_string()));
            assert!(info.tables.contains(&"nodes".to_string()));
            assert!(info.page_count.unwrap_or(0) > 0);

            // 快照內容＝來源內容（WAL 裡那 50 筆要在）
            let mut c = open_source(&dest, true).await.unwrap();
            let n: i64 = sqlx::query("SELECT COUNT(*) FROM nodes").fetch_one(&mut c).await.unwrap().get(0);
            assert_eq!(n, 50);
            let _ = c.close().await;
            let _ = writer.close().await;
        });
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 驗檔擋下佔位檔與非資料庫檔() {
        let dir = temp_dir("validate");
        let placeholder = dir.join("next-stop-v2_2026-09-14_0312_auto.db");
        fs::write(&placeholder, vec![0u8; 4096]).unwrap();
        let junk = dir.join("junk.db");
        fs::write(&junk, "這只是一段文字，不是資料庫".as_bytes()).unwrap();

        tauri::async_runtime::block_on(async {
            let e = validate(&placeholder).await.unwrap_err();
            assert!(e.contains("雲端"), "佔位檔的訊息要講人話：{e}");
            let e = validate(&junk).await.unwrap_err();
            assert!(e.contains("檔頭對不上"), "非 DB 檔的訊息要講人話：{e}");
            let e = validate(&dir.join("不存在.db")).await.unwrap_err();
            assert!(e.contains("找不到"), "缺檔的訊息要講人話：{e}");
        });
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 輪替只留最新的_keep_份且保險份另計() {
        let dir = temp_dir("rotate");
        for d in 10..=15 {
            touch_backup(&dir, &format!("next-stop-v2_2026-09-{d}_0300_auto.db"));
        }
        touch_backup(&dir, "next-stop-v2_2026-09-11_2100_manual.db");
        touch_backup(&dir, "next-stop.db"); // 舊 DB：不在前綴內，不該被碰
        touch_backup(&dir, "next-stop-v2_2026-09-09_0300_safety.db"); // 保險份：不進主位置配額

        let removed = rotate(&dir, 3, Some(&PRIMARY_KINDS));
        assert_eq!(removed.len(), 4, "7 份 auto/manual 留 3 份 ⇒ 刪 4 份，實際刪：{removed:?}");
        assert!(dir.join("next-stop-v2_2026-09-15_0300_auto.db").exists());
        assert!(dir.join("next-stop-v2_2026-09-14_0300_auto.db").exists());
        assert!(dir.join("next-stop-v2_2026-09-13_0300_auto.db").exists());
        assert!(!dir.join("next-stop-v2_2026-09-10_0300_auto.db").exists());
        assert!(dir.join("next-stop.db").exists(), "舊 DB 不該被輪替碰到");
        assert!(dir.join("next-stop-v2_2026-09-09_0300_safety.db").exists(), "保險份不佔主位置配額");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 還原前置_驗檔與保險份都做了且現有_db_沒被碰() {
        let dir = temp_dir("restore");
        let db = dir.join("next-stop-v2.db");
        let safety = dir.join("backups").join("safety");
        fs::create_dir_all(&safety).unwrap();

        tauri::async_runtime::block_on(async {
            let writer = make_db(&db).await;
            let before = fs::read(&db).unwrap();

            // 先做一份「要還原回去」的備份檔
            let src = dir.join(file_name(BackupKind::Manual, Local::now(), 1));
            snapshot(&db, &src).await.unwrap();

            let tmp = restore_prepare(&db, &safety, &src).await.expect("前置應該成功");
            assert!(tmp.exists(), "來源應該已經複製到 DB 旁的 .tmp");
            assert_eq!(fs::read(&tmp).unwrap(), fs::read(&src).unwrap(), ".tmp 應該是來源的完整複本");
            assert_eq!(fs::read(&db).unwrap(), before, "現有 DB 在換檔前一個 byte 都不該被碰");

            let safeties: Vec<_> = scan(&safety, BackupLocation::Primary);
            assert_eq!(safeties.len(), 1, "應該留下一份保險快照");
            assert_eq!(safeties[0].0.kind, BackupKind::Safety);
            validate(Path::new(&safeties[0].1.path)).await.expect("保險份自己也要能過驗檔");

            // 來源不合格時：直接擋下，連保險份都不多做
            let junk = dir.join("junk.db");
            fs::write(&junk, "不是資料庫".as_bytes()).unwrap();
            assert!(restore_prepare(&db, &safety, &junk).await.is_err());
            assert_eq!(scan(&safety, BackupLocation::Primary).len(), 1, "驗檔沒過就不該再多拍保險份");

            let _ = fs::remove_file(&tmp);
            let _ = writer.close().await;
        });
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    // （原名「鏡射複製最新一份…」；⑥ 第 5 條改成全量鏡射後，這條測的其實是「回傳的 path＝最新那份」
    //   與含中文空白路徑、冪等、壞路徑三件事，故正名。斷言一條沒動。）
    fn 鏡射回傳最新那份並在第二位置輪替() {
        let primary = temp_dir("mirror-primary");
        // 第二位置刻意用含中文與空白的路徑（§5-3）
        let secondary = temp_dir("mirror").join("私鐵 備份");
        for d in 12..=14 {
            touch_backup(&primary, &format!("next-stop-v2_2026-09-{d}_0300_auto.db"));
        }
        for d in 1..=5 {
            touch_backup(&primary, &format!("next-stop-v2_2026-09-0{d}_0300_auto.db"));
        }

        let r = mirror(&primary, &secondary.to_string_lossy(), 2);
        match r {
            SecondaryReport::Ok(ok) => {
                assert!(ok.ok);
                assert!(ok.path.ends_with("next-stop-v2_2026-09-14_0300_auto.db"), "應該鏡射最新那份：{}", ok.path);
            }
            SecondaryReport::Err(e) => panic!("鏡射不該失敗：{}", e.message),
        }
        assert!(secondary.join("next-stop-v2_2026-09-14_0300_auto.db").exists());
        assert!(!secondary.join("next-stop-v2_2026-09-14_0300_auto.db.tmp").exists());

        // 再鏡射一次：同名同大小 ⇒ 不重複複製，也不該報錯
        let again = mirror(&primary, &secondary.to_string_lossy(), 2);
        assert!(matches!(again, SecondaryReport::Ok(_)));

        // 第二位置指到不存在的磁碟 ⇒ 回人話錯誤，不 panic
        let bad = mirror(&primary, "Z:\\沒有這顆碟\\備份", 2);
        assert!(matches!(bad, SecondaryReport::Err(_)));

        let _ = fs::remove_dir_all(&primary);
        let _ = fs::remove_dir_all(secondary.parent().unwrap());
    }

    /// ⑥ 沙盒真機第 5 條：鏡射要把第二位置**缺的全部**補上（受 keep 上限），且冪等。
    #[test]
    fn 鏡射補齊配額內的全部份數且冪等() {
        let primary = temp_dir("mirror-full-primary");
        let secondary = temp_dir("mirror-full-secondary");

        // 主位置 5 份 auto＋1 份 manual＋1 份 safety（保險份不鏡射）
        for d in 10..=14 {
            touch_backup(&primary, &format!("next-stop-v2_2026-09-{d}_0300_auto.db"));
        }
        touch_backup(&primary, "next-stop-v2_2026-09-09_2100_manual.db");
        touch_backup(&primary, "next-stop-v2_2026-09-08_0300_safety.db");

        // 第二位置全空 ⇒ 一次補滿 keep(3) 份（新→舊＝14／13／12）
        assert!(matches!(mirror(&primary, &secondary.to_string_lossy(), 3), SecondaryReport::Ok(_)));
        for d in 12..=14 {
            assert!(
                secondary.join(format!("next-stop-v2_2026-09-{d}_0300_auto.db")).exists(),
                "09-{d} 應該被補到第二位置"
            );
        }
        assert_eq!(scan(&secondary, BackupLocation::Secondary).len(), 3, "只鏡射配額內的 3 份");
        assert!(
            !secondary.join("next-stop-v2_2026-09-08_0300_safety.db").exists(),
            "保險份不鏡射"
        );

        // 冪等：再跑一次不動任何檔（用 mtime 對照，同名同大小就該跳過）
        let before: Vec<_> = fs::read_dir(&secondary)
            .unwrap()
            .flatten()
            .map(|e| (e.file_name(), e.metadata().unwrap().modified().unwrap()))
            .collect();
        assert!(matches!(mirror(&primary, &secondary.to_string_lossy(), 3), SecondaryReport::Ok(_)));
        let after: Vec<_> = fs::read_dir(&secondary)
            .unwrap()
            .flatten()
            .map(|e| (e.file_name(), e.metadata().unwrap().modified().unwrap()))
            .collect();
        assert_eq!(before.len(), after.len(), "冪等：份數不變");
        for (name, mtime) in &before {
            assert!(
                after.iter().any(|(n, m)| n == name && m == mtime),
                "冪等：{name:?} 不該被重抄"
            );
        }

        // 主位置多一份更新的 ⇒ 只補那一份，第二位置照 keep 輪替掉最舊的
        touch_backup(&primary, "next-stop-v2_2026-09-15_0300_auto.db");
        match mirror(&primary, &secondary.to_string_lossy(), 3) {
            SecondaryReport::Ok(ok) => assert!(
                ok.path.ends_with("next-stop-v2_2026-09-15_0300_auto.db"),
                "回傳的 path＝最新那份：{}",
                ok.path
            ),
            SecondaryReport::Err(e) => panic!("鏡射不該失敗：{}", e.message),
        }
        assert!(secondary.join("next-stop-v2_2026-09-15_0300_auto.db").exists());
        assert!(
            !secondary.join("next-stop-v2_2026-09-12_0300_auto.db").exists(),
            "第二位置也照 keep 輪替，最舊的那份要被刪掉"
        );

        // keep 放大 ⇒ 之前輪替掉的舊份會被補回來（「缺的全部補」不只補最新）
        assert!(matches!(mirror(&primary, &secondary.to_string_lossy(), 7), SecondaryReport::Ok(_)));
        assert_eq!(scan(&secondary, BackupLocation::Secondary).len(), 7, "auto 6 份＋manual 1 份");
        assert!(secondary.join("next-stop-v2_2026-09-09_2100_manual.db").exists(), "manual 也要鏡射");
        assert!(secondary.join("next-stop-v2_2026-09-12_0300_auto.db").exists(), "輪替掉的舊份補得回來");

        let _ = fs::remove_dir_all(&primary);
        let _ = fs::remove_dir_all(&secondary);
    }

    /// ⑥ 沙盒真機第 3 條：io_msg 要認得 AlreadyExists，且訊息尾巴不准留 `(os error N)`。
    #[test]
    fn io_msg_講人話且不帶_os_error_編號() {
        let p = Path::new("C:\\Users\\User\\AppData\\Roaming\\app.shitetsu.nextstop\\backups");

        // ① AlreadyExists（Windows 的 ERROR_ALREADY_EXISTS＝183）：同名檔案擋住了
        let by_kind = io::Error::new(io::ErrorKind::AlreadyExists, "Cannot create a file when that file already exists.");
        let m = io_msg("建立備份資料夾", p, &by_kind);
        assert!(m.contains("同名檔案擋住了"), "AlreadyExists 要講人話：{m}");
        assert!(m.contains("backups"), "訊息要帶路徑：{m}");

        let by_raw = io::Error::from_raw_os_error(183);
        let m = io_msg("建立備份資料夾", p, &by_raw);
        assert!(m.contains("同名檔案擋住了"), "raw 183 也要認得：{m}");
        assert!(!m.contains("os error"), "尾巴不准留 (os error N)：{m}");

        // ② 通用 fallback（Other 等沒有專屬人話的 kind）：OS 訊息本文留著、編號去掉
        let other = io::Error::new(io::ErrorKind::Other, "The media is write protected. (os error 19)");
        let m = io_msg("讀取備份檔", p, &other);
        assert!(!m.contains("os error"), "fallback 也不准留編號：{m}");
        assert!(m.contains("讀取備份檔失敗"), "句型一致：{m}");
        assert!(m.contains("The media is write protected."), "OS 訊息本文要留著：{m}");

        let invalid = io::Error::new(io::ErrorKind::InvalidInput, "path is not valid");
        let m = io_msg("鏡射到第二備份位置", p, &invalid);
        assert!(m.contains("路徑不合法"), "InvalidInput 要講人話：{m}");
        assert!(!m.contains("os error"), "{m}");

        // ③ os_text 本身：只剝尾巴，沒有尾巴的一個字都不動
        assert_eq!(os_text(&other), "The media is write protected.");
        assert!(!os_text(&io::Error::from_raw_os_error(2)).contains("(os error"));
        let plain = io::Error::new(io::ErrorKind::Other, "沒有尾巴的自訂訊息");
        assert_eq!(os_text(&plain), "沒有尾巴的自訂訊息");
    }
}

/// 順序實證 ②：這支空 plugin 註冊在 `tauri_plugin_sql` **之後**，
/// setup 時 `DbInstances` 必定已就緒。兩行 log 一起看＝plugin 依註冊順序初始化的實證，
/// 順便當永久的回歸護欄（有人調換順序時 log 會立刻翻掉）。
///
/// **注意**：「已就緒」只代表 `DbInstances` 這個 map 被 manage 了，**不代表裡面有連線**——
/// `tauri_plugin_sql` 只在 `preload` 有列的時候才在 setup 連線，本專案是前端 `Database.load()`
/// 才建庫。實測（沙盒 log）：此刻 `next-stop-v2.db` 還不存在。所以「首開補備份」與「WAL 保證」
/// 兩件事**不能**掛在這裡，落點在 `backup_startup_report`（見那支 command 的註解）。
pub fn order_probe() -> TauriPlugin<Wry> {
    Builder::new("backup-probe")
        .setup(|app, _api| {
            let sql_ready = app.try_state::<DbInstances>().is_some();
            let db_ready = db_path(app).map(|p| p.exists()).unwrap_or(false);
            println!("[backup:probe] sql plugin 之後：DbInstances 已就緒＝{sql_ready}（預期 true）、DB 檔已存在＝{db_ready}（首開預期 false——前端 Database.load() 才建庫）");
            if !sql_ready {
                eprintln!("[backup:probe] ⚠ 順序不對——backup plugin 必須排在 tauri_plugin_sql 之前");
            }
            Ok(())
        })
        .build()
}

/// 首開補備份（⑥ 沙盒真機第 2 條）：只有「啟動報告＝`NoDb` 而此刻 DB 已經存在」才動手
/// ——那就是「backup plugin 跑的時候還沒有庫，前端剛剛把它建出來」的全新安裝第一天。
/// 其餘狀態（ok／skipped_today／error）一個字都不改；補拍走 `run_startup_async` 同一條
/// 「當日未備即備」的規則，所以重覆呼叫是冪等的。
///
/// 整段握著 `StartupState` 的鎖：同時到的第二個呼叫會等在這裡，不會讀到還沒補完的 `NoDb`。
async fn backfill_first_run(app: &AppHandle) {
    let Some(state) = app.try_state::<StartupState>() else { return };
    let mut guard = state.0.lock().await;
    if !matches!(&*guard, BackupReport::NoDb) {
        return;
    }
    match db_path(app) {
        Ok(p) if p.exists() => {}
        _ => return, // 連 DB 都還沒有——維持 NoDb，下次啟動再說
    }

    let report = run_startup_async(app).await;
    println!("[backup] 首開補備份（啟動時還沒有 DB）：{report:?}");
    if !matches!(report, BackupReport::NoDb) {
        *guard = report;
    }
}

/// WAL 冪等保證（⑥ 沙盒真機第 1 條的第二道）：走 plugin-sql 那條 pool 問一次 `PRAGMA journal_mode`，
/// 不是 wal 就設回 wal。借現成的 pool 是為了不跟它搶鎖（另開連線改 journal_mode 會撞 SQLITE_BUSY）。
/// 失敗只 log——這是保險絲，不是啟動的前置條件。
async fn ensure_wal(app: &AppHandle) {
    let Some(instances) = app.try_state::<DbInstances>() else { return };
    let lock = instances.0.read().await;
    let Some(pool) = lock.get(DB_URL) else {
        eprintln!("[backup] WAL 保證跳過：pool 還沒建起來");
        return;
    };
    let DbPool::Sqlite(pool) = pool;

    let mode = match sqlx::query("PRAGMA journal_mode").fetch_one(pool).await {
        Ok(r) => r.try_get::<String, _>(0).unwrap_or_default(),
        Err(e) => {
            eprintln!("[backup] 讀不到 journal_mode（{e}）");
            return;
        }
    };
    if mode.eq_ignore_ascii_case("wal") {
        println!("[backup] journal_mode＝{mode}");
        return;
    }
    match sqlx::query("PRAGMA journal_mode=WAL").fetch_one(pool).await {
        Ok(r) => println!(
            "[backup] journal_mode 原本是 {mode}，已設回 {}",
            r.try_get::<String, _>(0).unwrap_or_default()
        ),
        Err(e) => eprintln!("[backup] journal_mode 從 {mode} 設回 wal 失敗（{e}）"),
    }
}
