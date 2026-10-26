//! 六支 `#[tauri::command]`（桌機 `generate_handler!` 的 MCP 插槽；JSON 形狀 camelCase）。
//!   * 設定頁〈外部助理〉：`mcp_status`／`mcp_set_access`／`mcp_rotate_token`／`mcp_recent`
//!   * `src/mcp/McpBridge.tsx`：`mcp_register_tools`（啟動時、重新載入時）／`mcp_reply`（每次 `mcp:call` 的回覆）

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::bridge::Reply;
use super::config::{Access, AccessMap, Module};
use super::{McpState, RecentEntry, ToolSpec};

/// 不 derive Debug：裡面有金鑰（同 `McpConfig` 的鐵則）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub port: u16,
    /// `http://127.0.0.1:<埠>/mcp`
    pub url: String,
    pub token: String,
    /// 埠有綁起來
    pub listening: bool,
    /// 埠被占用、設定檔讀寫失敗等（沒事＝null）
    pub error: Option<String>,
    pub access: AccessMap,
    /// WebView 註冊上來的工具數（0＝還沒註冊）
    pub tool_count: usize,
    /// App 本體 exe 的絕對路徑（Claude 桌面版 stdio 設定的 `command`）
    pub exe_path: String,
}

#[tauri::command]
pub fn mcp_status(state: State<'_, Arc<McpState>>) -> McpStatus {
    state.status()
}

/// 改一個功能的開關（寫回 mcp.json），回新的狀態
#[tauri::command]
pub fn mcp_set_access(
    state: State<'_, Arc<McpState>>,
    module: Module,
    access: Access,
) -> Result<McpStatus, String> {
    state.set_access(module, access)?;
    Ok(state.status())
}

/// 重新產生金鑰：舊的立刻失效（已接上的助理要重貼設定）
#[tauri::command]
pub fn mcp_rotate_token(state: State<'_, Arc<McpState>>) -> Result<McpStatus, String> {
    state.rotate_token()?;
    Ok(state.status())
}

/// WebView 送上工具表（不含 handler）。再送一次＝WebView 重新載入過：還在等的呼叫全部放掉。回註冊了幾支
#[tauri::command]
pub fn mcp_register_tools(state: State<'_, Arc<McpState>>, tools: Vec<ToolSpec>) -> usize {
    let dropped = state.bridge.fail_all();
    if dropped > 0 {
        eprintln!("[mcp] WebView 重新註冊工具，放掉 {dropped} 個還在等的呼叫");
    }
    state.set_tools(tools)
}

/// `mcp:call` 的回覆。false＝沒人在等（已逾時或 id 不認得）
#[tauri::command]
pub fn mcp_reply(state: State<'_, Arc<McpState>>, reply: Reply) -> bool {
    state.bridge.resolve(reply)
}

/// 最近紀錄（新的在前，最多 50 筆；重開 App 清空）
#[tauri::command]
pub fn mcp_recent(state: State<'_, Arc<McpState>>) -> Vec<RecentEntry> {
    state.recent()
}
