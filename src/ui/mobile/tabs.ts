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
 *   icon    ＝ 16×16 幾何線稿的形狀清單（UI 丙-2 起改讀 `src/ui/common/icons-data.ts` 的 TAB_ICONS——全 App 圖示的唯一出處；
 *             形狀仍是 Sidebar gnav 那幾枚逐字，「更多」三點＝IconDots 同一個陣列，同 1.3px 筆觸）
 *
 * 為什麼 icon 是「形狀資料」不是 ReactNode：本檔是 .ts（registry 純資料、可被 probe 腳本 import 而不拉進 React DOM），
 *   渲染交給 `renderTabIcon()`（用 createElement，無 JSX）。WP1 的 MobileTabBar 直接呼叫它即可，不必再抄 SVG。
 *
 * 「更多」收：設定（主題）；日後日曆（v1.1.x）、售票口（記帳，桌機主）都進這一格——所以它是 'open'，
 *   而售票口**不**佔第五格（與桌機 gnav 第二欄「旅客筆記／時刻表／售票口」三枚不同，手機只有五格）。
 *
 * 售票口線車次①（D-票-20；《2026-10-11-售票口-車次①帳本-契約.md》§2.6 #5、0-27、0-28）：第五格「更多」→「售票口」。
 *   label／latin／status 同旅客筆記、時刻表兩格，改讀售票口線的登記檔；圖示逐字取 gnavIcons.tsx 的 IconTicketOffice。
 *   「更多」移出 `MOBILE_TABS`、改成 `MORE_PAGE`：`"more"` 仍是合法的頁 key（uiStore.mobileTab／openSyncPage 照舊），
 *   只是不在 tab bar 上——入口改成頂帶右上的「⋯」（MobileTopBand.tsx 的 `.m-band-more`）；在「更多」時底部五格都不亮，
 *   點任一格就離開（0-28：不記上一格、不加返回鈕）。`MORE_PAGE` 的完整內容由 foundation-golden.ts 一併鎖進金樣。
 */
import { createElement, type ReactElement } from "react";
// 並行地基（契約 §7 M-1）：旅客筆記／時刻表兩格的文字與狀態改讀各線登記檔（純資料；probe 會載入本檔，值 import 含 .ts）
import { lineById } from "../../lines/index.ts";
// UI 丙-2（視覺規範 §1.7）：圖示形狀集中在 common/icons-data.ts（純資料、零 import；icons.tsx 也讀它）——probe 照樣能載入
import { TAB_ICONS, type IconShapes } from "../common/icons-data.ts";

/** "more" 不在 tab bar 上（MORE_PAGE），但仍是合法的頁 key */
export type MobileTabKey = "today" | "routemap" | "notes" | "timetable" | "ticket" | "more";

export type MobileTabStatus = "open" | "planned";

/** 一個 SVG 子形狀（定義搬到 common/icons-data.ts；這裡轉出，舊的 import 不用改） */
export type { IconShape } from "../common/icons-data.ts";

export type MobileTabIcon = IconShapes;

export interface MobileTab {
  key: MobileTabKey;
  label: string;
  latin: string;
  status: MobileTabStatus;
  icon: MobileTabIcon;
}

/* ── 圖示形狀：一律取自 common/icons-data.ts 的 TAB_ICONS（UI 丙-2；形狀、鍵序逐字搬過去，金樣不變）── */

/** 「更多」＝水平三點（＝IconDots 同一個陣列）；車次①起畫在頂帶右上的 ⋯ 鈕 */
export const ICON_MORE: MobileTabIcon = TAB_ICONS.more;

const NOTES_MOBILE = lineById("notes").mobile;
const TIMETABLE_MOBILE = lineById("timetable").mobile;
const TICKET_MOBILE = lineById("ticket").mobile;

/** 底部 tab 的唯一真相；順序＝拍板順序（D-1.1-2；第五格 D-票-20）。旅客筆記／時刻表／售票口三格的 label／latin／status 來自各線登記檔 */
export const MOBILE_TABS: readonly MobileTab[] = [
  { key: "today", label: "今日", latin: "TODAY", status: "open", icon: TAB_ICONS.today },
  { key: "routemap", label: "路線圖", latin: "ROUTE MAP", status: "open", icon: TAB_ICONS.routemap },
  { key: "notes", label: NOTES_MOBILE.label, latin: NOTES_MOBILE.latin, status: NOTES_MOBILE.status, icon: TAB_ICONS.notes },
  {
    key: "timetable",
    label: TIMETABLE_MOBILE.label,
    latin: TIMETABLE_MOBILE.latin,
    status: TIMETABLE_MOBILE.status,
    icon: TAB_ICONS.timetable,
  },
  { key: "ticket", label: TICKET_MOBILE.label, latin: TICKET_MOBILE.latin, status: TICKET_MOBILE.status, icon: TAB_ICONS.ticket },
];

/** 「更多」頁：不在 tab bar 上（頂帶右上 ⋯ 進），頂帶的頁名與拉丁字仍讀這一筆（0-28） */
export const MORE_PAGE: MobileTab = { key: "more", label: "更多", latin: "MORE", status: "open", icon: ICON_MORE };

/** 未通車格點了顯示的那一行（與桌機 gnav 第二欄 tooltip 同一句；決策 :197 語感一致） */
export const COMING_SOON_TEXT = "次期開業予定";

/** 啟動落點（決策 #12 首頁＝今日視圖；手機同） */
export const DEFAULT_MOBILE_TAB: MobileTabKey = "today";

export function mobileTabByKey(key: MobileTabKey): MobileTab {
  // registry 五筆＋MORE_PAGE 是 const、key 是封閉聯集，找不到只會是程式錯誤——用 ! 不做 fallback，錯就要看得見
  return key === MORE_PAGE.key ? MORE_PAGE : MOBILE_TABS.find((t) => t.key === key)!;
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
