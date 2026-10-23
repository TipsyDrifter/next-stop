/**
 * AccountOrder——「帳戶順序」對話框本體（磨光⑥ 契約 §2-1；D-票-61；兩殼共用）。
 * props `{ onDone(): void }`；自己讀 store。標題由 host 依 `store.dialog.kind` 給（桌機 DesktopDialogHost、手機 MobileSheetHost）。
 *
 * 長相與寫法照 CategoryManager（同一套 class）：依群組分區（`groupAccounts`：群組序固定＝ACCOUNT_GROUPS，只列未封存帳戶），
 * 每列右邊 ↑／↓（群組頭尾那一格 disabled），列上 Alt+↑↓ 同義；呼叫既有的 `moveAccount`（同群組鄰居互換、走同步）。
 * 群組之間的順序不能改，只在群組內排。移動後焦點跟著那一列走（列是同一個 key，React 只換位置）。
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { groupAccounts, type AccountRow } from "../../../domain/ticket";
import { acctLabel } from "../TicketLedger";

// 即時存（moveAccount 按一下就寫）⇒ 沒有「完成」鈕：關閉走 DialogShell 的 ×／暗幕／Esc、手機 sheet 的暗幕／返回鍵（UI 丙-1，視覺規範 §6）。
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
            <ul className="ns-tk-dtree">
              {list.map((a, i) => (
                <li key={a.id} className="ns-tk-dmain">
                  <AcctRow account={a} label={acctLabel(a, accounts)} first={i === 0} last={i === list.length - 1} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/* ───────── 一列帳戶 ───────── */

/** 按鈕按下後多久內 first/last 的變動算「這次移動造成的」 */
const PRESS_WINDOW_MS = 1500;

function AcctRow({ account: a, label, first, last }: { account: AccountRow; label: string; first: boolean; last: boolean }) {
  const moveAccount = useTicketStore((s) => s.moveAccount);
  const rowRef = useRef<HTMLDivElement>(null);
  const move = (delta: 1 | -1) => {
    if ((delta < 0 && first) || (delta > 0 && last)) return;
    void moveAccount(a.id, delta);
  };
  // 移到頂／底後那顆鈕變 disabled，焦點會掉 ⇒ 交給同一列還能按的那顆（鍵盤連按不斷）。等 store 寫完、first/last 真的變了才判斷；
  // 中段移動時 first/last 不變、旗標不會被消耗 ⇒ 記按下的時間，過了就當作廢（之後同步拉到新帳戶造成的變動不搶焦點）
  const pressed = useRef(0);
  useEffect(() => {
    const at = pressed.current;
    pressed.current = 0;
    if (at === 0 || Date.now() - at > PRESS_WINDOW_MS) return;
    const row = rowRef.current;
    const act = document.activeElement;
    const lost = act === null || act === document.body || (act instanceof HTMLButtonElement && act.disabled && !!row?.contains(act));
    if (lost) row?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [first, last]);
  const press = (delta: 1 | -1) => {
    pressed.current = Date.now();
    move(delta);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      move(e.key === "ArrowUp" ? -1 : 1);
    }
  };

  return (
    <div ref={rowRef} className="ns-tk-drow" tabIndex={0} aria-label={label} onKeyDown={onKeyDown}>
      <span className="nm">{label}</span>
      <button type="button" className="ns-iconbtn ns-tk-dmini sq" aria-label={`上移：${label}`} title="上移（Alt+↑）" disabled={first} onClick={() => press(-1)}>
        ↑
      </button>
      <button type="button" className="ns-iconbtn ns-tk-dmini sq" aria-label={`下移：${label}`} title="下移（Alt+↓）" disabled={last} onClick={() => press(1)}>
        ↓
      </button>
    </div>
  );
}
