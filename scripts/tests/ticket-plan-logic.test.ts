/**
 * 售票口線・第③階段「管帳」單元測試（③契約 §4.7；甲席 Stage 0）。
 * 跑法：`node --test scripts/tests/ticket-plan-logic.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * A～F：domain（`src/domain/ticketPlan.ts`）全部真斷言。G：repository 對帳——memory 與 sqlite 兩個實作各跑一遍 38～42c（42 測匯入，隨「從財務管家匯入」拿掉）
 * （sqlite 跑在 `node:sqlite` 記憶體 DB、套**真的** 0007＋0010 DDL、開外鍵；`runBatch` 替身收 op，驗 op 的種類與 cols），
 * 43＝同一組操作在兩個實作逐列相同（甲席 Stage 1 補完）。
 *
 * 載入：ticketPlan.ts 以無副檔名 import "./ticket"／"./ticketView"／"./repeat"——static import 會在 registerHooks 之前解析，
 * 所以 src 的值一律等 hook 掛好後動態載入（同 ticket-view-logic.test.ts）。
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻，不寫 UTC 字面值。金額一律合成。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const FAKE_DB = `
let t = Date.UTC(2026, 9, 19, 1, 0, 0);
export function getDb() { const d = globalThis.__tkDb; if (!d) throw new Error("測試沒設 __tkDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
`;
const FAKE_CORE = `export async function invoke() { throw new Error("測試不 invoke"); }`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

import type { AccountRow, CategoryRow, CurrencyRow, EntryCtx, EntryRow } from "../../src/domain/ticket.ts";
import type { BudgetRow, RepeatRow } from "../../src/domain/ticketPlan.ts";

const T = await import("../../src/domain/ticket.ts");
const V = await import("../../src/domain/ticketView.ts");
const R = await import("../../src/domain/repeat.ts");
const P = await import("../../src/domain/ticketPlan.ts");
const M = await import("../../src/data/memoryTicketRepository.ts");
const S = await import("../../src/data/sqliteTicketRepository.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const { ticketId, UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, atOf } = T;
const { fixedRule, afterRule, serializeRule, nextFixedDate } = R;

/* ───────── fixture ───────── */

const NOW = new Date(2026, 9, 19, 9, 0).toISOString();
const TODAY = "2026-10-19";
/** 日界線（planMaterialize 的 dayStartHour；手建規則的帳時刻套它，✎-7 改） */
const DSH = 6;
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };

function cur(code: string, rate: string, isMain = false): CurrencyRow {
  return { id: ticketId("currency:" + code), code, name: code, decimals: 2, rate_to_main: rate, is_main: isMain ? 1 : 0, position: 0, ...SYNC };
}
function acc(id: string, name: string, group: string, extra: Partial<AccountRow> = {}): AccountRow {
  return { id, name, group_key: group, currency: "TWD", position: 0, archived_at: null, ...SYNC, ...extra };
}
function cat(id: string, kind: "income" | "expense", name: string, parent: string | null, position: number, extra: Partial<CategoryRow> = {}): CategoryRow {
  return { id, kind, name, parent_id: parent, position, archived_at: null, ...SYNC, ...extra };
}
function byId<X extends { id: string }>(rows: X[]): Record<string, X> {
  const o: Record<string, X> = {};
  for (const r of rows) o[r.id] = r;
  return o;
}

const TWD = cur("TWD", "1", true);
const USD = cur("USD", "31.5");
/** 7 帳戶（樣本格式 §三的形狀）＋一個封存、一個已刪 */
const ACCOUNTS: AccountRow[] = [
  acc("a-cash", "現金", "cash"),
  acc("a-bank", "帳戶", "bank"),
  acc("a-student", "學生證", "bank"),
  acc("a-lend", "出借貸款", "investment"),
  acc("a-easy", "悠遊卡", "bank"),
  acc("a-easyd", "悠遊卡", "debit"),
  acc("a-card", "信用卡", "card"),
  acc("a-arch", "舊帳戶", "bank", { archived_at: NOW }),
];
const GONE_ACC = acc("a-gone", "舊悠遊卡", "debit", { deleted_at: NOW });
const CATS: CategoryRow[] = [
  cat(UNCAT_INCOME_ID, "income", "未分類", null, 9999),
  cat(UNCAT_EXPENSE_ID, "expense", "未分類", null, 9999),
  cat("c-food", "expense", "🍜 食物", null, 0),
  cat("c-lunch", "expense", "午餐", "c-food", 0),
  cat("c-snack", "expense", "點心", "c-food", 1, { archived_at: NOW }),
  cat("c-traffic", "expense", "🚖 交通", null, 1),
  cat("c-bus", "expense", "公車", "c-traffic", 0),
  cat("c-rent", "expense", "房租", null, 2),
  cat("c-old", "expense", "舊分類", null, 3, { archived_at: NOW }),
  cat("c-salary", "income", "💳 薪水", null, 0),
];
const CTX: EntryCtx = { accById: byId(ACCOUNTS), catById: byId(CATS), curByCode: { TWD, USD } };

let seq = 0;
function ent(p: Partial<EntryRow> & { occurred_on: string; amount_minor: number }): EntryRow {
  seq++;
  return {
    id: p.id ?? `e-${seq}`,
    kind: "expense",
    occurred_at: atOf(p.occurred_on, "12:00", 0),
    account_id: "a-cash",
    to_account_id: null,
    category_id: "c-lunch",
    currency: "TWD",
    main_minor: p.amount_minor,
    account_minor: p.amount_minor,
    to_amount_minor: null,
    note: "",
    route_id: null,
    repeat_id: null,
    import_id: null,
    import_source: null,
    import_utime: null,
    ...SYNC,
    ...p,
  } as EntryRow;
}

/** 約 60 筆合成帳：9–11 月；含退款、USD、轉帳、校正、兩筆指到不存在的分類、一筆已刪 */
function demoEntries(): EntryRow[] {
  const out: EntryRow[] = [];
  const rnd = (() => {
    let a = 20261019;
    return () => {
      a = (a * 1103515245 + 12345) % 2147483648;
      return a / 2147483648;
    };
  })();
  for (const m of ["2026-09", "2026-10", "2026-11"]) {
    for (let d = 1; d <= 28; d += 2) {
      const day = `${m}-${String(d).padStart(2, "0")}`;
      const pick = ["c-lunch", "c-snack", "c-bus", "c-food", "c-rent"][Math.floor(rnd() * 5)];
      out.push(ent({ occurred_on: day, amount_minor: 1000 + Math.floor(rnd() * 400) * 100, category_id: pick }));
    }
    out.push(ent({ occurred_on: `${m}-05`, kind: "income", amount_minor: 3000000, category_id: "c-salary", account_id: "a-bank" }));
    out.push(ent({ occurred_on: `${m}-09`, amount_minor: -25000, category_id: "c-lunch", note: "退款" }));
    out.push(ent({ occurred_on: `${m}-12`, kind: "transfer", amount_minor: 500000, category_id: null, account_id: "a-bank", to_account_id: "a-cash", to_amount_minor: 500000 }));
    out.push(ent({ occurred_on: `${m}-13`, kind: "adjust", amount_minor: -3700, category_id: null }));
  }
  out.push(ent({ occurred_on: "2026-10-14", amount_minor: 1000, currency: "USD", main_minor: 31500, account_minor: 31500, category_id: "c-snack", note: "App Store" }));
  out.push(ent({ occurred_on: "2026-10-15", amount_minor: 9900, category_id: "c-missing1" }));
  out.push(ent({ occurred_on: "2026-10-16", amount_minor: 4500, category_id: "c-missing2" }));
  out.push(ent({ occurred_on: "2026-10-17", amount_minor: 88800, category_id: "c-lunch", deleted_at: NOW }));
  return out;
}
const ENTRIES = demoEntries();

function bud(scope: any, month: string | null, amount: number, position: number, extra: Partial<BudgetRow> = {}): BudgetRow {
  return { ...P.budgetRow(scope, month, amount, position, NOW), ...extra };
}
/** 3 個預算：總（預設＋本月覆寫）、主分類食物、子分類午餐 */
const BUDGETS: BudgetRow[] = [
  bud({ kind: "total" }, null, 5000000, 0),
  bud({ kind: "total" }, "2026-10", 300000, 1),
  bud({ kind: "category", categoryId: "c-food" }, null, 200000, 2),
  bud({ kind: "category", categoryId: "c-lunch" }, null, 100000, 3),
];

function rep(id: string, rule: any, p: Partial<RepeatRow> = {}): RepeatRow {
  const row = P.buildRepeatRow(
    { kind: "expense", accountId: "a-cash", toAccountId: null, categoryId: "c-lunch", amountMinor: 8000, currency: "TWD", note: "", routeId: null, rule, hhmm: "09:00" },
    CTX,
    { id, position: 0, nowIso: NOW },
  );
  return { ...row, ...p };
}

