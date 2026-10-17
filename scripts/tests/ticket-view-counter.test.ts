/**
 * 售票口②「看帳」資料層評審席的反例測試（②契約 2026-10-15 §0 口徑 0-6～0-11、0-14～0-16、0-19、0-22；§3、§4）。
 * 跑法：`node --test scripts/tests/ticket-view-counter.test.ts`（node 24，型別剝除；零依賴）。
 *
 * 這個檔只有評審席改。**會失敗的測試是刻意留著的反例**（給甲席看「預期 vs 實際」），不是壞掉的測試；
 * 標題前綴【反例】的那幾條在寫下時是紅的，其他全綠的也保留（鎖住評審查過的邊角）。
 *
 * 結構：
 *   R1～R13 純函式反例（退款多於支出、同日兩筆 USD、跨年趨勢、未細分、封存、墓碑、路線已刪、轉帳校正、
 *            compactMoney 邊界、月曆週起算、SQL vs TS、空資料、文字口徑）
 *   S1～S8  ticketStore 第②階段（替身 repo／uiStore／nodeStore；不碰真 DB）：searchEntries 不動頁面狀態、
 *            側欄篩帳戶 × 三視圖、年模式切年、下鑽、jumpToDay、寫入後重查、路線花費的競態
 *
 * 載入法照 ticket-view-logic.test.ts：registerHooks 補 `.ts`、替身 `../lib/db`／`./syncRepository`；
 * store 另外把 `../data/ticketRepository`／`./uiStore`／`./nodeStore` 換成 data: 模組（委派給 globalThis 上的替身）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/* ───────── 載入替身 ───────── */

const FAKE_DB = `
let t = Date.UTC(2026, 9, 12, 1, 0, 0);
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
/** 迷你 zustand 形狀（getState／setState／subscribe(s, prev)）；data: 模組不能再 import 裸名 */
const MINI_STORE = `
function mk(init) {
  let s = init; const ls = new Set();
  return {
    getState: () => s,
    setState: (p) => { const prev = s; s = { ...s, ...(typeof p === "function" ? p(s) : p) }; for (const l of ls) l(s, prev); },
    subscribe: (l) => { ls.add(l); return () => ls.delete(l); },
  };
}
`;
const FAKE_UI = `${MINI_STORE}
export const useUiStore = mk({
  dayStartHour: 0, weekStart: 1, toasts: [],
  showToast(t) { useUiStore.setState({ toasts: useUiStore.getState().toasts.concat([t]) }); },
  async askConfirm() { return true; },
});
globalThis.__uiStore = useUiStore;
`;
const FAKE_NODE = `${MINI_STORE}
export const useNodeStore = mk({ routes: [] });
globalThis.__nodeStore = useNodeStore;
`;
const FAKE_REPO = `
export const ticketRepo = new Proxy({}, { get: (_, k) => (...a) => globalThis.__tkRepo[k](...a) });
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? "";
    const fromSrc = parent.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (parent.includes("/src/store/ticketStore")) {
        if (specifier === "../data/ticketRepository") return { url: dataUrl(FAKE_REPO), shortCircuit: true };
        if (specifier === "./uiStore") return { url: dataUrl(FAKE_UI), shortCircuit: true };
        if (specifier === "./nodeStore") return { url: dataUrl(FAKE_NODE), shortCircuit: true };
      }
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

import type { AccountRow, CategoryKind, CategoryRow, CurrencyRow, EntryKind, EntryRow } from "../../src/domain/ticket.ts";
import type { CalendarCell, EntryFilter, EntryQuery, Period, RouteRef, ViewCtx } from "../../src/domain/ticketView.ts";

const T = await import("../../src/domain/ticket.ts");
const V = await import("../../src/domain/ticketView.ts");
const { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, groupByDay, monthSum, ticketId, moneyText, addMonths, monthOf, monthRange } = T;
const {
  EMPTY_FILTER,
  GONE_KEY,
  NO_ROUTE_KEY,
  UNSPLIT_KEY,
  asideText,
  breakdown,
  calendarCells,
  categoryIdsIncluding,
  cellText,
  compactMoney,
  dayStep,
  filterChips,
  filterEntries,
  filterToQuery,
  isFilterActive,
  keywordTokens,
  matchesKeyword,
  matchesQuery,
  monthGrid,
  monthlyTrend,
  nearestDayWithEntries,
  newestFirst,
  periodOf,
  periodRange,
  periodTitle,
  resultSummary,
  routeCtx,
  routeSpendOf,
  spendText,
  statsOverview,
  stepPeriod,
  trendMonths,
  trendRange,
  weekdayHeads,
} = V;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const NOW = new Date(2026, 9, 12, 9, 0).toISOString();
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };

/* ───────── fixture（形狀同 ticket-view-logic；自己一份，互不牽動） ───────── */

function cur(code: string, decimals: number, rate: string, isMain = false): CurrencyRow {
  return { id: ticketId("currency:" + code), code, name: code, decimals, rate_to_main: rate, is_main: isMain ? 1 : 0, position: 0, ...SYNC };
}
function acc(id: string, name: string, group: string, position: number, currency = "TWD", extra: Partial<AccountRow> = {}): AccountRow {
  return { id, name, group_key: group, currency, position, archived_at: null, ...SYNC, ...extra };
}
function cat(id: string, kind: CategoryKind, name: string, parent: string | null, position: number, extra: Partial<CategoryRow> = {}): CategoryRow {
  return { id, kind, name, parent_id: parent, position, archived_at: null, ...SYNC, ...extra };
}
function byId<T extends { id: string }>(rows: readonly T[]): Record<string, T> {
  const o: Record<string, T> = {};
  for (const r of rows) o[r.id] = r;
  return o;
}

const CURRENCIES = [cur("TWD", 2, "1", true), cur("USD", 2, "31.55"), cur("JPY", 0, "0.21")];
const ACCOUNTS = [
  acc("a-cash", "現金", "cash", 0),
  acc("a-bank", "帳戶", "bank", 0),
  acc("a-student", "學生證", "bank", 1),
  acc("a-card", "信用卡", "card", 0),
  acc("a-usd", "美金帳戶", "bank", 3, "USD"),
  acc("a-jpy", "日圓錢包", "cash", 2, "JPY"),
  acc("a-old", "舊錢包", "cash", 1, "TWD", { archived_at: NOW }),
];
const CATEGORIES = [
  cat(UNCAT_EXPENSE_ID, "expense", "未分類", null, 9999),
  cat(UNCAT_INCOME_ID, "income", "未分類", null, 9999),
  cat("p-food", "expense", "🍜 食物", null, 0),
  cat("c-lunch", "expense", "午餐", "p-food", 0),
  cat("c-dinner", "expense", "晚餐", "p-food", 1),
  cat("c-food-del", "expense", "宵夜", "p-food", 2, { deleted_at: NOW }),
  cat("p-traffic", "expense", "🚖 交通", null, 1),
  cat("c-bus", "expense", "公車", "p-traffic", 0),
  cat("p-life", "expense", "🪑 生活", null, 2),
  cat("c-rent", "expense", "房租", "p-life", 0, { archived_at: NOW }),
  cat("c-groc", "expense", "雜貨", "p-life", 1),
  cat("p-cloth", "expense", "🧥 服飾", null, 3),
  cat("c-clothes", "expense", "服裝", "p-cloth", 0),
  cat("p-arch", "expense", "🎮 舊遊戲", null, 4, { archived_at: NOW }),
  cat("c-arch-kid", "expense", "卡帶", "p-arch", 0, { archived_at: NOW }),
  cat("p-other", "expense", "其他", null, 5),
  cat("i-allow", "income", "💵 生活費", null, 0),
  cat("i-salary", "income", "💳 薪水", null, 1),
];
const ROUTES: RouteRef[] = [
  { id: "r-j", name: "日文", code: "J", color: "var(--route-preset-2)" },
  { id: "r-e", name: "全端開發", code: "E1", color: "var(--route-preset-1)" },
  { id: "r-l", name: "體能", code: "L2", color: null },
];
const curByCode: Record<string, CurrencyRow> = {};
for (const c of CURRENCIES) curByCode[c.code] = c;
const ALIVE_CATS = CATEGORIES.filter((c) => c.deleted_at === null);
/** store 的 catById／accById 只有未刪的列（含封存）——比照 */
const CTX: ViewCtx = { accById: byId(ACCOUNTS), catById: byId(ALIVE_CATS), curByCode, routeById: byId(ROUTES), routeOrder: ROUTES.map((r) => r.id) };

