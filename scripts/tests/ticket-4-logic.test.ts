/**
 * 售票口④（Stage 0 資料席）：荷札、記一筆設定期、備註記憶、常用票種、願望清單、拖曳排序的資料面。
 * 跑法：`node --test scripts/tests/ticket-4-logic.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 *   A～E  domain 純函式（ticket.ts planMoveTo、ticketPlan.ts 定期快設、ticketView.ts 荷札篩選與依荷札、ticketTags.ts、ticketAids.ts）
 *   F     repository 對帳：memory 與 sqlite 兩個實作各跑一遍（sqlite＝node:sqlite 記憶體庫套**真的** 0007＋0010＋0016 DDL、開外鍵；
 *         `runBatch` 替身收 op，驗新列的 op＝ticket.rs 白名單完整列、搬動＝整組寫）
 *   G     ticketStore（替身 uiStore／nodeStore／tagRepo／tagStore；ticketRepo＝真的 memory 實作）：saveDraft 的四步、存並再記、
 *         實體化帶規則的荷札、既有帳快設定期、今日頁的定期帳、備註記憶、常用票種、願望買了、捕捉框的 #荷札；
 *         代驗修正：規則編輯器的荷札（G1）、今日頁跳到那筆定期帳（O5）
 *   H     EntityTagField 的選中列（ui/common/entityTagKeys.ts；代驗 P1）
 *
 * 載入照 ticket-plan-logic／ticket-sort-store：registerHooks 補 `.ts`、把 `../lib/db`／`./syncRepository` 換成 data: 模組；
 * src 的值一律等 hook 掛好後動態載入。時區：測資用本地日 key，不寫 UTC 字面值；金額一律合成。
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

import type { AccountRow, CategoryRow, CurrencyRow, EntryCtx, EntryRow, TemplateRow, WishRow } from "../../src/domain/ticket.ts";

const T = await import("../../src/domain/ticket.ts");
const V = await import("../../src/domain/ticketView.ts");
const P = await import("../../src/domain/ticketPlan.ts");
const TG = await import("../../src/domain/ticketTags.ts");
const A = await import("../../src/domain/ticketAids.ts");
const TAGS = await import("../../src/domain/tags.ts");
const R = await import("../../src/domain/repeat.ts");
const M = await import("../../src/data/memoryTicketRepository.ts");
const S = await import("../../src/data/sqliteTicketRepository.ts");
const { addDays, todayKey } = await import("../../src/lib/date.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, ticketId, atOf } = T;

/* ───────── fixture ───────── */

const NOW = new Date(2026, 10, 2, 9, 0).toISOString();
const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };
const TWD: CurrencyRow = { id: ticketId("currency:TWD"), code: "TWD", name: "TWD", decimals: 2, rate_to_main: "1", is_main: 1, position: 0, ...SYNC };
const USD: CurrencyRow = { id: ticketId("currency:USD"), code: "USD", name: "USD", decimals: 2, rate_to_main: "31.5", is_main: 0, position: 1, ...SYNC };
const acc = (id: string, extra: Partial<AccountRow> = {}): AccountRow => ({ id, name: id, group_key: "cash", currency: "TWD", position: 0, archived_at: null, ...SYNC, ...extra });
const cat = (id: string, kind: "income" | "expense", parent: string | null = null, extra: Partial<CategoryRow> = {}): CategoryRow => ({
  id, kind, name: id, parent_id: parent, position: 0, archived_at: null, ...SYNC, ...extra,
});
const byId = <X extends { id: string }>(rows: X[]): Record<string, X> => Object.fromEntries(rows.map((r) => [r.id, r]));
const ACCS = [acc("a-cash"), acc("a-bank", { group_key: "bank" }), acc("a-old", { archived_at: NOW }), acc("a-usd", { currency: "USD" })];
const CATS = [
  cat(UNCAT_INCOME_ID, "income"),
  cat(UNCAT_EXPENSE_ID, "expense"),
  cat("c-food", "expense"),
  cat("c-lunch", "expense", "c-food"),
  cat("c-old", "expense", null, { archived_at: NOW }),
  cat("c-salary", "income"),
];
const CTX: EntryCtx = { accById: byId(ACCS), catById: byId(CATS), curByCode: { TWD, USD } };

