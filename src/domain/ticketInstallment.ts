/**
 * 售票口 3B：刷卡分期純函式引擎（v1.38 · Migration 0027）。
 * 零 React / DOM / Tauri 相依，可供 `node --test` 直載。
 */

export const MIN_INSTALLMENTS = 2;
export const MAX_INSTALLMENTS = 60;
export const INSTALLMENT_PRESETS = [3, 6, 12, 24] as const;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 某西元年月有幾天（month 1..12） */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 將 YYYY-MM-DD 往後加 `months` 個月，日期夾在目標月月底（例 1/31 + 1 月 → 2/28，+ 2 月 → 3/31） */
export function addMonthsClamp(dayKey: string, months: number): string {
  const [y0, m0, d0] = dayKey.split("-").map((s) => parseInt(s, 10));
  const totalMonths = y0 * 12 + (m0 - 1) + months;
  const y = Math.floor(totalMonths / 12);
  const m = (totalMonths % 12) + 1;
  const maxD = daysInMonth(y, m);
  const d = Math.min(d0, maxD);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 將總金額（整數最小單位）均分為 `periods` 期，餘數併入第 1 期，保證合計嚴格等於總額 */
export function splitInstallmentAmounts(totalMinor: number, periods: number): number[] {
  if (!Number.isInteger(periods) || periods < MIN_INSTALLMENTS || periods > MAX_INSTALLMENTS) {
    throw new RangeError(`分期期數需為 ${MIN_INSTALLMENTS}～${MAX_INSTALLMENTS} 之間的整數`);
  }
  if (!Number.isInteger(totalMinor) || totalMinor <= 0) {
    throw new RangeError("分期總金額需大於 0");
  }
  const base = Math.floor(totalMinor / periods);
  const rem = totalMinor - base * periods;
  const out: number[] = [];
  for (let i = 0; i < periods; i++) {
    out.push(i === 0 ? base + rem : base);
  }
  return out;
}

export interface InstallmentSlice {
  index: number; // 1-based
  total: number;
  occurredOn: string;
  amountMinor: number;
  feeMinor: number | null;
}

/** 規劃分期每一期的日期、金額與手續費（手續費掛第 1 期，其餘期為 null） */
export function planInstallmentSlices(input: {
  totalAmountMinor: number;
  periods: number;
  firstOccurredOn: string;
  feeMinor?: number | null;
}): InstallmentSlice[] {
  const amounts = splitInstallmentAmounts(input.totalAmountMinor, input.periods);
  const firstFee = input.feeMinor && input.feeMinor > 0 ? input.feeMinor : null;
  return amounts.map((amountMinor, idx) => ({
    index: idx + 1,
    total: input.periods,
    occurredOn: addMonthsClamp(input.firstOccurredOn, idx),
    amountMinor,
    feeMinor: idx === 0 ? firstFee : null,
  }));
}

export interface InstallmentEntryLike {
  id: string;
  occurred_on: string;
  amount_minor: number;
  main_minor: number;
  fee_main_minor?: number | null;
  installment_group_id: string | null;
  installment_index: number | null;
  installment_total: number | null;
  deleted_at: string | null;
}

export interface InstallmentGroupProgress {
  groupId: string;
  totalPeriods: number;
  aliveCount: number;
  postedCount: number; // occurred_on <= todayKey
  remainingCount: number; // occurred_on > todayKey
  totalMainMinor: number;
  postedMainMinor: number;
  remainingMainMinor: number;
  nextDueOn: string | null;
}

/** 計算單一分期群組截至 `todayKey` 的攤提進度 */
export function installmentProgressOf(
  entries: readonly InstallmentEntryLike[],
  groupId: string,
  todayKey: string,
): InstallmentGroupProgress | null {
  const rows = entries
    .filter((e) => e.deleted_at === null && e.installment_group_id === groupId)
    .sort((a, b) => (a.installment_index ?? 0) - (b.installment_index ?? 0) || a.occurred_on.localeCompare(b.occurred_on));
  if (!rows.length) return null;
  const totalPeriods = rows.reduce((m, r) => Math.max(m, r.installment_total ?? rows.length), rows.length);
  let postedCount = 0;
  let remainingCount = 0;
  let totalMainMinor = 0;
  let postedMainMinor = 0;
  let remainingMainMinor = 0;
  let nextDueOn: string | null = null;
  for (const r of rows) {
    const val = r.main_minor + (r.fee_main_minor ?? 0);
    totalMainMinor += val;
    if (r.occurred_on <= todayKey) {
      postedCount++;
      postedMainMinor += val;
    } else {
      remainingCount++;
      remainingMainMinor += val;
      if (nextDueOn === null || r.occurred_on < nextDueOn) nextDueOn = r.occurred_on;
    }
  }
  return {
    groupId,
    totalPeriods,
    aliveCount: rows.length,
    postedCount,
    remainingCount,
    totalMainMinor,
    postedMainMinor,
    remainingMainMinor,
    nextDueOn,
  };
}

/** 帳目列上的分期角標文字（例 `"分期 2/6"`；非分期回 null） */
export function installmentBadgeText(e: {
  installment_index?: number | null;
  installment_total?: number | null;
}): string | null {
  if (!e.installment_index || !e.installment_total || e.installment_total < MIN_INSTALLMENTS) return null;
  return `分期 ${e.installment_index}/${e.installment_total}`;
}
