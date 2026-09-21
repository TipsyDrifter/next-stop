/**
 * ConfirmDialog——置中的小確認窗（F1 連同子項完成 2.0e／F3 子孫 ≥5 刪除確認）：title／body／取消／確認；
 * Enter 確認、Esc 取消、開啟時聚焦確認鈕。視覺＝暗幕（techo-veil）＋紙卡（techo-card）＋襯線標題；
 * 確認鈕一律朱印主鈕（btn-seal：字色 --color-on-seal，深淺主題同值——修掉暗色下字底混色），取消＝btn-ghost。唯一來源＝uiStore.confirm。
 * 取捨：自帶兩鍵 Tab 循環與焦點還原，不依賴 DialogShell（那是帶標題列與 × 的表單殼，語義不同）。
 */
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useUiStore, type ConfirmState } from "../../store/uiStore";

export function ConfirmDialog() {
  const confirm = useUiStore((s) => s.confirm);
  const closeConfirm = useUiStore((s) => s.closeConfirm);
  if (!confirm) return null;
  return <ConfirmDialogInner confirm={confirm} onClose={closeConfirm} />;
}

function ConfirmDialogInner({ confirm, onClose }: { confirm: ConfirmState; onClose: () => void }) {
  const titleId = useId();
  const bodyId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => {
      if (prev && prev.isConnected) prev.focus();
    };
  }, []);

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onClose();
  };
  const ok = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onClose();
    confirm.onConfirm();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      ok();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Tab") {
      // 兩鍵之間循環，焦點不跑出窗外
      e.preventDefault();
      e.stopPropagation();
      (document.activeElement === confirmRef.current ? cancelRef : confirmRef).current?.focus();
    }
  };

  const danger = !!confirm.danger;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center techo-veil"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={confirm.body ? bodyId : undefined}
        className="techo-card w-[380px] max-w-[92vw] px-6 pt-5 pb-4 text-ink transition duration-150 ease-out starting:opacity-0 starting:translate-y-1"
      >
        <h2 id={titleId} className={"font-display text-[16px] leading-snug tracking-[0.06em] " + (danger ? "text-late" : "text-ink")}>
          {confirm.title}
        </h2>
        {confirm.body && (
          <p id={bodyId} className="mt-2 text-[13px] leading-6 text-ink-soft">
            {confirm.body}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancel}
            className="btn-ghost px-4 py-1.5 text-[13px] rounded-[2px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-gold transition-colors"
          >
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={ok}
            className="btn-seal px-4 py-1.5 text-[13px] font-medium rounded-[2px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            {confirm.confirmLabel ?? "確認"}
          </button>
        </div>
      </div>
    </div>
  );
}
