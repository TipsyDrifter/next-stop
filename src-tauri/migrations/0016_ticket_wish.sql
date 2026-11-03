-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 售票口・願望清單與常用票種（2026-11-02，售票口④；Stage 0 資料席立）
-- 兩張表：tk_wishes（想買的東西；買了連到記的那筆帳）／tk_templates（常用票種＝手動書籤：記一筆最上面那排小卡）。
-- 規格：docs/research/2026-11-01-售票口④-契約.md §6、§8；決策：決策記錄 售票口 D-票-68、69、76
-- 鐵則：純 DDL、不生資料列。不加 CHECK（遠端 op 違反 CHECK 會讓整個同步物件的交易失敗、游標卡住；同 0007、0010）。
-- 願望「買了沒」不另存狀態：entry_id 指到的帳還在＝已買；那筆帳被刪＝回到想買（讀的時候判斷，所以 entry_id 不設外鍵）。
-- 荷札一律走 taggings（ticket:wish／ticket:template），本檔不加欄。順序欄 position 照 #101：每次搬動整組重寫。
-- 號碼只寫在檔名與 migrations.rs 那一行；正式號由主對話進驗收時發（改那兩處，本檔內容不動）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE tk_wishes (
    id            TEXT PRIMARY KEY NOT NULL,              -- uuid()
    name          TEXT NOT NULL,                          -- 想買什麼（買了那筆的備註就用它）
    amount_minor  INTEGER,                                -- 預估金額，主幣別最小單位；NULL＝沒估
    note          TEXT NOT NULL DEFAULT '',
    category_id   TEXT REFERENCES tk_categories(id),      -- 支出分類，可不選（買了那筆預填它）
    position      INTEGER NOT NULL DEFAULT 0,
    entry_id      TEXT,                                   -- 買了記的那筆（→ tk_entries；不設外鍵：那筆被刪＝回到想買）
    bought_at     TEXT,                                   -- 按「買了」存檔的時刻（UTC ISO）；只給顯示與排序，真相看 entry_id

    device_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at     TEXT,
    deleted_at    TEXT
);

CREATE INDEX idx_tkw_category ON tk_wishes(category_id);
CREATE INDEX idx_tkw_entry    ON tk_wishes(entry_id);

CREATE TABLE tk_templates (
    id             TEXT PRIMARY KEY NOT NULL,             -- uuid()
    name           TEXT NOT NULL,                         -- 小卡上的字（「午餐」）
    kind           TEXT NOT NULL,                         -- income／expense／transfer（精算不能存）
    amount_minor   INTEGER,                               -- 原幣最小單位；NULL＝不帶金額
    currency       TEXT,                                  -- 原幣 code；NULL＝跟著帳戶
    account_id     TEXT REFERENCES tk_accounts(id),       -- NULL＝用預設帳戶
    to_account_id  TEXT REFERENCES tk_accounts(id),       -- transfer 才有
    category_id    TEXT REFERENCES tk_categories(id),     -- income／expense 才有
    note           TEXT NOT NULL DEFAULT '',
    route_id       TEXT,                                  -- → nodes（路線）；選填、不設外鍵（同 tk_entries）
    position       INTEGER NOT NULL DEFAULT 0,

    device_id      TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at      TEXT,
    deleted_at     TEXT
);

CREATE INDEX idx_tkt_account  ON tk_templates(account_id);
CREATE INDEX idx_tkt_category ON tk_templates(category_id);
