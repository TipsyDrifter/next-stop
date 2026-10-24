/**
 * RepeatEditor——定期規則編輯器（新建與編輯共用；③契約 §5.3；乙席擁有）。宿主＝DesktopDialogHost（寬 620、標題「定期規則」）。
 * 草稿在 store（`repeatDraft`／`setRepeatDraft`／`saveRepeatDraft`）；「取消」／Esc＝`onDone`（宿主接 `closeRepeatEditor`：
 * 從管理頁開的回管理頁、從大票開的直接關；草稿改過的話宿主先問「放棄…？」）。
 * 金額欄沒聚焦時印千分位（「8000」⇒「8,000」），聚焦時是草稿原字；草稿本身不改。
 *
 * 長相照原型席結論（app.js repeatEditor；樣式 ticket.css §N）——620 寬分左右兩欄，不內捲：
 *
 *   div.ns-tk-dialog.ns-tk-re
 *   ├─（從大票帶來的）.ns-tk-re-from「從 10/19 那筆帶過來的；那筆本身不會被重記」
 *   ├─ .ns-tk-re-cols
 *   │   ├─ 左「記什麼」 類型 Segmented 三段・.ns-tk-re-amt（前綴＋金額＋幣別 chip）・.ns-tk-fields.is-re 帳戶／轉入或分類／備註／路線
 *   │   └─ 右「什麼時候」頻率 Segmented 每日｜每週｜每月 → 每週 7 顆星期、每月 1–31 格（7×5；選了 29–31 才出「小月記在月底」）
 *   │                    → 起算日（新規則起算日在過去 ⇒「會補記」提示）・時刻・終止日（選填）
 *   │                    時刻＝共用 ClockInput compact（丙-5 F2，跟大票同一支、同一套換算 ticketClock.ts）：規則沒有「那一天」，
 *   │                    換算借起算日當參考日（refDay＝d.start）、說明行不寫日期（dateLabel={false}，只在打錯時說錯在哪）
 *   ├─ .ns-tk-re-preview  規則一句（repeatLabel）＋右端「第一班 11/5」／「下一班 11/5」／「從 10/5 起補記」；草稿還不完整 ⇒ 原因淡字
 *   └─ DialogFoot         取消・存（主鈕 btn-seal，在右）；丙-5 E3：桌機 portal 進 DialogShell 的黏底 foot（不用捲到底）
 *
 * 帳戶／分類／路線／幣別的挑選元件借大票的（TicketPanel 的 AcctPick／CategoryCombo／RoutePop／Pop），鍵盤與 IME 行為一致。
 * 日期浮層往上開（.ns-dialog-body 是內捲容器，往下開會被裁）。
 */
import { useRef, useState, type ReactNode } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { useNodeStore } from "../../../store/nodeStore";
import { todayKey } from "../../../lib/date";
import { DatePicker } from "../../common/DatePicker";
import { moneyText, parseAmount, type AccountRow } from "../../../domain/ticket";
import { shortDay } from "../../../domain/ticketView";
import { WEEKDAY_LABEL, WEEKDAY_ORDER, firstFixedDate, nextFixedDate, serializeRule } from "../../../domain/repeat";
import { buildRepeatRow, draftToRepeatInput, repeatLabel, type RepeatDraft } from "../../../domain/ticketPlan";
import { useImeGuard } from "../dialogs/dialogBits";
import { DialogFoot } from "../dialogs/DialogFoot";
import { TkIcon, TkRoundel } from "../TicketLedger";
import { AcctPick, CategoryCombo, Pop, RoutePop } from "../TicketPanel";
import { ClockInput, clockDraftsOkIn } from "../../common/ClockInput";
import { Segmented } from "../../common/Segmented";
import { msToWallHHMM, ticketClockBounds, ticketClockValue } from "../ticketClock";

type PopKind = "acct" | "toacct" | "cur" | "route" | "start" | "until" | null;

