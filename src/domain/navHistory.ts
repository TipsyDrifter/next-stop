/**
 * navHistory.ts——瀏覽歷史（上一頁／下一頁）與疊層返回純函式狀態機（第三梯 v1.29；回饋筆記①）。
 *
 * 將瀏覽狀態拆分為兩層：
 *   1. `baseKeyOf(s)`：底層頁面＋子分頁＋頁內下鑽（支線 zoomId、常用篩選、筆記選取／路線篩選／日記日期／荷札、時刻表單日｜週時段與統計週期、售票口帳戶篩選／搜尋／統計分類下鑽、車庫記錄簿）
 *   2. `overlayKeyOf(s)`：彈出對話框與詳情面板（設定視窗與其分頁籤、快速跳轉、快捷鍵指引、路線對話框、時刻表面板與四籤、售票口對話框與詳情面板）
 *
 * 支援：
 *   - 對話框內切籤或下鑽子面板時逐層推入歷史，按「上一頁」先退回上一籤／母對話框，再按「上一頁」關閉對話框；按「下一頁」可再次打開。
 *   - Smart Modal Unwind：當使用者透過 ×／Esc 手動關閉對話框回到同一底層頁面的前一個狀態時，自動將歷史游標 `index` 退回開窗前的位置（保留後續紀錄供「下一頁」重開），避免下次按「上一頁」又把剛關掉的視窗彈出來。
 */
import type { CalendarView, PageId, RouteDialogState, SettingsTab } from "../store/uiStore";
import type { OverviewTab, RouteLayout } from "../store/boardStore";
import type { InboxKind, NotesSection } from "../store/notesStore";
import type { TimetableSheet, TimetableView } from "../store/timetableStore";
import type { ScheduleMode } from "../store/timetableScheduleStore";
import type { StatsPeriod } from "./timetableStats";
import type { TicketDialog, TicketPanel } from "../store/ticketStore";
import type { Facet, StatsSpan, TicketView } from "./ticketView";
import type { DepotTab } from "../store/depotStore";

export interface NavSnapshot {
  /* ── 頂層頁面與頁內子狀態 ── */
  page: PageId;
  routeOverview: boolean;
  routeId: string | null;
  routeLayout: RouteLayout;
  overviewTab: OverviewTab;
  activeSavedId: string | null;
  zoomId: string | null;
  calendarView: CalendarView;
  notesSection: NotesSection;
  inboxKind: InboxKind;
  selectedNoteId: string | null;
  notesRouteFilter: string | null;
  notesUnderNode: { id: string; ids: string[]; label: string } | null;
  diaryDay: string;
  tagSelectedKey: string | null;
  timetableView: TimetableView;
  scheduleMode: ScheduleMode;
  ttStatsPeriod: StatsPeriod;
  ticketView: TicketView;
  ticketFilterAccountId: string | null;
  ticketStatsSpan: StatsSpan;
  ticketStatsFacet: Facet;
  ticketStatsKind: "expense" | "income";
  ticketStatsRoot: string | null;
  ticketSearchOpen: boolean;
  depotTab: DepotTab;
  depotBookId: string | null;

  /* ── 對話框／疊層／面板狀態 ── */
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  quickJumpOpen: boolean;
  hotkeyGuideOpen: boolean;
  routeDialog: RouteDialogState | null;
  timetableSheet: TimetableSheet | null;
  ticketDialog: TicketDialog | null;
  ticketPanel: TicketPanel;
}

export const MAX_NAV_HISTORY = 80;

