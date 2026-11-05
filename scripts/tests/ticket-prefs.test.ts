/**
 * 己-2「記住上次」的 store 層測試（D-主-416～418）：售票口視圖、統計的期間／切面／收支冷啟動讀回、改了就寫本機鍵（手機加 _mobile）；
 * 轉帳的轉入帳戶照上次預填。純函式（domain/ticketPrefs）在同檔前半。
 * 跑法：`node --test scripts/tests/ticket-prefs.test.ts`（node 24，型別剝除；零依賴）。替身與載入法抄 ticket-sort-store.test.ts。
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
/** 售票口④：store 會 import 荷札的 repository 與 store（真的那兩支會載到 ./index，node 碰到 import.meta.env）——換成不寫任何東西的替身 */
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

import type { AccountRow, CurrencyRow, EntryRow } from "../../src/domain/ticket.ts";

const { ticketId } = await import("../../src/domain/ticket.ts");
const P = await import("../../src/domain/ticketPrefs.ts");
const { todayKey } = await import("../../src/lib/date.ts");

const NOW = new Date(2026, 10, 4, 9, 0).toISOString();
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };
const TODAY = todayKey(0);

const CURRENCIES: CurrencyRow[] = [{ id: ticketId("currency:TWD"), code: "TWD", name: "TWD", decimals: 2, rate_to_main: "1", is_main: 1, position: 0, ...SYNC }];
const acc = (id: string, position: number, archived = false): AccountRow => ({
  id,
  name: id,
  group_key: "bank",
  currency: "TWD",
  position,
  archived_at: archived ? NOW : null,
  ...SYNC,
});
const ACCOUNTS = [acc("a1", 0), acc("a2", 1), acc("a3", 2), acc("old", 3, true)];
const byId = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a]));

describe("domain/ticketPrefs", () => {
  test("讀回來不認得的值一律回預設", () => {
    assert.equal(P.parseTicketView("stats"), "stats");
    assert.equal(P.parseTicketView("garage"), "list");
    assert.equal(P.parseTicketView(null), "list");
    assert.equal(P.parseStatsSpan("year"), "year");
    assert.equal(P.parseStatsSpan("week"), "month");
    assert.equal(P.parseFacet("tag"), "tag");
    assert.equal(P.parseFacet(""), "category");
    assert.equal(P.parseFacetKind("income"), "income");
    assert.equal(P.parseFacetKind("transfer"), "expense");
  });

  test("轉入記憶：壞掉的 JSON、不是物件、值不是字串 ⇒ 當沒記過／略過那一格", () => {
    assert.deepEqual(P.parseTransferMemo("{"), {});
    assert.deepEqual(P.parseTransferMemo("[1]"), {});
    assert.deepEqual(P.parseTransferMemo(JSON.stringify({ a1: "a2", a2: 3, "*": "" })), { a1: "a2" });
  });

  test("照轉出帳戶猜；沒記過這個轉出帳戶 ⇒ 用最近一次；猜到封存的、不在的、自己 ⇒ 不猜", () => {
    let m = P.rememberTransfer({}, "a1", "a2");
    m = P.rememberTransfer(m, "a2", "a3");
    assert.equal(P.guessTransferTo(m, "a1", byId), "a2");
    assert.equal(P.guessTransferTo(m, "a3", byId), null,"a3 沒當過轉出、最近一次又是它自己 ⇒ 不猜");
    assert.equal(P.guessTransferTo(P.rememberTransfer(m, "a3", "a1"), "old", byId), "a1", "沒當過轉出 ⇒ 最近一次");
    assert.equal(P.guessTransferTo(m, "a1", { ...byId, a2: { ...byId.a2, archived_at: NOW } }), "a3", "a2 封存了 ⇒ 退回最近一次（a3）");
    assert.equal(P.guessTransferTo(P.rememberTransfer({}, "a2", "a1"), "a1", byId), null, "最近一次就是轉出帳戶自己 ⇒ 不猜");
    assert.equal(P.guessTransferTo({ a1: "old" }, "a1", byId), null);
    assert.equal(P.guessTransferTo({ a1: "gone" }, "a1", byId), null);
    assert.deepEqual(P.rememberTransfer({ a1: "a2" }, "a1", "a1"), { a1: "a2" }, "轉給自己（不合法）不記");
  });
});

