/**
 * 售票口線・第③階段「管帳」的純函式（契約 2026-10-19 §4；甲席 Stage 0 全文實作）。
 *
 * 預算（按月；總額／分類；預設＋單月覆寫；只管支出）、定期帳（規則 → 到期實體化成一般帳目）、第二次匯入
 * （`BUDGET`／`BUDGET_AMOUNT`／`REPEATTRANSACTION` 三張表）。
 *
 * 鐵則同 ①②：只用可剝除語法；金額一律最小單位整數（`share`／`pace` 是比例才用浮點）；日 key 字串運算不經 `Date.parse`；
 * lib 目標 ES2020。`import` 只自 `./ticket`、`./ticketView`、`./repeat`（契約 0-10；`repeat.ts` 是主線的，只 import 不改）；
 * 不 import `lib/date`、不產生隨機 id（隨機 id 只在 repository 產生）。
 *
 * 數字口徑（契約 ✎-10）＝②的 0-7：預算的「已用」＝該月 expense 的 `main_minor` 合計（退款抵回、轉帳校正不算、封存照算）；
 * 主分類預算含子分類（`categoryIdsIncluding`）、子分類只算自己；`budgetUsed(total) ≡ statsOverview(…).expense`（測試互證）。
 *
 * 內容：
 *   §4.1 型別與常數（BudgetRow／RepeatRow／Mm* 定義在 ticket.ts——ImportLocal／MmbakDump 要用、ticket.ts 零 import——這裡 re-export）
 *   §4.2 預算         §4.3 定期帳（含實體化計畫 planMaterialize）
 *   §4.4 匯入（planImportAll 包住 ①的 planImport）
 */
import {
  IMPORT_SOURCE_MM,
  MAIN_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  UNCAT_NAME,
  atOf,
  buildEntryRow,
  categoryLabel,
  convertMinor,
  importRate,
  minorFromDecimal,
  moneyText,
  monthOf,
  monthRange,
  parseAmount,
  planImport,
  quickAmountText,
  ticketId,
  type AccountRow,
  type BudgetRow,
  type CategoryRow,
  type EntryCtx,
  type EntryRow,
  type ImportLocal,
  type ImportPlan,
  type MmbakDump,
  type MmBudget,
  type MmRepeat,
  type NewEntryInput,
  type RepeatRow,
} from "./ticket";
import { categoryIdsIncluding, dayStep, shortDay } from "./ticketView";
import {
  describeRule,
  firstFixedDate,
  fixedRule,
  nextFixedDate,
  parseRule,
  projectFixed,
  serializeRule,
  type FixedRepeatRule,
  type RepeatFreq,
} from "./repeat";

export type { BudgetRow, RepeatRow, MmBudget, MmBudgetAmount, MmRepeat } from "./ticket";

/* ───────────────────────── §4.1 型別與常數 ───────────────────────── */

export const REPEAT_HHMM_DEFAULT = "09:00";
/** projectFixed 的上限，再多留給下一輪（0-6-5） */
export const REPEAT_SCAN_MAX = 400;
/** 財務管家 PERIOD_TYPE＝月（實證：樣本只有這個值） */
export const MM_PERIOD_MONTH = 6;
/** 財務管家 REPEAT_TYPE＝每月（強證據，0-9） */
export const MM_REPEAT_MONTHLY = 1;
/** 預算列的 name 前綴（0-4） */
const BUDGET_NAME = "budget:";

export type BudgetScope = { kind: "total" } | { kind: "category"; categoryId: string };

export interface BudgetLine {
  scope: BudgetScope;
  key: string; // "total" | "cat:<id>"
  label: string; // 「總預算」／分類名（子分類＝「食物 › 點心」）
  budget: number; // 主幣別
  used: number;
  remaining: number; // budget − used（可負）
  share: number; // used ÷ budget（可 > 1、可 < 0）
  pace: number; // 0～1（✎-10）
  over: boolean; // used > budget
  override: boolean; // 這個月有覆寫
  archived: boolean; // 分類已封存
  gone: boolean; // 分類已不在
}

export interface RepeatDraft {
  kind: "expense" | "income" | "transfer";
  amountText: string;
  currency: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  note: string;
  routeId: string | null;
  freq: RepeatFreq;
  byweekday: number[];
  bymonthday: number[];
  start: string;
  until: string | null;
  hhmm: string;
  fromEntryId: string | null; // 「設成定期」來源（存檔後 link）
}

/** 規則的輸入（`TicketRepository.createRepeat`；data 層 re-export，同 NewEntryInput 的做法） */
export interface NewRepeatInput {
  kind: "income" | "expense" | "transfer";
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  amountMinor: number;
  currency: string;
  note: string;
  routeId: string | null;
  rule: FixedRepeatRule;
  hhmm: string;
}
export type RepeatPatch = Partial<NewRepeatInput>;

export interface PlanImportPart {
  budgets: {
    inserts: BudgetRow[];
    updates: { id: string; cols: Record<string, unknown> }[];
    unchanged: number;
    tombstoned: number;
    invalid: { uid: string; reason: string }[];
    overrides: number;
    scopes: number;
  };
  repeats: {
    inserts: RepeatRow[];
    updates: { id: string; cols: Record<string, unknown> }[];
    unchanged: number;
    tombstoned: number;
    invalid: { uid: string; reason: string }[];
  };
  missing: string[]; // dump.plan_missing 照抄（預覽卡那一行）
}

export const PLAN_TEXT = {
  total: "總預算",
  ruleBad: "重複規則有誤",
  accGone: "（帳戶已刪除）",
  catGone: "（分類已刪除）",
  paused: "已暫停",
  ended: "已結束",
  next: (d: string) => `下一班 ${d}`,
  weekNone: "每週至少選一天",
  monthNone: "每月至少選一天",
  startBad: "開始日期格式有誤",
  untilBad: "結束日期要在開始日期之後",
  budgetLine: (scopes: number, overrides: number) => `預算 ${scopes} 個${overrides > 0 ? `（${overrides} 個單月覆寫）` : ""}`,
  repeatLine: (n: number) => `定期帳 ${n} 筆`,
  skipLine: (n: number, reasons: string) => `略過 ${n}：${reasons}`,
  /** 本機刪過（墓碑）而跳過的預算列／定期規則（沙盒代驗 D2）；兩個都 0 ⇒ 不出。單位和上一行同：預算「個」、定期「條」 */
  tombLine: (budgets: number, repeats: number) =>
    budgets + repeats === 0
      ? null
      : `略過 ${[budgets > 0 ? `${budgets} 個` : "", repeats > 0 ? `${repeats} 條` : ""].filter(Boolean).join(" · ")}（已在這台裝置刪除）`,
} as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;
const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;

/* ───────────────────────── §4.2 預算 ───────────────────────── */

export function scopeKey(scope: BudgetScope): string {
  return scope.kind === "total" ? "total" : `cat:${scope.categoryId}`;
}

/** 列 → 對象 */
export function scopeOf(row: Pick<BudgetRow, "kind" | "category_id">): BudgetScope {
  return row.kind === "category" && row.category_id ? { kind: "category", categoryId: row.category_id } : { kind: "total" };
}

