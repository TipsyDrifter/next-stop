-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 0010 售票口・管帳（2026-10-19，第③階段；契約席立）
-- 兩張表：tk_budgets（月預算：總額／分類；預設與單月覆寫）／tk_repeats（定期帳的規則＋模板）；tk_entries 加一欄 repeat_id。
-- 規格：docs/research/2026-10-19-售票口-③管帳-契約.md §3；決策：決策記錄 售票口 第③階段
-- 鐵則：純 DDL、不生資料列。不加 CHECK（遠端 op 違反 CHECK 會讓整個同步物件的交易失敗、游標卡住；同 0007）。
-- 預算只管主幣別（財務管家的 BUDGET_AMOUNT 沒有幣別欄）；規則模板存原幣、實體化當下才折算（D-票-8）。
-- 預算列的 id 由「對象＋月份」決定性算出（契約 0-4）：一個對象一個月只會有一列，兩台各設也只有一列。
-- 實體化的帳 id = uuid v5("repeat:<repeat_id>:<班次日>")；本表不存班次記錄，靠 id 與墓碑去重（契約 0-6／0-7）。
-- 號碼只寫在檔名與 migrations.rs 那一行（施工期暫定號；正式號進驗收時改那兩處，本檔內容不動）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE tk_budgets (
    id            TEXT PRIMARY KEY NOT NULL,              -- ticketId("budget:<total|cat:<category_id>>:<default|YYYY-MM>")
    kind          TEXT NOT NULL,                          -- total／category
    category_id   TEXT REFERENCES tk_categories(id),      -- kind='category' 才有（支出的主分類或子分類；未分類不設，契約 ✎-14）
    month         TEXT,                                   -- NULL＝預設（套用沒有覆寫的每個月）；'YYYY-MM'＝該月覆寫
    amount_minor  INTEGER NOT NULL,                       -- 主幣別最小單位，> 0
    position      INTEGER NOT NULL DEFAULT 0,
    import_id     TEXT,                                   -- 財務管家 BUDGET_AMOUNT.uid
    import_source TEXT,                                   -- 'moneymanager'
    import_utime  INTEGER,                                -- 上次匯入時的 MODIFY_DATE（毫秒；重跑判定）

    device_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at     TEXT,
    deleted_at    TEXT
);

CREATE INDEX idx_tkb_category ON tk_budgets(category_id);
CREATE INDEX idx_tkb_month    ON tk_budgets(month) WHERE deleted_at IS NULL;

CREATE TABLE tk_repeats (
    id             TEXT PRIMARY KEY NOT NULL,             -- 手建 uuid()；匯入 ticketId("moneymanager:repeat:<uid>")
    kind           TEXT NOT NULL,                         -- income／expense／transfer
    account_id     TEXT NOT NULL REFERENCES tk_accounts(id),
    to_account_id  TEXT REFERENCES tk_accounts(id),       -- transfer 才有
    category_id    TEXT REFERENCES tk_categories(id),     -- income／expense 才有（NULL＝該 kind 的未分類）
    amount_minor   INTEGER NOT NULL,                      -- 原幣最小單位（expense 可負＝每月固定退回，少見但不擋）
    currency       TEXT NOT NULL,                         -- 原幣 code（transfer 恆＝轉出帳戶幣別）
    note           TEXT NOT NULL DEFAULT '',
    route_id       TEXT,                                  -- → nodes（路線）；選填、不設外鍵（同 tk_entries）
    rule           TEXT NOT NULL,                         -- FixedRepeatRule 的 JSON（domain/repeat.ts serializeRule；只收 mode='fixed'）
    hhmm           TEXT NOT NULL DEFAULT '09:00',         -- 實體化的帳的時刻（本地 HH:MM，不套日界線；契約 ✎-7）
    next_on        TEXT,                                  -- 游標：下一個還沒記的班次日（本地日）；NULL＝沒有下一班（until 過了）。可回退、不是真相（契約 0-6-4）
    paused_at      TEXT,                                  -- 非 NULL＝暫停：不實體化、不推游標；開始時手建的從明天往後算第一班、匯入的接著 next_on（＝財務管家游標）（契約 ✎-8）
    skipped_days   TEXT NOT NULL DEFAULT '[]',            -- JSON 陣列：使用者刪掉的班次日（升冪、去重）；實體化跳過、拉完同步後補刪（契約 0-7）
    position       INTEGER NOT NULL DEFAULT 0,
    import_id      TEXT,                                  -- 財務管家 REPEATTRANSACTION.uid
    import_source  TEXT,                                  -- 'moneymanager'
    import_utime   INTEGER,                               -- 上次匯入時的 USETIME（毫秒；重跑判定）

    device_id      TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at      TEXT,
    deleted_at     TEXT
);

CREATE INDEX idx_tkr_account  ON tk_repeats(account_id);
CREATE INDEX idx_tkr_category ON tk_repeats(category_id);
CREATE INDEX idx_tkr_next     ON tk_repeats(next_on) WHERE deleted_at IS NULL AND paused_at IS NULL;

-- 這筆帳是哪條規則記的（或被「設成定期」連上的）；不設外鍵：規則刪了＝「（規則已刪除）」的顯示狀態。
-- ADD COLUMN 不回頭驗既有列；既有列全 NULL。
ALTER TABLE tk_entries ADD COLUMN repeat_id TEXT;
CREATE INDEX idx_tke_repeat ON tk_entries(repeat_id);
