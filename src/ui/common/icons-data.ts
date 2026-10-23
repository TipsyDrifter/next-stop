/**
 * icons-data——全 App 圖示的「形狀資料」唯一出處（UI 丙-2 U3；視覺規範 §1.7）。
 *
 * 為什麼拆成純資料檔：`src/ui/mobile/tabs.ts` 是 registry 純資料、`scripts/probes/foundation-golden.ts` 會用 node
 *   直接 import 它（不經 Vite、不吃 JSX）。圖示的形狀要讓 tabs.ts 與 icons.tsx 讀同一份，又不能把 .tsx 拉進 probe，
 *   所以形狀放這裡（零 import、只有型別與常數），icons.tsx（React 元件）與 tabs.ts（手機 tab 登記）都從這裡取。
 *
 * 規格：viewBox 恆為 0 0 16 16；筆觸 1.3px、圓頭圓角、`currentColor`、不填色——這些由渲染端（icons.tsx 的 <svg>、
 *   tabs.ts 的 renderTabIcon）給，本檔只存子形狀。屬性名用 React 的 camelCase（strokeDasharray）。
 *
 * 形狀出處：
 *   - 元件圖示：prototypes/ui-brand/index.html 的 <symbol id="i-*">（活樣本）逐字。
 *   - 手機 tab：原本寫在 tabs.ts 的 ICON_TODAY…ICON_MORE 逐字搬來（＝Sidebar gnav／gnavIcons.tsx 的形狀）。
 *     ⚠ 鍵的插入順序與數值都不能動：foundation-golden 把 MOBILE_TABS／MORE_PAGE 連圖示形狀一起 JSON 化逐位元組比對。
 *   - 「更多」三點＝`dots`（⋯，§1.7「更多動作＝一種字形」）：tab 的 more 與 IconDots 是同一個陣列。
 */

/** 一個 SVG 子形狀：tag ＋ 屬性（viewBox 恆為 0 0 16 16，stroke 由外層 <svg> 給） */
export interface IconShape {
  tag: "path" | "rect" | "circle";
  attrs: Record<string, string | number>;
}

/** 一枚圖示＝子形狀清單 */
export type IconShapes = readonly IconShape[];

/** 元件圖示的名字（icons.tsx 每一個 Icon* 對應一個） */
export type IconName =
  | "search"
  | "gear"
  | "dots"
  | "close"
  | "plus"
  | "back"
  | "chevron"
  | "edit"
  | "up"
  | "down"
  | "first"
  | "last"
  | "calendar"
  | "flag"
  | "alert";

/* ── 「更多」三點：tab 的 MORE_PAGE 與 IconDots 共用（原 tabs.ts ICON_MORE 逐字） ── */
const DOTS: IconShapes = [
  { tag: "circle", attrs: { cx: 3.2, cy: 8, r: 1.3 } },
  { tag: "circle", attrs: { cx: 8, cy: 8, r: 1.3 } },
  { tag: "circle", attrs: { cx: 12.8, cy: 8, r: 1.3 } },
];

