/**
 * UI 丙-5 §4-2 的兩組回歸保護：
 *   - D1：store.createCategory 回新列（大票分類浮層「＋ 新增分類」建完要選上它）；寫入失敗回 null（store 吐 toast、浮層留著）。
 *   - I1：售票口的 Ctrl+P 結果提供者兩殼都列（`shells` 含 mobile：手機頂帶搜尋也拿得到帳目）。
 * 跑法：`node --test scripts/tests/ticket-c5-store.test.ts`（node 24，型別剝除；零依賴）。
 * 載入法照 ticket-sort-store.test.ts：registerHooks 補 `.ts`，store 的 repo／設定／uiStore／nodeStore 換成 data: 模組。
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
const FAKE_LEDGER = `export function acctLabel(a) { return a ? a.name : ""; }`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? "";
    if (parent.includes("/src/")) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (parent.includes("/src/ui/ticket/quickJump")) {
        // quickJump 只拿 TicketLedger 的 acctLabel（那支是 .tsx，node 讀不了）；uiStore 跟 store 用同一份替身
        if (specifier === "./TicketLedger") return { url: dataUrl(FAKE_LEDGER), shortCircuit: true };
        if (specifier === "../../store/uiStore") return { url: dataUrl(FAKE_UI), shortCircuit: true };
      }
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

import type { AccountRow, CategoryRow, CurrencyRow } from "../../src/domain/ticket.ts";

const { ticketId } = await import("../../src/domain/ticket.ts");

const NOW = new Date(2026, 9, 24, 9, 0).toISOString();
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };
const CURRENCIES: CurrencyRow[] = [{ id: ticketId("currency:TWD"), code: "TWD", name: "TWD", decimals: 2, rate_to_main: "1", is_main: 1, position: 0, ...SYNC }];
const ACCOUNTS: AccountRow[] = [{ id: "a1", name: "現金", group_key: "cash", currency: "TWD", position: 0, archived_at: null, ...SYNC }];
const cats: CategoryRow[] = [{ id: "x", kind: "expense", name: "食物", parent_id: null, position: 0, archived_at: null, ...SYNC }];

let failCreate = false;
const repo = {
  async ensureStarterRows() {},
  async listCurrencies() {
    return CURRENCIES.slice();
  },
  async listAccounts() {
    return ACCOUNTS.slice();
  },
  async listCategories() {
    return cats.slice();
  },
  async createCategory(input: { kind: "income" | "expense"; name: string; parentId: string | null }): Promise<CategoryRow> {
    if (failCreate) throw new Error("寫不進去");
    const row: CategoryRow = { id: `c${cats.length}`, kind: input.kind, name: input.name, parent_id: input.parentId, position: cats.length, archived_at: null, ...SYNC };
    cats.push(row);
    return row;
  },
  async lastUsedAccountId() {
    return null;
  },
  async recentCategoryIds() {
    return [];
  },
  async usageSince() {
    return { categories: [], accounts: [] };
  },
  async balances() {
    return {};
  },
  async hasAnyEntry() {
    return false;
  },
  async listEntries() {
    return [];
  },
  async queryEntries() {
    return [];
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

describe("UI 丙-5：createCategory 回新列、quickJump 兩殼都列", async () => {
  const { useTicketStore } = await import("../../src/store/ticketStore.ts");
  const st = () => useTicketStore.getState();
  await st().init("desktop");

  test("D1：createCategory 回 {id, name, kind}，refresh 之後 catById 裡查得到它（大票浮層才選得上）", async () => {
    const row = await st().createCategory({ kind: "expense", name: "咖啡豆", parentId: null });
    assert.ok(row);
    assert.equal(row.name, "咖啡豆");
    assert.equal(row.kind, "expense");
    assert.equal(row.parent_id, null);
    assert.equal(st().catById[row.id]?.name, "咖啡豆");
  });

  test("D1：寫入失敗回 null（呼叫端用真值判斷，舊的 boolean 用法照樣相容）", async () => {
    failCreate = true;
    try {
      const row = await st().createCategory({ kind: "income", name: "獎金", parentId: null });
      assert.equal(row, null);
      assert.ok(!cats.some((c) => c.name === "獎金"));
    } finally {
      failCreate = false;
    }
  });

  test("I1：TICKET_QUICK_JUMP 兩殼都列（shells 含 mobile）、前綴 $、組名「帳目」", async () => {
    const { TICKET_QUICK_JUMP } = await import("../../src/ui/ticket/quickJump.ts");
    assert.deepEqual([...(TICKET_QUICK_JUMP.shells ?? [])].sort(), ["desktop", "mobile"]);
    assert.equal(TICKET_QUICK_JUMP.prefix, "$");
    assert.equal(TICKET_QUICK_JUMP.group, "帳目");
  });
});
