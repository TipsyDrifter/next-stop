/**
 * 跨模組輕量相片附件櫃（`attachments`）資料層介面（v1.39 4A-1）。
 *
 * 效能鐵則：
 *   - 清單頁（售票口帳簿、時刻表時間軸）只呼叫 `listCountsByType`／`listAllCounts`（SQL 僅查 COUNT，絕不讀 `photo_data`）。
 *   - 只在開啟詳情側板／編輯表單時呼叫 `listByEntity` 按需讀實圖。
 *   - 只在開啟「運行報告 → 一日運行專頁」時呼叫 `listByEntities` 按需批次讀當日實圖。
 */
import type {
  AttachmentEntityRef,
  AttachmentEntityType,
  AttachmentRow,
} from "../domain/attachments";

export interface AddAttachmentInput {
  entityType: AttachmentEntityType;
  entityId: string;
  photoData: string;
  mime?: string;
  width?: number | null;
  height?: number | null;
  byteSize?: number | null;
  caption?: string;
}

export interface AttachmentRepository {
  /** 指定實體類型的輕量計數（entity_id → 張數）；絕不讀取 photo_data */
  listCountsByType(entityType: AttachmentEntityType): Promise<Record<string, number>>;
  /** 全站未刪除附件計數（`${entity_type}:${entity_id}` → 張數）；絕不讀取 photo_data */
  listAllCounts(): Promise<Record<string, number>>;
  /** 打開詳情面板／表單時按需讀取單一實體的全部實圖（依 position, created_at 升冪） */
  listByEntity(entityType: AttachmentEntityType, entityId: string): Promise<AttachmentRow[]>;
  /** 打開運行報告單日跨頁時按需批次讀取當日相關實體的實圖 */
  listByEntities(refs: readonly AttachmentEntityRef[]): Promise<AttachmentRow[]>;
  /** 依 id 取單筆（同步衝突列名用，預設不含已刪） */
  getAttachment(id: string, opts?: { withDeleted?: boolean }): Promise<AttachmentRow | null>;
  /** 新增相片附件（受 MAX_ATTACHMENTS_PER_ENTITY 上限保護；原子寫入 SQLite + sync op） */
  addAttachment(input: AddAttachmentInput): Promise<AttachmentRow>;
  /** 修改圖說（原子寫入 SQLite + sync op） */
  updateCaption(id: string, caption: string): Promise<AttachmentRow>;
  /** 軟刪除附件（設 deleted_at + sync op） */
  deleteAttachment(id: string): Promise<void>;
}
