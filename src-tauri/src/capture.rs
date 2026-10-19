//! 旅客筆記線・階段⑤「捕捉小窗」殼層（契約 `docs/research/2026-10-16-旅客筆記-車次⑤捕捉小窗-契約.md` §3.1、§0-0）。
//!
//! 做什麼：全域鍵 `Ctrl+Alt+N` 叫出第二個視窗（label `capture`；tauri.conf.json 寫 `create:false`，由 `setup` 在桌機自己建好並 hide）、
//! 存檔後把前景還給原本的 App 再播受付章、開機自啟（`--minimized`）、系統匣「記一句」共用的 `show`。
//! 整支 mod 只在 `cfg(desktop)` 編（`lib.rs` 的 `mod capture;` 掛著屬性）——手機沒有全域鍵、小窗、自啟。
//!
//! **編譯狀態**：整支檔案寫成時建置時段被占用，**沒跑過 cargo**（`cargo check`／`cargo test` 都還沒驗）。
//! 外部 crate 的簽名已逐一對照本機 registry 的原始碼（tauri 2.11.2、tauri-runtime-wry 2.11.2、tao 0.35.2、
//! tauri-plugin-autostart 2.5.1、tauri-plugin-global-shortcut 2.3.2、global-hotkey 0.8.0、windows-sys 0.59.0），
//! 剩下的風險是型別推論與借用細節，留給第一次 `cargo check`。
//!
//! 存檔後的收法（D-筆-61／契約 §0-0）由 `capture_hide` 的四個模式承擔：`saved`（Enter 當下、存檔寫完之前就還前景→
//! 小窗不可聚焦＋點擊穿透→存好後前端播章）、`revive`（saved 之後存檔沒成功→叫回小窗）、`esc`（還前景→hide）、`hide`（只 hide）。章播放期間的狀態見 `StampState`。
//!
//! 硬條件（契約 0-14／主對話 M-2）：「顯示主視窗」是**預設路徑**，在 `setup` 第一個陳述式決定；只有明確的
//! `--minimized` 參數才跳過；之後任何一步失敗都只 `eprintln!`，`setup` 永遠回 `Ok(())`，**絕不讓主視窗留在隱藏**。

use std::ffi::{OsStr, OsString};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, State};
use tauri_plugin_autostart::AutoLaunchManager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::tray;

// ───────────────────────── 常數（TS 端 `shell.ts` 有逐字相同的一份，`notes-logic.test.ts` 對帳）─────────────────────────

pub const CAPTURE_WINDOW: &str = "capture"; // tauri.conf.json 第二個視窗的 label
pub const EV_CAPTURE_SHOW: &str = "notes:capture-show"; // Rust → 小窗（emit_to）
pub const MINIMIZED_ARG: &str = "--minimized";
/// 系統匣「記一句」的選單 id（`tray.rs` 的 `build_menu`／`on_menu_event` 用）
pub const TRAY_MENU_ID: &str = "notes:capture";
pub const HOTKEY_ACCEL: &str = "Ctrl+Alt+N"; // 只給 log／status 回報

/// 正式版的 identifier；`run_value_name` 收到空字串時的退路
const DEFAULT_IDENTIFIER: &str = "app.shitetsu.nextstop";

/// 小窗垂直位置＝螢幕高的 18%（0-3 甲；App 內 118/800 ≈ 15%，小窗沒有標題列，略低一點）
const TOP_RATIO: f64 = 0.18;
const WIN_W: f64 = 640.0;
const WIN_H_MIN: f64 = 180.0;
const WIN_H_MAX: f64 = 640.0;
/// 票（或預覽框）高度之外的紙邊：上下各 16（契約 0-13）
const WIN_H_PAD: f64 = 32.0;

/// 開了 `--minimized` 但系統匣最後沒建起來時，這麼久之後自動把主視窗叫出來（不然使用者完全沒有入口）
const TRAY_WATCHDOG: Duration = Duration::from_secs(3);

/// 「存檔後播章」這段期間的保護窗：從 `capture_hide(saved)` 起算。章本身約 400ms（前端 `CAPTURE_STAMP_MS`），
/// 這裡抓寬到 700ms 當上限，只用在兩件事：①剛還前景造成的失焦不算「點到外面」；②章播放中使用者又按熱鍵把
/// 小窗叫回來時，攔下前端那顆過期計時器遲到的 hide（見 `StampState`）。
/// **必須大於前端 `CAPTURE_STAMP_MS`（`shell.ts`）**——章調長到 ≥ 這個值，章還在播、這裡就不再壓失焦，章會被提早收掉；
/// `notes-logic.test.ts` 有一條對帳鎖住「STAMP_GUARD > CAPTURE_STAMP_MS」，調章長度時一併調這個數字。
const STAMP_GUARD: Duration = Duration::from_millis(700);

/// 失焦事件到達後等這麼久再確認：WebView2 把鍵盤焦點從頂層視窗移進子視窗時 tao 也會報 `Focused(false)`
/// （視窗其實還是前景）——等一下、看前景視窗是不是真的換人了，才收起。
const BLUR_RECHECK: Duration = Duration::from_millis(120);

// ───────────────────────── 狀態 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyState {
    Registered,
    Failed(String),
}

