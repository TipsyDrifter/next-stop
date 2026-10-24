/**
 * TicketSide——書封頁務件「帳戶 ACCOUNTS」（車次①契約 §5.1、0-5、0-9、0-12；D-票-22 書封內；乙席）。
 * 經 mount 的 `sidebarAux` 掛進 Sidebar.tsx 的 `.lines-scroll` 位置（接縫 #50）：全域三件（gnav、工具列、cover-foot）不動，
 * 本元件自己 `flex:1; min-height:0`、清單自己捲（捲軸隱形、上下緣淡出，同 .lines-scroll）。
 *
 *   div.ns-tk-side
 *   ├─ h2「帳戶 ACCOUNTS」（沿用 .lines h2 的字級與虛線）
 *   ├─ .ns-tk-sidescroll
 *   │   ├─ .ns-tk-total        資產／負債／合計（主幣別；封存帳戶計入；跟清單一起捲，主人 10-13）
 *   │   ├─ button.ns-tk-sideitem「全部帳戶 N」（aria-pressed）
 *   │   ├─ .ns-tk-group ×N     群組小字（負債群組右標「負債」）→ .ns-tk-acct（名稱左、餘額右；點＝篩選；常駐淡態的 › ＝詳情板帳戶版）
 *   │   └─ .ns-tk-group.is-archived「封存 N ▸」（預設收）
 *   └─ .ns-tk-sidefoot         「＋ 帳戶」
 *
 * UI 丙-5 B1：書封底的無字滑桿（管理選單）退役，搬到頁首第四格「⚙ 管帳」（TicketLedger 開共用 PopMenu）；書封底只留「＋ 帳戶」。
 * UI 丙-5 B3：帳戶 › 常駐淡態（--dim），hover／開著帳戶版時轉實（不用 hover 就看得到有詳情）。
 *
 * 只讀 store、只叫 store 的動作（§2.5）。
 */
import { useState } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { MAIN_CURRENCY, groupAccounts, archivedAccounts, type AccountRow } from "../../domain/ticket";
import { Money } from "./parts/Money";
import { TkIcon, acctLabel } from "./TicketLedger";
import "./ticket.css";

export function TicketSide() {
  const accounts = useTicketStore((s) => s.accounts);
  const balances = useTicketStore((s) => s.balances);
  const totals = useTicketStore((s) => s.totals);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const panel = useTicketStore((s) => s.panel);
  const [archOpen, setArchOpen] = useState(false);

  // 頁務件比頁面先畫（書封）：warm 已由 TicketAgent 叫；餘額要等 init → refresh。進頁時 TicketView 會 init。
  const groups = groupAccounts(accounts);
  const archived = archivedAccounts(accounts);
  const live = accounts.filter((a) => a.deleted_at === null && a.archived_at === null);
  const store = useTicketStore.getState;

  const row = (a: AccountRow) => {
    const pressed = filterAccountId === a.id;
    const card = panel.kind === "account" && panel.id === a.id;
    const bal = balances[a.id] ?? 0;
    const label = acctLabel(a, accounts);
    return (
      <div key={a.id} className={`ns-tk-acct${bal === 0 ? " is-zero" : ""}${card ? " is-card" : ""}`}>
        <button
          type="button"
          className="ns-tk-acctbtn"
          aria-pressed={pressed}
          title={label}
          onClick={() => void store().setFilter(pressed ? null : a.id)}
        >
          <span className="mk" aria-hidden />
          <span className="n">{a.name}</span>
          <span className="b">
            <Money minor={bal} currency={a.currency} code />
          </span>
        </button>
        <button
          type="button"
          className="go"
          aria-label={`${label}的帳戶詳情`}
          title="帳戶詳情"
          onClick={() => store().openAccount(a.id)}
        >
          <TkIcon name="right" size={11} />
        </button>
      </div>
    );
  };

  return (
    <div className="ns-tk-side" aria-label="帳戶">
      <h2>帳戶 ACCOUNTS</h2>
      <div className="ns-tk-sidescroll">
      {/* 合計小卡在清單裡一起捲（主人 10-13 拍：矮視窗多讓出帳戶清單） */}
      <div className="ns-tk-total" aria-label="合計">
        <span>資產</span>
        <b>
          <Money minor={totals.asset} currency={MAIN_CURRENCY} />
        </b>
        <span>負債</span>
        <b>
          <Money minor={totals.liability} currency={MAIN_CURRENCY} />
        </b>
        <span className="sum">合計</span>
        <b className="sum">
          <Money minor={totals.net} currency={MAIN_CURRENCY} />
        </b>
      </div>
        <button
          type="button"
          className="ns-tk-sideitem"
          aria-pressed={filterAccountId === null}
          onClick={() => void store().setFilter(null)}
        >
          <span className="mk" aria-hidden />
          全部帳戶
          <span className="cnt">{live.length}</span>
        </button>
        {groups.map(({ group, accounts: list }) => (
          <div key={group.key} className="ns-tk-group">
            <h3>
              {group.label}
              {group.liability && <span className="lia">負債</span>}
            </h3>
            {list.map(row)}
          </div>
        ))}
        {archived.length > 0 && (
          <div className="ns-tk-group is-archived">
            <h3>
              <button type="button" aria-expanded={archOpen} onClick={() => setArchOpen((v) => !v)}>
                封存 {archived.length} {archOpen ? "▾" : "▸"}
              </button>
            </h3>
            {archOpen && archived.map(row)}
          </div>
        )}
        {live.length === 0 && archived.length === 0 && <p className="ns-tk-sideempty">還沒有帳戶</p>}
      </div>
      <div className="ns-tk-sidefoot">
        <button type="button" onClick={() => store().openDialog({ kind: "newAccount" })}>
          <TkIcon name="plus" size={11} />
          帳戶
        </button>
      </div>
    </div>
  );
}
