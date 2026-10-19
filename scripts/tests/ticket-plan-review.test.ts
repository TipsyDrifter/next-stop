/**
 * 售票口線・第③階段「管帳」評審席 (a)・資料層的反例測試（③契約 §2.5 (a)）。
 * 跑法：`node --test scripts/tests/ticket-plan-review.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 每一條 test 名稱開頭是 R 編號；**紅的＝評審認為產品碼有問題**（對應回報裡的 finding）。綠的＝反例守住了。
 * 契約列的九個反例：R1～R9；評審自己找的：R10～R16。
 *
 * 載入與 sqlite 替身照 ticket-plan-logic.test.ts（registerHooks 之後才動態載入 src；node:sqlite 套真的 0007＋0010 DDL）。
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻。金額一律合成。不碰任何真實資料。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
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
const { ticketId, UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, STARTER_CATEGORIES, STARTER_CURRENCY, atOf, localTime } = T;
const { fixedRule, serializeRule } = R;

/* ───────── fixture（小，只放反例要的） ───────── */

const NOW = new Date(2026, 9, 19, 9, 0).toISOString();
const TODAY = "2026-10-19";
/** 日界線（planMaterialize 的 dayStartHour；手建規則的帳時刻套它，✎-7 改） */
const DSH = 6;
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };

function cur(code: string, rate: string, isMain = false): CurrencyRow {
  return { id: ticketId("currency:" + code), code, name: code, decimals: 2, rate_to_main: rate, is_main: isMain ? 1 : 0, position: 0, ...SYNC };
}
function acc(id: string, name: string, extra: Partial<AccountRow> = {}): AccountRow {
  return { id, name, group_key: "cash", currency: "TWD", position: 0, archived_at: null, ...SYNC, ...extra };
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
const ACCOUNTS: AccountRow[] = [acc("a-cash", "現金"), acc("a-bank", "帳戶", { group_key: "bank" })];
const CATS: CategoryRow[] = [
  cat(UNCAT_INCOME_ID, "income", "未分類", null, 9999),
  cat(UNCAT_EXPENSE_ID, "expense", "未分類", null, 9999),
  cat("c-food", "expense", "🍜 食物", null, 0),
  cat("c-lunch", "expense", "午餐", "c-food", 0),
  cat("c-snack", "expense", "點心", "c-food", 1),
  cat("c-rent", "expense", "房租", null, 2),
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
function rep(id: string, rule: any, p: Partial<RepeatRow> = {}): RepeatRow {
  const row = P.buildRepeatRow(
    { kind: "expense", accountId: "a-cash", toAccountId: null, categoryId: "c-lunch", amountMinor: 8000, currency: "TWD", note: "", routeId: null, rule, hhmm: "09:00" },
    CTX,
    { id, position: 0, nowIso: NOW },
  );
  return { ...row, ...p };
}
/** [from, toIncl] 每一天 */
function daysBetween(from: string, toIncl: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= toIncl; d = V.dayStep(d, 1)) out.push(d);
  return out;
}
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

/* ───────── sqlite 替身＋兩個實作（照 ticket-plan-logic.test.ts） ───────── */

interface TestDb {
  ops: { tbl: string; row_id: string; op: string; cols: Record<string, unknown> }[];
  batches: number;
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<void>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: TestDb["ops"]): void;
}
function makeSqliteDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
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
async function setup(impl: Impl) {
  const { repo, db } = await impl.make();
  await repo.ensureStarterRows();
  const a = await repo.createAccount({ name: "現金", group: "cash", currency: "TWD", openingMinor: null, occurredOn: TODAY });
  const food = await repo.createCategory({ kind: "expense", name: "🍜 食物", parentId: null });
  const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });
  return { repo, db, acc: a as AccountRow, lunch: lunch as CategoryRow, food: food as CategoryRow };
}
const dailyInput = (accountId: string, categoryId: string, start: string, extra: Record<string, unknown> = {}): any => ({
  kind: "expense", accountId, toAccountId: null, categoryId, amountMinor: 8000, currency: "TWD", note: "早餐", routeId: null,
  rule: fixedRule("daily", start), hhmm: "09:00", ...extra,
});
async function entryAny(repo: any, id: string): Promise<EntryRow | undefined> {
  return ((await repo.loadImportLocal()).entries as EntryRow[]).find((e) => e.id === id);
}
/** 模擬同步引擎把某欄改掉（LWW 套上另一台的值）；兩個實作各用自己的後門 */
async function forceRepeatCols(repo: any, db: TestDb | null, id: string, cols: Partial<RepeatRow>): Promise<void> {
  if (db) {
    for (const [k, v] of Object.entries(cols)) await db.execute(`UPDATE tk_repeats SET ${k} = $1 WHERE id = $2`, [v, id]);
  } else Object.assign(repo.rep.get(id), cols);
}
async function forceAlive(repo: any, db: TestDb | null, id: string): Promise<void> {
  if (db) await db.execute(`UPDATE tk_entries SET deleted_at = NULL WHERE id = $1`, [id]);
  else repo.ent.get(id).deleted_at = null;
}
const opCount = (db: TestDb | null) => (db ? db.ops.length : 0);

