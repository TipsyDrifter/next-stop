/**
 * 時刻表線的登記檔・元件與掛點（並行地基・契約 §5.1；增補二）。**只有時刻表線改這個檔。**
 *
 * - `desktopView`：桌機頁面元件（`timetable.manifest.ts` 的 `page.status` 是 "open" 才會被畫出來）
 * - `mobileView` ：手機頁面元件（`mobile.status` 是 "open" 才會被畫出來）
 * - `reload`     ：同步拉到東西／本機被整批換掉之後，重載這條線的畫面狀態（`syncStore` 呼叫）
 * - 選填 `desktopOverlay`／`mobileOverlay`／`globalHotkeyHandlers`：全域浮層與全域快捷鍵（增補二；未通車不生效）
 *
 * 車次①a（契約 §6.1）：填 desktopView／mobileView／reload／mobileOverlay；不填 globalHotkeyHandlers。
 * ①a 補充契約（系統匣，2026-10-10）：加填 desktopOverlay＝TimetableDesktopAgent（回 null；App 一開就把運行中送到系統匣，
 * 不必先進時刻表頁——原 §6.1「不填 desktopOverlay」由此改寫）。
 * `desktopView`／`mobileView` 的欄位與值寫同一行（probe 牙齒 9 讀值）。此後凍結，只有整合席能改。
 */
import type { LineMount } from "./types";
import { TimetableDesktopAgent, TimetableView } from "../ui/timetable/desktop";
import { MobileTimetable, TimetableMobileAgent } from "../ui/timetable/mobile";
import { useTimetableStore } from "../store/timetableStore";

export const TIMETABLE_MOUNT: LineMount = {
  desktopView: TimetableView,
  mobileView: MobileTimetable,
  reload: (ctx) => useTimetableStore.getState().reload(ctx),
  // 桌機全域代理：系統匣顯示運行中（回 null、零 DOM）
  desktopOverlay: TimetableDesktopAgent,
  // 手機全域代理：回前景重貼常駐通知、重排試驗提醒、記下待問（回 null、零 DOM）
  mobileOverlay: TimetableMobileAgent,
};
