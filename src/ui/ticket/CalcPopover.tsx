/**
 * CalcPopover——售票口記一筆的小算盤浮層、手機內嵌算盤鍵盤與即時算式預覽徽章（v1.28 功能 3）。
 *
 * - 桌機 `CalcPopover`：掛在大票金額欄（`.ns-tk-bt-amt`）下方，按鈕全程 `onMouseDown preventDefault` 防止金額欄提前失焦。
 * - 手機 `MobileCalcPad`：4×5 大顆網格（`C ( ) ÷` / `7 8 9 ×` / `4 5 6 -` / `1 2 3 +` / `0 00 . =`）＋頂欄退格 `⌫` 與收起鈕。
 * - `CalcPreviewBadge`：當輸入字串含運算子（`hasCalcOperator`）時，即時顯示 `= 245` 預覽徽章；點擊徽章可直接收斂算式。
 */
import { useEffect, useRef, type MouseEvent } from "react";
import {
  commitCalcInput,
  evaluateCalcExpression,
  hasCalcOperator,
} from "../../domain/ticketCalc";

/** 計算機小圖示（14×14 線條風格，貼合私鐵手帳鋼筆線條語彙） */
export function CalcIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.25" y="1.75" width="11.5" height="12.5" rx="1.75" stroke="currentColor" strokeWidth="1.3" />
      <rect x="4.25" y="3.75" width="7.5" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5" cy="8.5" r="0.75" fill="currentColor" />
      <circle cx="8" cy="8.5" r="0.75" fill="currentColor" />
      <circle cx="11" cy="8.5" r="0.75" fill="currentColor" />
      <circle cx="5" cy="11.5" r="0.75" fill="currentColor" />
      <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
      <path d="M10.25 11.5h1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 即時計算結果預覽徽章：
 * 當 `value` 含有運算符號時顯示 `= 165`（若尚未完成或除以零則顯示提示）。
 */
export function CalcPreviewBadge({
  value,
  decimals = 2,
  allowNegative = false,
  currencyPrefix,
  onCommit,
  className,
}: {
  value: string;
  decimals?: number;
  allowNegative?: boolean;
  currencyPrefix?: string;
  onCommit?: (committed: string) => void;
  className?: string;
}) {
  if (!hasCalcOperator(value)) return null;
  const res = evaluateCalcExpression(value, decimals);
  const valid = res.ok && (allowNegative || res.value >= 0);
  const preventBlur = (e: MouseEvent) => e.preventDefault();

  if (!res.ok) {
    return (
      <span className={`ns-tk-calc-badge is-err${className ? ` ${className}` : ""}`} title={res.error}>
        {res.error}
      </span>
    );
  }
  if (!valid) {
    return (
      <span className={`ns-tk-calc-badge is-err${className ? ` ${className}` : ""}`}>
        = {res.formatted}（需大於 0）
      </span>
    );
  }

  const label = `= ${currencyPrefix ? `${currencyPrefix} ` : ""}${res.formatted}`;
  if (onCommit) {
    return (
      <button
        type="button"
        className={`ns-tk-calc-badge is-clickable${className ? ` ${className}` : ""}`}
        title="點擊套用計算結果"
        onMouseDown={preventBlur}
        onClick={() => onCommit(res.formatted)}
      >
        {label}
      </button>
    );
  }
  return <span className={`ns-tk-calc-badge${className ? ` ${className}` : ""}`}>{label}</span>;
}

/** 往算式字串追加按鍵的智慧處理（避免連續兩個二元運算子打架） */
export function appendCalcToken(current: string, token: string): string {
  const isBinaryOp = token === "+" || token === "-" || token === "×" || token === "÷" || token === "*" || token === "/";
  if (isBinaryOp && current.length > 0) {
    const last = current[current.length - 1];
    const lastIsOp = last === "+" || last === "-" || last === "×" || last === "÷" || last === "*" || last === "/";
    if (lastIsOp) {
      return current.slice(0, -1) + token;
    }
  }
  return current + token;
}

