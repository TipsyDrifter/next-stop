-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 第四梯（討論 6）：逐班填空與待辦入座頂替（2026-11-20，D-FB-7）
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵；保持 LF 行尾。
-- ─────────────────────────────────────────────────────────────

ALTER TABLE node_time_overrides ADD COLUMN custom_title TEXT;
ALTER TABLE node_time_overrides ADD COLUMN seated_node_id TEXT;
