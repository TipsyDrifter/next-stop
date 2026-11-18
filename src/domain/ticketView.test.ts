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
  TICKET_MANAGE_TABS,
  isTicketManageTab,
  hasInMonthFacets,
  isInMonthFilterActive,
  filterMonthEntries,
  inMonthSummary,
} = await import("./ticketView.ts");

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
