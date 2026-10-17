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
} from "../domain/ticket";
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
  "import_id",
  "import_source",
  "import_utime",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

type TkTable = "tk_currencies" | "tk_accounts" | "tk_categories" | "tk_entries";

const COLS_OF: Record<TkTable, readonly string[]> = {
  tk_currencies: CUR_COLS,
  tk_accounts: ACC_COLS,
  tk_categories: CAT_COLS,
  tk_entries: ENT_COLS,
};

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
    await this.commit(db, b);
  }

  async restoreEntry(id: string): Promise<void> {
    const db = await getDb();
    const row = await this.entryRow(db, id);
    if (!row || row.deleted_at === null) return;
    const b = newWriteBatch();
    pushUpdate(b, "tk_entries", id, { deleted_at: null, updated_at: nowUtcIso() });
    await this.commit(db, b);
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
      if (p.kind !== input.kind) throw new RangeError("分類和收支類型對不上");
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
    const parentWhere = c.parent_id === null ? "parent_id IS NULL" : "parent_id = $4";
    const args: unknown[] = [c.kind, UNCAT_INCOME_ID, UNCAT_EXPENSE_ID];
    if (c.parent_id !== null) args.push(c.parent_id);
    const sibs = await db.select<CategoryRow[]>(
      `SELECT * FROM tk_categories
       WHERE ${ALIVE} AND archived_at IS NULL AND kind = $1 AND id NOT IN ($2, $3) AND ${parentWhere}`,
      args,
    );
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
    const [currencies, accounts, categories, entries] = await Promise.all([
      db.select<CurrencyRow[]>(`SELECT * FROM tk_currencies`),
      db.select<AccountRow[]>(`SELECT * FROM tk_accounts`),
      db.select<CategoryRow[]>(`SELECT * FROM tk_categories`),
      db.select<EntryRow[]>(`SELECT * FROM tk_entries`),
    ]);
    return { currencies, accounts, categories, entries };
  }

  async applyImport(
    plan: ImportPlan,
    choices: Readonly<Record<string, ImportChoice>>,
    onProgress: (done: number, total: number) => void,
  ): Promise<ImportOutcome> {
    const db = await getDb();
    const m = materializeImport(plan, choices, nowUtcIso());

    // 第 1 批：幣別 → 帳戶 → 分類（plan.categories 已是父先子後）
    const first = newWriteBatch();
    for (const c of plan.currencies) pushInsert(first, "tk_currencies", c);
    for (const a of plan.accounts) pushInsert(first, "tk_accounts", a);
    for (const c of plan.categories) pushInsert(first, "tk_categories", c);
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
    };
  }
}