let seq = 0;
const created: EntryRow[] = [];
const repo = {
  async ensureStarterRows() {},
  async listCurrencies() {
    return CURRENCIES.slice();
  },
  async listAccounts() {
    return ACCOUNTS.slice();
  },
  async listCategories() {
    return [];
  },
  async lastUsedAccountId() {
    return "a1";
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
    return created.length > 0;
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
  async listWishes() {
    return [];
  },
  async listTemplates() {
    return [];
  },
  async createEntry(input: { kind: EntryRow["kind"]; amountMinor: number; accountId: string; toAccountId: string | null; occurredOn: string; occurredAt: string; note: string }) {
    seq++;
    const row: EntryRow = {
      id: `e${seq}`,
      kind: input.kind,
      occurred_on: input.occurredOn,
      occurred_at: input.occurredAt,
      account_id: input.accountId,
      to_account_id: input.toAccountId,
      category_id: null,
      amount_minor: input.amountMinor,
      currency: "TWD",
      main_minor: input.amountMinor,
      account_minor: input.amountMinor,
      to_amount_minor: input.toAccountId ? input.amountMinor : null,
      note: input.note,
      route_id: null,
      import_id: null,
      import_source: null,
      import_utime: null,
      ...SYNC,
    };
    created.push(row);
    return row;
  },
};
(globalThis as { __tkRepo?: unknown }).__tkRepo = repo;
const settings = (globalThis as unknown as { __settings?: Map<string, string> }).__settings ?? new Map<string, string>();
(globalThis as unknown as { __settings: Map<string, string> }).__settings = settings;

describe("ticketStore 己-2：記住上次", async () => {
  // 這台（桌機殼）上次：停在統計、看年、依路線、收入；手機殼的另記一份（不該被讀到）
  settings.set("ticket_view", "stats");
  settings.set("ticket_stats_span", "year");
  settings.set("ticket_stats_facet", "route");
  settings.set("ticket_stats_kind", "income");
  settings.set("ticket_view_mobile", "wish");
  const { useTicketStore } = await import("../../src/store/ticketStore.ts");
  const st = () => useTicketStore.getState();
  const tick = () => new Promise((r) => setTimeout(r, 0));

  await st().init("desktop");
  await tick();

  test("B5／B1：冷啟動照桌機鍵套回視圖、期間、切面、收支；統計資料跟著載（setView 走過一遍）", () => {
    assert.equal(st().view, "stats");
    assert.equal(st().span, "year");
    assert.equal(st().period.span, "year");
    assert.equal(st().period.key, TODAY.slice(0, 4));
    assert.equal(st().facet, "route");
    assert.equal(st().facetKind, "income");
    assert.ok(st().stats, "統計算過了");
  });

  test("套回來的那一下不寫回（本機鍵原樣）；之後改了就寫桌機鍵", async () => {
    assert.equal(settings.get("ticket_view"), "stats");
    await st().setView("calendar");
    await st().setSpan("month");
    st().setFacet("tag");
    st().setFacetKind("expense");
    await tick();
    assert.equal(settings.get("ticket_view"), "calendar");
    assert.equal(settings.get("ticket_stats_span"), "month");
    assert.equal(settings.get("ticket_stats_facet"), "tag");
    assert.equal(settings.get("ticket_stats_kind"), "expense");
    assert.equal(settings.get("ticket_view_mobile"), "wish", "手機鍵沒被動到");
  });

  test("不經 setView 的換視圖（跳到某天回清單）也記", async () => {
    await st().jumpToDay(TODAY);
    await tick();
    assert.equal(st().view, "list");
    assert.equal(settings.get("ticket_view"), "list");
  });

  test("換殼再 init：不再套另一殼的記憶（不在用到一半時跳走），之後的改動寫那一殼的鍵", async () => {
    await st().setView("stats");
    await st().init("mobile");
    await tick();
    assert.equal(st().view, "stats");
    await st().setView("accounts");
    await tick();
    assert.equal(settings.get("ticket_view_mobile"), "accounts");
    assert.equal(settings.get("ticket_view"), "stats");
  });

  test("B2：第一次轉帳沒記憶 ⇒ 轉入留空；存了 a1→a3 之後，下一筆從 a1 轉出就預填 a3、寫進本機鍵", async () => {
    st().openNew();
    st().setDraft({ kind: "transfer" });
    assert.equal(st().draft?.accountId, "a1");
    assert.equal(st().draft?.toAccountId, null);
    st().setDraft({ toAccountId: "a3", amountText: "500" });
    assert.equal(await st().saveDraft({ again: false }), true);
    assert.deepEqual(JSON.parse(settings.get("ticket_transfer_to") ?? "{}"), { a1: "a3", "*": "a3" });

    st().openNew();
    st().setDraft({ kind: "transfer" });
    assert.equal(st().draft?.toAccountId, "a3");
  });

  test("B2：換轉出帳戶時轉入還空著才猜；使用者清掉轉入（toAccountId:null）不再塞回去；收支類別不受影響", () => {
    st().openNew();
    st().setDraft({ kind: "transfer" });
    st().setDraft({ toAccountId: null });
    assert.equal(st().draft?.toAccountId, null, "清掉就是清掉");
    st().setDraft({ accountId: "a2" });
    assert.equal(st().draft?.toAccountId, "a3", "換轉出、轉入空著 ⇒ 用最近一次");
    st().setDraft({ kind: "expense" });
    assert.equal(st().draft?.toAccountId, null);
    st().openNew({ kind: "transfer" });
    assert.equal(st().draft?.toAccountId, "a3", "直接開一張轉帳也預填");
    st().openNew({ kind: "transfer", toAccountId: "a2" });
    assert.equal(st().draft?.toAccountId, "a2", "呼叫端指定的不蓋");
  });
});
