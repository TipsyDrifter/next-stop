-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 回饋乙：nodes 兄弟順序改排序鍵（fractional index）（2026-11-01，D-主-151；結接縫 #108／點子 #119）
-- 契約：docs/research/2026-11-01-回饋乙-契約.md §6（案 A：新增欄，舊欄原地保留）
-- 搬一列只寫被搬那一列的 sort_key（鍵算在上下鄰居之間，演算法 src/domain/fracIndex.ts），兩台各搬各的列互不覆蓋。
-- 舊欄 nodes.position 原地保留：新建時仍給 MAX+1（票號同毫秒決勝吃它），搬移不再改它；舊版物件的整數寫入照套到舊欄。
-- 存量回填＝App 啟動後由 TS 照畫面上的順序冪等補鍵並入列（同 0012 的做法；鍵在 SQL 裡算不了）。
-- 鐵則：只 DDL、不種資料；不加 CHECK（同 0009）；號碼只寫在檔名與 migrations.rs 那一行（施工期暫定號 0014，進驗收時由主對話發正式號）。
-- ─────────────────────────────────────────────────────────────

-- 排序鍵（base62、照位元組序比：SQLite 預設 BINARY 與 JS 的 `<` 一致；不能用 localeCompare）
--   NULL＝還沒給鍵（舊版建的列、收件匣不排序的臨時車票）：顯示時排在有鍵的後面，照 position→created_at→id
ALTER TABLE nodes ADD COLUMN sort_key TEXT;

CREATE INDEX IF NOT EXISTS idx_nodes_sort ON nodes(parent_id, sort_key);
