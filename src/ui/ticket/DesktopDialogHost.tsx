/**
 * DesktopDialogHost——售票口桌機的對話框宿主（車次①契約 §2.2、§2.5-4；乙席）。
 * `store.dialog` → 對應的本體（丙席的三個表單本體＋本席的 ImportCard，兩殼共用）包進 `DialogShell`：
 * 匯入票寬 620、其餘 460；標題依 `dialog.kind` 給（§2.5-4）。關閉（Esc／點暗幕／×／本體 onDone）一律走 `store.closeDialog()`。
 * 匯入寫入中（`imp.phase === "writing"`）不讓關：關掉只會丟掉進度畫面、寫入照跑（確定性 id 讓重跑安全，但主人會看不到結果）。
 */
import { useTicketStore, type TicketDialog } from "../../store/ticketStore";
import { DialogShell } from "../common/DialogShell";
import { NewAccountForm } from "./dialogs/NewAccountForm";
import { CategoryManager } from "./dialogs/CategoryManager";
import { CurrencyTable } from "./dialogs/CurrencyTable";
import { ImportCard } from "./ImportCard";

const TITLE: Record<TicketDialog["kind"], string> = {
  newAccount: "新增帳戶",
  categories: "分類管理",
  currencies: "幣別與匯率",
  import: "從財務管家匯入",
};

export function DesktopDialogHost() {
  const dialog = useTicketStore((s) => s.dialog);
  const writing = useTicketStore((s) => s.imp.phase === "writing");
  const closeDialog = useTicketStore((s) => s.closeDialog);
  if (!dialog) return null;
  const onClose = () => {
    if (!writing) closeDialog();
  };
  const isImport = dialog.kind === "import";
  return (
    <DialogShell title={TITLE[dialog.kind]} overline="售票口 — TICKET OFFICE" onClose={onClose} width={isImport ? 620 : 460} topClass="pt-[9vh]">
      {dialog.kind === "newAccount" && <NewAccountForm onDone={closeDialog} />}
      {dialog.kind === "categories" && <CategoryManager onDone={closeDialog} />}
      {dialog.kind === "currencies" && <CurrencyTable onDone={closeDialog} />}
      {isImport && <ImportCard onDone={onClose} />}
    </DialogShell>
  );
}