/// 受付章播放期間的狀態（D-筆-61）。純資料＋純方法，時間由呼叫端傳進來，好測。
///
/// 流程：`capture_hide(saved)` → `begin`（前景已還給原 App，小窗浮著播章）→ 前端 ~400ms 後 `capture_hide(hide)`。
/// 播章期間若使用者又按熱鍵：`show` 呼叫 `on_show` 把 `revived` 記起來——小窗已經是一張新的票，
/// 這時前端那顆章的計時器到點送來的 `hide` 是過期的，`take_swallow_hide` 要吞掉它，不然剛叫出來的小窗馬上被收掉。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct StampState {
    until: Option<Instant>,
    revived: bool,
}

impl StampState {
    pub(crate) fn begin(now: Instant) -> Self {
        Self {
            until: Some(now + STAMP_GUARD),
            revived: false,
        }
    }

    fn active(&self, now: Instant) -> bool {
        self.until.is_some_and(|t| now < t)
    }

    /// `show` 叫出小窗時呼叫。回傳「叫出的當下是否還在播章」（是 ⇒ 此刻的前景是原 App，要重新記）。
    pub(crate) fn on_show(&mut self, now: Instant) -> bool {
        if self.active(now) {
            self.revived = true;
            true
        } else {
            *self = Self::default();
            false
        }
    }

    /// 播章中、且沒被重新叫出：這個時候的失焦是我們自己還前景造成的，不算「點到外面」。
    pub(crate) fn suppresses_blur(&self, now: Instant) -> bool {
        self.active(now) && !self.revived
    }

    /// 收到一個 `hide`：回傳是否要吞掉（＝播章中被重新叫出的那張票，這顆 hide 是舊章的計時器）。一律清掉狀態。
    pub(crate) fn take_swallow_hide(&mut self, now: Instant) -> bool {
        let swallow = self.active(now) && self.revived;
        *self = Self::default();
        swallow
    }
}

pub struct CaptureShell {
    pub hotkey: Mutex<HotkeyState>,
    /// D-筆-61（§0-0）：叫出小窗之前的前景視窗（Windows 的 HWND，以 isize 存；其他平台恆 None）。
    /// 存完／Esc 時先把前景還給它。
    pub prev_hwnd: Mutex<Option<isize>>,
    /// 受付章播放期間的狀態（見 `StampState`）
    stamp: Mutex<StampState>,
}

impl CaptureShell {
    fn new() -> Self {
        Self {
            hotkey: Mutex::new(HotkeyState::Failed("尚未註冊".to_string())),
            prev_hwnd: Mutex::new(None),
            stamp: Mutex::new(StampState::default()),
        }
    }
}

/// 鎖中毒時照樣拿值（這兩把鎖裡只有簡單的值，沒有需要維持的不變式）
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ───────────────────────── 純函式（可測）─────────────────────────

/// 只認整個參數 == `--minimized`（不認前綴，`--minimized-x` 不算）。
/// 吃 `OsString` 不吃 `String`：`std::env::args()` 遇到非 Unicode 參數會 panic，而這一句跑在 setup 的第一步——
/// 「絕不讓主視窗留在隱藏、絕不擋啟動」的路徑上不該有任何 panic。
pub(crate) fn is_minimized_launch<I: IntoIterator<Item = OsString>>(args: I) -> bool {
    args.into_iter().any(|a| a.as_os_str() == OsStr::new(MINIMIZED_ARG))
}

/// 小窗左上角的物理座標：水平置中、頂端往下 18%。
/// `mon`＝(x, y, 寬, 高)，物理像素（第二螢幕的 x、y 可能是負的）；`win_w`／`win_h` 是邏輯像素，乘 `scale` 換物理。
/// 最後夾在螢幕裡：視窗底不超出螢幕下緣（螢幕很矮時）。
pub(crate) fn place(mon: (i32, i32, u32, u32), scale: f64, win_w: f64, win_h: f64) -> (i32, i32) {
    let (mx, my, mw, mh) = mon;
    let w_phys = win_w * scale;
    let h_phys = win_h * scale;
    let x = mx as f64 + (mw as f64 - w_phys) / 2.0;
    let y = my as f64 + mh as f64 * TOP_RATIO;
    let y_max = my as f64 + mh as f64 - h_phys;
    // 螢幕比視窗還矮的退路：y_max < my 時以頂端為準
    let y = y.min(y_max).max(my as f64);
    (x.round() as i32, y.round() as i32)
}

/// 開機自啟的登錄檔值名＝identifier 原文（空字串退回正式版）。各線 dev、沙盒的 identifier 不同 ⇒ 值名互不相干，
/// 不會互相覆蓋正式版（技術查證 Q4：crate 預設用 productName，所有版本同名）。
pub(crate) fn run_value_name(identifier: &str) -> String {
    let id = identifier.trim();
    if id.is_empty() {
        DEFAULT_IDENTIFIER.to_string()
    } else {
        id.to_string()
    }
}

/// 叫出小窗前的前景視窗，存完／Esc 時要不要把前景還給它（O3）：
/// 屬於**自己這個行程**的視窗（系統匣選單的隱形擁有者視窗 `tray_icon_app`、藏著的主視窗……）不還——
/// 還過去沒有任何人看得到，鍵盤反而卡在隱形視窗上；直接收起，讓 Windows 自己挑下一個視窗。
/// 例外：`is_main_window`＝記下的就是主視窗本身（使用者在主視窗裡按熱鍵）——那是看得見的「原本的 App」，照還。
/// `owner_pid` 查不到（None）時維持舊行為（還）。
pub(crate) fn restorable(owner_pid: Option<u32>, own_pid: u32, is_main_window: bool) -> bool {
    match owner_pid {
        Some(pid) if pid == own_pid => is_main_window,
        _ => true,
    }
}

