//! 財務管家備份（`.mmbak`）的唯讀讀取（車次①契約 §3.6、0-25）。
//!
//! **只讀，不解讀**：DO_TYPE 的意義、轉帳配對、金額換算一律在 TS（`src/domain/ticket.ts`）；
//! 這裡不丟任何一列（含 `IS_DEL=1`，由 TS 判）。
//! 金額兩欄的語意（實證於主人備份的聚合查詢）：`ZMONEY`＝**帳戶幣別**的金額、`IN_ZMONEY`＝**交易幣別（`currencyUid`）原幣**的金額
//! （外幣列 `ZMONEY / IN_ZMONEY = CURRENCY.RATE`、台幣列兩者相等）。所以 `IN_ZMONEY` 現在要讀（選填欄，備份沒這欄就是 None）；
//! `AMOUNT_ACCOUNT` 仍不讀。早期（D-票-19）曾當 `ZMONEY` 是原幣、`IN_ZMONEY` 不讀——那是錯的，外幣支出會被換算兩次。
//!
//! 型別欄名 snake_case，與 `src/domain/ticket.ts` 的 `MmbakReadResult`／`MmbakDump`／`Mm*` 逐字相同。
//! 欄名：甲席 10-12 在主人樣本的**複本**上只跑 `PRAGMA table_info`＋計數聚合實證（契約 §3.6 表格同步回寫）。
//! 讀法：FsExt 讀 bytes → 驗檔頭 → 複製到 `app_cache_dir()/ticket-import/` → sqlx 唯讀開 → 讀 → 外層刪暫存。
//! 不 import `backup`：那支 mod 只在桌機編（`lib.rs`），手機會編不過——`open_readonly` 照抄 `backup.rs::open_source`。
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row, SqliteConnection};

/// `ticket_import_read` 的回傳。schema 不符不是錯誤：`missing` 列出缺的「表」或「表.欄」、`dump` 為 None。
#[derive(Debug, Clone, Serialize)]
pub struct MmbakReadResult {
    pub missing: Vec<String>,
    pub dump: Option<MmbakDump>,
}

/// 五張要讀的表的原樣內容（字串欄一律 `CAST(x AS TEXT)`，整數欄 `CAST(COALESCE(x,0) AS INTEGER)`）；
/// 第③階段多三張（`BUDGET`／`BUDGET_AMOUNT`／`REPEATTRANSACTION`，缺欄不擋）。
#[derive(Debug, Clone, Serialize)]
pub struct MmbakDump {
    /// 給預覽卡顯示的檔名（路徑最後一段）
    pub file_name: String,
    pub currencies: Vec<MmCurrency>,
    pub groups: Vec<MmGroup>,
    pub accounts: Vec<MmAccount>,
    pub categories: Vec<MmCategory>,
    pub transactions: Vec<MmTx>,
    /// 第③階段（③契約 §3.6、0-17）：三張表**缺欄不擋**——某張表少了 `PLAN_COLUMNS` 裡任一欄 ⇒ 那張的陣列 None、
    /// `plan_missing` 推「表.欄」，交易照讀照匯。
    pub budgets: Option<Vec<MmBudget>>,
    pub budget_amounts: Option<Vec<MmBudgetAmount>>,
    pub repeats: Option<Vec<MmRepeat>>,
    pub plan_missing: Vec<String>,
}

/// `BUDGET` 一列（預算對象；碼值意義在 TS `planBudgetImport`）
#[derive(Debug, Clone, Serialize)]
pub struct MmBudget {
    pub uid: String,
    /// 分類預算的 `ZCATEGORY.uid`；總額是空字串或 NULL
    pub target_uid: Option<String>,
    pub do_type: i64,
    pub period_type: i64,
    pub is_total: bool,
    pub is_del: bool,
    pub transfer_type: i64,
    /// 毫秒
    pub modify_date: i64,
}

/// `BUDGET_AMOUNT` 一列（某個預算對象在某期的金額）
#[derive(Debug, Clone, Serialize)]
pub struct MmBudgetAmount {
    pub uid: String,
    pub budget_uid: String,
    pub is_del: bool,
    /// 十進位字串（`AMOUNT` 是 REAL；`num_text`，不經浮點運算）
    pub amount: String,
    /// `0`＝預設、`YYYYMM`＝該月覆寫
    pub budget_period: i64,
    /// 毫秒
    pub modify_date: i64,
}

/// `REPEATTRANSACTION` 一列（定期規則；只讀不解讀）
#[derive(Debug, Clone, Serialize)]
pub struct MmRepeat {
    pub uid: String,
    pub is_del: bool,
    /// 修改時間（毫秒）
    pub usetime: i64,
    /// 終止日（毫秒；0＝沒有）
    pub end_date: i64,
    /// 下一班（毫秒）
    pub next_date: i64,
    pub do_type: i64,
    pub repeat_type: i64,
    pub asset_uid: Option<String>,
    pub to_asset_uid: Option<String>,
    pub ctg_uid: Option<String>,
    pub currency_uid: Option<String>,
    /// 交易幣別原幣的金額（十進位字串；`AMOUNT_SUB` 是 REAL）
    pub amount_sub: String,
    pub memo: String,
    pub payee: String,
}

/// `CURRENCY` 一列
#[derive(Debug, Clone, Serialize)]
pub struct MmCurrency {
    pub uid: String,
    pub iso: String,
    pub is_main: bool,
    /// 十進位字串（`RATE`）；不經浮點
    pub rate: String,
    pub decimals: i64,
}

/// `ASSETGROUP` 一列
#[derive(Debug, Clone, Serialize)]
pub struct MmGroup {
    pub uid: String,
    pub type_code: Option<i64>,
    pub name: String,
}

/// `ASSETS` 一列
#[derive(Debug, Clone, Serialize)]
pub struct MmAccount {
    pub uid: String,
    pub name: String,
    pub group_uid: Option<String>,
    pub currency_uid: Option<String>,
    pub is_del: bool,
}

/// `ZCATEGORY` 一列
#[derive(Debug, Clone, Serialize)]
pub struct MmCategory {
    pub uid: String,
    /// 0＝收入、1＝支出
    pub type_code: i64,
    pub name: String,
    pub parent_uid: Option<String>,
    /// 0＝主、2＝子
    pub status: i64,
    pub is_del: bool,
}

/// `INOUTCOME` 一列
#[derive(Debug, Clone, Serialize)]
pub struct MmTx {
    pub uid: String,
    pub do_type: String,
    pub asset_uid: Option<String>,
    pub to_asset_uid: Option<String>,
    pub tx_uid_trans: Option<String>,
    pub ctg_uid: Option<String>,
    /// VARCHAR，但 SQLite 動態型別下仍可能存成 REAL ⇒ 一律 CAST 成字串
    /// **帳戶幣別**的金額（不是原幣！外幣列的原幣額在 `in_zmoney`）
    pub zmoney: String,
    pub currency_uid: Option<String>,
    /// 本地日 YYYY-MM-DD
    pub wdate: String,
    /// 毫秒（字串；TS 端 `Number()` 轉）
    pub zdate: String,
    pub content: String,
    /// 修改時間（毫秒）
    pub utime: i64,
    pub is_del: bool,
    /// 交易幣別（`currency_uid`）原幣的金額；備份沒有 `IN_ZMONEY` 欄、或這列是 NULL ⇒ None
    pub in_zmoney: Option<String>,
}

