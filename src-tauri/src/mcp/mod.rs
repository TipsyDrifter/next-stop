//! 外部助理（MCP）——Rust 端只當門口（契約 `docs/research/2026-10-25-主線-MCP接口班-契約.md` §3、§5；D-主-90～95）。
//!
//! 分工：
//!   * `config`   ─ `<app_config_dir>/mcp.json`（埠、金鑰、五個開關）、埠表
//!   * `server`   ─ 127.0.0.1:<埠> 的 Streamable HTTP（rmcp＋axum）：Bearer／Origin／Host 把關、開關把關
//!   * `bridge`   ─ `tools/call` 轉給主視窗 WebView（`mcp:call` 事件 → `mcp_reply`），30 秒逾時
//!   * `stdio`    ─ `私鐵手帳.exe --mcp-stdio`：stdin JSON-RPC ⇄ 本機 HTTP（Claude 桌面版一般聊天用，D-主-91）
//!   * `commands` ─ 六支 `#[tauri::command]`（設定頁〈外部助理〉與 `src/mcp/McpBridge.tsx` 用）
//!
//! 工具本身全在 TS（`src/mcp/`）用既有 repository 執行；這裡不碰 DB、不寫 SQL。
//! 掛載（`lib.rs`，主 session 接線）：`#[cfg(desktop)] mod mcp;`＋桌機 builder `.plugin(mcp::init())`＋
//!   桌機 `generate_handler!` 六支；`main.rs` 看到 `--mcp-stdio` 就 `run_stdio_bridge()` 後 exit。

pub mod bridge;
pub mod commands;
pub mod config;
pub mod server;
pub mod stdio;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Emitter, Manager, Wry,
};

pub use stdio::run_stdio_bridge;

use config::{Access, AccessMap, McpConfig, Module};

/// 事件只送主視窗（捕捉小窗不掛 bridge）
pub const MAIN_WINDOW: &str = "main";
pub const BLOCKED_EVENT: &str = "mcp:blocked";
/// 最近紀錄留幾筆（記憶體，重開 App 清空；D-主-95）
pub const RECENT_CAP: usize = 50;

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 工具歸屬：五個功能之一，或總覽（任一功能可讀就能用）
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolModule {
    Overview,
    Tasks,
    Timetable,
    Notes,
    Diary,
    Ledger,
}

impl ToolModule {
    pub fn module(self) -> Option<Module> {
        match self {
            ToolModule::Overview => None,
            ToolModule::Tasks => Some(Module::Tasks),
            ToolModule::Timetable => Some(Module::Timetable),
            ToolModule::Notes => Some(Module::Notes),
            ToolModule::Diary => Some(Module::Diary),
            ToolModule::Ledger => Some(Module::Ledger),
        }
    }
}

/// TS `McpToolSpec`（`src/mcp/types.ts`）——`mcp_register_tools` 收的形狀
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: serde_json::Map<String, serde_json::Value>,
    pub module: ToolModule,
    /// read＝只看就能用；write＝要「可改」
    pub access: Access,
    pub annotations: ToolHints,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolHints {
    pub read_only_hint: bool,
    pub destructive_hint: bool,
    #[serde(default)]
    pub idempotent_hint: Option<bool>,
    #[serde(default)]
    pub open_world_hint: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RecentKind {
    Write,
    Blocked,
    Error,
}

/// 最近紀錄一筆（設定頁〈外部助理〉的清單）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    /// 本地時間 RFC 3339（到秒，帶時區），UI 自己切 HH:MM
    pub at: String,
    pub kind: RecentKind,
    pub module: ToolModule,
    pub tool: String,
    pub summary: String,
}

#[derive(Default)]
struct Listen {
    listening: bool,
    error: Option<String>,
}

/// `app.manage(Arc<McpState>)`；HTTP server 與 commands 共用同一顆
pub struct McpState {
    /// None＝拿不到 app_config_dir（設定只在記憶體）
    config_path: Option<PathBuf>,
    config: Mutex<McpConfig>,
    /// None＝WebView 還沒註冊（還在啟動）
    tools: RwLock<Option<Arc<Vec<ToolSpec>>>>,
    recent: Mutex<VecDeque<RecentEntry>>,
    listen: Mutex<Listen>,
    /// 設定檔讀寫的錯（與埠的錯分開記，狀態一起回）
    config_error: Mutex<Option<String>>,
    pub(crate) bridge: bridge::Bridge,
}

impl McpState {
    pub fn new(config: McpConfig, config_path: Option<PathBuf>) -> Self {
        Self {
            config_path,
            config: Mutex::new(config),
            tools: RwLock::new(None),
            recent: Mutex::new(VecDeque::with_capacity(RECENT_CAP)),
            listen: Mutex::new(Listen::default()),
            config_error: Mutex::new(None),
            bridge: bridge::Bridge::default(),
        }
    }

    pub fn port(&self) -> u16 {
        lock(&self.config).port
    }

    pub fn token(&self) -> String {
        lock(&self.config).token.clone()
    }

    pub fn access(&self) -> AccessMap {
        lock(&self.config).access
    }

    fn persist(&self, cfg: &McpConfig) -> Result<(), String> {
        let Some(path) = &self.config_path else {
            return Err("找不到 App 設定資料夾，外部助理設定只在這次開著時有效。".into());
        };
        config::save(path, cfg)
    }

    /// 改一個開關並寫回 mcp.json；寫不進去就不改（畫面與檔案保持一致）
    pub fn set_access(&self, m: Module, a: Access) -> Result<(), String> {
        let mut cfg = lock(&self.config);
        let mut next = cfg.clone();
        next.access.set(m, a);
        self.persist(&next)?;
        *cfg = next;
        Ok(())
    }

