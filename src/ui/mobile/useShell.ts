/**
 * useShell——「現在該畫哪一個殼」的單一判準（v1.1.0 手機殼；WP0 契約層）。
 *
 * 回傳 'desktop'｜'mobile'，依 `matchMedia(MOBILE_MEDIA_QUERY)` 即時更新（旋轉、分割畫面、
 * 模擬器換裝置設定檔都會走 change 事件，不用重開 App）。
 *
 * 為什麼用「寬度」而不是「平台」判斷（Plan 草案 §6 技術自決「手機斷點 max-width:767px」）：
 *   - 桌機視窗有 minWidth 960（tauri.conf.json），永遠落不進 <768 → 桌機行為零改變（鐵則 1）。
 *   - 手機殼要能在瀏覽器 `?mock=1` 縮窗預覽、在模擬器多組裝置設定檔驗（P1「多型號適配」），
 *     綁平台就只能在真機看。
 *   - 同一條 media query 也是 mobile.css 的斷點；JS 與 CSS 吃同一把尺，不會出現「殼是手機、樣式是桌機」的半套。
 *
 * 使用契約：App 根 div 掛 `data-shell={shell}`，mobile.css 以 `[data-shell="mobile"]` 為前綴；
 *   同一時間只渲染一個殼（`shell === 'mobile' ? <MobileShell/> : <桌機樹>`），兩殼共用 store，不共用 DOM。
 *   SSR／非瀏覽器環境（測試）沒有 matchMedia → 一律 'desktop'。
 */
import { useEffect, useState } from "react";

export type ShellKind = "desktop" | "mobile";

/**
 * 與 src/styles/mobile.css 的斷點同值——改這裡也要改那裡（兩處字面值，刻意不抽共用：CSS 讀不到 TS 常數）。
 * 兩段式判準（2026-09-18 主人真機回報「橫向變回桌機版且破版」後修）：
 *   - `(max-width: 767px)`：直向手機、瀏覽器縮窗、模擬器。
 *   - `(pointer: coarse) and (max-height: 767px)`：觸控裝置橫向——小米 15T 橫向寬 853dp 早已超過 768，
 *     但短邊 394dp 仍是手機；用「粗指標＋短邊」而不是純寬度，桌機（pointer: fine）永遠不命中。
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px), ((pointer: coarse) and (max-height: 767px))";

function currentShell(): ShellKind {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches ? "mobile" : "desktop";
}

export function useShell(): ShellKind {
  // 初值就用實際量測值，不先渲染一幀桌機殼再切（會閃一下 1180px 的版面）
  const [shell, setShell] = useState<ShellKind>(currentShell);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (e: MediaQueryListEvent) => setShell(e.matches ? "mobile" : "desktop");
    // effect 掛上前若尺寸已變（StrictMode 雙掛載、devtools 切裝置），補對一次
    setShell(mq.matches ? "mobile" : "desktop");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 同步到 <html data-shell>：body{min-width:1180px} 是桌機在 techo.css 的硬假設，根 div 的 data-shell 管不到 body，
  // 只有掛在 html 上，mobile.css 的 `html[data-shell="mobile"] body { min-width: 0 }` 才壓得掉（橫向手機寬 >768 時尤其需要）。
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.shell = shell;
  }, [shell]);

  return shell;
}
