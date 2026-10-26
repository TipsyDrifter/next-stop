/** 帳目 MCP 工具（src/mcp/tools/ledger.ts）：memory repository 跑讀寫、參數錯誤、陣列上限。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, makeCtx } from "./mcp-ctx.ts";
import type { McpCtx, McpTool } from "../../src/mcp/types.ts";

const { LEDGER_TOOLS } = await load<typeof import("../../src/mcp/tools/ledger.ts")>("../../src/mcp/tools/ledger.ts");
const { McpUserError } = await load<typeof import("../../src/mcp/types.ts")>("../../src/mcp/types.ts");
const { UNCAT_EXPENSE_ID } = await load<typeof import("../../src/domain/ticket.ts")>("../../src/domain/ticket.ts");

const tool = (name: string): McpTool => {
  const t = LEDGER_TOOLS.find((x) => x.name === name);
  assert.ok(t, name);
  return t;
};
const run = (name: string, args: Record<string, unknown>, ctx: McpCtx) => tool(name).run(args, ctx);
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 固定在 2026-10-15 14:00（日界線 6）；帳戶：錢包（TWD，期初 1000）、美金戶（USD）、封存戶；分類：餐飲›午餐、薪水 */
async function setup() {
  const ctx = await makeCtx({ now: new Date(2026, 9, 15, 14, 0) });
  const repo = ctx.deps.ticketRepo;
  await repo.ensureStarterRows();
  await repo.createCurrency({ code: "USD", name: "美元", decimals: 2, rate: "32" });
  await repo.createCurrency({ code: "JPY", name: "日圓", decimals: 0, rate: "0.21" });
  const wallet = await repo.createAccount({ name: "錢包", group: "cash", currency: "TWD", openingMinor: 100000, occurredOn: "2026-10-01" });
  const usd = await repo.createAccount({ name: "美金戶", group: "bank", currency: "USD", openingMinor: null, occurredOn: "2026-10-01" });
  const old = await repo.createAccount({ name: "舊卡", group: "card", currency: "TWD", openingMinor: null, occurredOn: "2026-10-01" });
  await repo.setAccountArchived(old.id, true);
  const food = await repo.createCategory({ kind: "expense", name: "餐飲", parentId: null });
  const lunch = await repo.createCategory({ kind: "expense", name: "午餐", parentId: food.id });
  const salary = await repo.createCategory({ kind: "income", name: "薪水", parentId: null });
  return { ctx, repo, wallet, usd, old, food, lunch, salary };
}

async function rejects(p: Promise<unknown>, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof McpUserError, `不是 McpUserError：${String(e)}`);
    if (re) assert.match((e as Error).message, re);
    return true;
  });
}

test("工具 spec：名稱、module、access、annotations、描述長度", () => {
  assert.deepEqual(
    LEDGER_TOOLS.map((t) => t.name),
    ["find-accounts", "find-ledger-categories", "find-ledger-entries", "get-spending-summary", "add-ledger-entries", "update-ledger-entries", "delete-ledger-entries"],
  );
  for (const t of LEDGER_TOOLS) {
    assert.equal(t.module, "ledger");
    assert.ok(t.description.length <= 400, t.name);
    assert.equal(t.annotations.openWorldHint, false);
    const read = t.name.startsWith("find-") || t.name.startsWith("get-");
    assert.equal(t.access, read ? "read" : "write");
    assert.equal(t.annotations.readOnlyHint, read);
    assert.equal(t.annotations.destructiveHint, t.name.startsWith("update-") || t.name.startsWith("delete-"));
  }
});

test("find-accounts：餘額、封存、幣別、淨資產", async () => {
  const { ctx, wallet, old } = await setup();
  const out = await run("find-accounts", {}, ctx);
  const d = out.data as Any;
  assert.equal(d.mainCurrency, "TWD");
  const w = d.accounts.find((a: Any) => a.id === wallet.id);
  assert.deepEqual(w, { id: wallet.id, name: "錢包", group: "現金", currency: "TWD", balance: 1000 });
  assert.equal(d.accounts.find((a: Any) => a.id === old.id).archived, true);
  assert.equal(d.totals.net, 1000);
  assert.ok(d.currencies.some((c: Any) => c.code === "TWD" && c.main));
  assert.match(out.summary, /3 個帳戶（1 個封存）/);
  const live = (await run("find-accounts", { includeArchived: false }, ctx)).data as Any;
  assert.equal(live.accounts.length, 2);
  await rejects(run("find-accounts", { includeArchived: "yes" }, ctx));
});

