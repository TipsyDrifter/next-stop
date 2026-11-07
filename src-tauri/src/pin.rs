//! ⑬ 外部入口・桌面小窗殼層（契約 `docs/research/2026-11-06-外部入口-契約.md` 第三節、第九節）。
//!
//! 做什麼：常駐桌面一角的小窗（label `pin`，內容是獨立入口 `pin.html`），顯示正在跑的班次與今日還有幾張。
//! 這裡只管「視窗」——開關、置頂、位置、貼邊、跟著內容長高；內容資料全由主視窗的 `ExternalAgent` 用事件餵，
//! 小窗自己沒有 DB 權限（`capabilities/pin.json`）。
//!
//! 效能守則（照 ClaudeUsageMonitor 教訓）：
//!  * 按需建、關掉就銷毀：`tauri.conf.json` 寫 `create:false`，開才建，關用 `close()` 真的銷毀 webview（不是 hide），
//!    沒開小窗的人零成本。
//!  * 永遠不搶前景：設定檔 `focusable:false`＋`focus:false`，顯示只 `show()`，**絕不 `set_focus`**。
//!  * 沒人看就停：視窗被縮小時 `Webview::hide()`（WebView2 不知道自己被縮小，`visibilityState` 仍是 visible），還原時 `show()`。
//!
//! 狀態存檔 `app_config_dir/pin-window.json`（`visible`、`onTop`、`x`、`y`）：Rust 自己讀寫，不進 DB、不同步
//! （螢幕偏好不同步，D-1.1-3）。讀壞當預設。
//!
//! 整支 mod 只在 `cfg(desktop)` 編（手機走主畫面小工具）。
//!
//! **編譯狀態**：寫成時重活位被占用，**沒跑過 cargo**；外部 crate 簽名已對照本機 registry 原始碼
//! （tauri 2.11.2、tauri-runtime-wry 2.11.2、tao 0.35.2），剩下的風險是型別推論與借用細節。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, State};

// ───────────────────────── 常數 ─────────────────────────

pub const PIN_WINDOW: &str = "pin"; // tauri.conf.json 第三個視窗的 label
/// 全 App 廣播：`{ visible, onTop }`
pub const EV_VISIBILITY: &str = "pin:visibility";
/// 系統匣「桌面小窗」的選單 id（`tray.rs` 用）
pub const TRAY_MENU_ID: &str = "pin:toggle";

const STATE_FILE: &str = "pin-window.json";

/// 小窗寬固定 272 邏輯像素（契約三）；高度由內容決定，夾在 [H_MIN, H_MAX]
const PIN_W: f64 = 272.0;
const H_DEFAULT: f64 = 96.0;
const H_MIN: f64 = 60.0;
const H_MAX: f64 = 240.0;

/// 預設位置＝主螢幕工作區右下角，留 16 邏輯像素
const CORNER_MARGIN: f64 = 16.0;
/// 拖到離工作區邊 12 邏輯像素內就貼齊。必須小於 CORNER_MARGIN，預設位置才不會一開就被吸到角落
const SNAP_DIST: f64 = 12.0;
/// 視窗底離工作區底 24 邏輯像素內，算「貼著下緣」：長高時往上長、縮回來時底邊不動（含預設角落的 16px 邊）
const BOTTOM_ANCHOR_DIST: f64 = 24.0;
/// 拖曳停手這麼久才貼齊、存檔
const MOVE_DEBOUNCE: Duration = Duration::from_millis(300);
/// `pin_fit` 之後這段時間的 `Moved` 不算使用者放的（`set_position`／`set_size` 的事件是非同步回來的）
const FIT_MOVE_IGNORE: Duration = Duration::from_millis(500);
/// Windows 縮小的視窗座標是 (-32000, -32000)；小於這個值的位置不是使用者放的，不存
const OFFSCREEN_BELOW: i32 = -30000;

// ───────────────────────── 狀態 ─────────────────────────

/// 存檔內容（也是記憶體裡的現況）。欄位缺了、型別錯了都走預設——這是螢幕偏好，不值得為它擋啟動。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PinState {
    pub visible: bool,
    pub on_top: bool,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Default for PinState {
    fn default() -> Self {
        Self {
            visible: false,
            on_top: true,
            x: None,
            y: None,
        }
    }
}

