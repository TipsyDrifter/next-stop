/**
 * navHistoryStore——瀏覽歷史（上一頁／下一頁）與疊層返回狀態機（第三梯 v1.29；回饋筆記①）。
 *
 * 對齊手機返回鍵的直覺層級，同時支援「上一頁（返回）」與「下一頁（前進）」：
 *   1. 臨時彈出層優先收起（PopMenu、右鍵選單、日曆預覽、推遲選單、計算機、確認框、完成卡、靈感捕捉／變待辦預覽）
 *   2. 對話框與面板（設定視窗與其分頁籤、快速跳轉、快捷鍵指引、路線對話框、時刻表面板與分類／通知／目標／作息四籤、售票口對話框與詳情側板）
 *      - 在對話框內切籤或下鑽（如「設定：一般 → 備份」、「分類與設定：目標籤 → 新增目標」、「定期帳管理 → 編輯規則」），按返回先退回上一籤／上一層，再按返回關閉對話框；按前進可再次打開或前進。
 *      - 使用者手動按 ×／Esc 關閉對話框時，自動將歷史游標退回打開對話框前的位置（Smart Modal Unwind），不會在下次按返回時把剛關掉的視窗又彈出來。
 *   3. 頁內下鑽與子分頁（路線圖一覽 vs 單一路線、大綱｜看板、進入支線／列車 zoomId、常用篩選；旅客筆記四子頁、收件匣篩選、選中筆記、路線／節點篩選、日記日期、荷札下鑽；時刻表視圖、日程單日｜週時段、統計日｜週｜月；售票口視圖、帳戶篩選、搜尋開關、統計期間／切面／分類下鑽；車庫三籤與記錄簿）
 *   4. 頂層頁面切換（今日、路線圖、行程表、旅客筆記、時刻表、售票口、月報、車庫、候車室、搜尋）
 *
 * 支援滑鼠側鍵（MouseButton 3＝返回、4＝前進）與鍵盤快捷鍵（預設 Alt+[／Alt+]，另支援 Alt+←／Alt+→ 與 BrowserBack／BrowserForward）。
 */
import { create } from "zustand";
import { useUiStore } from "./uiStore";
import { useNodeStore } from "./nodeStore";
import { useBoardStore } from "./boardStore";
import { useNotesStore } from "./notesStore";
import { useTagStore } from "./tagStore";
import { useTimetableStore } from "./timetableStore";
import { useTimetableScheduleStore } from "./timetableScheduleStore";
import { useTimetableStatsStore } from "./timetableStatsStore";
import { useTicketStore } from "./ticketStore";
import { useDepotStore } from "./depotStore";
import {
  MAX_NAV_HISTORY,
  baseKeyOf,
  navKeyOf,
  overlayKeyOf,
  reducePushSnapshot,
  type NavSnapshot,
} from "../domain/navHistory";

export { baseKeyOf, navKeyOf, overlayKeyOf, reducePushSnapshot, type NavSnapshot };

export function captureNavSnapshot(): NavSnapshot {
  const ui = useUiStore.getState();
  const node = useNodeStore.getState();
  const board = useBoardStore.getState();
  const notes = useNotesStore.getState();
  const tag = useTagStore.getState();
  const tt = useTimetableStore.getState();
  const ttSch = useTimetableScheduleStore.getState();
  const ttStats = useTimetableStatsStore.getState();
  const tk = useTicketStore.getState();
  const depot = useDepotStore.getState();
  return {
    page: ui.page,
    routeOverview: ui.routeOverview,
    routeId: node.routeId,
    routeLayout: board.routeLayout,
    overviewTab: board.overviewTab,
    activeSavedId: board.activeSavedId,
    zoomId: ui.zoomId,
    calendarView: ui.calendarView,
    notesSection: notes.section,
    inboxKind: notes.inboxKind,
    selectedNoteId: notes.selectedNoteId,
    notesRouteFilter: notes.notesQuery.routeId ?? null,
    notesUnderNode: notes.notesQuery.underNode ?? null,
    diaryDay: notes.diaryDay,
    tagSelectedKey: tag.selectedKey,
    timetableView: tt.view,
    scheduleMode: ttSch.scheduleMode,
    ttStatsPeriod: ttStats.period,
    ticketView: tk.view,
    ticketFilterAccountId: tk.filterAccountId,
    ticketStatsSpan: tk.span,
    ticketStatsFacet: tk.facet,
    ticketStatsKind: tk.facetKind,
    ticketStatsRoot: tk.statsRoot,
    ticketSearchOpen: tk.searchOpen,
    depotTab: depot.tab,
    depotBookId: depot.bookId,
    settingsOpen: ui.settingsOpen,
    settingsTab: ui.settingsTab,
    quickJumpOpen: ui.quickJumpOpen,
    hotkeyGuideOpen: ui.hotkeyGuideOpen,
    routeDialog: ui.routeDialog ? { ...ui.routeDialog } : null,
    timetableSheet: tt.sheet,
    ticketDialog: tk.dialog,
    ticketPanel: tk.panel,
  };
}

