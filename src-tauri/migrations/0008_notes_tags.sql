-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 旅客筆記・荷札（2026-10-12，車次③；契約席立）
-- 兩張表：tags（荷札；id 由 name_key 決定性算出）／taggings（掛載；id 由 (entity_type, entity_id, tag_id) 決定性算出）。
-- 規格：docs/research/2026-10-12-旅客筆記-車次③荷札-契約.md §3
-- 決策：決策記錄 旅客筆記 D-筆-7／19／37～44；Plan 第三節 tags／taggings
-- 鐵則：純 DDL、不生資料列。通車補掛由前端首次進頁做（契約 0-9）。
-- 不設外鍵（taggings.tag_id→tags、entity_id→nodes/notes）：孤兒＝顯示狀態，不是錯誤；不設 UNIQUE／CHECK（遠端 op 違反會讓整個同步物件的交易失敗，契約 0-11）。
-- 巢狀只靠 name 裡的 `/`，不存 parent 欄；虛資料夾不入表。
-- 號碼只寫在檔名與 migrations.rs 那一行（施工期暫定號；正式號進月台時改那兩處，本檔內容不動。契約 0-1／2026-10-13 增補）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE tags (
    id          TEXT PRIMARY KEY NOT NULL,              -- uuid v5(TAG_ID_NAMESPACE, name_key)
    name        TEXT NOT NULL,                          -- 顯示用全路徑（保留大小寫），例「難度/高」；不含 #
    name_key    TEXT NOT NULL,                          -- 正規化後的全路徑（trim、NFKC、英文小寫、各段去頭尾空白）
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at  TEXT                                    -- soft delete；掛上一個已刪除的名稱＝復活（清掉）
);
CREATE INDEX idx_tags_key   ON tags(name_key);
CREATE INDEX idx_tags_alive ON tags(name_key) WHERE deleted_at IS NULL;

CREATE TABLE taggings (
    id           TEXT PRIMARY KEY NOT NULL,             -- uuid v5(TAGGING_ID_NAMESPACE, entity_type || '|' || entity_id || '|' || tag_id)
    entity_type  TEXT NOT NULL,                         -- 本線 'node'／'note'；別線 '<頁面id>:<自訂>'（不可用裸 'ticket'）
    entity_id    TEXT NOT NULL,                         -- 被掛的那一列的 id（node＝nodes.id 只接受 ticket/train/car；note＝notes.id，含日記）
    tag_id       TEXT NOT NULL,                         -- → tags.id（無 FK）
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at   TEXT                                   -- 摘掉＝soft delete；再掛＝清掉
);
CREATE INDEX idx_taggings_entity ON taggings(entity_type, entity_id);
CREATE INDEX idx_taggings_tag    ON taggings(tag_id);
