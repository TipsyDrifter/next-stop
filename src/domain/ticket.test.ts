/**
 * ticket.test.ts——售票口 v1.33（3B G4 自訂月起算日＆主幣別切換換算、G5 金額隱私遮罩格式化）純函式單元測試。
 * 執行：`node --test "src/domain/ticket.test.ts"`
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clampMonthStartDay,
  currencySymbol,
  daySubtotalText,
  divideRate,
  formatDisplayMoney,
  groupByDay,
  mainCurrencyOf,
  maskedMoneyText,
  monthOf,
  monthRange,
  monthRangeLabel,
  monthSum,
  parseMonthStartDay,
  planSetMainCurrency,
  rowAmount,
  type AccountRow,
  type BudgetRow,
  type CurrencyRow,
  type EntryRow,
} from "./ticket.ts";

const SYNC = {
  device_id: "dev1",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  synced_at: null,
  deleted_at: null,
} as const;

function makeEntry(overrides: Partial<EntryRow> & { id: string; occurred_on: string; main_minor: number }): EntryRow {
  const { id, occurred_on, main_minor, ...rest } = overrides;
  return {
    ...SYNC,
    id,
    kind: "expense",
    occurred_on,
    occurred_at: `${occurred_on}T12:00:00.000Z`,
    account_id: "acc_twd",
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

test("3B-G4 — parseMonthStartDay 與 clampMonthStartDay 嚴守 1～28 號邊界", () => {
  assert.equal(parseMonthStartDay(null), 1);
  assert.equal(parseMonthStartDay(""), 1);
  assert.equal(parseMonthStartDay("0"), 1);
  assert.equal(parseMonthStartDay("29"), 1);
  assert.equal(parseMonthStartDay("abc"), 1);
  assert.equal(parseMonthStartDay("5"), 5);
  assert.equal(parseMonthStartDay("25"), 25);
  assert.equal(parseMonthStartDay("28"), 28);
  assert.equal(clampMonthStartDay(-3), 1);
  assert.equal(clampMonthStartDay(31), 28);
  assert.equal(clampMonthStartDay(15.9), 15);
});

test("3B-G4 — monthOf / monthRange / monthRangeLabel 跨月、跨年（12月→1月）與平閏 2 月邊界完全吻合", () => {
  // 預設 startDay = 1
  assert.deepEqual(monthRange("2026-11"), { from: "2026-11-01", toExcl: "2026-12-01" });
  assert.equal(monthRangeLabel("2026-11", 1), null);
  assert.equal(monthOf("2026-11-01"), "2026-11");

  // startDay = 5：2026-11 帳期為 2026-11-05 ～ 2026-12-04
  assert.deepEqual(monthRange("2026-11", 5), { from: "2026-11-05", toExcl: "2026-12-05" });
  assert.equal(monthRangeLabel("2026-11", 5), "11/05–12/04");
  assert.equal(monthOf("2026-11-04", 5), "2026-10");
  assert.equal(monthOf("2026-11-05", 5), "2026-11");
  assert.equal(monthOf("2026-12-04", 5), "2026-11");
  assert.equal(monthOf("2026-12-05", 5), "2026-12");

  // startDay = 25 跨年：2026-12 帳期為 2026-12-25 ～ 2027-01-24
  assert.deepEqual(monthRange("2026-12", 25), { from: "2026-12-25", toExcl: "2027-01-25" });
  assert.equal(monthRangeLabel("2026-12", 25), "12/25–01/24");
  assert.equal(monthOf("2026-12-24", 25), "2026-11");
  assert.equal(monthOf("2026-12-25", 25), "2026-12");
  assert.equal(monthOf("2027-01-01", 25), "2026-12");
  assert.equal(monthOf("2027-01-24", 25), "2026-12");
  assert.equal(monthOf("2027-01-25", 25), "2027-01");

  // startDay = 28 平年 2 月（2026）與閏年 2 月（2028）
  assert.deepEqual(monthRange("2026-02", 28), { from: "2026-02-28", toExcl: "2026-03-28" });
  assert.equal(monthRangeLabel("2026-01", 28), "01/28–02/27");
  assert.equal(monthRangeLabel("2026-02", 28), "02/28–03/27");
  assert.equal(monthRangeLabel("2028-02", 28), "02/28–03/27");
  assert.equal(monthOf("2026-02-27", 28), "2026-01");
  assert.equal(monthOf("2026-02-28", 28), "2026-02");
  assert.equal(monthOf("2028-02-29", 28), "2028-02");
  assert.equal(monthOf("2028-03-27", 28), "2028-02");
  assert.equal(monthOf("2028-03-28", 28), "2028-03");
});

test("3B-G4 — monthSum 在自訂起算日下正確歸屬跨月帳目", () => {
  const list: EntryRow[] = [
    makeEntry({ id: "e1", occurred_on: "2026-11-03", main_minor: 100_00 }),
    makeEntry({ id: "e2", occurred_on: "2026-11-05", main_minor: 200_00 }),
    makeEntry({ id: "e3", occurred_on: "2026-12-04", main_minor: 300_00 }),
    makeEntry({ id: "e4", occurred_on: "2026-12-05", main_minor: 400_00 }),
    makeEntry({ id: "e5", occurred_on: "2026-12-02", kind: "income", main_minor: 5000_00 }),
  ];
  // startDay = 1：11 月含 e1, e2
  assert.deepEqual(monthSum(list, "2026-11", 1), { expense: 300_00, income: 0 });
  // startDay = 5：2026-11（11/05～12/04）含 e2, e3 與 12/02 收入 e5；11/03 歸入 2026-10，12/05 歸入 2026-12
  assert.deepEqual(monthSum(list, "2026-11", 5), { expense: 500_00, income: 5000_00 });
  assert.deepEqual(monthSum(list, "2026-10", 5), { expense: 100_00, income: 0 });
  assert.deepEqual(monthSum(list, "2026-12", 5), { expense: 400_00, income: 0 });
});

test("3B-G4 — 主幣別切換換算（planSetMainCurrency、divideRate、mainCurrencyOf、rowAmount）", () => {
  const currencies: CurrencyRow[] = [
    { ...SYNC, id: "c_twd", code: "TWD", name: "新台幣", decimals: 2, rate_to_main: "1", is_main: 1, position: 0 },
    { ...SYNC, id: "c_usd", code: "USD", name: "美元", decimals: 2, rate_to_main: "32", is_main: 0, position: 1 },
    { ...SYNC, id: "c_jpy", code: "JPY", name: "日圓", decimals: 0, rate_to_main: "0.2", is_main: 0, position: 2 },
  ];
  assert.equal(divideRate("1", "32"), "0.03125");
  assert.equal(divideRate("0.2", "32"), "0.00625");

  const entries: EntryRow[] = [
    // TWD 320.00 元 -> 切到 USD 後應為 $10.00 (1000 minor)
    makeEntry({ id: "e_twd", occurred_on: "2026-11-10", currency: "TWD", amount_minor: 320_00, main_minor: 320_00 }),
    // 原幣 USD $15.50 (1550 minor, 舊 main_minor = 496_00 TWD) -> 切到 USD 後原幣即主幣別，應精準回 1550 minor
    makeEntry({ id: "e_usd", occurred_on: "2026-11-11", currency: "USD", amount_minor: 15_50, main_minor: 496_00 }),
    // 原幣 JPY 1600 円 (舊 main_minor = 320_00 TWD) -> 切到 USD 後應為 $10.00 (1000 minor)
    makeEntry({ id: "e_jpy", occurred_on: "2026-11-12", currency: "JPY", amount_minor: 1600, main_minor: 320_00 }),
  ];
  const budgets: BudgetRow[] = [
    {
      ...SYNC,
      id: "b_total",
      kind: "total",
      category_id: null,
      month: null,
      amount_minor: 32000_00, // NT$ 32,000 -> USD $1,000.00 (1000_00)
      position: 0,
      import_id: null,
      import_source: null,
      import_utime: null,
    },
  ];

  const plan = planSetMainCurrency({
    targetCode: "USD",
    currencies,
    entries,
    budgets,
    wishes: [],
    nowIso: "2026-11-18T10:00:00.000Z",
  });
  const byCode: Record<string, CurrencyRow> = {};
  for (const c of currencies) {
    const upd = plan.currencies.find((u) => u.id === c.id);
    byCode[c.code] = upd ? { ...c, ...upd.cols } : c;
  }

  assert.equal(mainCurrencyOf(byCode).code, "USD");
  assert.equal(byCode.USD.is_main, 1);
  assert.equal(byCode.USD.rate_to_main, "1");
  assert.equal(byCode.TWD.is_main, 0);
  assert.equal(byCode.TWD.rate_to_main, "0.03125");
  assert.equal(byCode.JPY.rate_to_main, "0.00625");

  const updatedEntries = entries.map((e) => {
    const upd = plan.entries.find((u) => u.id === e.id);
    return upd ? { ...e, main_minor: upd.main_minor } : e;
  });
  assert.deepEqual(
    updatedEntries.map((e) => e.main_minor),
    [10_00, 15_50, 10_00],
  );
  assert.equal(plan.budgets[0].amount_minor, 1000_00);

  // rowAmount 傳入新主幣別 USD 時：USD 帳不顯示 convMain，TWD 帳則視為外幣顯示 convMain
  const accs: Record<string, AccountRow> = {
    acc_twd: { ...SYNC, id: "acc_twd", name: "台銀", group_key: "bank", currency: "TWD", position: 0, archived_at: null },
  };
  assert.equal(rowAmount(updatedEntries[1], null, accs, "USD").convMain, null);
  assert.equal(rowAmount(updatedEntries[0], null, accs, "USD").convMain, 10_00);
});

test("3B-G5 — maskedMoneyText / formatDisplayMoney / daySubtotalText 隱私遮罩顯示", () => {
  assert.equal(currencySymbol("TWD"), "NT$");
  assert.equal(currencySymbol("JPY"), "¥");
  assert.equal(currencySymbol("USD"), "US$");
  assert.equal(maskedMoneyText("TWD"), "NT$ ****");
  assert.equal(maskedMoneyText("JPY", { prefix: "＋" }), "＋¥ ****");
  assert.equal(maskedMoneyText("TWD", { withSymbol: false }), "****");
  assert.equal(formatDisplayMoney(1250_00, 2, { masked: true, currency: "TWD" }), "NT$ ****");
  assert.equal(formatDisplayMoney(1250_00, 2, { masked: false, currency: "TWD" }), "1,250");

  const groups = groupByDay(
    [
      makeEntry({ id: "e1", occurred_on: "2026-11-10", main_minor: 150_00 }),
      makeEntry({ id: "e2", occurred_on: "2026-11-10", kind: "income", main_minor: 2000_00 }),
    ],
    null,
  );
  assert.equal(daySubtotalText(groups[0], 2, { masked: true, currency: "TWD" }), "NT$ **** ＋NT$ ****");
});
