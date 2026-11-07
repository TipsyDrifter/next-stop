//! ⑨ 截止提醒（契約 docs/research/2026-11-04-主線-截止提醒-契約.md §5；查證 docs/research/2026-11-04-桌機通知點開回App查證.md 案 A）：
//! 桌機的提醒自己送 toast，因為 tauri-plugin-notification 2.3.3 沒有點擊回呼（2.6.0 才有，但要 tauri ^2.12，本專案鎖 2.11.2）。
//! 點了由系統開 `<scheme>://reminder?target=…`（D-主-357 案 B），走 ⑬ 的收連結路徑叫出主視窗、跳落點；通知中心裡、App 沒開時也走這條。
//! `Activated`＋事件 `ns-reminder-open`（payload＝JS 給的 target 字串）留著當後備。其他通知照走 `notifyOnce`。底線仍是提醒頁的「最近的提醒」。
//!
//! 只有 Windows 真的送；其他桌機回 Err，JS 退回 `notifyOnce`（通知照響、點了不回 App）。手機整支不編（lib.rs 的 `cfg(desktop)`）。

use tauri::AppHandle;

#[cfg(windows)]
mod imp {
    use super::AppHandle;
    use tauri::Emitter;
    use tauri_winrt_notification::Toast;
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

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

    /// XML 特殊字元跳脫（標題是票名，什麼字都可能有；壞掉整則就送不出去）
    pub(super) fn escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    /// `activationType="protocol"`＋`launch`：點了由系統開連結（第二個行程帶連結進來，single-instance 轉回來，App 沒開也開得起來），
    /// 通知進了通知中心也有效。`duration="long"`：7 秒太短來不及點。crate 沒有這兩個屬性的 API，所以自己組。
    pub(super) fn toast_xml(title: &str, body: &str, link: &str) -> String {
        format!(
            r#"<toast launch="{}" activationType="protocol" duration="long"><visual><binding template="ToastGeneric"><text id="1">{}</text><text id="2">{}</text></binding></visual></toast>"#,
            escape(link),
            escape(title),
            escape(body),
        )
    }

    /// 留著 `Activated`：protocol 萬一沒啟動（官方文件沒寫「捷徑沒有 stub CLSID」時的行為），通知還在螢幕上時仍走 D-主-357 那條。
    /// 兩條都到也無妨：開同一個落點，第二次沒有變化。
    pub(super) fn show(
        app: AppHandle,
        aumid: &str,
        title: &str,
        body: &str,
        link: &str,
        target: String,
    ) -> Result<(), String> {
        let send = || -> windows::core::Result<()> {
            let xml = XmlDocument::new()?;
            xml.LoadXml(&HSTRING::from(toast_xml(title, body, link)))?;
            let toast = ToastNotification::CreateToastNotification(&xml)?;
            toast.Activated(&TypedEventHandler::new(move |_, _| {
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
            }))?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid))?.Show(&toast)
        };
        send().map_err(|e| format!("送提醒通知失敗：{e}"))
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
    let link = crate::external::reminder_link(&crate::external::scheme_for(&identifier), &target);
    tauri::async_runtime::spawn_blocking(move || {
        imp::show(
            app,
            imp::aumid_for(&exe_dir, &identifier),
            &title,
            &body,
            &link,
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
    use super::imp::{aumid_for, toast_xml};
    use tauri_winrt_notification::Toast;

    const ID: &str = "app.shitetsu.nextstop";

    #[test]
    fn toast_走protocol且特殊字元要跳脫() {
        let xml = toast_xml("買<牛奶>&蛋", "明天 \"截止\"", "nextstop://reminder?target=%7B%7D&x=1");
        assert!(xml.contains(r#"launch="nextstop://reminder?target=%7B%7D&amp;x=1""#));
        assert!(xml.contains(r#"activationType="protocol""#));
        assert!(xml.contains("買&lt;牛奶&gt;&amp;蛋"));
        assert!(xml.contains("明天 &quot;截止&quot;"));
    }

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
