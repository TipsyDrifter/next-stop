/**
 * 售票口線・純函式單元測試（車次①契約 §4.8；甲席）。
 * 跑法：`node --test scripts/tests/ticket-logic.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 放 `scripts/` 而不是 `src/`：tsconfig 的 include 只有 src，不會去找 node:test 的型別。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻，不寫 UTC 字面值。
 * fixture dump 的名稱用樣本格式文件已公開的帳戶／分類名，金額一律合成。
 *
 * Stage 0（甲席）：A～K 共 50 條。Stage 1 補 17b／17c：repository 層（memory 與 sqlite 兩個實作）——
 * 用 `module.registerHooks` 把 `src/` 裡沒寫副檔名的相對 import 補上 `.ts`，並把 `../lib/db`、`./syncRepository`、
 * `@tauri-apps/api/core` 換成測試替身（data: URL）；sqlite 實作跑在 `node:sqlite` 記憶體 DB 上（套真的 0007 DDL、
 * 開外鍵），`runWriteBatch` 替身＝一個交易逐句執行＋把 op 收進陣列，讓測試看得到 op 的 cols。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/* ───────── repository 層的載入替身（17b／17c 用；只影響 src/ 底下的 import） ───────── */

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
  CURRENCY_TWD_ID,
  MAX_MINOR,
  STARTER_CATEGORIES,
  STARTER_CURRENCY,
  TICKET_ID_NAMESPACE,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  accountTotals,
  addMonths,
  applyEntryPatch,
  atOf,
  balancesOf,
  buildEntryRow,
  catKey,
  categoryLabel,
  categoryTree,
  convertMinor,
  currencyCode,
  dayLabel,
  daySubtotalText,
  defaultAccountId,
  defaultChoices,
  deriveAmounts,
  draftToInput,
  groupByDay,
  importRate,
  matchAccount,
  matchCategories,
  materializeImport,
  minorFromDecimal,
  missingText,
  mmSummary,
  moneyText,
  monthRange,
  monthSum,
  monthTitle,
  parseAmount,
  parseQuickEntry,
  parseRate,
  planAdjust,
  planImport,
  quickToast,
  rowAmount,
  serialOf,
  solveAdjustSigns,
  ticketId,
  uuidV5,
  type AccountRow,
  type CategoryKind,
  type CategoryRow,
  type CurrencyRow,
  type EntryCtx,
  type EntryDraft,
  type EntryRow,
  type ImportLocal,
  type MmbakDump,
  type MmTx,
  type NewEntryInput,
  type QuickCtx,
} from "../../src/domain/ticket.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const NOW = new Date(2026, 9, 12, 9, 0).toISOString();

/* ───────── 小工具 ───────── */

const SYNC = { device_id: null, created_at: NOW, updated_at: NOW, synced_at: null, deleted_at: null };

function cur(code: string, decimals: number, rate: string, isMain = false): CurrencyRow {
  return { id: ticketId("currency:" + code), code, name: code, decimals, rate_to_main: rate, is_main: isMain ? 1 : 0, position: 0, ...SYNC };
}
function acc(id: string, name: string, group: string, currency = "TWD", extra: Partial<AccountRow> = {}): AccountRow {
  return { id, name, group_key: group, currency, position: 0, archived_at: null, ...SYNC, ...extra };
}
function cat(id: string, kind: CategoryKind, name: string, parent: string | null, position: number, extra: Partial<CategoryRow> = {}): CategoryRow {
  return { id, kind, name, parent_id: parent, position, archived_at: null, ...SYNC, ...extra };
}
function byId<T extends { id: string }>(rows: T[]): Record<string, T> {
  const o: Record<string, T> = {};
  for (const r of rows) o[r.id] = r;
  return o;
}
function byCode(rows: CurrencyRow[]): Record<string, CurrencyRow> {
  const o: Record<string, CurrencyRow> = {};
  for (const r of rows) o[r.code] = r;
  return o;
}
const throwsMsg = (fn: () => unknown, msg: string) =>
  assert.throws(fn, (e: unknown) => e instanceof RangeError && e.message === msg, `應丟「${msg}」`);

const TWD = cur("TWD", 2, "1", true);
const USD = cur("USD", 2, "31.549671");
const JPY = cur("JPY", 0, "0.2");

/** 分類樹（樣本格式 §四的形狀，取一部分）；id＝"c:" + 名稱 */
function demoCats(): CategoryRow[] {
  const out: CategoryRow[] = [
    cat(UNCAT_INCOME_ID, "income", "未分類", null, 9999),
    cat(UNCAT_EXPENSE_ID, "expense", "未分類", null, 9999),
  ];
  ["💵 生活費", "💴 補貼", "💳 薪水"].forEach((n, i) => out.push(cat("c:" + n, "income", n, null, i)));
  const tree: [string, string[]][] = [
    ["🍜 食物", ["早餐", "午餐", "晚餐", "宵夜", "點心", "飲料"]],
    ["🚖 交通", ["公車", "捷運"]],
    ["🪑 生活", ["房租", "食材", "食物券"]],
    ["📙 教育", ["學費", "書籍？"]],
    ["🖼 文化", ["書籍", "電影"]],
    ["👬🏻 社交", ["聚餐", "🎁 禮物"]],
    ["🧘🏼 健康", ["運動"]],
  ];
  tree.forEach(([p, kids], i) => {
    out.push(cat("c:" + p, "expense", p, null, i));
    kids.forEach((k, j) => out.push(cat(`c:${p}/${k}`, "expense", k, "c:" + p, j)));
  });
  return out;
}

function ctxOf(accounts: AccountRow[], cats: CategoryRow[] = demoCats(), curs: CurrencyRow[] = [TWD, USD]): EntryCtx {
  return { accById: byId(accounts), catById: byId(cats), curByCode: byCode(curs) };
}

const CASH = acc("acc-cash", "現金", "cash");
const BANK = acc("acc-bank", "帳戶", "bank");
const STUDENT = acc("acc-student", "學生證", "bank");
const USDACC = acc("acc-usd", "美金帳", "bank", "USD");

function input(p: Partial<NewEntryInput>): NewEntryInput {
  return {
    kind: "expense",
    amountMinor: 8000,
    currency: "TWD",
    accountId: CASH.id,
    toAccountId: null,
    categoryId: null,
    occurredOn: "2026-10-08",
    occurredAt: new Date(2026, 9, 8, 12, 0).toISOString(),
    note: "",
    routeId: null,
    ...p,
  };
}

