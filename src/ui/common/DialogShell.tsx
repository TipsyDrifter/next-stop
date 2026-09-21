/**
 * DialogShell——置中小 dialog 的共用殼（2.3 路線 dialog／4.0 設定共用）：書封色暗幕（.techo-veil）＋票面紙卡（.ns-card）
 * ＋標題列（燙金 overline 小標＋襯線大標＋×）＋撕線分隔（.ns-tear）；Esc／點暗幕關閉。
 * 視覺全借原型票面語彙（paper-high、1px line、3px radius、原型 box-shadow、襯線標題）；沒有任何預設灰。
 * 取捨：桌面單窗、dialog 都很小，不做完整 focus trap；只保證 Esc 可關、點暗幕可關、進場淡入（@starting-style）。
 * 高度由殼統一管（M3 ⑥ 修正席）：紙卡 `.ns-dialog` 自己吃 `max-height: calc(100% - 24px)`（% 算的是
 * 暗幕扣掉 topClass 之後的內容高），撐不下時由 `.ns-dialog-body` 內捲——分頁不必去猜標題列與頁腳的高度。
 */
import { useEffect, useId, type ReactNode } from "react";
import "./overlay.css";

interface DialogShellProps {
  title: string;
  /** 標題上方的燙金小標（如「設定 — SETTINGS」）；省略則不顯示 */
  overline?: string;
  onClose: () => void;
  children: ReactNode;
  /** 卡片寬（px） */
  width?: number;
  /** 置頂距離，預設 18vh */
  topClass?: string;
}

export function DialogShell({ title, overline, onClose, children, width = 380, topClass = "pt-[18vh]" }: DialogShellProps) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={`techo-veil fixed inset-0 z-40 flex items-start justify-center ${topClass}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ns-card ns-dialog max-w-[92vw] transition duration-150 ease-out starting:opacity-0 starting:translate-y-1"
        style={{ width }}
      >
        <div className="ns-tear flex items-start justify-between gap-3 px-6 pt-5 pb-3.5">
          <div className="min-w-0">
            {overline && <p className="techo-overline mb-1.5">{overline}</p>}
            <h2 id={titleId} className="techo-title text-[19px] truncate">
              {title}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="關閉" className="ns-close -mr-2 -mt-1 shrink-0">
            ×
          </button>
        </div>
        <div className="ns-dialog-body px-6 pt-4 pb-5">{children}</div>
      </div>
    </div>
  );
}
