/**
 * 售票口線・第②階段「看帳」純函式單元測試（②契約 2026-10-15 §4.7；甲席 Stage 0）。
 * 跑法：`node --test scripts/tests/ticket-view-logic.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 結構：
 *   0.  口徑逐條（契約 0-7、0-8、0-11、0-14 的每一條各一個 test，標題寫條號）
 *   A～F §4.7 的 29 條（編號照契約）
 * 24 的 SQLite 那一半（`SqliteTicketRepository.queryEntries／routeSpend` 真 SQL，走 node:sqlite 的 `__tkDb` 替身）已在 Stage 1 補完：
 * 隨機 filter 六十組＋手排的邊角組合＋超過 `IN_LIMIT`（500）個分類 id 的 TS 補篩路徑，全部與純函式對帳。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻。金額一律合成，帳戶／分類名用樣本格式文件已公開的名稱。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/* ───────── 載入替身（同 ticket-logic.test.ts:23-50；只影響 src/ 底下的 import） ───────── */

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

import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  groupByDay,
  monthSum,
  ticketId,
  type AccountRow,
  type CategoryKind,
  type CategoryRow,
  type CurrencyRow,
  type DayGroup,
  type EntryKind,
  type EntryRow,
} from "../../src/domain/ticket.ts";
import type {
  CalendarCell,
  EntryFilter,
  Period,
  RouteRef,
  ViewCtx,
} from "../../src/domain/ticketView.ts";
// ticketView.ts 以無副檔名 import "./ticket"：static import 會在 registerHooks 之前解析，所以值一律等 hook 掛好後動態載入
const {
  EMPTY_FILTER,
  GONE_KEY,
  NO_ROUTE_KEY,
  RESULT_PAGE,
  UNSPLIT_KEY,
  asideText,
  breakdown,
  calendarCells,
  categoryIdsIncluding,
  cellText,
  compactMoney,
  dayStep,
  facetAllowed,
  filterChips,
  filterEntries,
  filterToQuery,
  inRange,
  isFilterActive,
  keywordTokens,
  matchesKeyword,
  matchesQuery,
  monthGrid,
  monthlyTrend,
  nearestDayWithEntries,
  newestFirst,
  pageResults,
  periodOf,
  periodRange,
  periodTitle,
  resultSummary,
  routeSpendOf,
  shareText,
  spendText,
  statsOverview,
  stepPeriod,
  trendMonths,
  trendRange,
  weekdayHeads,
} = await import("../../src/domain/ticketView.ts");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const NOW = new Date(2026, 9, 12, 9, 0).toISOString();
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };

/* ───────── fixture：7 帳戶（含 USD、封存）、使用者分類樹形狀、3 條路線 ───────── */

function cur(code: string, decimals: number, rate: string, isMain = false): CurrencyRow {
  return { id: ticketId("currency:" + code), code, name: code, decimals, rate_to_main: rate, is_main: isMain ? 1 : 0, position: 0, ...SYNC };
}
function acc(id: string, name: string, group: string, position: number, currency = "TWD", extra: Partial<AccountRow> = {}): AccountRow {
  return { id, name, group_key: group, currency, position, archived_at: null, ...SYNC, ...extra };
}
function cat(id: string, kind: CategoryKind, name: string, parent: string | null, position: number, extra: Partial<CategoryRow> = {}): CategoryRow {
  return { id, kind, name, parent_id: parent, position, archived_at: null, ...SYNC, ...extra };
}
function byId<T extends { id: string }>(rows: T[]): Record<string, T> {
  const o: Record<string, T> = {};
  for (const r of rows) o[r.id] = r;
  return o;
}

const CURRENCIES = [cur("TWD", 2, "1", true), cur("USD", 2, "31.55"), cur("JPY", 0, "0.21")];
const ACCOUNTS = [
  acc("a-cash", "現金", "cash", 0),
  acc("a-bank", "帳戶", "bank", 0),
  acc("a-student", "學生證", "bank", 1),
  acc("a-easy", "悠遊卡", "bank", 2),
  acc("a-card", "信用卡", "card", 0),
  acc("a-usd", "美金帳戶", "bank", 3, "USD"),
  acc("a-old", "舊錢包", "cash", 1, "TWD", { archived_at: NOW }),
];
const CATEGORIES = [
  cat(UNCAT_EXPENSE_ID, "expense", "未分類", null, 9999),
  cat(UNCAT_INCOME_ID, "income", "未分類", null, 9999),
  cat("p-food", "expense", "🍜 食物", null, 0),
  cat("c-breakfast", "expense", "早餐", "p-food", 0),
  cat("c-lunch", "expense", "午餐", "p-food", 1),
  cat("c-dinner", "expense", "晚餐", "p-food", 2),
  cat("c-food-del", "expense", "宵夜", "p-food", 3, { deleted_at: NOW }),
  cat("p-traffic", "expense", "🚖 交通", null, 1),
  cat("c-bus", "expense", "公車", "p-traffic", 0),
  cat("c-mrt", "expense", "捷運", "p-traffic", 1),
  cat("p-life", "expense", "🪑 生活", null, 2),
  cat("c-rent", "expense", "房租", "p-life", 0, { archived_at: NOW }),
  cat("c-groc", "expense", "雜貨", "p-life", 1),
  cat("p-cloth", "expense", "🧥 服飾", null, 3),
  cat("c-clothes", "expense", "服裝", "p-cloth", 0),
  cat("p-other", "expense", "其他", null, 4),
  cat("p-oldgame", "expense", "🎮 舊遊戲", null, 5, { archived_at: NOW }),
  cat("i-allow", "income", "💵 生活費", null, 0),
  cat("i-salary", "income", "💳 薪水", null, 1),
];
const ROUTES: RouteRef[] = [
  { id: "r-j", name: "日文", code: "J", color: "var(--route-preset-2)" },
  { id: "r-e", name: "全端開發", code: "E1", color: "var(--route-preset-1)" },
  { id: "r-l", name: "體能", code: "L2", color: "var(--route-preset-3)" },
];
const curByCode: Record<string, CurrencyRow> = {};
for (const c of CURRENCIES) curByCode[c.code] = c;
/** store 的 catById／accById 只有未刪的列（含封存）——比照 */
const CTX: ViewCtx = {
  accById: byId(ACCOUNTS),
  catById: byId(CATEGORIES.filter((c) => c.deleted_at === null)),
  curByCode,
  routeById: byId(ROUTES),
  routeOrder: ROUTES.map((r) => r.id),
};
const ALIVE_CATS = CATEGORIES.filter((c) => c.deleted_at === null);