/// `pin_status` 等 command 的回傳，也是 `pin:visibility` 的 payload
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinStatus {
    pub visible: bool,
    pub on_top: bool,
}

pub struct PinShell {
    file: Option<PathBuf>,
    state: Mutex<PinState>,
    /// 目前要的視窗高度（邏輯像素）；小窗掛上後 `pin_fit` 會更新，重開時用它建
    height: Mutex<f64>,
    /// 建窗進行中（鎖防連點重複建）
    building: AtomicBool,
    /// 位置去抖：每個 `Moved` 加一，停手後比對
    move_gen: AtomicU64,
    settle_running: AtomicBool,
    /// 到這時間之前忽略 `Moved`：`pin_fit` 造成的移動不該存檔——展開時的 y 存下來，重啟高度回 96 就往上偏
    ignore_moved_until: Mutex<Option<Instant>>,
    /// 我們因為「被縮小」把 webview 藏起來了
    hidden_by_minimize: AtomicBool,
}

impl PinShell {
    fn new(file: Option<PathBuf>, state: PinState) -> Self {
        Self {
            file,
            state: Mutex::new(state),
            height: Mutex::new(H_DEFAULT),
            building: AtomicBool::new(false),
            move_gen: AtomicU64::new(0),
            settle_running: AtomicBool::new(false),
            ignore_moved_until: Mutex::new(None),
            hidden_by_minimize: AtomicBool::new(false),
        }
    }
}

/// 鎖中毒時照樣拿值（裡面只有簡單的值，沒有需要維持的不變式）
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn status_of(st: &PinState) -> PinStatus {
    PinStatus {
        visible: st.visible,
        on_top: st.on_top,
    }
}

// ───────────────────────── 純函式（可測）─────────────────────────

/// 一個螢幕的工作區（物理像素，第二螢幕的 x、y 可能是負的）＋縮放
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Area {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub scale: f64,
}

impl Area {
    fn right(&self) -> i32 {
        self.x + self.w
    }
    fn bottom(&self) -> i32 {
        self.y + self.h
    }
    fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }
}

