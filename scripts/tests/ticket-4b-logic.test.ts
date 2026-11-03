/**
 * 售票口④ 第二輪（Stage 0 資料席）：分類不限層數（D-票-78）與帳戶頁的數字（D-票-79）。
 * 跑法：`node --test scripts/tests/ticket-4b-logic.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 *   A  樹、路徑、防環（ticket.ts：categoryForest／effectiveParentId 斷環／categoryPath／categoryLabel 短寫／categorySubtreeIds／
 *      moveUnderError／planMoveUnder／matchCategories 同名路徑短的在前）
 *   B  含子孫的口徑：統計（全部分類與以某分類為根）、麵包屑、預算、搜尋篩選與關鍵字、chip
 *   C  帳戶頁 accountCards：本月進出（帳戶幣別／主幣別、轉帳兩頭）、近六個月月底餘額
 *   D  repository：memory 與 sqlite 各跑一遍（sqlite＝node:sqlite 記憶體庫套真的 0007＋0010＋0016 DDL、開外鍵），最後比兩份樹長得一樣
 *   E  ticketStore（替身同 ticket-4-logic；ticketRepo＝真的 memory 實作）：setStatsRoot、moveCategoryUnder、常用排除上層封存、帳戶頁
 *
 * 載入照 ticket-4-logic：registerHooks 補 `.ts`、把 `../lib/db`／`./syncRepository` 換成 data: 模組；src 的值等 hook 掛好後動態載入。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const FAKE_DB = `
let t = Date.UTC(2026, 10, 2, 1, 0, 0);
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
  dayStartHour: 0, weekStart: 1, toasts: [], page: "today", mobileTab: "today",
  showToast(t) { useUiStore.setState({ toasts: useUiStore.getState().toasts.concat([t]) }); },
  askConfirm(o) { o.onConfirm && o.onConfirm(); },
});
globalThis.__uiStoreRef = useUiStore;
`;
const FAKE_NODE = `${MINI_STORE}
export const useNodeStore = mk({ routes: [] });
`;
const FAKE_REPO = `export const ticketRepo = new Proxy({}, { get: (_, k) => (...a) => globalThis.__tkRepo[k](...a) });`;
const FAKE_DATA = `
export const settingsRepo = { async get() { return null; }, async set() {} };
`;
/** 荷札 repository 替身：記每一次 setTags、listTagsOf 讀它記下的（key＝小寫名；不驗實體） */
const FAKE_TAG_REPO = `
const empty = () => ({ createdTagIds: [], createdTaggingIds: [], tagsBefore: [], taggingsBefore: [], notesBefore: [] });
globalThis.__tags = globalThis.__tags ?? { map: new Map(), calls: [] };
export const tagRepo = {
  async listTagsOf(type, id) {
    const names = globalThis.__tags.map.get(type + "|" + id) ?? [];
    return names.map((n) => ({ id: "t-" + n.toLowerCase(), name: n, name_key: n.toLowerCase(), created_at: "", updated_at: "", deleted_at: null }));
  },
  async setTags(type, id, names) {
    if (globalThis.__tags.fail) throw new Error("荷札寫不進去");
    globalThis.__tags.calls.push({ type, id, names: [...names] });
    globalThis.__tags.map.set(type + "|" + id, [...names]);
    const r = empty();
    if (names.length) r.createdTaggingIds.push(type + "|" + id);
    return { receipt: r, created: [] };
  },
};
`;
const FAKE_TAG_STORE = `${MINI_STORE}
globalThis.__tagLoads = 0;
export const useTagStore = mk({ index: null, async loadIndex() { globalThis.__tagLoads++; } });
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


import type { AccountRow, CategoryRow, CurrencyRow, EntryCtx, EntryRow } from "../../src/domain/ticket.ts";

const T = await import("../../src/domain/ticket.ts");
const V = await import("../../src/domain/ticketView.ts");
const P = await import("../../src/domain/ticketPlan.ts");
const M = await import("../../src/data/memoryTicketRepository.ts");
const S = await import("../../src/data/sqliteTicketRepository.ts");
const { todayKey } = await import("../../src/lib/date.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, ticketId, atOf } = T;

/* ───────── fixture：三層以上的支出樹 ─────────
 *   食物(0) ─ 外食(0) ─ 午餐(0) ─ 拉麵(0)
 *          │        └ 晚餐(1)
 *          └ 點心(1)
 *   交通(1，封存) ─ 公車(0)
 *   午餐(2，頂層同名)
 *   未分類
 */
const NOW = new Date(2026, 10, 2, 9, 0).toISOString();
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };
const TWD: CurrencyRow = { id: ticketId("currency:TWD"), code: "TWD", name: "TWD", decimals: 2, rate_to_main: "1", is_main: 1, position: 0, ...SYNC };
const USD: CurrencyRow = { id: ticketId("currency:USD"), code: "USD", name: "USD", decimals: 2, rate_to_main: "31.5", is_main: 0, position: 1, ...SYNC };
const acc = (id: string, extra: Partial<AccountRow> = {}): AccountRow => ({ id, name: id, group_key: "cash", currency: "TWD", position: 0, archived_at: null, ...SYNC, ...extra });
const cat = (id: string, name: string, parent: string | null, position: number, extra: Partial<CategoryRow> = {}): CategoryRow => ({
  id, kind: "expense", name, parent_id: parent, position, archived_at: null, ...SYNC, ...extra,
});
const byId = <X extends { id: string }>(rows: X[]): Record<string, X> => Object.fromEntries(rows.map((r) => [r.id, r]));
const CATS: CategoryRow[] = [
  cat(UNCAT_EXPENSE_ID, "未分類", null, 9999),
  { ...cat(UNCAT_INCOME_ID, "未分類", null, 9999), kind: "income" },
  { ...cat("c-salary", "薪水", null, 0), kind: "income" },
  cat("c-food", "🍜 食物", null, 0),
  cat("c-out", "外食", "c-food", 0),
  cat("c-lunch", "午餐", "c-out", 0),
  cat("c-ramen", "拉麵", "c-lunch", 0),
  cat("c-dinner", "晚餐", "c-out", 1),
  cat("c-snack", "點心", "c-food", 1),
  cat("c-traffic", "交通", null, 1, { archived_at: NOW }),
  cat("c-bus", "公車", "c-traffic", 0),
  cat("c-lunch-top", "午餐", null, 2),
];
const CAT_BY = byId(CATS);
const ACCS = [acc("a-cash"), acc("a-card", { group_key: "card" }), acc("a-usd", { group_key: "bank", currency: "USD" }), acc("a-old", { archived_at: NOW })];
const VCTX = { accById: byId(ACCS), catById: CAT_BY, curByCode: { TWD, USD }, routeById: {}, routeOrder: [] };

let seq = 0;
function ent(p: Partial<EntryRow> & { occurred_on: string }): EntryRow {
  seq++;
  const amount = p.amount_minor ?? 100;
  return {
    id: `e-${seq}`,
    kind: "expense",
    occurred_at: atOf(p.occurred_on, "12:00", 0),
    account_id: "a-cash",
    to_account_id: null,
    category_id: null,
    amount_minor: amount,
    currency: "TWD",
    main_minor: p.main_minor ?? amount,
    account_minor: p.account_minor ?? amount,
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
const throwsMsg = (fn: () => unknown, msg: string) =>
  assert.throws(fn, (e: unknown) => e instanceof RangeError && e.message === msg, `應丟「${msg}」`);
const rejectsMsg = (p: Promise<unknown>, msg: string) =>
  assert.rejects(p, (e: unknown) => e instanceof RangeError && e.message === msg, `應丟「${msg}」`);
const names = (rows: CategoryRow[]) => rows.map((c) => c.id);

/* ═════════════════════════ A. 樹、路徑、防環 ═════════════════════════ */

describe("A. 分類樹（不限層數）", () => {
  test("1. categoryForest：任意深度、每層照 position、未分類最後；封存的連底下整棵不列", () => {
    const f = T.categoryForest(CATS, "expense", { includeArchived: false });
    assert.deepEqual(f.map((n) => n.cat.id), ["c-food", "c-lunch-top", UNCAT_EXPENSE_ID]);
    const flat = T.flattenForest(f);
    assert.deepEqual(
      flat.map((n) => `${n.depth}:${n.cat.id}`),
      ["0:c-food", "1:c-out", "2:c-lunch", "3:c-ramen", "2:c-dinner", "1:c-snack", "0:c-lunch-top", `0:${UNCAT_EXPENSE_ID}`],
    );
    const all = T.flattenForest(T.categoryForest(CATS, "expense", { includeArchived: true })).map((n) => n.cat.id);
    assert.ok(all.includes("c-traffic") && all.includes("c-bus"), "includeArchived 連封存那棵一起");
  });

  test("2. effectiveParentId：父已刪／別 kind／未分類 ⇒ 頂層；同步造出的環 ⇒ id 最小的當頂層，兩邊算一樣", () => {
    const orphan = cat("c-orphan", "孤兒", "c-gone", 5);
    const gone = cat("c-gone", "已刪", null, 0, { deleted_at: NOW });
    const wrongKind = cat("c-wk", "別 kind 底下", "c-salary", 6);
    const underUncat = cat("c-uu", "未分類底下", UNCAT_EXPENSE_ID, 7);
    const cats = [...CATS, orphan, gone, wrongKind, underUncat];
    const by = byId(cats);
    for (const c of [orphan, wrongKind, underUncat]) assert.equal(T.effectiveParentId(c, by), null, c.id);
    // 環：k-a → k-b → k-a（兩台各把對方搬到自己底下）
    const ring = [cat("k-b", "B", "k-a", 0), cat("k-a", "A", "k-b", 0)];
    const rb = byId(ring);
    assert.equal(T.effectiveParentId(rb["k-a"], rb), null, "環上 id 最小的當頂層");
    assert.equal(T.effectiveParentId(rb["k-b"], rb), "k-a");
    // 三個的環＋掛在環上的一個
    const ring3 = [cat("r-3", "3", "r-1", 0), cat("r-1", "1", "r-2", 0), cat("r-2", "2", "r-3", 0), cat("r-kid", "kid", "r-2", 0)];
    const f = T.flattenForest(T.categoryForest(ring3, "expense", { includeArchived: true }));
    assert.deepEqual(f.map((n) => `${n.depth}:${n.cat.id}`), ["0:r-1", "1:r-3", "2:r-2", "3:r-kid"], "每個都出現一次、不會無窮遞迴");
  });

  test("3. categoryPath／categoryLabel（全寫與短寫）／categoryArchivedUp", () => {
    assert.deepEqual(names(T.categoryPath(CAT_BY["c-ramen"], CAT_BY)), ["c-food", "c-out", "c-lunch", "c-ramen"]);
    assert.equal(T.categoryLabel(CAT_BY["c-ramen"], CAT_BY), "🍜 食物 › 外食 › 午餐 › 拉麵");
    assert.equal(T.categoryLabel(CAT_BY["c-ramen"], CAT_BY, { short: true }), "午餐 › 拉麵");
    assert.equal(T.categoryLabel(CAT_BY["c-out"], CAT_BY, { short: true }), "🍜 食物 › 外食", "兩層時短寫＝全寫");
    assert.equal(T.categoryLabel(CAT_BY["c-food"], CAT_BY, { short: true }), "🍜 食物");
    assert.equal(T.categoryLabel(null, CAT_BY), "（分類已刪除）");
    assert.equal(T.categoryArchivedUp(CAT_BY["c-bus"], CAT_BY), true, "上層封存＝整棵算封存");
    assert.equal(T.categoryArchivedUp(CAT_BY["c-ramen"], CAT_BY), false);
  });

  test("4. categorySubtreeIds／categoryIdsIncluding：任何一層都含所有子孫（封存的也含、已刪的不含）；葉子只有自己", () => {
    assert.deepEqual(T.categorySubtreeIds("c-food", CATS), ["c-food", "c-out", "c-lunch", "c-ramen", "c-dinner", "c-snack"]);
    assert.deepEqual(T.categorySubtreeIds("c-out", CATS), ["c-out", "c-lunch", "c-ramen", "c-dinner"]);
    assert.deepEqual(T.categorySubtreeIds("c-ramen", CATS), ["c-ramen"]);
    assert.deepEqual(T.categorySubtreeIds("c-traffic", CATS), ["c-traffic", "c-bus"]);
    const withDead = CATS.map((c) => (c.id === "c-dinner" ? { ...c, deleted_at: NOW } : c));
    assert.deepEqual(V.categoryIdsIncluding(["c-lunch", "c-out"], withDead), ["c-lunch", "c-ramen", "c-out"], "去重、照輸入順序、已刪不含");
  });

  test("5. moveUnderError：防環、未分類、封存、別 kind、不在", () => {
    const by = { ...CAT_BY };
    assert.equal(T.moveUnderError("c-out", "c-ramen", by), "不能移到自己或自己底下的分類");
    assert.equal(T.moveUnderError("c-out", "c-out", by), "不能移到自己或自己底下的分類");
    assert.equal(T.moveUnderError(UNCAT_EXPENSE_ID, null, by), "「未分類」不能移動");
    assert.equal(T.moveUnderError("c-out", UNCAT_EXPENSE_ID, by), "「未分類」底下不能放分類");
    assert.equal(T.moveUnderError("c-out", "c-salary", by), "這個分類不屬於目前的收支類型");
    assert.equal(T.moveUnderError("c-out", "c-bus", by), "封存的分類底下不能放分類", "目標的上層封存了");
    assert.equal(T.moveUnderError("c-traffic", null, by), "封存的分類不能移動");
    assert.equal(T.moveUnderError("c-out", "nope", by), "要移去的分類已經不在了");
    assert.equal(T.moveUnderError("c-ramen", "c-lunch-top", by), null);
    assert.equal(T.moveUnderError("c-ramen", null, by), null);
  });

  test("6. planMoveUnder：換上層＝兩邊兄弟組整組重編；同層＝搬到第 k 個；孤兒移到頂層＝擦掉 parent_id", () => {
    // 外食 → 頂層第 1 個：頂層 [食物, 外食, 午餐(頂)]；食物底下剩 [點心] 從 0 重編
    const p1 = T.planMoveUnder(CATS, "c-out", null, 1);
    assert.equal(p1.parent, null);
    assert.deepEqual(p1.moves, [{ id: "c-snack", position: 0 }, { id: "c-food", position: 0 }, { id: "c-out", position: 1 }, { id: "c-lunch-top", position: 2 }]);
    // 省略 index ＝ 排最後
    const p2 = T.planMoveUnder(CATS, "c-snack", "c-lunch");
    assert.equal(p2.parent, "c-lunch");
    assert.deepEqual(p2.moves, [{ id: "c-out", position: 0 }, { id: "c-ramen", position: 0 }, { id: "c-snack", position: 1 }]);
    // 同層：等於 planMoveTo；省略 index ⇒ 不寫
    assert.deepEqual(T.planMoveUnder(CATS, "c-dinner", "c-out", 0), { parent: undefined, moves: [{ id: "c-dinner", position: 0 }, { id: "c-lunch", position: 1 }], breaks: [] });
    assert.deepEqual(T.planMoveUnder(CATS, "c-dinner", "c-out"), { parent: undefined, moves: [], breaks: [] });
    // 父已刪的孤兒本來就算頂層 ⇒ 移到頂層：只擦 parent_id
    const orphanCats = [...CATS, cat("c-gone", "已刪", null, 0, { deleted_at: NOW }), cat("c-orphan", "孤兒", "c-gone", 3)];
    assert.deepEqual(T.planMoveUnder(orphanCats, "c-orphan", null), { parent: null, moves: [], breaks: [] });
    throwsMsg(() => T.planMoveUnder(CATS, "c-food", "c-ramen"), "不能移到自己或自己底下的分類");
    // 同步合出的環 A→B→A（畫面：A 頂層、B 在 A 底下）：把 B 移到頂層 ⇒ A 一起寫 parent＝null，不會翻到 B 底下
    const ring = [...CATS, cat("c-ra", "環A", "c-rb", 7), cat("c-rb", "環B", "c-ra", 0)];
    const p3 = T.planMoveUnder(ring, "c-rb", null);
    assert.equal(p3.parent, null);
    assert.deepEqual(p3.breaks, ["c-ra"]);
    // 斷環照寫（不是這次搬的那個也修）；搬的就是環上最小的那個 ⇒ 不重複列
    assert.deepEqual(T.planMoveUnder(ring, "c-dinner", "c-out").breaks, ["c-ra"]);
    assert.deepEqual(T.planMoveUnder(ring, "c-ra", null).breaks, []);
    // 深鏈（> categoryPath 的 64 層護欄）也抓得到「移到自己底下」
    const chain = Array.from({ length: 70 }, (_, i) => cat(`c-d${String(i).padStart(2, "0")}`, `d${i}`, i ? `c-d${String(i - 1).padStart(2, "0")}` : null, 0));
    const chainBy = Object.fromEntries(chain.map((c) => [c.id, c]));
    assert.equal(T.moveUnderError("c-d00", "c-d69", chainBy), "不能移到自己或自己底下的分類");
  });

  test("7. matchCategories：比末段名字；同名路徑短的在前；不同名深的在前；上層封存的整棵不出", () => {
    const ids = (q: string) => T.matchCategories(q, CATS, "expense").map((c) => c.id);
    assert.deepEqual(ids("午餐"), ["c-lunch-top", "c-lunch"], "同名：頂層「午餐」在「食物 › 外食 › 午餐」前面");
    assert.deepEqual(ids("餐"), ["c-lunch-top", "c-lunch", "c-dinner"], "包含：午餐那組（深的先出現）整組在前、組內路徑短的先");
    assert.deepEqual(ids("拉"), ["c-ramen"]);
    assert.deepEqual(ids("食物"), ["c-food"], "比末段名字，不比路徑（「外食」不會因為路徑有食物就中）");
    assert.deepEqual(ids("公車"), [], "交通封存 ⇒ 公車也不出");
    const q = T.parseQuickEntry("80 拉麵 豚骨", { ...VCTX, lastAccountId: "a-cash" });
    assert.deepEqual([q.categoryId, q.note], ["c-ramen", "豚骨"], "捕捉一行比得到第四層");
  });
});

/* ═════════════════════════ B. 含子孫的口徑：統計、下鑽、預算、搜尋 ═════════════════════════ */

describe("B. 統計與口徑", () => {
  const NOV = { from: "2026-11-01", toExcl: "2026-12-01" };
  const ES = [
    ent({ occurred_on: "2026-11-02", category_id: "c-ramen", amount_minor: 100 }),
    ent({ occurred_on: "2026-11-02", category_id: "c-lunch", amount_minor: 200 }),
    ent({ occurred_on: "2026-11-03", category_id: "c-dinner", amount_minor: 300 }),
    ent({ occurred_on: "2026-11-03", category_id: "c-out", amount_minor: 50 }),
    ent({ occurred_on: "2026-11-04", category_id: "c-snack", amount_minor: 400 }),
    ent({ occurred_on: "2026-11-04", category_id: "c-food", amount_minor: 10 }),
    ent({ occurred_on: "2026-11-05", category_id: "c-bus", amount_minor: 70 }),
    ent({ occurred_on: "2026-11-05", category_id: UNCAT_EXPENSE_ID, amount_minor: 5 }),
    ent({ occurred_on: "2026-11-06", category_id: "c-gone-cat", amount_minor: 1 }),
  ];
  const row = (rows: { key: string; minor: number; deeper?: boolean; children?: unknown[] }[]) =>
    rows.map((r) => `${r.key}=${r.minor}${r.deeper ? "›" : ""}`);

  test("8. 全部分類：主列＝頂層（含所有子孫）、children＝直屬下一層＋未細分；底下還有更深的 ⇒ deeper", () => {
    const b = V.breakdown(ES, NOV, "category", "expense", VCTX);
    assert.deepEqual(row(b.rows), ["c-food=1060›", "c-traffic=70›", `${UNCAT_EXPENSE_ID}=5`, `${V.GONE_KEY}=1`]);
    const food = b.rows[0];
    assert.deepEqual(row(food.children as never), ["c-out=650›", "c-snack=400", `${V.UNSPLIT_KEY}=10`]);
    assert.equal(b.total, 1136);
  });

  test("9. 以某分類為根：主列＝它的直屬下一層、直接記在它本身的是最後一列「未細分」；分母＝那一層合計", () => {
    const b = V.breakdown(ES, NOV, "category", "expense", VCTX, { catRoot: "c-food" });
    assert.deepEqual(row(b.rows), ["c-out=650›", "c-snack=400", `${V.UNSPLIT_KEY}=10`]);
    assert.equal(b.total, 1060);
    assert.deepEqual(row(b.rows[0].children as never), ["c-lunch=300›", "c-dinner=300", `${V.UNSPLIT_KEY}=50`], "同額照樹順序；午餐底下還有拉麵 ⇒ 可以再進入");
    assert.equal(b.rows[2].label, "未細分");
    const out = V.breakdown(ES, NOV, "category", "expense", VCTX, { catRoot: "c-out" });
    assert.deepEqual(row(out.rows), ["c-lunch=300›", "c-dinner=300", `${V.UNSPLIT_KEY}=50`]);
    assert.deepEqual(row(out.rows[0].children as never), [`${V.UNSPLIT_KEY}=200`, "c-ramen=100"], "午餐本身＋拉麵（金額大到小）");
    // 葉子當根：只有「未細分」；封存那棵照算
    assert.deepEqual(row(V.breakdown(ES, NOV, "category", "expense", VCTX, { catRoot: "c-ramen" }).rows), [`${V.UNSPLIT_KEY}=100`]);
    assert.deepEqual(row(V.breakdown(ES, NOV, "category", "expense", VCTX, { catRoot: "c-traffic" }).rows), ["c-bus=70"]);
    // 根只對分類切面有效
    assert.equal(V.breakdown(ES, NOV, "account", "expense", VCTX, { catRoot: "c-food" }).rows[0].key, "a-cash");
  });

  test("10. statsCrumbs：全部分類 › 每一層", () => {
    assert.deepEqual(V.statsCrumbs("c-lunch", CAT_BY), [
      { id: null, label: "全部分類" },
      { id: "c-food", label: "🍜 食物" },
      { id: "c-out", label: "外食" },
      { id: "c-lunch", label: "午餐" },
    ]);
    assert.deepEqual(V.statsCrumbs(null, CAT_BY), [{ id: null, label: "全部分類" }]);
    assert.deepEqual(V.statsCrumbs("nope", CAT_BY), [{ id: null, label: "全部分類" }]);
  });

  test("11. 預算：分類預算含所有子孫（中間層、葉子各算各的）；列名＝完整路徑", () => {
    assert.equal(P.budgetUsed(ES, { kind: "category", categoryId: "c-food" }, "2026-11", CATS), 1060);
    assert.equal(P.budgetUsed(ES, { kind: "category", categoryId: "c-out" }, "2026-11", CATS), 650);
    assert.equal(P.budgetUsed(ES, { kind: "category", categoryId: "c-lunch" }, "2026-11", CATS), 300);
    assert.equal(P.budgetUsed(ES, { kind: "category", categoryId: "c-ramen" }, "2026-11", CATS), 100);
    const b = P.budgetRow({ kind: "category", categoryId: "c-lunch" }, null, 1000, 0, NOW);
    const lines = P.budgetLines([b], ES, "2026-11", CATS, "2026-11-15", { catById: CAT_BY });
    assert.equal(lines[0].label, "🍜 食物 › 外食 › 午餐");
    assert.equal(lines[0].used, 300);
  });

  test("12. 搜尋：選一個分類＝含子孫；關鍵字比得到每一層上層的名字；chip 只寫最後兩段", () => {
    const q = V.filterToQuery({ ...V.EMPTY_FILTER, categoryIds: ["c-out"] }, CATS);
    assert.deepEqual([...q.categoryIds], ["c-out", "c-lunch", "c-ramen", "c-dinner"]);
    const hit = ES.filter((e) => V.matchesQuery(e, q)).map((e) => e.category_id);
    assert.deepEqual(hit, ["c-ramen", "c-lunch", "c-dinner", "c-out"]);
    const tokens = V.keywordTokens("外食");
    assert.deepEqual(ES.filter((e) => V.matchesKeyword(e, tokens, VCTX)).map((e) => e.category_id), ["c-ramen", "c-lunch", "c-dinner", "c-out"]);
    const chips = V.filterChips({ ...V.EMPTY_FILTER, categoryIds: ["c-ramen"] }, VCTX);
    assert.equal(chips.find((c) => c.key === "categoryIds")?.label, "分類 午餐 › 拉麵");
  });
});

/* ═════════════════════════ C. 帳戶頁的數字 ═════════════════════════ */

describe("C. accountCards", () => {
  const ALL = [
    ent({ occurred_on: "2026-05-20", kind: "income", amount_minor: 5000 }), // 走勢之前
    ent({ occurred_on: "2026-06-10", amount_minor: 500 }),
    ent({ occurred_on: "2026-10-15", kind: "adjust", amount_minor: -20 }),
    ent({ occurred_on: "2026-11-02", kind: "income", amount_minor: 1000 }),
    ent({ occurred_on: "2026-11-03", amount_minor: 300 }),
    ent({ occurred_on: "2026-11-04", amount_minor: -50 }), // 退款
    ent({ occurred_on: "2026-11-05", kind: "transfer", amount_minor: 200, to_account_id: "a-card", to_amount_minor: 200 }),
    ent({ occurred_on: "2026-11-06", kind: "transfer", amount_minor: 3150, to_account_id: "a-usd", to_amount_minor: 100 }),
    ent({ occurred_on: "2026-11-07", account_id: "a-card", amount_minor: 80 }),
    ent({ occurred_on: "2026-11-08", kind: "adjust", amount_minor: 7 }),
    ent({ occurred_on: "2026-12-01", amount_minor: 100 }), // 未來月
    ent({ occurred_on: "2026-11-09", amount_minor: 999, deleted_at: NOW }), // 已刪不算
  ];
  const balances = T.balancesOf(ALL);
  const r = V.accountsRange("2026-11");
  const inWindow = ALL.filter((e) => e.occurred_on >= r.from && e.occurred_on < r.toExcl);
  const cards = V.accountCards(ACCS, balances, inWindow, "2026-11");

  test("13. 讀的範圍：走勢第一個月的月初到最後（含未來日）", () => {
    assert.deepEqual(r, { from: "2026-06-01", toExcl: V.FAR_DAY });
    assert.ok("2099-12-31" < V.FAR_DAY);
  });

  test("14. 本月進出：收支口徑（退款抵回）、轉帳兩頭各記在自己的帳戶、校正另列；帳戶幣別與主幣別", () => {
    assert.deepEqual(cards["a-cash"].month.own, { income: 1000, expense: 250, transferIn: 0, transferOut: 3350, adjust: 7 });
    assert.deepEqual(cards["a-card"].month.own, { income: 0, expense: 80, transferIn: 200, transferOut: 0, adjust: 0 });
    assert.deepEqual(cards["a-usd"].month.own.transferIn, 100, "目的帳戶幣別＝to_amount_minor");
    assert.deepEqual(cards["a-usd"].month.main.transferIn, 3150, "主幣別＝那筆的 main_minor");
    assert.equal(cards["a-old"].balance, 0, "封存帳戶也有卡（分組由 UI 決定）");
  });

  test("15. 走勢＝近六個月月底餘額（舊到新）；等於「只算月底以前的帳」的餘額；最後一點＝本月底（扣掉未來月的帳）", () => {
    for (const id of ["a-cash", "a-card", "a-usd"]) {
      const c = cards[id];
      assert.equal(c.balance, balances[id] ?? 0);
      assert.deepEqual(c.trend.map((p) => p.month), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
      for (const p of c.trend) {
        const end = T.monthRange(p.month).toExcl;
        assert.equal(p.balance, T.balancesOf(ALL.filter((e) => e.occurred_on < end))[id] ?? 0, `${id} ${p.month}`);
      }
    }
    assert.equal(cards["a-cash"].trend[5].balance, cards["a-cash"].balance + 100, "12/1 那筆還沒算進本月底");
  });

  test("16. 自己轉給自己只算一次（表單會擋，資料仍可能有）", () => {
    const self = [ent({ occurred_on: "2026-11-02", kind: "transfer", amount_minor: 30, to_account_id: "a-cash", to_amount_minor: 30 })];
    const c = V.accountCards(ACCS, T.balancesOf(self), self, "2026-11")["a-cash"];
    assert.deepEqual([c.month.own.transferIn, c.month.own.transferOut, c.balance, c.trend[5].balance], [30, 30, 0, 0]);
  });
});

/* ═════════════════════════ D. repository（memory／sqlite 同義） ═════════════════════════ */

interface TestDb {
  ops: { tbl: string; row_id: string; op: string; cols: Record<string, unknown> }[];
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<void>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: TestDb["ops"]): void;
}
function makeSqliteDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of ["0007_ticket_ledger", "0010_ticket_plan", "0016_ticket_wish"]) raw.exec(readFileSync(path.join(ROOT, `src-tauri/migrations/${f}.sql`), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const db: TestDb = {
    ops: [],
    async select(sql, args) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql, args) {
      raw.prepare(sql).run(bind(args));
    },
    runBatch(stmts, ops) {
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
type Impl = { name: "memory" | "sqlite"; make: () => { repo: any; db: TestDb | null } };
const IMPLS: Impl[] = [
  { name: "memory", make: () => ({ repo: new M.MemoryTicketRepository({ seedDemo: false }), db: null }) },
  {
    name: "sqlite",
    make: () => {
      const db = makeSqliteDb();
      (globalThis as { __tkDb?: TestDb }).__tkDb = db;
      return { repo: new S.SqliteTicketRepository(), db };
    },
  },
];
/** 樹的樣子（名字、上層名字、position、封存）——兩份 repo 比對用 */
async function shape(repo: any): Promise<string[]> {
  const cats = (await repo.listCategories()) as CategoryRow[];
  const by = byId(cats);
  return T.flattenForest(T.categoryForest(cats, "expense", { includeArchived: true })).map(
    (n) => `${"  ".repeat(n.depth)}${n.cat.name}@${n.cat.position}${n.cat.archived_at ? "（封存）" : ""}${n.cat.parent_id && !by[n.cat.parent_id] ? "!" : ""}`,
  );
}
const SHAPES: Record<string, string[][]> = {};

describe("D. repository（memory／sqlite）", () => {
  for (const impl of IMPLS) {
    test(`17. createCategory 不限層數、排在那一層最後；封存的底下不能建（${impl.name}）`, async () => {
      const { repo } = impl.make();
      await repo.ensureStarterRows();
      const food = await repo.createCategory({ kind: "expense", name: "食物", parentId: null });
      const out = await repo.createCategory({ kind: "expense", name: "外食", parentId: food.id });
      const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: out.id });
      const ramen = await repo.createCategory({ kind: "expense", name: "拉麵", parentId: lunch.id });
      const soba = await repo.createCategory({ kind: "expense", name: "蕎麥", parentId: lunch.id });
      assert.deepEqual([ramen.position, soba.position, ramen.parent_id], [0, 1, lunch.id]);
      await repo.setCategoryArchived(out.id, true);
      await rejectsMsg(repo.createCategory({ kind: "expense", name: "x", parentId: lunch.id }), "封存的分類底下不能建子分類");
    });

    test(`18. moveCategoryUnder：換上層＋兩邊整組寫；防環、未分類、別 kind、封存（${impl.name}）`, async () => {
      const { repo, db } = impl.make();
      await repo.ensureStarterRows();
      const food = await repo.createCategory({ kind: "expense", name: "食物", parentId: null });
      const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });
      const snack = await repo.createCategory({ kind: "expense", name: "點心", parentId: food.id });
      const ramen = await repo.createCategory({ kind: "expense", name: "拉麵", parentId: lunch.id });
      const traffic = await repo.createCategory({ kind: "expense", name: "交通", parentId: null });
      const bus = await repo.createCategory({ kind: "expense", name: "公車", parentId: traffic.id });
      const salary = await repo.createCategory({ kind: "income", name: "薪水", parentId: null });

      await rejectsMsg(repo.moveCategoryUnder(food.id, ramen.id), "不能移到自己或自己底下的分類");
      await rejectsMsg(repo.moveCategoryUnder(food.id, food.id), "不能移到自己或自己底下的分類");
      await rejectsMsg(repo.moveCategoryUnder(UNCAT_EXPENSE_ID, null), "「未分類」不能移動");
      await rejectsMsg(repo.moveCategoryUnder(lunch.id, UNCAT_EXPENSE_ID), "「未分類」底下不能放分類");
      await rejectsMsg(repo.moveCategoryUnder(lunch.id, salary.id), "這個分類不屬於目前的收支類型");

      // 午餐（連拉麵）搬到交通底下第 0 個：交通底下 [午餐, 公車]、食物底下剩 [點心]
      const mark = db ? db.ops.length : 0;
      await repo.moveCategoryUnder(lunch.id, traffic.id, 0);
      if (db) {
        const ops = db.ops.slice(mark);
        assert.equal(ops.length, 3, "午餐（parent_id＋position）、公車、點心各一筆；同一批");
        assert.deepEqual(ops.find((o) => o.row_id === lunch.id)?.cols.parent_id, traffic.id);
      }
      assert.deepEqual(await shape(repo), ["食物@0", "  點心@0", "交通@1", "  午餐@0", "    拉麵@0", "  公車@1", "未分類@9999"]);
      // 公車移到頂層第 1 個；同層搬動照舊
      await repo.moveCategoryUnder(bus.id, null, 1);
      await repo.moveCategoryUnder(snack.id, food.id); // 上層沒變、沒給 index ⇒ 不動
      assert.deepEqual(await shape(repo), ["食物@0", "  點心@0", "公車@1", "交通@2", "  午餐@0", "    拉麵@0", "未分類@9999"]);
      // 封存：底下整棵一起；封存的不能動、也不能當上層
      await repo.setCategoryArchived(ramen.id, true); // 先各自封存
      await repo.setCategoryArchived(traffic.id, true);
      await rejectsMsg(repo.moveCategoryUnder(lunch.id, null), "封存的分類不能移動");
      await rejectsMsg(repo.moveCategoryUnder(snack.id, lunch.id), "封存的分類底下不能放分類");
      assert.deepEqual(await shape(repo), ["食物@0", "  點心@0", "公車@1", "交通@2（封存）", "  午餐@0（封存）", "    拉麵@0（封存）", "未分類@9999"]);
      // 取消封存：連帶封存的回來，先各自封存的（拉麵）不動
      await repo.setCategoryArchived(traffic.id, false);
      assert.deepEqual(await shape(repo), ["食物@0", "  點心@0", "公車@1", "交通@2", "  午餐@0", "    拉麵@0（封存）", "未分類@9999"]);
      SHAPES[impl.name] = [await shape(repo)];
    });

    test(`18b. 同步合出的環：搬環上非最小的那個到頂層 ⇒ 最小的那個一起寫 parent＝null，不翻轉（${impl.name}）`, async () => {
      const { repo, db } = impl.make();
      await repo.ensureStarterRows();
      const a = await repo.createCategory({ kind: "expense", name: "甲", parentId: null });
      const b = await repo.createCategory({ kind: "expense", name: "乙", parentId: null });
      const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
      // 兩台各把對方搬到自己底下（逐欄 LWW 各贏一半）
      const setParent = async (id: string, p: string) => {
        if (db) await db.execute("UPDATE tk_categories SET parent_id = $1 WHERE id = $2", [p, id]);
        else (repo as any).cat.get(id).parent_id = p;
      };
      await setParent(lo.id, hi.id);
      await setParent(hi.id, lo.id);
      assert.deepEqual(await shape(repo), [`${lo.name}@${lo.position}`, `  ${hi.name}@${hi.position}`, "未分類@9999"], "讀時斷：小的當頂層");
      await repo.moveCategoryUnder(hi.id, null);
      const cats = (await repo.listCategories()) as CategoryRow[];
      assert.equal(cats.find((c) => c.id === lo.id)?.parent_id, null, "斷環寫回資料");
      assert.deepEqual((await shape(repo)).map((s) => s.replace(/@\d+/, "")), [lo.name, hi.name, "未分類"]);
    });
  }

  test("19. 兩份 repo 走完同一串操作，樹長得一樣", () => {
    assert.deepEqual(SHAPES.memory, SHAPES.sqlite);
  });
});

/* ═════════════════════════ E. ticketStore ═════════════════════════ */

describe("E. ticketStore 第二輪", async () => {
  const repo = new M.MemoryTicketRepository({ seedDemo: false });
  (globalThis as { __tkRepo?: unknown }).__tkRepo = repo;
  const { useTicketStore } = await import("../../src/store/ticketStore.ts");
  const st = () => useTicketStore.getState();
  const TODAY = todayKey(0);
  await st().init("desktop");
  const cash = await repo.createAccount({ name: "現金", group: "cash", currency: "TWD", openingMinor: 100000, occurredOn: TODAY });
  const food = await repo.createCategory({ kind: "expense", name: "食物", parentId: null });
  const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });
  const ramen = await repo.createCategory({ kind: "expense", name: "拉麵", parentId: lunch.id });
  const at = atOf(TODAY, "12:00", 0);
  for (const [c, n] of [[ramen.id, 3000], [lunch.id, 2000], [food.id, 500]] as const) {
    await repo.createEntry({ kind: "expense", amountMinor: n, currency: "TWD", accountId: cash.id, toAccountId: null, categoryId: c, occurredOn: TODAY, occurredAt: at, note: "", routeId: null });
  }
  await st().refresh();

  test("20. setStatsRoot：以那層為根重算；換收支、未分類、不在 ⇒ 回全部分類；換期間保留", async () => {
    await st().setView("stats");
    st().setDrill(food.id);
    st().setStatsRoot(lunch.id);
    assert.equal(st().statsRoot, lunch.id);
    assert.equal(st().drill, null, "換根就收起展開");
    assert.deepEqual(st().stats!.breakdown.rows.map((r) => `${r.key}=${r.minor}`), [`${ramen.id}=3000`, `${V.UNSPLIT_KEY}=2000`]);
    await st().setSpan("year");
    assert.equal(st().statsRoot, lunch.id);
    await st().setSpan("month");
    st().setStatsRoot(UNCAT_EXPENSE_ID);
    assert.equal(st().statsRoot, null);
    st().setStatsRoot(food.id);
    st().setFacetKind("income");
    assert.equal(st().statsRoot, null);
    st().setFacetKind("expense");
    st().setStatsRoot("nope");
    assert.equal(st().statsRoot, null);
  });

  test("21. moveCategoryUnder：成功回 true 並 refresh；防環 ⇒ toast 原因、回 false", async () => {
    assert.equal(await st().moveCategoryUnder(food.id, ramen.id), false);
    assert.equal(toastsOf().at(-1)?.message, "不能移到自己或自己底下的分類");
    assert.equal(await st().moveCategoryUnder(ramen.id, food.id, 0), true);
    assert.equal(st().catById[ramen.id].parent_id, food.id);
    await st().moveCategoryUnder(ramen.id, lunch.id); // 搬回去
  });

  test("22. 「常用」與備註帶分類：任何一層上層封存 ⇒ 不列", async () => {
    assert.ok(st().frequent.expense.includes(ramen.id));
    await st().setCategoryArchived(food.id, true);
    assert.deepEqual(st().frequent.expense.filter((id) => [food.id, lunch.id, ramen.id].includes(id)), []);
    // 只把拉麵取消封存：它自己沒封存、但上兩層還封存著 ⇒ 樹裡看不到 ⇒「常用」也不列
    await st().setCategoryArchived(ramen.id, false);
    assert.equal(st().catById[ramen.id].archived_at, null);
    assert.equal(st().frequent.expense.includes(ramen.id), false);
    assert.equal(st().lastCategoryForNote("expense", "x"), null);
    await st().setCategoryArchived(food.id, false);
    assert.ok(st().frequent.expense.includes(ramen.id));
  });

  test("23. 帳戶頁：setView(accounts) 一次載完卡片，記帳後 refresh 跟著變", async () => {
    assert.equal(st().accountCards, null, "沒進過帳戶頁不查");
    await st().setView("accounts");
    const c = st().accountCards![cash.id];
    assert.equal(c.balance, st().balances[cash.id]);
    assert.equal(c.month.own.expense, 5500);
    assert.equal(c.trend.length, V.ACCOUNT_TREND_MONTHS);
    await repo.createEntry({ kind: "expense", amountMinor: 700, currency: "TWD", accountId: cash.id, toAccountId: null, categoryId: ramen.id, occurredOn: TODAY, occurredAt: at, note: "", routeId: null });
    await st().refresh();
    assert.equal(st().accountCards![cash.id].month.own.expense, 6200);
    assert.equal(st().accountCards![cash.id].trend[V.ACCOUNT_TREND_MONTHS - 1].balance, st().balances[cash.id]);
  });
});

/** toast 清單（FAKE_UI 把自己掛在 globalThis.__uiStoreRef） */
function toastsOf(): { message: string; onAction?: () => void }[] {
  return (globalThis as unknown as { __uiStoreRef?: { getState(): { toasts: { message: string; onAction?: () => void }[] } } }).__uiStoreRef?.getState().toasts ?? [];
}