/** 本地 uuid v5（RFC 4122）：拿 node crypto 實算，和 domain 自帶的 SHA-1 對帳 */
function v5(ns: string, name: string): string {
  const nsBytes = Buffer.from(ns.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const throwsMsg = (fn: () => unknown, msg: string) =>
  assert.throws(fn, (e: unknown) => e instanceof RangeError && e.message === msg, `應丟「${msg}」`);

/* ═════════════════════════ A. id ═════════════════════════ */

describe("A. id", () => {
  test("1. budgetId 四種 name 逐字（node crypto 實算）、兩次相同", () => {
    const ns = T.TICKET_ID_NAMESPACE;
    assert.equal(P.budgetId({ kind: "total" }, null), v5(ns, "budget:total:default"));
    assert.equal(P.budgetId({ kind: "total" }, "2026-01"), v5(ns, "budget:total:2026-01"));
    assert.equal(P.budgetId({ kind: "category", categoryId: "c-food" }, null), v5(ns, "budget:cat:c-food:default"));
    assert.equal(P.budgetId({ kind: "category", categoryId: "c-food" }, "2026-01"), v5(ns, "budget:cat:c-food:2026-01"));
    assert.equal(P.budgetId({ kind: "total" }, null), P.budgetId({ kind: "total" }, null));
    assert.equal(P.scopeKey({ kind: "category", categoryId: "x" }), "cat:x");
  });
  test("2. materializeId：同 repeatId 同 day 相同、換 day 不同", () => {
    assert.equal(P.materializeId("r1", "2026-10-01"), P.materializeId("r1", "2026-10-01"));
    assert.notEqual(P.materializeId("r1", "2026-10-01"), P.materializeId("r1", "2026-10-02"));
    assert.equal(P.materializeId("r1", "2026-10-01"), v5(T.TICKET_ID_NAMESPACE, "repeat:r1:2026-10-01"));
  });
});

/* ═════════════════════════ B. 預算 ═════════════════════════ */

describe("B. 預算", () => {
  test("3. effectiveBudget：覆寫勝預設、只有覆寫、都沒有", () => {
    const e = P.effectiveBudget(BUDGETS, { kind: "total" }, "2026-10");
    assert.equal(e?.row.amount_minor, 300000);
    assert.equal(e?.override, true);
    assert.equal(P.effectiveBudget(BUDGETS, { kind: "total" }, "2026-09")?.row.amount_minor, 5000000);
    assert.equal(P.effectiveBudget(BUDGETS, { kind: "total" }, "2026-09")?.override, false);
    const onlyOver = [bud({ kind: "category", categoryId: "c-bus" }, "2026-10", 7000, 0)];
    assert.equal(P.effectiveBudget(onlyOver, { kind: "category", categoryId: "c-bus" }, "2026-10")?.row.amount_minor, 7000);
    assert.equal(P.effectiveBudget(onlyOver, { kind: "category", categoryId: "c-bus" }, "2026-11"), null);
    assert.equal(P.effectiveBudget([], { kind: "total" }, "2026-10"), null);
    const deleted = [bud({ kind: "total" }, null, 100, 0, { deleted_at: NOW })];
    assert.equal(P.effectiveBudget(deleted, { kind: "total" }, "2026-10"), null);
  });
  test("4. budgetUsed(total) ≡ statsOverview(…).expense（三個月）", () => {
    for (const m of ["2026-09", "2026-10", "2026-11"]) {
      assert.equal(P.budgetUsed(ENTRIES, { kind: "total" }, m, CATS), V.statsOverview(ENTRIES, T.monthRange(m)).expense, m);
    }
  });
  test("5. 主分類＝自己＋子（含封存子）、子只算自己、退款抵回、轉帳校正不入、USD 用 main_minor", () => {
    const sum = (ids: string[], m: string) =>
      ENTRIES.filter((e) => e.deleted_at === null && e.kind === "expense" && e.occurred_on.slice(0, 7) === m && ids.indexOf(e.category_id as string) >= 0).reduce(
        (s, e) => s + e.main_minor,
        0,
      );
    assert.equal(P.budgetUsed(ENTRIES, { kind: "category", categoryId: "c-food" }, "2026-10", CATS), sum(["c-food", "c-lunch", "c-snack"], "2026-10"));
    assert.equal(P.budgetUsed(ENTRIES, { kind: "category", categoryId: "c-lunch" }, "2026-10", CATS), sum(["c-lunch"], "2026-10"));
    const refundOnly = [ent({ occurred_on: "2026-10-03", amount_minor: -5000, category_id: "c-lunch" })];
    assert.equal(P.budgetUsed(refundOnly, { kind: "category", categoryId: "c-lunch" }, "2026-10", CATS), -5000, "淨退款可負");
    const usdOnly = ENTRIES.filter((e) => e.currency === "USD");
    assert.equal(P.budgetUsed(usdOnly, { kind: "category", categoryId: "c-snack" }, "2026-10", CATS), 31500);
    const tx = ENTRIES.filter((e) => e.kind === "transfer" || e.kind === "adjust");
    assert.equal(P.budgetUsed(tx, { kind: "total" }, "2026-10", CATS), 0);
  });
  test("6. monthPace：過去 1、未來 0、10/19 ⇒ 19/31、2/28 閏年", () => {
    assert.equal(P.monthPace("2026-09", TODAY), 1);
    assert.equal(P.monthPace("2026-11", TODAY), 0);
    assert.equal(P.monthPace("2026-10", TODAY), 19 / 31);
    assert.equal(P.monthPace("2028-02", "2028-02-28"), 28 / 29);
    assert.equal(P.monthPace("2027-02", "2027-02-28"), 1);
  });
  test("7. budgetLines：順序（總第一）、over 只在 >、gone／archived、share > 1", () => {
    const es = ENTRIES.concat([ent({ occurred_on: "2026-10-18", amount_minor: 500000, category_id: "c-lunch" })]);
    const budgets = [
      bud({ kind: "category", categoryId: "c-snack" }, null, 1000, 0),
      bud({ kind: "category", categoryId: "c-gone" }, null, 1000, 1),
      bud({ kind: "total" }, null, P.budgetUsed(es, { kind: "total" }, "2026-10", CATS), 5),
      bud({ kind: "category", categoryId: "c-lunch" }, null, 1, 2),
    ];
    const lines = P.budgetLines(budgets, es, "2026-10", CATS, TODAY, CTX);
    assert.deepEqual(
      lines.map((l) => l.key),
      ["total", "cat:c-snack", "cat:c-gone", "cat:c-lunch"],
    );
    assert.equal(lines[0].over, false, "剛好等於不算超支");
    assert.equal(lines[0].remaining, 0);
    assert.equal(lines[0].label, "總預算");
    assert.equal(lines[1].archived, true);
    assert.equal(lines[1].label, "🍜 食物 › 點心");
    assert.equal(lines[2].gone, true);
    assert.equal(lines[2].label, "（分類已刪除）");
    assert.equal(lines[3].over, true);
    assert.ok(lines[3].share > 1);
    assert.equal(lines[3].pace, 19 / 31);
    assert.equal(lines[3].override, false);
    const withOverride = P.budgetLines(BUDGETS, ENTRIES, "2026-10", CATS, TODAY, CTX);
    assert.equal(withOverride[0].override, true);
    assert.equal(withOverride[0].budget, 300000);
  });
  test("8. overBudgetDay：同日合計後比、剛好等於不算、沒超 null、退款讓累計回落再超 ⇒ 標最後一次越過（O1 後改）", () => {
    const es = [
      ent({ occurred_on: "2026-10-01", amount_minor: 20000 }),
      ent({ occurred_on: "2026-10-01", amount_minor: -15000 }),
      ent({ occurred_on: "2026-10-02", amount_minor: 10000 }),
      ent({ occurred_on: "2026-10-04", amount_minor: -8000 }),
      ent({ occurred_on: "2026-10-05", amount_minor: 10000 }),
      ent({ occurred_on: "2026-10-06", kind: "income", amount_minor: 999999, category_id: "c-salary" }),
    ];
    assert.equal(P.overBudgetDay(es, "2026-10", 10000), "2026-10-05", "10/1 同日合計 50 不超；10/2 累計 150 越過；10/4 退款回落 70；10/5 170 再越過 ⇒ 標 10/5");
    assert.equal(P.overBudgetDay(es, "2026-10", 15000), "2026-10-05", "10/2 剛好 150 不算；10/4 退款回落 70、10/5 170 再超");
    assert.equal(P.overBudgetDay(es, "2026-10", 50000), null);
    assert.equal(P.overBudgetDay(es, "2026-10", null), null);
    assert.equal(P.overBudgetDay(es, "2026-10", 0), null);
    assert.equal(P.overBudgetDay(es, "2026-09", 1), null);
  });
  test("9. budgetText 三種", () => {
    const base = P.budgetLines([bud({ kind: "total" }, null, 1500000, 0)], [ent({ occurred_on: "2026-10-02", amount_minor: 1234000 })], "2026-10", CATS, TODAY, CTX)[0];
    assert.deepEqual(P.budgetText(base, 2), { used: "12,340", budget: "15,000", rest: "剩 2,660" });
    const over = P.budgetLines([bud({ kind: "total" }, null, 1500000, 0)], [ent({ occurred_on: "2026-10-02", amount_minor: 1620000 })], "2026-10", CATS, TODAY, CTX)[0];
    assert.deepEqual(P.budgetText(over, 2), { used: "16,200", budget: "15,000", rest: "超支 1,200" });
    const exact = P.budgetLines([bud({ kind: "total" }, null, 1500000, 0)], [ent({ occurred_on: "2026-10-02", amount_minor: 1500000 })], "2026-10", CATS, TODAY, CTX)[0];
    assert.equal(P.budgetText(exact, 2).rest, "剩 0");
  });
});

/* ═════════════════════════ C. 規則 ═════════════════════════ */

const monthly = (start: string, days: number[]) => fixedRule("monthly", start, { bymonthday: days });

function draft(p: Partial<any> = {}): any {
  return {
    kind: "expense",
    amountText: "120",
    currency: "TWD",
    accountId: "a-cash",
    toAccountId: null,
    categoryId: "c-lunch",
    note: "",
    routeId: null,
    freq: "monthly",
    byweekday: [],
    bymonthday: [1],
    start: "2026-11-01",
    interval: 1,
    until: null,
    count: null,
    hhmm: "09:00",
    fromEntryId: null,
    ...p,
  };
}

describe("C. 規則", () => {
  test("10. parseFixedRule：拒 after 模式、壞 JSON", () => {
    assert.equal(P.parseFixedRule(serializeRule(afterRule(3, "2026-10-01"))), null);
    assert.equal(P.parseFixedRule("{oops"), null);
    assert.equal(P.parseFixedRule(""), null);
    assert.equal(P.parseFixedRule(serializeRule(monthly("2026-10-01", [1])))?.freq, "monthly");
  });
  test("11. ruleFromEntry：10/31 的帳 ⇒ bymonthday [31]、start 11/01", () => {
    const r = P.ruleFromEntry({ occurred_on: "2026-10-31" });
    assert.deepEqual(r.bymonthday, [31]);
    assert.equal(r.start, "2026-11-01");
    assert.equal(r.freq, "monthly");
  });
  test("12. draftToRepeatInput 錯誤表逐字（五條）＋沿用 validate", () => {
    throwsMsg(() => P.draftToRepeatInput(draft({ freq: "weekly", byweekday: [] }), CTX), "每週至少選一天");
    throwsMsg(() => P.draftToRepeatInput(draft({ freq: "monthly", bymonthday: [] }), CTX), "每月至少選一天");
    throwsMsg(() => P.draftToRepeatInput(draft({ start: "11/1" }), CTX), "開始日期格式有誤");
    throwsMsg(() => P.draftToRepeatInput(draft({ until: "2026-10-01" }), CTX), "結束日期要在開始日期之後");
    throwsMsg(() => P.draftToRepeatInput(draft({ hhmm: "25:00" }), CTX), "時刻看不懂");
    throwsMsg(() => P.draftToRepeatInput(draft({ accountId: "a-gone" }), CTX), "這個帳戶已經刪除了");
    throwsMsg(() => P.draftToRepeatInput(draft({ categoryId: "c-salary" }), CTX), "這個分類不屬於目前的收支類型");
    throwsMsg(() => P.draftToRepeatInput(draft({ amountText: "" }), CTX), "先填金額");
    const ok = P.draftToRepeatInput(draft({ bymonthday: [15, 1, 15] }), CTX);
    assert.deepEqual(ok.rule.bymonthday, [1, 15]);
    assert.equal(ok.amountMinor, 12000);
    // 往返：draftFromRepeat → draftToRepeatInput 規則字串不變
    const row = P.buildRepeatRow(ok, CTX, { id: "r-x", position: 0, nowIso: NOW });
    assert.equal(serializeRule(P.draftToRepeatInput(P.draftFromRepeat(row, CTX), CTX).rule), row.rule);
  });
  test("13. repeatLabel 四種（支出子分類、收入主分類、轉帳、USD）", () => {
    const ex = rep("r1", monthly("2026-10-01", [1]), { category_id: "c-rent", amount_minor: 1200000, note: "房租" });
    assert.equal(P.repeatLabel(ex, CTX), "每月 1 號 · 房租 · −12,000 · 現金");
    const inc = rep("r2", monthly("2026-10-01", [20]), { kind: "income", category_id: "c-salary", amount_minor: 600000, account_id: "a-bank" });
    assert.equal(P.repeatLabel(inc, CTX), "每月 20 號 · 💳 薪水 · ＋6,000 · 帳戶");
    const tr = rep("r3", fixedRule("weekly", "2026-10-01", { byweekday: [1, 3, 5] }), {
      kind: "transfer", category_id: null, account_id: "a-bank", to_account_id: "a-easy", amount_minor: 100000,
    });
    assert.equal(P.repeatLabel(tr, CTX), "每週一・三・五 · 帳戶 → 悠遊卡 · ⇄1,000");
    const usd = rep("r4", monthly("2026-10-01", [16]), { currency: "USD", amount_minor: 1000, category_id: "c-snack" });
    assert.equal(P.repeatLabel(usd, CTX), "每月 16 號 · 點心 · −10 USD · 現金");
    const gone = rep("r5", fixedRule("daily", "2026-10-01"), { account_id: "a-gone", category_id: "c-nope" });
    assert.equal(P.repeatLabel(gone, CTX), "每天重複 · （分類已刪除） · −80 · （帳戶已刪除）");
  });
  test("14. nextOnText／repeatStatus", () => {
    const r = rep("r1", monthly("2026-10-01", [1]), { next_on: "2026-11-01" });
    assert.equal(P.nextOnText(r), "下一班 11/1");
    assert.equal(P.nextOnText({ ...r, paused_at: NOW }), "已暫停");
    assert.equal(P.nextOnText({ ...r, next_on: null }), "已結束");
    assert.equal(P.repeatStatus(r, TODAY, {}), "active");
    assert.equal(P.repeatStatus({ ...r, paused_at: NOW }, TODAY, { r1: "x" }), "paused");
    assert.equal(P.repeatStatus(r, TODAY, { r1: "這個帳戶已經刪除了" }), "blocked");
    assert.equal(P.repeatStatus({ ...r, next_on: null }, TODAY, {}), "ended");
  });
});

/* ═════════════════════════ D. 實體化 ═════════════════════════ */

const daysOf = (inserts: EntryRow[]) => inserts.map((e) => e.occurred_on);
const none = new Set<string>();

describe("D. 實體化（planMaterialize；today＝2026-10-19）", () => {
  test("15. 每日規則 next_on 三天前 ⇒ 4 筆（三天前到今天）、游標推到明天", () => {
    const r = rep("rd", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-16" });
    const p = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH);
    assert.deepEqual(daysOf(p.inserts), ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    assert.deepEqual(p.cursors, [{ id: "rd", next_on: "2026-10-20" }]);
    assert.deepEqual(p.blocked, []);
  });
  test("16. 每月 31 日在 2 月 ⇒ 2/28、3 月 ⇒ 3/31", () => {
    const r = rep("r31", monthly("2027-01-01", [31]), { next_on: "2027-02-01" });
    const p = P.planMaterialize([r], none, "2027-03-31", CTX, NOW, DSH);
    assert.deepEqual(daysOf(p.inserts), ["2027-02-28", "2027-03-31"]);
    assert.deepEqual(p.cursors, [{ id: "r31", next_on: "2027-04-30" }]);
  });
  test("17. existingIds 含其中一天（墓碑）⇒ 跳過那天、其餘照記、游標照推", () => {
    const r = rep("rd", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-16" });
    const p = P.planMaterialize([r], new Set([P.materializeId("rd", "2026-10-17")]), TODAY, CTX, NOW, DSH);
    assert.deepEqual(daysOf(p.inserts), ["2026-10-16", "2026-10-18", "2026-10-19"]);
    assert.deepEqual(p.cursors, [{ id: "rd", next_on: "2026-10-20" }]);
  });
  test("18. skipped_days 含一天 ⇒ 跳過、reconcileIds 含它", () => {
    const r = rep("rd", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-16", skipped_days: '["2026-10-18"]' });
    const p = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH);
    assert.deepEqual(daysOf(p.inserts), ["2026-10-16", "2026-10-17", "2026-10-19"]);
    assert.deepEqual(p.reconcileIds, [P.materializeId("rd", "2026-10-18")]);
  });
  test("19. 暫停 ⇒ 0 筆、游標不動、但 reconcileIds 照給", () => {
    const r = rep("rd", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-16", paused_at: NOW, skipped_days: '["2026-10-02"]' });
    const p = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH);
    assert.deepEqual(p.inserts, []);
    assert.deepEqual(p.cursors, []);
    assert.deepEqual(p.reconcileIds, [P.materializeId("rd", "2026-10-02")]);
  });
  test("20. next_on 比 start 早（回退）⇒ 不重複（靠 existingIds）、游標照推", () => {
    const r = rep("rd", fixedRule("daily", "2026-10-10"), { next_on: "2026-10-05" });
    const had = new Set<string>();
    for (let d = 10; d <= 17; d++) had.add(P.materializeId("rd", `2026-10-${d}`));
    const p = P.planMaterialize([r], had, TODAY, CTX, NOW, DSH);
    assert.deepEqual(daysOf(p.inserts), ["2026-10-18", "2026-10-19"]);
    assert.deepEqual(p.cursors, [{ id: "rd", next_on: "2026-10-20" }]);
  });
  test("21. start 在未來 ⇒ 0 筆、游標＝start 那天或之後第一班", () => {
    const r = rep("rf", fixedRule("daily", "2026-10-25"), { next_on: null });
    const p = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH);
    assert.deepEqual(p.inserts, []);
    assert.deepEqual(p.cursors, [{ id: "rf", next_on: "2026-10-25" }]);
    const w = rep("rw", fixedRule("weekly", "2026-10-25", { byweekday: [3] }), { next_on: null }); // 10/25 是週日 ⇒ 第一班 10/28（三）
    assert.deepEqual(P.planMaterialize([w], none, TODAY, CTX, NOW, DSH).cursors, [{ id: "rw", next_on: "2026-10-28" }]);
    // buildRepeatRow 給的 next_on 本來就是它 ⇒ 不出游標（不寫空 op）
    const born = rep("rb", fixedRule("daily", "2026-10-25"));
    assert.equal(born.next_on, "2026-10-25");
    assert.deepEqual(P.planMaterialize([born], none, TODAY, CTX, NOW, DSH).cursors, []);
  });
  test("22. 指到已刪帳戶 ⇒ blocked、原因＝validate 的訊息、游標不動", () => {
    const r = rep("rg", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-18", account_id: "a-gone" });
    const ok = rep("rd", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-19" });
    const p = P.planMaterialize([r, ok], none, TODAY, CTX, NOW, DSH);
    assert.deepEqual(p.blocked, [{ id: "rg", reason: "這個帳戶已經刪除了" }]);
    assert.deepEqual(daysOf(p.inserts), ["2026-10-19"], "別條照記");
    assert.deepEqual(p.cursors, [{ id: "rd", next_on: "2026-10-20" }]);
    const badRule = rep("rx", fixedRule("daily", "2026-10-01"), { rule: "{bad" });
    assert.deepEqual(P.planMaterialize([badRule], none, TODAY, CTX, NOW, DSH).blocked, [{ id: "rx", reason: "重複規則有誤" }]);
  });
  test("23. until 過了 ⇒ next_on null", () => {
    const rule = fixedRule("daily", "2026-10-01");
    rule.until = "2026-10-10";
    const r = rep("ru", rule, { next_on: "2026-10-08" });
    const p = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH);
    assert.deepEqual(daysOf(p.inserts), ["2026-10-08", "2026-10-09", "2026-10-10"]);
    assert.deepEqual(p.cursors, [{ id: "ru", next_on: null }]);
  });
  test("24. 401 班 ⇒ 400 筆、游標停在第 400 班之後的下一班", () => {
    const from = V.dayStep(TODAY, -400);
    const r = rep("rl", fixedRule("daily", from), { next_on: from });
    const p = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH);
    assert.equal(p.inserts.length, P.REPEAT_SCAN_MAX);
    assert.equal(p.inserts[p.inserts.length - 1].occurred_on, V.dayStep(TODAY, -1));
    assert.deepEqual(p.cursors, [{ id: "rl", next_on: TODAY }]);
    // 下一輪續掃
    const p2 = P.planMaterialize([{ ...r, next_on: TODAY }], none, TODAY, CTX, NOW, DSH);
    assert.deepEqual(daysOf(p2.inserts), [TODAY]);
  });
  test("25. 封存帳戶照記", () => {
    const r = rep("ra", fixedRule("daily", "2026-10-01"), { next_on: TODAY, account_id: "a-arch", category_id: "c-old" });
    const p = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH);
    assert.equal(p.inserts.length, 1);
    assert.equal(p.inserts[0].account_id, "a-arch");
  });
  test("26. 手建規則 occurred_at＝atOf(day, hhmm, dayStartHour)（✎-7 改）、repeat_id、import_* null、id＝materializeId", () => {
    const r = rep("rd", fixedRule("daily", "2026-10-01"), { next_on: TODAY, hhmm: "02:30" });
    const [e] = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH).inserts;
    assert.equal(e.occurred_at, atOf(TODAY, "02:30", DSH));
    assert.equal(e.occurred_at, new Date(2026, 9, 20, 2, 30).toISOString(), "套日界線：帳日 10/19 的 02:30（日界線 6 點）＝日曆 10/20 02:30");
    assert.equal(e.occurred_on, TODAY);
    // 日界線 0 ⇒ 字面時刻；hhmm 在日界線之後 ⇒ 兩種一樣
    assert.equal(P.planMaterialize([r], none, TODAY, CTX, NOW, 0).inserts[0].occurred_at, new Date(2026, 9, 19, 2, 30).toISOString());
    const late = rep("rl", fixedRule("daily", "2026-10-01"), { next_on: TODAY, hhmm: "09:00" });
    assert.equal(P.planMaterialize([late], none, TODAY, CTX, NOW, DSH).inserts[0].occurred_at, new Date(2026, 9, 19, 9, 0).toISOString());
    assert.equal(e.repeat_id, "rd");
    assert.equal(e.id, P.materializeId("rd", TODAY));
    assert.deepEqual([e.import_id, e.import_source, e.import_utime], [null, null, null]);
    assert.equal(e.main_minor, 8000);
  });
  test("26b. 匯入的規則（import_source＝moneymanager）⇒ 字面時刻、不套日界線（和①匯入財務管家的帳一致，✎-7 改）", () => {
    const mm = rep("rm", fixedRule("daily", "2026-10-01"), { next_on: TODAY, hhmm: "02:30", import_source: "moneymanager", import_id: "mm-r1", import_utime: 1 });
    const hand = rep("rh", fixedRule("daily", "2026-10-01"), { next_on: TODAY, hhmm: "02:30" });
    const p = P.planMaterialize([mm, hand], none, TODAY, CTX, NOW, DSH);
    const byRep = (id: string) => p.inserts.find((x) => x.repeat_id === id)!;
    assert.equal(byRep("rm").occurred_at, new Date(2026, 9, 19, 2, 30).toISOString(), "匯入規則：10/19 02:30（字面）");
    assert.equal(byRep("rh").occurred_at, new Date(2026, 9, 20, 2, 30).toISOString(), "手建規則：同一個 hhmm 套日界線");
    assert.deepEqual([byRep("rm").occurred_on, byRep("rh").occurred_on], [TODAY, TODAY], "班次日都不變");
    assert.equal(P.repeatDayStart({ import_source: "moneymanager" }, DSH), 0);
    assert.equal(P.repeatDayStart({ import_source: null }, DSH), DSH);
  });
  test("27. 決定性：規則順序打亂 10 次 ⇒ deepEqual", () => {
    const rules = [
      rep("r1", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-12" }),
      rep("r2", fixedRule("weekly", "2026-09-01", { byweekday: [1, 3, 5] }), { next_on: "2026-10-01" }),
      rep("r3", monthly("2026-08-01", [1]), { next_on: "2026-09-01" }),
      rep("r4", monthly("2026-08-01", [31]), { next_on: "2026-08-31" }),
      rep("r5", fixedRule("daily", "2026-10-01"), { paused_at: NOW }),
      rep("r6", fixedRule("daily", "2026-10-01"), { account_id: "a-gone" }),
    ];
    const norm = (p: any) => ({
      inserts: p.inserts.slice().sort((a: EntryRow, b: EntryRow) => (a.id < b.id ? -1 : 1)),
      cursors: p.cursors.slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1)),
      blocked: p.blocked.slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1)),
      reconcileIds: p.reconcileIds.slice().sort(),
    });
    const base = norm(P.planMaterialize(rules, none, TODAY, CTX, NOW, DSH));
    let s = 7;
    for (let i = 0; i < 10; i++) {
      const shuffled = rules.slice().sort(() => ((s = (s * 48271) % 2147483647) % 3) - 1);
      assert.deepEqual(norm(P.planMaterialize(shuffled, none, TODAY, CTX, NOW, DSH)), base);
    }
  });
});

