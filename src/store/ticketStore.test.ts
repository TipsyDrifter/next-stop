/**
 * ticketStore.test.ts——售票口 v1.32（2B-1a 管帳分籤與返回母籤 ＆ 2B-2 當月直篩帳戶條件與鍵盤選取／跨月搜尋升格）Store 單元測試。
 * 執行：`node --test "src/store/ticketStore.test.ts"`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { AccountRow, CategoryRow, CurrencyRow, EntryRow } from "../domain/ticket.ts";

const FAKE_DB = `
export function getDb() { return Promise.reject(new Error("test no db")); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { return new Date().toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch() {}
`;
const FAKE_CORE = `export async function invoke() { throw new Error("test no invoke"); }`;
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
const FAKE_REPO = `export const ticketRepo = new Proxy({}, { get: (_, k) => (...a) => globalThis.__tkMgmtTestRepo[k](...a) });`;
const FAKE_DATA = `
globalThis.__tkMgmtSettings = globalThis.__tkMgmtSettings ?? new Map();
export const nodeRepo = { async getNode() { return null; } };
export const settingsRepo = {
  async get(k) { return globalThis.__tkMgmtSettings.has(k) ? globalThis.__tkMgmtSettings.get(k) : null; },
  async set(k, v) { globalThis.__tkMgmtSettings.set(k, v); },
};
`;
const FAKE_TAG_REPO = `
const empty = () => ({ createdTagIds: [], createdTaggingIds: [], tagsBefore: [], taggingsBefore: [], notesBefore: [] });
export const tagRepo = {
  async listTagsOf() { return []; },
  async setTags() { return { receipt: empty(), created: [] }; },
};
`;
const FAKE_TAG_STORE = `${MINI_STORE}
export const useTagStore = mk({ index: null, async loadIndex() {} });
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
        if (specifier === "../data/tagRepo") return { url: dataUrl(FAKE_TAG_REPO), shortCircuit: true };
        if (specifier === "./tagStore") return { url: dataUrl(FAKE_TAG_STORE), shortCircuit: true };
      }
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { ticketId } = await import("../domain/ticket.ts");
const { DEFAULT_ENTRY_SORT, EMPTY_FILTER, isInMonthFilterActive, matchesQuery, newestFirst } = await import("../domain/ticketView.ts");

const NOW = "2026-11-15T09:00:00.000Z";
const SYNC = { device_id: "dev1", created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };

const CURRENCIES: CurrencyRow[] = [
  { id: ticketId("currency:TWD"), code: "TWD", name: "TWD", decimals: 2, rate_to_main: "1", is_main: 1, position: 0, ...SYNC },
];
const ACCOUNTS: AccountRow[] = [
  { id: "a1", name: "現金", group_key: "cash", currency: "TWD", position: 0, archived_at: null, ...SYNC },
  { id: "a2", name: "信用卡", group_key: "card", currency: "TWD", position: 0, archived_at: null, ...SYNC },
];
const CATS: CategoryRow[] = [
  { id: "c1", kind: "expense", name: "餐飲", parent_id: null, position: 0, archived_at: null, ...SYNC },
];

function makeEntry(p: Partial<EntryRow> & { id: string; occurred_on: string; account_id: string }): EntryRow {
  const main = p.main_minor ?? 1000;
  return {
    kind: "expense",
    occurred_at: `${p.occurred_on}T12:00:00.000Z`,
    to_account_id: null,
    category_id: "c1",
    amount_minor: main,
    currency: "TWD",
    main_minor: main,
    account_minor: main,
    to_amount_minor: null,
    note: "",
    route_id: null,
    repeat_id: null,
    import_id: null,
    import_source: null,
    import_utime: null,
    ...SYNC,
    ...p,
  };
}

const ALL_ENTRIES: EntryRow[] = [
  makeEntry({ id: "nov_a1_2", occurred_on: "2026-11-12", account_id: "a1", main_minor: 1500 }),
  makeEntry({ id: "nov_a2_1", occurred_on: "2026-11-11", account_id: "a2", main_minor: 2000 }),
  makeEntry({ id: "nov_a1_1", occurred_on: "2026-11-10", account_id: "a1", main_minor: 800 }),
  makeEntry({ id: "oct_a1_old", occurred_on: "2026-10-25", account_id: "a1", main_minor: 3200 }),
];

const repo = {
  async ensureStarterRows() {},
  async listCurrencies() { return CURRENCIES.slice(); },
  async listAccounts() { return ACCOUNTS.slice(); },
  async listCategories() { return CATS.slice(); },
  async lastUsedAccountId() { return null; },
  async recentCategoryIds() { return []; },
  async usageSince() { return { categories: [], accounts: [] }; },
  async balances() { return {}; },
  async hasAnyEntry() { return true; },
  async listEntries(from: string, toExcl: string, accountId: string | null) {
    return ALL_ENTRIES
      .filter((e) => e.occurred_on >= from && e.occurred_on < toExcl)
      .filter((e) => !accountId || e.account_id === accountId || e.to_account_id === accountId)
      .sort(newestFirst);
  },
  async queryEntries(q: Parameters<typeof matchesQuery>[1]) {
    return ALL_ENTRIES.filter((e) => matchesQuery(e, q)).sort(newestFirst);
  },
  async listBudgets() { return []; },
  async listRepeats() { return []; },
  async materializeRepeats() { return { created: 0 }; },
  async listWishes() { return []; },
  async listWishKinds() { return []; },
  async listTemplates() { return []; },
  async getEntries() { return []; },
  async getWishTargets() { return {}; },
};
(globalThis as unknown as { __tkMgmtTestRepo: unknown }).__tkMgmtTestRepo = repo;

describe("ticketStore v1.32（2B-1a & 2B-2）", async () => {
  const { useTicketStore } = await import("./ticketStore.ts");
  const st = () => useTicketStore.getState();
  const tick = () => new Promise((r) => setTimeout(r, 0));

  await st().init("desktop");
  await tick();
  await st().setMonth("2026-11");

  test("2B-1a：openDialog 向下相容舊六籤正規化為 manage，且新增帳戶／定期帳子彈窗關閉退回原管理母籤", () => {
    st().openDialog({ kind: "budgets" });
    assert.deepEqual(st().dialog, { kind: "manage", tab: "budgets" });

    st().openDialog({ kind: "manage", tab: "accountOrder" });
    st().openDialog({ kind: "newAccount" });
    assert.deepEqual(st().dialog, { kind: "newAccount" });
    st().closeAccountDialog();
    assert.deepEqual(st().dialog, { kind: "manage", tab: "accountOrder" });

    st().openDialog({ kind: "manage", tab: "repeats" });
    st().openRepeatEditor(null);
    assert.equal(st().dialog?.kind, "repeat");
    st().closeRepeatEditor();
    assert.deepEqual(st().dialog, { kind: "manage", tab: "repeats" });
    st().closeDialog();
    assert.equal(st().dialog, null);
  });

  test("2B-2：已載入跨月舊資料（loadedMonths > 1）再切單一帳戶當月直篩時，moveSelection 嚴格停留在當月可見列、不選進舊月份", async () => {
    await st().setFilter(null);
    st().clearListFilter();
    await st().setMonth("2026-11");
    await st().loadOlderMonth(); // 載入 2026-10，使 days 含 2026-11 與 2026-10
    assert.deepEqual(st().loadedMonths, ["2026-11", "2026-10"]);

    // 切單選帳戶 a1（listFilter 仍為 EMPTY_FILTER、listSort 仍為預設）
    await st().setFilter("a1");
    assert.equal(st().listSort, DEFAULT_ENTRY_SORT);
    assert.deepEqual(st().listFilter, EMPTY_FILTER);
    assert.equal(isInMonthFilterActive(st().listFilter, st().listSort, st().filterAccountId), true);

    // 2026-11 的 a1 只有 nov_a1_2 與 nov_a1_1，oct_a1_old 屬於未渲染的舊月份 2026-10
    useTicketStore.setState({ selectedId: null });
    st().moveSelection(1);
    assert.equal(st().selectedId, "nov_a1_2");
    st().moveSelection(1);
    assert.equal(st().selectedId, "nov_a1_1");
    st().moveSelection(1);
    // 已到當月最後一筆，不得越界掉進 2026-10 的 oct_a1_old
    assert.equal(st().selectedId, "nov_a1_1");
  });

  test("2B-2：單選帳戶當月直篩下觸發搜尋升格（promoteListFilterToSearch），帳戶條件完整帶入跨月搜尋且查回跨月帳目", async () => {
    await st().setMonth("2026-11");
    await st().setFilter("a1");
    assert.equal(isInMonthFilterActive(st().listFilter, st().listSort, st().filterAccountId), true);

    await st().promoteListFilterToSearch();
    assert.equal(st().searchOpen, true);
    assert.equal(st().filter.accountId, "a1");
    assert.deepEqual(
      (st().results ?? []).map((e) => e.id),
      ["nov_a1_2", "nov_a1_1", "oct_a1_old"],
    );

    st().closeSearch();
    await st().setFilter(null);
  });
});
