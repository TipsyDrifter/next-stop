//! ⑬ 外部入口・桌機收連結（契約 `docs/research/2026-11-06-外部入口-契約.md` 第二節、第九節）。
//!
//! 做什麼：`nextstop://…` 連結從兩條路進來——冷啟動的 argv、第二個行程經 single-instance 帶回來的 argv——
//! 都先寫進**記憶體佇列**，再發事件 `ns-external-open` 叫 JS 來取（`external_take`），JS 處理完才 `external_ack`。
//! 「落地、JS 取一次、確認才刪」：JS 還沒掛上就來的連結不會掉，處理到一半 App 掛了也不會被當成已處理。
//!
//! 「不開 App」的連結（発車／到着）不叫出主視窗，其餘的叫出來；這個判斷在 TS（`externalLink.ts`）、Rust、Kotlin 各有一份，
//! 三份用同一張案例表 `scripts/tests/fixtures/external-links.json` 測。
//!
//! Windows：開機時把 scheme 寫進 `HKCU\Software\Classes\<scheme>`（不要系統管理員、不要安裝器 hook）；內容沒變不寫。
//! 不用 `tauri-plugin-deep-link`：dev 與沙盒要各用各的 scheme，而我們只需要寫登錄與讀 argv。
//!
//! 整支 mod 只在 `cfg(desktop)` 編（手機走 tt-notice 的 `NsExternalOpenActivity`）。
//!
//! **編譯狀態**：寫成時重活位被占用，**沒跑過 cargo**；外部 crate 簽名已對照本機 registry 原始碼
//! （tauri 2.11.2、tauri-plugin-single-instance 2.4.5、winreg 0.55.0）。

use std::ffi::OsString;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::tray;

/// 事件：佇列有新連結，JS 來取
pub const EV_OPEN: &str = "ns-external-open";

/// 單一連結長度上限（與 TS `parseExternalLink` 同）；超過直接丟掉
const MAX_LINK_LEN: usize = 2048;

/// 佇列上限：JS 一直沒來取（沒掛上）時，不讓記憶體無限長；超過丟最舊的
const MAX_QUEUE: usize = 64;

/// 正式版的 identifier（scheme 對照用）
const OFFICIAL_IDENTIFIER: &str = "app.shitetsu.nextstop";
const OFFICIAL_SCHEME: &str = "nextstop";

// ───────────────────────── 純函式（可測）─────────────────────────

/// scheme 由 identifier 決定，dev 與沙盒才不會去搶正式版的連結：
/// 正式 `app.shitetsu.nextstop` → `nextstop`；其他 → `nextstop-` ＋ 去掉 `app.shitetsu.nextstop.` 的部分、點換連字號
/// （`…nextstop.dev.ticket` → `nextstop-dev-ticket`）。字母轉小寫，其餘不合法字元也換連字號。
pub(crate) fn scheme_for(identifier: &str) -> String {
    let id = identifier.trim();
    if id.is_empty() || id == OFFICIAL_IDENTIFIER {
        return OFFICIAL_SCHEME.to_string();
    }
    let rest = id
        .strip_prefix(OFFICIAL_IDENTIFIER)
        .map(|r| r.trim_start_matches('.'))
        .unwrap_or(id);
    let rest: String = rest
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                '-'
            }
        })
        .collect();
    let rest = rest.trim_matches('-');
    if rest.is_empty() {
        OFFICIAL_SCHEME.to_string()
    } else {
        format!("{OFFICIAL_SCHEME}-{rest}")
    }
}

