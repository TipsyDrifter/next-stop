/**
 * 帳目（售票口線）的 MCP 工具——契約 §4「帳目」列。
 * 一律經 `ctx.deps.ticketRepo`；驗證與欄值推導照 UI 呼叫同一批 domain 純函式（buildEntryRow／applyEntryPatch／atOf…），
 * 寫入前先用 domain 對整批試算一次，有錯整批不寫（repository 每筆各自一個 WriteBatch，不能跨筆回滾）。
 * 金額：助理用一般數字，這裡依幣別小數位換成 minor（`parseAmount`，同 UI 表單）；回傳也換回一般數字。
 * 轉帳開放（NewEntryInput 支援）；調整餘額（adjustBalance）不在工具表，先不開。
 */
import type { JsonSchema, McpCtx, McpOutcome, McpTool } from "../types";
import { McpUserError } from "../types";
import { batch, bool, date, idList, int, oneOf, str } from "../args";
import {
  ACCOUNT_GROUPS,
  MAIN_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  accountTotals,
  atOf,
  buildEntryRow,
  applyEntryPatch,
  catKey,
  categoryLabel,
  categoryTree,
  currencyCode,
  defaultAccountId,
  isLiability,
  localTime,
  moneyText,
  parseAmount,
} from "../../domain/ticket";
import type {
  AccountRow,
  CategoryKind,
  CategoryRow,
  CurrencyRow,
  EntryCtx,
  EntryKind,
  EntryPatch,
  EntryRow,
  NewEntryInput,
} from "../../domain/ticket";
import {
  EMPTY_FILTER,
  GONE_KEY,
  UNSPLIT_KEY,
  breakdown,
  filterToQuery,
  keywordTokens,
  matchesKeyword,
  periodOf,
  periodRange,
  routeCtx,
  statsOverview,
} from "../../domain/ticketView";
import type { BreakdownRow, RouteRef, ViewCtx } from "../../domain/ticketView";
import { budgetLines } from "../../domain/ticketPlan";
import { addDays, parseClockInput, toDateKey } from "../../lib/date";

type Args = Record<string, unknown>;

const MODULE = "ledger" as const;
const LIST_LIMIT = 100;
const MAX_DAYS = 92;
const CATEGORY_LIMIT = 300;
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const KIND_LABEL: Readonly<Record<EntryKind, string>> = { expense: "支出", income: "收入", transfer: "轉帳", adjust: "餘額調整" };
const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

/* ───────── 共用：讀一次帳本的骨架 ───────── */

interface Meta {
  currencies: CurrencyRow[];
  accounts: AccountRow[];
  categories: CategoryRow[];
  ectx: EntryCtx;
  main: CurrencyRow | null;
}

function byId<T extends { id: string }>(rows: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const r of rows) out[r.id] = r;
  return out;
}

async function loadMeta(ctx: McpCtx): Promise<Meta> {
  const repo = ctx.deps.ticketRepo;
  const [currencies, accounts, categories] = await Promise.all([repo.listCurrencies(), repo.listAccounts(), repo.listCategories()]);
  const curByCode: Record<string, CurrencyRow> = {};
  for (const c of currencies) curByCode[c.code] = c;
  const main = currencies.find((c) => c.is_main === 1) ?? curByCode[MAIN_CURRENCY] ?? null;
  return { currencies, accounts, categories, ectx: { accById: byId(accounts), catById: byId(categories), curByCode }, main };
}

/** 路線屬於「任務」功能：任務關著就不帶路線名（也不拿來比關鍵字），只留 id */
async function loadRoutes(ctx: McpCtx): Promise<{ routeById: Record<string, RouteRef>; routeOrder: string[] }> {
  if (ctx.access.tasks === "off") return { routeById: {}, routeOrder: [] };
  return routeCtx((await ctx.deps.nodeRepo.listSidebar()).routes);
}

const mainCode = (m: Meta): string => m.main?.code ?? MAIN_CURRENCY;
const mainDec = (m: Meta): number => m.main?.decimals ?? 2;
const decOf = (m: Meta, code: string): number => m.ectx.curByCode[code]?.decimals ?? 2;

/** minor → 一般數字（字串拼小數點再轉，不經浮點除法） */
function num(minor: number, decimals: number): number {
  return Number(moneyText(minor, decimals).replace(/,/g, "").replace("−", "-"));
}

/** 一般數字（或數字字串）→ minor；規則同 UI 表單的 parseAmount（小數位超過幣別上限＝錯，不偷偷進位） */
function toMinor(v: unknown, cur: { code: string; decimals: number }, allowNegative: boolean, at: string): number {
  if (typeof v !== "number" && typeof v !== "string") throw new McpUserError(`${at} 要是數字，例如 120 或 12.5`);
  if (typeof v === "number" && !Number.isFinite(v)) throw new McpUserError(`${at} 要是數字`);
  try {
    return parseAmount(String(v), cur, { allowNegative });
  } catch (e) {
    throw userErr(e, at);
  }
}

