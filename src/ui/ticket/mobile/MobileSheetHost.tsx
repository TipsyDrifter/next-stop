/**
 * MobileSheetHost——手機的對話框宿主（車次①契約 §2.3、§2.5-4）：`store.dialog` → 對應本體包進底部面板
 * （`div.m-sheet-veil.techo-veil > div.m-sheet`，沿用 mobile.css 既有骨架；portal 到 body）。匯入票也走它，排版單欄。
 * 桌機的對應件是乙席的 DesktopDialogHost（DialogShell）；本體四件兩殼共用、props 都是 `{ onDone(): void }`、自己讀 store。
 *
 * 標題由宿主依 `dialog.kind` 給（§2.5-4）。匯入寫入中不給點暗幕關（寫一半關掉＝主人以為取消了、其實還在寫）。
 */
import { useTicketStore, type TicketDialog } from "../../../store/ticketStore";
import { useBackLayer } from "../../mobile/backStack";
import { NewAccountForm } from "../dialogs/NewAccountForm";
import { CategoryManager } from "../dialogs/CategoryManager";
import { CurrencyTable } from "../dialogs/CurrencyTable";
import { ImportCard } from "../ImportCard";
import { MSheet } from "./mobileBits";
import { MobileBudgetSheet } from "./plan/MobileBudgetSheet";
import { MobileRepeatSheet } from "./plan/MobileRepeatSheet";
import { MobileRepeatForm } from "./plan/MobileRepeatForm";

const TITLE: Record<TicketDialog["kind"], string> = {
  newAccount: "新增帳戶",
  categories: "分類管理",
  currencies: "幣別與匯率",
  import: "從財務管家匯入",
  budgets: "預算", // 第③階段（③契約 §5.5；Stage 0 甲席掛樁）
  repeats: "定期帳",
  repeat: "定期規則",
};

export function MobileSheetHost() {
  const dialog = useTicketStore((s) => s.dialog);
  const closeDialog = useTicketStore((s) => s.closeDialog);
  const writing = useTicketStore((s) => s.imp.phase === "writing");
  // 磨光①（主線手機殼契約 §1.5）：返回鍵＝同暗幕／「取消」。匯入寫入中吞掉（同暗幕不給關）；規則表單＝closeRepeatEditor（回上一個）。
  // 規則表單是全螢幕 ⇒ "full"（從記帳表單「設成定期…」開的，疊在表單那一層上面）
  useBackLayer(
    "ticket.dialog",
    dialog !== null,
    () => {
      const st = useTicketStore.getState();
      if (!st.dialog) return;
      if (st.dialog.kind === "import" && st.imp.phase === "writing") return;
      if (st.dialog.kind === "repeat") st.closeRepeatEditor();
      else st.closeDialog();
    },
    dialog?.kind === "repeat" ? "full" : "sheet",
  );
  if (!dialog) return null;
  // 規則表單的「取消」：從管理 sheet 開的回管理 sheet、從表單「設成定期…」開的直接關（③契約 §5.3、§5.5）
  const closeRepeat = () => useTicketStore.getState().closeRepeatEditor();
  // 規則表單是全螢幕（骨架照 MobileEntryForm，自己 portal），不包底部面板
  if (dialog.kind === "repeat") return <MobileRepeatForm onDone={closeRepeat} />;

  const body =
    dialog.kind === "newAccount" ? (
      <NewAccountForm onDone={closeDialog} />
    ) : dialog.kind === "categories" ? (
      <CategoryManager onDone={closeDialog} />
    ) : dialog.kind === "currencies" ? (
      <CurrencyTable onDone={closeDialog} />
    ) : dialog.kind === "budgets" ? (
      <MobileBudgetSheet onDone={closeDialog} />
    ) : dialog.kind === "repeats" ? (
      <MobileRepeatSheet onDone={closeDialog} />
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