/// 桌機提醒的連結：`<scheme>://reminder?target=<落點 JSON 的百分比編碼>`（`reminder_toast` 放進 toast 的 launch）。
/// 只有英數與 `-_.~` 不編碼，同 JS 的 `encodeURIComponent` 解得回來。
pub(crate) fn reminder_link(scheme: &str, target: &str) -> String {
    let mut out = format!("{scheme}://reminder?target=");
    for b in target.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// scheme 是否符合 `/^nextstop(-[a-z0-9-]+)?$/`（大小寫不敏感）
fn is_valid_scheme(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower == OFFICIAL_SCHEME
        || lower
            .strip_prefix("nextstop-")
            .is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

/// 超過上限？長度照 TS／Kotlin 的算法（UTF-16 單位），三份對同一條連結的判斷才一致；ASCII 連結走快路徑
fn too_long(url: &str) -> bool {
    url.len() > MAX_LINK_LEN && url.encode_utf16().count() > MAX_LINK_LEN
}

/// 這個字串是不是「我們這個 scheme」的連結（`<scheme>://…`，scheme 不分大小寫；超長的不算）
pub(crate) fn is_our_link(url: &str, scheme: &str) -> bool {
    if scheme.is_empty() || too_long(url) {
        return false;
    }
    url.split_once("://").is_some_and(|(s, _)| s.eq_ignore_ascii_case(scheme))
}

/// 「不開 App」的連結：到着（`arrive`）與帶分類的発車（`depart?category=<非空>`）。
/// 認不得、超長、scheme 不合規格的一律 false（＝照一般連結開 App 告知）。
/// `depart?ticket=…` 要開 App（可能要選分類），所以不算。
pub(crate) fn is_silent_link(url: &str) -> bool {
    if too_long(url) {
        return false;
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    if !is_valid_scheme(scheme) {
        return false;
    }
    let rest = rest.split('#').next().unwrap_or("");
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.eq_ignore_ascii_case("arrive") {
        return true;
    }
    if path.eq_ignore_ascii_case("depart") {
        // 與 TS `queryOf` 同：空鍵的略過、同名取第一個；值要解得開百分比編碼、且不是空的
        let first = query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| *k == "category");
        return first.is_some_and(|(_, v)| !v.is_empty() && percent_decodes(v));
    }
    false
}

/// 冷啟動的 argv（第 0 個是執行檔本身）：至少一個自己 scheme 的連結、且全部都不開 App。
/// 是的話主視窗這趟不該彈出來（`capture::setup`）。認連結的規則與 `handle_argv` 相同，兩邊對同一份 argv 的判斷才一致；
/// 吃 `OsString` 的理由同 `capture::is_minimized_launch`。
pub(crate) fn is_silent_launch<I: IntoIterator<Item = OsString>>(args: I, scheme: &str) -> bool {
    let mut any = false;
    for arg in args.into_iter().skip(1) {
        let arg = arg.to_string_lossy();
        if !is_our_link(&arg, scheme) {
            continue;
        }
        if !is_silent_link(&arg) {
            return false;
        }
        any = true;
    }
    any
}

/// 值是否解得開（對應 JS `decodeURIComponent` 不丟 URIError）：`%` 後要兩個十六進位數字，解出的位元組要是合法 UTF-8。
/// `+` 在 TS 先換成空格，不影響能不能解。
fn percent_decodes(s: &str) -> bool {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            // from_str_radix 會吃 `+1`，JS 不吃：先確認兩位都是十六進位數字
            let hex = b
                .get(i + 1..i + 3)
                .filter(|h| h.iter().all(u8::is_ascii_hexdigit))
                .and_then(|h| std::str::from_utf8(h).ok());
            match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(v) => out.push(v),
                None => return false,
            }
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).is_ok()
}

/// 登錄檔 `shell\open\command` 的預設值：`"<exe>" "%1"`
pub(crate) fn open_command(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

// ───────────────────────── 佇列 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExternalItem {
    pub id: String,
    pub url: String,
    /// 連結進來的時間（epoch ms）：JS 可能過一陣子才輪到它，発車到着要記使用者點的那一刻
    pub at: i64,
}

#[derive(Debug, Serialize)]
pub struct ExternalTake {
    pub items: Vec<ExternalItem>,
}

pub struct ExternalState {
    scheme: String,
    queue: Mutex<Vec<ExternalItem>>,
}

/// 鎖中毒時照樣拿值（佇列只是一串字串，沒有要維持的不變式）
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ExternalState {
    fn new(scheme: String) -> Self {
        Self {
            scheme,
            queue: Mutex::new(Vec::new()),
        }
    }

    /// 排進佇列；超長的丟掉（回 false）
    fn push(&self, url: &str) -> bool {
        if too_long(url) {
            return false;
        }
        let mut q = lock(&self.queue);
        if q.len() >= MAX_QUEUE {
            q.remove(0);
        }
        q.push(ExternalItem {
            id: uuid::Uuid::new_v4().to_string(),
            url: url.to_string(),
            at: now_ms(),
        });
        true
    }

    /// 只讀不清
    fn items(&self) -> Vec<ExternalItem> {
        lock(&self.queue).clone()
    }

    fn ack(&self, ids: &[String]) {
        lock(&self.queue).retain(|it| !ids.contains(&it.id));
    }
}

