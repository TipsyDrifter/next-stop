/**
 * 跨模組輕量相片附件櫃（`attachments`）記憶體實作（`?mock=1` 預覽與單元測試用）。
 *
 * 內建兩張輕量鐵道票根／窗景示範 SVG DataURL，可在 mock 模式下驗證縮圖、燈箱、計數徽章與運行報告單日生活掠影。
 */
import { nowUtcIso, uuid } from "../lib/db";
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

/** 示範票根／收據小圖（輕量 SVG Base64 DataURL） */
const DEMO_RECEIPT_SVG =
  "data:image/svg+xml;base64," +
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMjAgMjIwIj4" +
  "8cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjIyMCIgZmlsbD0iI2YyZWRlNCIvP" +
  "jxyZWN0IHg9IjIyIiB5PSIxOCIgd2lkdGg9IjI3NiIgaGVpZ2h0PSIxODQiIHJ4PSI2IiBmaWxsPSIjZmFmNmYwIiBzdHJva2U9IiM5YjhhNzYiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtZGFzaGFycmF5PSI0IDMiLz4" +
  "8dGV4dCB4PSI0MiIgeT0iNTQiIGZpbGw9IiMyYTJiNDkiIGZvbnQtZmFtaWx5PSJzZXJpZiIgZm9udC1zaXplPSIxOCIgZm9udC13ZWlnaHQ9IjcwMCI+Q0FGRSBSRUNFSVBUPC90ZXh0Pg" +
  "PGxpbmUgeDE9IjQyIiB5MT0iNzAiIHgyPSIyNzgiIHkyPSI3MCIgc3Ryb2tlPSIjYjhiMGMyIiBzdHJva2UtZGFzaGFycmF5PSIzIDMiLz4" +
  "8dGV4dCB4PSI0MiIgeT0iMTAyIiBmaWxsPSIjNDc0NjY3IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMyI+SGFuZC1EcmlwIENvZmZlZSAuLi4gTlQkIDE0MDwvdGV4dD4" +
  "8dGV4dCB4PSI0MiIgeT0iMTI4IiBmaWxsPSIjNDc0NjY3IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMyI+Q2lubmFtb24gUm9sbCAuLi4uLi4gTlQkIDg1PC90ZXh0Pg" +
  "PGNpcmNsZSBjeD0iMjUwIiBjeT0iMTU4IiByPSIyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjYWQzZDJiIiBzdHJva2Utd2lkdGg9IjIiIG9wYWNpdHk9IjAuNzgiLz4" +
  "PHRleHQgeD0iMjUwIiB5PSIxNjMiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IiNhZDNkMmIiIGZvbnQtZmFtaWx5PSJzZXJpZiIgZm9udC1zaXplPSIxMSI+UEFJRDwvdGV4dD4" +
  "8L3N2Zz4=";

/** 示範窗邊讀書風景小圖（輕量 SVG Base64 DataURL） */
const DEMO_SCENERY_SVG =
  "data:image/svg+xml;base64," +
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMjAgMjIwIj4" +
  "PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJzIiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+" +
  "PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzliYWNkMyIvPjxzdG9wIG9mZnNldD0iNTUlIiBzdG9wLWNvbG9yPSIjYzhiZmUxIi8+" +
  "PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjZWJjZWRiIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+" +
  "PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIyMjAiIGZpbGw9InVybCgjcykiLz4" +
  "PHBhdGggZD0iTTAgMTY1IFE5MCAxMzAgMTgwIDE1MCBUMzIwIDE0MCBMMzIwIDIyMCBMMCAyMjAgWiIgZmlsbD0iIzM4M2Q2MyIgb3BhY2l0eT0iMC43NSIvPg" +
  "PGNpcmNsZSBjeD0iMjQ0IiBjeT0iNTYiIHI9IjE2IiBmaWxsPSIjZjdlNWM1IiBvcGFjaXR5PSIwLjkiLz4" +
  "PHJlY3QgeD0iMzYiIHk9IjE1MCIgd2lkdGg9IjEyMCIgaGVpZ2h0PSIxOCIgZmlsbD0iIzJjMzA1OSIgcnk9IjIiLz4" +
  "PHJlY3QgeD0iNDYiIHk9IjE1NSIgd2lkdGg9IjE2IiBoZWlnaHQ9IjgiIGZpbGw9IiNmN2U1YzUiLz4" +
  "PHJlY3QgeD0iNzAiIHk9IjE1NSIgd2lkdGg9IjE2IiBoZWlnaHQ9IjgiIGZpbGw9IiNmN2U1YzUiLz4" +
  "PHJlY3QgeD0iOTQiIHk9IjE1NSIgd2lkdGg9IjE2IiBoZWlnaHQ9IjgiIGZpbGw9IiNmN2U1YzUiLz4" +
  "PHJlY3QgeD0iMTE4IiB5PSIxNTUiIHdpZHRoPSIxNiIgaGVpZ2h0PSI4IiBmaWxsPSIjZjdlNWM1Ii8+" +
  "PC9zdmc+";

export interface DemoAttachmentTargets {
  ticketEntryId?: string | null;
  timetableBlockId?: string | null;
}