let seq = 0;
/** 一筆帳（預設：TWD 支出 80、午餐、現金、中午） */
function E(p: Partial<EntryRow> & { occurred_on: string }): EntryRow {
  const [y, m, d] = p.occurred_on.split("-").map((s) => parseInt(s, 10));
  const main = p.main_minor ?? p.amount_minor ?? 8000;
  const amount = p.amount_minor ?? main;
  seq++;
  return {
    id: `x${String(seq).padStart(4, "0")}`,
    kind: "expense",
    occurred_at: new Date(y, m - 1, d, 12, seq % 60).toISOString(),
    account_id: "a-cash",
    to_account_id: null,
    category_id: "c-lunch",
    amount_minor: amount,
    currency: "TWD",
    main_minor: main,
    account_minor: amount,
    to_amount_minor: null,
    note: "",
    route_id: null,
    import_id: null,
    import_source: null,
    import_utime: null,
    ...SYNC,
    ...p,
  };
}
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const OCT = periodRange({ span: "month", key: "2026-10" });
const allRows = (b: { rows: { minor: number; share: number; children?: { minor: number; share: number }[] }[]; refunds: { minor: number; share: number; children?: { minor: number; share: number }[] }[] }) =>
  b.rows.concat(b.refunds).flatMap((r) => [r, ...(r.children ?? [])]);

/* ═════════════════════════ R. 純函式反例 ═════════════════════════ */

describe("R1 退款多於支出的分類（淨退回，0-8）", () => {
  test("R1a 主分類淨額為負 ⇒ 整列含 children 進 refunds、不入分母；淨額剛好 0 也算淨退回；rows＋refunds 合計＝statsOverview 支出", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", category_id: "c-lunch", amount_minor: 10000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-dinner", amount_minor: -30000, note: "訂位退款" }),
      E({ occurred_on: "2026-10-03", category_id: "c-bus", amount_minor: 5000 }),
      E({ occurred_on: "2026-10-04", category_id: "p-cloth", amount_minor: -50000, note: "退貨" }),
      E({ occurred_on: "2026-10-04", category_id: "c-clothes", amount_minor: 20000 }),
      E({ occurred_on: "2026-10-05", category_id: "c-groc", amount_minor: 700 }),
      E({ occurred_on: "2026-10-05", category_id: "c-groc", amount_minor: -700 }),
    ];
    const b = breakdown(xs, OCT, "category", "expense", CTX);
    assert.deepEqual(b.rows.map((r) => r.key), ["p-traffic"]);
    assert.equal(b.total, 5000);
    assert.equal(b.rows[0].share, 1);
    assert.deepEqual(b.refunds.map((r) => [r.key, r.minor]), [["p-cloth", -30000], ["p-food", -20000], ["p-life", 0]]);
    for (const r of allRows({ rows: [], refunds: b.refunds })) assert.equal(r.share, 0);
    const food = b.refunds.find((r) => r.key === "p-food");
    assert.deepEqual(food?.children?.map((c) => [c.key, c.minor]), [["c-lunch", 10000], ["c-dinner", -30000]]);
    const cloth = b.refunds.find((r) => r.key === "p-cloth");
    assert.deepEqual(cloth?.children?.map((c) => [c.key, c.minor]), [["c-clothes", 20000], [UNSPLIT_KEY, -50000]]);
    const sum = b.rows.concat(b.refunds).reduce((n, r) => n + r.minor, 0);
    assert.equal(sum, statsOverview(xs, OCT).expense);
  });
  test("【反例】R1b 主分類為正、某個子分類淨退回 ⇒ 兄弟子分類的 share 不得超過 1（§4.1 share 0～1；條長會超過 100%）", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", category_id: "c-lunch", amount_minor: 10000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-dinner", amount_minor: -3000 }),
    ];
    const b = breakdown(xs, OCT, "category", "expense", CTX);
    assert.equal(b.total, 7000);
    for (const r of allRows(b)) assert.ok(r.share >= 0 && r.share <= 1, `${JSON.stringify(r)} 的 share 超出 0～1`);
  });
  test("R1c 全部為負 ⇒ rows 空、total 0；shareText 只吃 0", () => {
    const xs = [E({ occurred_on: "2026-10-02", amount_minor: -100 }), E({ occurred_on: "2026-10-02", category_id: "c-bus", amount_minor: -1 })];
    const b = breakdown(xs, OCT, "category", "expense", CTX);
    assert.deepEqual([b.rows.length, b.total, b.refunds.length], [0, 0, 2]);
  });
});

describe("R2 同一天兩筆 USD（0-7-4：一律 main_minor）", () => {
  const usd1 = E({ occurred_on: "2026-10-07", currency: "USD", account_id: "a-usd", amount_minor: 1000, main_minor: 31550, account_minor: 1000, category_id: "c-groc", note: "App Store" });
  const usd2 = E({ occurred_on: "2026-10-07", currency: "USD", account_id: "a-usd", amount_minor: 250, main_minor: 7888, account_minor: 250, category_id: "c-lunch", note: "coffee" });
  const twd = E({ occurred_on: "2026-10-07", amount_minor: 10000 });
  const xs = [usd1, usd2, twd];
  test("R2a 月曆格、日分組、總覽、趨勢、帳戶切面都用 main_minor 合計", () => {
    const cell = calendarCells(xs, "2026-10", 1, "2026-10-16").flat().find((c) => c.dayKey === "2026-10-07") as CalendarCell;
    assert.deepEqual([cell.expense, cell.count], [31550 + 7888 + 10000, 3]);
    assert.equal(groupByDay(xs.slice().sort(newestFirst), null)[0].expense, cell.expense);
    assert.equal(statsOverview(xs, OCT).expense, cell.expense);
    assert.equal(monthlyTrend(xs, ["2026-10"])[0].expense, cell.expense);
    const b = breakdown(xs, OCT, "account", "expense", CTX);
    assert.deepEqual(b.rows.map((r) => [r.key, r.minor, r.count]), [["a-usd", 39438, 2], ["a-cash", 10000, 1]]);
    assert.deepEqual(cellText(cell, 2, false), { expense: "494", income: null }); // 494.38 → 494
  });
  test("R2b 數字 token：原幣「10」「2.5」「2.50」與折算「315.5」「78.88」都命中；「1000」（最小單位）不命中", () => {
    const hit = (t: string, e: EntryRow) => matchesKeyword(e, keywordTokens(t), CTX);
    assert.ok(hit("10", usd1));
    assert.ok(hit("10.00", usd1));
    assert.ok(hit("315.5", usd1));
    assert.ok(hit("315.50", usd1));
    assert.ok(hit("2.5", usd2));
    assert.ok(hit("2.50", usd2));
    assert.ok(hit("78.88", usd2));
    assert.ok(!hit("1000", usd1));
    assert.ok(!hit("31550", usd1));
    assert.deepEqual(filterEntries(xs, { ...EMPTY_FILTER, text: "10", accountId: "a-usd" }, CTX).map((e) => e.id), [usd1.id]);
  });
  test("R2c JPY（0 位小數）：原幣 500 命中「500」、不命中「5」；折算主幣 1.05 命中「1.05」", () => {
    const jpy = E({ occurred_on: "2026-10-08", currency: "JPY", account_id: "a-jpy", amount_minor: 500, main_minor: 105, account_minor: 500 });
    const hit = (t: string) => matchesKeyword(jpy, keywordTokens(t), CTX);
    assert.ok(hit("500"));
    assert.ok(!hit("5"));
    assert.ok(hit("1.05"));
  });
});