/** 確定性 id（0-4）：一個對象＋一個月（或預設）只會有一列 */
export function budgetId(scope: BudgetScope, month: string | null): string {
  return ticketId(`${BUDGET_NAME}${scopeKey(scope)}:${month ?? "default"}`);
}

/** 未刪列的對象去重；總預算固定第一，其餘依該對象列的最小 position（再 created_at、id） */
export function budgetScopes(budgets: readonly BudgetRow[]): BudgetScope[] {
  const best: Record<string, BudgetRow> = {};
  for (const b of budgets) {
    if (b.deleted_at !== null) continue;
    const k = scopeKey(scopeOf(b));
    const prev = best[k];
    if (!prev || b.position < prev.position || (b.position === prev.position && (cmpStr(b.created_at, prev.created_at) || cmpStr(b.id, prev.id)) < 0)) {
      best[k] = b;
    }
  }
  const keys = Object.keys(best).sort((a, b) => {
    if (a === "total") return -1;
    if (b === "total") return 1;
    const x = best[a];
    const y = best[b];
    return x.position - y.position || cmpStr(x.created_at, y.created_at) || cmpStr(x.id, y.id);
  });
  return keys.map((k) => scopeOf(best[k]));
}

/** 該月覆寫列優先，否則預設列；都沒有 ⇒ null */
export function effectiveBudget(
  budgets: readonly BudgetRow[],
  scope: BudgetScope,
  month: string,
): { row: BudgetRow; override: boolean } | null {
  const k = scopeKey(scope);
  let def: BudgetRow | null = null;
  for (const b of budgets) {
    if (b.deleted_at !== null || scopeKey(scopeOf(b)) !== k) continue;
    if (b.month === month) return { row: b, override: true };
    if (b.month === null) def = b;
  }
  return def ? { row: def, override: false } : null;
}

/** 該月支出淨額（0-7 口徑）；category ⇒ 主分類含子、子只算自己 */
export function budgetUsed(entries: readonly EntryRow[], scope: BudgetScope, month: string, cats: readonly CategoryRow[]): number {
  const r = monthRange(month);
  const ids = scope.kind === "category" ? new Set(categoryIdsIncluding([scope.categoryId], cats)) : null;
  let sum = 0;
  for (const e of entries) {
    if (e.deleted_at !== null || e.kind !== "expense" || e.occurred_on < r.from || e.occurred_on >= r.toExcl) continue;
    if (ids && !(e.category_id !== null && ids.has(e.category_id))) continue;
    sum += e.main_minor;
  }
  return sum;
}

function daysInMonth(month: string): number {
  const y = parseInt(month.slice(0, 4), 10);
  const m = parseInt(month.slice(5, 7), 10);
  return new Date(y, m, 0).getDate();
}

/** 按日進度：過去的月 1、未來的月 0、同月＝日號 ÷ 當月天數 */
export function monthPace(month: string, today: string): number {
  const tm = monthOf(today);
  if (tm > month) return 1;
  if (tm < month) return 0;
  return parseInt(today.slice(8, 10), 10) / daysInMonth(month);
}

/** 統計頁預算卡的列（0-11）：對每個有 effectiveBudget 的對象一列；總預算第一、其餘照 position */
export function budgetLines(
  budgets: readonly BudgetRow[],
  entries: readonly EntryRow[],
  month: string,
  cats: readonly CategoryRow[],
  today: string,
  ctx: Pick<EntryCtx, "catById">,
): BudgetLine[] {
  const pace = monthPace(month, today);
  const out: BudgetLine[] = [];
  for (const scope of budgetScopes(budgets)) {
    const eff = effectiveBudget(budgets, scope, month);
    if (!eff) continue;
    const budget = eff.row.amount_minor;
    const used = budgetUsed(entries, scope, month, cats);
    let label: string = PLAN_TEXT.total;
    let archived = false;
    let gone = false;
    if (scope.kind === "category") {
      const cat = ctx.catById[scope.categoryId] ?? null;
      gone = cat === null || cat.deleted_at !== null;
      label = categoryLabel(gone ? null : cat, ctx.catById);
      archived = !gone && cat !== null && cat.archived_at !== null;
    }
    out.push({
      scope,
      key: scopeKey(scope),
      label,
      budget,
      used,
      remaining: budget - used,
      share: budget > 0 ? used / budget : 0,
      pace,
      over: used > budget,
      override: eff.override,
      archived,
      gone,
    });
  }
  return out;
}

/**
 * 月曆「超」格（✎-6；沙盒代驗 O1 後改，和預算卡對齊）：
 * 只有「該月現在已用 > total」才標——已用和預算卡的總預算列同一支（budgetUsed(…, total, …)），卡寫「剩」月曆就不會標「超」。
 * 標在**最後一次**從 ≤ total 越到 > total 的那一天（之後累計一直在 total 之上）：該月支出依日升冪累加（同日合計後再比）。
 * 退款把月總額拉回 ≤ total ⇒ null；拉回後又超 ⇒ 標後面那次越過的日子。total null／≤0 ⇒ null。
 */
export function overBudgetDay(entries: readonly EntryRow[], month: string, totalMinor: number | null): string | null {
  if (totalMinor === null || totalMinor <= 0) return null;
  if (!(budgetUsed(entries, { kind: "total" }, month, []) > totalMinor)) return null;
  const byDay: Record<string, number> = {};
  for (const e of entries) {
    if (e.deleted_at !== null || e.kind !== "expense" || monthOf(e.occurred_on) !== month) continue;
    byDay[e.occurred_on] = (byDay[e.occurred_on] ?? 0) + e.main_minor;
  }
  let cum = 0;
  let crossed: string | null = null;
  for (const d of Object.keys(byDay).sort()) {
    const before = cum;
    cum += byDay[d];
    if (before <= totalMinor && cum > totalMinor) crossed = d;
  }
  return crossed;
}

/** 超支額無條件進位到整數主單位（至少 1）：超支 0.4 元不寫成「超支 0」（評審 R19） */
function overWhole(overMinor: number, decimals: number): number {
  const unit = Math.pow(10, decimals);
  return Math.max(1, Math.ceil(overMinor / unit)) * unit;
}

/** 卡上的三段字（整數主單位）；rest＝「剩 Z」或「超支 W」（W 無條件進位、至少 1） */
export function budgetText(line: BudgetLine, decimals: number): { used: string; budget: string; rest: string } {
  const w = (n: number) => moneyText(n, decimals, { whole: true });
  return {
    used: w(line.used),
    budget: w(line.budget),
    rest: line.over ? `超支 ${w(overWhole(-line.remaining, decimals))}` : `剩 ${w(line.remaining)}`,
  };
}

/** 預算的金額欄（store.setBudget 用）：主幣別、不允許負與 0 */
export function parseBudgetAmount(text: string, main: { code: string; decimals: number }): number {
  return parseAmount(text, main, { allowNegative: false });
}