let seq = 0;
function ent(p: Partial<EntryRow> & { occurred_on: string }): EntryRow {
  seq++;
  const amount = p.amount_minor ?? 12000;
  return {
    id: `e-${seq}`,
    kind: "expense",
    occurred_at: atOf(p.occurred_on, "12:00", 0),
    account_id: "a-cash",
    to_account_id: null,
    category_id: "c-lunch",
    amount_minor: amount,
    currency: "TWD",
    main_minor: amount,
    account_minor: amount,
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

/* ═════════════════════════ A. 搬到第 k 個（planMoveTo） ═════════════════════════ */

describe("A. planMoveTo（拖曳的整組寫）", () => {
  const L = ["a", "b", "c", "d"].map((id) => ({ id }));
  test("1. 往後、往前、夾到範圍內；回整組 0..n-1", () => {
    assert.deepEqual(T.planMoveTo(L, "a", 2), [{ id: "b", position: 0 }, { id: "c", position: 1 }, { id: "a", position: 2 }, { id: "d", position: 3 }]);
    assert.deepEqual(T.planMoveTo(L, "d", 0).map((x) => x.id), ["d", "a", "b", "c"]);
    assert.deepEqual(T.planMoveTo(L, "b", 99).map((x) => x.id), ["a", "c", "d", "b"]);
    assert.deepEqual(T.planMoveTo(L, "c", -5).map((x) => x.id), ["c", "a", "b", "d"]);
  });
  test("2. 位置沒變、id 不在、index 不是整數 ⇒ 空（不寫）", () => {
    assert.deepEqual(T.planMoveTo(L, "b", 1), []);
    assert.deepEqual(T.planMoveTo(L, "zz", 0), []);
    assert.deepEqual(T.planMoveTo(L, "a", 1.5), []);
  });
});

/* ═════════════════════════ B. 記一筆設定期（D-票-66） ═════════════════════════ */

describe("B. 定期快設", () => {
  test("3. 從記帳日帶：2026-11-05 是星期四、5 號；預設不重複", () => {
    const q = P.quickRepeat("weekly", "2026-11-05");
    assert.deepEqual(q, { freq: "weekly", weekday: 4, monthday: 5, until: null });
    assert.equal(P.noRepeat("2026-11-05").freq, "none");
    assert.equal(P.quickRepeatLabel(q), "每週四");
    assert.equal(P.quickRepeatLabel(P.quickRepeat("monthly", "2026-11-05")), "每月 5 日");
    assert.equal(P.quickRepeatLabel(P.quickRepeat("daily", "2026-11-05")), "每天");
    assert.equal(P.quickRepeatLabel(P.noRepeat("2026-11-05")), "不重複");
  });
  test("4. 起算＝下一班（不是這筆自己那天）：每月 12/5、每週下週四、每日隔天；不重複 ⇒ null", () => {
    assert.equal(P.quickFirstRun(P.quickRepeat("monthly", "2026-11-05"), "2026-11-05"), "2026-12-05");
    assert.equal(P.quickFirstRun(P.quickRepeat("weekly", "2026-11-05"), "2026-11-05"), "2026-11-12");
    assert.equal(P.quickFirstRun(P.quickRepeat("daily", "2026-11-05"), "2026-11-05"), "2026-11-06");
    assert.equal(P.quickRepeatRule(P.noRepeat("2026-11-05"), "2026-11-05"), null);
    const rule = P.quickRepeatRule(P.quickRepeat("monthly", "2026-11-05"), "2026-11-05")!;
    assert.equal(rule.start, "2026-11-06");
    assert.deepEqual(rule.bymonthday, [5]);
  });
  test("5. 31 號遇到小月夾到月底（repeat.ts 的規則）：10/31 每月 ⇒ 11/30、12/31", () => {
    const q = P.quickRepeat("monthly", "2026-10-31");
    const rule = P.quickRepeatRule(q, "2026-10-31")!;
    assert.equal(P.quickFirstRun(q, "2026-10-31"), "2026-11-30");
    assert.deepEqual(R.projectFixed(rule, rule.start, "2027-02-28"), ["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  });
  test("6. 改記帳日：沒點改過的星期幾／幾號跟著走、點改過的不動；結束日早於新起算 ⇒ 清掉", () => {
    const q = { ...P.quickRepeat("weekly", "2026-11-05"), until: "2026-11-10" };
    const moved = P.quickFollowDay(q, "2026-11-05", "2026-11-13");
    assert.equal(moved.weekday, 5);
    assert.equal(moved.monthday, 13);
    assert.equal(moved.until, null, "11/10 早於新起算 11/14");
    const pinned = { ...P.quickRepeat("weekly", "2026-11-05"), weekday: 1 };
    assert.equal(P.quickFollowDay(pinned, "2026-11-05", "2026-11-06").weekday, 1);
  });
  test("7. quickRepeatDraft → draftToRepeatInput：跟完整編輯器同一套驗證（結束日要在起算之後）", () => {
    const src = { kind: "expense" as const, amountText: "120", currency: "TWD", accountId: "a-cash", toAccountId: null, categoryId: "c-lunch", note: "午餐", routeId: null, dayKey: "2026-11-05", time: "12:30" };
    const rd = P.quickRepeatDraft(src, P.quickRepeat("monthly", "2026-11-05"), "e-1")!;
    assert.equal(rd.start, "2026-11-06");
    assert.equal(rd.hhmm, "12:30");
    assert.equal(rd.fromEntryId, "e-1");
    const input = P.draftToRepeatInput(rd, CTX);
    assert.equal(input.amountMinor, 12000);
    assert.deepEqual(input.rule.bymonthday, [5]);
    assert.equal(P.quickRepeatDraft(src, P.noRepeat("2026-11-05"), null), null);
    const bad = P.quickRepeatDraft(src, { ...P.quickRepeat("daily", "2026-11-05"), until: "2026-11-05" }, null)!;
    throwsMsg(() => P.draftToRepeatInput(bad, CTX), P.PLAN_TEXT.untilBad);
  });
  test("8. 既有帳那一列：quickOfRule／repeatLineText（快設表示得出來寫「日」、進階規則用 describeRule）", () => {
    const r = P.buildRepeatRow(
      { kind: "expense", accountId: "a-cash", toAccountId: null, categoryId: "c-lunch", amountMinor: 100, currency: "TWD", note: "", routeId: null, rule: P.quickRepeatRule(P.quickRepeat("monthly", "2026-11-01"), "2026-11-01")!, hhmm: "09:00" },
      CTX,
      { id: "r1", position: 0, nowIso: NOW },
    );
    assert.equal(P.repeatLineText(r), "每月 1 日 · 下一班 12/1");
    const adv = { ...r, rule: JSON.stringify({ ...JSON.parse(r.rule), bymonthday: [1, 15] }) };
    assert.equal(P.repeatLineText(adv), "每月 1・15 號 · 下一班 12/1");
    assert.equal(P.repeatLineText({ ...r, paused_at: NOW }), "每月 1 日 · 已暫停");
  });
  test("9. isRepeatMade：id＝materializeId(規則, 那天) 才算；來源那筆（uuid）不算；repeatDaySum 收入 − 支出", () => {
    const made = ent({ occurred_on: "2026-11-05", repeat_id: "r1", id: P.materializeId("r1", "2026-11-05") });
    const source = ent({ occurred_on: "2026-11-05", repeat_id: "r1" });
    const moved = ent({ occurred_on: "2026-11-06", repeat_id: "r1", id: P.materializeId("r1", "2026-11-05") });
    assert.equal(P.isRepeatMade(made), true);
    assert.equal(P.isRepeatMade(source), false);
    assert.equal(P.isRepeatMade(moved), false);
    const inc = ent({ occurred_on: "2026-11-05", kind: "income", amount_minor: 500000 });
    const tr = ent({ occurred_on: "2026-11-05", kind: "transfer", amount_minor: 100 });
    assert.deepEqual(P.repeatDaySum([made, inc, tr]), { count: 3, net: 500000 - 12000 });
  });
});

/* ═════════════════════════ C. 荷札（D-票-73、74） ═════════════════════════ */

describe("C. 荷札：捕捉、篩選、依荷札、關鍵字", () => {
  test("10. splitQuickTags：#名稱 抽出來、不進備註；色碼、純數字、C# 不算；同名只留一個", () => {
    assert.deepEqual(TG.splitQuickTags("80 午餐 #旅行/京都 和同學 #fff #2026"), { body: "80 午餐 和同學 #fff #2026", names: ["旅行/京都"] });
    assert.deepEqual(TG.splitQuickTags("80 C#課本 #出差 #出差"), { body: "80 C#課本", names: ["出差"] });
    assert.deepEqual(TG.splitQuickTags("80 午餐"), { body: "80 午餐", names: [] });
    assert.deepEqual(TG.splitQuickTags("80 午餐 #京都").body, "80 午餐");
  });
  test("11. cleanTagNames：去 #、去重、不合法回理由", () => {
    assert.deepEqual(TG.cleanTagNames(["#京都", "京都", "旅行/大阪"]), { ok: true, names: ["京都", "旅行/大阪"] });
    const bad = TG.cleanTagNames(["好 的"]);
    assert.equal(bad.ok, false);
    assert.equal(TG.cleanTagNames(["2026"]).ok, false);
    assert.deepEqual(TG.cleanTagNames([]), { ok: true, names: [] });
  });

  const idx = TAGS.buildIndex({
    tags: [
      { id: "t1", name: "旅行", key: "旅行" },
      { id: "t2", name: "旅行/京都", key: "旅行/京都" },
      { id: "t3", name: "旅行/大阪", key: "旅行/大阪" },
      { id: "t4", name: "出差", key: "出差" },
      { id: "t5", name: "Coffee", key: "coffee" },
    ],
    taggings: [
      { tagId: "t2", entityType: "ticket:entry", entityId: "x1" },
      { tagId: "t3", entityType: "ticket:entry", entityId: "x1" },
      { tagId: "t4", entityType: "ticket:entry", entityId: "x1" },
      { tagId: "t1", entityType: "ticket:entry", entityId: "x2" },
      { tagId: "t4", entityType: "ticket:entry", entityId: "x3" },
      { tagId: "t5", entityType: "ticket:repeat", entityId: "x4" },
    ],
  } as never);
  const x1 = ent({ id: "x1", occurred_on: "2026-11-03", amount_minor: 10000, note: "車票" });
  const x2 = ent({ id: "x2", occurred_on: "2026-11-04", amount_minor: 3000 });
  const x3 = ent({ id: "x3", occurred_on: "2026-11-04", amount_minor: 2000 });
  const x5 = ent({ id: "x5", occurred_on: "2026-11-04", amount_minor: 500 });
  const routes = { routeById: {}, routeOrder: [] };
  const vctx = { ...CTX, ...routes, entryTags: TG.entityTagMap(idx, TG.TK_TAG_ENTRY), tagName: TG.tagNameOf(idx) };

  test("12. entityTagMap／tagNameOf／tagNamesOf：只取那一種實體；名字照原寫法（大小寫）", () => {
    assert.deepEqual(Object.keys(vctx.entryTags).sort(), ["x1", "x2", "x3"]);
    assert.deepEqual(TG.entityTagMap(idx, TG.TK_TAG_REPEAT), { x4: ["coffee"] });
    assert.equal(TG.tagNameOf(idx)("coffee"), "Coffee");
    assert.equal(TG.tagNameOf(null)("coffee"), "coffee");
    assert.deepEqual(TG.tagNamesOf(idx, TG.TK_TAG_ENTRY, "x1"), ["出差", "旅行/京都", "旅行/大阪"].sort());
    assert.deepEqual(TG.entityTagMap(null), {});
  });
  test("13. matchesTagFilter：選父含子、多選＝任一、沒掛的不中；空＝不限", () => {
    assert.equal(V.matchesTagFilter(x1, ["旅行"], vctx), true);
    assert.equal(V.matchesTagFilter(x2, ["旅行"], vctx), true);
    assert.equal(V.matchesTagFilter(x3, ["旅行"], vctx), false);
    assert.equal(V.matchesTagFilter(x3, ["旅行", "出差"], vctx), true);
    assert.equal(V.matchesTagFilter(x2, ["旅行/京都"], vctx), false, "子不含父");
    assert.equal(V.matchesTagFilter(x5, ["旅行"], vctx), false);
    assert.equal(V.matchesTagFilter(x5, [], vctx), true);
    assert.equal(V.matchesTagFilter(x1, ["旅"], vctx), false, "不會把 #旅行 算進 #旅");
  });
  test("14. filterEntries／isFilterActive／filterChips 認 tagKeys；關鍵字也比對荷札名", () => {
    const all = [x1, x2, x3, x5];
    const f = { ...V.EMPTY_FILTER, tagKeys: ["旅行"] };
    assert.equal(V.isFilterActive(f), true);
    assert.deepEqual(V.filterEntries(all, f, vctx).map((e) => e.id).sort(), ["x1", "x2"]);
    assert.deepEqual(V.filterChips(f, vctx).map((c) => c.label), ["荷札 #旅行"]);
    assert.deepEqual(V.filterChips({ ...f, tagKeys: ["旅行", "出差"] }, vctx).map((c) => c.label), ["荷札 2 個"]);
    assert.deepEqual(V.filterEntries(all, { ...V.EMPTY_FILTER, text: "京都" }, vctx).map((e) => e.id), ["x1"]);
    assert.deepEqual(V.filterEntries(all, { ...V.EMPTY_FILTER, text: "出差" }, vctx).map((e) => e.id).sort(), ["x1", "x3"]);
    // 舊的 filter 物件（沒有 tagKeys）照舊能用
    const legacy = { ...V.EMPTY_FILTER } as Partial<typeof V.EMPTY_FILTER>;
    delete legacy.tagKeys;
    assert.equal(V.isFilterActive(legacy as typeof V.EMPTY_FILTER), false);
  });
  test("15. 依荷札：父含子、一筆掛多個各算一次、同一主列一筆只算一次；沒掛荷札一列排最後；share 分母＝期間淨額", () => {
    const r = { from: "2026-11-01", toExcl: "2026-12-01" };
    const b = V.breakdown([x1, x2, x3, x5], r, "tag", "expense", vctx);
    const rows = Object.fromEntries(b.rows.map((x) => [x.key, x]));
    assert.equal(b.total, 15500, "每筆只算一次");
    assert.equal(rows["旅行"].minor, 13000, "x1（京都＋大阪只算一次）＋x2");
    assert.equal(rows["旅行"].count, 2);
    assert.equal(rows["出差"].minor, 12000);
    assert.deepEqual(rows["旅行"].children!.map((c) => [c.label, c.minor]), [["京都", 10000], ["大阪", 10000], ["未細分", 3000]]);
    assert.equal(rows["出差"].children, undefined, "只有直接掛在父荷札本身 ⇒ 不出未細分");
    assert.equal(b.rows[b.rows.length - 1].key, V.NO_TAG_KEY);
    assert.equal(b.rows[b.rows.length - 1].label, "沒掛荷札");
    const sumShare = b.rows.reduce((s, x) => s + x.share, 0);
    assert.ok(sumShare > 1, "加總可能超過 100%（D-票-73 頁上寫一行說明）");
    assert.equal(rows["旅行"].share, 13000 / 15500);
    // 沒給 entryTags（index 沒載）＝全部沒掛
    assert.deepEqual(V.breakdown([x1], r, "tag", "expense", { ...CTX, ...routes }).rows.map((x) => x.key), [V.NO_TAG_KEY]);
  });
});

/* ═════════════════════════ D. 備註記憶（D-票-70） ═════════════════════════ */

describe("D. 備註記憶", () => {
  const uses = [
    { note: "麥味登", occurred_on: "2026-10-01", kind: "expense" as const, category_id: "c-lunch" },
    { note: "麥味登", occurred_on: "2026-10-20", kind: "expense" as const, category_id: "c-food" },
    { note: "ＭＫ便當", occurred_on: "2026-10-21", kind: "expense" as const, category_id: UNCAT_EXPENSE_ID },
    { note: "mk便當", occurred_on: "2026-10-02", kind: "expense" as const, category_id: "c-lunch" },
    { note: "麥味登", occurred_on: "2026-10-25", kind: "income" as const, category_id: "c-salary" },
    { note: "麥味登", occurred_on: "2026-10-26", kind: "expense" as const, category_id: "c-old" },
  ];
  test("16. noteRecallItems：鍵相同併成一個、次數相加、last＝最近的 occurred_on、字取最近那次的寫法", () => {
    const items = A.noteRecallItems(uses);
    const mai = items.find((x) => x.text === "麥味登")!;
    assert.equal(mai.count, 4);
    assert.equal(mai.last, "2026-10-26");
    const mk = items.find((x) => x.text.toLowerCase().includes("便當"))!;
    assert.equal(mk.count, 2);
    assert.equal(mk.text, "ＭＫ便當");
  });
  test("17. lastCategoryForNote：同 kind、最近一筆有真分類而且可用；全形半形大小寫視為一樣；未分類跳過", () => {
    const usable = (id: string) => CTX.catById[id] !== undefined && CTX.catById[id].archived_at === null;
    assert.equal(A.lastCategoryForNote(uses, "expense", "麥味登", usable), "c-food", "c-old 封存了，往回找");
    assert.equal(A.lastCategoryForNote(uses, "income", "麥味登", usable), "c-salary");
    assert.equal(A.lastCategoryForNote(uses, "expense", "mk便當", usable), "c-lunch", "最近那筆是未分類 ⇒ 用前一筆");
    assert.equal(A.lastCategoryForNote(uses, "expense", "沒寫過", usable), null);
    assert.equal(A.lastCategoryForNote(uses, "expense", "  ", usable), null);
  });
});

/* ═════════════════════════ E. 願望與常用票種（D-票-68、69） ═════════════════════════ */

describe("E. 願望與常用票種的純函式", () => {
  const w = (id: string, p: Partial<WishRow> = {}): WishRow => ({ ...A.buildWishRow({ name: id, amountMinor: 1000, note: "", categoryId: null }, { id, position: 0, nowIso: NOW }), ...p });
  test("18. wishView：entry_id 指到還在的帳＝已買；那筆被刪＝回到想買；合計不算沒估價的", () => {
    const e1 = ent({ occurred_on: "2026-11-01", amount_minor: 780000 });
    const e2 = ent({ occurred_on: "2026-10-01", amount_minor: 300 });
    const v = A.wishView(
      [w("w1", { position: 2 }), w("w2", { position: 1, amount_minor: null }), w("w3", { entry_id: e1.id }), w("w4", { entry_id: "gone" }), w("w5", { entry_id: e2.id }), w("w6", { deleted_at: NOW })],
      byId([e1, e2]),
    );
    assert.deepEqual(v.want.map((x) => x.id), ["w4", "w2", "w1"], "position 0（w4）→ 1 → 2；那筆不在的 w4 回到想買");
    assert.deepEqual(v.bought.map((b) => b.wish.id), ["w3", "w5"], "那筆的日期新到舊");
    assert.equal(v.wantTotal, 2000);
    assert.equal(v.unpriced, 1);
    assert.equal(v.spent, 780300);
    assert.equal(A.wishBought({ entry_id: e1.id }, byId([e1])), true);
    assert.equal(A.wishBought({ entry_id: e1.id }, {}), false);
  });
  test("19. checkWishInput／applyWishPatch：名稱不能空、金額 ≥ 0；只回變了的欄", () => {
    throwsMsg(() => A.checkWishInput({ name: "  " }), A.AIDS_TEXT.wishNameEmpty);
    throwsMsg(() => A.checkWishInput({ amountMinor: -1 }), A.AIDS_TEXT.wishAmountBad);
    const row = w("w1");
    assert.deepEqual(A.applyWishPatch(row, { name: "w1", amountMinor: 1000 }, NOW).cols, {});
    assert.deepEqual(A.applyWishPatch(row, { name: " 耳機 ", amountMinor: null }, "T2").cols, { name: "耳機", amount_minor: null, updated_at: "T2" });
  });
  test("20. wishDraftSeed：支出、金額＝預估（主幣別）、備註＝名稱、分類（封存或收入的不帶）", () => {
    const main = { code: "TWD", decimals: 2 };
    assert.deepEqual(A.wishDraftSeed(w("降噪耳機", { amount_minor: 780000, category_id: "c-lunch" }), CTX, main), {
      kind: "expense", amountText: "7800", currency: "TWD", note: "降噪耳機", categoryId: "c-lunch", wishId: "降噪耳機",
    });
    assert.equal(A.wishDraftSeed(w("x", { amount_minor: null, category_id: "c-old" }), CTX, main).categoryId, null);
    assert.equal(A.wishDraftSeed(w("x", { amount_minor: null }), CTX, main).amountText, "");
    assert.equal(A.wishDraftSeed(w("x", { category_id: "c-salary" }), CTX, main).categoryId, null);
  });
  test("21. templateFromEntry：整張照抄；精算不能存；轉帳不帶分類", () => {
    const e = ent({ occurred_on: "2026-11-01", note: "學餐", route_id: "rt" });
    assert.deepEqual(A.templateFromEntry(e, " 午餐 "), {
      name: "午餐", kind: "expense", amountMinor: 12000, currency: "TWD", accountId: "a-cash", toAccountId: null, categoryId: "c-lunch", note: "學餐", routeId: "rt",
    });
    throwsMsg(() => A.templateFromEntry(ent({ occurred_on: "2026-11-01", kind: "adjust" }), "x"), A.AIDS_TEXT.templateAdjust);
    throwsMsg(() => A.templateFromEntry(e, ""), A.AIDS_TEXT.templateNameEmpty);
    const tr = A.templateFromEntry(ent({ occurred_on: "2026-11-01", kind: "transfer", to_account_id: "a-bank", category_id: null }), "儲值");
    assert.equal(tr.toAccountId, "a-bank");
    assert.equal(tr.categoryId, null);
  });
  test("22. templateDraftSeed：整張填；帳戶已刪或封存 ⇒ 不給（草稿留原本的）；分類封存或 kind 不合 ⇒ null；沒存金額 ⇒ 清空", () => {
    const base = A.buildTemplateRow(
      { name: "午餐", kind: "expense", amountMinor: 12050, currency: "TWD", accountId: "a-cash", toAccountId: null, categoryId: "c-lunch", note: "學餐", routeId: null },
      { id: "t1", position: 0, nowIso: NOW },
    );
    assert.deepEqual(A.templateDraftSeed(base, CTX), {
      kind: "expense", amountText: "120.5", currency: "TWD", accountId: "a-cash", categoryId: "c-lunch", note: "學餐", routeId: null, fromTemplateId: "t1",
    });
    const gone: TemplateRow = { ...base, account_id: "a-old", category_id: "c-old", amount_minor: null, currency: null };
    const s = A.templateDraftSeed(gone, CTX);
    assert.equal("accountId" in s, false);
    assert.equal("currency" in s, false);
    assert.equal(s.categoryId, null);
    assert.equal(s.amountText, "");
    const usd = A.templateDraftSeed({ ...base, account_id: "a-usd", currency: null, amount_minor: 100 }, CTX);
    assert.equal(usd.currency, "USD", "沒存幣別 ⇒ 跟著帳戶");
    const tr = A.templateDraftSeed({ ...base, kind: "transfer", account_id: "a-bank", to_account_id: "a-old", category_id: "c-lunch" }, CTX);
    assert.equal(tr.toAccountId, null, "轉入帳戶封存 ⇒ 不帶");
    assert.equal(tr.categoryId, null);
  });
  test("22b. templateDraftSeed：金額的小數位照書籤自己的幣別；跟著帳戶幣別的（轉帳、沒存幣別的收支）帳戶不能用 ⇒ 不帶金額", () => {
    const JPY: CurrencyRow = { ...USD, id: ticketId("currency:JPY"), code: "JPY", name: "JPY", decimals: 0, rate_to_main: "0.21", position: 2 };
    const ctx: EntryCtx = { ...CTX, accById: { ...CTX.accById, "a-jpy": acc("a-jpy", { currency: "JPY", archived_at: NOW }) }, curByCode: { TWD, USD, JPY } };
    const base = A.buildTemplateRow(
      { name: "儲值", kind: "transfer", amountMinor: 5000, currency: "JPY", accountId: "a-jpy", toAccountId: "a-cash", categoryId: null, note: "", routeId: null },
      { id: "t2", position: 0, nowIso: NOW },
    );
    assert.equal(A.templateDraftSeed(base, ctx).amountText, "", "轉帳一定是帳戶幣別：帳戶封存 ⇒ 不帶金額（草稿的帳戶不一定是日圓）");
    const ex = A.templateDraftSeed({ ...base, kind: "expense", to_account_id: null, currency: null }, ctx);
    assert.deepEqual([ex.amountText, "currency" in ex, "accountId" in ex], ["", false, false], "跟著帳戶的幣別、帳戶封存 ⇒ 不帶金額（草稿的帳戶是別的幣別）");
    const own = A.templateDraftSeed({ ...base, kind: "expense", to_account_id: null }, ctx);
    assert.deepEqual([own.amountText, own.currency], ["5000", "JPY"], "存了自己的幣別：照它的小數位帶");
    const ok = A.templateDraftSeed({ ...base, account_id: "a-jpy-ok" }, { ...ctx, accById: { ...ctx.accById, "a-jpy-ok": acc("a-jpy-ok", { currency: "JPY" }) } });
    assert.equal(ok.amountText, "5000", "帳戶可用的日圓轉帳：不會被當成兩位小數");
  });
  test("23. applyTemplatePatch：只回變了的欄", () => {
    const t = A.buildTemplateRow({ name: "午餐", kind: "expense", amountMinor: null, currency: null, accountId: null, toAccountId: null, categoryId: null, note: "", routeId: null }, { id: "t1", position: 0, nowIso: NOW });
    assert.deepEqual(A.applyTemplatePatch(t, { name: "午餐" }, "T2").cols, {});
    assert.deepEqual(A.applyTemplatePatch(t, { name: "便當" }, "T2").cols, { name: "便當", updated_at: "T2" });
    throwsMsg(() => A.applyTemplatePatch(t, { kind: "adjust" as never }, "T2"), A.AIDS_TEXT.templateKindBad);
  });
});

/* ═════════════════════════ F. repository 對帳（memory／sqlite） ═════════════════════════ */

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
function rustCols(name: string): string[] {
  const src = readFileSync(path.join(ROOT, "src-tauri/src/sync/tables/ticket.rs"), "utf8");
  const m = new RegExp(`const ${name}: &\\[\\(&str, bool\\)\\] = &\\[([\\s\\S]*?)\\];`).exec(src);
  assert.ok(m, `ticket.rs 找不到 ${name}`);
  return Array.from(m[1].matchAll(/\("(\w+)",/g), (x) => x[1]);
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
async function setup(impl: Impl) {
  const { repo, db } = impl.make();
  await repo.ensureStarterRows();
  const cash = await repo.createAccount({ name: "現金", group: "cash", currency: "TWD", openingMinor: null, occurredOn: "2026-11-01" });
  const food = await repo.createCategory({ kind: "expense", name: "🍜 食物", parentId: null });
  const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });
  return { repo, db, cash, food, lunch };
}
const expenseInput = (accountId: string, categoryId: string | null, day: string, note = "", amountMinor = 12000) => ({
  kind: "expense", amountMinor, currency: "TWD", accountId, toAccountId: null, categoryId, occurredOn: day, occurredAt: atOf(day, "12:00", 0), note, routeId: null,
});

describe("F. repository（memory／sqlite；sqlite 套 0007＋0010＋0016 真 DDL）", () => {
  test("24. 0016：兩張表的欄＝ticket.rs 白名單＋id＋device_id／synced_at；檔頭照 0010 寫法、沒有 CHECK", () => {
    const sql = readFileSync(path.join(ROOT, "src-tauri/migrations/0016_ticket_wish.sql"), "utf8");
    assert.ok(!sql.includes("\r"), "LF 行尾");
    assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\bCHECK\b/, "註解以外沒有 CHECK");
    assert.match(sql, /號碼只寫在檔名與 migrations\.rs 那一行；正式號由主對話進驗收時發/);
    const d = new DatabaseSync(":memory:");
    for (const f of ["0007_ticket_ledger", "0010_ticket_plan", "0016_ticket_wish"]) d.exec(readFileSync(path.join(ROOT, `src-tauri/migrations/${f}.sql`), "utf8"));
    for (const [tbl, cols] of [["tk_wishes", "TK_WISHES_COLS"], ["tk_templates", "TK_TEMPLATES_COLS"]] as const) {
      const names = new Set(d.prepare(`PRAGMA table_info(${tbl})`).all().map((r) => String((r as { name: string }).name)));
      for (const c of [...rustCols(cols), "id", "device_id", "synced_at"]) assert.ok(names.has(c), `${tbl}.${c}`);
      assert.equal(names.size, rustCols(cols).length + 3, `${tbl} 沒有白名單外的欄`);
    }
    const rs = readFileSync(path.join(ROOT, "src-tauri/src/migrations.rs"), "utf8");
    assert.match(rs, /^\s*mig!\(16, "0016_ticket_wish", /m);
  });

  for (const impl of IMPLS) {
    test(`25. 願望：新的排最上面、改只寫變了的欄、買了／刪復原；新列 op＝白名單完整列（${impl.name}）`, async () => {
      const { repo, db, lunch } = await setup(impl);
      const w1 = await repo.createWish({ name: "降噪耳機", amountMinor: 780000, note: "", categoryId: lunch.id });
      const w2 = await repo.createWish({ name: "  登山背包 ", amountMinor: null, note: "", categoryId: null });
      assert.equal(w2.name, "登山背包");
      assert.deepEqual((await repo.listWishes()).map((w: WishRow) => w.id), [w2.id, w1.id], "新的在最上面");
      if (db) {
        const op = db.ops.find((o) => o.tbl === "tk_wishes" && o.row_id === w1.id)!;
        assert.deepEqual(Object.keys(op.cols), rustCols("TK_WISHES_COLS"));
      }
      await assert.rejects(repo.createWish({ name: " ", amountMinor: null, note: "", categoryId: null }), RangeError);
      const mark = db ? db.ops.length : 0;
      assert.equal((await repo.updateWish(w1.id, { name: "降噪耳機", amountMinor: 780000 })).id, w1.id);
      if (db) assert.equal(db.ops.length, mark, "沒變不寫");
      const up = await repo.updateWish(w1.id, { amountMinor: 699000 });
      assert.equal(up.amount_minor, 699000);
      if (db) assert.deepEqual(Object.keys(db.ops[db.ops.length - 1].cols).sort(), ["amount_minor", "updated_at"]);
      const e = await repo.createEntry(expenseInput((await repo.listAccounts())[0].id, lunch.id, "2026-11-01", "降噪耳機", 699000));
      await repo.setWishBought(w1.id, e.id);
      const bought = (await repo.listWishes()).find((w: WishRow) => w.id === w1.id)!;
      assert.equal(bought.entry_id, e.id);
      assert.ok(bought.bought_at);
      assert.deepEqual((await repo.getEntries([e.id, "nope", e.id])).map((x: EntryRow) => x.id), [e.id]);
      await repo.softDeleteWish(w2.id);
      assert.equal((await repo.listWishes()).length, 1);
      if (db) assert.equal(db.ops[db.ops.length - 1].op, "delete");
      await repo.restoreWish(w2.id);
      assert.equal((await repo.listWishes()).length, 2);
      await assert.rejects(repo.updateWish("nope", { name: "x" }), (err: unknown) => err instanceof RangeError && err.message === A.AIDS_TEXT.wishGone);
    });

    test(`26. moveWishTo：只在「想買」那組搬（已買的不參與）、整組寫；那筆被刪 ⇒ 回到想買（${impl.name}）`, async () => {
      const { repo, db, cash, lunch } = await setup(impl);
      const ids: string[] = [];
      for (const n of ["d", "c", "b", "a"]) ids.unshift((await repo.createWish({ name: n, amountMinor: null, note: "", categoryId: null })).id);
      // 現在 a b c d；b 買了
      const e = await repo.createEntry(expenseInput(cash.id, lunch.id, "2026-11-01", "b"));
      await repo.setWishBought(ids[1], e.id);
      const mark = db ? db.ops.length : 0;
      await repo.moveWishTo(ids[0], 1); // 想買：a c d ⇒ c a d
      const list = (await repo.listWishes()) as WishRow[];
      const want = list.filter((w) => w.entry_id === null).map((w) => w.name);
      assert.deepEqual(want, ["c", "a", "d"]);
      if (db) {
        const ops = db.ops.slice(mark);
        assert.equal(ops.length, 3, "想買那組三列都寫（#101 整組寫）");
        assert.ok(ops.every((o) => o.tbl === "tk_wishes" && Object.keys(o.cols).sort().join() === "position,updated_at"));
        assert.ok(!ops.some((o) => o.row_id === ids[1]), "已買的不寫");
      }
      await repo.softDeleteEntry(e.id);
      const all = (await repo.listWishes()) as WishRow[];
      const alive: Record<string, EntryRow> = {};
      const v = A.wishView(all, alive);
      assert.equal(v.want.length, 4, "那筆被刪 ⇒ 回到想買");
    });

    test(`27. 常用票種：排最後、外鍵擋已刪帳戶、改名只寫 name、搬到第 k 個整組寫、刪復原（${impl.name}）`, async () => {
      const { repo, db, cash, lunch } = await setup(impl);
      const base = { kind: "expense", amountMinor: 12000, currency: "TWD", accountId: cash.id, toAccountId: null, categoryId: lunch.id, note: "學餐", routeId: null };
      const t1 = await repo.createTemplate({ ...base, name: "午餐" });
      const t2 = await repo.createTemplate({ ...base, name: "晚餐" });
      const t3 = await repo.createTemplate({ ...base, name: "宵夜", amountMinor: null, currency: null, accountId: null, categoryId: null });
      assert.deepEqual((await repo.listTemplates()).map((t: TemplateRow) => t.name), ["午餐", "晚餐", "宵夜"]);
      if (db) assert.deepEqual(Object.keys(db.ops.find((o) => o.row_id === t1.id)!.cols), rustCols("TK_TEMPLATES_COLS"));
      await assert.rejects(repo.createTemplate({ ...base, name: "x", accountId: "a-nope" }), RangeError);
      await assert.rejects(repo.createTemplate({ ...base, name: "  " }), RangeError);
      const mark = db ? db.ops.length : 0;
      await repo.updateTemplate(t2.id, { name: "晚餐" });
      if (db) assert.equal(db.ops.length, mark);
      await repo.updateTemplate(t2.id, { name: "便當" });
      if (db) assert.deepEqual(Object.keys(db.ops[db.ops.length - 1].cols).sort(), ["name", "updated_at"]);
      const m2 = db ? db.ops.length : 0;
      await repo.moveTemplateTo(t3.id, 0);
      assert.deepEqual((await repo.listTemplates()).map((t: TemplateRow) => t.name), ["宵夜", "午餐", "便當"]);
      if (db) assert.equal(db.ops.length - m2, 3);
      await repo.moveTemplateTo(t3.id, 0);
      if (db) assert.equal(db.ops.length - m2, 3, "位置沒變不寫");
      await repo.softDeleteTemplate(t1.id);
      assert.equal((await repo.listTemplates()).length, 2);
      await repo.restoreTemplate(t1.id);
      assert.equal((await repo.listTemplates()).length, 3);
    });

    test(`28. moveAccountTo／moveCategoryTo：群組內／同層搬到第 k 個、整組寫；未分類不動（${impl.name}）`, async () => {
      const { repo, db, cash, food } = await setup(impl);
      const a2 = await repo.createAccount({ name: "零錢", group: "cash", currency: "TWD", openingMinor: null, occurredOn: "2026-11-01" });
      const a3 = await repo.createAccount({ name: "紅包", group: "cash", currency: "TWD", openingMinor: null, occurredOn: "2026-11-01" });
      await repo.createAccount({ name: "銀行", group: "bank", currency: "TWD", openingMinor: null, occurredOn: "2026-11-01" });
      const mark = db ? db.ops.length : 0;
      await repo.moveAccountTo(a3.id, 0);
      assert.deepEqual((await repo.listAccounts()).filter((a: AccountRow) => a.group_key === "cash").map((a: AccountRow) => a.id), [a3.id, cash.id, a2.id]);
      if (db) assert.equal(db.ops.length - mark, 3, "現金群組三列都寫；銀行群組不碰");
      const c2 = await repo.createCategory({ kind: "expense", name: "交通", parentId: null });
      const c3 = await repo.createCategory({ kind: "expense", name: "生活", parentId: null });
      await repo.moveCategoryTo(c3.id, 0);
      const mains = (await repo.listCategories()).filter((c: CategoryRow) => c.kind === "expense" && c.parent_id === null && c.id !== UNCAT_EXPENSE_ID);
      assert.deepEqual(mains.map((c: CategoryRow) => c.id), [c3.id, food.id, c2.id]);
      const m2 = db ? db.ops.length : 0;
      await repo.moveCategoryTo(UNCAT_EXPENSE_ID, 0);
      if (db) assert.equal(db.ops.length, m2);
    });

    test(`29. listNoteUses：還在的帳、備註非空（空白也不算）、精算不算；實體化回記出來的那幾筆（${impl.name}）`, async () => {
      const { repo, cash, lunch } = await setup(impl);
      await repo.createEntry(expenseInput(cash.id, lunch.id, "2026-11-01", "麥味登"));
      await repo.createEntry(expenseInput(cash.id, lunch.id, "2026-11-01", "   "));
      const gone = await repo.createEntry(expenseInput(cash.id, lunch.id, "2026-11-01", "刪掉的"));
      await repo.softDeleteEntry(gone.id);
      await repo.adjustBalance(cash.id, 999, "2026-11-01", "餘額調整"); // 精算的備註是系統寫的，不列
      const uses = (await repo.listNoteUses()) as { note: string; occurred_on: string; kind: string; category_id: string | null }[];
      assert.deepEqual(uses.map((u) => [u.note, u.occurred_on, u.kind, u.category_id]), [["麥味登", "2026-11-01", "expense", lunch.id]]);
      const r = await repo.createRepeat({ kind: "expense", accountId: cash.id, toAccountId: null, categoryId: lunch.id, amountMinor: 100, currency: "TWD", note: "", routeId: null, rule: P.quickRepeatRule(P.quickRepeat("daily", "2026-11-01"), "2026-11-01")!, hhmm: "09:00" });
      const res = await repo.materializeRepeats("2026-11-03", 0);
      assert.deepEqual(res.rows.map((x: { id: string; repeat_id: string }) => x.id).sort(), [P.materializeId(r.id, "2026-11-02"), P.materializeId(r.id, "2026-11-03")].sort());
      assert.ok(res.rows.every((x: { repeat_id: string }) => x.repeat_id === r.id));
      assert.deepEqual((await repo.materializeRepeats("2026-11-03", 0)).rows, []);
    });
  }
});

/* ═════════════════════════ G. ticketStore（替身；ticketRepo＝memory 實作） ═════════════════════════ */

describe("G. ticketStore 售票口④", async () => {
  const repo = new M.MemoryTicketRepository({ seedDemo: false });
  (globalThis as { __tkRepo?: unknown }).__tkRepo = repo;
  const tags = (globalThis as unknown as { __tags: { map: Map<string, string[]>; calls: { type: string; id: string; names: string[] }[]; fail?: boolean } }).__tags ?? { map: new Map(), calls: [] };
  (globalThis as unknown as { __tags: typeof tags }).__tags = tags;
  const { useTicketStore } = await import("../../src/store/ticketStore.ts");
  const st = () => useTicketStore.getState();
  const TODAY = todayKey(0);
  await st().init("desktop");
  await repo.createAccount({ name: "現金", group: "cash", currency: "TWD", openingMinor: null, occurredOn: TODAY });
  const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: null });
  await st().refresh();
  const cashId = st().accounts[0].id;
  const lastToast = (): string => {
    const ts = toastsOf();
    return ts.length ? ts[ts.length - 1].message : "";
  };

  test("30. openNew 的預設：沒荷札、不重複、沒有願望／常用票種；setDraftRepeat 從記帳日帶", () => {
    st().openNew({ dayKey: "2026-11-05" });
    const d = st().draft!;
    assert.deepEqual([d.tags, d.repeat.freq, d.wishId, d.fromTemplateId], [[], "none", null, null]);
    st().setDraftRepeat("weekly");
    assert.deepEqual(st().draft!.repeat, { freq: "weekly", weekday: 4, monthday: 5, until: null });
    st().setDraft({ dayKey: "2026-11-06" });
    assert.equal(st().draft!.repeat.weekday, 5, "改日期 ⇒ 星期幾跟著走");
    st().closePanel();
  });

  test("31. saveDraft：建帳 → 荷札 → 規則（下一班起、掛同一組荷札、連上這筆）→ 願望標成已買；toast 帶定期", async () => {
    const wish = (await st().createWish({ name: "便當盒", amountText: "350", tags: ["#廚房"] }))!;
    assert.ok(wish);
    assert.deepEqual(tags.calls.at(-1), { type: "ticket:wish", id: wish.id, names: ["廚房"] });
    st().openNew();
    st().setDraft({ amountText: "120", categoryId: lunch.id, note: "便當盒", tags: ["#午餐", "外帶"], wishId: wish.id });
    st().setDraftRepeat("monthly");
    const ok = await st().saveDraft({ again: false });
    assert.equal(ok, true);
    const entryId = st().selectedId!;
    const e = (await repo.getEntry(entryId))!;
    assert.ok(e.repeat_id, "這筆連上規則");
    const rep = st().repeats.find((r) => r.id === e.repeat_id)!;
    const rule = P.parseFixedRule(rep.rule)!;
    assert.equal(rule.start, addDays(TODAY, 1), "起算＝下一班");
    assert.deepEqual(rule.bymonthday, [parseInt(TODAY.slice(8, 10), 10)]);
    assert.deepEqual(tags.map.get(`ticket:entry|${entryId}`), ["午餐", "外帶"]);
    assert.deepEqual(tags.map.get(`ticket:repeat|${rep.id}`), ["午餐", "外帶"]);
    assert.equal(st().wish.bought.some((b) => b.wish.id === wish.id && b.entry.id === entryId), true, "願望移到已買");
    assert.match(lastToast(), /定期：每月 \d+ 日 · 已移到「已買」$/);
    // 那筆被刪 ⇒ 願望回到想買
    await st().deleteEntry(entryId);
    assert.equal(st().wish.want.some((w) => w.id === wish.id), true);
  });

  test("32. saveDraft：荷札名稱不合法 ⇒ 整筆不寫；規則不合法（結束日早於起算）⇒ 整筆不寫", async () => {
    const before = (await repo.listEntries("2000-01-01", "2100-01-01", null)).length;
    st().openNew();
    st().setDraft({ amountText: "80", categoryId: lunch.id, tags: ["好 的"] });
    assert.equal(await st().saveDraft({ again: false }), false);
    st().setDraft({ tags: [], repeat: { ...P.quickRepeat("daily", TODAY), until: TODAY } });
    assert.equal(await st().saveDraft({ again: false }), false);
    assert.equal((await repo.listEntries("2000-01-01", "2100-01-01", null)).length, before);
    st().closePanel();
  });

  test("33. 存並再記：清金額、備註、荷札、定期、願望；留類型、帳戶、分類、日期", async () => {
    st().openNew();
    st().setDraft({ amountText: "50", categoryId: lunch.id, note: "飲料", tags: ["手搖"] });
    st().setDraftRepeat("weekly");
    assert.equal(await st().saveDraft({ again: true }), true);
    const d = st().draft!;
    assert.deepEqual([d.amountText, d.note, d.tags, d.repeat.freq, d.wishId, d.categoryId, d.accountId], ["", "", [], "none", null, lunch.id, cashId]);
    st().closePanel();
  });

  test("34. 實體化：記出來的每一筆帶規則的荷札（規則沒掛就不寫）", async () => {
    const rep = await repo.createRepeat({
      kind: "expense", accountId: cashId, toAccountId: null, categoryId: lunch.id, amountMinor: 3000, currency: "TWD", note: "捷運", routeId: null,
      rule: P.quickRepeatRule(P.quickRepeat("daily", addDays(TODAY, -3)), addDays(TODAY, -3))!, hhmm: "08:00",
    });
    tags.map.set(`ticket:repeat|${rep.id}`, ["通勤"]);
    const n0 = tags.calls.length;
    await st().materialize("manual");
    const carried = tags.calls.slice(n0).filter((c) => c.type === "ticket:entry");
    assert.deepEqual(carried.map((c) => c.id).sort(), [-2, -1, 0].map((d) => P.materializeId(rep.id, addDays(TODAY, d))).sort());
    assert.ok(carried.every((c) => c.names.join() === "通勤"));
    // 今日頁：今天由規則記出來、還在的帳
    const todays = await st().repeatEntriesOn(TODAY);
    assert.ok(todays.some((e) => e.id === P.materializeId(rep.id, TODAY)));
    assert.ok(todays.every((e) => P.isRepeatMade(e)));
    assert.ok(st().entriesVersion > 0);
  });

  test("35. setEntryRepeatQuick：沒連規則的帳直接建規則（下一班起、帶這筆的荷札）；已連 ⇒ false", async () => {
    const e = await repo.createEntry(expenseInput(cashId, lunch.id, TODAY, "房租", 1200000) as never);
    tags.map.set(`ticket:entry|${e.id}`, ["家"]);
    await st().refresh();
    assert.equal(await st().setEntryRepeatQuick(e.id, P.quickRepeat("monthly", TODAY)), true);
    const linked = (await repo.getEntry(e.id))!;
    assert.ok(linked.repeat_id);
    assert.deepEqual(tags.map.get(`ticket:repeat|${linked.repeat_id}`), ["家"]);
    assert.equal(P.parseFixedRule(st().repeats.find((r) => r.id === linked.repeat_id)!.rule)!.start, addDays(TODAY, 1));
    assert.equal(await st().setEntryRepeatQuick(e.id, P.quickRepeat("weekly", TODAY)), false);
  });

  test("36. 備註記憶：懶載、存檔後重載；lastCategoryForNote 只回可用的分類", async () => {
    assert.equal(st().noteRecall, null);
    await st().loadNoteRecall();
    assert.ok(st().noteRecall!.some((x) => x.text === "房租"));
    assert.equal(st().lastCategoryForNote("expense", "房租"), lunch.id);
    assert.equal(st().lastCategoryForNote("income", "房租"), null);
    st().openNew();
    st().setDraft({ amountText: "60", categoryId: lunch.id, note: "全新備註" });
    await st().saveDraft({ again: false });
    await new Promise((r) => setTimeout(r, 0));
    await st().loadNoteRecall();
    assert.ok(st().noteRecall!.some((x) => x.text === "全新備註"), "存檔後作廢、背景重載");
  });

  test("37. 常用票種：存成常用（帶荷札）→ 點了整張填進草稿（含荷札）；改名、搬、刪復原", async () => {
    const e = (await repo.listEntries(TODAY, addDays(TODAY, 1), null)).find((x) => x.note === "房租")!;
    const t = (await st().saveTemplateFromEntry(e.id, "房租"))!;
    assert.ok(t);
    assert.deepEqual(tags.map.get(`ticket:template|${t.id}`), ["家"]);
    assert.equal(lastToast(), "已存成常用「房租」");
    st().openNew();
    await st().applyTemplate(t.id);
    const d = st().draft!;
    assert.deepEqual([d.amountText, d.categoryId, d.note, d.accountId, d.fromTemplateId, d.tags], ["12000", lunch.id, "房租", cashId, t.id, ["家"]]);
    st().closePanel();
    await st().renameTemplate(t.id, "每月房租");
    assert.equal(st().templates.find((x) => x.id === t.id)!.name, "每月房租");
    await st().deleteTemplate(t.id);
    assert.equal(st().templates.length, 0);
    toastsOf().at(-1)!.onAction!();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(st().templates.length, 1, "復原");
  });

  test("預算刪除可復原（失物招領 §5-1）：預設連同月覆寫一起回來；單月覆寫也能復原", async () => {
    const total = { kind: "total" } as const;
    const totals = () => st().budgets.filter((b) => b.category_id === null);
    assert.ok(await st().setBudget(total, null, "500"));
    assert.ok(await st().setBudget(total, "2026-11", "900"));
    await st().removeBudget(total, null);
    assert.equal(lastToast(), "已刪除這個預算");
    assert.equal(totals().length, 0);
    toastsOf().at(-1)!.onAction!();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(totals().length, 2, "預設與覆寫都回來");
    await st().removeBudget(total, "2026-11");
    assert.equal(totals().length, 1);
    toastsOf().at(-1)!.onAction!();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(totals().length, 2);
    await st().removeBudget(total, null); // 收乾淨：後面的測試不看預算
  });

  test("38. buyWish：開記一筆（支出、金額、備註＝名稱、分類、願望的荷札、wishId）", async () => {
    const w = (await st().createWish({ name: "行動電源", amountText: "990", categoryId: lunch.id, tags: ["3C"] }))!;
    await st().buyWish(w.id);
    const d = st().draft!;
    assert.deepEqual([d.kind, d.amountText, d.note, d.categoryId, d.tags, d.wishId], ["expense", "990", "行動電源", lunch.id, ["3C"], w.id]);
    st().closePanel();
    await st().deleteWish(w.id);
    assert.ok(!st().wishes.some((x) => x.id === w.id));
  });

  test("39. 捕捉框：一行的 #荷札 掛上、不進備註", async () => {
    const res = await st().addQuickEntry({ body: "45 午餐 和同學 #聚餐 #fff", dayKey: TODAY, routeId: null } as never);
    assert.ok(res.toast);
    const last = (await repo.listEntries(TODAY, addDays(TODAY, 1), null)).find((x) => x.note.includes("和同學"))!;
    assert.equal(last.note, "和同學 #fff");
    assert.deepEqual(tags.map.get(`ticket:entry|${last.id}`), ["聚餐"]);
  });

  const countAll = async () => (await repo.listEntries("2000-01-01", "2100-01-01", null)).length;

  test("40. saveDraft：帳寫進去之後願望那步失敗（存之前願望被刪）⇒ 照成功收（草稿清掉），不會再按一次多記一筆", async () => {
    const w = (await st().createWish({ name: "耳機", amountText: "300" }))!;
    await st().buyWish(w.id);
    await repo.softDeleteWish(w.id); // 另一台刪了、同步進來
    const n0 = await countAll();
    assert.equal(await st().saveDraft({ again: false }), true);
    assert.equal(await countAll(), n0 + 1);
    assert.equal(st().draft, null, "草稿已清");
    assert.equal(lastToast(), "帳已經記好了，但願望沒移到「已買」（可能已經刪了）");
  });

  test("41. saveDraft：規則那步失敗 ⇒ 帳照記、草稿清掉、不留沒連上的規則；toast 說定期沒設上", async () => {
    const orig = repo.createRepeat.bind(repo);
    const origLink = repo.linkEntryToRepeat.bind(repo);
    const n0 = await countAll();
    const r0 = (await repo.listRepeats()).length;
    try {
      (repo as { linkEntryToRepeat: unknown }).linkEntryToRepeat = async () => {
        throw new Error("連不上");
      };
      st().openNew();
      st().setDraft({ amountText: "60", categoryId: lunch.id, note: "早餐" });
      st().setDraftRepeat("daily");
      assert.equal(await st().saveDraft({ again: false }), true);
      assert.equal(await countAll(), n0 + 1);
      assert.equal(st().draft, null);
      assert.equal((await repo.listRepeats()).length, r0, "建了沒連上的規則已收回");
      assert.equal(lastToast(), "定期沒設上——帳已經記好了，可以在詳情再設一次");
    } finally {
      (repo as { createRepeat: unknown }).createRepeat = orig;
      (repo as { linkEntryToRepeat: unknown }).linkEntryToRepeat = origLink;
    }
  });

  /* ── 代驗修正（2026-11-03）：G1 規則編輯器的荷札、O5 今日頁跳到那筆定期帳 ── */
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("42. openRepeatEditor 的荷札草稿：全新＝空（立刻有）；改既有規則＝它掛的；從帳「設成定期…」＝那筆帳的；關掉後晚到的不寫回", async () => {
    st().openRepeatEditor(null);
    assert.deepEqual(st().repeatTags, { names: [], orig: [] });
    st().closeRepeatEditor();
    const rep = st().repeats.find((r) => tags.map.get(`ticket:repeat|${r.id}`)?.join() === "通勤")!;
    st().openRepeatEditor(rep.id);
    assert.equal(st().repeatTags, null, "讀回來之前是 null（荷札列不畫）");
    await tick();
    assert.deepEqual(st().repeatTags, { names: ["通勤"], orig: ["通勤"] });
    st().closeRepeatEditor();
    assert.equal(st().repeatTags, null);
    const e = await repo.createEntry(expenseInput(cashId, lunch.id, TODAY, "健身房", 99000) as never);
    tags.map.set(`ticket:entry|${e.id}`, ["健康", "固定"]);
    await st().refresh();
    st().makeRepeatFromEntry(e.id);
    await tick();
    assert.deepEqual(st().repeatTags!.names, ["健康", "固定"]);
    st().closeRepeatEditor();
    st().openRepeatEditor(rep.id);
    st().closeRepeatEditor(); // 讀的途中就關了
    await tick();
    assert.equal(st().repeatTags, null, "晚到的結果丟掉");
  });

  test("43. saveRepeatDraft 的荷札：新規則掛了就寫、在補記之前（補記的帶）；改既有規則只在改過時寫、已記的帳不追溯；名稱不合法整條不寫", async () => {
    // 新規則：起算在過去 ⇒ 存了當場補記，補記的每一筆帶這組荷札
    st().openRepeatEditor(null);
    st().setRepeatDraft({ amountText: "45", categoryId: lunch.id, note: "公車", freq: "daily", start: addDays(TODAY, -1) });
    st().setRepeatTags(["交通", "#通勤/公車"]);
    assert.equal(await st().saveRepeatDraft(), true);
    const rep = st().repeats.find((r) => r.note === "公車")!;
    assert.deepEqual(tags.map.get(`ticket:repeat|${rep.id}`), ["交通", "通勤/公車"]);
    for (const d of [-1, 0]) assert.deepEqual(tags.map.get(`ticket:entry|${P.materializeId(rep.id, addDays(TODAY, d))}`), ["交通", "通勤/公車"]);
    // 改既有規則：沒動荷札 ⇒ 不寫
    st().openRepeatEditor(rep.id);
    await tick();
    st().setRepeatDraft({ note: "公車月票" });
    let n0 = tags.calls.length;
    assert.equal(await st().saveRepeatDraft(), true);
    assert.equal(tags.calls.slice(n0).filter((c) => c.type === "ticket:repeat").length, 0);
    // 改了荷札 ⇒ 規則換成新的；已經記出來的帳不動
    st().openRepeatEditor(rep.id);
    await tick();
    st().setRepeatTags(["交通"]);
    n0 = tags.calls.length;
    assert.equal(await st().saveRepeatDraft(), true);
    assert.deepEqual(tags.map.get(`ticket:repeat|${rep.id}`), ["交通"]);
    assert.equal(tags.calls.slice(n0).filter((c) => c.type === "ticket:entry").length, 0, "已記的帳不追溯");
    assert.deepEqual(tags.map.get(`ticket:entry|${P.materializeId(rep.id, TODAY)}`), ["交通", "通勤/公車"]);
    // 名稱不合法 ⇒ 整條不寫、留在編輯器
    st().openRepeatEditor(null);
    st().setRepeatDraft({ amountText: "30", categoryId: lunch.id, note: "壞荷札" });
    st().setRepeatTags(["好 的"]);
    const r0 = (await repo.listRepeats()).length;
    assert.equal(await st().saveRepeatDraft(), false);
    assert.equal((await repo.listRepeats()).length, r0);
    assert.equal(st().dialog?.kind, "repeat");
    st().closeRepeatEditor();
  });

  test("44. 從帳「設成定期…」開編輯器、荷札還沒讀回來就存 ⇒ 存的時候讀那筆帳的荷札掛上（同 setEntryRepeatQuick）", async () => {
    const e = await repo.createEntry(expenseInput(cashId, lunch.id, TODAY, "保險", 300000) as never);
    tags.map.set(`ticket:entry|${e.id}`, ["保險"]);
    await st().refresh();
    st().makeRepeatFromEntry(e.id);
    assert.equal(st().repeatTags, null);
    assert.equal(await st().saveRepeatDraft(), true);
    const linked = (await repo.getEntry(e.id))!;
    assert.deepEqual(tags.map.get(`ticket:repeat|${linked.repeat_id}`), ["保險"]);
  });

  test("45. jumpToRepeatDay：選中並攤開那天第一筆定期帳（不是那天第一列）；那天沒有定期帳 ⇒ 同 jumpToDay", async () => {
    const day = addDays(TODAY, -12);
    const manual = await repo.createEntry({ ...expenseInput(cashId, lunch.id, day, "晚餐"), occurredAt: atOf(day, "21:00", 0) } as never);
    const rule = R.fixedRule("monthly", day, { byweekday: [], bymonthday: [parseInt(day.slice(8, 10), 10)] });
    rule.until = day; // 只有那一天一班
    const rep = await repo.createRepeat({
      kind: "expense", accountId: cashId, toAccountId: null, categoryId: lunch.id, amountMinor: 50000, currency: "TWD", note: "月費", routeId: null,
      rule, hhmm: "07:00",
    });
    await st().materialize("manual");
    const made = P.materializeId(rep.id, day);
    assert.equal((await repo.listEntries(day, addDays(day, 1), null))[0].id, manual.id, "那天第一列是手記的那筆");
    await st().jumpToRepeatDay(day);
    assert.equal(st().selectedId, made);
    assert.deepEqual(st().panel, { kind: "entry", id: made });
    await st().deleteEntry(made);
    await st().jumpToRepeatDay(day);
    assert.equal(st().selectedId, manual.id, "沒有定期帳 ⇒ 那天第一列（jumpToDay）");
  });
});

describe("H. EntityTagField 的選中列（代驗 P1：空著、沒動過 ⇒ Enter 不攔）", async () => {
  const K = await import("../../src/ui/common/entityTagKeys.ts");
  test("46. hasPick／enterAction：空字沒動過＝pass；打了字＝pick（有列）或 typed（沒列）；↑↓ 動過才 pick", () => {
    assert.equal(K.hasPick("", false), false);
    assert.equal(K.hasPick("  ", false), false);
    assert.equal(K.hasPick("京", false), true);
    assert.equal(K.hasPick("", true), true);
    assert.equal(K.enterAction("", false, 5), "pass", "空著按 Enter 不掛第一個建議");
    assert.equal(K.enterAction(" ", false, 5), "pass");
    assert.equal(K.enterAction("", true, 5), "pick", "用 ↓ 選了才掛");
    assert.equal(K.enterAction("", true, 0), "pass");
    assert.equal(K.enterAction("京都", false, 2), "pick");
    assert.equal(K.enterAction("新荷札", false, 0), "typed");
  });
  test("47. arrowAct：還沒有選中列 ⇒ ↓ 第一列、↑ 最後一列；有 ⇒ 循環；沒列 ⇒ 0", () => {
    assert.equal(K.arrowAct(0, 1, 4, false), 0);
    assert.equal(K.arrowAct(0, -1, 4, false), 3);
    assert.equal(K.arrowAct(0, 1, 4, true), 1);
    assert.equal(K.arrowAct(3, 1, 4, true), 0);
    assert.equal(K.arrowAct(0, -1, 4, true), 3);
    assert.equal(K.arrowAct(0, 1, 0, false), 0);
  });
});

/** toast 清單（FAKE_UI 把自己掛在 globalThis.__uiStoreRef） */
function toastsOf(): { message: string; onAction?: () => void }[] {
  return (globalThis as unknown as { __uiStoreRef?: { getState(): { toasts: { message: string; onAction?: () => void }[] } } }).__uiStoreRef?.getState().toasts ?? [];
}