/// 票（或預覽框）的內容高度（邏輯像素）→ 視窗高度：加上下紙邊，夾在 [WIN_H_MIN, WIN_H_MAX]。
pub(crate) fn fit_height(content: f64) -> f64 {
    if !content.is_finite() {
        return WIN_H_MIN;
    }
    (content + WIN_H_PAD).clamp(WIN_H_MIN, WIN_H_MAX)
}

// ───────────────────────── 前景視窗（D-筆-61；windows-sys 直接依賴，cfg(windows)）─────────────────────────

#[cfg(windows)]
fn foreground_hwnd() -> Option<isize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    // SAFETY: GetForegroundWindow 無參數、無前置條件，回傳 null 表示目前沒有前景視窗。
    let h = unsafe { GetForegroundWindow() };
    if h.is_null() {
        None
    } else {
        Some(h as isize)
    }
}

/// 回 true＝系統接受了。失敗（原視窗已關、被系統拒絕）呼叫端一律忽略，讓 Windows 自己挑下一個視窗。
#[cfg(windows)]
fn restore_foreground(hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    // SAFETY: SetForegroundWindow 對無效 HWND 只是回傳 0，不會出事。
    unsafe { SetForegroundWindow(hwnd as *mut core::ffi::c_void) != 0 }
}

/// 這個視窗現在是不是系統的前景視窗（比 tao 的 `Focused` 準：鍵盤焦點移進 WebView2 子視窗時，頂層視窗仍是前景）
#[cfg(windows)]
fn is_foreground_window<R: Runtime>(w: &tauri::Window<R>) -> bool {
    match (w.hwnd(), foreground_hwnd()) {
        (Ok(h), Some(fg)) => h.0 as isize == fg, // 未編譯驗證：tauri 的 HWND 是 windows crate 的 `HWND(pub *mut c_void)`
        _ => false,
    }
}

#[cfg(not(windows))]
fn is_foreground_window<R: Runtime>(w: &tauri::Window<R>) -> bool {
    w.is_focused().unwrap_or(false)
}

#[cfg(not(windows))]
fn foreground_hwnd() -> Option<isize> {
    None
}

#[cfg(not(windows))]
fn restore_foreground(_hwnd: isize) -> bool {
    false
}

/// 這個視窗屬於哪個行程（查不到＝None）
#[cfg(windows)]
fn window_owner_pid(hwnd: isize) -> Option<u32> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid: u32 = 0;
    // SAFETY: 對無效 HWND 只是回傳 0（thread id），pid 維持 0；`&mut pid` 是有效的寫入目標。
    let tid = unsafe { GetWindowThreadProcessId(hwnd as *mut core::ffi::c_void, &mut pid) };
    if tid == 0 {
        None
    } else {
        Some(pid)
    }
}

#[cfg(not(windows))]
fn window_owner_pid(_hwnd: isize) -> Option<u32> {
    None
}

/// 看得見的主視窗的 HWND（`restorable` 的例外判斷用；沒有主視窗、藏著、讀不到、非 Windows ⇒ None——藏著的主視窗不是「原本的 App」）
#[cfg(windows)]
fn main_window_hwnd<R: Runtime>(app: &AppHandle<R>) -> Option<isize> {
    let w = app.get_webview_window(tray::MAIN_WINDOW)?;
    w.hwnd().ok().map(|h| h.0 as isize) // 未編譯驗證：同 `is_foreground_window`，tauri 的 HWND 是 `HWND(pub *mut c_void)`
}

#[cfg(not(windows))]
fn main_window_hwnd<R: Runtime>(_app: &AppHandle<R>) -> Option<isize> {
    None
}

/// show 小窗之前記下目前的前景視窗。屬於自己行程的（系統匣選單的隱形視窗等）不記，見 `restorable`。
fn remember_foreground<R: Runtime>(app: &AppHandle<R>) {
    let Some(shell) = app.try_state::<CaptureShell>() else {
        return;
    };
    let main_hwnd = main_window_hwnd(app);
    let keep = foreground_hwnd()
        .filter(|&h| restorable(window_owner_pid(h), std::process::id(), main_hwnd == Some(h)));
    *lock(&shell.prev_hwnd) = keep;
}

/// 把前景還給 `prev_hwnd`（取出就清掉，只還一次）。失敗不報錯，回傳是否成功只給 log 用。
fn restore_previous_foreground<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(shell) = app.try_state::<CaptureShell>() else {
        return false;
    };
    let prev = lock(&shell.prev_hwnd).take();
    match prev {
        Some(h) => restore_foreground(h),
        None => false,
    }
}

// ───────────────────────── 熱鍵 ─────────────────────────

fn hotkey() -> Shortcut {
    // global-hotkey 0.8.0 `HotKey::new(mods: Option<Modifiers>, key: Code)`（`Shortcut` 是它的 re-export 別名），
    // `HotKey: Copy + PartialEq`；已對照原始碼，未編譯
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN)
}

/// 執行期註冊（**不用** `with_shortcuts`：被佔走會讓 `build()` 回 Err、App 開不起來，查證 Q1）。
fn try_register<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // plugin 的 `register` 內部 `run_on_main_thread` 再 `rx.recv()` 等結果；在主執行緒（setup、window event）呼叫時
    // tauri-runtime-wry 的 `send_user_message` 當場執行，不會死等（已對照 2.11.2 原始碼）
    app.global_shortcut().register(hotkey()).map_err(|e| e.to_string())
}

