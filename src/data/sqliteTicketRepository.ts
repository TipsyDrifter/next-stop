/**
 * 售票口線的 SQLite 實作（車次①契約 §3.5；甲席）。
 *
 * 寫法照 `sqliteTimetableRepository.ts`（`newWriteBatch → b.stmts.push → addOp → runWriteBatch`）：每支公開寫入＝
 * 讀現況 → domain 純函式推導（`buildEntryRow`／`applyEntryPatch`／`adjustRow`／`materializeImport`，與 mock 同一套）→
 * 一個 `WriteBatch` 落。資料語句與 op 同批、軟刪除、時間一律 `nowUtcIso()`（24 字元 ISO）。
 *
 * - op 的 cols（§3.5-1）：新列＝§3.2 白名單**完整列**（`deleted_at: null`）；改列＝真的改到的欄＋`updated_at`
 *   （值相同的欄不寫、不送 op；全部相同整筆跳過——逐欄 LWW，重新戳沒改的欄會蓋掉另一台的改動）；
 *   軟刪＝`delete` op `{ deleted_at, updated_at }`；復原＝`upsert` op `{ deleted_at: null, updated_at }`。
 * - 外鍵父先子後（0-15）：同一批內帳戶先於帳、主分類先於子分類；匯入第 1 批＝幣別＋帳戶＋分類，帳每 `IMPORT_CHUNK` 筆一批（0-21）。
 * - 起手三列（0-17）：依 id 查（含墓碑），缺幾列補幾列，幣別在前。
 * - 對 `./ticketRepository` 只用 `import type`（執行期不循環）。
 * - 第③階段（③契約 §3.5；甲席 Stage 1）：預算 upsert（`BUDGET_UPSERT`）、定期規則的寫入、實體化（reconcile → 查既有含墓碑 →
 *   只插沒有的 → 推游標）、`softDeleteEntry`／`restoreEntry` 同一批連動 `skipped_days`——推導全走 `ticketPlan.ts` 的純函式，與 mock 同義。
 */
import { invoke } from "@tauri-apps/api/core";
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { newWriteBatch, runWriteBatch, type SyncTable, type WriteBatch } from "./syncRepository";
import {
  CURRENCY_NAMES,
  IMPORT_CHUNK,
  STARTER_CATEGORIES,
  STARTER_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  adjustRow,
  applyEntryPatch,
  buildEntryRow,
  currencyCode,
  effectiveParentId,
  materializeImport,
  orderAccounts,
  parseRate,
  planAdjust,
  ticketId,
  type AccountRow,
  type CategoryKind,
  type CategoryRow,
  type CurrencyRow,
  type EntryCtx,
  type EntryPatch,
  type EntryRow,
  type ImportChoice,
  type ImportLocal,
  type ImportOutcome,
  type ImportPlan,
  type MmbakReadResult,
  type NewEntryInput,
  type UsageSince,
} from "../domain/ticket";
import {
  applyRepeatPatch,
  assertBudgetScope,
  budgetId,
  budgetRow,
  buildRepeatRow,
  materializeId,
  neverStarted,
  parseFixedRule,
  parseSkipped,
  planMaterialize,
  resumeNextOn,
  scanFrom,
  scopeKey,
  scopeOf,
  shiftDayOf,
  withSkipped,
  type BudgetRow,
  type BudgetScope,
  type NewRepeatInput,
  type PlanImportPart,
  type RepeatPatch,
  type RepeatRow,
} from "../domain/ticketPlan";
import { projectFixed } from "../domain/repeat";
import { todayKey } from "../lib/date";
import { matchesQuery } from "../domain/ticketView";
import type {
  AccountPatch,
  CurrencyPatch,
  EntryQuery,
  NewAccountInput,
  NewCategoryInput,
  NewCurrencyInput,
  TicketRepository,
} from "./ticketRepository";

const ALIVE = "deleted_at IS NULL";
/** `queryEntries` 的 `category_id IN (…)` 最多拼幾個參數（SQLite 預設上限 999，留餘裕給其他條件）；超過就改在 TS 補篩 */
const IN_LIMIT = 500;

