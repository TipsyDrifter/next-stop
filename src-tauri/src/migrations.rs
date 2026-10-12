//! migration 清單的**唯一來源**（並行地基 甲1；契約 `docs/research/2026-09-29-並行地基-契約.md` §4）。
//!
//! 誰讀這份清單：
//!   * `lib.rs` 的 sql plugin（`plugin_migrations()`）
//!   * `sync::SCHEMA_VERSION`（＝清單長度，導出、不手寫）
//!   * engine／snapshot 測試的 `make_pool`（走訪 `MIGRATIONS`）
//!   * `scripts/probes/wp5-sync-writes/run.mjs`、`run2.mjs`（逐行解析 `mig!(…)`，見下方「介面約定」）
//!
//! **介面約定**：`MIGRATIONS` 裡每一筆 `mig!(…)` 獨佔一行、以 `mig!(` 開頭（前面只能有空白）——probe 用正規式讀它。
//!
//! 新增一支 migration：`migrations/NNNN_<名字>.sql` 新檔＋清單**尾端加一行**。
//! 改正式號：改那一行的版號與檔名＋`git mv` 檔案（`stem_prefix_matches_version` 擋漏改）。
//! 已經裝上主人真機的那幾行**永不再改**（`released_migrations_are_frozen` 擋）。

use tauri_plugin_sql::{Migration, MigrationKind};

/// 一支 migration。版號**顯式寫**在每一筆（不由清單位置推導）：中間插一筆不會讓後面靜默改號。
pub struct MigrationDef {
    pub version: i64,
    /// 檔名去掉 `.sql`，例 "0004_sync"
    pub stem: &'static str,
    pub description: &'static str,
    /// `include_str!` 的原始內容（**未**經 `lf()`；進 sqlx 前由 `plugin_migrations()` 換行尾）
    pub sql: &'static str,
}

impl MigrationDef {
    /// 穩定的識別名＝stem 去掉前面的 `NNNN_`（例 "sync"）。改號時它不變——同步表 spec 的 `since` 存的就是它。
    pub fn key(&self) -> &'static str {
        &self.stem[5..]
    }
}

/// 版號、檔名、說明寫在同一行；`include_str!` 的路徑由檔名組出來，兩者不可能各說各話。
macro_rules! mig {
    ($version:literal, $stem:literal, $desc:literal) => {
        MigrationDef {
            version: $version,
            stem: $stem,
            description: $desc,
            sql: include_str!(concat!("../migrations/", $stem, ".sql")),
        }
    };
}

/// **唯一來源**。新增＝在尾端加一行。已經裝上主人真機的那幾行永不再改。
///
/// sqlx Migrator 只跑 `_sqlx_migrations` 裡沒有的版本，已跑過的只驗 checksum
/// → 既有版本的 SQL 一個字都不能改（改了舊 DB 會啟動失敗），新東西一律新開一支。
pub const MIGRATIONS: &[MigrationDef] = &[
    mig!(1, "0001_baseline", "v2 baseline: flexible rail tree (nodes) + work_logs + settings"),
    mig!(2, "0002_today", "today view: nodes.today_position/carried_from + work_logs.event (backfill issued)"),
    mig!(3, "0003_repeat", "repeat engine: occurrences table + legacy free-text repeat_rule migration"),
    // v1.1.1：純 DDL 三張表（sync_meta／sync_outbox／sync_cells），不生資料列（U8）。
    // 同步總開關沒開之前三張表全空、既有路徑零改變；backup plugin 排在 sql 之前，升級前照樣先有快照。
    mig!(4, "0004_sync", "sync foundation: sync_meta + sync_outbox + sync_cells (no data rows)"),
    mig!(5, "0005_notes_notes", "notes: notes table (capture / inbox / notes; diary columns reserved)"),
    mig!(6, "0006_timetable_blocks", "timetable: time_categories + time_blocks (starter categories are seeded by the app, not here)"),
];

