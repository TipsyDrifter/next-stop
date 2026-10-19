-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 時刻表 ③ 統計與環比：時數目標（2026-10-19，車次③；契約席立）
-- 一張表：time_goals（彈性目標：名字＋綁一組分類＋期間型態＋目標時數＋至少／至多）。
-- 規格：docs/research/2026-10-19-時刻表-③統計-契約.md §0-5
-- 決策：決策記錄 時刻表 D-時-42（彈性目標；期間四種型態）、D-時-56（目標卡）、D-時-59～62
-- 鐵則：只 DDL、不種資料；不加 CHECK——遠端 op 違反 CHECK 會讓整個同步物件的交易失敗（同 0006）。
-- 不設外鍵：scope 的分類 id 住在 JSON 裡；分類被刪＝顯示端略過，不是錯誤。
-- 號碼只寫在檔名與 migrations.rs 那一行（施工期暫定號 0011；進驗收時由主對話發正式號，本檔內容不動）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE time_goals (
    id           TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    scope        TEXT NOT NULL,                           -- JSON：{"categories":["<id>",…]}；⑥ 荷札進站後加 "tags"，不加欄
    period       TEXT NOT NULL,                           -- 'day' | 'week' | 'month'（週期重複）| 'since'（從某天起）| 'until'（到某天為止）| 'range'（單一區間）
    target_min   INTEGER NOT NULL,                        -- 目標分鐘
    direction    TEXT NOT NULL,                           -- 'atLeast' | 'atMost'
    start_on     TEXT,                                    -- 'YYYY-MM-DD'（日界線日）；since／until／range 的起點（含），週期重複＝NULL
    end_on       TEXT,                                    -- 'YYYY-MM-DD'（日界線日）；until／range 的終點（含當天整天），其餘 NULL
    position     INTEGER NOT NULL DEFAULT 0,
    archived_at  TEXT,

    -- 同步預備（比照 time_blocks）
    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);

CREATE INDEX idx_tg_alive ON time_goals(position) WHERE deleted_at IS NULL;
