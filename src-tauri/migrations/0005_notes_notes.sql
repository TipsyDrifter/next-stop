-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 0005 旅客筆記（2026-10-06，車次①；契約席立）
-- 一張表 notes：kind='note'（捕捉、收件匣、筆記）；kind='diary'（車次②）欄位現在就建好。
-- 規格：docs/research/2026-10-06-旅客筆記-車次①捕捉收件匣筆記-契約.md §3
-- 決策：決策記錄 旅客筆記 D-筆-1／5／6／17／18；Plan 第三節
-- 鐵則：純 DDL、不生資料列。node_id 指向 nodes(id) 但**不設外鍵**（孤兒＝「原節點已刪除」的顯示狀態，不是錯誤）。
-- 不存 route_id 快取（依路線篩選用 JOIN nodes 推導；契約 0-5）。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE notes (
    id          TEXT PRIMARY KEY NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('note','diary')),
    title       TEXT,                                   -- 選填；NULL／空字串＝列表顯示內文第一行（D-筆-1）
    body        TEXT NOT NULL DEFAULT '',               -- 純文字（Markdown 排版在車次④）
    entry_date  TEXT,                                   -- 日記所屬日 YYYY-MM-DD（車次②）；筆記恆 NULL
    noted_at    TEXT NOT NULL,                          -- 顯示與排序用時刻（UTC ISO）；預設＝建立當下，可改（補記）
    node_id     TEXT,                                   -- 掛在樹上的節點（路線／支線／列車／車廂）；日記恆 NULL；無 FK
    inbox       INTEGER NOT NULL DEFAULT 0 CHECK (inbox IN (0,1)),  -- 1＝未整理（收件匣）
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at  TEXT                                    -- soft delete
);

CREATE INDEX idx_notes_alive_kind_inbox ON notes(kind, inbox) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_noted            ON notes(noted_at);
CREATE INDEX idx_notes_node             ON notes(node_id);
CREATE INDEX idx_notes_entry            ON notes(entry_date);
