/**
 * 全域快捷鍵（App 層）：Ctrl+1/2/3 全域導航、Ctrl+P 快速跳轉、Ctrl+Shift+F 完整搜尋、Ctrl+. 詳情側板、Ctrl+, 設定、
 * `?`／Ctrl+/ 快捷鍵指引（M3 ⑦）。
 * 除了 `?` 之外只處理 Ctrl／Cmd 組合鍵——單鍵導航快捷鍵歸各視圖容器（導航／編輯雙模式在那裡處理）。
 * IME 護欄：組字中一律不攔。
 *
 * Ctrl+數字由頁面登記表決定（並行地基・契約 §8.4）：`pages.ts` 裡已通車的頁各有一顆 `global.nav.<頁>`
 *   （今日 1／路線圖 2／日曆 3；三條功能線預配 4／5／6，該線通車才生效），這裡用 `pageOfNavHotkey()` 一次查完
 *   再 `uiStore.setPage`，不再逐頁寫 case。未通車的頁不在 registry 裡 ⇒ Ctrl+4／5／6 現在沒有人攔。
 * 三條功能線的全域快捷鍵（不限頁面）：各線在 `src/lines/<line>.mount.tsx` 的 `globalHotkeyHandlers` 登記，
 *   這裡在既有 switch 之前用 `lineGlobalHotkeyHandler()` 查（增補 2026-10-05 增補二；未通車的線不生效）。
 *
 * M3 ⑦（決策記錄 :136／:190）：鍵位改查 registry（`./hotkeys`，單一真相來源），並接上指引頁兩條路——
 *   `?`      導航模式限定：輸入框裡不攔（那是在打字）、已經有別的疊層開著也不攔（Esc 會打架，草案 §0-6）。
 *   `Ctrl+/` IME 備援：**連輸入框裡都吃**（本來就是給正在組字的人用的）；設定開著時改切到
 *            「快捷鍵」籤，不再疊一層（兩層 dialog 同開會互搶 Esc）。
 */
import { useEffect } from "react";
import { useUiStore } from "../../store/uiStore";
import { isEditableTarget, resolveHotkey } from "./hotkeys";
import { pageOfNavHotkey } from "./pages";
// 查 `lines/runtime`、不 import `lines/mounts`：本 hook 在 App 的 import 清單裡排在核心元件之前，
// 直接 import mounts 會把各線的元件樹提早求值（修正席，評審發現 2；理由見 runtime.ts 檔頭）
import { lineGlobalHotkeyHandler } from "../../lines/runtime";
import { openFullSearch } from "../search/openFullSearch";

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
      // Ctrl+數字換頁：頁面登記表裡已通車的頁（契約 §8.4）
      const navPage = pageOfNavHotkey(hit.id);
      if (navPage) {
        e.preventDefault();
        ui.setPage(navPage);
        return;
      }
      // 三條功能線登記的全域快捷鍵（增補二）：三線都沒登記時恆 null ⇒ 不攔任何鍵
      const lineHandler = lineGlobalHotkeyHandler(hit.id);
      if (lineHandler) {
        e.preventDefault();
        lineHandler();
        return;
      }
      switch (hit.id) {
        case "global.quickjump":
          e.preventDefault();
          ui.setQuickJumpOpen(!ui.quickJumpOpen);
          break;
        case "global.fullsearch":
          // 完整搜尋班 D-主-111：到完整搜尋頁、游標進搜尋框（已在這頁＝只把游標拉回去）
          e.preventDefault();
          openFullSearch();
          break;
        case "global.panel.toggle":
          e.preventDefault();
          ui.setPanelOpen(!ui.panelOpen);
          break;
        case "global.settings":
          e.preventDefault();
          ui.setSettingsOpen(!ui.settingsOpen);
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