/// migration SQL 進 sqlx 之前一律換成 LF。
/// 為什麼（v1.1.5 真機，2026-09-28）：sqlx 的 checksum 算的是 SQL 的**原始位元組**；這台 git `autocrlf=true`，
/// 在 worktree 新 checkout 時四支 .sql 全變 CRLF，`include_str!` 就把 CRLF 嵌進 exe——主人桌機與手機的
/// `_sqlx_migrations` 記的是 LF 版 checksum，比對不上 ⇒ `Database.load` 直接拒開、整個 App 讀不到資料庫。
/// 沙盒抓不到，因為沙盒 DB 是同一顆 exe 新建的。`.gitattributes` 已鎖 `*.sql eol=lf`，這裡再擋一道。
pub(crate) fn lf(sql: &'static str) -> &'static str {
    if sql.contains('\r') {
        Box::leak(sql.replace("\r\n", "\n").replace('\r', "\n").into_boxed_str())
    } else {
        sql
    }
}

/// 交給 `tauri_plugin_sql::Builder::add_migrations` 的清單（每筆 `lf()` 過、一律 `Up`）。
pub fn plugin_migrations() -> Vec<Migration> {
    MIGRATIONS
        .iter()
        .map(|m| Migration {
            version: m.version,
            description: m.description,
            sql: lf(m.sql),
            kind: MigrationKind::Up,
        })
        .collect()
}

/// 用穩定名查版號（例 `version_of("sync") == Some(4)`）；查不到回 None。
pub fn version_of(key: &str) -> Option<i64> {
    MIGRATIONS.iter().find(|m| m.key() == key).map(|m| m.version)
}

/// 守門測試（契約 §4.3；**永久保留**）。
#[cfg(test)]
mod tests {
    use super::*;

    /// 已發行 migration 的 sqlx checksum：(version, stem, SHA-384(lf(sql)) 的 hex)。
    /// 前四筆的值與 G0 金樣（`sync/foundation_golden.rs` 的 `RELEASED_MIGRATIONS_SHA384`）相同。
    /// **每發行一支新 migration，調度在發版的那個 commit 把它加進這張表**（契約 §4.3、§15-7）。
    const RELEASED: &[(i64, &str, &str)] = &[
        (
            1,
            "0001_baseline",
            "d89a4692e07a597972fa938986e0bfc6a41b4c0babda5b17f009cb7dd39e8908cb4848f2443401c4add041d481d4a302",
        ),
        (
            2,
            "0002_today",
            "6a49cb4a5eac56909873b4d1a812000674f9bfee34988e9ef8c4afd0640ff5a958b35f5c3b577eece018f4831dfd030b",
        ),
        (
            3,
            "0003_repeat",
            "92707feb34dfb17fca8c00380495886f0a0bf73f3b179054521318f83b84e40855cbc9a1d27a4490fc334665a0f9f62f",
        ),
        (
            4,
            "0004_sync",
            "3d6aa560bedadda489c2c3e18fdb8b12e3553083b3818ec678503fcb2a29f82597b86f8901fe6409cf2d395581c45b27",
        ),
        // v1.2.0 發行（旅客筆記①）
        (
            5,
            "0005_notes_notes",
            "020fbe62464d1c72d15f97322ad9737c5fc2d7f9a837bf5c04379cbc470104dee6e640f07c2b3f41e2e0ff8fb2aac698",
        ),
        (
            6,
            "0006_timetable_blocks",
            "6a37993883d8807ff91e3c3f0759a45276e12d9d664dee50ce7008f5f3a63a29f1fd292c9271c4ba28da63267f02d0da",
        ),
    ];

    #[test]
    fn versions_unique_increasing_contiguous() {
        assert!(!MIGRATIONS.is_empty(), "migration 清單是空的");
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(
                m.version,
                i as i64 + 1,
                "第 {} 筆（{}）的版號是 {}，應為 {}：版號必須從 1 起連號、嚴格遞增、不重複",
                i + 1,
                m.stem,
                m.version,
                i + 1
            );
        }
    }

    #[test]
    fn schema_version_equals_count() {
        assert_eq!(crate::sync::SCHEMA_VERSION as usize, MIGRATIONS.len());
    }

    #[test]
    fn stem_prefix_matches_version() {
        for m in MIGRATIONS {
            let want = format!("{:04}", m.version);
            assert!(
                m.stem.len() > 5 && m.stem.is_char_boundary(5),
                "{}：檔名太短，應為 NNNN_<名字>",
                m.stem
            );
            assert_eq!(&m.stem[..4], want, "{}：檔名前四碼與版號 {} 不符", m.stem, m.version);
            assert_eq!(&m.stem[4..5], "_", "{}：第五碼應為 `_`", m.stem);
        }
    }

    #[test]
    fn keys_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for m in MIGRATIONS {
            assert!(!m.key().is_empty(), "{}：key 是空的", m.stem);
            assert!(seen.insert(m.key()), "migration 的 key `{}` 重複（{}）", m.key(), m.stem);
        }
    }

    #[test]
    fn no_orphan_sql_files() {
        let dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"));
        let mut files: Vec<String> = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("讀不到 {}：{e}", dir.display()))
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".sql"))
            .collect();
        files.sort();
        for f in &files {
            let stem = &f[..f.len() - 4];
            assert!(
                MIGRATIONS.iter().any(|m| m.stem == stem),
                "migrations/{f} 沒有登記在 MIGRATIONS（加了檔卻忘了在清單尾端加一行）"
            );
        }
        assert_eq!(files.len(), MIGRATIONS.len(), "migrations/ 的 .sql 檔數與清單筆數不符：{files:?}");
    }

    /// 任何一支 migration 在 checkout 裡不得帶 CR（否則 checksum 與所有既有 DB 不符）。
    /// 失敗＝這份 checkout 的行尾被 autocrlf 改寫，先修 .gitattributes／重新 checkout 再 build。
    #[test]
    fn migrations_are_lf_in_checkout() {
        for m in MIGRATIONS {
            assert!(!m.sql.contains('\r'), "{}.sql 帶 CR：這份 checkout 被 autocrlf 改寫了", m.stem);
        }
    }

    #[test]
    fn lf_normalizes_crlf_and_leaves_lf_alone() {
        assert_eq!(super::lf("a\r\nb\r\n"), "a\nb\n");
        let s: &'static str = "a\nb\n";
        assert!(std::ptr::eq(super::lf(s), s));
    }

    /// **永久的牙齒**：sqlx 認帳就是用這個 checksum，測試紅＝主人的資料庫會拒開。
    #[test]
    fn released_migrations_are_frozen() {
        use sha2::{Digest, Sha384};
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert!(RELEASED.len() <= MIGRATIONS.len(), "已發行表比清單還長：有已發行的 migration 被移除了");
        for (m, (v, stem, sum)) in MIGRATIONS.iter().zip(RELEASED) {
            assert_eq!((m.version, m.stem), (*v, *stem), "已發行的 migration 被改號或改名");
            let ours = hex(Sha384::digest(lf(m.sql).as_bytes()).as_slice());
            assert_eq!(ours, *sum, "{stem}：已發行 migration 的位元組被動過（sqlx 會拒開主人的資料庫）");
        }
        // 與 G0 金樣交叉核對（金樣檔凍結；這張表日後只會在尾端長）
        let golden = crate::sync::engine::foundation_golden::RELEASED_MIGRATIONS_SHA384;
        assert_eq!(&RELEASED[..golden.len()], golden, "已發行表的前段與 G0 金樣不符");
    }

    #[test]
    fn plugin_migrations_mirror_list() {
        let ms = plugin_migrations();
        assert_eq!(ms.len(), MIGRATIONS.len());
        for (p, m) in ms.iter().zip(MIGRATIONS) {
            assert_eq!(p.version, m.version);
            assert_eq!(p.description, m.description);
            assert_eq!(p.sql, lf(m.sql));
            assert!(matches!(p.kind, MigrationKind::Up));
        }
    }

    #[test]
    fn version_of_by_key() {
        assert_eq!(version_of("baseline"), Some(1));
        assert_eq!(version_of("sync"), Some(4));
        assert_eq!(version_of("0004_sync"), None);
        assert_eq!(version_of("nope"), None);
    }
}
