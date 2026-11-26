/**
 * PhotoAttachmentField——跨模組共用相片附件欄位（v1.39 4A-1）。
 *
 * 雙模式：
 *   1. 已存檔實體模式（傳 `entityType` + `entityId`）：
 *      按需載入該實體相片、選圖或貼上即時壓縮並寫入 SQLite + 同步計數。
 *   2. 新建草稿模式（傳 `drafts` + `onChangeDrafts`）：
 *      新建記帳或補記時間塊前先選好並壓縮暫存，待主紀錄建立拿到 id 後以 `flushAttachmentDrafts` 批次落庫。
 */
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { attachmentRepo } from "../../../data/attachmentRepo";
import {
  MAX_ATTACHMENTS_PER_ENTITY,
  canAddAttachment,
  remainingAttachmentSlots,
  type AttachmentDraft,
  type AttachmentEntityType,
  type AttachmentRow,
} from "../../../domain/attachments";
import { compressPhoto } from "../../../lib/compressPhoto";
import { uuid } from "../../../lib/db";
import { useAttachmentStore } from "../../../store/attachmentStore";
import { useUiStore } from "../../../store/uiStore";
import { IconCamera } from "./AttachmentCountBadge";
import { PhotoLightbox, type LightboxPhotoItem } from "./PhotoLightbox";
import "./attachments.css";

export interface PhotoAttachmentEntityProps {
  mode?: "entity";
  entityType: AttachmentEntityType;
  entityId: string;
  addLabel?: string;
  sourceLabel?: string;
}

export interface PhotoAttachmentDraftProps {
  mode: "draft";
  drafts: readonly AttachmentDraft[];
  onChangeDrafts: (next: AttachmentDraft[]) => void;
  addLabel?: string;
  sourceLabel?: string;
}

export type PhotoAttachmentFieldProps = PhotoAttachmentEntityProps | PhotoAttachmentDraftProps;