let isRestoring = false;
let pendingFlush = false;

/**
 * 優先收起不在歷史堆疊裡的臨時浮層（確認框、PopMenu、右鍵選單、日曆小卡、推遲選單、計算機、完成卡、靈感捕捉／預覽）。
 * 有收起任何一層時回傳 true，讓按一下返回鍵只做一件事。
 */
function dismissTopTransientOverlay(): boolean {
  const ui = useUiStore.getState();
  if (ui.confirm) {
    ui.closeConfirm();
    return true;
  }

  if (typeof document !== "undefined") {
    const popSelectors =
      ".ns-popmenu, .ns-ctx-menu, .ns-qa-pop, .ns-defer-pop, .defer-pop, .ns-tk-calc-pop, .ns-clock-pop, .ns-tp-pop, .ns-dp-pop, .daypop";
    const popList = document.querySelectorAll<HTMLElement>(popSelectors);
    if (popList.length > 0) {
      const topPop = popList[popList.length - 1];
      const active =
        document.activeElement instanceof HTMLElement && topPop.contains(document.activeElement)
          ? document.activeElement
          : topPop;
      const escInit: KeyboardEventInit = {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      };
      active.dispatchEvent(new KeyboardEvent("keydown", escInit));
      if (document.body.contains(topPop)) {
        document.dispatchEvent(new KeyboardEvent("keydown", escInit));
      }
      if (document.body.contains(topPop)) {
        window.dispatchEvent(new KeyboardEvent("keydown", escInit));
      }
      return true;
    }
  }

  const notes = useNotesStore.getState();
  if (notes.preview) {
    notes.cancelPreview();
    return true;
  }
  if (notes.capture) {
    notes.escapeCapture();
    return true;
  }

  if (ui.completeCardFor) {
    ui.setCompleteCardFor(null);
    return true;
  }

  return false;
}

/**
 * 當歷史游標已在最開頭（index === 0）時，若畫面上還有開著的對話框或可退回的父層（如支線聚焦、單一路線、記錄簿、荷札下鑽），
 * 像手機返回鍵一樣順著層級往上退一步。
 */
function stepUpHierarchyFallback(): boolean {
  const ui = useUiStore.getState();
  if (ui.hotkeyGuideOpen) {
    ui.setHotkeyGuideOpen(false);
    return true;
  }
  if (ui.quickJumpOpen) {
    ui.setQuickJumpOpen(false);
    return true;
  }
  if (ui.routeDialog) {
    ui.closeRouteDialog();
    return true;
  }
  if (ui.settingsOpen) {
    ui.setSettingsOpen(false);
    return true;
  }

  if (ui.page === "timetable") {
    const tt = useTimetableStore.getState();
    if (tt.sheet) {
      if (tt.sheet.kind === "goal" && tt.sheet.back === "goals") {
        tt.openSheet({ kind: "categories", tab: "goals" });
      } else {
        tt.closeSheet();
      }
      return true;
    }
  }

  if (ui.page === "ticket") {
    const tk = useTicketStore.getState();
    if (tk.dialog) {
      if (tk.dialog.kind === "repeat") {
        tk.openDialog({ kind: "repeats" });
      } else {
        tk.closeDialog();
      }
      return true;
    }
    if (tk.panel.kind !== "none") {
      tk.closePanel();
      return true;
    }
    if (tk.view === "list" && tk.searchOpen) {
      tk.closeSearch();
      return true;
    }
    if (tk.view === "stats" && tk.statsRoot !== null) {
      const parentId = tk.catById[tk.statsRoot]?.parent_id ?? null;
      tk.setStatsRoot(parentId);
      return true;
    }
  }

  if (ui.page === "routemap" && !ui.routeOverview) {
    if (ui.zoomId) {
      const byId = useNodeStore.getState().tree.byId;
      let cur = byId[ui.zoomId]?.parent_id ?? null;
      let nextZoom: string | null = null;
      while (cur) {
        const row = byId[cur];
        if (!row) break;
        if (row.kind === "branch" || row.kind === "train" || row.kind === "car") {
          nextZoom = row.id;
          break;
        }
        cur = row.parent_id;
      }
      ui.setZoom(nextZoom);
      return true;
    }
    ui.openRouteMap();
    return true;
  }

  if (ui.page === "notes") {
    const notes = useNotesStore.getState();
    if (notes.section === "tags" && useTagStore.getState().selectedKey !== null) {
      useTagStore.getState().select(null);
      return true;
    }
  }

  if (ui.page === "depot") {
    const depot = useDepotStore.getState();
    if (depot.bookId !== null) {
      depot.openBook(null);
      return true;
    }
  }

  return false;
}

