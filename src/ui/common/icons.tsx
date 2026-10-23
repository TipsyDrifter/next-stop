/**
 * icons——全 App 的線稿圖示（UI 丙-2 U3；視覺規範 §1.7、§2.3 圖示鈕）。
 *
 * 用途：按鈕、列、頁首工具列上的小圖示。語意固定、同一個意思不畫第二份：
 *   搜尋＝IconSearch（放大鏡）・設定／管理＝IconGear（齒輪）・更多動作＝IconDots（⋯，全 App 只有這一種字形）・
 *   關閉＝IconClose（×）・新增＝IconPlus（＋）・返回＝IconBack（‹）・往後／展開＝IconChevron（›，open 轉成 ▾）・
 *   編輯＝IconEdit（鉛筆）・上移／下移＝IconUp／IconDown。
 *   另附 ui-brand 樣本裡其他元件會用到的幾枚：IconFirst／IconLast（« »，DateNav 換年）、IconCalendar（日期 chip）、
 *   IconFlag（日期 chip 補記旗）、IconAlert（橫幅）。
 *
 * 規格：16×16 格（viewBox 0 0 16 16）、1.3px 筆觸、圓頭圓角、不填色、顏色走 `currentColor`（跟著外層文字色走，
 *   hover／選中換色由按鈕自己的 CSS 管）。形狀資料在 `icons-data.ts`（純資料；手機 tab 的 `mobile/tabs.ts` 也讀那一份）。
 *   尺寸：預設 16；按鈕裡的小圖示由呼叫端給 `size`，或交給 CSS（`.ns-ico` 的寬高蓋過 width/height 屬性——
 *   手機殼 `.ns-iconbtn > .ns-ico` 放大到 20，見 listbits.css）。
 *
 * ARIA：圖示一律 `aria-hidden`＋`focusable="false"`，**不帶自己的名字**——可點的那顆按鈕負責 `aria-label`＋`title`
 *   （§2.3：圖示鈕一定有 aria-label＋title）。圖示本身沒有鍵盤行為。
 *
 * 不用：票券與印章家族（圓牌、印章、検印）不是圖示，各有自己的元件；頁面圖示（gnav 六枚）在 sidebar/gnavIcons.tsx。
 */
import { createElement, type CSSProperties, type ReactElement } from "react";
import { ICON_SHAPES, type IconName, type IconShapes } from "./icons-data.ts";
import "./listbits.css";

export interface IconProps {
  /** 邊長 px（預設 16＝§1.7 的格）；CSS 有給寬高時以 CSS 為準 */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** 把形狀資料畫成一枚 <svg>（icons.tsx 內部與 IconChevron 共用） */
function renderShapes(shapes: IconShapes, { size = 16, className, style }: IconProps, extraClass?: string): ReactElement {
  const cls = "ns-ico" + (extraClass ? " " + extraClass : "") + (className ? " " + className : "");
  return (
    <svg
      className={cls}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes.map((s, i) => createElement(s.tag, { key: i, ...s.attrs }))}
    </svg>
  );
}

const make = (name: IconName) => {
  const Icon = (props: IconProps) => renderShapes(ICON_SHAPES[name], props);
  return Icon;
};

/** 搜尋（放大鏡） */
export const IconSearch = make("search");
/** 設定／管理（齒輪）：手機頂帶右上、頁首「管理」鈕 */
export const IconGear = make("gear");
/** 更多動作（⋯）：每一列常駐的那一顆（§0 法則 05） */
export const IconDots = make("dots");
/** 關閉（×） */
export const IconClose = make("close");
/** 新增（＋） */
export const IconPlus = make("plus");
/** 返回／前一個（‹） */
export const IconBack = make("back");
/** 編輯（鉛筆） */
export const IconEdit = make("edit");
/** 上移 */
export const IconUp = make("up");
/** 下移 */
export const IconDown = make("down");
/** 上一年（«） */
export const IconFirst = make("first");
/** 下一年（»） */
export const IconLast = make("last");
/** 日期 chip 的小月曆 */
export const IconCalendar = make("calendar");
/** 補記旗 */
export const IconFlag = make("flag");
/** 警示（橫幅） */
export const IconAlert = make("alert");

/**
 * 往後／展開（›）：`open` 為真時轉 90° 成 ▾（§1.7「展開＝▸／▾」）。
 * 轉場 --dur-fast；系統要求減少動態時直接跳到終態（listbits.css）。aria-expanded 由呼叫端那顆按鈕負責。
 */
export function IconChevron({ open, ...props }: IconProps & { open?: boolean }) {
  return renderShapes(ICON_SHAPES.chevron, props, "ns-ico-chev" + (open ? " is-open" : ""));
}

export type { IconName, IconShape, IconShapes, TabIconKey } from "./icons-data.ts";
/** 手機 tab 的形狀資料（`mobile/tabs.ts` 直接讀 icons-data.ts；這裡轉出給元件端用） */
export { TAB_ICONS, ICON_SHAPES } from "./icons-data.ts";
