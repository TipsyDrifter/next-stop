/**
 * MFullPage——手機全螢幕頁（UI 丙-2 U4；契約 §1 #15；視覺規範 §2.4「手機全螢幕頁」、§2.3 主鈕・書封上；活樣本 ui-brand §2.4 `.ns-mfull-bar`）。
 *
 * 用途：手機上「看一張票／一條路線／一筆帳的全部欄位、邊看邊改」（＝桌機的詳情側板），以及欄位多到 sheet 撐不下的表單（新增路線、記一筆）。
 * 不用：一個小任務 → MSheet；只要一個決定 → ConfirmDialog。
 *
 * 解剖（樣式在 common/msheet.css）：
 *   .ns-mfull[role=dialog]（fixed 全螢幕、高度吃視覺視窗 --m-vvh：軟鍵盤彈出時整頁停在鍵盤上方）
 *     ├ .ns-mfull-bar   頂列＝書封色（深面不消失，法則 01）：左「取消／‹ 返回」（`left`）｜中標題（襯線）｜右主鈕（`right`）
 *     │                 主鈕＝`.ns-btn.btn-seal.on-cover`（書封上的主鈕＝反白實心，§2.3）；主鈕在頂列，軟鍵盤彈出也不被遮
 *     └ .ns-mfull-body  內容可捲（紙材質：不透明票紙）
 *   `right` 省略＝即時存的頁（沒有主鈕，§2.3），頂列右邊留空、標題仍置中。
 *
 * ARIA：`role="dialog"`＋`aria-modal`＋`aria-labelledby`→標題。左鈕若是「返回」，前面的 ‹ 是 aria-hidden 的圖示。
 * 鍵盤與焦點：開啟焦點落頁（子元件 autoFocus 優先）、掉 body 拉回、關閉還焦點（DialogShell 的焦點三規則、磨光⑤ 第 100 號，useDialogFocus）；
 *   Esc＝左鈕（取消／返回；IME 組字中不攔、別人已 preventDefault 不搶、手機殼裡只有最上面那一層吃）。
 * 返回層：kind "full"（backStack.ts 檔頭：全螢幕面板）；返回鍵＝左鈕做的事。疊在本頁上的子 sheet 要傳 `backKind="dialog"`。
 * `inline`：dev 樣本頁用——畫在父框裡、不 portal、不登記返回層、不搶焦點。
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { backStack, useBackLayer } from "../mobile/backStack";
import { useDialogFocus } from "./DialogShell";
import { IconBack } from "./icons";
import "./msheet.css";

export interface MFullPageAction {
  label: string;
  onClick: () => void;
}

export interface MFullPageProps {
  /** 頂列中間的標題（襯線） */
  title: string;
  /** 左鈕：「取消」（新增流程）或「返回」（看詳情；`back` 為真時前面畫 ‹） */
  left: MFullPageAction & { back?: boolean };
  /** 右側主鈕（`.btn-seal.on-cover`）；即時存的頁省略 */
  right?: MFullPageAction & { disabled?: boolean; title?: string };
  children?: ReactNode;
  /** 返回層 id（預設自動產生） */
  backId?: string;
  /** dev 樣本頁用：畫在父框裡、不 portal、不登記返回層、不搶焦點 */
  inline?: boolean;
}

export function MFullPage({ title, left, right, children, backId, inline = false }: MFullPageProps) {
  const autoId = useId();
  const layerId = backId ?? `common.mfull${autoId}`;
  const titleId = `${autoId}-title`;
  const pageRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef(left.onClick);
  leftRef.current = left.onClick;

  // 返回鍵＝左鈕（只在手機殼生效；inline 樣本不登記）
  useBackLayer(layerId, !inline, () => leftRef.current(), "full");
  useDialogFocus(pageRef, !inline);

  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      const top = backStack.top();
      if (top && top.id !== layerId && document.documentElement.dataset.shell === "mobile") return;
      e.preventDefault();
      leftRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline, layerId]);

  const page = (
    <div
      ref={pageRef}
      role="dialog"
      aria-modal={inline ? undefined : true}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={"ns-mfull" + (inline ? " is-inline" : "")}
    >
      <div className="ns-mfull-bar">
        <button type="button" className="ns-mfull-left" onClick={() => leftRef.current()}>
          {left.back && <IconBack size={16} />}
          {left.label}
        </button>
        <h2 id={titleId} className="ns-mfull-title">
          {title}
        </h2>
        {right ? (
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-seal on-cover ns-mfull-right"
            onClick={right.onClick}
            disabled={right.disabled}
            title={right.title}
          >
            {right.label}
          </button>
        ) : (
          <span className="ns-mfull-right" aria-hidden="true" />
        )}
      </div>
      <div className="ns-mfull-body">{children}</div>
    </div>
  );

  if (inline || typeof document === "undefined") return page;
  return createPortal(page, document.body);
}
