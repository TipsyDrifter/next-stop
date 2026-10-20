/**
 * CurrencyTable——「幣別與匯率」對話框本體（車次①契約 §5.1、§2.5-4、0-18、0-30；兩殼共用；丙席）。
 * props `{ onDone(): void }`；自己讀 store。標題由 host 依 `store.dialog.kind` 給。
 *
 * 小表：代碼・名稱・小數位・「1 外幣 ＝ N TWD」可編輯（失焦／Enter 才送 store.updateCurrency；格式錯由 store 吐 toast 並還原）。
 * 主幣別那一列唯讀。底下一列「＋ 幣別」：代碼 3 個英文字母（自動轉大寫；重複由 repository 擋「已經有 USD 了」）、
 *   名稱可空（預設取 CURRENCY_NAMES）、小數位、匯率。改匯率不動歷史帳（D-票-8）——說明寫在表下。
 */
import { useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { CURRENCY_NAMES, MAIN_CURRENCY, type CurrencyRow } from "../../../domain/ticket";
import { useImeGuard } from "./dialogBits";

export function CurrencyTable({ onDone }: { onDone(): void }) {
  const currencies = useTicketStore((s) => s.currencies);
  const createCurrency = useTicketStore((s) => s.createCurrency);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [decimals, setDecimals] = useState(2);
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (busy || code.trim().length !== 3 || !rate.trim()) return;
    setBusy(true);
    try {
      if (await createCurrency({ code, name, decimals, rateText: rate })) {
        setCode("");
        setName("");
        setDecimals(2);
        setRate("");
      }
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void add();
  });
  const up = code.trim().toUpperCase();

  return (
    <div className="ns-tk-dialog ns-tk-dcur">
      <ul className="ns-tk-dcurlist">
        {currencies.map((c) => (
          <CurrencyLine key={c.id} cur={c} />
        ))}
      </ul>
      <p className="ns-tk-dhint">改匯率只影響之後的帳，已記的不變。</p>

      <div className="ns-tk-dcuradd" role="group" aria-label="新增幣別">
        <input
          className="techo-input ns-tk-din is-code"
          value={code}
          maxLength={3}
          placeholder="代碼"
          aria-label="幣別代碼（三個英文字母）"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          {...ime}
        />
        <input
          className="techo-input ns-tk-din"
          value={name}
          placeholder={CURRENCY_NAMES[up] ?? "名稱"}
          aria-label="幣別名稱（選填）"
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          {...ime}
        />
        <select className="ns-tk-dselect" value={decimals} aria-label="小數位" onChange={(e) => setDecimals(parseInt(e.target.value, 10))}>
          <option value={2}>小數 2 位</option>
          <option value={0}>無小數</option>
        </select>
        <label className="ns-tk-drate">
          <span>1 {up || "外幣"} ＝</span>
          <input
            className="techo-input ns-tk-din is-num"
            value={rate}
            inputMode="decimal"
            placeholder="匯率"
            aria-label="匯率"
            autoComplete="off"
            enterKeyHint="done"
            onChange={(e) => setRate(e.target.value)}
            {...ime}
          />
          <span>{MAIN_CURRENCY}</span>
        </label>
        <button
          type="button"
          className="ns-btn btn-ghost ns-tk-dbtn"
          disabled={busy || up.length !== 3 || !rate.trim()}
          onClick={() => void add()}
        >
          ＋ 幣別
        </button>
      </div>

      <div className="ns-tk-dfoot">
        <button type="button" className="ns-btn btn-gold ns-tk-dbtn" onClick={onDone}>
          完成
        </button>
      </div>
    </div>
  );
}

function CurrencyLine({ cur }: { cur: CurrencyRow }) {
  const updateCurrency = useTicketStore((s) => s.updateCurrency);
  const [rate, setRate] = useState(cur.rate_to_main);
  const [name, setName] = useState(cur.name);
  const [seen, setSeen] = useState(cur.rate_to_main + "\u0000" + cur.name);
  const key = cur.rate_to_main + "\u0000" + cur.name;
  if (seen !== key) {
    // 存檔成功（或格式錯被擋、store 沒變）之後跟著 store 的值走
    setSeen(key);
    setRate(cur.rate_to_main);
    setName(cur.name);
  }
  const blurOnEnter = useImeGuard((e) => (e.currentTarget as HTMLInputElement).blur());
  const main = cur.is_main === 1;

  const commitRate = async () => {
    if (rate.trim() === cur.rate_to_main) return;
    await updateCurrency(cur.id, { rateText: rate });
    // 失敗時 store 沒變 ⇒ 還原成 store 的值
    const now = useTicketStore.getState().curByCode[cur.code];
    if (now) setRate(now.rate_to_main);
  };
  const commitName = () => {
    const v = name.trim();
    if (!v) {
      setName(cur.name);
      return;
    }
    if (v !== cur.name) void updateCurrency(cur.id, { name: v });
  };

  return (
    <li className={"ns-tk-dcurrow" + (main ? " is-main" : "")}>
      <span className="code">{cur.code}</span>
      <input
        className="ns-tk-dname"
        value={name}
        aria-label={`${cur.code} 的名稱`}
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        {...blurOnEnter}
      />
      <span className="dec">{cur.decimals === 0 ? "無小數" : `小數 ${cur.decimals}`}</span>
      {main ? (
        <span className="rate is-main">主要幣別</span>
      ) : (
        <label className="rate">
          <span>1 {cur.code} ＝</span>
          <input
            className="ns-tk-dname is-num"
            value={rate}
            inputMode="decimal"
            aria-label={`1 ${cur.code} 換多少 ${MAIN_CURRENCY}`}
            autoComplete="off"
            enterKeyHint="done"
            onChange={(e) => setRate(e.target.value)}
            onBlur={() => void commitRate()}
            {...blurOnEnter}
          />
          <span>{MAIN_CURRENCY}</span>
        </label>
      )}
    </li>
  );
}
