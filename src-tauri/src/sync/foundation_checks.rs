//! 核心同步行為的回歸測試・第二組（源自並行地基 甲2；契約 `docs/research/2026-09-29-並行地基-契約.md` §11.3 ＋
//! `2026-10-05-並行地基-契約增補.md` 增補三）。
//!
//! 沿用 `foundation_golden.rs` 的種子、傾印、常數與 `golden/**` 資料檔；與它同樣**只鎖核心**（2026-10-05 解凍後）：
//! 臨時庫只跑已發行的前四支 migration，登記表用 `core_reg()`／`Registry::with_extra`（核心＋假表），
//! 不碰生產登記表，所以三線加 migration、加同步表不會讓這裡紅。資料檔要改須先經調度同意。
//! 核心自己加欄是例外（主線② 0009）——`SQL_STAMP_NODES` 等手抄常數要跟著改，這裡的 t8 才會綠。
//!   * T-甲8 `t8_純函式產出與手抄_sql_逐字相同`：重構後抽出的純函式（補戳／快照／匯出／匯入前清格子與刪表／
//!     清空／`reset_statements`／`local_alive_count`）產出的 SQL，與金樣裡手抄的 `SQL_*` 字面值逐字相同
//!   * T-甲10 `t10_*`：假表 `zz_probe` 經 `Registry::with_extra` 注入，走一遍補戳→快照→套用→匯出→匯入→清空，
//!     並斷言核心四張表的產出仍與金樣相同（新表不干擾舊表）；增補三：只有假表有資料、nodes 是空的時候，
//!     「這台有沒有資料」的計數大於零
//!
//! 掛在 `engine` 底下（`engine.rs` 檔尾的 `#[path]`），與金樣同理：讀得到 engine 的私有函式。

use super::foundation_golden::*;
use super::*;
use crate::sync::snapshot::{self, SnapshotKind};
use crate::sync::tables::{ConflictAnchor, Kind, OutboxQuery, Registry, RowsSpec, SyncTableSpec};

// ─────────────────────────────────────────────────────────────
// T-甲8：純函式的 SQL 產出 vs 金樣手抄字面值
// ─────────────────────────────────────────────────────────────

#[test]
fn t8_純函式產出與手抄_sql_逐字相同() {
    let reg = core_reg();
    let find_rows = |name: &str| {
        reg.rows()
            .find(|(t, _)| t.name == name)
            .unwrap_or_else(|| panic!("登記表裡沒有 {name}"))
    };

    // 補戳三句
    for (name, lit) in [
        ("nodes", SQL_STAMP_NODES),
        ("work_logs", SQL_STAMP_WORK_LOGS),
        ("occurrences", SQL_STAMP_OCCURRENCES),
    ] {
        let (t, r) = find_rows(name);
        assert_eq!(stamp_rows_sql(t.name, t.columns, r.stamp_filter), lit, "補戳 {name}");
    }

    // 快照：nodes 的 CTE、兩句 Plain
    for (name, lit) in [
        ("nodes", SQL_OUTBOX_NODES_CTE),
        ("work_logs", SQL_OUTBOX_WORK_LOGS),
        ("occurrences", SQL_OUTBOX_OCCURRENCES),
    ] {
        let (t, r) = find_rows(name);
        assert_eq!(outbox_query_sql(t.name, &r.outbox), lit, "快照 {name}");
    }
    assert!(matches!(find_rows("nodes").1.outbox, OutboxQuery::Custom(_)));

    // 全量 JSON 三句（登記順序）
    let full: Vec<String> = reg.rows().map(|(t, r)| full_json_sql(t.name, r.full_json_order)).collect();
    assert_eq!(full, SQL_FULL_JSON, "全量 JSON");

    // 匯入前清格子、刪表
    assert_eq!(snapshot::import_delete_cells_sql(reg), SQL_IMPORT_DELETE_CELLS, "匯入前清格子");
    assert_eq!(snapshot::import_delete_tables_sql(reg), SQL_IMPORT_DELETE_TABLES, "匯入前刪表");

    // 清空六句
    assert_eq!(wipe_statements(reg), SQL_WIPE, "wipe_local_data");

    // backup 的清場四句（backup.rs 只在桌機編）。`reset_statements()` 走生產登記表、沒有 `_with` 版本，
    // 三線登記的表會排在前面（子先父後）；只比核心那幾句，三線加表不會紅
    #[cfg(not(mobile))]
    {
        let core_deletes: Vec<String> = reg.rows().map(|(t, _)| format!("DELETE FROM {}", t.name)).collect();
        let ours: Vec<String> = crate::backup::reset_statements()
            .into_iter()
            .filter(|q| !q.starts_with("DELETE FROM ") || core_deletes.contains(q))
            .collect();
        assert_eq!(ours, SQL_RESET, "reset_statements（核心）");
    }

    // 這台有沒有資料：核心只有 nodes 一張 ⇒ 同一句 SQL
    assert_eq!(alive_count_sqls(reg), [SQL_ALIVE_COUNT], "local_alive_count");

    // 補戳的 derived hlc 片段（樣板沒動）
    assert_eq!(derived_hlc_sql("n"), SQL_DERIVED_HLC_N);
}

