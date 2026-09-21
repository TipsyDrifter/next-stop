-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 0004 同步地基（2026-09-18，v1.1.1 WP5／WP7 共用；契約席立）
-- 三張純機制表：sync_meta（裝置身分與游標）／sync_outbox（待上傳 op 佇列）／sync_cells（欄位級 LWW 的 hlc）。
-- 規格：docs/research/2026-09-18-v1.1.1-同步地基契約.md §2
-- 決策：docs/決策記錄.md〈v1.1 Plan 草案拍板〉D-1.1-3（只搬主人資料）／D-1.1-5（欄位級 LWW＋HLC）
--
-- 鐵則（U8 紀律）：**不生任何資料列**——這支只建表與索引，一筆 INSERT 都沒有。
--   device_id 由 Rust `sync_status()` 首次呼叫時 INSERT OR IGNORE；enabled 沒有列＝視同 '0'。
--   所以桌機升上來、同步總開關沒開之前，三張表全空，既有路徑行為零改變。
--
-- occurrences.id 自本版起改「確定性」（uuid v5 of `node_id|due_on`，namespace 固定，見契約 §2.4）：
--   **只影響新列**；既有的隨機 id 列原封不動（部分唯一索引 idx_occ_unique 已保證同班只一列存活）。
--   不做搬遷——搬 id 要連動 sync_cells／oplog，且沒有任何讀取路徑依賴 id 的形狀。
--
-- tauri-plugin-sql 用 sqlx Migrator：0001–0003 一字不動，本支跑過之後內容也不能再改（改了舊 DB 啟動失敗）。
-- ─────────────────────────────────────────────────────────────

-- ─── 同步中繼資料（key／value；鍵清單見契約 §8）───
--   device_id／role／epoch／salt／primary_device_id／enabled／schema_gate／
--   last_push_hlc／last_pull_key／last_sync_at／last_error
CREATE TABLE sync_meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

-- ─── 待上傳 op 佇列（本機每一次「主人資料」寫入＝一列；push 成功後刪）───
--   hlc     ＝ `<13位毫秒><4位十六進位計數>-<device_id 前 8 碼>`，可字典序比較（契約 §3）
--   tbl     ＝ 'nodes'|'work_logs'|'occurrences'|'settings'
--   row_id  ＝ 該表主鍵（settings 用 key）
--   op      ＝ 'upsert'|'delete'（delete 的 payload 仍是 {deleted_at:…}；op 只是標籤，套用規則同一條）
--   payload ＝ JSON 物件 {col: value}，只含「主人資料」欄（白名單見契約 §7.4）
CREATE TABLE sync_outbox (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    hlc        TEXT NOT NULL,
    tbl        TEXT NOT NULL,
    row_id     TEXT NOT NULL,
    op         TEXT NOT NULL CHECK (op IN ('upsert','delete')),
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_sync_outbox_hlc ON sync_outbox(hlc);

-- ─── 欄位級 LWW：每列每欄最後採用的 hlc（同 hlc 以 device_id 決勝＝hlc 字串本身已含 device 尾碼）───
--   本機寫入時就戳（TS 批次內同一交易）；套用遠端 op 時逐欄比較、較新才寫（契約 §7）。
CREATE TABLE sync_cells (
    tbl       TEXT NOT NULL,
    row_id    TEXT NOT NULL,
    col       TEXT NOT NULL,
    hlc       TEXT NOT NULL,
    device_id TEXT NOT NULL,
    PRIMARY KEY (tbl, row_id, col)
) WITHOUT ROWID;