/// 邏輯像素 → 物理像素
fn phys(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

/// 高度夾在 [H_MIN, H_MAX]；不是有限數就退回預設
pub(crate) fn clamp_height(h: f64) -> f64 {
    if !h.is_finite() {
        return H_DEFAULT;
    }
    h.clamp(H_MIN, H_MAX)
}

/// 把 (x, y, w, h) 的視窗夾回工作區裡（視窗比工作區大時以左上角為準）
pub(crate) fn clamp_into(area: Area, x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    (
        x.min(area.right() - w).max(area.x),
        y.min(area.bottom() - h).max(area.y),
    )
}

/// 工作區右下角、留邊的左上角座標
pub(crate) fn corner_position(area: Area, w_logical: f64, h_logical: f64) -> (i32, i32) {
    let w = phys(w_logical, area.scale);
    let h = phys(h_logical, area.scale);
    let m = phys(CORNER_MARGIN, area.scale);
    clamp_into(area, area.right() - w - m, area.bottom() - h - m, w, h)
}

/// 開窗的位置：存檔的位置落在某個現有螢幕的工作區裡 ⇒ 夾回那個工作區；
/// 沒存檔、或那個螢幕被拔掉了 ⇒ 主螢幕右下角。連螢幕都查不到 ⇒ None（維持系統預設位置）。
/// 「落在螢幕裡」＝視窗中心點在某個工作區內。
pub(crate) fn pick_position(
    saved: Option<(i32, i32)>,
    w_logical: f64,
    h_logical: f64,
    areas: &[Area],
    primary: Option<Area>,
) -> Option<(i32, i32)> {
    if let Some((sx, sy)) = saved {
        for a in areas {
            let w = phys(w_logical, a.scale);
            let h = phys(h_logical, a.scale);
            if a.contains(sx + w / 2, sy + h / 2) {
                return Some(clamp_into(*a, sx, sy, w, h));
            }
        }
    }
    primary
        .or_else(|| areas.first().copied())
        .map(|a| corner_position(a, w_logical, h_logical))
}

/// 拖完貼齊：每個方向離工作區邊 `thr` 物理像素內就貼上去（左右、上下各自判斷，左／上優先）
pub(crate) fn snap(x: i32, y: i32, w: i32, h: i32, area: Area, thr: i32) -> (i32, i32) {
    let nx = if (x - area.x).abs() <= thr {
        area.x
    } else if (area.right() - (x + w)).abs() <= thr {
        area.right() - w
    } else {
        x
    };
    let ny = if (y - area.y).abs() <= thr {
        area.y
    } else if (area.bottom() - (y + h)).abs() <= thr {
        area.bottom() - h
    } else {
        y
    };
    (nx, ny)
}

/// 高度變了之後的新 y：視窗貼著工作區下緣（`anchor` 物理像素內）⇒ 底邊不動、往上長／往回縮；
/// 否則頂邊不動、往下長，但不能超出工作區下緣（超出就往上推），也不能超出上緣。
pub(crate) fn fit_y(area: Area, y: i32, old_h: i32, new_h: i32, anchor: i32) -> i32 {
    let bottom = y + old_h;
    let anchored = area.bottom() - bottom <= anchor;
    let ny = if anchored { bottom - new_h } else { y };
    ny.min(area.bottom() - new_h).max(area.y)
}

/// 這個 `Moved` 要不要忽略（`pin_fit` 設的期限還沒到）
pub(crate) fn moved_ignored(until: Option<Instant>, now: Instant) -> bool {
    until.is_some_and(|t| now < t)
}

/// 存檔內容 → 狀態；壞掉（不是 JSON、欄位型別錯）一律回預設
pub(crate) fn parse_state(text: &str) -> PinState {
    serde_json::from_str(text).unwrap_or_default()
}

// ───────────────────────── 存檔 ─────────────────────────

fn load_state(path: &Path) -> PinState {
    std::fs::read_to_string(path)
        .map(|t| parse_state(&t))
        .unwrap_or_default()
}

/// 先寫暫存檔再改名，斷電不會留下半份。失敗只 log——位置沒存到不是大事。
fn save_state(shell: &PinShell, st: &PinState) {
    let Some(path) = shell.file.as_ref() else {
        return;
    };
    let result = (|| -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(st).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        eprintln!("[pin] 存 {STATE_FILE} 失敗：{e}");
    }
}

/// 改狀態＋存檔；回傳改完的 status。`f` 回 false 表示沒有變動（不存檔）。
fn update_state<R: Runtime>(
    app: &AppHandle<R>,
    f: impl FnOnce(&mut PinState) -> bool,
) -> Option<PinStatus> {
    let shell = app.try_state::<PinShell>()?;
    let mut st = lock(&shell.state);
    if f(&mut *st) {
        save_state(&shell, &st);
    }
    Some(status_of(&st))
}

fn emit_visibility<R: Runtime>(app: &AppHandle<R>, status: PinStatus) {
    if let Err(e) = app.emit(EV_VISIBILITY, status) {
        eprintln!("[pin] 送 {EV_VISIBILITY} 事件失敗：{e}");
    }
}

// ───────────────────────── 螢幕 ─────────────────────────

fn area_of(m: &tauri::window::Monitor) -> Area {
    let wa = m.work_area();
    Area {
        x: wa.position.x,
        y: wa.position.y,
        w: wa.size.width as i32,
        h: wa.size.height as i32,
        scale: m.scale_factor(),
    }
}

fn initial_position<R: Runtime>(app: &AppHandle<R>, saved: Option<(i32, i32)>, h_logical: f64) -> Option<(i32, i32)> {
    let areas: Vec<Area> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(area_of)
        .collect();
    let primary = app.primary_monitor().ok().flatten().map(|m| area_of(&m));
    pick_position(saved, PIN_W, h_logical, &areas, primary)
}

// ───────────────────────── 開關 ─────────────────────────

/// 所有入口（啟動還原、`pin_set_visible(true)`、系統匣）都走這一支：**找得到就用、找不到就建**。
/// 建窗丟到 async runtime，不在呼叫端（可能是主執行緒的事件回呼）同步建——Windows 上會死結（同 capture.rs）。
/// `building` 防連點：建到一半又來一次就略過，先來的那個會建完。
fn open<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(PIN_WINDOW) {
        reveal(app, &w);
        return;
    }
    let Some(shell) = app.try_state::<PinShell>() else {
        return;
    };
    if shell.building.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = build_and_reveal(&app);
        if let Some(shell) = app.try_state::<PinShell>() {
            shell.building.store(false, Ordering::SeqCst);
        }
        if let Err(e) = result {
            eprintln!("[pin] 建立小窗失敗：{e}");
            // 沒開成就別讓開關停在「開」
            if let Some(status) = update_state(&app, |st| std::mem::replace(&mut st.visible, false)) {
                emit_visibility(&app, status);
            }
        }
    });
}