export function timetableSheetKey(sheet: TimetableSheet): string {
  switch (sheet.kind) {
    case "categories": {
      const tab =
        sheet.focus === "notice"
          ? "notice"
          : sheet.focus === "routine"
            ? "routines"
            : sheet.focusId
              ? "cats"
              : (sheet.tab ?? "cats");
      return `ttSheet:categories:${tab}`;
    }
    case "goal":
      return `ttSheet:goal:${sheet.goalId ?? "new"}:${sheet.back ?? ""}`;
    case "pendingList":
      return `ttSheet:pendingList:${sheet.goalId ?? ""}`;
    case "plan":
      return `ttSheet:plan:${sheet.key}`;
    case "routine":
      return `ttSheet:routine:${sheet.day}:${sheet.id}`;
    case "slot":
      return `ttSheet:slot:${sheet.key}`;
    case "adhoc":
      return `ttSheet:adhoc:${sheet.key}`;
    case "edit":
      return `ttSheet:edit:${sheet.blockId}`;
    case "split":
      return `ttSheet:split:${sheet.blockId}`;
    case "fill":
      return `ttSheet:fill:${sheet.start}-${sheet.end}`;
    case "longRun":
      return `ttSheet:longRun:${sheet.blockId}`;
    case "taskCategory":
      return `ttSheet:taskCategory:${sheet.nodeId}`;
    case "tags":
      return `ttSheet:tags:${sheet.blockId}`;
    case "depart":
      return "ttSheet:depart";
  }
}

export function ticketDialogKey(dialog: TicketDialog): string {
  switch (dialog.kind) {
    case "repeat":
      return `tkDialog:repeat:${dialog.id ?? "new"}`;
    case "saveTemplate":
      return `tkDialog:saveTemplate:${dialog.entryId}`;
    default:
      return `tkDialog:${dialog.kind}`;
  }
}

export function ticketPanelKey(panel: TicketPanel): string {
  switch (panel.kind) {
    case "none":
      return "";
    case "new":
      return "tkPanel:new";
    case "entry":
      return `tkPanel:entry:${panel.id}`;
    case "account":
      return `tkPanel:account:${panel.id}`;
  }
}

/** 抽出不含彈出對話框的「底層頁面＋子分頁＋頁內下鑽」位置鍵 */
export function baseKeyOf(s: NavSnapshot): string {
  switch (s.page) {
    case "routemap":
      return s.routeOverview
        ? s.overviewTab === "filter"
          ? `routemap:overview:filter:${s.activeSavedId ?? ""}`
          : "routemap:overview:routes"
        : `routemap:route:${s.routeId ?? ""}:${s.routeLayout}:${s.zoomId ?? ""}`;
    case "calendar":
      return `calendar:${s.calendarView}`;
    case "notes":
      switch (s.notesSection) {
        case "inbox":
          return `notes:inbox:${s.inboxKind}`;
        case "notes":
          return `notes:notes:${s.notesRouteFilter ?? ""}:${s.notesUnderNode?.id ?? ""}:${s.selectedNoteId ?? ""}`;
        case "diary":
          return `notes:diary:${s.diaryDay}`;
        case "tags":
          return `notes:tags:${s.tagSelectedKey ?? ""}`;
      }
      break;
    case "timetable":
      if (s.timetableView === "schedule") return `timetable:schedule:${s.scheduleMode}`;
      if (s.timetableView === "stats") return `timetable:stats:${s.ttStatsPeriod}`;
      return `timetable:${s.timetableView}`;
    case "ticket":
      if (s.ticketView === "list") {
        return `ticket:list:${s.ticketFilterAccountId ?? ""}:${s.ticketSearchOpen ? "search" : ""}`;
      }
      if (s.ticketView === "stats") {
        return `ticket:stats:${s.ticketFilterAccountId ?? ""}:${s.ticketStatsSpan}:${s.ticketStatsFacet}:${s.ticketStatsKind}:${s.ticketStatsRoot ?? ""}`;
      }
      return `ticket:${s.ticketView}:${s.ticketFilterAccountId ?? ""}`;
    case "depot":
      return `depot:${s.depotTab}:${s.depotBookId ?? ""}`;
    default:
      return s.page;
  }
}