    /// 重新產生金鑰：舊的立刻失效（middleware 每次都對照當下的金鑰）
    pub fn rotate_token(&self) -> Result<(), String> {
        let mut cfg = lock(&self.config);
        let mut next = cfg.clone();
        next.token = config::new_token()?;
        self.persist(&next)?;
        *cfg = next;
        Ok(())
    }

    pub fn set_tools(&self, tools: Vec<ToolSpec>) -> usize {
        let n = tools.len();
        *self.tools.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(tools));
        n
    }

    pub fn tools(&self) -> Option<Arc<Vec<ToolSpec>>> {
        self.tools.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn push_recent(&self, kind: RecentKind, module: ToolModule, tool: &str, summary: String) {
        let entry = RecentEntry {
            at: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
            kind,
            module,
            tool: tool.to_string(),
            summary,
        };
        let mut q = lock(&self.recent);
        while q.len() >= RECENT_CAP {
            q.pop_front();
        }
        q.push_back(entry);
    }

    /// 新的在前
    pub fn recent(&self) -> Vec<RecentEntry> {
        lock(&self.recent).iter().rev().cloned().collect()
    }

    pub(crate) fn set_listening(&self) {
        let mut l = lock(&self.listen);
        l.listening = true;
        l.error = None;
    }

    pub(crate) fn set_listen_error(&self, e: String) {
        let mut l = lock(&self.listen);
        l.listening = false;
        l.error = Some(e);
    }

    pub(crate) fn set_config_error(&self, e: String) {
        *lock(&self.config_error) = Some(e);
    }

    pub fn status(&self) -> commands::McpStatus {
        let (port, token, access) = {
            let c = lock(&self.config);
            (c.port, c.token.clone(), c.access)
        };
        let (listening, listen_error) = {
            let l = lock(&self.listen);
            (l.listening, l.error.clone())
        };
        let error = match (listen_error, lock(&self.config_error).clone()) {
            (Some(a), Some(b)) => Some(format!("{a}；{b}")),
            (a, b) => a.or(b),
        };
        commands::McpStatus {
            port,
            url: format!("http://127.0.0.1:{port}/mcp"),
            token,
            listening,
            error,
            access,
            tool_count: self.tools().map(|t| t.len()).unwrap_or(0),
            exe_path: std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
        }
    }
}

/// 載入設定、manage 狀態、起 HTTP server。任何一步失敗都只記進狀態（設定頁看得到），App 照常開。
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("mcp")
        .setup(|app, _api| {
            let identifier = app.config().identifier.clone();
            let (cfg, path, err) = match app.path().app_config_dir() {
                Ok(dir) => {
                    let path = dir.join(config::CONFIG_FILE);
                    match config::load_or_init(&path, &identifier) {
                        Ok(c) => (c, Some(path), None),
                        Err(e) => {
                            // 讀不到（不是壞檔）：不覆寫原檔，這次只在記憶體
                            let c = McpConfig::fresh(&identifier)
                                .unwrap_or_else(|_| McpConfig::locked(&identifier));
                            (c, None, Some(e))
                        }
                    }
                }
                Err(e) => {
                    let c = McpConfig::fresh(&identifier)
                        .unwrap_or_else(|_| McpConfig::locked(&identifier));
                    (c, None, Some(format!("找不到 App 設定資料夾（{e}）。")))
                }
            };
            let state = Arc::new(McpState::new(cfg, path));
            if let Some(e) = err {
                eprintln!("[mcp] {e}");
                state.set_config_error(e);
            }
            app.manage(state.clone());

            let handle = app.clone();
            let emit: server::Emit = Arc::new(move |event: &str, payload: serde_json::Value| {
                handle
                    .emit_to(MAIN_WINDOW, event, payload)
                    .map_err(|e| e.to_string())
            });
            tauri::async_runtime::spawn(server::serve(state, emit));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_spec_吃_ts_的形狀() {
        let raw = r#"[{
            "name": "add-tasks",
            "title": "建立車票",
            "description": "建立車票（task）",
            "inputSchema": {"type":"object","properties":{"tasks":{"type":"array"}},"required":["tasks"]},
            "module": "tasks",
            "access": "write",
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}
        },{
            "name": "get-overview",
            "title": "今天的總覽",
            "description": "總覽",
            "inputSchema": {"type":"object","properties":{}},
            "module": "overview",
            "access": "read",
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
        }]"#;
        let specs: Vec<ToolSpec> = serde_json::from_str(raw).unwrap();
        assert_eq!(specs[0].module, ToolModule::Tasks);
        assert_eq!(specs[0].access, Access::Write);
        assert_eq!(specs[0].annotations.idempotent_hint, None);
        assert_eq!(specs[1].module, ToolModule::Overview);
        assert_eq!(specs[1].annotations.idempotent_hint, Some(true));
    }

    #[test]
    fn 最近紀錄最多_50_筆_新的在前() {
        let s = McpState::new(McpConfig::locked("x"), None);
        for i in 0..60 {
            s.push_recent(
                RecentKind::Write,
                ToolModule::Tasks,
                "add-tasks",
                format!("第 {i} 筆"),
            );
        }
        let r = s.recent();
        assert_eq!(r.len(), RECENT_CAP);
        assert_eq!(r[0].summary, "第 59 筆");
        assert_eq!(r[49].summary, "第 10 筆");
        let j = serde_json::to_value(&r[0]).unwrap();
        assert_eq!(j["kind"], "write");
        assert_eq!(j["module"], "tasks");
    }

    #[test]
    fn 沒有設定檔路徑時改開關回錯且不改() {
        let s = McpState::new(McpConfig::locked("x"), None);
        assert!(s.set_access(Module::Tasks, Access::Read).is_err());
        assert_eq!(s.access().get(Module::Tasks), Access::Off);
    }
}