/* ═════════════════════════ E. skipped ═════════════════════════ */

describe("E. skipped", () => {
  test("28. withSkipped 加／減／去重／升冪、壞 JSON 當空", () => {
    assert.equal(P.withSkipped("[]", "2026-10-02", true), '["2026-10-02"]');
    assert.equal(P.withSkipped('["2026-10-05"]', "2026-10-02", true), '["2026-10-02","2026-10-05"]');
    assert.equal(P.withSkipped('["2026-10-02","2026-10-05"]', "2026-10-02", true), '["2026-10-02","2026-10-05"]');
    assert.equal(P.withSkipped('["2026-10-02","2026-10-05"]', "2026-10-02", false), '["2026-10-05"]');
    assert.equal(P.withSkipped("{bad", "2026-10-02", true), '["2026-10-02"]');
    assert.deepEqual(P.parseSkipped('["2026-10-09", 3, "x", "2026-10-01", "2026-10-09"]'), ["2026-10-01", "2026-10-09"]);
  });
});

/* ═════════════════════════ F. 匯入 ═════════════════════════ */

describe("F. 開始（resumeNextOn；匯入已拿掉，早期匯入的規則照舊）", () => {
  test("35b. 早期匯入、從沒開始過 ⇒ next_on 不變（已過也保持，實體化照常補記到今天）；開始過或手建 ⇒ 明天起", () => {
    const mm = { import_source: "moneymanager", import_id: "mm-r1", import_utime: 1 };
    const imp = rep("ri", fixedRule("daily", "2026-10-01"), { ...mm, paused_at: NOW, next_on: "2026-11-03" });
    assert.equal(P.neverStarted(imp, []), true);
    assert.equal(P.resumeNextOn(imp, [], TODAY), "2026-11-03");
    const pastImp = rep("rp", fixedRule("daily", "2026-10-01"), { ...mm, import_id: "mm-r3", paused_at: NOW, next_on: "2026-10-16" });
    assert.equal(P.resumeNextOn(pastImp, [], TODAY), "2026-10-16", "NEXT_DATE 已過也保持——實體化照常補記到今天");
    const manual = rep("rm", fixedRule("daily", "2026-10-01"), { paused_at: NOW, next_on: "2026-10-03" });
    assert.equal(P.neverStarted(manual, []), false);
    assert.equal(P.resumeNextOn(manual, [], TODAY), "2026-10-20");
    assert.equal(P.neverStarted(imp, [{ repeat_id: imp.id }]), false, "有帳（含墓碑）指向它＝開始過");
    assert.equal(P.resumeNextOn(imp, [{ repeat_id: imp.id }], TODAY), nextFixedDate(P.parseFixedRule(imp.rule)!, TODAY));
  });
});

