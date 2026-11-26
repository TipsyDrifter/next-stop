/**
 * PhotoLightbox——跨模組相片附件大圖檢視燈箱（v1.39 4A-1）。
 *
 * - 支援多張切換（←／→ 鍵盤與按鈕）、Esc 關閉、點遮罩關閉。
 * - 必須接入 `useBackLayer` 支援 Android 硬體返回鍵關閉。
 * - 支援顯示來源標籤、選配跳轉按鈕（單日跨頁回跳記帳／時刻表）、以及選配圖說編輯與移除。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatAttachmentSize, MAX_ATTACHMENT_CAPTION_CHARS } from "../../../domain/attachments";
import { IconBack, IconChevron, IconClose } from "../icons";
import { useBackLayer } from "../../mobile/backStack";
import "./attachments.css";

export interface LightboxPhotoItem {
  id: string;
  photoData: string;
  caption: string;
  width?: number | null;
  height?: number | null;
  byteSize?: number | null;
  /** 來源標籤（例：售票口 · NT$ 225 或 時刻表 · 14:35 · 路易莎咖啡） */
  sourceLabel?: string;
  /** 跳轉按鈕文字（例：前往這筆記帳 ›） */
  jumpLabel?: string;
  onJump?: () => void;
}

export interface PhotoLightboxProps {
  items: readonly LightboxPhotoItem[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  /** 若提供則允許就地編輯一句圖說 */
  onUpdateCaption?: (id: string, caption: string) => void | Promise<void>;
  /** 若提供則允許刪除該張相片 */
  onDelete?: (id: string) => void | Promise<void>;
  backId?: string;
}

export function PhotoLightbox({
  items,
  index,
  onIndexChange,
  onClose,
  onUpdateCaption,
  onDelete,
  backId = "common.photoLightbox",
}: PhotoLightboxProps) {
  const safeIndex = Math.max(0, Math.min(index, Math.max(0, items.length - 1)));
  const item = items[safeIndex] ?? null;
  const [captionDraft, setCaptionDraft] = useState(item?.caption ?? "");
  const [savingCap, setSavingCap] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useBackLayer(backId, item !== null, onClose, "dialog");

  useEffect(() => {
    setCaptionDraft(item?.caption ?? "");
  }, [item?.id, item?.caption]);

  useEffect(() => {
    if (!item) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [item?.id]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement | null;
      const inInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (inInput) {
          target?.blur();
        } else {
          onClose();
        }
        return;
      }
      if (inInput) return;
      if (e.key === "ArrowLeft" && safeIndex > 0) {
        e.preventDefault();
        e.stopPropagation();
        onIndexChange(safeIndex - 1);
      } else if (e.key === "ArrowRight" && safeIndex < items.length - 1) {
        e.preventDefault();
        e.stopPropagation();
        onIndexChange(safeIndex + 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [item, safeIndex, items.length, onIndexChange, onClose]);

  if (!item) return null;

  const hasPrev = safeIndex > 0;
  const hasNext = safeIndex < items.length - 1;
  const dimText = [
    item.width && item.height ? `${item.width} × ${item.height}` : null,
    formatAttachmentSize(item.byteSize),
  ]
    .filter(Boolean)
    .join(" · ");

  const commitCaption = async () => {
    if (!onUpdateCaption || savingCap) return;
    const next = captionDraft.trim();
    if (next === item.caption.trim()) return;
    setSavingCap(true);
    try {
      await onUpdateCaption(item.id, next);
    } finally {
      setSavingCap(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true);
    try {
      await onDelete(item.id);
    } finally {
      setDeleting(false);
    }
  };

  const content = (
    <div
      className="ns-att-lb-veil"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="相片預覽"
        tabIndex={-1}
        className="techo-card ns-att-lb-card"
      >
        <header className="ns-att-lb-head">
          <div className="ns-att-lb-hmeta">
            {items.length > 1 && (
              <span className="ns-att-lb-idx">
                {safeIndex + 1} / {items.length}
              </span>
            )}
            {item.sourceLabel && <span className="ns-att-lb-src">{item.sourceLabel}</span>}
          </div>
          <div className="ns-att-lb-hacts">
            {item.onJump && (
              <button
                type="button"
                className="ns-btn btn-text ns-btn--sm"
                onClick={() => {
                  onClose();
                  item.onJump?.();
                }}
              >
                {item.jumpLabel ?? "前往來源 ›"}
              </button>
            )}
            <button
              type="button"
              className="ns-iconbtn"
              aria-label="關閉相片預覽"
              title="關閉（Esc）"
              onClick={onClose}
            >
              <IconClose size={15} />
            </button>
          </div>
        </header>

        <div className="ns-att-lb-stage">
          {items.length > 1 && (
            <button
              type="button"
              className="ns-att-lb-nav is-prev"
              disabled={!hasPrev}
              aria-label="上一張"
              title="上一張（←）"
              onClick={() => hasPrev && onIndexChange(safeIndex - 1)}
            >
              <IconBack size={14} />
            </button>
          )}
          <img src={item.photoData} alt={item.caption || item.sourceLabel || "相片附件"} />
          {items.length > 1 && (
            <button
              type="button"
              className="ns-att-lb-nav is-next"
              disabled={!hasNext}
              aria-label="下一張"
              title="下一張（→）"
              onClick={() => hasNext && onIndexChange(safeIndex + 1)}
            >
              <IconChevron size={14} />
            </button>
          )}
        </div>

        <footer className="ns-att-lb-foot">
          {onUpdateCaption ? (
            <div className="ns-att-lb-caprow">
              <input
                type="text"
                className="ns-att-lb-capin"
                aria-label="相片圖說"
                placeholder="寫一句簡短圖說（選填）…"
                maxLength={MAX_ATTACHMENT_CAPTION_CHARS}
                value={captionDraft}
                disabled={savingCap}
                onChange={(e) => setCaptionDraft(e.target.value)}
                onBlur={() => void commitCaption()}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitCaption();
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
          ) : (
            item.caption && <p className="ns-att-lb-captxt">{item.caption}</p>
          )}

          {(dimText || onDelete) && (
            <div className="ns-att-lb-bot">
              <span className="ns-att-lb-dims">{dimText}</span>
              {onDelete && (
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn-danger ns-btn--sm"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                >
                  {deleting ? "移除中…" : "移除這張相片"}
                </button>
              )}
            </div>
          )}
        </footer>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
