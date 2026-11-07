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
import { RouteMapPage } from "../outline/RouteMapPage";
import { CalendarView } from "../calendar/CalendarView";
import { LINE_MOUNTS } from "../../lines/mounts";
import { FullSearchView } from "../search/FullSearchView";
import { FullSearchSideAux } from "../search/FullSearchSideAux";
import { installPageSidebarAux } from "./pageAux";
import { ReportView } from "../report/ReportView";
import { DepotView } from "../depot/DepotView";
import { DepotCoverAux } from "../depot/DepotCoverAux";
import { WaitroomView } from "../waitroom/WaitroomView";

export const PAGE_VIEWS: Record<PageId, ComponentType | null> = {
  today: TodayView,
  // 丁 D-主-239：最上層＝路線一覽、點進去＝大綱（RouteMapPage 依 uiStore.routeOverview 選）
  routemap: RouteMapPage,
  calendar: CalendarView,
  notes: LINE_MOUNTS.notes.desktopView,
  timetable: LINE_MOUNTS.timetable.desktopView,
  ticket: LINE_MOUNTS.ticket.desktopView,
  // gnav 第三排「站內」（② 運行報告 D-主-182、③ 車庫 D-主-215、壬 候車室 D-主-511；側欄只留全域件，同運行報告）
  report: ReportView,
  depot: DepotView,
  waitroom: WaitroomView,
  // 不進 gnav 的頁（pages.ts AUX_PAGES；完整搜尋班 D-主-110）
  search: FullSearchView,
};

/**
 * 核心頁的書封頁務件（丁 D-主-235；規則 D-主-234「頁務件＝這一頁的目錄或篩選，點了留在這頁」）。
 * 功能線的頁不在這裡（走各線 mount 的 `sidebarAux`）。沒登記的核心頁：今日、路線圖、行程表畫「我的路線」，其他頁空著。
 * ②運行報告、③車庫的新頁在這張表加一筆自己的元件。
 */
installPageSidebarAux({
  search: FullSearchSideAux,
  // ③ 車庫：書封頁務件＝車庫的目錄（設計題丙 定案四；點了留在車庫頁）。② 運行報告沒有頁務件（側欄只留全域三件，D-主-234）
  depot: DepotCoverAux,
});
