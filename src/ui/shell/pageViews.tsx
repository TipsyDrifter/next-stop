/**
 * pageViews——桌機頁面 id → 主欄元件（並行地基・契約 §6.1）。
 *
 * 核心三頁靜態 import（不 lazy、不包 Suspense：契約決策 9，首次渲染的 DOM 時序不變）；
 * 三條功能線取各線 `src/lines/<line>.mount.tsx` 的 `desktopView`（未填＝null）。
 * 型別是 `Record<PageId, …>`——頁面登記表多一頁、這裡沒對應就編不過（契約 T-乙6）。
 * App.tsx 以 `PAGE_VIEWS[page] ?? Outline` 取用：`?? Outline` 保留地基之前三元式的落底。
 */
import type { ComponentType } from "react";
import type { PageId } from "./pages";
import { TodayView } from "../today/TodayView";
import { Outline } from "../outline/Outline";
import { CalendarView } from "../calendar/CalendarView";
import { LINE_MOUNTS } from "../../lines/mounts";
import { FullSearchView } from "../search/FullSearchView";

export const PAGE_VIEWS: Record<PageId, ComponentType | null> = {
  today: TodayView,
  routemap: Outline,
  calendar: CalendarView,
  notes: LINE_MOUNTS.notes.desktopView,
  timetable: LINE_MOUNTS.timetable.desktopView,
  ticket: LINE_MOUNTS.ticket.desktopView,
  // 不進 gnav 的頁（pages.ts AUX_PAGES；完整搜尋班 D-主-110）
  search: FullSearchView,
};
