/**
 * CurrencyTable——「幣別與帳本設定」對話框本體（車次①契約 §5.1；v1.33 3B G4「設為主幣別」＆「月起算日」＋ G5「帳本密碼鎖」；兩殼共用）。
 */
import { useState } from "react";
import { Select } from "../../common/Select";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import {
  CURRENCY_NAMES,
  mainCurrencyOf,
  monthRangeLabel,
  parseRate,
  type CurrencyRow,
} from "../../../domain/ticket";
import { isValidPin, normalizePinDigits } from "../../../domain/ticketLock";
import { useImeGuard } from "./dialogBits";

const START_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

export function CurrencyTable(_props: { onDone(): void }) {
  const currencies = useTicketStore((s) => s.currencies);
  const mainCode = useTicketStore((s) => mainCurrencyOf(s.curByCode).code);
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
          <CurrencyLine key={c.id} cur={c} mainCode={mainCode} />
        ))}
      </ul>
      <p className="ns-tk-dhint">改匯率只影響之後新記的帳；點「設為主幣別」則會依目前匯率一併換算歷史折合額與預算。</p>

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
        <Select className="ns-tk-dselect" value={decimals} aria-label="小數位" onChange={(v) => setDecimals(parseInt(v, 10))}>
          <option value={2}>小數 2 位</option>
          <option value={0}>無小數</option>
        </Select>
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
          <span>{mainCode}</span>
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

      <hr className="ns-tear ns-tk-dsep" />
      <LedgerPrefsSection />
    </div>
  );
}

function CurrencyLine({ cur, mainCode }: { cur: CurrencyRow; mainCode: string }) {
  const updateCurrency = useTicketStore((s) => s.updateCurrency);
  const [rate, setRate] = useState(cur.rate_to_main);
  const [name, setName] = useState(cur.name);
  const [seen, setSeen] = useState(cur.rate_to_main + "\u0000" + cur.name);
  const key = cur.rate_to_main + "\u0000" + cur.name;
  if (seen !== key) {
    setSeen(key);
    setRate(cur.rate_to_main);
    setName(cur.name);
  }
  const blurOnEnter = useImeGuard((e) => (e.currentTarget as HTMLInputElement).blur());
  const main = cur.is_main === 1;

  const commitRate = async () => {
    if (rate.trim() === cur.rate_to_main) return;
    await updateCurrency(cur.id, { rateText: rate });
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

  const askSetMain = async () => {
    let validRate: string;
    try {
      validRate = parseRate(rate);
    } catch (e) {
      useUiStore.getState().showToast({ message: e instanceof Error ? e.message : "請先填寫大於 0 的有效匯率" });
      return;
    }
    if (validRate !== cur.rate_to_main) {
      await updateCurrency(cur.id, { rateText: validRate });
      const latest = useTicketStore.getState().curByCode[cur.code];
      if (!latest || latest.rate_to_main !== validRate) return;
    }
    useUiStore.getState().askConfirm({
      title: `將「${cur.code}」設為主幣別？`,
      body: `帳本將改以 ${cur.code}（${cur.name}）作為折算基準（目前匯率：1 ${cur.code} ＝ ${validRate} ${mainCode}），並一併重算歷史帳目的折合額、預算與願望金額。`,
      confirmLabel: "設為主幣別",
      onConfirm: () => {
        void useTicketStore.getState().setMainCurrency(cur.code);
      },
    });
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
        <span className="ns-tk-dcur-right">
          <label className="rate">
            <span>1 {cur.code} ＝</span>
            <input
              className="ns-tk-dname is-num"
              value={rate}
              inputMode="decimal"
              aria-label={`1 ${cur.code} 換多少 ${mainCode}`}
              autoComplete="off"
              enterKeyHint="done"
              onChange={(e) => setRate(e.target.value)}
              onBlur={() => void commitRate()}
              {...blurOnEnter}
            />
            <span>{mainCode}</span>
          </label>
          <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" onClick={() => void askSetMain()}>
            設為主幣別
          </button>
        </span>
      )}
    </li>
  );
}

/* ───────── 帳本起算日、隱私遮罩與 4 碼密碼鎖設定區 ───────── */

type PinMode = "idle" | "set" | "change" | "clear";

