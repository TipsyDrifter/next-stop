-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 同步引擎班：定期券逐班時刻覆寫拆成資料列（2026-10-26，D-主-120）
-- 一天一列；id＝uuid v5(node_id || '|' || due_on)，由 TS 算（同 taggings 慣例，兩台同鍵同列）。
-- 舊欄 nodes.time_overrides 原地保留、停止讀寫（舊版物件的整欄寫入照套到舊欄、沒人讀）。
-- 存量搬移＝App 啟動後由 TS 一次性展開並入列（SQLite 算不了 uuid v5，不在 SQL 做）。
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵（同 0006／0011）。
-- 號碼只寫在檔名與 migrations.rs 那一行（施工期暫定號 0012；進驗收時由主對話發正式號，本檔內容不動）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE node_time_overrides (
    id           TEXT PRIMARY KEY NOT NULL,             -- uuid v5(OVERRIDE_ID_NAMESPACE, node_id || '|' || due_on)
    node_id      TEXT NOT NULL,                         -- → nodes.id（無 FK；定期券）
    due_on       TEXT NOT NULL,                         -- 'YYYY-MM-DD' 班次日（營業日）
    hhmm         TEXT,                                  -- 'HH:MM'（小時可 ≥24）；NULL＝這一班清掉時刻
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT                                   -- 清掉覆寫＝soft delete；再設同一班＝復活
);
CREATE INDEX idx_nto_node ON node_time_overrides(node_id, due_on);
