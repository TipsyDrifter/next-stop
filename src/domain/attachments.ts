/**
 * 跨模組輕量相片附件櫃（`attachments`）純領域模型（第八本第四梯 v1.39；4A-1）。
 *
 * 零 React／Store／Tauri 執行期相依，供 Node 單元測試與探針直接載入。
 * 清單頁永遠只看輕量計數（絕不讀 `photo_data`），只在打開詳情面板或運行報告單日跨頁時按需載入實圖。
 */

export type AttachmentEntityType = "ticket:entry" | "timetable:block";

export const MAX_ATTACHMENTS_PER_ENTITY = 4;
export const MAX_ATTACHMENT_DATA_CHARS = 240_000;
export const MAX_ATTACHMENT_CAPTION_CHARS = 120;

/** 附件中繼資料（不含 photo_data） */
export interface AttachmentMeta {
  id: string;
  entity_type: AttachmentEntityType;
  entity_id: string;
  caption: string;
  mime: string;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 完整附件資料列（對齊 migration 0028 `attachments`） */
export interface AttachmentRow extends AttachmentMeta {
  photo_data: string;
}

/** 新建記帳或補記時間塊尚未存檔前的暫存相片草稿 */
export interface AttachmentDraft {
  localId: string;
  photoData: string;
  mime: string;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  caption: string;
}

/** 批次載入指定實體相片用的定位鍵 */
export interface AttachmentEntityRef {
  entityType: AttachmentEntityType;
  entityId: string;
}

export function isAttachmentEntityType(v: unknown): v is AttachmentEntityType {
  return v === "ticket:entry" || v === "timetable:block";
}

/** 組成附件計數快取鍵（`${entityType}:${entityId}`） */
export function attachmentEntityKey(entityType: AttachmentEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** 清理並驗證圖說：轉單行、去除前後空白，超過長度上限則截斷至 120 字 */
export function validateAttachmentCaption(caption: string | null | undefined): string {
  if (!caption) return "";
  const single = caption.replace(/[\r\n\t]+/g, " ").trim();
  if (!single) return "";
  const chars = Array.from(single);
  if (chars.length <= MAX_ATTACHMENT_CAPTION_CHARS) return single;
  return chars.slice(0, MAX_ATTACHMENT_CAPTION_CHARS).join("");
}

/** 判斷目前張數是否還可新增附件（上限 4 張） */
export function canAddAttachment(currentCount: number): boolean {
  if (!Number.isFinite(currentCount) || currentCount < 0) return true;
  return Math.floor(currentCount) < MAX_ATTACHMENTS_PER_ENTITY;
}

/** 尚可新增的張數 */
export function remainingAttachmentSlots(currentCount: number): number {
  if (!Number.isFinite(currentCount) || currentCount < 0) return MAX_ATTACHMENTS_PER_ENTITY;
  return Math.max(0, MAX_ATTACHMENTS_PER_ENTITY - Math.floor(currentCount));
}

const VALID_DATA_URL_RE = /^data:image\/(?:webp|jpeg|jpg|png|svg\+xml);base64,[A-Za-z0-9+/=]+$/i;

/** 驗證附件 DataURL 格式與容量上限（不合法拋出 RangeError） */
export function validateAttachmentDataUrl(raw: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new RangeError("相片內容不能是空的");
  if (s.length > MAX_ATTACHMENT_DATA_CHARS) {
    throw new RangeError("相片大小超過上限，請換一張較輕量的圖片");
  }
  if (!VALID_DATA_URL_RE.test(s)) {
    throw new RangeError("相片格式不支援（僅接受 WebP／JPEG／PNG／SVG）");
  }
  return s;
}

/** 從合法 DataURL 推斷 MIME 型別 */
export function mimeFromDataUrl(dataUrl: string): string {
  const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  return m ? m[1].toLowerCase() : "image/webp";
}

/** 估算 DataURL 實際位元組數 */
export function estimateAttachmentBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const b64 = dataUrl.slice(comma + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** 格式化附件檔案大小（例如 `42 KB`、`1.2 MB`、`680 B`） */
export function formatAttachmentSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