fn build_and_reveal<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|c| c.label == PIN_WINDOW)
        .cloned()
        .ok_or_else(|| format!("tauri.conf.json 沒有 `{PIN_WINDOW}` 視窗設定"))?;
    let w = tauri::WebviewWindowBuilder::from_config(app, &cfg)
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?;
    if let Some(shell) = app.try_state::<PinShell>() {
        shell.hidden_by_minimize.store(false, Ordering::SeqCst);
        // 建窗這段時間使用者又按了關 ⇒ 建好就銷毀
        if !lock(&shell.state).visible {
            let _ = w.close();
            return Ok(());
        }
    }
    reveal(app, &w);
    Ok(())
}

/// 把（已存在的）小窗放到該去的位置並顯示。**絕不 set_focus**：視窗是 `focusable:false`，`show()` 也不搶前景。
/// 已經顯示著就只同步置頂，不動位置（不然使用者拖好的位置會被拉回去）。
fn reveal<R: Runtime>(app: &AppHandle<R>, w: &tauri::WebviewWindow<R>) {
    let Some(shell) = app.try_state::<PinShell>() else {
        return;
    };
    let (on_top, saved) = {
        let st = lock(&shell.state);
        (st.on_top, st.x.zip(st.y))
    };
    let h = *lock(&shell.height);
    if let Err(e) = w.set_always_on_top(on_top) {
        eprintln!("[pin] set_always_on_top 失敗：{e}");
    }
    if w.is_visible().unwrap_or(false) {
        return;
    }
    if let Some((x, y)) = initial_position(app, saved, h) {
        if let Err(e) = w.set_position(PhysicalPosition::new(x, y)) {
            eprintln!("[pin] set_position 失敗：{e}");
        }
    }
    if let Err(e) = w.set_size(LogicalSize::new(PIN_W, h)) {
        eprintln!("[pin] set_size 失敗：{e}");
    }
    if let Err(e) = w.show() {
        eprintln!("[pin] show 失敗：{e}");
    }
}

/// 關：`close()` 真的銷毀 webview（不是 hide）。找不到就是已經關了。
fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(PIN_WINDOW) {
        if let Err(e) = w.close() {
            eprintln!("[pin] close 失敗：{e}");
        }
    }
}

/// 開關的共用實作（command 與系統匣都叫它）：改狀態、存檔、開或關、廣播
fn set_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) -> Option<PinStatus> {
    let status = update_state(app, |st| {
        let changed = st.visible != visible;
        st.visible = visible;
        changed
    })?;
    if visible {
        open(app);
    } else {
        close(app);
    }
    emit_visibility(app, status);
    Some(status)
}

/// 系統匣「桌面小窗」：切換顯示
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let Some(shell) = app.try_state::<PinShell>() else {
        return;
    };
    let now = lock(&shell.state).visible;
    set_visible(app, !now);
}

/// `lib.rs` 的 `.setup` 開頭：讀存檔、manage。不會失敗（讀壞當預設）、只讀不寫，所以能排在第一個可能的事件之前（理由見 `lib.rs`）。
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    let file = app.path().app_config_dir().ok().map(|d| d.join(STATE_FILE));
    let st = file.as_deref().map(load_state).unwrap_or_default();
    app.manage(PinShell::new(file, st));
}

