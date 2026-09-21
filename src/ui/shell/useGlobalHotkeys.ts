/**
 * 全域快捷鍵（App 層）：Ctrl+1/2/3 全域導航、Ctrl+P 快速跳轉、Ctrl+. 詳情側板、Ctrl+, 設定、
 * `?`／Ctrl+/ 快捷鍵指引（M3 ⑦）。
 * 除了 `?` 之外只處理 Ctrl／Cmd 組合鍵——單鍵導航快捷鍵歸各視圖容器（導航／編輯雙模式在那裡處理）。
 * IME 護欄：組字中一律不攔。
 *
 * Ctrl+1/2/3＝gnav 第一欄三頁（今日／路線圖／日曆；決策記錄 r5、移植規格 §2）。
 * M3 ⑤ 起三頁全通車：
 *   Ctrl+1 → uiStore.setPage("today")
 *   Ctrl+2 → uiStore.setPage("routemap")
 *   Ctrl+3 → uiStore.setPage("calendar")
 * （③–④ 期間 Ctrl+3 與 gnav 日曆枚共用的 `UNBUILT_PAGE_HINT`「M3 施工中」兩個消費點都已拿掉，常數隨之刪除。）
 *
 * M3 ⑦（決策記錄 :136／:190）：鍵位改查 registry（`./hotkeys`，單一真相來源），並接上指引頁兩條路——
 *   `?`      導航模式限定：輸入框裡不攔（那是在打字）、已經有別的疊層開著也不攔（Esc 會打架，草案 §0-6）。
 *   `Ctrl+/` IME 備援：**連輸入框裡都吃**（本來就是給正在組字的人用的）；設定開著時改切到
 *            「快捷鍵」籤，不再疊一層（兩層 dialog 同開會互搶 Esc）。
 */
import { useEffect } from "react";
import { useUiStore } from "../../store/uiStore";
import { isEditableTarget, resolveHotkey } from "./hotkeys";

/**
 * @param enabled 掛不掛這組鍵。預設 true＝桌機呼叫端一字不改、行為零差異（鐵則 1）；
 *   v1.1.0 手機殼傳 false——手機沒有 QuickJump／SettingsPanel／HotkeyGuide 三顆元件，
 *   外接鍵盤按下去只會把 uiStore 的旗標設成 true 而畫面毫無反應（評審 S4），源頭不掛最乾淨。
 */
export function useGlobalHotkeys(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const hit = resolveHotkey("global", e);
      if (!hit) return;
      const ui = useUiStore.getState();
      switch (hit.id) {
        case "global.quickjump":
          e.preventDefault();
          ui.setQuickJumpOpen(!ui.quickJumpOpen);
          break;
        case "global.panel.toggle":
          e.preventDefault();
          ui.setPanelOpen(!ui.panelOpen);
          break;
        case "global.settings":
          e.preventDefault();
          ui.setSettingsOpen(!ui.settingsOpen);
          break;
        case "global.nav.today":
          e.preventDefault();
          ui.setPage("today");
          break;
        case "global.nav.routemap":
          e.preventDefault();
          ui.setPage("routemap");
          break;
        case "global.nav.calendar":
          e.preventDefault();
          ui.setPage("calendar");
          break;
        case "global.guide": {
          if (e.ctrlKey || e.metaKey) {
            // Ctrl+/：輸入框裡也吃——「輸入框」指的是視圖裡的行內輸入框（草稿列、改名、乘務記錄）。
            // 確認框／路線卡／完成卡是另一張有輸入或有決定的 dialog，開著時不切走（疊第二張 DialogShell
            // 會讓 Esc 一次關兩張、打到一半的字蒸發；§0-6 互斥）；設定開著就切籤而不是疊一層。
            if (ui.confirm || ui.routeDialog || ui.completeCardFor) return;
            e.preventDefault();
            if (ui.settingsOpen) ui.setSettingsTab("hotkeys");
            else ui.toggleHotkeyGuide();
          } else {
            // `?`：導航模式限定
            if (isEditableTarget(e.target)) return;
            if (
              ui.settingsOpen ||
              ui.quickJumpOpen ||
              ui.confirm ||
              ui.routeDialog ||
              ui.completeCardFor
            )
              return;
            e.preventDefault();
            ui.toggleHotkeyGuide();
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
