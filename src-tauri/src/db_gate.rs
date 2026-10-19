//! 降版閘門（主線④ 接縫 #80；契約 `docs/research/2026-10-19-主線-車次④降版閘門-契約.md` §2.1）。
//!
//! 為什麼要有這支：`tauri-plugin-sql` 2.4.0 的 `load` 是 `if let Some(m) = migrations.remove(&db) { migrate }`——
//! migrations 只在進程裡**第一次** load 時驗與升級，而且在 migrate **之前**就從表裡拿掉。所以同一個進程裡第二次 load
//! （F5、Android activity 重建、renderer 重啟）既不驗也不升級：舊版開到新 schema 的庫，第一次被 sqlx 拒、
//! 重新載入後就照常讀寫；新版第一次升級失敗，重新載入後就跑在舊 schema 上（反駁報告 K1）。
//!
//! 做法：前端每次要開庫之前先叫 `db_gate_check`，這裡照抄 sqlx `Migrator::run_direct` 的三道驗
//! （dirty → 不認得的版號 → checksum），不過就回人話、前端不 load。另加一道 sqlx 沒有的：這個進程已經把 load
//! 交出去過一次（plugin 的 migrations 已經被拿掉），庫裡卻還有沒跑的 migration ⇒ 上次升級沒做完，擋。
//! 還原備份前（`backup::validate`，桌機）也叫同一支 `gate_check`：較新版拍的備份在換檔前就擋。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha384};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Row, SqliteConnection};
use tauri::{AppHandle, Manager};

use crate::migrations::{lf, MigrationDef, MIGRATIONS};

/// 主庫檔名（plugin-sql 的 `sqlite:next-stop-v2.db` 會被對到 `app_config_dir/next-stop-v2.db`，兩殼相同）
pub(crate) const DB_FILE: &str = "next-stop-v2.db";

/// 這個進程已經放行過一次「要 load 的」開庫（之後 plugin 不會再驗、也不會再升級）。只在記憶體——重開 App 就歸零，
/// 正好對上 plugin 的 migrations 表也是重開才回來。
static LOAD_HANDED: AtomicBool = AtomicBool::new(false);

/// 庫跟這個 App 帶的 migration 清單對不上的情況
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GateError {
    /// `_sqlx_migrations` 有 `success = 0` 的列（sqlx `MigrateError::Dirty`；SQLite 上實際碰不到，照抄無害）
    Dirty(i64),
    /// 庫裡有比這版最大號還大的版號＝較新版用過（sqlx `VersionMissing` 的常見情況）
    Newer { db_max: i64, app_max: i64 },
    /// 庫裡有這版不認得、但不比最大號大的版號（開發期改過號；sqlx 一樣是 `VersionMissing`）
    Unknown(i64),
    /// 認得的版號、checksum 不同（sqlx `VersionMismatch`）
    Mismatch(i64),
    /// 這個進程已經交出過 load，庫裡卻還有沒跑的 migration（第一次升級失敗；plugin 不會再升級）
    Unfinished(i64),
    /// 唯讀、讀寫都開不了，或讀不了 `_sqlx_migrations`
    Unreadable(String),
}

/// 人話出現在哪裡：開 App（主庫）或還原前驗備份檔
#[derive(Clone, Copy)]
pub(crate) enum GateContext {
    Open,
    Backup,
}