/** 抽出當前開啟的對話框／面板疊層鍵（空字串代表無疊層） */
export function overlayKeyOf(s: NavSnapshot): string {
  const parts: string[] = [];
  if (s.settingsOpen) parts.push(`settings:${s.settingsTab}`);
  if (s.quickJumpOpen) parts.push("quickJump");
  if (s.hotkeyGuideOpen) parts.push("hotkeyGuide");
  if (s.routeDialog) parts.push(`routeDialog:${s.routeDialog.lineId ?? ""}:${s.routeDialog.editId ?? ""}`);
  if (s.page === "timetable" && s.timetableSheet) {
    parts.push(timetableSheetKey(s.timetableSheet));
  }
  if (s.page === "ticket") {
    if (s.ticketDialog) parts.push(ticketDialogKey(s.ticketDialog));
    const pk = ticketPanelKey(s.ticketPanel);
    if (pk) parts.push(pk);
  }
  return parts.join("|");
}

/** 依當前所在頁面與疊層抽出「使用者感知的完整瀏覽位置鍵」 */
export function navKeyOf(s: NavSnapshot): string {
  const base = baseKeyOf(s);
  const ov = overlayKeyOf(s);
  return ov ? `${base}||${ov}` : base;
}

/**
 * 純函式歷史推入與 Smart Modal Unwind 演算法。
 */
export function reducePushSnapshot(
  entries: readonly NavSnapshot[],
  index: number,
  snap: NavSnapshot,
  maxHistory = MAX_NAV_HISTORY,
): { entries: NavSnapshot[]; index: number } {
  const cur = entries[index];
  const nextKey = navKeyOf(snap);
  if (cur && navKeyOf(cur) === nextKey) {
    const copy = entries.slice();
    copy[index] = snap;
    return { entries: copy, index };
  }

  // 冷啟動時在路線圖頁剛載入第一條 routeId：原地補齊第一筆，不當成第二頁
  if (
    entries.length === 1 &&
    index === 0 &&
    cur &&
    cur.page === "routemap" &&
    !cur.routeOverview &&
    cur.routeId === null &&
    snap.page === "routemap" &&
    !snap.routeOverview &&
    snap.routeId !== null &&
    overlayKeyOf(snap) === ""
  ) {
    return { entries: [snap], index: 0 };
  }

  // Smart Modal Unwind：
  // 1) 若當前在某個疊層內（overlayKey !== ""），而使用者透過 ×／Esc／返回鈕回到了同一底層頁面的前一個狀態
  //    （例如關閉對話框回到無疊層，或從子對話框「新增目標」退回母對話框「分類與設定：目標籤」），
  //    直接將 index 退回該筆祖先紀錄（保留後續紀錄供「下一頁」重開），避免之後按「上一頁」又把剛關掉的對話框打開。
  if (cur && overlayKeyOf(cur) !== "") {
    const snapBase = baseKeyOf(snap);
    for (let i = index - 1; i >= 0; i--) {
      if (baseKeyOf(entries[i]) !== snapBase) break;
      if (navKeyOf(entries[i]) === nextKey) {
        const copy = entries.slice();
        copy[i] = snap;
        return { entries: copy, index: i };
      }
    }
    // 2) 若在疊層開著時直接跳往另一個底層頁面（例如在 Ctrl+P 快速跳轉選中項目並關閉跳轉窗），
    //    剝除中間的臨時疊層紀錄，讓新頁面直接接在打開疊層前的頁面之後。
    if (overlayKeyOf(snap) === "" && snapBase !== baseKeyOf(cur)) {
      let preIdx = index;
      while (preIdx > 0 && overlayKeyOf(entries[preIdx]) !== "") {
        preIdx--;
      }
      const head = entries.slice(0, preIdx + 1);
      if (head[head.length - 1] && navKeyOf(head[head.length - 1]) === nextKey) {
        head[head.length - 1] = snap;
        return { entries: head, index: head.length - 1 };
      }
      head.push(snap);
      if (head.length > maxHistory) head.shift();
      return { entries: head, index: head.length - 1 };
    }
  }

  const head = entries.slice(0, index + 1);
  head.push(snap);
  if (head.length > maxHistory) head.shift();
  return { entries: head, index: head.length - 1 };
}
