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
import type { NodeRow } from "../domain";
import { escapeLike, type NoteKind, type NoteRow } from "../domain/notes";
import type { CreateNoteInput, NoteListItem, NotePatch, NoteRepository, NotesQuery } from "./noteRepository";
import { nodeRepo } from "./index";
import { newWriteBatch, runWriteBatch, type SyncTable, type WriteBatch } from "./syncRepository";

const ALIVE = "n.deleted_at IS NULL";

/** update 收得到的欄（NotePatch 的五欄）；其餘鍵一律忽略 */
const PATCHABLE = new Set<string>(["title", "body", "noted_at", "node_id", "inbox"]);

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
    if (q.routeId === "none") {
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
    const b = newWriteBatch();
    b.stmts.push({
      sql: `INSERT INTO notes (id, kind, title, body, entry_date, noted_at, node_id, inbox, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      args: [id, kind, title, input.body, null, notedAt, nodeId, inbox, now, now],
    });
    // 首筆 op 帶白名單十欄全部（含 required 的 kind／noted_at，以及 deleted_at: null）——
    // 對面 apply_object 的新列分支缺 required 欄會整列跳過（契約 §3.3）
    addOp(b, "notes", id, "upsert", {
      kind,
      title,
      body: input.body,
      entry_date: null,
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
      entry_date: null,
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
}
