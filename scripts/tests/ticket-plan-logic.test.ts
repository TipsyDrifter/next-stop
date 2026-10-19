/**
 * 售票口線・第③階段「管帳」單元測試（③契約 §4.7；甲席 Stage 0）。
 * 跑法：`node --test scripts/tests/ticket-plan-logic.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * A～F：domain（`src/domain/ticketPlan.ts`）全部真斷言。G：repository 對帳——memory 與 sqlite 兩個實作各跑一遍 38～42c
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

import type { AccountRow, CategoryRow, CurrencyRow, EntryCtx, EntryRow, ImportLocal, MmbakDump } from "../../src/domain/ticket.ts";
import type { BudgetRow, RepeatRow } from "../../src/domain/ticketPlan.ts";

const T = await import("../../src/domain/ticket.ts");
const V = await import("../../src/domain/ticketView.ts");
const R = await import("../../src/domain/repeat.ts");
const P = await import("../../src/domain/ticketPlan.ts");
const M = await import("../../src/data/memoryTicketRepository.ts");
const S = await import("../../src/data/sqliteTicketRepository.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const { ticketId, UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, STARTER_CATEGORIES, STARTER_CURRENCY, atOf } = T;
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
    assert.equal(lines[2].label, "（分類已不在）");
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
    until: null,
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
    throwsMsg(() => P.draftToRepeatInput(draft({ freq: "weekly", byweekday: [] }), CTX), "每週要選至少一天");
    throwsMsg(() => P.draftToRepeatInput(draft({ freq: "monthly", bymonthday: [] }), CTX), "每月要選至少一天");
    throwsMsg(() => P.draftToRepeatInput(draft({ start: "11/1" }), CTX), "起算日看不懂");
    throwsMsg(() => P.draftToRepeatInput(draft({ until: "2026-10-01" }), CTX), "終止日要在起算日之後");
    throwsMsg(() => P.draftToRepeatInput(draft({ hhmm: "25:00" }), CTX), "時刻看不懂");
    throwsMsg(() => P.draftToRepeatInput(draft({ accountId: "a-gone" }), CTX), "這個帳戶已經不在了");
    throwsMsg(() => P.draftToRepeatInput(draft({ categoryId: "c-salary" }), CTX), "分類和收支類型對不上");
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
    assert.equal(P.repeatLabel(ex, CTX), "每月 1 日 · 房租 · −12,000 · 現金");
    const inc = rep("r2", monthly("2026-10-01", [20]), { kind: "income", category_id: "c-salary", amount_minor: 600000, account_id: "a-bank" });
    assert.equal(P.repeatLabel(inc, CTX), "每月 20 日 · 💳 薪水 · ＋6,000 · 帳戶");
    const tr = rep("r3", fixedRule("weekly", "2026-10-01", { byweekday: [1, 3, 5] }), {
      kind: "transfer", category_id: null, account_id: "a-bank", to_account_id: "a-easy", amount_minor: 100000,
    });
    assert.equal(P.repeatLabel(tr, CTX), "每週一・三・五 · 帳戶 → 悠遊卡 · ⇄1,000");
    const usd = rep("r4", monthly("2026-10-01", [16]), { currency: "USD", amount_minor: 1000, category_id: "c-snack" });
    assert.equal(P.repeatLabel(usd, CTX), "每月 16 日 · 點心 · −10 USD · 現金");
    const gone = rep("r5", fixedRule("daily", "2026-10-01"), { account_id: "a-gone", category_id: "c-nope" });
    assert.equal(P.repeatLabel(gone, CTX), "每日重複 · （分類已不在） · −80 · （帳戶已不在）");
  });
  test("14. nextOnText／repeatStatus", () => {
    const r = rep("r1", monthly("2026-10-01", [1]), { next_on: "2026-11-01" });
    assert.equal(P.nextOnText(r), "下一班 11/1");
    assert.equal(P.nextOnText({ ...r, paused_at: NOW }), "已暫停");
    assert.equal(P.nextOnText({ ...r, next_on: null }), "已結束");
    assert.equal(P.repeatStatus(r, TODAY, {}), "active");
    assert.equal(P.repeatStatus({ ...r, paused_at: NOW }, TODAY, { r1: "x" }), "paused");
    assert.equal(P.repeatStatus(r, TODAY, { r1: "這個帳戶已經不在了" }), "blocked");
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
    assert.deepEqual(p.blocked, [{ id: "rg", reason: "這個帳戶已經不在了" }]);
    assert.deepEqual(daysOf(p.inserts), ["2026-10-19"], "別條照記");
    assert.deepEqual(p.cursors, [{ id: "rd", next_on: "2026-10-20" }]);
    const badRule = rep("rx", fixedRule("daily", "2026-10-01"), { rule: "{bad" });
    assert.deepEqual(P.planMaterialize([badRule], none, TODAY, CTX, NOW, DSH).blocked, [{ id: "rx", reason: "規則看不懂" }]);
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

function emptyLocal(): ImportLocal {
  return {
    currencies: [{ ...STARTER_CURRENCY, ...SYNC }],
    accounts: [],
    categories: STARTER_CATEGORIES.map((c) => ({ ...c, archived_at: null, ...SYNC })),
    entries: [],
    budgets: [],
    repeats: [],
  };
}
const planOpts = (pause = true) => ({ balanceText: {}, nowIso: NOW, pauseImported: pause });
const dump3 = (): MmbakDump => M.mockImportDump("base", true);

describe("F. 匯入", () => {
  test("29. mmMonth 四種", () => {
    assert.equal(P.mmMonth(0), null);
    assert.equal(P.mmMonth(202601), "2026-01");
    assert.equal(P.mmMonth(202613), undefined);
    assert.equal(P.mmMonth(2026), undefined);
  });
  test("30. mmRepeatRule：每月＋until、未知碼 null", () => {
    const r = P.mmRepeatRule(1, "2026-11-03", "2027-06-30");
    assert.deepEqual([r?.freq, r?.bymonthday, r?.start, r?.until], ["monthly", [3], "2026-11-03", "2027-06-30"]);
    assert.equal(P.mmRepeatRule(9, "2026-11-03", null), null);
  });
  test("31. planBudgetImport：總＋主＋子、預設＋覆寫 ⇒ 5 列、scopes 3、overrides 2；各 invalid 原因逐字", () => {
    const { plan, part } = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const b = part.budgets;
    assert.equal(b.inserts.length, 5);
    assert.equal(b.scopes, 3);
    assert.equal(b.overrides, 2);
    assert.deepEqual(b.invalid, [{ uid: "mm-ba6", reason: "不是月預算" }]);
    const total = b.inserts.find((x) => x.kind === "total" && x.month === null)!;
    assert.equal(total.id, P.budgetId({ kind: "total" }, null));
    assert.equal(total.amount_minor, 1500000);
    assert.deepEqual([total.import_id, total.import_source], ["mm-ba1", "moneymanager"]);
    const snack = b.inserts.find((x) => x.category_id === plan.categoryIdOf["mm-ce0-4"])!;
    assert.equal(snack.amount_minor, 80000);
    // 其餘 invalid
    const d = dump3();
    d.budgets!.push(
      { uid: "inc", target_uid: null, do_type: 0, period_type: 6, is_total: true, is_del: false, transfer_type: 0, modify_date: 1 },
      { uid: "tt", target_uid: null, do_type: 1, period_type: 6, is_total: true, is_del: false, transfer_type: 1, modify_date: 1 },
      { uid: "uncat", target_uid: "mm-uncat", do_type: 1, period_type: 6, is_total: false, is_del: false, transfer_type: 0, modify_date: 1 },
    );
    d.budget_amounts!.push(
      { uid: "x-inc", budget_uid: "inc", is_del: false, amount: "100", budget_period: 0, modify_date: 1 },
      { uid: "x-tt", budget_uid: "tt", is_del: false, amount: "100", budget_period: 0, modify_date: 1 },
      { uid: "x-13", budget_uid: "_1_1_0_6", is_del: false, amount: "100", budget_period: 202613, modify_date: 1 },
      { uid: "x-zero", budget_uid: "_1_1_0_6", is_del: false, amount: "0", budget_period: 202602, modify_date: 1 },
      { uid: "x-uncat", budget_uid: "uncat", is_del: false, amount: "100", budget_period: 0, modify_date: 1 },
      { uid: "x-nobud", budget_uid: "nope", is_del: false, amount: "100", budget_period: 0, modify_date: 1 },
    );
    const plan2 = { categoryIdOf: { ...plan.categoryIdOf, "mm-uncat": UNCAT_EXPENSE_ID } };
    const inv = P.planBudgetImport(d, plan2, [], NOW).invalid;
    assert.deepEqual(inv, [
      { uid: "mm-ba6", reason: "不是月預算" },
      { uid: "x-13", reason: "看不懂的期間" },
      { uid: "x-inc", reason: "收入預算（本版只管支出）" },
      { uid: "x-nobud", reason: "預算對象找不到" },
      { uid: "x-tt", reason: "不認得的預算型態" },
      { uid: "x-uncat", reason: "未分類不設預算" },
      { uid: "x-zero", reason: "金額看不懂" },
    ]);
  });
  test("32. 重跑：結果當 local ⇒ 0／0；MODIFY_DATE+1 且金額變 ⇒ updates 1；金額沒變 ⇒ unchanged；本機墓碑 ⇒ tombstoned", () => {
    const { plan, part } = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const local = part.budgets.inserts;
    const again = P.planBudgetImport(dump3(), plan, local, NOW);
    assert.deepEqual([again.inserts.length, again.updates.length, again.unchanged], [0, 0, 5]);
    const d = dump3();
    d.budget_amounts![0].modify_date += 1;
    d.budget_amounts![0].amount = "16000";
    d.budget_amounts![1].modify_date += 1; // 金額沒變
    const r = P.planBudgetImport(d, plan, local, NOW);
    assert.equal(r.updates.length, 1);
    assert.deepEqual(r.updates[0].cols, { amount_minor: 1600000, import_id: "mm-ba1", import_source: "moneymanager", import_utime: d.budget_amounts![0].modify_date, updated_at: NOW });
    assert.equal(r.unchanged, 4);
    const tomb = local.map((x) => (x.month === null && x.kind === "total" ? { ...x, deleted_at: NOW } : x));
    assert.equal(P.planBudgetImport(dump3(), plan, tomb, NOW).tombstoned, 1);
  });
  test("33. planRepeatImport：四條、USD、hhmm、PAYEE 優先、未知週期碼、轉帳、不認得的類型", () => {
    const { plan, part } = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const r = part.repeats;
    assert.equal(r.inserts.length, 4);
    assert.deepEqual(r.invalid, [{ uid: "mm-r5", reason: "不認得的週期碼 9" }]);
    const byUid = (u: string) => r.inserts.find((x) => x.import_id === u)!;
    assert.equal(byUid("mm-r1").id, ticketId("moneymanager:repeat:mm-r1"));
    assert.equal(byUid("mm-r1").hhmm, "09:30");
    assert.equal(byUid("mm-r1").next_on, "2026-11-03");
    assert.equal(byUid("mm-r1").note, "雲端硬碟");
    assert.equal(byUid("mm-r4").note, "房租", "PAYEE 空 ⇒ MEMO");
    assert.deepEqual([byUid("mm-r3").currency, byUid("mm-r3").amount_minor], ["USD", 1000]);
    assert.equal(byUid("mm-r2").kind, "income");
    assert.equal(byUid("mm-r2").category_id, plan.categoryIdOf["mm-ci0"]);
    assert.equal(byUid("mm-r1").rule, serializeRule(P.mmRepeatRule(1, "2026-11-03", null)!));
    assert.equal(byUid("mm-r1").account_id, plan.accountIdOf["mm-a2"]);
    const d = dump3();
    const nd = new Date(2026, 10, 7, 9, 0).getTime();
    d.repeats!.push(
      { ...d.repeats![0], uid: "mm-tr", do_type: 3, to_asset_uid: "mm-a3", ctg_uid: null, next_date: nd, amount_sub: "500" },
      { ...d.repeats![0], uid: "mm-x5", do_type: 5 },
    );
    const r2 = P.planImportAll(d, emptyLocal(), planOpts()).part.repeats;
    const tr = r2.inserts.find((x) => x.import_id === "mm-tr")!;
    assert.deepEqual([tr.kind, tr.to_account_id, tr.category_id, tr.amount_minor], ["transfer", plan.accountIdOf["mm-a3"], null, 50000]);
    assert.ok(r2.invalid.some((x) => x.uid === "mm-x5" && x.reason === "不認得的類型 5"));
  });
  test("34. 0-1 兩種：pauseImported true ⇒ paused_at 非 null；false ⇒ null、next_on＝nextDay", () => {
    const a = P.planImportAll(dump3(), emptyLocal(), planOpts(true)).part.repeats.inserts;
    assert.ok(a.every((x) => x.paused_at === NOW));
    const b = P.planImportAll(dump3(), emptyLocal(), planOpts(false)).part.repeats.inserts;
    assert.ok(b.every((x) => x.paused_at === null));
    assert.equal(b.find((x) => x.import_id === "mm-r2")!.next_on, "2026-10-20");
  });
  test("35. 重跑規則：USETIME+1 且 AMOUNT_SUB 變 ⇒ updates（不含 paused_at／next_on）；本機已暫停 ⇒ 更新後仍暫停", () => {
    const { plan, part } = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const local = part.repeats.inserts;
    const same = P.planRepeatImport(dump3(), plan, local, NOW, { pauseImported: true, accounts: plan.accounts, entries: [] });
    assert.deepEqual([same.inserts.length, same.updates.length, same.unchanged], [0, 0, 4]);
    const d = dump3();
    d.repeats![0].usetime += 1;
    d.repeats![0].amount_sub = "350";
    const r = P.planRepeatImport(d, plan, local, NOW, { pauseImported: true, accounts: plan.accounts, entries: [] });
    assert.equal(r.updates.length, 1);
    assert.deepEqual(r.updates[0].cols, { amount_minor: 35000, import_utime: d.repeats![0].usetime, updated_at: NOW });
    assert.ok(!("paused_at" in r.updates[0].cols) && !("next_on" in r.updates[0].cols));
    // USETIME 沒變 ⇒ 不比模板
    const d2 = dump3();
    d2.repeats![0].amount_sub = "350";
    assert.equal(P.planRepeatImport(d2, plan, local, NOW, { pauseImported: true, accounts: plan.accounts, entries: [] }).updates.length, 0);
  });
  test("35b. 游標刷新（✎-8）：暫停且從沒開始過 ⇒ 重匯 NEXT_DATE 往後一個月 ⇒ updates 含 next_on；開始過 ⇒ 不動；resume 兩種", () => {
    const { plan, part } = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const local = part.repeats.inserts;
    const d = dump3();
    d.repeats![0].next_date = new Date(2026, 11, 3, 9, 30).getTime(); // 11/3 → 12/3
    const opts = { pauseImported: true, accounts: plan.accounts, entries: [] as Pick<EntryRow, "repeat_id">[] };
    const r = P.planRepeatImport(d, plan, local, NOW, opts);
    assert.equal(r.updates.length, 1);
    assert.equal(r.updates[0].cols.next_on, "2026-12-03");
    assert.equal(r.updates[0].cols.rule, serializeRule(P.mmRepeatRule(1, "2026-12-03", null)!));
    const id = r.updates[0].id;
    const started = P.planRepeatImport(d, plan, local, NOW, { ...opts, entries: [{ repeat_id: id }] });
    assert.equal(started.updates.length, 0, "開始過（有帳指向它）⇒ next_on 不動");
    // resume：從沒開始過的匯入規則 ⇒ next_on 不變；手建 ⇒ 明天起
    const imp = local.find((x) => x.id === id)!;
    assert.equal(P.neverStarted(imp, []), true);
    assert.equal(P.resumeNextOn(imp, [], TODAY), "2026-11-03");
    const pastImp = { ...local.find((x) => x.import_id === "mm-r3")! };
    assert.equal(P.resumeNextOn(pastImp, [], TODAY), "2026-10-16", "NEXT_DATE 已過也保持——實體化照常補記到今天");
    const manual = rep("rm", fixedRule("daily", "2026-10-01"), { paused_at: NOW, next_on: "2026-10-03" });
    assert.equal(P.resumeNextOn(manual, [], TODAY), "2026-10-20");
    assert.equal(P.resumeNextOn(imp, [{ repeat_id: id }], TODAY), nextFixedDate(P.parseFixedRule(imp.rule)!, TODAY));
  });
  test("36. plan_missing 非空 ⇒ 三個陣列 null ⇒ part 全空、missing 照抄", () => {
    const d = { ...dump3(), budgets: null, budget_amounts: null, repeats: null, plan_missing: ["BUDGET.targetUid"] };
    const { part } = P.planImportAll(d, emptyLocal(), planOpts());
    assert.deepEqual([part.budgets.inserts.length, part.repeats.inserts.length, part.budgets.scopes], [0, 0, 0]);
    assert.deepEqual(part.missing, ["BUDGET.targetUid"]);
    // 舊版 Rust（四個欄位都沒有）也不炸
    const old: any = { ...dump3() };
    delete old.budgets;
    delete old.budget_amounts;
    delete old.repeats;
    delete old.plan_missing;
    assert.deepEqual(P.planImportAll(old, emptyLocal(), planOpts()).part.missing, []);
  });
  test("37. partSummary 文字逐字", () => {
    const { part } = P.planImportAll(dump3(), emptyLocal(), planOpts());
    assert.deepEqual(P.partSummary(part), { budgetLine: "預算 3 個（2 個單月覆寫）", repeatLine: "定期 4 條", skipLine: "略過 2：不是月預算、不認得的週期碼 9", tombLine: null });
    const { part: empty } = P.planImportAll(M.mockImportDump("base"), emptyLocal(), planOpts());
    assert.deepEqual(P.partSummary(empty), { budgetLine: "預算 0 個", repeatLine: "定期 0 條", skipLine: null, tombLine: null });
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
/** 沒存活的帳也讀得到（含墓碑）：兩個實作都走 loadImportLocal */
async function entryAny(repo: any, id: string): Promise<EntryRow | undefined> {
  return ((await repo.loadImportLocal()).entries as EntryRow[]).find((e) => e.id === id);
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
      await assert.rejects(repo.setBudget({ kind: "category", categoryId: UNCAT_EXPENSE_ID }, null, 100), /未分類不設預算/);
      await assert.rejects(repo.setBudget({ kind: "category", categoryId: "c-nope" }, null, 100), /這個分類已經不在了/);
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
      assert.deepEqual(first, { inserted: 4, reconciled: 0, blocked: [] });
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

    test(`42. applyImport 含 part ⇒ 預算與規則落庫、第二次 inserts 0；全部開始接著 NEXT_DATE（${impl.name}）`, async () => {
      const { repo, db } = await impl.make();
      await repo.ensureStarterRows();
      const d = dump3();
      const a1 = P.planImportAll(d, await repo.loadImportLocal(), planOpts());
      const m0 = db ? db.ops.length : 0;
      const out = await repo.applyImport(a1.plan, T.defaultChoices(a1.plan), a1.part, () => {});
      assert.deepEqual([out.budgets, out.repeats], [5, 4]);
      if (db) {
        const ops = opsOf(db, m0);
        const bud = ops.filter((o) => o.tbl === "tk_budgets");
        const rep = ops.filter((o) => o.tbl === "tk_repeats");
        assert.deepEqual([bud.length, rep.length], [5, 4]);
        assert.deepEqual(Object.keys(bud[0].cols), rustCols("TK_BUDGETS_COLS"));
        assert.deepEqual(Object.keys(rep[0].cols), rustCols("TK_REPEATS_COLS"));
        // 外鍵父先子後：第 1 批裡分類在預算之前、帳戶在規則之前
        const firstBud = ops.findIndex((o) => o.tbl === "tk_budgets");
        const lastCat = ops.map((o) => o.tbl).lastIndexOf("tk_categories");
        assert.ok(lastCat < firstBud);
      }
      assert.equal((await repo.listBudgets()).length, 5);
      const reps: RepeatRow[] = await repo.listRepeats();
      assert.equal(reps.length, 4);
      assert.ok(reps.every((x) => x.paused_at !== null));
      const a2 = P.planImportAll(d, await repo.loadImportLocal(), planOpts());
      assert.deepEqual(
        [a2.part.budgets.inserts.length, a2.part.repeats.inserts.length, a2.part.budgets.updates.length, a2.part.repeats.updates.length],
        [0, 0, 0, 0],
      );
      // 重跑時 MODIFY_DATE／USETIME 變新且值變 ⇒ updates 落庫
      const d3 = dump3();
      d3.budget_amounts![0].modify_date += 1;
      d3.budget_amounts![0].amount = "16000";
      d3.repeats![0].usetime += 1;
      d3.repeats![0].amount_sub = "350";
      const a3 = P.planImportAll(d3, await repo.loadImportLocal(), planOpts());
      const out3 = await repo.applyImport(a3.plan, T.defaultChoices(a3.plan), a3.part, () => {});
      assert.deepEqual([out3.budgets, out3.repeats], [1, 1]);
      assert.equal((await repo.listBudgets()).find((b: BudgetRow) => b.import_id === "mm-ba1")!.amount_minor, 1600000);
      const r1 = (await repo.listRepeats()).find((x: RepeatRow) => x.import_id === "mm-r1")!;
      assert.deepEqual([r1.amount_minor, r1.import_utime, r1.paused_at !== null], [35000, d3.repeats![0].usetime, true], "更新後仍暫停");
      // 全部開始：從沒開始過的匯入規則接著 NEXT_DATE；已過的那條（10/16）實體化補記到今天
      const n = await repo.resumeAllRepeats(TODAY);
      assert.equal(n, 4);
      const afterResume: RepeatRow[] = await repo.listRepeats();
      assert.ok(afterResume.every((x) => x.paused_at === null));
      assert.equal(afterResume.find((x) => x.import_id === "mm-r3")!.next_on, "2026-10-16");
      assert.equal(afterResume.find((x) => x.import_id === "mm-r1")!.next_on, "2026-11-03");
      const m = await repo.materializeRepeats(TODAY, 6);
      assert.equal(m.inserted, 1, "只有 mm-r3（10/16）到期");
      assert.equal((await repo.listRepeats()).find((x: RepeatRow) => x.import_id === "mm-r3")!.next_on, "2026-11-16");
      assert.equal(await repo.resumeAllRepeats(TODAY), 0, "沒有暫停的 ⇒ 0、不寫");
    });

    test(`42b. 規則的寫入：建／改（rule 變 ⇒ next_on 重算、只改模板 ⇒ 不動）／暫停開始（手建明天起）／刪復原／連帳（${impl.name}）`, async () => {
      const { repo, db, acc, lunch, food } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, V.dayStep(TODAY, -2)));
      assert.equal(r.next_on, V.dayStep(TODAY, -2));
      assert.equal(r.position, 0);
      const r2 = await repo.createRepeat(dailyInput(acc.id, lunch.id, TODAY));
      assert.equal(r2.position, 1);
      await assert.rejects(repo.createRepeat({ ...dailyInput(acc.id, lunch.id, TODAY), accountId: "nope" }), /這個帳戶已經不在了/);
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
      await assert.rejects(repo.updateRepeat(r2.id, { note: "x" }, TODAY), /這條規則已經刪除了/);
      await assert.rejects(repo.setRepeatPaused(r2.id, true, TODAY), /這條規則已經刪除了/);
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
      await assert.rejects(repo.linkEntryToRepeat(e.id, "nope"), /這條規則已經刪除了/);
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
      assert.deepEqual(res.blocked, [{ id: bad.id, reason: "這個帳戶已經不在了" }]);
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
    for (const impl of IMPLS) {
      const { repo } = await impl.make();
      const idMap: Record<string, string> = {};
      const res: unknown[] = [];
      await repo.ensureStarterRows();
      const a = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      await repo.applyImport(a.plan, T.defaultChoices(a.plan), a.part, () => {});
      const accs: AccountRow[] = await repo.listAccounts();
      const cats: CategoryRow[] = (await repo.listCategories()).filter((c: CategoryRow) => c.kind === "expense" && c.id !== UNCAT_EXPENSE_ID);
      const acc0 = accs[0].id;
      const leaf = cats.find((c) => c.parent_id !== null)!.id;
      const root = cats.find((c) => c.parent_id === null)!.id;
      await repo.setBudget({ kind: "total" }, "2026-11", 300000);
      await repo.setBudget({ kind: "total" }, "2026-11", 310000);
      await repo.setBudget({ kind: "category", categoryId: leaf }, null, 40000);
      await repo.setBudget({ kind: "category", categoryId: root }, "2026-12", 70000);
      await repo.removeBudget({ kind: "category", categoryId: root }, null);
      const r1 = await repo.createRepeat(dailyInput(acc0, leaf, V.dayStep(TODAY, -3)));
      const r2 = await repo.createRepeat({ ...dailyInput(acc0, leaf, V.dayStep(TODAY, -10)), rule: fixedRule("weekly", V.dayStep(TODAY, -10), { byweekday: [1, 3, 5] }) });
      idMap[r1.id] = "R1";
      idMap[r2.id] = "R2";
      res.push(await repo.resumeAllRepeats(TODAY));
      res.push(await repo.materializeRepeats(TODAY, 6));
      await repo.softDeleteEntry(P.materializeId(r1.id, V.dayStep(TODAY, -1)));
      await repo.softDeleteEntry(P.materializeId(r1.id, V.dayStep(TODAY, -2)));
      await repo.restoreEntry(P.materializeId(r1.id, V.dayStep(TODAY, -2)));
      await repo.setRepeatPaused(r2.id, true, TODAY);
      await repo.updateRepeat(r1.id, { amountMinor: 9000 }, TODAY);
      await repo.updateRepeat(r2.id, { note: "通勤" }, TODAY);
      await repo.setRepeatPaused(r2.id, false, TODAY);
      res.push(await repo.materializeRepeats(TODAY, 6));
      const imported: RepeatRow[] = (await repo.listRepeats()).filter((x: RepeatRow) => x.import_source !== null);
      await repo.softDeleteRepeat(imported[0].id);
      await repo.softDeleteRepeat(imported[1].id);
      await repo.restoreRepeat(imported[1].id);
      const plainIds = ((await repo.loadImportLocal()).entries as EntryRow[]).filter((e) => e.deleted_at === null && e.repeat_id === null).map((e) => e.id).sort();
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
      const local = await repo.loadImportLocal();
      const entries = (local.entries as EntryRow[])
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
  test("G1. shiftDayOf：沒改日期 ⇒ occurred_on；改過日期 ⇒ 找回原本的班次日；連上的那筆（id 不是 repeat: 形）⇒ null；規則看不懂 ⇒ null", () => {
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

  test("G4. 預算的 scopes／overrides 只算有變動的：同一份備份再匯一次 ⇒ 0／0（和「定期 N 條」同一個口徑）", () => {
    const first = P.planImportAll(dump3(), emptyLocal(), planOpts());
    assert.deepEqual([first.part.budgets.scopes, first.part.budgets.overrides], [3, 2]);
    const local = { ...emptyLocal(), budgets: first.part.budgets.inserts, repeats: first.part.repeats.inserts };
    const again = P.planImportAll(dump3(), local, planOpts());
    assert.deepEqual([again.part.budgets.scopes, again.part.budgets.overrides, again.part.budgets.unchanged], [0, 0, 5]);
    assert.equal(P.partSummary(again.part).budgetLine, "預算 0 個");
  });

  test("G5. 規則指到①會丟掉的幣別（匯率看不懂／代碼不是三個字母）⇒ invalid「幣別看不懂」；對不到任何幣別仍用帳戶幣別", () => {
    for (const bad of [{ iso: "JPY", rate: "abc" }, { iso: "J1", rate: "0.2" }]) {
      const d = dump3();
      d.currencies.push({ uid: "mm-c9", iso: bad.iso, is_main: false, rate: bad.rate, decimals: 0 });
      d.repeats![2].currency_uid = "mm-c9";
      const { part } = P.planImportAll(d, emptyLocal(), planOpts());
      assert.ok(part.repeats.invalid.some((x) => x.uid === "mm-r3" && x.reason === "幣別看不懂"), bad.iso);
      assert.equal(part.repeats.inserts.some((x) => x.import_id === "mm-r3"), false);
    }
  });

  test("G6. ✎-8 游標刷新只往前：舊備份（NEXT_DATE 較早）不刷；新備份（較晚）照刷 next_on＋rule", () => {
    const first = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const local = { ...emptyLocal(), budgets: first.part.budgets.inserts, repeats: first.part.repeats.inserts };
    const id = ticketId("moneymanager:repeat:mm-r1");
    const older = dump3();
    older.repeats![0].next_date = new Date(2026, 9, 3, 9, 30).getTime();
    assert.equal(P.planImportAll(older, local, planOpts()).part.repeats.updates.find((u) => u.id === id), undefined);
    const newer = dump3();
    newer.repeats![0].next_date = new Date(2026, 11, 3, 9, 30).getTime();
    const up = P.planImportAll(newer, local, planOpts()).part.repeats.updates.find((u) => u.id === id);
    assert.ok(up && up.cols.next_on === "2026-12-03" && typeof up.cols.rule === "string");
  });
});

/* ═════════════════════════ H. 收尾修正（主 session 10-19 定的五件） ═════════════════════════ */

describe("H. 收尾修正", () => {
  for (const impl of IMPLS) {
    test(`H1. 「全部開始」只開始匯入且從沒開始過的規則：手動暫停的手建規則、開始過又暫停的匯入規則都不動；listUnstartedRepeatIds＝開始的那幾條（${impl.name}）`, async () => {
      const { repo, db } = await impl.make();
      await repo.ensureStarterRows();
      const a = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      await repo.applyImport(a.plan, T.defaultChoices(a.plan), a.part, () => {});
      const accs: AccountRow[] = await repo.listAccounts();
      const leaf = (await repo.listCategories()).find((c: CategoryRow) => c.kind === "expense" && c.parent_id !== null)!.id;
      // 手建規則、手動暫停
      const hand = await repo.createRepeat(dailyInput(accs[0].id, leaf, V.dayStep(TODAY, 1)));
      await repo.setRepeatPaused(hand.id, true, TODAY);
      // 匯入規則 mm-r3：單條開始 → 補記 10/16 → 再暫停（開始過了）
      const r3 = (await repo.listRepeats()).find((x: RepeatRow) => x.import_id === "mm-r3")!;
      await repo.setRepeatPaused(r3.id, false, TODAY);
      assert.equal((await repo.materializeRepeats(TODAY, DSH)).inserted, 1);
      await repo.setRepeatPaused(r3.id, true, TODAY);
      const fresh = (await repo.listRepeats()).filter((x: RepeatRow) => x.import_source !== null && x.id !== r3.id).map((x: RepeatRow) => x.id);
      assert.equal(fresh.length, 3);
      const ids: string[] = await repo.listUnstartedRepeatIds();
      assert.deepEqual(ids.slice().sort(), fresh.slice().sort(), "只有三條從沒開始過的匯入規則");
      const snapHand = (await repo.listRepeats()).find((x: RepeatRow) => x.id === hand.id)!;
      const snapR3 = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r3.id)!;
      const mark = db ? db.ops.length : 0;
      assert.equal(await repo.resumeAllRepeats(TODAY), 3, "回的 N＝listUnstartedRepeatIds 的長度");
      const after: RepeatRow[] = await repo.listRepeats();
      for (const id of fresh) assert.equal(after.find((x) => x.id === id)!.paused_at, null, "匯入、從沒開始過 ⇒ 開始");
      assert.deepEqual(after.find((x) => x.id === hand.id), snapHand, "手動暫停的手建規則一欄都不動");
      assert.deepEqual(after.find((x) => x.id === r3.id), snapR3, "開始過又暫停的匯入規則一欄都不動");
      if (db) {
        const ops = opsOf(db, mark);
        assert.deepEqual(ops.map((o) => o.row_id).sort(), fresh.slice().sort(), "只對那三條發 op");
      }
      assert.deepEqual(await repo.listUnstartedRepeatIds(), []);
      assert.equal(await repo.resumeAllRepeats(TODAY), 0, "沒有從沒開始過的 ⇒ 0；手動暫停的照舊不動");
      assert.notEqual((await repo.listRepeats()).find((x: RepeatRow) => x.id === hand.id)!.paused_at, null);
    });

    test(`H2. 開始過的匯入規則、記的帳又被刪光（只剩墓碑）⇒ 不算從沒開始過（listUnstartedRepeatIds 看墓碑；${impl.name}）`, async () => {
      const { repo } = await impl.make();
      await repo.ensureStarterRows();
      const a = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      await repo.applyImport(a.plan, T.defaultChoices(a.plan), a.part, () => {});
      const r3 = (await repo.listRepeats()).find((x: RepeatRow) => x.import_id === "mm-r3")!;
      await repo.setRepeatPaused(r3.id, false, TODAY);
      await repo.materializeRepeats(TODAY, DSH);
      await repo.softDeleteEntry(P.materializeId(r3.id, "2026-10-16"));
      await repo.setRepeatPaused(r3.id, true, TODAY);
      const ids: string[] = await repo.listUnstartedRepeatIds();
      assert.equal(ids.indexOf(r3.id), -1);
      assert.equal(ids.length, 3);
    });

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