/* ═════════════════════════ 契約列的九個反例 ═════════════════════════ */

describe("契約九個反例", () => {
  test("R1. 每月 31 日在 2 月：1/31 → 2/28 → 3/31（平年）、閏年 2/29；[29,30,31] 在 2 月只記一筆；游標不會卡在 28 日", () => {
    const rule = fixedRule("monthly", "2027-01-31", { bymonthday: [31] });
    const r = rep("r31", rule);
    const plan = P.planMaterialize([r], new Set(), "2027-03-31", CTX, NOW, DSH);
    assert.deepEqual(plan.inserts.map((x) => x.occurred_on), ["2027-01-31", "2027-02-28", "2027-03-31"]);
    assert.deepEqual(plan.cursors, [{ id: "r31", next_on: "2027-04-30" }]);
    // 跑到 2/28 那天：游標要是 3/31（不是 3/28）
    const mid = P.planMaterialize([r], new Set(), "2027-02-28", CTX, NOW, DSH);
    assert.deepEqual(mid.cursors, [{ id: "r31", next_on: "2027-03-31" }]);
    // 閏年
    const leap = P.planMaterialize([rep("rl", fixedRule("monthly", "2028-01-31", { bymonthday: [31] }))], new Set(), "2028-03-01", CTX, NOW, DSH);
    assert.deepEqual(leap.inserts.map((x) => x.occurred_on), ["2028-01-31", "2028-02-29"]);
    // 29・30・31 三個日子在 2 月都夾到 28 ⇒ 只有一班（同一個 id 不會插兩次）
    const multi = P.planMaterialize([rep("rm", fixedRule("monthly", "2027-02-01", { bymonthday: [29, 30, 31] }))], new Set(), "2027-03-01", CTX, NOW, DSH);
    assert.deepEqual(multi.inserts.map((x) => x.occurred_on), ["2027-02-28"]);
    assert.equal(new Set(multi.inserts.map((x) => x.id)).size, multi.inserts.length);
  });

  for (const impl of IMPLS) {
    test(`R2. next_on 回退到過去（甚至早於 start）＋skipped_days 被 LWW 蓋成空 ⇒ 不重複、墓碑不復活、只發一個游標 op（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, "2026-10-10"));
      assert.equal((await repo.materializeRepeats(TODAY, 6)).inserted, 10);
      const gone = P.materializeId(r.id, "2026-10-12");
      await repo.softDeleteEntry(gone);
      // 另一台的舊游標＋舊 skipped_days 蓋過來
      await forceRepeatCols(repo, db, r.id, { next_on: "2026-09-01", skipped_days: "[]" });
      const m0 = opCount(db);
      const res = await repo.materializeRepeats(TODAY, 6);
      assert.deepEqual([res.inserted, res.reconciled], [0, 0]);
      assert.notEqual((await entryAny(repo, gone))!.deleted_at, null, "墓碑還在");
      const live = ((await repo.loadImportLocal()).entries as EntryRow[]).filter((e) => e.repeat_id === r.id && e.deleted_at === null);
      assert.equal(live.length, 9);
      assert.equal((await repo.listRepeats())[0].next_on, "2026-10-20");
      if (db) assert.deepEqual(db.ops.slice(m0).map((o) => [o.tbl, Object.keys(o.cols).join(",")]), [["tk_repeats", "next_on,updated_at"]]);
    });
  }

  test("R3. skipped_days 含不是班次日的日子（每週一的規則記了週二）＋壞值 ⇒ 班次不受影響；reconcileIds 多出的 id 本機不存在", () => {
    const rule = fixedRule("weekly", "2026-10-05", { byweekday: [1] }); // 週一
    const clean = rep("rw", rule, { next_on: "2026-10-05" });
    const dirty = { ...clean, skipped_days: JSON.stringify(["2026-10-06", "2026-13-01", 42, "2026-10-14"]) };
    const a = P.planMaterialize([clean], new Set(), TODAY, CTX, NOW, DSH);
    const b = P.planMaterialize([dirty], new Set(), TODAY, CTX, NOW, DSH);
    assert.deepEqual(b.inserts.map((x) => x.occurred_on), ["2026-10-05", "2026-10-12", "2026-10-19"]);
    assert.deepEqual(b.inserts, a.inserts);
    assert.deepEqual(b.cursors, a.cursors);
    // parseSkipped 只認格式（2026-13-01 也收）、非字串略過；多出的 id 本機不存在，reconcile 只動活著的 ⇒ 無害
    assert.deepEqual(b.reconcileIds, ["2026-10-06", "2026-10-14", "2026-13-01"].map((d) => P.materializeId("rw", d)));
  });

  for (const impl of IMPLS) {
    test(`R4. 規則 start 在未來（週一規則、起算日是下週三）⇒ next_on＝起算後第一個週一；實體化 0 筆 0 op；暫停再開始不會跑到 start 之前（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, "2026-10-28", { rule: fixedRule("weekly", "2026-10-28", { byweekday: [1] }) }));
      assert.equal(r.next_on, "2026-11-02");
      const m0 = opCount(db);
      assert.equal((await repo.materializeRepeats(TODAY, 6)).inserted, 0);
      if (db) assert.equal(db.ops.length, m0, "游標沒變不寫");
      await repo.setRepeatPaused(r.id, true, TODAY);
      await repo.setRepeatPaused(r.id, false, TODAY);
      assert.equal((await repo.listRepeats())[0].next_on, "2026-11-02");
    });
  }

  test("R5. 主分類預算＋子分類有淨退款 ⇒ 已用可為負、不算超支、剩的比預算多；子分類只算自己；total ≡ statsOverview", () => {
    const es = [
      ent({ occurred_on: "2026-10-02", amount_minor: 50000, category_id: "c-food" }),
      ent({ occurred_on: "2026-10-03", amount_minor: -80000, category_id: "c-lunch", note: "退款" }),
      ent({ occurred_on: "2026-10-04", amount_minor: 10000, category_id: "c-snack" }),
      ent({ occurred_on: "2026-10-05", amount_minor: 20000, category_id: "c-rent" }),
    ];
    const food = { kind: "category" as const, categoryId: "c-food" };
    const lunch = { kind: "category" as const, categoryId: "c-lunch" };
    assert.equal(P.budgetUsed(es, food, "2026-10", CATS), -20000);
    assert.equal(P.budgetUsed(es, lunch, "2026-10", CATS), -80000);
    const total = P.budgetUsed(es, { kind: "total" }, "2026-10", CATS);
    assert.equal(total, V.statsOverview(es, T.monthRange("2026-10")).expense);
    const budgets = [P.budgetRow(food, null, 100000, 0, NOW), P.budgetRow(lunch, null, 30000, 1, NOW)];
    const lines = P.budgetLines(budgets, es, "2026-10", CATS, TODAY, CTX);
    const f = lines.find((l) => l.key === "cat:c-food")!;
    assert.deepEqual([f.used, f.over, f.remaining], [-20000, false, 120000]);
    assert.equal(P.budgetText(f, 2).rest, "剩 1,200");
    // 退款讓累計回落：總預算 600 ⇒ 10/02 累計 500、10/03 −300、10/04 −200、10/05 0 ⇒ 都沒超
    assert.equal(P.overBudgetDay(es, "2026-10", 60000), null);
    // 總預算 400：10/02 越過，但退款把月總額拉回 0（卡寫「剩」）⇒ 月曆不標（沙盒代驗 O1 後改）
    assert.equal(P.overBudgetDay(es, "2026-10", 40000), null);
  });

  test("R6. 總預算剛好等於已用 ⇒ 不超支、「剩 0」、月曆沒有「超」格；多 1 分錢才超支", () => {
    const es = [ent({ occurred_on: "2026-10-02", amount_minor: 60000 }), ent({ occurred_on: "2026-10-09", amount_minor: 40000 })];
    const b = [P.budgetRow({ kind: "total" }, null, 100000, 0, NOW)];
    const [line] = P.budgetLines(b, es, "2026-10", CATS, TODAY, CTX);
    assert.deepEqual([line.over, line.remaining, line.share], [false, 0, 1]);
    assert.equal(P.budgetText(line, 2).rest, "剩 0");
    assert.equal(P.overBudgetDay(es, "2026-10", 100000), null);
    const es2 = [...es, ent({ occurred_on: "2026-10-10", amount_minor: 1 })];
    const [over] = P.budgetLines(b, es2, "2026-10", CATS, TODAY, CTX);
    assert.equal(over.over, true);
    assert.equal(P.overBudgetDay(es2, "2026-10", 100000), "2026-10-10");
  });

  test("R7. BUDGET_PERIOD 202613 與鄰居 ⇒ 看不懂的期間；同一份備份其餘預算照匯", () => {
    for (const bad of [202613, 202600, 999913, 1, -202601, 2026010, 2026.5]) assert.equal(P.mmMonth(bad), undefined, String(bad));
    assert.equal(P.mmMonth(202612), "2026-12");
    assert.equal(P.mmMonth(100001), "1000-01");
    const d = dump3();
    d.budget_amounts!.push({ uid: "x-13", budget_uid: "_1_1_0_6", is_del: false, amount: "100", budget_period: 202613, modify_date: 1 });
    const { part } = P.planImportAll(d, emptyLocal(), planOpts());
    assert.ok(part.budgets.invalid.some((x) => x.uid === "x-13" && x.reason === "看不懂的期間"));
    assert.equal(part.budgets.inserts.length, 5, "其餘 5 列照匯");
  });

  test("R8a. REPEATTRANSACTION.currencyUid 對不到備份的任何幣別 ⇒ 用帳戶幣別（契約 §4.4），金額照帳戶幣別小數位", () => {
    const d = dump3();
    d.repeats![2].currency_uid = "mm-c-nope"; // mm-r3（原本是 USD）
    const { plan, part } = P.planImportAll(d, emptyLocal(), planOpts());
    const r3 = part.repeats.inserts.find((x) => x.import_id === "mm-r3")!;
    const accCur = plan.accounts.find((a) => a.id === r3.account_id)!.currency;
    assert.deepEqual([r3.currency, r3.amount_minor], [accCur, 1000]);
  });

  test("R8b. currencyUid 對到一個 ①匯入會丟掉的幣別（匯率看不懂）⇒ 規則的幣別必須是本機會有的幣別（否則全部開始後永遠 blocked）", () => {
    const d = dump3();
    d.currencies.push({ uid: "mm-c9", iso: "JPY", is_main: false, rate: "abc", decimals: 0 });
    d.repeats![2].currency_uid = "mm-c9";
    const local = emptyLocal();
    const { plan, part } = P.planImportAll(d, local, planOpts());
    const known = new Set([...local.currencies.map((c) => c.code), ...plan.currencies.map((c) => c.code)]);
    assert.equal(known.has("JPY"), false, "前提：①的 planImport 不建 JPY（匯率看不懂）");
    const r3 = part.repeats.inserts.find((x) => x.import_id === "mm-r3");
    const bad = part.repeats.invalid.find((x) => x.uid === "mm-r3");
    assert.ok(bad || (r3 && known.has(r3.currency)), `mm-r3 進來的幣別是 ${r3?.currency}，本機沒有這個幣別`);
  });

  test("R9a. 同一個備份匯兩次、第二次 USETIME／MODIFY_DATE 變小（其餘相同）⇒ 預算與規則都 unchanged", () => {
    const first = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const local = { ...emptyLocal(), budgets: first.part.budgets.inserts, repeats: first.part.repeats.inserts };
    const d = dump3();
    for (const a of d.budget_amounts!) a.modify_date -= 1000;
    for (const r of d.repeats!) r.usetime -= 1000;
    d.budget_amounts![0].amount = "99999"; // 金額不同但比較舊 ⇒ 不能蓋
    const again = P.planImportAll(d, local, planOpts());
    assert.deepEqual([again.part.budgets.updates.length, again.part.budgets.inserts.length], [0, 0]);
    assert.deepEqual([again.part.repeats.updates.length, again.part.repeats.inserts.length], [0, 0]);
  });

  test("R9b. 匯一份比較舊的備份（USETIME 變小、NEXT_DATE 早一個月）⇒ 從沒開始過的暫停規則不能被倒回舊游標／舊規則", () => {
    const first = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const local = { ...emptyLocal(), budgets: first.part.budgets.inserts, repeats: first.part.repeats.inserts };
    const d = dump3();
    d.repeats![0].usetime -= 1000; // mm-r1：比較舊的備份
    d.repeats![0].next_date = new Date(2026, 9, 3, 9, 30).getTime(); // 11/3 → 10/3（財務管家那時候還沒記 10/3）
    const again = P.planImportAll(d, local, planOpts());
    const up = again.part.repeats.updates.find((u) => u.id === ticketId("moneymanager:repeat:mm-r1"));
    assert.equal(up, undefined, `舊備份把游標倒回：${JSON.stringify(up?.cols)}——全部開始後會從 10/3 補記，和最新那次匯入帶進來的 10/3 那筆重複`);
  });
});

