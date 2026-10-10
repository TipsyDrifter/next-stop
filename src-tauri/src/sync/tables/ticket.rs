// 售票口線的同步表登記檔（並行地基 甲2；契約 §3.1、§13〈新增一張同步表〉）。只有售票口線改這個檔。
// 寫法慣例（`scripts/probes/registry.ts` 靠它對帳）：每一筆 spec 的 `name: "xxx",` 獨佔一行；
// `SETTINGS_KEYS` 維持 `pub const SETTINGS_KEYS: &[&str] = &[ … ];` 這個形狀。
// 新表的 `alive_filter` 一律要填（2026-10-05 拍板；見 `tables/mod.rs` 的 `RowsSpec::alive_filter`）。
use super::SyncTableSpec;
/// 售票口線的同步表。只有售票口線改這個檔。
pub const TABLES: &[SyncTableSpec] = &[];
/// 售票口線要同步的 settings 鍵。
pub const SETTINGS_KEYS: &[&str] = &[];
