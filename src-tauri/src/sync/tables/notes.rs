// 旅客筆記線的同步表登記檔（並行地基 甲2；契約 §3.1、§13〈新增一張同步表〉）。只有旅客筆記線改這個檔。
// 寫法慣例（`scripts/probes/registry.ts` 靠它對帳）：每一筆 spec 的 `name: "xxx",` 獨佔一行；
// `SETTINGS_KEYS` 維持 `pub const SETTINGS_KEYS: &[&str] = &[ … ];` 這個形狀。
// 新表的 `alive_filter` 一律要填（2026-10-05 拍板；見 `tables/mod.rs` 的 `RowsSpec::alive_filter`）。
use super::{ConflictAnchor, Kind, OutboxQuery, RowsSpec, SyncTableSpec};

/// notes 的「主人資料」欄白名單（車次①契約 §3.2）。第二欄＝是不是整數欄（apply 時走 i64）。
/// 沒有快取欄（路線由 node_id JOIN 推導，不存），所以表裡除了 id 的每一欄都同步。
const NOTES_COLS: &[(&str, bool)] = &[
    ("kind", false),
    ("title", false),
    ("body", false),
    ("entry_date", false),
    ("noted_at", false),
    ("node_id", false),
    ("inbox", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// tags 的「主人資料」欄（車次③契約 §3.2）。id 由 name_key 決定性算出（TS 端 `src/domain/tags.ts`），兩台同名同 id。
const TAGS_COLS: &[(&str, bool)] = &[
    ("name", false),
    ("name_key", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// taggings 的「主人資料」欄。id 由 (entity_type, entity_id, tag_id) 決定性算出。
const TAGGINGS_COLS: &[(&str, bool)] = &[
    ("entity_type", false),
    ("entity_id", false),
    ("tag_id", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// 旅客筆記線的同步表。只有旅客筆記線改這個檔。順序：notes、tags（被 taggings 指到）、taggings。
pub const TABLES: &[SyncTableSpec] = &[
    SyncTableSpec {
        name: "notes",
        pk: "id",
        columns: NOTES_COLS,
        // NOT NULL 且沒有 DEFAULT 的欄（0005）：kind、noted_at。body／inbox 有 DEFAULT，不列。
        required: &["kind", "noted_at"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "noted_at",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            // node_id 指向 nodes 但表上**沒有宣告 FK**（0005）：`prune_fk_violations` 走 PRAGMA foreign_key_check，
            // 沒有 FK 就查不到東西，填 true 是空轉。孤兒（節點被刪／還沒同步到）是「原節點已刪除」的顯示狀態，不是錯誤。
            fk_checked: false,
            // 車次①不記競合日誌（契約 0-8；要留痕得新增 anchor 種類＝改 engine.rs，另議）
            conflict_anchor: ConflictAnchor::None,
            // 2026-10-05 拍板：新功能的資料算進「這台有沒有資料」
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("notes_notes"),
        }),
    },
    SyncTableSpec {
        name: "tags",
        pk: "id",
        columns: TAGS_COLS,
        // NOT NULL 且沒有 DEFAULT：name、name_key（0008）
        required: &["name", "name_key"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "name_key",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "name_key",
            // 表上沒有 FK（車次③契約 0-11／§3.1）；name_key 也不設 UNIQUE（唯一性靠決定性 id）
            fk_checked: false,
            conflict_anchor: ConflictAnchor::None,
            // 2026-10-05 拍板：新功能的資料算進「這台有沒有資料」
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("notes_tags"),
        }),
    },
    SyncTableSpec {
        name: "taggings",
        pk: "id",
        columns: TAGGINGS_COLS,
        // NOT NULL 且沒有 DEFAULT：entity_type、entity_id、tag_id（0008）
        required: &["entity_type", "entity_id", "tag_id"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "created_at",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            // tag_id／entity_id 都沒有宣告 FK：孤兒＝顯示狀態（讀取一律 JOIN 存活，契約 0-12）
            fk_checked: false,
            conflict_anchor: ConflictAnchor::None,
            // 掛載不會脫離實體單獨存在；仍照規則填，免得「只掛了荷札」的裝置被當成空的
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("notes_tags"),
        }),
    },
];

/// 旅客筆記線要同步的 settings 鍵（車次①沒有）。
pub const SETTINGS_KEYS: &[&str] = &["week_start"];