/** repository／domain 的 RangeError＝使用者能修的錯（售票口慣例 §4.3）；其餘照原樣往上丟 */
function userErr(e: unknown, at: string): Error {
  if (e instanceof RangeError) return new McpUserError(`${at}：${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

/** occurred_at → 營業日表記（日界線前的凌晨寫成 25:30） */
function clockOf(e: EntryRow): string {
  const d = new Date(e.occurred_at);
  const hhmm = localTime(e.occurred_at);
  if (toDateKey(d) !== addDays(e.occurred_on, 1)) return hhmm;
  return `${Number(hhmm.slice(0, 2)) + 24}:${hhmm.slice(3)}`;
}

/** 營業日時刻 → 牆鐘 HH:MM（25:30 → 01:30）；UI 存回一律 atOf(dayKey, 牆鐘, dayStartHour) */
function wallClock(clock: string, dayStartHour: number, at: string): string {
  const t = parseClockInput(clock, dayStartHour);
  if (t === null) throw new McpUserError(`${at} 要是 HH:MM 時刻（比日界線早的凌晨寫成 25:00），收到「${clock}」`);
  const h = Number(t.slice(0, 2)) % 24;
  return `${String(h).padStart(2, "0")}:${t.slice(3)}`;
}

/** 帳不能記到未來（TicketPanel／MobileEntryForm 的日期選單 max＝今天） */
function notFuture(day: string, ctx: McpCtx, at: string): string {
  if (day > ctx.today) throw new McpUserError(`${at}：帳不能記到未來（今天是 ${ctx.today}），收到 ${day}`);
  return day;
}

function accountOrThrow(m: Meta, id: string, at: string, opts: { allowArchived: boolean }): AccountRow {
  const a = m.ectx.accById[id];
  if (!a || a.deleted_at !== null) throw new McpUserError(`${at}：找不到帳戶 ${id}（先用 find-accounts 查 id）`);
  // 記一筆的帳戶選單不列封存帳戶（groupAccounts）
  if (!opts.allowArchived && a.archived_at !== null) throw new McpUserError(`${at}：帳戶「${a.name}」已封存`);
  return a;
}

function categoryOrThrow(m: Meta, id: string, kind: CategoryKind, at: string, keepArchived: string | null = null): string {
  if (isUncat(id)) {
    if ((id === UNCAT_INCOME_ID ? "income" : "expense") !== kind) throw new McpUserError(`${at}：這個分類不屬於${KIND_LABEL[kind]}`);
    return id;
  }
  const c = m.ectx.catById[id];
  if (!c || c.deleted_at !== null) throw new McpUserError(`${at}：找不到分類 ${id}（先用 find-ledger-categories 查 id）`);
  if (c.kind !== kind) throw new McpUserError(`${at}：分類「${c.name}」是${KIND_LABEL[c.kind]}分類，不能用在${KIND_LABEL[kind]}`);
  // 分類選單不列封存分類（categoryTree includeArchived:false）
  // 那筆原本就掛著的封存分類照留（同帳戶 allowArchived）
  if (c.archived_at !== null && id !== keepArchived) throw new McpUserError(`${at}：分類「${c.name}」已封存`);
  return id;
}

async function routeOrThrow(ctx: McpCtx, id: string, at: string): Promise<string> {
  // 任務功能關著＝路線對助理不存在（跨模組 id 一律當找不到）
  if (ctx.access.tasks === "off") throw new McpUserError(`${at}：找不到路線 ${id}`);
  const routes = (await ctx.deps.nodeRepo.listSidebar()).routes;
  if (!routes.some((r) => r.id === id && r.deleted_at === null)) throw new McpUserError(`${at}：找不到路線 ${id}`);
  return id;
}

const given = (v: unknown): boolean => v !== undefined && v !== null;

/** mainAmount：只有外幣帳才有意義；給在主幣別帳上直接說，不默默略過 */
function mainOverride(it: Args, m: Meta, currency: string, allowNeg: boolean, w: string): number | undefined {
  if (!given(it.mainAmount)) return undefined;
  if (!m.main || currency === m.main.code) throw new McpUserError(`${w}.mainAmount：只用在外幣帳，這筆是 ${currency}`);
  return toMinor(it.mainAmount, m.main, allowNeg, `${w}.mainAmount`);
}

/** toAmount：只有轉入帳戶幣別不同的轉帳才有意義 */
function toOverride(it: Args, m: Meta, kind: EntryKind, currency: string, toAccountId: string | null, w: string): number | undefined {
  if (!given(it.toAmount)) return undefined;
  const toCur = kind === "transfer" && toAccountId ? m.ectx.curByCode[m.ectx.accById[toAccountId]?.currency ?? ""] : undefined;
  if (!toCur || toCur.code === currency) throw new McpUserError(`${w}.toAmount：只用在轉入帳戶幣別不同的轉帳`);
  return toMinor(it.toAmount, toCur, false, `${w}.toAmount`);
}

/** 給模型讀的一筆帳（不含 hlc／時間戳／匯入欄） */
function entryView(e: EntryRow, m: Meta, routes: Readonly<Record<string, RouteRef>>): Record<string, unknown> {
  const { accById, catById } = m.ectx;
  const out: Record<string, unknown> = {
    id: e.id,
    date: e.occurred_on,
    time: clockOf(e),
    kind: e.kind,
    amount: num(e.amount_minor, decOf(m, e.currency)),
    currency: e.currency,
    accountId: e.account_id,
    account: accById[e.account_id]?.name ?? "（帳戶已刪除）",
  };
  if (e.kind === "transfer" && e.to_account_id) {
    const to = accById[e.to_account_id];
    out.toAccountId = e.to_account_id;
    out.toAccount = to?.name ?? "（帳戶已刪除）";
    if (to && to.currency !== e.currency && e.to_amount_minor !== null) {
      out.toAmount = num(e.to_amount_minor, decOf(m, to.currency));
      out.toCurrency = to.currency;
    }
  }
  if (e.kind === "expense" && e.amount_minor < 0) out.refund = true;
  if (e.kind === "income" || e.kind === "expense") {
    out.categoryId = e.category_id;
    out.category = e.category_id ? categoryLabel(catById[e.category_id] ?? null, catById) : "未分類";
  }
  if (e.currency !== mainCode(m)) out.mainAmount = num(e.main_minor, mainDec(m));
  if (e.note) out.note = e.note;
  if (e.route_id) {
    out.routeId = e.route_id;
    const r = routes[e.route_id];
    if (r) out.route = r.name;
  }
  return out;
}

const money = (m: Meta, minor: number): string => `${moneyText(minor, mainDec(m))} ${mainCode(m)}`;

/* ───────── schema 小片 ───────── */

const S_DATE: JsonSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const S_AMOUNT: JsonSchema = { type: ["number", "string"] };

const ENTRY_FIELDS: Record<string, JsonSchema> = {
  kind: { type: "string", enum: ["expense", "income", "transfer"], description: "expense 支出／income 收入／transfer 轉帳" },
  amount: { ...S_AMOUNT, description: "一般數字（120、12.5），單位＝該幣別；支出填負數＝退款" },
  currency: { type: "string", description: "幣別代碼（TWD）；省略＝帳戶幣別；轉帳固定跟轉出帳戶" },
  accountId: { type: "string", description: "帳戶（轉帳＝轉出）" },
  toAccountId: { type: "string", description: "轉入帳戶（只有轉帳）" },
  toAmount: { ...S_AMOUNT, description: "只用在不同幣別的轉帳：轉入金額；省略＝照匯率" },
  mainAmount: { ...S_AMOUNT, description: "只用在外幣帳：折成主幣別的金額；省略＝照匯率" },
  categoryId: { type: "string", description: "分類 id（find-ledger-categories）；省略＝未分類" },
  date: { ...S_DATE, description: "YYYY-MM-DD，不能晚於今天" },
  time: { type: "string", description: "HH:MM 營業日表記（日界線前的凌晨寫 25:30）" },
  note: { type: "string", description: "備註" },
  routeId: { type: "string", description: "掛到哪條路線（project）" },
};

/* ───────── 讀 ───────── */

const findAccounts: McpTool = {
  name: "find-accounts",
  title: "查帳戶",
  description:
    "列出帳戶與目前餘額（含封存）、幣別清單、資產／負債合計。記帳前先用這支拿 accountId。金額是一般數字、單位＝帳戶幣別；信用卡等負債帳戶欠款為負數。",
  inputSchema: {
    type: "object",
    properties: { includeArchived: { type: "boolean", description: "要不要列封存的帳戶，預設 true" } },
    additionalProperties: false,
  },
  module: MODULE,
  access: "read",
  annotations: READ,
  async run(args: Args, ctx: McpCtx): Promise<McpOutcome> {
    const includeArchived = bool(args, "includeArchived") ?? true;
    const [m, balances] = await Promise.all([loadMeta(ctx), ctx.deps.ticketRepo.balances()]);
    const totals = accountTotals(m.accounts, balances, m.ectx.curByCode);
    const list = m.accounts.filter((a) => includeArchived || a.archived_at === null);
    const accounts = list.map((a) => {
      const g = ACCOUNT_GROUPS.find((x) => x.key === a.group_key) ?? ACCOUNT_GROUPS[ACCOUNT_GROUPS.length - 1];
      const out: Record<string, unknown> = {
        id: a.id,
        name: a.name,
        group: g.label,
        currency: a.currency,
        balance: num(balances[a.id] ?? 0, decOf(m, a.currency)),
      };
      if (isLiability(a.group_key)) out.liability = true;
      if (a.archived_at !== null) out.archived = true;
      return out;
    });
    const archivedCount = m.accounts.filter((a) => a.archived_at !== null).length;
    return {
      summary: `${m.accounts.length} 個帳戶${archivedCount ? `（${archivedCount} 個封存）` : ""}；淨資產 ${money(m, totals.net)}`,
      data: {
        mainCurrency: mainCode(m),
        totals: { asset: num(totals.asset, mainDec(m)), liability: num(totals.liability, mainDec(m)), net: num(totals.net, mainDec(m)) },
        accounts,
        currencies: m.currencies.map((c) => ({ code: c.code, name: c.name, decimals: c.decimals, rateToMain: c.rate_to_main, ...(c.is_main === 1 ? { main: true } : {}) })),
      },
    };
  },
};

const findCategories: McpTool = {
  name: "find-ledger-categories",
  title: "查帳目分類",
  description: "列出收支分類（兩層：主分類 › 子分類），記帳前用這支拿 categoryId。kind：expense 支出、income 收入。「未分類」也在清單裡。",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["expense", "income"], description: "只列這一種；省略＝兩種都列" },
      query: { type: "string", description: "名稱關鍵字" },
      includeArchived: { type: "boolean", description: "要不要列封存的分類，預設 false" },
    },
    additionalProperties: false,
  },
  module: MODULE,
  access: "read",
  annotations: READ,
  async run(args: Args, ctx: McpCtx): Promise<McpOutcome> {
    const kind = oneOf(args, "kind", ["expense", "income"] as const);
    const q = catKey(str(args, "query") ?? "");
    const includeArchived = bool(args, "includeArchived") ?? false;
    const m = await loadMeta(ctx);
    const out: Record<string, unknown>[] = [];
    for (const k of kind ? [kind] : (["expense", "income"] as const)) {
      for (const t of categoryTree(m.categories, k, { includeArchived })) {
        for (const c of [t.parent, ...t.children]) {
          if (q && !catKey(c.name).includes(q) && !(c !== t.parent && catKey(t.parent.name).includes(q))) continue;
          const row: Record<string, unknown> = { id: c.id, kind: c.kind, name: categoryLabel(c, m.ectx.catById) };
          if (c !== t.parent) row.parentId = t.parent.id;
          if (c.archived_at !== null) row.archived = true;
          out.push(row);
        }
      }
    }
    const cut = out.length > CATEGORY_LIMIT;
    return {
      summary: `${out.length} 個分類${cut ? `，只列前 ${CATEGORY_LIMIT} 個` : ""}`,
      data: { categories: out.slice(0, CATEGORY_LIMIT) },
    };
  },
};

const findEntries: McpTool = {
  name: "find-ledger-entries",
  title: "查帳",
  description:
    "依日期區間（最多 92 天）、帳戶、分類、種類、關鍵字查帳，新到舊，最多 100 筆。省略日期＝到今天為止的 30 天。分類給主分類會連子分類一起查。關鍵字比備註、分類、帳戶名，純數字比金額。",
  inputSchema: {
    type: "object",
    properties: {
      from: { ...S_DATE, description: "起日 YYYY-MM-DD（含）" },
      to: { ...S_DATE, description: "迄日 YYYY-MM-DD（含）" },
      accountId: { type: "string", description: "只看這個帳戶（含轉入）" },
      categoryId: { type: "string", description: "分類 id；主分類含子分類" },
      kind: { type: "string", enum: ["expense", "income", "transfer", "adjust"], description: "adjust＝餘額調整" },
      query: { type: "string", description: "關鍵字（空白分隔＝都要符合）" },
      limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT, description: "預設 100" },
    },
    additionalProperties: false,
  },
  module: MODULE,
  access: "read",
  annotations: READ,
  async run(args: Args, ctx: McpCtx): Promise<McpOutcome> {
    const to = date(args, "to") ?? ctx.today;
    const from = date(args, "from") ?? addDays(to, -29);
    if (from > to) throw new McpUserError("from 不能晚於 to");
    const days = Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000) + 1;
    if (days > MAX_DAYS) throw new McpUserError(`一次最多查 ${MAX_DAYS} 天，收到 ${days} 天`);
    const accountId = str(args, "accountId");
    const categoryId = str(args, "categoryId");
    const kind = oneOf(args, "kind", ["expense", "income", "transfer", "adjust"] as const);
    const query = str(args, "query") ?? "";
    const limit = int(args, "limit", { min: 1, max: LIST_LIMIT }) ?? LIST_LIMIT;

    const [m, rt] = await Promise.all([loadMeta(ctx), loadRoutes(ctx)]);
    if (accountId) accountOrThrow(m, accountId, "accountId", { allowArchived: true });
    if (categoryId && !isUncat(categoryId) && !m.ectx.catById[categoryId]) throw new McpUserError(`找不到分類 ${categoryId}`);

    // 同 UI 搜尋（ticketStore.runQuery）：結構條件走 queryEntries，關鍵字用 matchesKeyword 濾
    const rows = await ctx.deps.ticketRepo.queryEntries(
      filterToQuery(
        { ...EMPTY_FILTER, from, toExcl: addDays(to, 1), accountId: accountId ?? null, categoryIds: categoryId ? [categoryId] : [], kinds: kind ? [kind] : [] },
        m.categories,
      ),
    );
    const tokens = keywordTokens(query);
    const vctx: ViewCtx = { ...m.ectx, ...rt };
    // 只打符號（token 化後是空的）＝不當成「全部」（同 store.searchEntries）
    const hits = query.trim() && !tokens.length ? [] : rows.filter((e) => matchesKeyword(e, tokens, vctx));
    let expense = 0;
    let income = 0;
    for (const e of hits) {
      if (e.kind === "expense") expense += e.main_minor;
      else if (e.kind === "income") income += e.main_minor;
    }
    const cut = hits.length > limit;
    return {
      summary:
        `${from}～${to} 找到 ${hits.length} 筆 · 支出 ${money(m, expense)} · 收入 ${money(m, income)}` +
        (cut ? `；只列最新 ${limit} 筆` : ""),
      data: {
        from,
        to,
        total: hits.length,
        truncated: cut,
        mainCurrency: mainCode(m),
        expense: num(expense, mainDec(m)),
        income: num(income, mainDec(m)),
        entries: hits.slice(0, limit).map((e) => entryView(e, m, rt.routeById)),
      },
    };
  },
};

function breakdownView(b: { rows: BreakdownRow[]; refunds: BreakdownRow[] }, dec: number): Record<string, unknown>[] {
  const one = (r: BreakdownRow): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      categoryId: r.key === GONE_KEY || r.key === UNSPLIT_KEY ? null : r.key,
      name: r.label,
      amount: num(r.minor, dec),
      sharePct: Math.round(r.share * 100),
      count: r.count,
    };
    if (r.children) out.children = r.children.map(one);
    return out;
  };
  return [...b.rows, ...b.refunds].map(one);
}

const getSummary: McpTool = {
  name: "get-spending-summary",
  title: "收支統計",
  description:
    "某個月（或某一年）的收入、支出、淨額，各分類合計與占比（同 App 統計頁），月模式另附預算使用（預算、已用、剩餘、時間進度）。省略＝本月。金額一律主幣別。",
  inputSchema: {
    type: "object",
    properties: {
      month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "YYYY-MM" },
      year: { type: "string", pattern: "^\\d{4}$", description: "YYYY（整年；不附預算）" },
    },
    additionalProperties: false,
  },
  module: MODULE,
  access: "read",
  annotations: READ,
  async run(args: Args, ctx: McpCtx): Promise<McpOutcome> {
    const month = str(args, "month");
    const year = str(args, "year");
    if (month && year) throw new McpUserError("month 和 year 只能給一個");
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new McpUserError(`month 要是 YYYY-MM，收到「${month}」`);
    if (year !== undefined && !/^\d{4}$/.test(year)) throw new McpUserError(`year 要是 YYYY，收到「${year}」`);
    const period = year ? periodOf(`${year}-01`, "year") : periodOf(month ?? ctx.today.slice(0, 7), "month");
    const r = periodRange(period);
    const [m, entries, budgets] = await Promise.all([
      loadMeta(ctx),
      ctx.deps.ticketRepo.listEntries(r.from, r.toExcl, null),
      period.span === "month" ? ctx.deps.ticketRepo.listBudgets() : Promise.resolve([]),
    ]);
    const dec = mainDec(m);
    // 分類切面用不到路線；ViewCtx 的路線兩欄給空的
    const vctx: ViewCtx = { ...m.ectx, routeById: {}, routeOrder: [] };
    const ov = statsOverview(entries, r);
    const data: Record<string, unknown> = {
      period: period.key,
      mainCurrency: mainCode(m),
      income: num(ov.income, dec),
      expense: num(ov.expense, dec),
      net: num(ov.net, dec),
      count: ov.count,
      expenseByCategory: breakdownView(breakdown(entries, r, "category", "expense", vctx), dec),
      incomeByCategory: breakdownView(breakdown(entries, r, "category", "income", vctx), dec),
    };
    let budgetNote = "";
    if (period.span === "month") {
      // 同統計頁預算卡（ticketStore.computeBudgetLines）：budgetLines(預算, 帳, 月, 分類, 今天, ctx)
      const lines = budgetLines(budgets, entries, period.key, m.categories, ctx.today, m.ectx);
      data.budgets = lines.map((l) => ({
        name: l.label,
        ...(l.scope.kind === "category" ? { categoryId: l.scope.categoryId } : {}),
        budget: num(l.budget, dec),
        used: num(l.used, dec),
        remaining: num(l.remaining, dec),
        usedPct: Math.round(l.share * 100),
        timePct: Math.round(l.pace * 100),
        ...(l.over ? { over: true } : {}),
        ...(l.archived ? { archived: true } : {}),
        ...(l.gone ? { gone: true } : {}),
      }));
      const over = lines.filter((l) => l.over).length;
      if (lines.length) budgetNote = `；預算 ${lines.length} 項${over ? `，${over} 項超支` : "，都沒超支"}`;
    }
    return {
      summary: `${period.key} 支出 ${money(m, ov.expense)} · 收入 ${money(m, ov.income)} · 淨額 ${money(m, ov.net)}（${ov.count} 筆）${budgetNote}`,
      data,
    };
  },
};

/* ───────── 寫 ───────── */

/** 起手三列（TWD、兩個未分類）：UI 進售票口時 warm() 會先補；助理可能比 UI 早來，寫入前一樣補 */
async function ensureStarter(ctx: McpCtx): Promise<string[]> {
  const n = await ctx.deps.ticketRepo.ensureStarterRows();
  return n > 0 ? ["tk_currencies", "tk_categories"] : [];
}

function noDup(ids: readonly string[], key: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new McpUserError(`${key} 裡有重複的 id：${id}`);
    seen.add(id);
  }
}

/** 一筆一筆寫；中途失敗：前面寫成的照算（各自一個 WriteBatch），回報停在哪一筆 */
async function writeEach<T>(
  items: readonly T[],
  fn: (item: T, i: number) => Promise<EntryRow | null>,
  where: (i: number) => string,
): Promise<{ rows: EntryRow[]; failed: string | null }> {
  const rows: EntryRow[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const r = await fn(items[i], i);
      if (r) rows.push(r);
    } catch (e) {
      const err = userErr(e, where(i));
      if (rows.length === 0 && i === 0) throw err;
      return { rows, failed: err.message };
    }
  }
  return { rows, failed: null };
}

const addEntries: McpTool = {
  name: "add-ledger-entries",
  title: "記帳",
  description:
    "記一到多筆帳（上限 50）。amount 用一般數字（120、12.5），由 App 依幣別小數位換算；支出填負數＝退款。先 find-accounts 拿 accountId、find-ledger-categories 拿 categoryId。省略：kind＝expense、帳戶＝上次用的、日期＝今天（不能記到未來）、時刻＝現在、分類＝未分類。有一筆不合就整批不寫。",
  inputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: { type: "object", properties: ENTRY_FIELDS, required: ["amount"], additionalProperties: false },
      },
    },
    required: ["entries"],
    additionalProperties: false,
  },
  module: MODULE,
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args: Args, ctx: McpCtx): Promise<McpOutcome> {
    const items = batch(args, "entries");
    const starter = await ensureStarter(ctx);
    const [m, rt, lastUsed] = await Promise.all([loadMeta(ctx), loadRoutes(ctx), ctx.deps.ticketRepo.lastUsedAccountId()]);
    // 同記一筆表單的預設帳戶（openNew：defaultAccountId(accounts, lastAccountId)）
    const defAcc = defaultAccountId(m.accounts, lastUsed);
    const nowIso = ctx.now.toISOString();

    // 整批先試算：參數換算＋buildEntryRow 驗證，有一筆不合就整批不寫
    const inputs: NewEntryInput[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const w = `entries[${i}]`;
      const kind = oneOf(it, "kind", ["expense", "income", "transfer"] as const, w) ?? "expense";
      const accountId = str(it, "accountId", { where: w }) ?? defAcc;
      if (!accountId) throw new McpUserError("還沒有帳戶：請使用者先在 App 的售票口建一個帳戶");
      const acc = accountOrThrow(m, accountId, `${w}.accountId`, { allowArchived: false });
      const given = str(it, "currency", { where: w });
      let currency = acc.currency;
      if (given) {
        try {
          currency = currencyCode(given);
        } catch (e) {
          throw userErr(e, `${w}.currency`);
        }
        if (kind === "transfer" && currency !== acc.currency) throw new McpUserError(`${w}.currency：轉帳幣別跟著轉出帳戶（${acc.currency}）`);
      }
      const cur = m.ectx.curByCode[currency];
      if (!cur) throw new McpUserError(`${w}.currency：沒有這個幣別 ${currency}（find-accounts 的 currencies）`);
      const amountMinor = toMinor(it.amount, cur, kind === "expense", `${w}.amount`);

      let toAccountId: string | null = null;
      let categoryId: string | null = null;
      const toGiven = str(it, "toAccountId", { where: w });
      const catGiven = str(it, "categoryId", { where: w });
      if (kind === "transfer") {
        if (!toGiven) throw new McpUserError(`${w}.toAccountId：轉帳要填轉入帳戶`);
        if (catGiven) throw new McpUserError(`${w}.categoryId：轉帳沒有分類`);
        toAccountId = accountOrThrow(m, toGiven, `${w}.toAccountId`, { allowArchived: false }).id;
      } else {
        if (toGiven) throw new McpUserError(`${w}.toAccountId：只有轉帳要填`);
        if (catGiven) categoryId = categoryOrThrow(m, catGiven, kind, `${w}.categoryId`);
      }

      const day = notFuture(date(it, "date", { where: w }) ?? ctx.today, ctx, `${w}.date`);
      const clock = str(it, "time", { where: w });
      // 時刻省略＝現在的牆鐘（同 openNew 的 time: localTime(now)）；存回同 draftToInput：atOf(日, 牆鐘, 日界線)
      const occurredAt = atOf(day, clock ? wallClock(clock, ctx.dayStartHour, `${w}.time`) : localTime(nowIso), ctx.dayStartHour);
      const routeGiven = str(it, "routeId", { where: w });
      const input: NewEntryInput = {
        kind,
        amountMinor,
        currency,
        accountId: acc.id,
        toAccountId,
        categoryId,
        occurredOn: day,
        occurredAt,
        note: str(it, "note", { where: w }) ?? "",
        routeId: routeGiven ? await routeOrThrow(ctx, routeGiven, `${w}.routeId`) : null,
      };
      // 折算覆寫（同 draftToInput 的 mainOverrideText／toAmountText；UI 只在外幣／跨幣別時才露出這兩格）
      const mainMinor = mainOverride(it, m, currency, kind === "expense", w);
      if (mainMinor !== undefined) input.override = { mainMinor };
      const toAmountMinor = toOverride(it, m, kind, currency, toAccountId, w);
      if (toAmountMinor !== undefined) input.override = { ...input.override, toAmountMinor };
      try {
        buildEntryRow(input, m.ectx, { id: "preview", nowIso });
      } catch (e) {
        throw userErr(e, w);
      }
      inputs.push(input);
    }

    const { rows, failed } = await writeEach(inputs, (input) => ctx.deps.ticketRepo.createEntry(input), (i) => `entries[${i}]`);
    const m2 = await loadMeta(ctx);
    let expense = 0;
    let refunds = 0;
    for (const r of rows) {
      if (r.kind !== "expense") continue;
      if (r.main_minor < 0) refunds++;
      else expense += r.main_minor;
    }
    // 支出填負數＝退款（App 的慣例）；說破，助理把「午餐 120」誤傳成 -120 時才看得出來（沙盒 F3）
    const refundNote = refunds ? `；其中 ${refunds} 筆是退款（支出填了負數——如果本意是花費，請用 update-ledger-entries 改成正數）` : "";
    return {
      summary: `記了 ${rows.length} 筆帳${expense ? `（支出合計 ${money(m2, expense)}）` : ""}${refundNote}${failed ? `；之後停在 ${failed}` : ""}`,
      data: { entries: rows.map((r) => entryView(r, m2, rt.routeById)) },
      changed: [...starter, "tk_entries"],
      toast: `外部助理記了 ${rows.length} 筆帳`,
    };
  },
};

const updateEntries: McpTool = {
  name: "update-ledger-entries",
  title: "改帳",
  description:
    "改一到多筆帳（上限 50）：每筆給 id 和要改的欄位，沒給的不動（換帳戶不會換幣別；轉帳跟餘額調整的幣別跟著帳戶，幣別變了要一併給 amount）。categoryId 給 null＝改回未分類、routeId 給 null＝拿掉路線。改日期不給時刻＝時刻照舊。餘額調整那種不能改 kind。有一筆不合就整批不寫。",
  inputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            ...ENTRY_FIELDS,
            categoryId: { type: ["string", "null"], description: "分類 id；null＝未分類" },
            routeId: { type: ["string", "null"], description: "路線 id；null＝拿掉" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["entries"],
    additionalProperties: false,
  },
  module: MODULE,
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async run(args: Args, ctx: McpCtx): Promise<McpOutcome> {
    const items = batch(args, "entries");
    const ids = items.map((it, i) => str(it, "id", { required: true, where: `entries[${i}]` }));
    noDup(ids, "entries");
    const [m, rt] = await Promise.all([loadMeta(ctx), loadRoutes(ctx)]);
    const nowIso = ctx.now.toISOString();

    // 整批先試算（照 UI 編輯表單的 buildPatch 組 patch，再用 applyEntryPatch 驗）
    const plans: { id: string; patch: EntryPatch }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const w = `entries[${i}]`;
      const row = await ctx.deps.ticketRepo.getEntry(ids[i]);
      if (!row) throw new McpUserError(`${w}：找不到這筆帳 ${ids[i]}`);
      const adjust = row.kind === "adjust";
      const kindGiven = oneOf(it, "kind", ["expense", "income", "transfer"] as const, w);
      if (adjust && kindGiven) throw new McpUserError(`${w}.kind：餘額調整不能改收支類型`);
      const kind: EntryKind = adjust ? "adjust" : (kindGiven ?? row.kind);
      const accGiven = str(it, "accountId", { where: w });
      const acc = accountOrThrow(m, accGiven ?? row.account_id, `${w}.accountId`, { allowArchived: accGiven === undefined || accGiven === row.account_id });

      // 幣別：轉帳與調整跟著帳戶；收支沒給＝照舊（同桌機 TicketPanel 換帳戶只送 accountId，applyEntryPatch 不動收支的幣別）
      const curGiven = str(it, "currency", { where: w });
      let currency: string;
      if (kind === "transfer" || adjust) {
        currency = acc.currency;
        if (curGiven && curGiven.toUpperCase() !== acc.currency) throw new McpUserError(`${w}.currency：${KIND_LABEL[kind]}的幣別跟著帳戶（${acc.currency}）`);
      } else if (curGiven) {
        try {
          currency = currencyCode(curGiven);
        } catch (e) {
          throw userErr(e, `${w}.currency`);
        }
      } else currency = row.currency;
      const cur = m.ectx.curByCode[currency];
      if (!cur) throw new McpUserError(`${w}.currency：沒有這個幣別 ${currency}`);
      const allowNeg = adjust || kind === "expense";
      // 幣別換了又沒給金額：原本的數字換了單位就不是同一筆錢，請助理明講（UI 兩殼這裡做法不一，不猜）
      if (!given(it.amount) && currency !== row.currency) {
        throw new McpUserError(`${w}.amount：幣別從 ${row.currency} 換成 ${currency}，請一併給新幣別的金額`);
      }
      const amountMinor = given(it.amount) ? toMinor(it.amount, cur, allowNeg, `${w}.amount`) : row.amount_minor;

      const p: EntryPatch = {};
      if (!adjust && kind !== row.kind) p.kind = kind as EntryPatch["kind"];
      if (amountMinor !== row.amount_minor) p.amountMinor = amountMinor;
      if (currency !== row.currency) p.currency = currency;
      if (acc.id !== row.account_id) p.accountId = acc.id;
      const toGiven = str(it, "toAccountId", { where: w });
      if (kind === "transfer") {
        const toId = toGiven ?? row.to_account_id;
        if (!toId) throw new McpUserError(`${w}.toAccountId：轉帳要填轉入帳戶`);
        const to = accountOrThrow(m, toId, `${w}.toAccountId`, { allowArchived: toId === row.to_account_id });
        if (to.id !== row.to_account_id) p.toAccountId = to.id;
      } else if (toGiven) throw new McpUserError(`${w}.toAccountId：只有轉帳要填`);
      if (it.categoryId !== undefined) {
        if (kind !== "income" && kind !== "expense") throw new McpUserError(`${w}.categoryId：${KIND_LABEL[kind]}沒有分類`);
        const catId =
          it.categoryId === null ? null : categoryOrThrow(m, str(it, "categoryId", { required: true, where: w }), kind, `${w}.categoryId`, row.category_id);
        if (catId !== row.category_id) p.categoryId = catId;
      }
      const note = str(it, "note", { where: w });
      if (note !== undefined && note !== row.note) p.note = note;
      if (it.routeId !== undefined) {
        const routeId = it.routeId === null ? null : await routeOrThrow(ctx, str(it, "routeId", { required: true, where: w }), `${w}.routeId`);
        if (routeId !== row.route_id) p.routeId = routeId;
      }
      const day = date(it, "date", { where: w });
      if (day !== undefined && day !== row.occurred_on) notFuture(day, ctx, `${w}.date`);
      const clock = str(it, "time", { where: w });
      if (day !== undefined || clock !== undefined) {
        // 同 UI（TicketPanel 日期 chip、MobileEntryForm buildPatch）：沒給時刻＝原本的牆鐘；日期或牆鐘變了才寫，occurredAt＝atOf(日, 牆鐘, 日界線)
        const d = day ?? row.occurred_on;
        const rowWall = localTime(row.occurred_at);
        const wall = clock !== undefined ? wallClock(clock, ctx.dayStartHour, `${w}.time`) : rowWall;
        if (d !== row.occurred_on || wall !== rowWall) {
          p.occurredOn = d;
          p.occurredAt = atOf(d, wall, ctx.dayStartHour);
        }
      }
      const mainMinor = mainOverride(it, m, currency, allowNeg, w);
      if (mainMinor !== undefined) p.override = { mainMinor };
      const toAmountMinor = toOverride(it, m, kind, currency, p.toAccountId ?? row.to_account_id, w);
      if (toAmountMinor !== undefined) p.override = { ...p.override, toAmountMinor };
      try {
        applyEntryPatch(row, p, m.ectx, nowIso);
      } catch (e) {
        throw userErr(e, w);
      }
      plans.push({ id: row.id, patch: p });
    }

    const todo = plans.filter((x) => Object.keys(x.patch).length > 0);
    const { rows, failed } = await writeEach(todo, (x) => ctx.deps.ticketRepo.updateEntry(x.id, x.patch), (i) => `entries（${todo[i].id}）`);
    const m2 = await loadMeta(ctx);
    const same = plans.length - todo.length;
    return {
      summary: `改了 ${rows.length} 筆帳${same ? `；${same} 筆沒有變動` : ""}${failed ? `；之後停在 ${failed}` : ""}`,
      data: { entries: rows.map((r) => entryView(r, m2, rt.routeById)) },
      ...(rows.length ? { changed: ["tk_entries"], toast: `外部助理改了 ${rows.length} 筆帳` } : {}),
    };
  },
};

const deleteEntries: McpTool = {
  name: "delete-ledger-entries",
  title: "刪帳",
  description: "刪除一到多筆帳（上限 50，軟刪除、App 裡可復原）。定期帳記出來的那一筆刪掉＝那一班不再補記。",
  inputSchema: {
    type: "object",
    properties: { ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" }, description: "帳的 id（find-ledger-entries）" } },
    required: ["ids"],
    additionalProperties: false,
  },
  module: MODULE,
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run(args: Args, ctx: McpCtx): Promise<McpOutcome> {
    const ids = idList(args, "ids");
    noDup(ids, "ids");
    const rows = await Promise.all(ids.map((id) => ctx.deps.ticketRepo.getEntry(id)));
    const missing = ids.filter((_, i) => rows[i] === null);
    if (missing.length) throw new McpUserError(`找不到這些帳：${missing.join("、")}（沒有刪任何一筆）`);
    const [m, rt] = await Promise.all([loadMeta(ctx), loadRoutes(ctx)]);
    const views = (rows as EntryRow[]).map((r) => entryView(r, m, rt.routeById));
    let done = 0;
    let failed: string | null = null;
    for (const id of ids) {
      try {
        await ctx.deps.ticketRepo.softDeleteEntry(id); // 同 store.deleteEntry；有 repeat_id 時同一批記進規則的 skipped_days
        done++;
      } catch (e) {
        if (done === 0) throw userErr(e, id);
        failed = userErr(e, id).message;
        break;
      }
    }
    return {
      summary: `刪了 ${done} 筆帳${failed ? `；之後停在 ${failed}` : ""}`,
      data: { deleted: views.slice(0, done) },
      changed: ["tk_entries", "tk_repeats"],
      toast: `外部助理刪了 ${done} 筆帳`,
      // 同 ticketStore.deleteEntry 的「復原」（restoreEntry）
      undo: done
        ? async () => {
            for (const id of ids.slice(0, done)) await ctx.deps.ticketRepo.restoreEntry(id);
            return ["tk_entries", "tk_repeats"];
          }
        : undefined,
    };
  },
};

export const LEDGER_TOOLS: McpTool[] = [findAccounts, findCategories, findEntries, getSummary, addEntries, updateEntries, deleteEntries];
