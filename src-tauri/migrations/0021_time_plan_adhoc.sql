-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 第六本第三梯（v1.29）：臨時班次／主題預留時段（2026-11-10，D-時-190）
-- time_plans 除作息落地段（kind IS NULL AND node_id IS NULL）與車票第二段起（kind IS NULL AND node_id IS NOT NULL）外，
-- 新增 kind = 'adhoc' 的臨時班次／主題預留時段：可選綁定路線（route_id）或支線（node_id）、時間分類（category_id）與臨時標題（label）。
-- 鐵則：只 DDL、不種資料；不設外鍵。
-- ─────────────────────────────────────────────────────────────

ALTER TABLE time_plans ADD COLUMN kind TEXT;              -- NULL＝作息段／車票分段；'adhoc'＝臨時班次／主題預留時段
ALTER TABLE time_plans ADD COLUMN route_id TEXT;          -- → routes.id（無 FK）；臨時班次綁定路線（綁支線時一併填所屬路線）
