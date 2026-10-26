//! 既有四張同步表的 spec（並行地基 甲2；契約 §3.2）。值從 `engine.rs` 搬家前的
//! `columns_of`／`required_of`／`pk_of`／`stamp_missing_cells`／`snapshot_into_outbox`／`build_full_json`／
//! `prune_fk_violations`／`local_alive_count` **逐字搬**；G0 金樣（`sync/foundation_golden.rs`）逐位元組守著。
//!
//! 三條功能線不改這支檔——各線的表寫在自己的 `notes.rs`／`timetable.rs`／`ticket.rs`。
//! 核心之後新加的表（同步引擎班 `node_time_overrides`）另成一組 `TIME_OVERRIDE_TABLES`，不進 `TABLES`（理由見該常數）。

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
    ("scheduled_time", false),
    ("time_overrides", false),
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

/// node_time_overrides 的「主人資料」欄（同步引擎班 D-主-120；migration 0012）。
/// 一班一列、id 由 (node_id, due_on) 決定性算出（TS 端 `overrideId`，uuid v5），兩台同一班同一列——
/// 逐班時刻從 `nodes.time_overrides` 整欄 JSON 拆出來，兩台改不同班才不會互吃（#86）。
/// `nodes.time_overrides` 仍留在 `NODES_COLS`：舊版物件的整欄寫入照套到舊欄（沒人讀），拿掉會讓舊物件少套一欄。
const NODE_TIME_OVERRIDES_COLS: &[(&str, bool)] = &[
    ("node_id", false),
    ("due_on", false),
    ("hhmm", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// 核心新加的同步表（與上面四張分開一組）。
///
/// 為什麼不併進 `TABLES`：`Registry::core_only()` 只收 `TABLES`，G0 金樣（`foundation_golden.rs`）的臨時庫只跑
/// 0001–0004＋0009、沒有這張表——併進去補戳／快照／匯出／清空全部會撞「no such table」，金樣也得重產。
/// 分開一組、在生產登記表緊接核心之後串上（`tables/mod.rs` 的 `production_groups`），金樣照舊只鎖原本的四張。
/// 順序：接在 core 之後、notes 之前——probe（`scripts/probes/registry.ts`）照檔案內 `name:` 的出現順序對帳。
pub const TIME_OVERRIDE_TABLES: &[SyncTableSpec] = &[SyncTableSpec {
    name: "node_time_overrides",
    pk: "id",
    columns: NODE_TIME_OVERRIDES_COLS,
    // NOT NULL 且沒有 DEFAULT：node_id、due_on（0012）；hhmm 可 NULL（＝這一班清掉時刻）
    required: &["node_id", "due_on"],
    kind: Kind::Rows(RowsSpec {
        stamp_filter: "",
        outbox: OutboxQuery::Plain {
            order_by: "due_on",
            filter: "",
        },
        outbox_row_fix: None,
        full_json_order: "due_on",
        // node_id 指向 nodes 但沒宣告 FK（0012）：PRAGMA foreign_key_check 查不到東西，填 true 是空轉；
        // 票被刪掉時的孤兒列＝沒人讀（讀取一律依票撈）
        fk_checked: false,
        // 不記競合日誌：逐班時刻的「誰蓋了誰」由 toast 講（哪張票哪一班），不另寫乘務記錄
        conflict_anchor: ConflictAnchor::None,
        // 2026-10-05 拍板：新同步表一律算進「這台有沒有資料」（覆寫列不會脫離票單獨存在，照規則填）
        alive_filter: Some("deleted_at IS NULL"),
        since: Some("time_overrides"),
    }),
}];