/* ═════════════════════════ G. repository 對帳 ═════════════════════════ */

/**
 * node:sqlite 記憶體 DB＋plugin-sql 形狀的轉接（照 ticket-logic.test.ts 的 makeSqliteDb）：套**真的** 0007＋0010 DDL、開外鍵；
 * `runBatch`＝一個交易逐句執行＋把 op 收進陣列（測試看得到 op 的 cols）。
 */
interface TestDb {
  ops: { tbl: string; row_id: string; op: string; cols: Record<string, unknown> }[];
  batches: number; // runBatch 被叫了幾次（＝幾個 WriteBatch）
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<void>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: TestDb["ops"]): void;
}
function makeSqliteDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON"); // sqlx 預設開
  raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations/0007_ticket_ledger.sql"), "utf8"));
  raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations/0010_ticket_plan.sql"), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const db: TestDb = {
    ops: [],
    batches: 0,
    async select(sql, args) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql, args) {
      raw.prepare(sql).run(bind(args));
    },
    runBatch(stmts, ops) {
      db.batches++;
      raw.exec("BEGIN");
      try {
        for (const s of stmts) raw.prepare(s.sql).run(bind(s.args));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
      db.ops.push(...ops);
    },
  };
  return db;
}

/** ticket.rs 的白名單欄（新列的 op 完整列要與它逐欄相同） */
function rustCols(name: string): string[] {
  const src = readFileSync(path.join(ROOT, "src-tauri/src/sync/tables/ticket.rs"), "utf8");
  const m = new RegExp(`const ${name}: &\\[\\(&str, bool\\)\\] = &\\[([\\s\\S]*?)\\];`).exec(src);
  assert.ok(m, `ticket.rs 找不到 ${name}`);
  return Array.from(m[1].matchAll(/\("(\w+)",/g), (x) => x[1]);
}

type Impl = { name: "memory" | "sqlite"; make: () => Promise<{ repo: any; db: TestDb | null }> };
const IMPLS: Impl[] = [
  { name: "memory", make: async () => ({ repo: new M.MemoryTicketRepository({ seedDemo: false }), db: null }) },
  {
    name: "sqlite",
    make: async () => {
      const db = makeSqliteDb();
      (globalThis as { __tkDb?: TestDb }).__tkDb = db;
      return { repo: new S.SqliteTicketRepository(), db };
    },
  },
];

async function setup(impl: Impl): Promise<{ repo: any; db: TestDb | null; acc: AccountRow; lunch: CategoryRow; food: CategoryRow }> {
  const { repo, db } = await impl.make();
  await repo.ensureStarterRows();
  const a = await repo.createAccount({ name: "現金", group: "cash", currency: "TWD", openingMinor: null, occurredOn: TODAY });
  const food = await repo.createCategory({ kind: "expense", name: "🍜 食物", parentId: null });
  const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });
  return { repo, db, acc: a, lunch, food };
}
const dailyInput = (accountId: string, categoryId: string, start: string): any => ({
  kind: "expense", accountId, toAccountId: null, categoryId, amountMinor: 8000, currency: "TWD", note: "早餐", routeId: null,
  rule: fixedRule("daily", start), hhmm: "09:00",
});
/** 含墓碑的整張表（測試直讀：memory 讀內部 Map、sqlite 直接 SELECT；repo 沒有「讀含墓碑全表」的公開介面） */
async function allRows<Row>(repo: any, table: "tk_entries" | "tk_budgets" | "tk_repeats"): Promise<Row[]> {
  if (repo instanceof M.MemoryTicketRepository) {
    const key = { tk_entries: "ent", tk_budgets: "bud", tk_repeats: "rep" }[table];
    return Array.from((repo as unknown as Record<string, Map<string, Row>>)[key].values()).map((x) => ({ ...x }));
  }
  const db = (globalThis as { __tkDb?: TestDb }).__tkDb!;
  return (await db.select(`SELECT * FROM ${table}`)) as unknown as Row[];
}
/** 沒存活的帳也讀得到（含墓碑） */
async function entryAny(repo: any, id: string): Promise<EntryRow | undefined> {
  return (await allRows<EntryRow>(repo, "tk_entries")).find((e) => e.id === id);
}
const opsOf = (db: TestDb | null, from: number) => (db ? db.ops.slice(from) : []);