/// 註冊並把結果寫進 `CaptureShell.hotkey`；失敗只 log。
fn register_and_record<R: Runtime>(app: &AppHandle<R>) {
    let result = try_register(app);
    let Some(shell) = app.try_state::<CaptureShell>() else {
        return;
    };
    match result {
        Ok(()) => *lock(&shell.hotkey) = HotkeyState::Registered,
        Err(msg) => {
            eprintln!("[capture] 全域鍵 {HOTKEY_ACCEL} 註冊失敗：{msg}");
            *lock(&shell.hotkey) = HotkeyState::Failed(msg);
        }
    }
}

// ───────────────────────── 對外介面 ─────────────────────────

/// 只掛 global-shortcut（handler：快捷鍵 == Ctrl+Alt+N 且 Pressed ⇒ `show`）。
/// autostart 要用 identifier 當 `app_name`，identifier 在 build 之前拿不到 ⇒ 它在 `setup` 裡用 `app.plugin(...)` 掛。
pub fn plugins<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.plugin(
        tauri_plugin_global_shortcut::Builder::<R>::new() // 已對照 2.3.2 原始碼（registry cache 有 .crate）；未編譯
            .with_handler(|app, shortcut, event| {
                // 收 Pressed 與 Released 兩次 ⇒ 只處理 Pressed
                if *shortcut == hotkey() && event.state() == ShortcutState::Pressed {
                    show(app);
                }
            })
            .build(),
    )
}

/// `lib.rs` 的 `.setup` 第一句。順序不可換（契約 0-14）：
/// ① 沒帶 `--minimized` ⇒ 先叫出主視窗；② manage(CaptureShell)；③ 掛 autostart；④ 註冊熱鍵；⑤ 建小窗。永遠 `Ok(())`。
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // ① 預設路徑：顯示主視窗。tauri.conf.json 的 main 是 visible:false，這一句是它唯一的「出現」來源。
    let minimized = is_minimized_launch(std::env::args_os());
    if !minimized {
        tray::show_main_window(app);
    } else {
        spawn_tray_watchdog(app.clone());
    }

    // ② 狀態
    app.manage(CaptureShell::new());

    // ③ 開機自啟 plugin（值名＝identifier；開機自啟時帶 --minimized）。掛不起來只 log，開關那一列會 available=false。
    let name = run_value_name(&app.config().identifier);
    let autostart = tauri_plugin_autostart::Builder::new()
        .app_name(name)
        .arg(MINIMIZED_ARG)
        .build::<R>(); // 顯式 R：不靠 `app.plugin` 的推論（tauri-plugin-autostart 2.5.1 `Builder::build<R: Runtime>`）
    if let Err(e) = app.plugin(autostart) {
        eprintln!("[capture] 開機自啟 plugin 掛載失敗（設定頁不會出現開關）：{e}");
    }

    // ④ 全域鍵
    register_and_record(app);

    // ⑤ 建小窗（hide 的）。tauri.conf.json 的 capture 視窗寫 `create:false`，所以 tauri 自己不會建它：
    //  * Android 共用同一份 conf，tauri 若照 conf 建第二個視窗，tao／wry 會把第二個 webview 換進唯一的 activity、蓋掉主畫面；
    //  * 桌機建不起來（WebView2 出狀況）也只是 log、不會變成 setup 階段的 panic，主視窗（①）早就叫出來了。
    // 建好之前 `show` 找不到小窗會走 `rebuild_and_show`，所以這裡失敗不致命。
    if let Err(e) = build_capture_window(app) {
        eprintln!("[capture] 建立小窗失敗（熱鍵叫出時會再試一次）：{e}");
    }

    Ok(())
}

/// 依 tauri.conf.json 的 `capture` 視窗設定建小窗（`create:false` 的視窗 tauri 不會自動建，要自己 `from_config`）。
/// `setup`（主執行緒、Ready 之後，與 tauri 自己建設定檔視窗同一個時機）與 `rebuild_and_show` 共用。
fn build_capture_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|c| c.label == CAPTURE_WINDOW)
        .cloned()
        .ok_or_else(|| format!("tauri.conf.json 沒有 `{CAPTURE_WINDOW}` 視窗設定"))?;
    tauri::WebviewWindowBuilder::from_config(app, &cfg)
        .and_then(|b| b.build())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 帶 `--minimized` 啟動時，主視窗一直藏著；萬一系統匣沒建起來（tray::init 失敗）就沒有任何入口了。
/// 所以過一小段時間檢查：系統匣不在 ⇒ 把主視窗叫出來。（硬條件的第二層保險；系統匣在就什麼都不做）
fn spawn_tray_watchdog<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(TRAY_WATCHDOG);
        if app.tray_by_id(tray::TRAY_ID).is_none() {
            eprintln!("[capture] --minimized 但系統匣不存在，改為叫出主視窗");
            tray::show_main_window(&app);
        }
    });
}

