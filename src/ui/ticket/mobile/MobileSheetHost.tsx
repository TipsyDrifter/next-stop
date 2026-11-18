/**
 * MobileSheetHost——手機的對話框宿主（車次①契約 §2.3、§2.5-4；v1.32 2B-1a 管帳統合多分頁）：
 *   - `manage`（及向下相容的舊六種 kind）統一包進 `MSheet height="full"`，內掛 `<TicketManagePanel shell="mobile" />`（頂部 `<Tabs scroll>`）；
 *   - 返回層：本檔自己 `useBackLayer("ticket.dialog")`，MSheet 給同一個 `backId="ticket.dialog"`，refcount 合併成一層，返回鍵按一次即收起；
 *   - 從「管帳 › 帳戶／定期」點進 `newAccount`／`repeat` 完成或取消時，精準退回母分籤。
 */
import { isTicketManageTab, useTicketStore, type TicketDialog } from "../../../store/ticketStore";
import { useBackLayer } from "../../mobile/backStack";
import { MSheet, type MSheetHeight } from "../../common/MSheet";
import { NewAccountForm } from "../dialogs/NewAccountForm";
import { TicketManagePanel } from "../dialogs/TicketManagePanel";
import { MobileRepeatForm } from "./plan/MobileRepeatForm";
import { MobileSaveTemplateSheet } from "./MobileTemplateSheet";

const TITLE: Record<TicketDialog["kind"], string> = {
  manage: "管帳",
  newAccount: "新增帳戶",
  categories: "管帳",
  accountOrder: "管帳",
  currencies: "管帳",
  budgets: "管帳",
  repeats: "管帳",
  repeat: "定期帳",
  templates: "管帳",
  saveTemplate: "存成常用",
};

const HEIGHT: Record<Exclude<TicketDialog["kind"], "repeat">, MSheetHeight> = {
  manage: "full",
  newAccount: "auto",
  categories: "full",
  accountOrder: "full",
  currencies: "full",
  budgets: "full",
  repeats: "full",
  templates: "full",
  saveTemplate: "auto",
};

export function MobileSheetHost() {
  const dialog = useTicketStore((s) => s.dialog);
  const closeDialog = useTicketStore((s) => s.closeDialog);
  const closeAccountDialog = useTicketStore((s) => s.closeAccountDialog);
  // 全螢幕頁（記一筆／這一筆、帳戶頁）開著 ⇒ 這張 sheet 疊在它上面
  const overFull = useTicketStore((s) => s.panel.kind !== "none");
  const sheetKind = overFull ? "dialog" : "sheet";

  useBackLayer(
    "ticket.dialog",
    dialog !== null,
    () => {
      const st = useTicketStore.getState();
      if (!st.dialog) return;
      if (st.dialog.kind === "repeat") st.closeRepeatEditor();
      else if (st.dialog.kind === "newAccount") st.closeAccountDialog();
      else st.closeDialog();
    },
    dialog?.kind === "repeat" ? "full" : sheetKind,
  );
  if (!dialog) return null;

  const closeRepeat = () => useTicketStore.getState().closeRepeatEditor();
  if (dialog.kind === "repeat") return <MobileRepeatForm onDone={closeRepeat} />;
  if (dialog.kind === "saveTemplate") return <MobileSaveTemplateSheet key={dialog.entryId} entryId={dialog.entryId} backKind={sheetKind} onClose={closeDialog} />;

  const isManage = dialog.kind === "manage" || isTicketManageTab(dialog.kind);
  const manageTab = dialog.kind === "manage" ? (dialog.tab ?? "categories") : isTicketManageTab(dialog.kind) ? dialog.kind : null;
  const sheetKey = isManage ? "manage" : dialog.kind;
  const onSheetClose = dialog.kind === "newAccount" ? closeAccountDialog : closeDialog;

  return (
    <MSheet
      key={sheetKey}
      title={TITLE[dialog.kind]}
      onClose={onSheetClose}
      height={HEIGHT[dialog.kind]}
      backId="ticket.dialog"
      backKind={sheetKind}
      className={"ns-tk-msh is-dialog is-" + (isManage ? `manage is-${manageTab}` : dialog.kind)}
    >
      {isManage ? (
        <TicketManagePanel shell="mobile" onDone={closeDialog} />
      ) : (
        <NewAccountForm onDone={closeAccountDialog} />
      )}
    </MSheet>
  );
}