describe("R3 年模式跨年的趨勢月序（0-6）", () => {
  test("R3a 月模式選 1 月 ⇒ 前一年 2 月 … 本年 1 月（舊到新、選中月最右）；去年 12 月的帳落在倒數第二根", () => {
    const p: Period = { span: "month", key: "2026-01" };
    const ms = trendMonths(p);
    assert.equal(ms.length, 12);
    assert.equal(ms[0], "2025-02");
    assert.equal(ms[11], "2026-01");
    for (let i = 1; i < 12; i++) assert.ok(ms[i - 1] < ms[i], `月序 ${ms[i - 1]} < ${ms[i]}`);
    const xs = [E({ occurred_on: "2025-12-31", amount_minor: 1234 }), E({ occurred_on: "2026-01-01", amount_minor: 99 }), E({ occurred_on: "2025-01-31", amount_minor: 7 })];
    const tr = monthlyTrend(xs, ms);
    assert.equal(tr[10].expense, 1234);
    assert.equal(tr[11].expense, 99);
    assert.equal(tr.reduce((n, x) => n + x.expense, 0), 1333); // 2025-01 在範圍外
    assert.deepEqual(trendRange(p), { from: "2025-02-01", toExcl: "2026-02-01" });
  });
  test("R3b 年模式 ⇒ 該年 1～12 月；stepPeriod 跨年；periodRange 年＝[YYYY-01-01, YYYY+1-01-01)；periodOf 取年", () => {
    const y = periodOf("2026-01", "year");
    assert.deepEqual(y, { span: "year", key: "2026" });
    assert.deepEqual(trendMonths(stepPeriod(y, -1)), ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12"]);
    assert.deepEqual(periodRange(stepPeriod(y, -1)), { from: "2025-01-01", toExcl: "2026-01-01" });
    assert.deepEqual(trendRange(y), periodRange(y));
    assert.equal(periodTitle(stepPeriod(y, 1)), "2027 年");
    assert.deepEqual(stepPeriod({ span: "month", key: "2026-01" }, -1), { span: "month", key: "2025-12" });
    assert.deepEqual(stepPeriod({ span: "month", key: "2025-12" }, 13), { span: "month", key: "2027-01" });
  });
});

describe("R4 主分類本身有帳又有子分類（未細分，0-8）", () => {
  test("R4a 直接掛主分類＋子分類（含封存子）⇒ children＝子各列＋未細分；children 合計＝主列；count 也對得上", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", category_id: "p-life", amount_minor: 3000 }),
      E({ occurred_on: "2026-10-03", category_id: "p-life", amount_minor: 3000 }),
      E({ occurred_on: "2026-10-03", category_id: "c-groc", amount_minor: 1000 }),
      E({ occurred_on: "2026-10-04", category_id: "c-rent", amount_minor: 500 }), // 封存的子分類照算
    ];
    const b = breakdown(xs, OCT, "category", "expense", CTX);
    const life = b.rows[0];
    assert.equal(life.key, "p-life");
    assert.equal(life.label, "🪑 生活");
    assert.deepEqual(life.children?.map((c) => [c.key, c.label, c.minor, c.count]), [
      [UNSPLIT_KEY, "未細分", 6000, 2],
      ["c-groc", "雜貨", 1000, 1],
      ["c-rent", "房租", 500, 1],
    ]);
    assert.equal(life.children?.reduce((n, c) => n + c.minor, 0), life.minor);
    assert.equal(life.children?.reduce((n, c) => n + c.count, 0), life.count);
  });
  test("R4b 主分類有子分類（樹上）但期間內只有直接掛主分類的帳 ⇒ 不出 children（主分類本身就是那一列）", () => {
    const b = breakdown([E({ occurred_on: "2026-10-02", category_id: "p-life", amount_minor: 3000 })], OCT, "category", "expense", CTX);
    assert.equal(b.rows[0].children, undefined);
  });
  test("R4c 已刪的子分類（墓碑、catById 沒有）的帳 ⇒ 不併進主分類，歸「（分類已不在）」且進分母、排最後", () => {
    const xs = [E({ occurred_on: "2026-10-02", category_id: "c-food-del", amount_minor: 900000 }), E({ occurred_on: "2026-10-02", category_id: "c-lunch", amount_minor: 100 })];
    const b = breakdown(xs, OCT, "category", "expense", CTX);
    assert.deepEqual(b.rows.map((r) => [r.key, r.label]), [["p-food", "🍜 食物"], [GONE_KEY, "（分類已不在）"]]);
    assert.equal(b.total, 900100);
  });
});

describe("R5 封存帳戶／分類（0-7-5：照算）", () => {
  test("R5a 封存帳戶、封存主分類＋封存子分類：統計照算、名稱照出、樹序排序；categoryIdsIncluding 展開封存子", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", account_id: "a-old", category_id: "c-arch-kid", amount_minor: 4000 }),
      E({ occurred_on: "2026-10-02", account_id: "a-old", category_id: "p-other", amount_minor: 4000 }),
    ];
    assert.equal(statsOverview(xs, OCT).expense, 8000);
    const bc = breakdown(xs, OCT, "category", "expense", CTX);
    assert.deepEqual(bc.rows.map((r) => [r.key, r.label, r.minor]), [["p-arch", "🎮 舊遊戲", 4000], ["p-other", "其他", 4000]]); // 同額照樹序：p-arch(4) 在 p-other(5) 前
  });
  test("R5b 只有一個子分類有帳 ⇒ children 照出（一列也出，跟「只有直接掛」不同）", () => {
    const b = breakdown([E({ occurred_on: "2026-10-02", category_id: "c-arch-kid", amount_minor: 4000 })], OCT, "category", "expense", CTX);
    assert.deepEqual(b.rows[0].children?.map((c) => c.key), ["c-arch-kid"]);
  });
  test("R5c 帳戶切面：封存帳戶照出名稱；篩選＝封存帳戶照查得到", () => {
    const xs = [E({ occurred_on: "2026-10-02", account_id: "a-old", amount_minor: 4000 })];
    assert.deepEqual(breakdown(xs, OCT, "account", "expense", CTX).rows.map((r) => r.label), ["舊錢包"]);
    assert.equal(filterEntries(xs, { ...EMPTY_FILTER, accountId: "a-old" }, CTX).length, 1);
    assert.deepEqual(categoryIdsIncluding(["p-arch"], ALIVE_CATS), ["p-arch", "c-arch-kid"]);
    assert.deepEqual(categoryIdsIncluding(["p-food"], ALIVE_CATS), ["p-food", "c-lunch", "c-dinner"]); // 墓碑子不展開
  });
});

