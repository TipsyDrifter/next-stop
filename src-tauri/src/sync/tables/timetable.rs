// 時刻表線的同步表登記檔（並行地基 甲2；契約 §3.1、§13〈新增一張同步表〉）。只有時刻表線改這個檔。
// 寫法慣例（`scripts/probes/registry.ts` 靠它對帳）：每一筆 spec 的 `name: "xxx",` 獨佔一行；
// `SETTINGS_KEYS` 維持 `pub const SETTINGS_KEYS: &[&str] = &[ … ];` 這個形狀。
// 新表的 `alive_filter` 一律要填（2026-10-05 拍板；見 `tables/mod.rs` 的 `RowsSpec::alive_filter`）。
use super::{ConflictAnchor, Kind, OutboxQuery, RowsSpec, SyncTableSpec};

/// time_categories 的「主人資料」欄（車次①a 契約 §3.2）。account_id／device_id／synced_at 不同步（同核心慣例）。
const TIME_CATEGORIES_COLS: &[(&str, bool)] = &[
    ("parent_id", false),
    ("name", false),
    ("glyph", false),
    ("color_idx", true),
    ("position", true),
    ("default_min", true),
    ("archived_at", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// time_blocks 的「主人資料」欄。route_id 在本表是資料（只在沒連節點時才存），不是快取。
const TIME_BLOCKS_COLS: &[(&str, bool)] = &[
    ("category_id", false),
    ("started_at", false),
    ("ended_at", false),
    ("estimate_min", true),
    ("node_id", false),
    ("route_id", false),
    ("long_run_ack", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// time_goals 的「主人資料」欄（③ 契約 0-5）。account_id／device_id／synced_at 不同步（同核心慣例）。
const TIME_GOALS_COLS: &[(&str, bool)] = &[
    ("name", false),
    ("scope", false),
    ("period", false),
    ("target_min", true),
    ("direction", false),
    ("start_on", false),
    ("end_on", false),
    ("position", true),
    ("archived_at", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// 起手分類不算「這台有沒有資料」（契約 0-2 甲案）：每台都會自動種這 19 列，算進去的話任何新裝置加入同步都會被當成有資料。
/// id 與 `src/domain/timetable.ts` 的 `STARTER_CATEGORIES` 逐字相同（`scripts/tests/timetable-logic.test.ts` 對帳）。
const TIME_CATEGORIES_ALIVE: &str = "deleted_at IS NULL AND id NOT IN (\
'da1b233b-ba91-5269-b263-65101d1bdf43','f6a85065-28d7-5beb-8d12-65ee9d87b2c4','fc3692f1-857d-51b4-8c99-b0018333bc60',\
'593bcf09-ee64-5819-9af5-e069c89b3841','66a4fdf6-bc28-5cd4-8455-3faffd56f118','95280e69-3759-5d75-ac4f-b86547b913aa',\
'172c6c54-a53d-5988-bdbc-02d474b33088','9ab43381-2ee9-50fd-95dc-43239ad5cfbf','0f593f92-af5b-5d81-82ba-9363a9941dab',\
'163b6f28-5e42-5666-8f05-bd369e37e725','1f3bbc35-3ea7-56ed-9653-f62060742a28','cb9607ec-fb52-5deb-bc9e-7e5c7cbd6980',\
'88f77916-cb67-5128-82a2-7b95a49332e6','556a9c6a-de21-5b7d-9a3e-cc6312e7eef8','7d05ebf7-a358-536f-b5e3-9d842d19658d',\
'98001bf4-348e-508e-99ea-6df76c781347','ad20a08d-c66a-5999-89fc-4324701550ee','6e22561a-d964-58eb-8747-e6aa9d684d64',\
'88f7523b-61d2-5664-b039-8c32a86162c3')";

/// 時刻表線的同步表。只有時刻表線改這個檔。順序：categories 先（被 blocks 的外鍵指到）。
pub const TABLES: &[SyncTableSpec] = &[
    SyncTableSpec {
        name: "time_categories",
        pk: "id",
        columns: TIME_CATEGORIES_COLS,
        // NOT NULL 且沒有 DEFAULT：name（color_idx／position 有 DEFAULT）
        required: &["name"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            // 父先子後：頂層組（parent_id IS NULL → 0）排前面
            outbox: OutboxQuery::Plain {
                order_by: "(parent_id IS NOT NULL), position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: true, // parent_id 自我參照外鍵
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some(TIME_CATEGORIES_ALIVE),
            since: Some("timetable_blocks"),
        }),
    },
    SyncTableSpec {
        name: "time_blocks",
        pk: "id",
        columns: TIME_BLOCKS_COLS,
        // NOT NULL 且沒有 DEFAULT：category_id、started_at（long_run_ack 有 DEFAULT）
        required: &["category_id", "started_at"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "started_at",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "started_at",
            fk_checked: true, // category_id → time_categories
            // 不記競合日誌（競合日誌掛在節點上；兩台改同一塊由 App 的整理收斂，契約 §4.4）
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("timetable_blocks"),
        }),
    },
    SyncTableSpec {
        name: "time_goals",
        pk: "id",
        columns: TIME_GOALS_COLS,
        // NOT NULL 且沒有 DEFAULT：name、scope、period、target_min、direction（position 有 DEFAULT）
        required: &["name", "scope", "period", "target_min", "direction"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "position",
            fk_checked: false, // 沒有外鍵（scope 的分類 id 在 JSON 裡）
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("timetable_goals"),
        }),
    },
];

/// 時刻表線要同步的 settings 鍵：全域保險上限（分；0＝關）、釘選分類（JSON 字串陣列；磨光② A15）。
/// 「上次停在哪個視圖」與通知開關各台本地、不在這裡。
pub const SETTINGS_KEYS: &[&str] = &["timetable_long_run_max_min", "timetable_notice_pins"];