describe("G. repository 對帳（memory／sqlite 兩個實作；sqlite 跑 node:sqlite＋0007＋0010 真 DDL）", () => {
  for (const impl of IMPLS) {
    test(`38. setBudget 兩次同 scope 同 month ⇒ 一列、金額＝後者；removeBudget(預設) ⇒ 該對象所有覆寫一起軟刪（${impl.name}）`, async () => {
      const { repo, db, food } = await setup(impl);
      const tid = P.budgetId({ kind: "total" }, null);
      const mark = db ? db.ops.length : 0;
      const b1 = await repo.setBudget({ kind: "total" }, null, 100000);
      const b2 = await repo.setBudget({ kind: "total" }, null, 150000);
      assert.equal(b1.id, tid);
      assert.equal(b2.amount_minor, 150000);
      assert.equal(b2.position, b1.position, "重設同一個預算 position 不動");
      await repo.setBudget({ kind: "total" }, "2026-10", 90000);
      await repo.setBudget({ kind: "category", categoryId: food.id }, null, 50000);
      let list: BudgetRow[] = await repo.listBudgets();
      assert.equal(list.length, 3);
      assert.equal(list.filter((b) => b.kind === "total" && b.month === null).length, 1);
      assert.equal(list.find((b) => b.kind === "total" && b.month === null)!.amount_minor, 150000);
      assert.deepEqual(
        list.map((b) => [b.kind, b.month]),
        [["total", null], ["total", "2026-10"], ["category", null]],
        "position 照建立順序",
      );
      if (db) {
        const ups = opsOf(db, mark).filter((o) => o.row_id === tid);
        assert.deepEqual(ups.map((o) => o.op), ["upsert", "upsert"], "op 兩筆 upsert");
        assert.deepEqual(Object.keys(ups[0].cols), rustCols("TK_BUDGETS_COLS"), "完整列＝ticket.rs 白名單");
        assert.deepEqual([ups[0].cols.amount_minor, ups[1].cols.amount_minor], [100000, 150000]);
        assert.deepEqual([ups[1].cols.position, ups[1].cols.created_at], [ups[0].cols.position, ups[0].cols.created_at], "op 的完整列＝本機那一列（不送新的 position／created_at）");
        assert.equal(ups[1].cols.deleted_at, null);
        const rows = await db.select(`SELECT COUNT(*) AS n FROM tk_budgets WHERE id = $1`, [tid]);
        assert.equal(rows[0].n, 1);
      }
      await assert.rejects(repo.setBudget({ kind: "category", categoryId: UNCAT_EXPENSE_ID }, null, 100), /「未分類」不能設預算/);
      await assert.rejects(repo.setBudget({ kind: "category", categoryId: "c-nope" }, null, 100), /這個分類已經刪除了/);
      await assert.rejects(repo.setBudget({ kind: "total" }, null, 0), /預算要是大於 0 的金額/);
      await assert.rejects(repo.setBudget({ kind: "total" }, null, 1.5), /預算要是大於 0 的金額/);
      const before = db ? db.ops.length : 0;
      await repo.removeBudget({ kind: "total" }, null);
      list = await repo.listBudgets();
      assert.deepEqual(list.map((b) => b.kind), ["category"]);
      if (db) {
        const dels = opsOf(db, before);
        assert.deepEqual(dels.map((o) => o.op), ["delete", "delete"], "預設＋那個覆寫各一個 delete op（同一批）");
        assert.deepEqual(Object.keys(dels[0].cols), ["deleted_at", "updated_at"]);
      }
      // 移除單月覆寫只動那一列
      await repo.setBudget({ kind: "category", categoryId: food.id }, "2026-11", 30000);
      await repo.removeBudget({ kind: "category", categoryId: food.id }, "2026-11");
      assert.deepEqual((await repo.listBudgets()).map((b: BudgetRow) => b.month), [null]);
      // 重設同一個預算 ⇒ 同一列復活
      const again = await repo.setBudget({ kind: "total" }, null, 120000);
      assert.equal(again.id, tid);
      assert.equal(again.deleted_at, null);
      assert.equal((await repo.listBudgets()).find((b: BudgetRow) => b.id === tid)!.amount_minor, 120000);
    });

    test(`39. materializeRepeats 跑兩次 ⇒ 第二次 inserted 0、op 0；本機先軟刪其中一筆再跑 ⇒ 不復活、op 0（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, V.dayStep(TODAY, -3)));
      const m0 = db ? db.ops.length : 0;
      const first = await repo.materializeRepeats(TODAY, 6);
      const { rows: firstRows, ...firstCounts } = first;
      assert.deepEqual(firstCounts, { inserted: 4, reconciled: 0, blocked: [] });
      // 售票口④：多回記出來的那幾筆（store 拿它帶規則的荷札）
      assert.deepEqual(
        firstRows.map((x: { id: string; repeat_id: string }) => [x.id, x.repeat_id]).sort(),
        [-3, -2, -1, 0].map((d) => [P.materializeId(r.id, V.dayStep(TODAY, d)), r.id]).sort(),
      );
      assert.equal((await repo.listRepeats())[0].next_on, V.dayStep(TODAY, 1));
      if (db) {
        const ops = opsOf(db, m0);
        assert.equal(ops.length, 5, "4 筆帳＋1 個游標");
        const ent0 = ops.find((o) => o.tbl === "tk_entries")!;
        assert.deepEqual(Object.keys(ent0.cols), rustCols("TK_ENTRIES_COLS"), "帳的 op＝完整列");
        assert.equal(ent0.cols.repeat_id, r.id);
        const cur = ops.find((o) => o.tbl === "tk_repeats")!;
        assert.deepEqual(cur.cols, { next_on: V.dayStep(TODAY, 1), updated_at: cur.cols.updated_at });
      }
      const m1 = db ? db.ops.length : 0;
      assert.equal((await repo.materializeRepeats(TODAY, 6)).inserted, 0);
      if (db) assert.equal(db.ops.length, m1, "第二次不發任何 op（不對已存在的 id 發 op、游標沒變不寫）");
      const id = P.materializeId(r.id, V.dayStep(TODAY, -1));
      await repo.softDeleteEntry(id);
      const m2 = db ? db.ops.length : 0;
      const third = await repo.materializeRepeats(TODAY, 6);
      assert.deepEqual([third.inserted, third.reconciled], [0, 0]);
      assert.equal(await repo.getEntry(id), null);
      assert.notEqual((await entryAny(repo, id))!.deleted_at, null, "墓碑還在、沒復活");
      if (db) assert.equal(db.ops.length, m2, "墓碑不再發刪除 op");
    });

    test(`40. softDeleteEntry（repeat_id 非空）⇒ skipped_days 多那一天、restoreEntry ⇒ 少那一天；同一批（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, TODAY));
      await repo.materializeRepeats(TODAY, 6);
      const id = P.materializeId(r.id, TODAY);
      const m0 = db ? db.ops.length : 0;
      await repo.softDeleteEntry(id);
      assert.equal((await repo.listRepeats())[0].skipped_days, JSON.stringify([TODAY]));
      if (db) {
        const ops = opsOf(db, m0);
        assert.deepEqual(ops.map((o) => [o.tbl, o.op]), [["tk_entries", "delete"], ["tk_repeats", "upsert"]]);
        assert.deepEqual(Object.keys(ops[1].cols), ["skipped_days", "updated_at"]);
        assert.equal(ops[1].cols.skipped_days, JSON.stringify([TODAY]));
      }
      await repo.softDeleteEntry(id); // 已刪 ⇒ 什麼都不做
      const m1 = db ? db.ops.length : 0;
      await repo.restoreEntry(id);
      assert.equal((await repo.listRepeats())[0].skipped_days, "[]");
      assert.notEqual(await repo.getEntry(id), null);
      if (db) {
        const ops = opsOf(db, m1);
        assert.deepEqual(ops.map((o) => [o.tbl, o.op]), [["tk_entries", "upsert"], ["tk_repeats", "upsert"]]);
        assert.equal(ops[1].cols.skipped_days, "[]");
      }
      // 規則已刪 ⇒ 不動規則（只刪帳）
      await repo.softDeleteRepeat(r.id);
      const m2 = db ? db.ops.length : 0;
      await repo.softDeleteEntry(id);
      if (db) assert.deepEqual(opsOf(db, m2).map((o) => o.tbl), ["tk_entries"]);
      // 不是定期記的帳 ⇒ 不碰 tk_repeats
      const plain = await repo.createEntry({
        kind: "expense", amountMinor: 100, currency: "TWD", accountId: acc.id, toAccountId: null, categoryId: lunch.id,
        occurredOn: TODAY, occurredAt: atOf(TODAY, "12:00", 0), note: "", routeId: null,
      });
      const m3 = db ? db.ops.length : 0;
      await repo.softDeleteEntry(plain.id);
      if (db) assert.deepEqual(opsOf(db, m3).map((o) => o.tbl), ["tk_entries"]);
    });

    test(`41. reconcile：skipped_days 那天的帳被別台復活 ⇒ 再被軟刪、op 一筆 delete（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, TODAY));
      await repo.materializeRepeats(TODAY, 6);
      const id = P.materializeId(r.id, TODAY);
      await repo.softDeleteEntry(id);
      // 模擬同步把它復活（引擎「編輯勝刪除」）
      if (db) await db.execute(`UPDATE tk_entries SET deleted_at = NULL WHERE id = $1`, [id]);
      else (repo as any).ent.get(id).deleted_at = null;
      assert.notEqual(await repo.getEntry(id), null);
      const m0 = db ? db.ops.length : 0;
      const res = await repo.materializeRepeats(TODAY, 6);
      assert.deepEqual([res.reconciled, res.inserted], [1, 0]);
      assert.equal(await repo.getEntry(id), null);
      if (db) {
        const ops = opsOf(db, m0);
        assert.deepEqual(ops.map((o) => [o.tbl, o.row_id, o.op]), [["tk_entries", id, "delete"]]);
        assert.deepEqual(Object.keys(ops[0].cols), ["deleted_at", "updated_at"]);
      }
      // 已經是墓碑 ⇒ 下一輪 0、不發 op
      const m1 = db ? db.ops.length : 0;
      assert.equal((await repo.materializeRepeats(TODAY, 6)).reconciled, 0);
      if (db) assert.equal(db.ops.length, m1);
      // 暫停的規則照樣 reconcile（0-7-3 不管暫停）
      await repo.setRepeatPaused(r.id, true, TODAY);
      if (db) await db.execute(`UPDATE tk_entries SET deleted_at = NULL WHERE id = $1`, [id]);
      else (repo as any).ent.get(id).deleted_at = null;
      assert.equal((await repo.materializeRepeats(TODAY, 6)).reconciled, 1);
    });

    test(`42b. 規則的寫入：建／改（rule 變 ⇒ next_on 重算、只改模板 ⇒ 不動）／暫停開始（手建明天起）／刪復原／連帳（${impl.name}）`, async () => {
      const { repo, db, acc, lunch, food } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, V.dayStep(TODAY, -2)));
      assert.equal(r.next_on, V.dayStep(TODAY, -2));
      assert.equal(r.position, 0);
      const r2 = await repo.createRepeat(dailyInput(acc.id, lunch.id, TODAY));
      assert.equal(r2.position, 1);
      await assert.rejects(repo.createRepeat({ ...dailyInput(acc.id, lunch.id, TODAY), accountId: "nope" }), /這個帳戶已經刪除了/);
      const m0 = db ? db.ops.length : 0;
      const same = await repo.updateRepeat(r.id, { note: "早餐" }, TODAY);
      assert.equal(same.updated_at, r.updated_at, "沒變 ⇒ 不寫");
      if (db) assert.equal(db.ops.length, m0);
      const tpl = await repo.updateRepeat(r.id, { amountMinor: 9000, categoryId: food.id }, TODAY);
      assert.deepEqual([tpl.amount_minor, tpl.category_id, tpl.next_on], [9000, food.id, V.dayStep(TODAY, -2)], "只改模板 ⇒ next_on 不動");
      if (db) assert.deepEqual(Object.keys(opsOf(db, m0)[0].cols).sort(), ["amount_minor", "category_id", "updated_at"]);
      const ruled = await repo.updateRepeat(r.id, { rule: fixedRule("monthly", "2026-10-01", { bymonthday: [25] }) }, TODAY);
      assert.equal(ruled.next_on, "2026-10-25", "rule 變 ⇒ nextFixedDate(新規則, today)");
      // 暫停／開始：手建的明天往後第一班
      await repo.updateRepeat(r.id, { rule: fixedRule("daily", "2026-10-01") }, TODAY);
      await repo.setRepeatPaused(r.id, true, TODAY);
      await repo.setRepeatPaused(r.id, true, TODAY); // 已暫停 ⇒ 不動
      let got: RepeatRow = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r.id);
      assert.notEqual(got.paused_at, null);
      assert.equal((await repo.listRepeats())[1].id, r.id, "暫停的排後面");
      await repo.setRepeatPaused(r.id, false, TODAY);
      got = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r.id);
      assert.deepEqual([got.paused_at, got.next_on], [null, V.dayStep(TODAY, 1)]);
      // 刪除／復原
      await repo.softDeleteRepeat(r2.id);
      assert.deepEqual((await repo.listRepeats()).map((x: RepeatRow) => x.id), [r.id]);
      await assert.rejects(repo.updateRepeat(r2.id, { note: "x" }, TODAY), /這筆定期帳已經刪除了/);
      await assert.rejects(repo.setRepeatPaused(r2.id, true, TODAY), /這筆定期帳已經刪除了/);
      await repo.restoreRepeat(r2.id);
      assert.equal((await repo.listRepeats()).length, 2);
      // 連帳
      const e = await repo.createEntry({
        kind: "expense", amountMinor: 8000, currency: "TWD", accountId: acc.id, toAccountId: null, categoryId: lunch.id,
        occurredOn: TODAY, occurredAt: atOf(TODAY, "08:00", 0), note: "", routeId: null,
      });
      const m1 = db ? db.ops.length : 0;
      await repo.linkEntryToRepeat(e.id, r.id);
      await repo.linkEntryToRepeat(e.id, r.id); // 已經是 ⇒ 不寫
      assert.equal((await repo.getEntry(e.id)).repeat_id, r.id);
      if (db) assert.deepEqual(opsOf(db, m1).map((o) => Object.keys(o.cols).sort()), [["repeat_id", "updated_at"]]);
      await assert.rejects(repo.linkEntryToRepeat("nope", r.id), /這一筆已經刪除了/);
      await assert.rejects(repo.linkEntryToRepeat(e.id, "nope"), /這筆定期帳已經刪除了/);
    });

    test(`42c. 實體化的分批與 blocked：帳戶已刪 ⇒ blocked、游標不動、別條照記；超過 IMPORT_CHUNK 分批（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const big = await repo.createRepeat(dailyInput(acc.id, lunch.id, V.dayStep(TODAY, -(T.IMPORT_CHUNK + 9))));
      const gone = await repo.createAccount({ name: "舊悠遊卡", group: "debit", currency: "TWD", openingMinor: null, occurredOn: TODAY });
      const bad = await repo.createRepeat(dailyInput(gone.id, lunch.id, V.dayStep(TODAY, -1)));
      // 帳戶刪掉（repository 沒有刪帳戶的方法；直接動資料，模擬另一台刪了）
      if (db) await db.execute(`UPDATE tk_accounts SET deleted_at = $1 WHERE id = $2`, [NOW, gone.id]);
      else (repo as any).acc.get(gone.id).deleted_at = NOW;
      const b0 = db ? db.batches : 0;
      const res = await repo.materializeRepeats(TODAY, 6);
      if (db) assert.equal(db.batches - b0, 2, "帳每 IMPORT_CHUNK 筆一批");
      assert.equal(res.inserted, T.IMPORT_CHUNK + 10);
      assert.deepEqual(res.blocked, [{ id: bad.id, reason: "這個帳戶已經刪除了" }]);
      const rows: RepeatRow[] = await repo.listRepeats();
      assert.equal(rows.find((x) => x.id === bad.id)!.next_on, V.dayStep(TODAY, -1), "被擋 ⇒ 游標不動");
      assert.equal(rows.find((x) => x.id === big.id)!.next_on, V.dayStep(TODAY, 1));
      if (db) {
        const n = await db.select(`SELECT COUNT(*) AS n FROM tk_entries WHERE repeat_id = $1`, [big.id]);
        assert.equal(n[0].n, T.IMPORT_CHUNK + 10);
      }
    });
  }

  test("43. memory 與 sqlite 對同一組操作 ⇒ listBudgets／listRepeats／tk_entries（含墓碑）逐列相同", async () => {
    const snap: Record<string, unknown>[] = [];
    // 兩個實作的 uuid 都走 crypto.randomUUID：這一題換成每個實作從 1 數起的計數器，同一組操作就產生同一組 id（逐列比得起來）
    const realUuid = crypto.randomUUID.bind(crypto);
    try {
    for (const impl of IMPLS) {
      let k = 0;
      (crypto as { randomUUID: () => string }).randomUUID = () => `00000000-0000-4000-8000-${String(++k).padStart(12, "0")}`;
      const { repo } = await impl.make();
      const idMap: Record<string, string> = {};
      const res: unknown[] = [];
      await repo.ensureStarterRows();
      const acc0 = (await repo.createAccount({ name: "現金", group: "cash", currency: "TWD", openingMinor: null, occurredOn: TODAY })).id;
      const root = (await repo.createCategory({ kind: "expense", name: "🍜 食物", parentId: null })).id;
      const leaf = (await repo.createCategory({ kind: "expense", name: "午餐", parentId: root })).id;
      await repo.createEntry({
        kind: "expense", accountId: acc0, toAccountId: null, categoryId: leaf, amountMinor: 12000, currency: "TWD",
        note: "便當", occurredOn: V.dayStep(TODAY, -5), occurredAt: new Date(2026, 9, 14, 12, 0).toISOString(), routeId: null,
      });
      await repo.setBudget({ kind: "total" }, "2026-11", 300000);
      await repo.setBudget({ kind: "total" }, "2026-11", 310000);
      await repo.setBudget({ kind: "category", categoryId: leaf }, null, 40000);
      await repo.setBudget({ kind: "category", categoryId: root }, "2026-12", 70000);
      await repo.removeBudget({ kind: "category", categoryId: root }, null);
      const r1 = await repo.createRepeat(dailyInput(acc0, leaf, V.dayStep(TODAY, -3)));
      const r2 = await repo.createRepeat({ ...dailyInput(acc0, leaf, V.dayStep(TODAY, -10)), rule: fixedRule("weekly", V.dayStep(TODAY, -10), { byweekday: [1, 3, 5] }) });
      idMap[r1.id] = "R1";
      idMap[r2.id] = "R2";
      res.push(await repo.materializeRepeats(TODAY, 6));
      await repo.softDeleteEntry(P.materializeId(r1.id, V.dayStep(TODAY, -1)));
      await repo.softDeleteEntry(P.materializeId(r1.id, V.dayStep(TODAY, -2)));
      await repo.restoreEntry(P.materializeId(r1.id, V.dayStep(TODAY, -2)));
      await repo.setRepeatPaused(r2.id, true, TODAY);
      await repo.updateRepeat(r1.id, { amountMinor: 9000 }, TODAY);
      await repo.updateRepeat(r2.id, { note: "通勤" }, TODAY);
      await repo.setRepeatPaused(r2.id, false, TODAY);
      res.push(await repo.materializeRepeats(TODAY, 6));
      const r3 = await repo.createRepeat({ ...dailyInput(acc0, leaf, V.dayStep(TODAY, 3)), note: "刪掉的" });
      const r4 = await repo.createRepeat({ ...dailyInput(acc0, leaf, V.dayStep(TODAY, 5)), note: "刪了又復原" });
      await repo.softDeleteRepeat(r3.id);
      await repo.softDeleteRepeat(r4.id);
      await repo.restoreRepeat(r4.id);
      const plainIds = (await allRows<EntryRow>(repo, "tk_entries")).filter((e) => e.deleted_at === null && e.repeat_id === null).map((e) => e.id).sort();
      await repo.linkEntryToRepeat(plainIds[0], r1.id);
      await repo.softDeleteEntry(plainIds[0]); // 連上的帳刪掉也寫進 skipped_days（0-7-4 (iii)，無害）
      res.push(await repo.materializeRepeats(TODAY, 6));

      const nid = (id: string | null) => (id === null ? null : idMap[id] ?? id);
      const strip = (o: Record<string, unknown>) => {
        const x: Record<string, unknown> = { ...o };
        for (const k of ["created_at", "updated_at", "device_id", "synced_at"]) delete x[k];
        x.deleted_at = o.deleted_at !== null;
        if ("paused_at" in o) x.paused_at = o.paused_at !== null;
        return x;
      };
      const local = {
        entries: await allRows<EntryRow>(repo, "tk_entries"),
        budgets: await allRows<BudgetRow>(repo, "tk_budgets"),
        repeats: await allRows<RepeatRow>(repo, "tk_repeats"),
      };
      const entries = local.entries
        .map((e) => {
          const x = strip(e as unknown as Record<string, unknown>);
          if (e.repeat_id !== null && e.id === P.materializeId(e.repeat_id, e.occurred_on)) x.id = `m:${nid(e.repeat_id)}:${e.occurred_on}`;
          x.repeat_id = nid(e.repeat_id);
          return x;
        })
        .sort((p, q) => ((p.id as string) < (q.id as string) ? -1 : 1));
      snap.push({
        res,
        budgets: (await repo.listBudgets()).map(strip),
        repeats: (await repo.listRepeats()).map((r: RepeatRow) => ({ ...strip(r as unknown as Record<string, unknown>), id: nid(r.id) })),
        budgetsAll: (local.budgets as BudgetRow[]).map(strip).sort((p, q) => ((p.id as string) < (q.id as string) ? -1 : 1)),
        repeatsAll: (local.repeats as RepeatRow[]).map((r) => ({ ...strip(r as unknown as Record<string, unknown>), id: nid(r.id) })).sort((p, q) => ((p.id as string) < (q.id as string) ? -1 : 1)),
        entries,
      });
    }
    } finally {
      (crypto as { randomUUID: () => string }).randomUUID = realUuid;
    }
    const [mem, sql] = snap;
    assert.deepEqual(sql.res, mem.res, "回傳值相同");
    assert.deepEqual(sql.budgets, mem.budgets, "listBudgets 逐列（含順序）");
    assert.deepEqual(sql.repeats, mem.repeats, "listRepeats 逐列（含順序）");
    assert.deepEqual(sql.budgetsAll, mem.budgetsAll, "tk_budgets 含墓碑");
    assert.deepEqual(sql.repeatsAll, mem.repeatsAll, "tk_repeats 含墓碑");
    assert.deepEqual(sql.entries, mem.entries, "tk_entries 含墓碑");
    // 這組操作真的有走到實體化、skipped 與 reconcile
    const reps = mem.repeats as Record<string, unknown>[];
    assert.ok((mem.entries as Record<string, unknown>[]).some((e) => typeof e.id === "string" && (e.id as string).startsWith("m:R1:")));
    assert.ok(reps.some((r) => r.id === "R1" && (r.skipped_days as string).indexOf(V.dayStep(TODAY, -1)) >= 0));
  });
});