// ───────────────────────── 收連結 ─────────────────────────

/// argv（第 0 個是執行檔本身）裡有自己 scheme 的連結 ⇒ 排進佇列、發 `ns-external-open`；
/// 有任何一條「要開 App」的 ⇒ 叫出主視窗，全是「不開 App」的就不叫。回 true＝這份 argv 是連結、已處理，
/// 回 false＝沒連結，呼叫端照舊（single-instance 回呼就是叫出主視窗）。
pub fn handle_argv<R: Runtime>(app: &AppHandle<R>, argv: &[String]) -> bool {
    let Some(state) = app.try_state::<ExternalState>() else {
        return false;
    };
    let mut any = false;
    let mut needs_window = false;
    for arg in argv.iter().skip(1) {
        if !is_our_link(arg, &state.scheme) {
            continue;
        }
        if !state.push(arg) {
            eprintln!("[external] 連結超過 {MAX_LINK_LEN} 字元，丟掉");
            continue;
        }
        any = true;
        if !is_silent_link(arg) {
            needs_window = true;
        }
    }
    if any {
        if let Err(e) = app.emit(EV_OPEN, ()) {
            eprintln!("[external] 送 {EV_OPEN} 事件失敗：{e}");
        }
        if needs_window {
            tray::show_main_window(app);
        }
    }
    any
}

/// `lib.rs` 的 `.setup` 開頭：只 manage 佇列。不會失敗、沒有副作用，所以能排在第一個可能的連結之前（理由見 `lib.rs`）。
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    app.manage(ExternalState::new(scheme_for(&app.config().identifier)));
}

/// `lib.rs` 的 `.setup`（`tray::init` 之後）：寫 scheme 登錄（Windows）→ 收冷啟動 argv。失敗只 log。
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    #[cfg(windows)]
    {
        let scheme = scheme_for(&app.config().identifier);
        if let Err(e) = register_protocol(&scheme) {
            eprintln!("[external] 寫入 {scheme}:// 的登錄失敗（從瀏覽器點連結開不起來）：{e}");
        }
    }

    // 冷啟動：連結就在自己的 argv 裡（lossy：非 Unicode 的參數不該讓啟動 panic）
    let argv: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect();
    handle_argv(app, &argv);
    Ok(())
}

/// `HKCU\Software\Classes\<scheme>` 要長這樣（內容全對就不寫）：
/// 預設值 `URL:Next Stop`、`URL Protocol`（空字串）、`shell\open\command` 預設值 `"<exe>" "%1"`。
/// HKCU 不需要系統管理員；exe 換位置（重裝、dev 重編）時下次開機自己更新。
#[cfg(windows)]
fn register_protocol(scheme: &str) -> std::io::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const FRIENDLY: &str = "URL:Next Stop";

    let exe = std::env::current_exe()?;
    let want_cmd = open_command(&exe.to_string_lossy());
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let base = format!(r"Software\Classes\{scheme}");
    let cmd_path = format!(r"{base}\shell\open\command");

    let base_key = hkcu.open_subkey(&base).ok();
    let cur_name = base_key.as_ref().and_then(|k| k.get_value::<String, _>("").ok());
    let cur_proto = base_key.as_ref().and_then(|k| k.get_value::<String, _>("URL Protocol").ok());
    let cur_cmd = hkcu
        .open_subkey(&cmd_path)
        .ok()
        .and_then(|k| k.get_value::<String, _>("").ok());
    if cur_name.as_deref() == Some(FRIENDLY) && cur_proto.as_deref() == Some("") && cur_cmd.as_deref() == Some(want_cmd.as_str())
    {
        return Ok(());
    }

    let (base_key, _) = hkcu.create_subkey(&base)?;
    base_key.set_value("", &FRIENDLY)?;
    base_key.set_value("URL Protocol", &"")?;
    let (cmd_key, _) = hkcu.create_subkey(&cmd_path)?;
    cmd_key.set_value("", &want_cmd)?;
    Ok(())
}

// ───────────────────────── commands ─────────────────────────

