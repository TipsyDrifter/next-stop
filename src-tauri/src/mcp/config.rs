//! `<app_config_dir>/mcp.json`：埠、連線金鑰、五個功能的開關（契約 §3、§5；D-主-92）。
//!
//! 不進 DB（不進備份、不進雲端快照、不同步）——各台各自的信任設定。第一次沒有檔就建（預設全關）；
//! 壞檔備份成 `mcp.json.bad` 再重建（金鑰會換新，已接上的助理要重貼設定）。
//!
//! 鐵則：`McpConfig` 的 Debug 不印金鑰。

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "mcp.json";
pub const CONFIG_VERSION: u32 = 1;

/// 埠表（D-主-93：照 identifier 固定、被占用不換）。identifier 與 `scripts/dev-line.ts` 的 DEV_QUOTA 對帳（見測試）。
pub const PORT_TABLE: &[(&str, u16)] = &[
    ("app.shitetsu.nextstop", 18920),
    ("app.shitetsu.nextstop.dev", 18921),
    ("app.shitetsu.nextstop.dev.notes", 18922),
    ("app.shitetsu.nextstop.dev.timetable", 18923),
    ("app.shitetsu.nextstop.dev.ticket", 18924),
    ("app.shitetsu.nextstop.dev.core", 18925),
    ("app.shitetsu.nextstop.sandbox.a", 18931),
    ("app.shitetsu.nextstop.sandbox.b", 18932),
];
/// 表上沒有的 identifier（臨時沙盒等）
pub const FALLBACK_PORT: u16 = 18940;

pub fn port_for(identifier: &str) -> u16 {
    let id = identifier.trim();
    PORT_TABLE
        .iter()
        .find(|(k, _)| *k == id)
        .map(|(_, p)| *p)
        .unwrap_or(FALLBACK_PORT)
}

/// 一個功能開到哪。順序有意義：Off < Read < Write（可改＝含只看）
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    #[default]
    Off,
    Read,
    Write,
}

/// 設定頁〈外部助理〉的五個功能（＝TS `McpModule`）
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Module {
    Tasks,
    Timetable,
    Notes,
    Diary,
    Ledger,
}

impl Module {
    pub const ALL: [Module; 5] = [
        Module::Tasks,
        Module::Timetable,
        Module::Notes,
        Module::Diary,
        Module::Ledger,
    ];

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn key(self) -> &'static str {
        match self {
            Module::Tasks => "tasks",
            Module::Timetable => "timetable",
            Module::Notes => "notes",
            Module::Diary => "diary",
            Module::Ledger => "ledger",
        }
    }

    /// 與 TS `MCP_MODULE_LABEL` 同字（測試對帳）
    pub fn label(self) -> &'static str {
        match self {
            Module::Tasks => "任務",
            Module::Timetable => "時刻表",
            Module::Notes => "筆記",
            Module::Diary => "日記",
            Module::Ledger => "帳目",
        }
    }
}

/// 五個開關；檔案裡缺哪一個＝關
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(default)]
pub struct AccessMap {
    pub tasks: Access,
    pub timetable: Access,
    pub notes: Access,
    pub diary: Access,
    pub ledger: Access,
}

impl AccessMap {
    pub fn get(&self, m: Module) -> Access {
        match m {
            Module::Tasks => self.tasks,
            Module::Timetable => self.timetable,
            Module::Notes => self.notes,
            Module::Diary => self.diary,
            Module::Ledger => self.ledger,
        }
    }

    pub fn set(&mut self, m: Module, a: Access) {
        match m {
            Module::Tasks => self.tasks = a,
            Module::Timetable => self.timetable = a,
            Module::Notes => self.notes = a,
            Module::Diary => self.diary = a,
            Module::Ledger => self.ledger = a,
        }
    }

    /// 總覽能不能用：五個裡任一 ≥ 只看
    pub fn any_readable(&self) -> bool {
        Module::ALL.iter().any(|m| self.get(*m) >= Access::Read)
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct McpConfig {
    pub version: u32,
    /// 0＝照埠表補
    #[serde(default)]
    pub port: u16,
    /// 32 bytes 隨機、base64url 無 padding（43 字）
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub access: AccessMap,
}

impl fmt::Debug for McpConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpConfig")
            .field("version", &self.version)
            .field("port", &self.port)
            .field("token", &"<redacted>")
            .field("access", &self.access)
            .finish()
    }
}

