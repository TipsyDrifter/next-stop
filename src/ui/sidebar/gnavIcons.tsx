/**
 * gnav 六枚頁面圖示（並行地基・契約 §6.2 C-8；從 Sidebar.tsx 搬來，形狀逐字）。
 *
 * 原型（prototypes/m3-ext-routemap.html）的 1.3px 細線幾何 inline SVG；viewBox 恆為 16，只換 width/height。
 * 尺寸由呼叫端給：上排 17px、下排 15px（地基之前寫死在各枚裡；現在 `GNAV_ICONS[id](size)`）。
 * 型別是 `Record<PageId, …>`——頁面登記表多一頁、這裡沒登記就編不過（契約 T-乙6）。
 * 搜尋／齒輪／駅記號不是頁面，留在 Sidebar.tsx。
 */
import type { ReactElement } from "react";
import type { PageId } from "../shell/pages";

export function svgProps(size: number) {
  return {
    width: size, height: size, viewBox: "0 0 16 16",
    fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const,
    "aria-hidden": true,
  };
}

function IconToday(size: number) {
  return (
    <svg {...svgProps(size)}>
      <rect x="1.7" y="3.7" width="12.6" height="8.6" rx="1" />
      <path d="M10.2 3.7v8.6" strokeDasharray="1.6 2" />
    </svg>
  );
}
function IconRouteMap(size: number) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3.5 12.5V9.2c0-1.2.8-2 2-2h5c1.2 0 2-.8 2-2V3.8" />
      <circle cx="3.5" cy="13" r="1.4" />
      <circle cx="12.5" cy="3.2" r="1.4" />
    </svg>
  );
}
function IconCalendar(size: number) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2.3" y="3.2" width="11.4" height="10.2" rx="1" />
      <path d="M5.2 1.8v2.6M10.8 1.8v2.6" />
      <path d="M2.3 6.6h11.4" />
    </svg>
  );
}
function IconNotes(size: number) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="2.3" width="10" height="11.4" rx="1" />
      <path d="M6 2.3v11.4" />
    </svg>
  );
}
function IconTimetable(size: number) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M8 4.8V8l2.2 1.6" />
    </svg>
  );
}
function IconTicketOffice(size: number) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.6 13.4V8.2a5.4 5.4 0 0 1 10.8 0v5.2" />
      <path d="M5.4 10.6h5.2" />
      <path d="M8 10.6v2.8" />
    </svg>
  );
}

export const GNAV_ICONS: Record<PageId, (size: number) => ReactElement> = {
  today: IconToday,
  routemap: IconRouteMap,
  calendar: IconCalendar,
  notes: IconNotes,
  timetable: IconTimetable,
  ticket: IconTicketOffice,
};
