/**
 * DialogFoot——售票口對話框本體的按鈕列（取消・主鈕）放哪（UI 丙-5 E3）。
 *
 * 桌機：DesktopDialogHost 在 DialogShell 的 `foot`（黏底，排在內捲的本文之外）放一個空插槽 `.ns-tk-footslot`，
 *   用 `DialogFootTarget` 把它交給本體；本體把按鈕列包成 `<DialogFoot>` 就會 portal 進去——本文怎麼捲按鈕列都在卡底。
 * 手機（MobileSheetHost 沒給插槽）與任何沒給插槽的地方：照舊畫成本文裡的 `div.ns-tk-dfoot`（兩殼共用的本體不用分支）。
 * 為什麼用 portal 不是把按鈕列交給宿主：按鈕的狀態（busy、欄位空不空）在本體裡，宿主拿不到；portal 只搬 DOM，
 *   React 事件與 state 照舊在本體。按鈕在 <form> 外面時，送出鈕要帶 `form={表單 id}`（HTML form 屬性）。
 */
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FootSlot = createContext<HTMLElement | null>(null);

/** 宿主用：把 DialogShell foot 裡的插槽元素交給本體 */
export const DialogFootTarget = FootSlot.Provider;

export function DialogFoot({ children }: { children: ReactNode }) {
  const slot = useContext(FootSlot);
  if (slot) return createPortal(children, slot);
  return <div className="ns-tk-dfoot">{children}</div>;
}