/// `lib.rs` `.on_window_event` 閉包第一句：
/// * label==capture 且 CloseRequested ⇒ hide＋prevent_close（Alt+F4 不銷毀小窗；JS 的 blur 處理負責「字留著」）。
/// * label==capture 且 Focused(false)（別的視窗拿走前景）⇒ 收起、字留著（字在 webview 裡，hide 不動它；0-1）。
///   前端自己也會在 `blur` 時呼叫 `capture_hide`，兩邊都冪等；Rust 這邊是保險。見 `schedule_blur_hide`。
/// * label==main 且 Focused(true) 且熱鍵 Failed ⇒ 再 register 一次（關掉另一個佔鍵的版本後，回主視窗一下就拿回鍵）。
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } if window.label() == CAPTURE_WINDOW => {
            match window.hide() {
                Ok(()) => api.prevent_close(),
                Err(e) => eprintln!("[capture] 小窗 hide 失敗，照舊關閉：{e}"),
            }
        }
        tauri::WindowEvent::Focused(false) if window.label() == CAPTURE_WINDOW => {
            schedule_blur_hide(window.clone());
        }
        tauri::WindowEvent::Focused(true) if window.label() == tray::MAIN_WINDOW => {
            let app = window.app_handle();
            let failed = app
                .try_state::<CaptureShell>()
                .map(|s| matches!(*lock(&s.hotkey), HotkeyState::Failed(_)))
                .unwrap_or(false);
            if failed {
                register_and_record(app);
            }
        }
        _ => {}
    }
}

/// 小窗失焦 ⇒ 收起。**不能直接在事件裡 hide**，兩個原因：
/// ① 存檔後我們自己把前景還給原 App（`capture_hide(saved)`），小窗會收到失焦——那是預期的，章還要播（`StampState`）；
/// ② tao 在 Windows 用 WM_KILLFOCUS 報 `Focused(false)`，鍵盤焦點從頂層視窗移進 WebView2 子視窗時也會觸發，
///    那時小窗其實還是前景。所以等 `BLUR_RECHECK` 後再問系統「前景視窗是不是小窗」，不是才收。
/// （①②的判斷都在背景執行緒裡做，不阻塞事件迴圈；hide 失敗只 log。）
fn schedule_blur_hide<R: Runtime>(window: tauri::Window<R>) {
    let app = window.app_handle().clone();
    if let Some(shell) = app.try_state::<CaptureShell>() {
        if lock(&shell.stamp).suppresses_blur(Instant::now()) {
            return;
        }
    }
    std::thread::spawn(move || {
        std::thread::sleep(BLUR_RECHECK);
        if let Some(shell) = app.try_state::<CaptureShell>() {
            // 等待期間章才開始播：同上，不收
            if lock(&shell.stamp).suppresses_blur(Instant::now()) {
                return;
            }
        }
        if !window.is_visible().unwrap_or(false) || is_foreground_window(&window) {
            return; // 已經收起了，或只是焦點在小窗內部移動（假失焦）
        }
        if let Some(w) = app.get_webview_window(CAPTURE_WINDOW) {
            if let Err(e) = hide_window(&app, &w) {
                eprintln!("[capture] 失焦收起失敗：{e}");
            }
        }
    });
}

/// 收起小窗並清掉 saved 模式留下的旗標。**先 hide、後還原旗標**：視窗還顯示時 `set_focusable(true)` 不該有機會把前景
/// 從剛還回去的原 App 搶回來（tao 的樣式變更用 SWP_NOACTIVATE，這裡再保險一層）。
fn hide_window<R: Runtime>(app: &AppHandle<R>, w: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if let Some(shell) = app.try_state::<CaptureShell>() {
        *lock(&shell.stamp) = StampState::default();
    }
    let result = w.hide().map_err(|e| e.to_string());
    let _ = w.set_ignore_cursor_events(false);
    let _ = w.set_focusable(true);
    result
}

/// 熱鍵／系統匣共用：記前景 → place → unminimize → show → set_focus → emit_to(capture, EV_CAPTURE_SHOW)。
/// 找不到小窗（理論上只有被 destroy 才會）⇒ 在 async_runtime 裡用 `from_config` 重建後再叫一次。
/// 不在 handler 同步 build（Windows 上會死結，查證 Q3）。
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    show_inner(app, true);
}

fn show_inner<R: Runtime>(app: &AppHandle<R>, allow_rebuild: bool) {
    let Some(w) = app.get_webview_window(CAPTURE_WINDOW) else {
        if allow_rebuild {
            rebuild_and_show(app.clone());
        } else {
            eprintln!("[capture] 找不到小窗 `{CAPTURE_WINDOW}`，無法叫出");
        }
        return;
    };

    // 小窗已經開著（再按一次熱鍵）：前景視窗就是小窗自己，不能覆蓋 prev_hwnd。
    // 例外：章播放中（小窗浮著但前景早就還給原 App）又按熱鍵——此刻的前景是原 App，要重新記，
    // 同時 `on_show` 把「這張票是播章中被叫回來的」記起來，讓舊章計時器遲到的 hide 被吞掉。
    let was_stamping = match app.try_state::<CaptureShell>() {
        Some(shell) => lock(&shell.stamp).on_show(Instant::now()),
        None => false,
    };
    let already_visible = w.is_visible().unwrap_or(false);
    if !already_visible || was_stamping {
        remember_foreground(app);
    }

    focus_capture_window(&w, position_for(app));
    if let Err(e) = app.emit_to(CAPTURE_WINDOW, EV_CAPTURE_SHOW, ()) {
        eprintln!("[capture] emit {EV_CAPTURE_SHOW} 失敗：{e}");
    }
}

