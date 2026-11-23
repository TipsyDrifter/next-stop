-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 第四梯（討論 6）：期間自由券與預留席車票（2026-11-20，D-FB-7）
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵；保持 LF 行尾。
-- ─────────────────────────────────────────────────────────────

ALTER TABLE nodes ADD COLUMN scheduled_end TEXT;
ALTER TABLE nodes ADD COLUMN is_placeholder INTEGER;