/** §3.2 白名單（同步的「主人資料」欄；device_id／synced_at 不同步）。新列的 op 送這些欄的完整值。 */
const CUR_COLS = ["code", "name", "decimals", "rate_to_main", "is_main", "position", "created_at", "updated_at", "deleted_at"] as const;
const ACC_COLS = ["name", "group_key", "currency", "position", "archived_at", "created_at", "updated_at", "deleted_at"] as const;
const CAT_COLS = ["kind", "name", "parent_id", "position", "archived_at", "created_at", "updated_at", "deleted_at"] as const;
const ENT_COLS = [
  "kind",
  "occurred_on",
  "occurred_at",
  "account_id",
  "to_account_id",
  "category_id",
  "amount_minor",
  "currency",
  "main_minor",
  "account_minor",
  "to_amount_minor",
  "note",
  "route_id",
  "repeat_id", // 第③階段（③契約 0-3）
  "import_id",
  "import_source",
  "import_utime",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;
/** 第③階段（③契約 §3.2）：與 ticket.rs 的 TK_BUDGETS_COLS／TK_REPEATS_COLS 逐字相同 */
const BUD_COLS = [
  "kind",
  "category_id",
  "month",
  "amount_minor",
  "position",
  "import_id",
  "import_source",
  "import_utime",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;
const REP_COLS = [
  "kind",
  "account_id",
  "to_account_id",
  "category_id",
  "amount_minor",
  "currency",
  "note",
  "route_id",
  "rule",
  "hhmm",
  "next_on",
  "paused_at",
  "skipped_days",
  "position",
  "import_id",
  "import_source",
  "import_utime",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

type TkTable = "tk_currencies" | "tk_accounts" | "tk_categories" | "tk_entries" | "tk_budgets" | "tk_repeats";

const COLS_OF: Record<TkTable, readonly string[]> = {
  tk_currencies: CUR_COLS,
  tk_accounts: ACC_COLS,
  tk_categories: CAT_COLS,
  tk_entries: ENT_COLS,
  tk_budgets: BUD_COLS,
  tk_repeats: REP_COLS,
};
/** 預算的 upsert（③契約 §3.5-2）：重設同一個預算＝同一列、復活墓碑 */
const BUDGET_UPSERT = "DO UPDATE SET amount_minor = excluded.amount_minor, deleted_at = NULL, updated_at = excluded.updated_at";
const REPEAT_GONE = "這筆定期帳已經刪除了";

/** 陣列切段（`IN (…)` 不超過 `IN_LIMIT` 個參數、寫入每 `IMPORT_CHUNK` 筆一批） */
function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const isUncat = (id: string): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 往批次裡加一筆 op（＝sync_outbox 一列＋每個 col 一筆 sync_cells 戳記） */
function addOp(b: WriteBatch, tbl: SyncTable, rowId: string, op: "upsert" | "delete", cols: Record<string, unknown>): void {
  b.ops.push({ tbl, row_id: rowId, op, cols });
}

/** 白名單欄的完整值（新列的 op 用） */
function fullCols(tbl: TkTable, row: object): Record<string, unknown> {
  const r = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of COLS_OF[tbl]) out[c] = r[c] === undefined ? null : r[c];
  return out;
}

/**
 * 新列：`INSERT (id, 白名單欄) … ON CONFLICT(id) <onConflict>`＋完整列 upsert op。
 * `onConflict` 預設 `DO NOTHING`（確定性 id 的列兩台各建只留一列；匯入第 1 批與起手三列）。
 */
function pushInsert<T extends { id: string }>(b: WriteBatch, tbl: TkTable, row: T, onConflict = "DO NOTHING"): void {
  const cols = fullCols(tbl, row);
  const names = Object.keys(cols);
  const ph = names.map((_, i) => `$${i + 2}`).join(", ");
  b.stmts.push({
    sql: `INSERT INTO ${tbl} (id, ${names.join(", ")}) VALUES ($1, ${ph}) ON CONFLICT(id) ${onConflict}`,
    args: [row.id, ...names.map((n) => cols[n])],
  });
  addOp(b, tbl as SyncTable, row.id, "upsert", cols);
}

/** 改列：`UPDATE … SET <cols>`＋upsert op（cols 已含 updated_at；空 ⇒ 不寫） */
function pushUpdate(b: WriteBatch, tbl: TkTable, id: string, cols: Record<string, unknown>, where = ""): void {
  const names = Object.keys(cols);
  if (!names.length) return;
  const sets = names.map((n, i) => `${n} = $${i + 1}`).join(", ");
  b.stmts.push({
    sql: `UPDATE ${tbl} SET ${sets} WHERE id = $${names.length + 1}${where}`,
    args: [...names.map((n) => cols[n]), id],
  });
  addOp(b, tbl as SyncTable, id, "upsert", cols);
}

/** 鄰居互換（先把整組 position 攤成 0..n-1，再換；與 mock 的 swapIn 同義）⇒ 回真的要改的 { id, position } */
function planSwap<T extends { id: string; position: number }>(list: T[], id: string, delta: 1 | -1): { id: string; position: number }[] {
  const i = list.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [];
  const next = list.map((_x, k) => k);
  next[i] = j;
  next[j] = i;
  const out: { id: string; position: number }[] = [];
  list.forEach((x, k) => {
    if (x.position !== next[k]) out.push({ id: x.id, position: next[k] });
  });
  return out;
}

/** plugin-sql 對 INTEGER 回 number；EXISTS 回 0/1 */
const truthy = (v: unknown): boolean => v === 1 || v === true || v === "1";

export class SqliteTicketRepository implements TicketRepository {
  /* ───────── 內部 ───────── */

  private async commit(db: Database, b: WriteBatch): Promise<void> {
    if (!b.stmts.length && !b.ops.length) return;
    await runWriteBatch(db, b.stmts, b.ops);
  }

  /** 情境（§3.5-6）：未刪的帳戶、分類、幣別 */
  private async ctx(db: Database): Promise<EntryCtx> {
    const [accs, cats, curs] = await Promise.all([
      db.select<AccountRow[]>(`SELECT * FROM tk_accounts WHERE ${ALIVE}`),
      db.select<CategoryRow[]>(`SELECT * FROM tk_categories WHERE ${ALIVE}`),
      db.select<CurrencyRow[]>(`SELECT * FROM tk_currencies WHERE ${ALIVE}`),
    ]);
    const accById: Record<string, AccountRow> = {};
    const catById: Record<string, CategoryRow> = {};
    const curByCode: Record<string, CurrencyRow> = {};
    for (const a of accs) accById[a.id] = a;
    for (const c of cats) catById[c.id] = c;
    for (const c of curs) curByCode[c.code] = c;
    return { accById, catById, curByCode };
  }

  /** 含墓碑 */
  private async entryRow(db: Database, id: string): Promise<EntryRow | null> {
    const rows = await db.select<EntryRow[]>(`SELECT * FROM tk_entries WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  private async accountOrThrow(db: Database, id: string): Promise<AccountRow> {
    const rows = await db.select<AccountRow[]>(`SELECT * FROM tk_accounts WHERE id = $1 AND ${ALIVE}`, [id]);
    if (!rows[0]) throw new RangeError("這個帳戶已經不在了");
    return rows[0];
  }

  private async categoryOrThrow(db: Database, id: string): Promise<CategoryRow> {
    const rows = await db.select<CategoryRow[]>(`SELECT * FROM tk_categories WHERE id = $1 AND ${ALIVE}`, [id]);
    if (!rows[0]) throw new RangeError("這個分類已經不在了");
    return rows[0];
  }

  /** 同群組（未刪）的下一個 position */
  private async nextAccountPosition(db: Database, group: string): Promise<number> {
    const rows = await db.select<{ m: number | null }[]>(
      `SELECT MAX(position) AS m FROM tk_accounts WHERE group_key = $1 AND ${ALIVE}`,
      [group],
    );
    return (rows[0]?.m ?? -1) + 1;
  }

  /** §3.5-3 的單帳戶版 */
  private async balanceOf(db: Database, accountId: string): Promise<number> {
    const rows = await db.select<{ balance: number | null }[]>(
      `SELECT
         COALESCE((SELECT SUM(CASE WHEN e.kind IN ('expense','transfer') THEN -e.account_minor ELSE e.account_minor END)
                   FROM tk_entries e WHERE e.account_id = $1 AND e.deleted_at IS NULL), 0)
       + COALESCE((SELECT SUM(e.to_amount_minor)
                   FROM tk_entries e WHERE e.to_account_id = $1 AND e.kind = 'transfer' AND e.deleted_at IS NULL), 0) AS balance`,
      [accountId],
    );
    return Number(rows[0]?.balance ?? 0);
  }

  /* ───────── 起手 ───────── */

  async ensureStarterRows(): Promise<number> {
    const db = await getDb();
    // 不加 deleted_at 條件：墓碑也算「在」（0-17；三列本來不能刪，這裡只求冪等）
    const curHit = await db.select<{ id: string }[]>(`SELECT id FROM tk_currencies WHERE id = $1`, [STARTER_CURRENCY.id]);
    const catHit = await db.select<{ id: string }[]>(`SELECT id FROM tk_categories WHERE id IN ($1, $2)`, [
      STARTER_CATEGORIES[0].id,
      STARTER_CATEGORIES[1].id,
    ]);
    const have = new Set<string>([...curHit, ...catHit].map((r) => r.id));
    const now = nowUtcIso();
    const stamp = { created_at: now, updated_at: now, deleted_at: null };
    const b = newWriteBatch();
    let n = 0;
    if (!have.has(STARTER_CURRENCY.id)) {
      pushInsert(b, "tk_currencies", { ...STARTER_CURRENCY, ...stamp });
      n++;
    }
    for (const c of STARTER_CATEGORIES) {
      if (have.has(c.id)) continue;
      pushInsert(b, "tk_categories", { ...c, archived_at: null, ...stamp });
      n++;
    }
    await this.commit(db, b);
    return n;
  }

  /* ───────── 讀 ───────── */

  async listCurrencies(): Promise<CurrencyRow[]> {
    const db = await getDb();
    return db.select<CurrencyRow[]>(`SELECT * FROM tk_currencies WHERE ${ALIVE} ORDER BY position, code`);
  }

  async listAccounts(): Promise<AccountRow[]> {
    const db = await getDb();
    return orderAccounts(await db.select<AccountRow[]>(`SELECT * FROM tk_accounts WHERE ${ALIVE}`));
  }

  async listCategories(): Promise<CategoryRow[]> {
    const db = await getDb();
    return db.select<CategoryRow[]>(
      `SELECT * FROM tk_categories WHERE ${ALIVE} ORDER BY kind, (parent_id IS NOT NULL), position, created_at`,
    );
  }

  async balances(): Promise<Record<string, number>> {
    const db = await getDb();
    const rows = await db.select<{ id: string; balance: number | null }[]>(
      `SELECT a.id AS id,
         COALESCE((SELECT SUM(CASE WHEN e.kind IN ('expense','transfer') THEN -e.account_minor ELSE e.account_minor END)
                   FROM tk_entries e WHERE e.account_id = a.id AND e.deleted_at IS NULL), 0)
       + COALESCE((SELECT SUM(e.to_amount_minor)
                   FROM tk_entries e WHERE e.to_account_id = a.id AND e.kind = 'transfer' AND e.deleted_at IS NULL), 0) AS balance
       FROM tk_accounts a WHERE a.deleted_at IS NULL`,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = Number(r.balance ?? 0);
    return out;
  }

  async listEntries(fromDay: string, toDayExcl: string, accountId: string | null): Promise<EntryRow[]> {
    const db = await getDb();
    const acc = accountId === null ? "" : ` AND (account_id = $3 OR to_account_id = $3)`;
    const args: unknown[] = accountId === null ? [fromDay, toDayExcl] : [fromDay, toDayExcl, accountId];
    return db.select<EntryRow[]>(
      `SELECT * FROM tk_entries WHERE ${ALIVE} AND occurred_on >= $1 AND occurred_on < $2${acc}
       ORDER BY occurred_on DESC, occurred_at DESC, created_at DESC, id DESC`,
      args,
    );
  }

  /* ── 第②階段「看帳」的讀（②契約 §3.2；純讀，不寫 op） ── */

  /**
   * 結構條件查詢（0-14）：條件為空的子句不拼；ORDER BY 同 `listEntries`（＝`newestFirst`）。
   * `IN (…)` 的參數個數隨陣列長度拼；`category_id` 超過 `IN_LIMIT` 個就不拼那一句、改在 TS 用 `matchesQuery`
   * 補篩（結果與 SQL 版同義，ticket-view-logic 測試 24 鎖兩條路同結果）。關鍵字不在這裡（`matchesKeyword`）。
   */
  async queryEntries(q: EntryQuery): Promise<EntryRow[]> {
    const db = await getDb();
    const args: unknown[] = [];
    const arg = (v: unknown): string => {
      args.push(v);
      return `$${args.length}`;
    };
    const where: string[] = [ALIVE];
    if (q.from !== null) where.push(`occurred_on >= ${arg(q.from)}`);
    if (q.toExcl !== null) where.push(`occurred_on < ${arg(q.toExcl)}`);
    if (q.accountId !== null) {
      const p = arg(q.accountId);
      where.push(`(account_id = ${p} OR to_account_id = ${p})`);
    }
    const catInSql = q.categoryIds.length > 0 && q.categoryIds.length <= IN_LIMIT;
    if (catInSql) where.push(`category_id IN (${q.categoryIds.map(arg).join(", ")})`);
    if (q.kinds.length > 0) where.push(`kind IN (${q.kinds.map(arg).join(", ")})`);
    if (q.routeId === "none") where.push(`route_id IS NULL`);
    else if (q.routeId !== null) where.push(`route_id = ${arg(q.routeId)}`);
    const rows = await db.select<EntryRow[]>(
      `SELECT * FROM tk_entries WHERE ${where.join(" AND ")}
       ORDER BY occurred_on DESC, occurred_at DESC, created_at DESC, id DESC`,
      args,
    );
    return q.categoryIds.length > IN_LIMIT ? rows.filter((e) => matchesQuery(e, q)) : rows;
  }

  /** 路線花費（0-11）：直掛該路線的 expense `main_minor` 淨額；期間內與全部。SQL 聚合，沒有帳＝ 0／0 */
  async routeSpend(routeId: string, from: string, toExcl: string): Promise<{ inRange: number; allTime: number }> {
    const db = await getDb();
    const rows = await db.select<{ in_range: number | null; all_time: number | null }[]>(
      `SELECT
         COALESCE(SUM(CASE WHEN occurred_on >= $2 AND occurred_on < $3 THEN main_minor END), 0) AS in_range,
         COALESCE(SUM(main_minor), 0) AS all_time
       FROM tk_entries
       WHERE ${ALIVE} AND kind = 'expense' AND route_id = $1`,
      [routeId, from, toExcl],
    );
    return { inRange: Number(rows[0]?.in_range ?? 0), allTime: Number(rows[0]?.all_time ?? 0) };
  }

  async getEntry(id: string): Promise<EntryRow | null> {
    const db = await getDb();
    const rows = await db.select<EntryRow[]>(`SELECT * FROM tk_entries WHERE id = $1 AND ${ALIVE}`, [id]);
    return rows[0] ?? null;
  }

  async hasAnyEntry(): Promise<boolean> {
    const db = await getDb();
    const rows = await db.select<{ x: number }[]>(`SELECT EXISTS(SELECT 1 FROM tk_entries WHERE ${ALIVE}) AS x`);
    return truthy(rows[0]?.x);
  }

  async lastUsedAccountId(): Promise<string | null> {
    const db = await getDb();
    const rows = await db.select<{ account_id: string }[]>(
      `SELECT account_id FROM tk_entries WHERE ${ALIVE} AND kind <> 'adjust'
       ORDER BY created_at DESC, occurred_on DESC, occurred_at DESC, id DESC LIMIT 1`,
    );
    return rows[0]?.account_id ?? null;
  }

  async recentCategoryIds(kind: CategoryKind, limit: number): Promise<string[]> {
    const db = await getDb();
    // 每個分類取「最新」那一筆（created_at → occurred_on → occurred_at → id；匯入列 created_at 全同，靠後三者破平手），再依同一順序排
    const rows = await db.select<{ id: string }[]>(
      `SELECT id FROM (
         SELECT e.category_id AS id, e.created_at AS ca, e.occurred_on AS oo, e.occurred_at AS oa, e.id AS eid,
                ROW_NUMBER() OVER (PARTITION BY e.category_id
                                   ORDER BY e.created_at DESC, e.occurred_on DESC, e.occurred_at DESC, e.id DESC) AS rn
         FROM tk_entries e JOIN tk_categories c ON c.id = e.category_id
         WHERE e.deleted_at IS NULL AND e.kind = $1 AND c.deleted_at IS NULL AND c.archived_at IS NULL
           AND c.id NOT IN ($2, $3)
       ) WHERE rn = 1
       ORDER BY ca DESC, oo DESC, oa DESC, eid DESC LIMIT $4`,
      [kind, UNCAT_INCOME_ID, UNCAT_EXPENSE_ID, limit],
    );
    return rows.map((r) => r.id);
  }

  async usageSince(sinceDay: string): Promise<UsageSince> {
    const db = await getDb();
    const [cats, accs] = await Promise.all([
      db.select<{ id: string; n: number; last: string }[]>(
        `SELECT e.category_id AS id, COUNT(*) AS n, MAX(e.occurred_on || ' ' || e.occurred_at) AS last
         FROM tk_entries e JOIN tk_categories c ON c.id = e.category_id
         WHERE e.deleted_at IS NULL AND e.kind IN ('income', 'expense') AND e.occurred_on >= $1
           AND c.deleted_at IS NULL AND c.archived_at IS NULL AND c.id NOT IN ($2, $3)
         GROUP BY e.category_id`,
        [sinceDay, UNCAT_INCOME_ID, UNCAT_EXPENSE_ID],
      ),
      // 轉帳的兩端各算一次；校正（adjust）不是「用」帳戶，不算
      db.select<{ id: string; n: number }[]>(
        `SELECT id, COUNT(*) AS n FROM (
           SELECT account_id AS id FROM tk_entries WHERE deleted_at IS NULL AND kind <> 'adjust' AND occurred_on >= $1
           UNION ALL
           SELECT to_account_id AS id FROM tk_entries
           WHERE deleted_at IS NULL AND kind = 'transfer' AND to_account_id IS NOT NULL AND occurred_on >= $1
         ) GROUP BY id`,
        [sinceDay],
      ),
    ]);
    return {
      categories: cats.map((r) => ({ id: r.id, n: Number(r.n), last: String(r.last) })),
      accounts: accs.map((r) => ({ id: r.id, n: Number(r.n) })),
    };
  }

  /* ───────── 寫：帳 ───────── */

  async createEntry(input: NewEntryInput): Promise<EntryRow> {
    const db = await getDb();
    const row = buildEntryRow(input, await this.ctx(db), { id: uuid(), nowIso: nowUtcIso() });
    const b = newWriteBatch();
    pushInsert(b, "tk_entries", row, "DO NOTHING");
    await this.commit(db, b);
    return row;
  }

  async updateEntry(id: string, patch: EntryPatch): Promise<EntryRow> {
    const db = await getDb();
    const row = await this.entryRow(db, id);
    if (!row || row.deleted_at !== null) throw new RangeError("這一筆已經刪除了");
    const res = applyEntryPatch(row, patch, await this.ctx(db), nowUtcIso());
    if (Object.keys(res.cols).length === 0) return row;
    const b = newWriteBatch();
    pushUpdate(b, "tk_entries", id, res.cols, ` AND ${ALIVE}`);
    await this.commit(db, b);
    return res.row;
  }

  async softDeleteEntry(id: string): Promise<void> {
    const db = await getDb();
    const row = await this.entryRow(db, id);
    if (!row || row.deleted_at !== null) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE tk_entries SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, "tk_entries", id, "delete", { deleted_at: now, updated_at: now });
    await this.touchSkipped(db, b, row, true, now); // 第③階段（③契約 0-7-2）：同一批記進規則的 skipped_days
    await this.commit(db, b);
  }

  async restoreEntry(id: string): Promise<void> {
    const db = await getDb();
    const row = await this.entryRow(db, id);
    if (!row || row.deleted_at === null) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    pushUpdate(b, "tk_entries", id, { deleted_at: null, updated_at: now });
    await this.touchSkipped(db, b, row, false, now);
    await this.commit(db, b);
  }

  /**
   * 那筆 repeat_id 非空且規則還在 ⇒ 同一批 skipped_days 加／減那一班＋upsert op（值沒變就不寫；與 mock 的 touchSkipped 同義）。
   * 記的是**班次日**（shiftDayOf；帳改過日期也找得回原本那班），對不上（「設成定期」連上的那筆）就不碰（修正-資料，評審 R13／R14）。
   */
  private async touchSkipped(db: Database, b: WriteBatch, row: EntryRow, add: boolean, now: string): Promise<void> {
    if (!row.repeat_id) return;
    const rs = await db.select<RepeatRow[]>(`SELECT * FROM tk_repeats WHERE id = $1 AND ${ALIVE}`, [row.repeat_id]);
    const r = rs[0];
    if (!r) return;
    const day = shiftDayOf(r, row, todayKey(0));
    if (day === null) return;
    const next = withSkipped(r.skipped_days, day, add);
    if (next === r.skipped_days) return;
    pushUpdate(b, "tk_repeats", r.id, { skipped_days: next, updated_at: now }, ` AND ${ALIVE}`);
  }

  /* ───────── 寫：帳戶 ───────── */

  async createAccount(input: NewAccountInput): Promise<AccountRow> {
    const db = await getDb();
    const name = input.name.trim();
    if (!name) throw new RangeError("帳戶名稱不能是空的");
    const ctx = await this.ctx(db);
    if (!ctx.curByCode[input.currency]) throw new RangeError(`沒有這個幣別：${input.currency}`);
    const nowIso = nowUtcIso();
    const row: AccountRow = {
      id: uuid(),
      name,
      group_key: input.group,
      currency: input.currency,
      position: await this.nextAccountPosition(db, input.group),
      archived_at: null,
      device_id: null,
      created_at: nowIso,
      updated_at: nowIso,
      synced_at: null,
      deleted_at: null,
    };
    const b = newWriteBatch();
    pushInsert(b, "tk_accounts", row);
    if (input.openingMinor !== null && input.openingMinor !== 0) {
      // 期初餘額：同一批、帳戶之後（外鍵父先子後）
      const opening = adjustRow({
        account: row,
        amountMinor: input.openingMinor,
        occurredOn: input.occurredOn,
        nowIso,
        note: "期初餘額",
        id: uuid(),
        curByCode: ctx.curByCode,
      });
      pushInsert(b, "tk_entries", opening);
    }
    await this.commit(db, b);
    return row;
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<void> {
    const db = await getDb();
    const a = await this.accountOrThrow(db, id);
    const cols: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new RangeError("帳戶名稱不能是空的");
      if (name !== a.name) cols.name = name;
    }
    if (patch.currency !== undefined && patch.currency !== a.currency) {
      const ctx = await this.ctx(db);
      if (!ctx.curByCode[patch.currency]) throw new RangeError(`沒有這個幣別：${patch.currency}`);
      const used = await db.select<{ x: number }[]>(
        `SELECT EXISTS(SELECT 1 FROM tk_entries WHERE ${ALIVE} AND (account_id = $1 OR to_account_id = $1)) AS x`,
        [id],
      );
      if (truthy(used[0]?.x)) throw new RangeError("這個帳戶已經有帳，幣別不能改");
      cols.currency = patch.currency;
    }
    if (patch.group !== undefined && patch.group !== a.group_key) {
      cols.group_key = patch.group;
      cols.position = await this.nextAccountPosition(db, patch.group);
    }
    if (!Object.keys(cols).length) return;
    cols.updated_at = nowUtcIso();
    const b = newWriteBatch();
    pushUpdate(b, "tk_accounts", id, cols);
    await this.commit(db, b);
  }

  async setAccountArchived(id: string, archived: boolean): Promise<void> {
    const db = await getDb();
    const a = await this.accountOrThrow(db, id);
    if ((a.archived_at !== null) === archived) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    pushUpdate(b, "tk_accounts", id, { archived_at: archived ? now : null, updated_at: now });
    await this.commit(db, b);
  }

  async moveAccount(id: string, delta: 1 | -1): Promise<void> {
    const db = await getDb();
    const a = await this.accountOrThrow(db, id);
    const sibs = await db.select<AccountRow[]>(
      `SELECT * FROM tk_accounts WHERE ${ALIVE} AND archived_at IS NULL AND group_key = $1`,
      [a.group_key],
    );
    const moves = planSwap(orderAccounts(sibs), id, delta);
    if (!moves.length) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    for (const m of moves) pushUpdate(b, "tk_accounts", m.id, { position: m.position, updated_at: now });
    await this.commit(db, b);
  }

  async adjustBalance(accountId: string, targetMinor: number, occurredOn: string, note: string): Promise<EntryRow | null> {
    const db = await getDb();
    const a = await this.accountOrThrow(db, accountId);
    const d = planAdjust(await this.balanceOf(db, accountId), targetMinor);
    if (d === null) return null;
    const ctx = await this.ctx(db);
    const row = adjustRow({ account: a, amountMinor: d, occurredOn, nowIso: nowUtcIso(), note, id: uuid(), curByCode: ctx.curByCode });
    const b = newWriteBatch();
    pushInsert(b, "tk_entries", row);
    await this.commit(db, b);
    return row;
  }

  /* ───────── 寫：分類 ───────── */

  async createCategory(input: NewCategoryInput): Promise<CategoryRow> {
    const db = await getDb();
    const name = input.name.trim();
    if (!name) throw new RangeError("分類名稱不能是空的");
    if (input.parentId !== null) {
      if (isUncat(input.parentId)) throw new RangeError("「未分類」下面不能建子分類");
      const p = await this.categoryOrThrow(db, input.parentId);
      if (p.kind !== input.kind) throw new RangeError("這個分類不屬於目前的收支類型");
      if (p.parent_id !== null) throw new RangeError("分類只有兩層");
    }
    const parentWhere = input.parentId === null ? "parent_id IS NULL" : "parent_id = $4";
    const args: unknown[] = [input.kind, UNCAT_INCOME_ID, UNCAT_EXPENSE_ID];
    if (input.parentId !== null) args.push(input.parentId);
    const max = await db.select<{ m: number | null }[]>(
      `SELECT MAX(position) AS m FROM tk_categories
       WHERE ${ALIVE} AND kind = $1 AND id NOT IN ($2, $3) AND ${parentWhere}`,
      args,
    );
    const nowIso = nowUtcIso();
    const row: CategoryRow = {
      id: uuid(),
      kind: input.kind,
      name,
      parent_id: input.parentId,
      position: (max[0]?.m ?? -1) + 1,
      archived_at: null,
      device_id: null,
      created_at: nowIso,
      updated_at: nowIso,
      synced_at: null,
      deleted_at: null,
    };
    const b = newWriteBatch();
    pushInsert(b, "tk_categories", row);
    await this.commit(db, b);
    return row;
  }

  async renameCategory(id: string, name: string): Promise<void> {
    if (isUncat(id)) throw new RangeError("「未分類」不能改名或封存");
    const db = await getDb();
    const c = await this.categoryOrThrow(db, id);
    const n = name.trim();
    if (!n) throw new RangeError("分類名稱不能是空的");
    if (n === c.name) return;
    const b = newWriteBatch();
    pushUpdate(b, "tk_categories", id, { name: n, updated_at: nowUtcIso() });
    await this.commit(db, b);
  }

  async setCategoryArchived(id: string, archived: boolean): Promise<void> {
    if (isUncat(id)) throw new RangeError("「未分類」不能改名或封存");
    const db = await getDb();
    const c = await this.categoryOrThrow(db, id);
    const kids = await db.select<CategoryRow[]>(`SELECT * FROM tk_categories WHERE ${ALIVE} AND parent_id = $1`, [id]);
    const now = nowUtcIso();
    const b = newWriteBatch();
    if (archived) {
      if (c.archived_at !== null) return;
      // 它與它未封存的子分類同一個 archived_at（取消封存時靠這個值認出「連帶封存」的那些）
      pushUpdate(b, "tk_categories", id, { archived_at: now, updated_at: now });
      for (const k of kids) if (k.archived_at === null) pushUpdate(b, "tk_categories", k.id, { archived_at: now, updated_at: now });
    } else {
      if (c.archived_at === null) return;
      const was = c.archived_at;
      pushUpdate(b, "tk_categories", id, { archived_at: null, updated_at: now });
      for (const k of kids) if (k.archived_at === was) pushUpdate(b, "tk_categories", k.id, { archived_at: null, updated_at: now });
    }
    await this.commit(db, b);
  }

  async moveCategory(id: string, delta: 1 | -1): Promise<void> {
    if (isUncat(id)) return;
    const db = await getDb();
    const c = await this.categoryOrThrow(db, id);
    // 找兄弟看「實際掛在哪一層」（D-票-62）：父列已不在的子分類跟主分類同一層，與 categoryTree 的顯示一致
    const all = await db.select<CategoryRow[]>(
      `SELECT * FROM tk_categories WHERE ${ALIVE} AND kind = $1 AND id NOT IN ($2, $3)`,
      [c.kind, UNCAT_INCOME_ID, UNCAT_EXPENSE_ID],
    );
    const byId: Record<string, CategoryRow> = {};
    for (const x of all) byId[x.id] = x;
    const level = effectiveParentId(c, byId);
    const sibs = all.filter((x) => x.archived_at === null && effectiveParentId(x, byId) === level);
    sibs.sort((a, b) => a.position - b.position || cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
    const moves = planSwap(sibs, id, delta);
    if (!moves.length) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    for (const m of moves) pushUpdate(b, "tk_categories", m.id, { position: m.position, updated_at: now });
    await this.commit(db, b);
  }

  /* ───────── 寫：幣別 ───────── */

  async createCurrency(input: NewCurrencyInput): Promise<CurrencyRow> {
    const db = await getDb();
    const code = currencyCode(input.code);
    const id = ticketId("currency:" + code);
    const prevRows = await db.select<CurrencyRow[]>(`SELECT * FROM tk_currencies WHERE id = $1`, [id]);
    const prev = prevRows[0] ?? null;
    if (prev && prev.deleted_at === null) throw new RangeError(`已經有 ${code} 了`);
    const rate = parseRate(input.rate);
    const max = await db.select<{ m: number | null }[]>(`SELECT MAX(position) AS m FROM tk_currencies WHERE ${ALIVE}`);
    const nowIso = nowUtcIso();
    const row: CurrencyRow = {
      id,
      code,
      name: input.name.trim() || (CURRENCY_NAMES[code] ?? code),
      decimals: Number.isInteger(input.decimals) && input.decimals >= 0 ? input.decimals : 2,
      rate_to_main: rate,
      is_main: 0,
      position: (max[0]?.m ?? -1) + 1,
      device_id: null,
      created_at: prev ? prev.created_at : nowIso,
      updated_at: nowIso,
      synced_at: null,
      deleted_at: null,
    };
    const b = newWriteBatch();
    // 確定性 id：之前刪過的同幣別 ⇒ 覆寫整列、復活（created_at 保留原值）
    pushInsert(
      b,
      "tk_currencies",
      row,
      `DO UPDATE SET code = excluded.code, name = excluded.name, decimals = excluded.decimals,
         rate_to_main = excluded.rate_to_main, is_main = excluded.is_main, position = excluded.position,
         updated_at = excluded.updated_at, deleted_at = NULL`,
    );
    await this.commit(db, b);
    return row;
  }

  async updateCurrency(id: string, patch: CurrencyPatch): Promise<void> {
    const db = await getDb();
    const rows = await db.select<CurrencyRow[]>(`SELECT * FROM tk_currencies WHERE id = $1 AND ${ALIVE}`, [id]);
    const c = rows[0];
    if (!c) throw new RangeError(`沒有這個幣別：${id}`);
    const cols: Record<string, unknown> = {};
    if (patch.rate !== undefined) {
      if (c.is_main === 1) throw new RangeError("主幣別的匯率固定是 1");
      const rate = parseRate(patch.rate);
      if (rate !== c.rate_to_main) cols.rate_to_main = rate;
    }
    if (patch.name !== undefined && patch.name.trim() && patch.name.trim() !== c.name) cols.name = patch.name.trim();
    if (!Object.keys(cols).length) return;
    cols.updated_at = nowUtcIso();
    const b = newWriteBatch();
    pushUpdate(b, "tk_currencies", id, cols);
    await this.commit(db, b);
  }

  /* ───────── 匯入 ───────── */

  async pickImportFile(shell: "desktop" | "mobile"): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    // 手機不帶 filters：Android 的 showFilePicker 設了 filter 就只列得到 MIME 對得上的（.mmbak 的 MIME 不明，probe §2）
    const picked =
      shell === "desktop"
        ? await open({
            multiple: false,
            directory: false,
            title: "選財務管家的備份檔",
            filters: [{ name: "財務管家備份", extensions: ["mmbak"] }],
          })
        : await open({ multiple: false, directory: false, title: "選財務管家的備份檔" });
    return typeof picked === "string" ? picked : null;
  }

  async readImport(path: string): Promise<MmbakReadResult> {
    // 錯誤字串原樣往上丟（store 包成 toast）
    return invoke<MmbakReadResult>("ticket_import_read", { path });
  }

  async loadImportLocal(): Promise<ImportLocal> {
    const db = await getDb();
    const [currencies, accounts, categories, entries, budgets, repeats] = await Promise.all([
      db.select<CurrencyRow[]>(`SELECT * FROM tk_currencies`),
      db.select<AccountRow[]>(`SELECT * FROM tk_accounts`),
      db.select<CategoryRow[]>(`SELECT * FROM tk_categories`),
      db.select<EntryRow[]>(`SELECT * FROM tk_entries`),
      db.select<BudgetRow[]>(`SELECT * FROM tk_budgets`),
      db.select<RepeatRow[]>(`SELECT * FROM tk_repeats`),
    ]);
    return { currencies, accounts, categories, entries, budgets, repeats };
  }

  async applyImport(
    plan: ImportPlan,
    choices: Readonly<Record<string, ImportChoice>>,
    part: PlanImportPart,
    onProgress: (done: number, total: number) => void,
  ): Promise<ImportOutcome> {
    const db = await getDb();
    const m = materializeImport(plan, choices, nowUtcIso());

    // 第 1 批：幣別 → 帳戶 → 分類（plan.categories 已是父先子後）
    const first = newWriteBatch();
    for (const c of plan.currencies) pushInsert(first, "tk_currencies", c);
    for (const a of plan.accounts) pushInsert(first, "tk_accounts", a);
    for (const c of plan.categories) pushInsert(first, "tk_categories", c);
    // 第③階段（③契約 §3.5-8）：第 1 批尾端接預算與規則（父先：分類已在同批前面）
    for (const b of part.budgets.inserts) pushInsert(first, "tk_budgets", b, BUDGET_UPSERT);
    for (const u of part.budgets.updates) pushUpdate(first, "tk_budgets", u.id, u.cols, ` AND ${ALIVE}`);
    for (const r of part.repeats.inserts) pushInsert(first, "tk_repeats", r);
    for (const u of part.repeats.updates) pushUpdate(first, "tk_repeats", u.id, u.cols, ` AND ${ALIVE}`);
    await this.commit(db, first);

    // 之後：帳每 IMPORT_CHUNK 筆一批（0-21）；中途失敗＝前幾批已落，重跑同一個檔會補完（確定性 id）
    type Op = { kind: "insert"; row: EntryRow } | { kind: "update"; id: string; cols: Record<string, unknown> };
    const ops: Op[] = [
      ...m.entryInserts.map((row): Op => ({ kind: "insert", row })),
      ...m.entryUpdates.map((u): Op => ({ kind: "update", id: u.id, cols: u.cols })),
      // 「留 Next Stop 的」：只蓋 import_utime／updated_at 的記號（不算 updated）
      ...m.entryKept.map((u): Op => ({ kind: "update", id: u.id, cols: u.cols })),
    ];
    const total = ops.length;
    let done = 0;
    onProgress(0, total);
    for (let i = 0; i < ops.length; i += IMPORT_CHUNK) {
      const b = newWriteBatch();
      for (const op of ops.slice(i, i + IMPORT_CHUNK)) {
        if (op.kind === "insert") pushInsert(b, "tk_entries", op.row);
        else pushUpdate(b, "tk_entries", op.id, op.cols, ` AND ${ALIVE}`);
      }
      await this.commit(db, b);
      done = Math.min(total, i + IMPORT_CHUNK);
      onProgress(done, total);
    }
    const e = plan.entries;
    return {
      inserted: m.entryInserts.length,
      updated: m.entryUpdates.length,
      skipped: e.unchanged + e.tombstoned + e.invalid.length + m.keptLocal,
      budgets: part.budgets.inserts.length + part.budgets.updates.length,
      repeats: part.repeats.inserts.length + part.repeats.updates.length,
    };
  }

  /* ───────── 第③階段「管帳」：預算（③契約 §3.4、§3.5-2） ───────── */

  async listBudgets(): Promise<BudgetRow[]> {
    const db = await getDb();
    // 與 mock 同序：position → month（預設 '' 在前）→ id
    return db.select<BudgetRow[]>(`SELECT * FROM tk_budgets WHERE ${ALIVE} ORDER BY position, COALESCE(month, ''), id`);
  }

  /**
   * 依 (scope, month) 算 id（0-4）⇒ `INSERT … ON CONFLICT(id) DO UPDATE SET amount_minor, deleted_at = NULL, updated_at`。
   * 已有這一列（含墓碑）⇒ 用它的 position／created_at／import_* 組完整列：本機 DO UPDATE 只改三欄，op 的完整列與本機一致
   * （不然另一台會收到新的 position／created_at，兩台不同）。op＝完整列 upsert（復活另一台的墓碑＝「重設同一個預算」）。
   */
  async setBudget(scope: BudgetScope, month: string | null, amountMinor: number): Promise<BudgetRow> {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new RangeError("預算要是大於 0 的金額");
    const db = await getDb();
    assertBudgetScope(scope, (await this.ctx(db)).catById);
    const id = budgetId(scope, month);
    const now = nowUtcIso();
    const prevRows = await db.select<BudgetRow[]>(`SELECT * FROM tk_budgets WHERE id = $1`, [id]);
    const prev = prevRows[0] ?? null;
    let row: BudgetRow;
    if (prev) row = { ...prev, amount_minor: amountMinor, deleted_at: null, updated_at: now };
    else {
      const max = await db.select<{ m: number | null }[]>(`SELECT MAX(position) AS m FROM tk_budgets WHERE ${ALIVE}`);
      row = budgetRow(scope, month, amountMinor, (max[0]?.m ?? -1) + 1, now);
    }
    const b = newWriteBatch();
    pushInsert(b, "tk_budgets", row, BUDGET_UPSERT);
    await this.commit(db, b);
    return row;
  }

  /** 軟刪那一列；移除預設（month null）⇒ 連同該對象所有月的覆寫一起軟刪（同一批，每列一個 delete op） */
  async removeBudget(scope: BudgetScope, month: string | null): Promise<void> {
    const db = await getDb();
    const key = scopeKey(scope);
    const alive = await db.select<BudgetRow[]>(`SELECT * FROM tk_budgets WHERE ${ALIVE}`);
    const hit = alive.filter((r) => scopeKey(scopeOf(r)) === key && (month === null || r.month === month));
    if (!hit.length) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    for (const r of hit) {
      b.stmts.push({ sql: `UPDATE tk_budgets SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, r.id] });
      addOp(b, "tk_budgets", r.id, "delete", { deleted_at: now, updated_at: now });
    }
    await this.commit(db, b);
  }

  /* ───────── 第③階段「管帳」：定期帳（③契約 §3.4、§3.5-3～6、0-6～0-8） ───────── */

  /** 未刪的規則（含暫停）：進行中在前、依 next_on（沒有下一班在最後）、created_at、id（＝ ticketPlan.repeatOrder） */
  async listRepeats(): Promise<RepeatRow[]> {
    const db = await getDb();
    return db.select<RepeatRow[]>(
      `SELECT * FROM tk_repeats WHERE ${ALIVE}
       ORDER BY (paused_at IS NOT NULL), COALESCE(next_on, '9999-99-99'), created_at, id`,
    );
  }

  private async repeatOrThrow(db: Database, id: string): Promise<RepeatRow> {
    const rows = await db.select<RepeatRow[]>(`SELECT * FROM tk_repeats WHERE id = $1 AND ${ALIVE}`, [id]);
    if (!rows[0]) throw new RangeError(REPEAT_GONE);
    return rows[0];
  }

  async createRepeat(input: NewRepeatInput): Promise<RepeatRow> {
    const db = await getDb();
    const max = await db.select<{ m: number | null }[]>(`SELECT MAX(position) AS m FROM tk_repeats WHERE ${ALIVE}`);
    const row = buildRepeatRow(input, await this.ctx(db), { id: uuid(), position: (max[0]?.m ?? -1) + 1, nowIso: nowUtcIso() });
    const b = newWriteBatch();
    pushInsert(b, "tk_repeats", row);
    await this.commit(db, b);
    return row;
  }

  /** 模板或規則變了 ⇒ 寫有差的欄；rule 變了 ⇒ next_on＝nextFixedDate(新規則, today)（0-8，applyRepeatPatch）；沒變 ⇒ 不寫 */
  async updateRepeat(id: string, patch: RepeatPatch, today: string): Promise<RepeatRow> {
    const db = await getDb();
    const r = await this.repeatOrThrow(db, id);
    const res = applyRepeatPatch(r, patch, await this.ctx(db), today, nowUtcIso());
    if (Object.keys(res.cols).length === 0) return r;
    const b = newWriteBatch();
    pushUpdate(b, "tk_repeats", id, res.cols, ` AND ${ALIVE}`);
    await this.commit(db, b);
    return res.row;
  }

  /** 「從沒開始過」要看有沒有帳（含墓碑）的 repeat_id 指向它（neverStarted）；只撈 repeat_id 一欄 */
  private async repeatRefs(db: Database, ids: readonly string[]): Promise<{ repeat_id: string | null }[]> {
    const out: { repeat_id: string | null }[] = [];
    for (const part of chunks(ids, IN_LIMIT)) {
      const ph = part.map((_, i) => `$${i + 1}`).join(", ");
      const rows = await db.select<{ repeat_id: string | null }[]>(
        `SELECT DISTINCT repeat_id FROM tk_entries WHERE repeat_id IN (${ph})`,
        part as unknown[],
      );
      for (const x of rows) out.push(x);
    }
    return out;
  }

  /** 開始一條：手建的（或開始過的）明天起、從沒開始過的匯入規則接著 next_on（resumeNextOn，✎-8）；next_on 沒變就不寫那欄 */
  private resumeCols(r: RepeatRow, refs: readonly { repeat_id: string | null }[], today: string, now: string): Record<string, unknown> {
    const next = resumeNextOn(r, refs, today); // 規則看不懂 ⇒ RangeError
    const cols: Record<string, unknown> = { paused_at: null };
    if (next !== r.next_on) cols.next_on = next;
    cols.updated_at = now;
    return cols;
  }

  async setRepeatPaused(id: string, paused: boolean, today: string): Promise<void> {
    const db = await getDb();
    const r = await this.repeatOrThrow(db, id);
    if ((r.paused_at !== null) === paused) return;
    const now = nowUtcIso();
    const cols = paused ? { paused_at: now, updated_at: now } : this.resumeCols(r, await this.repeatRefs(db, [id]), today, now);
    const b = newWriteBatch();
    pushUpdate(b, "tk_repeats", id, cols, ` AND ${ALIVE}`);
    await this.commit(db, b);
  }

  /** 暫停中、從沒開始過的匯入規則＋它們的 refs（listUnstartedRepeatIds／resumeAllRepeats 共用同一個判法） */
  private async unstartedRepeats(db: Database): Promise<{ list: RepeatRow[]; refs: { repeat_id: string | null }[] }> {
    const paused = await db.select<RepeatRow[]>(
      `SELECT * FROM tk_repeats WHERE ${ALIVE} AND paused_at IS NOT NULL AND import_source IS NOT NULL ORDER BY created_at, id`,
    );
    if (!paused.length) return { list: [], refs: [] };
    const refs = await this.repeatRefs(
      db,
      paused.map((r) => r.id),
    );
    return { list: paused.filter((r) => neverStarted(r, refs)), refs };
  }

  async listUnstartedRepeatIds(): Promise<string[]> {
    const db = await getDb();
    return (await this.unstartedRepeats(db)).list.map((r) => r.id);
  }

  /** 全部開始（0-1）：只開始從沒開始過的匯入規則；先全部算好再寫（其中一條規則看不懂 ⇒ 丟錯、整批不動）；同一批；回開始了幾條 */
  async resumeAllRepeats(today: string): Promise<number> {
    const db = await getDb();
    const { list, refs } = await this.unstartedRepeats(db);
    if (!list.length) return 0;
    const now = nowUtcIso();
    const all = list.map((r) => ({ id: r.id, cols: this.resumeCols(r, refs, today, now) }));
    const b = newWriteBatch();
    for (const x of all) pushUpdate(b, "tk_repeats", x.id, x.cols, ` AND ${ALIVE}`);
    await this.commit(db, b);
    return list.length;
  }

  async softDeleteRepeat(id: string): Promise<void> {
    const db = await getDb();
    const rows = await db.select<RepeatRow[]>(`SELECT * FROM tk_repeats WHERE id = $1`, [id]);
    if (!rows[0] || rows[0].deleted_at !== null) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE tk_repeats SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, "tk_repeats", id, "delete", { deleted_at: now, updated_at: now });
    await this.commit(db, b);
  }

  async restoreRepeat(id: string): Promise<void> {
    const db = await getDb();
    const rows = await db.select<RepeatRow[]>(`SELECT * FROM tk_repeats WHERE id = $1`, [id]);
    if (!rows[0] || rows[0].deleted_at === null) return;
    const b = newWriteBatch();
    pushUpdate(b, "tk_repeats", id, { deleted_at: null, updated_at: nowUtcIso() });
    await this.commit(db, b);
  }

  /** 「設成定期」後把那筆帳連到規則：tk_entries.repeat_id＝id（已經是就不寫） */
  async linkEntryToRepeat(entryId: string, repeatId: string): Promise<void> {
    const db = await getDb();
    const e = await this.entryRow(db, entryId);
    if (!e || e.deleted_at !== null) throw new RangeError("這一筆已經刪除了");
    await this.repeatOrThrow(db, repeatId);
    if (e.repeat_id === repeatId) return;
    const b = newWriteBatch();
    pushUpdate(b, "tk_entries", entryId, { repeat_id: repeatId, updated_at: nowUtcIso() }, ` AND ${ALIVE}`);
    await this.commit(db, b);
  }

  /**
   * 實體化（③契約 0-6-3、§3.5-3）：
   *   (a) reconcile：skipped_days 每一天算出的 id，本機還活著的再軟刪一次（新 hlc，0-7-3）——每筆一個 delete op
   *   (b) 候選 id 查既有（**含墓碑**，`SELECT id … IN (…)` 不加 deleted_at 條件；超過 IN_LIMIT 切段）
   *   (c) 插入：只對 (b) 沒回的 id（`ON CONFLICT(id) DO NOTHING`＋完整列 upsert op）——不對已存在的 id 發 op
   *   (d) 游標：next_on 值變了才寫（planMaterialize 只出有變的）
   * 候選＝每條進行中、規則看得懂、沒結束的規則 `projectFixed(rule, scanFrom(r, rule, today), today)` 的每一班（與 planMaterialize 掃的範圍逐字相同），
   * 所以 existingIds 只需要這些 id，不用把整張 tk_entries 的 id 撈出來。
   * 分批：帳每 IMPORT_CHUNK 筆一批；reconcile 在第一批、游標在最後一批（中途失敗＝游標沒推，下一輪靠確定性 id 補完、不重複）。
   * **`next_on` 是游標不是真相**（0-6-4）：兩台 LWW 可能回退，回退只會讓下一輪多掃幾天；確定性 id＋墓碑檢查保證不重複。
   * 「今天」已由呼叫端用日界線算好（0-6-6）；`dayStartHour` 傳給 planMaterialize 算帳的時刻：手建的規則套日界線、匯入的規則字面時刻（repeatDayStart，✎-7 改）。
   */
  async materializeRepeats(
    today: string,
    dayStartHour: number,
  ): Promise<{ inserted: number; reconciled: number; blocked: { id: string; reason: string }[] }> {
    const db = await getDb();
    const repeats = await db.select<RepeatRow[]>(`SELECT * FROM tk_repeats WHERE ${ALIVE} ORDER BY position, created_at, id`);
    if (!repeats.length) return { inserted: 0, reconciled: 0, blocked: [] };

    // (b) 候選 id：reconcile 的日子＋每條進行中規則要掃的班次
    const cand = new Set<string>();
    for (const r of repeats) {
      for (const d of parseSkipped(r.skipped_days)) cand.add(materializeId(r.id, d));
      if (r.paused_at !== null) continue;
      const rule = parseFixedRule(r.rule);
      if (!rule) continue;
      const from = scanFrom(r, rule, today); // null＝已結束：不掃（與 planMaterialize 同一支，評審 R15）
      if (from === null) continue;
      for (const d of projectFixed(rule, from, today)) cand.add(materializeId(r.id, d));
    }
    const existing = new Set<string>();
    const alive = new Set<string>();
    for (const part of chunks(Array.from(cand), IN_LIMIT)) {
      const ph = part.map((_, i) => `$${i + 1}`).join(", ");
      const rows = await db.select<{ id: string; deleted_at: string | null }[]>(
        `SELECT id, deleted_at FROM tk_entries WHERE id IN (${ph})`,
        part as unknown[],
      );
      for (const x of rows) {
        existing.add(x.id);
        if (x.deleted_at === null) alive.add(x.id);
      }
    }

    const now = nowUtcIso();
    const plan = planMaterialize(repeats, existing, today, await this.ctx(db), now, dayStartHour);

    // (a) reconcile：本機還活著的才軟刪（墓碑不再發 op）
    const reconcile: string[] = [];
    for (const id of plan.reconcileIds) if (alive.has(id) && reconcile.indexOf(id) < 0) reconcile.push(id);

    const inserts = plan.inserts.filter((row) => !existing.has(row.id));
    const groups = inserts.length ? chunks(inserts, IMPORT_CHUNK) : [[]];
    for (let i = 0; i < groups.length; i++) {
      const b = newWriteBatch();
      if (i === 0) {
        for (const id of reconcile) {
          b.stmts.push({ sql: `UPDATE tk_entries SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND ${ALIVE}`, args: [now, id] });
          addOp(b, "tk_entries", id, "delete", { deleted_at: now, updated_at: now });
        }
      }
      // (c) 帳戶／分類已在本機（buildEntryRow 只收未刪的），外鍵父已在
      for (const row of groups[i]) pushInsert(b, "tk_entries", row, "DO NOTHING");
      // (d) 游標在最後一批
      if (i === groups.length - 1) {
        for (const c of plan.cursors) pushUpdate(b, "tk_repeats", c.id, { next_on: c.next_on, updated_at: now }, ` AND ${ALIVE}`);
      }
      await this.commit(db, b);
    }
    return { inserted: inserts.length, reconciled: reconcile.length, blocked: plan.blocked };
  }
}