describe("R6 墓碑（0-7-1）", () => {
  const live = E({ occurred_on: "2026-10-02", amount_minor: 1000, route_id: "r-j", note: "活的" });
  const dead = E({ occurred_on: "2026-10-02", amount_minor: 5000, route_id: "r-j", note: "刪掉的", deleted_at: NOW });
  const deadInc = E({ occurred_on: "2026-10-02", kind: "income", category_id: "i-allow", amount_minor: 7000, deleted_at: NOW });
  const xs = [live, dead, deadInc];
  test("R6a 統計、趨勢、月曆、占比（三切面）、路線花費、結構查詢、關鍵字查詢都不見墓碑", () => {
    assert.deepEqual(statsOverview(xs, OCT), { income: 0, expense: 1000, net: -1000, count: 1 });
    assert.deepEqual(monthlyTrend(xs, ["2026-10"])[0], { month: "2026-10", income: 0, expense: 1000 });
    const cell = calendarCells(xs, "2026-10", 0, "x").flat().find((c) => c.dayKey === "2026-10-02") as CalendarCell;
    assert.deepEqual([cell.expense, cell.income, cell.count], [1000, 0, 1]);
    for (const f of ["category", "account", "route"] as const) {
      assert.equal(breakdown(xs, OCT, f, "expense", CTX).total, 1000, f);
      assert.equal(breakdown(xs, OCT, f, "income", CTX).rows.length, 0, f);
    }
    assert.deepEqual(routeSpendOf(xs, "r-j", OCT), { inRange: 1000, allTime: 1000 });
    assert.deepEqual(xs.filter((e) => matchesQuery(e, filterToQuery(EMPTY_FILTER, ALIVE_CATS))).map((e) => e.id), [live.id]);
    assert.deepEqual(filterEntries(xs, { ...EMPTY_FILTER, text: "刪掉" }, CTX), []);
  });
  test("R6b 已刪的路線（routeCtx 丟掉墓碑）⇒ 路線切面歸「（路線已刪除）」、關鍵字不再命中舊路線名", () => {
    const nodes = [
      { id: "r-j", name: "日文", code: "J", color: null, deleted_at: null },
      { id: "r-dead", name: "吉他", code: "G", color: "x", deleted_at: NOW },
    ] as unknown as Parameters<typeof routeCtx>[0];
    const ctx: ViewCtx = { ...CTX, ...routeCtx(nodes) };
    const e = E({ occurred_on: "2026-10-02", route_id: "r-dead", amount_minor: 3000 });
    const b = breakdown([e], OCT, "route", "expense", ctx);
    assert.deepEqual(b.rows.map((r) => [r.key, r.label, r.color]), [[GONE_KEY, "（路線已刪除）", null]]);
    assert.ok(!matchesKeyword(e, keywordTokens("吉他"), ctx));
  });
});

describe("R7 route_id 指到已刪路線（0-7-6、0-8）", () => {
  test("R7a 兩條不同的已刪路線 ⇒ 合成一列「（路線已刪除）」；color null；進分母；未掛路線另一列", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", route_id: "r-ghost1", amount_minor: 3000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-ghost2", amount_minor: 2000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", amount_minor: 1000 }),
      E({ occurred_on: "2026-10-03", amount_minor: 4000 }),
    ];
    const b = breakdown(xs, OCT, "route", "expense", CTX);
    assert.deepEqual(b.rows.map((r) => [r.key, r.label, r.minor, r.count, r.color]), [
      [GONE_KEY, "（路線已刪除）", 5000, 2, null],
      [NO_ROUTE_KEY, "未掛路線", 4000, 1, null],
      ["r-j", "日文", 1000, 1, "var(--route-preset-2)"],
    ]);
    assert.equal(b.total, 10000);
  });
  test("R7b 篩選 chips／routeSpendOf／結構查詢對已刪路線照常運作", () => {
    const e = E({ occurred_on: "2026-10-02", route_id: "r-ghost1", amount_minor: 3000 });
    assert.deepEqual(filterChips({ ...EMPTY_FILTER, routeId: "r-ghost1" }, CTX), [{ key: "routeId", label: "路線 （路線已刪除）" }]);
    assert.deepEqual(routeSpendOf([e], "r-ghost1", OCT), { inRange: 3000, allTime: 3000 });
    assert.equal(filterEntries([e], { ...EMPTY_FILTER, routeId: "r-ghost1" }, CTX).length, 1);
    assert.equal(filterEntries([e], { ...EMPTY_FILTER, routeId: "none" }, CTX).length, 0);
  });
});

describe("R8 轉帳與校正不入收支（0-7-2）", () => {
  const xs = [
    E({ occurred_on: "2026-10-02", kind: "transfer", account_id: "a-bank", to_account_id: "a-card", category_id: null, amount_minor: 50000, to_amount_minor: 50000, route_id: "r-j" }),
    E({ occurred_on: "2026-10-02", kind: "adjust", category_id: null, amount_minor: -1200, route_id: "r-j" }),
    E({ occurred_on: "2026-10-02", kind: "adjust", category_id: "c-lunch", amount_minor: 900 }), // 校正誤帶分類也不入
    E({ occurred_on: "2026-10-02", amount_minor: 100 }),
  ];
  test("R8a 統計／趨勢／月曆 count／三切面／路線花費都只看那筆支出；搜尋摘要 N 含轉帳校正", () => {
    assert.deepEqual(statsOverview(xs, OCT), { income: 0, expense: 100, net: -100, count: 1 });
    const cell = calendarCells(xs, "2026-10", 1, "x").flat().find((c) => c.dayKey === "2026-10-02") as CalendarCell;
    assert.deepEqual([cell.expense, cell.income, cell.count], [100, 0, 1]);
    for (const f of ["category", "account", "route"] as const) {
      const b = breakdown(xs, OCT, f, "expense", CTX);
      assert.equal(b.total, 100, f);
      assert.equal(b.rows.reduce((n, r) => n + r.count, 0), 1, f);
    }
    assert.deepEqual(routeSpendOf(xs, "r-j", OCT), { inRange: 0, allTime: 0 });
    assert.equal(resultSummary(xs, 2), "找到 4 筆 · 支出 1 · 收入 0");
    assert.equal(spendText(0, 0, 2), "本月 0／累計 0");
  });
  test("R8b 帳戶篩選：轉入方也查得到（account_id OR to_account_id）", () => {
    assert.equal(filterEntries(xs, { ...EMPTY_FILTER, accountId: "a-card" }, CTX).length, 1);
  });
});

describe("R9 compactMoney 邊界（0-22）", () => {
  test("R9a 99,999／100,000／負數／0／整萬", () => {
    assert.equal(compactMoney(9999900, 2), "99,999");
    assert.equal(compactMoney(10000000, 2), "10萬");
    assert.equal(compactMoney(-9999900, 2), "−99,999");
    assert.equal(compactMoney(-10000000, 2), "−10萬");
    assert.equal(compactMoney(-12345600, 2), "−12.3萬");
    assert.equal(compactMoney(0, 2), "0");
    assert.equal(compactMoney(99995000, 2), "100萬"); // 999,950 → 99.995 萬 → 100萬（四捨五入後去尾 0）
    assert.equal(compactMoney(12999999, 2), "13萬");
    assert.equal(compactMoney(100000, 0), "10萬"); // 0 位小數幣別
    assert.equal(compactMoney(99999, 0), "99,999");
  });
  test("【反例】R9b 99,999.50～99,999.99：未達門檻卻被 whole 進位成「100,000」——縮寫版不該印出 6 位數（手機格放不下，0-22 的用意）", () => {
    assert.equal(compactMoney(9999950, 2), "10萬");
    assert.equal(compactMoney(-9999999, 2), "−10萬");
  });
  test("R9c cellText compact：淨退日、只有收入的日", () => {
    const c = (p: Partial<CalendarCell>): CalendarCell => ({ dayKey: "2026-10-02", inMonth: true, isToday: false, income: 0, expense: 0, count: 1, ...p });
    assert.deepEqual(cellText(c({ expense: -12345600 }), 2, true), { expense: "−12.3萬", income: null });
    assert.deepEqual(cellText(c({ income: 1500000 }), 2, true), { expense: "", income: "＋15,000" });
    assert.deepEqual(cellText(c({ expense: 0, count: 2 }), 2, true), { expense: "0", income: null }); // 當日 +x −x 抵成 0
  });
});

