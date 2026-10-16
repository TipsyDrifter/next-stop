/**
 * SqliteNoteRepository——NoteRepository 的 SQLite 實作（tauri-plugin-sql 前端直連；車次①契約 §3.3–3.4）。
 *
 * 寫法照 `sqliteNodeRepository.ts`：每個公開 mutation 一個交易——語句與同步 op 累加進 `WriteBatch`，
 * 收尾 `runWriteBatch(db, b.stmts, b.ops)` 一次落。op 的 `tbl` 一律 "notes"；cols 只放白名單欄
 * （`src-tauri/src/sync/tables/notes.rs` 的 NOTES_COLS），表上沒有快取欄，所以每一欄都是主人資料。
 *
 * 讀取一律 `deleted_at IS NULL`。路線不存快取（契約 0-5）：由 `node_id` LEFT JOIN nodes 推導。
 * 沒有 Rust command、不碰 invoke。
 */
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { dayKeyOf, dayWindow } from "../lib/date";
import type { Mood, NodeRow } from "../domain";
import {
  MISSING_NODE_NAME,
  escapeLike,
  footprintDayKeys,
  groupFootprints,
  type FootprintDay,
  type FootprintLog,
  type FootprintSeal,
  type NoteKind,
  type NoteRow,
} from "../domain/notes";
import type {
  CreateNoteInput,
  DiarySearchQuery,
  NoteListItem,
  NotePatch,
  NoteRepository,
  NotesQuery,
} from "./noteRepository";
import { nodeRepo } from "./index";
import {
  newWriteBatch,
  runWriteBatch,
  type OutboxOp,
  type SyncTable,
  type WriteBatch,
  type WriteStmt,
} from "./syncRepository";

const ALIVE = "n.deleted_at IS NULL";

/** update 收得到的欄（NotePatch 的七欄；車次②加 kind／entry_date）；其餘鍵一律忽略 */
const PATCHABLE = new Set<string>(["title", "body", "noted_at", "node_id", "inbox", "kind", "entry_date"]);

/** 列表三支共用的 SELECT（契約 §3.4）；WHERE 由呼叫端接 */
const SELECT_ITEM = `SELECT n.*,
       CASE WHEN x.id IS NULL THEN NULL WHEN x.kind = 'route' THEN x.id ELSE x.route_id END AS route_id,
       x.name AS node_name,
       x.kind AS node_kind,
       CASE WHEN n.node_id IS NOT NULL AND (x.id IS NULL OR x.deleted_at IS NOT NULL) THEN 1 ELSE 0 END AS node_missing
FROM notes n
LEFT JOIN nodes x ON x.id = n.node_id`;

const ORDER = `ORDER BY n.noted_at DESC, n.created_at DESC`;

/** SQLite 回來的一列（node_missing 是 0/1） */
type RawItem = Omit<NoteListItem, "node_missing"> & { node_missing: number };

function toItem(r: RawItem): NoteListItem {
  return { ...r, node_missing: !!r.node_missing };
}

function placeholders(count: number, start: number): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(",");
}

/** 往批次裡加一筆 op（＝sync_outbox 一列＋每個 col 一筆 sync_cells 戳記）；照抄 sqliteNodeRepository 的模組私有版 */
function addOp(
  b: WriteBatch,
  tbl: SyncTable,
  rowId: string,
  op: "upsert" | "delete",
  cols: Record<string, unknown>,
): void {
  b.ops.push({ tbl, row_id: rowId, op, cols });
}

/** 標題正規化：空字串（含純空白）存 NULL＝列表用內文第一行 */
function normTitle(t: string | null | undefined): string | null {
  return t && t.trim() ? t : null;
}

/**
 * 只改內文的一句 UPDATE＋它的 op（車次③契約 §3.5）：荷札改名／刪除的批次改寫內文走這條，
 * 與 `update(id, { body })` 的語句形狀逐字相同（任務書「走既有 notes 寫入路徑」），由 tagRepo 組進自己的批次。
 */
export function noteBodyUpdate(id: string, body: string, now: string): { stmt: WriteStmt; op: OutboxOp } {
  return {
    stmt: { sql: `UPDATE notes SET body = $1, updated_at = $2 WHERE id = $3`, args: [body, now, id] },
    op: { tbl: "notes", row_id: id, op: "upsert", cols: { body, updated_at: now } },
  };
}

export class SqliteNoteRepository implements NoteRepository {
  async listInbox(): Promise<NoteListItem[]> {
    const db = await getDb();
    const rows = await db.select<RawItem[]>(
      `${SELECT_ITEM}
       WHERE ${ALIVE} AND n.kind = 'note' AND n.inbox = 1
       ${ORDER}`,
    );
    return rows.map(toItem);
  }