impl GateError {
    pub(crate) fn message(&self, ctx: GateContext) -> String {
        use GateContext::*;
        use GateError::*;
        match (self, ctx) {
            (Newer { db_max, app_max }, Open) => format!(
                "這個資料庫被較新版的私鐵手帳用過（資料庫第 {db_max} 版，這個 App 只認得到第 {app_max} 版），為了不弄壞資料先不開。請安裝最新版再開——資料都還在，這一版沒有動它。"
            ),
            (Newer { db_max, app_max }, Backup) => format!(
                "這份備份是較新版的私鐵手帳拍的（資料庫第 {db_max} 版，這個 App 只認得到第 {app_max} 版），先更新 App 再還原。"
            ),
            (Unknown(v), Open) => format!(
                "資料庫裡有這個 App 不認得的升級紀錄（第 {v} 版），為了不弄壞資料先不開。資料庫檔案沒有被改動，請回報這個狀況。"
            ),
            (Unknown(v), Backup) => format!("這份備份有這個 App 不認得的升級紀錄（第 {v} 版），不能用來還原。"),
            (Mismatch(v), Open) => format!(
                "資料庫第 {v} 版的升級紀錄跟這個 App 帶的對不上，為了不弄壞資料先不開。資料庫檔案沒有被改動，請回報這個狀況。"
            ),
            (Mismatch(v), Backup) => format!("這份備份第 {v} 版的升級紀錄跟這個 App 帶的對不上，不能用來還原。"),
            (Dirty(v), Open) => format!(
                "上次升級資料庫（第 {v} 版）沒有做完，為了不弄壞資料先不開。資料庫檔案沒有被改動，請回報這個狀況。"
            ),
            (Dirty(v), Backup) => format!("這份備份拍的時候資料庫升級（第 {v} 版）還沒做完，不能用來還原。"),
            (Unfinished(v), _) => format!(
                "資料庫升級到第 {v} 版沒有做完，為了不弄壞資料先不開。請在系統匣的私鐵手帳按右鍵「結束」，再重新打開一次，會重新升級；資料庫檔案沒有被改動。"
            ),
            (Unreadable(e), Open) => format!("開不了資料庫來檢查版本（{e}）。請把私鐵手帳整個結束再打開一次。"),
            (Unreadable(e), Backup) => format!("讀不了這份備份的版本紀錄（{e}），不能用來還原。"),
        }
    }
}

/// 照 sqlx 0.8 `Migrator::run_direct` 驗一條連線（只讀、不建表、不套 migration）。
/// `strict_pending`：有沒跑的 migration 也算擋（`Unfinished`）——只在「這個進程已經交出過 load」時開。
/// `Ok(Ok(()))`＝過（含全新庫；`strict_pending=false` 時含比清單舊的庫——交給 plugin 照常升級）；`Ok(Err(_))`＝該擋；`Err`＝讀不了庫。
pub(crate) async fn gate_check(
    conn: &mut SqliteConnection,
    list: &[MigrationDef],
    strict_pending: bool,
) -> Result<Result<(), GateError>, sqlx::Error> {
    let has_table: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'")
            .fetch_optional(&mut *conn)
            .await?;
    if has_table.is_none() {
        return Ok(Ok(()));
    }
    // ① dirty（sqlx 同一句 SQL）
    let dirty: Option<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success = false ORDER BY version LIMIT 1")
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(v) = dirty {
        return Ok(Err(GateError::Dirty(v)));
    }
    let applied: Vec<(i64, Vec<u8>)> = sqlx::query("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&mut *conn)
        .await?
        .iter()
        .map(|r| Ok((r.try_get::<i64, _>(0)?, r.try_get::<Vec<u8>, _>(1)?)))
        .collect::<Result<_, sqlx::Error>>()?;
    // ② 不認得的版號（sqlx `ignore_missing` 預設 false；plugin 沒改）
    let app_max = list.iter().map(|m| m.version).max().unwrap_or(0);
    if let Some((v, _)) = applied.iter().find(|(v, _)| !list.iter().any(|m| m.version == *v)) {
        let db_max = applied.iter().map(|(v, _)| *v).max().unwrap_or(0);
        return Ok(Err(if db_max > app_max { GateError::Newer { db_max, app_max } } else { GateError::Unknown(*v) }));
    }
    // ③ checksum：sqlx `Migration::new` 算的是 SQL 原始位元組的 SHA-384；plugin 交給它的是 `lf()` 過的字串
    for m in list {
        match applied.iter().find(|(v, _)| *v == m.version) {
            Some((_, sum)) => {
                if Sha384::digest(lf(m.sql).as_bytes()).as_slice() != sum.as_slice() {
                    return Ok(Err(GateError::Mismatch(m.version)));
                }
            }
            // ④ 沒跑的（sqlx 會在這裡 apply）：只有 plugin 已經不會再升級時才擋
            None if strict_pending => return Ok(Err(GateError::Unfinished(m.version))),
            None => {}
        }
    }
    Ok(Ok(()))
}

/// 開一條連線來驗：先唯讀；開不起來（例如上次沒乾淨關、WAL 待回復）改讀寫——最多做 WAL 回復，不改內容
/// （同 `backup::snapshot` 的退路）。`create_if_missing(false)`：不會因為驗而生出空庫。
async fn open_for_check(path: &Path) -> Result<SqliteConnection, sqlx::Error> {
    let base = SqliteConnectOptions::new().filename(path).create_if_missing(false);
    match base.clone().read_only(true).connect().await {
        Ok(c) => Ok(c),
        Err(_) => base.read_only(false).connect().await,
    }
}

/// 驗一個庫檔；檔不存在＝過（全新安裝，plugin 會建）。
pub(crate) async fn check_file(path: &Path, strict_pending: bool) -> Result<(), GateError> {
    if !path.exists() {
        return Ok(());
    }
    let mut conn = open_for_check(path)
        .await
        .map_err(|e| GateError::Unreadable(format!("{}：{e}", path.display())))?;
    let verdict = gate_check(&mut conn, MIGRATIONS, strict_pending).await;
    let _ = sqlx::Connection::close(conn).await;
    verdict.unwrap_or_else(|e| Err(GateError::Unreadable(format!("{}：{e}", path.display()))))
}

/// 還原前驗備份檔（`backup::validate`）：沒跑的 migration 不算問題（還原後重開，plugin 會升級）
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) async fn check_backup_file(path: &Path) -> Result<(), String> {
    check_file(path, false).await.map_err(|g| g.message(GateContext::Backup))
}