/// 佇列裡還沒確認的連結。只讀不清——清要等 `external_ack`。
#[tauri::command]
pub fn external_take(state: State<'_, ExternalState>) -> ExternalTake {
    ExternalTake { items: state.items() }
}

/// JS 處理完了，把這些 id 從佇列拿掉
#[tauri::command]
pub fn external_ack(state: State<'_, ExternalState>, ids: Vec<String>) {
    state.ack(&ids);
}

/// 這個行程認的 scheme（設定頁「複製連結」用）
#[tauri::command]
pub fn external_scheme(state: State<'_, ExternalState>) -> String {
    state.scheme.clone()
}

/// 叫出主視窗（小窗的「開今日」「開時刻表」按了之後，主視窗可能藏在系統匣）
#[tauri::command]
pub async fn external_show_main(app: AppHandle) {
    tray::show_main_window(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheme_正式版是nextstop() {
        assert_eq!(scheme_for("app.shitetsu.nextstop"), "nextstop");
        assert_eq!(scheme_for(""), "nextstop");
    }

    #[test]
    fn scheme_其他identifier去前綴_點換連字號() {
        assert_eq!(scheme_for("app.shitetsu.nextstop.dev.ticket"), "nextstop-dev-ticket");
        assert_eq!(scheme_for("app.shitetsu.nextstop.sandbox.a"), "nextstop-sandbox-a");
        assert_eq!(scheme_for("app.shitetsu.nextstop.dev"), "nextstop-dev");
        // 前綴後面只剩點 ⇒ 當正式版
        assert_eq!(scheme_for("app.shitetsu.nextstop."), "nextstop");
    }

    #[test]
    fn scheme_產出的都符合規格() {
        for id in ["app.shitetsu.nextstop.dev.Notes_2", "com.other.app", "app.shitetsu.nextstop.sandbox.a"] {
            assert!(is_valid_scheme(&scheme_for(id)), "{id}");
        }
    }

    #[test]
    fn silent_到着與帶分類的発車() {
        assert!(is_silent_link("nextstop://arrive"));
        assert!(is_silent_link("nextstop://arrive/"));
        assert!(is_silent_link("nextstop://depart?category=c1"));
        assert!(is_silent_link("nextstop://depart?category=c1&name=%E5%89%B5%E4%BD%9C"));
        assert!(is_silent_link("NEXTSTOP://depart?category=c1"));
        assert!(is_silent_link("nextstop-dev-ticket://arrive"));
    }

    #[test]
    fn silent_要開App的與壞的都是false() {
        assert!(!is_silent_link("nextstop://today"));
        assert!(!is_silent_link("nextstop://ticket/abc"));
        assert!(!is_silent_link("nextstop://depart?ticket=t1"));
        assert!(!is_silent_link("nextstop://depart?category="));
        assert!(!is_silent_link("nextstop://depart"));
        assert!(!is_silent_link("nextstop://delete/abc"));
        assert!(!is_silent_link("https://example.com/arrive"));
        assert!(!is_silent_link("other://arrive"));
        assert!(!is_silent_link("nextstop-://arrive"));
        assert!(!is_silent_link("nextstop:arrive"));
        assert!(!is_silent_link(""));
    }

    #[test]
    fn silent_category與TS一致_空值_壞編碼_同名取第一個() {
        assert!(!is_silent_link("nextstop://depart?category=%E0%A4%A")); // 解不開
        assert!(!is_silent_link("nextstop://depart?category=%ZZ"));
        assert!(!is_silent_link("nextstop://depart?category=&category=x")); // 第一個是空的
        assert!(!is_silent_link("nextstop://depart?=x&category="));
        assert!(is_silent_link("nextstop://depart?=x&category=c1"));
        assert!(is_silent_link("nextstop://depart?ticket=t1&category=c1")); // category 優先
        assert!(is_silent_link("nextstop://depart?category=c%201"));
        assert!(!is_silent_link("nextstop://arrive/extra"));
        assert!(!is_silent_link("nextstop://depart/x?category=c1"));
    }

    #[test]
    fn silent_超長丟掉() {
        let long = format!("nextstop://depart?category={}", "a".repeat(MAX_LINK_LEN));
        assert!(!is_silent_link(&long));
    }

    #[test]
    fn our_link_只認自己的scheme() {
        assert!(is_our_link("nextstop://today", "nextstop"));
        assert!(is_our_link("NextStop://today", "nextstop"));
        assert!(!is_our_link("nextstop-dev://today", "nextstop"));
        assert!(!is_our_link("nextstop://today", "nextstop-dev"));
        assert!(is_our_link("nextstop-dev://today", "nextstop-dev"));
        assert!(!is_our_link("C:\\next-stop.exe", "nextstop"));
        assert!(!is_our_link("--minimized", "nextstop"));
        assert!(!is_our_link("nextstop://today", ""));
    }

    #[test]
    fn our_link_超長不算() {
        let long = format!("nextstop://ticket/{}", "a".repeat(MAX_LINK_LEN));
        assert!(!is_our_link(&long, "nextstop"));
    }

    fn argv(v: &[&str]) -> Vec<OsString> {
        v.iter().map(|s| OsString::from(*s)).collect()
    }

    #[test]
    fn 冷啟動_全是不開App的連結才算() {
        fn silent(v: &[&str]) -> bool {
            is_silent_launch(argv(v), "nextstop")
        }
        assert!(silent(&["app.exe", "nextstop://arrive"]));
        assert!(silent(&["app.exe", "nextstop://arrive", "nextstop://depart?category=c1"]));
        assert!(silent(&["app.exe", "--minimized", "nextstop://arrive"])); // 其他參數不算連結
        assert!(!silent(&["app.exe"]));
        assert!(!silent(&[]));
        assert!(!silent(&["app.exe", "--minimized"]));
        assert!(!silent(&["app.exe", "nextstop://today"]));
        assert!(!silent(&["app.exe", "nextstop://arrive", "nextstop://today"])); // 有一條要開就要開
        assert!(!silent(&["app.exe", "nextstop://depart?category=%FF"])); // 認不得的要開 App 講一句
        assert!(!silent(&["app.exe", "nextstop-dev://arrive"])); // 別的 scheme 不是這個行程的連結
        assert!(!silent(&["nextstop://arrive"])); // 第 0 個是執行檔本身
    }

    #[test]
    fn 登錄指令格式() {
        assert_eq!(
            open_command(r"C:\Program Files\私鐵手帳\next-stop.exe"),
            r#""C:\Program Files\私鐵手帳\next-stop.exe" "%1""#
        );
    }

    #[test]
    fn 佇列_排入_取_確認() {
        let s = ExternalState::new("nextstop".to_string());
        assert!(s.push("nextstop://today"));
        assert!(s.push("nextstop://arrive"));
        let items = s.items();
        assert_eq!(items.len(), 2);
        assert_ne!(items[0].id, items[1].id);
        assert!(items[0].at > 0);
        // 只讀不清
        assert_eq!(s.items().len(), 2);
        s.ack(&[items[0].id.clone(), "不存在的id".to_string()]);
        let left = s.items();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].url, "nextstop://arrive");
    }

    #[test]
    fn 佇列_超長丟掉_滿了丟最舊() {
        let s = ExternalState::new("nextstop".to_string());
        assert!(!s.push(&format!("nextstop://ticket/{}", "a".repeat(MAX_LINK_LEN))));
        assert!(s.items().is_empty());
        for i in 0..(MAX_QUEUE + 3) {
            s.push(&format!("nextstop://ticket/{i}"));
        }
        let items = s.items();
        assert_eq!(items.len(), MAX_QUEUE);
        assert_eq!(items[0].url, "nextstop://ticket/3");
    }

    #[test]
    fn take的json形狀() {
        let v = serde_json::to_value(ExternalTake {
            items: vec![ExternalItem {
                id: "i1".to_string(),
                url: "nextstop://today".to_string(),
                at: 1_730_000_000_000,
            }],
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "items": [{ "id": "i1", "url": "nextstop://today", "at": 1_730_000_000_000_i64 }] })
        );
    }

    /// 三份「不開 App」判斷（TS、Rust、Kotlin）共用的案例表；形狀 `[{ url, silent, valid }]`
    #[test]
    fn 案例表_silent逐條一致() {
        #[derive(serde::Deserialize)]
        struct Case {
            url: String,
            silent: bool,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../scripts/tests/fixtures/external-links.json")).unwrap();
        assert!(!cases.is_empty());
        for c in cases {
            assert_eq!(is_silent_link(&c.url), c.silent, "{}", c.url);
        }
    }
}
