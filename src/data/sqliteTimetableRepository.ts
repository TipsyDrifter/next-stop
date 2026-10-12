/**
 * 時刻表線的 SQLite 實作（車次①a 契約 §3.5；甲席）。
 *
 * 寫法照 `sqliteNodeRepository.ts`（`newWriteBatch → b.stmts.push → addOp → runWriteBatch`）：
 * 每支公開寫入＝讀 span（§3.5-1）→ 純函式算 `WritePlan`（`src/domain/timetable.ts`）→ `applyPlan` 一個
 * `WriteBatch` 落（§3.5-2）。資料語句與 op 同批、軟刪除、時間一律經 `isoOf`／`msOf`（24 字元 ISO，SQL 端字串比較）。
 *
 * - `pieceId(key)`：整理切出來的片段的確定性 id（uuid v5，命名空間 `TIMETABLE_ID_NAMESPACE`、name 前綴 `"piece:"`；
 *   寫法照 `syncRepository.ts` 的 `occurrenceId`）。mock 也用它。
 * - `reconcile()` 的寫入鍵（§3.5-4、契約 0-8 的 2026-10-11 改訂、D-時-26）：**該列 `started_at` 那一格**的
 *   `sync_cells.hlc` ＋ `"|"` ＋ `updated_at`（由 `reconcileWriteKey` 組）。不再取整列 MAX：一直開著、事後才寫下
 *   結束的那班會因此變成最晚，把另一台離線記的時段整段吃掉（沙盒 F3）；看「誰比較晚發車」才對。沒有那一格的列在
 *   hlc 位置放一個空白 `" "`（0x20 小於 hlc 會出現的任何字元 0-9／a-f／`-`），所以**沒有格子的列永遠排最早**——不能
 *   放空字串：`"" + "|"` 以 `|`（0x7C）開頭，字典序反而大於任何真 hlc。`sync_cells` 不在（還原中途的舊 DB）就只用
 *   `" |" + updated_at`，由 `ensureSyncTables` 判斷。掃描範圍＝最近 `RECONCILE_WINDOW_DAYS` 天＋所有運行中
 *   （契約 §9-6 退路；與 §3.5-4「不帶條件」的偏差見沙盒回報 F2 的處置）。
 * - 起手分類（§3.5-5、契約 0-3）：表完全沒有列（含墓碑）才種 19 列＋19 筆完整 upsert op，父列排在子列前。
 *   「同步先拉一趟再種」的閘門在 store（§3.7.1），本檔只管冪等地種。
 * - 設定讀寫不在這裡（store 直接用 `settingsRepo`）。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { dayWindow } from "../lib/date";
import { ensureSyncTables, newWriteBatch, runWriteBatch, type SyncTable, type WriteBatch } from "./syncRepository";
import type { TimetableRepository, CreateCategoryInput, CategoryPatch } from "./timetableRepository";
import {
  MIN,
  STARTER_CATEGORIES,
  TIMETABLE_ID_NAMESPACE,
  canUndoArrive,
  groupedCategories,
  isoOf,
  msOf,
  planArrive,
  planCover,
  planDepart,
  planEdit,
  planFill,
  planReconcile,
  planResolveLongRun,
  planRestart,
  planSplit,
  reconcileWindowStart,
  reconcileWriteKey,
  segmentsOfDay,
  summarizeCover,
  toDayBlockSegments,
  toSpan,
  type CoverSummary,
  type DayBlockSegment,
  type KeyedSpan,
  type LongRunChoice,
  type Span,
  type TimeBlockRow,
  type TimeCategoryRow,
  type WritePlan,
} from "../domain/timetable";

const ALIVE = "deleted_at IS NULL";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** uuid v5(TIMETABLE_ID_NAMESPACE, "piece:" + key)；Web Crypto 的 SHA-1（Tauri WebView／`?mock=1` 的 localhost 都是 secure context） */
export async function pieceId(key: string): Promise<string> {
  const ns = hexToBytes(TIMETABLE_ID_NAMESPACE.replace(/-/g, ""));
  const name = new TextEncoder().encode(`piece:${key}`);
  const buf = new Uint8Array(ns.length + name.length);
  buf.set(ns, 0);
  buf.set(name, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 往批次裡加一筆 op（＝sync_outbox 一列＋每個 col 一筆 sync_cells 戳記） */
function addOp(b: WriteBatch, tbl: SyncTable, rowId: string, op: "upsert" | "delete", cols: Record<string, unknown>): void {
  b.ops.push({ tbl, row_id: rowId, op, cols });
}

/** 讀出來的現況：列（id → 列）＋純函式用的 span */
interface Snapshot {
  rowsById: Record<string, TimeBlockRow>;
  spans: Span[];
}

/** 分類列表的順序（§3.4）：頂層組 position，再各組子分類 position；同 position 以 created_at；孤兒（父已刪）排最後 */
function orderCategories(all: TimeCategoryRow[]): TimeCategoryRow[] {
  const byId = new Map<string, TimeCategoryRow>();
  for (const c of all) byId.set(c.id, c);
  // groupedCategories 會略過封存的；列表要含封存 ⇒ 排序時先抹掉 archived_at
  const grouped = groupedCategories(all.map((c) => ({ ...c, archived_at: null })));
  const ordered: TimeCategoryRow[] = [];
  const seen = new Set<string>();
  for (const g of grouped) {
    ordered.push(byId.get(g.group.id)!);
    seen.add(g.group.id);
    for (const c of g.children) {
      ordered.push(byId.get(c.id)!);
      seen.add(c.id);
    }
  }
  for (const c of all) if (!seen.has(c.id)) ordered.push(c);
  return ordered;
}

export class SqliteTimetableRepository implements TimetableRepository {
  /* ───────── 內部 ───────── */

  /**
   * 讀 span（§3.5-1）：未刪除且 `ended_at IS NULL OR ended_at > $from`（`from`＝這次動作影響區間的開始；
   * null＝全部）。結束於 `from` 之前的塊與這次動作不相交，純函式本來就會跳過。
   */
  private async loadSnapshot(db: Database, fromIso: string | null): Promise<Snapshot> {
    const rows =
      fromIso === null
        ? await db.select<TimeBlockRow[]>(`SELECT * FROM time_blocks WHERE ${ALIVE}`)
        : await db.select<TimeBlockRow[]>(
            `SELECT * FROM time_blocks WHERE ${ALIVE} AND (ended_at IS NULL OR ended_at > $1)`,
            [fromIso],
          );
    const rowsById: Record<string, TimeBlockRow> = {};
    const spans: Span[] = [];
    for (const r of rows) {
      rowsById[r.id] = r;
      spans.push(toSpan(r));
    }
    return { rowsById, spans };
  }

  private async getBlock(db: Database, id: string): Promise<TimeBlockRow | null> {
    const rows = await db.select<TimeBlockRow[]>(`SELECT * FROM time_blocks WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  private async getCategory(db: Database, id: string): Promise<TimeCategoryRow | null> {
    const rows = await db.select<TimeCategoryRow[]>(`SELECT * FROM time_categories WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /**
   * 套用 WritePlan（§3.5-2）：patch → UPDATE＋upsert op（改到的欄＋updated_at）；insert → INSERT … ON CONFLICT(id)
   * DO UPDATE（兩台的整理對同一片段算出同一 id，後到的那台要能覆寫）＋**完整列**的 upsert op；delete → 軟刪除＋delete op。
   * 全部累加進同一個 `WriteBatch`。回 inserts 依序對應的 id。
   *
   * patch 的每一欄都先與 `rowsById` 的現值比對，**值相同的欄不寫、不送 op**（逐欄 LWW：重新戳一個沒改的欄會讓這台
   * 的舊值蓋掉另一台對那一欄的改動）；全部相同就整筆跳過（不發 UPDATE、不送 op）。
   */
  private async applyPlan(b: WriteBatch, plan: WritePlan, rowsById: Record<string, TimeBlockRow>, nowIso: string): Promise<string[]> {
    for (const p of plan.patches) {
      const cur: TimeBlockRow | undefined = rowsById[p.id];
      const sets: string[] = [];
      const args: unknown[] = [];
      const cols: Record<string, unknown> = {};
      const put = (col: keyof TimeBlockRow, v: string | number | null): void => {
        if (cur && cur[col] === v) return; // 沒變的欄不碰
        args.push(v);
        sets.push(`${col} = $${args.length}`);
        cols[col] = v;
      };
      if (p.start !== undefined) put("started_at", isoOf(p.start));
      if (p.end !== undefined) put("ended_at", p.end === null ? null : isoOf(p.end));
      if (p.categoryId !== undefined) put("category_id", p.categoryId);
      if (p.ack !== undefined) put("long_run_ack", p.ack ? 1 : 0);
      if (!sets.length) continue;
      args.push(nowIso);
      sets.push(`updated_at = $${args.length}`);
      cols.updated_at = nowIso;
      args.push(p.id);
      b.stmts.push({ sql: `UPDATE time_blocks SET ${sets.join(", ")} WHERE id = $${args.length}`, args });
      addOp(b, "time_blocks", p.id, "upsert", cols);
    }

    const ids: string[] = [];
    for (const i of plan.inserts) {
      const id = i.key ? await pieceId(i.key) : uuid();
      const from = i.inherit && i.fromId ? rowsById[i.fromId] : undefined;
      const row = {
        category_id: i.categoryId,
        started_at: isoOf(i.start),
        ended_at: i.end === null ? null : isoOf(i.end),
        estimate_min: from?.estimate_min ?? null,
        node_id: from?.node_id ?? null,
        route_id: from?.route_id ?? null,
        long_run_ack: i.ack ? 1 : 0,
      };
      b.stmts.push({
        sql: `INSERT INTO time_blocks
           (id, category_id, started_at, ended_at, estimate_min, node_id, route_id, long_run_ack, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         ON CONFLICT(id) DO UPDATE SET
           category_id = excluded.category_id, started_at = excluded.started_at, ended_at = excluded.ended_at,
           estimate_min = excluded.estimate_min, node_id = excluded.node_id, route_id = excluded.route_id,
           long_run_ack = excluded.long_run_ack, updated_at = excluded.updated_at, deleted_at = NULL`,
        args: [id, row.category_id, row.started_at, row.ended_at, row.estimate_min, row.node_id, row.route_id, row.long_run_ack, nowIso],
      });
      // 收到方沒有這列時必填欄要齊（engine 新列缺必填就跳過）⇒ 完整列
      addOp(b, "time_blocks", id, "upsert", { ...row, created_at: nowIso, updated_at: nowIso, deleted_at: null });
      ids.push(id);
    }

    for (const d of plan.deletes) {
      b.stmts.push({ sql: `UPDATE time_blocks SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [nowIso, d] });
      addOp(b, "time_blocks", d, "delete", { deleted_at: nowIso, updated_at: nowIso });
    }
    return ids;
  }

  /** plan 為空 ⇒ 不呼叫 runWriteBatch（§3.5-2） */
  private async commit(db: Database, b: WriteBatch): Promise<void> {
    if (!b.stmts.length && !b.ops.length) return;
    await runWriteBatch(db, b.stmts, b.ops);
  }

  /* ───────── 分類 ───────── */

  async listCategories(): Promise<TimeCategoryRow[]> {
    const db = await getDb();
    const rows = await db.select<TimeCategoryRow[]>(`SELECT * FROM time_categories WHERE ${ALIVE}`);
    return orderCategories(rows);
  }

  async countCategoriesIncludingDeleted(): Promise<number> {
    const db = await getDb();
    const rows = await db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM time_categories`);
    return rows[0]?.n ?? 0;
  }

  async ensureStarterCategories(): Promise<boolean> {
    const db = await getDb();
    if ((await this.countCategoriesIncludingDeleted()) > 0) return false;
    const now = nowUtcIso();
    const b = newWriteBatch();
    // STARTER_CATEGORIES 的順序＝三個組先、再各組子分類 ⇒ op 順序＝收到方的套用順序（父先子後）
    for (const s of STARTER_CATEGORIES) {
      b.stmts.push({
        sql: `INSERT INTO time_categories
           (id, parent_id, name, glyph, color_idx, position, default_min, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT(id) DO NOTHING`,
        args: [s.id, s.parentId, s.name, s.glyph, s.colorIdx, s.position, s.defaultMin, now],
      });
      addOp(b, "time_categories", s.id, "upsert", {
        parent_id: s.parentId,
        name: s.name,
        glyph: s.glyph,
        color_idx: s.colorIdx,
        position: s.position,
        default_min: s.defaultMin,
        archived_at: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
    }
    await runWriteBatch(db, b.stmts, b.ops);
    return true;
  }

  async createCategory(input: CreateCategoryInput): Promise<TimeCategoryRow> {
    const name = input.name.trim();
    if (!name) throw new RangeError("分類名稱不能是空的");
    const db = await getDb();
    if (input.parentId !== null) {
      const parent = await this.getCategory(db, input.parentId);
      if (!parent || parent.deleted_at !== null || parent.parent_id !== null) throw new RangeError("找不到這個分組");
    }
    const sibWhere = input.parentId === null ? `parent_id IS NULL` : `parent_id = $1`;
    const sibArgs = input.parentId === null ? [] : [input.parentId];
    const max = await db.select<{ m: number | null }[]>(
      `SELECT MAX(position) AS m FROM time_categories WHERE ${sibWhere} AND ${ALIVE}`,
      sibArgs,
    );
    const position = (max[0]?.m ?? -1) + 1;
    const now = nowUtcIso();
    const id = uuid();
    const glyph = input.parentId === null ? null : (Array.from(name)[0] ?? null);
    const b = newWriteBatch();
    b.stmts.push({
      sql: `INSERT INTO time_categories
         (id, parent_id, name, glyph, color_idx, position, default_min, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      args: [id, input.parentId, name, glyph, input.colorIdx, position, input.defaultMin, now],
    });
    addOp(b, "time_categories", id, "upsert", {
      parent_id: input.parentId,
      name,
      glyph,
      color_idx: input.colorIdx,
      position,
      default_min: input.defaultMin,
      archived_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    await runWriteBatch(db, b.stmts, b.ops);
    const row = await this.getCategory(db, id);
    if (!row) throw new Error("建立分類失敗");
    return row;
  }

  async updateCategory(id: string, patch: CategoryPatch): Promise<void> {
    const db = await getDb();
    const c = await this.getCategory(db, id);
    if (!c || c.deleted_at !== null) throw new RangeError("找不到這個分類");
    const sets: string[] = [];
    const args: unknown[] = [];
    const cols: Record<string, unknown> = {};
    const put = (col: string, v: unknown): void => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
      cols[col] = v;
    };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new RangeError("分類名稱不能是空的");
      put("name", name);
      if (c.parent_id !== null) put("glyph", Array.from(name)[0] ?? null);
    }
    if (patch.colorIdx !== undefined) put("color_idx", patch.colorIdx);
    if (patch.defaultMin !== undefined) put("default_min", patch.defaultMin);
    if (!sets.length) return;
    put("updated_at", nowUtcIso());
    args.push(id);
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_categories SET ${sets.join(", ")} WHERE id = $${args.length}`, args });
    addOp(b, "time_categories", id, "upsert", cols);
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async reorderCategories(parentId: string | null, orderedIds: readonly string[]): Promise<void> {
    const db = await getDb();
    const sibWhere = parentId === null ? `parent_id IS NULL` : `parent_id = $1`;
    const sibArgs = parentId === null ? [] : [parentId];
    const rows = await db.select<{ id: string; position: number }[]>(
      `SELECT id, position FROM time_categories WHERE ${sibWhere} AND ${ALIVE}`,
      sibArgs,
    );
    const posById = new Map<string, number>();
    for (const r of rows) posById.set(r.id, r.position);
    const now = nowUtcIso();
    const b = newWriteBatch();
    orderedIds.forEach((id, i) => {
      const cur = posById.get(id);
      if (cur === undefined || cur === i) return; // 不在這一層、或 position 沒變 ⇒ 不送 op
      b.stmts.push({ sql: `UPDATE time_categories SET position = $1, updated_at = $2 WHERE id = $3`, args: [i, now, id] });
      addOp(b, "time_categories", id, "upsert", { position: i, updated_at: now });
    });
    await this.commit(db, b);
  }

  /* ───────── 時間塊：讀 ───────── */

  async listRunning(): Promise<TimeBlockRow[]> {
    const db = await getDb();
    return db.select<TimeBlockRow[]>(`SELECT * FROM time_blocks WHERE ${ALIVE} AND ended_at IS NULL ORDER BY started_at DESC`);
  }

  async listBlocks(fromIso: string, toIso: string): Promise<TimeBlockRow[]> {
    const db = await getDb();
    return db.select<TimeBlockRow[]>(
      `SELECT * FROM time_blocks WHERE ${ALIVE} AND started_at < $2 AND (ended_at IS NULL OR ended_at > $1)
       ORDER BY started_at ASC`,
      [fromIso, toIso],
    );
  }

  async listDaySegments(dateKey: string, dayStartHour: number): Promise<DayBlockSegment[]> {
    const w = dayWindow(dateKey, dayStartHour);
    const rows = await this.listBlocks(w.start, w.end);
    const items = segmentsOfDay(rows.map(toSpan), { start: msOf(w.start), end: msOf(w.end) }, Date.now());
    const catById: Record<string, TimeCategoryRow> = {};
    for (const c of await this.listCategories()) catById[c.id] = c;
    const rowsById: Record<string, TimeBlockRow> = {};
    for (const r of rows) rowsById[r.id] = r;
    return toDayBlockSegments(items, catById, rowsById);
  }

  /* ───────── 時間塊：寫 ───────── */

  async depart(categoryId: string, atIso: string): Promise<{ block: TimeBlockRow; summary: CoverSummary }> {
    const db = await getDb();
    const now = Date.now();
    const at = Math.min(msOf(atIso), now);
    const snap = await this.loadSnapshot(db, isoOf(at));
    const plan = planDepart(snap.spans, { categoryId, at, now });
    const b = newWriteBatch();
    const ids = await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    const newId = ids[plan.inserts.findIndex((i) => !i.inherit)];
    const block = await this.getBlock(db, newId);
    if (!block) throw new Error("發車失敗");
    return { block, summary: summarizeCover(plan) };
  }

  async arrive(atIso?: string): Promise<TimeBlockRow[]> {
    const db = await getDb();
    const now = Date.now();
    const rows = await this.listRunning();
    const plan = planArrive(rows.map(toSpan), { at: atIso ? msOf(atIso) : null, now });
    const b = newWriteBatch();
    const rowsById: Record<string, TimeBlockRow> = {};
    for (const r of rows) rowsById[r.id] = r;
    await this.applyPlan(b, plan, rowsById, isoOf(now));
    await this.commit(db, b);
    const out: TimeBlockRow[] = [];
    for (const p of plan.patches) {
      const r = await this.getBlock(db, p.id);
      if (r) out.push(r);
    }
    return out;
  }

  async undoArrive(id: string): Promise<boolean> {
    const db = await getDb();
    const snap = await this.loadSnapshot(db, null);
    if (!canUndoArrive(snap.spans, id)) return false;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_blocks SET ended_at = NULL, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, "time_blocks", id, "upsert", { ended_at: null, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
    return true;
  }

  async restart(id: string, atIso: string): Promise<CoverSummary> {
    const db = await getDb();
    const now = Date.now();
    const at = Math.min(msOf(atIso), now - MIN);
    // 運行中的塊 ended_at IS NULL ⇒ 一定在 span 裡；其餘只要與 [at, ∞) 相交的
    const snap = await this.loadSnapshot(db, isoOf(at));
    const plan = planRestart(snap.spans, { id, at, now });
    const b = newWriteBatch();
    await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    return summarizeCover(plan, id);
  }

  async fill(categoryId: string, startIso: string, endIso: string): Promise<{ block: TimeBlockRow; summary: CoverSummary }> {
    const db = await getDb();
    const now = Date.now();
    const start = msOf(startIso);
    const snap = await this.loadSnapshot(db, isoOf(start));
    const plan = planFill(snap.spans, { categoryId, start, end: msOf(endIso), now });
    const b = newWriteBatch();
    const ids = await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    const newId = ids[plan.inserts.findIndex((i) => !i.inherit)];
    const block = await this.getBlock(db, newId);
    if (!block) throw new Error("補記失敗");
    return { block, summary: summarizeCover(plan) };
  }

  async editBlock(id: string, input: { categoryId: string; startIso: string; endIso: string }): Promise<CoverSummary> {
    const db = await getDb();
    const now = Date.now();
    // 主角自己可能整個落在新區間之前（往後挪）⇒ 不帶 $from，讀全部
    const snap = await this.loadSnapshot(db, null);
    const plan = planEdit(snap.spans, {
      id,
      categoryId: input.categoryId,
      start: msOf(input.startIso),
      end: msOf(input.endIso),
      now,
    });
    const b = newWriteBatch();
    await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    return summarizeCover(plan, id);
  }

  async split(id: string, atIso: string, categoryId2: string): Promise<TimeBlockRow | null> {
    const db = await getDb();
    const now = Date.now();
    const snap = await this.loadSnapshot(db, null);
    const plan = planSplit(snap.spans, { id, at: msOf(atIso), categoryId2, now });
    if (!plan) return null;
    const b = newWriteBatch();
    const ids = await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    return this.getBlock(db, ids[0]);
  }

  async resolveLongRun(id: string, endIso: string, choice: LongRunChoice, categoryId2?: string): Promise<void> {
    const db = await getDb();
    const now = Date.now();
    const snap = await this.loadSnapshot(db, null);
    const plan = planResolveLongRun(snap.spans, { id, end: msOf(endIso), choice, categoryId2: categoryId2 ?? null, now });
    const b = newWriteBatch();
    await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
  }

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const r = await this.getBlock(db, id);
    if (!r || r.deleted_at !== null) throw new RangeError("找不到這一塊");
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_blocks SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, "time_blocks", id, "delete", { deleted_at: now, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async restore(id: string): Promise<CoverSummary> {
    const db = await getDb();
    const r = await this.getBlock(db, id);
    if (!r || r.deleted_at === null) throw new RangeError("找不到這一塊");
    const now = Date.now();
    const nowIso = isoOf(now);
    const me = toSpan(r);
    // 刪掉時還在運行中的塊（ended_at NULL；undoArrive／同步可能在面板開著時把它變回運行中）：復原成「結束於刪除那一刻」——
    // 否則蓋的區間到 +∞，刪掉之後才発車的每一班都會被整塊收掉，而且會出現兩班運行中
    const endedAtRestore: string | null = r.ended_at === null ? r.deleted_at : null;
    const coverEnd = me.end ?? msOf(r.deleted_at);
    // 復原的那一塊視為最新：蓋到的照補記規則處理（它自己已刪除、不在 span 裡，exceptId 只是保險）
    const snap = await this.loadSnapshot(db, r.started_at);
    const plan = planCover(snap.spans, { start: me.start, end: coverEnd }, id);
    const b = newWriteBatch();
    await this.applyPlan(b, plan, snap.rowsById, nowIso);
    if (endedAtRestore !== null) {
      b.stmts.push({
        sql: `UPDATE time_blocks SET deleted_at = NULL, ended_at = $1, updated_at = $2 WHERE id = $3`,
        args: [endedAtRestore, nowIso, id],
      });
      addOp(b, "time_blocks", id, "upsert", { deleted_at: null, ended_at: endedAtRestore, updated_at: nowIso });
    } else {
      b.stmts.push({ sql: `UPDATE time_blocks SET deleted_at = NULL, updated_at = $1 WHERE id = $2`, args: [nowIso, id] });
      addOp(b, "time_blocks", id, "upsert", { deleted_at: null, updated_at: nowIso });
    }
    await runWriteBatch(db, b.stmts, b.ops);
    return summarizeCover(plan, id);
  }

  async previewCover(startIso: string, endIso: string | null, exceptId: string | null): Promise<CoverSummary> {
    const db = await getDb();
    const snap = await this.loadSnapshot(db, startIso);
    const plan = planCover(snap.spans, { start: msOf(startIso), end: endIso === null ? null : msOf(endIso) }, exceptId);
    return summarizeCover(plan, exceptId);
  }

  /* ───────── 同步後整理 ───────── */

  async reconcile(): Promise<number> {
    const db = await getDb();
    // 寫入鍵（契約 0-8 改訂、D-時-26）：該列 started_at 那一格的 hlc＋"|"＋updated_at；沒有那一格 ⇒ hlc 位置放
    // " "（排最早，見檔頭）；sync_cells 不在就只用 updated_at。
    // 為什麼只看 started_at：改結束／改分類都會戳新 hlc，整列取 MAX 會讓「一直開著、17:30 才寫下結束」的那班
    // 壓過另一台 14:30 之後離線記的幾段（沙盒 F3）。col 字串＝欄名：本機由 syncSideStatements 以 op.cols 的鍵戳
    // （applyPlan 的 put("started_at", …)／完整列 insert），遠端由 Rust stamp_cell 以白名單欄名戳
    // （tables/timetable.rs 的 TIME_BLOCKS_COLS）。PK (tbl,row_id,col) ⇒ 一列最多一格，子查詢不用 MAX。
    const withCells = await ensureSyncTables(db);
    type Row = TimeBlockRow & { wk_hlc?: string | null };
    // 只掃最近 RECONCILE_WINDOW_DAYS 天＋所有運行中（契約 §9-6 退路；沙盒回報 F2 全表 1.6 秒）。
    // 條件與 `inReconcileWindow` 同語義；ISO 24 字元字串比較＝時刻比較。
    const floor = isoOf(reconcileWindowStart(Date.now()));
    const inWindow = `(b.ended_at IS NULL OR b.ended_at >= $1 OR b.started_at >= $1)`;
    const rows = withCells
      ? await db.select<Row[]>(
          `SELECT b.*,
                  COALESCE((SELECT c.hlc FROM sync_cells c
                            WHERE c.tbl = 'time_blocks' AND c.row_id = b.id AND c.col = 'started_at'), ' ') AS wk_hlc
           FROM time_blocks b WHERE b.${ALIVE} AND ${inWindow}`,
          [floor],
        )
      : await db.select<Row[]>(`SELECT b.* FROM time_blocks b WHERE b.${ALIVE} AND ${inWindow}`, [floor]);
    const rowsById: Record<string, TimeBlockRow> = {};
    const keyed: KeyedSpan[] = [];
    for (const r of rows) {
      const { wk_hlc, ...row } = r;
      rowsById[row.id] = row;
      keyed.push({ ...toSpan(row), writeKey: reconcileWriteKey(wk_hlc, row.updated_at) });
    }
    const plan = planReconcile(keyed);
    const n = plan.patches.length + plan.inserts.length + plan.deletes.length;
    if (!n) return 0;
    const b = newWriteBatch();
    await this.applyPlan(b, plan, rowsById, nowUtcIso());
    await this.commit(db, b);
    return n;
  }
}