/** 可以設預算的分類（✎-14）：支出、未刪、不是未分類；不合 ⇒ RangeError */
export function assertBudgetScope(scope: BudgetScope, catById: Readonly<Record<string, CategoryRow>>): void {
  if (scope.kind === "total") return;
  if (isUncat(scope.categoryId)) throw new RangeError("「未分類」不能設預算");
  const c = catById[scope.categoryId];
  if (!c || c.deleted_at !== null) throw new RangeError("這個分類已經刪除了");
  if (c.kind !== "expense") throw new RangeError("只有支出分類可以設預算");
}

/** 新的一列預算（id 由對象＋月決定；position 由呼叫端給） */
export function budgetRow(scope: BudgetScope, month: string | null, amountMinor: number, position: number, nowIso: string): BudgetRow {
  return {
    id: budgetId(scope, month),
    kind: scope.kind,
    category_id: scope.kind === "category" ? scope.categoryId : null,
    month,
    amount_minor: amountMinor,
    position,
    import_id: null,
    import_source: null,
    import_utime: null,
    device_id: null,
    created_at: nowIso,
    updated_at: nowIso,
    synced_at: null,
    deleted_at: null,
  };
}

/* ───────────────────────── §4.3 定期帳 ───────────────────────── */

/** parseRule 後 mode === "fixed" 才回（本線沒有「完成後 N 天」）；壞掉 ⇒ null */
export function parseFixedRule(json: string): FixedRepeatRule | null {
  const r = parseRule(json);
  return r && r.mode === "fixed" ? r : null;
}

/** 實體化的帳的確定性 id（0-4）：兩台各自實體化同一班＝同一列 */
export function materializeId(repeatId: string, day: string): string {
  return ticketId(`repeat:${repeatId}:${day}`);
}

/** skipped_days 的 JSON → 升冪去重的日 key；壞 JSON／不是日 key 的值 ⇒ 略過 */
export function parseSkipped(json: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const set = new Set<string>();
  for (const v of raw) if (typeof v === "string" && DAY_RE.test(v)) set.add(v);
  return Array.from(set).sort();
}

/** 加（add）或拿掉一天；回升冪去重的 JSON */
export function withSkipped(json: string, day: string, add: boolean): string {
  const list = parseSkipped(json).filter((d) => d !== day);
  if (add) list.push(day);
  list.sort();
  return JSON.stringify(list);
}

/**
 * 實體化的帳用哪個日界線算時刻（✎-7 改，收尾修正，評審 R16）：
 *   手建的規則 ⇒ 使用者的 dayStartHour（和①表單 `atOf(日, 時刻, dayStartHour)` 同一把尺：凌晨 03:00、日界線 6 點 ⇒ 帳日的隔一個日曆日 03:00）
 *   匯入的規則（import_source＝moneymanager）⇒ 0＝字面時刻（和①匯入財務管家的帳一致：occurred_at 是 ZDATE 的實際時刻）
 */
export function repeatDayStart(r: Pick<RepeatRow, "import_source">, dayStartHour: number): number {
  return r.import_source === IMPORT_SOURCE_MM ? 0 : dayStartHour;
}

/** 模板 → 一筆帳的輸入；occurredAt＝atOf(day, hhmm, repeatDayStart(r, dayStartHour))（✎-7 改） */
export function repeatToInput(r: RepeatRow, day: string, dayStartHour: number): NewEntryInput {
  return {
    kind: r.kind,
    amountMinor: r.amount_minor,
    currency: r.currency,
    accountId: r.account_id,
    toAccountId: r.kind === "transfer" ? r.to_account_id : null,
    categoryId: r.kind === "transfer" ? null : r.category_id,
    occurredOn: day,
    occurredAt: atOf(day, r.hhmm, repeatDayStart(r, dayStartHour)),
    note: r.note,
    routeId: r.route_id,
  };
}

/**
 * 實體化計畫（契約 0-6-3；純、決定性）。對每條未刪規則：
 *   reconcileIds += skipped_days 每一天的 id（不管暫停；repository 把本機還活著的再軟刪一次，0-7-3）
 *   暫停 ⇒ 到此為止；規則看不懂 ⇒ blocked
 *   班次＝projectFixed(rule, scanFrom(r, rule, today), today)（≤ 400；scanFrom null＝已結束 ⇒ 不掃、不出游標）；id 在 existingIds（**含墓碑**）或 skipped ⇒ 跳過
 *   buildEntryRow 丟 RangeError（帳戶／分類已刪…）⇒ 整條 blocked、游標不動、不插入
 *   游標＝nextFixedDate(rule, today)（滿 400 班且最後一班 < today ⇒ 從最後一班接著算，下一輪續掃）；沒變就不出
 * **`next_on` 是游標不是真相**（0-6-4）：兩台 LWW 可能回退，回退只會讓下一輪多掃幾天；確定性 id＋墓碑檢查保證不重複。
 * 帳的時刻：手建的規則套 dayStartHour、匯入的規則字面時刻（repeatDayStart，✎-7 改）；只影響 occurred_at，不影響班次日與 id。
 */