describe("G. 修正-資料（評審 findings 的回歸；R 編號對 ticket-plan-review.test.ts）", () => {
  test("G1. shiftDayOf：沒改日期 ⇒ occurred_on；改過日期 ⇒ 找回原本的班次日；連上的那筆（id 不是 repeat: 形）⇒ null；重複規則有誤 ⇒ null", () => {
    const r = rep("rs", fixedRule("daily", "2026-10-17"));
    const id17 = P.materializeId("rs", "2026-10-17");
    assert.equal(P.shiftDayOf(r, { id: id17, occurred_on: "2026-10-17" }, TODAY), "2026-10-17");
    assert.equal(P.shiftDayOf(r, { id: id17, occurred_on: "2026-10-18" }, TODAY), "2026-10-17", "R13：改到 10/18");
    assert.equal(P.shiftDayOf(r, { id: id17, occurred_on: "2026-10-16" }, TODAY), "2026-10-17", "R14：改到起算日之前");
    assert.equal(P.shiftDayOf(r, { id: id17, occurred_on: "2026-12-01" }, TODAY), "2026-10-17", "改到今天之後");
    assert.equal(P.shiftDayOf(r, { id: "e-linked", occurred_on: "2026-10-17" }, TODAY), null, "R13c：設成定期連上的那筆");
    assert.equal(P.shiftDayOf({ ...r, rule: "{壞" }, { id: id17, occurred_on: "2026-10-18" }, TODAY), null);
    // 超過 400 班的長規則：分段找得到
    const long = rep("rl", fixedRule("daily", "2024-01-01"));
    const far = P.materializeId("rl", "2025-06-01");
    assert.equal(P.shiftDayOf(long, { id: far, occurred_on: "2026-10-01" }, TODAY), "2025-06-01");
  });

  test("G2. scanFrom：next_on 有值 ⇒ 它；null 且已結束 ⇒ null；null 但今天之後還有班（不一致）⇒ start", () => {
    const ended = { ...fixedRule("daily", "2024-06-01"), until: "2025-12-31" };
    assert.equal(P.scanFrom({ next_on: "2026-10-10" }, fixedRule("daily", "2026-10-01"), TODAY), "2026-10-10");
    assert.equal(P.scanFrom({ next_on: null }, ended, TODAY), null);
    assert.equal(P.scanFrom({ next_on: null }, fixedRule("daily", "2026-10-01"), TODAY), "2026-10-01");
    // 已結束的規則只做 reconcile：skipped 的 id 照出、不出游標
    const r = rep("re", ended, { next_on: null, skipped_days: JSON.stringify(["2025-01-02"]) });
    const plan = P.planMaterialize([r], none, TODAY, CTX, NOW, DSH);
    assert.deepEqual([plan.inserts.length, plan.cursors.length, plan.reconcileIds], [0, 0, [P.materializeId("re", "2025-01-02")]]);
  });

  test("G3. budgetText：超支不到一個主單位 ⇒「超支 1」；超支 1.2 ⇒「超支 2」（無條件進位）；剛好整數不變", () => {
    const line = (used: number, budget: number) => P.budgetLines([P.budgetRow({ kind: "total" }, null, budget, 0, NOW)], [ent({ occurred_on: "2026-10-02", amount_minor: used })], "2026-10", CATS, TODAY, CTX)[0];
    assert.equal(P.budgetText(line(100040, 100000), 2).rest, "超支 1");
    assert.equal(P.budgetText(line(100120, 100000), 2).rest, "超支 2");
    assert.equal(P.budgetText(line(150000, 100000), 2).rest, "超支 500");
    assert.equal(P.budgetText(line(1001, 1000), 0).rest, "超支 1");
  });

});

