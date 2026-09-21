-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · v2 baseline schema（2026-08-20，M2 鋪軌）
-- 彈性樹單表 nodes（kind 分身分）＋ work_logs（工作日誌）＋ settings（鍵值）
-- 規格：docs/產品規格書.md §5／§8；決策：docs/決策記錄.md M2 段
-- ─────────────────────────────────────────────────────────────
-- 同步預備（決策 #20）：UUID 主鍵、account_id／device_id 預留、
-- created_at／updated_at／synced_at／deleted_at 全 UTC ISO 8601，deleted_at＝soft delete
-- DB 檔改名 next-stop-v2.db：v0.1 的 next-stop.db 原地保留不讀（另有 .bak 備份）
-- ─────────────────────────────────────────────────────────────

PRAGMA foreign_keys = ON;

-- ─── 節點（幹線／路線／支線／列車／車廂／車票／車站 共用一表）───
CREATE TABLE nodes (
    id             TEXT PRIMARY KEY NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('line','route','branch','train','car','ticket','station')),
    parent_id      TEXT REFERENCES nodes(id),
    line_id        TEXT REFERENCES nodes(id),   -- 所屬幹線（快取）；幹線本身 NULL；臨時車票可 NULL
    route_id       TEXT REFERENCES nodes(id),   -- 所屬路線（快取）；幹線／路線本身 NULL；臨時車票＝路線標籤（可 NULL）
    name           TEXT NOT NULL,
    description    TEXT,
    position       INTEGER NOT NULL DEFAULT 0,  -- 兄弟間排序

    -- 路線外觀
    color          TEXT,
    code           TEXT,                        -- 路線代碼（選填）

    -- 任務欄位（train／car；ticket 只用 status／scheduled_on／completed_at）
    status         TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','paused')),
    scheduled_on   TEXT,                        -- 執行日 YYYY-MM-DD（本地日期）
    due_on         TEXT,                        -- 截止日 YYYY-MM-DD
    priority       TEXT NOT NULL DEFAULT 'mid' CHECK (priority IN ('low','mid','high')),
    estimate_min   INTEGER,                     -- 預計時間（分）
    progress       INTEGER CHECK (progress IS NULL OR progress BETWEEN 0 AND 100), -- 無子項時的手動進度
    time_spent_min INTEGER,                     -- 花費時間（分，輕量手動；M5 後綁時間塊）
    mood           TEXT CHECK (mood IS NULL OR mood IN ('green','yellow','red')),
    repeat_rule    TEXT,                        -- JSON；M2 預留欄位、M3 引擎
    completed_at   TEXT,

    -- 車站欄位
    expected_on    TEXT,                        -- 預定到站日
    arrived_on     TEXT,                        -- 實際到站日

    -- 同步預備
    account_id     TEXT,
    device_id      TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at      TEXT,
    deleted_at     TEXT
);

CREATE INDEX idx_nodes_parent    ON nodes(parent_id);
CREATE INDEX idx_nodes_line      ON nodes(line_id);
CREATE INDEX idx_nodes_route     ON nodes(route_id);
CREATE INDEX idx_nodes_kind      ON nodes(kind);
CREATE INDEX idx_nodes_scheduled ON nodes(scheduled_on);
CREATE INDEX idx_nodes_due       ON nodes(due_on);
CREATE INDEX idx_nodes_alive     ON nodes(deleted_at) WHERE deleted_at IS NULL;

-- ─── 工作日誌（每次做完隨手記一句，累積成任務歷史軌跡）───
CREATE TABLE work_logs (
    id          TEXT PRIMARY KEY NOT NULL,
    node_id     TEXT NOT NULL REFERENCES nodes(id),
    body        TEXT NOT NULL,
    logged_at   TEXT NOT NULL,

    account_id  TEXT,
    device_id   TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at   TEXT,
    deleted_at  TEXT
);

CREATE INDEX idx_work_logs_node ON work_logs(node_id);

-- ─── 設定（主題、日界線……）───
CREATE TABLE settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
