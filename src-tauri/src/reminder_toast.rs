//! ⑨ 截止提醒（契約 docs/research/2026-11-04-主線-截止提醒-契約.md §5；查證 docs/research/2026-11-04-桌機通知點開回App查證.md 案 A）：
//! 桌機的提醒自己送 toast，因為 tauri-plugin-notification 2.3.3 沒有點擊回呼（2.6.0 才有，但要 tauri ^2.12，本專案鎖 2.11.2）。
//! 點了＝叫出主視窗＋事件 `ns-reminder-open`（payload＝JS 給的 target 字串，這裡當不透明字串）。其他通知照走 `notifyOnce`。
//! 官方只保證通知還在螢幕上時點得到；進了通知中心、或 App 已結束時再點不保證，底線是提醒頁的「最近的提醒」。
//!
//! 只有 Windows 真的送；其他桌機回 Err，JS 退回 `notifyOnce`（通知照響、點了不回 App）。手機整支不編（lib.rs 的 `cfg(desktop)`）。

use tauri::AppHandle;

#[cfg(windows)]
mod imp {
    use super::AppHandle;
    use tauri::Emitter;
    use tauri_winrt_notification::{Duration, Toast};

    const OPEN_EVENT: &str = "ns-reminder-open";

    /// 照 tauri-plugin-notification 2.3.3 `src/desktop.rs` 的判斷（`exe_dir` 以 `\target\debug`／`\target\release` 結尾＝沒安裝）：
    /// AUMID 要跟開始選單捷徑上的一樣（NSIS 設成 identifier）才有 App 自己的名字與圖示；沒安裝就沒有捷徑，
    /// Windows 對沒註冊的 AUMID 不回錯、靜默不顯示，所以退回 PowerShell 的（通知上會顯示 PowerShell）。
    pub(super) fn aumid_for<'a>(exe_dir: &str, identifier: &'a str) -> &'a str {
        use std::path::MAIN_SEPARATOR as SEP;
        if exe_dir.ends_with(format!("{SEP}target{SEP}debug").as_str())
            || exe_dir.ends_with(format!("{SEP}target{SEP}release").as_str())
        {
            Toast::POWERSHELL_APP_ID
        } else {
            identifier
        }
    }

    /// 送出後不留 `Toast`，理由（讀 tauri-winrt-notification 0.7.3 `src/lib.rs` 的 `show`）：
    /// `ToastNotification` 是 `show(&self)` 裡的區域變數，回呼掛在它身上、註冊 token 也丟了；`show` 一回傳，crate 這邊就不再持有它。
    /// `Toast` 只多握一份回呼 delegate 的參考，留在容器裡也留不住 `ToastNotification`——事件的來源不在我們手上，留了沒有作用。
    /// 回呼還會不會來，取決於 Windows 在 `Show` 之後自己是否持有那個物件。notify-rust 4.18 也是 `toast.show()` 後就丟 `Toast`、只留 channel。
    /// 要是實測發現回呼不來，得繞過這個 crate 自己建 `ToastNotification` 並留參考（查證報告 §6 第 1 條）。
    pub(super) fn show(
        app: AppHandle,
        aumid: &str,
        title: &str,
        body: &str,
        target: String,
    ) -> Result<(), String> {
        Toast::new(aumid)
            .title(title)
            .text1(body)
            // 點開只保證在通知還在螢幕上時有效，7 秒太短來不及點
            .duration(Duration::Long)
            // 回呼在系統的執行緒上（不是送出的這條）：視窗操作丟回主執行緒，emit 哪條都行
            .on_activated(move |_action| {
                let handle = app.clone();
                if let Err(e) =
                    app.run_on_main_thread(move || crate::tray::show_main_window(&handle))
                {
                    eprintln!("[reminder_toast] 派回主執行緒失敗：{e}");
                }
                if let Err(e) = app.emit(OPEN_EVENT, target.clone()) {
                    eprintln!("[reminder_toast] 送 {OPEN_EVENT} 事件失敗：{e}");
                }
                Ok(())
            })
            .show()
            .map_err(|e| format!("送提醒通知失敗：{e}"))
    }
}

/// 送一則可以點回 App 的提醒。`target`＝JS `JSON.stringify` 過的落點，點了原樣放進事件 `ns-reminder-open`。
/// async＋`spawn_blocking`：`Toast::show` 是同步的 COM 呼叫，尾端還固定 sleep 10ms，不佔 async 執行緒；回傳值帶回成敗讓 JS 決定要不要退回 `notifyOnce`。
#[cfg(windows)]
#[tauri::command]
pub async fn reminder_toast(
    app: AppHandle,
    title: String,
    body: String,
    target: String,
) -> Result<(), String> {
    let exe = tauri::utils::platform::current_exe().map_err(|e| format!("找不到執行檔：{e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "找不到執行檔所在的資料夾".to_string())?
        .display()
        .to_string();
    let identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        imp::show(
            app,
            imp::aumid_for(&exe_dir, &identifier),
            &title,
            &body,
            target,
        )
    })
    .await
    .map_err(|e| format!("送提醒通知的工作沒跑完：{e}"))?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn reminder_toast(
    _app: AppHandle,
    _title: String,
    _body: String,
    _target: String,
) -> Result<(), String> {
    Err("這個平台沒有可點回 App 的提醒通知".to_string())
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::aumid_for;
    use tauri_winrt_notification::Toast;

    const ID: &str = "app.shitetsu.nextstop";

    #[test]
    fn installed_exe_uses_identifier() {
        assert_eq!(aumid_for(r"C:\Program Files\私鐵手帳", ID), ID);
        assert_eq!(aumid_for(r"C:\Users\me\AppData\Local\私鐵手帳", ID), ID);
    }

    #[test]
    fn dev_build_falls_back_to_powershell() {
        assert_eq!(
            aumid_for(r"C:\repo\src-tauri\target\debug", ID),
            Toast::POWERSHELL_APP_ID
        );
        assert_eq!(
            aumid_for(r"C:\repo\src-tauri\target\release", ID),
            Toast::POWERSHELL_APP_ID
        );
    }

    #[test]
    fn only_exact_target_dirs_count_as_dev() {
        // 跟外掛同一條：只比結尾的完整路徑段，名字裡剛好有 target、debug 的安裝位置不算
        assert_eq!(aumid_for(r"C:\target\debug-tools", ID), ID);
        assert_eq!(aumid_for(r"C:\mytarget\debug", ID), ID);
    }
}
