//! 時刻表 ①c：Android 常駐通知（自訂版面、系統跳秒、到着鈕、常用分類格）＋跑太久提醒（AlarmManager）。
//! Rust 端沒有任何命令——JS 的 plugin:tt-notice|<cmd> 在 mobile 由 tauri 轉給 Kotlin（tauri 2.11.2 webview/mod.rs:1859-1901）。
//! 桌機＝空殼（不註冊任何東西；JS 端只在 Android 呼叫）。Kotlin 絕不寫 SQLite（Plan 技術底線 5）。
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.shitetsu.nextstop.ttnotice";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("tt-notice")
        .setup(|_app, _api| {
            // 寫法照 tauri-plugin-notification 2.3.3 src/mobile.rs:15-31；回傳的 PluginHandle 不用存——Rust 不呼叫 Kotlin
            #[cfg(target_os = "android")]
            let _handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "TtNoticePlugin")?;
            Ok(())
        })
        .build()
}
