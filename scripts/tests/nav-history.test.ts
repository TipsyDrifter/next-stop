import test from "node:test";
import assert from "node:assert/strict";
import {
  baseKeyOf,
  overlayKeyOf,
  navKeyOf,
  reducePushSnapshot,
  type NavSnapshot,
} from "../../src/domain/navHistory.ts";

function makeBaseSnap(overrides: Partial<NavSnapshot> = {}): NavSnapshot {
  return {
    page: "today",
    routeOverview: false,
    routeId: "r1",
    routeLayout: "outline",
    overviewTab: "routes",
    activeSavedId: null,
    zoomId: null,
    calendarView: "month",
    notesSection: "inbox",
    inboxKind: "all",
    selectedNoteId: null,
    notesRouteFilter: null,
    notesUnderNode: null,
    diaryDay: "2026-11-10",
    tagSelectedKey: null,
    timetableView: "schedule",
    scheduleMode: "week",
    ttStatsPeriod: "week",
    ticketView: "list",
    ticketFilterAccountId: null,
    ticketStatsSpan: "month",
    ticketStatsFacet: "category",
    ticketStatsKind: "expense",
    ticketStatsRoot: null,
    ticketSearchOpen: false,
    depotTab: "ride",
    depotBookId: null,
    settingsOpen: false,
    settingsTab: "general",
    quickJumpOpen: false,
    hotkeyGuideOpen: false,
    routeDialog: null,
    timetableSheet: null,
    ticketDialog: null,
    ticketPanel: { kind: "none" },
    ...overrides,
  };
}

test("navHistory — baseKeyOf 與 overlayKeyOf 分離底層視圖、支線下鑽與對話框疊層", () => {
  const s0 = makeBaseSnap();
  assert.equal(overlayKeyOf(s0), "");

  // 進入支線 zoomId
  const sZoom = makeBaseSnap({ page: "routemap", routeOverview: false, routeId: "r1", zoomId: "b1" });
  assert.equal(baseKeyOf(sZoom), "routemap:route:r1:outline:b1");

  // 打開設定視窗與切籤
  const sSetGen = { ...sZoom, settingsOpen: true, settingsTab: "general" as const };
  const sSetBak = { ...sZoom, settingsOpen: true, settingsTab: "backup" as const };
  assert.equal(baseKeyOf(sSetGen), baseKeyOf(sZoom));
  assert.equal(overlayKeyOf(sSetGen), "settings:general");
  assert.equal(overlayKeyOf(sSetBak), "settings:backup");
  assert.notEqual(navKeyOf(sSetGen), navKeyOf(sSetBak));
});

test("navHistory — 對話框內切籤、子面板下鑽與 Smart Modal Unwind（手動按 × 關窗自動退回開窗前位置）", () => {
  const base = makeBaseSnap({ page: "timetable", timetableView: "schedule", scheduleMode: "week" });
  let state = { entries: [base], index: 0 };

  // 1. 打開「分類與設定：目標籤」
  const sheetGoals = makeBaseSnap({
    ...base,
    timetableSheet: { kind: "categories", tab: "goals" },
  });
  state = reducePushSnapshot(state.entries, state.index, sheetGoals);
  assert.equal(state.index, 1);

  // 2. 點「＋ 新增目標」進入子面板
  const sheetNewGoal = makeBaseSnap({
    ...base,
    timetableSheet: { kind: "goal", goalId: null, back: "goals" },
  });
  state = reducePushSnapshot(state.entries, state.index, sheetNewGoal);
  assert.equal(state.index, 2);

  // 3. 在子面板按「取消」回到母對話框「分類與設定：目標籤」：Smart Unwind 退回 index = 1
  state = reducePushSnapshot(state.entries, state.index, sheetGoals);
  assert.equal(state.index, 1);

  // 4. 手動按 × 關閉對話框回到無疊層的 base：Smart Unwind 退回 index = 0（保留後續紀錄供「下一頁」重開）
  state = reducePushSnapshot(state.entries, state.index, base);
  assert.equal(state.index, 0);
  assert.equal(state.entries.length, 3);
});

test("navHistory — 在快速跳轉（QuickJump）等疊層中跳往新頁面時，自動剝除中間臨時疊層紀錄", () => {
  const today = makeBaseSnap({ page: "today" });
  let state = { entries: [today], index: 0 };

  // 按 Ctrl+P 打開快速跳轉
  const qj = makeBaseSnap({ page: "today", quickJumpOpen: true });
  state = reducePushSnapshot(state.entries, state.index, qj);
  assert.equal(state.index, 1);

  // 選中項目跳往旅客筆記並自動關閉 QuickJump
  const notes = makeBaseSnap({ page: "notes", notesSection: "notes", selectedNoteId: "n42", quickJumpOpen: false });
  state = reducePushSnapshot(state.entries, state.index, notes);
  assert.equal(state.entries.length, 2);
  assert.equal(state.index, 1);
  assert.equal(state.entries[0].page, "today");
  assert.equal(state.entries[0].quickJumpOpen, false);
  assert.equal(state.entries[1].page, "notes");
});
