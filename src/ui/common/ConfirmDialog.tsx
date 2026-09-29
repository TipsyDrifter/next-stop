/**
 * ConfirmDialog——置中的小確認窗（F1 連同子項完成 2.0e／F3 子孫 ≥5 刪除確認）：title／body／取消／確認；
 * Enter 確認、Esc 取消、開啟時聚焦確認鈕。視覺＝暗幕（techo-veil）＋紙卡（techo-card）＋襯線標題；
 * 確認鈕一律朱印主鈕（btn-seal：字色 --color-on-seal，深淺主題同值——修掉暗色下字底混色），取消＝btn-ghost。唯一來源＝uiStore.confirm。
 * 取捨：自帶兩鍵 Tab 循環與焦點還原，不依賴 DialogShell（那是帶標題列與 × 的表單殼，語義不同）。
 *
 * v1.1.6（重新開始契約 §5；拍板〈回饋兩題拍板〉三層保護的第二層＝打字確認）：`confirm.typeToConfirm` 有值時，
 * body 下方多一格底線輸入（`techo-input`），主人逐字打出那個詞（危險區＝「清空」）確認鈕才亮：
 *   * 開窗焦點在**輸入框**（不是確認鈕——焦點在確認鈕上，一個 Enter 就把整台清掉了，打字那一層等於沒有）；
 *   * 相符＝`value.trim() === typeToConfirm`：全形／半形、大小寫一概不轉（「清空」兩個字沒有這個問題，多轉只是多一條漏洞）；
 *   * Enter 在不相符時什麼都不做（不確認、也不關窗——關窗會讓人以為按到了）；Esc 照舊取消；
 *   * Tab 在「輸入框 → 取消 → 確認」三件之間循環（確認鈕 disabled 時跳過它），Shift+Tab 反向；
 *   * 手機殼 16px（overlay.css `.ns-confirm-type`；Android WebView 聚焦時不放大整頁的門檻）。
 * 沒帶 `typeToConfirm` 的確認窗：下面 `typing` 為 false 的每一條分支都與 v1.1.5 逐字相同（焦點、Enter、兩鍵 Tab、class）。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
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
  const typeId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  const word = confirm.typeToConfirm;
  const typing = !!word;
  const [typed, setTyped] = useState("");
  const matched = !typing || typed.trim() === word;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (typing ? inputRef : confirmRef).current?.focus();
    return () => {
      if (prev && prev.isConnected) prev.focus();
    };
    // 只在開窗那一刻決定焦點（typing 在同一個確認窗的生命週期內不會變）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onClose();
  };
  const ok = () => {
    if (doneRef.current) return;
    if (!matched) return; // 打字確認還沒相符：鈕是 disabled 的，這裡是 Enter 的第二道
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
      e.preventDefault();
      e.stopPropagation();
      if (!typing) {
        // 兩鍵之間循環，焦點不跑出窗外
        (document.activeElement === confirmRef.current ? cancelRef : confirmRef).current?.focus();
        return;
      }
      // 打字確認：輸入框 → 取消 → 確認（disabled 時跳過）三件循環
      const ring = [inputRef.current, cancelRef.current, matched ? confirmRef.current : null].filter(
        (el): el is HTMLInputElement | HTMLButtonElement => !!el,
      );
      const at = ring.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
      const next = at < 0 ? 0 : (at + (e.shiftKey ? ring.length - 1 : 1)) % ring.length;
      ring[next]?.focus();
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
        {typing && (
          <div className="ns-confirm-type">
            <label htmlFor={typeId} className="ns-note ns-confirm-type-hint">
              {confirm.typeHint ?? `輸入「${word}」才能按下去`}
            </label>
            <input
              ref={inputRef}
              id={typeId}
              className="techo-input ns-confirm-type-input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed.trim() !== "" && !matched}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
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
            disabled={!matched}
            className={
              "btn-seal px-4 py-1.5 text-[13px] font-medium rounded-[2px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-gold" +
              (typing ? " ns-confirm-type-ok" : "")
            }
          >
            {confirm.confirmLabel ?? "確認"}
          </button>
        </div>
      </div>
    </div>
  );
}