impl McpConfig {
    /// 全新的一份：預設全關、新金鑰
    pub fn fresh(identifier: &str) -> Result<Self, String> {
        Ok(Self {
            version: CONFIG_VERSION,
            port: port_for(identifier),
            token: new_token()?,
            access: AccessMap::default(),
        })
    }

    /// 連金鑰都產不出來時的退路（空金鑰＝誰都進不來）
    pub fn locked(identifier: &str) -> Self {
        Self {
            version: CONFIG_VERSION,
            port: port_for(identifier),
            token: String::new(),
            access: AccessMap::default(),
        }
    }
}

pub fn new_token() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|_| "取得系統亂數失敗。".to_string())?;
    Ok(B64.encode(buf))
}

pub fn bad_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".bad");
    PathBuf::from(s)
}

/// 讀設定；沒有就建、壞了備份成 `.bad` 再建。讀不到（權限等 IO 錯）不覆寫、直接回錯。
pub fn load_or_init(path: &Path, identifier: &str) -> Result<McpConfig, String> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("讀不到外部助理設定（{}）：{e}", path.display())),
    };
    let Some(raw) = raw else {
        let cfg = McpConfig::fresh(identifier)?;
        save(path, &cfg)?;
        return Ok(cfg);
    };
    match serde_json::from_str::<McpConfig>(&raw) {
        Ok(mut cfg) => {
            let mut dirty = false;
            if cfg.port == 0 {
                cfg.port = port_for(identifier);
                dirty = true;
            }
            if cfg.token.trim().is_empty() {
                cfg.token = new_token()?;
                dirty = true;
            }
            if dirty {
                save(path, &cfg)?;
            }
            Ok(cfg)
        }
        Err(e) => {
            let bad = bad_path(path);
            eprintln!(
                "[mcp] mcp.json 壞了（{e}），備份成 {} 再重建",
                bad.display()
            );
            if let Err(e) = fs::rename(path, &bad) {
                eprintln!("[mcp] 備份壞檔失敗（照樣重建）：{e}");
            }
            let cfg = McpConfig::fresh(identifier)?;
            save(path, &cfg)?;
            Ok(cfg)
        }
    }
}

