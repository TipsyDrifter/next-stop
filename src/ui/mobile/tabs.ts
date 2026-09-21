/**
 * tabs——手機殼底部 5 格 tab 的 registry（v1.1.0；WP0 契約層）。
 *
 * 拍板依據：決策記錄〈v1.1 Plan 草案拍板〉D-1.1-2——「底部 5 格＝今日・路線圖・旅客筆記・時刻表・更多，
 *   未通車格灰顯、點了顯示『次期開業予定』；tab 定義做成 registry 資料，新功能通車＝改一筆」。
 *   順序即拍板順序，不可調（主人追加約束：tab 要預留未來功能的位置）。
 *
 * 一筆一項（沿 hotkeys.ts「registry 是資料、顯示端不手抄」的紀律）：
 *   key     ＝ uiStore.mobileTab 的值；'today'／'routemap' 與桌機 PageId 同名，方便日後對照
 *   label   ＝ 中文頁名（tab 下方的字）
 *   latin   ＝ 拉丁小字（頂帶右側／無障礙補述用；沿 gnav 的 latin 語感，字體走 --font-latin）
 *   status  ＝ 'open' 已通車／'planned' 未通車（灰顯 .42、點了只顯示 <ComingSoon/> 一行「次期開業予定」）
 *   icon    ＝ 16×16 幾何線稿的形狀清單（逐字取 Sidebar.tsx 的 gnav 圖示；「更多」是新畫的三點，同 1.3px 筆觸）
 *
 * 為什麼 icon 是「形狀資料」不是 ReactNode：本檔是 .ts（registry 純資料、可被 probe 腳本 import 而不拉進 React DOM），
 *   渲染交給 `renderTabIcon()`（用 createElement，無 JSX）。WP1 的 MobileTabBar 直接呼叫它即可，不必再抄 SVG。
 *
 * 「更多」收：設定（主題）；日後日曆（v1.1.x）、售票口（記帳，桌機主）都進這一格——所以它是 'open'，
 *   而售票口**不**佔第五格（與桌機 gnav 第二欄「旅客筆記／時刻表／售票口」三枚不同，手機只有五格）。
 */
import { createElement, type ReactElement } from "react";

export type MobileTabKey = "today" | "routemap" | "notes" | "timetable" | "more";

export type MobileTabStatus = "open" | "planned";

/** 一個 SVG 子形狀：tag ＋ 屬性（viewBox 恆為 0 0 16 16，stroke 由外層 <svg> 給） */
export interface IconShape {
  tag: "path" | "rect" | "circle";
  attrs: Record<string, string | number>;
}

export type MobileTabIcon = readonly IconShape[];

export interface MobileTab {
  key: MobileTabKey;
  label: string;
  latin: string;
  status: MobileTabStatus;
  icon: MobileTabIcon;
}

/* ── 圖示形狀（Sidebar.tsx IconToday／IconRouteMap／IconNotes／IconTimetable 逐字；IconMore 新畫）── */

const ICON_TODAY: MobileTabIcon = [
  { tag: "rect", attrs: { x: 1.7, y: 3.7, width: 12.6, height: 8.6, rx: 1 } },
  { tag: "path", attrs: { d: "M10.2 3.7v8.6", strokeDasharray: "1.6 2" } },
];

const ICON_ROUTEMAP: MobileTabIcon = [
  { tag: "path", attrs: { d: "M3.5 12.5V9.2c0-1.2.8-2 2-2h5c1.2 0 2-.8 2-2V3.8" } },
  { tag: "circle", attrs: { cx: 3.5, cy: 13, r: 1.4 } },
  { tag: "circle", attrs: { cx: 12.5, cy: 3.2, r: 1.4 } },
];

const ICON_NOTES: MobileTabIcon = [
  { tag: "rect", attrs: { x: 3, y: 2.3, width: 10, height: 11.4, rx: 1 } },
  { tag: "path", attrs: { d: "M6 2.3v11.4" } },
];

const ICON_TIMETABLE: MobileTabIcon = [
  { tag: "circle", attrs: { cx: 8, cy: 8, r: 5.7 } },
  { tag: "path", attrs: { d: "M8 4.8V8l2.2 1.6" } },
];

/** 「更多」＝水平三點（同 1.3px 筆觸、r 與 gnav 路線圖端點同量級） */
const ICON_MORE: MobileTabIcon = [
  { tag: "circle", attrs: { cx: 3.2, cy: 8, r: 1.3 } },
  { tag: "circle", attrs: { cx: 8, cy: 8, r: 1.3 } },
  { tag: "circle", attrs: { cx: 12.8, cy: 8, r: 1.3 } },
];

/** 底部 tab 的唯一真相；順序＝拍板順序（D-1.1-2） */
export const MOBILE_TABS: readonly MobileTab[] = [
  { key: "today", label: "今日", latin: "TODAY", status: "open", icon: ICON_TODAY },
  { key: "routemap", label: "路線圖", latin: "ROUTE MAP", status: "open", icon: ICON_ROUTEMAP },
  { key: "notes", label: "旅客筆記", latin: "NOTES", status: "planned", icon: ICON_NOTES },
  { key: "timetable", label: "時刻表", latin: "TIMETABLE", status: "planned", icon: ICON_TIMETABLE },
  { key: "more", label: "更多", latin: "MORE", status: "open", icon: ICON_MORE },
];

/** 未通車格點了顯示的那一行（與桌機 gnav 第二欄 tooltip 同一句；決策 :197 語感一致） */
export const COMING_SOON_TEXT = "次期開業予定";

/** 啟動落點（決策 #12 首頁＝今日視圖；手機同） */
export const DEFAULT_MOBILE_TAB: MobileTabKey = "today";

export function mobileTabByKey(key: MobileTabKey): MobileTab {
  // registry 五筆是 const、key 是封閉聯集，找不到只會是程式錯誤——用 ! 不做 fallback，錯就要看得見
  return MOBILE_TABS.find((t) => t.key === key)!;
}

/**
 * 把 registry 的形狀清單畫成 <svg>（無 JSX；stroke 走 currentColor，顏色由外層 CSS 的 color 決定）。
 * size 預設 22——底部 tab 的觸控目標由 .m-tab 撐到 ≥44px，圖示本身不必大（gnav 第一欄是 17）。
 */
export function renderTabIcon(icon: MobileTabIcon, size = 22): ReactElement {
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.3,
      strokeLinecap: "round",
      "aria-hidden": true,
    },
    ...icon.map((s, i) => createElement(s.tag, { key: i, ...s.attrs })),
  );
}