export function planMaterialize(
  repeats: readonly RepeatRow[],
  existingIds: ReadonlySet<string>,
  today: string,
  ctx: EntryCtx,
  nowIso: string,
  dayStartHour: number,
  idOf: (repeatId: string, day: string) => string = materializeId,
): {
  inserts: EntryRow[];
  cursors: { id: string; next_on: string | null }[];
  blocked: { id: string; reason: string }[];
  reconcileIds: string[];
} {
  const inserts: EntryRow[] = [];
  const cursors: { id: string; next_on: string | null }[] = [];
  const blocked: { id: string; reason: string }[] = [];
  const reconcileIds: string[] = [];
  for (const r of repeats) {
    if (r.deleted_at !== null) continue;
    const skipped = parseSkipped(r.skipped_days);
    for (const d of skipped) reconcileIds.push(idOf(r.id, d));
    if (r.paused_at !== null) continue;
    const rule = parseFixedRule(r.rule);
    if (!rule) {
      blocked.push({ id: r.id, reason: PLAN_TEXT.ruleBad });
      continue;
    }
    const from = scanFrom(r, rule, today);
    if (from === null) continue; // 已結束（next_on null 且今天之後沒有班）：只做 reconcile、不掃也不寫游標
    const days = projectFixed(rule, from, today);
    const mine: EntryRow[] = [];
    let reason: string | null = null;
    for (const day of days) {
      const id = idOf(r.id, day);
      if (existingIds.has(id) || skipped.indexOf(day) >= 0) continue;
      try {
        const row = buildEntryRow(repeatToInput(r, day, dayStartHour), ctx, { id, nowIso });
        row.repeat_id = r.id;
        mine.push(row);
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    if (reason !== null) {
      blocked.push({ id: r.id, reason });
      continue;
    }
    for (const row of mine) inserts.push(row);
    const last = days.length ? days[days.length - 1] : null;
    const next = days.length >= REPEAT_SCAN_MAX && last !== null && last < today ? nextFixedDate(rule, last) : nextFixedDate(rule, today);
    if (next !== r.next_on) cursors.push({ id: r.id, next_on: next });
  }
  return { inserts, cursors, blocked, reconcileIds };
}

/**
 * 這一輪從哪天掃（0-6-3；修正-資料，評審 R15）：next_on 有值 ⇒ 它；next_on null（＝已結束）且今天之後也沒有班 ⇒ null（不掃）；
 * next_on null 但規則今天之後還有班（兩台 LWW 交錯出的不一致，例：另一台改了 until）⇒ 從 start 掃一次、游標自己補回來。
 * 原稿 `next_on ?? start` 會讓超過 400 班的已結束規則每一輪「滿 400 寫回過去某天 → 下一輪寫回 null」永遠發 op。
 * sqliteTicketRepository 撈候選 id 走同一支，兩邊掃的範圍逐字相同。
 */
export function scanFrom(r: Pick<RepeatRow, "next_on">, rule: FixedRepeatRule, today: string): string | null {
  if (r.next_on !== null) return r.next_on;
  return nextFixedDate(rule, today) === null ? null : rule.start;
}

/**
 * 一筆實體化的帳是哪一個班次日（0-7-2；修正-資料，評審 R13／R14／R13c）：skipped_days 要記**班次日**，不是帳現在的日期——
 * id 是用班次日算的（materializeId），reconcile 照 skipped_days 算 id；記成帳改過的日期，會軟刪到同一條規則那天的帳、也收不回被復活的這筆。
 *   (1) materializeId(repeat.id, occurred_on) 對得上 ⇒ occurred_on（沒改過日期，最常見）
 *   (2) 否則在 [rule.start, max(today, occurred_on)] 的班次裡找 id 對得上的那一天（每段 400 班、最多 100 段）
 *   (3) 都對不上（「設成定期」連上的那筆、id 不是 repeat: 形；或規則改過、原本那天已不是班次）⇒ null：不碰 skipped_days
 *       （這筆自己的墓碑仍擋得住重記：實體化查既有 id 含墓碑）
 */
export function shiftDayOf(
  repeat: Pick<RepeatRow, "id" | "rule">,
  entry: Pick<EntryRow, "id" | "occurred_on">,
  today: string,
  idOf: (repeatId: string, day: string) => string = materializeId,
): string | null {
  if (idOf(repeat.id, entry.occurred_on) === entry.id) return entry.occurred_on;
  const rule = parseFixedRule(repeat.rule);
  if (!rule) return null;
  const to = today > entry.occurred_on ? today : entry.occurred_on;
  let from = rule.start;
  for (let seg = 0; seg < 100 && from <= to; seg++) {
    const days = projectFixed(rule, from, to);
    for (const d of days) if (idOf(repeat.id, d) === entry.id) return d;
    if (days.length < REPEAT_SCAN_MAX) break;
    from = dayStep(days[days.length - 1], 1);
  }
  return null;
}

/** 手建規則「開始」時的游標：明天往後的第一班（嚴格晚於今天，✎-8） */
export function nextOnAfterResume(rule: FixedRepeatRule, today: string): string | null {
  return nextFixedDate(rule, today);
}

/** 從沒開始過的匯入規則（✎-8）：import_source＝moneymanager 且沒有任何帳（含已刪的）的 repeat_id 指向它 */
export function neverStarted(repeat: Pick<RepeatRow, "id" | "import_source">, entries: readonly Pick<EntryRow, "repeat_id">[]): boolean {
  if (repeat.import_source !== IMPORT_SOURCE_MM) return false;
  for (const e of entries) if (e.repeat_id === repeat.id) return false;
  return true;
}

/**
 * 「開始」後的 next_on（✎-8）：從沒開始過的匯入規則接著財務管家的游標（＝最後一次匯入帶進來的 NEXT_DATE，保持不動；
 * 那天已過就照常補記到今天）；其餘（手建的、開始過的）＝明天往後的第一班、暫停期間的班不補。規則看不懂 ⇒ RangeError
 */
export function resumeNextOn(r: RepeatRow, entries: readonly Pick<EntryRow, "repeat_id">[], today: string): string | null {
  const rule = parseFixedRule(r.rule);
  if (!rule) throw new RangeError(PLAN_TEXT.ruleBad);
  if (neverStarted(r, entries) && r.next_on !== null) return r.next_on;
  return nextOnAfterResume(rule, today);
}

/** 「設成定期…」的預設規則：每月、日號＝那筆的日、從隔天起算（那筆本身不會被重記） */
export function ruleFromEntry(e: Pick<EntryRow, "occurred_on">): FixedRepeatRule {
  return fixedRule("monthly", dayStep(e.occurred_on, 1), { bymonthday: [parseInt(e.occurred_on.slice(8, 10), 10)] });
}

/** 最小單位 → 可再 parseAmount 的十進位字串（不分位、ASCII 負號；草稿的金額欄用） */
export function amountInputText(minor: number, decimals: number): string {
  const neg = minor < 0;
  const digits = String(Math.abs(minor)).padStart(decimals + 1, "0");
  const int = decimals > 0 ? digits.slice(0, digits.length - decimals) : digits;
  let frac = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** 規則列 → 編輯器草稿（規則看不懂 ⇒ 每月、start 那天的日號） */
export function draftFromRepeat(r: RepeatRow, ctx: EntryCtx): RepeatDraft {
  const rule = parseFixedRule(r.rule);
  const cur = ctx.curByCode[r.currency];
  const start = rule ? rule.start : r.next_on ?? "";
  return {
    kind: r.kind,
    amountText: amountInputText(r.amount_minor, cur ? cur.decimals : 2),
    currency: r.currency,
    accountId: r.account_id,
    toAccountId: r.to_account_id,
    categoryId: r.category_id,
    note: r.note,
    routeId: r.route_id,
    freq: rule ? rule.freq : "monthly",
    byweekday: rule && rule.byweekday ? rule.byweekday.slice() : [],
    bymonthday: rule && rule.bymonthday ? rule.bymonthday.slice() : DAY_RE.test(start) ? [parseInt(start.slice(8, 10), 10)] : [],
    start,
    until: rule ? rule.until : null,
    hhmm: r.hhmm,
    fromEntryId: null,
  };
}

function uniqSorted(list: readonly number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (const n of list) if (Number.isInteger(n) && n >= lo && n <= hi && out.indexOf(n) < 0) out.push(n);
  return out.sort((a, b) => a - b);
}

/**
 * 草稿 → 規則輸入（錯誤表：每週要選至少一天／每月要選至少一天／起算日看不懂／終止日要在起算日之後／時刻看不懂；
 * 其餘沿用 `validate()` 的訊息——拿 start 那天用 `buildEntryRow` 試算一次）
 */
export function draftToRepeatInput(d: RepeatDraft, ctx: EntryCtx): NewRepeatInput {
  if (!d.accountId) throw new RangeError("選一個帳戶");
  const account = ctx.accById[d.accountId];
  if (!account || account.deleted_at !== null) throw new RangeError("這個帳戶已經刪除了");
  const currency = d.kind === "transfer" ? account.currency : d.currency;
  const cur = ctx.curByCode[currency];
  if (!cur) throw new RangeError(`沒有這個幣別：${currency}`);
  const amountMinor = parseAmount(d.amountText, cur, { allowNegative: d.kind === "expense" });
  const byweekday = uniqSorted(d.byweekday, 0, 6);
  const bymonthday = uniqSorted(d.bymonthday, 1, 31);
  if (d.freq === "weekly" && !byweekday.length) throw new RangeError(PLAN_TEXT.weekNone);
  if (d.freq === "monthly" && !bymonthday.length) throw new RangeError(PLAN_TEXT.monthNone);
  if (!DAY_RE.test(d.start)) throw new RangeError(PLAN_TEXT.startBad);
  const until = d.until !== null && d.until.trim() !== "" ? d.until.trim() : null;
  if (until !== null && (!DAY_RE.test(until) || until < d.start)) throw new RangeError(PLAN_TEXT.untilBad);
  atOf(d.start, d.hhmm, 0); // 時刻看不懂 ⇒ RangeError
  const rule = fixedRule(d.freq, d.start, { byweekday, bymonthday });
  rule.until = until;
  const input: NewRepeatInput = {
    kind: d.kind,
    accountId: d.accountId,
    toAccountId: d.kind === "transfer" ? d.toAccountId : null,
    categoryId: d.kind === "transfer" ? null : d.categoryId,
    amountMinor,
    currency,
    note: d.note,
    routeId: d.routeId,
    rule,
    hhmm: d.hhmm.trim(),
  };
  checkRepeatInput(input, ctx);
  return input;
}

/** 規則輸入的驗證（repository 也叫）：規則必須是 fixed、時刻看得懂、start 那天試算一筆帳過得了 validate() */
export function checkRepeatInput(input: NewRepeatInput, ctx: EntryCtx): void {
  if (!input.rule || input.rule.mode !== "fixed" || !DAY_RE.test(input.rule.start)) throw new RangeError(PLAN_TEXT.ruleBad);
  atOf(input.rule.start, input.hhmm, 0);
  buildEntryRow(
    {
      kind: input.kind,
      amountMinor: input.amountMinor,
      currency: input.currency,
      accountId: input.accountId,
      toAccountId: input.toAccountId,
      categoryId: input.categoryId,
      occurredOn: input.rule.start,
      occurredAt: atOf(input.rule.start, input.hhmm, 0),
      note: input.note,
      routeId: input.routeId,
    },
    ctx,
    { id: "check", nowIso: "1970-01-01T00:00:00.000Z" },
  );
}

/** 新規則列（id／position 由 repository 給；next_on＝firstFixedDate(rule, start)） */
export function buildRepeatRow(input: NewRepeatInput, ctx: EntryCtx, meta: { id: string; position: number; nowIso: string }): RepeatRow {
  checkRepeatInput(input, ctx);
  return {
    id: meta.id,
    kind: input.kind,
    account_id: input.accountId,
    to_account_id: input.kind === "transfer" ? input.toAccountId : null,
    category_id: input.kind === "transfer" ? null : input.categoryId,
    amount_minor: input.amountMinor,
    currency: input.currency,
    note: input.note,
    route_id: input.routeId,
    rule: serializeRule(input.rule),
    hhmm: input.hhmm,
    next_on: firstFixedDate(input.rule, input.rule.start),
    paused_at: null,
    skipped_days: "[]",
    position: meta.position,
    import_id: null,
    import_source: null,
    import_utime: null,
    device_id: null,
    created_at: meta.nowIso,
    updated_at: meta.nowIso,
    synced_at: null,
    deleted_at: null,
  };
}

/** 模板欄（匯入比對與 applyRepeatPatch 共用） */
const REPEAT_TEMPLATE_COLS = ["kind", "account_id", "to_account_id", "category_id", "amount_minor", "currency", "note", "rule", "hhmm"] as const;

/**
 * 改規則（0-8）：合併 → 驗證 → 有差的欄＋updated_at；`rule` 字串變了 ⇒ next_on＝nextFixedDate(新規則, today)。
 * 沒有任何欄變 ⇒ cols 空、回原列。route_id 也比（模板的一部分，只是匯入不比它）。
 */
export function applyRepeatPatch(
  r: RepeatRow,
  patch: RepeatPatch,
  ctx: EntryCtx,
  today: string,
  nowIso: string,
): { row: RepeatRow; cols: Record<string, unknown> } {
  if (r.deleted_at !== null) throw new RangeError("這筆定期帳已經刪除了");
  const oldRule = parseFixedRule(r.rule);
  const kind = patch.kind ?? r.kind;
  const accountId = patch.accountId ?? r.account_id;
  let currency = patch.currency ?? r.currency;
  if (kind === "transfer" && patch.currency === undefined) {
    const acc = ctx.accById[accountId];
    if (acc) currency = acc.currency;
  }
  const rule = patch.rule ?? oldRule;
  if (!rule) throw new RangeError(PLAN_TEXT.ruleBad);
  const input: NewRepeatInput = {
    kind,
    accountId,
    toAccountId: kind === "transfer" ? (patch.toAccountId !== undefined ? patch.toAccountId : r.to_account_id) : null,
    categoryId: kind === "transfer" ? null : patch.categoryId !== undefined ? patch.categoryId : kind !== r.kind ? null : r.category_id,
    amountMinor: patch.amountMinor ?? r.amount_minor,
    currency,
    note: patch.note ?? r.note,
    routeId: patch.routeId !== undefined ? patch.routeId : r.route_id,
    rule,
    hhmm: patch.hhmm ?? r.hhmm,
  };
  checkRepeatInput(input, ctx);
  const next: RepeatRow = {
    ...r,
    kind: input.kind,
    account_id: input.accountId,
    to_account_id: input.toAccountId,
    category_id: input.categoryId,
    amount_minor: input.amountMinor,
    currency: input.currency,
    note: input.note,
    route_id: input.routeId,
    rule: serializeRule(input.rule),
    hhmm: input.hhmm,
  };
  const cols: Record<string, unknown> = {};
  for (const c of REPEAT_TEMPLATE_COLS) if (next[c] !== r[c]) cols[c] = next[c];
  if (next.route_id !== r.route_id) cols.route_id = next.route_id;
  if (cols.rule !== undefined) {
    next.next_on = nextFixedDate(input.rule, today);
    if (next.next_on !== r.next_on) cols.next_on = next.next_on;
  }
  if (Object.keys(cols).length === 0) return { row: r, cols: {} };
  cols.updated_at = nowIso;
  next.updated_at = nowIso;
  return { row: next, cols };
}

/** 分類段：子分類只寫自己的名字（同占比的列）；未分類＝「未分類」；不在 ⇒「（分類已不在）」 */
function catText(id: string | null, kind: "income" | "expense", catById: Readonly<Record<string, CategoryRow>>): string {
  const cid = id ?? (kind === "income" ? UNCAT_INCOME_ID : UNCAT_EXPENSE_ID);
  if (isUncat(cid)) return UNCAT_NAME;
  const c = catById[cid];
  return c && c.deleted_at === null ? c.name : PLAN_TEXT.catGone;
}

function accName(id: string | null, accById: Readonly<Record<string, AccountRow>>): string {
  const a = id ? accById[id] : undefined;
  return a && a.deleted_at === null ? a.name : PLAN_TEXT.accGone;
}

/**
 * 管理頁一列的一句話（✎-12）：收支＝「每月 1 日 · 房租 · −12,000 · 現金」（外幣在金額後加代碼）；
 * 轉帳＝「每月 5 日 · 帳戶 → 悠遊卡 · ⇄1,000」（帳戶已在去向段，不再重複）
 */
export function repeatLabel(r: RepeatRow, ctx: EntryCtx): string {
  const rule = parseFixedRule(r.rule);
  const desc = rule ? describeRule(rule) : PLAN_TEXT.ruleBad;
  const cur = ctx.curByCode[r.currency];
  const dec = cur ? cur.decimals : 2;
  const foreign = r.currency !== MAIN_CURRENCY && !(cur && cur.is_main === 1) ? ` ${r.currency}` : "";
  if (r.kind === "transfer") {
    return `${desc} · ${accName(r.account_id, ctx.accById)} → ${accName(r.to_account_id, ctx.accById)} · ${moneyText(r.amount_minor, dec, { prefix: "⇄" })}${foreign}`;
  }
  return `${desc} · ${catText(r.category_id, r.kind, ctx.catById)} · ${quickAmountText(r.kind, r.amount_minor, dec)}${foreign} · ${accName(r.account_id, ctx.accById)}`;
}

/** 管理頁的分區：暫停優先；上次實體化被擋 ⇒ blocked；沒有下一班 ⇒ ended */
export function repeatStatus(
  r: Pick<RepeatRow, "id" | "paused_at" | "next_on">,
  today: string,
  blocked: Readonly<Record<string, string>>,
): "active" | "paused" | "blocked" | "ended" {
  void today;
  if (r.paused_at !== null) return "paused";
  if (blocked[r.id] !== undefined) return "blocked";
  if (r.next_on === null) return "ended";
  return "active";
}

/** 「下一班 10/1」／「已暫停」／「已結束」 */
export function nextOnText(r: Pick<RepeatRow, "paused_at" | "next_on">): string {
  if (r.paused_at !== null) return PLAN_TEXT.paused;
  if (r.next_on === null) return PLAN_TEXT.ended;
  return PLAN_TEXT.next(shortDay(r.next_on));
}

/** 管理頁的排序（同 SQLite `ORDER BY (paused_at IS NOT NULL), COALESCE(next_on, '9999-99-99'), created_at`） */
export function repeatOrder(a: RepeatRow, b: RepeatRow): number {
  const pa = a.paused_at !== null ? 1 : 0;
  const pb = b.paused_at !== null ? 1 : 0;
  return pa - pb || cmpStr(a.next_on ?? "9999-99-99", b.next_on ?? "9999-99-99") || cmpStr(a.created_at, b.created_at) || cmpStr(a.id, b.id);
}

/* ───────────────────────── §4.4 匯入 ───────────────────────── */

/** 財務管家 BUDGET_PERIOD：0 ⇒ null（預設）；YYYYMM 且月 01–12 ⇒ "YYYY-MM"；其他 ⇒ undefined（看不懂） */
export function mmMonth(period: number): string | null | undefined {
  if (period === 0) return null;
  if (!Number.isInteger(period) || period < 100001 || period > 999912) return undefined;
  const y = Math.floor(period / 100);
  const m = period - y * 100;
  if (m < 1 || m > 12) return undefined;
  return `${String(y).padStart(4, "0")}-${pad2(m)}`;
}

function mainDecimals(dump: MmbakDump): number {
  const main = dump.currencies.find((c) => c.is_main);
  return main && Number.isInteger(main.decimals) && main.decimals >= 0 && main.decimals <= 8 ? main.decimals : 2;
}

/** 預算三張表的計畫（0-9）：預算是單例，id＝budgetId(對象, 月)；雙軌期以財務管家為準（新的 MODIFY_DATE 且金額不同 ⇒ 更新） */
export function planBudgetImport(
  dump: MmbakDump,
  plan: Pick<ImportPlan, "categoryIdOf">,
  localBudgets: readonly BudgetRow[],
  nowIso: string,
): PlanImportPart["budgets"] {
  const out: PlanImportPart["budgets"] = { inserts: [], updates: [], unchanged: 0, tombstoned: 0, invalid: [], overrides: 0, scopes: 0 };
  const budgets = dump.budgets ?? null;
  const amounts = dump.budget_amounts ?? null;
  if (budgets === null || amounts === null) return out;
  const byUid: Record<string, MmBudget> = {};
  for (const b of budgets) byUid[b.uid] = b;
  const mmCatType: Record<string, number> = {};
  for (const c of dump.categories) mmCatType[c.uid] = c.type_code;
  const dec = mainDecimals(dump);
  const local: Record<string, BudgetRow> = {};
  let pos = -1;
  for (const b of localBudgets) {
    local[b.id] = b;
    if (b.deleted_at === null && b.position > pos) pos = b.position;
  }
  // 同一個 id 在備份出現兩次（理論上不會）⇒ 留 MODIFY_DATE 大的那筆
  const cand: Record<string, { scope: BudgetScope; month: string | null; amount: number; uid: string; mtime: number }> = {};
  const order: string[] = [];
  for (const a of amounts) {
    if (a.is_del) continue;
    const b = byUid[a.budget_uid];
    if (!b) {
      out.invalid.push({ uid: a.uid, reason: "找不到設預算的分類" });
      continue;
    }
    if (b.is_del) continue;
    if (b.do_type !== 1) {
      out.invalid.push({ uid: a.uid, reason: "收入預算（目前只支援支出預算）" });
      continue;
    }
    if (b.period_type !== MM_PERIOD_MONTH) {
      out.invalid.push({ uid: a.uid, reason: "目前只支援每月預算" });
      continue;
    }
    if (b.transfer_type !== 0) {
      out.invalid.push({ uid: a.uid, reason: "不支援這種預算類型" });
      continue;
    }
    let scope: BudgetScope;
    if (b.is_total) scope = { kind: "total" };
    else {
      const t = b.target_uid ?? "";
      const cid = t ? plan.categoryIdOf[t] : undefined;
      if (!cid) {
        out.invalid.push({ uid: a.uid, reason: "找不到這個分類" });
        continue;
      }
      if (isUncat(cid)) {
        out.invalid.push({ uid: a.uid, reason: "「未分類」不能設預算" });
        continue;
      }
      if (mmCatType[t] !== undefined && mmCatType[t] !== 1) {
        out.invalid.push({ uid: a.uid, reason: "這個分類不屬於目前的收支類型" });
        continue;
      }
      scope = { kind: "category", categoryId: cid };
    }
    const month = mmMonth(a.budget_period);
    if (month === undefined) {
      out.invalid.push({ uid: a.uid, reason: "時間範圍格式有誤" });
      continue;
    }
    let amount: number;
    try {
      amount = minorFromDecimal(a.amount, dec, "round");
    } catch {
      out.invalid.push({ uid: a.uid, reason: "金額格式有誤" });
      continue;
    }
    if (amount <= 0) {
      out.invalid.push({ uid: a.uid, reason: "金額格式有誤" });
      continue;
    }
    const id = budgetId(scope, month);
    const prev = cand[id];
    if (!prev) order.push(id);
    if (!prev || a.modify_date >= prev.mtime) cand[id] = { scope, month, amount, uid: a.uid, mtime: a.modify_date };
  }
  const kept = new Set<string>();
  for (const id of order) {
    const c = cand[id];
    const l = local[id];
    if (!l) {
      const row = budgetRow(c.scope, c.month, c.amount, ++pos, nowIso);
      row.import_id = c.uid;
      row.import_source = IMPORT_SOURCE_MM;
      row.import_utime = c.mtime;
      out.inserts.push(row);
    } else if (l.deleted_at !== null) {
      out.tombstoned++;
      continue;
    } else if (c.mtime > (l.import_utime ?? -1) && c.amount !== l.amount_minor) {
      out.updates.push({
        id,
        cols: { amount_minor: c.amount, import_id: c.uid, import_source: IMPORT_SOURCE_MM, import_utime: c.mtime, updated_at: nowIso },
      });
    } else {
      out.unchanged++;
      continue;
    }
    // scopes／overrides 只算這次有變動的（inserts∪updates；修正-資料，評審：和「定期 N 條」同一個口徑、和結果卡對得上）
    kept.add(scopeKey(c.scope));
    if (c.month !== null) out.overrides++;
  }
  out.scopes = kept.size;
  out.invalid.sort((a, b) => cmpStr(a.uid, b.uid) || cmpStr(a.reason, b.reason));
  return out;
}

/** REPEAT_TYPE → 規則（只認每月；start＝NEXT_DATE 本地日、日號＝它的日號；END_DATE ⇒ until） */
export function mmRepeatRule(repeatType: number, nextDay: string, endDay: string | null): FixedRepeatRule | null {
  if (repeatType !== MM_REPEAT_MONTHLY || !DAY_RE.test(nextDay)) return null;
  const rule = fixedRule("monthly", nextDay, { bymonthday: [parseInt(nextDay.slice(8, 10), 10)] });
  rule.until = endDay !== null && DAY_RE.test(endDay) ? endDay : null;
  return rule;
}

/** 毫秒 → 本地日 key；ms ≤ 0 或看不懂 ⇒ ""（呼叫端當無） */
export function localDayOf(ms: number): string {
  if (!(ms > 0)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 毫秒 → 本地 HH:MM；看不懂 ⇒ 預設 09:00 */
export function localHhmmOf(ms: number): string {
  if (!(ms > 0)) return REPEAT_HHMM_DEFAULT;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return REPEAT_HHMM_DEFAULT;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 定期規則的計畫（0-9、0-1）：匯入的規則 id＝ticketId("moneymanager:repeat:<uid>")；
 * pauseImported ⇒ paused_at＝nowIso（0-1 (a)，D-票-31）；next_on＝NEXT_DATE 本地日（＝財務管家下一班還沒記的那天）。
 * 重跑：USETIME 較新 ⇒ 只比模板欄（不動 paused_at／next_on／skipped_days）；**例外（✎-8）**：本機規則還在暫停且從沒開始過
 * ⇒ 備份的 NEXT_DATE 比本機 next_on **晚**才算有差、一併刷成它（rule 的 start 跟著它，也一起刷；只往前、不倒回）——不看 USETIME：
 * 財務管家記一班會推 NEXT_DATE，USETIME 動不動沒實證（§9-4）。
 * opts.accounts／entries＝本機帳戶（帳戶幣別）與帳（判斷「從沒開始過」）。
 */
export function planRepeatImport(
  dump: MmbakDump,
  plan: Pick<ImportPlan, "accountIdOf" | "categoryIdOf" | "accounts">,
  localRepeats: readonly RepeatRow[],
  nowIso: string,
  opts: { pauseImported: boolean; accounts: readonly AccountRow[]; entries: readonly Pick<EntryRow, "repeat_id">[] },
): PlanImportPart["repeats"] {
  const out: PlanImportPart["repeats"] = { inserts: [], updates: [], unchanged: 0, tombstoned: 0, invalid: [] };
  const repeats: MmRepeat[] | null = dump.repeats ?? null;
  if (repeats === null) return out;
  const accCur: Record<string, string> = {};
  for (const a of opts.accounts) accCur[a.id] = a.currency;
  for (const a of plan.accounts) accCur[a.id] = a.currency;
  const curByUid: Record<string, { iso: string; decimals: number; rate: string; is_main: boolean }> = {};
  const curByIso: Record<string, { decimals: number; rate: string; is_main: boolean }> = {};
  // 和①的 planImport 同一把篩子（評審 R8b）：ISO 不是三個英文字母、或匯率看不懂的幣別①不會建 ⇒ 指到它的規則進 invalid「幣別看不懂」
  const badCurUid = new Set<string>();
  for (const c of dump.currencies) {
    const iso = c.iso.trim().toUpperCase();
    let curOk = /^[A-Z]{3}$/.test(iso);
    if (curOk && !c.is_main) {
      try {
        importRate(c.rate);
      } catch {
        curOk = false;
      }
    }
    if (!curOk) {
      badCurUid.add(c.uid);
      continue;
    }
    const decimals = Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 8 ? c.decimals : 2;
    curByUid[c.uid] = { iso, decimals, rate: c.rate, is_main: c.is_main };
    if (!curByIso[iso]) curByIso[iso] = { decimals, rate: c.rate, is_main: c.is_main };
  }
  const mmCatType: Record<string, number> = {};
  for (const c of dump.categories) mmCatType[c.uid] = c.type_code;
  const local: Record<string, RepeatRow> = {};
  let pos = -1;
  for (const r of localRepeats) {
    local[r.id] = r;
    if (r.deleted_at === null && r.position > pos) pos = r.position;
  }
  const seen = new Set<string>();
  for (const t of repeats) {
    if (t.is_del) continue;
    let kind: RepeatRow["kind"];
    if (t.do_type === 0) kind = "income";
    else if (t.do_type === 1) kind = "expense";
    else if (t.do_type === 3 && t.to_asset_uid) kind = "transfer";
    else {
      out.invalid.push({ uid: t.uid, reason: `不支援的類型：${t.do_type}` });
      continue;
    }
    const accountId = t.asset_uid ? plan.accountIdOf[t.asset_uid] : undefined;
    if (!accountId || !accCur[accountId]) {
      out.invalid.push({ uid: t.uid, reason: "找不到這個帳戶" });
      continue;
    }
    let toAccountId: string | null = null;
    if (kind === "transfer") {
      toAccountId = (t.to_asset_uid && plan.accountIdOf[t.to_asset_uid]) || null;
      if (!toAccountId) {
        out.invalid.push({ uid: t.uid, reason: "找不到這個帳戶" });
        continue;
      }
      if (toAccountId === accountId) {
        out.invalid.push({ uid: t.uid, reason: "轉出和轉入不能是同一個帳戶" });
        continue;
      }
    }
    let categoryId: string | null = null;
    if (kind !== "transfer" && t.ctg_uid) {
      const cid = plan.categoryIdOf[t.ctg_uid];
      const want = kind === "income" ? 0 : 1;
      if (cid && !isUncat(cid) && (mmCatType[t.ctg_uid] === undefined || mmCatType[t.ctg_uid] === want)) categoryId = cid;
    }
    const accCode = accCur[accountId];
    if (t.currency_uid && badCurUid.has(t.currency_uid) && !curByUid[t.currency_uid]) {
      out.invalid.push({ uid: t.uid, reason: "不支援這個幣別" });
      continue;
    }
    const txCur = t.currency_uid ? curByUid[t.currency_uid] : undefined;
    let currency = txCur ? txCur.iso : accCode;
    const decOf = (iso: string): number => (curByIso[iso] ? curByIso[iso].decimals : 2);
    let amount: number;
    try {
      amount = minorFromDecimal(t.amount_sub, decOf(currency), "round");
      if (kind === "transfer" && currency !== accCode) {
        // 轉帳的幣別跟著轉出帳戶（§4.3）：以備份匯率折成帳戶幣別（同①修正席步驟 5）
        const from = curByIso[currency];
        const to = curByIso[accCode];
        if (!from || !to) throw new RangeError("不支援這個幣別");
        amount = convertMinor(
          amount,
          { decimals: from.decimals, rate_to_main: from.is_main ? "1" : importRate(from.rate) },
          { decimals: to.decimals, rate_to_main: to.is_main ? "1" : importRate(to.rate) },
        );
        currency = accCode;
      }
    } catch {
      out.invalid.push({ uid: t.uid, reason: "金額格式有誤" });
      continue;
    }
    if (amount === 0 || (amount < 0 && kind !== "expense")) {
      out.invalid.push({ uid: t.uid, reason: "金額格式有誤" });
      continue;
    }
    const nextDay = localDayOf(t.next_date);
    if (!nextDay) {
      out.invalid.push({ uid: t.uid, reason: "下一班日期格式有誤" });
      continue;
    }
    const rule = mmRepeatRule(t.repeat_type, nextDay, t.end_date > 0 ? localDayOf(t.end_date) || null : null);
    if (!rule) {
      out.invalid.push({ uid: t.uid, reason: `不支援的重複週期：${t.repeat_type}` });
      continue;
    }
    const id = ticketId("moneymanager:repeat:" + t.uid);
    if (seen.has(id)) continue;
    seen.add(id);
    const row: RepeatRow = {
      id,
      kind,
      account_id: accountId,
      to_account_id: toAccountId,
      category_id: categoryId,
      amount_minor: amount,
      currency,
      note: t.payee.trim() || t.memo.trim(),
      route_id: null,
      rule: serializeRule(rule),
      hhmm: localHhmmOf(t.next_date),
      next_on: nextDay,
      paused_at: opts.pauseImported ? nowIso : null,
      skipped_days: "[]",
      position: 0,
      import_id: t.uid,
      import_source: IMPORT_SOURCE_MM,
      import_utime: t.usetime,
      device_id: null,
      created_at: nowIso,
      updated_at: nowIso,
      synced_at: null,
      deleted_at: null,
    };
    const l = local[id];
    if (!l) {
      row.position = ++pos;
      out.inserts.push(row);
      continue;
    }
    if (l.deleted_at !== null) {
      out.tombstoned++;
      continue;
    }
    const cols: Record<string, unknown> = {};
    const newer = t.usetime > (l.import_utime ?? -1);
    if (newer) for (const c of REPEAT_TEMPLATE_COLS) if (row[c] !== l[c]) cols[c] = row[c];
    // ✎-8 的游標刷新**只往前**（評審 R9b）：比較舊的備份（NEXT_DATE 較早）不能把游標／規則倒回去，否則「全部開始」從舊日子補記、
    // 和上一次匯入帶進來的那筆重複（0-1 要防的雙記）。財務管家記一班只會把 NEXT_DATE 往後推。
    if (l.paused_at !== null && neverStarted(l, opts.entries) && (l.next_on === null || nextDay > l.next_on)) {
      cols.next_on = nextDay;
      if (l.rule !== row.rule) cols.rule = row.rule;
    }
    if (Object.keys(cols).length === 0) {
      out.unchanged++;
      continue;
    }
    if (newer) cols.import_utime = t.usetime;
    cols.updated_at = nowIso;
    out.updates.push({ id, cols });
  }
  out.invalid.sort((a, b) => cmpStr(a.uid, b.uid) || cmpStr(a.reason, b.reason));
  return out;
}

/** ①的 planImport＋第③階段的兩段（store 改叫這支；ticket.ts 不反向 import，不成環） */
export function planImportAll(
  dump: MmbakDump,
  local: ImportLocal,
  opts: { balanceText: Readonly<Record<string, string>>; nowIso: string; pauseImported: boolean },
): { plan: ImportPlan; part: PlanImportPart } {
  const plan = planImport(dump, local, { balanceText: opts.balanceText, nowIso: opts.nowIso });
  const part: PlanImportPart = {
    budgets: planBudgetImport(dump, plan, local.budgets ?? [], opts.nowIso),
    repeats: planRepeatImport(dump, plan, local.repeats ?? [], opts.nowIso, {
      pauseImported: opts.pauseImported,
      accounts: local.accounts,
      entries: local.entries,
    }),
    missing: (dump.plan_missing ?? []).slice(),
  };
  return { plan, part };
}

/**
 * 預覽卡／結果卡文字（§5.6）：budgetLine「預算 3 個（2 個單月覆寫）」、repeatLine「定期 4 條」、skipLine「略過 N：原因、原因」或 null、
 * tombLine「略過 N 個（這台刪過）」／「略過 M 條（這台刪過）」／「略過 N 個 · M 條（這台刪過）」或 null（墓碑照舊不復活，只是說出來；D2）
 */
export function partSummary(part: PlanImportPart): { budgetLine: string; repeatLine: string; skipLine: string | null; tombLine: string | null } {
  const b = part.budgets;
  const r = part.repeats;
  const invalid = [...b.invalid, ...r.invalid];
  const reasons: string[] = [];
  for (const x of invalid) if (reasons.indexOf(x.reason) < 0) reasons.push(x.reason);
  return {
    budgetLine: PLAN_TEXT.budgetLine(b.scopes, b.overrides),
    repeatLine: PLAN_TEXT.repeatLine(r.inserts.length + r.updates.length),
    skipLine: invalid.length ? PLAN_TEXT.skipLine(invalid.length, reasons.join("、")) : null,
    tombLine: PLAN_TEXT.tombLine(b.tombstoned, r.tombstoned),
  };
}
