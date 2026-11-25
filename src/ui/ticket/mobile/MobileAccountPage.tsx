import { Select } from "../../common/Select";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { isTicketAmountMasked, TK_TEXT, useTicketStore } from "../../../store/ticketStore";
import {
  ACCOUNT_GROUPS,
  currencySymbol,
  isLiability,
  mainCurrencyOf,
  maskedMoneyText,
  moneyText,
  orderAccounts,
  type AccountGroup,
} from "../../../domain/ticket";
import { MAX_CARD_DAY, MIN_CARD_DAY } from "../../../domain/ticketCardCycle";
import { MFullPage } from "../../common/MFullPage";
import { shortDayKey } from "../../common/DatePicker";
import { useImeGuard } from "./mobileBits";

const CARD_DAYS = Array.from({ length: MAX_CARD_DAY - MIN_CARD_DAY + 1 }, (_, i) => i + MIN_CARD_DAY);

export function MobileAccountPage({ id }: { id: string }) {
  const acc = useTicketStore((s) => s.accById[id] ?? null);
  const accounts = useTicketStore((s) => s.accounts);
  const balance = useTicketStore((s) => s.balances[id] ?? 0);
  const cardCycle = useTicketStore((s) => s.cardCycles[id] ?? null);
  const curByCode = useTicketStore((s) => s.curByCode);
  const currencies = useTicketStore((s) => s.currencies);
  const masked = useTicketStore(isTicketAmountMasked);
  const closePanel = useTicketStore((s) => s.closePanel);
  const updateAccount = useTicketStore((s) => s.updateAccount);
  const adjustBalance = useTicketStore((s) => s.adjustBalance);
  const archiveAccount = useTicketStore((s) => s.archiveAccount);
  const unarchiveAccount = useTicketStore((s) => s.unarchiveAccount);
  const deleteAccount = useTicketStore((s) => s.deleteAccount);
  const setFilter = useTicketStore((s) => s.setFilter);
  const openNew = useTicketStore((s) => s.openNew);
  const openPayCardBill = useTicketStore((s) => s.openPayCardBill);

  const paySourceAccounts = useMemo(
    () =>
      orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null && a.id !== id && !isLiability(a.group_key))),
    [accounts, id],
  );

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
  const mainCode = mainCurrencyOf(currencies);
  const dec = curByCode[acc.currency]?.decimals ?? 2;
  const locked = balance !== 0;
  const archived = acc.archived_at !== null;
  const isCard = acc.group_key === "card";
  const curSym = currencySymbol(acc.currency);
  const fmtCardAmt = (minor: number) =>
    masked ? maskedMoneyText(acc.currency) : `${curSym} ${moneyText(minor, dec)}`;
  const cycleStatusLabel =
    cardCycle === null
      ? null
      : cardCycle.dueMinor <= 0
        ? "本期已繳清"
        : cardCycle.status === "overdue" && cardCycle.daysUntilDue !== null
          ? `逾期 ${Math.abs(cardCycle.daysUntilDue)} 天`
          : cardCycle.daysUntilDue === 0
            ? "今天繳款截止"
            : cardCycle.daysUntilDue !== null && cardCycle.daysUntilDue <= 7
              ? `${cardCycle.daysUntilDue} 天後截止`
              : cardCycle.paymentDueOn
                ? `${shortDayKey(cardCycle.paymentDueOn)} 截止`
                : "待繳款";

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
            <Select
              className="ns-tk-mselect"
              aria-label="群組"
              value={ACCOUNT_GROUPS.some((g) => g.key === acc.group_key) ? acc.group_key : "other"}
              onChange={(v) => void updateAccount(acc.id, { group: v as AccountGroup })}
            >
              {ACCOUNT_GROUPS.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                  {g.liability ? "（負債）" : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="ns-tk-mf-field">
            <span className="lbl">幣別</span>
            <Select
              className="ns-tk-mselect"
              aria-label="幣別"
              value={acc.currency}
              disabled={locked}
              onChange={(v) => void updateAccount(acc.id, { currency: v })}
            >
              {currencies.map((c) => (
                <option key={c.id} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </Select>
            {locked && <small className="ns-tk-macct-note">記過帳就不能改幣別了</small>}
          </label>
          {isCard && (
            <>
              <label className="ns-tk-mf-field">
                <span className="lbl">結帳日</span>
                <Select
                  className="ns-tk-mselect"
                  aria-label="每月結帳日"
                  value={acc.statement_day !== null ? String(acc.statement_day) : ""}
                  onChange={(v) => void updateAccount(acc.id, { statementDay: v ? Number(v) : null })}
                >
                  <option value="">不設定</option>
                  {CARD_DAYS.map((day) => (
                    <option key={day} value={String(day)}>
                      每月 {day} 日
                    </option>
                  ))}
                </Select>
              </label>
              <label className="ns-tk-mf-field">
                <span className="lbl">繳款日</span>
                <Select
                  className="ns-tk-mselect"
                  aria-label="每月繳款截止日"
                  value={acc.payment_due_day !== null ? String(acc.payment_due_day) : ""}
                  onChange={(v) => void updateAccount(acc.id, { paymentDueDay: v ? Number(v) : null })}
                >
                  <option value="">不設定</option>
                  {CARD_DAYS.map((day) => (
                    <option key={day} value={String(day)}>
                      每月 {day} 日
                    </option>
                  ))}
                </Select>
              </label>
              <label className="ns-tk-mf-field">
                <span className="lbl">扣款戶</span>
                <Select
                  className="ns-tk-mselect"
                  aria-label="預設扣款帳戶"
                  value={acc.auto_pay_account_id ?? ""}
                  onChange={(v) => void updateAccount(acc.id, { autoPayAccountId: v || null })}
                >
                  <option value="">自動選擇</option>
                  {paySourceAccounts.map((pa) => (
                    <option key={pa.id} value={pa.id}>
                      {pa.name}
                      {pa.currency !== acc.currency ? `（${pa.currency}）` : ""}
                    </option>
                  ))}
                </Select>
              </label>
            </>
          )}
        </div>

        {isCard && (
          <section className="ns-tk-macct-cycle" aria-label="本期帳單摘要">
            {cardCycle ? (
              <>
                <div className="hd">
                  <span className="lbl">本期帳單</span>
                  <span className="range">
                    {shortDayKey(cardCycle.prevStatementOn)} 後 ～ {shortDayKey(cardCycle.lastStatementOn)}
                  </span>
                  {cycleStatusLabel && (
                    <span
                      className={
                        "st" +
                        (cardCycle.dueMinor <= 0
                          ? " is-paid"
                          : cardCycle.status === "overdue" || cardCycle.status === "due"
                            ? " is-warn"
                            : "")
                      }
                    >
                      {cycleStatusLabel}
                    </span>
                  )}
                </div>
                <div className="grid">
                  <div className="cell">
                    <span>本期帳單</span>
                    <b>{fmtCardAmt(cardCycle.billMinor)}</b>
                  </div>
                  <div className="cell">
                    <span>本期已繳</span>
                    <b>{fmtCardAmt(cardCycle.paidMinor)}</b>
                  </div>
                  <div className={"cell is-due" + (cardCycle.status === "overdue" || cardCycle.status === "due" ? " is-warn" : "")}>
                    <span>剩餘應繳</span>
                    <b>{cardCycle.dueMinor > 0 ? fmtCardAmt(cardCycle.dueMinor) : "已繳清"}</b>
                  </div>
                  <div className="cell">
                    <span>下期未出帳</span>
                    <b>{fmtCardAmt(cardCycle.unbilledMinor)}</b>
                  </div>
                </div>
                {!archived && (
                  <button
                    type="button"
                    className={`ns-btn ${adj === null && cardCycle.dueMinor > 0 ? "btn-seal" : "btn-ghost"} ns-tk-mbtn ns-tk-macct-pay`}
                    onClick={() => void openPayCardBill(acc.id)}
                  >
                    一鍵繳卡費
                  </button>
                )}
              </>
            ) : (
              <div className="empty">
                <p>設定每月結帳日後，將自動彙總本期帳單、已繳金額、剩餘應繳與下期未出帳消費。</p>
                {!archived && balance < 0 && (
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-tk-mbtn ns-tk-macct-pay"
                    onClick={() => void openPayCardBill(acc.id)}
                  >
                    一鍵繳卡費
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        <div className="ns-tk-macct-balance">
          <span className="lbl">目前餘額</span>
          <b>
            {masked ? (
              maskedMoneyText(acc.currency)
            ) : (
              <>
                {moneyText(balance, dec)}
                {acc.currency !== mainCode && <small>{acc.currency}</small>}
              </>
            )}
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
                  placeholder={masked ? "" : moneyText(balance, dec).replace(/,/g, "")}
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
              // 售票口④ 第二輪：從帳戶分頁點進來的 ⇒ 回清單才看得到帳（月曆／統計照舊留在原地，它們也跟著篩）
              const v = useTicketStore.getState().view;
              if (v === "accounts") void useTicketStore.getState().setView("list");
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
            <>
              <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={() => void unarchiveAccount(acc.id)}>
                取消封存
              </button>
              <button type="button" className="ns-btn btn-ghost ns-btn-danger ns-tk-mbtn" onClick={() => void deleteAccount(acc.id)}>
                刪除帳戶
              </button>
            </>
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