/// 備份檔頭（前 16 bytes）
pub const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// 讀進記憶體的上限（超過＝不像財務管家的備份）
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 必須存在的 9 張表（不分大小寫比對；後四張 ①b 不讀、只驗在不在，③ 要用）
pub const REQUIRED_TABLES: &[&str] = &[
    "INOUTCOME",
    "ASSETS",
    "ASSETGROUP",
    "ZCATEGORY",
    "CURRENCY",
    "BUDGET",
    "BUDGET_AMOUNT",
    "REPEATTRANSACTION",
    "ZETC",
];

/// 要讀的表（欄名檢查只看這幾張）：①b 的五張＋第③階段的三張（後三張只為了填 `plan_missing`，不進 `REQUIRED_COLUMNS`，0-17）
const READ_TABLES: &[&str] = &[
    "INOUTCOME",
    "ASSETS",
    "ASSETGROUP",
    "ZCATEGORY",
    "CURRENCY",
    "BUDGET",
    "BUDGET_AMOUNT",
    "REPEATTRANSACTION",
];

/// 第③階段三張表要讀的欄（表, 欄；③契約 §3.6，全部實證於〈③備份預算重複表實證〉）。
/// 缺了**不擋**（0-17）：那張表的陣列 None、`plan_missing` 推「表.欄」，交易照匯。
pub const PLAN_COLUMNS: &[(&str, &str)] = &[
    ("BUDGET", "uid"),
    ("BUDGET", "targetUid"),
    ("BUDGET", "DO_TYPE"),
    ("BUDGET", "PERIOD_TYPE"),
    ("BUDGET", "IS_TOTAL"),
    ("BUDGET", "IS_DEL"),
    ("BUDGET", "TRANSFER_TYPE"),
    ("BUDGET", "MODIFY_DATE"),
    ("BUDGET_AMOUNT", "uid"),
    ("BUDGET_AMOUNT", "budgetUid"),
    ("BUDGET_AMOUNT", "IS_DEL"),
    ("BUDGET_AMOUNT", "AMOUNT"),
    ("BUDGET_AMOUNT", "BUDGET_PERIOD"),
    ("BUDGET_AMOUNT", "MODIFY_DATE"),
    ("REPEATTRANSACTION", "uid"),
    ("REPEATTRANSACTION", "IS_DEL"),
    ("REPEATTRANSACTION", "USETIME"),
    ("REPEATTRANSACTION", "END_DATE"),
    ("REPEATTRANSACTION", "NEXT_DATE"),
    ("REPEATTRANSACTION", "DO_TYPE"),
    ("REPEATTRANSACTION", "REPEAT_TYPE"),
    ("REPEATTRANSACTION", "assetUid"),
    ("REPEATTRANSACTION", "toAssetUid"),
    ("REPEATTRANSACTION", "ctgUid"),
    ("REPEATTRANSACTION", "currencyUid"),
    ("REPEATTRANSACTION", "AMOUNT_SUB"),
    ("REPEATTRANSACTION", "MEMO"),
    ("REPEATTRANSACTION", "PAYEE"),
];
const PLAN_TABLES: &[&str] = &["BUDGET", "BUDGET_AMOUNT", "REPEATTRANSACTION"];

/// 必須存在的欄（表, 欄）。前段＝樣本格式文件實證；後段＝甲席 10-12 `PRAGMA table_info` 實證（契約 §3.6）。
/// 改欄名時 `scripts/probes/ticket-import-dryrun.ts`（若有）要一起改。
pub const REQUIRED_COLUMNS: &[(&str, &str)] = &[
    ("INOUTCOME", "uid"),
    ("INOUTCOME", "DO_TYPE"),
    ("INOUTCOME", "assetUid"),
    ("INOUTCOME", "toAssetUid"),
    ("INOUTCOME", "txUidTrans"),
    ("INOUTCOME", "ctgUid"),
    ("INOUTCOME", "ZMONEY"),
    ("INOUTCOME", "currencyUid"),
    ("INOUTCOME", "WDATE"),
    ("INOUTCOME", "ZDATE"),
    ("INOUTCOME", "ZCONTENT"),
    ("INOUTCOME", "UTIME"),
    ("INOUTCOME", "IS_DEL"),
    ("ASSETS", "uid"),
    ("ASSETGROUP", "uid"),
    ("ASSETGROUP", "TYPE"),
    ("ZCATEGORY", "uid"),
    ("ZCATEGORY", "TYPE"),
    ("ZCATEGORY", "pUid"),
    ("ZCATEGORY", "STATUS"),
    ("ZCATEGORY", "C_IS_DEL"),
    ("CURRENCY", "uid"),
    ("CURRENCY", "RATE"),
    ("CURRENCY", "DECIMAL_POINT"),
    // ── 甲席 10-12 實證 ──
    ("ASSETS", "NIC_NAME"),
    ("ASSETS", "groupUid"),
    ("ASSETGROUP", "ACC_GROUP_NAME"),
    ("ZCATEGORY", "NAME"),
    ("CURRENCY", "ISO"),
    ("CURRENCY", "IS_MAIN_CURRENCY"),
];

/// 有就用、沒有也讀得下去的欄（甲席 10-12 實證；樣本裡都有，只是不設為必要）：
/// - `ASSETS.currencyUid` 沒有 ⇒ None（TS 當主幣別）
/// - `ASSETS.IS_DEL` 樣本**沒有**這欄（帳戶沒有刪除旗標）⇒ 一律 false；別的版本有就照讀
/// - 各表排序欄沒有 ⇒ 用 rowid
/// - `INOUTCOME.IN_ZMONEY` 沒有 ⇒ None（TS 外幣列退回記成帳戶幣別）
const COL_TX_IN_ZMONEY: (&str, &str) = ("INOUTCOME", "IN_ZMONEY");
const COL_ASSET_CURRENCY: (&str, &str) = ("ASSETS", "currencyUid");
const COL_ASSET_DEL: (&str, &str) = ("ASSETS", "IS_DEL");
const COL_ASSET_ORDER: (&str, &str) = ("ASSETS", "ORDERSEQ");
const COL_GROUP_ORDER: (&str, &str) = ("ASSETGROUP", "ORDERSEQ");
const COL_CATEGORY_ORDER: (&str, &str) = ("ZCATEGORY", "ORDERSEQ");
const COL_CURRENCY_ORDER: (&str, &str) = ("CURRENCY", "ORDER_SEQ");

/// 前 16 bytes 必須是 SQLite 檔頭。
pub fn check_magic(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < SQLITE_MAGIC.len() || &bytes[..SQLITE_MAGIC.len()] != SQLITE_MAGIC {
        return Err("這不是財務管家的備份檔（檔頭對不上）".into());
    }
    Ok(())
}

