/**
 * 時刻表線的登記檔・元件與掛點（並行地基・契約 §5.1；增補二）。**只有時刻表線改這個檔。**
 *
 * - `desktopView`：桌機頁面元件（`timetable.manifest.ts` 的 `page.status` 是 "open" 才會被畫出來）
 * - `mobileView` ：手機頁面元件（`mobile.status` 是 "open" 才會被畫出來）
 * - `reload`     ：同步拉到東西／本機被整批換掉之後，重載這條線的畫面狀態（`syncStore` 呼叫）
 * - 選填 `desktopOverlay`／`mobileOverlay`／`globalHotkeyHandlers`：全域浮層與全域快捷鍵（增補二；未通車不生效）
 *
 * 地基階段三個欄位都是 null、選填欄位都不填 ⇒ 集中檔走不到任何一條這條線的分支。
 */
import type { LineMount } from "./types";

export const TIMETABLE_MOUNT: LineMount = {
  desktopView: null,
  mobileView: null,
  reload: null,
};