  async listNotes(q: NotesQuery = {}): Promise<NoteListItem[]> {
    const db = await getDb();
    const where: string[] = [ALIVE, `n.kind = 'note'`, `n.inbox = 0`];
    const args: unknown[] = [];
    if (q.underNode) {
      // 車次④ P5：掛在這個節點與它底下的（與 routeId 互斥，underNode 優先）
      const ids = Array.from(new Set([q.underNode.id, ...q.underNode.ids]));
      where.push(`n.node_id IN (${placeholders(ids.length, args.length + 1)})`);
      args.push(...ids);
    } else if (q.routeId === "none") {
      where.push(`n.node_id IS NULL`);
    } else if (q.routeId) {
      args.push(q.routeId);
      where.push(`(x.id = $${args.length} OR x.route_id = $${args.length})`);
    }
    const query = (q.query ?? "").trim();
    if (query) {
      args.push(`%${escapeLike(query)}%`);
      where.push(`(n.title LIKE $${args.length} ESCAPE '\\' OR n.body LIKE $${args.length} ESCAPE '\\')`);
    }
    args.push(q.limit ?? 200, q.offset ?? 0);
    const rows = await db.select<RawItem[]>(
      `${SELECT_ITEM}
       WHERE ${where.join(" AND ")}
       ${ORDER}
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return rows.map(toItem);
  }

  async getNote(id: string): Promise<NoteListItem | null> {
    const db = await getDb();
    const rows = await db.select<RawItem[]>(`${SELECT_ITEM} WHERE ${ALIVE} AND n.id = $1`, [id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async listInboxTickets(): Promise<NodeRow[]> {
    // 契約 0-7 甲案已放行：查詢住在 NodeRepository（mock 與真機同一條路）
    return nodeRepo.listInboxTickets();
  }

  async create(input: CreateNoteInput): Promise<NoteRow> {
    const db = await getDb();
    const now = nowUtcIso();
    const id = uuid();
    const kind: NoteKind = input.kind;
    const title = normTitle(input.title);
    const notedAt = input.notedAt ?? now;
    const nodeId = input.nodeId ?? null;
    const inbox = input.inbox ? 1 : 0;
    const entryDate = entryDateOf(input);
    const b = newWriteBatch();
    b.stmts.push({
      sql: `INSERT INTO notes (id, kind, title, body, entry_date, noted_at, node_id, inbox, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      args: [id, kind, title, input.body, entryDate, notedAt, nodeId, inbox, now, now],
    });
    // 首筆 op 帶白名單十欄全部（含 required 的 kind／noted_at，以及 deleted_at: null）——
    // 對面 apply_object 的新列分支缺 required 欄會整列跳過（契約 §3.3）
    addOp(b, "notes", id, "upsert", {
      kind,
      title,
      body: input.body,
      entry_date: entryDate,
      noted_at: notedAt,
      node_id: nodeId,
      inbox,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    await runWriteBatch(db, b.stmts, b.ops);
    return {
      id,
      kind,
      title,
      body: input.body,
      entry_date: entryDate,
      noted_at: notedAt,
      node_id: nodeId,
      inbox,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
  }

  async update(id: string, patch: NotePatch): Promise<void> {
    const picked: [string, unknown][] = [];
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (!PATCHABLE.has(k) || v === undefined) continue;
      if (k === "title") picked.push([k, normTitle(v as string | null)]);
      else if (k === "inbox") picked.push([k, v ? 1 : 0]);
      else picked.push([k, v]);
    }
    if (!picked.length) return;
    const db = await getDb();
    const now = nowUtcIso();
    const sets = picked.map(([k], i) => `${k} = $${i + 1}`);
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE notes SET ${sets.join(", ")}, updated_at = $${picked.length + 1} WHERE id = $${picked.length + 2}`,
      args: [...picked.map(([, v]) => v), now, id],
    });
    addOp(b, "notes", id, "upsert", { ...Object.fromEntries(picked), updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE notes SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND deleted_at IS NULL`,
      args: [now, id],
    });
    // 與 nodes 的 softDelete 同形：delete op 的 payload 也是 {col: value}
    addOp(b, "notes", id, "delete", { deleted_at: now, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async restore(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const db = await getDb();
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE notes SET deleted_at = NULL, updated_at = $1 WHERE id IN (${placeholders(ids.length, 2)})`,
      args: [now, ...ids],
    });
    for (const x of ids) addOp(b, "notes", x, "upsert", { deleted_at: null, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  /* ───────── 階段④・掛樹查詢（契約 §3.2＋§0-0 P4；全部唯讀、不進 outbox） ───────── */

  async listByNodes(nodeIds: readonly string[], here: string, limit = 50): Promise<NoteListItem[]> {
    if (!nodeIds.length) return [];
    const db = await getDb();
    const rows = await db.select<RawItem[]>(
      `${SELECT_ITEM}
       WHERE ${ALIVE} AND n.kind = 'note' AND n.inbox = 0 AND n.node_id IN (${placeholders(nodeIds.length, 3)})
       ORDER BY (n.node_id = $1) DESC, n.noted_at DESC, n.created_at DESC
       LIMIT $2`,
      [here, limit, ...nodeIds],
    );
    return rows.map(toItem);
  }

  async countByNodes(nodeIds: readonly string[]): Promise<number> {
    if (!nodeIds.length) return 0;
    const db = await getDb();
    const rows = await db.select<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM notes n
       WHERE n.deleted_at IS NULL AND n.kind = 'note' AND n.inbox = 0 AND n.node_id IN (${placeholders(nodeIds.length, 1)})`,
      [...nodeIds],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async countNotes(): Promise<number> {
    const db = await getDb();
    const rows = await db.select<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM notes n WHERE n.deleted_at IS NULL AND n.kind = 'note' AND n.inbox = 0`,
    );
    return Number(rows[0]?.c ?? 0);
  }

  async searchQuick(kind: NoteKind, query: string, limit: number): Promise<NoteListItem[]> {
    const q = query.trim();
    if (!q) return [];
    const db = await getDb();
    const rows = await db.select<RawItem[]>(
      `${SELECT_ITEM}
       WHERE ${ALIVE} AND n.kind = $1 AND (n.title LIKE $2 ESCAPE '\\' OR n.body LIKE $2 ESCAPE '\\')
       ORDER BY CASE WHEN $1 = 'diary' THEN n.entry_date ELSE n.noted_at END DESC, n.created_at DESC
       LIMIT $3`,
      [kind, `%${escapeLike(q)}%`, limit],
    );
    return rows.map(toItem);
  }

  /* ───────── 車次②・日記（§3.4） ───────── */

  async listDiary(day: string): Promise<NoteListItem[]> {
    const db = await getDb();
    const rows = await db.select<RawItem[]>(
      `${SELECT_ITEM}
       WHERE ${ALIVE} AND n.kind = 'diary' AND n.entry_date = $1
       ORDER BY n.noted_at ASC, n.created_at ASC`,
      [day],
    );
    return rows.map(toItem);
  }

  async searchDiary(q: DiarySearchQuery): Promise<NoteListItem[]> {
    const query = q.query.trim();
    if (!query) return [];
    const db = await getDb();
    const rows = await db.select<RawItem[]>(
      `${SELECT_ITEM}
       WHERE ${ALIVE} AND n.kind = 'diary'
         AND (n.title LIKE $1 ESCAPE '\\' OR n.body LIKE $1 ESCAPE '\\')
       ORDER BY n.entry_date DESC, n.noted_at DESC
       LIMIT $2 OFFSET $3`,
      [`%${escapeLike(query)}%`, q.limit ?? 100, q.offset ?? 0],
    );
    return rows.map(toItem);
  }

  async listDiaryMarks(from: string, to: string): Promise<Record<string, number>> {
    const db = await getDb();
    const rows = await db.select<{ day: string; c: number }[]>(
      `SELECT entry_date AS day, COUNT(*) AS c FROM notes
       WHERE deleted_at IS NULL AND kind = 'diary' AND entry_date BETWEEN $1 AND $2
       GROUP BY entry_date`,
      [from, to],
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.day] = Number(r.c);
    return out;
  }

  async listDiaryDays(from: string, to: string): Promise<string[]> {
    return Object.keys(await this.listDiaryMarks(from, to)).sort();
  }

  /* ───────── 車次②・當天足跡（唯讀查核心三表；§3.4） ─────────
   * 時間視窗＝日界線日的 [start, end)（lib/date dayWindow），三句各自 SELECT、在 TS 端合成（groupFootprints）。
   * (c) 手記的節點條件：子樹 soft delete 只標 nodes、不連帶標 work_logs（sqliteNodeRepository.softDelete 讀過，
   * 契約 §8-2）⇒ 加 `n.id IS NULL OR n.deleted_at IS NULL`：節點已刪的手記跟著它的済章一起不列；
   * 節點根本不在（還沒同步到）的才顯示「（原車票已刪除）」。 */

  async listFootprints(day: string, dayStartHour: number): Promise<FootprintDay> {
    const db = await getDb();
    const { start, end } = dayWindow(day, dayStartHour);
    const [nodeSeals, occSeals, logs] = await Promise.all([
      // (a) 済章・單發票／列車／車廂／退役定期券（含 cascade 蓋章的子項——cascade 分支也寫 completed_at）
      db.select<SealRow[]>(
        `SELECT n.id, n.id AS node_id, n.name, n.kind, n.route_id, n.completed_at AS at, n.mood, NULL AS due_on
         FROM nodes n
         WHERE n.deleted_at IS NULL AND n.kind IN ('train','car','ticket') AND n.status = 'done'
           AND n.completed_at IS NOT NULL AND n.completed_at >= $1 AND n.completed_at < $2`,
        [start, end],
      ),
      // (b) 済章・定期券班次（運休不列）
      db.select<SealRow[]>(
        `SELECT o.id, o.node_id, n.name, n.kind, n.route_id, o.completed_at AS at, o.mood, o.due_on
         FROM occurrences o JOIN nodes n ON n.id = o.node_id
         WHERE o.deleted_at IS NULL AND n.deleted_at IS NULL AND o.status = 'done'
           AND o.completed_at IS NOT NULL AND o.completed_at >= $1 AND o.completed_at < $2`,
        [start, end],
      ),
      // (c) 手記（event IS NULL；発券／入鋏／済／conflict 都不列，D-筆-22）
      db.select<LogRow[]>(
        `SELECT w.id, w.node_id, w.body, w.logged_at AS at, n.name AS node_name
         FROM work_logs w LEFT JOIN nodes n ON n.id = w.node_id
         WHERE w.deleted_at IS NULL AND w.event IS NULL AND w.body != ''
           AND w.logged_at >= $1 AND w.logged_at < $2
           AND (n.id IS NULL OR n.deleted_at IS NULL)`,
        [start, end],
      ),
    ]);
    const seals: FootprintSeal[] = [...nodeSeals, ...occSeals].map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      name: r.name,
      kind: r.kind,
      routeId: r.route_id,
      at: r.at,
      mood: r.mood,
      dueOn: r.due_on,
    }));
    const footLogs: FootprintLog[] = logs.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      nodeName: r.node_name ?? MISSING_NODE_NAME,
      body: r.body,
      at: r.at,
      nodeMissing: r.node_name === null,
    }));
    // blocks 一律 null：時間塊由 store 經 footprintBlocks 插槽補（repository 不碰插槽，§3.4）
    return groupFootprints(day, seals, footLogs, null);
  }

  async listFootprintDays(from: string, to: string, dayStartHour: number): Promise<string[]> {
    if (from > to) return [];
    const db = await getDb();
    const start = dayWindow(from, dayStartHour).start;
    const end = dayWindow(to, dayStartHour).end;
    // 只撈時間戳；本地時區與日界線在 SQL 裡算不乾淨 ⇒ TS 端 dayKeyOf 分桶（一個月最多幾百列）
    const rows = await db.select<{ at: string }[]>(
      `SELECT completed_at AS at FROM nodes
       WHERE deleted_at IS NULL AND kind IN ('train','car','ticket') AND status = 'done'
         AND completed_at IS NOT NULL AND completed_at >= $1 AND completed_at < $2
       UNION ALL
       SELECT o.completed_at AS at FROM occurrences o JOIN nodes n ON n.id = o.node_id
       WHERE o.deleted_at IS NULL AND n.deleted_at IS NULL AND o.status = 'done'
         AND o.completed_at IS NOT NULL AND o.completed_at >= $1 AND o.completed_at < $2
       UNION ALL
       SELECT w.logged_at AS at FROM work_logs w LEFT JOIN nodes n ON n.id = w.node_id
       WHERE w.deleted_at IS NULL AND w.event IS NULL AND w.body != ''
         AND w.logged_at >= $1 AND w.logged_at < $2
         AND (n.id IS NULL OR n.deleted_at IS NULL)`,
      [start, end],
    );
    return footprintDayKeys(
      rows.map((r) => r.at),
      (iso) => dayKeyOf(iso, dayStartHour),
    );
  }
}

/** (a)／(b) 回來的一列 */
interface SealRow {
  id: string;
  node_id: string;
  name: string;
  kind: FootprintSeal["kind"];
  route_id: string | null;
  at: string;
  mood: Mood | null;
  due_on: string | null;
}

/** (c) 回來的一列；node_name 為 NULL＝LEFT JOIN 沒對到節點 */
interface LogRow {
  id: string;
  node_id: string;
  body: string;
  at: string;
  node_name: string | null;
}

/** create 的 entry_date：日記必填（缺 ⇒ RangeError），筆記恆 NULL（契約 §3.3） */
function entryDateOf(input: CreateNoteInput): string | null {
  if (input.kind !== "diary") return null;
  if (!input.entryDate) throw new RangeError("日記要有日期");
  return input.entryDate;
}
