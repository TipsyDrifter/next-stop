-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 第八本第三梯（v1.38）：售票口黃金雙欄、手續費、刷卡分期與信用卡帳單週期（2026-11-25，D-1.36-5）
-- 鐵則：只 DDL、不種資料；不加 CHECK；不設外鍵；保持 LF 行尾。
-- ─────────────────────────────────────────────────────────────

-- 3A：品項／來源主欄（保留可 NULL 作為 v1.37 存量未搬移哨兵，v1.38 新寫入恆為非 NULL 字串）
ALTER TABLE tk_entries ADD COLUMN item TEXT;
ALTER TABLE tk_repeats ADD COLUMN item TEXT;
ALTER TABLE tk_templates ADD COLUMN item TEXT;

-- 3B-1：手續費獨立欄（帳戶幣別最小單位與當下折算主幣別；NULL 或 0＝無手續費）
ALTER TABLE tk_entries ADD COLUMN fee_minor INTEGER;
ALTER TABLE tk_entries ADD COLUMN fee_main_minor INTEGER;
ALTER TABLE tk_repeats ADD COLUMN fee_minor INTEGER;
ALTER TABLE tk_templates ADD COLUMN fee_minor INTEGER;

-- 3B-2：刷卡分期群組欄（同組共享 installment_group_id，第 installment_index / installment_total 期）
ALTER TABLE tk_entries ADD COLUMN installment_group_id TEXT;
ALTER TABLE tk_entries ADD COLUMN installment_index INTEGER;
ALTER TABLE tk_entries ADD COLUMN installment_total INTEGER;
CREATE INDEX idx_tke_inst_group ON tk_entries(installment_group_id) WHERE installment_group_id IS NOT NULL;

-- 3B-3：信用卡帳單週期與預設扣款帳戶（不設外鍵，讀時驗證存活）
ALTER TABLE tk_accounts ADD COLUMN statement_day INTEGER;
ALTER TABLE tk_accounts ADD COLUMN payment_due_day INTEGER;
ALTER TABLE tk_accounts ADD COLUMN auto_pay_account_id TEXT;
