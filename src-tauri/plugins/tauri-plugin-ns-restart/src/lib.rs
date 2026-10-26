//! 手機殼班 B5：Android 真重啟。
//! `app.restart()` 在 Android＝`exit(0)`（tauri 2.11.2 process.rs 沒有 Android 分支；`current_binary()`
//! 回 app_process64、spawn 必敗）——使用者看到 App 直接關掉、像閃退。
//! 成熟做法（查證 `docs/research/2026-09-29-Android重啟App成熟做法查證.md`）＝前景時
//! `startActivity(launchIntent, NEW_TASK|CLEAR_TASK)` 再結束行程（ProcessPhoenix 同路子）。
//! 桌機＝空殼（不註冊 Android 類別）；`restart_app()` 在非 Android 平台原樣走 `app.restart()`。
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.shitetsu.nextstop.nsrestart";

/// Rust 端要主動呼叫 Kotlin（三個還原流程都從 Rust 收尾後重啟），所以把 PluginHandle 收進 managed state
/// （tt-notice 不存 handle 是因為它只被 JS 叫；這裡反過來）。
#[cfg(target_os = "android")]
struct NsRestartHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ns-restart")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "NsRestartPlugin")?;
                _app.manage(NsRestartHandle(handle));
            }
            Ok(())
        })
        .build()
}

/// 真重啟。呼叫端先做完 DB 收尾（關 pool、WAL checkpoint）再叫——順序與現有三個 `app.restart()` 呼叫點相同。
/// Android：叫 Kotlin 在前景重啟任務。成功時 Kotlin **不回應**、親手 `exitProcess` 結束整個行程，所以
/// `run_mobile_plugin` 會一直擋在這裡直到行程死掉——不能先回應再各自退出，否則 Rust 的 exit 可能搶在
/// startActivity 之前、新任務沒交出去就死了。走到下一行的 `exit(0)` 只有兩種：plugin 沒掛上、或 Kotlin reject
/// （行為退回原狀＝只退出，資料的收尾標記都已落地）。其餘平台：照舊 `app.restart()`。
pub fn restart_app<R: Runtime>(app: &AppHandle<R>) -> ! {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        if let Some(h) = app.try_state::<NsRestartHandle<R>>() {
            let _: Result<serde_json::Value, _> = h.0.run_mobile_plugin("restartApp", ());
        }
        std::process::exit(0);
    }
    #[cfg(not(target_os = "android"))]
    {
        app.restart()
    }
}
