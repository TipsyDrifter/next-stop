/**
 * MobileAccountPage——手機的帳戶頁（車次①契約 §5.3；桌機詳情板「帳戶版」的手機版，§5.1）。
 * 殼＝共用 MFullPage（UI 丙-5 H5）：書封色頂列左「‹ 售票口」＝先存名稱再收起（store.closePanel）、中「帳戶」、右邊空（即時存的頁沒有主鈕）；
 *   本文裡放 `div.ns-tk-macct`（本檔的樣式掛在它底下）；「已封存」小牌在本文最上面。返回層 id "ticket.account" 交給 MFullPage（返回鍵＝左鈕）。
 *
 * 由上而下：名稱（失焦／Enter 才改名）・群組・幣別（有帳鎖）→ 目前餘額大字＋「調整餘額…」（行內展開目標餘額＋確定，
 *   生成一筆精算）→「看這個帳戶的帳」「在這個帳戶記一筆」→ 封存／取消封存（封存走 store 的確認窗）。
 * 幣別鎖：store 沒有「這個帳戶有沒有帳」——餘額不是 0 就鎖；餘額剛好 0 但有帳的，repository 會擋下並吐
 *   「這個帳戶已經有帳，幣別不能改」（錯誤表），不會改壞資料。
 */
import { useEffect, useRef, useState } from "react";
import { TK_TEXT, useTicketStore } from "../../../store/ticketStore";
import { ACCOUNT_GROUPS, MAIN_CURRENCY, moneyText, type AccountGroup } from "../../../domain/ticket";
import { MFullPage } from "../../common/MFullPage";
import { useImeGuard } from "./mobileBits";

export function MobileAccountPage({ id }: { id: string }) {
  const acc = useTicketStore((s) => s.accById[id] ?? null);
  const balance = useTicketStore((s) => s.balances[id] ?? 0);
  const curByCode = useTicketStore((s) => s.curByCode);
  const currencies = useTicketStore((s) => s.currencies);
  const closePanel = useTicketStore((s) => s.closePanel);
  const updateAccount = useTicketStore((s) => s.updateAccount);
  const adjustBalance = useTicketStore((s) => s.adjustBalance);
  const archiveAccount = useTicketStore((s) => s.archiveAccount);
  const unarchiveAccount = useTicketStore((s) => s.unarchiveAccount);
  const setFilter = useTicketStore((s) => s.setFilter);
  const openNew = useTicketStore((s) => s.openNew);

  const [name, setName] = useState(acc?.name ?? "");
  const [adj, setAdj] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 剛送出去的名字：點「‹ 售票口」時名稱框先失焦存一次、左鈕又存一次——store 還沒刷新回來前 acc.name 仍是舊名，靠這個不重送
  const sent = useRef<string | null>(null);
  // 外面改了名（同步、桌機、自己剛存的刷新回來）⇒ 跟著換；帳戶不在了 ⇒ 收起
  useEffect(() => {
    sent.current = null;
    if (acc) setName(acc.name);
  }, [acc?.name]);
  useEffect(() => {
    if (!acc) closePanel();
  }, [acc, closePanel]);

  const commitName = () => {
    if (!acc) return;
    const v = name.trim();
    if (!v) {
      setName(acc.name);
      return;
    }
    if (v !== acc.name && v !== sent.current) {
      sent.current = v;
      void updateAccount(acc.id, { name: v });
    }
  };
  // 磨光①（主線手機殼契約 §1.5）：返回鍵＝「‹ 售票口」。返回鍵不會讓名稱框失焦，所以左鈕先存再收（丙-5：MFullPage 的返回鍵就是叫左鈕）
  const leave = () => {
    commitName();
    closePanel();
  };
  const nameIme = useImeGuard((e) => (e.currentTarget as HTMLInputElement).blur());
  const adjIme = useImeGuard((e) => {
    e.preventDefault();
    void submitAdjust();
  });

  async function submitAdjust() {
    if (!acc || adj === null || busy) return;
    setBusy(true);
    try {
      if (await adjustBalance(acc.id, adj)) setAdj(null);
    } finally {
      setBusy(false);
    }
  }

  if (!acc) return null;
  const dec = curByCode[acc.currency]?.decimals ?? 2;
  const locked = balance !== 0;
  const archived = acc.archived_at !== null;

  return (
    <MFullPage title="帳戶" left={{ label: "售票口", back: true, onClick: leave }} backId="ticket.account">
    <div className="ns-tk-macct">
      <div className="ns-tk-macct-scroll">
        {archived && <span className="ns-tk-macct-tag">已封存</span>}
        <input
          className="ns-tk-macct-name"
          value={name}
          aria-label="帳戶名稱"
          enterKeyHint="done"
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          {...nameIme}
        />

        <div className="ns-tk-macct-fields">
          <label className="ns-tk-mf-field">
            <span className="lbl">群組</span>
            <select
              className="ns-tk-mselect"
              value={ACCOUNT_GROUPS.some((g) => g.key === acc.group_key) ? acc.group_key : "other"}
              onChange={(e) => void updateAccount(acc.id, { group: e.target.value as AccountGroup })}
            >
              {ACCOUNT_GROUPS.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                  {g.liability ? "（負債）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="ns-tk-mf-field">
            <span className="lbl">幣別</span>
            <select
              className="ns-tk-mselect"
              value={acc.currency}
              disabled={locked}
              onChange={(e) => void updateAccount(acc.id, { currency: e.target.value })}
            >
              {currencies.map((c) => (
                <option key={c.id} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
            {locked && <small className="ns-tk-macct-note">記過帳就不能改幣別了</small>}
          </label>
        </div>

        <div className="ns-tk-macct-balance">
          <span className="lbl">目前餘額</span>
          <b>
            {moneyText(balance, dec)}
            {acc.currency !== MAIN_CURRENCY && <small>{acc.currency}</small>}
          </b>
          {adj === null ? (
            <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={() => setAdj("")}>
              調整餘額…
            </button>
          ) : (
            <div className="ns-tk-macct-adj">
              <label>
                <span className="lbl">目標餘額</span>
                <input
                  inputMode="decimal"
                  autoComplete="off"
                  autoFocus
                  enterKeyHint="done"
                  value={adj}
                  placeholder={moneyText(balance, dec).replace(/,/g, "")}
                  onChange={(e) => setAdj(e.target.value)}
                  {...adjIme}
                />
              </label>
              <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={() => setAdj(null)}>
                取消
              </button>
              <button type="button" className="ns-btn btn-seal ns-tk-mbtn" disabled={busy || adj.trim() === ""} onClick={() => void submitAdjust()}>
                確定
              </button>
            </div>
          )}
        </div>

        <div className="ns-tk-macct-links">
          <button
            type="button"
            className="ns-btn btn-ghost ns-tk-mbtn"
            onClick={() => {
              void setFilter(acc.id);
              closePanel();
            }}
          >
            看這個帳戶的帳
          </button>
          {!archived && (
            <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={() => openNew({ accountId: acc.id, currency: acc.currency })}>
              在這個帳戶記一筆
            </button>
          )}
        </div>

        <div className="ns-tk-macct-foot">
          {archived ? (
            <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={() => void unarchiveAccount(acc.id)}>
              取消封存
            </button>
          ) : (
            <button type="button" className="ns-btn btn-ghost ns-btn-danger ns-tk-mbtn" onClick={() => archiveAccount(acc.id)}>
              封存
            </button>
          )}
          <small>{TK_TEXT.archiveBody}</small>
        </div>
      </div>
    </div>
    </MFullPage>
  );
}
