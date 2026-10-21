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
 * - 車次①b①c（契約 §3.3）：預估、多切點、合併、分類的搬組／封存／換圓牌字；①c 預留的佇列発車／到着與 `blockExists`。
 *   全部照同一套寫法（純函式 → applyPlan → 一個 WriteBatch）；`updateCategory` 的驗證規則與訊息與 memory 版逐字相同。
 * - 車次②（② 契約 §3.4）：`applyPlan` 的連結兩欄成對寫（patch：任一欄不同 ⇒ 兩欄都寫；insert：明寫 → inherit／keepLink
 *   照 fromId 抄 → 沒連）；`depart`／`fill`／`editBlock` 的連結照傳給純函式；`setLink`、`lastCategoryFor`、
 *   `listBlocksByNodes`、`listBlocksByRoute`。零 migration（§3.6）。
 * - 車次③（③ 契約 0-5、§3.2）：`time_goals` 的 CRUD（`listGoals`／`createGoal`／`updateGoal`／`archiveGoal`／`deleteGoal`／
 *   `restoreGoal`／`getGoal`）與公開的 `getBlock(id, { withDeleted })`。統計／週視圖／目標讀 `listBlocksSlim`（只取 8 欄，沙盒回報 F1②；語義同 `listBlocks`）。
 * - 車次⑥（⑥ 契約 0-8、0-11、§3.2）：`applyPlan` 把要搬的手動荷札（insert 的 `fromId`、`planMerge` 的 `absorbedInto`）記在那一批上，
 *   `commit` 提交之後 `carryBlockTags`（第二個交易）；目標的 `tagNames` 先寫目標列、再 `setTags('timetable:goal')`，scope 照 0-4（v2 有黏性）。
 *   荷札 repository 由建構子注入（`timetableRepository.ts` 給 `tagRepo`）；寫過 taggings 由 `consumeTagWrites()` 回報給 store。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { dayWindow } from "../lib/date";