describe("R10 月曆週起算 0／1（0-6、§4.4）", () => {
  test("R10a 24 個月 × weekStart 0／1：每列 7 天、每列從 weekStart 起、涵蓋全月、首列含 1 號、末列含月底、weekdayHeads 對得上", () => {
    const WD = ["日", "一", "二", "三", "四", "五", "六"];
    for (let i = 0; i < 24; i++) {
      const month = addMonths("2025-01", i);
      for (const ws of [0, 1] as const) {
        const g = monthGrid(month, ws);
        const heads = weekdayHeads(ws);
        for (const row of g) {
          assert.equal(row.length, 7);
          row.forEach((d, j) => {
            const [y, m, dd] = d.split("-").map((s) => parseInt(s, 10));
            assert.equal(WD[new Date(y, m - 1, dd).getDay()], heads[j], `${month}/${ws} ${d}`);
          });
        }
        const flat = g.flat();
        assert.ok(flat.indexOf(`${month}-01`) >= 0 && flat.indexOf(`${month}-01`) < 7, `${month}/${ws} 首列含 1 號`);
        const last = dayStep(`${addMonths(month, 1)}-01`, -1);
        assert.ok(flat.indexOf(last) >= flat.length - 7, `${month}/${ws} 末列含月底`);
        assert.equal(flat.filter((d) => monthOf(d) === month).length, parseInt(last.slice(8), 10));
      }
    }
  });
  test("R10b 列數 4～6：2026-02（2/1 週日、2/28 週六）weekStart 0、2027-02（2/1 週一）weekStart 1 剛好 4 列（契約 §4.4 的「5 或 6 列」是概略說法，演算法＝1 號所在週～月底所在週，與原型 monthGrid 同；不補列）", () => {
    assert.equal(monthGrid("2026-02", 0).length, 4);
    assert.equal(monthGrid("2027-02", 1).length, 4);
    for (let i = 0; i < 48; i++) for (const ws of [0, 1] as const) {
      const n = monthGrid(addMonths("2024-01", i), ws).length;
      assert.ok(n >= 4 && n <= 6, `${addMonths("2024-01", i)}/${ws} 列數 ${n}`);
    }
  });
  test("R10c calendarCells 本月格合計＝monthSum；inMonth；isToday 只一格", () => {
    const xs = [E({ occurred_on: "2026-10-31", amount_minor: 100 }), E({ occurred_on: "2026-11-01", amount_minor: 999 }), E({ occurred_on: "2026-10-01", kind: "income", category_id: "i-allow", amount_minor: 5 })];
    for (const ws of [0, 1] as const) {
      const flat = calendarCells(xs.filter((e) => monthOf(e.occurred_on) === "2026-10"), "2026-10", ws, "2026-10-16").flat();
      const inM = flat.filter((c) => c.inMonth);
      assert.equal(inM.length, 31);
      const s = monthSum(xs, "2026-10");
      assert.equal(inM.reduce((n, c) => n + c.expense, 0), s.expense);
      assert.equal(inM.reduce((n, c) => n + c.income, 0), s.income);
      assert.equal(flat.filter((c) => c.isToday).length, 1);
    }
  });
  test("R10d nearestDayWithEntries：同距離往前優先、跨月", () => {
    const g = (d: string) => ({ dayKey: d, label: d, expense: 0, income: 0, entries: [E({ occurred_on: d })] });
    assert.equal(nearestDayWithEntries([g("2026-10-12"), g("2026-10-08")], "2026-10-10"), "2026-10-08");
    assert.equal(nearestDayWithEntries([g("2026-10-08"), g("2026-10-12")], "2026-10-10"), "2026-10-08");
    assert.equal(nearestDayWithEntries([g("2026-11-01"), g("2026-09-29")], "2026-10-31"), "2026-11-01");
    assert.equal(nearestDayWithEntries([], "2026-10-31"), null);
  });
});