test("find-ledger-categories：兩層、kind、關鍵字、封存", async () => {
  const { ctx, repo, food, lunch, salary } = await setup();
  const all = (await run("find-ledger-categories", {}, ctx)).data as Any;
  const l = all.categories.find((c: Any) => c.id === lunch.id);
  assert.deepEqual(l, { id: lunch.id, kind: "expense", name: "餐飲 › 午餐", parentId: food.id });
  assert.ok(all.categories.some((c: Any) => c.id === UNCAT_EXPENSE_ID));
  const inc = (await run("find-ledger-categories", { kind: "income" }, ctx)).data as Any;
  assert.ok(inc.categories.every((c: Any) => c.kind === "income"));
  assert.ok(inc.categories.some((c: Any) => c.id === salary.id));
  const q = (await run("find-ledger-categories", { query: "午" }, ctx)).data as Any;
  assert.deepEqual(q.categories.map((c: Any) => c.id), [lunch.id]);
  await repo.setCategoryArchived(salary.id, true);
  const hid = (await run("find-ledger-categories", { kind: "income" }, ctx)).data as Any;
  assert.ok(!hid.categories.some((c: Any) => c.id === salary.id));
  const shown = (await run("find-ledger-categories", { kind: "income", includeArchived: true }, ctx)).data as Any;
  assert.equal(shown.categories.find((c: Any) => c.id === salary.id).archived, true);
  await rejects(run("find-ledger-categories", { kind: "transfer" }, ctx), /kind/);
});

test("add-ledger-entries：金額換 minor、預設值、讀得回來", async () => {
  const { ctx, repo, wallet, lunch, salary } = await setup();
  const out = await run(
    "add-ledger-entries",
    {
      entries: [
        { amount: 120.5, categoryId: lunch.id, note: "便當", time: "12:30" },
        { kind: "income", amount: "50000", accountId: wallet.id, categoryId: salary.id, date: "2026-10-05" },
        { amount: 80, time: "25:10" },
      ],
    },
    ctx,
  );
  assert.deepEqual(out.changed, ["tk_entries"]);
  assert.match(out.toast ?? "", /3 筆/);
  const es = (out.data as Any).entries;
  assert.equal(es[0].amount, 120.5);
  assert.equal(es[0].category, "餐飲 › 午餐");
  assert.equal(es[0].date, "2026-10-15");
  assert.equal(es[0].time, "12:30");
  assert.equal(es[0].account, "錢包");
  assert.equal(es[2].time, "25:10");
  assert.equal(es[2].category, "未分類");
  const row = await repo.getEntry(es[0].id);
  assert.equal(row?.amount_minor, 12050);
  assert.equal(row?.note, "便當");
  // 25:10 ＝ 營業日 10-15 的隔天凌晨 01:10
  const late = await repo.getEntry(es[2].id);
  assert.equal(late?.occurred_on, "2026-10-15");
  assert.equal(new Date(late!.occurred_at).getDate(), 16);
  // 時刻省略＝現在
  const inc = await repo.getEntry(es[1].id);
  assert.equal(new Date(inc!.occurred_at).getHours(), 14);

  const found = (await run("find-ledger-entries", { from: "2026-10-01", to: "2026-10-15" }, ctx)).data as Any;
  assert.equal(found.total, 4); // 3 筆＋期初餘額調整
  assert.equal(found.expense, 200.5);
  assert.equal(found.income, 50000);
  const bal = (await run("find-accounts", {}, ctx)).data as Any;
  assert.equal(bal.accounts.find((a: Any) => a.id === wallet.id).balance, 1000 - 200.5 + 50000);
});