let seq = 0;
/** 一筆帳（預設：TWD 支出、午餐、現金、中午） */
function E(p: Partial<EntryRow> & { occurred_on: string }): EntryRow {
  const [y, m, d] = p.occurred_on.split("-").map((s) => parseInt(s, 10));
  const main = p.main_minor ?? p.amount_minor ?? 8000;
  const amount = p.amount_minor ?? main;
  seq++;
  return {
    id: `e${String(seq).padStart(4, "0")}`,
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

/** 固定種子的 PRNG（mulberry32） */
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

const FIX_MONTHS = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];

/** 約 60 筆合成帳，跨 2025-12～2026-10（含退款、同日兩筆 USD、轉帳、校正、三成掛路線、分類不在、路線不在、墓碑、封存帳戶） */
function makeFixture(): EntryRow[] {
  const rnd = prng(20261016);
  const out: EntryRow[] = [];
  const cats = ["c-breakfast", "c-lunch", "c-dinner", "c-bus", "c-mrt", "c-groc", "c-rent", "c-clothes", "p-food", "p-other", UNCAT_EXPENSE_ID];
  const accs = ["a-cash", "a-cash", "a-bank", "a-student", "a-easy", "a-card"];
  const notes = ["", "", "便當", "全家", "學餐 和同學", "早上那班", "７-11"];
  for (let i = 0; i < 42; i++) {
    const month = FIX_MONTHS[i % FIX_MONTHS.length];
    const day = `${month}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
    out.push(
      E({
        occurred_on: day,
        amount_minor: (30 + Math.floor(rnd() * 470)) * 100,
        account_id: accs[Math.floor(rnd() * accs.length)],
        category_id: cats[Math.floor(rnd() * cats.length)],
        note: notes[Math.floor(rnd() * notes.length)],
        route_id: rnd() < 0.3 ? ROUTES[Math.floor(rnd() * ROUTES.length)].id : null,
      }),
    );
  }
  for (const [d, c, v] of [
    ["2025-12-05", "i-allow", 500000],
    ["2026-02-05", "i-salary", 1200000],
    ["2026-04-05", "i-allow", 500000],
    ["2026-07-05", "i-salary", 1250000],
    ["2026-10-05", "i-allow", 500000],
    ["2026-10-20", UNCAT_INCOME_ID, 30000],
  ] as [string, string, number][]) {
    out.push(E({ occurred_on: d, kind: "income", category_id: c, amount_minor: v, account_id: "a-bank" }));
  }
  // 退款（服飾淨退回的月）、同日兩筆 USD、轉帳、校正、分類不在、路線不在、墓碑、封存帳戶、直接掛主分類、掛路線的退款
  out.push(E({ occurred_on: "2026-03-10", category_id: "c-clothes", amount_minor: -120000, note: "退貨退款" }));
  out.push(E({ occurred_on: "2026-10-07", currency: "USD", account_id: "a-usd", amount_minor: 1000, main_minor: 31550, category_id: "c-groc", note: "App Store" }));
  out.push(E({ occurred_on: "2026-10-07", currency: "USD", account_id: "a-usd", amount_minor: 250, main_minor: 7888, category_id: "c-lunch", note: "coffee" }));
  out.push(E({ occurred_on: "2026-10-03", kind: "transfer", account_id: "a-bank", to_account_id: "a-student", category_id: null, amount_minor: 120000, to_amount_minor: 120000, note: "儲值" }));
  out.push(E({ occurred_on: "2026-10-04", kind: "adjust", category_id: null, amount_minor: -3700, note: "餘額調整" }));
  out.push(E({ occurred_on: "2026-09-12", category_id: "c-ghost", amount_minor: 9900, note: "分類被硬刪的那筆" }));
  out.push(E({ occurred_on: "2026-09-13", route_id: "r-ghost", amount_minor: 18000, note: "舊路線的帳" }));
  out.push(E({ occurred_on: "2026-10-06", amount_minor: 99900, deleted_at: NOW, note: "刪掉的" }));
  out.push(E({ occurred_on: "2026-02-14", account_id: "a-old", amount_minor: 45000, category_id: "c-dinner", note: "舊錢包付的" }));
  out.push(E({ occurred_on: "2026-10-09", category_id: "p-food", amount_minor: 6600, route_id: "r-j" }));
  out.push(E({ occurred_on: "2026-10-10", category_id: "c-bus", amount_minor: -1500, route_id: "r-j", note: "悠遊卡退款" }));
  return out;
}
const FIX = makeFixture();
const ALIVE_FIX = FIX.filter((e) => e.deleted_at === null);
const OCT = { span: "month", key: "2026-10" } as const satisfies Period;

/** 洗牌（固定種子） */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rnd = prng(seed);
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

const dg = (dayKey: string, n = 1): DayGroup => ({ dayKey, label: dayKey, expense: 0, income: 0, entries: Array.from({ length: n }, () => E({ occurred_on: dayKey })) });

test("fixture 形狀（§4.7）：約 60 筆、跨 2025-12～2026-10、帳戶 7 個（含 USD、封存）、路線三成上下", () => {
  assert.ok(FIX.length >= 55 && FIX.length <= 65, `筆數 ${FIX.length}`);
  assert.equal(ACCOUNTS.length, 7);
  assert.ok(ACCOUNTS.some((a) => a.currency === "USD") && ACCOUNTS.some((a) => a.archived_at !== null));
  const days = FIX.map((e) => e.occurred_on).sort();
  assert.ok(days[0] < "2026-01-01" && days[days.length - 1] >= "2026-10-01");
  const exp = FIX.filter((e) => e.kind === "expense");
  const routed = exp.filter((e) => e.route_id !== null).length / exp.length;
  assert.ok(routed > 0.15 && routed < 0.45, `掛路線比例 ${routed}`);
});

/* ═════════════════════════ 0. 口徑逐條（契約 0-7、0-8、0-11、0-14） ═════════════════════════ */

describe("0-7 收支口徑（統計、月曆、趨勢、路線花費共用）", () => {
  const r = periodRange(OCT);
  test("0-7-1 只算 deleted_at IS NULL 的列（統計、月曆、趨勢、路線花費、占比）", () => {
    const live = E({ occurred_on: "2026-10-02", amount_minor: 1000, route_id: "r-j" });
    const dead = E({ occurred_on: "2026-10-02", amount_minor: 5000, route_id: "r-j", deleted_at: NOW });
    const xs = [live, dead];
    assert.equal(statsOverview(xs, r).expense, 1000);
    assert.equal(monthlyTrend(xs, ["2026-10"])[0].expense, 1000);
    const cell = calendarCells(xs, "2026-10", 1, "2026-10-12").flat().find((c) => c.dayKey === "2026-10-02") as CalendarCell;
    assert.equal(cell.expense, 1000);
    assert.equal(cell.count, 1);
    assert.deepEqual(routeSpendOf(xs, "r-j", r), { inRange: 1000, allTime: 1000 });
    assert.equal(breakdown(xs, r, "category", "expense", CTX).total, 1000);
  });
  test("0-7-2 轉帳與校正不入收支（但仍在搜尋結果與類型篩選裡）", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", kind: "transfer", account_id: "a-bank", to_account_id: "a-cash", category_id: null, amount_minor: 50000 }),
      E({ occurred_on: "2026-10-02", kind: "adjust", category_id: null, amount_minor: 1200 }),
      E({ occurred_on: "2026-10-02", amount_minor: 100 }),
    ];
    assert.deepEqual(statsOverview(xs, r), { income: 0, expense: 100, net: -100, count: 1 });
    assert.deepEqual(monthlyTrend(xs, ["2026-10"]), [{ month: "2026-10", income: 0, expense: 100 }]);
    const cell = calendarCells(xs, "2026-10", 1, "x").flat().find((c) => c.dayKey === "2026-10-02") as CalendarCell;
    assert.deepEqual([cell.expense, cell.income, cell.count], [100, 0, 1]);
    assert.equal(filterEntries(xs, { ...EMPTY_FILTER, kinds: ["transfer", "adjust"] }, CTX).length, 2);
    assert.match(resultSummary(xs, 2), /^找到 3 筆 · 支出 1 · 收入 0$/);
  });
  test("0-7-3 支出＝expense 淨額（退款抵回、可為負）；收入＝income 合計；淨額＝收入 − 支出", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", amount_minor: 30000 }),
      E({ occurred_on: "2026-10-03", amount_minor: -120000, category_id: "c-clothes" }),
      E({ occurred_on: "2026-10-04", kind: "income", category_id: "i-allow", amount_minor: 50000 }),
    ];
    assert.deepEqual(statsOverview(xs, r), { income: 50000, expense: -90000, net: 140000, count: 3 });
  });
  test("0-7-4 外幣一律用 main_minor（記帳當下折好的），不用現在的匯率重算", () => {
    const usd = E({ occurred_on: "2026-10-02", currency: "USD", account_id: "a-usd", amount_minor: 1000, main_minor: 31550 });
    const ctx2: ViewCtx = { ...CTX, curByCode: { ...curByCode, USD: { ...curByCode.USD, rate_to_main: "30" } } }; // 匯率改了
    assert.equal(statsOverview([usd], r).expense, 31550);
    assert.equal(breakdown([usd], r, "account", "expense", CTX).rows[0].minor, 31550);
    assert.deepEqual(breakdown([usd], r, "account", "expense", ctx2), breakdown([usd], r, "account", "expense", CTX));
  });
  test("0-7-5 封存的帳戶與分類照算", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", account_id: "a-old", amount_minor: 4500 }), // 封存帳戶
      E({ occurred_on: "2026-10-02", category_id: "c-rent", amount_minor: 900000 }), // 封存子分類
      E({ occurred_on: "2026-10-02", category_id: "p-oldgame", amount_minor: 1000 }), // 封存主分類
    ];
    assert.equal(statsOverview(xs, r).expense, 905500);
    const b = breakdown(xs, r, "category", "expense", CTX);
    assert.deepEqual(
      b.rows.map((x) => [x.key, x.minor]),
      [["p-life", 900000], ["p-food", 4500], ["p-oldgame", 1000]],
    );
    assert.equal(breakdown(xs, r, "account", "expense", CTX).rows.find((x) => x.key === "a-old")?.minor, 4500);
    assert.deepEqual(routeSpendOf([{ ...xs[0], route_id: "r-l" }], "r-l", r), { inRange: 4500, allTime: 4500 });
  });
  test("0-7-6 分類／帳戶／路線指到不在的 ⇒ 各歸一列「（…已不在／已刪除）」，而且進占比的分母", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", category_id: "c-ghost", account_id: "a-ghost", route_id: "r-ghost", amount_minor: 1000 }),
      E({ occurred_on: "2026-10-02", amount_minor: 3000 }),
    ];
    for (const [facet, label] of [["category", "（分類已不在）"], ["account", "（帳戶已不在）"], ["route", "（路線已刪除）"]] as const) {
      const b = breakdown(xs, r, facet, "expense", CTX);
      const gone = b.rows.find((x) => x.key === GONE_KEY);
      assert.ok(gone, facet);
      assert.equal(gone.label, label);
      assert.equal(gone.minor, 1000);
      assert.equal(b.total, 4000, `${facet} 分母含 GONE`);
      assert.equal(gone.share, 0.25);
    }
  });
  test("0-7-7 側欄篩帳戶＝先照 listEntries 口徑取帳（account_id 或 to_account_id），三個視圖再算", () => {
    const q = filterToQuery({ ...EMPTY_FILTER, accountId: "a-student" }, ALIVE_CATS);
    const mine = FIX.filter((e) => matchesQuery(e, q));
    assert.ok(mine.every((e) => e.account_id === "a-student" || e.to_account_id === "a-student"));
    assert.ok(mine.some((e) => e.kind === "transfer")); // 轉入也算「這個帳戶的帳」
    const ov = statsOverview(mine, periodRange(OCT));
    assert.deepEqual(ov, statsOverview(mine.filter((e) => e.account_id === "a-student"), periodRange(OCT))); // 轉帳不入收支，所以只差在列表裡
    assert.equal(facetAllowed("account", "a-student"), "category");
  });
});

describe("0-8 占比怎麼算", () => {
  const r = periodRange(OCT);
  test("0-8-1 kind＝expense／income 各看各的（facetKind）", () => {
    const xs = [E({ occurred_on: "2026-10-02", amount_minor: 100 }), E({ occurred_on: "2026-10-02", kind: "income", category_id: "i-allow", amount_minor: 900 })];
    assert.deepEqual(breakdown(xs, r, "category", "expense", CTX).rows.map((x) => x.key), ["p-food"]);
    assert.deepEqual(breakdown(xs, r, "category", "income", CTX).rows.map((x) => x.key), ["i-allow"]);
  });
  test("0-8-2 分母＝淨額 > 0 的列合計；淨額 ≤ 0 的列不入圖、不入分母、進「淨退回」；條長加總 100%", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", category_id: "c-bus", amount_minor: 30000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-lunch", amount_minor: 10000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-clothes", amount_minor: -3000 }),
    ];
    const b = breakdown(xs, r, "category", "expense", CTX);
    assert.equal(b.total, 40000);
    assert.deepEqual(b.rows.map((x) => [x.key, x.share]), [["p-traffic", 0.75], ["p-food", 0.25]]);
    assert.deepEqual(b.refunds.map((x) => [x.key, x.label, x.minor, x.share]), [["p-cloth", "🧥 服飾", -3000, 0]]);
  });
  test("0-8-3 分類兩層：主＝自己＋子；有子分類列時直接掛主分類的另成「未細分」；只有直接掛 ⇒ 不出「未細分」；未分類照常、固定最後", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", category_id: "c-lunch", amount_minor: 10000 }),
      E({ occurred_on: "2026-10-02", category_id: "p-food", amount_minor: 2000 }),
      E({ occurred_on: "2026-10-02", category_id: "p-other", amount_minor: 4000 }),
      E({ occurred_on: "2026-10-02", category_id: UNCAT_EXPENSE_ID, amount_minor: 99000 }),
    ];
    const b = breakdown(xs, r, "category", "expense", CTX);
    assert.deepEqual(b.rows.map((x) => x.key), ["p-food", "p-other", UNCAT_EXPENSE_ID]);
    const food = b.rows[0];
    assert.equal(food.minor, 12000);
    assert.deepEqual(food.children?.map((x) => [x.key, x.label, x.minor]), [["c-lunch", "午餐", 10000], [UNSPLIT_KEY, "未細分", 2000]]);
    assert.equal(b.rows[1].children, undefined);
    assert.equal(b.rows[2].label, "未分類");
  });
  test("0-8-4 帳戶切面依 account_id；側欄已篩帳戶 ⇒ 帳戶切面不給、回分類", () => {
    const xs = [E({ occurred_on: "2026-10-02", account_id: "a-card", amount_minor: 700 }), E({ occurred_on: "2026-10-02", account_id: "a-cash", amount_minor: 300 })];
    assert.deepEqual(breakdown(xs, r, "account", "expense", CTX).rows.map((x) => [x.key, x.label]), [["a-card", "信用卡"], ["a-cash", "現金"]]);
    assert.equal(facetAllowed("account", "a-card"), "category");
    assert.equal(facetAllowed("route", "a-card"), "route");
    assert.equal(facetAllowed("account", null), "account");
  });
  test("0-8-5 路線切面：未掛路線一列（是最大的一列也不藏）、已刪除的路線一列", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", amount_minor: 50000 }),
      E({ occurred_on: "2026-10-02", route_id: "r-e", amount_minor: 3000 }),
      E({ occurred_on: "2026-10-02", route_id: "r-ghost", amount_minor: 100 }),
    ];
    const b = breakdown(xs, r, "route", "expense", CTX);
    assert.deepEqual(b.rows.map((x) => [x.key, x.label]), [[NO_ROUTE_KEY, "未掛路線"], ["r-e", "全端開發"], [GONE_KEY, "（路線已刪除）"]]);
  });
  test("0-8-6 百分比四捨五入到整數；0 < share < 0.5% ⇒ <1%；加總不補差", () => {
    assert.equal(shareText(1 / 3), "33%");
    assert.equal(shareText(0.004), "<1%");
    const xs = [1, 1, 1].map(() => E({ occurred_on: "2026-10-02", amount_minor: 100, category_id: "c-bus" }));
    xs.push(E({ occurred_on: "2026-10-02", amount_minor: 100, category_id: "c-lunch" }), E({ occurred_on: "2026-10-02", amount_minor: 100, category_id: "c-groc" }));
    const b = breakdown(xs, r, "category", "expense", CTX);
    assert.deepEqual(b.rows.map((x) => shareText(x.share)), ["60%", "20%", "20%"]);
  });
  test("0-8-7 排序：金額大到小；同額照切面的自然順序（分類樹序／orderAccounts／路線側欄順序）", () => {
    const same = (k: Partial<EntryRow>[]) => k.map((p) => E({ occurred_on: "2026-10-02", amount_minor: 500, ...p }));
    assert.deepEqual(
      breakdown(same([{ category_id: "c-clothes" }, { category_id: "c-bus" }, { category_id: "c-lunch" }]), r, "category", "expense", CTX).rows.map((x) => x.key),
      ["p-food", "p-traffic", "p-cloth"],
    );
    assert.deepEqual(
      breakdown(same([{ account_id: "a-card" }, { account_id: "a-student" }, { account_id: "a-cash" }]), r, "account", "expense", CTX).rows.map((x) => x.key),
      ["a-cash", "a-student", "a-card"],
    );
    assert.deepEqual(
      breakdown(same([{ route_id: "r-l" }, { route_id: "r-j" }, { route_id: "r-e" }]), r, "route", "expense", CTX).rows.map((x) => x.key),
      ["r-j", "r-e", "r-l"],
    );
  });
});

describe("0-11 路線的花費口徑", () => {
  const oct = periodRange(OCT);
  test("0-11-1 花費＝route_id 直掛的 expense 淨額（退款抵回；轉帳、校正、收入不入）", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", route_id: "r-j", amount_minor: 10000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", amount_minor: -2000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", kind: "income", category_id: "i-allow", amount_minor: 50000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", kind: "transfer", account_id: "a-bank", to_account_id: "a-cash", category_id: null, amount_minor: 3000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", kind: "adjust", category_id: null, amount_minor: 700 }),
      E({ occurred_on: "2026-10-03", route_id: "r-e", amount_minor: 999 }),
    ];
    assert.deepEqual(routeSpendOf(xs, "r-j", oct), { inRange: 8000, allTime: 8000 });
  });
  test("0-11-2 本月＝傳進來的期間；累計＝全部期間（含封存帳戶的帳）", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", route_id: "r-j", amount_minor: 10000 }),
      E({ occurred_on: "2026-09-30", route_id: "r-j", amount_minor: 7000 }),
      E({ occurred_on: "2025-12-01", route_id: "r-j", account_id: "a-old", amount_minor: 4000 }),
    ];
    assert.deepEqual(routeSpendOf(xs, "r-j", oct), { inRange: 10000, allTime: 21000 });
  });
  test("0-11-3 文字「本月 1,230／累計 18,420」：主幣別、整數不顯示小數（有小數照印，契約 §4.6 不帶 whole）、千分位、負數 −；兩個 0 ⇒ 本月 0／累計 0", () => {
    assert.equal(spendText(123000, 1842000, 2), "本月 1,230／累計 18,420");
    assert.equal(spendText(123049, 1842050, 2), "本月 1,230.49／累計 18,420.50");
    assert.equal(spendText(0, 0, 2), "本月 0／累計 0");
    assert.equal(spendText(-5000, 0, 2), "本月 −50／累計 0");
  });
});

describe("0-14 搜尋與篩選的口徑", () => {
  test("0-14-1 期間＝全部是搜尋的預設（EMPTY_FILTER 不帶期間）；五欄都空＝不作用", () => {
    assert.equal(EMPTY_FILTER.from, null);
    assert.equal(EMPTY_FILTER.toExcl, null);
    assert.equal(isFilterActive(EMPTY_FILTER), false);
    assert.equal(isFilterActive({ ...EMPTY_FILTER, text: "   " }), false);
    for (const p of [{ text: "x" }, { from: "2026-10-01" }, { toExcl: "2026-10-01" }, { accountId: "a" }, { categoryIds: ["c"] }, { kinds: ["income"] as EntryKind[] }, { routeId: "none" as const }]) {
      assert.equal(isFilterActive({ ...EMPTY_FILTER, ...p }), true, JSON.stringify(p));
    }
  });
  test("0-14-2 主分類勾＝含全部子分類；子分類可單勾", () => {
    const xs = [E({ occurred_on: "2026-10-02", category_id: "c-bus" }), E({ occurred_on: "2026-10-02", category_id: "p-traffic" }), E({ occurred_on: "2026-10-02", category_id: "c-lunch" })];
    assert.equal(filterEntries(xs, { ...EMPTY_FILTER, categoryIds: ["p-traffic"] }, CTX).length, 2);
    assert.equal(filterEntries(xs, { ...EMPTY_FILTER, categoryIds: ["c-bus"] }, CTX).length, 1);
  });
  test("0-14-3 關鍵字以空白切 token、全部都要命中（AND）；兩邊都 catKey（去開頭 emoji、全形轉半形、小寫）", () => {
    const e = E({ occurred_on: "2026-10-02", note: "Lunch 和同學 7-11", category_id: "c-lunch", route_id: "r-e" });
    assert.equal(matchesKeyword(e, keywordTokens("lunch 同學"), CTX), true);
    assert.equal(matchesKeyword(e, keywordTokens("ＬＵＮＣＨ"), CTX), false); // 全形英文字母不在 normalizeInput 的範圍（只轉數字與符號）
    assert.equal(matchesKeyword(e, keywordTokens("LUNCH　７-１１"), CTX), true); // 全形空白與數字
    assert.equal(matchesKeyword(e, keywordTokens("🍜食物"), CTX), true); // 去開頭 emoji 後比主分類名
    assert.equal(matchesKeyword(e, keywordTokens("lunch 晚餐"), CTX), false);
  });
  test("0-14-4 文字 token 比：備註、分類名（含主分類名）、帳戶名（含轉入帳戶）、路線名與代碼；包含即命中", () => {
    const e = E({ occurred_on: "2026-10-02", kind: "transfer", account_id: "a-bank", to_account_id: "a-student", category_id: null, route_id: "r-e", note: "儲值" });
    for (const t of ["儲", "帳戶", "學生", "全端", "e1"]) assert.equal(matchesKeyword(e, keywordTokens(t), CTX), true, t);
    const f = E({ occurred_on: "2026-10-02", category_id: "c-mrt" });
    for (const t of ["捷運", "交通", "現金"]) assert.equal(matchesKeyword(f, keywordTokens(t), CTX), true, t);
  });
  test("0-14-5 純數字 token 另比金額：與 |amount_minor| 原幣字串或 |main_minor| 主幣別字串完全相符（80 命中 80／80.00，不命中 800）；也照文字規則比", () => {
    const e80 = E({ occurred_on: "2026-10-02", amount_minor: 8000 });
    const e800 = E({ occurred_on: "2026-10-02", amount_minor: 80000 });
    const note80 = E({ occurred_on: "2026-10-02", amount_minor: 1500, note: "80 號公車" });
    const refund = E({ occurred_on: "2026-10-02", amount_minor: -8000 });
    const t = keywordTokens("80");
    assert.deepEqual([e80, e800, note80, refund].map((e) => matchesKeyword(e, t, CTX)), [true, false, true, true]);
    assert.equal(matchesKeyword(e80, keywordTokens("80.00"), CTX), true);
  });
  test("0-14-6 結果：新到舊、照日分組；摘要 N 含轉帳校正、支出收入照 0-7", () => {
    const xs = shuffled(FIX, 7);
    const res = filterEntries(xs, { ...EMPTY_FILTER, from: "2026-10-01", toExcl: "2026-11-01" }, CTX);
    for (let i = 1; i < res.length; i++) assert.ok(newestFirst(res[i - 1], res[i]) < 0);
    const days = groupByDay(res, null);
    assert.ok(days.length > 1 && days.every((g, i) => i === 0 || g.dayKey < days[i - 1].dayKey));
    const ov = statsOverview(res, periodRange(OCT));
    const n = res.length;
    assert.ok(res.some((e) => e.kind === "transfer") && res.some((e) => e.kind === "adjust"));
    assert.equal(resultSummary(res, 2), `找到 ${n} 筆 · 支出 ${fmt(ov.expense)} · 收入 ${fmt(ov.income)}`);
  });
});

/** moneyText(x, 2) 的簡寫（測試裡只拿來組期望字串） */
function fmt(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const int = Math.floor(abs / 100);
  const frac = abs % 100;
  const body = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + String(frac).padStart(2, "0") : "");
  return (neg ? "−" : "") + body;
}

/* ═════════════════════════ A. 期間 ═════════════════════════ */

describe("A. 期間", () => {
  test("1. periodRange 月／年、跨年；periodOf；periodTitle", () => {
    assert.deepEqual(periodRange({ span: "month", key: "2026-10" }), { from: "2026-10-01", toExcl: "2026-11-01" });
    assert.deepEqual(periodRange({ span: "month", key: "2026-12" }), { from: "2026-12-01", toExcl: "2027-01-01" });
    assert.deepEqual(periodRange({ span: "year", key: "2026" }), { from: "2026-01-01", toExcl: "2027-01-01" });
    assert.deepEqual(periodOf("2026-10", "year"), { span: "year", key: "2026" });
    assert.deepEqual(periodOf("2026-10", "month"), { span: "month", key: "2026-10" });
    assert.equal(periodTitle({ span: "month", key: "2026-10" }), "2026 年 10 月");
    assert.equal(periodTitle({ span: "year", key: "2026" }), "2026 年");
    assert.equal(inRange("2026-10-31", periodRange(OCT)), true);
    assert.equal(inRange("2026-11-01", periodRange(OCT)), false);
  });
  test("2. trendMonths 月模式 12 個舊到新（選中月在最右）、年模式 1–12", () => {
    const m = trendMonths({ span: "month", key: "2026-03" });
    assert.equal(m.length, 12);
    assert.equal(m[0], "2025-04");
    assert.equal(m[11], "2026-03");
    for (let i = 1; i < 12; i++) assert.ok(m[i] > m[i - 1]);
    assert.deepEqual(trendMonths({ span: "year", key: "2026" }), [
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
  });
  test("3. trendRange 涵蓋 periodRange", () => {
    assert.deepEqual(trendRange(OCT), { from: "2025-11-01", toExcl: "2026-11-01" });
    assert.deepEqual(trendRange({ span: "year", key: "2026" }), { from: "2026-01-01", toExcl: "2027-01-01" });
    for (const p of [OCT, { span: "month", key: "2026-01" }, { span: "year", key: "2025" }] as Period[]) {
      const tr = trendRange(p);
      const pr = periodRange(p);
      assert.ok(tr.from <= pr.from && tr.toExcl >= pr.toExcl, JSON.stringify(p));
    }
  });
  test("4. stepPeriod 年 ±、月跨年", () => {
    assert.deepEqual(stepPeriod({ span: "year", key: "2026" }, 1), { span: "year", key: "2027" });
    assert.deepEqual(stepPeriod({ span: "year", key: "2026" }, -1), { span: "year", key: "2025" });
    assert.deepEqual(stepPeriod({ span: "month", key: "2026-12" }, 1), { span: "month", key: "2027-01" });
    assert.deepEqual(stepPeriod({ span: "month", key: "2026-01" }, -1), { span: "month", key: "2025-12" });
  });
});

/* ═════════════════════════ B. 統計 ═════════════════════════ */

describe("B. 統計", () => {
  const r = periodRange(OCT);
  test("5. statsOverview：轉帳校正不入、退款抵回（支出可為負）、外幣用 main_minor、封存帳戶照算、墓碑不算", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", amount_minor: 8000 }),
      E({ occurred_on: "2026-10-03", amount_minor: -3500 }),
      E({ occurred_on: "2026-10-04", kind: "income", category_id: "i-allow", amount_minor: 200000 }),
      E({ occurred_on: "2026-10-05", kind: "transfer", account_id: "a-bank", to_account_id: "a-cash", category_id: null, amount_minor: 50000 }),
      E({ occurred_on: "2026-10-06", kind: "adjust", category_id: null, amount_minor: 1200 }),
      E({ occurred_on: "2026-10-07", currency: "USD", account_id: "a-usd", amount_minor: 1000, main_minor: 31550 }),
      E({ occurred_on: "2026-10-08", account_id: "a-old", amount_minor: 2000 }),
      E({ occurred_on: "2026-10-09", amount_minor: 99999, deleted_at: NOW }),
      E({ occurred_on: "2026-11-01", amount_minor: 7777 }),
      E({ occurred_on: "2026-09-30", amount_minor: 7777 }),
    ];
    assert.deepEqual(statsOverview(xs, r), { income: 200000, expense: 38050, net: 161950, count: 5 });
    assert.deepEqual(statsOverview([xs[1]], r), { income: 0, expense: -3500, net: 3500, count: 1 });
    assert.deepEqual(statsOverview([], r), { income: 0, expense: 0, net: 0, count: 0 });
  });
  test("6. statsOverview(本月) ≡ monthSum(entries, month)（三個月）", () => {
    for (const m of ["2025-12", "2026-03", "2026-10"]) {
      const ov = statsOverview(FIX, periodRange({ span: "month", key: m }));
      const ms = monthSum(FIX, m);
      assert.deepEqual({ income: ov.income, expense: ov.expense }, ms, m);
      assert.ok(ov.count > 0, m);
    }
  });
  test("7. monthlyTrend：月序照輸入、沒帳的月 0／0、每點＝monthSum", () => {
    const months = trendMonths(OCT); // 2025-11 … 2026-10
    const t = monthlyTrend(FIX, months);
    assert.deepEqual(t.map((p) => p.month), months);
    assert.deepEqual(t[0], { month: "2025-11", income: 0, expense: 0 });
    for (const p of t) assert.deepEqual({ income: p.income, expense: p.expense }, monthSum(FIX, p.month), p.month);
    const y = monthlyTrend(FIX, trendMonths({ span: "year", key: "2026" }));
    assert.deepEqual(y[11], { month: "2026-12", income: 0, expense: 0 }); // 未來的月照畫、值為 0
  });
  test("8. breakdown(category)：主＝自己＋子；有子又直接掛主 ⇒「未細分」；只有直接掛 ⇒ 沒有；分類找不到 ⇒ GONE；未分類最後、GONE 在它之後", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", category_id: "c-lunch", amount_minor: 10000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-lunch", amount_minor: 5000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-breakfast", amount_minor: 3000 }),
      E({ occurred_on: "2026-10-02", category_id: "p-food", amount_minor: 2000 }),
      E({ occurred_on: "2026-10-02", category_id: "p-other", amount_minor: 4000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-bus", amount_minor: 6000 }),
      E({ occurred_on: "2026-10-02", category_id: UNCAT_EXPENSE_ID, amount_minor: 50000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-ghost", amount_minor: 1000 }),
      E({ occurred_on: "2026-10-02", kind: "income", category_id: "i-allow", amount_minor: 777 }), // 別 kind 不入
    ];
    const b = breakdown(xs, r, "category", "expense", CTX);
    assert.deepEqual(
      b.rows.map((x) => [x.key, x.label, x.minor, x.count]),
      [
        ["p-food", "🍜 食物", 20000, 4],
        ["p-traffic", "🚖 交通", 6000, 1],
        ["p-other", "其他", 4000, 1],
        [UNCAT_EXPENSE_ID, "未分類", 50000, 1],
        [GONE_KEY, "（分類已不在）", 1000, 1],
      ],
    );
    assert.deepEqual(b.rows[0].children?.map((x) => [x.key, x.label, x.minor, x.count]), [
      ["c-lunch", "午餐", 15000, 2],
      ["c-breakfast", "早餐", 3000, 1],
      [UNSPLIT_KEY, "未細分", 2000, 1],
    ]);
    assert.deepEqual(b.rows[1].children?.map((x) => x.key), ["c-bus"]); // 有子分類列就有 children（沒有直接掛 ⇒ 沒有未細分）
    assert.equal(b.rows[2].children, undefined); // 只有直接掛主分類
    assert.equal(b.rows[3].children, undefined);
    assert.equal(b.total, 81000);
    assert.equal(b.rows[0].children?.[0].share, 15000 / 81000);
  });
  test("9. total＝正列合計、share 加總 0.99～1.01；淨退款分類進 refunds；全部為負 ⇒ total 0、share 全 0", () => {
    for (const facet of ["category", "account", "route"] as const) {
      for (const kind of ["expense", "income"] as const) {
        const b = breakdown(FIX, periodRange({ span: "year", key: "2026" }), facet, kind, CTX);
        assert.equal(b.total, b.rows.reduce((s, x) => s + x.minor, 0), `${facet}/${kind}`);
        assert.ok(b.rows.every((x) => x.minor > 0) && b.refunds.every((x) => x.minor <= 0));
        const sum = b.rows.reduce((s, x) => s + x.share, 0);
        assert.ok(sum > 0.99 && sum < 1.01, `${facet}/${kind} share 加總 ${sum}`);
      }
    }
    const march = breakdown(FIX, periodRange({ span: "month", key: "2026-03" }), "category", "expense", CTX);
    assert.ok(march.refunds.some((x) => x.key === "p-cloth"), "三月服飾淨退回");
    const neg = [E({ occurred_on: "2026-10-02", category_id: "c-clothes", amount_minor: -3000 }), E({ occurred_on: "2026-10-02", category_id: "c-bus", amount_minor: -10 })];
    const b0 = breakdown(neg, r, "category", "expense", CTX);
    assert.equal(b0.total, 0);
    assert.deepEqual(b0.rows, []);
    assert.deepEqual(b0.refunds.map((x) => [x.key, x.minor, x.share]), [["p-cloth", -3000, 0], ["p-traffic", -10, 0]]);
    // 主分類為正、某子為負 ⇒ 子留在 children、share 0（兄弟子分類 10000 / total 8000 ＞ 1 ⇒ 夾到 1，§4.1 share 0～1）；主分類為負 ⇒ 整列（含 children）進 refunds、share 全 0
    const mix = [
      E({ occurred_on: "2026-10-02", category_id: "c-lunch", amount_minor: 10000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-dinner", amount_minor: -2000 }),
      E({ occurred_on: "2026-10-02", category_id: "c-clothes", amount_minor: -3000 }),
      E({ occurred_on: "2026-10-02", category_id: "p-cloth", amount_minor: 1000 }),
    ];
    const bm = breakdown(mix, r, "category", "expense", CTX);
    assert.deepEqual(bm.rows[0].children?.map((x) => [x.key, x.minor, x.share]), [["c-lunch", 10000, 1], ["c-dinner", -2000, 0]]);
    assert.deepEqual(bm.refunds[0].children?.map((x) => [x.key, x.minor, x.share]), [[UNSPLIT_KEY, 1000, 0], ["c-clothes", -3000, 0]]);
  });
  test("10. breakdown(account)：外幣帳戶用 main_minor；帳戶不在 ⇒ GONE", () => {
    const xs = [
      E({ occurred_on: "2026-10-07", currency: "USD", account_id: "a-usd", amount_minor: 1000, main_minor: 31550 }),
      E({ occurred_on: "2026-10-07", currency: "USD", account_id: "a-usd", amount_minor: 250, main_minor: 7888 }),
      E({ occurred_on: "2026-10-07", account_id: "a-cash", amount_minor: 8000 }),
      E({ occurred_on: "2026-10-07", account_id: "a-ghost", amount_minor: 100 }),
    ];
    const b = breakdown(xs, r, "account", "expense", CTX);
    assert.deepEqual(b.rows.map((x) => [x.key, x.label, x.minor, x.count]), [
      ["a-usd", "美金帳戶", 39438, 2],
      ["a-cash", "現金", 8000, 1],
      [GONE_KEY, "（帳戶已不在）", 100, 1],
    ]);
  });
  test("11. breakdown(route)：未掛路線一列、已刪路線一列、color 帶出；金額大到小、同額照 routeOrder", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", route_id: "r-e", amount_minor: 3000 }),
      E({ occurred_on: "2026-10-02", route_id: "r-j", amount_minor: 3000 }),
      E({ occurred_on: "2026-10-02", amount_minor: 20000 }),
      E({ occurred_on: "2026-10-02", route_id: "r-ghost", amount_minor: 1000 }),
      E({ occurred_on: "2026-10-02", route_id: "r-l", amount_minor: 1500 }),
    ];
    const b = breakdown(xs, r, "route", "expense", CTX);
    assert.deepEqual(b.rows.map((x) => [x.key, x.label, x.color]), [
      [NO_ROUTE_KEY, "未掛路線", null],
      ["r-j", "日文", "var(--route-preset-2)"],
      ["r-e", "全端開發", "var(--route-preset-1)"],
      ["r-l", "體能", "var(--route-preset-3)"],
      [GONE_KEY, "（路線已刪除）", null],
    ]);
  });
  test("12. shareText 三種（0、<1%、四捨五入）", () => {
    assert.equal(shareText(0), "0%");
    assert.equal(shareText(0.0049), "<1%");
    assert.equal(shareText(0.005), "1%");
    assert.equal(shareText(0.125), "13%");
    assert.equal(shareText(1), "100%");
  });
  test("13. categoryIdsIncluding：主展開含封存子（不含已刪）、子原樣、去重、照輸入順序", () => {
    assert.deepEqual(categoryIdsIncluding(["p-life"], CATEGORIES), ["p-life", "c-rent", "c-groc"]);
    assert.deepEqual(categoryIdsIncluding(["c-lunch"], CATEGORIES), ["c-lunch"]);
    assert.deepEqual(categoryIdsIncluding(["c-lunch", "p-food"], CATEGORIES), ["c-lunch", "p-food", "c-breakfast", "c-dinner"]);
    assert.deepEqual(categoryIdsIncluding(["p-food", "p-food"], CATEGORIES), ["p-food", "c-breakfast", "c-lunch", "c-dinner"]);
    assert.deepEqual(categoryIdsIncluding(["c-ghost"], CATEGORIES), ["c-ghost"]);
  });
  test("14. facetAllowed", () => {
    assert.equal(facetAllowed("account", "a-cash"), "category");
    assert.equal(facetAllowed("account", null), "account");
    assert.equal(facetAllowed("category", "a-cash"), "category");
    assert.equal(facetAllowed("route", "a-cash"), "route");
  });
});

/* ═════════════════════════ C. 月曆 ═════════════════════════ */

describe("C. 月曆", () => {
  test("15. monthGrid：列數、第一格、最後一格（weekStart 0／1）", () => {
    const check = (month: string, ws: 0 | 1, rows: number, first: string, last: string) => {
      const g = monthGrid(month, ws);
      assert.equal(g.length, rows, `${month}/${ws} 列數`);
      assert.ok(g.every((r) => r.length === 7));
      const flat = g.flat();
      assert.equal(flat[0], first);
      assert.equal(flat[flat.length - 1], last);
      for (let i = 1; i < flat.length; i++) assert.equal(flat[i], dayStep(flat[i - 1], 1));
    };
    check("2026-10", 1, 5, "2026-09-28", "2026-11-01");
    check("2026-08", 1, 6, "2026-07-27", "2026-09-06");
    check("2026-11", 0, 5, "2026-11-01", "2026-12-05");
    check("2026-02", 1, 5, "2026-01-26", "2026-03-01");
    assert.deepEqual(weekdayHeads(1), ["一", "二", "三", "四", "五", "六", "日"]);
    assert.deepEqual(weekdayHeads(0), ["日", "一", "二", "三", "四", "五", "六"]);
  });
  test("16. calendarCells：格值＝groupByDay 同日的 income／expense；inMonth／isToday", () => {
    const oct = ALIVE_FIX.filter((e) => e.occurred_on.slice(0, 7) === "2026-10").sort(newestFirst);
    const groups = groupByDay(oct, null);
    const cells = calendarCells(FIX, "2026-10", 1, "2026-10-12");
    const flat = cells.flat();
    for (const c of flat.filter((x) => x.inMonth)) {
      const g = groups.find((x) => x.dayKey === c.dayKey);
      assert.equal(c.expense, g ? g.expense : 0, c.dayKey);
      assert.equal(c.income, g ? g.income : 0, c.dayKey);
      assert.equal(c.count, g ? g.entries.filter((e) => e.kind === "income" || e.kind === "expense").length : 0, c.dayKey);
    }
    assert.equal(flat[0].inMonth, false);
    assert.equal(flat.filter((x) => x.isToday).map((x) => x.dayKey).join(), "2026-10-12");
    const usdDay = flat.find((x) => x.dayKey === "2026-10-07") as CalendarCell;
    assert.equal(usdDay.expense, 31550 + 7888); // 同日兩筆 USD
  });
  test("17. cellText 四種（無帳、只支出、有收入、淨退）＋compact 版", () => {
    const c = (p: Partial<CalendarCell>): CalendarCell => ({ dayKey: "2026-10-02", inMonth: true, isToday: false, income: 0, expense: 0, count: 1, ...p });
    assert.deepEqual(cellText(c({ count: 0 }), 2, false), { expense: "", income: null });
    assert.deepEqual(cellText(c({ expense: 123456 }), 2, false), { expense: "1,235", income: null });
    assert.deepEqual(cellText(c({ expense: 8000, income: 200000, count: 2 }), 2, false), { expense: "80", income: "＋2,000" });
    assert.deepEqual(cellText(c({ income: 200000 }), 2, false), { expense: "", income: "＋2,000" });
    assert.deepEqual(cellText(c({ expense: -35000 }), 2, false), { expense: "−350", income: null });
    assert.deepEqual(cellText(c({ expense: 12345600, income: 10000000, count: 2 }), 2, true), { expense: "12.3萬", income: "＋10萬" });
    assert.deepEqual(cellText(c({ expense: 12345600 }), 2, false), { expense: "123,456", income: null }); // 桌機不縮
  });
  test("18. compactMoney（輸入是分、2 位小數）", () => {
    assert.equal(compactMoney(12345600, 2), "12.3萬");
    assert.equal(compactMoney(100000000, 2), "100萬");
    assert.equal(compactMoney(10000000, 2), "10萬");
    assert.equal(compactMoney(9999900, 2), "99,999");
    assert.equal(compactMoney(-12345600, 2), "−12.3萬");
    assert.equal(compactMoney(0, 2), "0");
    assert.equal(compactMoney(123456, 0), "12.3萬"); // 0 位小數的幣別
  });
  test("19. dayStep 跨月跨年、±7", () => {
    assert.equal(dayStep("2026-10-31", 1), "2026-11-01");
    assert.equal(dayStep("2026-12-31", 1), "2027-01-01");
    assert.equal(dayStep("2026-01-01", -1), "2025-12-31");
    assert.equal(dayStep("2026-02-25", 7), "2026-03-04");
    assert.equal(dayStep("2026-03-04", -7), "2026-02-25");
  });
  test("20. nearestDayWithEntries 三種（有那天、最接近往前優先、空）", () => {
    const days = [dg("2026-10-09"), dg("2026-10-05"), dg("2026-10-01")];
    assert.equal(nearestDayWithEntries(days, "2026-10-05"), "2026-10-05");
    assert.equal(nearestDayWithEntries(days, "2026-10-07"), "2026-10-05"); // 等距 ⇒ 往前
    assert.equal(nearestDayWithEntries(days, "2026-10-08"), "2026-10-09");
    assert.equal(nearestDayWithEntries(days, "2026-12-01"), "2026-10-09");
    assert.equal(nearestDayWithEntries([], "2026-10-05"), null);
  });
});

/* ═════════════════════════ D. 搜尋 ═════════════════════════ */

describe("D. 搜尋", () => {
  test("21. keywordTokens：全形、emoji 去除、數字判定", () => {
    assert.deepEqual(keywordTokens("　午餐　８０ "), [
      { key: "午餐", raw: "午餐", isNumber: false },
      { key: "80", raw: "80", isNumber: true },
    ]);
    assert.deepEqual(keywordTokens("🍜食物 1,200 80.5 80a"), [
      { key: "食物", raw: "🍜食物", isNumber: false },
      { key: "1,200", raw: "1,200", isNumber: true },
      { key: "80.5", raw: "80.5", isNumber: true },
      { key: "80a", raw: "80a", isNumber: false },
    ]);
    assert.deepEqual(keywordTokens("Ｌunch"), [{ key: "ｌunch", raw: "Ｌunch", isNumber: false }]);
    assert.deepEqual(keywordTokens("   "), []);
    assert.deepEqual(keywordTokens("🍜"), []); // 只有 emoji ⇒ catKey 後是空的、丟掉
  });
  test("22. matchesKeyword：備註、分類（子與主）、帳戶（含轉入）、路線名與代碼、AND、金額完全相符、去逗號、USD 原幣與折算、數字也比備註", () => {
    const e1 = E({ occurred_on: "2026-10-02", amount_minor: 8000, note: "便當 和同學", route_id: "r-j" });
    const e2 = E({ occurred_on: "2026-10-02", amount_minor: 80000, note: "外套", category_id: "c-clothes" });
    const e3 = E({ occurred_on: "2026-10-02", amount_minor: 8050, category_id: "c-groc" });
    const e4 = E({ occurred_on: "2026-10-02", kind: "transfer", account_id: "a-bank", to_account_id: "a-student", category_id: null, amount_minor: 120000, note: "儲值" });
    const e5 = E({ occurred_on: "2026-10-02", currency: "USD", account_id: "a-usd", amount_minor: 1000, main_minor: 31550, category_id: "c-groc" });
    const e6 = E({ occurred_on: "2026-10-02", amount_minor: 15000, note: "80 號公車", category_id: "c-bus" });
    const all = [e1, e2, e3, e4, e5, e6];
    const hits = (q: string) => all.filter((e) => matchesKeyword(e, keywordTokens(q), CTX)).map((e) => all.indexOf(e) + 1);
    assert.deepEqual(hits("便當"), [1]);
    assert.deepEqual(hits("和同學 便當"), [1]);
    assert.deepEqual(hits("便當 外套"), []);
    assert.deepEqual(hits("食物"), [1]);
    assert.deepEqual(hits("午餐"), [1]);
    assert.deepEqual(hits("學生證"), [4]);
    assert.deepEqual(hits("日文"), [1]);
    assert.deepEqual(hits("j"), [1]);
    assert.deepEqual(hits("80"), [1, 6]);
    assert.deepEqual(hits("80.00"), [1]); // 金額視同 80；文字照字面比（備註裡沒有「80.00」）
    assert.deepEqual(hits("800"), [2]);
    assert.deepEqual(hits("80.5"), [3]);
    assert.deepEqual(hits("80.50"), [3]);
    assert.deepEqual(hits("1,200"), [4]);
    assert.deepEqual(hits("1200"), [4]);
    assert.deepEqual(hits("10"), [5]);
    assert.deepEqual(hits("315.5"), [5]);
    assert.deepEqual(hits("31550"), []);
    assert.deepEqual(hits("公車 80"), [6]);
    assert.deepEqual(hits(""), [1, 2, 3, 4, 5, 6]);
  });
  test("23. filterEntries：五欄各一＋組合（與逐條手算的結果相同、新到舊）", () => {
    const xs = shuffled(FIX, 3);
    const naive = (pred: (e: EntryRow) => boolean) => ALIVE_FIX.filter(pred).sort(newestFirst).map((e) => e.id);
    const ids = (f: Partial<EntryFilter>) => filterEntries(xs, { ...EMPTY_FILTER, ...f }, CTX).map((e) => e.id);
    assert.deepEqual(ids({ from: "2026-03-01", toExcl: "2026-05-01" }), naive((e) => e.occurred_on >= "2026-03-01" && e.occurred_on < "2026-05-01"));
    assert.deepEqual(ids({ accountId: "a-student" }), naive((e) => e.account_id === "a-student" || e.to_account_id === "a-student"));
    const food = ["p-food", "c-breakfast", "c-lunch", "c-dinner"];
    assert.deepEqual(ids({ categoryIds: ["p-food"] }), naive((e) => e.category_id !== null && food.indexOf(e.category_id) >= 0));
    assert.deepEqual(ids({ kinds: ["transfer", "adjust"] }), naive((e) => e.kind === "transfer" || e.kind === "adjust"));
    assert.deepEqual(ids({ routeId: "none" }), naive((e) => e.route_id === null));
    assert.deepEqual(ids({ routeId: "r-j" }), naive((e) => e.route_id === "r-j"));
    assert.deepEqual(
      ids({ from: "2026-10-01", toExcl: "2026-11-01", kinds: ["expense"], routeId: "r-j" }),
      naive((e) => e.occurred_on >= "2026-10-01" && e.kind === "expense" && e.route_id === "r-j"),
    );
    assert.deepEqual(ids({ text: "便當" }), naive((e) => e.note.indexOf("便當") >= 0));
    assert.equal(ids({}).length, ALIVE_FIX.length); // 全空＝全部未刪
    assert.ok(ids({ text: "刪掉的" }).length === 0); // 墓碑不出
  });
  test("24. SQL 對帳：SqliteTicketRepository.queryEntries(filterToQuery(f)) 再 matchesKeyword ≡ filterEntries(all, f)；routeSpend ≡ routeSpendOf", async () => {
    const db = makeSqliteDb();
    // 掛著路線的收入／轉帳／校正／墓碑：routeSpend 的 SQL 一個都不能算進去（fixture 本身沒有這幾種掛路線的帳）
    const extras = [
      E({ occurred_on: "2026-10-11", route_id: "r-j", kind: "income", category_id: "i-allow", amount_minor: 70000 }),
      E({ occurred_on: "2026-10-11", route_id: "r-j", kind: "transfer", account_id: "a-bank", to_account_id: "a-cash", category_id: null, amount_minor: 3300 }),
      E({ occurred_on: "2026-10-11", route_id: "r-j", kind: "adjust", category_id: null, amount_minor: 450 }),
      E({ occurred_on: "2026-10-11", route_id: "r-j", amount_minor: 9100, deleted_at: NOW }),
    ];
    const ALL = FIX.concat(extras);
    for (const e of ALL) db.insert(e);
    (globalThis as { __tkDb?: unknown }).__tkDb = db;
    const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
    const repo = new SqliteTicketRepository();
    const check = async (f: EntryFilter, label = JSON.stringify(f)) => {
      const rows = await repo.queryEntries(filterToQuery(f, ALIVE_CATS));
      // 結構條件這一半：SQL 的結果＝純函式 matchesQuery 的結果（含排序）
      const q = filterToQuery(f, ALIVE_CATS);
      assert.deepEqual(rows.map((e: EntryRow) => e.id), ALL.filter((e) => matchesQuery(e, q)).sort(newestFirst).map((e) => e.id), `結構 ${label}`);
      // 加上關鍵字：與 filterEntries 一條龍同結果
      const sql = rows.filter((e: EntryRow) => matchesKeyword(e, keywordTokens(f.text), CTX)).map((e: EntryRow) => e.id);
      assert.deepEqual(sql, filterEntries(ALL, f, CTX).map((e) => e.id), label);
      assert.ok(rows.every((e: EntryRow) => e.deleted_at === null), `墓碑不出 ${label}`);
    };
    // 手排的邊角：全空、每欄各一、組合
    await check(EMPTY_FILTER);
    await check({ ...EMPTY_FILTER, from: "2026-10-01", toExcl: "2026-11-01" });
    await check({ ...EMPTY_FILTER, from: "2026-10-31" }); // 邊界日
    await check({ ...EMPTY_FILTER, toExcl: "2025-12-05" }); // 邊界（不含）
    await check({ ...EMPTY_FILTER, accountId: "a-student" }); // 含轉入方
    await check({ ...EMPTY_FILTER, accountId: "a-ghost" });
    await check({ ...EMPTY_FILTER, categoryIds: ["p-food"] }); // 主分類展開
    await check({ ...EMPTY_FILTER, categoryIds: ["c-ghost"] }); // 不在的分類 id 仍可查
    await check({ ...EMPTY_FILTER, kinds: ["transfer", "adjust"] });
    await check({ ...EMPTY_FILTER, kinds: ["income"], from: "2026-01-01" });
    await check({ ...EMPTY_FILTER, routeId: "none" });
    await check({ ...EMPTY_FILTER, routeId: "r-ghost" });
    await check({ ...EMPTY_FILTER, text: "80", kinds: ["expense"], routeId: "r-j", accountId: "a-cash", categoryIds: ["p-food"], from: "2026-01-01", toExcl: "2027-01-01" });
    // 隨機 filter 六十組
    const rnd = prng(24);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    for (let i = 0; i < 60; i++) {
      await check({
        text: pick(["", "", "便當", "80", "日文", "學生證", "App", "退"]),
        from: pick([null, "2025-12-01", "2026-01-01", "2026-10-01"]),
        toExcl: pick([null, "2026-03-01", "2026-07-01", "2026-11-01"]),
        accountId: pick([null, null, "a-cash", "a-student", "a-usd", "a-old"]),
        categoryIds: pick([[], [], ["p-food"], ["c-bus", "p-life"], ["i-allow"], [UNCAT_EXPENSE_ID, "p-other"]]),
        kinds: pick<readonly EntryKind[]>([[], [], ["expense"], ["income"], ["transfer", "adjust"], ["expense", "income"]]),
        routeId: pick([null, null, "none", "r-j", "r-e", "r-l"]),
      });
    }
    // routeSpend：SQL ≡ routeSpendOf（含沒有帳的路線、已不在的路線、各種期間）
    for (const id of ["r-j", "r-e", "r-l", "r-ghost", "r-none"]) {
      for (const r of [{ from: "2026-10-01", toExcl: "2026-11-01" }, { from: "2026-09-01", toExcl: "2026-10-01" }, { from: "2025-01-01", toExcl: "2025-02-01" }, { from: "2026-01-01", toExcl: "2027-01-01" }]) {
        assert.deepEqual(await repo.routeSpend(id, r.from, r.toExcl), routeSpendOf(ALL, id, r), `${id} ${r.from}`);
      }
    }
    // 0-11：r-j 十月有一筆 −1,500 的退款 ⇒ SQL 的本月淨額比「只加正的」少 1,500（退款真的抵回）
    const rj = FIX.filter((e) => e.deleted_at === null && e.kind === "expense" && e.route_id === "r-j" && e.occurred_on >= "2026-10-01" && e.occurred_on < "2026-11-01");
    const gross = rj.filter((e) => e.main_minor > 0).reduce((n, e) => n + e.main_minor, 0);
    assert.ok(rj.some((e) => e.main_minor === -1500));
    assert.equal((await repo.routeSpend("r-j", "2026-10-01", "2026-11-01")).inRange, gross - 1500);
  });
  test("24b. SQL 的 IN (…) 上限：category_id 超過 500 個 ⇒ 不拼那一句、改在 TS 補篩，結果與純函式同", async () => {
    const db = makeSqliteDb();
    for (const e of FIX) db.insert(e);
    (globalThis as { __tkDb?: unknown }).__tkDb = db;
    const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
    const repo = new SqliteTicketRepository();
    const many = Array.from({ length: 600 }, (_, i) => `x-${i}`).concat(["c-bus", "c-lunch", "p-other"]);
    const q = { ...filterToQuery(EMPTY_FILTER, ALIVE_CATS), categoryIds: many, kinds: ["expense" as const] };
    const rows = await repo.queryEntries(q);
    assert.deepEqual(rows.map((e: EntryRow) => e.id), FIX.filter((e) => matchesQuery(e, q)).sort(newestFirst).map((e) => e.id));
    assert.ok(rows.length > 0 && rows.every((e: EntryRow) => ["c-bus", "c-lunch", "p-other"].indexOf(e.category_id ?? "") >= 0));
    // 剛好 500 個（上限內、走 SQL 的 IN）：全是不存在的 id ⇒ 空
    const q2 = { ...q, categoryIds: many.slice(0, 500) };
    assert.deepEqual((await repo.queryEntries(q2)).map((e: EntryRow) => e.id), []);
    // 剛好 500 個且含真分類 ⇒ 與純函式同
    const q3 = { ...q, categoryIds: many.slice(0, 497).concat(["c-bus", "c-lunch", "p-other"]) };
    assert.deepEqual((await repo.queryEntries(q3)).map((e: EntryRow) => e.id), FIX.filter((e) => matchesQuery(e, q3)).sort(newestFirst).map((e) => e.id));
  });
  test("24m. mock 的 queryEntries／routeSpend 用同一套純函式（MemoryTicketRepository；與 filterEntries 同結果）", async () => {
    const { MemoryTicketRepository } = await import("../../src/data/memoryTicketRepository.ts");
    const repo = new MemoryTicketRepository({ seedDemo: false }) as unknown as { ent: Map<string, EntryRow>; queryEntries(q: unknown): Promise<EntryRow[]>; routeSpend(id: string, f: string, t: string): Promise<unknown> };
    for (const e of FIX) repo.ent.set(e.id, { ...e });
    const f: EntryFilter = { ...EMPTY_FILTER, from: "2026-01-01", categoryIds: ["p-food"], kinds: ["expense"] };
    const rows = await repo.queryEntries(filterToQuery(f, ALIVE_CATS));
    assert.deepEqual(rows.map((e) => e.id), filterEntries(FIX, f, CTX).map((e) => e.id));
    assert.deepEqual(await repo.routeSpend("r-j", "2026-10-01", "2026-11-01"), routeSpendOf(FIX, "r-j", { from: "2026-10-01", toExcl: "2026-11-01" }));
  });
  test("25. resultSummary、filterChips 文字逐字", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", amount_minor: 8000 }),
      E({ occurred_on: "2026-10-02", amount_minor: -3500 }),
      E({ occurred_on: "2026-10-02", kind: "income", category_id: "i-allow", amount_minor: 200000 }),
      E({ occurred_on: "2026-10-02", kind: "transfer", account_id: "a-bank", to_account_id: "a-cash", category_id: null, amount_minor: 50000 }),
      E({ occurred_on: "2026-10-02", kind: "adjust", category_id: null, amount_minor: 1200 }),
    ];
    assert.equal(resultSummary(xs, 2), "找到 5 筆 · 支出 45 · 收入 2,000");
    assert.equal(resultSummary([], 2), "找到 0 筆 · 支出 0 · 收入 0");
    const f: EntryFilter = {
      text: "便當",
      from: "2026-10-01",
      toExcl: "2026-11-01",
      accountId: "a-cash",
      categoryIds: ["c-lunch"],
      kinds: ["transfer", "expense"],
      routeId: "r-j",
    };
    assert.deepEqual(filterChips(f, CTX), [
      { key: "from", label: "期間 10/1–10/31" },
      { key: "accountId", label: "帳戶 現金" },
      { key: "categoryIds", label: "分類 🍜 食物 › 午餐" },
      { key: "kinds", label: "類型 支出、轉帳" },
      { key: "routeId", label: "路線 ●J 日文" },
    ]);
    assert.deepEqual(filterChips({ ...EMPTY_FILTER, categoryIds: ["c-lunch", "c-bus", "p-life"], routeId: "none" }, CTX), [
      { key: "categoryIds", label: "分類 3 個" },
      { key: "routeId", label: "未掛路線" },
    ]);
    assert.deepEqual(filterChips({ ...EMPTY_FILTER, from: "2025-12-01", toExcl: "2026-02-01" }, CTX), [{ key: "from", label: "期間 2025/12/1–2026/1/31" }]);
    assert.deepEqual(filterChips({ ...EMPTY_FILTER, from: "2026-10-01" }, CTX), [{ key: "from", label: "期間 10/1 起" }]);
    assert.deepEqual(filterChips({ ...EMPTY_FILTER, accountId: "a-ghost", routeId: "r-ghost" }, CTX), [
      { key: "accountId", label: "帳戶 （帳戶已不在）" },
      { key: "routeId", label: "路線 （路線已刪除）" },
    ]);
    assert.deepEqual(filterChips(EMPTY_FILTER, CTX), []);
  });
  test("26. pageResults", () => {
    const xs = Array.from({ length: 700 }, (_, i) => i);
    assert.equal(pageResults(xs, 1).length, RESULT_PAGE);
    assert.equal(pageResults(xs, 2).length, RESULT_PAGE * 2);
    assert.equal(pageResults(xs, 3).length, 700);
    assert.equal(pageResults(xs, 0).length, RESULT_PAGE);
  });
});

/* ═════════════════════════ E. 路線 ═════════════════════════ */

describe("E. 路線", () => {
  test("27. routeSpendOf：轉帳校正收入不入、退款抵回、期間、allTime 含封存帳戶、墓碑不算", () => {
    const xs = [
      E({ occurred_on: "2026-10-02", route_id: "r-j", amount_minor: 10000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", amount_minor: -2000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", kind: "income", category_id: "i-allow", amount_minor: 50000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", kind: "transfer", account_id: "a-bank", to_account_id: "a-cash", category_id: null, amount_minor: 3000 }),
      E({ occurred_on: "2026-10-03", route_id: "r-j", kind: "adjust", category_id: null, amount_minor: 700 }),
      E({ occurred_on: "2026-09-12", route_id: "r-j", amount_minor: 7000 }),
      E({ occurred_on: "2026-08-12", route_id: "r-j", account_id: "a-old", amount_minor: 4000 }),
      E({ occurred_on: "2026-10-04", route_id: "r-j", amount_minor: 9999, deleted_at: NOW }),
      E({ occurred_on: "2026-10-04", route_id: "r-e", amount_minor: 555 }),
    ];
    const oct = periodRange(OCT);
    assert.deepEqual(routeSpendOf(xs, "r-j", oct), { inRange: 8000, allTime: 19000 });
    assert.deepEqual(routeSpendOf(xs, "r-l", oct), { inRange: 0, allTime: 0 });
    // fixture：與 breakdown(route) 的那一列同數
    const b = breakdown(FIX, oct, "route", "expense", CTX);
    for (const rt of ROUTES) {
      const row = b.rows.concat(b.refunds).find((x) => x.key === rt.id);
      assert.equal(routeSpendOf(FIX, rt.id, oct).inRange, row ? row.minor : 0, rt.id);
    }
  });
  test("28. spendText／asideText（0 ⇒ null）", () => {
    assert.equal(spendText(123000, 1842000, 2), "本月 1,230／累計 18,420");
    assert.equal(spendText(0, 0, 2), "本月 0／累計 0");
    assert.equal(asideText(0, 2), null);
    assert.equal(asideText(123000, 2), "本月花 1,230"); // 磨光③ 2-6：跟時刻表「本月 3h」並排要分得出是錢
    assert.equal(asideText(-5000, 2), "本月花 −50");
  });
});

/* ═════════════════════════ F. 決定性 ═════════════════════════ */

describe("F. 決定性", () => {
  test("29. fixture 順序打亂 10 次 ⇒ breakdown／calendarCells／statsOverview 輸出 deepEqual", () => {
    const year = periodRange({ span: "year", key: "2026" });
    const snap = (xs: EntryRow[]) => ({
      b: (["category", "account", "route"] as const).map((f) => [breakdown(xs, year, f, "expense", CTX), breakdown(xs, year, f, "income", CTX)]),
      c: calendarCells(xs, "2026-10", 1, "2026-10-12"),
      o: statsOverview(xs, year),
      t: monthlyTrend(xs, trendMonths(OCT)),
    });
    const base = snap(FIX);
    for (let i = 0; i < 10; i++) assert.deepEqual(snap(shuffled(FIX, 100 + i)), base, `第 ${i + 1} 次`);
  });
});

/* ───────── 24 用的 node:sqlite 記憶體 DB（plugin-sql 形狀；外鍵關掉——fixture 有指到不在的分類／帳戶） ───────── */

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