/* ═════════════════════════ 評審自己找的 ═════════════════════════ */

describe("評審自己找的", () => {
  test("R10. 實體化決定性：規則順序打亂 ⇒ 依 id 排序後逐列相同；兩台 nowIso／游標不同 ⇒ 共同的 id 內容只差時間戳", () => {
    const rs = [
      rep("ra", fixedRule("daily", "2026-10-15")),
      rep("rb", fixedRule("weekly", "2026-10-01", { byweekday: [1, 3, 5] })),
      rep("rc", fixedRule("monthly", "2026-08-31", { bymonthday: [31] })),
    ];
    const base = P.planMaterialize(rs, new Set(), TODAY, CTX, NOW, DSH);
    const sortRows = (xs: EntryRow[]) => xs.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = 0; i < 6; i++) {
      const sh = rs.slice().sort(() => (((i * 7919) % 3) - 1));
      assert.deepEqual(sortRows(P.planMaterialize(sh, new Set(), TODAY, CTX, NOW, DSH).inserts), sortRows(base.inserts));
    }
    // 另一台：游標比較後面、時間不同
    const other = P.planMaterialize(rs.map((r) => ({ ...r, next_on: "2026-10-17" })), new Set(), TODAY, CTX, "2026-10-19T05:00:00.000Z", DSH);
    const strip = (e: EntryRow) => ({ ...e, created_at: "", updated_at: "" });
    const mine = byId(base.inserts);
    for (const e of other.inserts) assert.deepEqual(strip(e), strip(mine[e.id]), e.id);
  });

  for (const impl of IMPLS) {
    test(`R11. neverStarted 刷新：開始過、記的帳又被刪光（只剩墓碑）⇒ 再暫停＋重匯不能把游標刷回財務管家的（${impl.name}）`, async () => {
      const { repo } = await impl.make();
      await repo.ensureStarterRows();
      const a1 = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      await repo.applyImport(a1.plan, T.defaultChoices(a1.plan), a1.part, () => {});
      await repo.resumeAllRepeats(TODAY);
      assert.equal((await repo.materializeRepeats(TODAY, 6)).inserted, 1, "mm-r3 補記 10/16");
      const r3 = (await repo.listRepeats()).find((x: RepeatRow) => x.import_id === "mm-r3")!;
      await repo.softDeleteEntry(P.materializeId(r3.id, "2026-10-16"));
      await repo.setRepeatPaused(r3.id, true, TODAY);
      const before = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r3.id)!.next_on;
      const d = dump3();
      d.repeats![2].next_date = new Date(2026, 11, 16, 21, 15).getTime();
      d.repeats![2].usetime += 1;
      const a2 = P.planImportAll(d, await repo.loadImportLocal(), planOpts());
      const up = a2.part.repeats.updates.find((u) => u.id === r3.id);
      assert.ok(!up || !("next_on" in up.cols), "開始過（有墓碑指向它）⇒ next_on 不刷");
      await repo.applyImport(a2.plan, T.defaultChoices(a2.plan), a2.part, () => {});
      assert.equal((await repo.listRepeats()).find((x: RepeatRow) => x.id === r3.id)!.next_on, before);
      // 開始 ⇒ 手建語義（明天起），不是接財務管家
      await repo.setRepeatPaused(r3.id, false, TODAY);
      const after = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r3.id)!;
      assert.equal(after.next_on, R.nextFixedDate(P.parseFixedRule(after.rule)!, TODAY));
    });
  }

  for (const impl of IMPLS) {
    test(`R12. 墓碑不復活：刪一筆 → skipped_days 被 LWW 蓋空 → 規則刪了又復原 → 重匯 ⇒ 那筆還是墓碑、帳 0 op（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, "2026-10-17"));
      await repo.materializeRepeats(TODAY, 6);
      const id = P.materializeId(r.id, "2026-10-18");
      await repo.softDeleteEntry(id);
      await forceRepeatCols(repo, db, r.id, { skipped_days: "[]" });
      await repo.softDeleteRepeat(r.id);
      await repo.restoreRepeat(r.id);
      const m0 = opCount(db);
      const res = await repo.materializeRepeats(TODAY, 6);
      assert.equal(res.inserted, 0);
      assert.notEqual((await entryAny(repo, id))!.deleted_at, null);
      if (db) assert.equal(db.ops.slice(m0).filter((o) => o.tbl === "tk_entries").length, 0);
    });
  }

  for (const impl of IMPLS) {
    test(`R13. 刪掉一筆「改過日期」的定期帳 ⇒ 不能誤刪同規則另一天的帳；skipped_days 要記班次日（${impl.name}）`, async () => {
      const { repo, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, "2026-10-17"));
      await repo.materializeRepeats(TODAY, 6); // 10/17、10/18、10/19
      const moved = P.materializeId(r.id, "2026-10-17");
      const real18 = P.materializeId(r.id, "2026-10-18");
      // 使用者把 10/17 那筆改到 10/18（0-8：要回頭改就自己改那筆）
      await repo.updateEntry(moved, { occurredOn: "2026-10-18", occurredAt: atOf("2026-10-18", "09:00", 6) });
      await repo.softDeleteEntry(moved);
      await repo.materializeRepeats(TODAY, 6); // 下一輪（reconcile）
      assert.notEqual(await repo.getEntry(real18), null, "10/18 自己那一班被 reconcile 誤刪了");
      assert.deepEqual(P.parseSkipped((await repo.listRepeats())[0].skipped_days), ["2026-10-17"], "skipped_days 記的是 occurred_on，不是班次日");
    });
  }

  for (const impl of IMPLS) {
    test(`R14. 0-7 守法對「改過日期」的帳失效：A 刪了它、B 離線復活 ⇒ reconcile 要把它再刪掉（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, "2026-10-17"));
      await repo.materializeRepeats(TODAY, 6);
      const moved = P.materializeId(r.id, "2026-10-17");
      await repo.updateEntry(moved, { occurredOn: "2026-10-16", occurredAt: atOf("2026-10-16", "09:00", 6) });
      await repo.softDeleteEntry(moved);
      await forceAlive(repo, db, moved); // 引擎「編輯勝刪除」復活
      await repo.materializeRepeats(TODAY, 6);
      assert.equal(await repo.getEntry(moved), null, "復活的那筆沒被 reconcile 收掉（skipped_days 記成 10/16，算出的 id 對不到）");
    });
  }

  for (const impl of IMPLS) {
    test(`R13c. 同一類：「設成定期」連上的那筆（起算日改成它那天）被刪 ⇒ 不能連同那天實體化的帳一起刪（${impl.name}）`, async () => {
      const { repo, acc, lunch } = await setup(impl);
      const src = await repo.createEntry({
        kind: "expense", amountMinor: 1200000, currency: "TWD", accountId: acc.id, toAccountId: null, categoryId: lunch.id,
        occurredOn: "2026-10-01", occurredAt: atOf("2026-10-01", "09:00", 6), note: "房租", routeId: null,
      });
      // 編輯器把起算日從 ruleFromEntry 的隔天改回 10/1（RepeatDraft.start 可改）
      const r = await repo.createRepeat(dailyInput(acc.id, lunch.id, "2026-10-01", { rule: fixedRule("monthly", "2026-10-01", { bymonthday: [1] }), amountMinor: 1200000 }));
      await repo.linkEntryToRepeat(src.id, r.id);
      await repo.materializeRepeats(TODAY, 6); // 10/1 那一班
      const mat = P.materializeId(r.id, "2026-10-01");
      assert.notEqual(await repo.getEntry(mat), null, "前提：10/1 實體化了一筆");
      await repo.softDeleteEntry(src.id); // 使用者刪掉原本那筆
      await repo.materializeRepeats(TODAY, 6);
      assert.notEqual(await repo.getEntry(mat), null, "刪原本那筆，實體化的 10/1 也被 reconcile 刪掉");
    });
  }

  test("R15. 已結束的長規則（超過 400 班）⇒ 每一輪實體化不該來回改游標（null ↔ 過去的某天）", () => {
    const rule = { ...fixedRule("daily", "2024-06-01"), until: "2025-12-31" };
    const ids = new Set(daysBetween("2024-06-01", "2025-12-31").map((d) => P.materializeId("rend", d)));
    const ended = rep("rend", rule, { next_on: null });
    const res = P.planMaterialize([ended], ids, TODAY, CTX, NOW, DSH);
    assert.deepEqual(res.inserts, []);
    assert.deepEqual(res.cursors, [], `已結束的規則被寫回游標 ${JSON.stringify(res.cursors)}（next_on null ⇒ from＝start 又掃 400 班）`);
  });

  for (const impl of IMPLS) {
    test(`R15b. 同上，走 repository：記完之後再跑兩輪 ⇒ 游標維持 null、不發 op（${impl.name}）`, async () => {
      const { repo, db, acc, lunch } = await setup(impl);
      const input = dailyInput(acc.id, lunch.id, "2024-06-01");
      input.rule = { ...input.rule, until: "2025-12-31" };
      const r = await repo.createRepeat(input);
      await repo.materializeRepeats(TODAY, 6); // 前 400 班
      await repo.materializeRepeats(TODAY, 6); // 其餘
      assert.equal((await repo.listRepeats())[0].next_on, null, "前提：記完了、已結束");
      const m0 = opCount(db);
      await repo.materializeRepeats(TODAY, 6);
      const third = (await repo.listRepeats()).find((x: RepeatRow) => x.id === r.id)!.next_on;
      if (db) assert.equal(db.ops.length, m0, "第三輪不該發 op");
      assert.equal(third, null, `第三輪把游標改成 ${third}`);
    });
  }

  test("R16. 跨日界線：hhmm 在日界線之前（03:00、日界線 6 點）⇒ 手建規則的帳 occurred_at 和①表單同一把尺；匯入規則維持字面時刻（和①匯入的帳一致）", () => {
    // ✎-7 改（主 session 10-19 定）：手建的規則套日界線；import_source＝moneymanager 的規則字面時刻
    const r = rep("rn", fixedRule("daily", TODAY), { hhmm: "03:00", next_on: TODAY });
    const [row] = P.planMaterialize([r], new Set(), TODAY, CTX, NOW, DSH).inserts;
    // ①的表單（TicketPanel／MobileEntryForm）：time＝localTime(occurred_at)，存檔／改日期時 occurredAt＝atOf(日, time, dayStartHour)
    const formAt = atOf(row.occurred_on, localTime(row.occurred_at), DSH);
    assert.equal(row.occurred_at, formAt, "手建規則用字面時刻（10/19 03:00），表單同一筆算出 10/20 03:00：一改日期就跳一天、和手記的凌晨帳排序也相反");
    assert.equal(row.occurred_at, new Date(2026, 9, 20, 3, 0).toISOString(), "帳日 10/19 的 03:00（日界線 6 點）＝日曆 10/20 03:00");
    assert.equal(row.occurred_on, TODAY, "班次日（帳日）不變");
    // 匯入的規則：①匯入財務管家的帳 occurred_at＝ZDATE 實際時刻（不套日界線），實體化的帳跟它一致
    const mm = rep("rm", fixedRule("daily", TODAY), { hhmm: "03:00", next_on: TODAY, import_source: "moneymanager", import_id: "mm-x", import_utime: 1 });
    const [mrow] = P.planMaterialize([mm], new Set(), TODAY, CTX, NOW, DSH).inserts;
    assert.equal(mrow.occurred_at, atOf(TODAY, "03:00", 0), "匯入規則要字面時刻（10/19 03:00）");
    assert.equal(mrow.occurred_on, TODAY);
    assert.equal(mrow.id, P.materializeId("rm", TODAY), "id 只看班次日、和時刻無關");
  });

  test("R17. 先拉後記（0-6-1(b)）：ticket.mount 要填 afterPull 叫 materialize（整合席；現在註解還寫「不填」）", () => {
    const src = readFileSync(path.join(ROOT, "src/lines/ticket.mount.tsx"), "utf8");
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(code, /afterPull\s*:[^,}]*materialize\(\s*["']afterPull["']\s*\)/, "沒有 afterPull ⇒ 拉完不 reconcile，0-7 第 3 層只在啟動／跨日／手動才跑");
  });

  test("R18. 先拉後記（0-6-2）的競態：同步 status 還沒載入（booting）時，TicketAgent 不能當成「沒加入同步」直接跑", () => {
    const src = readFileSync(path.join(ROOT, "src/ui/ticket/TicketAgent.tsx"), "utf8");
    const fn = /function scheduleStartup\(\)[\s\S]*?\r?\n}\r?\n/.exec(src); // \r?：CRLF checkout 不假紅
    assert.ok(fn, "找不到 scheduleStartup");
    assert.match(fn[0], /booting/, "scheduleStartup 只看 status?.configured；syncStore.status 初值是 null（booting: true），warm() 比 boot() 先完成時就跳過先拉後記");
  });

  test("R19. 超支不到 0.5 元（主幣別有小數）⇒ 卡上不該寫「超支 0」", () => {
    const es = [ent({ occurred_on: "2026-10-02", amount_minor: 100040 })];
    const [line] = P.budgetLines([P.budgetRow({ kind: "total" }, null, 100000, 0, NOW)], es, "2026-10", CATS, TODAY, CTX);
    assert.equal(line.over, true);
    assert.notEqual(P.budgetText(line, 2).rest, "超支 0", "over＝true 卻寫「超支 0」");
  });
});

