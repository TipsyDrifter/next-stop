-- ─────────────────────────────────────────────────────────────
-- 私鐵手帳 · 0009 車票預定時刻（2026-10-16，主線階段②）
-- 兩個可空欄。決策：docs/主線/決策記錄 主線小車次.md〈車次② 車票預定時刻〉（D-主-10～15、自決 1–4）
-- 契約：docs/research/2026-10-16-主線-車次②預定時刻-契約.md §5.1
-- tauri-plugin-sql 用 sqlx Migrator，只跑 _sqlx_migrations 裡沒有的版本 → 舊 DB 只會跑到這一支。
-- ─────────────────────────────────────────────────────────────

-- 預定時刻（營業日表記 'HH:MM'，小時可 ≥ 24：日界線 06:00 時 '25:00'＝隔天 01:00；存的字就是看到的字）
--   單發票＝這張票的時刻；定期券＝每班的時刻（每一班繼承）；NULL＝不排時刻
--   值域故意不下 CHECK：ADD COLUMN 的 CHECK 不會回頭驗既有列，格式與範圍由 TS 端（lib/date.ts parseClockInput）把關
ALTER TABLE nodes ADD COLUMN scheduled_time TEXT;

-- 定期券的逐班覆寫：JSON {'YYYY-MM-DD': 'HH:MM' | null}（null＝這一班不排時刻）；只有定期券會有值
--   讀寫只經 domain/scheduledTime.ts；寫入時清掉「已過且有結局」的班；整欄 LWW（兩台同時改同一張不同班會互蓋，自決 4 記著）
--   清規則時一併清 NULL；換規則時清掉未來的項；NULL＝沒有任何覆寫
ALTER TABLE nodes ADD COLUMN time_overrides TEXT;
