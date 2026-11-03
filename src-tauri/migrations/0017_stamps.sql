-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 第五本第一梯 ③ 車庫與回顧：駅スタンプ（2026-11-02，D-主-208～214）
-- 規格：docs/research/2026-11-02-主線-車庫與回顧-契約.md §二
-- 只記發生過的事：每一列＝一枚已經蓋下的章（開業、車站到着、路線／幹線到站、開業滿一年、記帳滿一年、
-- 済第 100／1000 枚、日記第 100 篇、時刻表分類 100 小時）。沒發生的不存在，不存「還差多少」。
-- id＝uuid v5(kind|subject_id|value)，由 TS 算（同 node_time_overrides 慣例，兩台各自蓋＝同一列）。
-- label＝蓋章當時的名字（改名或刪除後章上的字不變）；stamped_on＝事實發生那天（依日界線）。
-- 取消到站＝soft delete；再到站＝同一列復活（deleted_at 清回 NULL、日期換新）。
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵（subject_id 指 nodes 或 time_categories）。
-- 號碼只寫在檔名與 migrations.rs 那一行（施工期暫定號 0016；預定正式號 0017，主對話發；0016 預留給售票口④）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE stamps (
    id           TEXT PRIMARY KEY NOT NULL,             -- uuid v5(STAMP_ID_NAMESPACE, kind|subject_id|value)
    kind         TEXT NOT NULL,                         -- opening／station／route／line／route_year／ledger_year／seals／diary／time_cat
    subject_id   TEXT,                                  -- 車站／路線／幹線的 nodes.id、時刻表分類 id；累計類 NULL
    value        INTEGER,                               -- 100／1000…；沒有就 NULL
    label        TEXT NOT NULL,                         -- 蓋章當時的名字
    stamped_on   TEXT NOT NULL,                         -- 'YYYY-MM-DD' 事實發生那天（依日界線）
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);
CREATE INDEX idx_stamps_stamped_on ON stamps(stamped_on);