/// 讀主人選的檔（兩殼都走 FsExt：Android 是 SAF 的 content:// URI，`std::fs` 開不了）→ 驗檔頭 →
/// 寫到 `app_cache_dir()/ticket-import/<epoch 毫秒>.mmbak`，回暫存路徑。原檔一個位元組都不碰。
pub fn copy_to_cache(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    use std::io::Read;
    use std::str::FromStr;
    use tauri::Manager;
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    let fp = FilePath::from_str(path).map_err(|_| "讀不到你選的檔案：路徑看不懂".to_string())?;
    let mut opts = OpenOptions::new();
    opts.read(true);
    let file = app
        .fs()
        .open(fp, opts)
        .map_err(|e| format!("讀不到你選的檔案：{e}"))?;
    // 多讀 1 byte 判斷是否超過上限，不把超大檔整個吞進記憶體
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("讀不到你選的檔案：{e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("檔案太大（超過 64 MB），不像財務管家的備份".into());
    }
    check_magic(&bytes)?;

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("找不到暫存資料夾：{e}"))?
        .join("ticket-import");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了暫存資料夾：{e}"))?;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = dir.join(format!("{ms}.mmbak"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("寫不了暫存檔：{e}"))?;
    Ok(tmp)
}

/// 預覽卡顯示的檔名，優先用系統回報的真檔名。
/// Android 的 content URI 最後一段是文件編號（如 `msf:1093`）而不是檔名，真檔名要問 ContentResolver
/// （`app.path().file_name(&path)`，tauri 2.11 內建，查 OpenableColumns.DISPLAY_NAME）；
/// 桌機一般路徑那邊拿到的就是最後一段。`real` 為 None／空白（查不到）⇒ 退回 `display_name(path)`。
pub fn pick_display_name(real: Option<String>, path: &str) -> String {
    match real.map(|s| s.trim().to_string()) {
        Some(s) if !s.is_empty() => s,
        _ => display_name(path),
    }
}

/// 給預覽卡顯示的檔名＝路徑最後一段（`/` 或 `\` 之後；content URI 先 percent-decode）；取不到＝「備份檔」。
/// content URI 的最後一段若不像檔名（沒有 `.mmbak` 副檔名，不分大小寫；例如 SAF 文件編號 `msf:1093`）
/// ⇒ 回固定字串「財務管家備份」，免得預覽卡顯示一串數字。一般路徑照舊顯示真檔名。
pub fn display_name(path: &str) -> String {
    let is_content = path.starts_with("content://");
    let decoded = if is_content { percent_decode(path) } else { path.to_string() };
    let last = decoded.rsplit(['/', '\\']).next().unwrap_or("").trim();
    // SAF 的 document id 形如 `primary:Download/x.mmbak`——斜線已切掉；只剩 `primary:x` 時取冒號後
    let last = last.rsplit(':').next().unwrap_or("").trim();
    if last.is_empty() {
        "備份檔".into()
    } else if is_content && !last.to_ascii_lowercase().ends_with(".mmbak") {
        "財務管家備份".into()
    } else {
        last.to_string()
    }
}

/// 最小的 percent-decode（不加依賴）：`%XX` → byte，其餘照抄；結果不是合法 UTF-8 就有損轉換。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 唯讀開（照抄 `backup.rs::open_source`；read_only 恆真——暫存複本不會有待回復的 WAL）。
async fn open_readonly(db: &Path) -> Result<SqliteConnection, sqlx::Error> {
    SqliteConnectOptions::new()
        .filename(db)
        .create_if_missing(false)
        .read_only(true)
        .connect()
        .await
}

/// 讀出整份 dump。schema 不符 ⇒ Ok(missing 非空、dump None)；開不起來／查詢失敗 ⇒ Err。
pub async fn read_dump(path: &Path, file_name: &str) -> Result<MmbakReadResult, String> {
    let mut conn = open_readonly(path)
        .await
        .map_err(|e| format!("打不開這個備份檔：{e}"))?;
    let out = read_with(&mut conn, file_name).await;
    let _ = conn.close().await;
    out
}

fn read_err(e: sqlx::Error) -> String {
    format!("讀備份失敗：{e}")
}

/// SQL 識別字加雙引號（表名來自 sqlite_master，照實際大小寫）
fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 可空字串欄
fn opt_text(col: &str) -> String {
    format!("CAST({col} AS TEXT)")
}

/// 非空字串欄（NULL ⇒ ''）
fn text(col: &str) -> String {
    format!("COALESCE(CAST({col} AS TEXT), '')")
}

/// 數字字串欄（金額、匯率）：存成 REAL 時 CAST 可能吐科學記號（`%!.15g`），那種才改用定點再去尾零。
fn num_text(col: &str) -> String {
    format!(
        "COALESCE(CASE WHEN typeof({col}) = 'real' AND instr(lower(CAST({col} AS TEXT)), 'e') > 0 \
         THEN rtrim(rtrim(printf('%.12f', {col}), '0'), '.') ELSE CAST({col} AS TEXT) END, '')"
    )
}

/// 整數欄（NULL ⇒ 0）
fn int(col: &str) -> String {
    format!("CAST(COALESCE({col}, 0) AS INTEGER)")
}

