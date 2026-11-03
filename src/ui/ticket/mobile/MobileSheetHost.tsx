/**
 * MobileSheetHost——手機的對話框宿主（車次①契約 §2.3、§2.5-4）：`store.dialog` → 對應本體包進底部面板（portal 到 body）。
 * 桌機的對應件是乙席的 DesktopDialogHost（DialogShell）；本體兩殼共用、props 都是 `{ onDone(): void }`、自己讀 store。
 *
 * 標題由宿主依 `dialog.kind` 給（§2.5-4）。
 *
 * UI 丙-5 H4（契約 §1 H4、§3.5）：殼換共用 `MSheet`（舊 mobileBits.MSheet 退役）——
 *   - 返回層：本檔自己 `useBackLayer("ticket.dialog")`（規則表單走 closeRepeatEditor），MSheet 給同一個 `backId`
 *     ⇒ refcount 合併成一層，返回鍵按一次就關；onBack 用最後登記的那一個＝本檔這行（effect 子先父後）。
 *   - 疊放：記一筆／這一筆（全螢幕表單）、帳戶頁開著時，從表單裡開的「＋ 新增帳戶／分類管理」要疊在表單上面
 *     ⇒ `backKind="dialog"`（共用 MSheet 抬到 z 47 `.is-over`；返回層權重也高過表單的 "full"）。本檔那行的 kind 跟著同一個值
 *     （backStack 以第一次登記的 kind 為準，而子元件 MSheet 先登記——兩邊寫一樣才不會跟這裡以為的不同）。
 *   - `className="ns-tk-msh is-dialog is-<kind>"`：手機單欄微調掛在這組 class 上（ticket-mobile.css「丙-5 T4」分區）。
 * 售票口④（手機席，D-票-68）：templates＝管帳「常用票種」（兩殼共用本體 dialogs/TemplateManager，同帳戶順序）；saveTemplate＝這一筆「存成常用…」
 *   （MobileSaveTemplateSheet 自己畫 MSheet，因為要黏底按鈕列；疊在全螢幕表單上＝"dialog"）。
 */
import { useTicketStore, type TicketDialog } from "../../../store/ticketStore";
import { useBackLayer } from "../../mobile/backStack";
import { MSheet, type MSheetHeight } from "../../common/MSheet";
import { NewAccountForm } from "../dialogs/NewAccountForm";
import { CategoryManager } from "../dialogs/CategoryManager";
import { AccountOrder } from "../dialogs/AccountOrder";
import { CurrencyTable } from "../dialogs/CurrencyTable";
import { MobileBudgetSheet } from "./plan/MobileBudgetSheet";
import { MobileRepeatSheet } from "./plan/MobileRepeatSheet";
import { MobileRepeatForm } from "./plan/MobileRepeatForm";
import { TemplateManager } from "../dialogs/TemplateManager";
import { MobileSaveTemplateSheet } from "./MobileTemplateSheet";

const TITLE: Record<TicketDialog["kind"], string> = {
  newAccount: "新增帳戶",
  categories: "分類管理",
  accountOrder: "帳戶順序", // 磨光⑥ 契約 §2-1；D-票-61
  currencies: "幣別與匯率",
  budgets: "預算", // 第③階段（③契約 §5.5；Stage 0 甲席掛樁）
  repeats: "定期帳",
  repeat: "定期帳",
  templates: "常用票種", // 售票口④（D-票-68）：本體＝兩殼共用的 dialogs/TemplateManager
  saveTemplate: "存成常用",
};

/** 初始高：一定很長的（分類樹）直接 90%；其餘跟內容（≤60%，可上拉到 90%；預算、定期帳常常只有幾列，給 90% 會空一大片） */
const HEIGHT: Record<Exclude<TicketDialog["kind"], "repeat">, MSheetHeight> = {
  newAccount: "auto",
  categories: "full",
  accountOrder: "auto",
  currencies: "auto",
  budgets: "auto",
  repeats: "auto",
  templates: "auto", // 售票口④（D-票-68）
  saveTemplate: "auto", // 實際由 MobileSaveTemplateSheet 自己畫（要黏底「取消｜存」），這格只為了表完整
};

export function MobileSheetHost() {
  const dialog = useTicketStore((s) => s.dialog);
  const closeDialog = useTicketStore((s) => s.closeDialog);
  // 全螢幕頁（記一筆／這一筆、帳戶頁）開著 ⇒ 這張 sheet 疊在它上面
  const overFull = useTicketStore((s) => s.panel.kind !== "none");
  const sheetKind = overFull ? "dialog" : "sheet";
  // 磨光①（主線手機殼契約 §1.5）：返回鍵＝同暗幕；規則表單＝closeRepeatEditor（回上一個）。
  // 規則表單是全螢幕 ⇒ "full"（從記帳表單「設成定期…」開的，疊在表單那一層上面）
  useBackLayer(
    "ticket.dialog",
    dialog !== null,
    () => {
      const st = useTicketStore.getState();
      if (!st.dialog) return;
      if (st.dialog.kind === "repeat") st.closeRepeatEditor();
      else st.closeDialog();
    },
    dialog?.kind === "repeat" ? "full" : sheetKind,
  );
  if (!dialog) return null;
  // 規則表單的「取消」：從管理 sheet 開的回管理 sheet、從表單「設成定期…」開的直接關（③契約 §5.3、§5.5）
  const closeRepeat = () => useTicketStore.getState().closeRepeatEditor();
  // 規則表單是全螢幕（骨架照 MobileEntryForm，自己 portal），不包底部面板
  if (dialog.kind === "repeat") return <MobileRepeatForm onDone={closeRepeat} />;
  // 售票口④「存成常用…」：要黏底「取消｜存」，自己畫 MSheet（backId 同這一層 "ticket.dialog"、kind 同宿主算的）
  if (dialog.kind === "saveTemplate") return <MobileSaveTemplateSheet key={dialog.entryId} entryId={dialog.entryId} backKind={sheetKind} onClose={closeDialog} />;

  const body =
    dialog.kind === "newAccount" ? (
      <NewAccountForm onDone={closeDialog} />
    ) : dialog.kind === "categories" ? (
      <CategoryManager onDone={closeDialog} />
    ) : dialog.kind === "accountOrder" ? (
      <AccountOrder onDone={closeDialog} />
    ) : dialog.kind === "currencies" ? (
      <CurrencyTable onDone={closeDialog} />
    ) : dialog.kind === "budgets" ? (
      <MobileBudgetSheet onDone={closeDialog} />
    ) : dialog.kind === "templates" ? (
      <TemplateManager onDone={closeDialog} />
    ) : (
      <MobileRepeatSheet onDone={closeDialog} />
    );

  return (
    <MSheet
      key={dialog.kind} // 換一種對話框＝換一張 sheet（展開狀態、焦點不帶過去）
      title={TITLE[dialog.kind]}
      onClose={closeDialog}
      height={HEIGHT[dialog.kind]}
      backId="ticket.dialog"
      backKind={sheetKind}
      className={"ns-tk-msh is-dialog is-" + dialog.kind}
    >
      {body}
    </MSheet>
  );
}
