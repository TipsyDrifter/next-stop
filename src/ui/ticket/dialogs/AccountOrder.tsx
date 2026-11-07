/**
 * AccountOrder——「帳戶順序」對話框本體（磨光⑥ 契約 §2-1；D-票-61；兩殼共用）。
 * props `{ onDone(): void }`；自己讀 store。標題由 host 依 `store.dialog.kind` 給（桌機 DesktopDialogHost、手機 MobileSheetHost）。
 *
 * 長相與寫法照 TemplateManager（共用 ManagerList／ManagerRow）：依群組分區（`groupAccounts`：群組序固定＝ACCOUNT_GROUPS，只列未封存帳戶），
 * 每組一張 ManagerList；這個框只管順序，列上只有名稱（純文字，不改名）＋⋯。⋯ 裡「上移 Alt+↑／下移 Alt+↓」由 ManagerRow 排
 * （群組頭尾那一格停用並說明；手機開 MSheet），呼叫 `moveAccountTo(id, i±1)`（同群組換位、走同步）。
 * 群組之間的順序不能改，只在群組內排。
 * 售票口④（契約 §5）：每個群組一份共用拖曳（common/dragReorder），放開對最新清單換算 indexOfAnchor → `moveAccountTo`
 * （整組寫）；拖不出群組（每組各自一份清單）。⋯ 與 Alt+↑↓ 是鍵盤與讀屏的入口，拖曳是加速。
 */
import { useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { groupAccounts, type AccountRow } from "../../../domain/ticket";
import { ManagerList, ManagerRow } from "../../common/ManagerRow";
import { indexOfAnchor, useDragReorder } from "../../common/dragReorder";
import { acctLabel } from "../TicketLedger";

// 即時存（moveAccountTo 按一下就寫）⇒ 沒有「完成」鈕：關閉走 DialogShell 的 ×／暗幕／Esc、手機 sheet 的暗幕／返回鍵（UI 丙-1，視覺規範 §6）。
// onDone 仍是兩個宿主共用的 props 介面，本體不再呼叫。
export function AccountOrder(_props: { onDone(): void }) {
  const accounts = useTicketStore((s) => s.accounts);
  const groups = groupAccounts(accounts);

  return (
    <div className="ns-tk-dialog ns-tk-dorder">
      {groups.length === 0 ? (
        <p className="ns-tk-dhint">還沒有帳戶</p>
      ) : (
        groups.map(({ group, accounts: list }) => (
          <section key={group.key} className="ns-tk-dorder-grp" aria-label={group.label}>
            <h3 className="lbl">{group.label}</h3>
            <GroupList groupKey={group.key} groupLabel={group.label} list={list} accounts={accounts} />
          </section>
        ))
      )}
    </div>
  );
}

/* ───────── 一個群組的清單（各自一份拖曳） ───────── */

function GroupList({ groupKey, groupLabel, list, accounts }: { groupKey: string; groupLabel: string; list: AccountRow[]; accounts: AccountRow[] }) {
  const moveAccountTo = useTicketStore((s) => s.moveAccountTo);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useDragReorder({
    root,
    items: list.map((a) => ({ id: a.id })),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = groupAccounts(useTicketStore.getState().accounts).find((g) => g.group.key === groupKey)?.accounts.map((a) => a.id) ?? [];
      const at = indexOfAnchor(latest, ids[0], place);
      if (at === null) return;
      void moveAccountTo(ids[0], at);
    },
  });
  // ManagerList 不轉發 ref ⇒ 拖曳 root 掛外層 div
  return (
    <div ref={setRoot}>
      <ManagerList label={groupLabel}>
        {list.map((a, i) => (
          <ManagerRow
            key={a.id}
            dragId={a.id}
            dataId={a.id}
            name={acctLabel(a, accounts)}
            onUp={i > 0 ? () => void moveAccountTo(a.id, i - 1) : undefined}
            onDown={i < list.length - 1 ? () => void moveAccountTo(a.id, i + 1) : undefined}
            menu={[]}
          />
        ))}
      </ManagerList>
    </div>
  );
}
