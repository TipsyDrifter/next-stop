/**
 * navHistory.test.ts——售票口 v1.32（2B-1a 管帳多分頁對話框切籤歷史與子彈窗返回）單元測試。
 * 執行：`node --test "src/domain/navHistory.test.ts"`
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  baseKeyOf,
  overlayKeyOf,
  navKeyOf,
  reducePushSnapshot,
  ticketDialogKey,
  type NavSnapshot,
} from "./navHistory.ts";

function makeTicketSnap(overrides: Partial<NavSnapshot> = {}): NavSnapshot {
  return {
    page: "ticket",
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
    diaryDay: "2026-11-15",
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
    reportDay: null,
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

test("2B-1a — ticketDialogKey 將 manage 各分籤與既有六種 kind 對齊至同一套疊層鍵", () => {
  assert.equal(ticketDialogKey({ kind: "manage" }), "tkDialog:manage:categories");
  assert.equal(ticketDialogKey({ kind: "manage", tab: "budgets" }), "tkDialog:manage:budgets");
  assert.equal(ticketDialogKey({ kind: "categories" }), "tkDialog:manage:categories");
  assert.equal(ticketDialogKey({ kind: "accountOrder" }), "tkDialog:manage:accountOrder");
  assert.equal(ticketDialogKey({ kind: "budgets" }), "tkDialog:manage:budgets");
  assert.equal(ticketDialogKey({ kind: "repeats" }), "tkDialog:manage:repeats");
  assert.equal(ticketDialogKey({ kind: "templates" }), "tkDialog:manage:templates");
  assert.equal(ticketDialogKey({ kind: "currencies" }), "tkDialog:manage:currencies");
  assert.equal(ticketDialogKey({ kind: "newAccount" }), "tkDialog:newAccount");
  assert.equal(ticketDialogKey({ kind: "repeat", id: null }), "tkDialog:repeat:new");
  assert.equal(ticketDialogKey({ kind: "repeat", id: "rep_1" }), "tkDialog:repeat:rep_1");
});

test("2B-1a — 售票口「管帳」對話框內切籤（分類 → 預算 → 定期）逐層推入歷史，支援按上一頁退回上一籤再收起視窗", () => {
  const base = makeTicketSnap();
  let state = { entries: [base], index: 0 };

  // 1. 點右上「⚙ 管帳」打開預設「分類」籤
  const sCats = makeTicketSnap({ ticketDialog: { kind: "manage", tab: "categories" } });
  state = reducePushSnapshot(state.entries, state.index, sCats);
  assert.equal(state.index, 1);
  assert.equal(overlayKeyOf(state.entries[state.index]), "tkDialog:manage:categories");

  // 2. 切到「預算」籤
  const sBudgets = makeTicketSnap({ ticketDialog: { kind: "manage", tab: "budgets" } });
  state = reducePushSnapshot(state.entries, state.index, sBudgets);
  assert.equal(state.index, 2);
  assert.equal(baseKeyOf(sCats), baseKeyOf(sBudgets));
  assert.notEqual(navKeyOf(sCats), navKeyOf(sBudgets));

  // 3. 再切到「定期」籤
  const sRepeats = makeTicketSnap({ ticketDialog: { kind: "manage", tab: "repeats" } });
  state = reducePushSnapshot(state.entries, state.index, sRepeats);
  assert.equal(state.index, 3);

  // 模擬按上一頁（Alt+←）：index 3 -> 2（預算）-> 1（分類）-> 0（關閉對話框回帳簿）
  assert.deepEqual(state.entries[state.index - 1].ticketDialog, { kind: "manage", tab: "budgets" });
  assert.deepEqual(state.entries[state.index - 2].ticketDialog, { kind: "manage", tab: "categories" });
  assert.equal(state.entries[state.index - 3].ticketDialog, null);
});

test("2B-1a — 從「管帳 › 定期／帳戶」點進子彈窗（新增定期帳／新增帳戶）完成或取消時，Smart Modal Unwind 自動退回母分籤", () => {
  const base = makeTicketSnap();
  let state = { entries: [base], index: 0 };

  // 打開「管帳 › 帳戶」→ 點「＋ 新增帳戶」→ 取消回「管帳 › 帳戶」
  const sAcctTab = makeTicketSnap({ ticketDialog: { kind: "manage", tab: "accountOrder" } });
  state = reducePushSnapshot(state.entries, state.index, sAcctTab);
  assert.equal(state.index, 1);

  const sNewAcct = makeTicketSnap({ ticketDialog: { kind: "newAccount" } });
  state = reducePushSnapshot(state.entries, state.index, sNewAcct);
  assert.equal(state.index, 2);

  // 取消／建完退回「管帳 › 帳戶」：游標自動退回 index = 1，不殘留幽靈子彈窗歷史
  state = reducePushSnapshot(state.entries, state.index, sAcctTab);
  assert.equal(state.index, 1);

  // 切到「定期」籤 → 點「＋ 新增定期帳」→ 儲存退回「定期」籤
  const sRepTab = makeTicketSnap({ ticketDialog: { kind: "manage", tab: "repeats" } });
  state = reducePushSnapshot(state.entries, state.index, sRepTab);
  assert.equal(state.index, 2);

  const sNewRep = makeTicketSnap({ ticketDialog: { kind: "repeat", id: null } });
  state = reducePushSnapshot(state.entries, state.index, sNewRep);
  assert.equal(state.index, 3);

  state = reducePushSnapshot(state.entries, state.index, sRepTab);
  assert.equal(state.index, 2);

  // 手動按 × 關閉「管帳」對話框：游標自動退回開窗前 index = 0（且保留 entries 供「下一頁」重開）
  state = reducePushSnapshot(state.entries, state.index, base);
  assert.equal(state.index, 0);
  assert.ok(state.entries.length >= 3);
});

test("v1.33 — 運行報告「一日運行專頁（reportDay）」納入 baseKeyOf：進入專頁、前後翻日、跨模組跳轉與返回／前進", () => {
  const overview = makeTicketSnap({ page: "report", reportDay: null });
  assert.equal(baseKeyOf(overview), "report");

  let state = { entries: [overview], index: 0 };

  // 1. 點擊 11/18 進入一日運行專頁
  const day18 = makeTicketSnap({ page: "report", reportDay: "2026-11-18" });
  assert.equal(baseKeyOf(day18), "report:day:2026-11-18");
  state = reducePushSnapshot(state.entries, state.index, day18);
  assert.equal(state.index, 1);

  // 2. 翻至前一天 11/17
  const day17 = makeTicketSnap({ page: "report", reportDay: "2026-11-17" });
  assert.equal(baseKeyOf(day17), "report:day:2026-11-17");
  state = reducePushSnapshot(state.entries, state.index, day17);
  assert.equal(state.index, 2);

  // 3. 點「編輯當日日記 ›」原子跳轉至旅客筆記 11/17 日記
  const notes17 = makeTicketSnap({ page: "notes", notesSection: "diary", diaryDay: "2026-11-17" });
  state = reducePushSnapshot(state.entries, state.index, notes17);
  assert.equal(state.index, 3);

  // 模擬按滑鼠側鍵返回（Alt+[）：3(日記) -> 2(11/17 專頁) -> 1(11/18 專頁) -> 0(運行報告總表)
  assert.equal(baseKeyOf(state.entries[2]!), "report:day:2026-11-17");
  assert.equal(baseKeyOf(state.entries[1]!), "report:day:2026-11-18");
  assert.equal(baseKeyOf(state.entries[0]!), "report");
});
