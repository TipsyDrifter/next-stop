/**
 * v1.33 資料層測試（售票口）：ticket_month_start_day 同步鍵與 setMainCurrency 原子切換主幣別。
 * SQLite 版（node:sqlite + 全套 0001–0023 migrations）與記憶體版跑同一套斷言。
 * 跑法：`node --test scripts/tests/v133-schema-ticket.test.ts`
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.now() - 1000 * 60 * 60 * 24;
export function getDb() { const d = globalThis.__v133TkDb; if (!d) throw new Error("測試沒設 __v133TkDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function ensureSyncTables() { return false; }
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

type Op = { tbl: string; row_id: string; op: string; cols: Record<string, unknown> };
function makeDb() {
  const raw = new DatabaseSync(":memory:");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(path.join(dir, f), "utf8"));
  }
  raw.exec("PRAGMA foreign_keys = OFF");
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  return {
    batches: [] as Op[][],
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]) {
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args ?? []));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
      this.batches.push(ops);
    },
  };
}

const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
const { MemoryTicketRepository } = await import("../../src/data/memoryTicketRepository.ts");
const { SYNC_SETTINGS_KEYS } = await import("../../src/data/syncTables.ts");
const { UNCAT_EXPENSE_ID, WR_KIND_BUY_ID } = await import("../../src/domain/ticket.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
type Maker = () => { repo: Repo; db: ReturnType<typeof makeDb> | null };
const makers: [string, Maker][] = [
  [
    "sqlite",
    () => {
      const db = makeDb();
      (globalThis as Record<string, unknown>).__v133TkDb = db;
      return { repo: new SqliteTicketRepository(), db };
    },
  ],
  ["memory", () => ({ repo: new MemoryTicketRepository({ seedDemo: false }), db: null })],
];

test("SYNC_SETTINGS_KEYS 包含 ticket_month_start_day，且不將隱私遮罩與密碼鎖進雲端同步", () => {
  assert.ok(SYNC_SETTINGS_KEYS.includes("ticket_month_start_day"));
  assert.equal(SYNC_SETTINGS_KEYS.includes("ticket_privacy_masked"), false);
  assert.equal(SYNC_SETTINGS_KEYS.includes("ticket_lock_pin_hash"), false);
});

for (const [name, make] of makers) {
  describe(`${name}：setMainCurrency 原子切換主幣別`, () => {
    test("反算匯率、重算歷史帳目 main_minor 與預算／願望金額、並單批寫入 outbox", async () => {
      const { repo, db } = make();
      await repo.ensureStarterRows();
      await repo.createCurrency({ code: "USD", name: "美元", decimals: 2, rate: "31.5" });
      await repo.createCurrency({ code: "JPY", name: "日圓", decimals: 0, rate: "0.21" });
      const acc = await repo.createAccount({
        name: "銀行",
        group: "bank",
        currency: "TWD",
        openingMinor: null,
        occurredOn: "2026-11-01",
      });

      const eTwd = await repo.createEntry({
        kind: "expense",
        amountMinor: 3150, // NT$31.50 -> 1.00 USD
        currency: "TWD",
        accountId: acc.id,
        toAccountId: null,
        categoryId: UNCAT_EXPENSE_ID,
        occurredOn: "2026-11-10",
        occurredAt: "2026-11-10T10:00:00.000Z",
        note: "咖啡",
        routeId: null,
      });
      const eUsd = await repo.createEntry({
        kind: "expense",
        amountMinor: 1000, // US$10.00
        currency: "USD",
        accountId: acc.id,
        toAccountId: null,
        categoryId: UNCAT_EXPENSE_ID,
        occurredOn: "2026-11-11",
        occurredAt: "2026-11-11T10:00:00.000Z",
        note: "訂閱",
        routeId: null,
      });
      const eJpy = await repo.createEntry({
        kind: "expense",
        amountMinor: 3150, // ¥3150 (decimals=0) -> 661.5 TWD -> 21.00 USD (2100 minor)
        currency: "JPY",
        accountId: acc.id,
        toAccountId: null,
        categoryId: UNCAT_EXPENSE_ID,
        occurredOn: "2026-11-12",
        occurredAt: "2026-11-12T10:00:00.000Z",
        note: "拉麵",
        routeId: null,
      });
      const eDel = await repo.createEntry({
        kind: "expense",
        amountMinor: 9999,
        currency: "TWD",
        accountId: acc.id,
        toAccountId: null,
        categoryId: UNCAT_EXPENSE_ID,
        occurredOn: "2026-11-12",
        occurredAt: "2026-11-12T11:00:00.000Z",
        note: "已刪",
        routeId: null,
      });
      await repo.softDeleteEntry(eDel.id);

      const bud = await repo.setBudget({ kind: "total" }, null, 315000); // NT$3,150 -> US$100.00 (10000 minor)
      const wish = await repo.createWish({ name: "耳機", amountMinor: 63000, note: "", categoryId: null, kindId: WR_KIND_BUY_ID }); // NT$630 -> US$20.00 (2000 minor)

      const batchesBefore = db?.batches.length ?? 0;
      await repo.setMainCurrency("usd");

      const curs = await repo.listCurrencies();
      const twd = curs.find((c: { code: string }) => c.code === "TWD");
      const usd = curs.find((c: { code: string }) => c.code === "USD");
      const jpy = curs.find((c: { code: string }) => c.code === "JPY");
      assert.equal(usd.is_main, 1);
      assert.equal(usd.rate_to_main, "1");
      assert.equal(twd.is_main, 0);
      assert.equal(twd.rate_to_main, "0.0317460317");
      assert.equal(jpy.is_main, 0);
      assert.equal(jpy.rate_to_main, "0.0066666667");

      const entries = await repo.listEntries("2026-11-01", "2026-12-01", null);
      assert.equal(entries.find((e: { id: string }) => e.id === eTwd.id).main_minor, 100);
      assert.equal(entries.find((e: { id: string }) => e.id === eUsd.id).main_minor, 1000);
      assert.equal(entries.find((e: { id: string }) => e.id === eJpy.id).main_minor, 2100);

      const budgets = await repo.listBudgets();
      assert.equal(budgets.find((b: { id: string }) => b.id === bud.id).amount_minor, 10000);

      const wishes = await repo.listWishes();
      assert.equal(wishes.find((w: { id: string }) => w.id === wish.id).amount_minor, 2000);

      if (db) {
        assert.equal(db.batches.length, batchesBefore + 1, "必須在單一 WriteBatch 原子寫入");
        const ops = db.batches[db.batches.length - 1];
        assert.ok(ops.some((o) => o.tbl === "tk_currencies" && o.row_id === usd.id && o.cols.is_main === 1));
        assert.ok(ops.some((o) => o.tbl === "tk_entries" && o.row_id === eTwd.id && o.cols.main_minor === 100));
        assert.ok(ops.some((o) => o.tbl === "tk_budgets" && o.row_id === bud.id && o.cols.amount_minor === 10000));
        assert.ok(ops.some((o) => o.tbl === "tk_wishes" && o.row_id === wish.id && o.cols.amount_minor === 2000));
        assert.equal(ops.some((o) => o.row_id === eDel.id), false, "已刪帳目不動");
      }

      // 切回已為主幣別 ⇒ 冪等不動
      const batchesAfterSwitch = db?.batches.length ?? 0;
      await repo.setMainCurrency("USD");
      if (db) assert.equal(db.batches.length, batchesAfterSwitch);

      // 切回 TWD ⇒ TWD 帳目 main_minor 精準還原為原幣 amount_minor
      await repo.setMainCurrency("TWD");
      const restoredEntries = await repo.listEntries("2026-11-01", "2026-12-01", null);
      assert.equal(restoredEntries.find((e: { id: string }) => e.id === eTwd.id).main_minor, 3150);

      // 不存在的幣別 ⇒ RangeError
      await assert.rejects(() => repo.setMainCurrency("EUR"), RangeError);
    });
  });
}