import { ensureSyncTables, newWriteBatch, runWriteBatch, type SyncTable, type WriteBatch } from "./syncRepository";
import type { TimetableRepository, CreateCategoryInput, CategoryPatch, DepartOptions, MergePreview } from "./timetableRepository";
import { LINKABLE_KINDS, linkOfRow } from "../domain/timetableLink";
import {
  MIN,
  STARTER_CATEGORIES,
  TIMETABLE_ID_NAMESPACE,
  canUndoArrive,
  currentRunning,
  insertLinkOf,
  groupedCategories,
  isoOf,
  msOf,
  planArrive,
  planArriveBefore,
  planCover,
  planDepart,
  planDepartPending,
  planEdit,
  planFill,
  planMerge,
  planReconcile,
  planResolveLongRun,
  planRestart,
  planSetEstimate,
  planSetLink,
  planSplit,
  planSplitMulti,
  reconcileWindowStart,
  reconcileWriteKey,
  segmentsOfDay,
  summarizeCover,
  toDayBlockSegments,
  toSpan,
  type BlockLink,
  type CoverSummary,
  type DayBlockSegment,
  type KeyedSpan,
  type LongRunChoice,
  type Span,
  type TimeBlockRow,
  type TimeBlockSlim,
  type TimeCategoryRow,
  type TimeGoalRow,
  type WritePlan,
} from "../domain/timetable";
import { goalScopeJson, goalScopeNext, goalToInput, normalizeGoalInput, parseGoal, type GoalInput } from "../domain/timetableStats";
import { TT_TAG_GOAL } from "../domain/timetableTags";
import { carryBlockTags, carryPairsOfPlan, checkTagNames, receiptWrote, type CarryPair, type TimetableTagRepo } from "./timetableTagCarry";
import {
  buildPaintUndo,
  planPaintFill,
  planPaintLive,
  planUndoPaint,
  type PaintRow,
  type PaintUndo,
} from "../domain/timetableGrid";

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
  /** ⑥：荷札 repository（注入；沒給＝不搬手動荷札、目標不寫荷札——`node --test` 直載時） */
  private readonly tags: TimetableTagRepo | null;
  /** ⑥：每個 WriteBatch 要搬的手動荷札（applyPlan 收、commit 之後 carryBlockTags） */
  private readonly carryOf = new WeakMap<WriteBatch, CarryPair[]>();
  /** ⑥：上次 consumeTagWrites 以來有沒有寫過 taggings */
  private tagWrites = false;

  constructor(opts?: { tagRepo?: TimetableTagRepo | null }) {
    this.tags = opts?.tagRepo ?? null;
  }

  consumeTagWrites(): boolean {
    const v = this.tagWrites;
    this.tagWrites = false;
    return v;
  }

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

  private async getBlockRow(db: Database, id: string): Promise<TimeBlockRow | null> {
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
      if (p.estimateMin !== undefined) put("estimate_min", p.estimateMin);
      if (p.link !== undefined) {
        // ② 契約 0-2：連結兩欄成對寫——任一欄跟現值不同 ⇒ 兩欄都寫、都進 op（繞過 put 的相同值跳過）；
        // 逐欄 LWW 下只送變了的那欄，兩台同時改連結會拼出 (X, R) 這種誰都沒選的組合
        const same = !!cur && cur.node_id === p.link.nodeId && cur.route_id === p.link.routeId;
        if (!same) {
          for (const [col, v] of [
            ["node_id", p.link.nodeId],
            ["route_id", p.link.routeId],
          ] as const) {
            args.push(v);
            sets.push(`${col} = $${args.length}`);
            cols[col] = v;
          }
        }
      }
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
      const id = i.fixedId ?? (i.key ? await pieceId(i.key) : uuid());
      // ② 契約 §3.1：連結的來源列要用 rowsById[fromId]（不能沿用只在 inherit 時才取的 from——keepLink 不看 inherit）
      const src = i.fromId ? rowsById[i.fromId] : undefined;
      const from = i.inherit ? src : undefined;
      const link: BlockLink = insertLinkOf(i, src);
      const row = {
        category_id: i.categoryId,
        started_at: isoOf(i.start),
        ended_at: i.end === null ? null : isoOf(i.end),
        // ①b：insert 明寫的預估蓋過 inherit 抄來的（undefined＝照 inherit 規則）
        estimate_min: i.estimateMin !== undefined ? i.estimateMin : (from?.estimate_min ?? null),
        node_id: link.nodeId,
        route_id: link.routeId,
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
    // ⑥ 0-8：手動荷札跟著 fromId／合併搬——記在這一批上，commit 之後才寫（兩個交易）
    const pairs = carryPairsOfPlan(plan.inserts, ids, plan.absorbedInto);
    if (pairs.length) {
      const list = this.carryOf.get(b);
      if (list) list.push(...pairs);
      else this.carryOf.set(b, pairs);
    }
    return ids;
  }

  /**
   * plan 為空 ⇒ 不呼叫 runWriteBatch（§3.5-2）。⑥ 0-8：批次提交**之後** await 搬手動荷札（applyPlan 記在這一批上的 pair）；
   * 搬荷札失敗只 warn，不影響這次寫入的結果。
   */
  private async commit(db: Database, b: WriteBatch): Promise<void> {
    if (!b.stmts.length && !b.ops.length) return;
    await runWriteBatch(db, b.stmts, b.ops);
    const pairs = this.carryOf.get(b);
    if (pairs) {
      this.carryOf.delete(b);
      if (await carryBlockTags(pairs, this.tags)) this.tagWrites = true;
    }
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
    // 先全部驗證、再組成一句 UPDATE（一個 batch；規則與訊息＝memory 版，①b①c 契約 §3.3-3）
    const name = patch.name !== undefined ? patch.name.trim() : undefined;
    if (name !== undefined && !name) throw new RangeError("分類名稱不能是空的");
    let target: TimeCategoryRow | null = null;
    if (patch.parentId !== undefined) {
      if (c.parent_id === null) throw new RangeError("分組不能搬");
      const t = await this.getCategory(db, patch.parentId);
      if (!t || t.deleted_at !== null || t.parent_id !== null) throw new RangeError("找不到這個分組");
      target = t;
    }
    if (patch.archived !== undefined && c.parent_id === null) throw new RangeError("分組不能封存");
    const glyph = patch.glyph !== undefined ? patch.glyph.trim() : undefined;
    if (glyph !== undefined) {
      if (c.parent_id === null) throw new RangeError("分組沒有圓牌字");
      if (Array.from(glyph).length !== 1) throw new RangeError("圓牌字只能一個字");
    }
    const now = nowUtcIso();
    const sets: string[] = [];
    const args: unknown[] = [];
    const cols: Record<string, unknown> = {};
    const put = (col: string, v: unknown): void => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
      cols[col] = v;
    };
    if (name !== undefined) {
      put("name", name);
      // 圓牌字只在「還是自動的」（＝舊名第一字或 null）時跟著換；主人換過的不動（取代 ①a 的無條件覆寫）。
      // 同一次也明寫了圓牌字 ⇒ 交給下面的 glyph 分支（一句 UPDATE 裡同一欄只出現一次）
      if (glyph === undefined && c.parent_id !== null && (c.glyph === null || c.glyph === Array.from(c.name)[0])) {
        const auto = Array.from(name)[0] ?? null;
        if (auto !== c.glyph) put("glyph", auto);
      }
    }
    if (patch.colorIdx !== undefined) put("color_idx", patch.colorIdx);
    if (patch.defaultMin !== undefined) put("default_min", patch.defaultMin);
    if (target && target.id !== c.parent_id) {
      const max = await db.select<{ m: number | null }[]>(
        `SELECT MAX(position) AS m FROM time_categories WHERE parent_id = $1 AND ${ALIVE}`,
        [target.id],
      );
      put("parent_id", target.id);
      put("position", (max[0]?.m ?? -1) + 1);
    }
    // 值沒變的不送（逐欄 LWW：封存兩次不重戳封存時刻、還原已在的不送 op）
    if (patch.archived === true && c.archived_at === null) put("archived_at", now);
    else if (patch.archived === false && c.archived_at !== null) put("archived_at", null);
    if (glyph !== undefined && glyph !== c.glyph) put("glyph", glyph);
    if (!sets.length) return;
    put("updated_at", now);
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

  async listBlocksSlim(fromIso: string, toIso: string): Promise<TimeBlockSlim[]> {
    const db = await getDb();
    return db.select<TimeBlockSlim[]>(
      `SELECT id, category_id, started_at, ended_at, estimate_min, node_id, route_id, long_run_ack
       FROM time_blocks WHERE ${ALIVE} AND started_at < $2 AND (ended_at IS NULL OR ended_at > $1)
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

  async depart(categoryId: string, atIso: string, opts?: DepartOptions): Promise<{ block: TimeBlockRow; summary: CoverSummary }> {
    const db = await getDb();
    const now = Date.now();
    const at = Math.min(msOf(atIso), now);
    const snap = await this.loadSnapshot(db, isoOf(at));
    const plan = planDepart(snap.spans, { categoryId, at, now, estimateMin: opts?.estimateMin ?? null, link: opts?.link ?? null });
    const b = newWriteBatch();
    const ids = await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    const newId = ids[plan.inserts.findIndex((i) => !i.inherit)];
    const block = await this.getBlockRow(db, newId);
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
      const r = await this.getBlockRow(db, p.id);
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

  async fill(
    categoryId: string,
    startIso: string,
    endIso: string,
    opts?: { link?: BlockLink | null; ack?: boolean },
  ): Promise<{ block: TimeBlockRow; summary: CoverSummary }> {
    const db = await getDb();
    const now = Date.now();
    const start = msOf(startIso);
    const snap = await this.loadSnapshot(db, isoOf(start));
    // 磨光⑤ 收尾：ack＝按了「確定記這麼長」（新塊直接記成已確認）
    const plan = planFill(snap.spans, { categoryId, start, end: msOf(endIso), now, link: opts?.link ?? null, ack: opts?.ack });
    const b = newWriteBatch();
    const ids = await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    const newId = ids[plan.inserts.findIndex((i) => !i.inherit)];
    const block = await this.getBlockRow(db, newId);
    if (!block) throw new Error("補記失敗");
    return { block, summary: summarizeCover(plan) };
  }

  async editBlock(
    id: string,
    input: { categoryId: string; startIso: string; endIso: string; link?: BlockLink | null; ack?: boolean },
  ): Promise<CoverSummary> {
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
      link: input.link, // ②：undefined＝不動
      curLink: snap.rowsById[id] ? linkOfRow(snap.rowsById[id]) : undefined,
      ack: input.ack, // 磨光⑤ 收尾：按了「確定記這麼長」
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
    return this.getBlockRow(db, ids[0]);
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
    const r = await this.getBlockRow(db, id);
    if (!r || r.deleted_at !== null) throw new RangeError("找不到這一塊");
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_blocks SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, "time_blocks", id, "delete", { deleted_at: now, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
    this.tagWrites = true; // ⑥ 評審後：index 只收實體存活的 taggings（0-6）⇒ 刪／復活都要重載
  }

  async restore(id: string): Promise<CoverSummary> {
    const db = await getDb();
    const r = await this.getBlockRow(db, id);
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
    await this.commit(db, b); // ⑥：planCover 切出的片段也搬手動荷札（批次一定非空，＝原本的 runWriteBatch）
    this.tagWrites = true; // ⑥ 評審後：復活的塊的手動荷札要回到 index（0-6 存活過濾）
    return summarizeCover(plan, id);
  }

  async previewCover(startIso: string, endIso: string | null, exceptId: string | null): Promise<CoverSummary> {
    const db = await getDb();
    const snap = await this.loadSnapshot(db, startIso);
    const plan = planCover(snap.spans, { start: msOf(startIso), end: endIso === null ? null : msOf(endIso) }, exceptId);
    return summarizeCover(plan, exceptId);
  }

  /* ───────── ①b（①b①c 契約 §3.3-4～7） ───────── */

  /**
   * 運行中那一班的預估。planSetEstimate 只需要「那一列」⇒ 只讀那一列（＝契約「loadSnapshot 只為找那列」的同語義，
   * 不掃全表）；已刪除的當作找不到。值沒變 ⇒ applyPlan 整筆跳過、不送 op。
   */
  async setEstimate(id: string, estimateMin: number | null): Promise<void> {
    const db = await getDb();
    const r = await this.getBlockRow(db, id);
    if (!r || r.deleted_at !== null) throw new RangeError("找不到這一塊");
    const plan = planSetEstimate([toSpan(r)], { id, estimateMin });
    const b = newWriteBatch();
    await this.applyPlan(b, plan, { [id]: r }, nowUtcIso());
    await this.commit(db, b);
  }

  async splitMulti(id: string, cutsIso: readonly string[], categoryIds: readonly string[]): Promise<TimeBlockRow[]> {
    const db = await getDb();
    const now = Date.now();
    const snap = await this.loadSnapshot(db, null);
    const plan = planSplitMulti(snap.spans, {
      id,
      cuts: cutsIso.map(msOf),
      categoryIds,
      now,
      // Span 不帶預估 ⇒ 由列上給（契約 0-14 的「原值」）
      estimateMin: snap.rowsById[id]?.estimate_min ?? null,
    });
    const b = newWriteBatch();
    const ids = await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    const out: TimeBlockRow[] = [];
    for (const x of [id, ...ids]) {
      const r = await this.getBlockRow(db, x);
      if (r) out.push(r);
    }
    return out;
  }

  async previewMerge(id: string, dir: "prev" | "next", boundIso: string): Promise<MergePreview | null> {
    const db = await getDb();
    const snap = await this.loadSnapshot(db, null);
    const out = planMerge(snap.spans, { id, dir, bound: msOf(boundIso), now: Date.now() });
    return out ? { ...out.preview } : null;
  }

  async merge(id: string, dir: "prev" | "next", boundIso: string): Promise<MergePreview | null> {
    const db = await getDb();
    const now = Date.now();
    const snap = await this.loadSnapshot(db, null);
    const out = planMerge(snap.spans, { id, dir, bound: msOf(boundIso), now });
    if (!out) return null;
    const b = newWriteBatch();
    await this.applyPlan(b, out.plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    return { ...out.preview };
  }

  /** store.refresh() 每次都讀它；`idx_tb_started` 覆蓋 started_at 範圍 */
  async listRecentCategoryIds(sinceIso: string, limit: number): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<{ category_id: string; m: string }[]>(
      `SELECT category_id, MAX(started_at) AS m FROM time_blocks
       WHERE ${ALIVE} AND started_at >= $1 GROUP BY category_id ORDER BY m DESC LIMIT $2`,
      [sinceIso, limit],
    );
    return rows.map((r) => r.category_id);
  }

  /** 含已刪除（佇列冪等用，契約 0-6） */
  async blockExists(id: string): Promise<boolean> {
    const db = await getDb();
    const rows = await db.select<{ x: number }[]>(`SELECT 1 AS x FROM time_blocks WHERE id = $1`, [id]);
    return rows.length > 0;
  }

  /**
   * 佇列発車（契約 0-5 乙案、0-6）：要看得到 at 之後的塊（untilNext 找下一班）⇒ 全部讀。
   * 新塊 id＝opts.fixedId（applyPlan 的 insert 優先用它）；plan 為 null ⇒ 不寫、回 null。
   */
  async departPending(categoryId: string, atIso: string, opts: { fixedId: string; untilNext: boolean }): Promise<TimeBlockRow | null> {
    const db = await getDb();
    const now = Date.now();
    const snap = await this.loadSnapshot(db, null);
    const plan = planDepartPending(snap.spans, { categoryId, at: msOf(atIso), now, fixedId: opts.fixedId, untilNext: opts.untilNext });
    if (!plan) return null;
    const b = newWriteBatch();
    await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    return this.getBlockRow(db, opts.fixedId);
  }

  /** 佇列到着：只結束開始早於 at 的運行中（planArriveBefore）；回被結束的列 */
  async arrivePending(atIso: string): Promise<TimeBlockRow[]> {
    const db = await getDb();
    const now = Date.now();
    const rows = await this.listRunning();
    const plan = planArriveBefore(rows.map(toSpan), { at: msOf(atIso), now });
    const rowsById: Record<string, TimeBlockRow> = {};
    for (const r of rows) rowsById[r.id] = r;
    const b = newWriteBatch();
    await this.applyPlan(b, plan, rowsById, isoOf(now));
    await this.commit(db, b);
    const out: TimeBlockRow[] = [];
    for (const p of plan.patches) {
      const r = await this.getBlockRow(db, p.id);
      if (r) out.push(r);
    }
    return out;
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

  /* ───────── ②（② 契約 §3.4） ───────── */

  /**
   * 改一塊的連結（運行中、已結束都可以）；null＝取消連結。只讀那一列（同 setEstimate）；連結一樣 ⇒ 空 plan、不寫。
   * 節點不在這台（還沒同步過來）⇒ 照樣允許；在、但種類不能連 ⇒ RangeError。
   */
  async setLink(id: string, link: BlockLink | null): Promise<void> {
    const db = await getDb();
    const r = await this.getBlockRow(db, id);
    if (!r || r.deleted_at !== null) throw new RangeError("找不到這一塊");
    if (link && link.nodeId !== null) {
      const k = await db.select<{ kind: string }[]>(`SELECT kind FROM nodes WHERE id = $1`, [link.nodeId]);
      if (k[0] && !LINKABLE_KINDS.includes(k[0].kind)) throw new RangeError("只能連到車票、列車或車廂");
    }
    const plan = planSetLink([toSpan(r)], { id, link, curLink: linkOfRow(r) });
    const b = newWriteBatch();
    await this.applyPlan(b, plan, { [id]: r }, nowUtcIso());
    await this.commit(db, b);
  }

  /**
   * 「記住上次的分類」（② 契約 0-4、§3.4-6）：先節點、再路線，第一條有結果就不跑第二條。
   * 「還能用」＝分類未刪除、未封存、是子分類。路線那條不看 `n.deleted_at`（刪掉的票以前用過的分類照樣算）。
   */
  async lastCategoryFor(nodeId: string | null, routeId: string | null): Promise<{ categoryId: string; from: "node" | "route" } | null> {
    const db = await getDb();
    const usable = `c.deleted_at IS NULL AND c.archived_at IS NULL AND c.parent_id IS NOT NULL`;
    if (nodeId !== null) {
      const byNode = await db.select<{ category_id: string }[]>(
        `SELECT b.category_id FROM time_blocks b
         JOIN time_categories c ON c.id = b.category_id
         WHERE b.deleted_at IS NULL AND b.node_id = $1 AND ${usable}
         ORDER BY b.started_at DESC LIMIT 1`,
        [nodeId],
      );
      if (byNode[0]) return { categoryId: byNode[0].category_id, from: "node" };
    }
    if (routeId === null) return null;
    // 兩段 UNION ALL，各自用得上索引（idx_nodes_route＋idx_tb_node；只連路線那段量小、沒有索引，§3.4-8）
    const byRoute = await db.select<{ category_id: string }[]>(
      `SELECT x.category_id FROM (
         SELECT b.category_id, b.started_at FROM nodes n
         JOIN time_blocks b ON b.node_id = n.id
         WHERE n.route_id = $1 AND b.deleted_at IS NULL
         UNION ALL
         SELECT b.category_id, b.started_at FROM time_blocks b
         WHERE b.node_id IS NULL AND b.route_id = $1 AND b.deleted_at IS NULL
       ) x
       JOIN time_categories c ON c.id = x.category_id
       WHERE ${usable}
       ORDER BY x.started_at DESC LIMIT 1`,
      [routeId],
    );
    return byRoute[0] ? { categoryId: byRoute[0].category_id, from: "route" } : null;
  }

  /** 未刪除、node_id 在清單裡的塊（每 400 個 id 一批；空清單回 []），started_at 遞增 */
  async listBlocksByNodes(nodeIds: readonly string[]): Promise<TimeBlockRow[]> {
    const ids = Array.from(new Set(nodeIds));
    if (!ids.length) return [];
    const db = await getDb();
    const out: TimeBlockRow[] = [];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const ph = chunk.map((_, k) => `$${k + 1}`).join(", ");
      const rows = await db.select<TimeBlockRow[]>(
        `SELECT * FROM time_blocks WHERE ${ALIVE} AND node_id IN (${ph}) ORDER BY started_at ASC`,
        chunk,
      );
      for (const r of rows) out.push(r);
    }
    // 多批合併後重排（ISO 24 字元字串比較＝時刻比較）
    if (ids.length > 400) out.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
    return out;
  }

  /**
   * 未刪除、屬於這條路線的塊（② 契約 0-5、§3.4-8）：經節點推導（活的節點）＋只連這條路線。
   * 寫成 UNION ALL 讓第一段由 nodes 起頭走 idx_nodes_route、再走 idx_tb_node；兩段不相交（第二段 node_id IS NULL）。
   */
  async listBlocksByRoute(routeId: string): Promise<TimeBlockRow[]> {
    const db = await getDb();
    return db.select<TimeBlockRow[]>(
      `SELECT b.* FROM nodes n
       JOIN time_blocks b ON b.node_id = n.id
       WHERE n.route_id = $1 AND n.deleted_at IS NULL AND b.deleted_at IS NULL
       UNION ALL
       SELECT * FROM time_blocks
       WHERE node_id IS NULL AND route_id = $1 AND deleted_at IS NULL
       ORDER BY started_at ASC`,
      [routeId],
    );
  }

  /* ───────── ③：公開的取一塊、時數目標 ───────── */

  async getBlock(id: string, opts?: { withDeleted?: boolean }): Promise<TimeBlockRow | null> {
    const db = await getDb();
    const r = await this.getBlockRow(db, id);
    if (!r) return null;
    return r.deleted_at !== null && !opts?.withDeleted ? null : r;
  }

  private async getGoalRow(db: Database, id: string): Promise<TimeGoalRow | null> {
    const rows = await db.select<TimeGoalRow[]>(`SELECT * FROM time_goals WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  private async aliveGoalOrThrow(db: Database, id: string): Promise<TimeGoalRow> {
    const g = await this.getGoalRow(db, id);
    if (!g || g.deleted_at !== null) throw new RangeError("找不到這個目標");
    return g;
  }

  async listGoals(): Promise<TimeGoalRow[]> {
    const db = await getDb();
    return db.select<TimeGoalRow[]>(`SELECT * FROM time_goals WHERE ${ALIVE} ORDER BY position ASC, created_at ASC, id ASC`);
  }

  async getGoal(id: string, opts?: { withDeleted?: boolean }): Promise<TimeGoalRow | null> {
    const db = await getDb();
    const g = await this.getGoalRow(db, id);
    if (!g) return null;
    return g.deleted_at !== null && !opts?.withDeleted ? null : g;
  }

  /** ⑥ 0-11：目標列寫好之後才掛荷札（第二個交易）；`names` 是 undefined＝不動 */
  private async writeGoalTags(id: string, names: readonly string[] | undefined): Promise<void> {
    if (names === undefined || !this.tags) return;
    const r = await this.tags.setTags(TT_TAG_GOAL, id, names);
    if (receiptWrote(r.receipt)) this.tagWrites = true;
  }

  async createGoal(input: GoalInput): Promise<TimeGoalRow> {
    const v = normalizeGoalInput(input);
    const tagNames = v.tagNames !== undefined ? checkTagNames(v.tagNames) : undefined; // 不合法 ⇒ 目標列也不寫
    const db = await getDb();
    const max = await db.select<{ m: number | null }[]>(`SELECT MAX(position) AS m FROM time_goals WHERE ${ALIVE}`);
    const position = (max[0]?.m ?? -1) + 1;
    const now = nowUtcIso();
    const id = uuid();
    const scope = goalScopeJson(v.categoryIds, (tagNames?.length ?? 0) > 0); // ⑥ 0-4：有荷札 ⇒ v2
    const b = newWriteBatch();
    b.stmts.push({
      sql: `INSERT INTO time_goals
         (id, name, scope, period, target_min, direction, start_on, end_on, position, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      args: [id, v.name, scope, v.period, v.targetMin, v.direction, v.startOn, v.endOn, position, now],
    });
    addOp(b, "time_goals", id, "upsert", {
      name: v.name,
      scope,
      period: v.period,
      target_min: v.targetMin,
      direction: v.direction,
      start_on: v.startOn,
      end_on: v.endOn,
      position,
      archived_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    await runWriteBatch(db, b.stmts, b.ops);
    await this.writeGoalTags(id, tagNames);
    const row = await this.getGoalRow(db, id);
    if (!row) throw new Error("建立目標失敗");
    return row;
  }

  async updateGoal(id: string, patch: Partial<GoalInput>): Promise<void> {
    const db = await getDb();
    const cur = await this.aliveGoalOrThrow(db, id);
    const parsed = parseGoal(cur);
    if (!parsed) throw new RangeError("這個目標是新版本寫的，這一版改不了");
    // ⑥ 0-4：patch 沒帶荷札 ⇒ 驗證與 scope 版本照 taggings 現在掛的（只綁荷札的目標改名不會被「至少選一個」擋下）
    const curTags = this.tags ? (await this.tags.listTagsOf(TT_TAG_GOAL, id)).map((t) => t.name) : [];
    const v = normalizeGoalInput({ ...goalToInput(parsed), ...patch, tagNames: patch.tagNames ?? curTags });
    const tagNames = patch.tagNames !== undefined ? checkTagNames(v.tagNames ?? []) : undefined;
    const scope = goalScopeNext(cur.scope, v.categoryIds, (tagNames ?? curTags).length > 0); // v2 有黏性
    const sets: string[] = [];
    const args: unknown[] = [];
    const cols: Record<string, unknown> = {};
    // 值沒變的欄不送（逐欄 LWW：兩台各改不同欄都保得住）
    const put = (col: string, val: unknown, old: unknown): void => {
      if (val === old) return;
      args.push(val);
      sets.push(`${col} = $${args.length}`);
      cols[col] = val;
    };
    put("name", v.name, cur.name);
    put("scope", scope, cur.scope);
    put("period", v.period, cur.period);
    put("target_min", v.targetMin, cur.target_min);
    put("direction", v.direction, cur.direction);
    put("start_on", v.startOn, cur.start_on);
    put("end_on", v.endOn, cur.end_on);
    if (sets.length) {
      const now = nowUtcIso();
      args.push(now);
      sets.push(`updated_at = $${args.length}`);
      cols.updated_at = now;
      args.push(id);
      const b = newWriteBatch();
      b.stmts.push({ sql: `UPDATE time_goals SET ${sets.join(", ")} WHERE id = $${args.length}`, args });
      addOp(b, "time_goals", id, "upsert", cols);
      await runWriteBatch(db, b.stmts, b.ops);
    }
    await this.writeGoalTags(id, tagNames); // 欄都沒變也照樣對荷札做差（setTags 沒變＝不寫）
  }

  async archiveGoal(id: string, on: boolean): Promise<void> {
    const db = await getDb();
    const cur = await this.aliveGoalOrThrow(db, id);
    if (on === (cur.archived_at !== null)) return; // 狀態沒變：不重戳封存時刻、不送 op
    const now = nowUtcIso();
    const at = on ? now : null;
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_goals SET archived_at = $1, updated_at = $2 WHERE id = $3`, args: [at, now, id] });
    addOp(b, "time_goals", id, "upsert", { archived_at: at, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async deleteGoal(id: string): Promise<void> {
    const db = await getDb();
    await this.aliveGoalOrThrow(db, id);
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_goals SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, "time_goals", id, "delete", { deleted_at: now, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
    this.tagWrites = true; // ⑥ 評審後：同 softDelete
  }

  async restoreGoal(id: string): Promise<void> {
    const db = await getDb();
    const cur = await this.getGoalRow(db, id);
    if (!cur || cur.deleted_at === null) throw new RangeError("找不到這個目標");
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_goals SET deleted_at = NULL, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, "time_goals", id, "upsert", { deleted_at: null, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
    this.tagWrites = true; // ⑥ 評審後：復活的目標綁的荷札要回到 index（只綁荷札的目標才畫得出條）
  }

  /* ── ⑤（⑤ 契約 0-5、§3.2） ── */

  /**
   * 方眼塗色：loadSnapshot → plan（fill＝planPaintFill；live＝planPaintLive）→ 記 before（plan 的 patch／delete 對象，
   * 寫前一定在 snapshot 裡）→ applyPlan → 讀回寫後的列 → buildPaintUndo（`updated_at` 真的變了才進 touched）。
   * `fill`／`depart`／`restart` 本身不動。live 同分類而且選區頭不早於它（plan＝null）＝什麼都不寫。
   */
  async paint(
    categoryId: string,
    startIso: string,
    endIso: string,
    mode: "fill" | "live",
  ): Promise<{ block: TimeBlockRow; summary: CoverSummary; undo: PaintUndo }> {
    const db = await getDb();
    const now = Date.now();
    const start = msOf(startIso);
    let snap: Snapshot;
    let plan: WritePlan | null;
    /** live 同分類＝提早出發：主角是運行中那班（summary 不算它、回傳它） */
    let restartId: string | null = null;
    if (mode === "fill") {
      snap = await this.loadSnapshot(db, isoOf(start));
      plan = planPaintFill(snap.spans, { categoryId, start, end: msOf(endIso), now });
    } else {
      const a = Math.min(start, now);
      // planRestart 會把 at 夾到 now − 1 分 ⇒ 讀的範圍跟著放寬（同 restart()）
      snap = await this.loadSnapshot(db, isoOf(Math.min(a, now - MIN)));
      const R = currentRunning(snap.spans);
      plan = planPaintLive(snap.spans, { categoryId, at: a, now });
      if (R && R.categoryId === categoryId) {
        restartId = R.id;
        if (plan === null) {
          return {
            block: snap.rowsById[R.id],
            summary: { removed: 0, shortened: 0, splitCount: 0 },
            undo: { inserted: [], touched: [] },
          };
        }
      }
    }
    if (plan === null) throw new Error("塗色失敗");
    const b = newWriteBatch();
    const ids = await this.applyPlan(b, plan, snap.rowsById, isoOf(now));
    await this.commit(db, b);
    const after: Record<string, TimeBlockRow | null> = {};
    for (const id of [...plan.patches.map((p) => p.id), ...plan.deletes, ...ids]) {
      if (!(id in after)) after[id] = await this.getBlockRow(db, id);
    }
    const undo = buildPaintUndo(plan, snap.rowsById, after, ids);
    const blockId = restartId ?? ids[plan.inserts.findIndex((i) => !i.inherit)];
    const block = after[blockId] ?? (await this.getBlockRow(db, blockId));
    if (!block) throw new Error("塗色失敗");
    return { block, summary: summarizeCover(plan, restartId), undo };
  }

  /**
   * 撤回一次塗色（0-5）：現況用 getBlockRow 讀（含已刪除；loadSnapshot 不含）→ planUndoPaint 守門（比 `updated_at`）→
   * 一個 WriteBatch：新增的列軟刪除；被動到的列只寫跟塗之前不同的欄＋updated_at（逐欄 LWW）。
   * **不叫 restore()**（它內部跑 planCover，會把復原的塊當最新寫入去切別人）；不跑 planCover。
   */
  async undoPaint(undo: PaintUndo): Promise<boolean> {
    const db = await getDb();
    const current: Record<string, PaintRow | null> = {};
    for (const id of [...undo.inserted.map((x) => x.id), ...undo.touched.map((x) => x.id)]) {
      if (!(id in current)) current[id] = await this.getBlockRow(db, id);
    }
    const writes = planUndoPaint(undo, current);
    if (writes === null) return false;
    const nowIso = isoOf(Date.now());
    const b = newWriteBatch();
    for (const w of writes) {
      if (w.op === "delete") {
        b.stmts.push({ sql: `UPDATE time_blocks SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [nowIso, w.id] });
        addOp(b, "time_blocks", w.id, "delete", { deleted_at: nowIso, updated_at: nowIso });
        continue;
      }
      const sets: string[] = [];
      const args: unknown[] = [];
      const cols: Record<string, unknown> = {};
      for (const [col, v] of Object.entries(w.cols)) {
        args.push(v);
        sets.push(`${col} = $${args.length}`);
        cols[col] = v;
      }
      args.push(nowIso);
      sets.push(`updated_at = $${args.length}`);
      cols.updated_at = nowIso;
      args.push(w.id);
      b.stmts.push({ sql: `UPDATE time_blocks SET ${sets.join(", ")} WHERE id = $${args.length}`, args });
      addOp(b, "time_blocks", w.id, "upsert", cols);
    }
    await this.commit(db, b);
    this.tagWrites = true; // ⑥ 評審後：撤回會讓被蓋掉的塊復活、切出的片段軟刪 ⇒ index 要重載
    return true;
  }
}