/* ═════════ 沙盒代驗（2026-10-19）之後的小修：D2、O1 ═════════ */

describe("沙盒代驗後：D2 匯入跳過的墓碑要說出來", () => {
  test("D2a. 純函式：墓碑列不算進 scopes／overrides；tombLine 三種寫法、0 個不出", () => {
    const { plan, part } = P.planImportAll(dump3(), emptyLocal(), planOpts());
    const local = part.budgets.inserts;
    // 點心只有預設一列 ⇒ 刪了就少一個對象
    const snackId = plan.categoryIdOf["mm-ce0-4"];
    const snackTomb = local.filter((x) => x.category_id === snackId).map((x) => ({ ...x, deleted_at: NOW }));
    const again = P.planBudgetImport(dump3(), plan, snackTomb, NOW);
    assert.deepEqual([again.tombstoned, again.inserts.length, again.scopes, again.overrides], [1, 4, 2, 2]);
    // 食物的預設＋覆寫都刪 ⇒ 對象少一個、覆寫少一個
    const foodId = plan.categoryIdOf["mm-ce0"];
    const foodTomb = local.filter((x) => x.category_id === foodId).map((x) => ({ ...x, deleted_at: NOW }));
    const f = P.planBudgetImport(dump3(), plan, foodTomb, NOW);
    assert.deepEqual([f.tombstoned, f.inserts.length, f.scopes, f.overrides], [2, 3, 2, 1]);
    // 文案
    assert.equal(P.PLAN_TEXT.tombLine(0, 0), null);
    assert.equal(P.PLAN_TEXT.tombLine(2, 0), "略過 2 個（這台刪過）");
    assert.equal(P.PLAN_TEXT.tombLine(0, 1), "略過 1 條（這台刪過）");
    assert.equal(P.PLAN_TEXT.tombLine(1, 3), "略過 1 個 · 3 條（這台刪過）");
    assert.equal(P.partSummary(part).tombLine, null, "乾淨庫 ⇒ 不出");
  });

  for (const impl of IMPLS) {
    test(`D2b. 沙盒重現：設總預算 → 移除 → 匯入 ⇒ 總預算預設不復活、預覽不算它、有「略過 1 個（這台刪過）」；寫入後結果卡同一行（${impl.name}）`, async () => {
      const { repo } = await impl.make();
      await repo.ensureStarterRows();
      await repo.setBudget({ kind: "total" }, null, 2000000);
      await repo.removeBudget({ kind: "total" }, null);
      assert.equal((await repo.listBudgets()).length, 0);
      const a = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      const b = a.part.budgets;
      const totalDefault = P.budgetId({ kind: "total" }, null);
      assert.equal(b.tombstoned, 1);
      assert.ok(!b.inserts.some((x) => x.id === totalDefault) && !b.updates.some((x) => x.id === totalDefault), "墓碑不復活");
      assert.equal(b.inserts.length, 4);
      // 總預算這個對象還有 2026-01 的覆寫要進來 ⇒ 對象仍是 3 個；墓碑那一列（預設，不是覆寫）不算
      assert.deepEqual([b.scopes, b.overrides], [3, 2]);
      const sum = P.partSummary(a.part);
      assert.equal(sum.budgetLine, "預算 3 個（2 個單月覆寫）");
      assert.equal(sum.tombLine, "略過 1 個（這台刪過）");
      const out = await repo.applyImport(a.plan, T.defaultChoices(a.plan), a.part, () => {});
      assert.equal(out.budgets, 4);
      const live = await repo.listBudgets();
      assert.equal(live.length, 4);
      assert.ok(!live.some((x: BudgetRow) => x.id === totalDefault), "寫入後總預算預設仍是墓碑");
      // 再匯一次：墓碑還在 ⇒ 照樣說；其餘 unchanged
      const a2 = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      assert.deepEqual([a2.part.budgets.tombstoned, a2.part.budgets.unchanged, a2.part.budgets.scopes], [1, 4, 0]);
      assert.equal(P.partSummary(a2.part).tombLine, "略過 1 個（這台刪過）");
    });
  }

  for (const impl of IMPLS) {
    test(`D2c. 定期規則比照：匯入後刪一條 → 重匯 ⇒ 不復活、「略過 1 條（這台刪過）」；和預算一起 ⇒「略過 1 個 · 1 條」（${impl.name}）`, async () => {
      const { repo } = await impl.make();
      await repo.ensureStarterRows();
      const a1 = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      await repo.applyImport(a1.plan, T.defaultChoices(a1.plan), a1.part, () => {});
      const r1 = (await repo.listRepeats()).find((x: RepeatRow) => x.import_id === "mm-r1")!;
      await repo.softDeleteRepeat(r1.id);
      const a2 = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      assert.deepEqual([a2.part.repeats.tombstoned, a2.part.repeats.inserts.length, a2.part.repeats.updates.length], [1, 0, 0]);
      assert.equal(P.partSummary(a2.part).repeatLine, "定期 0 條");
      assert.equal(P.partSummary(a2.part).tombLine, "略過 1 條（這台刪過）");
      await repo.removeBudget({ kind: "category", categoryId: a1.plan.categoryIdOf["mm-ce0-4"] }, null);
      const a3 = P.planImportAll(dump3(), await repo.loadImportLocal(), planOpts());
      assert.equal(P.partSummary(a3.part).tombLine, "略過 1 個 · 1 條（這台刪過）");
      await repo.applyImport(a3.plan, T.defaultChoices(a3.plan), a3.part, () => {});
      assert.ok(!(await repo.listRepeats()).some((x: RepeatRow) => x.id === r1.id), "規則墓碑不復活");
    });
  }
});