test("add-ledger-entries：轉帳、外幣、退款", async () => {
  const { ctx, repo, wallet, usd } = await setup();
  const out = await run(
    "add-ledger-entries",
    {
      entries: [
        { kind: "transfer", amount: 3200, accountId: wallet.id, toAccountId: usd.id, toAmount: 100 },
        { amount: 10, accountId: usd.id, note: "咖啡" },
        { amount: -30, note: "退款" },
        { amount: 500, currency: "JPY" },
      ],
    },
    ctx,
  );
  const [t, c, r, j] = (out.data as Any).entries;
  assert.equal(t.kind, "transfer");
  assert.equal(t.toAmount, 100);
  assert.equal(t.toCurrency, "USD");
  assert.equal(c.currency, "USD");
  assert.equal(c.mainAmount, 320);
  assert.equal(r.amount, -30);
  assert.equal(j.currency, "JPY");
  assert.equal(j.mainAmount, 105);
  const bal = await repo.balances();
  assert.equal(bal[usd.id], 10000 - 1000);
});

test("add-ledger-entries：參數錯誤整批不寫", async () => {
  const { ctx, repo, wallet, old, lunch, salary } = await setup();
  const before = (await repo.listEntries("2000-01-01", "2100-01-01", null)).length;
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ amount: 1.234 }, /最多 2 位小數/],
    [{ amount: 0 }, /不能是 0/],
    [{ amount: "abc" }, /金額/],
    [{ kind: "income", amount: -5 }, /大於 0/],
    [{ amount: 5, accountId: "nope" }, /找不到帳戶/],
    [{ amount: 5, accountId: old.id }, /封存/],
    [{ amount: 5, categoryId: salary.id }, /收入分類/],
    [{ amount: 5, categoryId: "nope" }, /找不到分類/],
    [{ kind: "transfer", amount: 5 }, /轉入帳戶/],
    [{ kind: "transfer", amount: 5, accountId: wallet.id, toAccountId: wallet.id }, /同一個帳戶/],
    [{ amount: 5, toAccountId: wallet.id }, /只有轉帳/],
    [{ amount: 5, currency: "EUR" }, /沒有這個幣別/],
    [{ amount: 5, date: "2026/10/01" }, /YYYY-MM-DD/],
    [{ amount: 5, time: "31:00" }, /HH:MM/],
    [{ amount: 5, routeId: "nope" }, /找不到路線/],
    [{ amount: 5, kind: "adjust" }, /kind/],
  ];
  for (const [item, re] of bad) await rejects(run("add-ledger-entries", { entries: [{ amount: 1, categoryId: lunch.id }, item] }, ctx), re);
  await rejects(run("add-ledger-entries", { entries: [] }, ctx), /至少一筆/);
  await rejects(run("add-ledger-entries", { entries: Array.from({ length: 51 }, () => ({ amount: 1 })) }, ctx), /最多 50 筆/);
  await rejects(run("add-ledger-entries", {}, ctx), /陣列/);
  assert.equal((await repo.listEntries("2000-01-01", "2100-01-01", null)).length, before);
  // 剛好 50 筆可以
  const ok = await run("add-ledger-entries", { entries: Array.from({ length: 50 }, () => ({ amount: 1 })) }, ctx);
  assert.equal((ok.data as Any).entries.length, 50);
});

test("add-ledger-entries：沒有帳戶時說清楚；起手列會補", async () => {
  const ctx = await makeCtx({ now: new Date(2026, 9, 15, 14, 0) });
  await rejects(run("add-ledger-entries", { entries: [{ amount: 1 }] }, ctx), /還沒有帳戶/);
  assert.ok((await ctx.deps.ticketRepo.listCurrencies()).some((c) => c.code === "TWD"));
});