/* ═════════════════════════ H. 收尾修正（主 session 10-19 定的五件） ═════════════════════════ */

describe("H. 收尾修正", () => {
  for (const impl of IMPLS) {
    test(`H3. materializeRepeats 把 dayStartHour 傳下去：手建規則 03:00、日界線 6 ⇒ 帳日的隔一個日曆日 03:00（${impl.name}）`, async () => {
      const { repo, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat({ ...dailyInput(acc.id, lunch.id, TODAY), hhmm: "03:00" });
      assert.equal((await repo.materializeRepeats(TODAY, DSH)).inserted, 1);
      const e = (await entryAny(repo, P.materializeId(r.id, TODAY)))!;
      assert.equal(e.occurred_on, TODAY);
      assert.equal(e.occurred_at, atOf(TODAY, "03:00", DSH));
      assert.equal(e.occurred_at, new Date(2026, 9, 20, 3, 0).toISOString());
    });
  }

  test("H4. should-3：onTicketPage 看 <html data-shell> 判殼、不看 lastShell（啟動那一刻 init 還沒跑、lastShell 還是 desktop）", () => {
    const src = readFileSync(path.join(ROOT, "src/store/ticketStore.ts"), "utf8");
    const fn = /function onTicketPage\(\): boolean \{[\s\S]*?\r?\n {2}\}/.exec(src); // \r?：CRLF checkout 不假紅
    assert.ok(fn, "找不到 onTicketPage");
    const code = fn[0].replace(/\/\/.*$/gm, "");
    assert.match(code, /getAttribute\(\s*["']data-shell["']\s*\)/);
    assert.doesNotMatch(code, /lastShell/);
  });
});

describe("I. 定期帳補完：每 N 期、記滿 N 筆、提前跳過下一班（D-票-80 起）", () => {
  const weeklyMon = (start: string, p: Partial<any> = {}) => ({ ...fixedRule("weekly", start, { byweekday: [1] }), ...p });
  const dailyN = (start: string, count: number) => ({ ...fixedRule("daily", start), count });

  test("I1. 草稿來回不丟 interval／count／until；draftFromRepeat 給原樣，不換算", () => {
    const input = P.draftToRepeatInput(draft({ freq: "weekly", byweekday: [1], interval: 2, count: 5 }), CTX);
    assert.equal(input.rule.interval, 2);
    assert.equal(input.rule.count, 5);
    const row = P.buildRepeatRow(input, CTX, { id: "r1", position: 0, nowIso: NOW });
    const back = P.draftFromRepeat(row, CTX);
    assert.deepEqual([back.interval, back.count, back.until], [2, 5, null]);
    assert.equal(serializeRule(P.draftToRepeatInput(back, CTX).rule), row.rule, "存回去逐字相同（不會被當成改了規則）");
    const old = P.draftFromRepeat(rep("r0", monthly("2026-10-01", [1])), CTX);
    assert.deepEqual([old.interval, old.count], [1, null], "舊規則＝每 1 期、沒有筆數");
  });

  test("I2. draftToRepeatInput 擋間隔與筆數的範圍（上限照頻率）", () => {
    throwsMsg(() => P.draftToRepeatInput(draft({ freq: "weekly", byweekday: [1], interval: 53 }), CTX), "間隔要是 1 到 52 的整數");
    throwsMsg(() => P.draftToRepeatInput(draft({ interval: 13 }), CTX), "間隔要是 1 到 12 的整數");
    throwsMsg(() => P.draftToRepeatInput(draft({ freq: "daily", interval: 0 }), CTX), "間隔要是 1 到 365 的整數");
    throwsMsg(() => P.draftToRepeatInput(draft({ count: 0 }), CTX), "筆數要是 1 到 999 的整數");
    throwsMsg(() => P.draftToRepeatInput(draft({ count: 1.5 }), CTX), "筆數要是 1 到 999 的整數");
    assert.equal(P.draftToRepeatInput(draft({ freq: "daily", interval: 365 }), CTX).rule.interval, 365);
  });

  test("I3. 結束三選：模式由 until／count 決定，切換預帶值、兩格互斥", () => {
    const d = { start: "2026-11-01", until: null, count: null };
    assert.equal(P.repeatEndMode(d), "none");
    const c = P.repeatEndPatch(d, "count", TODAY);
    assert.deepEqual(c, { until: null, count: 12 });
    assert.equal(P.repeatEndMode(c), "count");
    const u = P.repeatEndPatch({ ...d, ...c }, "until", TODAY);
    assert.deepEqual(u, { until: "2026-12-01", count: null }, "起算日在未來 ⇒ 從起算日算 30 天");
    assert.equal(P.repeatEndMode(u), "until");
    assert.equal(P.repeatEndPatch({ ...d, start: "2026-01-01" }, "until", TODAY).until, "2026-11-18", "起算日在過去 ⇒ 從今天算");
    assert.deepEqual(P.repeatEndPatch({ ...d, ...u }, "none", TODAY), { until: null, count: null });
  });

  test("I4. liveFixedRule：第 N 班＝until、跟既有 until 取早的、可重複呼叫、沒 count 原樣回", () => {
    const plain = fixedRule("daily", "2026-10-01");
    assert.equal(P.liveFixedRule(plain), plain);
    const live = P.liveFixedRule(dailyN("2026-10-01", 5));
    assert.deepEqual([live.until, live.count], ["2026-10-05", null]);
    assert.deepEqual(P.liveFixedRule(live), live);
    assert.equal(P.liveFixedRule({ ...dailyN("2026-10-01", 5), until: "2026-10-03" }).until, "2026-10-03", "until 比較早 ⇒ 留 until");
    assert.equal(P.liveFixedRule({ ...dailyN("2026-10-01", 2), until: "2026-10-30" }).until, "2026-10-02", "第 N 班比較早 ⇒ 收到第 N 班");
    assert.equal(P.liveFixedRule(weeklyMon("2026-10-05", { interval: 2, count: 3 })).until, "2026-11-02", "隔週一：10/5、10/19、11/2");
    assert.equal(P.liveFixedRule({ ...monthly("2026-01-31", [31]), count: 2 }).until, "2026-02-28", "月底夾回也算一班");
    assert.equal(P.repeatLastRun(dailyN("2026-10-01", 5)), "2026-10-05");
    assert.equal(P.repeatLastRun(plain), null);
  });

  test("I5. 實體化：記滿 N 筆到了就停、游標 null（已結束），之後不再掃也不再發游標", () => {
    const r = rep("rc", dailyN("2026-10-15", 3), { next_on: "2026-10-15" });
    const plan = P.planMaterialize([r], new Set<string>(), TODAY, CTX, NOW, 6);
    assert.deepEqual(plan.inserts.map((e: EntryRow) => e.occurred_on), ["2026-10-15", "2026-10-16", "2026-10-17"]);
    assert.deepEqual(plan.cursors, [{ id: "rc", next_on: null }]);
    const done = { ...r, next_on: null };
    assert.equal(P.scanFrom(done, P.liveFixedRule(dailyN("2026-10-15", 3)), TODAY), null);
    const again = P.planMaterialize([done], new Set(plan.inserts.map((e: EntryRow) => e.id)), TODAY, CTX, NOW, 6);
    assert.deepEqual([again.inserts.length, again.cursors.length], [0, 0]);
    assert.equal(P.repeatStatus(done, TODAY, {}), "ended");
    assert.equal(P.repeatLineText(done), "每天重複 · 已結束");
  });

  test("I6. 刪掉的那筆也佔名額：第 N 班不往後延", () => {
    const r = rep("rc", dailyN("2026-10-15", 3), { next_on: "2026-10-15", skipped_days: JSON.stringify(["2026-10-16"]) });
    const plan = P.planMaterialize([r], new Set<string>(), TODAY, CTX, NOW, 6);
    assert.deepEqual(plan.inserts.map((e: EntryRow) => e.occurred_on), ["2026-10-15", "2026-10-17"]);
    assert.deepEqual(plan.cursors, [{ id: "rc", next_on: null }]);
  });

  test("I7. 放寬筆數回到進行中；間隔照起算日算", () => {
    const r = rep("rc", dailyN("2026-10-15", 3), { next_on: null });
    const res = P.applyRepeatPatch(r, { rule: dailyN("2026-10-15", 10) }, CTX, TODAY, NOW);
    assert.equal(res.row.next_on, "2026-10-20");
    const row = rep("ri", weeklyMon("2026-10-05", { interval: 2 }), { next_on: "2026-10-05" });
    const plan = P.planMaterialize([row], new Set<string>(), TODAY, CTX, NOW, 6);
    assert.deepEqual(plan.inserts.map((e: EntryRow) => e.occurred_on), ["2026-10-05", "2026-10-19"]);
    assert.deepEqual(plan.cursors, [{ id: "ri", next_on: "2026-11-02" }]);
  });

  test("I8. 開始（resume）與換規則都吃換算後的規則、跨過跳過的日子", () => {
    const ended = rep("rc", dailyN("2026-10-01", 3), { next_on: "2026-10-02", paused_at: NOW });
    assert.equal(P.resumeNextOn(ended, [], TODAY), null, "第 3 班已過 ⇒ 開始後也是已結束");
    const r = rep("rd", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-20", paused_at: NOW, skipped_days: JSON.stringify(["2026-10-20", "2026-10-21"]) });
    assert.equal(P.resumeNextOn(r, [], TODAY), "2026-10-22");
    const changed = P.applyRepeatPatch(r, { rule: fixedRule("daily", "2026-10-02") }, CTX, TODAY, NOW);
    assert.equal(changed.row.next_on, "2026-10-22");
  });

  test("I9. quickOfRule：有筆數或間隔 ≠ 1 ⇒ null；repeatRuleText／repeatLabel 帶結束條件", () => {
    assert.equal(P.quickOfRule(dailyN("2026-10-01", 3)), null);
    assert.equal(P.quickOfRule(weeklyMon("2026-10-05", { interval: 2 })), null);
    assert.notEqual(P.quickOfRule({ ...fixedRule("daily", "2026-10-01"), until: "2026-12-31" }), null);
    assert.equal(P.repeatRuleText(weeklyMon("2026-10-05", { interval: 2, count: 12 })), "每 2 週 一 · 共 12 筆");
    assert.equal(P.repeatRuleText({ ...monthly("2026-10-01", [1]), until: "2026-12-31" }), "每月 1 號 · 到 12/31");
    assert.equal(P.repeatRuleText(monthly("2026-10-01", [1])), "每月 1 號");
    assert.match(P.repeatLabel(rep("rc", dailyN("2026-10-01", 3)), CTX), /^每天重複 · 共 3 筆 · /);
  });

  test("I10. 跳過下一班：寫進 skipped_days、游標往後推，下一輪實體化不記也不把游標算回去", () => {
    const r = rep("rm", monthly("2026-10-01", [1]), { next_on: "2026-11-01" });
    assert.equal(P.canSkipNext(r), true);
    const plan = P.planSkipNext(r, NOW);
    assert.equal(plan.day, "2026-11-01");
    assert.deepEqual(plan.cols, { skipped_days: JSON.stringify(["2026-11-01"]), next_on: "2026-12-01", updated_at: NOW });
    const next = { ...r, ...plan.cols };
    assert.deepEqual(P.pendingSkips(next, TODAY), ["2026-11-01"]);
    const same = P.planMaterialize([next], new Set<string>(), TODAY, CTX, NOW, 6);
    assert.deepEqual(same.cursors, [], "今天還沒到 11/1：游標留在 12/1，不是算回 11/1");
    const atDay = P.planMaterialize([next], new Set<string>(), "2026-12-01", CTX, NOW, 6);
    assert.deepEqual(atDay.inserts.map((e: EntryRow) => e.occurred_on), ["2026-12-01"], "11/1 過了也不補記");
    assert.deepEqual(P.pendingSkips(next, "2026-11-01"), [], "到了那天就不算還沒到");
    assert.deepEqual(P.pendingSkips({ ...next, rule: serializeRule(monthly("2026-10-01", [15])) }, TODAY), [], "規則改過、那天已不是班次 ⇒ 不列");
  });

  test("I11. 跳過最後一班＝已結束；連跳；擋已暫停、已結束、規則壞掉", () => {
    const r = rep("rc", dailyN("2026-10-20", 2), { next_on: "2026-10-20" });
    const one = { ...r, ...P.planSkipNext(r, NOW).cols };
    assert.equal(one.next_on, "2026-10-21");
    const two = P.planSkipNext(one, NOW);
    assert.equal(two.day, "2026-10-21");
    assert.equal(two.cols.next_on, null, "第 2 班是最後一班");
    const ended = { ...one, ...two.cols };
    assert.equal(P.canSkipNext(ended), false);
    assert.equal(P.scanFrom(ended, P.liveFixedRule(dailyN("2026-10-20", 2)), TODAY), null, "最後一班被跳過：不從 start 重掃");
    throwsMsg(() => P.planSkipNext(ended, NOW), "這筆定期帳已經結束了");
    throwsMsg(() => P.planSkipNext({ ...r, paused_at: NOW }, NOW), "已暫停的定期帳沒有下一班");
    assert.equal(P.canSkipNext({ ...r, paused_at: NOW }), false);
    throwsMsg(() => P.planSkipNext({ ...r, rule: "{oops" }, NOW), "重複規則有誤");
    const noEnd = P.planSkipNext(rep("rd", fixedRule("daily", "2026-10-01"), { next_on: "2026-10-20", skipped_days: JSON.stringify(["2026-10-20"]) }), NOW);
    assert.equal(noEnd.day, "2026-10-21", "游標落在已跳過的日子 ⇒ 下一班往後找");
  });

  test("I12. 取消跳過：拿掉那天、游標退回；不在裡面 ⇒ 不寫；已結束的也回得來", () => {
    const r = rep("rm", monthly("2026-10-01", [1]), { next_on: "2026-12-01", skipped_days: JSON.stringify(["2026-11-01"]) });
    assert.deepEqual(P.planUnskip(r, "2026-11-01", NOW), { skipped_days: "[]", next_on: "2026-11-01", updated_at: NOW });
    assert.equal(P.planUnskip(r, "2026-11-02", NOW), null);
    const ended = rep("rc", dailyN("2026-10-20", 1), { next_on: null, skipped_days: JSON.stringify(["2026-10-20"]) });
    assert.equal(P.planUnskip(ended, "2026-10-20", NOW)!.next_on, "2026-10-20");
    const notRun = rep("rm", monthly("2026-10-01", [15]), { next_on: "2026-11-15", skipped_days: JSON.stringify(["2026-11-01"]) });
    assert.equal(P.planUnskip(notRun, "2026-11-01", NOW)!.next_on, undefined, "規則改過、那天已不是班次 ⇒ 游標不動");
  });

  for (const impl of IMPLS) {
    test(`I13. skipNextRepeat／unskipRepeat 走同步欄位、兩個實作同語義（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat({ ...dailyInput(acc.id, lunch.id, V.dayStep(TODAY, 1)), rule: dailyN(V.dayStep(TODAY, 1), 3) });
      const m0 = db ? db.ops.length : 0;
      assert.equal(await repo.skipNextRepeat(r.id), V.dayStep(TODAY, 1));
      let row = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r.id)!;
      assert.equal(row.skipped_days, JSON.stringify([V.dayStep(TODAY, 1)]));
      assert.equal(row.next_on, V.dayStep(TODAY, 2));
      if (db) {
        const ops = opsOf(db, m0);
        assert.equal(ops.length, 1);
        assert.equal(ops[0].tbl, "tk_repeats");
        assert.deepEqual(Object.keys(ops[0].cols).sort(), ["next_on", "skipped_days", "updated_at"]);
      }
      assert.equal((await repo.materializeRepeats(TODAY, 6)).inserted, 0);
      row = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r.id)!;
      assert.equal(row.next_on, V.dayStep(TODAY, 2), "實體化不把游標算回被跳過的那天");

      await repo.unskipRepeat(r.id, V.dayStep(TODAY, 1));
      row = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r.id)!;
      assert.equal(row.skipped_days, "[]");
      assert.equal(row.next_on, V.dayStep(TODAY, 1));
      const m1 = db ? db.ops.length : 0;
      await repo.unskipRepeat(r.id, V.dayStep(TODAY, 1));
      if (db) assert.equal(db.ops.length, m1, "沒變就不寫");

      await repo.setRepeatPaused(r.id, true, TODAY);
      await assert.rejects(repo.skipNextRepeat(r.id), /已暫停/);
    });

    test(`I14. 記滿 N 筆跑到底：帳數剛好 N、之後已結束（${impl.name}）`, async () => {
      const { repo, acc, lunch } = await setup(impl);
      const start = V.dayStep(TODAY, -5);
      const r = await repo.createRepeat({ ...dailyInput(acc.id, lunch.id, start), rule: dailyN(start, 3) });
      assert.equal((await repo.materializeRepeats(TODAY, 6)).inserted, 3);
      assert.equal((await repo.listRepeats()).find((x: RepeatRow) => x.id === r.id)!.next_on, null);
      assert.equal((await repo.materializeRepeats(TODAY, 6)).inserted, 0);
    });
  }
});