describe("R11 SQL 與 TS 兩路（§3.2 ≡ matchesQuery／routeSpendOf）", () => {
  test("R11a 刁鑽資料：同刻同建立時間（只靠 id 排序）、null 分類、墓碑、外鍵不在、自轉帳、空期間、邊界日 ⇒ 兩路逐筆同序", async () => {
    const db = makeSqliteDb();
    const rnd = prng(4242);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const rows: EntryRow[] = [];
    const days = ["2025-12-31", "2026-01-01", "2026-09-30", "2026-10-01", "2026-10-31", "2026-11-01"];
    for (let i = 0; i < 160; i++) {
      const kind = pick<EntryKind>(["expense", "expense", "expense", "income", "transfer", "adjust"]);
      const d = pick(days);
      const e = E({
        occurred_on: d,
        kind,
        account_id: pick(["a-cash", "a-card", "a-usd", "a-old", "a-ghost"]),
        to_account_id: kind === "transfer" ? pick(["a-card", "a-cash", "a-bank"]) : null,
        category_id: kind === "transfer" || kind === "adjust" ? null : pick(["c-lunch", "p-food", "c-food-del", "c-ghost", UNCAT_EXPENSE_ID, "i-allow", "c-arch-kid"]),
        amount_minor: Math.floor(rnd() * 20000) - 4000,
        route_id: pick([null, null, "r-j", "r-e", "r-ghost"]),
        note: pick(["", "便當", "退款", "80"]),
        deleted_at: rnd() < 0.15 ? NOW : null,
      });
      // 一半的帳同一刻同建立時間：只剩 id DESC 決定先後
      if (i % 2 === 0) {
        e.occurred_at = `${d}T04:00:00.000Z`;
        e.created_at = NOW;
      }
      rows.push(e);
    }
    for (const e of rows) db.insert(e);
    (globalThis as { __tkDb?: unknown }).__tkDb = db;
    const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
    const repo = new SqliteTicketRepository();
    const qs: EntryQuery[] = [
      filterToQuery(EMPTY_FILTER, ALIVE_CATS),
      { ...filterToQuery(EMPTY_FILTER, ALIVE_CATS), from: "2026-10-31", toExcl: "2026-10-31" }, // 空期間
      { ...filterToQuery(EMPTY_FILTER, ALIVE_CATS), from: "2026-11-01", toExcl: "2026-10-01" }, // 倒過來
      { ...filterToQuery(EMPTY_FILTER, ALIVE_CATS), from: "2026-10-01", toExcl: "2026-11-01" },
      filterToQuery({ ...EMPTY_FILTER, accountId: "a-card" }, ALIVE_CATS),
      filterToQuery({ ...EMPTY_FILTER, accountId: "a-ghost", kinds: ["transfer", "expense"] }, ALIVE_CATS),
      filterToQuery({ ...EMPTY_FILTER, categoryIds: ["p-food"] }, ALIVE_CATS),
      filterToQuery({ ...EMPTY_FILTER, categoryIds: ["c-food-del", "c-ghost"] }, ALIVE_CATS),
      filterToQuery({ ...EMPTY_FILTER, categoryIds: [UNCAT_EXPENSE_ID], routeId: "none" }, ALIVE_CATS),
      filterToQuery({ ...EMPTY_FILTER, routeId: "r-ghost", kinds: ["income", "adjust"] }, ALIVE_CATS),
      filterToQuery({ ...EMPTY_FILTER, kinds: ["adjust"], routeId: "none", from: "2026-01-01" }, ALIVE_CATS),
    ];
    for (const q of qs) {
      const sql = (await repo.queryEntries(q)).map((e: EntryRow) => e.id);
      const ts = rows.filter((e) => matchesQuery(e, q)).sort(newestFirst).map((e) => e.id);
      assert.deepEqual(sql, ts, JSON.stringify(q));
    }
    for (const id of ["r-j", "r-e", "r-ghost", "r-none"]) {
      for (const r of [OCT, { from: "2026-10-31", toExcl: "2026-11-01" }, { from: "2026-11-01", toExcl: "2026-10-01" }]) {
        assert.deepEqual(await repo.routeSpend(id, r.from, r.toExcl), routeSpendOf(rows, id, r), `${id} ${r.from}`);
      }
    }
  });
  test("R11b store 送出的 filter 一條龍：SQL 結構＋TS 關鍵字 ≡ filterEntries（含數字、多 token、emoji 開頭的分類名）", async () => {
    const db = makeSqliteDb();
    const rows = [
      E({ occurred_on: "2026-10-02", amount_minor: 8000, note: "便當" }),
      E({ occurred_on: "2026-10-02", amount_minor: 80000, note: "便當 大份" }),
      E({ occurred_on: "2026-10-02", amount_minor: 8000, category_id: "p-food", route_id: "r-j" }),
      E({ occurred_on: "2026-10-03", currency: "USD", account_id: "a-usd", amount_minor: 8000, main_minor: 252400, category_id: "c-groc" }),
      E({ occurred_on: "2026-10-04", kind: "transfer", account_id: "a-bank", to_account_id: "a-card", category_id: null, amount_minor: 8000 }),
    ];
    for (const e of rows) db.insert(e);
    (globalThis as { __tkDb?: unknown }).__tkDb = db;
    const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
    const repo = new SqliteTicketRepository();
    for (const f of [
      { ...EMPTY_FILTER, text: "80" },
      { ...EMPTY_FILTER, text: "便當 80" },
      { ...EMPTY_FILTER, text: "食物" },
      { ...EMPTY_FILTER, text: "j 80", categoryIds: ["p-food"] },
      { ...EMPTY_FILTER, text: "信用卡" },
      { ...EMPTY_FILTER, text: "2,524" },
    ] as EntryFilter[]) {
      const sql = (await repo.queryEntries(filterToQuery(f, ALIVE_CATS))).filter((e: EntryRow) => matchesKeyword(e, keywordTokens(f.text), CTX)).map((e: EntryRow) => e.id);
      assert.deepEqual(sql, filterEntries(rows, f, CTX).map((e) => e.id), JSON.stringify(f));
    }
    // 數字 80：命中 80、80 USD（原幣），不命中 800（無備註含 80 的那筆）
    assert.deepEqual(filterEntries(rows, { ...EMPTY_FILTER, text: "80" }, CTX).map((e) => e.amount_minor), [8000, 8000, 8000, 8000]);
  });
});

describe("R12 空資料", () => {
  test("R12a 沒有任何帳：每支純函式都回空／0，不丟例外", () => {
    assert.deepEqual(statsOverview([], OCT), { income: 0, expense: 0, net: 0, count: 0 });
    assert.ok(monthlyTrend([], trendMonths({ span: "month", key: "2026-10" })).every((p) => p.income === 0 && p.expense === 0));
    for (const f of ["category", "account", "route"] as const) assert.deepEqual(breakdown([], OCT, f, "expense", CTX), { rows: [], total: 0, refunds: [] });
    assert.ok(calendarCells([], "2026-10", 1, "2026-10-16").flat().every((c) => c.count === 0 && cellText(c, 2, true).expense === "" && cellText(c, 2, false).income === null));
    assert.equal(resultSummary([], 2), "找到 0 筆 · 支出 0 · 收入 0");
    assert.deepEqual(routeSpendOf([], "r-j", OCT), { inRange: 0, allTime: 0 });
    assert.equal(asideText(0, 2), null);
    assert.deepEqual(filterEntries([], { ...EMPTY_FILTER, text: "x" }, CTX), []);
    assert.deepEqual(filterChips(EMPTY_FILTER, CTX), []);
    assert.equal(isFilterActive({ ...EMPTY_FILTER, text: "   " }), false);
  });
  test("R12b 空的 ctx（還沒 warm：catById／accById／curByCode／路線都空）：breakdown 全歸 GONE、matchesKeyword 只比備註與金額", () => {
    const empty: ViewCtx = { accById: {}, catById: {}, curByCode: {}, routeById: {}, routeOrder: [] };
    const e = E({ occurred_on: "2026-10-02", amount_minor: 8000, note: "便當" });
    assert.deepEqual(breakdown([e], OCT, "category", "expense", empty).rows.map((r) => r.key), [GONE_KEY]);
    assert.ok(matchesKeyword(e, keywordTokens("便當 80"), empty));
    assert.ok(!matchesKeyword(e, keywordTokens("午餐"), empty));
  });
});

describe("R13 文字口徑（0-11、§4.6）", () => {
  test("【反例】R13a 路線花費非整數：§4.6 寫 TK_TEXT.spend(moneyText(inRange), moneyText(allTime))（不帶 whole；0-11「整數不顯示小數」）⇒ 12.50 應照印、不該四捨五入成 13", () => {
    assert.equal(spendText(1250, 1842050, 2), `本月 ${moneyText(1250, 2)}／累計 ${moneyText(1842050, 2)}`);
  });
  test("【反例】R13b 手機列尾同理：§4.6 asideText＝`本月 ${moneyText(inRange)}`", () => {
    assert.equal(asideText(1250, 2), `本月 ${moneyText(1250, 2)}`);
    assert.notEqual(asideText(40, 2), null); // 0.40 元不是 0；whole 會印成「本月 0」
    assert.notEqual(asideText(40, 2), "本月 0");
  });
  test("R13c 搜尋摘要：N＝全部筆數；支出收入用 main_minor、退款抵回", () => {
    const xs = [E({ occurred_on: "2026-10-02", amount_minor: 123456 }), E({ occurred_on: "2026-10-02", amount_minor: -456 }), E({ occurred_on: "2026-10-02", kind: "income", category_id: "i-allow", amount_minor: 100000 })];
    assert.equal(resultSummary(xs, 2), "找到 3 筆 · 支出 1,230 · 收入 1,000");
  });
});

/* ═════════════════════════ S. ticketStore 第②階段（替身） ═════════════════════════ */

const { todayKey } = await import("../../src/lib/date.ts");
const CUR = monthOf(todayKey(0));
const PREV = addMonths(CUR, -1);