test("find-ledger-entries：帳戶、分類含子分類、種類、關鍵字、區間上限、截斷", async () => {
  const { ctx, wallet, usd, food, lunch } = await setup();
  await run(
    "add-ledger-entries",
    {
      entries: [
        { amount: 100, categoryId: lunch.id, note: "拉麵", date: "2026-10-10" },
        { amount: 50, categoryId: food.id, note: "飲料", date: "2026-10-11" },
        { amount: 7, accountId: usd.id, note: "書", date: "2026-10-12" },
        { kind: "transfer", amount: 320, accountId: wallet.id, toAccountId: usd.id, date: "2026-10-12" },
      ],
    },
    ctx,
  );
  const q = async (a: Record<string, unknown>) => ((await run("find-ledger-entries", { from: "2026-10-01", to: "2026-10-31", ...a }, ctx)).data as Any).entries;
  assert.equal((await q({ categoryId: food.id })).length, 2);
  assert.equal((await q({ categoryId: lunch.id })).length, 1);
  assert.equal((await q({ accountId: usd.id })).length, 2); // 含轉入
  assert.equal((await q({ kind: "transfer" })).length, 1);
  assert.equal((await q({ kind: "adjust" })).length, 1);
  assert.deepEqual((await q({ query: "拉麵" })).map((e: Any) => e.note), ["拉麵"]);
  assert.equal((await q({ query: "100" })).length, 1); // 數字比金額
  assert.equal((await q({ query: "午餐" })).length, 1); // 比分類名
  assert.equal((await q({ query: "!!" })).length, 0);
  const all = await q({});
  assert.deepEqual(all.map((e: Any) => e.date), [...all.map((e: Any) => e.date)].sort().reverse()); // 新到舊
  const lim = (await run("find-ledger-entries", { from: "2026-10-01", to: "2026-10-31", limit: 2 }, ctx)) as Any;
  assert.equal(lim.data.entries.length, 2);
  assert.equal(lim.data.truncated, true);
  assert.match(lim.summary, /只列最新 2 筆/);
  // 預設＝到今天的 30 天
  const def = (await run("find-ledger-entries", {}, ctx)).data as Any;
  assert.equal(def.to, "2026-10-15");
  assert.equal(def.from, "2026-09-16");
  await rejects(run("find-ledger-entries", { from: "2026-01-01", to: "2026-10-01" }, ctx), /最多查 92 天/);
  await rejects(run("find-ledger-entries", { from: "2026-10-05", to: "2026-10-01" }, ctx), /不能晚於/);
  await rejects(run("find-ledger-entries", { accountId: "nope" }, ctx), /找不到帳戶/);
  await rejects(run("find-ledger-entries", { limit: 101 }, ctx), /不能大於/);
  await rejects(run("find-ledger-entries", { kind: "x" }, ctx), /kind/);
});

test("get-spending-summary：分類合計（含子分類）、預算、年模式", async () => {
  const { ctx, repo, food, lunch, salary } = await setup();
  await repo.setBudget({ kind: "total" }, null, 50000);
  await repo.setBudget({ kind: "category", categoryId: food.id }, null, 1000000);
  await run(
    "add-ledger-entries",
    {
      entries: [
        { amount: 100, categoryId: lunch.id, date: "2026-10-10" },
        { amount: 50, categoryId: food.id, date: "2026-10-11" },
        { amount: 30, date: "2026-10-12" },
        { kind: "income", amount: 1000, categoryId: salary.id, date: "2026-10-05" },
        { amount: 999, date: "2026-09-30" },
      ],
    },
    ctx,
  );
  const out = await run("get-spending-summary", {}, ctx);
  const d = out.data as Any;
  assert.equal(d.period, "2026-10");
  assert.equal(d.expense, 180);
  assert.equal(d.income, 1000);
  assert.equal(d.net, 820);
  assert.equal(d.count, 4);
  const f = d.expenseByCategory.find((r: Any) => r.categoryId === food.id);
  assert.equal(f.amount, 150);
  assert.equal(f.children.length, 2); // 午餐＋未細分
  assert.equal(d.incomeByCategory[0].categoryId, salary.id);
  const total = d.budgets.find((b: Any) => b.name === "總預算");
  assert.deepEqual([total.budget, total.used, total.remaining, total.usedPct], [500, 180, 320, 36]);
  assert.equal(total.timePct, Math.round((15 / 31) * 100));
  const fb = d.budgets.find((b: Any) => b.categoryId === food.id);
  assert.equal(fb.used, 150);
  assert.match(out.summary, /預算 2 項，都沒超支/);
  const sep = (await run("get-spending-summary", { month: "2026-09" }, ctx)).data as Any;
  assert.equal(sep.expense, 999);
  const yr = (await run("get-spending-summary", { year: "2026" }, ctx)).data as Any;
  assert.equal(yr.expense, 1179);
  assert.equal(yr.budgets, undefined);
  await rejects(run("get-spending-summary", { month: "2026-13" }, ctx), /YYYY-MM/);
  await rejects(run("get-spending-summary", { month: "2026-10", year: "2026" }, ctx), /只能給一個/);
});

