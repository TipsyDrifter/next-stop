//! 核心同步行為的回歸測試（源自並行地基 甲0 的金樣；契約 `docs/research/2026-09-29-並行地基-契約.md` §11）。
//!
//! **定位**：鎖住核心四張表（nodes／work_logs／occurrences／settings）的補戳、快照進 outbox、全量 JSON
//! 匯出與匯入、清空、套用，逐位元組比對 `golden/**`。地基重構驗收完之後解凍（2026-10-05），改成只鎖核心：
//!   * 臨時庫只跑**已發行的前四支** migration（`golden_pool`），登記表用 `Registry::core_only()`（`core_reg`）；
//!   * 全量 JSON 的 `schema` 在比對前固定成 `GOLDEN_SCHEMA`（＝4），不隨 migration 總數變動。
//!
//! 所以三條線照契約 §13 加 migration、在自己的登記檔加同步表，這組測試都不會紅；紅了就是核心行為變了。
//!
//! **資料檔**（`golden/` 底下的 .json／.jsonl／.txt）由 2026-10-05 之前**未經重構**的舊碼產生
//! （`NS_GOLDEN=write cargo test foundation_golden` 寫檔，其餘時候逐位元組比對；執行期讀檔，檔不在也編得過）。
//! 要重新產生或改動任何一個資料檔，須先經調度同意。`.gitattributes` 鎖 LF，別讓編輯器改行尾。
//!
//! 掛在 `engine` 底下（`engine.rs` 檔尾的 `#[path]`），所以讀得到 engine 的私有函式。
//! 比對不符時，實際產出另存到系統暫存目錄的 `ns-golden-actual-<檔名>`，方便 diff。
//!
//! 牙齒對照（契約 §11.3）：
//!   * T-甲1 `t1_白名單常數與舊函式相等`
//!   * T-甲2 `t2_補戳結果`                 → `golden/stamp_cells.json`
//!   * T-甲3 `t3_快照進_outbox`            → `golden/outbox.jsonl`
//!   * T-甲4 `t4_全量_json`                → `golden/full.json`
//!   * T-甲5 `t5_匯入`                     → `golden/import_report.json`、`golden/import_dump.txt`
//!   * T-甲6 `t6_清空`                     → `golden/wipe_counts.json`
//!   * T-甲7 `t7_套用`（輸入 `golden/apply_fixture.json`，甲0 手寫）→ `golden/apply_result.txt`
//!   * T-甲8 `SQL_*` 常數（手抄）＋ `t8_手抄_sql_在舊碼上效果相同`（甲0 能做的機器旁證：文字無法在舊碼上驗，
//!     改驗「把手抄字面值拿去執行，效果與舊函式相同」；重構後的純函式產出逐字比對由 甲2 對這些常數做）
//!   * T-甲9 `RELEASED_MIGRATIONS_SHA384` ＋ `t9_已發行_migration_位元組鎖`
//!   * T-甲10／T-甲11 不在 甲0（要等登記表與 android target）。
#![allow(dead_code)]

use super::*;
use crate::sync::snapshot::{self, SnapshotKind};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::Column;
use std::sync::atomic::AtomicU32;

// ─────────────────────────────────────────────────────────────
// 固定身分與時間（契約 §11.2：時間戳全部用固定字面值，裝置 id 用固定字串）
// ─────────────────────────────────────────────────────────────

/// 「我」＝跑補戳、快照、清空、套用的這一台（dev8＝`golden-s`）
pub(crate) const SELF_DEV: &str = "golden-self-device";
/// 預先放在 `sync_cells` 的「別台」（dev8＝`golden-o`）
pub(crate) const OTHER_DEV: &str = "golden-other-device";
/// T-甲5 匯入那一台
pub(crate) const IMPORT_DEV: &str = "golden-import-device";
/// `sync_meta.epoch`
pub(crate) const EPOCH: &str = "1788220800000";
/// 全量 JSON 的 `exported_at` 在比對前換成這個（`now_iso()` 不可重現）
pub(crate) const FIXED_EXPORTED_AT: &str = "2026-09-29T00:00:00.000Z";
/// 競合日誌的 `id`（uuid v4）與三個時間欄在比對前換成這個
pub(crate) const MASK: &str = "<masked>";
/// 全量 JSON 的 `schema` 在比對前換成這個：臨時庫只跑已發行的前四支 migration，金樣也是 4；
/// 不用 `SCHEMA_VERSION`（它＝migration 總數，三線加 migration 就會變）
pub(crate) const GOLDEN_SCHEMA: u32 = 4;

/// 回歸測試用的登記表：只含核心四張表（三線登記的表不在臨時庫裡）
pub(crate) fn core_reg() -> &'static Registry {
    Registry::core_only()
}

// ─────────────────────────────────────────────────────────────
// T-甲1：白名單／必填欄／主鍵的金樣常數（從 `engine.rs:117-163、178-180、188-190` 抄）
// ─────────────────────────────────────────────────────────────

