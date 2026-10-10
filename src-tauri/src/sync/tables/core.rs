//! 既有四張同步表的 spec（並行地基 甲2；契約 §3.2）。值從 `engine.rs` 搬家前的
//! `columns_of`／`required_of`／`pk_of`／`stamp_missing_cells`／`snapshot_into_outbox`／`build_full_json`／
//! `prune_fk_violations`／`local_alive_count` **逐字搬**；G0 金樣（`sync/foundation_golden.rs`）逐位元組守著。
//!
//! 三條功能線不改這支檔——各線的表寫在自己的 `notes.rs`／`timetable.rs`／`ticket.rs`。

use super::{ConflictAnchor, Kind, OutboxQuery, RowsSpec, SyncTableSpec};
use crate::sync::engine::db_err;
use sqlx::Row;

/// 「主人資料」欄白名單。第二個欄位＝是不是整數欄（apply 時走 i64，其餘走文字或 NULL）。
///
/// 為什麼要有白名單：快取（`line_id`）與推導（有 repeat_rule 的 `scheduled_on`、lazy `today_position`）
/// 各台自算，搬過去只會互相打架；`account_id／device_id／synced_at` 這輪不用。
/// `route_id` 在表裡是快取，**只有根層臨時車票**那一筆是資料（路線標籤）——這個例外在快照端過濾（§2.2）。
const NODES_COLS: &[(&str, bool)] = &[
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
const WORK_LOGS_COLS: &[(&str, bool)] = &[
    ("node_id", false),
    ("body", false),
    ("logged_at", false),
    ("event", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];
const OCCURRENCES_COLS: &[(&str, bool)] = &[
    ("node_id", false),
    ("due_on", false),
    ("status", false),
    ("completed_at", false),
    ("mood", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];
const SETTINGS_COLS: &[(&str, bool)] = &[("value", false)];

/// nodes 的快照查詢：父先子後（遞迴 CTE；孤兒列＝父不存在的，也當根層收進來，不漏）
const NODES_OUTBOX_CTE: &str = "WITH RECURSIVE tree(id, depth) AS ( \
            SELECT id, 0 FROM nodes WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM nodes) \
            UNION ALL \
            SELECT n.id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id WHERE t.depth < 50 \
         ) \
         SELECT n.*, t.depth AS _depth FROM nodes n JOIN tree t ON t.id = n.id ORDER BY t.depth, n.position";

/// route_id 只有「根層臨時車票」那一筆是資料；其餘是快取，對方自己重算（契約 §2.2）
fn nodes_outbox_row_fix(
    row: &sqlx::sqlite::SqliteRow,
    cols: &mut serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let is_root_ticket = row
        .try_get::<Option<String>, _>("parent_id")
        .map_err(db_err)?
        .is_none()
        && row.try_get::<String, _>("kind").map_err(db_err)? == "ticket";
    if !is_root_ticket {
        cols.remove("route_id");
    }
    Ok(())
}

pub const TABLES: &[SyncTableSpec] = &[
    SyncTableSpec {
        name: "nodes",
        pk: "id",
        columns: NODES_COLS,
        required: &["kind", "name"],
        kind: Kind::Rows(RowsSpec {
            // nodes：`route_id` 只有「根層臨時車票」那一列是資料（路線標籤），其餘是快取、不進同步（契約 §2.2）
            stamp_filter: "WHERE NOT (c.col = 'route_id' AND NOT (n.parent_id IS NULL AND n.kind = 'ticket'))",
            outbox: OutboxQuery::Custom(NODES_OUTBOX_CTE),
            outbox_row_fix: Some(nodes_outbox_row_fix),
            full_json_order: "created_at",
            fk_checked: true,
            conflict_anchor: ConflictAnchor::SelfId,
            alive_filter: Some("deleted_at IS NULL"),
            since: None,
        }),
    },
    SyncTableSpec {
        name: "work_logs",
        pk: "id",
        columns: WORK_LOGS_COLS,
        required: &["node_id", "body", "logged_at"],
        kind: Kind::Rows(RowsSpec {
            // work_logs：競合日誌是各台自己記的「我這版被誰蓋掉了」，永不進同步（補戳與快照兩句**不同**：
            // 補戳帶別名 `n.`、沒有前導空白；快照不帶別名、有前導空白）
            stamp_filter: "WHERE n.event IS NULL OR n.event <> 'conflict'",
            outbox: OutboxQuery::Plain {
                order_by: "logged_at",
                filter: " WHERE event IS NULL OR event <> 'conflict'",
            },
            outbox_row_fix: None,
            full_json_order: "logged_at",
            fk_checked: true,
            conflict_anchor: ConflictAnchor::Column("node_id"),
            alive_filter: None,
            since: None,
        }),
    },
    SyncTableSpec {
        name: "occurrences",
        pk: "id",
        columns: OCCURRENCES_COLS,
        required: &["node_id", "due_on", "status"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "due_on",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "due_on",
            fk_checked: true,
            conflict_anchor: ConflictAnchor::Column("node_id"),
            alive_filter: None,
            since: None,
        }),
    },
    SyncTableSpec {
        name: "settings",
        pk: "key",
        columns: SETTINGS_COLS,
        required: &[],
        kind: Kind::KeyValue,
    },
];

/// settings 只同步這幾把鑰匙（v1.1.1 契約 §2.2／D-1.1-3）
pub const SETTINGS_KEYS: &[&str] = &["day_start_hour"];
