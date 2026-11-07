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
    ("repeat_id", false), // 第③階段（③契約 0-3）：哪條定期規則記的；舊版 App 收到只丟這一欄
    ("import_id", false),
    ("import_source", false),
    ("import_utime", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// tk_budgets 的「主人資料」欄（第③階段，③契約 §3.2）。amount_minor 是主幣別；month NULL＝預設。
const TK_BUDGETS_COLS: &[(&str, bool)] = &[
    ("kind", false),
    ("category_id", false),
    ("month", false),
    ("amount_minor", true),
    ("position", true),
    ("import_id", false),
    ("import_source", false),
    ("import_utime", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// tk_repeats 的「主人資料」欄（第③階段）。next_on 是游標（③契約 0-6-4）、skipped_days 是 JSON 整欄 LWW（③契約 0-7-4）。
const TK_REPEATS_COLS: &[(&str, bool)] = &[
    ("kind", false),
    ("account_id", false),
    ("to_account_id", false),
    ("category_id", false),
    ("amount_minor", true),
    ("currency", false),
    ("note", false),
    ("route_id", false),
    ("rule", false),
    ("hhmm", false),
    ("next_on", false),
    ("paused_at", false),
    ("skipped_days", false),
    ("position", true),
    ("import_id", false),
    ("import_source", false),
    ("import_utime", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// wr_kinds 的「主人資料」欄（壬 候車室 0019）：種類（番線）——name、實現動作 action、順序。
/// 起手五列由 App 依固定 id 補種（含墓碑判斷，刪了不回來）；兩台的種子 id 相同、確定性合一。
const WR_KINDS_COLS: &[(&str, bool)] = &[
    ("name", false),
    ("action", false),
    ("position", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// 起手五列不算「這台有沒有資料」（同 tk_currencies／tk_categories 前例）：
/// id 與 `src/domain/ticket.ts` 的 WR_KIND_SEEDS 逐字相同。
const WR_KINDS_ALIVE: &str = "deleted_at IS NULL AND id NOT IN (\
'5b1a6c3e-0f44-5a7a-9d2b-8e6f1c0a2b31','9c2d7e4f-1a55-5b8b-8c3c-7f0a2d1b3c42',\
'3e4f8a5c-2b66-5c9c-bd4d-6a1b3e2c4d53','7a5c9b6d-3c77-5dad-ae5e-5b2c4f3d5e64',\
'1d6e0c7f-4d88-5ebe-9f6f-4c3d5a4e6f75')";

/// tk_wishes 的「主人資料」欄（售票口④ 0016；壬 候車室 0019 加 kind_id／target_kind／target_id）。
/// amount_minor 是主幣別、可 NULL；entry_id、kind_id、target_id 都不設外鍵（讀時判斷）。
const TK_WISHES_COLS: &[(&str, bool)] = &[
    ("name", false),
    ("amount_minor", true),
    ("note", false),
    ("category_id", false),
    ("position", true),
    ("entry_id", false),
    ("bought_at", false),
    ("kind_id", false),
    ("target_kind", false),
    ("target_id", false),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// tk_templates 的「主人資料」欄（售票口④，0016）：常用票種＝手動書籤。amount_minor／currency／account_id 可 NULL。
const TK_TEMPLATES_COLS: &[(&str, bool)] = &[
    ("name", false),
    ("kind", false),
    ("amount_minor", true),
    ("currency", false),
    ("account_id", false),
    ("to_account_id", false),
    ("category_id", false),
    ("note", false),
    ("route_id", false),
    ("position", true),
    ("created_at", false),
    ("updated_at", false),
    ("deleted_at", false),
];

/// 起手列不算「這台有沒有資料」（契約 0-16）：每台都會自動種 TWD 與收／支兩個「未分類」。
/// id 與 `src/domain/ticket.ts` 的 `CURRENCY_TWD_ID`／`UNCAT_INCOME_ID`／`UNCAT_EXPENSE_ID` 逐字相同（`scripts/tests/ticket-logic.test.ts` 對帳）。
const TK_CURRENCIES_ALIVE: &str = "deleted_at IS NULL AND id <> '0fd3bc2e-78d6-5e66-8e08-42d0006b659c'";
/// 預設分類（癸，D-主-531）同理，但改過名、排過序（`updated_at` 變了）就算資料；id 與 `DEFAULT_CATEGORIES` 逐字相同
/// （`scripts/tests/starter-defaults.test.ts` 對帳）。
const TK_CATEGORIES_ALIVE: &str = "deleted_at IS NULL AND id NOT IN (\
'aa25f94b-7093-5bd4-afe2-e3266219e74d','a6006f3b-a58a-502f-8164-98305b88fd1c') \
AND NOT (updated_at = created_at AND id IN (\
'3e349438-e3ec-5766-a953-60f3e9df0107','29b356df-5466-59eb-9c0d-91340dd06db5','2fd75c14-c48d-5525-adc4-944e992f2574',\
'ce0b3643-0bdb-5744-ac4a-0d2c970eccc4','887934a9-c482-5dd8-8eb8-88c2aa9507bd','7fbdd90a-bd98-5115-8167-cdaa5f7c632d',\
'22cd6164-03c6-5465-8c92-f99f6c680d8e','f00b86bb-4614-5159-bdd5-be810e321dbb','a8da037a-662f-5cfa-95c2-c6eeb6986f93',\
'2d6277f0-370b-54db-b0d1-07a20367748b','edc9eebe-57c6-5443-a3ed-04c0a2904464','df5dd9d9-df1f-570c-936a-3389c72cc93a'))";

/// tk_categories 的快照查詢：父先子後（D-票-78 分類不限層數之後，`(parent_id IS NOT NULL), position` 只保證兩層）。
/// 每一列往上走到頂、取最大深度排序：父一定排在子前面；父不在的當頂層（深度 0）；同步合出的環
/// （A→B→A）走到護欄 50 停、排在最後，不漏列。快照被切成好幾個物件時，孫輩才不會先到、被收到方的外鍵救援撤掉。
const TK_CATEGORIES_OUTBOX_CTE: &str = "WITH RECURSIVE up(id, anc, d) AS ( \
            SELECT id, parent_id, 0 FROM tk_categories \
            UNION ALL \
            SELECT up.id, c.parent_id, up.d + 1 FROM up JOIN tk_categories c ON c.id = up.anc WHERE up.d < 50 \
         ) \
         SELECT t.*, u.depth AS _depth FROM tk_categories t \
         JOIN (SELECT id, MAX(d) AS depth FROM up GROUP BY id) u ON u.id = t.id ORDER BY u.depth, t.position";

/// 售票口線的同步表（＋候車室的 wr_kinds：壬 0019，邏輯歸主線、實作放這裡跟 tk_wishes 作伴）。
/// 順序＝外鍵的父先子後：currencies → accounts → categories → entries → budgets → repeats（第③階段；兩張只指父表、彼此不指）
/// → wr_kinds → wishes → templates（售票口④／壬；wishes 的 kind_id 指 wr_kinds、不設 FK）。
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
            // 父先子後（不限層數）：見 `TK_CATEGORIES_OUTBOX_CTE`
            outbox: OutboxQuery::Custom(TK_CATEGORIES_OUTBOX_CTE),
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
    SyncTableSpec {
        name: "tk_budgets",
        pk: "id",
        columns: TK_BUDGETS_COLS,
        // NOT NULL 且沒有 DEFAULT：kind、amount_minor
        required: &["kind", "amount_minor"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: true, // category_id → tk_categories
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("ticket_plan"),
        }),
    },
    SyncTableSpec {
        name: "tk_repeats",
        pk: "id",
        columns: TK_REPEATS_COLS,
        // NOT NULL 且沒有 DEFAULT：kind、account_id、amount_minor、currency、rule（note／hhmm／skipped_days 有 DEFAULT）
        required: &["kind", "account_id", "amount_minor", "currency", "rule"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: true, // account_id／to_account_id → tk_accounts；category_id → tk_categories
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("ticket_plan"),
        }),
    },
    SyncTableSpec {
        name: "wr_kinds",
        pk: "id",
        columns: WR_KINDS_COLS,
        // NOT NULL 且沒有 DEFAULT：name（action／position 有 DEFAULT）
        required: &["name"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: false, // 沒有外鍵（tk_wishes.kind_id 指它，但不設 FK、讀時判斷）
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some(WR_KINDS_ALIVE),
            since: Some("waitroom_kind"),
        }),
    },
    SyncTableSpec {
        name: "tk_wishes",
        pk: "id",
        columns: TK_WISHES_COLS,
        // NOT NULL 且沒有 DEFAULT：name（note／position 有 DEFAULT）
        required: &["name"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            // 排序整組寫（#101）：每次搬動整組 position 同批送，跟帳戶／分類一樣
            outbox: OutboxQuery::Plain {
                order_by: "position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: true, // category_id → tk_categories（entry_id 不設外鍵）
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("ticket_wish"),
        }),
    },
    SyncTableSpec {
        name: "tk_templates",
        pk: "id",
        columns: TK_TEMPLATES_COLS,
        // NOT NULL 且沒有 DEFAULT：name、kind（note／position 有 DEFAULT）
        required: &["name", "kind"],
        kind: Kind::Rows(RowsSpec {
            stamp_filter: "",
            outbox: OutboxQuery::Plain {
                order_by: "position",
                filter: "",
            },
            outbox_row_fix: None,
            full_json_order: "created_at",
            fk_checked: true, // account_id／to_account_id → tk_accounts；category_id → tk_categories
            conflict_anchor: ConflictAnchor::None,
            alive_filter: Some("deleted_at IS NULL"),
            since: Some("ticket_wish"),
        }),
    },
];

/// 售票口線要同步的 settings 鍵（車次①沒有）。
pub const SETTINGS_KEYS: &[&str] = &[];
