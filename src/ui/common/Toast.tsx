/**
 * Toast——底部居中的小條通知（F1／F3 的 undo toast、擋下提示等；唯一來源＝uiStore.toast，TTL 10 秒由 store 管）。
 * 視覺：票面紙卡小條（.ns-card：paper-high、1px line、3px radius、原型陰影）＋墨色訊息＋金邊動作鈕（.btn-gold）＋× 關閉；
 * 進場淡入用 @starting-style，換訊息時以 key 重播。
 * 訊息最多兩行（窄幅會換行、超過才省略；#59）。w-max 必要：fixed＋left-1/2 的可用寬度只剩半個視窗，不加的話 390px 寬只有約 195px。
 * 副標 `sub`（時刻表⑤〈原型定案〉1：塗色蓋到既有紀錄時「蓋掉 2 塊、切短 2 塊——撤回會全部回來」）：主訊息下面一行小字，各自最多兩行。
 * 取捨：不做淡出（卸載即消失）——為了退場動畫多留一份 toast 狀態不划算。
 * 磨光① A1（契約 §9.3）：根元素多一個 `ns-toast` class，給手機 CSS 認（三種落點與不透明底都在 mobile.css）；
 *   沒有任何桌機規則選它，桌機外觀不變。
 */
import { useUiStore } from "../../store/uiStore";
import "./overlay.css";

// ToastState 的副標欄：uiStore.ts 是集中檔、這一輪不動，先在顯示端用 module augmentation 補上（選填，舊呼叫端不受影響）；
// 之後有人動 uiStore 時把這一欄搬進 ToastState 本體、刪掉這段。
declare module "../../store/uiStore" {
  interface ToastState {
    /** 第二行小字（墨色淡一階）；沒有＝只有一行主訊息 */
    sub?: string;
  }
}

export function Toast() {
  const toast = useUiStore((s) => s.toast);
  const hideToast = useUiStore((s) => s.hideToast);
  if (!toast) return null;

  return (
    <div
      key={toast.message + (toast.sub ?? "")}
      role="status"
      aria-live="polite"
      className="ns-card ns-toast fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-max max-w-[min(92vw,560px)] flex items-center gap-3 pl-4 pr-1.5 py-1.5 text-[13px] tracking-[0.03em] transition duration-200 ease-out starting:opacity-0 starting:translate-y-2"
    >
      {toast.sub ? (
        <span className="min-w-0 flex flex-col gap-0.5 py-0.5">
          <span className="break-words line-clamp-2">{toast.message}</span>
          <span className="break-words line-clamp-2 text-[11.5px] leading-snug tracking-[0.02em] text-ink-soft">{toast.sub}</span>
        </span>
      ) : (
        <span className="min-w-0 break-words line-clamp-2">{toast.message}</span>
      )}
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
