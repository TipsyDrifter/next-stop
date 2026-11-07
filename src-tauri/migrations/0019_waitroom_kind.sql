-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 候車室・種類表與實現去向（2026-11-06，壬 候車室；D-主-519～521）
-- 願望清單升級成全 App 的候車室：既有 tk_wishes 就地升級、不搬表——既有列自動掛到「買」，一筆不搬。
-- wr_kinds＝種類（番線）：可增刪改名排序；action＝實現時做什麼（entry 記一筆／ticket 開票／route 開路線／
--   diary 寫日記／time 記時間）。起手五列（買／做／去／讀看／學）**由 App 經 repository 依固定 id 補種**
--   （會進 oplog；同 0006 的起手分類與 0-17 前例，不在這裡 INSERT）；固定 id 在 src/domain/ticket.ts 的
--   WR_KIND_SEEDS，kind_id 的 DEFAULT＝「買」那列的 id，逐字相同。
-- 實現「了沒」照 0016 的 entry_id 前例讀時判斷、不另存狀態：
--   action=entry 看 entry_id 指到的帳還在；其他看 target_kind（node／note／block）＋target_id 指到的記錄還在。
-- bought_at 沿用當「實現時刻」（欄名不改；顯示層翻譯）。
-- 鐵則：純 DDL、不生資料列、不加 CHECK（同 0004、0006、0016）。kind_id／target_id 不設外鍵（同 entry_id）。
-- 號碼只寫在檔名與 migrations.rs 那一行；正式號由主對話進驗收時發（改那兩處，本檔內容不動）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE wr_kinds (
    id            TEXT PRIMARY KEY NOT NULL,              -- uuid()；起手五列＝固定 id
    name          TEXT NOT NULL,                          -- 種類名（買／做／去／讀看／學…可改）
    action        TEXT NOT NULL DEFAULT 'ticket',         -- 實現動作：entry／ticket／route／diary／time
    position      INTEGER NOT NULL DEFAULT 0,             -- 順序＝番線號（1 起算顯示）

    device_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at     TEXT,
    deleted_at    TEXT
);

ALTER TABLE tk_wishes ADD COLUMN kind_id TEXT NOT NULL DEFAULT '5b1a6c3e-0f44-5a7a-9d2b-8e6f1c0a2b31';
ALTER TABLE tk_wishes ADD COLUMN target_kind TEXT;       -- node／note／block（entry 走既有 entry_id）
ALTER TABLE tk_wishes ADD COLUMN target_id TEXT;

CREATE INDEX idx_tkw_kind   ON tk_wishes(kind_id);
CREATE INDEX idx_tkw_target ON tk_wishes(target_id);