/// 一次開庫要不要放行（純函式，可測）。`attach`＝捕捉小窗：附著主視窗的連線、不 load，不參與「交出過 load」。
/// 回 `Ok(true)`＝放行而且要記成「交出過 load」。
pub(crate) fn decide(attach: bool, handed: bool, verdict: Result<(), GateError>) -> Result<bool, GateError> {
    match verdict {
        Ok(()) => Ok(!attach),
        // 開不了／讀不了，而 plugin 還會自己驗（這個進程還沒交出過 load）⇒ 放行，讓 plugin 驗、讓它報錯；
        // 小窗也放行（沒有 pool 它自己就讀不到）
        Err(GateError::Unreadable(_)) if attach || !handed => Ok(!attach),
        Err(g) => Err(g),
    }
}

pub(crate) fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join(DB_FILE))
        .map_err(|e| format!("找不到 App 設定資料夾（{e}）。"))
}

/// 前端 `lib/db.ts::getDb()` 每個頁面開庫前叫一次；`Err`＝不要 load（人話直接給 `⚠` 那一列）。
/// JS 參數：`{ attach }`（捕捉小窗傳 true）。
#[tauri::command]
pub async fn db_gate_check(app: AppHandle, attach: Option<bool>) -> Result<(), String> {
    let attach = attach.unwrap_or(false);
    let handed = LOAD_HANDED.load(Ordering::SeqCst);
    let verdict = check_file(&db_path(&app)?, !attach && handed).await;
    match decide(attach, handed, verdict) {
        Ok(hand) => {
            if hand {
                LOAD_HANDED.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
        Err(g) => Err(g.message(GateContext::Open)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    /// 清單 `list` 套上去的庫（暫存資料夾裡的真檔；sqlx Migrator＝plugin 用的同一套）
    async fn make_db(dir: &Path, list: &[MigrationDef]) -> PathBuf {
        use sqlx::migrate::{Migration, MigrationType, Migrator};
        let path = dir.join("t.db");
        let mut conn = SqliteConnectOptions::new().filename(&path).create_if_missing(true).connect().await.unwrap();
        let ms: Vec<Migration> = list
            .iter()
            .map(|m| Migration::new(m.version, m.description.into(), MigrationType::Simple, lf(m.sql).into(), false))
            .collect();
        let migrator = Migrator { migrations: ms.into(), ..Migrator::DEFAULT };
        migrator.run_direct(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        path
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ns-gate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 「較新版」＝現行清單再多一支（假的，只在測試裡）
    fn plus_extra() -> Vec<MigrationDef> {
        MIGRATIONS
            .iter()
            .map(|m| MigrationDef { version: m.version, stem: m.stem, description: m.description, sql: m.sql })
            .chain(std::iter::once(MigrationDef {
                version: 9999,
                stem: "9999_probe",
                description: "probe",
                sql: "CREATE TABLE gate_probe (id TEXT PRIMARY KEY);",
            }))
            .collect()
    }

    async fn verdict(path: &Path, list: &[MigrationDef], strict: bool) -> Result<(), GateError> {
        let mut conn = SqliteConnectOptions::new().filename(path).read_only(true).connect().await.unwrap();
        let v = gate_check(&mut conn, list, strict).await.unwrap();
        conn.close().await.unwrap();
        v
    }

    fn app_max() -> i64 {
        MIGRATIONS.iter().map(|m| m.version).max().unwrap()
    }

    #[test]
    fn 新版庫_舊版開_每一次都擋() {
        tauri::async_runtime::block_on(async {
            let d = tmp("newer");
            let newer = plus_extra();
            let path = make_db(&d, &newer).await;
            // 反例本體（#80）：plugin 只擋第一次；這支不管叫幾次、放行過沒有都擋
            for strict in [false, true, true] {
                assert_eq!(verdict(&path, MIGRATIONS, strict).await, Err(GateError::Newer { db_max: 9999, app_max: app_max() }));
                let e = check_file(&path, strict).await.unwrap_err();
                assert!(e.message(GateContext::Open).contains("第 9999 版"));
            }
            // 新版自己開：過
            assert_eq!(verdict(&path, &newer, true).await, Ok(()));
            // 對照：sqlx 本身（plugin 第一次 load 走的路）在同一顆庫上也是拒開——閘門跟它判得一樣
            {
                use sqlx::migrate::{MigrateError, Migration, MigrationType, Migrator};
                let ms: Vec<Migration> = MIGRATIONS
                    .iter()
                    .map(|m| Migration::new(m.version, m.description.into(), MigrationType::Simple, lf(m.sql).into(), false))
                    .collect();
                let migrator = Migrator { migrations: ms.into(), ..Migrator::DEFAULT };
                let mut c = SqliteConnectOptions::new().filename(&path).connect().await.unwrap();
                assert!(matches!(migrator.run_direct(&mut c).await, Err(MigrateError::VersionMissing(9999))));
                c.close().await.unwrap();
            }
            std::fs::remove_dir_all(&d).ok();
        });
    }

    #[test]
    fn 舊版庫_第一次放行_交出過_load_之後就擋() {
        tauri::async_runtime::block_on(async {
            let d = tmp("older");
            let path = make_db(&d, &MIGRATIONS[..MIGRATIONS.len() - 1]).await;
            // 第一次（plugin 還會升級）：過
            assert_eq!(verdict(&path, MIGRATIONS, false).await, Ok(()));
            // K1 反例：交出過 load、升級卻沒做完 ⇒ 擋，叫主人整個結束再開
            assert_eq!(verdict(&path, MIGRATIONS, true).await, Err(GateError::Unfinished(app_max())));
            // 同版：不論嚴不嚴都過
            let d2 = tmp("same");
            let same = make_db(&d2, MIGRATIONS).await;
            for strict in [false, true] {
                assert_eq!(verdict(&same, MIGRATIONS, strict).await, Ok(()));
                assert_eq!(check_file(&same, strict).await, Ok(()));
            }
            std::fs::remove_dir_all(&d).ok();
            std::fs::remove_dir_all(&d2).ok();
        });
    }

    #[test]
    fn 不認得但不比較大的版號_不說較新版() {
        tauri::async_runtime::block_on(async {
            let d = tmp("unknown");
            let path = make_db(&d, MIGRATIONS).await;
            let mut c = SqliteConnectOptions::new().filename(&path).connect().await.unwrap();
            sqlx::query("UPDATE _sqlx_migrations SET version = -5 WHERE version = 1").execute(&mut c).await.unwrap();
            c.close().await.unwrap();
            let v = verdict(&path, MIGRATIONS, false).await;
            assert_eq!(v, Err(GateError::Unknown(-5)));
            assert!(!v.unwrap_err().message(GateContext::Open).contains("較新版"));
            std::fs::remove_dir_all(&d).ok();
        });
    }

    #[test]
    fn checksum_不符_擋() {
        tauri::async_runtime::block_on(async {
            let d = tmp("mismatch");
            let path = make_db(&d, MIGRATIONS).await;
            let mut c = SqliteConnectOptions::new().filename(&path).connect().await.unwrap();
            sqlx::query("UPDATE _sqlx_migrations SET checksum = x'00' WHERE version = 3").execute(&mut c).await.unwrap();
            c.close().await.unwrap();
            assert_eq!(verdict(&path, MIGRATIONS, false).await, Err(GateError::Mismatch(3)));
            std::fs::remove_dir_all(&d).ok();
        });
    }

    #[test]
    fn 升級沒做完的_dirty_列_擋() {
        tauri::async_runtime::block_on(async {
            let d = tmp("dirty");
            let path = make_db(&d, MIGRATIONS).await;
            let mut c = SqliteConnectOptions::new().filename(&path).connect().await.unwrap();
            sqlx::query("UPDATE _sqlx_migrations SET success = false WHERE version = 2").execute(&mut c).await.unwrap();
            c.close().await.unwrap();
            assert_eq!(verdict(&path, MIGRATIONS, false).await, Err(GateError::Dirty(2)));
            std::fs::remove_dir_all(&d).ok();
        });
    }

    #[test]
    fn 沒有庫檔或沒有_migration_表_過_而且不會生出檔() {
        tauri::async_runtime::block_on(async {
            let d = tmp("none");
            let missing = d.join("nope.db");
            assert_eq!(check_file(&missing, true).await, Ok(()));
            assert!(!missing.exists(), "驗一次不該建出空庫");
            let bare = d.join("bare.db");
            let mut c = SqliteConnectOptions::new().filename(&bare).create_if_missing(true).connect().await.unwrap();
            sqlx::query("CREATE TABLE x (a)").execute(&mut c).await.unwrap();
            c.close().await.unwrap();
            assert_eq!(verdict(&bare, MIGRATIONS, true).await, Ok(()));
            std::fs::remove_dir_all(&d).ok();
        });
    }

    #[test]
    fn 開不了的檔_還沒交出過_load_放行_交出過就擋() {
        tauri::async_runtime::block_on(async {
            let d = tmp("junk");
            let junk = d.join("junk.db");
            std::fs::write(&junk, "這不是資料庫".as_bytes()).unwrap();
            let v = check_file(&junk, false).await;
            assert!(matches!(v, Err(GateError::Unreadable(_))), "{v:?}");
            std::fs::remove_dir_all(&d).ok();
        });
        let unreadable = || Err(GateError::Unreadable("x".into()));
        assert_eq!(decide(false, false, unreadable()), Ok(true), "第一次：讓 plugin 自己驗");
        assert!(decide(false, true, unreadable()).is_err(), "交出過 load：plugin 不會再驗，擋");
        assert_eq!(decide(true, true, unreadable()), Ok(false), "小窗：放行、不記");
        assert_eq!(decide(true, false, Ok(())), Ok(false), "小窗過了也不記成交出過 load");
        assert_eq!(decide(false, false, Ok(())), Ok(true));
        assert!(decide(true, false, Err(GateError::Newer { db_max: 12, app_max: 11 })).is_err(), "較新版連小窗也擋");
    }

    #[test]
    fn 備份的人話與開庫的不同() {
        let g = GateError::Newer { db_max: 12, app_max: 11 };
        assert!(g.message(GateContext::Backup).contains("先更新 App 再還原"));
        assert!(g.message(GateContext::Open).contains("請安裝最新版再開"));
        assert!(GateError::Unfinished(11).message(GateContext::Open).contains("結束"));
    }
}
