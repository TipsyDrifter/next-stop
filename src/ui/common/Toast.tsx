/**
 * Toast——底部居中的小條通知（F1／F3 的 undo toast、擋下提示等；唯一來源＝uiStore.toast，壽命由 store 管）。
 * 視覺（UI 丙-1，視覺規範 §2.8）：浮層紙卡小條（.techo-card：霧面玻璃、不透字）＋墨色訊息
 *   ＋文字鈕動作（.btn-text，作用中色、hover 底線；舊的金框鈕退役）＋× 關閉；字級在 overlay.css 的 .ns-toast；
 * 進場淡入用 @starting-style，換訊息時以 key 重播。
 * 訊息最多兩行（窄幅會換行、超過才省略；#59）。w-max 必要：fixed＋left-1/2 的可用寬度只剩半個視窗，不加的話 390px 寬只有約 195px。
 * 副標 `sub`（時刻表⑤〈原型定案〉1：塗色蓋到既有紀錄時「蓋掉 2 塊、切短 2 塊——撤回會全部回來」）：主訊息下面一行小字，各自最多兩行。
 * 取捨：不做淡出（卸載即消失）——為了退場動畫多留一份 toast 狀態不划算。
 * 磨光① A1（契約 §9.3）：根元素多一個 `ns-toast` class，給手機 CSS 認（三種落點與不透明底都在 mobile.css）；
 *   UI 丙-1 起桌機也用它掛浮層的字（overlay.css `.ns-toast`，值同舊卡的內文字級）；手機的落點規則請認 `.ns-toast`／`.techo-card`。
 */
import { useUiStore } from "../../store/uiStore";
import "./overlay.css";

export function Toast() {
  const toast = useUiStore((s) => s.toast);
  const hideToast = useUiStore((s) => s.hideToast);
  if (!toast) return null;

  return (
    <div
      key={toast.message + (toast.sub ?? "")}
      role="status"
      aria-live="polite"
      className="techo-card ns-toast fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-max max-w-[min(92vw,560px)] flex items-center gap-3 pl-4 pr-1.5 py-1.5 transition duration-200 ease-out starting:opacity-0 starting:translate-y-2"
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
          className="ns-btn ns-btn--sm btn-text shrink-0"
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