function applyNavSnapshot(snap: NavSnapshot): void {
  isRestoring = true;
  try {
    const ui = useUiStore.getState();

    // 1. 底層頁面與頁內狀態
    if (snap.page === "routemap") {
      if (snap.routeOverview) {
        ui.openRouteMap();
        const board = useBoardStore.getState();
        if (board.overviewTab !== snap.overviewTab) {
          board.setOverviewTab(snap.overviewTab);
        }
        if (snap.overviewTab === "filter" && board.activeSavedId !== snap.activeSavedId) {
          if (snap.activeSavedId) board.applySaved(snap.activeSavedId);
          else board.clearFilter();
        }
      } else {
        if (ui.page !== "routemap") ui.setPage("routemap");
        if (ui.routeOverview) ui.setRouteOverview(false);
        const curRoute = useNodeStore.getState().routeId;
        if (snap.routeId && snap.routeId !== curRoute) {
          void useNodeStore.getState().openRoute(snap.routeId);
        }
        if (useBoardStore.getState().routeLayout !== snap.routeLayout) {
          useBoardStore.getState().setRouteLayout(snap.routeLayout);
        }
        if (useUiStore.getState().zoomId !== snap.zoomId) {
          useUiStore.getState().setZoom(snap.zoomId);
        }
      }
    } else {
      if (ui.page !== snap.page) ui.setPage(snap.page);
      switch (snap.page) {
        case "calendar":
          if (ui.calendarView !== snap.calendarView) void ui.setCalendarView(snap.calendarView);
          break;
        case "notes": {
          const notes = useNotesStore.getState();
          if (notes.section !== snap.notesSection) {
            notes.setSection(snap.notesSection);
          }
          if (snap.notesSection === "inbox" && notes.inboxKind !== snap.inboxKind) {
            notes.setInboxKind(snap.inboxKind);
          } else if (snap.notesSection === "notes") {
            const curRoute = notes.notesQuery.routeId ?? null;
            const curUnderId = notes.notesQuery.underNode?.id ?? null;
            const snapUnderId = snap.notesUnderNode?.id ?? null;
            if (curRoute !== snap.notesRouteFilter || curUnderId !== snapUnderId) {
              void notes.setNotesQuery({
                ...notes.notesQuery,
                routeId: snap.notesRouteFilter ?? undefined,
                underNode: snap.notesUnderNode ?? undefined,
              });
            }
            if (notes.selectedNoteId !== snap.selectedNoteId) {
              notes.selectNote(snap.selectedNoteId);
            }
          } else if (snap.notesSection === "diary" && notes.diaryDay !== snap.diaryDay) {
            notes.setDiaryDay(snap.diaryDay);
          } else if (snap.notesSection === "tags" && useTagStore.getState().selectedKey !== snap.tagSelectedKey) {
            useTagStore.getState().select(snap.tagSelectedKey);
          }
          break;
        }
        case "timetable": {
          const tt = useTimetableStore.getState();
          if (tt.view !== snap.timetableView) {
            tt.setView(snap.timetableView);
          }
          if (
            snap.timetableView === "schedule" &&
            useTimetableScheduleStore.getState().scheduleMode !== snap.scheduleMode
          ) {
            useTimetableScheduleStore.getState().setScheduleMode(snap.scheduleMode);
          }
          if (
            snap.timetableView === "stats" &&
            useTimetableStatsStore.getState().period !== snap.ttStatsPeriod
          ) {
            useTimetableStatsStore.getState().setPeriod(snap.ttStatsPeriod);
          }
          if (snap.timetableSheet) {
            tt.openSheet(snap.timetableSheet);
          } else if (tt.sheet !== null) {
            tt.closeSheet();
          }
          break;
        }
        case "ticket": {
          const tk = useTicketStore.getState();
          if (tk.view !== snap.ticketView) {
            void tk.setView(snap.ticketView);
          }
          if (tk.filterAccountId !== snap.ticketFilterAccountId) {
            void tk.setFilter(snap.ticketFilterAccountId);
          }
          if (snap.ticketView === "list") {
            if (snap.ticketSearchOpen && !tk.searchOpen) tk.openSearch();
            else if (!snap.ticketSearchOpen && tk.searchOpen) tk.closeSearch();
          } else if (snap.ticketView === "stats") {
            if (tk.span !== snap.ticketStatsSpan) void tk.setSpan(snap.ticketStatsSpan);
            if (tk.facet !== snap.ticketStatsFacet) tk.setFacet(snap.ticketStatsFacet);
            if (tk.facetKind !== snap.ticketStatsKind) tk.setFacetKind(snap.ticketStatsKind);
            if (tk.statsRoot !== snap.ticketStatsRoot) tk.setStatsRoot(snap.ticketStatsRoot);
          }
          if (snap.ticketDialog) {
            tk.openDialog(snap.ticketDialog);
          } else if (tk.dialog !== null) {
            tk.closeDialog();
          }
          if (snap.ticketPanel.kind === "none") {
            if (tk.panel.kind !== "none") tk.closePanel();
          } else if (snap.ticketPanel.kind === "new") {
            if (tk.panel.kind !== "new") tk.openNew();
          } else if (snap.ticketPanel.kind === "entry") {
            if (tk.panel.kind !== "entry" || tk.panel.id !== snap.ticketPanel.id) {
              tk.openEntry(snap.ticketPanel.id);
            }
          } else if (snap.ticketPanel.kind === "account") {
            if (tk.panel.kind !== "account" || tk.panel.id !== snap.ticketPanel.id) {
              tk.openAccount(snap.ticketPanel.id);
            }
          }
          break;
        }
        case "depot": {
          const depot = useDepotStore.getState();
          if (depot.tab !== snap.depotTab) {
            depot.setTab(snap.depotTab);
          }
          if (depot.bookId !== snap.depotBookId) {
            depot.openBook(snap.depotBookId);
          }
          break;
        }
      }
    }

    // 若切離時刻表或售票口，確保其對話框也同步收起
    if (snap.page !== "timetable" && useTimetableStore.getState().sheet !== null && !snap.timetableSheet) {
      useTimetableStore.getState().closeSheet();
    }
    if (snap.page !== "ticket" && useTicketStore.getState().dialog !== null && !snap.ticketDialog) {
      useTicketStore.getState().closeDialog();
    }

    // 2. 全域對話框疊層（設定、快速跳轉、快捷鍵指引、路線對話框）
    const uiAfter = useUiStore.getState();
    if (snap.settingsOpen) {
      if (!uiAfter.settingsOpen) uiAfter.openSettings(snap.settingsTab);
      else if (uiAfter.settingsTab !== snap.settingsTab) uiAfter.setSettingsTab(snap.settingsTab);
    } else if (uiAfter.settingsOpen) {
      uiAfter.setSettingsOpen(false);
    }

    if (uiAfter.quickJumpOpen !== snap.quickJumpOpen) {
      uiAfter.setQuickJumpOpen(snap.quickJumpOpen);
    }
    if (uiAfter.hotkeyGuideOpen !== snap.hotkeyGuideOpen) {
      uiAfter.setHotkeyGuideOpen(snap.hotkeyGuideOpen);
    }
    if (snap.routeDialog) {
      uiAfter.openRouteDialog(snap.routeDialog);
    } else if (uiAfter.routeDialog) {
      uiAfter.closeRouteDialog();
    }
  } finally {
    queueMicrotask(() => {
      isRestoring = false;
    });
  }
}