interface FakeRepo {
  entries: EntryRow[];
  spendDelay: number;
  spendCalls: number;
  [k: string]: unknown;
}
function fakeRepo(entries: EntryRow[]): FakeRepo {
  const alive = (e: EntryRow) => e.deleted_at === null;
  const r: FakeRepo = {
    entries,
    spendDelay: 0,
    spendCalls: 0,
    async ensureStarterRows() {},
    async listCurrencies() {
      return CURRENCIES.slice();
    },
    async listAccounts() {
      return ACCOUNTS.slice();
    },
    async listCategories() {
      return ALIVE_CATS.slice();
    },
    async lastUsedAccountId() {
      return null;
    },
    async recentCategoryIds() {
      return [];
    },
    async balances() {
      return {};
    },
    async hasAnyEntry() {
      return r.entries.some(alive);
    },
    async listEntries(from: string, toExcl: string, accountId: string | null) {
      return r.entries
        .filter((e) => alive(e) && e.occurred_on >= from && e.occurred_on < toExcl && (accountId === null || e.account_id === accountId || e.to_account_id === accountId))
        .sort(newestFirst)
        .map((e) => ({ ...e }));
    },
    async queryEntries(q: EntryQuery) {
      return r.entries.filter((e) => matchesQuery(e, q)).sort(newestFirst).map((e) => ({ ...e }));
    },
    async routeSpend(id: string, from: string, toExcl: string) {
      r.spendCalls++;
      const v = routeSpendOf(r.entries, id, { from, toExcl });
      if (r.spendDelay) await new Promise((res) => setTimeout(res, r.spendDelay));
      return v;
    },
    async getEntry(id: string) {
      const e = r.entries.find((x) => x.id === id && alive(x));
      return e ? { ...e } : null;
    },
    async createEntry(i: { kind: EntryRow["kind"]; amountMinor: number; currency: string; accountId: string; toAccountId: string | null; categoryId: string | null; occurredOn: string; note: string; routeId: string | null }) {
      const row = E({ kind: i.kind, amount_minor: i.amountMinor, main_minor: i.amountMinor, currency: i.currency, account_id: i.accountId, to_account_id: i.toAccountId, category_id: i.categoryId, occurred_on: i.occurredOn, note: i.note, route_id: i.routeId });
      r.entries.push(row);
      return { ...row };
    },
  };
  return r;
}
const NODE_ROUTES = ROUTES.map((x) => ({ ...x, kind: "route", deleted_at: null }));

function storeFixture(): EntryRow[] {
  return [
    E({ occurred_on: `${CUR}-02`, category_id: "c-lunch", amount_minor: 10000, account_id: "a-cash", route_id: "r-j", note: "午間" }),
    E({ occurred_on: `${CUR}-02`, category_id: "c-dinner", amount_minor: 25000, account_id: "a-card" }),
    E({ occurred_on: `${CUR}-03`, category_id: "c-bus", amount_minor: 3000, account_id: "a-card", route_id: "r-e" }),
    E({ occurred_on: `${CUR}-05`, kind: "income", category_id: "i-allow", amount_minor: 500000, account_id: "a-bank" }),
    E({ occurred_on: `${CUR}-06`, kind: "transfer", category_id: null, account_id: "a-bank", to_account_id: "a-card", amount_minor: 100000, to_amount_minor: 100000 }),
    E({ occurred_on: `${CUR}-08`, currency: "USD", account_id: "a-usd", amount_minor: 1000, main_minor: 31550, category_id: "c-groc", note: "App" }),
    E({ occurred_on: `${CUR}-04`, amount_minor: 99900, account_id: "a-card", note: "刪掉的", deleted_at: NOW }),
    E({ occurred_on: `${PREV}-15`, category_id: "c-lunch", amount_minor: 12000, account_id: "a-card", note: "便當", route_id: "r-j" }),
    E({ occurred_on: `${PREV}-20`, category_id: "c-clothes", amount_minor: -50000, account_id: "a-cash", note: "退貨" }),
  ];
}

