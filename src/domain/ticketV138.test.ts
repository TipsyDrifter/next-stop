import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsClamp,
  installmentBadgeText,
  installmentProgressOf,
  planInstallmentSlices,
  splitInstallmentAmounts,
} from "./ticketInstallment.ts";
import { creditCardCycleOf, isCardDueForReminder, type CardAccountLike, type CardEntryLike } from "./ticketCardCycle.ts";
import { findLegacySplitCandidates, suggestLegacySplit } from "./ticketSplit.ts";

describe("ticketInstallment (3B 分期付款)", () => {
  it("clamps month-end dates properly across leap and non-leap years", () => {
    assert.equal(addMonthsClamp("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonthsClamp("2026-01-31", 2), "2026-03-31");
    assert.equal(addMonthsClamp("2028-01-31", 1), "2028-02-29");
    assert.equal(addMonthsClamp("2026-11-15", 3), "2027-02-15");
  });

  it("splits total minor units with remainder in period 1 and attaches fee only to period 1", () => {
    const amounts = splitInstallmentAmounts(10000, 3);
    assert.deepEqual(amounts, [3334, 3333, 3333]);
    assert.equal(amounts.reduce((a, b) => a + b, 0), 10000);

    const slices = planInstallmentSlices({
      totalAmountMinor: 10000,
      periods: 3,
      firstOccurredOn: "2026-10-31",
      feeMinor: 15000,
    });
    assert.equal(slices.length, 3);
    assert.deepEqual(slices[0], { index: 1, total: 3, occurredOn: "2026-10-31", amountMinor: 3334, feeMinor: 15000 });
    assert.deepEqual(slices[1], { index: 2, total: 3, occurredOn: "2026-11-30", amountMinor: 3333, feeMinor: null });
    assert.deepEqual(slices[2], { index: 3, total: 3, occurredOn: "2026-12-31", amountMinor: 3333, feeMinor: null });
  });

  it("computes installment progress and badge text", () => {
    const rows = [
      { id: "i1", occurred_on: "2026-09-10", amount_minor: 10000, main_minor: 10000, fee_main_minor: 500, installment_group_id: "g1", installment_index: 1, installment_total: 3, deleted_at: null },
      { id: "i2", occurred_on: "2026-10-10", amount_minor: 10000, main_minor: 10000, fee_main_minor: null, installment_group_id: "g1", installment_index: 2, installment_total: 3, deleted_at: null },
      { id: "i3", occurred_on: "2026-11-10", amount_minor: 10000, main_minor: 10000, fee_main_minor: null, installment_group_id: "g1", installment_index: 3, installment_total: 3, deleted_at: null },
    ];
    const p = installmentProgressOf(rows, "g1", "2026-10-15");
    assert.ok(p);
    assert.equal(p.postedCount, 2);
    assert.equal(p.remainingCount, 1);
    assert.equal(p.totalMainMinor, 30500);
    assert.equal(p.remainingMainMinor, 10000);
    assert.equal(p.nextDueOn, "2026-11-10");
    assert.equal(installmentBadgeText(rows[1]), "分期 2/3");
    assert.equal(installmentBadgeText({ installment_index: null, installment_total: null }), null);
  });
});

describe("ticketCardCycle (3B 信用卡帳單週期與提醒)", () => {
  const card: CardAccountLike = {
    id: "card-1",
    name: "星辰白金卡",
    group_key: "card",
    currency: "TWD",
    statement_day: 20,
    payment_due_day: 5,
    auto_pay_account_id: "bank-1",
    archived_at: null,
    deleted_at: null,
  };

  it("computes current statement bill, payments, remaining due, and unbilled spending", () => {
    const entries: CardEntryLike[] = [
      // Previous cycle (Aug 21 - Sep 20): 2,000 + fee 30 = 2,030
      { kind: "expense", occurred_on: "2026-09-01", account_id: "card-1", to_account_id: null, account_minor: 200000, to_amount_minor: null, fee_minor: 3000, deleted_at: null },
      // Refund in cycle: -500 => net bill 1,530
      { kind: "expense", occurred_on: "2026-09-18", account_id: "card-1", to_account_id: null, account_minor: -50000, to_amount_minor: null, fee_minor: null, deleted_at: null },
      // Unbilled spending after Sep 20: 800
      { kind: "expense", occurred_on: "2026-09-25", account_id: "card-1", to_account_id: null, account_minor: 80000, to_amount_minor: null, fee_minor: null, deleted_at: null },
      // Partial payment after Sep 20: 530
      { kind: "transfer", occurred_on: "2026-09-28", account_id: "bank-1", to_account_id: "card-1", account_minor: 53000, to_amount_minor: 53000, fee_minor: 1500, deleted_at: null },
    ];
    const s = creditCardCycleOf(card, entries, "2026-10-03");
    assert.ok(s);
    assert.equal(s.lastStatementOn, "2026-09-20");
    assert.equal(s.prevStatementOn, "2026-08-20");
    assert.equal(s.paymentDueOn, "2026-10-05");
    assert.equal(s.billMinor, 153000);
    assert.equal(s.paidMinor, 53000);
    assert.equal(s.dueMinor, 100000);
    assert.equal(s.unbilledMinor, 80000);
    assert.equal(s.daysUntilDue, 2);
    assert.equal(s.status, "due");
    assert.equal(isCardDueForReminder(s, 3), true);
    assert.equal(isCardDueForReminder(s, 1), false);
  });

  it("marks bill as paid and mutes reminder when payment covers bill", () => {
    const entries: CardEntryLike[] = [
      { kind: "expense", occurred_on: "2026-09-10", account_id: "card-1", to_account_id: null, account_minor: 100000, to_amount_minor: null, fee_minor: null, deleted_at: null },
      { kind: "transfer", occurred_on: "2026-09-25", account_id: "bank-1", to_account_id: "card-1", account_minor: 100000, to_amount_minor: 100000, fee_minor: null, deleted_at: null },
    ];
    const s = creditCardCycleOf(card, entries, "2026-10-04");
    assert.ok(s);
    assert.equal(s.dueMinor, 0);
    assert.equal(s.status, "paid");
    assert.equal(isCardDueForReminder(s, 5), false);
  });
});

describe("ticketSplit (3A 舊帳隨筆分流小幫手)", () => {
  it("suggests clean splits for parenthetical, separator, space, long, and duplicate rows", () => {
    const base = { kind: "expense" as const, occurred_on: "2026-10-01", amount_minor: 12000, currency: "TWD", category_id: null, deleted_at: null };
    const p = suggestLegacySplit({ ...base, id: "1", item: "麥味登（跟室友吃早午餐）", note: "" });
    assert.equal(p?.suggestedItem, "麥味登");
    assert.equal(p?.suggestedNote, "跟室友吃早午餐");

    const s = suggestLegacySplit({ ...base, id: "2", item: "7-11 - 買咖啡順便領包裹", note: "" });
    assert.equal(s?.suggestedItem, "7-11");
    assert.equal(s?.suggestedNote, "買咖啡順便領包裹");

    const sp = suggestLegacySplit({ ...base, id: "3", item: "全聯 牛奶吐司跟週末水果", note: "" });
    assert.equal(sp?.suggestedItem, "全聯");
    assert.equal(sp?.suggestedNote, "牛奶吐司跟週末水果");

    const dup = suggestLegacySplit({ ...base, id: "4", item: "拉麵", note: "拉麵" });
    assert.equal(dup?.reason, "duplicate");
    assert.equal(dup?.suggestedNote, "");

    const clean = suggestLegacySplit({ ...base, id: "5", item: "麥味登", note: "" });
    assert.equal(clean, null);

    const list = findLegacySplitCandidates([
      { ...base, id: "1", occurred_on: "2026-10-01", item: "麥味登（跟室友）", note: "" },
      { ...base, id: "2", occurred_on: "2026-10-05", item: "拉麵", note: "" },
      { ...base, id: "3", occurred_on: "2026-10-03", item: "全聯 買牛奶跟麵包", note: "" },
    ]);
    assert.deepEqual(list.map((x) => x.entryId), ["3", "1"]);
  });
});
