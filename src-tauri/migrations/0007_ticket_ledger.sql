-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 0007 售票口・帳本（2026-10-12，車次①；契約席立）
-- 四張表：tk_currencies（幣別）／tk_accounts（帳戶）／tk_categories（收支分類，兩層）／tk_entries（一筆帳）。
-- 規格：docs/research/2026-10-11-售票口-車次①帳本-契約.md §3；欄位權威＝Plan v3 §二（改名與補欄見契約 0-14）
-- 鐵則：純 DDL、不生資料列。TWD 主幣別與收／支兩個「未分類」由 App 經 repository 寫入（會進 oplog；契約 0-17）。
-- 金額一律原幣最小單位整數（INTEGER）；匯率是十進位字串（TEXT），不存浮點。餘額不存，查詢時加總（契約 §3.5-3）。
-- 不加 CHECK：遠端 op 違反 CHECK 會讓整個同步物件的交易失敗、游標卡住（同時刻表契約 0-9）；kind／group_key 的合法值由 App 守。
-- 沒有同步預備欄 account_id：會與帳本的 account_id（帳戶）撞名，且它從 v1.0 起恆 NULL、不同步（契約 0-13）。
-- route_id 不設外鍵：路線是 nodes 的列，刪了＝「原路線已刪除」的顯示狀態（同 0006）。
-- import_id 一般索引、不做 UNIQUE：套遠端列時觸發違反比重複更糟（Plan v3 §四）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE tk_currencies (
    id            TEXT PRIMARY KEY NOT NULL,              -- uuid v5(TICKET_ID_NAMESPACE, "currency:" + code)
    code          TEXT NOT NULL,                          -- ISO 4217 三碼大寫；自然鍵（同 code ⇒ 同 id，兩台各建也只有一列）
    name          TEXT NOT NULL DEFAULT '',               -- 顯示名（新台幣／美元…）
    decimals      INTEGER NOT NULL DEFAULT 2,             -- 最小單位的小數位
    rate_to_main  TEXT NOT NULL DEFAULT '1',              -- 1 單位此幣＝N 主幣別（十進位字串；主幣別恆 '1'）
    is_main       INTEGER NOT NULL DEFAULT 0,             -- 1＝主幣別（v1 只有 TWD）
    position      INTEGER NOT NULL DEFAULT 0,

    -- 同步預備（比照 0006；不含 account_id，契約 0-13）
    device_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at     TEXT,
    deleted_at    TEXT
);

CREATE TABLE tk_accounts (
    id            TEXT PRIMARY KEY NOT NULL,
    name          TEXT NOT NULL,
    group_key     TEXT NOT NULL DEFAULT 'other',          -- 契約 §4.1 ACCOUNT_GROUPS 的 key；card／credit／loan＝負債
    currency      TEXT NOT NULL DEFAULT 'TWD',            -- tk_currencies.code（不設外鍵：code 不是主鍵）
    position      INTEGER NOT NULL DEFAULT 0,             -- 同群組內的順序
    archived_at   TEXT,                                   -- 封存：仍計入合計、表單選不到

    device_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at     TEXT,
    deleted_at    TEXT
);

CREATE TABLE tk_categories (
    id            TEXT PRIMARY KEY NOT NULL,
    kind          TEXT NOT NULL,                          -- income／expense
    name          TEXT NOT NULL,                          -- 主人的命名照存（含 emoji 前綴）
    parent_id     TEXT REFERENCES tk_categories(id),      -- NULL＝主分類；兩層
    position      INTEGER NOT NULL DEFAULT 0,             -- 同一層內的順序（未分類＝9999，顯示時固定最後）
    archived_at   TEXT,                                   -- 封存主分類 ⇒ 子分類同時封存

    device_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at     TEXT,
    deleted_at    TEXT
);

CREATE INDEX idx_tkc_parent ON tk_categories(parent_id);

CREATE TABLE tk_entries (
    id               TEXT PRIMARY KEY NOT NULL,
    kind             TEXT NOT NULL,                       -- income／expense／transfer／adjust
    occurred_on      TEXT NOT NULL,                       -- 本地日 YYYY-MM-DD（主人選的日，不套日界線）
    occurred_at      TEXT NOT NULL,                       -- 時刻 UTC ISO（toISOString 24 字元）
    account_id       TEXT NOT NULL REFERENCES tk_accounts(id),
    to_account_id    TEXT REFERENCES tk_accounts(id),     -- transfer 才有
    category_id      TEXT REFERENCES tk_categories(id),   -- income／expense 才有（比不到＝該 kind 的未分類）
    amount_minor     INTEGER NOT NULL,                    -- 原幣最小單位；income／transfer 正；expense 可負（退款）；adjust 帶正負
    currency         TEXT NOT NULL,                       -- 原幣 code（transfer 恆＝轉出帳戶幣別）
    main_minor       INTEGER NOT NULL,                    -- 折主幣別
    account_minor    INTEGER NOT NULL,                    -- 折帳戶幣別（餘額公式用它）
    to_amount_minor  INTEGER,                             -- 轉入帳戶幣別的金額（transfer）
    note             TEXT NOT NULL DEFAULT '',
    route_id         TEXT,                                -- → nodes（路線）；選填、不設外鍵
    import_id        TEXT,                                -- 匯入來源的 id（財務管家 uid／"transfer:" + txUidTrans）
    import_source    TEXT,                                -- 'moneymanager'
    import_utime     INTEGER,                             -- 上次匯入時財務管家的 UTIME（毫秒；重跑判定，契約 0-22）

    device_id        TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at        TEXT,
    deleted_at       TEXT
);

CREATE INDEX idx_tke_on       ON tk_entries(occurred_on) WHERE deleted_at IS NULL;
CREATE INDEX idx_tke_account  ON tk_entries(account_id);
CREATE INDEX idx_tke_to       ON tk_entries(to_account_id);
CREATE INDEX idx_tke_category ON tk_entries(category_id);
CREATE INDEX idx_tke_import   ON tk_entries(import_id);
