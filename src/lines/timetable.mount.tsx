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
 * 車次①b（契約 §6.1 #1f）：加填 navBadge／navHint（運行中標記；插槽＝接縫 #58）。
 * 車次②段一（② 契約 §6.1 #A1、0-12）：加填 nodeFields 第一筆 `timetable.time`（車票、支線、路線的「時間」列；
 * 內容可展開成多行 ⇒ `top`）與 ticketSheetItems `timetable.depart`（手機票卡 ⋯ 的「発車」）。
 * 車次②段二填值（② 契約 §6.1 #F1；插槽＝接縫 #66）：加填 todayRowActions `timetable.depart`（桌機今日列「発車」鈕／
 * 「正在跑」標記、手機票卡「正在跑」標記、今日鍵 n＝`timetable.today.depart`）、todayStats（今日「專注」）、
 * nodeFields 第二筆 `timetable.time.task`（列車、車廂側板「分量」段的「時間」，取代「花費」列；section "amount"）。
 * `desktopView`／`mobileView` 的欄位與值寫同一行（probe 牙齒 9 讀值）。此後凍結，只有整合席能改。
 */
import type { LineMount } from "./types";
import { TimetableDesktopAgent, TimetableView } from "../ui/timetable/desktop";
import { MobileTimetable, TimetableMobileAgent } from "../ui/timetable/mobile";
import { NavBadge, timetableNavHint } from "../ui/timetable/NavBadge";
import { useTimetableStore } from "../store/timetableStore";
import { TimeField } from "../ui/timetable/task/TimeField";
import { TimeFieldMobile } from "../ui/timetable/task/TimeFieldMobile";
import { TicketSheetDepart } from "../ui/timetable/task/TicketSheetDepart";
import { TodayRowDepart, departFromTodayKey } from "../ui/timetable/task/TodayRowDepart";
import { TodayRowMark } from "../ui/timetable/task/TodayRowMark";
import { TodayFocus } from "../ui/timetable/task/TodayFocus";

export const TIMETABLE_MOUNT: LineMount = {
  desktopView: TimetableView,
  mobileView: MobileTimetable,
  reload: (ctx) => useTimetableStore.getState().reload(ctx),
  // 桌機全域代理：系統匣顯示運行中（回 null、零 DOM）
  desktopOverlay: TimetableDesktopAgent,
  // 手機全域代理：回前景重貼常駐通知、重排試驗提醒、記下待問（回 null、零 DOM）
  mobileOverlay: TimetableMobileAgent,
  // ①b 運行中標記（接縫 #58）：書封「時刻表」與手機 tab 右上的分類小圓牌；桌機 tooltip 尾巴「・創作 14:35 発」
  navBadge: NavBadge,
  navHint: timetableNavHint,
  // ②段一 #A1：側板／手機路線圖詳情的「時間」列（車票、支線、路線；狀態段）
  // ②段二 #F1：列車、車廂的「時間」畫在「分量」段，取代「花費」列（列車、車廂才有手填，〈原型拍板〉3）
  nodeFields: [
    { id: "timetable.time", label: "時間", kinds: ["ticket", "branch", "route"], top: true, Desktop: TimeField, Mobile: TimeFieldMobile },
    { id: "timetable.time.task", label: "時間", kinds: ["train", "car"], top: true, section: "amount", Desktop: TimeField, Mobile: TimeFieldMobile },
  ],
  // ②段一 #A1：手機票卡 ⋯ 的「発車」
  ticketSheetItems: [{ id: "timetable.depart", Item: TicketSheetDepart }],
  // ②段二 #F1：今日列「発車」／「正在跑」與今日鍵 n（manifest 登記 scope "today" 的 `timetable.today.depart`）
  todayRowActions: [
    {
      id: "timetable.depart",
      Desktop: TodayRowDepart,
      Mobile: TodayRowMark,
      hotkeys: { "timetable.today.depart": departFromTodayKey },
    },
  ],
  // ②段二 #F1：今日「專注」＝有連到任務／路線的時間塊（桌機取代核心專注；手機補上）
  todayStats: TodayFocus,
};
