/**
 * 售票口 3B：信用卡帳單週期、本期應繳與繳款提醒純函式（v1.38 · Migration 0027）。
 * 零 React / DOM / Tauri 相依，可供 `node --test` 直載。
 */

export const MIN_CARD_DAY = 1;
export const MAX_CARD_DAY = 28;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

export function clampCardDay(day: number | null | undefined): number | null {
  if (day === null || day === undefined || !Number.isFinite(day)) return null;
  const n = Math.floor(day);
  if (n < MIN_CARD_DAY || n > MAX_CARD_DAY) return null;
  return n;
}

function makeDayKey(year: number, month: number, day: number): string {
  const total = year * 12 + (month - 1);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

function parseYmd(dayKey: string): [number, number, number] {
  const [y, m, d] = dayKey.split("-").map((s) => parseInt(s, 10));
  return [y, m, d];
}

/** 兩日差（`toDay - fromDay` 之整數天數） */
export function diffCardDays(fromDay: string, toDay: string): number {
  const [y1, m1, d1] = parseYmd(fromDay);
  const [y2, m2, d2] = parseYmd(toDay);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export interface CardAccountLike {
  id: string;
  name: string;
  group_key: string;
  currency: string;
  statement_day: number | null;
  payment_due_day: number | null;
  auto_pay_account_id: string | null;
  archived_at: string | null;
  deleted_at: string | null;
}

export interface CardEntryLike {
  kind: "income" | "expense" | "transfer" | "adjust";
  occurred_on: string;
  account_id: string;
  to_account_id: string | null;
  account_minor: number;
  to_amount_minor: number | null;
  fee_minor?: number | null;
  deleted_at: string | null;
}

export type CardBillStatus = "paid" | "due" | "overdue" | "upcoming";

export interface CreditCardCycleSummary {
  accountId: string;
  statementDay: number;
  paymentDueDay: number | null;
  /** 最近一次已結帳日（<= todayKey） */
  lastStatementOn: string;
  /** 前一次結帳日（本期帳單起點，不含當天） */
  prevStatementOn: string;
  /** 下一次結帳日（> todayKey） */
  nextStatementOn: string;
  /** 本期帳單對應之繳款截止日（無設 payment_due_day 則 null） */
  paymentDueOn: string | null;
  /** 本期帳單消費淨額（帳戶幣別最小單位，含手續費、扣退款） */
  billMinor: number;
  /** 結帳後已轉入該卡的繳款合計（帳戶幣別最小單位） */
  paidMinor: number;
  /** 本期剩餘應繳（Math.max(0, billMinor - paidMinor)） */
  dueMinor: number;
  /** 尚未結帳的新一期消費淨額（lastStatementOn < d <= nextStatementOn） */
  unbilledMinor: number;
  /** 距離繳款截止日還剩幾天（0＝今天截止；負數＝已逾期；無設截止日則 null） */
  daysUntilDue: number | null;
  status: CardBillStatus;
}

/**
 * 計算信用卡截至 `todayKey` 的最近一期已出帳單、已繳金額、本期剩餘應繳與下期未出帳消費。
 * 若該帳戶非 `card` 群組、已刪或未設定合法 `statement_day`（1..28），回傳 null。
 */
export function creditCardCycleOf(
  account: CardAccountLike,
  entries: readonly CardEntryLike[],
  todayKey: string,
): CreditCardCycleSummary | null {
  if (account.deleted_at !== null || account.group_key !== "card") return null;
  const stmtDay = clampCardDay(account.statement_day);
  if (stmtDay === null) return null;
  const dueDay = clampCardDay(account.payment_due_day);

  const [ty, tm, td] = parseYmd(todayKey);
  // 若今天 >= 結帳日，最近已結帳日＝本月結帳日；否則＝上月結帳日
  const lastStmtYear = td >= stmtDay ? ty : tm === 1 ? ty - 1 : ty;
  const lastStmtMonth = td >= stmtDay ? tm : tm === 1 ? 12 : tm - 1;
  const lastStatementOn = makeDayKey(lastStmtYear, lastStmtMonth, stmtDay);
  const prevStatementOn = makeDayKey(lastStmtYear, lastStmtMonth - 1, stmtDay);
  const nextStatementOn = makeDayKey(lastStmtYear, lastStmtMonth + 1, stmtDay);

  // payment_due_day > statement_day ⇒ 結帳同月；payment_due_day <= statement_day ⇒ 結帳次月
  const paymentDueOn =
    dueDay === null
      ? null
      : dueDay > stmtDay
        ? makeDayKey(lastStmtYear, lastStmtMonth, dueDay)
        : makeDayKey(lastStmtYear, lastStmtMonth + 1, dueDay);

  // 繳款認定窗口：自結帳隔日起至 max(paymentDueOn, nextStatementOn) 之前
  const payWindowEnd =
    paymentDueOn && paymentDueOn > nextStatementOn ? paymentDueOn : nextStatementOn;

  let billMinor = 0;
  let paidMinor = 0;
  let unbilledMinor = 0;

  for (const e of entries) {
    if (e.deleted_at !== null) continue;
    // 1. 刷卡消費（含手續費、退款為負自然抵扣）
    if (e.account_id === account.id && e.kind === "expense") {
      const amt = e.account_minor + (e.fee_minor ?? 0);
      if (e.occurred_on > prevStatementOn && e.occurred_on <= lastStatementOn) {
        billMinor += amt;
      } else if (e.occurred_on > lastStatementOn && e.occurred_on <= nextStatementOn) {
        unbilledMinor += amt;
      }
    }
    // 2. 轉入該信用卡帳戶＝繳卡費（或入帳折抵）
    if (e.kind === "transfer" && e.to_account_id === account.id) {
      if (e.occurred_on > lastStatementOn && e.occurred_on <= payWindowEnd) {
        paidMinor += e.to_amount_minor ?? 0;
      }
    }
  }

  const netBill = Math.max(0, billMinor);
  const dueMinor = Math.max(0, netBill - paidMinor);
  const daysUntilDue = paymentDueOn ? diffCardDays(todayKey, paymentDueOn) : null;

  let status: CardBillStatus;
  if (dueMinor <= 0) {
    status = "paid";
  } else if (daysUntilDue !== null && daysUntilDue < 0) {
    status = "overdue";
  } else if (daysUntilDue !== null && daysUntilDue <= 7) {
    status = "due";
  } else {
    status = "upcoming";
  }

  return {
    accountId: account.id,
    statementDay: stmtDay,
    paymentDueDay: dueDay,
    lastStatementOn,
    prevStatementOn,
    nextStatementOn,
    paymentDueOn,
    billMinor: netBill,
    paidMinor,
    dueMinor,
    unbilledMinor: Math.max(0, unbilledMinor),
    daysUntilDue,
    status,
  };
}

/** 檢查某張信用卡是否需要觸發繳款提醒（未封存、有剩餘應繳、且在提前 `leadDays` 天內或已逾期未超過 7 天） */
export function isCardDueForReminder(summary: CreditCardCycleSummary, leadDays: number): boolean {
  if (summary.dueMinor <= 0 || summary.daysUntilDue === null) return false;
  return summary.daysUntilDue <= leadDays && summary.daysUntilDue >= -7;
}
