-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 時刻表 ⑦ 作息範本與多時段（2026-11-01，車次⑦；契約席立）
-- 一欄兩表：time_blocks.note（一句備註）／time_routines（作息範本）／time_plans（某一天的預定：作息落地的段＋車票第二段起）。
-- 規格：docs/research/2026-11-01-時刻表⑦-契約.md §2
-- 決策：決策記錄 時刻表 D-時-156（範本照週幾自動帶）、D-時-158（車票多時段只在日程）、D-時-160（落地規則）、D-時-163（備註）、D-時-167（段的名字）
-- 範本的段放 JSON（整份一邊贏，同整組寫 position 的取捨）；落到某一天的預定一段一列（逐欄 LWW，#86 的教訓）。
-- time_plans 的 id：作息落地＝uuid v5(day|routine_id|序號)，由 TS 算（兩台同一天各自落地＝同一批列）；手動加的段＝隨機 uuid。
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵（category_id／node_id／routine_id 同 time_blocks.node_id 的慣例）。
-- 號碼只寫在檔名與 migrations.rs 那一行（正式號 0015，主對話 11-01 發；施工期暫用過 0014）。
-- ─────────────────────────────────────────────────────────────

ALTER TABLE time_blocks ADD COLUMN note TEXT;            -- 一句備註；NULL＝沒寫

CREATE TABLE time_routines (
    id           TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    items        TEXT NOT NULL DEFAULT '{"v":1,"items":[]}', -- JSON：{"v":1,"items":[{"cat":"<子分類 id>","s":"HH:MM","e":"HH:MM","n":"名字"}]}，營業日表記（小時可 ≥24）；n 選填（沒填＝分類名）
    weekdays     INTEGER NOT NULL DEFAULT 0,              -- 位元：bit0＝週一 … bit6＝週日；0＝不自動帶
    position     INTEGER NOT NULL DEFAULT 0,
    archived_at  TEXT,

    -- 同步預備（比照 time_goals）
    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);

CREATE INDEX idx_tr_alive ON time_routines(position) WHERE deleted_at IS NULL;

CREATE TABLE time_plans (
    id           TEXT PRIMARY KEY NOT NULL,
    day          TEXT NOT NULL,                           -- 'YYYY-MM-DD'（日界線日）
    start_hm     TEXT NOT NULL,                           -- 'HH:MM' 營業日表記（小時可 ≥24）
    end_hm       TEXT NOT NULL,                           -- 'HH:MM' 營業日表記
    category_id  TEXT,                                    -- 作息段：分類（→ time_categories.id，無 FK）；車票段：NULL
    node_id      TEXT,                                    -- 車票段：車票（→ nodes.id，無 FK）；作息段：NULL
    routine_id   TEXT,                                    -- 從哪套範本落地（→ time_routines.id，無 FK）；手動加的段＝NULL
    label        TEXT,                                    -- 作息段的名字（早餐／午餐／晚餐都是「用餐」時分得開；D-時-167）；NULL＝用分類名

    -- 同步預備（比照 time_goals）
    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT                                     -- 刪這段／這天不套＝soft delete（標記留著，同一天不會再落地）
);

CREATE INDEX idx_tp_day  ON time_plans(day);
CREATE INDEX idx_tp_node ON time_plans(node_id);
