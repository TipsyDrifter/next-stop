-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 0003 重複任務引擎（2026-09-11，M3 ④ WP1）
-- occurrences 班次記錄表＋legacy 自由文字規則搬遷。
-- 規格：docs/research/2026-09-11-M3④重複任務引擎-實施計畫草案.md §4
-- 決策：docs/決策記錄.md「④ 重複任務引擎實施計畫拍板」2（D-④-2 兩層分工）
--   nodes.status ＝系列狀態（done＝退役，引擎不再排班）
--   occurrences  ＝班次結果（done／skipped）；済蓋在班次上、跨日自然換一班
-- tauri-plugin-sql 用 sqlx Migrator，只跑 _sqlx_migrations 裡沒有的版本 → 0001／0002 一字不動。
-- ─────────────────────────────────────────────────────────────

-- ─── 班次記錄（一列＝某張定期券的某一班的結局）───
--   status='done'    ＝這班済了；completed_at＝蓋章時刻（UTC ISO）
--   status='skipped' ＝這班運休（氛5：跳過班次、不是第四種 nodes.status）；completed_at 恆 NULL
--   反悔（取消済／取消運休）＝soft delete 這一列，同一班次可以再蓋（所以唯一索引要帶 deleted_at 條件）
CREATE TABLE occurrences (
    id           TEXT PRIMARY KEY NOT NULL,
    node_id      TEXT NOT NULL REFERENCES nodes(id),
    due_on       TEXT NOT NULL,                -- 班次日 YYYY-MM-DD（本地日期，引擎算出來的那一班）
    status       TEXT NOT NULL CHECK (status IN ('done','skipped')),
    completed_at TEXT,                         -- done 的蓋章時刻（UTC ISO）；skipped 為 NULL
    mood         TEXT CHECK (mood IS NULL OR mood IN ('green','yellow','red')),  -- 班次心情（完成卡；鏡射 nodes.mood）

    -- 同步預備（比照 work_logs）
    account_id   TEXT,
    device_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at    TEXT,
    deleted_at   TEXT
);

-- 一張票的同一班次只能有一個存活結局；soft delete 掉的不佔位（部分唯一索引）
CREATE UNIQUE INDEX idx_occ_unique ON occurrences(node_id, due_on) WHERE deleted_at IS NULL;
CREATE INDEX idx_occ_node ON occurrences(node_id);
CREATE INDEX idx_occ_due  ON occurrences(due_on);

-- ─── legacy 自由文字規則搬遷 ───
-- M2／M3③ 期間 repeat_rule 是一個自由文字欄（側板 placeholder「M3 引擎上線前先記錄規則文字」）。
-- ④ 起 repeat_rule ＝ JSON（domain/repeat.ts 的 RepeatRule，一律以 '{' 開頭）。
-- 非 '{' 開頭的舊字串：不丟主人打過的字 → 搬進 description 尾巴，再把欄位清 NULL
-- （否則 fareClass／fareOf 會把那段亂字當成定期券；⑧ 清場後這段自然乾淨）。
UPDATE nodes
SET description = CASE
      WHEN description IS NULL OR description = ''
        THEN '（舊重複規則：' || trim(repeat_rule) || '）'
      ELSE description || char(10) || '（舊重複規則：' || trim(repeat_rule) || '）'
    END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE repeat_rule IS NOT NULL
  AND trim(repeat_rule) != ''
  AND substr(trim(repeat_rule), 1, 1) != '{';

-- 搬完（或本來就只是空白）的一律清掉；JSON 形狀的原封不動留著
UPDATE nodes
SET repeat_rule = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE repeat_rule IS NOT NULL
  AND (trim(repeat_rule) = '' OR substr(trim(repeat_rule), 1, 1) != '{');
