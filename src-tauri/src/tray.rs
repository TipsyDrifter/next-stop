//! 桌機系統匣（時刻表 ①a 補充契約 §2；D-時-24、D-時-25）。
//!
//! 系統匣是**全 App 的殼層行為**：App 開著圖示就一直在；按 ✕ 只是縮到這裡（`lib.rs` 攔 CloseRequested），
//! 從這裡「結束」才真的關。時刻表只透過 `tray_set_status` 告訴殼層「現在要顯示什麼」——殼層不懂車次。
//!
//! 為什麼不發 Windows 系統通知當常駐：`tauri-plugin-notification` 2.3.3 桌面版沒有 `remove_active`／`cancel`
//! （只在 `mobile.rs`），發了收不回；系統匣圖示＋tooltip 才能「隨時換、隨時收」。
//!
//! 整支 mod 只在 `cfg(desktop)` 編（`lib.rs` 的 `mod tray;` 掛著屬性）——手機沒有系統匣。

use std::sync::OnceLock;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

/// 系統匣圖示 id（`tray_by_id` 用；只有這一顆）
pub const TRAY_ID: &str = "main";

/// 主視窗 label（tauri.conf.json 沒寫 label ⇒ 預設 "main"）
pub const MAIN_WINDOW: &str = "main";

/// 初始／關掉「系統匣顯示運行中」時的 tooltip
const TOOLTIP_IDLE: &str = "Next Stop";

/// 運行中圓點的顏色＝印章紅 `--color-seal` 的亮色主題值 `#AD3D2B`（`src/styles/theme.css:66`）。
/// 系統匣不跟 App 主題換色：工作列的深淺是 Windows 的設定，不是我們的；靠外圈白邊在深色工作列上辨識。
const SEAL_RGB: [u8; 3] = [0xAD, 0x3D, 0x2B];

/// 開機算一次的兩張圖（預設＋運行中）。`tray_set_status` 每次換圖都從這裡拿，不重算。
struct TrayImages {
    idle: Image<'static>,
    running: Image<'static>,
}

static IMAGES: OnceLock<TrayImages> = OnceLock::new();

/// 在 RGBA 圖右下角畫一顆實心圓點（運行中的樣子）。**純函式**：不碰 Tauri、不碰全域狀態，可單元測試。
///
/// - 直徑＝短邊 38%；外圈白邊＝短邊 / 32（32px 的系統匣圖示上剛好約 1px；來源圖多半是 256px 的 ico，
///   Windows 會縮到 16／24／32 顯示，邊寬跟著邊長等比例，縮完才還是「約 1px」，不會整圈消失）。
/// - 圓點貼著右下角（留出白邊的寬度）；邊緣做 1px 的覆蓋率反鋸齒，縮圖後不毛邊。
/// - 合成用 straight alpha 的 "over"：原圖右下角若是透明，圓點照樣是實心不透明。
/// - 輸入長度與寬高對不上（壞圖）⇒ 原樣複製回去，不 panic（寧可沒有紅點，也不要殼層崩）。
pub(crate) fn compose_running_badge(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || rgba.len() != w * h * 4 {
        return out;
    }
    let side = width.min(height) as f32;
    let r = side * 0.38 / 2.0;
    let ring = (side / 32.0).max(1.0);
    let cx = width as f32 - r - ring;
    let cy = height as f32 - r - ring;
    let outer = r + ring;

    let x0 = (cx - outer - 1.0).floor().max(0.0) as usize;
    let y0 = (cy - outer - 1.0).floor().max(0.0) as usize;
    for y in y0..h {
        for x in x0..w {
            // 像素中心到圓心的距離；覆蓋率＝邊界往外 0.5px 線性收到 0
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let d = (dx * dx + dy * dy).sqrt();
            let ring_cov = (outer + 0.5 - d).clamp(0.0, 1.0);
            if ring_cov <= 0.0 {
                continue;
            }
            let dot_cov = (r + 0.5 - d).clamp(0.0, 1.0);
            let i = (y * w + x) * 4;
            let px = [out[i], out[i + 1], out[i + 2], out[i + 3]];
            let px = over([255, 255, 255], ring_cov, px);
            let px = over(SEAL_RGB, dot_cov, px);
            out[i..i + 4].copy_from_slice(&px);
        }
    }
    out
}

/// straight alpha 的 "over"：把不透明度 `a` 的 `src` 色疊到 `dst`（RGBA）上
fn over(src: [u8; 3], a: f32, dst: [u8; 4]) -> [u8; 4] {
    if a <= 0.0 {
        return dst;
    }
    let da = dst[3] as f32 / 255.0;
    let oa = a + da * (1.0 - a);
    if oa <= 0.0 {
        return [0, 0, 0, 0];
    }
    let ch = |s: u8, d: u8| -> u8 {
        let v = (s as f32 * a + d as f32 * da * (1.0 - a)) / oa;
        v.round().clamp(0.0, 255.0) as u8
    };
    [
        ch(src[0], dst[0]),
        ch(src[1], dst[1]),
        ch(src[2], dst[2]),
        (oa * 255.0).round().clamp(0.0, 255.0) as u8,
    ]
}

/// 叫出主視窗：左鍵單擊、選單「開啟 Next Stop」、第二個執行個體被啟動時共用這一支（補充契約 §2-4）。
/// 順序 unminimize → show → set_focus：被縮到工作列的要先還原，藏起來的要先顯示，最後才搶得到前景。
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = app.get_webview_window(MAIN_WINDOW) else {
        eprintln!("[tray] 找不到主視窗 `{MAIN_WINDOW}`，無法叫出");
        return;
    };
    if let Err(e) = w.unminimize() {
        eprintln!("[tray] unminimize 失敗：{e}");
    }
    if let Err(e) = w.show() {
        eprintln!("[tray] show 失敗：{e}");
    }
    if let Err(e) = w.set_focus() {
        eprintln!("[tray] set_focus 失敗：{e}");
    }
}