interface NavHistoryState {
  entries: NavSnapshot[];
  index: number;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  pushSnapshot: (snap?: NavSnapshot) => void;
  goBack: () => boolean;
  goForward: () => boolean;
  reset: (snap?: NavSnapshot) => void;
}

export const useNavHistoryStore = create<NavHistoryState>((set, get) => {
  const initial = captureNavSnapshot();
  return {
    entries: [initial],
    index: 0,

    canGoBack: () => get().index > 0,
    canGoForward: () => get().index < get().entries.length - 1,

    pushSnapshot: (snap = captureNavSnapshot()) => {
      if (isRestoring) return;
      const { entries, index } = get();
      set(reducePushSnapshot(entries, index, snap, MAX_NAV_HISTORY));
    },

    goBack: () => {
      // 第一順위：先收起畫面上開著的臨時浮層（選單、日曆小卡、推遲選單、確認框、捕捉框等）
      if (dismissTopTransientOverlay()) return true;

      const { entries, index } = get();
      if (index <= 0) {
        return stepUpHierarchyFallback();
      }
      const targetIndex = index - 1;
      const target = entries[targetIndex];
      set({ index: targetIndex });
      applyNavSnapshot(target);
      return true;
    },

    goForward: () => {
      const { entries, index } = get();
      if (index >= entries.length - 1) return false;
      const targetIndex = index + 1;
      const target = entries[targetIndex];
      set({ index: targetIndex });
      applyNavSnapshot(target);
      return true;
    },

    reset: (snap = captureNavSnapshot()) => {
      set({ entries: [snap], index: 0 });
    },
  };
});