/** 新建記帳或時間塊成功拿到實體 id 後，將暫存相片草稿批次寫入附件櫃 */
export async function flushAttachmentDrafts(
  entityType: AttachmentEntityType,
  entityId: string,
  drafts: readonly AttachmentDraft[],
): Promise<number> {
  if (!entityId || !drafts.length) return 0;
  let wrote = 0;
  for (const d of drafts.slice(0, MAX_ATTACHMENTS_PER_ENTITY)) {
    try {
      await attachmentRepo.addAttachment({
        entityType,
        entityId,
        photoData: d.photoData,
        mime: d.mime,
        width: d.width,
        height: d.height,
        byteSize: d.byteSize,
        caption: d.caption,
      });
      wrote++;
    } catch (e) {
      console.warn("[attachments] 寫入暫存相片失敗", e);
    }
  }
  if (wrote > 0) {
    useAttachmentStore.getState().bumpCount(entityType, entityId, wrote);
  }
  return wrote;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function PhotoAttachmentField(props: PhotoAttachmentFieldProps) {
  const isDraft = props.mode === "draft";
  const entityType = !isDraft ? props.entityType : null;
  const entityId = !isDraft ? props.entityId : "";
  const revision = useAttachmentStore((s) => s.revision);
  const bumpCount = useAttachmentStore((s) => s.bumpCount);
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  // 實體模式：按需載入實圖（切換實體或遠端同步 revision 遞增時重拉）
  useEffect(() => {
    if (isDraft || !entityType || !entityId) {
      setRows([]);
      return;
    }
    let alive = true;
    setLoading(true);
    void attachmentRepo
      .listByEntity(entityType, entityId)
      .then((list) => {
        if (alive) setRows(list);
      })
      .catch((e: unknown) => {
        console.warn("[attachments] 載入相片失敗", e);
        if (alive) setRows([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isDraft, entityType, entityId, revision]);

  const lightboxItems = useMemo<LightboxPhotoItem[]>(() => {
    if (isDraft) {
      return props.drafts.map((d) => ({
        id: d.localId,
        photoData: d.photoData,
        caption: d.caption,
        width: d.width,
        height: d.height,
        byteSize: d.byteSize,
        sourceLabel: props.sourceLabel,
      }));
    }
    return rows.map((r) => ({
      id: r.id,
      photoData: r.photo_data,
      caption: r.caption,
      width: r.width,
      height: r.height,
      byteSize: r.byte_size,
      sourceLabel: props.sourceLabel,
    }));
  }, [isDraft, isDraft ? props.drafts : rows, props.sourceLabel]);

  const count = lightboxItems.length;
  const canAdd = canAddAttachment(count);

  const ingestFiles = async (files: readonly Blob[]) => {
    if (!files.length || busy) return;
    const slots = remainingAttachmentSlots(count);
    if (slots <= 0) {
      useUiStore.getState().showToast({ message: `最多可附加 ${MAX_ATTACHMENTS_PER_ENTITY} 張相片` });
      return;
    }
    const picked = files.slice(0, slots);
    if (files.length > slots) {
      useUiStore.getState().showToast({ message: `最多 ${MAX_ATTACHMENTS_PER_ENTITY} 張，已自動取前 ${slots} 張` });
    }

    setBusy(true);
    try {
      if (isDraft) {
        const added: AttachmentDraft[] = [];
        for (const f of picked) {
          const res = await compressPhoto(f);
          added.push({
            localId: uuid(),
            photoData: res.dataUrl,
            mime: res.mimeType,
            width: res.width,
            height: res.height,
            byteSize: res.byteSize,
            caption: "",
          });
        }
        if (added.length) {
          props.onChangeDrafts([...props.drafts, ...added].slice(0, MAX_ATTACHMENTS_PER_ENTITY));
        }
      } else if (entityType && entityId) {
        const addedRows: AttachmentRow[] = [];
        for (const f of picked) {
          const res = await compressPhoto(f);
          const row = await attachmentRepo.addAttachment({
            entityType,
            entityId,
            photoData: res.dataUrl,
            mime: res.mimeType,
            width: res.width,
            height: res.height,
            byteSize: res.byteSize,
          });
          addedRows.push(row);
        }
        if (addedRows.length) {
          setRows((prev) => [...prev, ...addedRows]);
          bumpCount(entityType, entityId, addedRows.length);
        }
      }
    } catch (e) {
      useUiStore.getState().showToast({ message: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items || !items.length) return;
    const imgs: Blob[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) imgs.push(blob);
      }
    }
    if (!imgs.length) return;
    e.preventDefault();
    e.stopPropagation();
    void ingestFiles(imgs);
  };

  const handleDelete = async (id: string) => {
    try {
      if (isDraft) {
        const next = props.drafts.filter((d) => d.localId !== id);
        props.onChangeDrafts(next);
        if (openIdx !== null) {
          if (next.length === 0) setOpenIdx(null);
          else if (openIdx >= next.length) setOpenIdx(next.length - 1);
        }
      } else if (entityType && entityId) {
        await attachmentRepo.deleteAttachment(id);
        setRows((prev) => {
          const next = prev.filter((r) => r.id !== id);
          if (openIdx !== null) {
            if (next.length === 0) setOpenIdx(null);
            else if (openIdx >= next.length) setOpenIdx(next.length - 1);
          }
          return next;
        });
        bumpCount(entityType, entityId, -1);
      }
    } catch (e) {
      useUiStore.getState().showToast({ message: errText(e) });
    }
  };

  const handleUpdateCaption = async (id: string, caption: string) => {
    try {
      if (isDraft) {
        props.onChangeDrafts(
          props.drafts.map((d) => (d.localId === id ? { ...d, caption } : d)),
        );
      } else {
        const updated = await attachmentRepo.updateCaption(id, caption);
        setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
      }
    } catch (e) {
      useUiStore.getState().showToast({ message: errText(e) });
    }
  };

  const addText = props.addLabel ?? "貼上相片／票根";

  return (
    <div className="ns-att-field" onPaste={handlePaste} tabIndex={-1}>
      <input
        ref={fileRef}
        id={inputId}
        type="file"
        accept="image/*"
        multiple
        className="ns-att-filein"
        onChange={(e) => {
          const list = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (list.length) void ingestFiles(list);
        }}
      />

      {count > 0 ? (
        <div className="ns-att-grid">
          {lightboxItems.map((it, idx) => (
            <div key={it.id} className="ns-att-thumb">
              <button
                type="button"
                className="ns-att-thumb-hit"
                aria-label={it.caption ? `檢視相片：${it.caption}` : `檢視第 ${idx + 1} 張相片`}
                onClick={() => setOpenIdx(idx)}
              >
                <img src={it.photoData} alt={it.caption || `相片 ${idx + 1}`} />
              </button>
              {it.caption && <span className="ns-att-thumb-cap">{it.caption}</span>}
              <button
                type="button"
                className="ns-att-thumb-del"
                aria-label="移除這張相片"
                title="移除這張相片"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(it.id);
                }}
              >
                ×
              </button>
            </div>
          ))}

          {canAdd && (
            <button
              type="button"
              className="ns-att-add is-tile"
              disabled={busy}
              aria-label={addText}
              title={`${addText}（支援剪貼簿貼上）`}
              onClick={() => fileRef.current?.click()}
            >
              <IconCamera size={14} />
              <span>{busy ? "處理中" : "＋ 新增"}</span>
            </button>
          )}
        </div>
      ) : (
        <div>
          <button
            type="button"
            className="ns-att-add"
            disabled={busy || loading}
            onClick={() => fileRef.current?.click()}
          >
            <IconCamera size={13} />
            <span>{busy ? "壓縮相片中…" : loading ? "載入中…" : `＋ ${addText}`}</span>
          </button>
        </div>
      )}

      {(count > 0 || busy) && (
        <div className="ns-att-meta-row">
          <span>{busy ? "正在輕量化壓縮…" : "點擊看大圖或寫圖說・支援貼上圖片"}</span>
          <span className="cnt">
            {count}/{MAX_ATTACHMENTS_PER_ENTITY}
          </span>
        </div>
      )}

      {openIdx !== null && (
        <PhotoLightbox
          items={lightboxItems}
          index={openIdx}
          onIndexChange={setOpenIdx}
          onClose={() => setOpenIdx(null)}
          onUpdateCaption={handleUpdateCaption}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