/// `lib.rs` 的 `.setup`（`tray::init` 之後）：上次開著就建窗（含開機自啟）。失敗只 log。
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let visible = app
        .try_state::<PinShell>()
        .map(|shell| lock(&shell.state).visible)
        .unwrap_or(false);
    if visible {
        open(app);
    }
    Ok(())
}

// ───────────────────────── 視窗事件 ─────────────────────────

/// `lib.rs` `.on_window_event` 閉包裡加一行。只認 label `pin`：
/// * `Moved`：去抖後貼齊、存位置（`pin_fit` 自己造成的不算）。
/// * `Resized`：被縮小 ⇒ `Webview::hide()`；還原 ⇒ `show()`。
/// * `CloseRequested`（使用者 Alt+F4；程式自己 `close()` 時狀態早已是 false）：記成「關」，不攔。
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if window.label() != PIN_WINDOW {
        return;
    }
    match event {
        tauri::WindowEvent::Moved(_) => {
            let app = window.app_handle();
            let ignored = app
                .try_state::<PinShell>()
                .map(|shell| moved_ignored(*lock(&shell.ignore_moved_until), Instant::now()))
                .unwrap_or(false);
            if ignored {
                return;
            }
            schedule_settle(app);
        }
        tauri::WindowEvent::Resized(_) => sync_minimized(window),
        tauri::WindowEvent::CloseRequested { .. } => {
            let app = window.app_handle();
            let mut was_visible = false;
            let status = update_state(app, |st| {
                was_visible = st.visible;
                std::mem::replace(&mut st.visible, false)
            });
            if let (true, Some(status)) = (was_visible, status) {
                emit_visibility(app, status);
            }
        }
        _ => {}
    }
}

/// 縮小／還原時開關 webview。WebView2 不知道視窗被縮小（`visibilityState` 仍是 visible，toolchain 第 18 條），
/// 小窗的計時器會白跑；藏起來它才會停。動 webview 丟到 async runtime，不在事件回呼裡直接做。
fn sync_minimized<R: Runtime>(window: &tauri::Window<R>) {
    let app = window.app_handle();
    let Some(shell) = app.try_state::<PinShell>() else {
        return;
    };
    let minimized = window.is_minimized().unwrap_or(false);
    if shell.hidden_by_minimize.swap(minimized, Ordering::SeqCst) == minimized {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(w) = app.get_webview_window(PIN_WINDOW) else {
            return;
        };
        let wv: &tauri::Webview<R> = w.as_ref();
        // Webview::show 只切 webview 可見，不會把視窗帶到前景
        let result = if minimized { wv.hide() } else { wv.show() };
        if let Err(e) = result {
            eprintln!("[pin] webview {} 失敗：{e}", if minimized { "hide" } else { "show" });
        }
    });
}

/// 拖曳中 `Moved` 一秒好幾十次：每次只把世代加一，由一條背景執行緒每 300ms 看一次世代有沒有動，
/// 停手了才貼齊＋存檔。同一時間最多一條執行緒。
fn schedule_settle<R: Runtime>(app: &AppHandle<R>) {
    let Some(shell) = app.try_state::<PinShell>() else {
        return;
    };
    let first = shell.move_gen.fetch_add(1, Ordering::SeqCst) + 1;
    if shell.settle_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut seen = first;
        loop {
            std::thread::sleep(MOVE_DEBOUNCE);
            let Some(shell) = app.try_state::<PinShell>() else {
                return;
            };
            let now = shell.move_gen.load(Ordering::SeqCst);
            if now != seen {
                seen = now;
                continue;
            }
            settle(&app);
            shell.settle_running.store(false, Ordering::SeqCst);
            // 放掉旗標的空檔又有 Moved 進來 ⇒ 自己接著做，不漏
            let latest = shell.move_gen.load(Ordering::SeqCst);
            if latest != seen && !shell.settle_running.swap(true, Ordering::SeqCst) {
                seen = latest;
                continue;
            }
            return;
        }
    });
}