const KINDS: { k: RepeatDraft["kind"]; label: string }[] = [
  { k: "expense", label: "支出" },
  { k: "income", label: "收入" },
  { k: "transfer", label: "轉帳" },
];
const FREQS: { k: RepeatDraft["freq"]; label: string }[] = [
  { k: "daily", label: "每日" },
  { k: "weekly", label: "每週" },
  { k: "monthly", label: "每月" },
];
const SIGN: Record<RepeatDraft["kind"], string> = { expense: "", income: "＋", transfer: "⇄" };
const ymd = (d: string): string => d.replace(/-/g, "/");
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 金額欄沒聚焦時的樣子：讀得懂就印千分位（「8000」⇒「8,000」；負數 ASCII 減號同大票），讀不懂照原字。草稿本身不改 */
function prettyAmount(text: string, cur: { code: string; decimals: number }): string {
  try {
    const v = parseAmount(text, cur, { allowNegative: true, allowZero: true });
    return (v < 0 ? "-" : "") + moneyText(Math.abs(v), cur.decimals);
  } catch {
    return text;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="lbl">{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export function RepeatEditor({ onDone }: { onDone(): void }) {
  const draft = useTicketStore((s) => s.repeatDraft);
  const dialog = useTicketStore((s) => s.dialog);
  const repeats = useTicketStore((s) => s.repeats);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const currencies = useTicketStore((s) => s.currencies);
  const balances = useTicketStore((s) => s.balances);
  const entries = useTicketStore((s) => s.entries);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [pop, setPop] = useState<PopKind>(null);
  const [busy, setBusy] = useState(false);
  const [amtFocus, setAmtFocus] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const store = useTicketStore.getState;
  const ime = useImeGuard((e) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).blur?.();
    void save();
  });
  if (!draft || !dialog || dialog.kind !== "repeat") return null;
  const d = draft;
  const editingId = dialog.id;
  const editing = editingId ? (repeats.find((r) => r.id === editingId) ?? null) : null;
  const today = todayKey(dayStartHour);
  const set = (p: Partial<RepeatDraft>) => store().setRepeatDraft(p);
  const ctx = { accById, catById, curByCode };
  const acc = d.accountId ? accById[d.accountId] : undefined;
  const toAcc = d.toAccountId ? accById[d.toAccountId] : undefined;
  const route = d.routeId ? routes.find((r) => r.id === d.routeId) : undefined;
  const balText = (a: AccountRow) => moneyText(balances[a.id] ?? 0, curByCode[a.currency]?.decimals ?? 2);
  const fromEntry = d.fromEntryId ? entries.find((e) => e.id === d.fromEntryId) : undefined;
  const isNew = editingId === null;
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(d.start);

  async function save() {
    if (busy) return;
    // 時刻框剛打錯、還沒回去看過 ⇒ 不存、焦點回框（丙-5 風險 1；不擋的話規則會默默用舊時刻存）。「存」鈕 portal 在本文外，所以從本文的根找
    if (!clockDraftsOkIn(rootRef.current)) return;
    setBusy(true);
    try {
      await store().saveRepeatDraft(); // 成功會自己關掉、出 toast；失敗 toast 原因、留在這裡
    } finally {
      setBusy(false);
    }
  }

  /* 預覽：草稿能組成規則就印 repeatLabel＋第一班／下一班；不能就印原因 */
  let previewText = "";
  let previewNext = "";
  let previewErr: string | null = null;
  try {
    const input = draftToRepeatInput(d, ctx);
    const row = buildRepeatRow(input, ctx, { id: editingId ?? "preview", position: 0, nowIso: new Date().toISOString() });
    previewText = repeatLabel(row, ctx);
    if (!isNew) {
      const same = editing && editing.rule === serializeRule(input.rule);
      const n = same ? editing.next_on : nextFixedDate(input.rule, today);
      previewNext = n ? `下一班 ${shortDay(n)}` : "已結束";
    } else if (input.rule.start < today) {
      previewNext = `從 ${shortDay(input.rule.start)} 起補記`;
    } else {
      const n = firstFixedDate(input.rule, input.rule.start);
      previewNext = n ? `第一班 ${shortDay(n)}` : "沒有班次";
    }
  } catch (e) {
    previewErr = errMsg(e);
  }

  const setFreq = (freq: RepeatDraft["freq"]) => {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(d.start) ? d.start : today;
    const p: Partial<RepeatDraft> = { freq };
    if (freq === "weekly" && !d.byweekday.length) p.byweekday = [new Date(start + "T12:00:00").getDay()];
    if (freq === "monthly" && !d.bymonthday.length) p.bymonthday = [parseInt(start.slice(8, 10), 10)];
    set(p);
  };
  const toggle = (list: number[], n: number): number[] => (list.indexOf(n) >= 0 ? list.filter((x) => x !== n) : list.concat(n).sort((a, b) => a - b));

  const left = (
    <div className="ns-tk-re-what">
      <p className="ns-tk-re-sec">記什麼</p>
      <Segmented<RepeatDraft["kind"]>
        aria-label="類型"
        options={KINDS.map((o) => ({ value: o.k, label: o.label }))}
        value={d.kind}
        onChange={(k) => set({ kind: k })}
      />
      <div className="ns-tk-re-amt">
        <span className="sg" aria-hidden>
          {SIGN[d.kind]}
        </span>
        <input
          className="ns-tk-amtin"
          inputMode="decimal"
          autoComplete="off"
          aria-label="金額"
          placeholder="0"
          autoFocus={isNew && !d.amountText}
          value={amtFocus ? d.amountText : prettyAmount(d.amountText, { code: d.currency, decimals: curByCode[d.currency]?.decimals ?? 2 })}
          onFocus={() => setAmtFocus(true)}
          onBlur={() => setAmtFocus(false)}
          onChange={(e) => set({ amountText: e.target.value })}
          {...ime}
        />
        <div className="ns-tk-curwrap">
          <button
            type="button"
            className="ns-tk-curchip"
            aria-label={`幣別 ${d.currency}`}
            aria-haspopup="listbox"
            aria-expanded={pop === "cur"}
            disabled={d.kind === "transfer"}
            title={d.kind === "transfer" ? "轉帳幣別會跟著轉出帳戶" : "換幣別"}
            data-pop-toggle
            onClick={() => setPop(pop === "cur" ? null : "cur")}
          >
            {d.currency}
          </button>
          {pop === "cur" && (
            <Pop label="幣別" onClose={() => setPop(null)} className="is-cur">
              {currencies.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={c.code === d.currency}
                  className={`opt${c.code === d.currency ? " on" : ""}`}
                  onClick={() => {
                    setPop(null);
                    set({ currency: c.code });
                  }}
                >
                  <span className="code">{c.code}</span>
                  {c.name}
                </button>
              ))}
            </Pop>
          )}
        </div>
      </div>
      <div className="ns-tk-fields is-re">
        <Field label={d.kind === "transfer" ? "轉出" : "帳戶"}>
          <AcctPick
            open={pop === "acct"}
            onToggle={() => setPop(pop === "acct" ? null : "acct")}
            onClose={() => setPop(null)}
            acc={acc}
            exclude={null}
            balText={balText}
            onPick={(id) => {
              setPop(null);
              set({ accountId: id });
            }}
          />
        </Field>
        {d.kind === "transfer" ? (
          <Field label="轉入">
            <AcctPick
              open={pop === "toacct"}
              onToggle={() => setPop(pop === "toacct" ? null : "toacct")}
              onClose={() => setPop(null)}
              acc={toAcc}
              exclude={d.accountId}
              balText={balText}
              onPick={(id) => {
                setPop(null);
                set({ toAccountId: id });
              }}
            />
          </Field>
        ) : (
          <Field label="分類">
            {/* manage={false}：已經在對話框裡，開分類管理會把規則編輯器換掉 */}
            <CategoryCombo kind={d.kind} categoryId={d.categoryId} onPick={(id) => set({ categoryId: id })} manage={false} />
          </Field>
        )}
        <Field label="備註">
          <input
            className="ns-tk-textin"
            placeholder="備註"
            aria-label="備註"
            autoComplete="off"
            value={d.note}
            onChange={(e) => set({ note: e.target.value })}
            {...ime}
          />
        </Field>
        <Field label="路線">
          <button
            type="button"
            className={`ns-tk-pick${route ? "" : " is-empty"}`}
            aria-haspopup="listbox"
            aria-expanded={pop === "route"}
            data-pop-toggle
            onClick={() => setPop(pop === "route" ? null : "route")}
          >
            {route ? (
              <>
                <TkRoundel route={route} />
                {route.name}
              </>
            ) : (
              "不掛"
            )}
          </button>
          {pop === "route" && (
            <RoutePop
              routes={routes}
              current={d.routeId}
              onClose={() => setPop(null)}
              onPick={(id) => {
                setPop(null);
                set({ routeId: id });
              }}
            />
          )}
        </Field>
      </div>
    </div>
  );

  const days: number[] = [];
  for (let n = 1; n <= 31; n++) days.push(n);
  const right = (
    <div className="ns-tk-re-when">
      <p className="ns-tk-re-sec">什麼時候</p>
      <Segmented<RepeatDraft["freq"]>
        aria-label="頻率"
        options={FREQS.map((o) => ({ value: o.k, label: o.label }))}
        value={d.freq}
        onChange={setFreq}
      />
      <div className="ns-tk-re-detail">
        {d.freq === "daily" && <p className="ns-tk-re-dailyhint">每天都記一筆</p>}
        {d.freq === "weekly" && (
          <div className="ns-tk-re-wk" role="group" aria-label="星期幾">
            {WEEKDAY_ORDER.map((w) => (
              <button key={w} type="button" aria-pressed={d.byweekday.indexOf(w) >= 0} onClick={() => set({ byweekday: toggle(d.byweekday, w) })}>
                {WEEKDAY_LABEL[w]}
              </button>
            ))}
          </div>
        )}
        {d.freq === "monthly" && (
          <>
            <div className="ns-tk-re-days" role="group" aria-label="每月的哪幾天">
              {days.map((n) => (
                <button key={n} type="button" aria-pressed={d.bymonthday.indexOf(n) >= 0} onClick={() => set({ bymonthday: toggle(d.bymonthday, n) })}>
                  {n}
                </button>
              ))}
            </div>
            {d.bymonthday.some((n) => n > 28) && <p className="ns-tk-re-hint">遇到月底沒有這天，就記在當月最後一天</p>}
          </>
        )}
      </div>
      <div className="ns-tk-fields is-re">
        <Field label="起算日">
          <span className="ns-tk-date">
            <button
              type="button"
              className="ns-tk-datechip"
              aria-haspopup="dialog"
              aria-expanded={pop === "start"}
              data-pop-toggle
              onClick={() => setPop(pop === "start" ? null : "start")}
            >
              {/^\d{4}-\d{2}-\d{2}$/.test(d.start) ? ymd(d.start) : "選日子"}
            </button>
          </span>
          {pop === "start" && (
            <DatePicker
              float
              className="ns-tk-re-datepop"
              label="從哪一天起算"
              value={d.start}
              markValue
              quick={[{ label: "今天", day: today }]}
              onPick={(day) => {
                setPop(null);
                const p: Partial<RepeatDraft> = { start: day };
                if (d.until && d.until < day) p.until = null;
                set(p);
              }}
              onClose={() => setPop(null)}
            />
          )}
        </Field>
        {isNew && d.start < today && /^\d{4}-\d{2}-\d{2}$/.test(d.start) && <p className="ns-tk-re-hint is-past">起算日在過去：會補記從那天起的每一班</p>}
        <Field label="時刻">
          <RuleClock day={validDay ? d.start : today} hhmm={d.hhmm} dayStartHour={dayStartHour} onChange={(hhmm) => set({ hhmm })} />
        </Field>
        <Field label="結束日">
          <span className="ns-tk-date">
            <button
              type="button"
              className={"ns-tk-datechip" + (d.until ? "" : " is-empty")}
              aria-haspopup="dialog"
              aria-expanded={pop === "until"}
              data-pop-toggle
              onClick={() => setPop(pop === "until" ? null : "until")}
            >
              {d.until ? ymd(d.until) : "（選填）"}
            </button>
            {d.until && (
              <button type="button" className="ns-tk-re-clr" aria-label="不設結束日" title="不設結束日" onClick={() => set({ until: null })}>
                <TkIcon name="x" size={10} />
              </button>
            )}
          </span>
          {pop === "until" && (
            <DatePicker
              float
              className="ns-tk-re-datepop"
              label="記到哪一天為止"
              value={d.until}
              markValue
              min={d.start}
              onPick={(day) => {
                setPop(null);
                set({ until: day });
              }}
              onClose={() => setPop(null)}
            />
          )}
        </Field>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="ns-tk-dialog ns-tk-re">
      {fromEntry && <p className="ns-tk-re-from">從 {shortDay(fromEntry.occurred_on)} 那筆帶入，原本那筆不會重複記</p>}
      <div className="ns-tk-re-cols">
        {left}
        {right}
      </div>
      <p className={"ns-tk-re-preview" + (previewErr ? " is-err" : "")} aria-live="polite">
        {previewErr ? (
          <span className="t">還不能存：{previewErr}</span>
        ) : (
          <>
            <span className="t" title={previewText}>
              {previewText}
            </span>
            <span className="nx">{previewNext}</span>
          </>
        )}
      </p>
      {/* E3：按鈕列交給 DialogFoot（桌機 portal 進 DialogShell 的黏底 foot；沒插槽時照舊畫在本文裡） */}
      <DialogFoot>
        <button type="button" className="ns-btn btn-ghost ns-tk-dbtn" onClick={onDone}>
          取消
        </button>
        <button type="button" className="ns-btn btn-seal ns-tk-dbtn" disabled={busy} onClick={() => void save()}>
          存
        </button>
      </DialogFoot>
    </div>
  );
}

/* ── 時刻（丙-5 F2）：共用 ClockInput compact。草稿是牆鐘 "HH:MM"；換算同大票（ticketClock.ts：日界線起 24 小時、存回牆鐘）。
   草稿在 store、按「存」才寫庫 ⇒ 每一步直接改草稿，不用去抖。Enter 只確定時刻（不存整條規則）。
   草稿的字看不懂（理論上不會：只有這一格能改它）⇒ 框裡顯示日界線那一刻，存檔時的檢查會說。 ── */
function RuleClock({ day, hhmm, dayStartHour, onChange }: { day: string; hhmm: string; dayStartHour: number; onChange(hhmm: string): void }) {
  const { lo, hi } = ticketClockBounds(day, dayStartHour);
  const value = ticketClockValue(day, hhmm, dayStartHour) ?? lo;
  return (
    <span className="ns-tk-re-clock">
      <ClockInput variant="compact" label="時刻" value={value} lo={lo} hi={hi} refDay={day} dateLabel={false} onChange={(ms) => onChange(msToWallHHMM(ms))} />
    </span>
  );
}
