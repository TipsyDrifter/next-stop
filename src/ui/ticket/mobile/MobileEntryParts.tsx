/**
 * MobileEntryParts——手機記一筆表單的售票口④新件（D-票-66～70、74；手機席）。MobileEntryForm、MobileRepeatForm、願望面板共用。
 * 拆成獨立檔只為了讓 MobileEntryForm 不再長一倍；不給桌機用（桌機的對應件在 ticket/ 底下，桌機席）。
 *
 * - `TemplateCards`：記一筆最上面一排常用票種小卡（D-票-68）；點了整張填好（store.applyTemplate），只差存檔。沒有常用票種＝整排不出。
 * - `MobileNoteField`：備註欄換共用 RecallInput（D-票-70、71）——打一兩個字，下面推開以前寫過的（一列 44px）；
 *   第一次聚焦才懶載候選（store.loadNoteRecall）。選了以前的由呼叫端決定要不要順手帶分類。
 * - `RepeatQuickRow`：「定期」列（D-票-66）＝四顆小鈕常駐「不重複｜每日｜每週｜每月」；選了以後下一行
 *   「每月 [5 日 ▾] · 結束日 [不設 ▾]」＋一行說明「存檔＝這筆照記，12/5 起自動記」。星期幾／幾號／結束日點了開小面板（RepeatPickSheets）。
 * - `RepeatPickSheets`：上面三顆 chip 開的面板（星期 7 格／1–31 日格／MobileDatePicker 可「不設」）；疊在全螢幕表單上＝"dialog"。
 * - `TagDraftRow`：「更多欄位」裡一列「荷札」（D-票-74）＝牌子（× 常駐）＋「掛荷札」開旅客筆記的點選器 insert 模式，
 *   交回的名稱併進草稿——按「存」才寫（新的一筆、改一筆同法；時刻表塊面板 MobileTagDraft 的做法）。
 * - `TkTag`：售票口手機的荷札牌（`.ns-tk-mtag`，造型同旅客筆記手機牌：細框、左端切角、打孔；只用 --tag-* token，不借別線的 class）。
 * 樣式全在 `ticket-4-mobile.css`。
 */
import { useState, type ReactNode } from "react";
import { isTicketAmountMasked, useTicketStore } from "../../../store/ticketStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { MSheet } from "../../common/MSheet";
import { Segmented } from "../../common/Segmented";
import { RecallInput } from "../../common/RecallInput";
import { MobileDatePicker } from "../../common/MobileDatePicker";
import { shortDayKey } from "../../common/DatePicker";
import { keyOf } from "../../../domain/tags";
import {
  currencySymbol,
  mainCurrencyOf,
  maskedMoneyText,
  moneyText,
  parseAmount,
  type AccountRow,
  type CurrencyRow,
  type EntryRow,
  type TemplateRow,
} from "../../../domain/ticket";
import {
  INSTALLMENT_PRESETS,
  MAX_INSTALLMENTS,
  MIN_INSTALLMENTS,
  installmentProgressOf,
  planInstallmentSlices,
} from "../../../domain/ticketInstallment";
import { REPEAT_QUICK_FREQS, REPEAT_QUICK_TEXT, quickFirstRun, type RepeatQuick, type RepeatQuickFreq } from "../../../domain/ticketPlan";
import { WEEKDAY_LABEL, WEEKDAY_ORDER } from "../../../domain/repeat";
import { dayStep, shortDay } from "../../../domain/ticketView";
import { IconCaret, IconPlus } from "./mobileBits";

/* ═══════════ 常用票種小卡 ═══════════ */

