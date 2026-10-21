/**
 * 售票口・磨光⑥ 契約 §2-3／§2-4 的 store 層測試（D-票-63、D-票-64）：「常用」從用量算出來、搜尋結果排序、排序記在本機設定。
 * 跑法：`node --test scripts/tests/ticket-sort-store.test.ts`（node 24，型別剝除；零依賴）。
 *
 * 載入法照 ticket-view-counter.test.ts：registerHooks 補 `.ts`，store 的 `../data/ticketRepository`／`../data`／`./uiStore`／`./nodeStore`
 * 換成 data: 模組（repo 與設定委派給 globalThis 上的替身）。純函式本身的測試在 ticket-logic／ticket-view-logic。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const FAKE_DB = `
export function getDb() { return Promise.reject(new Error("這個測試不碰 DB")); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { return new Date().toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch() {}
`;
const FAKE_CORE = `export async function invoke() { throw new Error("測試不 invoke"); }`;
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
`;
const FAKE_NODE = `${MINI_STORE}
export const useNodeStore = mk({ routes: [] });
`;
const FAKE_REPO = `export const ticketRepo = new Proxy({}, { get: (_, k) => (...a) => globalThis.__tkRepo[k](...a) });`;
/** 本機設定：Map 放在 globalThis，測試可以看、可以預先塞值；set 可以被要求失敗 */
const FAKE_DATA = `
globalThis.__settings = globalThis.__settings ?? new Map();
export const settingsRepo = {
  async get(k) {
    const v = globalThis.__settings.has(k) ? globalThis.__settings.get(k) : null;
    if (globalThis.__settingsGate) await globalThis.__settingsGate; // 測試可以卡住讀取，模擬「讀的途中使用者先動手」
    return v;
  },
  async set(k, v) { if (globalThis.__settingsFail) throw new Error("寫不進去"); globalThis.__settings.set(k, v); },
};
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? "";
    if (parent.includes("/src/")) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (parent.includes("/src/store/ticketStore")) {
        if (specifier === "../data/ticketRepository") return { url: dataUrl(FAKE_REPO), shortCircuit: true };
        if (specifier === "../data") return { url: dataUrl(FAKE_DATA), shortCircuit: true };
        if (specifier === "./uiStore") return { url: dataUrl(FAKE_UI), shortCircuit: true };
        if (specifier === "./nodeStore") return { url: dataUrl(FAKE_NODE), shortCircuit: true };
      }
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

import type { AccountRow, CategoryRow, CurrencyRow, EntryRow } from "../../src/domain/ticket.ts";

const { ticketId } = await import("../../src/domain/ticket.ts");
const { matchesQuery, newestFirst, pageResults, RESULT_PAGE } = await import("../../src/domain/ticketView.ts");
const { todayKey, addDays } = await import("../../src/lib/date.ts");

const NOW = new Date(2026, 9, 12, 9, 0).toISOString();
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };
const TODAY = todayKey(0); // fake uiStore 的 dayStartHour＝0
const MONTH = TODAY.slice(0, 7);

const CURRENCIES: CurrencyRow[] = [{ id: ticketId("currency:TWD"), code: "TWD", name: "TWD", decimals: 2, rate_to_main: "1", is_main: 1, position: 0, ...SYNC }];
const acc = (id: string, group: string, position: number): AccountRow => ({ id, name: id, group_key: group, currency: "TWD", position, archived_at: null, ...SYNC });
const cat = (id: string, kind: "income" | "expense"): CategoryRow => ({ id, kind, name: id, parent_id: null, position: 0, archived_at: null, ...SYNC });
const ACCOUNTS = [acc("a1", "cash", 0), acc("a2", "bank", 0), acc("a3", "bank", 1), acc("a4", "card", 0)];
// pa＝已封存的主分類、pc＝它底下的子分類（完整分類樹看不到它 ⇒「常用」也不該列）
const CATS = [
  cat("x", "expense"),
  cat("y", "expense"),
  cat("i", "income"),
  { ...cat("pa", "expense"), archived_at: NOW },
  { ...cat("pc", "expense"), parent_id: "pa" },
];

let seq = 0;
function E(p: Partial<EntryRow> & { occurred_on: string }): EntryRow {
  seq++;
  const main = p.main_minor ?? 1000;
  return {
    id: `s${String(seq).padStart(3, "0")}`,
    kind: "expense",
    occurred_at: new Date(`${p.occurred_on}T12:00:00`).toISOString(),
    account_id: "a1",
    to_account_id: null,
    category_id: "x",
    amount_minor: main,
    currency: "TWD",
    main_minor: main,
    account_minor: main,
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

const entries: EntryRow[] = [
  E({ occurred_on: `${MONTH}-01`, main_minor: 500, note: "便當" }),
  E({ occurred_on: `${MONTH}-01`, main_minor: 9000, note: "便當" }),
  E({ occurred_on: `${MONTH}-02`, main_minor: 300, note: "便當" }),
  E({ occurred_on: `${MONTH}-03`, main_minor: 9000, note: "便當" }),
  E({ occurred_on: `${MONTH}-03`, main_minor: 20000, kind: "income", category_id: "i", note: "便當" }),
];

const usageCalls: string[] = [];
const repo = {
  async ensureStarterRows() {},
  async listCurrencies() {
    return CURRENCIES.slice();
  },
  async listAccounts() {
    return ACCOUNTS.slice();
  },
  async listCategories() {
    return CATS.slice();
  },
  async lastUsedAccountId() {
    return null;
  },
  async recentCategoryIds(kind: string) {
    return kind === "expense" ? ["pc", "y"] : [];
  },
  async usageSince(since: string) {
    usageCalls.push(since);
    return {
      categories: [
        { id: "x", n: 4, last: `${TODAY} 12` },
        { id: "pc", n: 9, last: `${TODAY} 12` }, // 父分類已封存 ⇒ 不列
        { id: "i", n: 1, last: `${TODAY} 12` },
        { id: "ghost", n: 9, last: `${TODAY} 12` }, // 不在 categories 的 id（kind 對不上）⇒ 不列
      ],
      accounts: [
        { id: "a3", n: 5 },
        { id: "a1", n: 2 },
        { id: "a2", n: 2 },
        { id: "a4", n: 1 },
      ],
    };
  },
  async balances() {
    return {};
  },
  async hasAnyEntry() {
    return true;
  },
  async listEntries() {
    return [];
  },
  async queryEntries(q: Parameters<typeof matchesQuery>[1]) {
    return entries.filter((e) => matchesQuery(e, q)).sort(newestFirst);
  },
  async listBudgets() {
    return [];
  },
  async listRepeats() {
    return [];
  },
  async listUnstartedRepeatIds() {
    return [];
  },
};
(globalThis as { __tkRepo?: unknown }).__tkRepo = repo;
const settings = (globalThis as unknown as { __settings?: Map<string, string> }).__settings ?? new Map<string, string>();
(globalThis as unknown as { __settings: Map<string, string> }).__settings = settings;

describe("ticketStore 磨光⑥：常用與搜尋排序", async () => {
  settings.set("ticket_result_sort", "amountDesc"); // 這台上次選的
  const { useTicketStore } = await import("../../src/store/ticketStore.ts");
  const st = () => useTicketStore.getState();
  const ids = (xs: readonly EntryRow[] | null) => (xs ?? []).map((e) => e.id);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  await st().init("desktop");
  await tick();

  test("frequent：分類＝30 天次數多的在前、不滿 8 個用 recent 補（父分類已封存的子分類 pc 不列）；帳戶＝前 3（同次數照 orderAccounts）；usageSince 的起點＝今天往前 29 天", () => {
    assert.deepEqual(st().frequent.expense, ["x", "y"]);
    assert.deepEqual(st().frequent.income, ["i"]); // ghost 的 kind 對不上 ⇒ 不列
    assert.deepEqual(st().frequent.accounts, ["a3", "a1", "a2"]); // a3 五次；a1、a2 同二次 ⇒ cash 群組在 bank 前
    assert.ok(usageCalls.length >= 1);
    assert.equal(usageCalls[0], addDays(TODAY, -29));
  });

  test("啟動時讀回本機設定的排序（桌機鍵 ticket_result_sort）", () => {
    assert.equal(st().resultSort, "amountDesc");
  });

  test("金額排序：results 照主幣絕對值大到小、同值日期新到舊；resultDays 是空的（平面清單）", async () => {
    await st().setFilterText("便當");
    const got = st().results ?? [];
    assert.deepEqual(got.map((e) => e.main_minor), [20000, 9000, 9000, 500, 300]);
    assert.deepEqual(ids(got).slice(1, 3), [entries[3].id, entries[1].id]); // 兩筆 9,000：03 日的在 01 日前
    assert.deepEqual(st().resultDays, []);
  });

  test("換排序：不重查、立刻重排；日期舊到新 ⇒ 日組舊到新、組內也舊到新；寫進本機鍵", async () => {
    const calls = usageCalls.length;
    st().setResultSort("dateAsc");
    assert.deepEqual(st().resultDays.map((g) => g.dayKey), [`${MONTH}-01`, `${MONTH}-02`, `${MONTH}-03`]);
    assert.deepEqual(ids(st().resultDays[0].entries), [entries[0].id, entries[1].id]);
    assert.deepEqual(ids(st().results), ids(st().resultDays.flatMap((g) => g.entries)), "results 與畫面順序一致（鍵盤 ↑↓ 靠它）");
    await tick();
    assert.equal(settings.get("ticket_result_sort"), "dateAsc");
    assert.equal(usageCalls.length, calls, "換排序不重讀用量");
    st().setResultSort("dateDesc");
    assert.deepEqual(st().resultDays.map((g) => g.dayKey), [`${MONTH}-03`, `${MONTH}-02`, `${MONTH}-01`]);
  });

  test("清除搜尋 ⇒ 排序回日期・新到舊，本機鍵也回預設（重開 App 不會莫名變金額排序）", async () => {
    st().setResultSort("amountAsc");
    await tick();
    st().closeSearch();
    assert.equal(st().resultSort, "dateDesc");
    assert.equal(st().results, null);
    await tick();
    assert.equal(settings.get("ticket_result_sort"), "dateDesc");
  });

  test("一般清單的「排序」：沒搜尋 ⇒ 開搜尋、期間＝現在看的月、套上排序；已經在搜尋 ⇒ 只換排序", async () => {
    await st().searchMonthSorted("amountDesc");
    assert.equal(st().searchOpen, true);
    assert.equal(st().filter.from, `${MONTH}-01`);
    assert.equal(st().resultSort, "amountDesc");
    assert.equal((st().results ?? []).length, entries.length);
    assert.equal((st().results ?? [])[0].main_minor, 20000);
    const f = st().filter;
    await st().searchMonthSorted("amountAsc");
    assert.equal(st().filter, f, "已在搜尋 ⇒ 條件不動");
    assert.equal((st().results ?? [])[0].main_minor, 300);
    st().closeSearch();
  });

  test("讀本機鍵的途中使用者先選了排序 ⇒ 讀回來的舊值不蓋掉它（換殼 init 時）", async () => {
    const g = globalThis as unknown as { __settingsGate?: Promise<void> };
    settings.set("ticket_result_sort_mobile", "amountAsc");
    let release!: () => void;
    g.__settingsGate = new Promise<void>((r) => (release = r));
    await st().init("mobile");
    st().setResultSort("dateAsc");
    g.__settingsGate = undefined;
    release();
    await tick();
    await tick();
    assert.equal(st().resultSort, "dateAsc");
    assert.equal(settings.get("ticket_result_sort_mobile"), "dateAsc");
    st().closeSearch();
    await tick();
  });

  test("分頁：選中第 350 筆 ⇒ 要翻到第 2 頁才畫得到（TicketLedger 自動翻頁的算式）", () => {
    const rows = Array.from({ length: 400 }, (_, i) => i);
    const page = Math.floor(350 / RESULT_PAGE) + 1;
    assert.equal(page, 2);
    assert.ok(pageResults(rows, page).includes(350));
    assert.ok(!pageResults(rows, 1).includes(350));
  });

  test("本機鍵寫不進去 ⇒ 吞掉，排序照樣生效", async () => {
    (globalThis as unknown as { __settingsFail: boolean }).__settingsFail = true;
    await st().setFilterText("便當");
    st().setResultSort("amountDesc");
    await tick();
    assert.equal(st().resultSort, "amountDesc");
    assert.equal((st().results ?? [])[0].main_minor, 20000);
    (globalThis as unknown as { __settingsFail: boolean }).__settingsFail = false;
    st().closeSearch();
  });
});
