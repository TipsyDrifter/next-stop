//! 主視窗看不看得到（⑪ 動態氛圍層的效能守則）。
//!
//! WebView2 不知道自己被縮小，頁面的 visibilityState 一直是 visible，螢幕保護蓋著也照畫
//! （ClaudeUsageMonitor D105／D107 實測）。所以由後端看：主視窗被縮小、藏到系統匣、螢幕保護、鎖屏，
//! 任何一種都算「看不到」，變了才通知頁面（前端 `src/ui/ambience/motionSleep.ts`）。
//!
//! 用輪詢而不是各自掛事件：藏視窗的入口很多（✕ 進系統匣、Win+D、工作列），一支輪詢把全部封住，
//! 而且三個系統呼叫每 2 秒一次，成本可以忽略。不動 WebView 的 IsVisible：那會讓頁面變 hidden，
//! 同步輪詢和提醒的計時都會跟著停（常駐系統匣時這兩件要繼續）。
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const POLL: Duration = Duration::from_secs(2);
const EVENT: &str = "motion://hidden";

static HIDDEN: AtomicBool = AtomicBool::new(false);

/// 任何一種就算看不到；拿不到視窗狀態時當看得到（寧可多畫，不要永遠不醒）
fn decide(visible: bool, minimized: bool, screensaver: bool, locked: bool) -> bool {
    !visible || minimized || screensaver || locked
}

#[cfg(windows)]
fn screensaver_running() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETSCREENSAVERRUNNING};
    let mut running: i32 = 0;
    // SAFETY: 這個 action 只把一個 BOOL 寫進傳入的指標，指標指向這個函式堆疊上活著的 i32。
    let ok = unsafe { SystemParametersInfoW(SPI_GETSCREENSAVERRUNNING, 0, (&mut running as *mut i32).cast(), 0) };
    ok != 0 && running != 0
}

/// 鎖屏（或 UAC 安全桌面）時，這個行程打不開輸入桌面
#[cfg(windows)]
fn session_locked() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_SWITCHDESKTOP};
    // SAFETY: 呼叫沒有傳指標；回傳的 handle 只在這裡用，非 null 才關。
    unsafe {
        let desk = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if desk.is_null() {
            return true;
        }
        CloseDesktop(desk);
        false
    }
}

#[cfg(not(windows))]
fn screensaver_running() -> bool {
    false
}

#[cfg(not(windows))]
fn session_locked() -> bool {
    false
}

fn hidden_now(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window(crate::tray::MAIN_WINDOW) else {
        return false;
    };
    decide(
        w.is_visible().unwrap_or(true),
        w.is_minimized().unwrap_or(false),
        screensaver_running(),
        session_locked(),
    )
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("motion-watch".into()).spawn(move || loop {
        std::thread::sleep(POLL);
        let hidden = hidden_now(&app);
        if HIDDEN.swap(hidden, Ordering::Relaxed) != hidden {
            let _ = app.emit_to(crate::tray::MAIN_WINDOW, EVENT, hidden);
        }
    });
    if let Err(e) = spawned {
        eprintln!("[motion-watch] 起不來，動畫只會在頁面隱藏時停：{e}");
    }
}

/// 頁面開場問一次：開機直接藏在系統匣時，事件比頁面的監聽還早發
#[tauri::command]
pub fn motion_watch_state() -> bool {
    HIDDEN.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::decide;

    #[test]
    fn any_of_the_four_means_hidden() {
        assert!(!decide(true, false, false, false));
        assert!(decide(false, false, false, false));
        assert!(decide(true, true, false, false));
        assert!(decide(true, false, true, false));
        assert!(decide(true, false, false, true));
    }
}
