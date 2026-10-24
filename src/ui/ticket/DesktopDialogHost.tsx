/**
 * DesktopDialogHost——售票口桌機的對話框宿主（車次①契約 §2.2、§2.5-4；乙席）。
 * `store.dialog` → 對應的本體（丙席的三個表單本體＋本席的 ImportCard，兩殼共用）包進 `DialogShell`：
 * 寬度檔位（UI 丙-5 E3，視覺規範 §2.4 三檔）：匯入票、定期帳清單、規則編輯器＝L 620，其餘＝M 520；
 * 眉標 `{售票口, Ticket Office}`（粉彩只畫拉丁斜體、銀河「中 — LATIN」，同 PageHeader）；標題依 `dialog.kind` 給（§2.5-4）。
 * 有「取消・主鈕」的本體（新增帳戶、規則編輯器）把按鈕列包成 `<DialogFoot>`，這裡在 DialogShell 的黏底 `foot` 放插槽接住
 * （dialogs/DialogFoot.tsx）；本體沒用 DialogFoot 時插槽是空的、整列藏起來（ticket.css 丙-5 T3 區）。即時存的管理類不給 foot。
 * 關閉（Esc／點暗幕／×／本體 onDone）一律走 `store.closeDialog()`。
 * 匯入寫入中（`imp.phase === "writing"`）不讓關：關掉只會丟掉進度畫面、寫入照跑（確定性 id 讓重跑安全，但主人會看不到結果）。
 * 規則編輯器（修正-UI）：草稿跟打開那一刻比有改過 ⇒ Esc／×／暗幕／「取消」先問一次「放棄…？」（同大票新票的 requestEscape），
 * 沒改過直接回去。
 */
import { useRef, useState } from "react";
import { useTicketStore, type TicketDialog } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { DialogShell } from "../common/DialogShell";
import { DialogFootTarget } from "./dialogs/DialogFoot";
import { NewAccountForm } from "./dialogs/NewAccountForm";
import { CategoryManager } from "./dialogs/CategoryManager";
import { AccountOrder } from "./dialogs/AccountOrder";
import { CurrencyTable } from "./dialogs/CurrencyTable";
import { ImportCard } from "./ImportCard";
import { BudgetEditor } from "./plan/BudgetEditor";
import { RepeatManager } from "./plan/RepeatManager";
import { RepeatEditor } from "./plan/RepeatEditor";

const TITLE: Record<TicketDialog["kind"], string> = {
  newAccount: "新增帳戶",
  categories: "分類管理",
  accountOrder: "帳戶順序", // 磨光⑥ 契約 §2-1；D-票-61
  currencies: "幣別與匯率",
  import: "從財務管家匯入",
  budgets: "預算", // 第③階段（③契約 §5.2、§5.3；Stage 0 甲席掛樁）
  repeats: "定期帳",
  repeat: "定期帳",
};

export function DesktopDialogHost() {
  const dialog = useTicketStore((s) => s.dialog);
  const writing = useTicketStore((s) => s.imp.phase === "writing");
  const closeDialog = useTicketStore((s) => s.closeDialog);
  const repeatDraft = useTicketStore((s) => s.repeatDraft);
  // 規則編輯器打開那一刻的草稿（dialog 物件換了＝重新打開，重拍一次）
  const base = useRef<{ dialog: TicketDialog; json: string } | null>(null);
  // 黏底按鈕列的插槽（DialogShell foot 裡的空 div）：本體的 <DialogFoot> portal 進來
  const [footSlot, setFootSlot] = useState<HTMLDivElement | null>(null);
  if (dialog?.kind === "repeat" && repeatDraft && base.current?.dialog !== dialog) base.current = { dialog, json: JSON.stringify(repeatDraft) };
  if (!dialog) return null;
  const isRepeat = dialog.kind === "repeat";
  // 規則編輯器的 Esc／×／暗幕＝「取消」：從管理頁開的回管理頁（③契約 §5.3）；改過先問
  const onClose = () => {
    if (writing) return;
    if (!isRepeat) {
      closeDialog();
      return;
    }
    const t = useTicketStore.getState();
    const dirty = t.repeatDraft !== null && base.current !== null && JSON.stringify(t.repeatDraft) !== base.current.json;
    if (!dirty) {
      t.closeRepeatEditor();
      return;
    }
    useUiStore.getState().askConfirm({
      title: dialog.kind === "repeat" && dialog.id === null ? "放棄這筆定期帳？" : "放棄這次的修改？",
      confirmLabel: "放棄",
      onConfirm: () => useTicketStore.getState().closeRepeatEditor(),
    });
  };
  const isImport = dialog.kind === "import";
  const wide = isImport || dialog.kind === "repeats" || isRepeat;
  const hasFoot = dialog.kind === "newAccount" || isRepeat;
  return (
    <DialogShell
      title={TITLE[dialog.kind]}
      overline={{ zh: "售票口", latin: "Ticket Office" }}
      onClose={onClose}
      size={wide ? "L" : "M"}
      topClass="pt-[9vh]"
      foot={hasFoot ? <div ref={setFootSlot} className="ns-tk-footslot" /> : undefined}
    >
      <DialogFootTarget value={hasFoot ? footSlot : null}>
        {dialog.kind === "newAccount" && <NewAccountForm onDone={closeDialog} />}
        {dialog.kind === "categories" && <CategoryManager onDone={closeDialog} />}
        {dialog.kind === "accountOrder" && <AccountOrder onDone={closeDialog} />}
        {dialog.kind === "currencies" && <CurrencyTable onDone={closeDialog} />}
        {isImport && <ImportCard onDone={onClose} />}
        {dialog.kind === "budgets" && <BudgetEditor onDone={closeDialog} />}
        {dialog.kind === "repeats" && <RepeatManager onDone={closeDialog} />}
        {isRepeat && <RepeatEditor onDone={onClose} />}
      </DialogFootTarget>
    </DialogShell>
  );
}
