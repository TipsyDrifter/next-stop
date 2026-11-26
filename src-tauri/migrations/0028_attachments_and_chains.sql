-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 第八本第四梯（v1.39）：跨模組輕量相片附件櫃、時間塊地點與行為鏈（2026-11-26，D-1.36-5）
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵；保持 LF 行尾。
-- ─────────────────────────────────────────────────────────────

-- 4A-1：跨模組按需載入輕量相片附件表（WebP/JPEG DataURL ≤180KB；列表查詢不讀 photo_data，零圖片記憶體負載）
CREATE TABLE attachments (
    id           TEXT PRIMARY KEY NOT NULL,
    entity_type  TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    caption      TEXT NOT NULL DEFAULT '',
    mime         TEXT NOT NULL DEFAULT 'image/webp',
    photo_data   TEXT NOT NULL,
    width        INTEGER,
    height       INTEGER,
    byte_size    INTEGER,
    position     INTEGER NOT NULL DEFAULT 0,

    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);

CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id, position) WHERE deleted_at IS NULL;

-- 4A-2：時刻表時間塊地點標記（選填單行字串，NULL＝未填）
ALTER TABLE time_blocks ADD COLUMN location TEXT;

-- 4B-1：時刻表行為鏈（計時模板）表
CREATE TABLE time_chains (
    id           TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    steps        TEXT NOT NULL DEFAULT '[]',
    position     INTEGER NOT NULL DEFAULT 0,
    archived_at  TEXT,

    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);

CREATE INDEX idx_time_chains_pos ON time_chains(position) WHERE deleted_at IS NULL;