/// 先寫 `.tmp` 再 rename（Windows 的 rename 會蓋掉舊檔）
pub fn save(path: &Path, cfg: &McpConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("建立設定資料夾失敗：{e}"))?;
    }
    let json =
        serde_json::to_string_pretty(cfg).map_err(|e| format!("外部助理設定序列化失敗：{e}"))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, json).map_err(|e| format!("寫入外部助理設定失敗：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("寫入外部助理設定失敗：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ns-mcp-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 第一次建檔_預設全關且金鑰43字() {
        let d = temp_dir();
        let p = d.join(CONFIG_FILE);
        let cfg = load_or_init(&p, "app.shitetsu.nextstop").unwrap();
        assert_eq!(cfg.access, AccessMap::default());
        for m in Module::ALL {
            assert_eq!(cfg.access.get(m), Access::Off);
        }
        assert!(!cfg.access.any_readable());
        assert_eq!(cfg.port, 18920);
        assert_eq!(cfg.token.len(), 43);
        assert!(cfg
            .token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(p.exists());
        // 再讀一次＝同一份（不會每次開 App 換金鑰）
        assert_eq!(load_or_init(&p, "app.shitetsu.nextstop").unwrap(), cfg);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn 讀寫往返() {
        let d = temp_dir();
        let p = d.join(CONFIG_FILE);
        let mut cfg = McpConfig::fresh("app.shitetsu.nextstop.dev.ticket").unwrap();
        cfg.access.set(Module::Tasks, Access::Write);
        cfg.access.set(Module::Ledger, Access::Read);
        save(&p, &cfg).unwrap();
        let back = load_or_init(&p, "whatever").unwrap();
        assert_eq!(back, cfg);
        assert_eq!(back.port, 18924);
        assert_eq!(back.access.get(Module::Tasks), Access::Write);
        assert_eq!(back.access.get(Module::Notes), Access::Off);
        // 檔案用小寫字
        let raw = fs::read_to_string(&p).unwrap();
        assert!(raw.contains("\"tasks\": \"write\""));
        assert!(raw.contains("\"ledger\": \"read\""));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn 壞檔備份再重建() {
        let d = temp_dir();
        let p = d.join(CONFIG_FILE);
        fs::write(&p, "{ not json").unwrap();
        let cfg = load_or_init(&p, "app.shitetsu.nextstop.sandbox.a").unwrap();
        assert_eq!(cfg.port, 18931);
        assert!(!cfg.access.any_readable());
        assert_eq!(fs::read_to_string(bad_path(&p)).unwrap(), "{ not json");
        // 不認得的開關值也算壞檔
        fs::write(
            &p,
            r#"{"version":1,"port":18920,"token":"x","access":{"tasks":"rw"}}"#,
        )
        .unwrap();
        let cfg2 = load_or_init(&p, "app.shitetsu.nextstop").unwrap();
        assert_ne!(cfg2.token, "x");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn 缺欄位補齊_缺開關算關() {
        let d = temp_dir();
        let p = d.join(CONFIG_FILE);
        fs::write(&p, r#"{"version":1,"access":{"notes":"read"}}"#).unwrap();
        let cfg = load_or_init(&p, "app.shitetsu.nextstop.dev").unwrap();
        assert_eq!(cfg.port, 18921);
        assert_eq!(cfg.token.len(), 43);
        assert_eq!(cfg.access.get(Module::Notes), Access::Read);
        assert_eq!(cfg.access.get(Module::Diary), Access::Off);
        // 補過的有寫回
        assert_eq!(load_or_init(&p, "app.shitetsu.nextstop.dev").unwrap(), cfg);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn 埠表() {
        assert_eq!(port_for("app.shitetsu.nextstop"), 18920);
        assert_eq!(port_for("app.shitetsu.nextstop.dev"), 18921);
        assert_eq!(port_for("app.shitetsu.nextstop.dev.notes"), 18922);
        assert_eq!(port_for("app.shitetsu.nextstop.dev.timetable"), 18923);
        assert_eq!(port_for("app.shitetsu.nextstop.dev.ticket"), 18924);
        assert_eq!(port_for("app.shitetsu.nextstop.dev.core"), 18925);
        assert_eq!(port_for("app.shitetsu.nextstop.sandbox.a"), 18931);
        assert_eq!(port_for("app.shitetsu.nextstop.sandbox.b"), 18932);
        assert_eq!(port_for("app.shitetsu.nextstop.sandbox.zzz"), FALLBACK_PORT);
        assert_eq!(port_for(""), FALLBACK_PORT);
        // 埠不重複
        let mut ports: Vec<u16> = PORT_TABLE.iter().map(|(_, p)| *p).collect();
        ports.push(FALLBACK_PORT);
        let n = ports.len();
        ports.sort_unstable();
        ports.dedup();
        assert_eq!(ports.len(), n);
    }

    /// `scripts/dev-line.ts` 的每個 dev identifier 都要在埠表上（新開一條線忘了配埠會撞 18940）
    #[test]
    fn 埠表與_dev_line_對帳() {
        let src = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scripts/dev-line.ts"
        ))
        .expect("讀 scripts/dev-line.ts");
        let mut seen = 0;
        for piece in src.split("identifier: \"").skip(1) {
            let id = piece.split('"').next().unwrap();
            assert!(
                PORT_TABLE.iter().any(|(k, _)| *k == id),
                "dev-line.ts 的 {id} 不在 mcp 埠表上"
            );
            seen += 1;
        }
        assert!(
            seen >= 5,
            "dev-line.ts 的 identifier 格式變了？只找到 {seen} 個"
        );
        // 正式版的 identifier 也在
        let conf =
            fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).unwrap();
        assert!(conf.contains("\"identifier\": \"app.shitetsu.nextstop\""));
    }

    /// 功能名稱與 TS `MCP_MODULE_LABEL` 同字（被擋時助理收到的那句話兩邊一致）
    #[test]
    fn 功能名稱與_ts_對帳() {
        let src = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/mcp/types.ts"))
            .expect("讀 src/mcp/types.ts");
        let block = src
            .split("MCP_MODULE_LABEL")
            .nth(1)
            .expect("找不到 MCP_MODULE_LABEL");
        for m in Module::ALL {
            let needle = format!("{}: \"{}\"", m.key(), m.label());
            assert!(block.contains(&needle), "TS 那邊沒有 {needle}");
        }
    }

    #[test]
    fn debug_不印金鑰() {
        let cfg = McpConfig::fresh("app.shitetsu.nextstop").unwrap();
        let s = format!("{cfg:?}");
        assert!(!s.contains(&cfg.token));
    }
}
