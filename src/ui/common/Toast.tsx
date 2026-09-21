/**
 * Toast——底部居中的小條通知（F1／F3 的 undo toast、擋下提示等；唯一來源＝uiStore.toast，TTL 10 秒由 store 管）。
 * 視覺：票面紙卡小條（.ns-card：paper-high、1px line、3px radius、原型陰影）＋墨色訊息＋金邊動作鈕（.btn-gold）＋× 關閉；
 * 進場淡入用 @starting-style，換訊息時以 key 重播。
 * 取捨：不做淡出（卸載即消失）——為了退場動畫多留一份 toast 狀態不划算。
 */
import { useUiStore } from "../../store/uiStore";
import "./overlay.css";

export function Toast() {
  const toast = useUiStore((s) => s.toast);
  const hideToast = useUiStore((s) => s.hideToast);
  if (!toast) return null;

  return (
    <div
      key={toast.message}
      role="status"
      aria-live="polite"
      className="ns-card fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[min(92vw,560px)] flex items-center gap-3 pl-4 pr-1.5 py-1.5 text-[13px] tracking-[0.03em] transition duration-200 ease-out starting:opacity-0 starting:translate-y-2"
    >
      <span className="min-w-0 truncate">{toast.message}</span>
      {toast.actionLabel && (
        <button
          type="button"
          onClick={() => {
            toast.onAction?.();
            hideToast();
          }}
          className="btn-gold ns-btn ns-btn--sm shrink-0"
        >
          {toast.actionLabel}
        </button>
      )}
      <button type="button" onClick={hideToast} aria-label="關閉通知" className="ns-close ns-close--sm shrink-0">
        ×
      </button>
    </div>
  );
}
