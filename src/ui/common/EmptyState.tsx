/**
 * EmptyState——空狀態（UI 丙-2 U3；視覺規範 §2.7、§2.3 按鈕層級、§1.8 載入）。
 *
 * 用途：一個清單、一頁、一個區段「沒有東西可列」時，告訴使用者現在是哪一種空、下一步怎麼做。
 *   三種語氣（tone）：
 *     first ＝第一次空：教第一步——給一顆次鈕（action）當第一步，必要時加一顆文字鈕（secondary）。
 *     done  ＝全部完成：慶祝——通常不給鈕；印章放「済」。
 *     nores ＝搜尋無結果：中性＋換個字——常見只給文字鈕「清除搜尋」；沒給 stamp 時預設畫虛線圓＋放大鏡。
 * 什麼時候不用：載入中（§1.8：資料未到的 200ms 內不畫空狀態，畫骨架或空白——由呼叫端判斷「已載入且為空」才掛本元件）；
 *   錯誤（用 ErrorBar）；一次性說明（頁內資訊卡）。
 *
 * 解剖（樣本 prototypes/ui-brand/index.html「空狀態」節：.ns-empty／.ns-empty-row）：
 *   頁級（預設）＝置中直排：［印章輪廓（可省）］→ 標題（襯線 --fs-h3）→ 一句說明（最多兩行）→［次鈕］［文字鈕］直排。
 *   區段級（inline）＝卡內一行：標題那句＋說明（可省）＋文字鈕（action／secondary 都畫成小號文字鈕）。
 * 層級：第一步一律是次鈕 .btn-ghost（§2.3「空狀態第一步＝次鈕」，不是主鈕、不是燙金字連結）；第二行動是文字鈕 .btn-text。
 * 位置：頁級放內容區中央（本元件 margin-inline:auto、max-width 300；垂直置中由版面容器決定）；區段級放卡內。
 *   **空狀態出現時，同頁上方的「＋ 新增」要隱藏**（同一動作同頁一個入口）——那是呼叫端的事，本元件管不到。
 * 桌機↔手機：同一支；字級、鈕高走 token（[data-shell="mobile"] 整組換）。
 * ARIA：tone="nores" 的外框帶 role="status"（搜尋結果換成「找不到」時讀屏會念出來）；其他語氣是靜態內容、不帶 live region。
 *   印章／記號一律 aria-hidden（插畫）。標題用一般段落（不猜 heading 層級，免得頁面大綱亂掉）。
 * 鍵盤：沒有自己的鍵盤行為；兩顆鈕是一般 <button>，Tab 依序可達、Enter／Space 觸發。
 * 文案：標題寫狀態（「今天還沒有列車」），說明寫做法（「寫下第一張車票，按 Enter 就発券。」），鈕是動詞 2～4 字。
 */
import type { ReactNode } from "react";
import { IconSearch } from "./icons";
import "./listbits.css";

export type EmptyTone = "first" | "done" | "nores";

export interface EmptyAction {
  label: string;
  onClick: () => void;
  /** 字前的小圖示（例：<IconPlus />）；可省 */
  icon?: ReactNode;
}

export interface EmptyStateProps {
  tone: EmptyTone;
  /** 印章輪廓（例：検印框、済章）；不給時 nores 畫預設的虛線圓＋放大鏡，其他語氣不畫；給 null 一律不畫 */
  stamp?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  /** 第一步（次鈕 .btn-ghost；inline 時畫成小號文字鈕） */
  action?: EmptyAction;
  /** 第二行動（文字鈕 .btn-text） */
  secondary?: EmptyAction;
  /** 區段級：卡內一行＋文字鈕 */
  inline?: boolean;
  className?: string;
}

function ActionLabel({ a }: { a: EmptyAction }) {
  return (
    <>
      {a.icon}
      {a.label}
    </>
  );
}

export function EmptyState({ tone, stamp, title, desc, action, secondary, inline, className }: EmptyStateProps) {
  const live = tone === "nores" ? { role: "status" as const } : {};

  if (inline) {
    return (
      <div className={"ns-empty-row is-" + tone + (className ? " " + className : "")} {...live}>
        <span className="ns-empty-line">{title}</span>
        {desc && <span className="ns-empty-desc">{desc}</span>}
        {action && (
          <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={action.onClick}>
            <ActionLabel a={action} />
          </button>
        )}
        {secondary && (
          <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={secondary.onClick}>
            <ActionLabel a={secondary} />
          </button>
        )}
      </div>
    );
  }

  const mark =
    stamp !== undefined ? stamp : tone === "nores" ? (
      <span className="ns-empty-search">
        <IconSearch />
      </span>
    ) : null;

  return (
    <div className={"ns-empty is-" + tone + (className ? " " + className : "")} {...live}>
      {mark && (
        <div className="ns-empty-mark" aria-hidden="true">
          {mark}
        </div>
      )}
      <p className="ns-empty-title">{title}</p>
      {desc && <p className="ns-empty-desc">{desc}</p>}
      {(action || secondary) && (
        <div className="ns-empty-acts">
          {action && (
            <button type="button" className="ns-btn btn-ghost" onClick={action.onClick}>
              <ActionLabel a={action} />
            </button>
          )}
          {secondary && (
            <button type="button" className="ns-btn btn-text" onClick={secondary.onClick}>
              <ActionLabel a={secondary} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
