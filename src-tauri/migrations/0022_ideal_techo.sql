-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 車窓・理想手札（2026-11-15，第六本第四梯 v1.30；D-主-560～564）
-- 兩張表：
--   1. ideal_cards：無期限、不打勾的扉頁風景手札卡（三大主題：person 我想成為的人／scenery 理想的生活風景／horizon 遠方的目的地），
--      支援內建車窗線畫插畫（art_preset）與本機自動壓縮輕量相片（photo_data DataURL）雙軌，以及釘選「心之所向」（pinned）。
--   2. ideal_reflections：「車窓の問い」每日零壓力車窗問答紀錄，支援跨時空同題（prompt_key）並排回顧，
--      以及與《旅客筆記・日記》的單筆對應連動（diary_note_id，無外鍵）。
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE ideal_cards (
    id           TEXT PRIMARY KEY NOT NULL,
    theme        TEXT NOT NULL DEFAULT 'person',           -- 'person' | 'scenery' | 'horizon'
    title        TEXT NOT NULL,                            -- 卡片標題
    body         TEXT NOT NULL DEFAULT '',                 -- 散文描繪內文
    motto        TEXT NOT NULL DEFAULT '',                 -- 濃縮的一句「心之所向」題詞（空則釘選時取 title）
    art_preset   TEXT NOT NULL DEFAULT 'sea-station',      -- 內建車窗線畫插畫代號
    photo_data   TEXT,                                     -- 本機自動縮圖壓縮之輕量 DataURL；NULL＝顯示 art_preset 線畫
    pinned       INTEGER NOT NULL DEFAULT 0,               -- 1＝釘選為今日頂端「心之所向」；0＝一般
    position     INTEGER NOT NULL DEFAULT 0,               -- 同主題內排序

    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);

CREATE INDEX idx_ideal_cards_theme ON ideal_cards(theme, position);

CREATE TABLE ideal_reflections (
    id            TEXT PRIMARY KEY NOT NULL,
    prompt_key    TEXT NOT NULL,                           -- 題目穩定識別碼（內建 key 或 'custom:...'）供跨時空同題聚合
    category      TEXT NOT NULL DEFAULT 'daily',           -- 'self' | 'daily' | 'value' | 'journey' | 'custom'
    question      TEXT NOT NULL,                           -- 作答當下的題目文字
    answer        TEXT NOT NULL,                           -- 回答內容
    answered_on   TEXT NOT NULL,                           -- 歸屬日界線日期 'YYYY-MM-DD'
    diary_note_id TEXT,                                    -- 同步寫入《旅客筆記・日記》的 notes.id（→ notes.id，無 FK）
    pinned        INTEGER NOT NULL DEFAULT 0,              -- 1＝釘選為今日頂端「心之所向」；0＝一般

    account_id    TEXT,
    device_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at     TEXT,
    deleted_at    TEXT
);

CREATE INDEX idx_ideal_reflections_prompt ON ideal_reflections(prompt_key, answered_on);
CREATE INDEX idx_ideal_reflections_date ON ideal_reflections(answered_on);