test("update-ledger-entries：部分欄位、改分類／種類／日期、讀得回來", async () => {
  const { ctx, repo, wallet, usd, lunch, salary } = await setup();
  const added = (await run(
    "add-ledger-entries",
    {
      entries: [
        { amount: 100, categoryId: lunch.id, note: "拉麵", time: "12:00" },
        { amount: 10, accountId: usd.id },
      ],
    },
    ctx,
  )) as Any;
  const [a, b] = added.data.entries;
  const out = await run(
    "update-ledger-entries",
    {
      entries: [
        { id: a.id, amount: 88, note: "沾麵", date: "2026-10-14" },
        { id: b.id, accountId: wallet.id }, // 換帳戶 ⇒ 幣別、金額都不動（同桌機 TicketPanel 只送 accountId）
      ],
    },
    ctx,
  );
  assert.deepEqual(out.changed, ["tk_entries"]);
  const ra = await repo.getEntry(a.id);
  assert.equal(ra?.amount_minor, 8800);
  assert.equal(ra?.note, "沾麵");
  assert.equal(ra?.occurred_on, "2026-10-14");
  assert.equal(new Date(ra!.occurred_at).getHours(), 12); // 時刻照舊
  assert.equal(ra?.category_id, lunch.id);
  const rb = await repo.getEntry(b.id);
  assert.equal(rb?.account_id, wallet.id);
  assert.equal(rb?.currency, "USD");
  assert.equal(rb?.amount_minor, 1000);

  await run("update-ledger-entries", { entries: [{ id: a.id, categoryId: null, time: "25:30" }] }, ctx);
  const ra2 = await repo.getEntry(a.id);
  assert.equal(ra2?.category_id, UNCAT_EXPENSE_ID);
  assert.equal(new Date(ra2!.occurred_at).getDate(), 15);
  // 改成收入、沒給分類 ⇒ 換成收入的未分類（applyEntryPatch 規則）
  await run("update-ledger-entries", { entries: [{ id: a.id, kind: "income", categoryId: salary.id }] }, ctx);
  assert.equal((await repo.getEntry(a.id))?.category_id, salary.id);
  // 改成轉帳：幣別跟著轉出帳戶（USD → TWD），沒給金額不猜
  await rejects(run("update-ledger-entries", { entries: [{ id: b.id, kind: "transfer", toAccountId: usd.id }] }, ctx), /一併給新幣別的金額/);
  await run("update-ledger-entries", { entries: [{ id: b.id, kind: "transfer", toAccountId: usd.id, amount: 320 }] }, ctx);
  const rb2 = await repo.getEntry(b.id);
  assert.equal(rb2?.kind, "transfer");
  assert.equal(rb2?.currency, "TWD");
  assert.equal(rb2?.amount_minor, 32000);
  assert.equal(rb2?.category_id, null);
  // 沒變動
  const same = await run("update-ledger-entries", { entries: [{ id: a.id, note: "沾麵" }] }, ctx);
  assert.match(same.summary, /1 筆沒有變動/);
  assert.equal(same.changed, undefined);
});

test("update-ledger-entries：錯誤整批不寫、上限、重複 id", async () => {
  const { ctx, repo, wallet, old, salary } = await setup();
  const [a, b] = ((await run("add-ledger-entries", { entries: [{ amount: 100 }, { amount: 5 }] }, ctx)) as Any).data.entries;
  const adj = (await repo.listEntries("2026-10-01", "2026-10-02", wallet.id))[0];
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ id: "nope", note: "x" }, /找不到這筆帳/],
    [{ id: a.id, categoryId: salary.id }, /收入分類/],
    [{ id: a.id, accountId: old.id }, /封存/],
    [{ id: a.id, kind: "transfer" }, /轉入帳戶/],
    [{ id: a.id, amount: 1.234 }, /小數/],
    [{ id: adj.id, kind: "income" }, /餘額調整不能改/],
    [{ id: a.id, time: "99:00" }, /HH:MM/],
  ];
  for (const [item, re] of bad) await rejects(run("update-ledger-entries", { entries: [{ id: b.id, note: "改了" }, item] }, ctx), re);
  assert.equal((await repo.getEntry(b.id))?.note, "");
  await rejects(run("update-ledger-entries", { entries: [{ id: a.id }, { id: a.id }] }, ctx), /重複/);
  await rejects(run("update-ledger-entries", { entries: Array.from({ length: 51 }, () => ({ id: a.id })) }, ctx), /最多 50 筆/);
  await rejects(run("update-ledger-entries", { entries: [{ note: "x" }] }, ctx), /缺少/);
  // 餘額調整可以改金額（可負）
  await run("update-ledger-entries", { entries: [{ id: adj.id, amount: -20 }] }, ctx);
  assert.equal((await repo.getEntry(adj.id))?.amount_minor, -2000);
});

