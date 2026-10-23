/**
 * ErrorBar——頁級錯誤列（UI 丙-2 U3；視覺規範 §2.4「頁級錯誤列」、§2.8 提示表）。
 *
 * 用途：「這一頁」載入或儲存失敗——放在內容區頂端一行，說發生什麼事、給一顆「重試」。
 *   收掉各線各寫一份的錯誤列（App 主欄的 ⚠ 列、.ns-tt-error、.ns-tk-error、.m-error、.ns-tk-mstate、.ns-tt-m-error；丙-3～6 套用）。
 * 什麼時候不用：影響整個 App 的狀態（同步錯、備份失敗、版本閘門）＝橫幅（SyncBanner）；欄位驗證＝行內提示；
 *   做完一件事的回饋＝toast。
 * 解剖（樣本 prototypes/ui-brand/index.html「提示」節 .ns-errrow）：紙材質一行＝訊息（赭 --late、--fs-ui，可換行）
 *   ＋［重試］小號次鈕（給 onRetry 才有）＋［×］圖示鈕（給 onClose 才有）。訊息不加 ⚠ 字元（顏色與位置已經說了）。
 * 狀態：重試中要顯示「重試中…」或禁用，由呼叫端換 message／不給 onRetry 處理；本元件不記狀態。
 * 位置：內容區頂、頁首之下；一次一條。兩殼同一支（字級、鈕高走 token）。
 * ARIA：外框 role="alert"（出現時讀屏立即念出）；× 的 aria-label＋title＝「關閉錯誤訊息」。
 * 鍵盤：沒有自己的鍵盤行為；「重試」「×」是一般 <button>，Tab 可達、Enter／Space 觸發。不搶焦點（alert 由讀屏念，不移焦點）。
 * 文案：一句「什麼沒有成功」（「帳簿沒有載入成功。」），不貼例外原文給使用者讀。
 */
import type { ReactNode } from "react";
import { IconClose } from "./icons";
import "./listbits.css";

export interface ErrorBarProps {
  message: ReactNode;
  /** 給了才畫「重試」次鈕 */
  onRetry?: () => void;
  /** 給了才畫 ×（收掉這一條） */
  onClose?: () => void;
  className?: string;
}

export function ErrorBar({ message, onRetry, onClose, className }: ErrorBarProps) {
  return (
    <div className={"ns-errrow" + (className ? " " + className : "")} role="alert">
      <span className="ns-errrow-msg">{message}</span>
      {onRetry && (
        <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={onRetry}>
          重試
        </button>
      )}
      {onClose && (
        <button type="button" className="ns-iconbtn" aria-label="關閉錯誤訊息" title="關閉錯誤訊息" onClick={onClose}>
          <IconClose />
        </button>
      )}
    </div>
  );
}
