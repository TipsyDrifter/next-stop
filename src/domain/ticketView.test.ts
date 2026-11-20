/**
 * ticketView.test.ts——售票口 v1.32（2B-1a 管帳分籤常數 ＆ 2B-2 當月直篩排序）純函式單元測試。
 * 執行：`node --test "src/domain/ticketView.test.ts"`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { AccountRow, CategoryRow, CurrencyRow, EntryRow } from "./ticket.ts";
import type { EntryFilter, ViewCtx } from "./ticketView.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  DEFAULT_ENTRY_SORT,
  EMPTY_FILTER,
  GONE_KEY,
  NO_ROUTE_KEY,
  NO_TAG_KEY,
  TICKET_MANAGE_TABS,
  breakdown,
  calendarCells,
  cellText,
  isTicketManageTab,
  hasInMonthFacets,
  isInMonthFilterActive,
  filterMonthEntries,
  inMonthSummary,
  monthlyTrend,
  periodRange,
  resultSummary,
  routeBreakdownEntries,
  trendMonths,
  trendRange,
} = await import("./ticketView.ts");
const { budgetLines, budgetMonthSub, budgetRow, budgetText, overBudgetDay } = await import("./ticketPlan.ts");
const { parseBreakdownSort } = await import("./ticketPrefs.ts");

const SYNC = {
  device_id: "dev1",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  synced_at: null,
  deleted_at: null,
} as const;

const twd: CurrencyRow = {
  ...SYNC,
  id: "cur_twd",
  code: "TWD",
  name: "新台幣",
  decimals: 0,
  rate_to_main: "1",
  is_main: 1,
  position: 0,
};

const accCash: AccountRow = { ...SYNC, id: "acc_cash", name: "現金", group_key: "cash", currency: "TWD", position: 0, archived_at: null };
const accCard: AccountRow = { ...SYNC, id: "acc_card", name: "信用卡", group_key: "card", currency: "TWD", position: 1, archived_at: null };

const catFood: CategoryRow = { ...SYNC, id: "cat_food", kind: "expense", name: "外食", parent_id: null, position: 0, archived_at: null };
const catRamen: CategoryRow = { ...SYNC, id: "cat_ramen", kind: "expense", name: "拉麵", parent_id: "cat_food", position: 0, archived_at: null };
const catTransit: CategoryRow = { ...SYNC, id: "cat_transit", kind: "expense", name: "交通", parent_id: null, position: 1, archived_at: null };
const catSalary: CategoryRow = { ...SYNC, id: "cat_salary", kind: "income", name: "薪資", parent_id: null, position: 0, archived_at: null };

function makeEntry(overrides: Partial<EntryRow> & { id: string; occurred_on: string; main_minor: number }): EntryRow {
  const { id, occurred_on, main_minor, ...rest } = overrides;
  return {
    ...SYNC,
    id,
    kind: "expense",
    occurred_on,
    occurred_at: `${occurred_on}T12:00:00.000Z`,
    account_id: "acc_cash",
    to_account_id: null,
    category_id: "cat_food",
    amount_minor: main_minor,
    currency: "TWD",
    main_minor,
    account_minor: main_minor,
    to_amount_minor: null,
    note: "",
    route_id: null,
    repeat_id: null,
    import_id: null,
    import_source: null,
    import_utime: null,
    ...rest,
  };
}

const ctx: ViewCtx = {
  curByCode: { TWD: twd },
  accById: { acc_cash: accCash, acc_card: accCard },
  catById: {
    cat_food: catFood,
    cat_ramen: catRamen,
    cat_transit: catTransit,
    cat_salary: catSalary,
  },
  routeById: {
    r_jy: { id: "r_jy", name: "山手線", code: "JY", color: "#80c241" },
  },
  routeOrder: ["r_jy"],
  entryTags: {
    e_nov_ramen: ["旅行/京都"],
    e_nov_transit: ["通勤"],
    e_oct_ramen: ["旅行/京都"],
  },
  tagName: (k) => k,
};

const entries: EntryRow[] = [
  makeEntry({ id: "e_oct_ramen", occurred_on: "2026-10-28", main_minor: 320, category_id: "cat_ramen", route_id: "r_jy" }),
  makeEntry({ id: "e_nov_ramen", occurred_on: "2026-11-03", main_minor: 280, category_id: "cat_ramen", route_id: "r_jy", account_id: "acc_card" }),
  makeEntry({ id: "e_nov_lunch", occurred_on: "2026-11-10", main_minor: 150, category_id: "cat_food", route_id: null, account_id: "acc_cash" }),
  makeEntry({ id: "e_nov_transit", occurred_on: "2026-11-12", main_minor: 45, category_id: "cat_transit", route_id: "r_jy", account_id: "acc_cash" }),
  makeEntry({ id: "e_nov_salary", occurred_on: "2026-11-05", main_minor: 32000, kind: "income", category_id: "cat_salary", account_id: "acc_cash" }),
  makeEntry({
    id: "e_nov_transfer",
    occurred_on: "2026-11-15",
    main_minor: 1000,
    kind: "transfer",
    category_id: null,
    account_id: "acc_cash",
    to_account_id: "acc_card",
    to_amount_minor: 1000,
  }),
  makeEntry({ id: "e_dec_future", occurred_on: "2026-12-01", main_minor: 500, category_id: "cat_food" }),
];

test("2B-1a — TICKET_MANAGE_TABS 涵蓋全套六籤且順序固定", () => {
  assert.deepEqual(
    TICKET_MANAGE_TABS.map((t) => t.key),
    ["categories", "accountOrder", "budgets", "repeats", "templates", "currencies"],
  );
  assert.equal(isTicketManageTab("repeats"), true);
  assert.equal(isTicketManageTab("newAccount"), false);
});

test("2B-2 — hasInMonthFacets 與 isInMonthFilterActive 正確辨識當月篩選與排序狀態", () => {
  assert.equal(hasInMonthFacets(EMPTY_FILTER), false);
  assert.equal(isInMonthFilterActive(EMPTY_FILTER, DEFAULT_ENTRY_SORT, null), false);
  assert.equal(isInMonthFilterActive(EMPTY_FILTER, "amountDesc", null), true);
  assert.equal(isInMonthFilterActive(EMPTY_FILTER, DEFAULT_ENTRY_SORT, "acc_cash"), true);
  assert.equal(hasInMonthFacets({ ...EMPTY_FILTER, tagKeys: ["旅行"] }), true);
});

test("2B-2 — filterMonthEntries 嚴格鎖定指定月份（翻月自然沿用條件），支援分類含子孫、路線、帳戶、#荷札選父含子與四種排序", () => {
  // 1) 主分類「外食」自動涵蓋子分類「拉麵」，且只篩 2026-11（排除 10 月與 12 月）
  const fFood: EntryFilter = { ...EMPTY_FILTER, categoryIds: ["cat_food"] };
  const novFood = filterMonthEntries(entries, "2026-11", fFood, "dateDesc", ctx);
  assert.deepEqual(novFood.map((e) => e.id), ["e_nov_lunch", "e_nov_ramen"]);

  // 翻到 2026-10 沿用同一篩選條件
  const octFood = filterMonthEntries(entries, "2026-10", fFood, "dateDesc", ctx);
  assert.deepEqual(octFood.map((e) => e.id), ["e_oct_ramen"]);

  // 2) #荷札 選父「旅行」自動涵蓋子「旅行/京都」
  const fTag: EntryFilter = { ...EMPTY_FILTER, tagKeys: ["旅行"] };
  const novTag = filterMonthEntries(entries, "2026-11", fTag, "dateDesc", ctx);
  assert.deepEqual(novTag.map((e) => e.id), ["e_nov_ramen"]);

  // 3) 帳戶篩選會同時命中轉入端（acc_card 命中刷卡支出與轉入）
  const fCard: EntryFilter = { ...EMPTY_FILTER, accountId: "acc_card" };
  const novCard = filterMonthEntries(entries, "2026-11", fCard, "dateAsc", ctx);
  assert.deepEqual(novCard.map((e) => e.id), ["e_nov_ramen", "e_nov_transfer"]);

  // 4) 路線「無路線」篩選
  const fNoRoute: EntryFilter = { ...EMPTY_FILTER, routeId: "none" };
  const novNoRoute = filterMonthEntries(entries, "2026-11", fNoRoute, "amountDesc", ctx);
  assert.deepEqual(novNoRoute.map((e) => e.id), ["e_nov_salary", "e_nov_transfer", "e_nov_lunch"]);

  // 5) 當月金額小到大排序
  const novAmtAsc = filterMonthEntries(entries, "2026-11", EMPTY_FILTER, "amountAsc", ctx);
  assert.deepEqual(novAmtAsc.map((e) => e.id), [
    "e_nov_transit",
    "e_nov_lunch",
    "e_nov_ramen",
    "e_nov_transfer",
    "e_nov_salary",
  ]);
});

test("2B-2 — inMonthSummary 依 0-7 口徑計算當月篩選筆數與收支小計（轉帳計入筆數但不入收支）", () => {
  const novAll = filterMonthEntries(entries, "2026-11", EMPTY_FILTER, "dateDesc", ctx);
  // 5 筆（含 1 筆轉帳）；支出 = 280 + 150 + 45 = 475；收入 = 32,000
  assert.equal(inMonthSummary(novAll, 0), "5 筆 · 支出 475 · 收入 32,000");
});

test("3B-1 — 統計各切面（分類／帳戶／路線／荷札）筆數聚合與「依金額｜依筆數」排序切換", () => {
  assert.equal(parseBreakdownSort(null), "amount");
  assert.equal(parseBreakdownSort("count"), "count");
  assert.equal(parseBreakdownSort("invalid"), "amount");

  const novRange = periodRange({ span: "month", key: "2026-11" });
  const statEntries: EntryRow[] = [
    // 交通：3 筆小額（共 120）
    makeEntry({ id: "t1", occurred_on: "2026-11-02", main_minor: 40, category_id: "cat_transit", route_id: "r_jy", account_id: "acc_cash" }),
    makeEntry({ id: "t2", occurred_on: "2026-11-05", main_minor: 40, category_id: "cat_transit", route_id: "r_jy", account_id: "acc_cash" }),
    makeEntry({ id: "t3", occurred_on: "2026-11-08", main_minor: 40, category_id: "cat_transit", route_id: "r_jy", account_id: "acc_cash" }),
    // 外食：2 筆大額（共 800：拉麵 600 × 1 筆、未細分 200 × 1 筆）
    makeEntry({ id: "f1", occurred_on: "2026-11-10", main_minor: 600, category_id: "cat_ramen", route_id: null, account_id: "acc_card" }),
    makeEntry({ id: "f2", occurred_on: "2026-11-12", main_minor: 200, category_id: "cat_food", route_id: "r_old_deleted", account_id: "acc_card" }),
  ];
  const statCtx: ViewCtx = {
    ...ctx,
    entryTags: {
      t1: ["通勤"],
      t2: ["通勤"],
      t3: ["通勤"],
      f1: ["美食"],
    },
  };

  // 分類切面：預設依金額（外食 800 > 交通 120）vs 依筆數（交通 3 筆 > 外食 2 筆）
  const byAmt = breakdown(statEntries, novRange, "category", "expense", statCtx, { sort: "amount" });
  assert.deepEqual(
    byAmt.rows.map((r) => ({ key: r.key, minor: r.minor, count: r.count })),
    [
      { key: "cat_food", minor: 800, count: 2 },
      { key: "cat_transit", minor: 120, count: 3 },
    ],
  );
  const byCnt = breakdown(statEntries, novRange, "category", "expense", statCtx, { sort: "count" });
  assert.deepEqual(
    byCnt.rows.map((r) => ({ key: r.key, minor: r.minor, count: r.count })),
    [
      { key: "cat_transit", minor: 120, count: 3 },
      { key: "cat_food", minor: 800, count: 2 },
    ],
  );

  // 荷札切面：沒掛荷札（NO_TAG_KEY, tail=1）即使筆數多也固定錨定在一般荷札之後；一般荷札依筆數排（通勤 3 筆 > 美食 1 筆）
  const tagByAmt = breakdown(statEntries, novRange, "tag", "expense", statCtx, { sort: "amount" });
  assert.deepEqual(tagByAmt.rows.map((r) => r.key), ["美食", "通勤", NO_TAG_KEY]);
  const tagByCnt = breakdown(statEntries, novRange, "tag", "expense", statCtx, { sort: "count" });
  assert.deepEqual(tagByCnt.rows.map((r) => r.key), ["通勤", "美食", NO_TAG_KEY]);
  assert.deepEqual(tagByCnt.rows.map((r) => r.count), [3, 1, 1]);

  // 路線切面：routeBreakdownEntries 與 breakdown 各列筆數及淨額 100% 吻合，且按日期新到舊排
  const rtBreak = breakdown(statEntries, novRange, "route", "expense", statCtx, { sort: "count" });
  assert.deepEqual(rtBreak.rows.map((r) => ({ key: r.key, count: r.count })), [
    { key: "r_jy", count: 3 },
    { key: NO_ROUTE_KEY, count: 1 },
    { key: GONE_KEY, count: 1 },
  ]);
  for (const row of rtBreak.rows) {
    const detail = routeBreakdownEntries(statEntries, novRange, row.key, "expense", statCtx);
    assert.equal(detail.length, row.count);
    assert.equal(
      detail.reduce((sum, e) => sum + e.main_minor, 0),
      row.minor,
    );
  }
  assert.deepEqual(
    routeBreakdownEntries(statEntries, novRange, "r_jy", "expense", statCtx).map((e) => e.id),
    ["t3", "t2", "t1"],
  );
});

test("3B-G4 — 自訂月起算日（5 號／25 號跨年）在清單直篩、月曆、統計趨勢與預算進度全線一致", () => {
  // startDay = 5：2026-11 為 11/05～12/04
  // entries 中：e_nov_ramen(11/03=280) 落入 2026-10；e_nov_salary(11/05)、e_nov_lunch(11/10=150)、e_nov_transit(11/12=45)、e_nov_transfer(11/15)、e_dec_future(12/01=500) 落入 2026-11！
  const novStart5 = filterMonthEntries(entries, "2026-11", EMPTY_FILTER, "dateAsc", ctx, 5);
  assert.deepEqual(
    novStart5.map((e) => e.id),
    ["e_nov_salary", "e_nov_lunch", "e_nov_transit", "e_nov_transfer", "e_dec_future"],
  );

  // 跨年測試：startDay = 25，2026-12 帳期為 2026-12-25 ～ 2027-01-24
  const crossYearEntries: EntryRow[] = [
    makeEntry({ id: "cy_before", occurred_on: "2026-12-24", main_minor: 300 }),
    makeEntry({ id: "cy_dec26", occurred_on: "2026-12-26", main_minor: 400 }),
    makeEntry({ id: "cy_jan10", occurred_on: "2027-01-10", main_minor: 700 }),
    makeEntry({ id: "cy_jan25", occurred_on: "2027-01-25", main_minor: 900 }),
  ];
  const decRange25 = periodRange({ span: "month", key: "2026-12" }, 25);
  assert.deepEqual(decRange25, { from: "2026-12-25", toExcl: "2027-01-25" });

  // 年統計區間 = 該年 12 個帳務月的聯集（2026-01-25 ～ 2027-01-25）
  const yearRange25 = periodRange({ span: "year", key: "2026" }, 25);
  assert.deepEqual(yearRange25, { from: "2026-01-25", toExcl: "2027-01-25" });
  assert.deepEqual(trendRange({ span: "year", key: "2026" }, 25), yearRange25);

  const trend = monthlyTrend(crossYearEntries, trendMonths({ span: "year", key: "2026" }), 25);
  const novPoint = trend.find((p) => p.month === "2026-11");
  const decPoint = trend.find((p) => p.month === "2026-12");
  assert.equal(novPoint?.expense, 300); // 12/24 歸入 2026-11
  assert.equal(decPoint?.expense, 1100); // 12/26 (400) + 01/10 (700) 歸入 2026-12；01/25 歸入 2027-01

  // 預算卡與超支日：2026-12（12/25～01/24 共 31 天），總預算 1000，於 2027-01-10 累積 1100 超支
  const bRows = [budgetRow({ kind: "total" }, null, 1000, 0, "2026-12-01T00:00:00.000Z")];
  const lines = budgetLines(bRows, crossYearEntries, "2026-12", [catFood], "2027-01-03", ctx, 25);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].used, 1100);
  assert.equal(lines[0].over, true);
  // 12/25 到 01/03 共已過 10 天 / 31 天
  assert.equal(Math.round(lines[0].pace * 31), 10);
  assert.equal(budgetMonthSub("2026-12", "2027-01-03", 25), "12 月（12/25–01/24） · 已過 10/31 天");
  assert.equal(overBudgetDay(crossYearEntries, "2026-12", 1000, 25), "2027-01-10");

  // 月曆格歸屬：2027-01-10 在 2026-12（startDay=25）月曆中 inMonth === true
  const cells = calendarCells(crossYearEntries, "2026-12", 1, "2027-01-10", 25).flat();
  const jan10Cell = cells.find((c) => c.dayKey === "2027-01-10");
  assert.equal(jan10Cell?.inMonth, true);
  assert.equal(jan10Cell?.expense, 700);
});

test("3B-G5 — 統計摘要、預算文字與月曆格在隱私遮罩開啟時不洩漏金額數字", () => {
  const novAll = filterMonthEntries(entries, "2026-11", EMPTY_FILTER, "dateDesc", ctx);
  assert.equal(inMonthSummary(novAll, 0, { masked: true, currency: "TWD" }), "5 筆 · 支出 NT$ **** · 收入 NT$ ****");
  assert.equal(resultSummary(novAll, 0, { masked: true, currency: "TWD" }), "找到 5 筆 · 支出 NT$ **** · 收入 NT$ ****");

  const bRows = [budgetRow({ kind: "total" }, null, 300, 0, "2026-11-01T00:00:00.000Z")];
  const [line] = budgetLines(bRows, entries, "2026-11", [catFood], "2026-11-15", ctx, 1);
  assert.deepEqual(budgetText(line, 0, { masked: true, currency: "TWD" }), {
    used: "NT$ ****",
    budget: "NT$ ****",
    rest: "超支 NT$ ****",
  });

  const cells = calendarCells(entries, "2026-11", 1, "2026-11-05", 1).flat();
  const nov5 = cells.find((c) => c.dayKey === "2026-11-05")!;
  assert.deepEqual(cellText(nov5, 0, false, true), { expense: "", income: "＋****" });
});
