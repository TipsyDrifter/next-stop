//! 同步表登記表（並行地基 甲2；契約 `docs/research/2026-09-29-並行地基-契約.md` §3）。
//!
//! 「每張同步表都要加一筆」的清單型設定全部收在這裡：欄白名單、必填、主鍵、補戳 filter、快照查詢、
//! 匯出排序、外鍵檢查、清空／灌表順序、衝突掛點、「這台有沒有資料」。engine／snapshot／backup 一律查表，
//! 不再各自寫死表名。**既有表專屬的分支不收**（`apply_object` 裡 settings 的 upsert、work_logs 的遠端
//! 競合過濾、nodes 的快取重算）——新表不會去改它們（契約決策 2）。
//!
//! 檔案分工：`core.rs`＝既有四張表（值從 engine 逐字搬）；`notes.rs`／`timetable.rs`／`ticket.rs`＝三條線
//! 各自的登記檔，**只有那條線改自己的檔**，這支 `mod.rs` 與 `core.rs` 三線都不必碰。
//!
//! 順序固定：core → notes → timetable → ticket。Rows 表的登記順序＝父先子後（灌表、補戳、快照、匯出、
//! 外鍵檢查都用它）；反序＝子先父後（清空、匯入前刪表）。

pub mod core;
pub mod notes;
pub mod ticket;
pub mod timetable;

use std::sync::OnceLock;