/** 元件圖示（ui-brand <symbol id="i-*"> 逐字；語意固定，同一個意思不畫第二份——§1.7） */
export const ICON_SHAPES: Readonly<Record<IconName, IconShapes>> = {
  /** 搜尋＝放大鏡（i-search） */
  search: [
    { tag: "circle", attrs: { cx: 7, cy: 7, r: 4.3 } },
    { tag: "path", attrs: { d: "M10.2 10.2 13.6 13.6" } },
  ],
  /** 設定／管理＝齒輪（i-gear） */
  gear: [
    { tag: "circle", attrs: { cx: 8, cy: 8, r: 2.2 } },
    {
      tag: "path",
      attrs: {
        d: "M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.35 1.35M11.05 11.05l1.35 1.35M3.6 12.4l1.35-1.35M11.05 4.95l1.35-1.35",
      },
    },
    { tag: "circle", attrs: { cx: 8, cy: 8, r: 4.4 } },
  ],
  /** 更多動作＝⋯（i-more） */
  dots: DOTS,
  /** 關閉＝×（i-close） */
  close: [{ tag: "path", attrs: { d: "M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" } }],
  /** 新增＝＋（i-plus） */
  plus: [{ tag: "path", attrs: { d: "M8 3.2v9.6M3.2 8h9.6" } }],
  /** 返回＝‹（i-back）；DateNav 的「前一個」也是它 */
  back: [{ tag: "path", attrs: { d: "M10 3.2 5.2 8 10 12.8" } }],
  /** 往後／展開＝›（i-fwd）；IconChevron 以它為本，展開時轉 90° 成 ▾ */
  chevron: [{ tag: "path", attrs: { d: "M6 3.2 10.8 8 6 12.8" } }],
  /** 編輯＝鉛筆（i-pencil） */
  edit: [{ tag: "path", attrs: { d: "M3 13 4 9.6 10.6 3l2.4 2.4L6.4 12 3 13zM9.2 4.4l2.4 2.4" } }],
  /** 上移（i-up） */
  up: [{ tag: "path", attrs: { d: "M8 13V3.4M4.4 7 8 3.4 11.6 7" } }],
  /** 下移（i-down） */
  down: [{ tag: "path", attrs: { d: "M8 3v9.6M4.4 9 8 12.6 11.6 9" } }],
  /** 上一年＝«（i-first；DateNav 的換年） */
  first: [{ tag: "path", attrs: { d: "M8 3.6 3.6 8 8 12.4M12.4 3.6 8 8l4.4 4.4" } }],
  /** 下一年＝»（i-last） */
  last: [{ tag: "path", attrs: { d: "M8 3.6 12.4 8 8 12.4M3.6 3.6 8 8l-4.4 4.4" } }],
  /** 日期 chip 的小月曆（i-cal；與 gnav 的行程表頁圖示是兩個意思，不合併） */
  calendar: [
    { tag: "rect", attrs: { x: 2.4, y: 3.4, width: 11.2, height: 10, rx: 1 } },
    { tag: "path", attrs: { d: "M2.4 6.6h11.2M5.4 2v2.6M10.6 2v2.6" } },
  ],
  /** 補記旗（i-flag；日期 chip flag="backfill"） */
  flag: [{ tag: "path", attrs: { d: "M4 14V2.6M4 3h7.4l-1.6 2.6L11.4 8.2H4" } }],
  /** 警示三角（i-alert；橫幅） */
  alert: [{ tag: "path", attrs: { d: "M8 2.4 14.2 13.2H1.8L8 2.4zM8 6.6v3.2M8 11.4v.2" } }],
};

/** 手機底部 tab（與「更多」頁）的圖示 key：與 MobileTabKey 同名 */
export type TabIconKey = "today" | "routemap" | "notes" | "timetable" | "ticket" | "more";

/**
 * 手機 tab 的形狀資料（原 tabs.ts ICON_* 逐字；gnav 頁面圖示同形）。tabs.ts 的 MOBILE_TABS／MORE_PAGE 從這裡取。
 * 鍵的插入順序與數值是金樣的一部分（見檔頭 ⚠）。
 */
export const TAB_ICONS: Readonly<Record<TabIconKey, IconShapes>> = {
  /** 今日（gnav IconToday） */
  today: [
    { tag: "rect", attrs: { x: 1.7, y: 3.7, width: 12.6, height: 8.6, rx: 1 } },
    { tag: "path", attrs: { d: "M10.2 3.7v8.6", strokeDasharray: "1.6 2" } },
  ],
  /** 路線圖（gnav IconRouteMap） */
  routemap: [
    { tag: "path", attrs: { d: "M3.5 12.5V9.2c0-1.2.8-2 2-2h5c1.2 0 2-.8 2-2V3.8" } },
    { tag: "circle", attrs: { cx: 3.5, cy: 13, r: 1.4 } },
    { tag: "circle", attrs: { cx: 12.5, cy: 3.2, r: 1.4 } },
  ],
  /** 旅客筆記（gnav IconNotes） */
  notes: [
    { tag: "rect", attrs: { x: 3, y: 2.3, width: 10, height: 11.4, rx: 1 } },
    { tag: "path", attrs: { d: "M6 2.3v11.4" } },
  ],
  /** 時刻表（gnav IconTimetable） */
  timetable: [
    { tag: "circle", attrs: { cx: 8, cy: 8, r: 5.7 } },
    { tag: "path", attrs: { d: "M8 4.8V8l2.2 1.6" } },
  ],
  /** 售票口（gnavIcons.tsx IconTicketOffice：窗口拱＋台面＋支柱） */
  ticket: [
    { tag: "path", attrs: { d: "M2.6 13.4V8.2a5.4 5.4 0 0 1 10.8 0v5.2" } },
    { tag: "path", attrs: { d: "M5.4 10.6h5.2" } },
    { tag: "path", attrs: { d: "M8 10.6v2.8" } },
  ],
  /** 「更多」（頂帶右上進；與 IconDots 同一個陣列） */
  more: DOTS,
};
