/**
 * TicketLockGate——售票口 v1.33 3B G5「4 位數帳本密碼鎖驗證畫面 ＆ 解除隱私遮罩驗證窗」（雙端共用）。
 *
 * - 支援實體數字鍵盤直敲（0–9、全形數字、Backspace）與觸控點按（>=44px），滿 4 碼自動核驗。
 * - 視覺嚴守 v2.3：語意層 CSS Tokens、卡片圓角 `--radius-card`、控制項圓角 `--radius-ctl`，沉穩手帳紙感。
 * - 手機解除遮罩抽屜走共用 `MSheet`（內建 `useBackLayer`），桌機走共用 `DialogShell`。
 */
import { useCallback, useEffect, useState } from "react";
import { PIN_LENGTH, normalizePinDigits } from "../../../domain/ticketLock";
import { TK_TEXT, useTicketStore, type TicketShell } from "../../../store/ticketStore";
import { DialogShell } from "../../common/DialogShell";
import { MSheet } from "../../common/MSheet";

/* ───────── 共用 1.3px 幾何細線圖示（眼睛遮罩 ／ 帳本鎖） ───────── */

export function IconEyeOpen({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8Z" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  );
}

export function IconEyeMasked({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.2 2.2 13.8 13.8" />
      <path d="M6.6 3.8A6.5 6.5 0 0 1 8 3.6c4 0 6.4 4.4 6.4 4.4a11.4 11.4 0 0 1-2.1 2.7" />
      <path d="M9.9 11.9A6.2 6.2 0 0 1 8 12.4C4 12.4 1.6 8 1.6 8a11.5 11.5 0 0 1 2.6-3.1" />
    </svg>
  );
}

export function IconPadlock({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.2" y="7.2" width="9.6" height="6.8" rx="1.4" />
      <path d="M5.2 7.2V5.1a2.8 2.8 0 0 1 5.6 0v2.1" />
      <circle cx="8" cy="10.6" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* ───────── 4 碼輸入盤（鍵盤直敲 ＋ 觸控數字鍵） ───────── */

export interface PinKeypadProps {
  hint?: string;
  listenKeyboard?: boolean;
  onSubmit(pin: string): boolean | Promise<boolean>;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function PinKeypad({ hint, listenKeyboard = true, onSubmit }: PinKeypadProps) {
  const [digits, setDigits] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tryCommit = useCallback(
    async (next: string) => {
      if (next.length < PIN_LENGTH || busy) return;
      setBusy(true);
      try {
        const ok = await onSubmit(next);
        if (!ok) {
          setErr(TK_TEXT.pinWrong);
          setDigits("");
        } else {
          setErr(null);
          setDigits("");
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, onSubmit],
  );

  const pushDigit = useCallback(
    (d: string) => {
      if (busy) return;
      const clean = normalizePinDigits(d);
      if (!clean) return;
      setErr(null);
      setDigits((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        const next = (prev + clean).slice(0, PIN_LENGTH);
        if (next.length === PIN_LENGTH) {
          setTimeout(() => void tryCommit(next), 0);
        }
        return next;
      });
    },
    [busy, tryCommit],
  );

  const backspace = useCallback(() => {
    if (busy) return;
    setErr(null);
    setDigits((prev) => prev.slice(0, -1));
  }, [busy]);

  const clearAll = useCallback(() => {
    if (busy) return;
    setErr(null);
    setDigits("");
  }, [busy]);

  useEffect(() => {
    if (!listenKeyboard) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest("input, textarea, select, [contenteditable]")) return;
      const mapped = normalizePinDigits(e.key);
      if (mapped.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        pushDigit(mapped);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        backspace();
      } else if (e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();
        clearAll();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listenKeyboard, pushDigit, backspace, clearAll]);

  return (
    <div className="ns-tk-pin" role="group" aria-label="4 位數帳本密碼輸入">
      {hint && <p className="ns-tk-pin-hint">{hint}</p>}
      <div className={"ns-tk-pin-slots" + (err ? " is-error" : "")} aria-label={`已輸入 ${digits.length} 位，共 ${PIN_LENGTH} 位`}>
        {[0, 1, 2, 3].map((idx) => {
          const filled = idx < digits.length;
          const active = idx === digits.length && !busy;
          return (
            <span
              key={idx}
              className={"ns-tk-pin-slot" + (filled ? " is-filled" : "") + (active ? " is-active" : "")}
              aria-hidden="true"
            >
              {filled ? "●" : ""}
            </span>
          );
        })}
      </div>
      <p className={"ns-tk-pin-msg" + (err ? " is-error" : "")} role={err ? "alert" : undefined}>
        {err ?? "可直接敲擊數字鍵盤或點按下方數字"}
      </p>
      <div className="ns-tk-pin-grid">
        {DIGITS.map((d) => (
          <button key={d} type="button" className="ns-tk-pin-key" disabled={busy} onClick={() => pushDigit(d)}>
            {d}
          </button>
        ))}
        <button
          type="button"
          className="ns-tk-pin-key is-aux"
          disabled={busy || digits.length === 0}
          aria-label="清除全部"
          onClick={clearAll}
        >
          清除
        </button>
        <button type="button" className="ns-tk-pin-key" disabled={busy} onClick={() => pushDigit("0")}>
          0
        </button>
        <button
          type="button"
          className="ns-tk-pin-key is-aux"
          disabled={busy || digits.length === 0}
          aria-label="倒退一碼"
          onClick={backspace}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}

/* ───────── 整頁帳本鎖定畫面（桌機 TicketView ＆ 手機 MobileTicketOffice 共用） ───────── */

export function TicketLockGate() {
  const unlockWithPin = useTicketStore((s) => s.unlockWithPin);
  return (
    <section className="ns-tk-lockgate" aria-label="售票口帳本已鎖定">
      <div className="ns-tk-lockcard techo-card">
        <span className="ns-tk-lock-eyebrow">TICKET OFFICE · 售票口</span>
        <div className="ns-tk-lock-badge" aria-hidden="true">
          <IconPadlock size={22} />
        </div>
        <h2 className="ns-tk-lock-title">帳本已鎖定</h2>
        <PinKeypad hint="請輸入 4 位數密碼，驗證通過後於本次執行期保持解鎖" onSubmit={(pin) => unlockWithPin(pin)} />
      </div>
    </section>
  );
}

/* ───────── 嘗試解除隱私遮罩時的 4 碼驗證窗 ───────── */

export function TicketUnmaskPrompt({ shell }: { shell: TicketShell }) {
  const open = useTicketStore((s) => s.unmaskPromptOpen);
  const close = useTicketStore((s) => s.closeUnmaskPrompt);
  const unlockWithPin = useTicketStore((s) => s.unlockWithPin);

  if (!open) return null;

  if (shell === "mobile") {
    return (
      <MSheet
        title="解除金額隱私遮罩"
        backId="ticket.unmask.pin"
        backKind="dialog"
        onClose={close}
        className="ns-tk-msh"
      >
        <div className="ns-tk-unmask-body">
          <PinKeypad hint="已啟用帳本密碼鎖，請輸入 4 位數密碼以顯示真實金額" onSubmit={(pin) => unlockWithPin(pin)} />
        </div>
      </MSheet>
    );
  }

  return (
    <DialogShell
      title="解除金額隱私遮罩"
      overline={{ zh: "售票口", latin: "Ticket Office" }}
      size="S"
      onClose={close}
    >
      <div className="ns-tk-unmask-body">
        <PinKeypad hint="已啟用帳本密碼鎖，請輸入 4 位數密碼以顯示真實金額" onSubmit={(pin) => unlockWithPin(pin)} />
      </div>
    </DialogShell>
  );
}