// ─────────────────────────────────────────────────────────────
// T-甲10：假表 `zz_probe`
// ─────────────────────────────────────────────────────────────

/// 假表（四欄慣例＋node_id 外鍵＋必填 body）
const ZZ_DDL: &str = "CREATE TABLE zz_probe ( \
    id TEXT PRIMARY KEY, \
    node_id TEXT REFERENCES nodes(id), \
    body TEXT NOT NULL, \
    created_at TEXT NOT NULL, \
    updated_at TEXT NOT NULL, \
    deleted_at TEXT)";

const ZZ_COLS: &[(&str, bool)] = &[
    ("node_id", false),
    ("body", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// 照契約 §13〈新增一張同步表〉的寫法填的假 spec（`since` 借 `sync`＝4 號，假表本身不是 migration 建的）
static ZZ_TABLES: &[SyncTableSpec] = &[SyncTableSpec {
    name: "zz_probe",
    pk: "id",
    columns: ZZ_COLS,
    required: &["body", "created_at", "updated_at"],
    kind: Kind::Rows(RowsSpec {
        stamp_filter: "",
        outbox: OutboxQuery::Plain {
            order_by: "created_at",
            filter: "",
        },
        outbox_row_fix: None,
        full_json_order: "created_at",
        fk_checked: true,
        conflict_anchor: ConflictAnchor::Column("node_id"),
        // 增補三：新同步表一律填 alive_filter
        alive_filter: Some("deleted_at IS NULL"),
        since: Some("sync"),
    }),
}];
static ZZ_KEYS: &[&str] = &["zz_key"];

fn zz_registry() -> Registry {
    Registry::with_extra(ZZ_TABLES, ZZ_KEYS)
}

async fn create_zz(pool: &Pool<Sqlite>) {
    sqlx::raw_sql(ZZ_DDL).execute(pool).await.unwrap();
}

/// 假表兩列（Z1 活的、掛 T1；Z2 墓碑、掛 K1）＋假的 settings 鍵
async fn seed_zz(pool: &Pool<Sqlite>) {
    use serde_json::json;
    ins(
        pool,
        "zz_probe",
        &[
            ("id", json!("Z1")),
            ("node_id", json!("T1")),
            ("body", json!("探針一")),
            ("created_at", json!("2026-09-01T00:00:06.000Z")),
            ("updated_at", json!("2026-09-10T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "zz_probe",
        &[
            ("id", json!("Z2")),
            ("node_id", json!("K1")),
            ("body", json!("探針二")),
            ("created_at", json!("2026-09-01T00:00:05.500Z")),
            ("updated_at", json!("2026-09-11T00:00:00.000Z")),
            ("deleted_at", json!("2026-09-11T00:00:00.000Z")),
        ],
    )
    .await;
    ins(
        pool,
        "settings",
        &[
            ("key", json!("zz_key")),
            ("value", json!("zz")),
            ("updated_at", json!("2026-09-04T02:00:00.000Z")),
        ],
    )
    .await;
}

/// 一行是不是假表帶進來的（傾印裡的 `"zz_probe"` 列與 `"zz_key"` 鍵）
fn is_zz_line(line: &str) -> bool {
    line.contains("\"zz_")
}

/// 傾印裡去掉假表的行
fn without_zz(text: &str) -> String {
    text.split_inclusive('\n').filter(|l| !is_zz_line(l)).collect()
}

/// 從金樣傾印裡取出 `# {title}` 那一段（到下一個 `# ` 為止）
fn golden_block(text: &str, title: &str) -> String {
    let head = format!("# {title}\n");
    let i = text.find(&head).unwrap_or_else(|| panic!("金樣裡沒有 {head:?}"));
    let rest = &text[i + head.len()..];
    let j = rest.find("\n# ").map(|j| j + 1).unwrap_or(rest.len());
    format!("{head}{}", &rest[..j])
}

#[test]
fn t10_假表_補戳與快照() {
    tauri::async_runtime::block_on(async {
        let reg = zz_registry();
        let (pool, path) = golden_pool("t10-stamp").await;
        seed_golden(&pool).await;
        create_zz(&pool).await;
        seed_zz(&pool).await;

        // ── 補戳：核心的格子＝金樣；假表兩列×五欄＋假鍵一格 ──
        let stamped = {
            let mut tx = pool.begin().await.unwrap();
            let n = stamp_missing_cells_with(&reg, &mut tx, SELF_DEV).await.unwrap();
            tx.commit().await.unwrap();
            n
        };
        let golden: Value = serde_json::from_str(&read_golden("stamp_cells.json")).unwrap();
        assert_eq!(stamped, golden["stamped"].as_u64().unwrap() + 2 * 5 + 1, "補戳格數");
        let (_, cells) = query_rows(&pool, SQL_DUMP_CELLS).await;
        let core: Vec<Value> = cells
            .iter()
            .filter(|r| !is_zz_line(&serde_json::to_string(r).unwrap()))
            .map(|r| Value::Array(r.clone()))
            .collect();
        assert_eq!(Value::Array(core), golden["cells"], "注入假表後核心的格子與金樣相同");
        let zz_cells = cells.iter().filter(|r| r[0] == "zz_probe").count();
        assert_eq!(zz_cells, 10, "假表的格子");

        // ── 快照：去掉假表那幾筆之後（seq 不比），與金樣逐位元組相同；假表的 op 排在 occurrences 之後、settings 之前 ──
        let n = snapshot_into_outbox_with(&reg, &pool, SELF_DEV).await.unwrap();
        let out = render_outbox(&pool).await;
        assert_eq!(n as usize, out.lines().count());
        let strip_seq = |line: &str| -> String {
            let mut v: Vec<Value> = serde_json::from_str(line).unwrap();
            v.remove(0);
            serde_json::to_string(&v).unwrap()
        };
        let ours: Vec<String> = out.lines().filter(|l| !is_zz_line(l)).map(strip_seq).collect();
        let theirs: Vec<String> = read_golden("outbox.jsonl").lines().map(strip_seq).collect();
        assert_eq!(ours, theirs, "注入假表後核心的 outbox 與金樣相同");
        let tbls: Vec<String> = out
            .lines()
            .map(|l| serde_json::from_str::<Vec<Value>>(l).unwrap()[2].as_str().unwrap().to_string())
            .collect();
        let first_zz = tbls.iter().position(|t| t == "zz_probe").expect("假表要進 outbox");
        let last_zz = tbls.iter().rposition(|t| t == "zz_probe").unwrap();
        assert!(tbls[..first_zz].iter().all(|t| t != "settings"), "假表的 op 要在 settings 之前");
        assert_eq!(tbls[first_zz - 1], "occurrences", "假表的 op 緊接在 occurrences 之後");
        assert!(tbls[last_zz + 1..].iter().all(|t| t == "settings"));
        // 墓碑也要跟著走；假鍵也要進
        assert!(out.contains("\"Z2\""), "假表的墓碑要進 outbox");
        assert!(out.contains("\"zz_key\""), "假的 settings 鍵要進 outbox");

        drop_golden_pool(pool, path).await;
    });
}

#[test]
fn t10_假表_套用() {
    tauri::async_runtime::block_on(async {
        let reg = zz_registry();

        // ── (a) 金樣 fixture 在假表登記表下套用：輸出與金樣逐位元組相同（新表不干擾舊表）──
        let fixture: OplogObject = serde_json::from_str(&read_golden("apply_fixture.json")).unwrap();
        let (pool, path) = golden_pool("t10-apply-golden").await;
        seed_golden(&pool).await;
        create_zz(&pool).await;
        {
            let mut tx = pool.begin().await.unwrap();
            stamp_missing_cells_with(&reg, &mut tx, SELF_DEV).await.unwrap();
            tx.commit().await.unwrap();
        }
        let o = apply_object_with(&reg, &pool, &fixture, "golden/object-key.bin", SELF_DEV)
            .await
            .unwrap();
        // 下面的渲染與金樣 t7 相同
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
        assert_eq!(out, read_golden("apply_result.txt"), "注入假表後套用金樣 fixture 的結果與金樣相同");

        // ── (b) 假表自己的 op：新列、併發改（競合掛到 node_id）、缺必填、孤兒（外鍵救援）──
        let op = |hlc: &str, row: &str, cols: Value| Op {
            hlc: hlc.to_string(),
            tbl: "zz_probe".to_string(),
            row_id: row.to_string(),
            op: OpKind::Upsert,
            cols: cols.as_object().unwrap().clone(),
        };
        let obj = OplogObject {
            version: OPLOG_VERSION,
            epoch: EPOCH.to_string(),
            device_id: "golden-remote-device".to_string(),
            hlc_from: "17896000000000001-golden-r".to_string(),
            hlc_to: "17896000000000004-golden-r".to_string(),
            schema: SCHEMA_VERSION,
            seen: Default::default(),
            ops: vec![
                op(
                    "17896000000000001-golden-r",
                    "Z3",
                    serde_json::json!({
                        "node_id": "T1", "body": "新規探針",
                        "created_at": "2026-09-20T00:00:00.000Z", "updated_at": "2026-09-20T00:00:00.000Z"
                    }),
                ),
                op("17896000000000002-golden-r", "Z1", serde_json::json!({ "body": "改寫探針" })),
                op(
                    "17896000000000003-golden-r",
                    "Z4",
                    serde_json::json!({ "node_id": "T1", "created_at": "2026-09-20T00:00:00.000Z" }),
                ),
                op(
                    "17896000000000004-golden-r",
                    "Z5",
                    serde_json::json!({
                        "node_id": "GHOST", "body": "孤兒探針",
                        "created_at": "2026-09-20T00:00:00.000Z", "updated_at": "2026-09-20T00:00:00.000Z"
                    }),
                ),
            ],
        };

        // 生產登記表不認得假表 ⇒ 四筆全跳過（證明閘門就是登記表）
        let (p0, path0) = golden_pool("t10-apply-prod").await;
        seed_golden(&p0).await;
        create_zz(&p0).await;
        seed_zz(&p0).await;
        golden_stamp(&p0, SELF_DEV).await;
        let o0 = apply_object_with(core_reg(), &p0, &obj, "k-zz", SELF_DEV).await.unwrap();
        assert_eq!((o0.applied, o0.skipped, o0.conflicts), (0, 4, 0), "不認得假表的登記表下，假表的 op 全跳過");
        drop_golden_pool(p0, path0).await;

        let (pool, path) = golden_pool("t10-apply-zz").await;
        seed_golden(&pool).await;
        create_zz(&pool).await;
        seed_zz(&pool).await;
        {
            let mut tx = pool.begin().await.unwrap();
            stamp_missing_cells_with(&reg, &mut tx, SELF_DEV).await.unwrap();
            tx.commit().await.unwrap();
        }
        let o = apply_object_with(&reg, &pool, &obj, "k-zz", SELF_DEV).await.unwrap();
        assert_eq!(o.applied, 2, "Z3 新列＋Z1 改寫（Z5 孤兒被救援撤掉）");
        assert_eq!(o.skipped, 2, "Z4 缺必填＋Z5 孤兒");
        assert_eq!(o.skipped_missing, 1, "Z4 缺 body");
        assert_eq!(o.conflicts, 1, "Z1.body 的併發修改留痕");
        assert!(o.changed.iter().any(|t| t == "zz_probe"), "changed 要含假表：{:?}", o.changed);
        let (_, zz) = query_rows(&pool, "SELECT id, body FROM zz_probe ORDER BY id").await;
        assert_eq!(
            zz,
            vec![
                vec![Value::from("Z1"), Value::from("改寫探針")],
                vec![Value::from("Z2"), Value::from("探針二")],
                vec![Value::from("Z3"), Value::from("新規探針")],
            ]
        );
        // 競合日誌掛在 Z1 的 node_id（T1）上（ConflictAnchor::Column）
        let (_, logs) = query_rows(
            &pool,
            "SELECT node_id, body FROM work_logs WHERE event = 'conflict' AND body LIKE '%zz_probe%'",
        )
        .await;
        assert_eq!(logs.len(), 1, "假表的競合日誌一筆");
        assert_eq!(logs[0][0], Value::from("T1"), "競合掛在 node_id 指到的節點");
        assert!(logs[0][1].as_str().unwrap().contains("\"row_id\":\"Z1\""));
        drop_golden_pool(pool, path).await;
    });
}

#[test]
fn t10_假表_匯出_匯入_清空() {
    tauri::async_runtime::block_on(async {
        let reg = zz_registry();

        // ── 匯出：去掉假表與假鍵之後，與金樣 full.json 相同 ──
        let (pool, path) = golden_pool("t10-full").await;
        seed_golden(&pool).await;
        create_zz(&pool).await;
        seed_zz(&pool).await;
        let text = fix_full_json(&build_full_json_with(&reg, &pool, SnapshotKind::Manual).await.unwrap());
        drop_golden_pool(pool, path).await;
        let mut doc: Value = serde_json::from_str(&text).unwrap();
        let zz = doc.as_object_mut().unwrap().remove("zz_probe").expect("匯出要有假表的陣列");
        let zz_ids: Vec<&str> = zz.as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(zz_ids, ["Z2", "Z1"], "假表依 full_json_order（created_at）排序、含墓碑");
        assert_eq!(doc["settings"]["zz_key"], "zz");
        doc["settings"].as_object_mut().unwrap().remove("zz_key");
        let golden: Value = serde_json::from_str(&read_golden("full.json")).unwrap();
        assert_eq!(doc, golden, "注入假表後核心的全量 JSON 與金樣相同");

        // ── 匯入：核心三表＋settings＋格子與金樣相同；假表進 `others` ──
        let (pool, path) = golden_pool("t10-import").await;
        seed_other(&pool).await;
        create_zz(&pool).await;
        let report = snapshot::import_full_json_with(&reg, &pool, &text, IMPORT_DEV).await.unwrap();
        let golden_report: Value = serde_json::from_str(&read_golden("import_report.json")).unwrap();
        let ours: Value = serde_json::to_value(&report).unwrap();
        for k in ["nodes", "work_logs", "occurrences", "skipped_rows"] {
            assert_eq!(ours[k], golden_report[k], "ImportReport.{k}");
        }
        assert_eq!(ours["settings"], golden_report["settings"].as_u64().unwrap() + 1, "多一把假鍵");
        assert_eq!(ours["others"], serde_json::json!({ "zz_probe": 2 }), "假表的筆數進 others");
        let golden_dump = read_golden("import_dump.txt");
        for (title, sql) in [
            ("nodes", "SELECT * FROM nodes ORDER BY id"),
            ("work_logs", "SELECT * FROM work_logs ORDER BY id"),
            ("occurrences", "SELECT * FROM occurrences ORDER BY id"),
            ("settings", "SELECT * FROM settings ORDER BY key"),
            ("sync_cells", SQL_DUMP_CELLS),
        ] {
            let ours = without_zz(&dump_block(&pool, title, sql).await);
            assert_eq!(ours, golden_block(&golden_dump, title), "匯入後 {title}（去掉假表）與金樣相同");
        }
        let (_, zz_rows) = query_rows(&pool, "SELECT id FROM zz_probe ORDER BY id").await;
        assert_eq!(zz_rows, vec![vec![Value::from("Z1")], vec![Value::from("Z2")]]);

        // ── 清空：假表清空，其餘列數與金樣相同 ──
        let (wp, wpath) = golden_pool("t10-wipe").await;
        seed_golden(&wp).await;
        create_zz(&wp).await;
        seed_zz(&wp).await;
        {
            let mut tx = wp.begin().await.unwrap();
            stamp_missing_cells_with(&reg, &mut tx, SELF_DEV).await.unwrap();
            tx.commit().await.unwrap();
        }
        snapshot_into_outbox_with(&reg, &wp, SELF_DEV).await.unwrap();
        {
            let mut tx = wp.begin().await.unwrap();
            wipe_local_data_with(&reg, &mut tx).await.unwrap();
            tx.commit().await.unwrap();
        }
        let mut counts = table_counts(&wp).await;
        let zz_n = counts.iter().find(|(n, _)| n == "zz_probe").map(|(_, c)| *c);
        assert_eq!(zz_n, Some(0), "假表要被清空");
        counts.retain(|(n, _)| n != "zz_probe");
        // 假鍵 settings 不清（settings 本來就不清），所以 settings 比金樣多一列
        for (n, c) in counts.iter_mut() {
            if n == "settings" {
                *c -= 1;
            }
        }
        assert_eq!(render_counts(&counts), read_golden("wipe_counts.json"), "清空後其餘列數與金樣相同");
        drop_golden_pool(wp, wpath).await;
        drop_golden_pool(pool, path).await;

        // ── 清空的 SQL：假表排在最前面（子先父後＝登記反序）──
        assert_eq!(
            wipe_statements(&reg),
            [
                "PRAGMA defer_foreign_keys = ON",
                "DELETE FROM zz_probe",
                "DELETE FROM occurrences",
                "DELETE FROM work_logs",
                "DELETE FROM nodes",
                "DELETE FROM sync_outbox",
                "DELETE FROM sync_cells",
            ]
        );
    });
}

/// 增補三：只有假表有資料、nodes 是空的時候，「這台有沒有資料」的計數大於零
#[test]
fn t10_假表_這台有沒有資料() {
    tauri::async_runtime::block_on(async {
        let reg = zz_registry();
        let (pool, path) = golden_pool("t10-alive").await;
        create_zz(&pool).await;
        use serde_json::json;
        ins(
            &pool,
            "zz_probe",
            &[
                ("id", json!("ZA")),
                ("body", json!("只有我")),
                ("created_at", json!("2026-09-01T00:00:00.000Z")),
                ("updated_at", json!("2026-09-01T00:00:00.000Z")),
            ],
        )
        .await;
        ins(
            &pool,
            "zz_probe",
            &[
                ("id", json!("ZB")),
                ("body", json!("墓碑不算")),
                ("created_at", json!("2026-09-01T00:00:00.000Z")),
                ("updated_at", json!("2026-09-02T00:00:00.000Z")),
                ("deleted_at", json!("2026-09-02T00:00:00.000Z")),
            ],
        )
        .await;
        let (_, nodes) = query_rows(&pool, "SELECT id FROM nodes").await;
        assert!(nodes.is_empty(), "前提：nodes 是空的");
        assert_eq!(local_alive_count_with(core_reg(), &pool).await.unwrap(), 0, "核心登記表不認得假表 ⇒ 0");
        let n = local_alive_count_with(&reg, &pool).await.unwrap();
        assert!(n > 0, "只有新表有資料時，這台要算「有資料」");
        assert_eq!(n, 1, "墓碑不算");
        assert_eq!(
            alive_count_sqls(&reg),
            [
                SQL_ALIVE_COUNT.to_string(),
                "SELECT COUNT(*) AS n FROM zz_probe WHERE deleted_at IS NULL".to_string(),
            ]
        );
        drop_golden_pool(pool, path).await;
    });
}

/// 契約 S-5：`since` 有值的表，只有快照的 schema 已經含那支 migration 才要求陣列存在；核心三表照舊一定要在
#[test]
fn t10_假表_匯入驗證看_since() {
    let reg = zz_registry();
    let doc = |schema: Option<u64>, zz: bool| {
        let mut m = serde_json::json!({ "nodes": [], "work_logs": [], "occurrences": [] });
        if let Some(s) = schema {
            m["schema"] = Value::from(s);
        }
        if zz {
            m["zz_probe"] = Value::Array(vec![]);
        }
        m.to_string()
    };
    // since = "sync"（4 號）
    assert!(snapshot::validate_full_json_with(&reg, &doc(Some(3), false)).is_ok(), "schema 3 的快照可以沒有假表");
    assert!(snapshot::validate_full_json_with(&reg, &doc(None, false)).is_ok(), "缺 schema＝0，可以沒有假表");
    assert!(snapshot::validate_full_json_with(&reg, &doc(Some(4), false)).is_err(), "schema 4 的快照必須有假表");
    assert!(snapshot::validate_full_json_with(&reg, &doc(Some(4), true)).is_ok());
    // 核心登記表：核心三表照舊
    let core = core_reg();
    assert!(snapshot::validate_full_json_with(core, &doc(Some(4), false)).is_ok());
    assert!(snapshot::validate_full_json_with(core, &serde_json::json!({ "schema": 4, "nodes": [], "work_logs": [] }).to_string()).is_err());
    assert!(snapshot::validate_full_json_with(core, &serde_json::json!({ "nodes": [], "work_logs": [] }).to_string()).is_err());
}