test("delete-ledger-entries：軟刪除、找不到整批不刪、上限", async () => {
  const { ctx, repo } = await setup();
  const [a, b] = ((await run("add-ledger-entries", { entries: [{ amount: 1 }, { amount: 2 }] }, ctx)) as Any).data.entries;
  await rejects(run("delete-ledger-entries", { ids: [a.id, "nope"] }, ctx), /找不到/);
  assert.ok(await repo.getEntry(a.id));
  await rejects(run("delete-ledger-entries", { ids: [a.id, a.id] }, ctx), /重複/);
  await rejects(run("delete-ledger-entries", { ids: Array.from({ length: 51 }, (_, i) => `x${i}`) }, ctx), /最多 50 筆/);
  await rejects(run("delete-ledger-entries", { ids: [] }, ctx), /至少一筆/);
  const out = await run("delete-ledger-entries", { ids: [a.id] }, ctx);
  assert.deepEqual(out.changed, ["tk_entries", "tk_repeats"]);
  assert.equal(await repo.getEntry(a.id), null);
  assert.ok(await repo.getEntry(b.id));
  // 軟刪除：restore 回得來
  await repo.restoreEntry(a.id);
  assert.ok(await repo.getEntry(a.id));
});

test("路線：任務關著就不帶路線名", async () => {
  const { ctx } = await setup();
  const line = await ctx.deps.nodeRepo.create({ kind: "line", name: "生活", parentId: null });
  const route = await ctx.deps.nodeRepo.create({ kind: "route", name: "旅行", parentId: line.id });
  const out = (await run("add-ledger-entries", { entries: [{ amount: 1, routeId: route.id }] }, ctx)) as Any;
  assert.equal(out.data.entries[0].route, "旅行");
  const off = { ...ctx, access: { ...ctx.access, tasks: "off" as const } };
  const found = (await run("find-ledger-entries", {}, off)).data as Any;
  const e = found.entries.find((x: Any) => x.id === out.data.entries[0].id);
  assert.equal(e.routeId, route.id);
  assert.equal(e.route, undefined);
});

test("日期不能記到未來；改日期保留牆鐘（含 25:xx）", async () => {
  const { ctx, repo } = await setup();
  await rejects(run("add-ledger-entries", { entries: [{ amount: 1, date: "2026-10-16" }] }, ctx), /不能記到未來/);
  const [a] = ((await run("add-ledger-entries", { entries: [{ amount: 1, date: "2026-10-14", time: "25:10" }] }, ctx)) as Any).data.entries;
  await rejects(run("update-ledger-entries", { entries: [{ id: a.id, date: "2026-10-20" }] }, ctx), /不能記到未來/);
  await run("update-ledger-entries", { entries: [{ id: a.id, date: "2026-10-13" }] }, ctx);
  const r = await repo.getEntry(a.id);
  assert.equal(r?.occurred_on, "2026-10-13");
  const at = new Date(r!.occurred_at);
  assert.deepEqual([at.getDate(), at.getHours(), at.getMinutes()], [14, 1, 10]); // 還是營業日的 25:10
  const back = ((await run("find-ledger-entries", { from: "2026-10-13", to: "2026-10-13" }, ctx)).data as Any).entries;
  assert.equal(back[0].time, "25:10");
  // 只送同一個時刻＝沒變動
  const same = await run("update-ledger-entries", { entries: [{ id: a.id, time: "25:10" }] }, ctx);
  assert.match(same.summary, /1 筆沒有變動/);
});