describe("沙盒代驗後：O1 月曆「超」和預算卡對齊", () => {
  const B = 100000; // 總預算 1,000
  const card = (es: EntryRow[]) => P.budgetLines([P.budgetRow({ kind: "total" }, null, B, 0, NOW)], es, "2026-10", CATS, TODAY, CTX)[0];
  /** 每個情境都對一次：月曆有「超」⇔ 卡上 over */
  const check = (es: EntryRow[], want: string | null, msg: string) => {
    const got = P.overBudgetDay(es, "2026-10", B);
    assert.equal(got, want, msg);
    assert.equal(got !== null, card(es).over, `${msg}：月曆和卡對不上`);
  };
  const e = (d: string, n: number) => ent({ occurred_on: `2026-10-${d}`, amount_minor: n });

  test("O1a. 只超一次 ⇒ 標越過那天（之後再花也不搬）", () => {
    check([e("02", 60000), e("09", 50000)], "2026-10-09", "10/09 累計 1,100 越過");
    check([e("02", 60000), e("09", 50000), e("12", 30000)], "2026-10-09", "越過之後一直在上面 ⇒ 不搬");
    check([e("02", 120000)], "2026-10-02", "一筆就超");
  });
  test("O1b. 超了被退款拉回 ⇒ 不標（卡寫「剩」）", () => {
    check([e("02", 60000), e("09", 50000), e("12", -20000)], null, "退款拉回 900");
    assert.equal(P.budgetText(card([e("02", 60000), e("09", 50000), e("12", -20000)]), 2).rest, "剩 100");
  });
  test("O1c. 拉回又超 ⇒ 標後面那次越過的日子", () => {
    check([e("02", 60000), e("09", 50000), e("12", -20000), e("20", 30000)], "2026-10-20", "10/12 拉回 900、10/20 1,200 再越過");
    // 同一天先退款再花（同日合計後比）：10/12 當天淨 +5,000 ⇒ 不算拉回，仍標 10/09
    check([e("02", 60000), e("09", 50000), e("12", -20000), e("12", 25000)], "2026-10-09", "同日合計");
  });
  test("O1d. 等於預算不算：剛好 1,000 ⇒ 不標；超過後被拉回剛好 1,000 ⇒ 不標；從剛好 1,000 再多 1 分 ⇒ 標那天", () => {
    check([e("02", 60000), e("09", 40000)], null, "剛好等於");
    check([e("02", 60000), e("09", 50000), e("12", -10000)], null, "拉回到剛好等於");
    check([e("02", 60000), e("09", 50000), e("12", -10000), e("15", 1)], "2026-10-15", "從等於越到 > ⇒ 算一次越過");
  });
  test("O1e. 別月的帳、收入、已刪的帳不影響（和卡同口徑）", () => {
    const es = [
      e("02", 60000),
      e("09", 50000),
      ent({ occurred_on: "2026-09-30", amount_minor: 999999 }),
      ent({ occurred_on: "2026-10-10", kind: "income", amount_minor: 999999, category_id: "c-salary" }),
      ent({ occurred_on: "2026-10-11", amount_minor: -50000, deleted_at: NOW }),
    ];
    check(es, "2026-10-09", "只看 10 月支出、未刪");
  });
});

void UNCAT_INCOME_ID;
void serializeRule;