function scheduleFlush(): void {
  if (isRestoring || pendingFlush) return;
  pendingFlush = true;
  queueMicrotask(() => {
    pendingFlush = false;
    if (!isRestoring) {
      useNavHistoryStore.getState().pushSnapshot();
    }
  });
}

// 訂閱各 Store 的導航、下鑽與疊層欄位變化，同一 tick 內的連動改動自動合併為單一歷史紀錄
useUiStore.subscribe((s, p) => {
  if (
    s.page !== p.page ||
    s.routeOverview !== p.routeOverview ||
    s.zoomId !== p.zoomId ||
    s.calendarView !== p.calendarView ||
    s.settingsOpen !== p.settingsOpen ||
    s.settingsTab !== p.settingsTab ||
    s.quickJumpOpen !== p.quickJumpOpen ||
    s.hotkeyGuideOpen !== p.hotkeyGuideOpen ||
    s.routeDialog !== p.routeDialog
  ) {
    scheduleFlush();
  }
});
useNodeStore.subscribe((s, p) => {
  if (s.routeId !== p.routeId) scheduleFlush();
});
useBoardStore.subscribe((s, p) => {
  if (
    s.routeLayout !== p.routeLayout ||
    s.overviewTab !== p.overviewTab ||
    s.activeSavedId !== p.activeSavedId
  ) {
    scheduleFlush();
  }
});
useNotesStore.subscribe((s, p) => {
  if (
    s.section !== p.section ||
    s.inboxKind !== p.inboxKind ||
    s.selectedNoteId !== p.selectedNoteId ||
    s.notesQuery !== p.notesQuery ||
    s.diaryDay !== p.diaryDay
  ) {
    scheduleFlush();
  }
});
useTagStore.subscribe((s, p) => {
  if (s.selectedKey !== p.selectedKey) scheduleFlush();
});
useTimetableStore.subscribe((s, p) => {
  if (s.view !== p.view || s.sheet !== p.sheet) scheduleFlush();
});
useTimetableScheduleStore.subscribe((s, p) => {
  if (s.scheduleMode !== p.scheduleMode) scheduleFlush();
});
useTimetableStatsStore.subscribe((s, p) => {
  if (s.period !== p.period) scheduleFlush();
});
useTicketStore.subscribe((s, p) => {
  if (
    s.view !== p.view ||
    s.filterAccountId !== p.filterAccountId ||
    s.span !== p.span ||
    s.facet !== p.facet ||
    s.facetKind !== p.facetKind ||
    s.statsRoot !== p.statsRoot ||
    s.searchOpen !== p.searchOpen ||
    s.dialog !== p.dialog ||
    s.panel !== p.panel
  ) {
    scheduleFlush();
  }
});
useDepotStore.subscribe((s, p) => {
  if (s.tab !== p.tab || s.bookId !== p.bookId) scheduleFlush();
});
