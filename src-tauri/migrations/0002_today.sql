-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 0002 今日視圖（2026-09-05，M3 ③ WP1）
-- 三個欄位＋既有節點的発券回填。規格：docs/research/2026-09-05-M3③今日視圖-實施計畫草案.md §4
-- 決策：docs/決策記錄.md「③ 今日視圖實施計畫拍板」1（D-③-5 乙：乘務記錄加系統事件）
-- tauri-plugin-sql 用 sqlx Migrator，只跑 _sqlx_migrations 裡沒有的版本 → 舊 DB 只會跑到這一支。
-- ─────────────────────────────────────────────────────────────

-- 今日序（今日視圖的手動序，與大綱的 position 分開存；盲探 丙-2「今日序另存」）
--   NULL＝這張票還沒進過今日；首次聚合進今日時 lazy 指派 max+1（listToday 內）
--   推遲到未來日／清除執行日時清回 NULL＝下次進來算新聚合、尾插（r7）
ALTER TABLE nodes ADD COLUMN today_position INTEGER;

-- 繰越（原執行日 YYYY-MM-DD）：繰越角印「自 M/D 繰越」的資料來源（盲探 丙-6）
--   只在「推遲」動線（scheduled_on 從今天或過去 → 未來日）寫入；再次改期覆寫、完成保留
ALTER TABLE nodes ADD COLUMN carried_from TEXT;

-- 乘務記錄的系統事件（D-③-5 乙）：'issued'＝発券（建票）／'punched'＝入鋏（首次進 doing）／'done'＝済（完成）
--   NULL＝主人手記（M2 既有列全部是 NULL）；事件列 body 一律空字串
--   值域故意不下 CHECK：ADD COLUMN 的 CHECK 不會回頭驗既有列，語義由 TS 端（domain/node.ts WorkLogEvent）把關
ALTER TABLE work_logs ADD COLUMN event TEXT;

CREATE INDEX idx_nodes_today      ON nodes(today_position) WHERE today_position IS NOT NULL;
CREATE INDEX idx_work_logs_event  ON work_logs(node_id, event);

-- 回填：既有未刪除節點各補一枚発券，時刻＝該節點的 created_at、內文空
-- （⑧ 清場後這批自然消失；id 用 SQLite 的 randomblob 湊 UUID v4 字面，與 crypto.randomUUID() 同形）
INSERT INTO work_logs (id, node_id, body, logged_at, event, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  n.id, '', n.created_at, 'issued', n.created_at, n.created_at
FROM nodes n
WHERE n.deleted_at IS NULL;
