// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // MCP 接口班（D-主-91）：Claude 桌面版以 stdio 啟動的轉接模式。必須在進 Tauri 之前分流——
    // 單一執行個體外掛會把第二個行程導回主視窗然後結束，轉接就永遠起不來。
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if std::env::args().any(|a| a == "--mcp-stdio") {
        std::process::exit(next_stop_lib::run_mcp_stdio());
    }
    next_stop_lib::run()
}
