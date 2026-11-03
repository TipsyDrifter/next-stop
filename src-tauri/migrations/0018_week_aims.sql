-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 週方針（2026-11-02，戊；設計題丙 題六 A）
-- 一張表：week_aims（一週三到五句「這週大致要完成的事」，一句一列）。
-- 規格：docs/research/2026-11-02-主線-週方針-契約.md §2（D-主-251～253、263）
-- week_on＝那週第一天 'YYYY-MM-DD'；讀取用區間（改了每週從星期幾開始，舊列照落在包含它的那週）。
-- carried_from＝從哪一句帶過來（來源方針的 id）；帶過去那列的 id＝uuid v5(來源 id｜目標週首)，由 TS 算（兩台各自帶同一句＝同一列）。
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵（node_id 同 time_plans.node_id 的慣例）。
-- 預定正式號 0018（A 發；0016 售票口④、0017 車庫 stamps）；施工期分支檔名 0016，進驗收時由主對話改號。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE week_aims (
    id           TEXT PRIMARY KEY NOT NULL,
    week_on      TEXT NOT NULL,                           -- 那週第一天 'YYYY-MM-DD'
    text         TEXT NOT NULL,                           -- 一句方針
    node_id      TEXT,                                    -- 掛的路線（之後含支線）（→ nodes.id，無 FK）；NULL＝不掛
    position     INTEGER NOT NULL DEFAULT 0,              -- 這週裡的順序
    done_at      TEXT,                                    -- 済的時刻（UTC ISO）；NULL＝還沒済
    carried_from TEXT,                                    -- 從哪一句帶過來（→ week_aims.id，無 FK）；NULL＝這週新寫的

    -- 同步預備（比照 time_plans）
    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);

CREATE INDEX idx_wa_week ON week_aims(week_on);