describe("S. ticketStore 第②階段（替身 repo；不碰真 DB）", async () => {
  const repo = fakeRepo(storeFixture());
  (globalThis as { __tkRepo?: unknown }).__tkRepo = repo;
  const { useTicketStore } = await import("../../src/store/ticketStore.ts");
  const nodeStore = (globalThis as unknown as { __nodeStore: { setState(p: unknown): void } }).__nodeStore;
  nodeStore.setState({ routes: NODE_ROUTES });
  const st = () => useTicketStore.getState();
  const ids = (xs: readonly EntryRow[] | null) => (xs ?? []).map((e) => e.id);
  const fx = repo.entries;
  const byNote = (n: string) => fx.find((e) => e.note === n) as EntryRow;

  await st().init("desktop");

  test("S0 init：本月、清單視圖、期間＝本月", () => {
    assert.equal(st().month, CUR);
    assert.equal(st().view, "list");
    assert.deepEqual(st().period, { span: "month", key: CUR });
  });

  test("S1 searchEntries（Ctrl+P）不動頁面的 filter／results／searchOpen／view；新到舊、limit、墓碑不出、分類名與路線名可找", async () => {
    await st().setFilterText("便當");
    assert.deepEqual(ids(st().results), [byNote("便當").id]);
    const before = { filter: st().filter, results: st().results, resultDays: st().resultDays, searchOpen: st().searchOpen, view: st().view, month: st().month };
    const hits = await st().searchEntries("午餐", 4);
    assert.deepEqual(ids(hits), [fx[0].id, byNote("便當").id]);
    assert.equal((await st().searchEntries("日文", 4)).length, 2); // 路線名
    const latest = await st().searchEntries("", 3);
    assert.equal(latest.length, 3);
    assert.deepEqual(ids(latest), ids(fx.filter((e) => e.deleted_at === null).sort(newestFirst).slice(0, 3)));
    assert.deepEqual(await st().searchEntries("刪掉", 4), []);
    const after = { filter: st().filter, results: st().results, resultDays: st().resultDays, searchOpen: st().searchOpen, view: st().view, month: st().month };
    assert.deepEqual(after, before);
    assert.equal(after.filter, before.filter); // 同一個物件（沒有被重設再設回）
    assert.equal(after.results, before.results);
    st().closeSearch();
    assert.equal(st().results, null);
  });

  test("S2 側欄篩帳戶 × 三視圖：清單／月曆／統計都只看該帳戶；帳戶切面被迫回分類；轉入該帳戶的轉帳不入收支", async () => {
    await st().setView("stats");
    st().setFacet("account");
    assert.equal(st().facet, "account");
    await st().setFilter("a-card");
    assert.equal(st().facet, "category");
    st().setFacet("account");
    assert.equal(st().facet, "category");
    const s = st().stats;
    assert.ok(s);
    assert.deepEqual(s.overview, { income: 0, expense: 28000, net: -28000, count: 2 });
    assert.deepEqual(s.breakdown.rows.map((r) => [r.key, r.minor]), [["p-food", 25000], ["p-traffic", 3000]]);
    const trend = Object.fromEntries(s.trend.map((p) => [p.month, p.expense]));
    assert.equal(trend[CUR], 28000);
    assert.equal(trend[PREV], 12000);
    assert.ok(st().days.flatMap((g) => g.entries).every((e) => e.account_id === "a-card" || e.to_account_id === "a-card"));
    await st().setView("calendar");
    const cal = (st().calendar ?? []).flat();
    assert.equal(cal.find((c) => c.dayKey === `${CUR}-02`)?.expense, 25000);
    assert.equal(cal.find((c) => c.dayKey === `${CUR}-06`)?.count, 0); // 轉入 a-card 的轉帳
    assert.equal(cal.find((c) => c.dayKey === `${CUR}-05`)?.income, 0); // a-bank 的收入不出
    await st().setFilter(null);
    await st().setView("stats");
    assert.equal(st().stats?.overview.expense, 10000 + 25000 + 3000 + 31550);
  });

  test("S3 統計年模式：[ ] 切年、month 不動；不超過今年；趨勢＝該年 1～12；切回月模式回到原月", async () => {
    await st().setSpan("year");
    const y = CUR.slice(0, 4);
    assert.deepEqual(st().period, { span: "year", key: y });
    await st().stepMonth(-1);
    const py = String(parseInt(y, 10) - 1);
    assert.deepEqual(st().period, { span: "year", key: py });
    assert.equal(st().month, CUR);
    assert.deepEqual(st().stats?.trend.map((p) => p.month), trendMonths({ span: "year", key: py }));
    assert.deepEqual(st().stats?.period, { span: "year", key: py });
    await st().stepMonth(1);
    await st().stepMonth(1); // 明年：擋
    assert.deepEqual(st().period, { span: "year", key: y });
    const yr = periodRange({ span: "year", key: y });
    assert.deepEqual(st().stats?.overview, statsOverview(fx, yr));
    await st().setSpan("month");
    assert.deepEqual(st().period, { span: "month", key: CUR });
    assert.deepEqual(st().stats?.overview, statsOverview(fx, monthRange(CUR)));
  });

  test("S4 統計下鑽 drillToList：切清單、期間＝統計期間、帳戶＝側欄篩選、帶入分類與類型；results 只剩那些帳", async () => {
    await st().setFilter("a-card");
    await st().setView("stats");
    await st().drillToList({ categoryIds: ["p-food"], kinds: ["expense"] });
    assert.equal(st().view, "list");
    assert.equal(st().searchOpen, true);
    const r = monthRange(CUR);
    assert.deepEqual([st().filter.from, st().filter.toExcl, st().filter.accountId], [r.from, r.toExcl, "a-card"]);
    assert.deepEqual(ids(st().results), [fx[1].id]);
    st().closeSearch();
    await st().setFilter(null);
  });

  test("S5 jumpToDay：沒帳的日 ⇒ 不選取、淡字「M/D 沒有紀錄」、pendingDay＝最接近有帳的日；別月的日 ⇒ 切月並選中那天第一筆", async () => {
    await st().jumpToDay(`${CUR}-20`);
    assert.equal(st().view, "list");
    assert.equal(st().selectedId, null);
    assert.equal(st().dayNotice, `${parseInt(CUR.slice(5), 10)}/20 沒有紀錄`);
    assert.equal(st().pendingDay, `${CUR}-08`);
    await st().jumpToDay(`${PREV}-15`);
    assert.equal(st().month, PREV);
    assert.equal(st().selectedId, byNote("便當").id);
    assert.equal(st().pendingDay, `${PREV}-15`);
    await st().setMonth(CUR);
  });

  test("S6 寫入後 refresh：搜尋結果、統計、月曆跟著重算（不必重開頁）", async () => {
    await st().setView("stats");
    await st().setFilterText("App"); // setFilterText 會打開搜尋但不切視圖
    assert.equal(st().results?.length, 1);
    repo.entries.push(E({ occurred_on: `${CUR}-09`, amount_minor: 7000, note: "App 2" }));
    await st().refresh();
    assert.equal(st().results?.length, 2);
    assert.equal(st().stats?.overview.expense, 10000 + 25000 + 3000 + 31550 + 7000);
    assert.equal((st().calendar ?? []).flat().find((c) => c.dayKey === `${CUR}-09`)?.expense, 7000);
    st().closeSearch();
    await st().setView("list");
  });

  test("S7 路線花費：本月＝今天所在月（不跟頁面月份）、累計＝全部；0／0 也有值", async () => {
    await st().setMonth(PREV);
    await st().loadRouteSpend("r-j");
    assert.deepEqual(st().routeSpend["r-j"], { month: 10000, total: 22000 });
    await st().loadRouteSpend("r-l");
    assert.deepEqual(st().routeSpend["r-l"], { month: 0, total: 0 });
    await st().setMonth(CUR);
  });

  test("【反例】S8 路線花費競態：loadRouteSpend 查的途中有一次 refresh（任何寫入／同步）⇒ 結果被丟掉、routeSpend 永遠沒有這條路線的值（RouteSpendField 只在 key「消失」時重叫，這裡 key 從沒出現 ⇒ 側板卡在「…」）", async () => {
    await st().refresh(); // routeSpend 清空
    assert.equal(st().routeSpend["r-e"], undefined);
    repo.spendDelay = 30;
    const p = st().loadRouteSpend("r-e");
    await st().refresh(); // 查的途中有寫入
    await p;
    repo.spendDelay = 0;
    assert.notEqual(st().routeSpend["r-e"], undefined, "refresh 後 routeSpend['r-e'] 沒人補查");
  });

  test("S9 側欄選了帳戶 ⇒ 搜尋沿用（0-10）：不放進 filter、清空文字就回一般清單；搜尋自己指定的帳戶優先", async () => {
    await st().setFilter("a-card");
    await st().setFilterText("1"); // 數字 token：命中金額或備註
    const all = ids(st().results);
    await st().setFilterText("");
    assert.equal(st().results, null);
    assert.equal(st().filter.accountId, null);
    await st().setFilterText("午間");
    assert.deepEqual(ids(st().results), []); // 午間是 a-cash 的帳
    await st().patchFilter({ accountId: "a-cash" });
    assert.deepEqual(ids(st().results), [byNote("午間").id]);
    assert.ok(all.every((id) => { const e = fx.find((x) => x.id === id) as EntryRow; return e.account_id === "a-card" || e.to_account_id === "a-card"; }));
    st().closeSearch();
    await st().setFilter(null);
  });

  test("S10 drillToList 遇到「未細分」「（…已不在）」不動作（篩選表達不了）", async () => {
    await st().setView("stats");
    st().closeSearch();
    await st().drillToList({ categoryIds: [UNSPLIT_KEY] });
    await st().drillToList({ routeId: GONE_KEY });
    await st().drillToList({ accountId: GONE_KEY });
    assert.equal(st().view, "stats");
    assert.equal(st().searchOpen, false);
    await st().setView("list");
  });

  test("S12 在統計視圖記一筆別月的帳 ⇒ 頁首月份、period、統計三數一起換到那個月（沙盒 D1 回歸）", async () => {
    await st().setSpan("month");
    await st().setMonth(CUR);
    await st().setView("stats");
    st().openNew({ dayKey: `${PREV}-10`, accountId: "a-cash", categoryId: "c-lunch", amountText: "55" });
    assert.equal(await st().saveDraft({ again: false }), true);
    assert.equal(st().month, PREV);
    assert.deepEqual(st().period, { span: "month", key: PREV });
    assert.deepEqual(st().stats?.period, { span: "month", key: PREV });
    assert.equal(st().stats?.overview.expense, 12000 - 50000 + 5500);
    await st().setMonth(CUR);
    await st().setView("list");
  });

  test("S11 只打 emoji／符號 ⇒ 不當成有字（不比出整本帳）；Ctrl+P 回空", async () => {
    await st().setFilterText("🍜");
    assert.equal(st().results, null);
    assert.deepEqual(await st().searchEntries("🍜", 4), []);
    st().closeSearch();
  });
});

/* ───────── node:sqlite 記憶體 DB（plugin-sql 形狀；外鍵關掉——資料有指到不在的分類／帳戶） ───────── */

function makeSqliteDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations/0007_ticket_ledger.sql"), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  return {
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
    },
    insert(e: EntryRow) {
      const cols = Object.keys(e);
      raw.prepare(`INSERT INTO tk_entries (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`).run(
        bind(cols.map((c) => (e as unknown as Record<string, unknown>)[c])),
      );
    },
  };
}