const clone = (r: AttachmentRow): AttachmentRow => ({ ...r });
const isAlive = (r: AttachmentRow): boolean => r.deleted_at === null;
const cmpRows = (a: AttachmentRow, b: AttachmentRow): number =>
  a.position - b.position ||
  (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class MemoryAttachmentRepository implements AttachmentRepository {
  private readonly rows = new Map<string, AttachmentRow>();
  private readonly seedDemo: boolean;
  private readonly resolveTargets?: () => Promise<DemoAttachmentTargets>;
  private seedPromise: Promise<void> | null = null;

  constructor(opts?: {
    seedDemo?: boolean;
    resolveTargets?: () => Promise<DemoAttachmentTargets>;
  }) {
    this.seedDemo = opts?.seedDemo ?? false;
    this.resolveTargets = opts?.resolveTargets;
  }

  private async ready(): Promise<void> {
    if (!this.seedDemo) return;
    if (!this.seedPromise) {
      this.seedPromise = this.runSeed().catch(() => undefined);
    }
    await this.seedPromise;
  }

  private async runSeed(): Promise<void> {
    const targets = this.resolveTargets ? await this.resolveTargets() : {};
    const now = nowUtcIso();
    if (targets.ticketEntryId) {
      const id = "demo-att-ticket-1";
      this.rows.set(id, {
        id,
        entity_type: "ticket:entry",
        entity_id: targets.ticketEntryId,
        caption: "午後手沖咖啡與肉桂捲收據",
        mime: "image/svg+xml",
        photo_data: DEMO_RECEIPT_SVG,
        width: 320,
        height: 220,
        byte_size: estimateAttachmentBytes(DEMO_RECEIPT_SVG),
        position: 0,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
    }
    if (targets.timetableBlockId) {
      const id = "demo-att-block-1";
      this.rows.set(id, {
        id,
        entity_type: "timetable:block",
        entity_id: targets.timetableBlockId,
        caption: "黃昏時分的窗邊桌面與電車風景",
        mime: "image/svg+xml",
        photo_data: DEMO_SCENERY_SVG,
        width: 320,
        height: 220,
        byte_size: estimateAttachmentBytes(DEMO_SCENERY_SVG),
        position: 0,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
    }
  }

  async listCountsByType(entityType: AttachmentEntityType): Promise<Record<string, number>> {
    await this.ready();
    const out: Record<string, number> = {};
    for (const r of this.rows.values()) {
      if (!isAlive(r) || r.entity_type !== entityType) continue;
      out[r.entity_id] = (out[r.entity_id] ?? 0) + 1;
    }
    return out;
  }

  async listAllCounts(): Promise<Record<string, number>> {
    await this.ready();
    const out: Record<string, number> = {};
    for (const r of this.rows.values()) {
      if (!isAlive(r)) continue;
      const k = attachmentEntityKey(r.entity_type, r.entity_id);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  async listByEntity(entityType: AttachmentEntityType, entityId: string): Promise<AttachmentRow[]> {
    await this.ready();
    if (!entityId) return [];
    const list: AttachmentRow[] = [];
    for (const r of this.rows.values()) {
      if (isAlive(r) && r.entity_type === entityType && r.entity_id === entityId) {
        list.push(clone(r));
      }
    }
    return list.sort(cmpRows);
  }

  async listByEntities(refs: readonly AttachmentEntityRef[]): Promise<AttachmentRow[]> {
    await this.ready();
    if (!refs.length) return [];
    const want = new Set(refs.map((r) => attachmentEntityKey(r.entityType, r.entityId)));
    const list: AttachmentRow[] = [];
    for (const r of this.rows.values()) {
      if (isAlive(r) && want.has(attachmentEntityKey(r.entity_type, r.entity_id))) {
        list.push(clone(r));
      }
    }
    return list.sort(cmpRows);
  }

  async getAttachment(id: string, opts?: { withDeleted?: boolean }): Promise<AttachmentRow | null> {
    await this.ready();
    const r = this.rows.get(id);
    if (!r) return null;
    if (r.deleted_at !== null && !opts?.withDeleted) return null;
    return clone(r);
  }

  async addAttachment(input: AddAttachmentInput): Promise<AttachmentRow> {
    await this.ready();
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

    const existing = Array.from(this.rows.values()).filter(
      (r) => isAlive(r) && r.entity_type === input.entityType && r.entity_id === entityId,
    );
    if (existing.length >= MAX_ATTACHMENTS_PER_ENTITY) {
      throw new RangeError(`每筆紀錄最多附加 ${MAX_ATTACHMENTS_PER_ENTITY} 張相片`);
    }
    const maxPos = existing.reduce((m, r) => Math.max(m, r.position), -1);
    const now = nowUtcIso();
    const row: AttachmentRow = {
      id: uuid(),
      entity_type: input.entityType,
      entity_id: entityId,
      caption,
      mime,
      photo_data: photoData,
      width,
      height,
      byte_size: byteSize,
      position: maxPos + 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.rows.set(row.id, row);
    return clone(row);
  }

  async updateCaption(id: string, rawCaption: string): Promise<AttachmentRow> {
    await this.ready();
    const cur = this.rows.get(id);
    if (!cur || !isAlive(cur)) throw new RangeError("找不到這張相片附件");
    const caption = validateAttachmentCaption(rawCaption);
    if (caption === cur.caption) return clone(cur);
    cur.caption = caption;
    cur.updated_at = nowUtcIso();
    return clone(cur);
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.ready();
    const cur = this.rows.get(id);
    if (!cur || !isAlive(cur)) return;
    const now = nowUtcIso();
    cur.deleted_at = now;
    cur.updated_at = now;
  }
}