pub(crate) const GOLDEN_NODES_COLS: &[(&str, bool)] = &[
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
pub(crate) const GOLDEN_WORK_LOGS_COLS: &[(&str, bool)] = &[
    ("node_id", false),
    ("body", false),
    ("logged_at", false),
    ("event", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];
pub(crate) const GOLDEN_OCCURRENCES_COLS: &[(&str, bool)] = &[
    ("node_id", false),
    ("due_on", false),
    ("status", false),
    ("completed_at", false),
    ("mood", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];
pub(crate) const GOLDEN_SETTINGS_COLS: &[(&str, bool)] = &[("value", false)];

pub(crate) const GOLDEN_NODES_REQUIRED: &[&str] = &["kind", "name"];
pub(crate) const GOLDEN_WORK_LOGS_REQUIRED: &[&str] = &["node_id", "body", "logged_at"];
pub(crate) const GOLDEN_OCCURRENCES_REQUIRED: &[&str] = &["node_id", "due_on", "status"];

/// settings 同步白名單（`engine.rs:91`）
pub(crate) const GOLDEN_SETTINGS_KEYS: &[&str] = &["day_start_hour"];

/// (表名, 白名單, 必填, 主鍵)——四張同步表
pub(crate) const GOLDEN_TABLES: &[(&str, &[(&str, bool)], &[&str], &str)] = &[
    ("nodes", GOLDEN_NODES_COLS, GOLDEN_NODES_REQUIRED, "id"),
    ("work_logs", GOLDEN_WORK_LOGS_COLS, GOLDEN_WORK_LOGS_REQUIRED, "id"),
    ("occurrences", GOLDEN_OCCURRENCES_COLS, GOLDEN_OCCURRENCES_REQUIRED, "id"),
    ("settings", GOLDEN_SETTINGS_COLS, &[], "key"),
];

/// 不是同步表的名字：`columns_of` 回 None、`required_of` 回空、`pk_of` 回 "id"
pub(crate) const GOLDEN_NOT_SYNC_TABLES: &[&str] =
    &["sync_meta", "sync_outbox", "sync_cells", "zz_nope", "", "Nodes"];

// ─────────────────────────────────────────────────────────────
// T-甲8：SQL 字面金樣（**手抄**；依現行樣板展開，審閱者對照行號肉眼核對）
// ─────────────────────────────────────────────────────────────

/// `engine.rs:1112-1117` `derived_hlc_sql("n")` 展開
pub(crate) const SQL_DERIVED_HLC_N: &str = "printf('%013d0000-%s', CAST(round((julianday(COALESCE(NULLIF(n.updated_at,''), NULLIF(n.created_at,''), '1970-01-01T00:00:00.000Z')) - 2440587.5) * 86400000.0) AS INTEGER), ?1)";

/// `engine.rs:1148-1153` 補戳 nodes（`?1`＝dev8、`?2`＝device_id）
pub(crate) const SQL_STAMP_NODES: &str = concat!(
    "INSERT OR IGNORE INTO sync_cells (tbl, row_id, col, hlc, device_id) ",
    "SELECT 'nodes', n.id, c.col, ",
    "printf('%013d0000-%s', CAST(round((julianday(COALESCE(NULLIF(n.updated_at,''), NULLIF(n.created_at,''), '1970-01-01T00:00:00.000Z')) - 2440587.5) * 86400000.0) AS INTEGER), ?1)",
    ", ?2 ",
    "FROM nodes n CROSS JOIN (",
    "SELECT 'kind' AS col UNION ALL SELECT 'parent_id' AS col UNION ALL SELECT 'name' AS col UNION ALL ",
    "SELECT 'description' AS col UNION ALL SELECT 'position' AS col UNION ALL SELECT 'color' AS col UNION ALL ",
    "SELECT 'code' AS col UNION ALL SELECT 'status' AS col UNION ALL SELECT 'scheduled_on' AS col UNION ALL ",
    "SELECT 'due_on' AS col UNION ALL SELECT 'priority' AS col UNION ALL SELECT 'estimate_min' AS col UNION ALL ",
    "SELECT 'progress' AS col UNION ALL SELECT 'time_spent_min' AS col UNION ALL SELECT 'mood' AS col UNION ALL ",
    "SELECT 'repeat_rule' AS col UNION ALL SELECT 'completed_at' AS col UNION ALL SELECT 'expected_on' AS col UNION ALL ",
    "SELECT 'arrived_on' AS col UNION ALL SELECT 'today_position' AS col UNION ALL SELECT 'carried_from' AS col UNION ALL ",
    "SELECT 'route_id' AS col UNION ALL SELECT 'created_at' AS col UNION ALL SELECT 'updated_at' AS col UNION ALL ",
    "SELECT 'deleted_at' AS col",
    ") c WHERE NOT (c.col = 'route_id' AND NOT (n.parent_id IS NULL AND n.kind = 'ticket'))"
);

/// `engine.rs:1148-1153` 補戳 work_logs
pub(crate) const SQL_STAMP_WORK_LOGS: &str = concat!(
    "INSERT OR IGNORE INTO sync_cells (tbl, row_id, col, hlc, device_id) ",
    "SELECT 'work_logs', n.id, c.col, ",
    "printf('%013d0000-%s', CAST(round((julianday(COALESCE(NULLIF(n.updated_at,''), NULLIF(n.created_at,''), '1970-01-01T00:00:00.000Z')) - 2440587.5) * 86400000.0) AS INTEGER), ?1)",
    ", ?2 ",
    "FROM work_logs n CROSS JOIN (",
    "SELECT 'node_id' AS col UNION ALL SELECT 'body' AS col UNION ALL SELECT 'logged_at' AS col UNION ALL ",
    "SELECT 'event' AS col UNION ALL SELECT 'created_at' AS col UNION ALL SELECT 'updated_at' AS col UNION ALL ",
    "SELECT 'deleted_at' AS col",
    ") c WHERE n.event IS NULL OR n.event <> 'conflict'"
);

/// `engine.rs:1148-1153` 補戳 occurrences（filter 是空字串 ⇒ **結尾留一個空白**）
pub(crate) const SQL_STAMP_OCCURRENCES: &str = concat!(
    "INSERT OR IGNORE INTO sync_cells (tbl, row_id, col, hlc, device_id) ",
    "SELECT 'occurrences', n.id, c.col, ",
    "printf('%013d0000-%s', CAST(round((julianday(COALESCE(NULLIF(n.updated_at,''), NULLIF(n.created_at,''), '1970-01-01T00:00:00.000Z')) - 2440587.5) * 86400000.0) AS INTEGER), ?1)",
    ", ?2 ",
    "FROM occurrences n CROSS JOIN (",
    "SELECT 'node_id' AS col UNION ALL SELECT 'due_on' AS col UNION ALL SELECT 'status' AS col UNION ALL ",
    "SELECT 'completed_at' AS col UNION ALL SELECT 'mood' AS col UNION ALL SELECT 'created_at' AS col UNION ALL ",
    "SELECT 'updated_at' AS col UNION ALL SELECT 'deleted_at' AS col",
    ") c "
);

/// `engine.rs:1165-1172` 補戳 settings 一把鑰匙（`?3`＝鑰匙；這句重構時不動，列著備查）
pub(crate) const SQL_STAMP_SETTINGS: &str = concat!(
    "INSERT OR IGNORE INTO sync_cells (tbl, row_id, col, hlc, device_id) ",
    "SELECT 'settings', n.key, 'value', ",
    "printf('%013d0000-%s', CAST(round((julianday(COALESCE(NULLIF(n.updated_at,''), '1970-01-01T00:00:00.000Z')) - 2440587.5) * 86400000.0) AS INTEGER), ?1)",
    ", ?2 FROM settings n WHERE n.key = ?3"
);

/// `engine.rs:1292-1297` 快照 nodes 的遞迴 CTE
pub(crate) const SQL_OUTBOX_NODES_CTE: &str = concat!(
    "WITH RECURSIVE tree(id, depth) AS ( ",
    "SELECT id, 0 FROM nodes WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM nodes) ",
    "UNION ALL ",
    "SELECT n.id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id WHERE t.depth < 50 ",
    ") ",
    "SELECT n.*, t.depth AS _depth FROM nodes n JOIN tree t ON t.id = n.id ORDER BY t.depth, n.position"
);

/// `engine.rs:1329` 快照 work_logs（filter 開頭有一個空白）
pub(crate) const SQL_OUTBOX_WORK_LOGS: &str =
    "SELECT * FROM work_logs WHERE event IS NULL OR event <> 'conflict' ORDER BY logged_at";
/// `engine.rs:1329` 快照 occurrences（filter 空字串）
pub(crate) const SQL_OUTBOX_OCCURRENCES: &str = "SELECT * FROM occurrences ORDER BY due_on";

/// `engine.rs:3869` 全量 JSON 三表
pub(crate) const SQL_FULL_JSON: &[&str] = &[
    "SELECT * FROM nodes ORDER BY created_at",
    "SELECT * FROM work_logs ORDER BY logged_at",
    "SELECT * FROM occurrences ORDER BY due_on",
];

/// `snapshot.rs:459-462` 匯入前清格子（settings 白名單只有 `day_start_hour`）
pub(crate) const SQL_IMPORT_DELETE_CELLS: &str = "DELETE FROM sync_cells WHERE tbl IN ('nodes','work_logs','occurrences') OR (tbl = 'settings' AND row_id IN ('day_start_hour'))";

/// `snapshot.rs:468-469` 匯入前刪表（子先父後）
pub(crate) const SQL_IMPORT_DELETE_TABLES: &[&str] = &[
    "DELETE FROM occurrences",
    "DELETE FROM work_logs",
    "DELETE FROM nodes",
];

/// `engine.rs:3113-3120` `wipe_local_data` 六句
pub(crate) const SQL_WIPE: &[&str] = &[
    "PRAGMA defer_foreign_keys = ON",
    "DELETE FROM occurrences",
    "DELETE FROM work_logs",
    "DELETE FROM nodes",
    "DELETE FROM sync_outbox",
    "DELETE FROM sync_cells",
];

/// `backup.rs:1044-1049` `reset_database_keep_settings` 四句（重構後＝`reset_statements()`）
pub(crate) const SQL_RESET: &[&str] = &[
    "DELETE FROM occurrences",
    "DELETE FROM work_logs",
    "DELETE FROM nodes",
    "VACUUM",
];

/// `engine.rs:3714` `local_alive_count`
pub(crate) const SQL_ALIVE_COUNT: &str = "SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL";

// ─────────────────────────────────────────────────────────────
// T-甲9：已發行 migration 的 sqlx checksum（SHA-384(lf(sql)) 的 hex）
// 甲0 由 `lib.rs` 現行的 `lf(include_str!(…))` 算出（`t9_…` 斷言它們相等）；
// 甲0 另以 node `crypto.createHash('sha384')` 對 checkout 裡的檔案位元組獨立算過一次，兩邊一致。
// ─────────────────────────────────────────────────────────────

/// (version, stem, sha384 hex)
pub(crate) const RELEASED_MIGRATIONS_SHA384: &[(i64, &str, &str)] = &[
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
];

// ─────────────────────────────────────────────────────────────
// 金樣檔讀寫
// ─────────────────────────────────────────────────────────────

pub(crate) fn golden_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/golden"))
}

pub(crate) fn write_mode() -> bool {
    std::env::var("NS_GOLDEN").map(|v| v == "write").unwrap_or(false)
}

/// 讀金樣檔（執行期讀，檔不在也編得過）
pub(crate) fn read_golden(name: &str) -> String {
    let p = golden_dir().join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| {
        panic!(
            "讀不到金樣 {}：{e}（金樣要在 G0 之前用 NS_GOLDEN=write 產生）",
            p.display()
        )
    })
}

/// `NS_GOLDEN=write` ⇒ 寫檔；否則逐位元組比對，不符就把實際產出另存暫存目錄並指出第一個不同的行。
pub(crate) fn check_golden(name: &str, actual: &str) {
    if write_mode() {
        let dir = golden_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), actual.as_bytes()).unwrap();
        return;
    }
    let expected = read_golden(name);
    if expected == actual {
        return;
    }
    let dump = std::env::temp_dir().join(format!("ns-golden-actual-{name}"));
    let _ = std::fs::write(&dump, actual.as_bytes());
    let mut el = expected.split('\n');
    let mut al = actual.split('\n');
    let mut line = 1usize;
    loop {
        match (el.next(), al.next()) {
            (Some(e), Some(a)) if e == a => line += 1,
            (e, a) => panic!(
                "金樣 {name} 不符（第 {line} 行）\n  金樣：{e:?}\n  實際：{a:?}\n實際產出已存到 {}",
                dump.display()
            ),
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 臨時 DB 與種子（契約 §11.2）
// ─────────────────────────────────────────────────────────────

static GSEQ: AtomicU32 = AtomicU32::new(0);

/// 跑完 0001–0004 的臨時 DB（系統暫存目錄、測完就刪；FK 開著，與既有測試的 `make_pool` 同設定）。
/// **只跑已發行的前四支、寫死在這裡**，不跟著 `MIGRATIONS` 走：三線加的 migration 不進這顆庫。
pub(crate) async fn golden_pool(tag: &str) -> (Pool<Sqlite>, std::path::PathBuf) {
    let n = GSEQ.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!(
        "ns-foundation-golden-{tag}-{}-{n}.db",
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

pub(crate) async fn drop_golden_pool(pool: Pool<Sqlite>, path: std::path::PathBuf) {
    pool.close().await;
    let _ = std::fs::remove_file(&path);
}

/// 依欄名插一列（值：null／整數／字串）
pub(crate) async fn ins(pool: &Pool<Sqlite>, tbl: &str, cols: &[(&str, Value)]) {
    let names = cols.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(", ");
    let marks = vec!["?"; cols.len()].join(", ");
    let sql = format!("INSERT INTO {tbl} ({names}) VALUES ({marks})");
    let mut q = sqlx::query(&sql);
    for (c, v) in cols {
        q = match v {
            Value::Null => q.bind(None::<String>),
            Value::Number(n) => q.bind(n.as_i64().expect("種子只用整數")),
            Value::String(s) => q.bind(s.clone()),
            other => panic!("種子 {tbl}.{c} 的值型別不支援：{other}"),
        };
    }
    q.execute(pool)
        .await
        .unwrap_or_else(|e| panic!("種子插入 {tbl} 失敗：{e}"));
}

/// 金樣種子。每一項對應一個容易被重構改壞的特例（契約 §11.2 的表）：
///   * nodes 插入順序 L1→R1→T1→K2→K1→D1（FK 開著，只能父先）；
///     `created_at` 順序 K2→R1→K1→L1→T1→D1；CTE 順序（深度、再 position）K1→L1→R1→T1→D1→K2——三種都不同
///   * K1＝根層臨時車票帶 `route_id='R1'`（要留）；K2＝非根層也帶 `route_id='R1'`（快照與補戳都要濾掉）
///   * D1＝墓碑；T1 的整數欄全有值、多數可 NULL 欄有值；L1／R1 多數欄 NULL
///   * work_logs：W1 一般（event NULL）、W2 競合日誌、W3 墓碑（event='punched'）；logged_at 順序 W2→W3→W1 ≠ 插入順序
///   * occurrences：O2 先插、O1 後插，due_on 順序 O1→O2
///   * settings：`day_start_hour`（白名單）、`theme`（非白名單）
///   * sync_cells：`T1.name`（較晚的 hlc、別台）、`T1.status`（較早的 hlc、這台）
///   * sync_meta：`device_id`、`epoch`
pub(crate) async fn seed_golden(pool: &Pool<Sqlite>) {
    use serde_json::json;
    let n = Value::Null;
    // ── nodes ──
    ins(
        pool,
        "nodes",
        &[
            ("id", json!("L1")),
            ("kind", json!("line")),
            ("parent_id", n.clone()),
            ("name", json!("月見坂線")),
            ("position", json!(2)),
            ("color", json!("#8a3b2e")),
            ("code", json!("TK")),
            ("created_at", json!("2026-09-01T00:00:03.000Z")),
            ("updated_at", json!("2026-09-05T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "nodes",
        &[
            ("id", json!("R1")),
            ("kind", json!("route")),
            ("parent_id", json!("L1")),
            ("line_id", json!("L1")),
            ("name", json!("普通")),
            ("description", json!("各駅停車")),
            ("position", json!(1)),
            ("created_at", json!("2026-09-01T00:00:01.000Z")),
            ("updated_at", json!("2026-09-06T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "nodes",
        &[
            ("id", json!("T1")),
            ("kind", json!("train")),
            ("parent_id", json!("R1")),
            ("line_id", json!("L1")),
            ("route_id", json!("R1")),
            ("name", json!("今日の列車")),
            ("position", json!(0)),
            ("status", json!("doing")),
            ("scheduled_on", json!("2026-09-10")),
            ("due_on", json!("2026-09-12")),
            ("priority", json!("high")),
            ("estimate_min", json!(30)),
            ("progress", json!(40)),
            ("time_spent_min", json!(15)),
            ("mood", json!("green")),
            ("expected_on", json!("2026-09-11")),
            ("today_position", json!(3)),
            ("carried_from", json!("2026-09-09")),
            ("created_at", json!("2026-09-01T00:00:04.000Z")),
            ("updated_at", json!("2026-09-10T12:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "nodes",
        &[
            ("id", json!("K2")),
            ("kind", json!("ticket")),
            ("parent_id", json!("T1")),
            ("line_id", json!("L1")),
            ("route_id", json!("R1")),
            ("name", json!("改札券")),
            ("position", json!(5)),
            ("repeat_rule", json!("{\"freq\":\"daily\"}")),
            ("account_id", json!("acct-x")),
            ("device_id", json!("dev-x")),
            ("created_at", json!("2026-09-01T00:00:00.500Z")),
            ("updated_at", json!("2026-09-07T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "nodes",
        &[
            ("id", json!("K1")),
            ("kind", json!("ticket")),
            ("parent_id", n.clone()),
            ("line_id", json!("L1")),
            ("route_id", json!("R1")),
            ("name", json!("臨時券")),
            ("position", json!(1)),
            ("status", json!("done")),
            ("completed_at", json!("2026-09-08T09:30:00.000Z")),
            ("arrived_on", json!("2026-09-08")),
            ("created_at", json!("2026-09-01T00:00:02.000Z")),
            ("updated_at", json!("2026-09-08T09:30:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "nodes",
        &[
            ("id", json!("D1")),
            ("kind", json!("ticket")),
            ("parent_id", json!("R1")),
            ("line_id", json!("L1")),
            ("route_id", json!("R1")),
            ("name", json!("廃止券")),
            ("position", json!(7)),
            ("created_at", json!("2026-09-01T00:00:05.000Z")),
            ("updated_at", json!("2026-09-09T00:00:00.000Z")),
            ("deleted_at", json!("2026-09-09T00:00:00.000Z")),
        ],
    )
    .await;
    // ── work_logs ──
    ins(
        pool,
        "work_logs",
        &[
            ("id", json!("W1")),
            ("node_id", json!("T1")),
            ("body", json!("発車")),
            ("logged_at", json!("2026-09-02T09:00:00.000Z")),
            ("event", n.clone()),
            ("created_at", json!("2026-09-02T09:00:00.000Z")),
            ("updated_at", json!("2026-09-02T09:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "work_logs",
        &[
            ("id", json!("W2")),
            ("node_id", json!("T1")),
            ("body", json!("{\"col\":\"name\",\"mine\":\"旧\",\"theirs\":\"新\"}")),
            ("logged_at", json!("2026-09-02T07:00:00.000Z")),
            ("event", json!("conflict")),
            ("created_at", json!("2026-09-02T07:00:00.000Z")),
            ("updated_at", json!("2026-09-02T07:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "work_logs",
        &[
            ("id", json!("W3")),
            ("node_id", json!("K1")),
            ("body", json!("改札")),
            ("logged_at", json!("2026-09-02T08:00:00.000Z")),
            ("event", json!("punched")),
            ("created_at", json!("2026-09-02T08:00:00.000Z")),
            ("updated_at", json!("2026-09-03T00:00:00.000Z")),
            ("deleted_at", json!("2026-09-03T00:00:00.000Z")),
        ],
    )
    .await;
    // ── occurrences ──
    ins(
        pool,
        "occurrences",
        &[
            ("id", json!("O2")),
            ("node_id", json!("K1")),
            ("due_on", json!("2026-09-03")),
            ("status", json!("skipped")),
            ("created_at", json!("2026-09-03T00:00:00.000Z")),
            ("updated_at", json!("2026-09-03T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "occurrences",
        &[
            ("id", json!("O1")),
            ("node_id", json!("T1")),
            ("due_on", json!("2026-09-02")),
            ("status", json!("done")),
            ("completed_at", json!("2026-09-02T10:00:00.000Z")),
            ("mood", json!("yellow")),
            ("created_at", json!("2026-09-02T10:00:00.000Z")),
            ("updated_at", json!("2026-09-02T10:00:00.000Z")),
        ],
    )
    .await;
    // ── settings ──
    ins(
        pool,
        "settings",
        &[
            ("key", json!("day_start_hour")),
            ("value", json!("4")),
            ("updated_at", json!("2026-09-04T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "settings",
        &[
            ("key", json!("theme")),
            ("value", json!("sepia")),
            ("updated_at", json!("2026-09-04T01:00:00.000Z")),
        ],
    )
    .await;
    // ── sync_cells（預先兩格）──
    ins(
        pool,
        "sync_cells",
        &[
            ("tbl", json!("nodes")),
            ("row_id", json!("T1")),
            ("col", json!("name")),
            ("hlc", json!("17895000000000000-golden-o")),
            ("device_id", json!(OTHER_DEV)),
        ],
    )
    .await;
    ins(
        pool,
        "sync_cells",
        &[
            ("tbl", json!("nodes")),
            ("row_id", json!("T1")),
            ("col", json!("status")),
            ("hlc", json!("17882000000000000-golden-s")),
            ("device_id", json!(SELF_DEV)),
        ],
    )
    .await;
    // ── sync_meta ──
    ins(pool, "sync_meta", &[("key", json!("device_id")), ("value", json!(SELF_DEV))]).await;
    ins(pool, "sync_meta", &[("key", json!("epoch")), ("value", json!(EPOCH))]).await;
}

/// T-甲5 用：「另一顆塞了不同資料的 DB」（匯入要把它換掉；非白名單 settings 與其格子要留下）
pub(crate) async fn seed_other(pool: &Pool<Sqlite>) {
    use serde_json::json;
    ins(
        pool,
        "nodes",
        &[
            ("id", json!("X1")),
            ("kind", json!("line")),
            ("name", json!("旧線")),
            ("position", json!(0)),
            ("created_at", json!("2026-08-01T00:00:00.000Z")),
            ("updated_at", json!("2026-08-01T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "nodes",
        &[
            ("id", json!("X2")),
            ("kind", json!("ticket")),
            ("parent_id", json!("X1")),
            ("line_id", json!("X1")),
            ("name", json!("旧券")),
            ("position", json!(0)),
            ("created_at", json!("2026-08-01T00:00:01.000Z")),
            ("updated_at", json!("2026-08-01T00:00:01.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "work_logs",
        &[
            ("id", json!("XW1")),
            ("node_id", json!("X2")),
            ("body", json!("旧記録")),
            ("logged_at", json!("2026-08-02T00:00:00.000Z")),
            ("created_at", json!("2026-08-02T00:00:00.000Z")),
            ("updated_at", json!("2026-08-02T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "occurrences",
        &[
            ("id", json!("XO1")),
            ("node_id", json!("X2")),
            ("due_on", json!("2026-08-03")),
            ("status", json!("done")),
            ("created_at", json!("2026-08-03T00:00:00.000Z")),
            ("updated_at", json!("2026-08-03T00:00:00.000Z")),
        ],
    )
    .await;
    for (k, v, at) in [
        ("day_start_hour", "6", "2026-08-04T00:00:00.000Z"),
        ("theme", "dark", "2026-08-04T01:00:00.000Z"),
        ("cover", "kraft", "2026-08-04T02:00:00.000Z"),
    ] {
        ins(
            pool,
            "settings",
            &[("key", json!(k)), ("value", json!(v)), ("updated_at", json!(at))],
        )
        .await;
    }
    for (tbl, row, col, hlc, dev) in [
        ("nodes", "X1", "name", "17855000000000000-golden-o", OTHER_DEV),
        ("work_logs", "XW1", "body", "17855000000000001-golden-o", OTHER_DEV),
        ("settings", "day_start_hour", "value", "17855000000000002-golden-o", OTHER_DEV),
        // 非白名單 settings 的格子：匯入不准清
        ("settings", "theme", "value", "17855000000000003-golden-o", OTHER_DEV),
    ] {
        ins(
            pool,
            "sync_cells",
            &[
                ("tbl", json!(tbl)),
                ("row_id", json!(row)),
                ("col", json!(col)),
                ("hlc", json!(hlc)),
                ("device_id", json!(dev)),
            ],
        )
        .await;
    }
    ins(pool, "sync_meta", &[("key", json!("device_id")), ("value", json!(IMPORT_DEV))]).await;
}

// ─────────────────────────────────────────────────────────────
// 傾印（陣列形狀，不靠 Map 的鍵順序；一列一行，方便 diff）
// ─────────────────────────────────────────────────────────────

/// 一格 → JSON（整數 → 數字、文字 → 字串、NULL → null）
pub(crate) fn cell_json(row: &SqliteRow, i: usize) -> Value {
    if let Ok(Some(n)) = row.try_get::<Option<i64>, _>(i) {
        Value::from(n)
    } else if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
        Value::from(s)
    } else {
        Value::Null
    }
}

/// 跑一句 SELECT → (欄名, 每列的值陣列)
pub(crate) async fn query_rows(pool: &Pool<Sqlite>, sql: &str) -> (Vec<String>, Vec<Vec<Value>>) {
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("傾印失敗（{sql}）：{e}"));
    let cols: Vec<String> = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();
    let vals = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| cell_json(r, i)).collect())
        .collect();
    (cols, vals)
}

/// `# 標題` ＋ 欄名一行 ＋ 每列一行
pub(crate) fn render_block(title: &str, cols: &[String], rows: &[Vec<Value>]) -> String {
    let mut s = format!("# {title}\n");
    s.push_str(&serde_json::to_string(cols).unwrap());
    s.push('\n');
    for r in rows {
        s.push_str(&serde_json::to_string(r).unwrap());
        s.push('\n');
    }
    s
}

pub(crate) async fn dump_block(pool: &Pool<Sqlite>, title: &str, sql: &str) -> String {
    let (cols, rows) = query_rows(pool, sql).await;
    render_block(title, &cols, &rows)
}

/// `sync_cells` 全表（依 tbl、row_id、col）
pub(crate) const SQL_DUMP_CELLS: &str =
    "SELECT tbl, row_id, col, hlc, device_id FROM sync_cells ORDER BY tbl, row_id, col";

/// 每一張表的列數（`sqlite_master` 裡的每一張表，依名字排序）
pub(crate) async fn table_counts(pool: &Pool<Sqlite>) -> Vec<(String, i64)> {
    let names: Vec<String> = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .fetch_all(pool)
        .await
        .unwrap()
        .iter()
        .map(|r| r.try_get::<String, _>("name").unwrap())
        .collect();
    let mut out = Vec::new();
    for name in names {
        let n: i64 = sqlx::query(&format!("SELECT COUNT(*) FROM \"{name}\""))
            .fetch_one(pool)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        out.push((name, n));
    }
    out
}

pub(crate) fn render_counts(counts: &[(String, i64)]) -> String {
    let mut s = String::from("{\n");
    for (i, (name, n)) in counts.iter().enumerate() {
        let comma = if i + 1 < counts.len() { "," } else { "" };
        s.push_str(&format!("  {}: {n}{comma}\n", serde_json::to_string(name).unwrap()));
    }
    s.push_str("}\n");
    s
}

/// 補戳（獨立交易），回補了幾格
pub(crate) async fn golden_stamp(pool: &Pool<Sqlite>, me: &str) -> u64 {
    let mut tx = pool.begin().await.unwrap();
    let n = stamp_missing_cells_with(core_reg(), &mut tx, me).await.unwrap();
    tx.commit().await.unwrap();
    n
}

/// `sync_outbox` 依 seq：每行 `[seq, hlc, tbl, row_id, op, payload]`
pub(crate) async fn render_outbox(pool: &Pool<Sqlite>) -> String {
    let (_, rows) = query_rows(
        pool,
        "SELECT seq, hlc, tbl, row_id, op, payload FROM sync_outbox ORDER BY seq",
    )
    .await;
    let mut s = String::new();
    for r in &rows {
        s.push_str(&serde_json::to_string(r).unwrap());
        s.push('\n');
    }
    s
}

/// 全量 JSON 的 `exported_at` 換成固定字串（只換值，其餘位元組原封不動）
pub(crate) fn fix_exported_at(s: &str) -> String {
    let key = "\"exported_at\": \"";
    let i = s.find(key).expect("全量 JSON 沒有 exported_at") + key.len();
    let j = i + s[i..].find('"').expect("exported_at 的值沒有收尾引號");
    format!("{}{}{}", &s[..i], FIXED_EXPORTED_AT, &s[j..])
}

/// 全量 JSON 頂層的 `schema` 換成 `GOLDEN_SCHEMA`（只換值，其餘位元組原封不動；頂層鍵縮排兩格）
pub(crate) fn fix_schema(s: &str) -> String {
    let key = "\n  \"schema\": ";
    let i = s.find(key).expect("全量 JSON 沒有 schema") + key.len();
    let j = i + s[i..].find(|c: char| !c.is_ascii_digit()).expect("schema 的值沒有收尾");
    format!("{}{}{}", &s[..i], GOLDEN_SCHEMA, &s[j..])
}

/// 全量 JSON 比對前要固定的兩處：`exported_at`、`schema`
pub(crate) fn fix_full_json(s: &str) -> String {
    fix_schema(&fix_exported_at(s))
}

/// 種子 → 全量 JSON（`exported_at`、`schema` 已固定）
pub(crate) async fn golden_full_json() -> String {
    let (pool, path) = golden_pool("full").await;
    seed_golden(&pool).await;
    let text = build_full_json_with(core_reg(), &pool, SnapshotKind::Manual).await.unwrap();
    drop_golden_pool(pool, path).await;
    fix_full_json(&text)
}

// ─────────────────────────────────────────────────────────────
// 測試
// ─────────────────────────────────────────────────────────────

/// T-甲1：金樣常數＝舊的 `columns_of`／`required_of`／`pk_of`（重構後同一組斷言對薄殼再跑）
#[test]
fn t1_白名單常數與舊函式相等() {
    for (tbl, cols, req, pk) in GOLDEN_TABLES {
        assert_eq!(columns_of(tbl), Some(*cols), "columns_of({tbl})");
        assert_eq!(required_of(tbl), *req, "required_of({tbl})");
        assert_eq!(pk_of(tbl), *pk, "pk_of({tbl})");
    }
    for tbl in GOLDEN_NOT_SYNC_TABLES {
        assert_eq!(columns_of(tbl), None, "columns_of({tbl:?}) 應為 None");
        assert!(required_of(tbl).is_empty(), "required_of({tbl:?}) 應為空");
        assert_eq!(pk_of(tbl), "id", "pk_of({tbl:?})");
    }
    assert_eq!(SYNC_SETTINGS_KEYS, GOLDEN_SETTINGS_KEYS);
}

/// T-甲2：種子 → `stamp_missing_cells` → 整張 `sync_cells`
#[test]
fn t2_補戳結果() {
    tauri::async_runtime::block_on(async {
        let (pool, path) = golden_pool("stamp").await;
        seed_golden(&pool).await;
        let stamped = golden_stamp(&pool, SELF_DEV).await;
        let (_, cells) = query_rows(&pool, SQL_DUMP_CELLS).await;
        drop_golden_pool(pool, path).await;
        // 合法 JSON：{"stamped": N, "cells": [[tbl, row_id, col, hlc, device_id], …]}，一格一行
        let mut out = format!("{{\n  \"stamped\": {stamped},\n  \"cells\": [\n");
        for (i, r) in cells.iter().enumerate() {
            let comma = if i + 1 < cells.len() { "," } else { "" };
            out.push_str(&format!("    {}{comma}\n", serde_json::to_string(r).unwrap()));
        }
        out.push_str("  ]\n}\n");
        check_golden("stamp_cells.json", &out);
    });
}

/// T-甲3：種子 → 補戳 → `snapshot_into_outbox` → `sync_outbox` 依 seq（oplog 內容的位元組比對）
#[test]
fn t3_快照進_outbox() {
    tauri::async_runtime::block_on(async {
        let (pool, path) = golden_pool("outbox").await;
        seed_golden(&pool).await;
        golden_stamp(&pool, SELF_DEV).await;
        let n = snapshot_into_outbox_with(core_reg(), &pool, SELF_DEV).await.unwrap();
        let out = render_outbox(&pool).await;
        drop_golden_pool(pool, path).await;
        assert_eq!(n as usize, out.lines().count(), "回傳的 op 數＝outbox 列數");
        check_golden("outbox.jsonl", &out);
    });
}

/// T-甲4：種子 → `build_full_json`（雲端快照／匯出檔的位元組比對）
#[test]
fn t4_全量_json() {
    tauri::async_runtime::block_on(async {
        let text = golden_full_json().await;
        check_golden("full.json", &text);
    });
}

/// T-甲5：另一顆有料的 DB → `import_full_json(golden/full.json)` → (a) 報告序列化字串 (b) 傾印
#[test]
fn t5_匯入() {
    tauri::async_runtime::block_on(async {
        let input = if write_mode() {
            golden_full_json().await
        } else {
            read_golden("full.json")
        };
        let (pool, path) = golden_pool("import").await;
        seed_other(&pool).await;
        let report = snapshot::import_full_json_with(core_reg(), &pool, &input, IMPORT_DEV)
            .await
            .unwrap();
        let report_text = serde_json::to_string(&report).unwrap();
        let mut dump = String::new();
        dump.push_str(&dump_block(&pool, "nodes", "SELECT * FROM nodes ORDER BY id").await);
        dump.push_str(&dump_block(&pool, "work_logs", "SELECT * FROM work_logs ORDER BY id").await);
        dump.push_str(&dump_block(&pool, "occurrences", "SELECT * FROM occurrences ORDER BY id").await);
        dump.push_str(&dump_block(&pool, "settings", "SELECT * FROM settings ORDER BY key").await);
        dump.push_str(&dump_block(&pool, "sync_cells", SQL_DUMP_CELLS).await);
        drop_golden_pool(pool, path).await;
        check_golden("import_report.json", &report_text);
        check_golden("import_dump.txt", &dump);
    });
}

/// T-甲6：種子 → 補戳 → 快照（outbox 有料）→ `wipe_local_data` → 每張表的列數
#[test]
fn t6_清空() {
    tauri::async_runtime::block_on(async {
        let (pool, path) = golden_pool("wipe").await;
        seed_golden(&pool).await;
        golden_stamp(&pool, SELF_DEV).await;
        snapshot_into_outbox_with(core_reg(), &pool, SELF_DEV).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        wipe_local_data_with(core_reg(), &mut tx).await.unwrap();
        tx.commit().await.unwrap();
        let counts = table_counts(&pool).await;
        drop_golden_pool(pool, path).await;
        check_golden("wipe_counts.json", &render_counts(&counts));
    });
}

/// T-甲7：種子 → 補戳 → `apply_object(golden/apply_fixture.json)` → `ApplyOutcome` 五欄＋資料傾印。
/// 競合日誌的 `id` 與三個時間欄抹掉、`body` 逐字比；settings 只比 key／value（apply 的 upsert 戳的是「現在」）。
#[test]
fn t7_套用() {
    tauri::async_runtime::block_on(async {
        let fixture: OplogObject =
            serde_json::from_str(&read_golden("apply_fixture.json")).expect("apply_fixture.json 解不開");
        let (pool, path) = golden_pool("apply").await;
        seed_golden(&pool).await;
        golden_stamp(&pool, SELF_DEV).await;
        let o = apply_object_with(core_reg(), &pool, &fixture, "golden/object-key.bin", SELF_DEV)
            .await
            .unwrap();

        let mut out = String::from("# outcome [applied, skipped, conflicts, changed, skipped_missing]\n");
        out.push_str(
            &serde_json::to_string(&serde_json::json!([
                o.applied,
                o.skipped,
                o.conflicts,
                o.changed,
                o.skipped_missing
            ]))
            .unwrap(),
        );
        out.push('\n');
        out.push_str(&dump_block(&pool, "nodes", "SELECT * FROM nodes ORDER BY id").await);

        // work_logs：競合日誌抹掉 id 與時間欄，再依整列字串排序（id 是 uuid，不能拿來排）
        let (cols, mut rows) = query_rows(&pool, "SELECT * FROM work_logs ORDER BY id").await;
        let idx = |name: &str| cols.iter().position(|c| c == name).unwrap();
        let (i_id, i_event) = (idx("id"), idx("event"));
        let masked = [i_id, idx("logged_at"), idx("created_at"), idx("updated_at")];
        for r in rows.iter_mut() {
            if r[i_event].as_str() == Some("conflict") && r[i_id].as_str() != Some("W2") {
                for i in masked {
                    r[i] = Value::from(MASK);
                }
            }
        }
        rows.sort_by_key(|r| serde_json::to_string(r).unwrap());
        out.push_str(&render_block("work_logs", &cols, &rows));

        out.push_str(&dump_block(&pool, "occurrences", "SELECT * FROM occurrences ORDER BY id").await);
        out.push_str(&dump_block(&pool, "settings", "SELECT key, value FROM settings ORDER BY key").await);
        out.push_str(&dump_block(&pool, "sync_cells", SQL_DUMP_CELLS).await);
        out.push_str(&dump_block(&pool, "sync_meta", "SELECT key, value FROM sync_meta ORDER BY key").await);
        drop_golden_pool(pool, path).await;
        check_golden("apply_result.txt", &out);
    });
}

/// T-甲8 的機器旁證：手抄的 SQL 字面值拿到舊碼的同一份種子上執行，效果與舊函式相同。
/// （文字逐字相同要等 甲2 的純函式出來才驗得了；這裡至少擋住「抄錯到語意都變了」。）
#[test]
fn t8_手抄_sql_在舊碼上效果相同() {
    tauri::async_runtime::block_on(async {
        // ── 樣板展開：用舊碼的零件重組一次，對照手抄字面值 ──
        assert_eq!(derived_hlc_sql("n"), SQL_DERIVED_HLC_N);
        for (tbl, filter, lit) in [
            (
                "nodes",
                "WHERE NOT (c.col = 'route_id' AND NOT (n.parent_id IS NULL AND n.kind = 'ticket'))",
                SQL_STAMP_NODES,
            ),
            ("work_logs", "WHERE n.event IS NULL OR n.event <> 'conflict'", SQL_STAMP_WORK_LOGS),
            ("occurrences", "", SQL_STAMP_OCCURRENCES),
        ] {
            let cols_sql = core_reg()
                .find(tbl)
                .unwrap()
                .columns
                .iter()
                .map(|(c, _)| format!("SELECT '{c}' AS col"))
                .collect::<Vec<_>>()
                .join(" UNION ALL ");
            let rebuilt = format!(
                "INSERT OR IGNORE INTO sync_cells (tbl, row_id, col, hlc, device_id) \
                 SELECT '{tbl}', n.id, c.col, {stamp}, ?2 \
                 FROM {tbl} n CROSS JOIN ({cols_sql}) c {filter}",
                stamp = derived_hlc_sql("n")
            );
            assert_eq!(rebuilt, lit, "補戳 {tbl} 的手抄字面值");
        }

        // ── 補戳：字面值執行 vs `stamp_missing_cells` ──
        let (a, pa) = golden_pool("t8-stamp-a").await;
        let (b, pb) = golden_pool("t8-stamp-b").await;
        seed_golden(&a).await;
        seed_golden(&b).await;
        let n_old = golden_stamp(&a, SELF_DEV).await;
        let dev8 = dev8_of(SELF_DEV);
        let mut n_lit = 0u64;
        {
            let mut tx = b.begin().await.unwrap();
            for sql in [SQL_STAMP_NODES, SQL_STAMP_WORK_LOGS, SQL_STAMP_OCCURRENCES] {
                n_lit += sqlx::query(sql)
                    .bind(&dev8)
                    .bind(SELF_DEV)
                    .execute(&mut *tx)
                    .await
                    .unwrap()
                    .rows_affected();
            }
            for key in GOLDEN_SETTINGS_KEYS {
                n_lit += sqlx::query(SQL_STAMP_SETTINGS)
                    .bind(&dev8)
                    .bind(SELF_DEV)
                    .bind(*key)
                    .execute(&mut *tx)
                    .await
                    .unwrap()
                    .rows_affected();
            }
            tx.commit().await.unwrap();
        }
        assert_eq!(n_old, n_lit, "補戳格數");
        assert_eq!(
            dump_block(&a, "cells", SQL_DUMP_CELLS).await,
            dump_block(&b, "cells", SQL_DUMP_CELLS).await,
            "補戳結果"
        );

        // ── 快照的三句查詢：列順序＝`snapshot_into_outbox` 產出的 row_id 首見順序 ──
        snapshot_into_outbox_with(core_reg(), &a, SELF_DEV).await.unwrap();
        for (tbl, sql) in [
            ("nodes", SQL_OUTBOX_NODES_CTE),
            ("work_logs", SQL_OUTBOX_WORK_LOGS),
            ("occurrences", SQL_OUTBOX_OCCURRENCES),
        ] {
            let lit_ids: Vec<String> = sqlx::query(sql)
                .fetch_all(&a)
                .await
                .unwrap()
                .iter()
                .map(|r| r.try_get::<String, _>("id").unwrap())
                .collect();
            let mut seen: Vec<String> = Vec::new();
            for r in sqlx::query("SELECT row_id FROM sync_outbox WHERE tbl = ? ORDER BY seq")
                .bind(tbl)
                .fetch_all(&a)
                .await
                .unwrap()
            {
                let id: String = r.try_get("row_id").unwrap();
                if !seen.contains(&id) {
                    seen.push(id);
                }
            }
            assert_eq!(lit_ids, seen, "快照 {tbl} 的列順序");
        }

        // ── 全量 JSON 的三句查詢：列順序＝`build_full_json` 的陣列順序 ──
        let doc: Value =
            serde_json::from_str(&build_full_json_with(core_reg(), &a, SnapshotKind::Manual).await.unwrap())
                .unwrap();
        for (tbl, sql) in ["nodes", "work_logs", "occurrences"].into_iter().zip(SQL_FULL_JSON) {
            let lit_ids: Vec<String> = sqlx::query(sql)
                .fetch_all(&a)
                .await
                .unwrap()
                .iter()
                .map(|r| r.try_get::<String, _>("id").unwrap())
                .collect();
            let doc_ids: Vec<String> = doc[tbl]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["id"].as_str().unwrap().to_string())
                .collect();
            assert_eq!(lit_ids, doc_ids, "全量 JSON {tbl} 的列順序");
        }

        // ── local_alive_count ──
        let lit_alive: i64 = sqlx::query(SQL_ALIVE_COUNT)
            .fetch_one(&a)
            .await
            .unwrap()
            .try_get("n")
            .unwrap();
        assert_eq!(
            local_alive_count_with(core_reg(), &a).await.unwrap(),
            lit_alive as u64,
            "local_alive_count"
        );

        // ── 清空：字面值六句 vs `wipe_local_data`（兩顆都先補戳＋快照，outbox 有料）──
        snapshot_into_outbox_with(core_reg(), &b, SELF_DEV).await.unwrap();
        {
            let mut tx = a.begin().await.unwrap();
            wipe_local_data_with(core_reg(), &mut tx).await.unwrap();
            tx.commit().await.unwrap();
            let mut tx = b.begin().await.unwrap();
            for sql in SQL_WIPE {
                sqlx::query(sql).execute(&mut *tx).await.unwrap();
            }
            tx.commit().await.unwrap();
        }
        assert_eq!(table_counts(&a).await, table_counts(&b).await, "清空後的列數");
        drop_golden_pool(a, pa).await;
        drop_golden_pool(b, pb).await;

        // ── 匯入前清格子＋刪表：只剩非白名單 settings 的格子、三表清空 ──
        let (c, pc) = golden_pool("t8-import").await;
        seed_golden(&c).await;
        golden_stamp(&c, SELF_DEV).await;
        ins(
            &c,
            "sync_cells",
            &[
                ("tbl", Value::from("settings")),
                ("row_id", Value::from("theme")),
                ("col", Value::from("value")),
                ("hlc", Value::from("17884000000000000-golden-s")),
                ("device_id", Value::from(SELF_DEV)),
            ],
        )
        .await;
        {
            let mut tx = c.begin().await.unwrap();
            sqlx::query("PRAGMA defer_foreign_keys = ON").execute(&mut *tx).await.unwrap();
            sqlx::query(SQL_IMPORT_DELETE_CELLS).execute(&mut *tx).await.unwrap();
            for sql in SQL_IMPORT_DELETE_TABLES {
                sqlx::query(sql).execute(&mut *tx).await.unwrap();
            }
            tx.commit().await.unwrap();
        }
        let (_, left) = query_rows(&c, SQL_DUMP_CELLS).await;
        assert_eq!(
            left,
            vec![vec![
                Value::from("settings"),
                Value::from("theme"),
                Value::from("value"),
                Value::from("17884000000000000-golden-s"),
                Value::from(SELF_DEV),
            ]],
            "匯入前清格子只留非白名單 settings"
        );
        drop_golden_pool(c, pc).await;

        // ── reset_database_keep_settings 四句：三表清空、settings／格子／meta 不動 ──
        let (d, pd) = golden_pool("t8-reset").await;
        seed_golden(&d).await;
        golden_stamp(&d, SELF_DEV).await;
        let before = table_counts(&d).await;
        for sql in SQL_RESET {
            sqlx::query(sql).execute(&d).await.unwrap();
        }
        let after = table_counts(&d).await;
        for ((name, n0), (name1, n1)) in before.iter().zip(after.iter()) {
            assert_eq!(name, name1);
            let want = if ["nodes", "work_logs", "occurrences"].contains(&name.as_str()) {
                0
            } else {
                *n0
            };
            assert_eq!(*n1, want, "reset 之後 {name} 的列數");
        }
        drop_golden_pool(d, pd).await;
    });
}

/// T-甲9：已發行 migration 的 checksum＝金樣常數。算法與 tauri-plugin-sql 送進 sqlx 的完全相同：
/// `lib.rs` 的 `lf(include_str!(…))` → `sqlx::migrate::Migration::new` 的 SHA-384。
#[test]
fn t9_已發行_migration_位元組鎖() {
    use sha2::{Digest, Sha384};
    let current: [(i64, &str, &'static str); 4] = [
        (1, "0001_baseline", crate::lf(include_str!("../../migrations/0001_baseline.sql"))),
        (2, "0002_today", crate::lf(include_str!("../../migrations/0002_today.sql"))),
        (3, "0003_repeat", crate::lf(include_str!("../../migrations/0003_repeat.sql"))),
        (4, "0004_sync", crate::lf(include_str!("../../migrations/0004_sync.sql"))),
    ];
    assert_eq!(current.len(), RELEASED_MIGRATIONS_SHA384.len());
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    for ((v, stem, sql), (gv, gstem, ghex)) in current.iter().zip(RELEASED_MIGRATIONS_SHA384) {
        assert_eq!((v, stem), (gv, gstem));
        let ours = hex(Sha384::digest(sql.as_bytes()).as_slice());
        let theirs = sqlx::migrate::Migration::new(
            *v,
            std::borrow::Cow::Borrowed("golden"),
            sqlx::migrate::MigrationType::Simple,
            std::borrow::Cow::Borrowed(*sql),
            false,
        );
        assert_eq!(hex(&theirs.checksum), ours, "{stem}：sha2 與 sqlx 的 checksum 算法不一致");
        assert_eq!(ours, *ghex, "{stem}：已發行 migration 的位元組被動過（sqlx 會拒開主人的資料庫）");
    }
}