/// 欄白名單一欄：(欄名, 是不是整數欄)——與 `engine::columns_of` 的回傳元素同形
pub type ColSpec = (&'static str, bool);

/// 快照進 outbox 時怎麼撈這張表
pub enum OutboxQuery {
    /// 組成 `SELECT * FROM {name}{filter} ORDER BY {order_by}`。
    /// `filter` **含前導空白**（例 `" WHERE …"`），空字串＝不過濾。
    Plain {
        order_by: &'static str,
        filter: &'static str,
    },
    /// 整句自帶（nodes 的遞迴 CTE）
    Custom(&'static str),
}

/// 競合日誌要掛在哪個節點上
pub enum ConflictAnchor {
    /// 這一列自己就是節點（nodes）
    SelfId,
    /// 取這一欄的值當節點 id（work_logs／occurrences 的 `node_id`）：先看本機現有列、再看 op 帶來的值
    Column(&'static str),
    /// 不記競合日誌（三線新表的預設）
    None,
}

/// 快照進 outbox 前，對單一列的 cols 做修正（nodes：非根層臨時車票要拿掉 `route_id`）
pub type OutboxRowFix = fn(
    &sqlx::sqlite::SqliteRow,
    &mut serde_json::Map<String, serde_json::Value>,
) -> Result<(), String>;

/// 「整張表每一列都同步」的表才有的設定
pub struct RowsSpec {
    /// `stamp_missing_cells` 的 WHERE 子句（別名固定：資料表 `n`、欄清單 `c`；**不含**前導空白）；空字串＝不過濾
    pub stamp_filter: &'static str,
    pub outbox: OutboxQuery,
    pub outbox_row_fix: Option<OutboxRowFix>,
    /// `build_full_json` 的 ORDER BY 欄
    pub full_json_order: &'static str,
    /// 進不進 `prune_fk_violations`／`prune_orphans` 的檢查清單
    pub fk_checked: bool,
    pub conflict_anchor: ConflictAnchor,
    /// 「這台有沒有資料」（`local_alive_count`）要不要算這張表：`Some(條件)`＝算（`SELECT COUNT(*) … WHERE {條件}`
    /// 加進總數）、`None`＝不算。
    ///
    /// **規則（2026-10-05 主人拍板：新功能的資料算進「這台有沒有資料」）**：新同步表一律填，通常是未刪除的條件
    /// `Some("deleted_at IS NULL")`。判斷不該算的，要在該車次的契約寫明理由並報調度——填 `None` 的表，
    /// 在一台「只有這張表有資料」的裝置上加入同步時會被當成空的，可能直接採用雲端那一份而清掉本機資料。
    /// 既有的 work_logs／occurrences 是 `None`：它們掛在車票底下，沒有車票就不會有它們（v1.1 起的行為，不改）。
    pub alive_filter: Option<&'static str>,
    /// 建立這張表的 migration 的 key（`crate::migrations::MigrationDef::key`，例 `"notes_tags"`）；
    /// None＝從 schema 1 就有。用途：匯入比它舊的快照時，這張表的陣列可以不存在。
    pub since: Option<&'static str>,
}

pub enum Kind {
    Rows(RowsSpec),
    /// 鍵值表、只同步白名單鍵（目前只有 settings）
    KeyValue,
}

pub struct SyncTableSpec {
    pub name: &'static str,
    /// 主鍵欄名（settings＝"key"，其餘＝"id"）
    pub pk: &'static str,
    pub columns: &'static [ColSpec],
    /// INSERT 時非有不可的欄（NOT NULL 且沒有 DEFAULT）
    pub required: &'static [&'static str],
    pub kind: Kind,
}

/// 登記表。生產路徑一律用 `Registry::production()`；測試可用 `core_only`（只含核心）或 `with_extra`（核心＋假表，
/// 契約 §11 T-甲10）。
pub struct Registry {
    tables: Vec<&'static SyncTableSpec>,
    settings_keys: Vec<&'static str>,
}

impl Registry {
    fn build(groups: &[(&'static [SyncTableSpec], &'static [&'static str])]) -> Registry {
        let mut tables = Vec::new();
        let mut settings_keys = Vec::new();
        for (ts, ks) in groups {
            tables.extend(ts.iter());
            settings_keys.extend(ks.iter().copied());
        }
        Registry {
            tables,
            settings_keys,
        }
    }

    fn production_groups() -> [(&'static [SyncTableSpec], &'static [&'static str]); 5] {
        [
            (core::TABLES, core::SETTINGS_KEYS),
            // 逐班時刻覆寫（0012）另立一組：core::TABLES 是 G0 金樣鎖住的核心四張，
            // 新表不進 core_only 的臨時庫，金樣零接觸（D-主-120）。probe 照 name: 出現順序對帳，所以緊接在 core 之後。
            (core::TIME_OVERRIDE_TABLES, &[]),
            (notes::TABLES, notes::SETTINGS_KEYS),
            (timetable::TABLES, timetable::SETTINGS_KEYS),
            (ticket::TABLES, ticket::SETTINGS_KEYS),
        ]
    }

    /// 順序固定：core（nodes, work_logs, occurrences, settings）→ node_time_overrides → notes → timetable → ticket。建一次。
    pub fn production() -> &'static Registry {
        static REG: OnceLock<Registry> = OnceLock::new();
        REG.get_or_init(|| Registry::build(&Registry::production_groups()))
    }

    pub fn find(&self, name: &str) -> Option<&'static SyncTableSpec> {
        self.tables.iter().copied().find(|t| t.name == name)
    }

    /// Kind::Rows 的表，登記順序＝父先子後
    pub fn rows(&self) -> impl DoubleEndedIterator<Item = (&'static SyncTableSpec, &'static RowsSpec)> + '_ {
        self.tables.iter().copied().filter_map(|t| match &t.kind {
            Kind::Rows(r) => Some((t, r)),
            Kind::KeyValue => None,
        })
    }

    /// `rows()` 的反序＝子先父後（清空、匯入前刪表）
    pub fn rows_rev(&self) -> impl Iterator<Item = (&'static SyncTableSpec, &'static RowsSpec)> + '_ {
        self.rows().rev()
    }

    /// settings 白名單鍵：core → notes → timetable → ticket
    pub fn settings_keys(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.settings_keys.iter().copied()
    }

    /// 只含核心四張表（`core.rs`）的登記表。**只給測試用**：核心同步行為的回歸測試（`foundation_golden.rs`／
    /// `foundation_checks.rs`）的臨時庫只跑已發行的前四支 migration，三線之後登記的表在那顆庫裡不存在；
    /// 用這份登記表，三線加表時那組測試不受影響。
    #[cfg(test)]
    pub fn core_only() -> &'static Registry {
        static REG: OnceLock<Registry> = OnceLock::new();
        REG.get_or_init(|| Registry::build(&[(core::TABLES, core::SETTINGS_KEYS)]))
    }

    /// 核心登記表之後再接一組（測試用：假表 `zz_probe` 走一遍）。接在 `core_only` 而不是生產登記表後面，
    /// 理由同 `core_only`。
    #[cfg(test)]
    pub fn with_extra(extra: &'static [SyncTableSpec], keys: &'static [&'static str]) -> Registry {
        Registry::build(&[(core::TABLES, core::SETTINGS_KEYS), (extra, keys)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 核心四張表的內容寫死；生產登記表＝core → notes → timetable → ticket 依序串接。
    /// 修正席（評審發現 1）：原本斷言生產登記表「正好四張表、一把鍵」，三線照 §13 在自己的登記檔加一筆就會紅在
    /// 這支「三線不必碰」的檔上；改成核心寫死＋生產表是四組的串接（地基現況三線皆空 ⇒ 斷言內容與原本相同）。
    #[test]
    fn 生產登記表的順序與內容() {
        let core_names: Vec<&str> = core::TABLES.iter().map(|t| t.name).collect();
        assert_eq!(core_names, ["nodes", "work_logs", "occurrences", "settings"]);
        assert_eq!(core::SETTINGS_KEYS, ["day_start_hour"]);

        let reg = Registry::production();
        let groups = Registry::production_groups();
        let want: Vec<&str> = groups.iter().flat_map(|(ts, _)| ts.iter().map(|t| t.name)).collect();
        let names: Vec<&str> = reg.tables.iter().map(|t| t.name).collect();
        assert_eq!(names, want);
        assert_eq!(&names[..core_names.len()], &core_names[..], "核心四張表必須排在最前");
        let want_keys: Vec<&str> = groups.iter().flat_map(|(_, ks)| ks.iter().copied()).collect();
        assert_eq!(reg.settings_keys().collect::<Vec<_>>(), want_keys);

        let rows: Vec<&str> = reg.rows().map(|(t, _)| t.name).collect();
        assert_eq!(&rows[..3], ["nodes", "work_logs", "occurrences"]);
        let mut rev: Vec<&str> = reg.rows_rev().map(|(t, _)| t.name).collect();
        assert_eq!(&rev[rev.len() - 3..], ["occurrences", "work_logs", "nodes"]);
        rev.reverse();
        assert_eq!(rev, rows, "rows_rev 必須是 rows 的反序");
        assert!(reg.find("sync_meta").is_none());
    }

    #[test]
    fn 表名與_settings_鍵不重複_且_since_指到真的_migration() {
        let reg = Registry::production();
        let mut seen = std::collections::BTreeSet::new();
        for t in &reg.tables {
            assert!(seen.insert(t.name), "同步表 `{}` 登記了兩次", t.name);
            if let Kind::Rows(r) = &t.kind {
                if let Some(k) = r.since {
                    assert!(
                        crate::migrations::version_of(k).is_some(),
                        "`{}` 的 since = {k:?} 不是任何 migration 的 key",
                        t.name
                    );
                }
            }
        }
        let mut keys = std::collections::BTreeSet::new();
        for k in reg.settings_keys() {
            assert!(keys.insert(k), "settings 鍵 `{k}` 登記了兩次");
        }
    }
}
