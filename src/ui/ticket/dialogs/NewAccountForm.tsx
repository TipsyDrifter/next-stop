import { Select } from "../../common/Select";
/**
 * NewAccountForm——「新增帳戶」對話框本體（車次①契約 §5.1、§2.5-4；兩殼共用；丙席）。
 * props `{ onDone(): void }`（確認或取消後由 host 關）；自己讀 store。標題由 host 依 `store.dialog.kind` 給。
 *
 * 欄位：名稱・群組（12 個，依 ACCOUNT_GROUPS 順序；`lent` 顯示「借出／應收」）・幣別・期初餘額（可空；填了＝建立時同時生成一筆
 *   精算，備註「期初餘額」——store.createAccount 做）。「建立」成功才關；失敗 store 已吐 toast，欄位留著讓主人改。
 *   建完要不要接著記一筆／填回草稿看 `dialog.then`，store.createAccount 處理（磨光③ 2-16）；這裡只管建與關。
 * 「取消・建立」包在 `<DialogFoot>`：桌機進 DialogShell 的黏底 foot（UI 丙-5 E3），手機照舊在本文最後；
 *   按鈕在 <form> 外面時「建立」靠 `form={formId}` 送出。
 * 桌機外觀在 ticket.css §F、手機觸控尺寸在 ticket-mobile.css。
 */
import { useId, useMemo, useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import {
  ACCOUNT_GROUPS,
  isLiability,
  mainCurrencyOf,
  orderAccounts,
  type AccountGroup,
} from "../../../domain/ticket";
import { MAX_CARD_DAY, MIN_CARD_DAY, clampCardDay } from "../../../domain/ticketCardCycle";
import { acctLabel } from "../TicketLedger";
import { useImeGuard } from "./dialogBits";
import { DialogFoot } from "./DialogFoot";
import "../ticket-v138.css";

const CARD_DAYS = Array.from({ length: MAX_CARD_DAY - MIN_CARD_DAY + 1 }, (_, i) => MIN_CARD_DAY + i);

export function NewAccountForm({ onDone }: { onDone(): void }) {
  const currencies = useTicketStore((s) => s.currencies);
  const accounts = useTicketStore((s) => s.accounts);
  const createAccount = useTicketStore((s) => s.createAccount);
  const [name, setName] = useState("");
  const [group, setGroup] = useState<AccountGroup>("cash");
  const [currency, setCurrency] = useState(() => mainCurrencyOf(currencies));
  const [opening, setOpening] = useState("");
  const [statementDay, setStatementDay] = useState("");
  const [paymentDueDay, setPaymentDueDay] = useState("");
  const [autoPayAccountId, setAutoPayAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const isCard = group === "card";
  const autoPayAccounts = useMemo(
    () => orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null && !isLiability(a.group_key))),
    [accounts],
  );

  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const parsedStatement = isCard && statementDay ? clampCardDay(parseInt(statementDay, 10)) : null;
      const parsedDue = isCard && paymentDueDay ? clampCardDay(parseInt(paymentDueDay, 10)) : null;
      const parsedAutoPay = isCard && autoPayAccountId ? autoPayAccountId : null;
      if (
        await createAccount({
          name,
          group,
          currency,
          openingText: opening,
          statementDay: parsedStatement,
          paymentDueDay: parsedDue,
          autoPayAccountId: parsedAutoPay,
        })
      ) {
        onDone();
      }
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void submit();
  });

  return (
    <form
      id={formId}
      className="ns-tk-dialog ns-tk-dnew"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="ns-tk-dfield">
        <span className="lbl">名稱</span>
        <input
          className="techo-input ns-tk-din"
          value={name}
          autoFocus
          autoComplete="off"
          enterKeyHint="next"
          placeholder="例：現金、悠遊卡"
          onChange={(e) => setName(e.target.value)}
          {...ime}
        />
      </label>
      <label className="ns-tk-dfield">
        <span className="lbl">群組</span>
        <Select className="ns-tk-dselect" aria-label="群組" value={group} onChange={(v) => setGroup(v as AccountGroup)}>
          {ACCOUNT_GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
              {g.liability ? "（負債）" : ""}
            </option>
          ))}
        </Select>
      </label>
      <label className="ns-tk-dfield">
        <span className="lbl">幣別</span>
        <Select className="ns-tk-dselect" aria-label="幣別" value={currency} onChange={(v) => setCurrency(v)}>
          {currencies.map((c) => (
            <option key={c.id} value={c.code}>
              {c.code} · {c.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="ns-tk-dfield">
        <span className="lbl">初始餘額</span>
        <input
          className="techo-input ns-tk-din is-num"
          value={opening}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="可空"
          onChange={(e) => setOpening(e.target.value)}
          {...ime}
        />
      </label>
      <p className="ns-tk-dhint">填寫後會自動記一筆「精算」（期初餘額）；負債請填負數。</p>
      {isCard && (
        <section className="tk-v38-card-fields" aria-label="信用卡帳單週期設定">
          <p className="tk-v38-card-fields-hd">信用卡帳單週期（選填）</p>
          <label className="ns-tk-dfield">
            <span className="lbl">每月結帳日</span>
            <Select
              className="ns-tk-dselect"
              aria-label="每月結帳日"
              value={statementDay}
              onChange={(v) => setStatementDay(v)}
            >
              <option value="">不指定</option>
              {CARD_DAYS.map((d) => (
                <option key={d} value={String(d)}>
                  每月 {d} 日
                </option>
              ))}
            </Select>
          </label>
          <label className="ns-tk-dfield">
            <span className="lbl">每月繳款日</span>
            <Select
              className="ns-tk-dselect"
              aria-label="每月繳款截止日"
              value={paymentDueDay}
              onChange={(v) => setPaymentDueDay(v)}
            >
              <option value="">不指定</option>
              {CARD_DAYS.map((d) => (
                <option key={d} value={String(d)}>
                  每月 {d} 日
                </option>
              ))}
            </Select>
          </label>
          <label className="ns-tk-dfield">
            <span className="lbl">預設扣款帳戶</span>
            <Select
              className="ns-tk-dselect"
              aria-label="預設扣款帳戶"
              value={autoPayAccountId}
              onChange={(v) => setAutoPayAccountId(v)}
            >
              <option value="">不指定</option>
              {autoPayAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {acctLabel(a, accounts)}
                  {a.currency !== currency ? ` (${a.currency})` : ""}
                </option>
              ))}
            </Select>
          </label>
        </section>
      )}
      <DialogFoot>
        <button type="button" className="ns-btn btn-ghost ns-tk-dbtn" onClick={onDone}>
          取消
        </button>
        <button type="submit" form={formId} className="ns-btn btn-seal ns-tk-dbtn" disabled={busy || !name.trim()}>
          建立
        </button>
      </DialogFoot>
    </form>
  );
}