/// 把小窗叫到前景可打字的狀態：還原「章播放中」的不可聚焦＋點擊穿透 → （有座標就）定位 → unminimize → show → set_focus。
/// `show_inner` 與 `capture_hide(revive)` 共用——上一輪存檔後的旗標若沒被清掉，這裡一定要還原，不然小窗叫出來打不了字。
fn focus_capture_window<R: Runtime>(w: &tauri::WebviewWindow<R>, pos: Option<(i32, i32)>) {
    if let Err(e) = w.set_ignore_cursor_events(false) {
        eprintln!("[capture] set_ignore_cursor_events(false) 失敗：{e}");
    }
    if let Err(e) = w.set_focusable(true) {
        eprintln!("[capture] set_focusable(true) 失敗：{e}");
    }
    if let Some((x, y)) = pos {
        if let Err(e) = w.set_position(PhysicalPosition::new(x, y)) {
            eprintln!("[capture] set_position 失敗：{e}");
        }
    }
    if let Err(e) = w.unminimize() {
        eprintln!("[capture] unminimize 失敗：{e}");
    }
    if let Err(e) = w.show() {
        eprintln!("[capture] show 失敗：{e}");
    }
    if let Err(e) = w.set_focus() {
        eprintln!("[capture] set_focus 失敗：{e}");
    }
}

/// 游標所在螢幕的工作區 → 小窗左上角。任何一步拿不到就回 None（維持視窗上次的位置）。
fn position_for<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32)> {
    let cur = app.cursor_position().ok()?;
    let mon = app
        .monitor_from_point(cur.x, cur.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let wa = mon.work_area();
    Some(place(
        (wa.position.x, wa.position.y, wa.size.width, wa.size.height),
        mon.scale_factor(),
        WIN_W,
        WIN_H_MIN,
    ))
}

fn rebuild_and_show<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        match build_capture_window(&app) {
            Ok(()) => show_inner(&app, false),
            Err(e) => eprintln!("[capture] 重建小窗失敗：{e}"),
        }
    });
}

// ───────────────────────── commands ─────────────────────────

/// `capture_hide` 的三種收法（JS 端 `hideCapture(mode?)`，字串是 camelCase）。省略＝`hide`。
///
/// * `saved`：Enter 的當下（**不等存檔寫完**——DB 寫入加 IPC 要 65–125ms，這段期間鍵盤還在小窗手上，Enter 後馬上打的字會掉）。
///   **先把前景還給原本的 App**，小窗改成不可聚焦＋點擊穿透，**但不 hide**——存檔成功後 JS 播約 400ms 的受付章，
///   播完再呼叫 `hide`。章播放期間鍵盤一律落在原 App。
///   （前景被還走時小窗會收到 blur——JS 在這段期間必須忽略 blur，不能把它當成「點到外面」。）
/// * `revive`：`saved` 之後存檔沒成功（寫入失敗、其實是空的、轉成預覽框）——把小窗叫回來：重新記下此刻的前景、
///   還原可聚焦／可點擊、show＋聚焦；**不 emit 叫出事件**（字還在、票不換，前端自己把焦點放回打字區）。
/// * `esc`：Esc 放棄。把前景還給原 App，再 hide。
/// * `hide`：失焦（別的視窗拿走焦點，前景不用還）、章播完、Alt+F4 之後的收尾。只 hide，並清掉 saved 留下的旗標。
///   例外：章播放中使用者又按熱鍵把小窗叫回來（`show` 已把旗標還原、小窗是新的一張票），這時舊章的計時器送來的
///   那一個 `hide` 會被吞掉一次（700ms 保護窗內；見 `StampState`）。前端若在 `notes:capture-show` 時取消章的計時器更好，
///   這裡只是保險。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HideMode {
    #[default]
    Hide,
    Saved,
    Esc,
    Revive,
}

#[tauri::command]
pub async fn capture_hide(app: AppHandle, mode: Option<HideMode>) -> Result<(), String> {
    let Some(w) = app.get_webview_window(CAPTURE_WINDOW) else {
        return Ok(()); // 冪等：沒有小窗就當已收起
    };
    match mode.unwrap_or_default() {
        HideMode::Saved => {
            // 先宣告「開始播章」再還前景：還前景會讓小窗失焦，`schedule_blur_hide` 要靠這個知道別收
            if let Some(shell) = app.try_state::<CaptureShell>() {
                *lock(&shell.stamp) = StampState::begin(Instant::now());
            }
            if !restore_previous_foreground(&app) {
                eprintln!("[capture] 前景沒有還成功（原視窗已關或被系統拒絕），照常播章");
            }
            if let Err(e) = w.set_focusable(false) {
                eprintln!("[capture] set_focusable(false) 失敗：{e}");
            }
            if let Err(e) = w.set_ignore_cursor_events(true) {
                eprintln!("[capture] set_ignore_cursor_events(true) 失敗：{e}");
            }
            Ok(())
        }
        HideMode::Revive => {
            if let Some(shell) = app.try_state::<CaptureShell>() {
                *lock(&shell.stamp) = StampState::default();
            }
            remember_foreground(&app); // 此刻的前景＝剛才還過去的原 App；之後 Esc／再存才還得回去
            focus_capture_window(&w, None);
            Ok(())
        }
        HideMode::Esc => {
            if !restore_previous_foreground(&app) {
                eprintln!("[capture] 前景沒有還成功，照常收起");
            }
            hide_window(&app, &w)
        }
        HideMode::Hide => {
            // 章播放中被熱鍵叫回來的那張新票，不該被舊章的計時器收掉（`StampState`）
            let swallow = match app.try_state::<CaptureShell>() {
                Some(shell) => lock(&shell.stamp).take_swallow_hide(Instant::now()),
                None => false,
            };
            if swallow {
                return Ok(());
            }
            hide_window(&app, &w)
        }
    }
}