/// 建系統匣圖示（`lib.rs` 的 `setup` 叫）。失敗只回錯、由呼叫端寫 log——系統匣建不起來不該讓 App 開不了。
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // 圖案＝App 的預設視窗圖示（generate_context! 從 bundle 圖示嵌進來）；沒有就不換圖，只換 tooltip
    if let Some(icon) = app.default_window_icon() {
        let idle = icon.clone().to_owned();
        let running = Image::new_owned(
            compose_running_badge(idle.rgba(), idle.width(), idle.height()),
            idle.width(),
            idle.height(),
        );
        let _ = IMAGES.set(TrayImages { idle, running });
    } else {
        eprintln!("[tray] 沒有 default_window_icon，系統匣不換運行中圖示");
    }

    let open = MenuItem::with_id(app, "open", "開啟 Next Stop", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(TOOLTIP_IDLE)
        .menu(&menu)
        // 左鍵＝叫出視窗；選單只給右鍵（D-時-25 (2)）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            // 「結束」＝`app.exit(0)`：走 RunEvent::ExitRequested → RunEvent::Exit，各外掛 on_event 照常收尾
            // （plugin-sql 在 Exit 關 pool、single-instance 在 Exit 放掉 mutex）——與舊的 ✕ 關最後一扇窗是同一段收尾，
            // 只差「視窗 Destroyed」那一個事件（App 與外掛都沒有人聽它）。實證見本線回報。
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 只認「左鍵放開」：按下就叫的話，放開那一下又會被 Windows 當成點在剛跳出來的視窗外
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(imgs) = IMAGES.get() {
        builder = builder.icon(imgs.idle.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 時刻表告訴殼層「現在要顯示什麼」（補充契約 §2-8）：設 tooltip、換成運行中或預設圖示。
/// async：tray 的 setter 會派到主執行緒等回覆，不在 IPC 的主執行緒路徑上同步等。
/// 找不到 tray（例如建立失敗）回 `Ok(())`＋寫一行 log——前端不必為了殼層沒圖示丟錯。
#[tauri::command]
pub async fn tray_set_status(
    app: AppHandle,
    running: bool,
    tooltip: String,
) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        eprintln!("[tray] tray_set_status：找不到系統匣圖示（建立失敗？），略過");
        return Ok(());
    };
    tray.set_tooltip(Some(tooltip.as_str()))
        .map_err(|e| e.to_string())?;
    if let Some(imgs) = IMAGES.get() {
        let img = if running { &imgs.running } else { &imgs.idle };
        tray.set_icon(Some(img.clone())).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 64×64、整張不透明藍（運行中圓點畫在上面，好分辨哪裡被改過）
    fn blue(w: u32, h: u32) -> Vec<u8> {
        [0x20, 0x40, 0xC0, 0xFF].repeat((w * h) as usize)
    }

    fn px(buf: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * w + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn 尺寸不變() {
        let src = blue(64, 64);
        assert_eq!(compose_running_badge(&src, 64, 64).len(), src.len());
        let src = blue(256, 256);
        assert_eq!(compose_running_badge(&src, 256, 256).len(), src.len());
    }

    #[test]
    fn 右下角圓點變成印章紅() {
        let (w, h) = (64u32, 64u32);
        let out = compose_running_badge(&blue(w, h), w, h);
        // 圓心：直徑 38%＝24.32、半徑 12.16、白邊 2 ⇒ 圓心約 (49.84, 49.84)
        assert_eq!(px(&out, w, 49, 49), [SEAL_RGB[0], SEAL_RGB[1], SEAL_RGB[2], 0xFF]);
        // 圓點外、白邊上（圓心正右方 r+1 ≈ 13px 處）是白
        assert_eq!(px(&out, w, 62, 49), [0xFF, 0xFF, 0xFF, 0xFF]);
    }

    #[test]
    fn 中心與左上角不變() {
        let (w, h) = (64u32, 64u32);
        let src = blue(w, h);
        let out = compose_running_badge(&src, w, h);
        assert_eq!(px(&out, w, 32, 32), px(&src, w, 32, 32));
        assert_eq!(px(&out, w, 0, 0), px(&src, w, 0, 0));
        // 右上、左下兩角也不碰（圓點只在右下）
        assert_eq!(px(&out, w, 63, 0), px(&src, w, 63, 0));
        assert_eq!(px(&out, w, 0, 63), px(&src, w, 0, 63));
    }

    #[test]
    fn 透明底上的圓點仍是實心() {
        let (w, h) = (32u32, 32u32);
        let src = vec![0u8; (w * h * 4) as usize];
        let out = compose_running_badge(&src, w, h);
        // 32px：半徑 6.08、白邊 1 ⇒ 圓心約 (24.92, 24.92)
        assert_eq!(px(&out, w, 24, 24), [SEAL_RGB[0], SEAL_RGB[1], SEAL_RGB[2], 0xFF]);
        assert_eq!(px(&out, w, 4, 4), [0, 0, 0, 0]);
    }

    #[test]
    fn 壞輸入原樣回() {
        let src = vec![1u8; 10];
        assert_eq!(compose_running_badge(&src, 64, 64), src);
        assert_eq!(compose_running_badge(&[], 0, 0), Vec::<u8>::new());
    }
}