/** 小卡上的金額：支出 −120、收入 ＋15,000、轉帳 ⇄ 500；外幣後面帶代碼；沒存金額＝「—」（點了金額欄空著讓人打） */
export function templateAmountText(
  t: Pick<TemplateRow, "kind" | "amount_minor" | "currency" | "account_id">,
  accById: Readonly<Record<string, AccountRow>>,
  curByCode: Readonly<Record<string, CurrencyRow>>,
  masked = false,
): string {
  if (t.amount_minor === null) return "—";
  const mainCode = mainCurrencyOf(Object.values(curByCode));
  const code = t.currency ?? (t.account_id ? accById[t.account_id]?.currency : undefined) ?? mainCode;
  if (masked) {
    return maskedMoneyText(code, { prefix: t.kind === "income" ? "＋" : t.kind === "transfer" ? "⇄" : "−", withSymbol: false });
  }
  const dec = curByCode[code]?.decimals ?? 2;
  const abs = Math.abs(t.amount_minor);
  const body = t.kind === "expense" ? moneyText(-abs, dec) : moneyText(abs, dec, { prefix: t.kind === "income" ? "＋" : "⇄" });
  return code === mainCode ? body : `${body} ${code}`;
}

export function TemplateCards({ activeId }: { activeId: string | null }) {
  const templates = useTicketStore((s) => s.templates);
  const accById = useTicketStore((s) => s.accById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const masked = useTicketStore(isTicketAmountMasked);
  const applyTemplate = useTicketStore((s) => s.applyTemplate);
  if (templates.length === 0) return null;
  const mainCode = mainCurrencyOf(Object.values(curByCode));
  return (
    <div className="ns-tk-m4-marks" role="group" aria-label="常用票種">
      {templates.map((t) => {
        const on = t.id === activeId;
        const item = (t.item ?? "").trim();
        const showItem = item !== "" && item !== t.name.trim();
        const feeAccCur = (t.account_id ? accById[t.account_id]?.currency : undefined) ?? t.currency ?? mainCode;
        const feeDec = curByCode[feeAccCur]?.decimals ?? 2;
        const feeLabel =
          t.fee_minor && t.fee_minor > 0
            ? masked
              ? `+費 ${maskedMoneyText(feeAccCur, { withSymbol: false })}`
              : `+費 ${currencySymbol(feeAccCur)} ${moneyText(t.fee_minor, feeDec)}`
            : null;
        return (
          <button
            key={t.id}
            type="button"
            className={"ns-tk-m4-mark" + (on ? " on" : "")}
            data-kind={t.kind}
            aria-pressed={on}
            onClick={() => void applyTemplate(t.id)}
          >
            <span className="n">
              {t.name}
              {showItem && <small className="it"> · {item}</small>}
            </span>
            <span className="v">
              {templateAmountText(t, accById, curByCode, masked)}
              {feeLabel && <small className="fee">{feeLabel}</small>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ═══════════ 品項／來源（接 RecallInput 歷史補完） ═══════════ */

export function MobileNoteField({
  value,
  onChange,
  onPick,
  rows = 1,
  label = "品項",
  ariaLabel = "品項／來源",
  placeholder = "店家、品項或來源…",
}: {
  value: string;
  onChange(next: string): void;
  /** 選了以前寫過的某一句（值已經換成它） */
  onPick?(text: string): void;
  rows?: number;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const items = useTicketStore((s) => s.noteRecall);
  const load = useTicketStore((s) => s.loadNoteRecall);
  return (
    <div className="ns-tk-mf-field top ns-tk-m4-note">
      <span className="lbl" aria-hidden>
        {label}
      </span>
      <RecallInput
        multiline={rows > 1}
        rows={rows}
        value={value}
        onChange={onChange}
        items={items}
        onNeedItems={() => void load()}
        onPick={(it) => onPick?.(it.text)}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        className="ns-tk-mf-note"
        wrapClassName="ns-tk-m4-recall"
        shell="mobile"
      />
    </div>
  );
}

/* ═══════════ 隨筆備註（純感想欄，絕不接 RecallInput） ═══════════ */

export function MobileMemoField({
  value,
  onChange,
  rows = 2,
}: {
  value: string;
  onChange(next: string): void;
  rows?: number;
}) {
  return (
    <div className="ns-tk-mf-field top ns-tk-m4-memo">
      <span className="lbl" aria-hidden>
        隨筆
      </span>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="隨筆備註"
        placeholder="隨筆感想（不進補完）…"
        className="ns-tk-mf-note ns-tk-mf-memo"
        autoComplete="off"
      />
    </div>
  );
}

/* ═══════════ 手續費獨立選填欄（44px 觸控高度＋幣別前綴＋實扣提示） ═══════════ */

export function MobileFeeField({
  value,
  onChange,
  kind,
  feeCurrency,
  entryCurrency,
  amountMinor,
  curByCode,
}: {
  value: string;
  onChange(next: string): void;
  kind: "expense" | "income" | "transfer";
  feeCurrency: string;
  entryCurrency: string;
  amountMinor: number | null;
  curByCode: Readonly<Record<string, CurrencyRow>>;
}) {
  const feeCur = curByCode[feeCurrency];
  const dec = feeCur?.decimals ?? 2;
  const sym = currencySymbol(feeCurrency);

  let feeMinor: number | null = null;
  let feeErr: string | null = null;
  if (value.trim() !== "") {
    if (feeCur) {
      try {
        const parsed = parseAmount(value, feeCur, { allowNegative: true, allowZero: true });
        if (parsed < 0) feeErr = "手續費不能是負數";
        else if (parsed > 0) feeMinor = parsed;
      } catch (e) {
        feeErr = e instanceof Error ? e.message : "格式不正確";
      }
    }
  }

  let hint: string | null = null;
  if (feeMinor !== null && feeMinor > 0) {
    const sameCur = feeCurrency === entryCurrency;
    if (amountMinor !== null && sameCur) {
      if (kind === "expense") {
        hint = `含手續費實扣 ${sym} ${moneyText(amountMinor + feeMinor, dec)}`;
      } else if (kind === "transfer") {
        hint = `轉出帳戶實扣 ${sym} ${moneyText(amountMinor + feeMinor, dec)}`;
      } else {
        hint = `扣除手續費實收 ${sym} ${moneyText(amountMinor - feeMinor, dec)}`;
      }
    } else {
      hint =
        kind === "income"
          ? `另從帳戶扣除手續費 ${sym} ${moneyText(feeMinor, dec)}`
          : `另從帳戶加扣手續費 ${sym} ${moneyText(feeMinor, dec)}`;
    }
  }

  return (
    <div className="ns-tk-m4-fee">
      <div className="ns-tk-mf-field">
        <span className="lbl" aria-hidden>
          手續費
        </span>
        <div className="ns-tk-m4-feein">
          <span className="sym" aria-hidden>
            {sym}
          </span>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            enterKeyHint="done"
            value={value}
            placeholder="0（選填）"
            aria-label="手續費"
            onChange={(e) => onChange(e.target.value)}
          />
          {value.trim() !== "" && (
            <button type="button" className="clr" aria-label="清除手續費" onClick={() => onChange("")}>
              ×
            </button>
          )}
        </div>
      </div>
      {feeErr ? (
        <p className="ns-tk-m4-feehint is-err" role="status">
          {feeErr}
        </p>
      ) : hint ? (
        <p className="ns-tk-m4-feehint">{hint}</p>
      ) : null}
    </div>
  );
}

/* ═══════════ 刷卡分期設定（新支出限定） ═══════════ */

export function MobileInstallmentField({
  periods,
  onChange,
  amountMinor,
  feeMinor,
  currency,
  curByCode,
  dayKey,
}: {
  periods: number | null;
  onChange(next: number | null): void;
  amountMinor: number | null;
  feeMinor: number | null;
  currency: string;
  curByCode: Readonly<Record<string, CurrencyRow>>;
  dayKey: string;
}) {
  const isPreset = periods !== null && (INSTALLMENT_PRESETS as readonly number[]).includes(periods);
  const [customOpen, setCustomOpen] = useState(periods !== null && !isPreset);
  const [customText, setCustomText] = useState(periods !== null && !isPreset ? String(periods) : "");
  const showCustom = customOpen || (periods !== null && !isPreset);

  const cur = curByCode[currency];
  const dec = cur?.decimals ?? 2;
  const sym = currencySymbol(currency);

  const pickNone = () => {
    setCustomOpen(false);
    setCustomText("");
    onChange(null);
  };
  const pickPreset = (n: number) => {
    setCustomOpen(false);
    onChange(n);
  };
  const pickCustom = () => {
    setCustomOpen(true);
    const parsed = parseInt(customText.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= MIN_INSTALLMENTS && parsed <= MAX_INSTALLMENTS) {
      onChange(parsed);
    } else if (periods === null || isPreset) {
      const def = 10;
      setCustomText(String(def));
      onChange(def);
    }
  };
  const onCustomInput = (raw: string) => {
    const clean = raw.replace(/[^\d]/g, "").slice(0, 2);
    setCustomText(clean);
    const n = parseInt(clean, 10);
    if (Number.isInteger(n) && n >= MIN_INSTALLMENTS && n <= MAX_INSTALLMENTS) {
      onChange(n);
    }
  };

  let summary: string | null = null;
  if (periods !== null && periods >= MIN_INSTALLMENTS) {
    if (amountMinor !== null && amountMinor > 0) {
      try {
        const slices = planInstallmentSlices({
          totalAmountMinor: amountMinor,
          periods,
          firstOccurredOn: dayKey,
          feeMinor,
        });
        const first = slices[0];
        const second = slices[1];
        const last = slices[slices.length - 1];
        const feeNote = feeMinor && feeMinor > 0 ? "（手續費併入首期）" : "";
        if (first.amountMinor !== second.amountMinor) {
          summary = `首期 ${sym} ${moneyText(first.amountMinor, dec)}，第 2–${periods} 期各 ${sym} ${moneyText(second.amountMinor, dec)} · 至 ${shortDayKey(last.occurredOn)}${feeNote}`;
        } else {
          summary = `每期 ${sym} ${moneyText(first.amountMinor, dec)} × ${periods} 期 · 至 ${shortDayKey(last.occurredOn)}${feeNote}`;
        }
      } catch {
        summary = `分 ${periods} 期`;
      }
    } else {
      summary = `分 ${periods} 期 · 填寫金額後試算每期攤還`;
    }
  }

  return (
    <div className="ns-tk-m4-inst">
      <div className="ns-tk-mf-field top">
        <span className="lbl" aria-hidden>
          分期
        </span>
        <div className="ns-tk-m4-instbox">
          <div className="ns-tk-m4-instpills" role="radiogroup" aria-label="刷卡分期">
            <button
              type="button"
              role="radio"
              aria-checked={!showCustom && periods === null}
              className={"ns-tk-m4-instpill" + (!showCustom && periods === null ? " on" : "")}
              onClick={pickNone}
            >
              不分期
            </button>
            {INSTALLMENT_PRESETS.map((n) => {
              const active = !showCustom && periods === n;
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={"ns-tk-m4-instpill" + (active ? " on" : "")}
                  onClick={() => pickPreset(n)}
                >
                  {n} 期
                </button>
              );
            })}
            <button
              type="button"
              role="radio"
              aria-checked={showCustom}
              className={"ns-tk-m4-instpill" + (showCustom ? " on" : "")}
              onClick={pickCustom}
            >
              自訂
            </button>
          </div>
          {showCustom && (
            <label className="ns-tk-m4-instcust">
              <span>期數</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={customText}
                placeholder={`${MIN_INSTALLMENTS}–${MAX_INSTALLMENTS}`}
                aria-label="自訂分期期數"
                onChange={(e) => onCustomInput(e.target.value)}
              />
              <small>期（{MIN_INSTALLMENTS}–{MAX_INSTALLMENTS}）</small>
            </label>
          )}
          {summary && <p className="ns-tk-m4-instsum">{summary}</p>}
        </div>
      </div>
    </div>
  );
}

/* ═══════════ 既有分期帳進度卡 ═══════════ */

export function MobileInstallmentProgressCard({
  entry,
  groupRows,
  today,
  curByCode,
  masked,
}: {
  entry: EntryRow;
  groupRows: readonly EntryRow[] | null;
  today: string;
  curByCode: Readonly<Record<string, CurrencyRow>>;
  masked: boolean;
}) {
  if (!entry.installment_group_id) return null;
  const prog = groupRows ? installmentProgressOf(groupRows, entry.installment_group_id, today) : null;
  const mainCur = mainCurrencyOf(curByCode);
  const mainCode = mainCur.code;
  const mainDec = mainCur.decimals;
  const mainSym = currencySymbol(mainCode);

  const fmt = (minor: number) =>
    masked ? maskedMoneyText(mainCode) : `${mainSym} ${moneyText(minor, mainDec)}`;

  const idx = entry.installment_index ?? 1;
  const total = prog?.totalPeriods ?? entry.installment_total ?? 1;
  const posted = prog?.postedCount ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((posted / total) * 100)) : 0;

  return (
    <section className="ns-tk-m4-instcard" aria-label="刷卡分期進度">
      <div className="hd">
        <span className="t">刷卡分期進度</span>
        <span className="badge">
          第 {idx} / {total} 期
        </span>
      </div>
      {prog ? (
        <>
          <div className="bar" role="progressbar" aria-valuenow={posted} aria-valuemin={0} aria-valuemax={total}>
            <span className="fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="meta">
            <span>
              已入帳 <b>{prog.postedCount}</b> 期 · <b>{fmt(prog.postedMainMinor)}</b>
            </span>
            <span>
              剩餘 <b>{prog.remainingCount}</b> 期 · <b>{fmt(prog.remainingMainMinor)}</b>
            </span>
          </div>
          <p className="next">
            {prog.nextDueOn ? `下期入帳：${shortDayKey(prog.nextDueOn)}` : "已全數入帳"}
            {prog.aliveCount < prog.totalPeriods && `（現存 ${prog.aliveCount} 期）`}
          </p>
        </>
      ) : (
        <p className="next">讀取分期進度…</p>
      )}
    </section>
  );
}

/* ═══════════ 定期列 ═══════════ */

const FREQ_OPTIONS = REPEAT_QUICK_FREQS.map((f) => ({ value: f, label: REPEAT_QUICK_TEXT[f] }));

export type RepeatPick = "week" | "day" | "until";

/** chip「5 日 ▾」「不設 ▾」 */
function PickChip({ empty, label, onClick, children }: { empty?: boolean; label: string; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" className={"ns-tk-m4-repchip" + (empty ? " is-empty" : "")} aria-haspopup="dialog" aria-label={label} onClick={onClick}>
      {children}
      <IconCaret size={10} />
    </button>
  );
}

/** 重複圖示（說明行前面那顆；16 viewBox／1.3 筆觸） */
/** 結束日 chip 的字：寫到年（「2026/12/31」，跨年的結束日看得出是哪一年；同桌機） */
const untilText = (key: string): string => key.replace(/-/g, "/");

const IconRepeat = () => (
  <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7.5a5 5 0 0 1 8.6-3.4L13 5.5M13 2.5v3h-3M13 8.5a5 5 0 0 1-8.6 3.4L3 10.5M3 13.5v-3h3" />
  </svg>
);

/**
 * 「定期」列。新的一筆＝草稿的 repeat（store）；改一筆（還沒連規則、按了「設成定期…」）＝本地狀態，按「存」才建規則。
 * 說明行＝`lead`＋第一班怎麼記（新：「存檔＝這筆照記，」；舊：「按「存」之後，」）：第一班在未來「12/5 起自動記」、
 *   就是今天「今天起自動記」、已經過了「11/6 起的會補記到今天」（記帳日在過去，存檔當場補記——store 的行為）；
 *   結束日早於第一班「結束日之前沒有下一班」。字跟桌機定期列同一套說法。
 * `onMore`＝「更多設定…」開完整規則編輯器（每 N 週、一次選好幾天這類進階規則；只有改一筆給）。
 */
export function RepeatQuickRow({
  value,
  dayKey,
  lead,
  onFreq,
  onPick,
  onMore,
}: {
  value: RepeatQuick;
  dayKey: string;
  lead: string;
  onFreq(f: RepeatQuickFreq): void;
  onPick(which: RepeatPick): void;
  onMore?(): void;
}) {
  const today = todayKey(useUiStore((s) => s.dayStartHour));
  const first = quickFirstRun(value, dayKey);
  const hint =
    first === null
      ? "結束日之前沒有下一班"
      : first < today
        ? `${lead}${shortDay(first)} 起的會補記到今天`
        : first === today
          ? `${lead}今天起自動記`
          : `${lead}${shortDay(first)} 起自動記`;
  return (
    <div className="ns-tk-m4-rep">
      <div className="ns-tk-mf-field">
        <span className="lbl" aria-hidden>
          定期
        </span>
        <div className="seg">
          <Segmented options={FREQ_OPTIONS} value={value.freq} onChange={onFreq} aria-label="定期" />
        </div>
      </div>
      {value.freq !== "none" && (
        <div className="ns-tk-m4-repbox">
          <div className="when">
            {value.freq === "daily" ? (
              <span>每日</span>
            ) : value.freq === "weekly" ? (
              <>
                <span>每週</span>
                <PickChip label={`星期幾：週${WEEKDAY_LABEL[value.weekday]}`} onClick={() => onPick("week")}>
                  {WEEKDAY_LABEL[value.weekday]}
                </PickChip>
              </>
            ) : (
              <>
                <span>每月</span>
                <PickChip label={`每月幾日：${value.monthday} 日`} onClick={() => onPick("day")}>
                  {value.monthday} 日
                </PickChip>
              </>
            )}
            <span className="sep" aria-hidden>
              ·
            </span>
            <span>結束日</span>
            <PickChip empty={!value.until} label={`結束日：${value.until ? untilText(value.until) : "不設"}`} onClick={() => onPick("until")}>
              {value.until ? untilText(value.until) : "不設"}
            </PickChip>
          </div>
          <p className="hint">
            <IconRepeat />
            {hint}
          </p>
          {onMore && (
            <button type="button" className="ns-btn ns-btn--sm btn-text more" aria-haspopup="dialog" onClick={onMore}>
              更多設定…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const DAYS_1_31 = Array.from({ length: 31 }, (_, i) => i + 1);

/**
 * 定期列 chip 開的面板：星期 7 格（一到日）／1–31 日格（單選；選了就關）／結束日（月格，「不設」＝清掉）。
 * 疊在全螢幕表單上 ⇒ backKind "dialog"；backId 由呼叫端給（它已用 useBackLayer 登記同一個 id）。
 */
export function RepeatPickSheets({
  which,
  value,
  dayKey,
  backId,
  onChange,
  onClose,
}: {
  which: RepeatPick | null;
  value: RepeatQuick;
  dayKey: string;
  backId: string;
  onChange(q: RepeatQuick): void;
  onClose(): void;
}) {
  if (which === "week") {
    return (
      <MSheet title="每週哪一天" onClose={onClose} backId={backId} backKind="dialog" className="ns-tk-m4-pick">
        <div className="ns-tk-mre-wk" role="group" aria-label="星期幾">
          {WEEKDAY_ORDER.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={value.weekday === w}
              onClick={() => {
                onChange({ ...value, weekday: w });
                onClose();
              }}
            >
              {WEEKDAY_LABEL[w]}
            </button>
          ))}
        </div>
      </MSheet>
    );
  }
  if (which === "day") {
    return (
      <MSheet title="每月幾日" onClose={onClose} backId={backId} backKind="dialog" className="ns-tk-m4-pick">
        <div className="ns-tk-mre-days" role="group" aria-label="每月幾日">
          {DAYS_1_31.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={value.monthday === n}
              aria-label={`${n} 日`}
              onClick={() => {
                onChange({ ...value, monthday: n });
                onClose();
              }}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="ns-tk-mre-hint">遇到月底沒有這天，就記在當月最後一天</p>
      </MSheet>
    );
  }
  if (which === "until") {
    // 最早＝第一班（結束日早於第一班＝一班都不會記）；沒有第一班就從記帳日隔天起
    const min = quickFirstRun({ ...value, until: null }, dayKey) ?? dayStep(dayKey, 1);
    return (
      <MobileDatePicker
        title="記到哪一天為止"
        value={value.until}
        min={min}
        quick={[
          { label: "今年底", day: `${dayKey.slice(0, 4)}-12-31` },
          { label: "一年後", day: dayStep(dayKey, 365) },
        ].filter((q) => q.day >= min)}
        onPick={(day) => {
          onChange({ ...value, until: day });
          onClose();
        }}
        onClear={() => {
          onChange({ ...value, until: null });
          onClose();
        }}
        clearLabel="不設"
        onClose={onClose}
        backId={backId}
        backKind="dialog"
      />
    );
  }
  return null;
}

/* ═══════════ 荷札 ═══════════ */

/** 名稱三段式：父層淡、末段正常、分隔 /（牌上不印 #） */
function TagSegs({ name }: { name: string }) {
  const segs = name.split(/[/／]/);
  const out: ReactNode[] = [];
  segs.forEach((s, i) => {
    if (i) out.push(<i key={`s${i}`} className="sl">/</i>);
    out.push(
      <span key={i} className={i < segs.length - 1 ? "pa" : "la"}>
        {s}
      </span>,
    );
  });
  return <>{out}</>;
}

/** 一張荷札牌（× 常駐：觸控沒有 hover） */
export function TkTag({ name, onRemove }: { name: string; onRemove?(): void }) {
  return (
    <span className="ns-tk-mtag">
      <span className="face" aria-hidden />
      <span className="nm">
        <TagSegs name={name} />
      </span>
      {onRemove && (
        <button type="button" className="x" aria-label={`拿掉 #${name}`} onClick={onRemove}>
          <svg width={10} height={10} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </span>
  );
}

/** 名稱併進草稿（同 key 不重複；不合法的名字照原字比，存檔時 store 會擋下並說明） */
export function mergeTagNames(cur: readonly string[], add: readonly string[]): string[] {
  const out = cur.slice();
  const have = new Set(cur.map((n) => keyOf(n) ?? n));
  for (const n of add) {
    const k = keyOf(n) ?? n;
    if (have.has(k)) continue;
    have.add(k);
    out.push(n);
  }
  return out;
}

/** 「＋ 掛荷札」（虛線框；字同旅客筆記、時刻表） */
export function TagAddButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="ns-tk-m4-tagadd" aria-haspopup="dialog" onClick={onClick}>
      <IconPlus size={11} />
      掛荷札
    </button>
  );
}

/**
 * 「更多欄位」裡的荷札列（草稿）：牌子＋「掛荷札」。點選器 insert 模式（標題 `title`），交回的名稱併進草稿，按「存」才寫。
 */
export function TagDraftRow({ value, onChange, title }: { value: readonly string[]; onChange(names: string[]): void; title: string }) {
  const open = () =>
    useTagStore.getState().openPicker({
      mode: "insert",
      entityType: null,
      entityId: null,
      name: "",
      title,
      onInsert: (names) => {
        if (names.length) onChange(mergeTagNames(value, names));
      },
    });
  return (
    <div className="ns-tk-mf-field ns-tk-m4-tagrow">
      <span className="lbl" aria-hidden>
        荷札
      </span>
      <div className="tags" role="group" aria-label="荷札">
        {value.length === 0 && <span className="none">沒有掛</span>}
        {value.map((n, i) => (
          <TkTag key={(keyOf(n) ?? n) + "|" + i} name={n} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
        ))}
        <TagAddButton onClick={open} />
      </div>
    </div>
  );
}

/** 「更多欄位」摘要裡的荷札：「#3C」「#3C 等 2 個」；沒有＝null */
export function tagSummary(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const head = `#${names[0].replace(/^#/, "")}`;
  return names.length === 1 ? head : `${head} 等 ${names.length} 個`;
}