/// 小窗跟著內容長高：`height` 是票（或預覽框）的邏輯像素高度，這裡加紙邊並夾在 [180, 640]。
#[tauri::command]
pub async fn capture_fit(app: AppHandle, height: f64) -> Result<(), String> {
    let Some(w) = app.get_webview_window(CAPTURE_WINDOW) else {
        return Ok(());
    };
    w.set_size(LogicalSize::new(WIN_W, fit_height(height)))
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub hotkey_registered: bool,
    pub hotkey_error: Option<String>,
    pub accel: &'static str,
}

/// 熱鍵還沒拿到時，順便再註冊一次（設定頁開著、使用者一直停在主視窗上時，`Focused(true)` 不會再來；
/// 設定列在警示顯示時會定時問，佔鍵的那一方關掉後幾秒內就拿回來）。
#[tauri::command]
pub fn capture_status<R: Runtime>(app: AppHandle<R>, shell: State<'_, CaptureShell>) -> CaptureStatus {
    let failed = matches!(*lock(&shell.hotkey), HotkeyState::Failed(_));
    if failed {
        register_and_record(&app);
    }
    let (hotkey_registered, hotkey_error) = match &*lock(&shell.hotkey) {
        HotkeyState::Registered => (true, None),
        HotkeyState::Failed(msg) => (false, Some(msg.clone())),
    };
    CaptureStatus {
        hotkey_registered,
        hotkey_error,
        accel: HOTKEY_ACCEL,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartInfo {
    /// plugin 沒掛成功（或不是桌機）⇒ false，此時 `enabled` 一定 false；前端整列不畫
    pub available: bool,
    pub enabled: bool,
    /// 登錄檔值名＝identifier（前端「預設開」只對正式 identifier 做，直接拿這個比對）
    pub name: String,
    /// 這支 exe 是 debug 建置（`cfg!(debug_assertions)`）。前端「預設開」的第三道閘：沙盒流程會再 build 一次
    /// 「正式 identifier 的 debug exe」，它與安裝版共用 identifier（登錄檔值名、DB 都同一份），雙擊它不能去改使用者真實的 Run 值。
    /// 只擋「預設開」；設定頁的手動開關不看這個。
    pub debug_build: bool,
}

fn autostart_info<R: Runtime>(app: &AppHandle<R>) -> Result<AutostartInfo, String> {
    let name = run_value_name(&app.config().identifier);
    match app.try_state::<AutoLaunchManager>() {
        None => Ok(AutostartInfo {
            available: false,
            enabled: false,
            name,
            debug_build: cfg!(debug_assertions),
        }),
        Some(m) => Ok(AutostartInfo {
            available: true,
            enabled: m.is_enabled().map_err(|e| e.to_string())?,
            name,
            debug_build: cfg!(debug_assertions),
        }),
    }
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> Result<AutostartInfo, String> {
    autostart_info(&app)
}

#[tauri::command]
pub async fn autostart_set(app: AppHandle, enabled: bool) -> Result<AutostartInfo, String> {
    {
        let Some(m) = app.try_state::<AutoLaunchManager>() else {
            return Err("開機自啟外掛沒有掛成功".to_string());
        };
        let result = if enabled { m.enable() } else { m.disable() };
        if let Err(e) = result {
            // 關掉時值本來就不在（或只剩一半）也算成功：以讀回來的結果為準
            let now = m.is_enabled().unwrap_or(enabled);
            if now == enabled {
                eprintln!("[capture] autostart 切換回報錯誤但狀態已符合：{e}");
            } else {
                return Err(e.to_string());
            }
        }
    }
    autostart_info(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<OsString> {
        v.iter().map(|s| OsString::from(*s)).collect()
    }

    #[test]
    fn minimized_有參數就是true() {
        assert!(is_minimized_launch(args(&["next-stop.exe", "--minimized"])));
    }

    #[test]
    fn minimized_沒參數是false() {
        assert!(!is_minimized_launch(args(&["next-stop.exe"])));
        assert!(!is_minimized_launch(Vec::<OsString>::new()));
    }

    #[test]
    fn minimized_只認完整參數不認前綴() {
        assert!(!is_minimized_launch(args(&["next-stop.exe", "--minimized-x"])));
        assert!(!is_minimized_launch(args(&["next-stop.exe", "--minimize"])));
    }

    #[test]
    fn place_1080p無縮放_水平置中_頂18() {
        // x = (1920-640)/2 = 640；y = 1080*0.18 = 194.4 → 194
        assert_eq!(place((0, 0, 1920, 1080), 1.0, 640.0, 240.0), (640, 194));
    }

    #[test]
    fn place_縮放2倍_視窗寬用物理像素算() {
        // 視窗物理寬 1280；x = (3840-1280)/2 = 1280；y = 2160*0.18 = 388.8 → 389
        assert_eq!(place((0, 0, 3840, 2160), 2.0, 640.0, 240.0), (1280, 389));
    }

    #[test]
    fn place_第二螢幕在左邊_座標為負() {
        // 螢幕原點 (-1920, 0)：x = -1920 + 640 = -1280
        assert_eq!(place((-1920, 0, 1920, 1080), 1.0, 640.0, 240.0), (-1280, 194));
    }

    #[test]
    fn place_螢幕比視窗矮時夾回頂端() {
        // 螢幕高 200、視窗高 240：y_max < my ⇒ 以頂端 (my) 為準
        assert_eq!(place((0, 100, 1920, 200), 1.0, 640.0, 240.0), (640, 100));
    }

    #[test]
    fn restorable_別的行程的視窗_照還() {
        assert!(restorable(Some(4321), 1234, false));
        assert!(restorable(None, 1234, false)); // 查不到擁有者 ⇒ 維持舊行為
    }

    #[test]
    fn restorable_自己行程的視窗_不還_除非是主視窗() {
        // 系統匣選單的隱形擁有者視窗等
        assert!(!restorable(Some(1234), 1234, false));
        // 使用者在主視窗裡按熱鍵：主視窗是看得見的原 App
        assert!(restorable(Some(1234), 1234, true));
    }

    #[test]
    fn run_value_name_原文() {
        assert_eq!(run_value_name("app.shitetsu.nextstop.sandbox.a"), "app.shitetsu.nextstop.sandbox.a");
        assert_eq!(run_value_name("  app.shitetsu.nextstop.dev.notes "), "app.shitetsu.nextstop.dev.notes");
    }

    #[test]
    fn run_value_name_空字串退回正式版() {
        assert_eq!(run_value_name(""), "app.shitetsu.nextstop");
        assert_eq!(run_value_name("   "), "app.shitetsu.nextstop");
    }

    #[test]
    fn fit_height_加紙邊並夾範圍() {
        assert_eq!(fit_height(240.0), 272.0);
        assert_eq!(fit_height(10.0), WIN_H_MIN); // 太矮 ⇒ 下限
        assert_eq!(fit_height(9999.0), WIN_H_MAX); // 太高 ⇒ 上限
        assert_eq!(fit_height(f64::NAN), WIN_H_MIN);
    }

    #[test]
    fn capture_status_json_是camelcase() {
        let v = serde_json::to_value(CaptureStatus {
            hotkey_registered: false,
            hotkey_error: Some("not wired".to_string()),
            accel: HOTKEY_ACCEL,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "hotkeyRegistered": false, "hotkeyError": "not wired", "accel": "Ctrl+Alt+N" })
        );
    }

    #[test]
    fn autostart_info_json_是camelcase() {
        let v = serde_json::to_value(AutostartInfo {
            available: true,
            enabled: false,
            name: "app.shitetsu.nextstop".to_string(),
            debug_build: true,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "available": true, "enabled": false, "name": "app.shitetsu.nextstop", "debugBuild": true })
        );
    }

    #[test]
    fn hide_mode_從camelcase字串解析() {
        let saved: HideMode = serde_json::from_str("\"saved\"").unwrap();
        let esc: HideMode = serde_json::from_str("\"esc\"").unwrap();
        let hide: HideMode = serde_json::from_str("\"hide\"").unwrap();
        let revive: HideMode = serde_json::from_str("\"revive\"").unwrap();
        assert_eq!(
            (saved, esc, hide, revive),
            (HideMode::Saved, HideMode::Esc, HideMode::Hide, HideMode::Revive)
        );
        assert_eq!(HideMode::default(), HideMode::Hide);
    }

    /// 測試用的時間：以一個基準 Instant 往後加 ms
    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn stamp_沒開始播章_失焦照常收起() {
        let t0 = Instant::now();
        let s = StampState::default();
        assert!(!s.suppresses_blur(t0));
    }

    #[test]
    fn stamp_播章中的失焦不收_過了保護窗才收() {
        let t0 = Instant::now();
        let s = StampState::begin(t0);
        assert!(s.suppresses_blur(at(t0, 10))); // 剛還前景造成的失焦
        assert!(s.suppresses_blur(at(t0, 699)));
        assert!(!s.suppresses_blur(at(t0, 700))); // 保護窗過了
    }

    #[test]
    fn stamp_正常播完_hide不被吞() {
        let t0 = Instant::now();
        let mut s = StampState::begin(t0);
        assert!(!s.take_swallow_hide(at(t0, 400))); // 沒被叫回來 ⇒ 章計時器的 hide 要真的收
        assert_eq!(s, StampState::default()); // 狀態清乾淨
    }

    #[test]
    fn stamp_播章中被熱鍵叫回_舊章的hide吞一次() {
        let t0 = Instant::now();
        let mut s = StampState::begin(t0);
        assert!(s.on_show(at(t0, 200))); // 叫出時還在播章 ⇒ 要重新記前景
        assert!(!s.suppresses_blur(at(t0, 250))); // 已是新的一張票，之後的失焦算數
        assert!(s.take_swallow_hide(at(t0, 400))); // 舊章計時器到點的 hide ⇒ 吞掉
        assert!(!s.take_swallow_hide(at(t0, 410))); // 只吞一次：之後的 hide（例如點到外面）照常收
    }

    #[test]
    fn stamp_保護窗過了才叫出_不算被叫回() {
        let t0 = Instant::now();
        let mut s = StampState::begin(t0);
        assert!(!s.on_show(at(t0, 900))); // 章早就播完（前端沒送 hide 的話）⇒ 當作普通叫出
        assert_eq!(s, StampState::default());
        assert!(!s.take_swallow_hide(at(t0, 910)));
    }

    #[test]
    fn 常數與tauri_conf_label_一致() {
        // 小窗 label 與 tauri.conf.json 第二個視窗對得上（TS 端 shell.ts 的對帳在 notes-logic.test.ts）
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(&format!("\"label\": \"{CAPTURE_WINDOW}\"")));
        assert!(conf.contains("\"label\": \"main\""));
    }
}
