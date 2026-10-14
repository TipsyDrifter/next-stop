// 售票口線的同步表登記檔（並行地基 甲2；車次①契約 §3.2、地基契約 §13〈新增一張同步表〉）。只有售票口線改這個檔。
// 寫法慣例（`scripts/probes/registry.ts` 靠它對帳）：每一筆 spec 的 `name: "xxx",` 獨佔一行；
// `SETTINGS_KEYS` 維持 `pub const SETTINGS_KEYS: &[&str] = &[ … ];` 這個形狀。
// 新表的 `alive_filter` 一律要填（2026-10-05 拍板；見 `tables/mod.rs` 的 `RowsSpec::alive_filter`）。
use super::{ConflictAnchor, Kind, OutboxQuery, RowsSpec, SyncTableSpec};

/// tk_currencies 的「主人資料」欄（第二欄＝是不是整數欄）。device_id／synced_at 不同步（同核心慣例）。
const TK_CURRENCIES_COLS: &[(&str, bool)] = &[
    ("code", false),
    ("name", false),
    ("decimals", true),
    ("rate_to_main", false),
    ("is_main", true),
    ("position", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

const TK_ACCOUNTS_COLS: &[(&str, bool)] = &[
    ("name", false),
    ("group_key", false),
    ("currency", false),
    ("position", true),
    ("archived_at", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

const TK_CATEGORIES_COLS: &[(&str, bool)] = &[
    ("kind", false),
    ("name", false),
    ("parent_id", false),
    ("position", true),
    ("archived_at", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// tk_entries 的「主人資料」欄。main_minor／account_minor／to_amount_minor 是記帳當下折好的值（D-票-8），是資料不是快取。
const TK_ENTRIES_COLS: &[(&str, bool)] = &[
    ("kind", false),
    ("occurred_on", false),
    ("occurred_at", false),
    ("account_id", false),
    ("to_account_id", false),
    ("category_id", false),
    ("amount_minor", true),
    ("currency", false),
    ("main_minor", true),
    ("account_minor", true),
    ("to_amount_minor", true),
    ("note", false),
    ("route_id", false),
    ("import_id", false),
    ("import_source", false),
    ("import_utime", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// 起手列不算「這台有沒有資料」（契約 0-16）：每台都會自動種 TWD 與收／支兩個「未分類」。
/// id 與 `src/domain/ticket.ts` 的 `CURRENCY_TWD_ID`／`UNCAT_INCOME_ID`／`UNCAT_EXPENSE_ID` 逐字相同（`scripts/tests/ticket-logic.test.ts` 對帳）。
const TK_CURRENCIES_ALIVE: &str = "deleted_at IS NULL AND id <> '0fd3bc2e-78d6-5e66-8e08-42d0006b659c'";
const TK_CATEGORIES_ALIVE: &str = "deleted_at IS NULL AND id NOT IN (\
'aa25f94b-7093-5bd4-afe2-e3266219e74d','a6006f3b-a58a-502f-8164-98305b88fd1c')";

/// 售票口線的同步表。只有售票口線改這個檔。順序＝外鍵的父先子後：currencies → accounts → categories → entries。
pub const TABLES: &[SyncTableSpec] = &[
    SyncTableSpec {
        name: "tk_currencies",
        pk: "id",
        columns: TK_CURRENCIES_COLS,
        // NOT NULL 且沒有 DEFAULT：code
        required: &["code"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: false, // 沒有外鍵
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some(TK_CURRENCIES_ALIVE),
            since: Some("ticket_ledger"),
        }),
    },
    SyncTableSpec {
        name: "tk_accounts",
        pk: "id",
        columns: TK_ACCOUNTS_COLS,
        // NOT NULL 且沒有 DEFAULT：name（group_key／currency／position 有 DEFAULT）
        required: &["name"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: false, // 沒有外鍵（currency 存 code）
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("ticket_ledger"),
        }),
    },
    SyncTableSpec {
        name: "tk_categories",
        pk: "id",
        columns: TK_CATEGORIES_COLS,
        // NOT NULL 且沒有 DEFAULT：kind、name
        required: &["kind", "name"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            // 父先子後：主分類（parent_id IS NULL → 0）排前面
            outbox: OutboxQuery::Plain {
                order_by: "(parent_id IS NOT NULL), position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: true, // parent_id 自我參照外鍵
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some(TK_CATEGORIES_ALIVE),
            since: Some("ticket_ledger"),
        }),
    },
    SyncTableSpec {
        name: "tk_entries",
        pk: "id",
        columns: TK_ENTRIES_COLS,
        // NOT NULL 且沒有 DEFAULT（note 有 DEFAULT）
        required: &["kind", "occurred_on", "occurred_at", "account_id", "amount_minor", "currency", "main_minor", "account_minor"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "occurred_on, occurred_at",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "occurred_on",
            fk_checked: true, // account_id／to_account_id → tk_accounts；category_id → tk_categories
            // 不記競合日誌（競合日誌掛在節點上；兩台改同一筆＝逐欄 LWW）
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("ticket_ledger"),
        }),
    },
];

/// 售票口線要同步的 settings 鍵（車次①沒有）。
pub const SETTINGS_KEYS: &[&str] = &[];
