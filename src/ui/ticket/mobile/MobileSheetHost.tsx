/**
 * MobileSheetHost——手機的對話框宿主（車次①契約 §2.3、§2.5-4）：`store.dialog` → 對應本體包進底部面板
 * （`div.m-sheet-veil.techo-veil > div.m-sheet`，沿用 mobile.css 既有骨架；portal 到 body）。匯入票也走它，排版單欄。
 * 桌機的對應件是乙席的 DesktopDialogHost（DialogShell）；本體四件兩殼共用、props 都是 `{ onDone(): void }`、自己讀 store。
 *
 * 標題由宿主依 `dialog.kind` 給（§2.5-4）。匯入寫入中不給點暗幕關（寫一半關掉＝主人以為取消了、其實還在寫）。
 */
import { useTicketStore, type TicketDialog } from "../../../store/ticketStore";
import { NewAccountForm } from "../dialogs/NewAccountForm";
import { CategoryManager } from "../dialogs/CategoryManager";
import { CurrencyTable } from "../dialogs/CurrencyTable";
import { ImportCard } from "../ImportCard";
import { MSheet } from "./mobileBits";

const TITLE: Record<TicketDialog["kind"], string> = {
  newAccount: "新增帳戶",
  categories: "分類管理",
  currencies: "幣別與匯率",
  import: "從財務管家匯入",
};

export function MobileSheetHost() {
  const dialog = useTicketStore((s) => s.dialog);
  const closeDialog = useTicketStore((s) => s.closeDialog);
  const writing = useTicketStore((s) => s.imp.phase === "writing");
  if (!dialog) return null;

  const body =
    dialog.kind === "newAccount" ? (
      <NewAccountForm onDone={closeDialog} />
    ) : dialog.kind === "categories" ? (
      <CategoryManager onDone={closeDialog} />
    ) : dialog.kind === "currencies" ? (
      <CurrencyTable onDone={closeDialog} />
    ) : (
      <ImportCard onDone={closeDialog} />
    );

  return (
    <MSheet
      title={TITLE[dialog.kind]}
      onClose={closeDialog}
      dismissable={!(dialog.kind === "import" && writing)}
      className={"is-dialog is-" + dialog.kind}
    >
      {body}
    </MSheet>
  );
}