/// 停手後：貼齊工作區邊（離邊 12 邏輯像素內），然後把位置存檔。縮小中、沒顯示、座標不合理就什麼都不做。
fn settle<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = app.get_webview_window(PIN_WINDOW) else {
        return;
    };
    if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
        return;
    };
    if pos.x <= OFFSCREEN_BELOW || pos.y <= OFFSCREEN_BELOW {
        return;
    }
    let (ww, wh) = (size.width as i32, size.height as i32);
    let cx = f64::from(pos.x) + f64::from(ww) / 2.0;
    let cy = f64::from(pos.y) + f64::from(wh) / 2.0;
    let (mut x, mut y) = (pos.x, pos.y);
    if let Some(mon) = app.monitor_from_point(cx, cy).ok().flatten() {
        let area = area_of(&mon);
        let thr = phys(SNAP_DIST, area.scale);
        let (nx, ny) = snap(x, y, ww, wh, area, thr);
        if (nx, ny) != (x, y) {
            if let Err(e) = w.set_position(PhysicalPosition::new(nx, ny)) {
                eprintln!("[pin] 貼齊 set_position 失敗：{e}");
            } else {
                (x, y) = (nx, ny);
            }
        }
    }
    update_state(app, |st| {
        let changed = st.x != Some(x) || st.y != Some(y);
        st.x = Some(x);
        st.y = Some(y);
        changed
    });
}

// ───────────────────────── commands ─────────────────────────

#[tauri::command]
pub fn pin_status(shell: State<'_, PinShell>) -> PinStatus {
    status_of(&lock(&shell.state))
}

/// 開／關小窗。開＝建窗（若還沒有）、照存檔定位、顯示，不搶前景；關＝銷毀。狀態一變存檔並廣播 `pin:visibility`。
#[tauri::command]
pub async fn pin_set_visible(app: AppHandle, visible: bool) -> Result<PinStatus, String> {
    set_visible(&app, visible).ok_or_else(|| "桌面小窗尚未初始化".to_string())
}

#[tauri::command]
pub async fn pin_set_on_top(app: AppHandle, on_top: bool) -> Result<PinStatus, String> {
    let status = update_state(&app, |st| {
        let changed = st.on_top != on_top;
        st.on_top = on_top;
        changed
    })
    .ok_or_else(|| "桌面小窗尚未初始化".to_string())?;
    if let Some(w) = app.get_webview_window(PIN_WINDOW) {
        w.set_always_on_top(on_top).map_err(|e| e.to_string())?;
    }
    emit_visibility(&app, status);
    Ok(status)
}