/** 桌機版浮層小算盤（掛在 `.ns-tk-bt-amt` 內） */
export function CalcPopover({
  value,
  decimals = 2,
  allowNegative = false,
  onChange,
  onClose,
}: {
  value: string;
  decimals?: number;
  allowNegative?: boolean;
  onChange: (next: string) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || popRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-calc-toggle]")) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const preventBlur = (e: MouseEvent) => e.preventDefault();
  const evalRes = hasCalcOperator(value) ? evaluateCalcExpression(value, decimals) : null;

  const press = (key: string) => {
    if (key === "C") {
      onChange("");
      return;
    }
    if (key === "⌫") {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === "=") {
      const next = commitCalcInput(value, { allowNegative, decimals });
      onChange(next);
      onClose();
      return;
    }
    onChange(appendCalcToken(value, key));
  };

  const rows: readonly (readonly string[])[] = [
    ["7", "8", "9", "÷"],
    ["4", "5", "6", "×"],
    ["1", "2", "3", "-"],
    ["0", "00", ".", "+"],
  ];

  return (
    <div
      ref={popRef}
      className="ns-tk-calc-pop"
      role="dialog"
      aria-label="小算盤"
      onMouseDown={preventBlur}
    >
      <div className="ns-tk-calc-top">
        <button type="button" className="ns-tk-calc-key is-fn" onClick={() => press("C")} title="清除全部">
          C
        </button>
        <button type="button" className="ns-tk-calc-key is-fn" onClick={() => press("(")} title="左括號">
          (
        </button>
        <button type="button" className="ns-tk-calc-key is-fn" onClick={() => press(")")} title="右括號">
          )
        </button>
        <button type="button" className="ns-tk-calc-key is-fn" onClick={() => press("⌫")} title="退格" aria-label="退格">
          ⌫
        </button>
      </div>
      <div className="ns-tk-calc-grid">
        {rows.flat().map((k) => {
          const isOp = k === "÷" || k === "×" || k === "-" || k === "+";
          return (
            <button
              key={k}
              type="button"
              className={`ns-tk-calc-key${isOp ? " is-op" : ""}`}
              onClick={() => press(k)}
            >
              {k}
            </button>
          );
        })}
      </div>
      <div className="ns-tk-calc-foot">
        <span className="ns-tk-calc-preview">
          {evalRes ? (evalRes.ok ? `= ${evalRes.formatted}` : evalRes.error) : value ? `= ${value}` : "可直打 120+45"}
        </span>
        <button type="button" className="ns-tk-calc-key is-eq" onClick={() => press("=")}>
          = 完成
        </button>
      </div>
    </div>
  );
}

/** 手機版內嵌小算盤鍵盤（4×5 網格：`C ( ) ÷` / `7 8 9 ×` / `4 5 6 -` / `1 2 3 +` / `0 00 . =`） */
export function MobileCalcPad({
  value,
  decimals = 2,
  allowNegative = false,
  onChange,
  onDone,
}: {
  value: string;
  decimals?: number;
  allowNegative?: boolean;
  onChange: (next: string) => void;
  onDone: () => void;
}) {
  const preventBlur = (e: MouseEvent) => e.preventDefault();
  const evalRes = hasCalcOperator(value) ? evaluateCalcExpression(value, decimals) : null;

  const press = (key: string) => {
    if (key === "C") {
      onChange("");
      return;
    }
    if (key === "⌫") {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === "=") {
      const next = commitCalcInput(value, { allowNegative, decimals });
      onChange(next);
      onDone();
      return;
    }
    onChange(appendCalcToken(value, key));
  };

  const keys: readonly (readonly string[])[] = [
    ["C", "(", ")", "÷"],
    ["7", "8", "9", "×"],
    ["4", "5", "6", "-"],
    ["1", "2", "3", "+"],
    ["0", "00", ".", "="],
  ];

  return (
    <div className="ns-tk-mcalc" role="group" aria-label="小算盤鍵盤" onMouseDown={preventBlur}>
      <div className="ns-tk-mcalc-bar">
        <span className="ns-tk-mcalc-expr">
          {value || "0"}
          {evalRes && (
            <b className={evalRes.ok ? "is-ok" : "is-err"}>
              {" "}
              {evalRes.ok ? `= ${evalRes.formatted}` : `（${evalRes.error}）`}
            </b>
          )}
        </span>
        <div className="ns-tk-mcalc-acts">
          <button type="button" className="ns-tk-mcalc-act" onClick={() => press("⌫")} aria-label="退格">
            ⌫
          </button>
          <button type="button" className="ns-tk-mcalc-act is-close" onClick={onDone}>
            收起
          </button>
        </div>
      </div>
      <div className="ns-tk-mcalc-grid">
        {keys.flat().map((k) => {
          const isOp = k === "÷" || k === "×" || k === "-" || k === "+";
          const isFn = k === "C" || k === "(" || k === ")";
          const isEq = k === "=";
          return (
            <button
              key={k}
              type="button"
              className={`ns-tk-mcalc-key${isOp ? " is-op" : ""}${isFn ? " is-fn" : ""}${isEq ? " is-eq" : ""}`}
              onClick={() => press(k)}
            >
              {k}
            </button>
          );
        })}
      </div>
    </div>
  );
}
