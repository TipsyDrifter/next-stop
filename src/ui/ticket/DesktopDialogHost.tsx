/**
 * DesktopDialogHost——售票口桌機的對話框宿主（車次①契約 §2.2、§2.5-4；v1.32 2B-1a 管帳統合多分頁）。
 * `store.dialog` → 對應的本體包進 `DialogShell`：
 *   - `manage`（及向下相容的舊六種 kind）統一渲染 `<TicketManagePanel shell="desktop" />`（標題「管帳」，`size="L"` 舒適容納各籤）；
 *   - 獨立表單型彈窗 `newAccount`、`repeat`、`saveTemplate` 維持獨立流程（從「管帳 › 帳戶／定期」點進時，完成或取消後精準退回母分籤）。
 */
import { useRef, useState } from "react";
import { isTicketManageTab, useTicketStore, type TicketDialog } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { DialogShell } from "../common/DialogShell";
import { DialogFootTarget } from "./dialogs/DialogFoot";
import { NewAccountForm } from "./dialogs/NewAccountForm";
import { TicketManagePanel } from "./dialogs/TicketManagePanel";
import { RepeatEditor } from "./plan/RepeatEditor";
import { SaveTemplateDialog } from "./dialogs/SaveTemplate";
import { LegacySplitBody } from "./dialogs/LegacySplitModal";

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
  legacySplit: "舊帳隨筆分流小幫手",
};

export function DesktopDialogHost() {
  const dialog = useTicketStore((s) => s.dialog);
  const closeDialog = useTicketStore((s) => s.closeDialog);
  const closeAccountDialog = useTicketStore((s) => s.closeAccountDialog);
  const repeatDraft = useTicketStore((s) => s.repeatDraft);
  // 規則編輯器打開那一刻的草稿（dialog 物件換了＝重新打開，重拍一次）
  const base = useRef<{ dialog: TicketDialog; json: string } | null>(null);
  // 黏底按鈕列的插槽（DialogShell foot 裡的空 div）：本體的 <DialogFoot> portal 進來
  const [footSlot, setFootSlot] = useState<HTMLDivElement | null>(null);
  if (dialog?.kind === "repeat" && repeatDraft && base.current?.dialog !== dialog) base.current = { dialog, json: JSON.stringify(repeatDraft) };
  if (!dialog) return null;
  const isManage = dialog.kind === "manage" || isTicketManageTab(dialog.kind);
  const isRepeat = dialog.kind === "repeat";
  const isNewAccount = dialog.kind === "newAccount";
  const isLegacySplit = dialog.kind === "legacySplit";
  // 規則編輯器與新增帳戶的 Esc／×／暗幕＝「取消」：從「管帳」開的退回原分籤
  const onClose = () => {
    if (isNewAccount) {
      closeAccountDialog();
      return;
    }
    if (!isRepeat) {
      closeDialog();
      return;
    }
    const t = useTicketStore.getState();
    const tags = t.repeatTags;
    const dirty =
      (t.repeatDraft !== null && base.current !== null && JSON.stringify(t.repeatDraft) !== base.current.json) ||
      (tags !== null && JSON.stringify(tags.names) !== JSON.stringify(tags.orig));
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
  const wide = isManage || isRepeat || isLegacySplit;
  const hasFoot = isNewAccount || isRepeat || isLegacySplit;
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
        {isManage && <TicketManagePanel shell="desktop" onDone={closeDialog} />}
        {isNewAccount && <NewAccountForm onDone={closeAccountDialog} />}
        {isRepeat && <RepeatEditor onDone={onClose} />}
        {dialog.kind === "saveTemplate" && <SaveTemplateDialog onDone={closeDialog} />}
        {isLegacySplit && <LegacySplitBody onClose={closeDialog} />}
      </DialogFootTarget>
    </DialogShell>
  );
}