async fn read_with(conn: &mut SqliteConnection, file_name: &str) -> Result<MmbakReadResult, String> {
    // 1. 表（不分大小寫）：大寫名 → 實際名
    let rows = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .fetch_all(&mut *conn)
        .await
        .map_err(read_err)?;
    let mut actual: HashMap<String, String> = HashMap::new();
    for r in &rows {
        let name: String = r.try_get(0).map_err(read_err)?;
        actual.entry(name.to_ascii_uppercase()).or_insert(name);
    }
    let mut missing: Vec<String> = REQUIRED_TABLES
        .iter()
        .filter(|t| !actual.contains_key(**t))
        .map(|t| t.to_string())
        .collect();

    // 2. 五張要讀的表的欄（不分大小寫）
    let mut cols: HashMap<&str, HashSet<String>> = HashMap::new();
    for t in READ_TABLES {
        let Some(real) = actual.get(*t) else { continue };
        let rs = sqlx::query("SELECT name FROM pragma_table_info(?1)")
            .bind(real)
            .fetch_all(&mut *conn)
            .await
            .map_err(read_err)?;
        let mut set = HashSet::new();
        for r in &rs {
            let c: String = r.try_get(0).map_err(read_err)?;
            set.insert(c.to_ascii_uppercase());
        }
        cols.insert(*t, set);
    }
    let has = |(t, c): (&str, &str)| cols.get(t).is_some_and(|s| s.contains(&c.to_ascii_uppercase()));
    for (t, c) in REQUIRED_COLUMNS {
        if actual.contains_key(*t) && !has((t, c)) {
            missing.push(format!("{t}.{c}"));
        }
    }

    // 3. schema 不符
    if !missing.is_empty() {
        return Ok(MmbakReadResult { missing, dump: None });
    }

    // 4. 讀五張表（排序欄有就用，否則 rowid）
    let tbl = |t: &str| ident(&actual[t]);
    let order = |c: (&str, &str)| if has(c) { format!("{}, rowid", c.1) } else { "rowid".to_string() };

    let sql = format!(
        "SELECT {}, {}, {} <> 0, {}, {} FROM {} ORDER BY {}",
        text("uid"),
        text("ISO"),
        int("IS_MAIN_CURRENCY"),
        num_text("RATE"),
        "CAST(COALESCE(DECIMAL_POINT, 2) AS INTEGER)", // 沒填當 2 位（樣本全為 2）
        tbl("CURRENCY"),
        order(COL_CURRENCY_ORDER),
    );
    let mut currencies = Vec::new();
    for r in sqlx::query(&sql).fetch_all(&mut *conn).await.map_err(read_err)? {
        currencies.push(MmCurrency {
            uid: r.try_get(0).map_err(read_err)?,
            iso: r.try_get(1).map_err(read_err)?,
            is_main: r.try_get(2).map_err(read_err)?,
            rate: r.try_get(3).map_err(read_err)?,
            decimals: r.try_get(4).map_err(read_err)?,
        });
    }

    let sql = format!(
        "SELECT {}, CAST(TYPE AS INTEGER), {} FROM {} ORDER BY {}",
        text("uid"),
        text("ACC_GROUP_NAME"),
        tbl("ASSETGROUP"),
        order(COL_GROUP_ORDER),
    );
    let mut groups = Vec::new();
    for r in sqlx::query(&sql).fetch_all(&mut *conn).await.map_err(read_err)? {
        groups.push(MmGroup {
            uid: r.try_get(0).map_err(read_err)?,
            type_code: r.try_get(1).map_err(read_err)?,
            name: r.try_get(2).map_err(read_err)?,
        });
    }

    let sql = format!(
        "SELECT {}, {}, {}, {}, {} <> 0 FROM {} ORDER BY {}",
        text("uid"),
        text("NIC_NAME"),
        opt_text("groupUid"),
        if has(COL_ASSET_CURRENCY) { opt_text("currencyUid") } else { "NULL".to_string() },
        if has(COL_ASSET_DEL) { int("IS_DEL") } else { "0".to_string() },
        tbl("ASSETS"),
        order(COL_ASSET_ORDER),
    );
    let mut accounts = Vec::new();
    for r in sqlx::query(&sql).fetch_all(&mut *conn).await.map_err(read_err)? {
        accounts.push(MmAccount {
            uid: r.try_get(0).map_err(read_err)?,
            name: r.try_get(1).map_err(read_err)?,
            group_uid: r.try_get(2).map_err(read_err)?,
            currency_uid: r.try_get(3).map_err(read_err)?,
            is_del: r.try_get(4).map_err(read_err)?,
        });
    }

    // C_IS_DEL：樣本裡未刪的是 NULL、刪的是 1 ⇒ COALESCE 成 0
    let sql = format!(
        "SELECT {}, {}, {}, {}, {}, {} <> 0 FROM {} ORDER BY {}",
        text("uid"),
        int("TYPE"),
        text("NAME"),
        opt_text("pUid"),
        int("STATUS"),
        int("C_IS_DEL"),
        tbl("ZCATEGORY"),
        order(COL_CATEGORY_ORDER),
    );
    let mut categories = Vec::new();
    for r in sqlx::query(&sql).fetch_all(&mut *conn).await.map_err(read_err)? {
        categories.push(MmCategory {
            uid: r.try_get(0).map_err(read_err)?,
            type_code: r.try_get(1).map_err(read_err)?,
            name: r.try_get(2).map_err(read_err)?,
            parent_uid: r.try_get(3).map_err(read_err)?,
            status: r.try_get(4).map_err(read_err)?,
            is_del: r.try_get(5).map_err(read_err)?,
        });
    }

    let sql = format!(
        "SELECT {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {} <> 0, {} FROM {} ORDER BY rowid",
        text("uid"),
        text("DO_TYPE"),
        opt_text("assetUid"),
        opt_text("toAssetUid"),
        opt_text("txUidTrans"),
        opt_text("ctgUid"),
        num_text("ZMONEY"),
        opt_text("currencyUid"),
        text("WDATE"),
        num_text("ZDATE"),
        text("ZCONTENT"),
        int("UTIME"),
        int("IS_DEL"),
        if has(COL_TX_IN_ZMONEY) { format!("NULLIF({}, '')", num_text("IN_ZMONEY")) } else { "NULL".to_string() },
        tbl("INOUTCOME"),
    );
    let mut transactions = Vec::new();
    for r in sqlx::query(&sql).fetch_all(&mut *conn).await.map_err(read_err)? {
        transactions.push(MmTx {
            uid: r.try_get(0).map_err(read_err)?,
            do_type: r.try_get(1).map_err(read_err)?,
            asset_uid: r.try_get(2).map_err(read_err)?,
            to_asset_uid: r.try_get(3).map_err(read_err)?,
            tx_uid_trans: r.try_get(4).map_err(read_err)?,
            ctg_uid: r.try_get(5).map_err(read_err)?,
            zmoney: r.try_get(6).map_err(read_err)?,
            currency_uid: r.try_get(7).map_err(read_err)?,
            wdate: r.try_get(8).map_err(read_err)?,
            zdate: r.try_get(9).map_err(read_err)?,
            content: r.try_get(10).map_err(read_err)?,
            utime: r.try_get(11).map_err(read_err)?,
            is_del: r.try_get(12).map_err(read_err)?,
            in_zmoney: r.try_get(13).map_err(read_err)?,
        });
    }

    // 5. 第③階段三張表（0-17 缺欄不擋）：表不在（REQUIRED_TABLES 已擋，實際上不會發生）推「表」、少欄推「表.欄」，那張給 None
    let mut plan_missing: Vec<String> = Vec::new();
    let mut plan_ok: HashSet<&str> = HashSet::new();
    for t in PLAN_TABLES {
        if !actual.contains_key(*t) {
            plan_missing.push(t.to_string());
            continue;
        }
        let before = plan_missing.len();
        for (pt, c) in PLAN_COLUMNS {
            if pt == t && !has((pt, c)) {
                plan_missing.push(format!("{pt}.{c}"));
            }
        }
        if plan_missing.len() == before {
            plan_ok.insert(*t);
        }
    }

    let budgets = if plan_ok.contains("BUDGET") {
        let sql = format!(
            "SELECT {}, {}, {}, {}, {} <> 0, {} <> 0, {}, {} FROM {} ORDER BY rowid",
            text("uid"),
            opt_text("targetUid"),
            int("DO_TYPE"),
            int("PERIOD_TYPE"),
            int("IS_TOTAL"),
            int("IS_DEL"),
            int("TRANSFER_TYPE"),
            int("MODIFY_DATE"),
            tbl("BUDGET"),
        );
        let mut v = Vec::new();
        for r in sqlx::query(&sql).fetch_all(&mut *conn).await.map_err(read_err)? {
            v.push(MmBudget {
                uid: r.try_get(0).map_err(read_err)?,
                target_uid: r.try_get(1).map_err(read_err)?,
                do_type: r.try_get(2).map_err(read_err)?,
                period_type: r.try_get(3).map_err(read_err)?,
                is_total: r.try_get(4).map_err(read_err)?,
                is_del: r.try_get(5).map_err(read_err)?,
                transfer_type: r.try_get(6).map_err(read_err)?,
                modify_date: r.try_get(7).map_err(read_err)?,
            });
        }
        Some(v)
    } else {
        None
    };

    let budget_amounts = if plan_ok.contains("BUDGET_AMOUNT") {
        let sql = format!(
            "SELECT {}, {}, {} <> 0, {}, {}, {} FROM {} ORDER BY rowid",
            text("uid"),
            text("budgetUid"),
            int("IS_DEL"),
            num_text("AMOUNT"),
            int("BUDGET_PERIOD"),
            int("MODIFY_DATE"),
            tbl("BUDGET_AMOUNT"),
        );
        let mut v = Vec::new();
        for r in sqlx::query(&sql).fetch_all(&mut *conn).await.map_err(read_err)? {
            v.push(MmBudgetAmount {
                uid: r.try_get(0).map_err(read_err)?,
                budget_uid: r.try_get(1).map_err(read_err)?,
                is_del: r.try_get(2).map_err(read_err)?,
                amount: r.try_get(3).map_err(read_err)?,
                budget_period: r.try_get(4).map_err(read_err)?,
                modify_date: r.try_get(5).map_err(read_err)?,
            });
        }
        Some(v)
    } else {
        None
    };

    let repeats = if plan_ok.contains("REPEATTRANSACTION") {
        let sql = format!(
            "SELECT {}, {} <> 0, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {} FROM {} ORDER BY rowid",
            text("uid"),
            int("IS_DEL"),
            int("USETIME"),
            int("END_DATE"),
            int("NEXT_DATE"),
            int("DO_TYPE"),
            int("REPEAT_TYPE"),
            opt_text("assetUid"),
            opt_text("toAssetUid"),
            opt_text("ctgUid"),
            opt_text("currencyUid"),
            num_text("AMOUNT_SUB"),
            text("MEMO"),
            text("PAYEE"),
            tbl("REPEATTRANSACTION"),
        );
        let mut v = Vec::new();
        for r in sqlx::query(&sql).fetch_all(&mut *conn).await.map_err(read_err)? {
            v.push(MmRepeat {
                uid: r.try_get(0).map_err(read_err)?,
                is_del: r.try_get(1).map_err(read_err)?,
                usetime: r.try_get(2).map_err(read_err)?,
                end_date: r.try_get(3).map_err(read_err)?,
                next_date: r.try_get(4).map_err(read_err)?,
                do_type: r.try_get(5).map_err(read_err)?,
                repeat_type: r.try_get(6).map_err(read_err)?,
                asset_uid: r.try_get(7).map_err(read_err)?,
                to_asset_uid: r.try_get(8).map_err(read_err)?,
                ctg_uid: r.try_get(9).map_err(read_err)?,
                currency_uid: r.try_get(10).map_err(read_err)?,
                amount_sub: r.try_get(11).map_err(read_err)?,
                memo: r.try_get(12).map_err(read_err)?,
                payee: r.try_get(13).map_err(read_err)?,
            });
        }
        Some(v)
    } else {
        None
    };

    Ok(MmbakReadResult {
        missing: Vec::new(),
        dump: Some(MmbakDump {
            file_name: file_name.to_string(),
            currencies,
            groups,
            accounts,
            categories,
            transactions,
            budgets,
            budget_amounts,
            repeats,
            plan_missing,
        }),
    })
}