function entry(p: Partial<EntryRow> & { id: string }): EntryRow {
  return {
    kind: "expense",
    occurred_on: "2026-10-08",
    occurred_at: new Date(2026, 9, 8, 12, 0).toISOString(),
    account_id: CASH.id,
    to_account_id: null,
    category_id: null,
    amount_minor: 0,
    currency: "TWD",
    main_minor: 0,
    account_minor: 0,
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

/* ═════════════════════════ A. id ═════════════════════════ */

describe("A. id", () => {
  const v5 = (ns: string, name: string): string => {
    const h = createHash("sha1")
      .update(Buffer.concat([Buffer.from(ns.replace(/-/g, ""), "hex"), Buffer.from(name, "utf8")]))
      .digest();
    const b = Buffer.from(h.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    const s = b.toString("hex");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };

  test("1. uuidV5 對 node:crypto 版 v5：200 個名字（含中文、emoji、空字串、長字串）全同", () => {
    const names = ["", "中文", "🍜 食物", "👬🏻 社交", "a".repeat(200), "moneymanager:transfer:abc"];
    for (let i = 0; names.length < 200; i++) names.push(`名字-${i}-${String.fromCodePoint(0x1f300 + (i % 80))}-${"x".repeat(i % 70)}`);
    for (const n of names) {
      assert.equal(uuidV5(TICKET_ID_NAMESPACE, n), v5(TICKET_ID_NAMESPACE, n), n);
      assert.equal(uuidV5(DNS, n), v5(DNS, n), n);
    }
  });

  test("2. TICKET_ID_NAMESPACE＝v5(DNS, 'ticket.nextstop.shitetsu.app')；RFC 範例", () => {
    assert.equal(uuidV5(DNS, "ticket.nextstop.shitetsu.app"), TICKET_ID_NAMESPACE);
    assert.equal(uuidV5(DNS, "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  test("3. 起手三個 id＝ticketId('currency:TWD')／('uncategorized:income')／('uncategorized:expense')", () => {
    assert.equal(CURRENCY_TWD_ID, ticketId("currency:TWD"));
    assert.equal(UNCAT_INCOME_ID, ticketId("uncategorized:income"));
    assert.equal(UNCAT_EXPENSE_ID, ticketId("uncategorized:expense"));
    assert.equal(ticketId("currency:USD"), "710fa7fb-b403-500a-9a74-514275c49dee");
    assert.equal(ticketId("currency:CNY"), "79529a2a-5d86-56b1-9342-f378f81c6770");
  });

  test("4. ticket.rs 的 alive_filter 含起手三列的 id（0-16）", () => {
    const rs = readFileSync(path.join(ROOT, "src-tauri/src/sync/tables/ticket.rs"), "utf8");
    const c = rs.match(/const TK_CURRENCIES_ALIVE[\s\S]*?;/);
    const k = rs.match(/const TK_CATEGORIES_ALIVE[\s\S]*?;/);
    assert.ok(c && k, "ticket.rs 沒有兩個 alive 常數");
    assert.ok(c[0].includes(`'${CURRENCY_TWD_ID}'`));
    assert.ok(k[0].includes(`'${UNCAT_INCOME_ID}'`));
    assert.ok(k[0].includes(`'${UNCAT_EXPENSE_ID}'`));
  });

  test("5. STARTER_CURRENCY／STARTER_CATEGORIES 欄值＝§3.3 表", () => {
    assert.deepEqual({ ...STARTER_CURRENCY }, {
      id: CURRENCY_TWD_ID, code: "TWD", name: "新台幣", decimals: 2, rate_to_main: "1", is_main: 1, position: 0,
    });
    assert.deepEqual(
      STARTER_CATEGORIES.map((c) => ({ ...c })),
      [
        { id: UNCAT_INCOME_ID, kind: "income", name: "未分類", parent_id: null, position: 9999 },
        { id: UNCAT_EXPENSE_ID, kind: "expense", name: "未分類", parent_id: null, position: 9999 },
      ],
    );
  });
});

/* ═════════════════════════ B. 金額解析 ═════════════════════════ */

describe("B. 金額解析", () => {
  const T = { code: "TWD", decimals: 2 };
  test("6. parseAmount", () => {
    assert.equal(parseAmount("80", T, { allowNegative: false }), 8000);
    assert.equal(parseAmount("1,234.5", T, { allowNegative: false }), 123450);
    assert.equal(parseAmount("８０", T, { allowNegative: false }), 8000);
    throwsMsg(() => parseAmount("12.345", T, { allowNegative: false }), "TWD 最多 2 位小數");
    throwsMsg(() => parseAmount("", T, { allowNegative: false }), "先填金額");
    throwsMsg(() => parseAmount("abc", T, { allowNegative: false }), "金額要是數字，例如 80 或 12.5");
    throwsMsg(() => parseAmount("0", T, { allowNegative: false }), "金額不能是 0");
    throwsMsg(() => parseAmount("-5", T, { allowNegative: false }), "收入和轉帳的金額要是正的");
    assert.equal(parseAmount("-5", T, { allowNegative: true }), -500);
    throwsMsg(() => parseAmount("1.5", { code: "JPY", decimals: 0 }, { allowNegative: false }), "JPY 不收小數");
    throwsMsg(() => parseAmount("99999999999999999", T, { allowNegative: false }), "金額太大了");
  });

  test("7. minorFromDecimal(round)：絕對值半進位", () => {
    assert.equal(minorFromDecimal("120.0", 2, "round"), 12000);
    assert.equal(minorFromDecimal("1.005", 2, "round"), 101);
    assert.equal(minorFromDecimal("-1.005", 2, "round"), -101);
    assert.equal(minorFromDecimal("31.549671", 2, "round"), 3155);
  });

  test("8. parseRate", () => {
    assert.equal(parseRate("31.549671"), "31.549671");
    assert.equal(parseRate("4.350"), "4.35");
    assert.equal(parseRate("031"), "31");
    assert.equal(parseRate("1.0"), "1");
    for (const bad of ["0", "-1", "abc", "0.000"]) throwsMsg(() => parseRate(bad), "匯率要是大於 0 的數字");
  });

  test("9. currencyCode", () => {
    assert.equal(currencyCode(" usd "), "USD");
    throwsMsg(() => currencyCode("US"), "幣別代碼要是三個英文字母");
  });
});

/* ═════════════════════════ C. 換算 ═════════════════════════ */

describe("C. 換算", () => {
  test("10. convertMinor：USD↔TWD、JPY（0 位）、半進位遠離零", () => {
    assert.equal(convertMinor(1000, USD, TWD), 31550);
    assert.equal(convertMinor(31550, TWD, USD), 1000);
    assert.equal(convertMinor(1000, JPY, TWD), 20000);
    const HALF = { decimals: 2, rate_to_main: "0.5" };
    assert.equal(convertMinor(1, HALF, TWD), 1); // 0.5 分 ⇒ 1
    assert.equal(convertMinor(-1, HALF, TWD), -1); // −0.5 分 ⇒ −1
    assert.equal(convertMinor(1234, TWD, TWD), 1234);
  });
});

/* ═════════════════════════ D. deriveAmounts ═════════════════════════ */

describe("D. deriveAmounts", () => {
  const curByCode = byCode([TWD, USD]);
  test("11. 同幣別", () => {
    assert.deepEqual(deriveAmounts({ kind: "expense", amountMinor: 8000, currency: "TWD", account: CASH, toAccount: null, curByCode }), {
      main_minor: 8000, account_minor: 8000, to_amount_minor: null,
    });
  });
  test("12. TWD 帳戶記 USD ⇒ account_minor === main_minor", () => {
    const r = deriveAmounts({ kind: "expense", amountMinor: 1000, currency: "USD", account: CASH, toAccount: null, curByCode });
    assert.equal(r.main_minor, 31550);
    assert.equal(r.account_minor, 31550);
  });
  test("13. USD 帳戶記 USD ⇒ account_minor＝原額、main_minor 換算", () => {
    const r = deriveAmounts({ kind: "expense", amountMinor: 1000, currency: "USD", account: USDACC, toAccount: null, curByCode });
    assert.equal(r.account_minor, 1000);
    assert.equal(r.main_minor, 31550);
  });
  test("14. USD 帳戶記 TWD ⇒ main_minor＝原額、account_minor 換算", () => {
    const r = deriveAmounts({ kind: "expense", amountMinor: 31550, currency: "TWD", account: USDACC, toAccount: null, curByCode });
    assert.equal(r.main_minor, 31550);
    assert.equal(r.account_minor, 1000);
  });
  test("15. override 生效", () => {
    const a = deriveAmounts({ kind: "expense", amountMinor: 1000, currency: "USD", account: CASH, toAccount: null, curByCode, override: { mainMinor: 32000 } });
    assert.equal(a.main_minor, 32000);
    assert.equal(a.account_minor, 32000);
    const b = deriveAmounts({ kind: "expense", amountMinor: 31550, currency: "TWD", account: USDACC, toAccount: null, curByCode, override: { accountMinor: 999 } });
    assert.equal(b.account_minor, 999);
  });
  test("16. 轉帳：同幣別 to＝原額、異幣別換算、幣別不是轉出帳戶的 ⇒ RangeError", () => {
    assert.equal(deriveAmounts({ kind: "transfer", amountMinor: 50000, currency: "TWD", account: CASH, toAccount: STUDENT, curByCode }).to_amount_minor, 50000);
    assert.equal(deriveAmounts({ kind: "transfer", amountMinor: 31550, currency: "TWD", account: CASH, toAccount: USDACC, curByCode }).to_amount_minor, 1000);
    assert.equal(
      deriveAmounts({ kind: "transfer", amountMinor: 31550, currency: "TWD", account: CASH, toAccount: USDACC, curByCode, override: { toAmountMinor: 990 } }).to_amount_minor,
      990,
    );
    throwsMsg(() => deriveAmounts({ kind: "transfer", amountMinor: 1000, currency: "USD", account: CASH, toAccount: STUDENT, curByCode }), "轉帳的幣別跟著轉出帳戶");
  });
});

/* ═════════════════════════ E. 推導與驗證 ═════════════════════════ */

describe("E. 推導與驗證", () => {
  const ctx = ctxOf([CASH, BANK, STUDENT, USDACC]);
  const meta = { id: "e-1", nowIso: NOW };

  test("17. buildEntryRow：收支無分類 ⇒ 未分類；§4.3 錯誤表（domain 層）逐字", () => {
    const inc = buildEntryRow(input({ kind: "income", amountMinor: 200000 }), ctx, meta);
    assert.equal(inc.category_id, UNCAT_INCOME_ID);
    assert.equal(buildEntryRow(input({}), ctx, meta).category_id, UNCAT_EXPENSE_ID);
    const ok = buildEntryRow(input({ categoryId: "c:🍜 食物/午餐" }), ctx, meta);
    assert.equal(ok.created_at, NOW);
    assert.equal(ok.import_id, null);
    throwsMsg(() => buildEntryRow(input({ amountMinor: 0 }), ctx, meta), "金額不能是 0");
    throwsMsg(() => buildEntryRow(input({ amountMinor: MAX_MINOR + 1 }), ctx, meta), "金額太大了");
    throwsMsg(() => buildEntryRow(input({ kind: "income", amountMinor: -1 }), ctx, meta), "收入和轉帳的金額要是正的");
    throwsMsg(() => buildEntryRow(input({ accountId: "" }), ctx, meta), "選一個帳戶");
    throwsMsg(() => buildEntryRow(input({ accountId: "nope" }), ctx, meta), "這個帳戶已經不在了");
    throwsMsg(() => buildEntryRow(input({ kind: "transfer" }), ctx, meta), "選一個轉入帳戶");
    throwsMsg(() => buildEntryRow(input({ kind: "transfer", toAccountId: CASH.id }), ctx, meta), "轉出和轉入不能是同一個帳戶");
    throwsMsg(() => buildEntryRow(input({ kind: "transfer", toAccountId: STUDENT.id, currency: "USD" }), ctx, meta), "轉帳的幣別跟著轉出帳戶");
    throwsMsg(() => buildEntryRow(input({ kind: "income", amountMinor: 100, categoryId: "c:🍜 食物" }), ctx, meta), "分類和收支類型對不上");
    throwsMsg(() => buildEntryRow(input({ currency: "EUR" }), ctx, meta), "沒有這個幣別：EUR");
    throwsMsg(() => parseRate("0"), "匯率要是大於 0 的數字");
    throwsMsg(() => currencyCode("12"), "幣別代碼要是三個英文字母");
    const del = { ...buildEntryRow(input({}), ctx, meta), deleted_at: NOW };
    throwsMsg(() => applyEntryPatch(del, { note: "x" }, ctx, NOW), "這一筆已經刪除了");
  });

  // 17b／17c／17d（repository 層）在檔尾的「E2」describe

  test("18. applyEntryPatch：只改備註不重算；改金額重算；換成轉帳清分類；沒變 cols 空", () => {
    const row = buildEntryRow(input({ amountMinor: 1000, currency: "USD", categoryId: "c:🍜 食物/午餐" }), ctx, meta);
    assert.equal(row.main_minor, 31550);
    const ctx2 = ctxOf([CASH, BANK, STUDENT, USDACC], demoCats(), [TWD, { ...USD, rate_to_main: "30" }]);
    const later = new Date(2026, 9, 12, 10, 0).toISOString();
    const a = applyEntryPatch(row, { note: "便當" }, ctx2, later);
    assert.deepEqual(Object.keys(a.cols).sort(), ["note", "updated_at"]);
    assert.equal(a.row.main_minor, 31550); // 折算不動（D-票-8）
    const b = applyEntryPatch(row, { amountMinor: 2000 }, ctx2, later);
    assert.equal(b.row.main_minor, 60000);
    assert.equal(b.row.account_minor, 60000);
    assert.equal(b.cols.updated_at, later);
    const c = applyEntryPatch(row, { kind: "transfer", toAccountId: STUDENT.id, currency: "TWD", amountMinor: 50000 }, ctx2, later);
    assert.equal(c.row.category_id, null);
    assert.equal(c.row.to_amount_minor, 50000);
    const d = applyEntryPatch(row, { note: "" }, ctx2, later);
    assert.deepEqual(d.cols, {});
    assert.equal(d.row, row);
  });

  test("19. draftToInput：退款負數、收入負數擋、atOf 套進去", () => {
    const draft: EntryDraft = {
      kind: "expense", amountText: "-350", currency: "TWD", accountId: CASH.id, toAccountId: null, categoryId: null,
      dayKey: "2026-10-08", time: "14:32", note: "", routeId: null, mainOverrideText: null, toAmountText: null,
    };
    const inp = draftToInput(draft, ctx, 6);
    assert.equal(inp.amountMinor, -35000);
    assert.equal(inp.occurredAt, atOf("2026-10-08", "14:32", 6));
    assert.equal(inp.occurredOn, "2026-10-08");
    throwsMsg(() => draftToInput({ ...draft, kind: "income", amountText: "-1" }, ctx, 6), "收入和轉帳的金額要是正的");
  });
});

/* ═════════════════════════ F. 餘額與合計 ═════════════════════════ */

describe("F. 餘額與合計", () => {
  test("20. balancesOf：收入、支出、退款、轉帳兩側、adjust、外幣支出、墓碑不算", () => {
    const es: EntryRow[] = [
      entry({ id: "1", kind: "income", amount_minor: 200000, account_minor: 200000 }),
      entry({ id: "2", kind: "expense", amount_minor: 8000, account_minor: 8000 }),
      entry({ id: "3", kind: "expense", amount_minor: -35000, account_minor: -35000 }),
      entry({ id: "4", kind: "transfer", amount_minor: 50000, account_minor: 50000, to_account_id: STUDENT.id, to_amount_minor: 50000 }),
      entry({ id: "5", kind: "adjust", amount_minor: -3700, account_minor: -3700 }),
      entry({ id: "6", kind: "expense", amount_minor: 1000, currency: "USD", account_minor: 31550 }),
      entry({ id: "7", kind: "expense", amount_minor: 99900, account_minor: 99900, deleted_at: NOW }),
    ];
    const b = balancesOf(es);
    assert.equal(b[CASH.id], 200000 - 8000 + 35000 - 50000 - 3700 - 31550);
    assert.equal(b[STUDENT.id], 50000);
  });

  test("21. accountTotals：負債進 liability、封存計入、USD 以目前匯率換算", () => {
    const card = acc("acc-card", "信用卡", "card");
    const old = acc("acc-old", "舊帳戶", "bank", "TWD", { archived_at: NOW });
    const t = accountTotals([CASH, card, old, USDACC], { [CASH.id]: 100000, [card.id]: -5000, [old.id]: 1000, [USDACC.id]: 1000 }, byCode([TWD, USD]));
    assert.deepEqual(t, { asset: 100000 + 1000 + 31550, liability: -5000, net: 100000 + 1000 + 31550 - 5000 });
  });

  test("22. planAdjust", () => {
    assert.equal(planAdjust(1000, 1000), null);
    assert.equal(planAdjust(920, 3000), 2080);
    assert.equal(planAdjust(0, -500), -500);
  });
});

/* ═════════════════════════ G. 顯示 ═════════════════════════ */

describe("G. 顯示", () => {
  test("23. moneyText 七個例子逐字", () => {
    assert.equal(moneyText(1234500, 2), "12,345");
    assert.equal(moneyText(123456, 2), "1,234.56");
    assert.equal(moneyText(5, 2), "0.05");
    assert.equal(moneyText(-35000, 2), "−350");
    assert.equal(moneyText(200000, 2, { prefix: "＋" }), "＋2,000");
    assert.equal(moneyText(31550, 2, { whole: true }), "316");
    assert.equal(moneyText(0, 2), "0");
  });

  test("24. rowAmount：退款、adjust 帶號、轉帳三種視角", () => {
    const accById = byId([CASH, STUDENT, USDACC]);
    const refund = rowAmount(entry({ id: "r", kind: "expense", amount_minor: -35000, main_minor: -35000 }), null, accById);
    assert.equal(moneyText(refund.minor, 2, { prefix: refund.prefix }), "−350");
    const adj = rowAmount(entry({ id: "a", kind: "adjust", amount_minor: -3700 }), null, accById);
    assert.deepEqual([adj.prefix, adj.minor], ["±", -3700]);
    const tr = entry({ id: "t", kind: "transfer", amount_minor: 31550, main_minor: 31550, to_account_id: USDACC.id, to_amount_minor: 1000 });
    assert.deepEqual(rowAmount(tr, null, accById), { prefix: "⇄", minor: 31550, currency: "TWD", convMain: null });
    assert.deepEqual(rowAmount(tr, CASH.id, accById), { prefix: "⇄", minor: -31550, currency: "TWD", convMain: null });
    assert.deepEqual(rowAmount(tr, USDACC.id, accById), { prefix: "⇄", minor: 1000, currency: "USD", convMain: 31550 });
    const usd = rowAmount(entry({ id: "u", kind: "expense", amount_minor: 1000, currency: "USD", main_minor: 31550 }), null, accById);
    assert.equal(usd.convMain, 31550);
  });

  test("25. groupByDay：同日退款淨額、transfer／adjust 不入、income 另計、新到舊；daySubtotalText 四種", () => {
    const es: EntryRow[] = [
      entry({ id: "1", occurred_on: "2026-10-09", kind: "expense", main_minor: 5000 }),
      entry({ id: "2", occurred_on: "2026-10-08", kind: "expense", main_minor: 8000 }),
      entry({ id: "3", occurred_on: "2026-10-08", kind: "expense", main_minor: -3000 }),
      entry({ id: "4", occurred_on: "2026-10-08", kind: "income", main_minor: 200000 }),
      entry({ id: "5", occurred_on: "2026-10-08", kind: "transfer", main_minor: 50000 }),
      entry({ id: "6", occurred_on: "2026-10-08", kind: "adjust", main_minor: -3700 }),
    ];
    const g = groupByDay(es, null);
    assert.deepEqual(g.map((x) => [x.dayKey, x.expense, x.income, x.entries.length]), [
      ["2026-10-09", 5000, 0, 1],
      ["2026-10-08", 5000, 200000, 5],
    ]);
    assert.equal(g[1].label, "10/8 週四");
    const G = (expense: number, income: number) => ({ dayKey: "x", label: "", expense, income, entries: [] });
    assert.equal(daySubtotalText(G(123000, 0), 2), "1,230");
    assert.equal(daySubtotalText(G(123000, 200000), 2), "1,230 ＋2,000");
    assert.equal(daySubtotalText(G(0, 200000), 2), "＋2,000");
    assert.equal(daySubtotalText(G(0, 0), 2), "");
  });

  test("26. monthSum 只算該月", () => {
    const es: EntryRow[] = [
      entry({ id: "1", occurred_on: "2026-10-01", kind: "expense", main_minor: 1000 }),
      entry({ id: "2", occurred_on: "2026-10-31", kind: "income", main_minor: 5000 }),
      entry({ id: "3", occurred_on: "2026-09-30", kind: "expense", main_minor: 9999 }),
      entry({ id: "4", occurred_on: "2026-10-05", kind: "transfer", main_minor: 7777 }),
    ];
    assert.deepEqual(monthSum(es, "2026-10"), { income: 5000, expense: 1000 });
  });

  test("27. dayLabel／monthTitle／addMonths／monthRange", () => {
    assert.equal(dayLabel("2026-10-08"), "10/8 週四");
    assert.equal(monthTitle("2026-10"), "2026 年 10 月");
    assert.equal(addMonths("2026-01", -1), "2025-12");
    assert.equal(addMonths("2026-12", 1), "2027-01");
    assert.deepEqual(monthRange("2026-12"), { from: "2026-12-01", toExcl: "2027-01-01" });
  });

  test("28. serialOf 同日三筆", () => {
    const t = (h: number) => new Date(2026, 9, 8, h, 0).toISOString();
    const es = [entry({ id: "b", occurred_at: t(14) }), entry({ id: "a", occurred_at: t(9) }), entry({ id: "c", occurred_at: t(20) })];
    assert.deepEqual(es.map((e) => serialOf(e, es)), ["No.1008-02", "No.1008-01", "No.1008-03"]);
  });

  test("29. atOf：日界線前的凌晨屬於前一個帳日", () => {
    assert.equal(atOf("2026-10-08", "01:30", 6), new Date(2026, 9, 9, 1, 30).toISOString());
    assert.equal(atOf("2026-10-08", "14:32", 6), new Date(2026, 9, 8, 14, 32).toISOString());
  });
});

/* ═════════════════════════ H. 分類與帳戶 ═════════════════════════ */

describe("H. 分類與帳戶", () => {
  test("30. catKey 去掉 emoji（含膚色修飾）", () => {
    assert.equal(catKey("🍜 食物"), "食物");
    assert.equal(catKey("🧘🏼 健康"), "健康");
    assert.equal(catKey("👬🏻 社交"), "社交");
  });

  test("31. matchCategories：完全→前綴→包含；子先主後；封存／未分類／別 kind 不出", () => {
    const cats = demoCats();
    const names = (q: string, kind: CategoryKind = "expense", cs = cats) => matchCategories(q, cs, kind).map((c) => c.name);
    assert.equal(names("午餐")[0], "午餐");
    assert.equal(names("食物")[0], "🍜 食物"); // 完全相符的主分類勝過前綴相符的子分類「食物券」
    assert.ok(names("食物").indexOf("食物券") > 0);
    assert.deepEqual(names("書籍").slice(0, 2), ["書籍", "書籍？"]); // 文化›書籍（完全）勝過 教育›書籍？（前綴）
    assert.equal(matchCategories("書籍", cats, "expense")[0].parent_id, "c:🖼 文化");
    assert.equal(names("飲")[0], "飲料");
    assert.deepEqual(names("餐"), ["早餐", "午餐", "晚餐", "聚餐"]);
    const archived = cats.map((c) => (c.name === "點心" ? { ...c, archived_at: NOW } : c));
    assert.deepEqual(names("點心", "expense", archived), []);
    assert.deepEqual(names("未分類"), []);
    assert.deepEqual(names("午餐", "income"), []);
    assert.deepEqual(names(""), []);
  });

  test("32. categoryTree：未分類最後、封存隱藏；categoryLabel 三種", () => {
    const cats = demoCats().map((c) => (c.id === "c:🚖 交通" ? { ...c, archived_at: NOW } : c));
    const t = categoryTree(cats, "expense", { includeArchived: false });
    assert.equal(t[t.length - 1].parent.id, UNCAT_EXPENSE_ID);
    assert.ok(!t.some((x) => x.parent.id === "c:🚖 交通"));
    assert.ok(!t.some((x) => x.children.some((k) => k.parent_id === "c:🚖 交通")));
    const all = categoryTree(cats, "expense", { includeArchived: true });
    assert.equal(all.find((x) => x.parent.id === "c:🚖 交通")?.children.length, 2);
    assert.deepEqual(t[0].children.map((c) => c.name), ["早餐", "午餐", "晚餐", "宵夜", "點心", "飲料"]);
    const byIdCats = byId(cats);
    assert.equal(categoryLabel(byIdCats["c:🍜 食物/午餐"], byIdCats), "🍜 食物 › 午餐");
    assert.equal(categoryLabel(byIdCats["c:🍜 食物"], byIdCats), "🍜 食物");
    assert.equal(categoryLabel(byIdCats[UNCAT_EXPENSE_ID], byIdCats), "未分類");
    assert.equal(categoryLabel(null, byIdCats), "（分類已不在）");
  });

  test("33. matchAccount／defaultAccountId", () => {
    const e1 = acc("acc-e1", "悠遊卡", "debit");
    const e2 = acc("acc-e2", "悠遊卡", "bank", "TWD", { position: 5 });
    const arch = acc("acc-arch", "學校帳戶", "bank", "TWD", { archived_at: NOW });
    const list = [CASH, e1, e2, STUDENT, arch];
    assert.equal(matchAccount("悠遊卡", list)?.id, e2.id); // bank 在 debit 前
    assert.equal(matchAccount("學", list)?.id, STUDENT.id);
    assert.equal(matchAccount("學校", list), null); // 封存不比
    assert.equal(defaultAccountId(list, STUDENT.id), STUDENT.id);
    assert.equal(defaultAccountId(list, arch.id), CASH.id);
    assert.equal(defaultAccountId([], null), null);
  });
});

/* ═════════════════════════ I. parseQuickEntry ═════════════════════════ */

describe("I. parseQuickEntry", () => {
  const qctx = (accounts: AccountRow[], last: string | null): QuickCtx => ({ ...ctxOf(accounts), lastAccountId: last });
  const ACCS = [CASH, BANK, STUDENT];

  test("34. 0-7 兩個範例", () => {
    const a = parseQuickEntry("80 午餐 便當 @學生證", qctx(ACCS, CASH.id));
    assert.deepEqual(a, { kind: "expense", amountMinor: 8000, currency: "TWD", accountId: STUDENT.id, categoryId: "c:🍜 食物/午餐", categoryMatched: true, note: "便當" });
    const b = parseQuickEntry("+2000 補貼 家教費", qctx(ACCS, BANK.id));
    assert.deepEqual(b, { kind: "income", amountMinor: 200000, currency: "TWD", accountId: BANK.id, categoryId: "c:💴 補貼", categoryMatched: true, note: "家教費" });
  });

  test("35. 第一個字不是金額 ⇒ 錯誤訊息逐字", () => {
    throwsMsg(() => parseQuickEntry("午餐 80", qctx(ACCS, null)), "第一個字要是金額，例如『80 午餐』");
  });

  test("36. 比不到分類 ⇒ 整段當備註、未分類、toast 尾有「（分類待補）」", () => {
    const c = qctx(ACCS, BANK.id);
    const q = parseQuickEntry("80 不存在的東西 好吃", c);
    assert.equal(q.categoryId, UNCAT_EXPENSE_ID);
    assert.equal(q.categoryMatched, false);
    assert.equal(q.note, "不存在的東西 好吃");
    assert.equal(quickToast(q, c), "已記 −80 不存在的東西 好吃 · 帳戶（分類待補）");
  });

  test("37. @ 比不到／沒 @ 用上一筆／上一筆封存取第一個未封存／沒有帳戶", () => {
    throwsMsg(() => parseQuickEntry("80 午餐 @xx", qctx(ACCS, null)), "找不到帳戶『xx』");
    assert.equal(parseQuickEntry("80 午餐", qctx(ACCS, STUDENT.id)).accountId, STUDENT.id);
    const archived = { ...STUDENT, archived_at: NOW };
    assert.equal(parseQuickEntry("80 午餐", qctx([CASH, BANK, archived], archived.id)).accountId, CASH.id);
    throwsMsg(() => parseQuickEntry("80 午餐", qctx([], null)), "還沒有帳戶——先到售票口新增一個");
  });

  test("38. 全形、千分位、小數位超過、只認最後一個 @", () => {
    const c = qctx(ACCS, BANK.id);
    const a = parseQuickEntry("８０　午餐　＠現金", c);
    assert.deepEqual([a.amountMinor, a.accountId, a.categoryId], [8000, CASH.id, "c:🍜 食物/午餐"]);
    assert.equal(parseQuickEntry("1,200 午餐", c).amountMinor, 120000);
    throwsMsg(() => parseQuickEntry("12.345 午餐", c), "TWD 最多 2 位小數");
    const b = parseQuickEntry("80 午餐 @現金 @學生證", c);
    assert.equal(b.accountId, STUDENT.id);
    assert.equal(b.note, "@現金");
  });

  test("39. quickToast：支出、收入（名稱帶 emoji）、外幣帳戶帶幣別碼", () => {
    const c = qctx([...ACCS, USDACC], BANK.id);
    assert.equal(quickToast(parseQuickEntry("80 午餐 @學生證", c), c), "已記 −80 午餐 · 學生證");
    assert.equal(quickToast(parseQuickEntry("+2000 補貼 家教費", c), c), "已記 ＋2,000 補貼 · 帳戶");
    assert.equal(quickToast(parseQuickEntry("80 午餐 @美金帳", c), c), "已記 −80 USD 午餐 · 美金帳");
  });
});

/* ═════════════════════════ J. 匯入 ═════════════════════════ */

/** fixture：7 帳戶（含兩個悠遊卡）、兩層分類（1 個被指到的已刪、1 個沒被指到的已刪）、TWD／USD／CNY、
 *  30 筆交易（3 對轉帳＋1 條缺腿、4 筆差別、1 筆孤兒、1 筆 USD）＋1 筆已刪交易 */
function fixtureDump(): MmbakDump {
  const groups = ["現金", "帳戶", "信用卡", "扣帳卡", "定期存款", "電子貨幣", "投資", "信用額度", "貸款", "保險", "其他"].map((name, i) => ({
    uid: `g${i + 1}`, type_code: i + 1, name,
  }));
  const G = (name: string) => groups.find((g) => g.name === name)!.uid;
  const accounts = [
    ["a1", "現金", "現金"], ["a2", "帳戶", "帳戶"], ["a3", "學生證", "帳戶"], ["a4", "出借貸款", "投資"],
    ["a5", "悠遊卡", "帳戶"], ["a6", "悠遊卡", "扣帳卡"], ["a7", "信用卡", "信用卡"],
  ].map(([uid, name, g]) => ({ uid, name, group_uid: G(g), currency_uid: "c1", is_del: false }));
  const C = (uid: string, type: number, name: string, parent: string | null, isDel = false) => ({
    uid, type_code: type, name, parent_uid: parent, status: parent ? 2 : 0, is_del: isDel,
  });
  const categories = [
    C("ci1", 0, "💴 補貼", null), C("ci2", 0, "💵 生活費", null),
    C("ce1", 1, "🍜 食物", null), C("ce1a", 1, "午餐", "ce1"), C("ce1b", 1, "晚餐", "ce1"),
    C("ce2", 1, "🚖 交通", null), C("ce2a", 1, "捷運", "ce2"),
    C("cdel1", 1, "🎮 舊遊戲", null, true), C("cdel2", 1, "舊分類", "ce2", true),
  ];
  const txs: MmTx[] = [];
  const T = (uid: string, do_type: string, asset: string, money: string, day: number, extra: Partial<MmTx> = {}) =>
    txs.push({
      uid, do_type, asset_uid: asset, to_asset_uid: null, tx_uid_trans: null, ctg_uid: null, zmoney: money, in_zmoney: money, currency_uid: "c1",
      wdate: `2026-09-${String(day).padStart(2, "0")}`, zdate: String(new Date(2026, 8, day, 12, 30).getTime()), content: "",
      utime: 1759276800000, is_del: false, ...extra,
    });
  T("t1", "0", "a2", "3000", 1, { ctg_uid: "ci1" });
  T("t2", "0", "a2", "2000", 15, { ctg_uid: "ci2" });
  const ex: [string, string, number, string][] = [
    ["a1", "120", 2, "ce1a"], ["a1", "80", 3, "ce1a"], ["a1", "200", 3, "ce1b"], ["a3", "25", 4, "ce2a"], ["a3", "25", 5, "ce2a"],
    ["a1", "150", 6, "ce1b"], ["a1", "90", 7, "ce1a"], ["a2", "450", 8, "cdel1"], ["a5", "30", 9, "ce2a"], ["a1", "60", 10, "ce1"],
    ["a3", "25", 11, "ce2a"], ["a1", "110", 12, "ce1a"], ["a1", "70", 13, "ce1b"], ["a2", "300", 14, "ce2"], ["a1", "40", 16, "ce1a"],
  ];
  ex.forEach(([a, m, d, c], i) => T(`e${i + 1}`, "1", a, m, d, { ctg_uid: c, content: i === 0 ? "便當" : "" }));
  T("o1", "1", "a1", "99", 17, { ctg_uid: "cmissing" });
  // 財務管家語意：ZMONEY＝帳戶幣別（TWD）額、IN_ZMONEY＝原幣（USD）額；ZMONEY / IN_ZMONEY ＝ 備份匯率
  T("u1", "1", "a2", "315.5", 18, { ctg_uid: "ce1b", currency_uid: "c2", in_zmoney: "10" });
  const tr = (key: string, from: string, to: string, money: string, day: number) => {
    T(`${key}-3`, "3", from, money, day, { to_asset_uid: to, tx_uid_trans: key, content: "儲值" });
    T(`${key}-4`, "4", to, money, day, { to_asset_uid: from, tx_uid_trans: key });
  };
  tr("tr1", "a2", "a3", "500", 5);
  tr("tr2", "a2", "a1", "1000", 10);
  tr("tr3", "a1", "a5", "300", 20);
  T("m1", "3", "a2", "200", 21, { to_asset_uid: "a3", tx_uid_trans: "tr-lonely" });
  T("d1", "7", "a1", "120", 22);
  T("d2", "8", "a1", "37", 23);
  T("d3", "7", "a2", "1500", 24);
  T("d4", "8", "a4", "2000", 25);
  T("x1", "1", "a1", "60", 26, { ctg_uid: "ce1a", is_del: true });
  return {
    file_name: "fixture.mmbak",
    currencies: [
      { uid: "c1", iso: "TWD", is_main: true, rate: "1", decimals: 2 },
      { uid: "c2", iso: "USD", is_main: false, rate: "31.549671", decimals: 2 },
      { uid: "c3", iso: "CNY", is_main: false, rate: "4.35", decimals: 2 },
    ],
    groups,
    accounts,
    categories,
    transactions: txs,
  };
}

/** 本機只有起手三列（＋可選的列） */
function emptyLocal(extra: Partial<ImportLocal> = {}): ImportLocal {
  return {
    currencies: [{ ...TWD, id: CURRENCY_TWD_ID }, ...(extra.currencies ?? [])],
    accounts: extra.accounts ?? [],
    categories: [cat(UNCAT_INCOME_ID, "income", "未分類", null, 9999), cat(UNCAT_EXPENSE_ID, "expense", "未分類", null, 9999), ...(extra.categories ?? [])],
    entries: extra.entries ?? [],
  };
}

const mmId = (uid: string) => ticketId("moneymanager:" + uid);
const plan0 = (local = emptyLocal(), balanceText: Record<string, string> = {}, dump = fixtureDump()) =>
  planImport(dump, local, { balanceText, nowIso: NOW });

describe("J. 匯入", () => {
  test("40. mmSummary：帳戶 7、交易＝未刪原始列數、分類＝用到的、日期範圍", () => {
    assert.deepEqual(mmSummary(fixtureDump()), { accounts: 7, categories: 8, transactions: 30, from: "2026-09-01", to: "2026-09-25" });
  });

  test("40b. mmSummary「分類 N」口徑定案（契約 0-24）：只算存在的分類、孤兒 uid 不算、收支跨類型去重", () => {
    const base = fixtureDump();
    // 孤兒：fixture 的 o1 指到不存在的 "cmissing"（支出）——8 裡本來就不含它
    assert.ok(base.transactions.some((t) => t.ctg_uid === "cmissing" && !t.is_del));
    assert.ok(!base.categories.some((c) => c.uid === "cmissing"));
    assert.equal(mmSummary(base).categories, 8);
    // 孤兒再出現在收入一次也不算（不是「收支各算一次」＝不是 +2）
    const d = fixtureDump();
    d.transactions.push({ ...d.transactions.find((t) => t.uid === "o1")!, uid: "o2", do_type: "0" });
    assert.equal(mmSummary(d).categories, 8);
    // 同一個存在的分類 uid 同時出現在收入與支出 ⇒ 只算 1（跨類型去重）
    const e = fixtureDump();
    e.transactions.push({ ...e.transactions.find((t) => t.uid === "e1")!, uid: "e1-inc", do_type: "0" });
    assert.equal(mmSummary(e).categories, 8);
    // 已刪除的交易不帶入
    const f = fixtureDump();
    f.transactions.push({ ...f.transactions.find((t) => t.uid === "e1")!, uid: "ghost", do_type: "0", ctg_uid: "ci1", is_del: true });
    assert.equal(mmSummary(f).categories, 8);
  });

  test("41. 帳戶：確定性 id、兩個悠遊卡分開、本機同名同群組同幣別的手記帳戶 ⇒ 對到它", () => {
    const p = plan0();
    assert.equal(p.accounts.length, 7);
    assert.equal(p.accountIdOf.a5, mmId("a5"));
    assert.notEqual(p.accountIdOf.a5, p.accountIdOf.a6);
    assert.deepEqual([p.accounts[4].group_key, p.accounts[5].group_key], ["bank", "debit"]);
    assert.equal(p.accounts[3].group_key, "investment"); // 出借貸款（0-19）
    const manual = acc("my-cash", "現金", "cash");
    const q = plan0(emptyLocal({ accounts: [manual] }));
    assert.equal(q.accountIdOf.a1, "my-cash");
    assert.equal(q.accounts.length, 6);
  });

  test("42. 分類：現用樹全建（父先子後）、被指到的已刪分類建並封存、沒被指到的不建、孤兒 ⇒ 未分類", () => {
    const p = plan0();
    assert.deepEqual(p.categories.map((c) => c.name), ["💴 補貼", "💵 生活費", "🍜 食物", "🚖 交通", "🎮 舊遊戲", "午餐", "晚餐", "捷運"]);
    assert.equal(p.categories.find((c) => c.name === "🎮 舊遊戲")?.archived_at, NOW);
    assert.equal(p.categories.find((c) => c.name === "午餐")?.parent_id, mmId("ce1"));
    assert.ok(!p.categories.some((c) => c.name === "舊分類"));
    const orphan = p.entries.inserts.find((e) => e.import_id === "o1");
    assert.equal(orphan?.category_id, UNCAT_EXPENSE_ID);
  });

  test("43. 轉帳：3 對合成 3 筆、id、轉出轉入、缺腿進 invalid", () => {
    const p = plan0();
    const trs = p.entries.inserts.filter((e) => e.kind === "transfer");
    assert.equal(trs.length, 3);
    const t1 = trs.find((e) => e.id === ticketId("moneymanager:transfer:tr1"));
    assert.ok(t1);
    assert.deepEqual([t1.account_id, t1.to_account_id, t1.amount_minor, t1.to_amount_minor, t1.import_id, t1.note], [mmId("a2"), mmId("a3"), 50000, 50000, "transfer:tr1", "儲值"]);
    assert.deepEqual(p.entries.invalid, [{ uid: "m1", reason: "轉帳缺另一腿" }]);
    assert.equal(p.entries.inserts.length, 30 - 6 + 3 - 1);
  });

  test("44. occurred_on＝wdate、occurred_at＝ISO(zdate)；USD 用備份匯率（本機匯率不同時仍用備份的）", () => {
    const local = emptyLocal({ currencies: [{ ...USD, rate_to_main: "30" }] });
    const p = plan0(local);
    const e1 = p.entries.inserts.find((e) => e.import_id === "e1")!;
    assert.equal(e1.occurred_on, "2026-09-02");
    assert.equal(e1.occurred_at, new Date(2026, 8, 2, 12, 30).toISOString());
    assert.equal(e1.note, "便當");
    const u1 = p.entries.inserts.find((e) => e.import_id === "u1")!;
    assert.deepEqual([u1.currency, u1.amount_minor, u1.main_minor, u1.account_minor], ["USD", 1000, 31550, 31550]);
    assert.ok(!p.currencies.some((c) => c.code === "USD")); // 本機已有 ⇒ 不新建
    assert.ok(p.currencies.some((c) => c.code === "CNY"));
  });

  test("44a. 外幣列：ZMONEY 已是帳戶幣別額、IN_ZMONEY 才是原幣額——不再把 ZMONEY 換算第二次（回歸）", () => {
    const mk = (uid: string, money: string, inMoney: string | null, cur = "c2", day = 19): MmTx => ({
      uid, do_type: "1", asset_uid: "a2", to_asset_uid: null, tx_uid_trans: null, ctg_uid: "ce1a", zmoney: money, in_zmoney: inMoney,
      currency_uid: cur, wdate: `2026-09-${day}`, zdate: String(new Date(2026, 8, day, 9, 0).getTime()), content: "",
      utime: 1759276800000, is_del: false,
    });
    const before = balancesOf(plan0().entries.inserts)[mmId("a2")];
    const balAfter = (d: MmbakDump) => balancesOf(plan0(undefined, {}, d).entries.inserts)[mmId("a2")];

    // 100 USD 花在 TWD 帳戶：備份 ZMONEY＝3155.0（TWD）、IN_ZMONEY＝100.0（USD）、匯率 31.55
    const d1 = fixtureDump();
    d1.currencies.find((c) => c.uid === "c2")!.rate = "31.55";
    d1.transactions.push(mk("fx1", "3155.0", "100.0"));
    const e1 = plan0(undefined, {}, d1).entries.inserts.find((e) => e.import_id === "fx1")!;
    assert.deepEqual(
      [e1.currency, e1.amount_minor, e1.account_minor, e1.main_minor],
      ["USD", 10000, 315500, 315500],
    );
    assert.equal(balAfter(d1) - before, -315500); // 舊程式會多換算一次、約 −99,540 元

    // TWD 列不變（IN_ZMONEY＝ZMONEY；同幣別不看 IN_ZMONEY，連它是 null 也一樣）
    const d2 = fixtureDump();
    d2.transactions.push(mk("tw1", "250.5", "250.5", "c1"), mk("tw2", "10", null, "c1", 20));
    const p2 = plan0(undefined, {}, d2);
    const tw1 = p2.entries.inserts.find((e) => e.import_id === "tw1")!;
    assert.deepEqual([tw1.currency, tw1.amount_minor, tw1.account_minor, tw1.main_minor], ["TWD", 25050, 25050, 25050]);
    const tw2 = p2.entries.inserts.find((e) => e.import_id === "tw2")!;
    assert.deepEqual([tw2.currency, tw2.amount_minor, tw2.account_minor, tw2.main_minor], ["TWD", 1000, 1000, 1000]);

    // IN_ZMONEY 缺（null／空字串／看不懂／0）的外幣列 ⇒ 保守退回記成帳戶幣別，餘額照樣對
    for (const bad of [null, "", "abc", "0"]) {
      const d3 = fixtureDump();
      d3.currencies.find((c) => c.uid === "c2")!.rate = "31.55";
      d3.transactions.push(mk("fx2", "3155.0", bad));
      const e3 = plan0(undefined, {}, d3).entries.inserts.find((e) => e.import_id === "fx2")!;
      assert.deepEqual([e3.currency, e3.amount_minor, e3.account_minor, e3.main_minor], ["TWD", 315500, 315500, 315500], `in_zmoney=${bad}`);
      assert.equal(balAfter(d3) - before, -315500);
    }
  });

  test("45. 差別：A／B／solved／default（解不出 ok:false、都沒填 ok:null）；plus／minus", () => {
    // 不含差別的基礎：a1 −31900、a2 243450、a4 0（見 fixtureDump 的金額）
    const A = plan0(undefined, { a1: "-236", a2: "3934.5", a4: "-2000" });
    assert.deepEqual(A.adjust, { total: 4, plus: 2, minus: 2, rule: "A" });
    assert.ok(A.checks.filter((c) => c.inputMinor !== null).every((c) => c.ok === true));
    const B = plan0(undefined, { a1: "-402", a2: "934.5", a4: "2000" });
    assert.equal(B.adjust.rule, "B");
    const S = plan0(undefined, { a1: "-236", a2: "934.5" });
    assert.equal(S.adjust.rule, "solved");
    assert.deepEqual(S.checks.filter((c) => c.inputMinor !== null).map((c) => c.ok), [true, true]);
    const d3 = S.entries.inserts.find((e) => e.import_id === "d3")!;
    assert.equal(d3.amount_minor, -150000);
    const D = plan0(undefined, { a1: "-300" });
    assert.equal(D.adjust.rule, "default");
    assert.equal(D.checks.find((c) => c.mmUid === "a1")?.ok, false);
    const N = plan0();
    assert.equal(N.adjust.rule, "default");
    assert.ok(N.checks.every((c) => c.ok === null));
    assert.equal(N.checks.length, 7);
    assert.equal(N.checks.find((c) => c.mmUid === "a1")?.computedMinor, -23600); // 預設 A
  });

  test("46. 重跑：照第一次結果 ⇒ 0／0；改一筆 ⇒ changed 1；墓碑；本機改備註不覆寫；本機手記 ⇒ extraLocal", () => {
    const local = emptyLocal();
    const p = plan0(local);
    const m = materializeImport(p, defaultChoices(p), NOW);
    const local2: ImportLocal = {
      currencies: [...local.currencies, ...p.currencies],
      accounts: [...local.accounts, ...p.accounts],
      categories: [...local.categories, ...p.categories],
      entries: m.entryInserts,
    };
    const again = plan0(local2);
    assert.equal(again.entries.inserts.length, 0);
    assert.equal(again.entries.changed.length, 0);
    assert.equal(again.currencies.length + again.accounts.length + again.categories.length, 0);

    const dump2 = fixtureDump();
    const t = dump2.transactions.find((x) => x.uid === "e2")!;
    t.utime += 1;
    t.content = "改過的備註";
    const bumped = plan0(local2, {}, dump2);
    assert.equal(bumped.entries.changed.length, 1);
    assert.ok(bumped.entries.changed[0].cols.includes("note"));
    assert.deepEqual(defaultChoices(bumped), { [mmId("e2")]: "theirs" });

    const tomb = { ...local2, entries: local2.entries.map((e) => (e.import_id === "e3" ? { ...e, deleted_at: NOW } : e)) };
    const pt = plan0(tomb);
    assert.equal(pt.entries.tombstoned, 1);
    assert.ok(!pt.entries.inserts.some((e) => e.import_id === "e3"));

    const edited = { ...local2, entries: local2.entries.map((e) => (e.import_id === "e4" ? { ...e, note: "我自己改的" } : e)) };
    const pe = plan0(edited);
    assert.equal(pe.entries.changed.length, 0);

    const extra = { ...local2, entries: [...local2.entries, entry({ id: "mine", account_id: mmId("a1") })] };
    assert.equal(plan0(extra).extraLocal, 1);
  });

  test("47. materializeImport：update cols 不含 route_id；選 ours ⇒ 不寫、計入 keptLocal", () => {
    const local = emptyLocal();
    const p = plan0(local);
    const m = materializeImport(p, {}, NOW);
    const local2: ImportLocal = {
      currencies: [...local.currencies, ...p.currencies],
      accounts: p.accounts,
      categories: [...local.categories, ...p.categories],
      entries: m.entryInserts.map((e) => (e.import_id === "e2" ? { ...e, route_id: "route-1" } : e)),
    };
    const dump2 = fixtureDump();
    const t = dump2.transactions.find((x) => x.uid === "e2")!;
    t.utime += 1;
    t.content = "改過的備註";
    const b = plan0(local2, {}, dump2);
    const theirs = materializeImport(b, defaultChoices(b), NOW);
    assert.equal(theirs.entryUpdates.length, 1);
    assert.ok(!("route_id" in theirs.entryUpdates[0].cols));
    assert.equal(theirs.entryUpdates[0].cols.note, "改過的備註");
    assert.equal(theirs.entryUpdates[0].cols.import_utime, t.utime);
    const ours = materializeImport(b, { [mmId("e2")]: "ours" }, NOW);
    assert.deepEqual([ours.entryUpdates.length, ours.keptLocal], [0, 1]);
    // 選 ours ⇒ 只送一個記號 update：import_utime＝這次備份的 UTIME＋updated_at，不碰內容欄
    assert.deepEqual(ours.entryKept, [{ id: mmId("e2"), cols: { import_utime: t.utime, updated_at: NOW } }]);
    assert.deepEqual(theirs.entryKept, []);
  });

  test("48. 主幣別不是 TWD ⇒ unsupported 逐字；missingText 兩種格式", () => {
    const d = fixtureDump();
    d.currencies = d.currencies.map((c) => ({ ...c, is_main: c.iso === "USD" }));
    assert.equal(plan0(undefined, {}, d).unsupported, "這個備份的主幣別是 USD，Next Stop 目前只支援新台幣");
    assert.equal(plan0().unsupported, null);
    assert.equal(missingText(["ASSETS"]), "ASSETS 表");
    assert.equal(missingText(["INOUTCOME.txUidTrans"]), "INOUTCOME.txUidTrans 欄");
    assert.equal(missingText(["A", "B", "C.d", "E"]), "A 表、B 表、C.d 欄等");
  });

  test("49. 決定性：交易順序打亂 10 次 ⇒ planImport 輸出 deepEqual", () => {
    const want = plan0(undefined, { a1: "-236" });
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let k = 0; k < 10; k++) {
      const d = fixtureDump();
      const arr = d.transactions;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      assert.deepEqual(plan0(undefined, { a1: "-236" }, d), want);
    }
  });

  /* ── 修正席 10-12（評審 must／should）── */

  test("43b. 跨幣別轉帳（腿 3 幣別 ≠ 轉出帳戶）⇒ 存成轉出帳戶幣別；之後只改備註 cols 只有 note＋updated_at", () => {
    const d = fixtureDump();
    d.accounts.push({ uid: "a8", name: "美金帳", group_uid: "g2", currency_uid: "c2", is_del: false });
    d.transactions.push(
      { uid: "x-3", do_type: "3", asset_uid: "a2", to_asset_uid: "a8", tx_uid_trans: "trx", ctg_uid: null, zmoney: "10", in_zmoney: "10", currency_uid: "c2",
        wdate: "2026-09-19", zdate: String(new Date(2026, 8, 19, 9, 0).getTime()), content: "換匯", utime: 1759276800000, is_del: false },
      { uid: "x-4", do_type: "4", asset_uid: "a8", to_asset_uid: "a2", tx_uid_trans: "trx", ctg_uid: null, zmoney: "10", in_zmoney: "10", currency_uid: "c2",
        wdate: "2026-09-19", zdate: String(new Date(2026, 8, 19, 9, 0).getTime()), content: "", utime: 1759276800000, is_del: false },
    );
    const p = plan0(undefined, {}, d);
    const t = p.entries.inserts.find((e) => e.import_id === "transfer:trx")!;
    // TWD 帳戶轉 10 USD（備份匯率 31.549671）⇒ TWD 315.50；轉入 USD 帳戶 10
    assert.deepEqual([t.currency, t.amount_minor, t.account_minor, t.main_minor, t.to_amount_minor], ["TWD", 31550, 31550, 31550, 1000]);
    const usd8 = p.accounts.find((a) => a.id === mmId("a8"))!;
    assert.equal(usd8.currency, "USD");
    const ctx = ctxOf([...p.accounts], demoCats(), [TWD, USD]);
    const r = applyEntryPatch(t, { note: "換匯（改）" }, ctx, NOW);
    assert.deepEqual(Object.keys(r.cols).sort(), ["note", "updated_at"]);
    // 防線：舊列若幣別不是轉出帳戶的，只改備註不准偷換幣別（擋下而不是改錯）
    throwsMsg(() => applyEntryPatch({ ...t, currency: "USD", amount_minor: 1000 }, { note: "x" }, ctx, NOW), "轉帳的幣別跟著轉出帳戶");
  });

  test("44b. 匯率超過 10 位小數 ⇒ 半進位到 10 位；看不懂的匯率不退回主幣別、帳戶與帳進 invalid", () => {
    assert.equal(importRate("0.210526315789474"), "0.2105263158");
    assert.equal(importRate("31.549671"), "31.549671");
    assert.equal(importRate("1.234e-5"), "0.00001234");
    assert.equal(importRate("4.350"), "4.35");
    throwsMsg(() => importRate("0.00000000001"), "匯率要是大於 0 的數字");
    throwsMsg(() => importRate("abc"), "匯率要是大於 0 的數字");

    const d = fixtureDump();
    d.currencies.push({ uid: "c4", iso: "JPY", is_main: false, rate: "0.210526315789474", decimals: 0 });
    d.accounts.push({ uid: "a9", name: "日圓錢包", group_uid: "g1", currency_uid: "c4", is_del: false });
    d.transactions.push({
      uid: "j1", do_type: "1", asset_uid: "a9", to_asset_uid: null, tx_uid_trans: null, ctg_uid: "ce1a", zmoney: "500", in_zmoney: "500", currency_uid: null,
      wdate: "2026-09-19", zdate: String(new Date(2026, 8, 19, 9, 0).getTime()), content: "", utime: 1759276800000, is_del: false,
    });
    const p = plan0(undefined, {}, d);
    assert.equal(p.accounts.find((a) => a.id === mmId("a9"))?.currency, "JPY");
    const j1 = p.entries.inserts.find((e) => e.import_id === "j1")!;
    assert.deepEqual([j1.currency, j1.amount_minor, j1.main_minor], ["JPY", 500, 10526]);

    const bad = fixtureDump();
    bad.currencies.push({ uid: "c4", iso: "JPY", is_main: false, rate: "0", decimals: 0 });
    bad.accounts.push({ uid: "a9", name: "日圓錢包", group_uid: "g1", currency_uid: "c4", is_del: false });
    bad.transactions.push({ ...d.transactions[d.transactions.length - 1] });
    const q = plan0(undefined, {}, bad);
    assert.ok(!q.accounts.some((a) => a.name === "日圓錢包"));
    assert.ok(!q.entries.inserts.some((e) => e.import_id === "j1"));
    assert.deepEqual(q.entries.invalid.find((x) => x.uid === "j1"), { uid: "j1", reason: "幣別看不懂" });
  });

  test("46b. 第一次按名稱對上手建帳戶／分類，主人改名後重跑 ⇒ 沿用原對應、不多建", () => {
    const manualAcc = acc("my-cash", "現金", "cash");
    const manualCat = cat("my-food", "expense", "🍜 食物", null, 0);
    const local = emptyLocal({ accounts: [manualAcc], categories: [manualCat] });
    const p = plan0(local);
    assert.equal(p.accountIdOf.a1, "my-cash");
    assert.ok(!p.categories.some((c) => c.name === "🍜 食物"));
    const m = materializeImport(p, defaultChoices(p), NOW);
    const local2: ImportLocal = {
      currencies: [...local.currencies, ...p.currencies],
      accounts: [{ ...manualAcc, name: "皮夾" }, ...p.accounts],
      categories: [...local.categories.map((c) => (c.id === "my-food" ? { ...c, name: "吃飯" } : c)), ...p.categories],
      entries: m.entryInserts,
    };
    const dump2 = fixtureDump();
    dump2.transactions.push({ ...dump2.transactions.find((x) => x.uid === "e1")!, uid: "e99", wdate: "2026-09-19", ctg_uid: "ce1" });
    const again = plan0(local2, {}, dump2);
    assert.deepEqual(again.accounts, []);
    assert.deepEqual(again.categories, []);
    assert.equal(again.accountIdOf.a1, "my-cash");
    const e99 = again.entries.inserts.find((e) => e.import_id === "e99")!;
    assert.deepEqual([e99.account_id, e99.category_id], ["my-cash", "my-food"]);
  });
});

/* ═════════════════════════ K. solveAdjustSigns ═════════════════════════ */

describe("K. solveAdjustSigns", () => {
  test("50. 唯一解／多解／無解／超過上限／空陣列", () => {
    assert.deepEqual(solveAdjustSigns([5, 3, 2], 4), [1, -1, 1]);
    assert.equal(solveAdjustSigns([1, 1], 0), null);
    assert.equal(solveAdjustSigns([5], 3), null);
    assert.equal(solveAdjustSigns(new Array(23).fill(1), 1), null);
    assert.deepEqual(solveAdjustSigns([], 0), []);
    assert.equal(solveAdjustSigns([], 5), null);
    const amounts = [101, 203, 307, 401, 503, 601, 701, 809, 907, 1009, 1103, 1201, 1301, 1409, 1511, 1601, 1709, 1801, 1901, 2003, 2111, 2203];
    const signs = amounts.map((_, i) => (i % 3 === 0 ? -1 : 1) as 1 | -1);
    const need = amounts.reduce((s, a, i) => s + signs[i] * a, 0);
    const got = solveAdjustSigns(amounts, need);
    if (got) assert.equal(got.reduce((s, x, i) => s + x * amounts[i], 0), need); // 22 筆：有解就要對得上
  });
});

/* ═════════════════════════ E2. repository 層（memory／sqlite 兩個實作；Stage 1） ═════════════════════════ */

/** node:sqlite 記憶體 DB＋plugin-sql 形狀的轉接（select／execute 用 `$1..$n`）；`runBatch`＝一個交易＋收 op */
interface TestDb {
  ops: { tbl: string; row_id: string; op: string; cols: Record<string, unknown> }[];
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<void>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: TestDb["ops"]): void;
}
function makeSqliteDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON"); // sqlx 預設開（0-15）
  raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations/0007_ticket_ledger.sql"), "utf8"));
  // 第③階段（③契約 0-3）：tk_entries 多 repeat_id、另兩張表——sqlite 實作的 ENT_COLS 已含 repeat_id，真機也一定跑過 0010
  raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations/0010_ticket_plan.sql"), "utf8"));
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

/** ticket.rs 的白名單欄（op 完整列要與它逐欄相同） */
function rustCols(name: string): string[] {
  const src = readFileSync(path.join(ROOT, "src-tauri/src/sync/tables/ticket.rs"), "utf8");
  const m = new RegExp(`const ${name}: &\\[\\(&str, bool\\)\\] = &\\[([\\s\\S]*?)\\];`).exec(src);
  assert.ok(m, `ticket.rs 找不到 ${name}`);
  return Array.from(m[1].matchAll(/\("(\w+)",/g), (x) => x[1]);
}

/** 第③階段 applyImport 多一個 part（③契約 §3.4）；①的匯入測試不帶預算／規則 */
const EMPTY_PART = {
  budgets: { inserts: [], updates: [], unchanged: 0, tombstoned: 0, invalid: [], overrides: 0, scopes: 0 },
  repeats: { inserts: [], updates: [], unchanged: 0, tombstoned: 0, invalid: [] },
  missing: [],
};

const rejectsMsg = (p: Promise<unknown>, msg: string) =>
  assert.rejects(p, (e: unknown) => e instanceof RangeError && e.message === msg, `應丟「${msg}」`);

type AnyRepo = any; // 測試只看行為；兩個實作都 implements TicketRepository
const REPO_DAY = "2026-10-12";
const atLocal = (h: number) => new Date(2026, 9, 12, h, 0).toISOString();
const IMPLS: { name: string; make: () => Promise<{ repo: AnyRepo; db: TestDb | null }> }[] = [
  {
    name: "memory",
    make: async () => {
      const { MemoryTicketRepository } = await import("../../src/data/memoryTicketRepository.ts");
      return { repo: new MemoryTicketRepository({ seedDemo: false }), db: null };
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const db = makeSqliteDb();
      (globalThis as { __tkDb?: TestDb }).__tkDb = db;
      const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
      return { repo: new SqliteTicketRepository(), db };
    },
  },
];
const newAcc = (name: string, group: string, currency = "TWD", openingMinor: number | null = null) => ({
  name,
  group,
  currency,
  openingMinor,
  occurredOn: REPO_DAY,
});
const newEntry = (p: Partial<NewEntryInput>): NewEntryInput => ({
  kind: "expense",
  amountMinor: 8000,
  currency: "TWD",
  accountId: "",
  toAccountId: null,
  categoryId: null,
  occurredOn: REPO_DAY,
  occurredAt: atLocal(12),
  note: "",
  routeId: null,
  ...p,
});

describe("E2. repository 層（memory／sqlite）", () => {
  for (const impl of IMPLS) {
    test(`17b. repository 層的錯誤訊息逐字（${impl.name}）`, async () => {
      const { repo } = await impl.make();
      assert.equal(await repo.ensureStarterRows(), 3);
      assert.equal(await repo.ensureStarterRows(), 0); // 冪等（0-17）

      await rejectsMsg(repo.createAccount(newAcc("  ", "cash")), "帳戶名稱不能是空的");
      await rejectsMsg(repo.createAccount(newAcc("現金", "cash", "EUR")), "沒有這個幣別：EUR");
      const cash = await repo.createAccount(newAcc(" 現金 ", "cash", "TWD", 100000));
      assert.equal(cash.name, "現金");

      const usd = await repo.createCurrency({ code: " usd ", name: "", decimals: 2, rate: "31.549671" });
      assert.equal(usd.code, "USD");
      assert.equal(usd.id, ticketId("currency:USD"));
      assert.equal(usd.name, "美元");
      await rejectsMsg(repo.createCurrency({ code: "USD", name: "", decimals: 2, rate: "30" }), "已經有 USD 了");
      await rejectsMsg(repo.createCurrency({ code: "US", name: "", decimals: 2, rate: "30" }), "幣別代碼要是三個英文字母");
      await rejectsMsg(repo.createCurrency({ code: "EUR", name: "", decimals: 2, rate: "0" }), "匯率要是大於 0 的數字");
      await rejectsMsg(repo.updateCurrency(CURRENCY_TWD_ID, { rate: "2" }), "主幣別的匯率固定是 1");

      await rejectsMsg(repo.updateAccount(cash.id, { currency: "USD" }), "這個帳戶已經有帳，幣別不能改"); // 期初那筆算帳
      await rejectsMsg(repo.updateAccount(cash.id, { name: " " }), "帳戶名稱不能是空的");
      const student = await repo.createAccount(newAcc("學生證", "bank"));
      await repo.updateAccount(student.id, { currency: "USD" }); // 沒帳 ⇒ 可以改
      assert.equal((await repo.listAccounts()).find((a: AccountRow) => a.id === student.id).currency, "USD");

      await rejectsMsg(repo.createCategory({ kind: "expense", name: "  ", parentId: null }), "分類名稱不能是空的");
      const food = await repo.createCategory({ kind: "expense", name: "🍜 食物", parentId: null });
      const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });
      await rejectsMsg(repo.createCategory({ kind: "expense", name: "便當", parentId: lunch.id }), "分類只有兩層");
      await rejectsMsg(repo.createCategory({ kind: "income", name: "x", parentId: food.id }), "分類和收支類型對不上");
      await rejectsMsg(repo.createCategory({ kind: "expense", name: "x", parentId: UNCAT_EXPENSE_ID }), "「未分類」下面不能建子分類");
      await rejectsMsg(repo.renameCategory(UNCAT_EXPENSE_ID, "雜項"), "「未分類」不能改名或封存");
      await rejectsMsg(repo.setCategoryArchived(UNCAT_INCOME_ID, true), "「未分類」不能改名或封存");
      await rejectsMsg(repo.renameCategory(food.id, " "), "分類名稱不能是空的");

      await rejectsMsg(repo.createEntry(newEntry({ accountId: cash.id, amountMinor: 0 })), "金額不能是 0");
      const e = await repo.createEntry(newEntry({ accountId: cash.id, categoryId: lunch.id }));
      await repo.softDeleteEntry(e.id);
      await rejectsMsg(repo.updateEntry(e.id, { note: "x" }), "這一筆已經刪除了");
    });

    test(`17c. repository 行為：餘額、清單、刪除復原、調整、排序、封存、匯入重跑（${impl.name}）`, async () => {
      const { repo } = await impl.make();
      await repo.ensureStarterRows();
      const cash = await repo.createAccount(newAcc("現金", "cash", "TWD", 100000));
      const student = await repo.createAccount(newAcc("學生證", "bank"));
      const bank = await repo.createAccount(newAcc("帳戶", "bank"));
      await repo.createCurrency({ code: "USD", name: "", decimals: 2, rate: "31.549671" });
      const usdAcc = await repo.createAccount(newAcc("美金", "bank", "USD"));
      assert.deepEqual([student.position, bank.position, usdAcc.position], [0, 1, 2]);
      const food = await repo.createCategory({ kind: "expense", name: "🍜 食物", parentId: null });
      const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });

      const e1 = await repo.createEntry(newEntry({ accountId: cash.id, categoryId: lunch.id, note: "便當" }));
      const e2 = await repo.createEntry(
        newEntry({ kind: "transfer", amountMinor: 50000, accountId: cash.id, toAccountId: student.id, occurredAt: atLocal(13) }),
      );
      const e3 = await repo.createEntry(newEntry({ amountMinor: 1000, currency: "USD", accountId: cash.id, categoryId: lunch.id, occurredAt: atLocal(14) }));
      assert.equal(e3.account_minor, 31550);
      const e4 = await repo.createEntry(newEntry({ kind: "income", amountMinor: 200000, accountId: bank.id, occurredAt: atLocal(9) }));
      assert.equal(e4.category_id, UNCAT_INCOME_ID);

      const want: Record<string, number> = {
        [cash.id]: 100000 - 8000 - 50000 - 31550,
        [student.id]: 50000,
        [bank.id]: 200000,
        [usdAcc.id]: 0,
      };
      assert.deepEqual(await repo.balances(), want);
      const local0: ImportLocal = await repo.loadImportLocal();
      const pure = balancesOf(local0.entries);
      for (const id of Object.keys(want)) assert.equal(pure[id] ?? 0, want[id], "SQL 聚合與 balancesOf 同義（§3.5-3）");

      const cashList: EntryRow[] = await repo.listEntries(REPO_DAY, "2026-10-13", cash.id);
      assert.deepEqual(cashList.filter((x) => x.kind !== "adjust").map((x) => x.id), [e3.id, e2.id, e1.id]);
      assert.deepEqual((await repo.listEntries(REPO_DAY, "2026-10-13", student.id)).map((x: EntryRow) => x.id), [e2.id]);
      assert.equal((await repo.listEntries("2026-10-13", "2026-10-14", null)).length, 0);
      assert.equal(await repo.hasAnyEntry(), true);
      assert.equal(await repo.lastUsedAccountId(), bank.id); // 最近建立的非精算
      assert.deepEqual(await repo.recentCategoryIds("expense", 5), [lunch.id]);
      assert.deepEqual(await repo.recentCategoryIds("income", 5), []); // 未分類不算

      const u1 = await repo.updateEntry(e1.id, { note: "午餐便當" });
      assert.equal(u1.note, "午餐便當");
      assert.equal(u1.main_minor, 8000);
      assert.equal((await repo.getEntry(e1.id)).note, "午餐便當");
      const same = await repo.updateEntry(e1.id, { note: "午餐便當" });
      assert.equal(same.updated_at, u1.updated_at); // 沒變 ⇒ 不寫

      await repo.softDeleteEntry(e2.id);
      assert.equal(await repo.getEntry(e2.id), null);
      assert.equal((await repo.balances())[student.id], 0);
      await repo.restoreEntry(e2.id);
      assert.equal((await repo.balances())[student.id], 50000);

      assert.equal(await repo.adjustBalance(cash.id, want[cash.id], REPO_DAY, "對帳"), null);
      const adj = await repo.adjustBalance(cash.id, 10000, REPO_DAY, "對帳");
      assert.equal(adj.kind, "adjust");
      assert.equal(adj.amount_minor, 10000 - want[cash.id]);
      assert.equal((await repo.balances())[cash.id], 10000);

      const bankIds = async () =>
        (await repo.listAccounts()).filter((a: AccountRow) => a.group_key === "bank").map((a: AccountRow) => a.id);
      await repo.moveAccount(bank.id, -1);
      assert.deepEqual(await bankIds(), [bank.id, student.id, usdAcc.id]);
      await repo.moveAccount(bank.id, -1); // 到邊界＝不動
      assert.deepEqual(await bankIds(), [bank.id, student.id, usdAcc.id]);
      await repo.setAccountArchived(usdAcc.id, true);
      assert.notEqual((await repo.listAccounts()).find((a: AccountRow) => a.id === usdAcc.id).archived_at, null);
      await repo.updateAccount(usdAcc.id, { group: "cash" });
      const moved = (await repo.listAccounts()).find((a: AccountRow) => a.id === usdAcc.id);
      assert.deepEqual([moved.group_key, moved.position], ["cash", 1]);

      // 分類封存：先單獨封存「晚餐」，再封存主分類；取消封存只帶回同一刻連帶封存的「午餐」
      const dinner = await repo.createCategory({ kind: "expense", name: "晚餐", parentId: food.id });
      await repo.setCategoryArchived(dinner.id, true);
      await repo.setCategoryArchived(food.id, true);
      const cats1: CategoryRow[] = await repo.listCategories();
      const f1 = cats1.find((c) => c.id === food.id)!;
      assert.notEqual(f1.archived_at, null);
      assert.equal(cats1.find((c) => c.id === lunch.id)!.archived_at, f1.archived_at);
      assert.notEqual(cats1.find((c) => c.id === dinner.id)!.archived_at, f1.archived_at);
      await repo.setCategoryArchived(food.id, false);
      const cats2: CategoryRow[] = await repo.listCategories();
      assert.equal(cats2.find((c) => c.id === food.id)!.archived_at, null);
      assert.equal(cats2.find((c) => c.id === lunch.id)!.archived_at, null);
      assert.notEqual(cats2.find((c) => c.id === dinner.id)!.archived_at, null);
      const traffic = await repo.createCategory({ kind: "expense", name: "🚖 交通", parentId: null });
      await repo.moveCategory(traffic.id, -1);
      const tops = (await repo.listCategories()).filter((c: CategoryRow) => c.kind === "expense" && c.parent_id === null);
      assert.deepEqual(tops.map((c: CategoryRow) => c.id), [traffic.id, food.id, UNCAT_EXPENSE_ID]);

      // 匯入：第一次全寫、重跑新增 0、import2 已修改 2
      const { mockImportDump } = await import("../../src/data/memoryTicketRepository.ts");
      const dump: MmbakDump = mockImportDump("base");
      const plan = planImport(dump, await repo.loadImportLocal(), { balanceText: {}, nowIso: NOW });
      const progress: [number, number][] = [];
      const out = await repo.applyImport(plan, defaultChoices(plan), EMPTY_PART, (d: number, t: number) => progress.push([d, t]));
      const n = plan.entries.inserts.length;
      assert.ok(n > 100);
      assert.deepEqual(out, {
        inserted: n,
        updated: 0,
        skipped: plan.entries.unchanged + plan.entries.tombstoned + plan.entries.invalid.length,
        budgets: 0,
        repeats: 0,
      });
      assert.deepEqual(progress[0], [0, n]);
      assert.deepEqual(progress[progress.length - 1], [n, n]);
      const local1: ImportLocal = await repo.loadImportLocal();
      assert.equal(local1.entries.filter((x) => x.import_source === "moneymanager").length, n);
      const again = planImport(dump, local1, { balanceText: {}, nowIso: NOW });
      assert.deepEqual([again.entries.inserts.length, again.entries.changed.length], [0, 0]);
      const plan2 = planImport(mockImportDump("import2"), local1, { balanceText: {}, nowIso: NOW });
      assert.equal(plan2.entries.changed.length, 2);
      const out2 = await repo.applyImport(plan2, defaultChoices(plan2), EMPTY_PART, () => {});
      assert.equal(out2.updated, 2);
      const plan3 = planImport(mockImportDump("import2"), await repo.loadImportLocal(), { balanceText: {}, nowIso: NOW });
      assert.equal(plan3.entries.changed.length, 0);
      // 匯入後 SQL 聚合仍與 balancesOf 同義
      const pure2 = balancesOf((await repo.loadImportLocal()).entries);
      const sql2: Record<string, number> = await repo.balances();
      for (const id of Object.keys(sql2)) assert.equal(sql2[id], pure2[id] ?? 0);
    });

    test(`17e. 匯入「已修改」選留 Next Stop 的 ⇒ 蓋 import_utime 記號、下次重跑不再列、內容不動（${impl.name}）`, async () => {
      const { repo } = await impl.make();
      await repo.ensureStarterRows();
      const { mockImportDump } = await import("../../src/data/memoryTicketRepository.ts");
      const plan = planImport(mockImportDump("base"), await repo.loadImportLocal(), { balanceText: {}, nowIso: NOW });
      await repo.applyImport(plan, defaultChoices(plan), EMPTY_PART, () => {});
      const local1: ImportLocal = await repo.loadImportLocal();
      const plan2 = planImport(mockImportDump("import2"), local1, { balanceText: {}, nowIso: NOW });
      assert.equal(plan2.entries.changed.length, 2);
      const [keep, take] = plan2.entries.changed;
      const out = await repo.applyImport(plan2, { [keep.id]: "ours", [take.id]: "theirs" }, EMPTY_PART, () => {});
      assert.equal(out.updated, 1, "留本機的不算 updated");
      const local2: ImportLocal = await repo.loadImportLocal();
      const keptRow = local2.entries.find((x) => x.id === keep.id)!;
      const keptBefore = local1.entries.find((x) => x.id === keep.id)!;
      assert.equal(keptRow.import_utime, keep.incoming.import_utime, "記號＝這次備份的 UTIME");
      assert.notEqual(keptRow.updated_at, keptBefore.updated_at);
      assert.deepEqual({ ...keptRow, import_utime: 0, updated_at: "" }, { ...keptBefore, import_utime: 0, updated_at: "" }, "留本機 ⇒ 內容欄不變");
      assert.equal(local2.entries.find((x) => x.id === take.id)!.note, take.incoming.note);
      const plan3 = planImport(mockImportDump("import2"), local2, { balanceText: {}, nowIso: NOW });
      assert.equal(plan3.entries.changed.length, 0, "同一版重跑不再列為已修改");
    });

    test(`17f. 「上一筆帳戶」「最近分類」在 created_at 全同（匯入）時有決定性次序（${impl.name}）`, async () => {
      const { repo, db } = await impl.make();
      await repo.ensureStarterRows();
      const a1 = await repo.createAccount(newAcc("甲", "cash"));
      const a2 = await repo.createAccount(newAcc("乙", "cash"));
      const food = await repo.createCategory({ kind: "expense", name: "食物", parentId: null });
      const c1 = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });
      const c2 = await repo.createCategory({ kind: "expense", name: "交通", parentId: null });
      const c3 = await repo.createCategory({ kind: "expense", name: "娛樂", parentId: null });
      // 三筆建好後把 created_at 全壓成同一值（匯入列的樣子），靠 occurred_on／occurred_at／id 破平手
      const mk = async (accountId: string, categoryId: string, on: string, at: string) =>
        repo.createEntry(newEntry({ accountId, categoryId, occurredOn: on, occurredAt: at }));
      const x1 = await mk(a2.id, c1.id, "2026-10-01", new Date(2026, 9, 1, 9).toISOString());
      const x2 = await mk(a2.id, c2.id, "2026-10-03", new Date(2026, 9, 3, 9).toISOString());
      const x3 = await mk(a1.id, c3.id, "2026-10-03", new Date(2026, 9, 3, 18).toISOString()); // 同日、時刻較晚
      const x4 = await mk(a2.id, c1.id, "2026-10-02", new Date(2026, 9, 2, 9).toISOString()); // c1 的最新一筆
      const SAME = "2026-10-05T00:00:00.000Z";
      const ids = [x1, x2, x3, x4].map((x) => x.id);
      if (db) {
        for (const id of ids) await db.execute("UPDATE tk_entries SET created_at = $1 WHERE id = $2", [SAME, id]);
      } else {
        // memory 的 getEntry 回 clone，直接改內部表
        for (const id of ids) (repo as unknown as { ent: Map<string, EntryRow> }).ent.get(id)!.created_at = SAME;
      }
      // 順序（新→舊）：x3(10/03 18:00)、x2(10/03 09:00)、x4(10/02)、x1(10/01) ⇒ 最後帳戶＝a1；分類 c3, c2, c1
      assert.equal(await repo.lastUsedAccountId(), a1.id);
      assert.deepEqual(await repo.recentCategoryIds("expense", 5), [c3.id, c2.id, c1.id]);
      // 每個分類取自己最新的一筆（c1 取 x4 而非 x1），所以 c1 排在 c2 之後
      assert.deepEqual(await repo.recentCategoryIds("expense", 2), [c3.id, c2.id]);
      // 發生日、時刻也全同 ⇒ 看 id：id 大的算較新
      const same = new Date(2026, 9, 9, 9).toISOString();
      const y1 = await mk(a1.id, c1.id, "2026-10-09", same);
      const y2 = await mk(a2.id, c2.id, "2026-10-09", same);
      for (const id of [y1.id, y2.id]) {
        if (db) await db.execute("UPDATE tk_entries SET created_at = $1 WHERE id = $2", [SAME, id]);
        else (repo as unknown as { ent: Map<string, EntryRow> }).ent.get(id)!.created_at = SAME;
      }
      const hi = y1.id > y2.id ? y1 : y2;
      const lo = hi === y1 ? y2 : y1;
      assert.equal(await repo.lastUsedAccountId(), hi.account_id);
      assert.deepEqual((await repo.recentCategoryIds("expense", 2)), [hi.category_id, lo.category_id]);
    });
  }

  test("17d. sqlite 的 op：新列送 ticket.rs 白名單完整列、改列只送改到的欄、軟刪 delete op、復原 upsert", async () => {
    const { repo, db } = await IMPLS[1].make();
    const ops = db!.ops;
    await repo.ensureStarterRows();
    assert.deepEqual(
      ops.map((o) => [o.tbl, o.row_id]),
      [
        ["tk_currencies", CURRENCY_TWD_ID],
        ["tk_categories", UNCAT_INCOME_ID],
        ["tk_categories", UNCAT_EXPENSE_ID],
      ],
    );
    assert.deepEqual(Object.keys(ops[0].cols), rustCols("TK_CURRENCIES_COLS"));
    assert.deepEqual(Object.keys(ops[1].cols), rustCols("TK_CATEGORIES_COLS"));
    assert.equal(ops[0].cols.deleted_at, null);
    assert.equal(ops[0].cols.is_main, 1);

    const cash = await repo.createAccount(newAcc("現金", "cash", "TWD", 5000));
    const accOp = ops[ops.length - 2];
    const openOp = ops[ops.length - 1];
    assert.deepEqual([accOp.tbl, openOp.tbl], ["tk_accounts", "tk_entries"]); // 父先子後
    assert.deepEqual(Object.keys(accOp.cols), rustCols("TK_ACCOUNTS_COLS"));
    assert.deepEqual(Object.keys(openOp.cols), rustCols("TK_ENTRIES_COLS"));
    assert.equal(openOp.cols.kind, "adjust");

    const e = await repo.createEntry(newEntry({ accountId: cash.id }));
    const n0 = ops.length;
    await repo.updateEntry(e.id, { note: "便當" });
    assert.equal(ops.length, n0 + 1);
    assert.deepEqual(Object.keys(ops[n0].cols).sort(), ["note", "updated_at"]);
    await repo.updateEntry(e.id, { note: "便當" });
    assert.equal(ops.length, n0 + 1, "沒變 ⇒ 不送 op");
    await repo.softDeleteEntry(e.id);
    assert.equal(ops[n0 + 1].op, "delete");
    assert.deepEqual(Object.keys(ops[n0 + 1].cols).sort(), ["deleted_at", "updated_at"]);
    await repo.softDeleteEntry(e.id);
    assert.equal(ops.length, n0 + 2, "已刪再刪 ⇒ 不送 op");
    await repo.restoreEntry(e.id);
    assert.equal(ops[n0 + 2].op, "upsert");
    assert.equal(ops[n0 + 2].cols.deleted_at, null);
    await repo.moveAccount(cash.id, 1);
    assert.equal(ops.length, n0 + 3, "到邊界 ⇒ 不送 op");

    // 刪過的幣別再建 ⇒ 同一個確定性 id 復活（created_at 保留）
    const usd = await repo.createCurrency({ code: "USD", name: "", decimals: 2, rate: "31.5" });
    await db!.execute("UPDATE tk_currencies SET deleted_at = $1 WHERE id = $2", [NOW, usd.id]);
    const again = await repo.createCurrency({ code: "USD", name: "美金", decimals: 2, rate: "32" });
    assert.equal(again.id, usd.id);
    assert.equal(again.created_at, usd.created_at);
    const list: CurrencyRow[] = await repo.listCurrencies();
    assert.deepEqual(
      list.map((c) => [c.code, c.rate_to_main, c.name]),
      [
        ["TWD", "1", "新台幣"],
        ["USD", "32", "美金"],
      ],
    );
  });
});
