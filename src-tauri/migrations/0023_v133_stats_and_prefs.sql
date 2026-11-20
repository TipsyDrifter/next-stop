-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 第七本第三梯（v1.33）：統計專題、作息範本生效區間（2026-11-18）
-- 兩項變更：
--   1. time_stat_topics：釘選自訂統計專題（G1 / 功能 2），可單獨指定專題切日時間 day_start_hour（NULL＝跟隨全域）。
--   2. time_routines 新增 start_day / end_day（G2）：作息範本生效區間（'YYYY-MM-DD' 或 NULL）。
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE time_stat_topics (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT '{"v":1}',       -- JSON 存分類／路線／節點／荷札篩選條件
    day_start_hour  INTEGER,                               -- NULL＝跟隨全域日界線；0–23＝專題獨立切日線
    position        INTEGER NOT NULL DEFAULT 0,
    archived_at     TEXT,

    -- 同步預備（比照 time_goals / time_routines）
    account_id      TEXT,
    device_id       TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at       TEXT,
    deleted_at      TEXT
);

CREATE INDEX idx_tst_alive ON time_stat_topics(position) WHERE deleted_at IS NULL;

ALTER TABLE time_routines ADD COLUMN start_day TEXT;       -- 'YYYY-MM-DD' 或 NULL（不限開始日）
ALTER TABLE time_routines ADD COLUMN end_day TEXT;         -- 'YYYY-MM-DD' 或 NULL（不限結束日）