/// 小窗跟著內容長高：`height` 是邏輯像素，夾 [60, 240]，寬固定 272。
/// 貼著工作區下緣時往上長（預設的右下角就是；「換車 ▾」往下展開才不會掉出螢幕），縮回來底邊不動。
#[tauri::command]
pub async fn pin_fit(app: AppHandle, height: f64) -> Result<(), String> {
    let h = clamp_height(height);
    let Some(shell) = app.try_state::<PinShell>() else {
        return Ok(());
    };
    *lock(&shell.height) = h;
    let Some(w) = app.get_webview_window(PIN_WINDOW) else {
        return Ok(());
    };
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    let inner = w.inner_size().map_err(|e| e.to_string())?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    // set_size 設的是內容高；位置算的是含外框的高（Windows 的隱形邊框），差的要補上，底邊才對得齊
    let frame = size.height.saturating_sub(inner.height) as i32;
    let (old_h, new_h) = (size.height as i32, phys(h, scale) + frame);
    // 縮小中的座標是 (-32000, -32000)：只改尺寸，不算位置
    let new_y = if pos.y > OFFSCREEN_BELOW && old_h != new_h {
        let cx = f64::from(pos.x) + f64::from(size.width) / 2.0;
        let cy = f64::from(pos.y) + f64::from(old_h) / 2.0;
        app.monitor_from_point(cx, cy)
            .ok()
            .flatten()
            .map(|m| fit_y(area_of(&m), pos.y, old_h, new_h, phys(BOTTOM_ANCHOR_DIST, scale)))
    } else {
        None
    };
    *lock(&shell.ignore_moved_until) = Some(Instant::now() + FIT_MOVE_IGNORE);
    w.set_size(LogicalSize::new(PIN_W, h)).map_err(|e| e.to_string())?;
    if let Some(y) = new_y.filter(|&y| y != pos.y) {
        w.set_position(PhysicalPosition::new(pos.x, y)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920×1080、工作區扣掉下方 40px 工作列、縮放 1.0
    const MAIN: Area = Area {
        x: 0,
        y: 0,
        w: 1920,
        h: 1040,
        scale: 1.0,
    };
    /// 主螢幕左邊的第二螢幕（座標為負）
    const LEFT: Area = Area {
        x: -1920,
        y: 0,
        w: 1920,
        h: 1080,
        scale: 1.0,
    };

    #[test]
    fn 角落_右下留16() {
        // x = 1920-272-16 = 1632；y = 1040-96-16 = 928
        assert_eq!(corner_position(MAIN, 272.0, 96.0), (1632, 928));
    }

    #[test]
    fn 角落_縮放2倍用物理像素算() {
        let a = Area { x: 0, y: 0, w: 3840, h: 2080, scale: 2.0 };
        // 視窗 544×192、邊 32：x = 3840-544-32 = 3264；y = 2080-192-32 = 1856
        assert_eq!(corner_position(a, 272.0, 96.0), (3264, 1856));
    }

    #[test]
    fn 角落_第二螢幕座標為負() {
        assert_eq!(corner_position(LEFT, 272.0, 96.0), (-288, 968));
    }

    #[test]
    fn 夾範圍() {
        assert_eq!(clamp_into(MAIN, 5000, 5000, 272, 96), (1648, 944));
        assert_eq!(clamp_into(MAIN, -50, -50, 272, 96), (0, 0));
        assert_eq!(clamp_into(MAIN, 100, 100, 272, 96), (100, 100));
        // 視窗比工作區還大：以左上角為準
        assert_eq!(clamp_into(MAIN, 10, 10, 3000, 3000), (0, 0));
    }

    #[test]
    fn 還原位置_存檔的在螢幕內_照用() {
        let areas = [MAIN, LEFT];
        assert_eq!(pick_position(Some((300, 200)), 272.0, 96.0, &areas, Some(MAIN)), Some((300, 200)));
        assert_eq!(pick_position(Some((-500, 200)), 272.0, 96.0, &areas, Some(MAIN)), Some((-500, 200)));
    }

    #[test]
    fn 還原位置_螢幕被拔掉_回主螢幕右下角() {
        // 存的位置在左邊第二螢幕，現在只剩主螢幕
        assert_eq!(pick_position(Some((-500, 200)), 272.0, 96.0, &[MAIN], Some(MAIN)), Some((1632, 928)));
    }

    #[test]
    fn 還原位置_沒存檔_右下角() {
        assert_eq!(pick_position(None, 272.0, 96.0, &[MAIN], Some(MAIN)), Some((1632, 928)));
    }

    #[test]
    fn 還原位置_解析度變小_夾回工作區() {
        let small = Area { x: 0, y: 0, w: 1280, h: 680, scale: 1.0 };
        // 中心 (1400+136, 600+48) 在 1280 寬外 ⇒ 不算在螢幕內 ⇒ 右下角
        assert_eq!(pick_position(Some((1400, 600)), 272.0, 96.0, &[small], Some(small)), Some((992, 568)));
        // 中心在內但右、下邊超出 ⇒ 夾回
        assert_eq!(pick_position(Some((1100, 600)), 272.0, 96.0, &[small], Some(small)), Some((1008, 584)));
    }

    #[test]
    fn 還原位置_沒有螢幕資訊() {
        assert_eq!(pick_position(Some((10, 10)), 272.0, 96.0, &[], None), None);
        // 查不到主螢幕但有螢幕清單 ⇒ 用第一個
        assert_eq!(pick_position(None, 272.0, 96.0, &[MAIN], None), Some((1632, 928)));
    }

    #[test]
    fn 貼齊_離邊12內吸過去() {
        // 左、上
        assert_eq!(snap(10, 8, 272, 96, MAIN, 12), (0, 0));
        // 右、下：右緣離 1920 還差 5、下緣離 1040 還差 12
        assert_eq!(snap(1643, 932, 272, 96, MAIN, 12), (1648, 944));
    }

    #[test]
    fn 貼齊_超過距離不動() {
        assert_eq!(snap(13, 13, 272, 96, MAIN, 12), (13, 13));
        assert_eq!(snap(500, 400, 272, 96, MAIN, 12), (500, 400));
    }

    #[test]
    fn 貼齊_預設角落的16邊不會被吸走() {
        let (x, y) = corner_position(MAIN, 272.0, 96.0);
        assert_eq!(snap(x, y, 272, 96, MAIN, phys(SNAP_DIST, 1.0)), (x, y));
    }

    #[test]
    fn 貼齊_第二螢幕() {
        assert_eq!(snap(-1915, 5, 272, 96, LEFT, 12), (-1920, 0));
    }

    #[test]
    fn 長高_貼著下緣往上長_縮回底邊不動() {
        // 預設角落：y=928、高96、底 1024，離工作區底 1040 還有 16（在 24 錨定距離內）
        assert_eq!(fit_y(MAIN, 928, 96, 220, 24), 804);
        assert_eq!(fit_y(MAIN, 804, 220, 96, 24), 928);
    }

    #[test]
    fn 長高_不在下緣_往下長_超出就推回來() {
        assert_eq!(fit_y(MAIN, 300, 96, 220, 24), 300);
        // 底在 896，往下長到 260 會超出工作區底 1040 ⇒ 往上推到 780
        assert_eq!(fit_y(MAIN, 800, 96, 260, 24), 780);
        assert_eq!(fit_y(MAIN, 700, 96, 240, 24), 700);
    }

    #[test]
    fn 長高_不超出上緣() {
        let short = Area { x: 0, y: 0, w: 800, h: 150, scale: 1.0 };
        assert_eq!(fit_y(short, 40, 96, 240, 24), 0);
    }

    #[test]
    fn 忽略移動_只在期限內() {
        let t0 = Instant::now();
        assert!(!moved_ignored(None, t0));
        let until = Some(t0 + FIT_MOVE_IGNORE);
        assert!(moved_ignored(until, t0));
        assert!(!moved_ignored(until, t0 + FIT_MOVE_IGNORE));
    }

    #[test]
    fn 高度夾60到240() {
        assert_eq!(clamp_height(10.0), 60.0);
        assert_eq!(clamp_height(96.0), 96.0);
        assert_eq!(clamp_height(999.0), 240.0);
        assert_eq!(clamp_height(f64::NAN), 96.0);
        assert_eq!(clamp_height(f64::INFINITY), 96.0);
    }

    #[test]
    fn 存檔_預設值() {
        let d = PinState::default();
        assert!(!d.visible);
        assert!(d.on_top);
        assert_eq!((d.x, d.y), (None, None));
    }

    #[test]
    fn 存檔_讀壞當預設() {
        assert_eq!(parse_state(""), PinState::default());
        assert_eq!(parse_state("not json"), PinState::default());
        assert_eq!(parse_state(r#"{"visible":"yes"}"#), PinState::default());
        assert_eq!(parse_state("[]"), PinState::default());
    }

    #[test]
    fn 存檔_欄位缺了補預設() {
        let s = parse_state(r#"{"visible":true}"#);
        assert!(s.visible);
        assert!(s.on_top);
        assert_eq!(s.x, None);
    }

    #[test]
    fn 存檔_json是camelcase且來回一致() {
        let st = PinState { visible: true, on_top: false, x: Some(-300), y: Some(40) };
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!(v, serde_json::json!({ "visible": true, "onTop": false, "x": -300, "y": 40 }));
        assert_eq!(parse_state(&v.to_string()), st);
    }

    #[test]
    fn status的json是camelcase() {
        let v = serde_json::to_value(PinStatus { visible: true, on_top: false }).unwrap();
        assert_eq!(v, serde_json::json!({ "visible": true, "onTop": false }));
    }

    #[test]
    fn 常數與tauri_conf_一致() {
        // 小窗 label、create:false、不聚焦等設定寫在 tauri.conf.json；這裡只鎖最容易被誤改的幾個字
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(&format!("\"label\": \"{PIN_WINDOW}\"")));
        assert!(conf.contains("\"url\": \"pin.html\""));
        assert!(conf.contains("\"focusable\": false"));
        assert!(conf.contains(&format!("\"width\": {}", PIN_W as i32)));
    }
}