function LedgerPrefsSection() {
  const month = useTicketStore((s) => s.month);
  const monthStartDay = useTicketStore((s) => s.monthStartDay);
  const setMonthStartDay = useTicketStore((s) => s.setMonthStartDay);
  const privacyMasked = useTicketStore((s) => s.privacyMasked);
  const togglePrivacyMask = useTicketStore((s) => s.togglePrivacyMask);
  const hasLockPin = useTicketStore((s) => s.hasLockPin);
  const setLockPin = useTicketStore((s) => s.setLockPin);
  const clearLockPin = useTicketStore((s) => s.clearLockPin);
  const lockLedger = useTicketStore((s) => s.lockLedger);

  const [pinMode, setPinMode] = useState<PinMode>("idle");
  const [curPin, setCurPin] = useState("");
  const [nextPin, setNextPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  const rangeLabel = monthRangeLabel(month, monthStartDay);

  const resetPinForm = () => {
    setPinMode("idle");
    setCurPin("");
    setNextPin("");
    setConfirmPin("");
    setPinErr(null);
  };

  const submitPinForm = async () => {
    if (pinBusy) return;
    setPinErr(null);
    if (pinMode === "clear") {
      if (!isValidPin(curPin)) {
        setPinErr("請輸入目前 4 位數字密碼");
        return;
      }
      setPinBusy(true);
      try {
        if (await clearLockPin(curPin)) resetPinForm();
        else setPinErr("目前密碼不正確");
      } finally {
        setPinBusy(false);
      }
      return;
    }
    if (pinMode === "change" && !isValidPin(curPin)) {
      setPinErr("請輸入目前 4 位數字密碼");
      return;
    }
    if (!isValidPin(nextPin)) {
      setPinErr("新密碼需為 4 位數字（0000–9999）");
      return;
    }
    if (nextPin !== confirmPin) {
      setPinErr("兩次輸入的新密碼不一致");
      return;
    }
    setPinBusy(true);
    try {
      const ok = await setLockPin(nextPin, pinMode === "change" ? curPin : undefined);
      if (ok) resetPinForm();
      else setPinErr("目前密碼不正確");
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <section className="ns-tk-dprefs" aria-label="帳本與隱私設定">
      <h3 className="ns-tk-dprefs-hd">帳本與隱私設定</h3>

      <div className="ns-tk-dpref-row">
        <div className="ns-tk-dpref-main">
          <b>帳務月起算日</b>
          <small>
            {rangeLabel
              ? `目前帳期範例：${rangeLabel}（清單、月曆、統計與預算統一依此區間計算）`
              : "預設每月 1 日起算（可配合發薪日或生活費入帳日改為 1～28 日）"}
          </small>
        </div>
        <Select
          className="ns-tk-dselect ns-tk-dpref-sel"
          value={monthStartDay}
          aria-label="帳務月起算日"
          onChange={(v) => void setMonthStartDay(parseInt(v, 10))}
        >
          {START_DAYS.map((d) => (
            <option key={d} value={d}>
              每月 {d} 日
            </option>
          ))}
        </Select>
      </div>

      <div className="ns-tk-dpref-row">
        <div className="ns-tk-dpref-main">
          <b>金額隱私遮罩（****）</b>
          <small>隱藏總資產、帳戶餘額、收支小計與帳目金額，也可隨時從售票口頁首眼睛按鈕切換</small>
        </div>
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-ghost ns-tk-dbtn"
          aria-pressed={privacyMasked}
          onClick={togglePrivacyMask}
        >
          {privacyMasked ? "已開啟遮罩" : "開啟遮罩"}
        </button>
      </div>

      <div className="ns-tk-dpref-row is-pin">
        <div className="ns-tk-dpref-main">
          <b>帳本 4 位數密碼鎖</b>
          <small>
            {hasLockPin
              ? "已啟用（僅存本機雜湊，每次啟動首次進入售票口或解除遮罩時驗證）"
              : "未啟用（設定後每次啟動 App 首次進入售票口需輸入 4 碼驗證）"}
          </small>
        </div>
        {pinMode === "idle" && (
          <div className="ns-tk-dpref-acts">
            {hasLockPin ? (
              <>
                <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" onClick={lockLedger}>
                  立即鎖定
                </button>
                <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" onClick={() => setPinMode("change")}>
                  修改密碼
                </button>
                <button
                  type="button"
                  className="ns-btn ns-btn--sm btn-ghost ns-btn-danger ns-tk-dmini"
                  onClick={() => setPinMode("clear")}
                >
                  關閉
                </button>
              </>
            ) : (
              <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dbtn" onClick={() => setPinMode("set")}>
                設定密碼鎖…
              </button>
            )}
          </div>
        )}
      </div>

      {pinMode !== "idle" && (
        <div className="ns-tk-dpinform" role="group" aria-label="設定帳本密碼鎖">
          {(pinMode === "change" || pinMode === "clear") && (
            <label className="ns-tk-dpinfield">
              <span>目前密碼</span>
              <input
                type="password"
                className="techo-input ns-tk-din is-pin"
                inputMode="numeric"
                maxLength={4}
                placeholder="4 位數字"
                autoComplete="off"
                autoFocus
                value={curPin}
                onChange={(e) => setCurPin(normalizePinDigits(e.target.value))}
              />
            </label>
          )}
          {(pinMode === "set" || pinMode === "change") && (
            <>
              <label className="ns-tk-dpinfield">
                <span>新 4 碼密碼</span>
                <input
                  type="password"
                  className="techo-input ns-tk-din is-pin"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="0000–9999"
                  autoComplete="off"
                  autoFocus={pinMode === "set"}
                  value={nextPin}
                  onChange={(e) => setNextPin(normalizePinDigits(e.target.value))}
                />
              </label>
              <label className="ns-tk-dpinfield">
                <span>再確認一次</span>
                <input
                  type="password"
                  className="techo-input ns-tk-din is-pin"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="再輸入一次"
                  autoComplete="off"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(normalizePinDigits(e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitPinForm();
                    }
                  }}
                />
              </label>
            </>
          )}
          {pinErr && (
            <p className="ns-tk-dpinerr" role="alert">
              {pinErr}
            </p>
          )}
          <div className="ns-tk-dpinfoot">
            <button type="button" className="ns-btn ns-btn--sm btn-ghost" disabled={pinBusy} onClick={resetPinForm}>
              取消
            </button>
            <button
              type="button"
              className={"ns-btn ns-btn--sm " + (pinMode === "clear" ? "btn-ghost ns-btn-danger" : "btn-seal")}
              disabled={pinBusy}
              onClick={() => void submitPinForm()}
            >
              {pinMode === "clear" ? "確認關閉密碼鎖" : pinMode === "change" ? "更新密碼" : "啟用密碼鎖"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