test("mainAmount／toAmount 用錯地方直接說；外幣折算覆寫寫得進去", async () => {
  const { ctx, repo, wallet, usd } = await setup();
  await rejects(run("add-ledger-entries", { entries: [{ amount: 10, mainAmount: 10 }] }, ctx), /只用在外幣帳/);
  await rejects(
    run("add-ledger-entries", { entries: [{ kind: "transfer", amount: 10, accountId: usd.id, toAccountId: usd.id, toAmount: 1 }] }, ctx),
    /toAmount/,
  );
  await rejects(run("add-ledger-entries", { entries: [{ amount: 10, toAmount: 1 }] }, ctx), /toAmount/);
  const [c] = ((await run("add-ledger-entries", { entries: [{ amount: 10, accountId: usd.id, mainAmount: 300 }] }, ctx)) as Any).data.entries;
  assert.equal(c.mainAmount, 300);
  await run("update-ledger-entries", { entries: [{ id: c.id, mainAmount: 310 }] }, ctx);
  assert.equal((await repo.getEntry(c.id))?.main_minor, 31000);
  const [t] = ((await run("add-ledger-entries", { entries: [{ kind: "transfer", amount: 100, accountId: wallet.id, toAccountId: usd.id }] }, ctx)) as Any).data.entries;
  await rejects(run("update-ledger-entries", { entries: [{ id: t.id, mainAmount: 1 }] }, ctx), /只用在外幣帳/);
});

test("封存分類：原本就掛著的可以留；新選的拒絕", async () => {
  const { ctx, repo, food, lunch } = await setup();
  const [a] = ((await run("add-ledger-entries", { entries: [{ amount: 5, categoryId: lunch.id }] }, ctx)) as Any).data.entries;
  await repo.setCategoryArchived(lunch.id, true);
  await run("update-ledger-entries", { entries: [{ id: a.id, categoryId: lunch.id, note: "留著" }] }, ctx);
  assert.equal((await repo.getEntry(a.id))?.note, "留著");
  await rejects(run("add-ledger-entries", { entries: [{ amount: 5, categoryId: lunch.id }] }, ctx), /已封存/);
  await repo.setCategoryArchived(food.id, true);
  await rejects(run("update-ledger-entries", { entries: [{ id: a.id, categoryId: food.id }] }, ctx), /已封存/);
});

test("任務關著：routeId 一律找不到", async () => {
  const { ctx } = await setup();
  const line = await ctx.deps.nodeRepo.create({ kind: "line", name: "生活", parentId: null });
  const route = await ctx.deps.nodeRepo.create({ kind: "route", name: "旅行", parentId: line.id });
  const off = { ...ctx, access: { ...ctx.access, tasks: "off" as const } };
  await rejects(run("add-ledger-entries", { entries: [{ amount: 1, routeId: route.id }] }, off), /找不到路線/);
  const [a] = ((await run("add-ledger-entries", { entries: [{ amount: 1, routeId: route.id }] }, ctx)) as Any).data.entries;
  await rejects(run("update-ledger-entries", { entries: [{ id: a.id, routeId: route.id }] }, off), /找不到路線/);
  await run("update-ledger-entries", { entries: [{ id: a.id, routeId: null }] }, off); // 拿掉照收
  // 別模組的 id 當帳的 id ＝找不到
  await rejects(run("delete-ledger-entries", { ids: [route.id] }, ctx), /找不到/);
  await rejects(run("update-ledger-entries", { entries: [{ id: route.id, note: "x" }] }, ctx), /找不到這筆帳/);
});

test("支出填負數＝退款：回應說破（沙盒 F3）", async () => {
  const { runMcpCall } = await load<typeof import("../../src/mcp/run.ts")>("../../src/mcp/run.ts");
  const { ctx, wallet } = await setup();
  const { reply } = await runMcpCall("r1", "add-ledger-entries", { entries: [{ amount: -120, accountId: wallet.id, note: "午餐" }] }, ctx);
  assert.equal(reply.isError, false, reply.text);
  assert.match(reply.text, /1 筆是退款/);
  assert.match(reply.text, /"refund":true/);
});
