/**
 * 跨模組輕量相片附件櫃（`attachments`）SQLite 實作（v1.39 4A-1）。
 *
 * 對齊 migration `0028_attachments_and_chains.sql` 與 `src-tauri/src/sync/tables/core.rs` (`ATTACHMENTS_COLS`)：
 *   `id, entity_type, entity_id, caption, mime, photo_data, width, height, byte_size, position, created_at, updated_at, deleted_at`
 *
 * 寫入一律經 `newWriteBatch` → `runWriteBatch` 原子送出資料列與同步 op。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { newWriteBatch, runWriteBatch } from "./syncRepository";
import type { AddAttachmentInput, AttachmentRepository } from "./attachmentRepository";
import {
  MAX_ATTACHMENTS_PER_ENTITY,
  attachmentEntityKey,
  estimateAttachmentBytes,
  isAttachmentEntityType,
  mimeFromDataUrl,
  validateAttachmentCaption,
  validateAttachmentDataUrl,
  type AttachmentEntityRef,
  type AttachmentEntityType,
  type AttachmentRow,
} from "../domain/attachments";

const ALIVE = "deleted_at IS NULL";
const CHUNK_SIZE = 200;

export class SqliteAttachmentRepository implements AttachmentRepository {
  private async getRow(db: Database, id: string): Promise<AttachmentRow | null> {
    const rows = await db.select<AttachmentRow[]>(`SELECT * FROM attachments WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listCountsByType(entityType: AttachmentEntityType): Promise<Record<string, number>> {
    const db = await getDb();
    const rows = await db.select<{ entity_id: string; cnt: number }[]>(
      `SELECT entity_id, COUNT(*) AS cnt
       FROM attachments
       WHERE entity_type = $1 AND ${ALIVE}
       GROUP BY entity_id`,
      [entityType],
    );
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (r.cnt > 0) out[r.entity_id] = r.cnt;
    }
    return out;
  }

  async listAllCounts(): Promise<Record<string, number>> {
    const db = await getDb();
    const rows = await db.select<{ entity_type: string; entity_id: string; cnt: number }[]>(
      `SELECT entity_type, entity_id, COUNT(*) AS cnt
       FROM attachments
       WHERE ${ALIVE}
       GROUP BY entity_type, entity_id`,
    );
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (r.cnt > 0 && isAttachmentEntityType(r.entity_type)) {
        out[attachmentEntityKey(r.entity_type, r.entity_id)] = r.cnt;
      }
    }
    return out;
  }

  async listByEntity(entityType: AttachmentEntityType, entityId: string): Promise<AttachmentRow[]> {
    if (!entityId) return [];
    const db = await getDb();
    return db.select<AttachmentRow[]>(
      `SELECT id, entity_type, entity_id, caption, mime, photo_data, width, height, byte_size, position, created_at, updated_at, deleted_at
       FROM attachments
       WHERE entity_type = $1 AND entity_id = $2 AND ${ALIVE}
       ORDER BY position ASC, created_at ASC, id ASC`,
      [entityType, entityId],
    );
  }

  async listByEntities(refs: readonly AttachmentEntityRef[]): Promise<AttachmentRow[]> {
    if (!refs.length) return [];
    const byType = new Map<AttachmentEntityType, string[]>();
    const seen = new Set<string>();
    for (const r of refs) {
      if (!r.entityId) continue;
      const key = attachmentEntityKey(r.entityType, r.entityId);
      if (seen.has(key)) continue;
      seen.add(key);
      const list = byType.get(r.entityType);
      if (list) list.push(r.entityId);
      else byType.set(r.entityType, [r.entityId]);
    }
    if (byType.size === 0) return [];

    const db = await getDb();
    const out: AttachmentRow[] = [];
    for (const [entityType, ids] of byType.entries()) {
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const ph = chunk.map((_, k) => `$${k + 2}`).join(", ");
        const rows = await db.select<AttachmentRow[]>(
          `SELECT id, entity_type, entity_id, caption, mime, photo_data, width, height, byte_size, position, created_at, updated_at, deleted_at
           FROM attachments
           WHERE entity_type = $1 AND entity_id IN (${ph}) AND ${ALIVE}
           ORDER BY position ASC, created_at ASC, id ASC`,
          [entityType, ...chunk],
        );
        for (const row of rows) out.push(row);
      }
    }
    return out;
  }

  async getAttachment(id: string, opts?: { withDeleted?: boolean }): Promise<AttachmentRow | null> {
    const db = await getDb();
    const row = await this.getRow(db, id);
    if (!row) return null;
    return row.deleted_at !== null && !opts?.withDeleted ? null : row;
  }

  async addAttachment(input: AddAttachmentInput): Promise<AttachmentRow> {
    if (!isAttachmentEntityType(input.entityType)) {
      throw new RangeError("不支援的附件類型");
    }
    const entityId = input.entityId.trim();
    if (!entityId) throw new RangeError("缺少附件歸屬項目");
    const photoData = validateAttachmentDataUrl(input.photoData);
    const caption = validateAttachmentCaption(input.caption);
    const mime = input.mime?.trim() || mimeFromDataUrl(photoData);
    const width = typeof input.width === "number" && Number.isFinite(input.width) ? Math.round(input.width) : null;
    const height = typeof input.height === "number" && Number.isFinite(input.height) ? Math.round(input.height) : null;
    const byteSize =
      typeof input.byteSize === "number" && Number.isFinite(input.byteSize)
        ? Math.round(input.byteSize)
        : estimateAttachmentBytes(photoData);

    const db = await getDb();
    const stat = await db.select<{ cnt: number; max_pos: number | null }[]>(
      `SELECT COUNT(*) AS cnt, MAX(position) AS max_pos
       FROM attachments
       WHERE entity_type = $1 AND entity_id = $2 AND ${ALIVE}`,
      [input.entityType, entityId],
    );
    const cnt = stat[0]?.cnt ?? 0;
    if (cnt >= MAX_ATTACHMENTS_PER_ENTITY) {
      throw new RangeError(`每筆紀錄最多附加 ${MAX_ATTACHMENTS_PER_ENTITY} 張相片`);
    }
    const position = (stat[0]?.max_pos ?? -1) + 1;
    const now = nowUtcIso();
    const id = uuid();

    const b = newWriteBatch();
    b.stmts.push({
      sql: `INSERT INTO attachments
              (id, entity_type, entity_id, caption, mime, photo_data, width, height, byte_size, position, created_at, updated_at, deleted_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, NULL)`,
      args: [id, input.entityType, entityId, caption, mime, photoData, width, height, byteSize, position, now],
    });
    b.ops.push({
      tbl: "attachments",
      row_id: id,
      op: "upsert",
      cols: {
        entity_type: input.entityType,
        entity_id: entityId,
        caption,
        mime,
        photo_data: photoData,
        width,
        height,
        byte_size: byteSize,
        position,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
    });
    await runWriteBatch(db, b.stmts, b.ops);

    return {
      id,
      entity_type: input.entityType,
      entity_id: entityId,
      caption,
      mime,
      photo_data: photoData,
      width,
      height,
      byte_size: byteSize,
      position,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
  }

  async updateCaption(id: string, rawCaption: string): Promise<AttachmentRow> {
    const db = await getDb();
    const cur = await this.getRow(db, id);
    if (!cur || cur.deleted_at !== null) throw new RangeError("找不到這張相片附件");
    const caption = validateAttachmentCaption(rawCaption);
    if (caption === cur.caption) return cur;

    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE attachments SET caption = $1, updated_at = $2 WHERE id = $3`,
      args: [caption, now, id],
    });
    b.ops.push({
      tbl: "attachments",
      row_id: id,
      op: "upsert",
      cols: { caption, updated_at: now },
    });
    await runWriteBatch(db, b.stmts, b.ops);
    return { ...cur, caption, updated_at: now };
  }

  async deleteAttachment(id: string): Promise<void> {
    const db = await getDb();
    const cur = await this.getRow(db, id);
    if (!cur || cur.deleted_at !== null) return;

    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE attachments SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
      args: [now, id],
    });
    b.ops.push({
      tbl: "attachments",
      row_id: id,
      op: "delete",
      cols: { deleted_at: now, updated_at: now },
    });
    await runWriteBatch(db, b.stmts, b.ops);
  }
}
