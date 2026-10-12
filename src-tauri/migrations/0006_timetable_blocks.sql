-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 0005 時刻表（2026-10-06，車次①a；契約席立）
-- 兩張表：time_categories（時間分類，兩層）／time_blocks（時間塊）。
-- 規格：docs/research/2026-10-06-時刻表-車次①a計時發車台軸-契約.md §3
-- 決策：決策記錄 時刻表 D-時-2／10／12／16；Plan 第五節技術底線 1、3、4
-- 鐵則：純 DDL、不生資料列。起手分類由 App 經 repository 寫入（會進 oplog；契約 0-3），不在這裡 INSERT。
-- 不在資料庫層強制「只能有一筆運行中」：同步套用別台變更時會暫時出現兩筆，由 App 的整理收掉（契約 §4.4）。
-- 不對 color_idx／default_min 加 CHECK：遠端 op 違反 CHECK 會讓整個同步物件的交易失敗（契約 0-9）。
-- node_id／route_id 不設外鍵：車次②才有 UI；節點不在＝「原節點已刪除」的顯示狀態，不是錯誤。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE time_categories (
    id           TEXT PRIMARY KEY NOT NULL,
    parent_id    TEXT REFERENCES time_categories(id),     -- NULL＝頂層組；兩層（①a 只有組→分類）
    name         TEXT NOT NULL,
    glyph        TEXT,                                    -- 圓牌一個字；頂層組可空
    color_idx    INTEGER NOT NULL DEFAULT 1,              -- 色盤序號 1–8（各主題各一組，契約 §5.6 §A）
    position     INTEGER NOT NULL DEFAULT 0,              -- 同一層內的順序
    default_min  INTEGER,                                 -- 預設長度（分）＝「長時間運行」門檻；NULL＝用全域保險上限
    archived_at  TEXT,                                    -- 封存（①b 才有 UI）

    -- 同步預備（比照 occurrences）
    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);

CREATE INDEX idx_tc_parent ON time_categories(parent_id);

CREATE TABLE time_blocks (
    id            TEXT PRIMARY KEY NOT NULL,
    category_id   TEXT NOT NULL REFERENCES time_categories(id),
    started_at    TEXT NOT NULL,                          -- UTC ISO（toISOString 24 字元）
    ended_at      TEXT,                                   -- NULL＝運行中
    estimate_min  INTEGER,                                -- 這一班的預估（①b 才有 UI）
    node_id       TEXT,                                   -- 連到的任務節點（車次②）
    route_id      TEXT,                                   -- 只連路線時用（車次②；有 node_id 時不存，由節點推導）
    long_run_ack  INTEGER NOT NULL DEFAULT 0 CHECK (long_run_ack IN (0,1)),  -- 1＝主人回答過「其實到幾點」或按了「別問了」

    -- 同步預備（比照 occurrences）
    account_id    TEXT,
    device_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at     TEXT,
    deleted_at    TEXT
);

CREATE INDEX idx_tb_started  ON time_blocks(started_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_tb_running  ON time_blocks(ended_at)   WHERE deleted_at IS NULL AND ended_at IS NULL;
CREATE INDEX idx_tb_category ON time_blocks(category_id);
CREATE INDEX idx_tb_node     ON time_blocks(node_id);
