/**
 * DialogShell——置中小 dialog 的共用殼（2.3 路線 dialog／4.0 設定共用）：書封色暗幕（.techo-veil）＋票面紙卡（.ns-card）
 * ＋標題列（燙金 overline 小標＋襯線大標＋×）＋撕線分隔（.ns-tear）；Esc／點暗幕關閉。
 * 視覺全借原型票面語彙（paper-high、1px line、3px radius、原型 box-shadow、襯線標題）；沒有任何預設灰。
 * 取捨：桌面單窗、dialog 都很小，不做完整 focus trap（Tab 走得出去）；保證 Esc 可關、點暗幕可關、進場淡入（@starting-style）。
 * 焦點（磨光⑤ #100）：紙卡 tabIndex=-1，三條規則——
 *   ① 開啟：焦點不在卡內就移到卡本身（子元件 autoFocus／自己的開場聚焦優先：子的 effect 先跑，這裡看到已在卡內就不搶）。
 *      落在卡上而不是第一顆鈕：第一顆是標題列的「×」，焦點在那裡按 Enter／Space 會直接關窗（OffPageSheetHost 檔頭同理）。
 *   ② 開著：焦點掉到 body（被點的鈕重畫／卸載、點到卡外不可聚焦處）⇒ 拉回卡上。之前掉 body 時，頁面的 window 後援
 *      （時刻表 Enter＝到着）會把鍵吃走。兩條偵測：focusout 的 relatedTarget 為空、或卡內 DOM 有增刪（Chromium 移除聚焦元素
 *      不一定發 focusout），下一拍 activeElement 是 body 才拉。視窗整個失焦時 activeElement 仍是原元素，不會誤拉。
 *   ③ 關閉：焦點還給開之前的元素——還在畫面上、而且焦點此刻落空（body）才還，不搶關窗動作自己安排的去處。
 *      例外：滑鼠點開的按鈕（開窗那一刻不是 :focus-visible）不還，維持原本「掉 body、由頁面接手」——時刻表刻意不讓焦點
 *      留在鈕上（RunDock 檔頭：留著的話面板關掉後 Enter 會再按到它，而不是到着）。
 *   API 不變；五個 host（設定、`?`、路線對話框、時刻表面板、售票口對話框）自己的開場聚焦照舊有效。
 * 高度由殼統一管（M3 ⑥ 修正席）：紙卡 `.ns-dialog` 自己吃 `max-height: calc(100% - 24px)`（% 算的是
 * 暗幕扣掉 topClass 之後的內容高），撐不下時由 `.ns-dialog-body` 內捲——分頁不必去猜標題列與頁腳的高度。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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

/**
 * 開窗那一刻的焦點、關窗時要不要還（#100 規則③）：body／沒有＝不還；滑鼠點開的按鈕（不是 :focus-visible）＝不還，
 * 照舊掉 body 由頁面接手；其餘（鍵盤停在鈕上、頁面容器、列、輸入框）＝還。
 */
function openerToRestore(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || a === document.body) return null;
  if (a.tagName === "BUTTON") {
    try {
      if (!a.matches(":focus-visible")) return null;
    } catch {
      return null; // 不認得 :focus-visible 的引擎：保守當滑鼠點的
    }
  }
  return a;
}

export function DialogShell({ title, overline, onClose, children, width = 380, topClass = "pt-[18vh]" }: DialogShellProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  // 開窗前的焦點：第一次 render 時記（commit 之後子元件的 autoFocus 已經把焦點搬進來，effect 裡再讀就晚了）
  const [opener] = useState(() => openerToRestore());

  /* 磨光⑤ #100：焦點三條規則（見檔頭） */
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    // ① 開啟
    if (!card.contains(document.activeElement)) card.focus({ preventScroll: true });
    // ② 開著：掉到 body 就拉回卡上（下一拍再看，讓重畫後的子元件先有機會自己聚焦）
    let t: ReturnType<typeof setTimeout> | undefined;
    const pullBackSoon = (): void => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!card.isConnected) return;
        const a = document.activeElement;
        if (a === null || a === document.body) card.focus({ preventScroll: true });
      }, 0);
    };
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget === null) pullBackSoon();
    };
    card.addEventListener("focusout", onFocusOut);
    const mo = new MutationObserver(() => {
      const a = document.activeElement;
      if (a === null || a === document.body) pullBackSoon();
    });
    mo.observe(card, { childList: true, subtree: true });
    return () => {
      clearTimeout(t);
      mo.disconnect();
      card.removeEventListener("focusout", onFocusOut);
      // ③ 關閉：卡已卸載，焦點若在卡內此刻已落到 body；落空才還（host 自己把焦點送去別處就不搶）
      const a = document.activeElement;
      if (opener && opener.isConnected && (a === null || a === document.body)) opener.focus({ preventScroll: true });
    };
    // 只在開窗那一刻設定（opener 在同一個 dialog 生命週期內不變）
  }, [opener]);

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
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ns-card ns-dialog max-w-[92vw] transition duration-150 ease-out starting:opacity-0 starting:translate-y-1"
        // 卡本身只是焦點的落腳處（#100），不畫聚焦框——框留給卡裡真正能操作的東西
        style={{ width, outline: "none" }}
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