/* ═══════════════════════════════════════════════════════════════════════
   單測（契約 §3.6 (a)–(g)；③契約 §3.6 (h)–(j)；臨時 DB 造最小 schema，照 backup.rs 的 temp_dir 寫法）
   `copy_to_cache` 要 AppHandle，不進單測（沙盒 §7.2 驗）。
   ═══════════════════════════════════════════════════════════════════════ */
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn temp_db(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("next-stop-mmbak-test-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("sample.mmbak")
    }

    /// 樣本的欄名（甲席 10-12 實證的子集）；欄不帶型別＝無 affinity，插什麼存什麼（(e) 要 REAL 原樣存）
    fn schema() -> Vec<(&'static str, Vec<&'static str>)> {
        vec![
            (
                "INOUTCOME",
                vec![
                    "uid", "assetUid", "ctgUid", "toAssetUid", "ZCONTENT", "ZDATE", "WDATE", "DO_TYPE", "ZMONEY",
                    "txUidTrans", "IN_ZMONEY", "IS_DEL", "UTIME", "currencyUid", "AMOUNT_ACCOUNT",
                ],
            ),
            ("ASSETS", vec!["NIC_NAME", "ORDERSEQ", "uid", "currencyUid", "groupUid"]),
            ("ASSETGROUP", vec!["uid", "IS_DEL", "ACC_GROUP_NAME", "TYPE", "ORDERSEQ"]),
            ("ZCATEGORY", vec!["C_IS_DEL", "uid", "NAME", "ORDERSEQ", "TYPE", "STATUS", "pUid"]),
            (
                "CURRENCY",
                vec!["uid", "NAME", "ISO", "IS_DEL", "ORDER_SEQ", "RATE", "IS_MAIN_CURRENCY", "DECIMAL_POINT"],
            ),
            // 第③階段（③契約 §3.6）：三張表的完整欄（＋一兩個不讀的欄，驗「多的欄不礙事」）
            (
                "BUDGET",
                vec!["uid", "targetUid", "DO_TYPE", "PERIOD_TYPE", "IS_TOTAL", "IS_DEL", "TRANSFER_TYPE", "MODIFY_DATE", "ORDERSEQ"],
            ),
            ("BUDGET_AMOUNT", vec!["uid", "budgetUid", "IS_DEL", "AMOUNT", "BUDGET_PERIOD", "MODIFY_DATE"]),
            (
                "REPEATTRANSACTION",
                vec![
                    "uid", "IS_DEL", "USETIME", "END_DATE", "NEXT_DATE", "DO_TYPE", "REPEAT_TYPE", "assetUid", "toAssetUid",
                    "ctgUid", "currencyUid", "AMOUNT_SUB", "MEMO", "PAYEE", "MARK",
                ],
            ),
            ("ZETC", vec!["ID"]),
        ]
    }

    /// 造檔。`rename`：表名換成別的寫法（測大小寫）；`skip_table`／`skip_col`：故意缺。
    async fn make(path: &Path, rename: Option<(&str, &str)>, skip_table: Option<&str>, skip_col: Option<(&str, &str)>) {
        let mut c = SqliteConnectOptions::new().filename(path).create_if_missing(true).connect().await.unwrap();
        for (t, cs) in schema() {
            if skip_table == Some(t) {
                continue;
            }
            let cs: Vec<&str> = cs.into_iter().filter(|col| skip_col != Some((t, *col))).collect();
            let name = match rename {
                Some((from, to)) if from == t => to,
                _ => t,
            };
            sqlx::query(&format!("CREATE TABLE {name} ({})", cs.join(", "))).execute(&mut c).await.unwrap();
        }
        let has = |t: &str| skip_table != Some(t);
        if has("CURRENCY") {
            sqlx::query(
                "INSERT INTO CURRENCY (uid, NAME, ISO, IS_DEL, ORDER_SEQ, RATE, IS_MAIN_CURRENCY, DECIMAL_POINT) VALUES \
                 ('c-usd', '美元', 'USD', 0, 1, 31.549671, 0, 2), ('c-twd', '新台幣', 'TWD', 0, 0, 1.0, 1, 2)",
            )
            .execute(&mut c)
            .await
            .unwrap();
        }
        if has("ASSETGROUP") {
            sqlx::query(
                "INSERT INTO ASSETGROUP (uid, IS_DEL, ACC_GROUP_NAME, TYPE, ORDERSEQ) VALUES \
                 ('g-card', 0, '信用卡', 3, 1), ('g-cash', 0, '現金', 1, 0)",
            )
            .execute(&mut c)
            .await
            .unwrap();
        }
        if has("ASSETS") {
            sqlx::query(
                "INSERT INTO ASSETS (NIC_NAME, ORDERSEQ, uid, currencyUid, groupUid) VALUES \
                 ('信用卡', 1, 'a-card', 'c-twd', 'g-card'), ('現金', 0, 'a-cash', 'c-twd', 'g-cash')",
            )
            .execute(&mut c)
            .await
            .unwrap();
        }
        let cat = match rename {
            Some(("ZCATEGORY", to)) => to,
            _ => "ZCATEGORY",
        };
        if has("ZCATEGORY") {
            sqlx::query(&format!(
                "INSERT INTO {cat} (C_IS_DEL, uid, NAME, ORDERSEQ, TYPE, STATUS, pUid) VALUES \
                 (NULL, 'k-food', '🍜 食物', 0, 1, 0, NULL), (NULL, 'k-lunch', '午餐', 0, 1, 2, 'k-food'), \
                 (1, 'k-old', '舊分類', 1, 0, 0, NULL)"
            ))
            .execute(&mut c)
            .await
            .unwrap();
        }
        if has("INOUTCOME") {
            let tx_col = if skip_col == Some(("INOUTCOME", "txUidTrans")) { "" } else { ", txUidTrans" };
            let skip_in = skip_col == Some(("INOUTCOME", "IN_ZMONEY"));
            let in_col = if skip_in { "" } else { ", IN_ZMONEY" };
            let tx_val = |v: &str| if tx_col.is_empty() { String::new() } else { format!(", {v}") };
            for (uid, do_type, asset, to, trans, ctg, money, in_money, del) in [
                ("t1", "1", "a-cash", "NULL", "NULL", "'k-lunch'", "'120'", "'4'", 0),
                ("t2", "3", "a-cash", "'a-card'", "'x1'", "NULL", "'500'", "'500'", 0),
                ("t3", "1", "a-cash", "NULL", "NULL", "'k-food'", "'80'", "NULL", 1),
                ("t4", "0", "a-cash", "NULL", "NULL", "'k-old'", "120.0", "120.0", 0),
            ] {
                sqlx::query(&format!(
                    "INSERT INTO INOUTCOME (uid, DO_TYPE, assetUid, toAssetUid{tx_col}, ctgUid, ZMONEY{in_col}, currencyUid, \
                     WDATE, ZDATE, ZCONTENT, UTIME, IS_DEL) VALUES ('{uid}', '{do_type}', '{asset}', {to}{}, {ctg}, \
                     {money}{}, 'c-twd', '2026-10-08', '1791000000000', '備註', 1791000000001, {del})",
                    tx_val(trans),
                    if skip_in { String::new() } else { format!(", {in_money}") }
                ))
                .execute(&mut c)
                .await
                .unwrap();
            }
        }
        // 第③階段三張表（欄＝值的 SQL 字面；skip_col 指到的欄連值一起拿掉）。無 affinity：REAL 照 REAL 存、字串照字串存
        let plan_rows: Vec<(&str, Vec<Vec<(&str, &str)>>)> = vec![
            (
                "BUDGET",
                vec![
                    vec![
                        ("uid", "'b-total'"), ("targetUid", "NULL"), ("DO_TYPE", "1"), ("PERIOD_TYPE", "6"), ("IS_TOTAL", "1"),
                        ("IS_DEL", "0"), ("TRANSFER_TYPE", "0"), ("MODIFY_DATE", "1791000000010"),
                    ],
                    vec![
                        ("uid", "'b-food'"), ("targetUid", "'k-food'"), ("DO_TYPE", "1"), ("PERIOD_TYPE", "6"), ("IS_TOTAL", "0"),
                        ("IS_DEL", "0"), ("TRANSFER_TYPE", "0"), ("MODIFY_DATE", "1791000000011"),
                    ],
                ],
            ),
            (
                "BUDGET_AMOUNT",
                vec![
                    vec![
                        ("uid", "'ba1'"), ("budgetUid", "'b-total'"), ("IS_DEL", "0"), ("AMOUNT", "15000.0"),
                        ("BUDGET_PERIOD", "0"), ("MODIFY_DATE", "1791000000012"),
                    ],
                    vec![
                        ("uid", "'ba2'"), ("budgetUid", "'b-total'"), ("IS_DEL", "0"), ("AMOUNT", "12000.5"),
                        ("BUDGET_PERIOD", "202601"), ("MODIFY_DATE", "1791000000013"),
                    ],
                    vec![
                        ("uid", "'ba3'"), ("budgetUid", "'b-food'"), ("IS_DEL", "1"), ("AMOUNT", "'3000'"),
                        ("BUDGET_PERIOD", "'202602'"), ("MODIFY_DATE", "1791000000014"),
                    ],
                ],
            ),
            (
                "REPEATTRANSACTION",
                vec![
                    vec![
                        ("uid", "'r1'"), ("IS_DEL", "0"), ("USETIME", "1791000000020"), ("END_DATE", "0"),
                        ("NEXT_DATE", "1793000000000"), ("DO_TYPE", "1"), ("REPEAT_TYPE", "1"), ("assetUid", "'a-cash'"),
                        ("toAssetUid", "''"), ("ctgUid", "'k-lunch'"), ("currencyUid", "'c-usd'"), ("AMOUNT_SUB", "12.5"),
                        ("MEMO", "''"), ("PAYEE", "'雲端'"),
                    ],
                    vec![
                        ("uid", "'r2'"), ("IS_DEL", "1"), ("USETIME", "1791000000021"), ("END_DATE", "1800000000000"),
                        ("NEXT_DATE", "1793000000001"), ("DO_TYPE", "0"), ("REPEAT_TYPE", "9"), ("assetUid", "'a-card'"),
                        ("toAssetUid", "NULL"), ("ctgUid", "NULL"), ("currencyUid", "NULL"), ("AMOUNT_SUB", "300"),
                        ("MEMO", "NULL"), ("PAYEE", "NULL"),
                    ],
                ],
            ),
        ];
        for (t, rows) in plan_rows {
            if !has(t) {
                continue;
            }
            for row in rows {
                let row: Vec<(&str, &str)> = row.into_iter().filter(|(col, _)| skip_col != Some((t, *col))).collect();
                let cs: Vec<&str> = row.iter().map(|x| x.0).collect();
                let vs: Vec<&str> = row.iter().map(|x| x.1).collect();
                sqlx::query(&format!("INSERT INTO {t} ({}) VALUES ({})", cs.join(", "), vs.join(", ")))
                    .execute(&mut c)
                    .await
                    .unwrap();
            }
        }
        let _ = c.close().await;
    }

    fn read(path: &Path) -> MmbakReadResult {
        tauri::async_runtime::block_on(read_dump(path, "MM.mmbak")).unwrap()
    }

    #[test]
    fn a_完整九表_讀出全部欄值() {
        let p = temp_db("full");
        tauri::async_runtime::block_on(make(&p, None, None, None));
        let r = read(&p);
        assert!(r.missing.is_empty(), "{:?}", r.missing);
        let d = r.dump.expect("dump");
        assert_eq!(d.file_name, "MM.mmbak");

        // 排序欄生效：ORDER_SEQ／ORDERSEQ 小的在前（插入順序相反）
        assert_eq!(d.currencies.len(), 2);
        assert_eq!(d.currencies[0].iso, "TWD");
        assert!(d.currencies[0].is_main);
        assert_eq!(d.currencies[1].uid, "c-usd");
        assert_eq!(d.currencies[1].rate, "31.549671");
        assert_eq!(d.currencies[1].decimals, 2);
        assert!(!d.currencies[1].is_main);

        assert_eq!(d.groups.len(), 2);
        assert_eq!(d.groups[0].name, "現金");
        assert_eq!(d.groups[0].type_code, Some(1));

        assert_eq!(d.accounts.len(), 2);
        assert_eq!(d.accounts[0].uid, "a-cash");
        assert_eq!(d.accounts[0].name, "現金");
        assert_eq!(d.accounts[0].group_uid.as_deref(), Some("g-cash"));
        assert_eq!(d.accounts[0].currency_uid.as_deref(), Some("c-twd"));
        assert!(!d.accounts[0].is_del); // 樣本 ASSETS 沒有刪除欄 ⇒ 一律 false

        assert_eq!(d.categories.len(), 3);
        assert_eq!(d.categories[0].name, "🍜 食物");
        assert_eq!(d.categories[0].parent_uid, None);
        assert!(!d.categories[0].is_del); // C_IS_DEL NULL ⇒ 未刪
        assert_eq!(d.categories[1].parent_uid.as_deref(), Some("k-food"));
        assert_eq!(d.categories[1].status, 2);
        assert!(d.categories[2].is_del);
        assert_eq!(d.categories[2].type_code, 0);

        assert_eq!(d.transactions.len(), 4);
        let t1 = &d.transactions[0];
        assert_eq!(t1.uid, "t1");
        assert_eq!(t1.do_type, "1");
        assert_eq!(t1.zmoney, "120");
        assert_eq!(t1.in_zmoney.as_deref(), Some("4")); // 原幣額與 ZMONEY 不同時照讀（外幣列）
        assert_eq!(d.transactions[2].in_zmoney, None); // NULL ⇒ None
        assert_eq!(t1.wdate, "2026-10-08");
        assert_eq!(t1.zdate, "1791000000000");
        assert_eq!(t1.content, "備註");
        assert_eq!(t1.utime, 1791000000001);
        assert_eq!(t1.to_asset_uid, None);
        let t2 = &d.transactions[1];
        assert_eq!(t2.to_asset_uid.as_deref(), Some("a-card"));
        assert_eq!(t2.tx_uid_trans.as_deref(), Some("x1"));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn b_少_assets_表_回_missing() {
        let p = temp_db("noassets");
        tauri::async_runtime::block_on(make(&p, None, Some("ASSETS"), None));
        let r = read(&p);
        assert_eq!(r.missing, vec!["ASSETS".to_string()]);
        assert!(r.dump.is_none());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn c_少_txuidtrans_欄_回_表點欄() {
        let p = temp_db("nocol");
        tauri::async_runtime::block_on(make(&p, None, None, Some(("INOUTCOME", "txUidTrans"))));
        let r = read(&p);
        assert_eq!(r.missing, vec!["INOUTCOME.txUidTrans".to_string()]);
        assert!(r.dump.is_none());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn d_表名小寫照樣認得() {
        let p = temp_db("lower");
        tauri::async_runtime::block_on(make(&p, Some(("ZCATEGORY", "zcategory")), None, None));
        let r = read(&p);
        assert!(r.missing.is_empty(), "{:?}", r.missing);
        assert_eq!(r.dump.unwrap().categories.len(), 3);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn e_zmoney_以_real_存_讀出字串() {
        let p = temp_db("real");
        tauri::async_runtime::block_on(make(&p, None, None, None));
        let d = read(&p).dump.unwrap();
        let t4 = d.transactions.iter().find(|t| t.uid == "t4").unwrap();
        assert_eq!(t4.zmoney, "120.0");
        assert_eq!(t4.in_zmoney.as_deref(), Some("120.0"));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn e2_沒有_in_zmoney_欄_讀得下去_回_none() {
        let p = temp_db("noinzm");
        tauri::async_runtime::block_on(make(&p, None, None, Some(("INOUTCOME", "IN_ZMONEY"))));
        let r = read(&p);
        assert!(r.missing.is_empty(), "{:?}", r.missing);
        assert!(r.dump.unwrap().transactions.iter().all(|t| t.in_zmoney.is_none()));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn f_check_magic_擋非_sqlite() {
        assert!(check_magic(b"SQLite format 3\0rest-of-header").is_ok());
        let e = check_magic("這只是一段文字，不是資料庫".as_bytes()).unwrap_err();
        assert!(e.contains("檔頭對不上"), "{e}");
        assert!(check_magic(&[0u8; 4096]).is_err());
        assert!(check_magic(b"SQLite").is_err());
    }

    #[test]
    fn g_is_del_的列照樣回傳() {
        let p = temp_db("del");
        tauri::async_runtime::block_on(make(&p, None, None, None));
        let d = read(&p).dump.unwrap();
        let t3 = d.transactions.iter().find(|t| t.uid == "t3").unwrap();
        assert!(t3.is_del);
        assert!(d.categories.iter().any(|c| c.uid == "k-old" && c.is_del));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn h_三張管帳表完整_plan_missing_空_欄值照讀() {
        let p = temp_db("plan");
        tauri::async_runtime::block_on(make(&p, None, None, None));
        let r = read(&p);
        assert!(r.missing.is_empty(), "{:?}", r.missing);
        let d = r.dump.expect("dump");
        assert!(d.plan_missing.is_empty(), "{:?}", d.plan_missing);

        let b = d.budgets.expect("budgets");
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].uid, "b-total");
        assert_eq!(b[0].target_uid, None);
        assert!(b[0].is_total);
        assert!(!b[0].is_del);
        assert_eq!((b[0].do_type, b[0].period_type, b[0].transfer_type), (1, 6, 0));
        assert_eq!(b[0].modify_date, 1791000000010);
        assert_eq!(b[1].target_uid.as_deref(), Some("k-food"));
        assert!(!b[1].is_total);

        let a = d.budget_amounts.expect("budget_amounts");
        assert_eq!(a.len(), 3);
        assert_eq!(a[0].uid, "ba1");
        assert_eq!(a[0].budget_uid, "b-total");
        assert_eq!(a[0].budget_period, 0);
        assert_eq!(a[0].modify_date, 1791000000012);
        assert!(a[2].is_del); // IS_DEL=1 照樣回傳（TS 判）
        assert_eq!(a[2].amount, "3000");

        let rp = d.repeats.expect("repeats");
        assert_eq!(rp.len(), 2);
        let r1 = &rp[0];
        assert_eq!(r1.uid, "r1");
        assert!(!r1.is_del);
        assert_eq!((r1.usetime, r1.end_date, r1.next_date), (1791000000020, 0, 1793000000000));
        assert_eq!((r1.do_type, r1.repeat_type), (1, 1));
        assert_eq!(r1.asset_uid.as_deref(), Some("a-cash"));
        assert_eq!(r1.to_asset_uid.as_deref(), Some("")); // 空字串原樣（只讀不解讀；TS 當沒有）
        assert_eq!(r1.ctg_uid.as_deref(), Some("k-lunch"));
        assert_eq!(r1.currency_uid.as_deref(), Some("c-usd"));
        assert_eq!((r1.memo.as_str(), r1.payee.as_str()), ("", "雲端"));
        let r2 = &rp[1];
        assert!(r2.is_del);
        assert_eq!((r2.end_date, r2.repeat_type), (1800000000000, 9)); // 不認得的週期碼也照讀
        assert_eq!((r2.to_asset_uid.clone(), r2.ctg_uid.clone(), r2.currency_uid.clone()), (None, None, None));
        assert_eq!((r2.memo.as_str(), r2.payee.as_str()), ("", "")); // NULL ⇒ ''
        assert_eq!(r2.amount_sub, "300");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn i_管帳表缺欄不擋_那張給_none_交易照讀() {
        let p = temp_db("plancol");
        tauri::async_runtime::block_on(make(&p, None, None, Some(("BUDGET", "targetUid"))));
        let r = read(&p);
        assert!(r.missing.is_empty(), "{:?}", r.missing); // 不進 REQUIRED_COLUMNS（0-17）
        let d = r.dump.expect("dump 仍 Some");
        assert!(d.budgets.is_none());
        assert_eq!(d.plan_missing, vec!["BUDGET.targetUid".to_string()]);
        assert_eq!(d.budget_amounts.map(|v| v.len()), Some(3));
        assert_eq!(d.repeats.map(|v| v.len()), Some(2));
        assert_eq!(d.transactions.len(), 4);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());

        let p = temp_db("plancol2");
        tauri::async_runtime::block_on(make(&p, None, None, Some(("REPEATTRANSACTION", "PAYEE"))));
        let d = read(&p).dump.expect("dump 仍 Some");
        assert!(d.repeats.is_none());
        assert_eq!(d.plan_missing, vec!["REPEATTRANSACTION.PAYEE".to_string()]);
        assert_eq!(d.budgets.map(|v| v.len()), Some(2));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn j_金額以_real_存_讀出字串_期間讀成整數() {
        let p = temp_db("planreal");
        tauri::async_runtime::block_on(make(&p, None, None, None));
        let d = read(&p).dump.unwrap();
        let rp = d.repeats.unwrap();
        assert_eq!(rp[0].amount_sub, "12.5");
        let a = d.budget_amounts.unwrap();
        assert_eq!(a[0].amount, "15000.0");
        assert_eq!(a[1].amount, "12000.5");
        assert_eq!(a[1].budget_period, 202601);
        assert_eq!(a[2].budget_period, 202602); // 存成字串也讀成整數
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn 顯示檔名取最後一段() {
        assert_eq!(display_name(r"C:\Users\x\files\MM(2026-10-10).mmbak"), "MM(2026-10-10).mmbak");
        assert_eq!(display_name("/storage/emulated/0/Download/MM.mmbak"), "MM.mmbak");
        assert_eq!(
            display_name("content://com.android.externalstorage.documents/document/primary%3ADownload%2FMM%20x.mmbak"),
            "MM x.mmbak"
        );
        assert_eq!(display_name(""), "備份檔");
        assert_eq!(display_name("C:/dir/"), "備份檔");
    }

    #[test]
    fn 顯示檔名_content_uri_文件編號不當檔名() {
        // 實測 bug：Android 選檔器回 `.../document/msf%3A1093`，最後一段是文件編號
        assert_eq!(
            display_name("content://com.android.providers.downloads.documents/document/msf%3A1093"),
            "財務管家備份"
        );
        assert_eq!(display_name("content://com.android.providers.downloads.documents/document/1093"), "財務管家備份");
        // 帶 .mmbak 的最後一段照舊顯示（含大寫副檔名）
        assert_eq!(
            display_name("content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2FMM-copy.mmbak"),
            "MM-copy.mmbak"
        );
        assert_eq!(display_name("content://media/external/file/MM.MMBAK"), "MM.MMBAK");
        // 桌機路徑不受影響（大寫副檔名、非 .mmbak 副檔名都照顯示）
        assert_eq!(display_name(r"C:\Users\x\MM-copy.MMBAK"), "MM-copy.MMBAK");
        assert_eq!(display_name(r"C:\Users\x\backup.bin"), "backup.bin");
    }

    #[test]
    fn 顯示檔名_優先用系統回報的真檔名() {
        let uri = "content://com.android.providers.downloads.documents/document/msf%3A1093";
        assert_eq!(pick_display_name(Some("MM-copy.mmbak".into()), uri), "MM-copy.mmbak");
        assert_eq!(pick_display_name(Some("  MM(1).mmbak ".into()), uri), "MM(1).mmbak");
        // 查不到／空白 ⇒ 退回 display_name
        assert_eq!(pick_display_name(None, uri), "財務管家備份");
        assert_eq!(pick_display_name(Some("  ".into()), uri), "財務管家備份");
        assert_eq!(pick_display_name(None, r"C:\x\MM.mmbak"), "MM.mmbak");
    }

    #[test]
    fn 數字欄避開科學記號() {
        let p = temp_db("exp");
        tauri::async_runtime::block_on(async {
            make(&p, None, None, None).await;
            let mut c = SqliteConnectOptions::new().filename(&p).connect().await.unwrap();
            sqlx::query("UPDATE CURRENCY SET RATE = 0.00001234 WHERE uid = 'c-usd'").execute(&mut c).await.unwrap();
            let _ = c.close().await;
        });
        let d = read(&p).dump.unwrap();
        let usd = d.currencies.iter().find(|x| x.uid == "c-usd").unwrap();
        assert_eq!(usd.rate, "0.00001234");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }
}
