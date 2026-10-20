/**
 * NewAccountForm——「新增帳戶」對話框本體（車次①契約 §5.1、§2.5-4；兩殼共用；丙席）。
 * props `{ onDone(): void }`（確認或取消後由 host 關）；自己讀 store。標題由 host 依 `store.dialog.kind` 給。
 *
 * 欄位：名稱・群組（12 個，依財務管家順序；`lent` 顯示「借出／應收」）・幣別・期初餘額（可空；填了＝建立時同時生成一筆
 *   精算，備註「期初餘額」——store.createAccount 做）。「建立」成功才關；失敗 store 已吐 toast，欄位留著讓主人改。
 *   建完要不要接著記一筆／填回草稿看 `dialog.then`，store.createAccount 處理（磨光③ 2-16）；這裡只管建與關。
 * 桌機外觀在 ticket.css §F、手機觸控尺寸在 ticket-mobile.css。
 */
import { useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { ACCOUNT_GROUPS, MAIN_CURRENCY, type AccountGroup } from "../../../domain/ticket";
import { useImeGuard } from "./dialogBits";

export function NewAccountForm({ onDone }: { onDone(): void }) {
  const currencies = useTicketStore((s) => s.currencies);
  const createAccount = useTicketStore((s) => s.createAccount);
  const [name, setName] = useState("");
  const [group, setGroup] = useState<AccountGroup>("cash");
  const [currency, setCurrency] = useState(MAIN_CURRENCY);
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      if (await createAccount({ name, group, currency, openingText: opening })) onDone();
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
        <select className="ns-tk-dselect" value={group} onChange={(e) => setGroup(e.target.value as AccountGroup)}>
          {ACCOUNT_GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
              {g.liability ? "（負債）" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="ns-tk-dfield">
        <span className="lbl">幣別</span>
        <select className="ns-tk-dselect" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {currencies.map((c) => (
            <option key={c.id} value={c.code}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
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
      <div className="ns-tk-dfoot">
        <button type="button" className="ns-btn btn-ghost ns-tk-dbtn" onClick={onDone}>
          取消
        </button>
        <button type="submit" className="ns-btn btn-gold ns-tk-dbtn" disabled={busy || !name.trim()}>
          建立
        </button>
      </div>
    </form>
  );
}
