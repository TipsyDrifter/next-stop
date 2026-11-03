//! 車庫與回顧 D-主-214：`stamps`（駅スタンプ）走一遍同步引擎——沙盒雙機以外，機器先把引擎這一段鎖住。
//! 臨時庫跑全部 migration（含 stamps），登記表用生產那份；不碰網路、不碰正本（檔案在系統暫存目錄、測完就刪）。
//!
//! 驗：兩台各自蓋同一枚（同 id、日期不同）不論先後套用都收斂成同一列（逐欄 LWW）；收回（delete op）傳得過去；
//! 復活（upsert deleted_at=NULL）傳得過去；快照帶得出 stamps 且欄位只有白名單；章算進「這台有沒有資料」；清空會清掉。

use super::*;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQ: AtomicU32 = AtomicU32::new(0);

async fn make_pool(tag: &str) -> (Pool<Sqlite>, std::path::PathBuf) {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!("ns-stamps-synctest-{tag}-{}-{n}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true).foreign_keys(true))
        .await
        .unwrap();
    for m in crate::migrations::MIGRATIONS {
        sqlx::raw_sql(m.sql).execute(&pool).await.unwrap();
    }
    (pool, path)
}

async fn drop_pool(pool: Pool<Sqlite>, path: std::path::PathBuf) {
    pool.close().await;
    let _ = std::fs::remove_file(&path);
}

fn op(hlc: &str, kind: OpKind, cols: &[(&str, Value)]) -> Op {
    let mut m = Map::new();
    for (k, v) in cols {
        m.insert((*k).to_string(), v.clone());
    }
    Op { hlc: hlc.into(), tbl: "stamps".into(), row_id: "S1".into(), op: kind, cols: m }
}

fn obj(device: &str, ops: Vec<Op>) -> OplogObject {
    OplogObject {
        version: OPLOG_VERSION,
        epoch: "1758153600000".into(),
        device_id: device.into(),
        hlc_from: ops.iter().map(|o| o.hlc.clone()).min().unwrap_or_default(),
        hlc_to: ops.iter().map(|o| o.hlc.clone()).max().unwrap_or_default(),
        schema: crate::sync::SCHEMA_VERSION,
        seen: Default::default(),
        ops,
    }
}

fn stamp_cols(day: &str, label: &str) -> Vec<(&'static str, Value)> {
    vec![
        ("kind", "seals".into()),
        ("subject_id", Value::Null),
        ("value", 1000.into()),
        ("label", label.to_string().into()),
        ("stamped_on", day.to_string().into()),
        ("created_at", "2026-11-02T00:00:00.000Z".into()),
        ("updated_at", "2026-11-02T00:00:00.000Z".into()),
    ]
}

async fn row(pool: &Pool<Sqlite>) -> (String, String, Option<String>, i64) {
    let r = sqlx::query("SELECT stamped_on, label, deleted_at, value FROM stamps WHERE id = 'S1'")
        .fetch_one(pool)
        .await
        .unwrap();
    (r.get("stamped_on"), r.get("label"), r.get("deleted_at"), r.get("value"))
}

#[test]
fn 兩台各蓋同一枚_先後順序不同也收斂成同一列() {
    tauri::async_runtime::block_on(async {
        let (a, pa) = make_pool("a").await;
        let (b, pb) = make_pool("b").await;
        // 兩台離線各自數到第 1000 枚、日期不同：a 早（hlc 小）、b 晚
        let from_a = obj("dev-a", vec![op("17581536000000010-aaaaaaaa", OpKind::Upsert, &stamp_cols("2026-10-01", "寄出確認信"))]);
        let from_b = obj("dev-b", vec![op("17581536000000020-bbbbbbbb", OpKind::Upsert, &stamp_cols("2026-10-02", "整理書桌"))]);
        // 甲庫：先收 a 再收 b；乙庫：先收 b 再收 a
        apply_object(&a, &from_a, "k-a1", "dev-x").await.unwrap();
        apply_object(&a, &from_b, "k-b1", "dev-x").await.unwrap();
        apply_object(&b, &from_b, "k-b2", "dev-y").await.unwrap();
        apply_object(&b, &from_a, "k-a2", "dev-y").await.unwrap();
        let ra = row(&a).await;
        let rb = row(&b).await;
        assert_eq!(ra, rb, "兩台收斂成同一列");
        assert_eq!(ra.0, "2026-10-02", "晚寫的那台贏（逐欄 LWW）");
        assert_eq!(ra.3, 1000, "value 是整數欄");
        // 章算進「這台有沒有資料」
        assert!(local_alive_count(&a).await.unwrap() >= 1);
        drop_pool(a, pa).await;
        drop_pool(b, pb).await;
    });
}

#[test]
fn 收回與復活都傳得過去() {
    tauri::async_runtime::block_on(async {
        let (p, path) = make_pool("revive").await;
        apply_object(&p, &obj("dev-a", vec![op("17581536000000010-aaaaaaaa", OpKind::Upsert, &stamp_cols("2026-10-01", "N5"))]), "k1", "dev-x")
            .await
            .unwrap();
        let del = vec![("deleted_at", Value::from("2026-11-02T01:00:00.000Z")), ("updated_at", Value::from("2026-11-02T01:00:00.000Z"))];
        apply_object(&p, &obj("dev-a", vec![op("17581536000000011-aaaaaaaa", OpKind::Delete, &del)]), "k2", "dev-x")
            .await
            .unwrap();
        assert!(row(&p).await.2.is_some(), "收回＝軟刪傳過來");
        let alive_before = local_alive_count(&p).await.unwrap();
        let back = vec![
            ("deleted_at", Value::Null),
            ("stamped_on", Value::from("2026-11-02")),
            ("label", Value::from("N5 改名")),
            ("updated_at", Value::from("2026-11-02T02:00:00.000Z")),
        ];
        apply_object(&p, &obj("dev-a", vec![op("17581536000000012-aaaaaaaa", OpKind::Upsert, &back)]), "k3", "dev-x")
            .await
            .unwrap();
        let r = row(&p).await;
        assert_eq!((r.0.as_str(), r.1.as_str(), r.2), ("2026-11-02", "N5 改名", None), "同一列復活、日期與名字換新");
        assert_eq!(local_alive_count(&p).await.unwrap(), alive_before + 1);
        drop_pool(p, path).await;
    });
}

#[test]
fn 快照帶得出章_清空會清掉() {
    tauri::async_runtime::block_on(async {
        let (p, path) = make_pool("snap").await;
        sqlx::query(
            "INSERT INTO stamps (id, kind, subject_id, value, label, stamped_on) VALUES ('S1','station','st1',NULL,'N5','2026-10-15')",
        )
        .execute(&p)
        .await
        .unwrap();
        let mut tx = p.begin().await.unwrap();
        stamp_missing_cells(&mut tx, "dev-a").await.unwrap();
        tx.commit().await.unwrap();
        snapshot_into_outbox(&p, "dev-a").await.unwrap();
        let payloads: Vec<String> = sqlx::query("SELECT payload FROM sync_outbox WHERE tbl = 'stamps'")
            .fetch_all(&p)
            .await
            .unwrap()
            .iter()
            .map(|r| r.get::<String, _>("payload"))
            .collect();
        assert_eq!(payloads.len(), 1, "快照帶出一筆 stamps");
        let cols: Map<String, Value> = serde_json::from_str(&payloads[0]).unwrap();
        let mut keys: Vec<&str> = cols.keys().map(|s| s.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["created_at", "deleted_at", "kind", "label", "stamped_on", "subject_id", "updated_at", "value"]);
        let mut tx = p.begin().await.unwrap();
        wipe_local_data(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
        let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM stamps").fetch_one(&p).await.unwrap().get("n");
        assert_eq!(n, 0, "重新開始／改用另一台時章一起清掉");
        drop_pool(p, path).await;
    });
}
