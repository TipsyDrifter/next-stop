/**
 * TicketPanel——售票口桌機頁的右側詳情板（車次①契約 §5.1、0-1、0-3、0-8、0-30；乙席）。
 *
 *   aside.ns-tk-panel（寬 360、自己捲；store.panel＝none 時不渲染）＋右上 ×（收起）
 *   ├─【票版】article.ns-tk-bigticket[data-kind]（攤開的大票；材質抄 .ticket::before 配方、打孔在票根撕線兩端）
 *   │   ├─ .ns-tk-bt-stub   類型三選（校正票唯讀「精算」）＋ No.MMDD-nn
 *   │   ├─ .ns-tk-bt-amt    前綴＋金額大字 input＋幣別 chip（小選單）；外幣下一行 .ns-tk-conv「≈ NT$ 3,155 · 匯率 31.55」可點改折算額
 *   │   ├─ .ns-tk-bt-seal   検印位（TicketSeal）
 *   │   ├─ .ns-tk-fields    帳戶／轉入／（轉入金額）／分類 combobox／日期＋時刻／備註／路線
 *   │   └─ .ns-tk-bt-foot   新票：存檔 Enter・存並再記 Ctrl+Enter・Esc 放棄；舊票：刪除 Del＋「已存」
 *   └─【帳戶版】article.ns-tk-acctcard：名稱（行內改）・群組・幣別（有餘額鎖）・目前餘額＋調整餘額…・封存
 *
 * 新票＝明確存檔（Enter／Ctrl+Enter；store.setDraft／saveDraft）；舊票＝即時存（金額 600ms 去抖、其餘改了就送；
 * store.updateEntry，0-8）。輸入欄的鍵（ticket-entry scope）由本檔自理：Enter 存、Ctrl+Enter 存並再記、Esc 放棄／收起、
 * 分類欄 ↑↓ 選候選；小浮層的 ↑↓／Enter／Esc 不漏給頁面的鍵盤表。
 * 只讀 store、只叫 store 的動作（§2.5）；domain 的純函式直接用。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { useNodeStore } from "../../store/nodeStore";
import { addDays, todayKey } from "../../lib/date";
import { CommitInput, CommitTextarea, FieldRow, useDebouncedCommit } from "../panel/fields";
import { DatePicker } from "../common/DatePicker";
import {
  ACCOUNT_GROUPS,
  MAIN_CURRENCY,
  MAIN_SYMBOL,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  atOf,
  categoryLabel,
  convertMinor,
  dayLabel,
  groupAccounts,
  localTime,
  matchCategories,
  moneyText,
  parseAmount,
  planAdjust,
  serialOf,
  type AccountGroup,
  type AccountRow,
  type CategoryRow,
  type CurrencyRow,
  type EntryDraft,
  type EntryKind,
  type EntryPatch,
  type EntryRow,
  type Prefix,
} from "../../domain/ticket";
import type { NodeRow } from "../../domain/node";
import { Money } from "./parts/Money";
import { TicketSeal } from "./parts/TicketSeal";
import { TkIcon, TkRoundel, acctLabel, capsOf, groupLabel } from "./TicketLedger";

/* ───────── 小工具 ───────── */

const PREFIX: Record<EntryKind, Prefix> = { income: "＋", expense: "", transfer: "⇄", adjust: "±" };
const KINDS: { k: "expense" | "income" | "transfer"; label: string }[] = [
  { k: "expense", label: "支出" },
  { k: "income", label: "收入" },
  { k: "transfer", label: "轉帳" },
];

const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const toast = (message: string): void => useUiStore.getState().showToast({ message });

/** 輸入欄裡的金額字（不帶前綴；負數用 ASCII 減號，parseAmount 讀得懂；千分位保留） */
function amountInputText(minor: number, decimals: number): string {
  return (minor < 0 ? "-" : "") + moneyText(Math.abs(minor), decimals);
}

/** 解析失敗回 null（打字中途的不完整字串不吵人） */
function tryParse(text: string, cur: { code: string; decimals: number }, allowNegative: boolean, allowZero = false): number | null {
  try {
    return parseAmount(text, cur, { allowNegative, allowZero });
  } catch {
    return null;
  }
}

/** 主幣別列（is_main＝1；沒有就 TWD） */
function mainCurrency(curByCode: Record<string, CurrencyRow>): CurrencyRow | undefined {
  for (const k of Object.keys(curByCode)) if (curByCode[k].is_main === 1) return curByCode[k];
  return curByCode[MAIN_CURRENCY];
}

/** 點外面收起（帶 data-pop-toggle 的開關鈕除外——讓它自己切換） */
function useOutside(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || ref.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-pop-toggle]")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [ref, onClose]);
}

/**
 * 小浮層 .ns-tk-pop（帳戶／路線／幣別）：開啟時焦點落在選中的那一項（或搜尋欄、或第一項）；
 * ↑↓ 在選項間移動、Enter＝按鈕原生 click、Esc 收起；這幾個鍵都不漏給頁面鍵盤表。
 */
function Pop({ label, onClose, children, className, search }: { label: string; onClose(): void; children: ReactNode; className?: string; search?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, onClose);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = search ? el.querySelector<HTMLElement>("input") : (el.querySelector<HTMLElement>(".opt.on") ?? el.querySelector<HTMLElement>(".opt"));
    first?.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }, [search]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const opts = Array.from(ref.current?.querySelectorAll<HTMLElement>(".opt:not([disabled])") ?? []);
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!opts.length) return;
      const n = opts.length;
      const j = i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      opts[j].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && i < 0 && opts.length && search) {
      e.preventDefault();
      opts[0].click(); // 搜尋欄 Enter＝挑第一個符合的
    } else if (e.key !== "Tab") {
      return;
    }
    e.stopPropagation();
  };
  return (
    <div ref={ref} className={`ns-tk-pop${className ? ` ${className}` : ""}`} role="listbox" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/* ───────── 詳情板 ───────── */

export interface TicketPanelProps {
  /** 剛存好、要蓋章動畫的那一筆 id（TicketView 給） */
  freshId: string | null;
  /** 焦點還給帳簿（Esc 收起後） */
  onBackToList(): void;
}

export function TicketPanel({ freshId, onBackToList }: TicketPanelProps) {
  const panel = useTicketStore((s) => s.panel);
  const draft = useTicketStore((s) => s.draft);
  const entries = useTicketStore((s) => s.entries);
  const results = useTicketStore((s) => s.results);
  const accById = useTicketStore((s) => s.accById);

  if (panel.kind === "none") return null;
  let body: ReactNode = null;
  if (panel.kind === "new" && draft) body = <BigTicket key="new" row={null} fresh={false} onBackToList={onBackToList} />;
  else if (panel.kind === "entry") {
    // 第②階段：搜尋結果跨月（②契約 0-15），選中的那筆可能不在已載的月份裡 ⇒ 也從 results 找
    const row = entries.find((e) => e.id === panel.id) ?? results?.find((e) => e.id === panel.id);
    if (row) body = <BigTicket key={row.id} row={row} fresh={freshId === row.id} onBackToList={onBackToList} />;
  } else if (panel.kind === "account") {
    const acc = accById[panel.id];
    if (acc) body = <AcctCard key={acc.id} acc={acc} />;
  }
  if (!body) return null;
  return (
    <aside className="ns-tk-panel techo-scroll" aria-label="詳情板">
      <button
        type="button"
        className="ns-tk-panelx"
        title={`收起（${capsOf("ticket.escape")}）`}
        aria-label="收起"
        onClick={() => {
          useTicketStore.getState().requestEscape();
          onBackToList();
        }}
      >
        <TkIcon name="x" size={13} />
      </button>
      {body}
    </aside>
  );
}

/* ───────── 大票 ───────── */

type PopKind = "acct" | "toacct" | "cur" | "route" | "date" | null;

interface Vm {
  kind: EntryKind;
  currency: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  dayKey: string;
  time: string;
  note: string;
  routeId: string | null;
}

function BigTicket({ row, fresh, onBackToList }: { row: EntryRow | null; fresh: boolean; onBackToList(): void }) {
  const isNew = row === null;
  const draft = useTicketStore((s) => s.draft);
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const currencies = useTicketStore((s) => s.currencies);
  const curByCode = useTicketStore((s) => s.curByCode);
  const balances = useTicketStore((s) => s.balances);
  const entries = useTicketStore((s) => s.entries);
  const savedAt = useTicketStore((s) => s.savedAt);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const routes = useNodeStore((s) => s.routes);
  const [pop, setPop] = useState<PopKind>(null);
  const amtRef = useRef<HTMLInputElement>(null);
  const store = useTicketStore.getState;
  const today = todayKey(dayStartHour);

  const vm: Vm = row
    ? {
        kind: row.kind,
        currency: row.currency,
        accountId: row.account_id,
        toAccountId: row.to_account_id,
        categoryId: row.category_id,
        dayKey: row.occurred_on,
        time: localTime(row.occurred_at),
        note: row.note,
        routeId: row.route_id,
      }
    : {
        kind: draft?.kind ?? "expense",
        currency: draft?.currency ?? MAIN_CURRENCY,
        accountId: draft?.accountId ?? null,
        toAccountId: draft?.toAccountId ?? null,
        categoryId: draft?.categoryId ?? null,
        dayKey: draft?.dayKey ?? today,
        time: draft?.time ?? "",
        note: draft?.note ?? "",
        routeId: draft?.routeId ?? null,
      };
  const cur = curByCode[vm.currency];
  const decimals = cur?.decimals ?? 2;
  const main = mainCurrency(curByCode);
  const mainDec = main?.decimals ?? 2;
  const foreign = vm.currency !== (main?.code ?? MAIN_CURRENCY);
  const acc = vm.accountId ? accById[vm.accountId] : undefined;
  const toAcc = vm.toAccountId ? accById[vm.toAccountId] : undefined;
  const route = vm.routeId ? routes.find((r) => r.id === vm.routeId) : undefined;
  const allowNeg = vm.kind === "expense" || vm.kind === "adjust";

  /* 舊票：改欄位＝即時存（store 失敗會自己 toast） */
  const patch = (p: EntryPatch) => {
    if (row) void store().updateEntry(row.id, p);
  };

  /* ── 金額 ── */
  const [amtLocal, setAmtLocal] = useState(row ? amountInputText(row.amount_minor, decimals) : "");
  const rowAmt = row?.amount_minor;
  useEffect(() => {
    if (row && document.activeElement !== amtRef.current) setAmtLocal(amountInputText(row.amount_minor, decimals));
  }, [rowAmt, decimals]); // eslint-disable-line react-hooks/exhaustive-deps
  const amtCommit = useDebouncedCommit<string>((text) => {
    if (!row || !cur) return;
    const v = tryParse(text, cur, allowNeg);
    if (v !== null && v !== row.amount_minor) patch({ amountMinor: v });
  }, 600);
  const amountText = isNew ? (draft?.amountText ?? "") : amtLocal;
  const amountMinor = cur ? tryParse(amountText, cur, allowNeg) : null;

  const onAmount = (text: string) => {
    if (isNew) store().setDraft({ amountText: text });
    else {
      setAmtLocal(text);
      amtCommit.schedule(text);
    }
  };
  const onAmountBlur = () => {
    if (isNew || !row || !cur) return;
    amtCommit.cancel();
    try {
      const v = parseAmount(amtLocal, cur, { allowNegative: allowNeg });
      if (v !== row.amount_minor) patch({ amountMinor: v });
      setAmtLocal(amountInputText(v, decimals));
    } catch (e) {
      toast(errMsg(e));
      setAmtLocal(amountInputText(row.amount_minor, decimals));
    }
  };

  // 新票：開啟時焦點在金額
  useEffect(() => {
    if (isNew) amtRef.current?.focus();
  }, [isNew]);

  /* ── 折算（外幣）── */
  const [convEdit, setConvEdit] = useState(false);
  let convMinor: number | null = null;
  if (foreign && cur && main) {
    if (row) convMinor = row.main_minor;
    else if (draft?.mainOverrideText) convMinor = tryParse(draft.mainOverrideText, main, true);
    else if (amountMinor !== null) convMinor = convertMinor(amountMinor, cur, main);
  }
  const commitConv = (text: string) => {
    setConvEdit(false);
    if (!main) return;
    if (isNew) {
      store().setDraft({ mainOverrideText: text.trim() === "" ? null : text });
      return;
    }
    if (text.trim() === "") return;
    try {
      patch({ override: { mainMinor: parseAmount(text, main, { allowNegative: allowNeg }) } });
    } catch (e) {
      toast(errMsg(e));
    }
  };

  /* ── 轉入金額（不同幣別轉帳）── */
  const toCur = toAcc ? curByCode[toAcc.currency] : undefined;
  const crossCur = vm.kind === "transfer" && !!acc && !!toAcc && acc.currency !== toAcc.currency;
  let toAutoMinor: number | null = null;
  if (crossCur && cur && toCur && amountMinor !== null) toAutoMinor = convertMinor(amountMinor, cur, toCur);

  /* ── 類型 ── */
  const setKind = (k: "expense" | "income" | "transfer") => {
    if (k === vm.kind) return;
    if (isNew) {
      const seed: Partial<EntryDraft> = { kind: k };
      if (k === "transfer" && !vm.toAccountId) {
        const other = accounts.find((a) => a.deleted_at === null && a.archived_at === null && a.id !== vm.accountId);
        if (other) seed.toAccountId = other.id;
      }
      store().setDraft(seed);
      return;
    }
    if (k === "transfer") {
      const other = vm.toAccountId ?? accounts.find((a) => a.deleted_at === null && a.archived_at === null && a.id !== vm.accountId)?.id ?? null;
      patch({ kind: k, toAccountId: other });
    } else patch({ kind: k });
  };

  /* ── 存檔（新票）── */
  const save = async (again: boolean) => {
    const ok = await store().saveDraft({ again });
    if (ok && again) amtRef.current?.focus();
  };
  const onTicketKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const t = e.target as HTMLElement;
    const editable = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
    if (isNew && e.key === "Enter" && editable && !e.shiftKey && !e.altKey) {
      if (t.closest(".ns-tk-pop, .ns-datepick")) return;
      e.preventDefault();
      e.stopPropagation();
      void save(e.ctrlKey || e.metaKey);
      return;
    }
    if (e.key === "Escape" && editable && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      if (!isNew) (t as HTMLInputElement).blur(); // 舊票：先把正在改的送出
      store().requestEscape();
      if (useTicketStore.getState().panel.kind === "none") onBackToList();
    }
  };

  const savedFlash = !isNew && savedAt !== null && Date.now() - savedAt < 2500;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!savedFlash) return;
    const t = setTimeout(() => tick((n) => n + 1), 2600);
    return () => clearTimeout(t);
  }, [savedAt, savedFlash]);

  const serial = row ? serialOf(row, entries.filter((x) => x.occurred_on === row.occurred_on)) : "NEW";
  const dayText = vm.dayKey === today ? "今天" : dayLabel(vm.dayKey);
  const balText = (a: AccountRow) => moneyText(balances[a.id] ?? 0, curByCode[a.currency]?.decimals ?? 2);

  return (
    <article
      className={`ns-tk-bigticket${isNew ? " is-new" : ""}`}
      data-kind={vm.kind}
      aria-label={isNew ? "新票" : "這一筆"}
      onKeyDown={onTicketKeyDown}
    >
      <div className="ns-tk-bt-stub">
        {vm.kind === "adjust" ? (
          <span className="ns-tk-kind is-locked" title="精算票：類型不能切">
            精算
          </span>
        ) : (
          <span className="ns-tk-kind" role="group" aria-label="類型">
            {KINDS.map((o) => (
              <button key={o.k} type="button" aria-pressed={vm.kind === o.k} onClick={() => setKind(o.k)}>
                {o.label}
              </button>
            ))}
          </span>
        )}
        <span className="ns-tk-serial">{serial}</span>
      </div>

      <div className="ns-tk-bt-face">
        <div className="ns-tk-bt-amt">
          <span className="sg" aria-hidden>
            {PREFIX[vm.kind]}
          </span>
          <input
            ref={amtRef}
            className="ns-tk-amtin"
            inputMode="decimal"
            autoComplete="off"
            aria-label="金額"
            placeholder="0"
            value={amountText}
            onChange={(e) => onAmount(e.target.value)}
            onBlur={onAmountBlur}
          />
          <div className="ns-tk-curwrap">
            <button
              type="button"
              className="ns-tk-curchip"
              aria-label={`幣別 ${vm.currency}`}
              aria-haspopup="listbox"
              aria-expanded={pop === "cur"}
              disabled={vm.kind === "transfer" || vm.kind === "adjust"}
              title={vm.kind === "transfer" ? "轉帳的幣別跟著轉出帳戶" : "換幣別"}
              data-pop-toggle
              onClick={() => setPop(pop === "cur" ? null : "cur")}
            >
              {vm.currency}
            </button>
            {pop === "cur" && (
              <Pop label="幣別" onClose={() => setPop(null)} className="is-cur">
                {currencies.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={c.code === vm.currency}
                    className={`opt${c.code === vm.currency ? " on" : ""}`}
                    onClick={() => {
                      setPop(null);
                      if (isNew) store().setDraft({ currency: c.code });
                      else patch({ currency: c.code });
                    }}
                  >
                    <span className="code">{c.code}</span>
                    {c.name}
                    <span className="r">{c.is_main === 1 ? "主幣別" : `1 ＝ ${c.rate_to_main}`}</span>
                  </button>
                ))}
              </Pop>
            )}
          </div>
        </div>
        {foreign && cur && (
          <div className="ns-tk-conv">
            ≈ {MAIN_SYMBOL}{" "}
            {convEdit ? (
              <ConvInput
                initial={convMinor !== null ? moneyText(Math.abs(convMinor), mainDec) : ""}
                onDone={commitConv}
                onCancel={() => setConvEdit(false)}
              />
            ) : (
              <button type="button" title="改折算額" onClick={() => setConvEdit(true)}>
                <b>{convMinor !== null ? moneyText(convMinor, mainDec) : "—"}</b>
              </button>
            )}{" "}
            · 匯率 {cur.rate_to_main}
            {isNew && draft?.mainOverrideText && (
              <button type="button" className="ns-tk-convreset" onClick={() => store().setDraft({ mainOverrideText: null })}>
                照匯率
              </button>
            )}
          </div>
        )}

        <div className="ns-tk-bt-seal">
          <TicketSeal kind={vm.kind} fresh={fresh} />
        </div>

        <div className="ns-tk-fields">
          <FieldRow label={vm.kind === "transfer" ? "轉出" : "帳戶"}>
            <AcctPick
              open={pop === "acct"}
              onToggle={() => setPop(pop === "acct" ? null : "acct")}
              onClose={() => setPop(null)}
              acc={acc}
              exclude={null}
              balText={balText}
              onPick={(id) => {
                setPop(null);
                if (isNew) store().setDraft({ accountId: id });
                else patch({ accountId: id });
              }}
            />
          </FieldRow>
          {vm.kind === "transfer" && (
            <FieldRow label="轉入">
              <AcctPick
                open={pop === "toacct"}
                onToggle={() => setPop(pop === "toacct" ? null : "toacct")}
                onClose={() => setPop(null)}
                acc={toAcc}
                exclude={vm.accountId}
                balText={balText}
                onPick={(id) => {
                  setPop(null);
                  if (isNew) store().setDraft({ toAccountId: id, toAmountText: null });
                  else patch({ toAccountId: id });
                }}
              />
            </FieldRow>
          )}
          {crossCur && toAcc && toCur && (
            <FieldRow label="轉入額">
              <ToAmountField
                key={row ? `${row.id}-${row.to_amount_minor}` : "new"}
                isNew={isNew}
                currency={toAcc.currency}
                placeholder={toAutoMinor !== null ? moneyText(toAutoMinor, toCur.decimals) : "自動換算"}
                value={isNew ? (draft?.toAmountText ?? "") : row?.to_amount_minor != null ? moneyText(row.to_amount_minor, toCur.decimals) : ""}
                onDraft={(text) => store().setDraft({ toAmountText: text === "" ? null : text })}
                onCommit={(text) => {
                  try {
                    patch({ override: { toAmountMinor: parseAmount(text, toCur, { allowNegative: false }) } });
                  } catch (e) {
                    toast(errMsg(e));
                  }
                }}
              />
            </FieldRow>
          )}
          {(vm.kind === "expense" || vm.kind === "income") && (
            <FieldRow label="分類">
              <CategoryCombo
                kind={vm.kind}
                categoryId={vm.categoryId}
                onPick={(id) => {
                  if (isNew) store().setDraft({ categoryId: id });
                  else patch({ categoryId: id });
                }}
              />
            </FieldRow>
          )}
          <FieldRow label="日期">
            <span className="ns-tk-date">
              <button
                type="button"
                className="ns-tk-datechip"
                aria-haspopup="dialog"
                aria-expanded={pop === "date"}
                data-pop-toggle
                onClick={() => setPop(pop === "date" ? null : "date")}
              >
                {dayText}
              </button>
              <TimeField
                value={vm.time}
                onCommit={(hhmm) => {
                  if (isNew) store().setDraft({ time: hhmm });
                  else {
                    try {
                      patch({ occurredAt: atOf(vm.dayKey, hhmm, dayStartHour) });
                    } catch (e) {
                      toast(errMsg(e));
                    }
                  }
                }}
              />
            </span>
            {pop === "date" && (
              <DatePicker
                float
                className="ns-tk-datepop"
                label="記在哪一天"
                value={vm.dayKey}
                markValue
                max={today}
                quick={[
                  { label: "今天", day: today },
                  { label: "昨天", day: addDays(today, -1) },
                  { label: "前天", day: addDays(today, -2) },
                ]}
                onPick={(day) => {
                  setPop(null);
                  if (isNew) store().setDraft({ dayKey: day });
                  else {
                    try {
                      patch({ occurredOn: day, occurredAt: atOf(day, vm.time, dayStartHour) });
                    } catch (e) {
                      toast(errMsg(e));
                    }
                  }
                }}
                onClose={() => setPop(null)}
              />
            )}
          </FieldRow>
          <FieldRow label="備註" top>
            {isNew ? (
              <textarea
                className="ns-tk-textin"
                rows={1}
                placeholder="一句話"
                aria-label="備註"
                value={vm.note}
                onChange={(e) => store().setDraft({ note: e.target.value })}
              />
            ) : (
              <div className="ns-tk-notewrap">
                <CommitTextarea value={vm.note} rows={1} ariaLabel="備註" placeholder="一句話" onCommit={(note) => patch({ note })} />
              </div>
            )}
          </FieldRow>
          {vm.kind !== "adjust" && (
            <FieldRow label="路線">
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
                  current={vm.routeId}
                  onClose={() => setPop(null)}
                  onPick={(id) => {
                    setPop(null);
                    if (isNew) store().setDraft({ routeId: id });
                    else patch({ routeId: id });
                  }}
                />
              )}
            </FieldRow>
          )}
        </div>

        <div className="ns-tk-bt-foot">
          {isNew ? (
            <>
              <button type="button" className="ns-tk-btn primary" onClick={() => void save(false)}>
                存檔<kbd className="ns-tk-kbd">{capsOf("ticket-entry.save")}</kbd>
              </button>
              <button type="button" className="ns-tk-btn" onClick={() => void save(true)}>
                存並再記<kbd className="ns-tk-kbd">{capsOf("ticket-entry.again")}</kbd>
              </button>
              <span className="ns-tk-esc">{capsOf("ticket-entry.escape")} 放棄</span>
            </>
          ) : (
            <>
              <button type="button" className="ns-tk-btn quiet danger" onClick={() => row && void store().deleteEntry(row.id)}>
                刪除<kbd className="ns-tk-kbd">{capsOf("ticket.delete")}</kbd>
              </button>
              <span className={`ns-tk-saved${savedFlash ? " flash" : ""}`} aria-live="polite">
                {savedFlash ? "已存" : "即時存檔"}
              </span>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

/* ── 帳戶挑選鈕＋浮層（依群組分區；封存的不列） ── */
function AcctPick(props: {
  open: boolean;
  onToggle(): void;
  onClose(): void;
  acc: AccountRow | undefined;
  exclude: string | null;
  balText(a: AccountRow): string;
  onPick(id: string): void;
}) {
  const accounts = useTicketStore((s) => s.accounts);
  const groups = groupAccounts(accounts);
  return (
    <>
      <button
        type="button"
        className={`ns-tk-pick${props.acc ? "" : " is-empty"}`}
        aria-haspopup="listbox"
        aria-expanded={props.open}
        data-pop-toggle
        onClick={props.onToggle}
      >
        {props.acc ? (
          <>
            {props.acc.name}
            <span className="sub">
              {groupLabel(props.acc.group_key)} · {props.balText(props.acc)}
              {props.acc.archived_at !== null && " · 已封存"}
            </span>
          </>
        ) : (
          "選一個帳戶"
        )}
      </button>
      {props.open && (
        <Pop label="帳戶" onClose={props.onClose}>
          {groups.map(({ group, accounts: list }) => {
            const opts = list.filter((a) => a.id !== props.exclude);
            if (!opts.length) return null;
            return (
              <div key={group.key} role="group" aria-label={group.label}>
                <div className="hd">{group.label}</div>
                {opts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="option"
                    aria-selected={props.acc?.id === a.id}
                    className={`opt${props.acc?.id === a.id ? " on" : ""}`}
                    onClick={() => props.onPick(a.id)}
                  >
                    {acctLabel(a, accounts)}
                    <span className="r">
                      {props.balText(a)}
                      {a.currency !== MAIN_CURRENCY && <small> {a.currency}</small>}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          {groups.length === 0 && <div className="hd">還沒有帳戶</div>}
          <div className="sep" />
          <button
            type="button"
            className="opt is-add"
            onClick={() => {
              props.onClose();
              useTicketStore.getState().openDialog({ kind: "newAccount" });
            }}
          >
            <TkIcon name="plus" size={11} />
            新增帳戶
          </button>
        </Pop>
      )}
    </>
  );
}

/* ── 路線浮層（只到路線，D-票 K3；頂部搜尋） ── */
function RoutePop({ routes, current, onClose, onPick }: { routes: NodeRow[]; current: string | null; onClose(): void; onPick(id: string | null): void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return routes;
    return routes.filter((r) => r.name.toLowerCase().indexOf(k) >= 0 || (r.code ?? "").toLowerCase().indexOf(k) >= 0);
  }, [routes, q]);
  return (
    <Pop label="路線" onClose={onClose} search>
      <div className="search">
        <TkIcon name="search" size={12} />
        <input className="ns-tk-textin" placeholder="找路線" aria-label="找路線" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!q && (
        <button type="button" role="option" aria-selected={current === null} className={`opt${current === null ? " on" : ""}`} onClick={() => onPick(null)}>
          <TkRoundel route={null} />
          不掛
        </button>
      )}
      {list.map((r) => (
        <button key={r.id} type="button" role="option" aria-selected={current === r.id} className={`opt${current === r.id ? " on" : ""}`} onClick={() => onPick(r.id)}>
          <TkRoundel route={r} />
          {r.name}
          {r.code && <span className="path">{r.code}</span>}
        </button>
      ))}
      {list.length === 0 && <div className="hd">找不到「{q}」</div>}
    </Pop>
  );
}

/* ── 分類 combobox（打字即搜：子分類優先、顯示「主 › 子」；空白列最近用過；↑↓ Enter） ── */
function CategoryCombo({ kind, categoryId, onPick }: { kind: "income" | "expense"; categoryId: string | null; onPick(id: string | null): void }) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const recent = useTicketStore((s) => s.recent[kind]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [kb, setKb] = useState(-1); // -1＝還沒挑（空白時 Enter 留給新票存檔）
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useOutside(wrapRef, () => setOpen(false));

  const cat = categoryId && !isUncat(categoryId) ? catById[categoryId] : undefined;
  const label = cat ? categoryLabel(cat, catById) : "";
  const options: CategoryRow[] = useMemo(() => {
    if (q.trim()) return matchCategories(q, categories, kind).slice(0, 12);
    return recent.map((id) => catById[id]).filter((c): c is CategoryRow => !!c && c.deleted_at === null && c.archived_at === null && c.kind === kind);
  }, [q, categories, kind, recent, catById]);

  // 挑完只收浮層、焦點留在欄上（不 blur：焦點掉到 body 會讓 Enter 存檔／Esc 放棄／Tab 移欄全接不到）
  const pick = (id: string | null) => {
    setOpen(false);
    setQ("");
    setKb(-1);
    if (id !== categoryId) onPick(id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!open) setOpen(true);
      const n = options.length;
      if (n) setKb((i) => (i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n));
    } else if (e.key === "Enter" && open && options[kb]) {
      // 打了字或用 ↑↓ 挑過：Enter＝挑反白那一個（新票的「Enter 存檔」要等分類挑完）
      e.preventDefault();
      e.stopPropagation();
      pick(options[kb].id);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQ("");
    }
  };

  return (
    <div ref={wrapRef} className="ns-tk-catwrap">
      <input
        ref={inputRef}
        className="ns-tk-catin"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label="分類"
        autoComplete="off"
        placeholder={cat ? "" : "打字搜尋，或選最近用過"}
        value={open ? q : label}
        onFocus={() => {
          setOpen(true);
          setQ("");
          setKb(-1);
        }}
        onClick={() => {
          // 挑完焦點還在欄上：再點一下重開浮層（onFocus 不會再觸發）
          if (!open) {
            setOpen(true);
            setQ("");
            setKb(-1);
          }
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setKb(e.target.value.trim() ? 0 : -1);
          setOpen(true);
        }}
        onBlur={(e) => {
          // 點浮層的選項時 mousedown 已 preventDefault，不會走到這裡；真的離開欄位才收
          if (wrapRef.current?.contains(e.relatedTarget as Node)) return;
          setOpen(false);
          setQ("");
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="ns-tk-pop is-cat" role="listbox" aria-label="分類候選" onMouseDown={(e) => e.preventDefault()}>
          {options.length > 0 ? (
            <>
              <div className="hd">{q.trim() ? "符合" : "最近用過"}</div>
              {options.map((c, i) => {
                const p = c.parent_id ? catById[c.parent_id] : undefined;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={i === kb}
                    tabIndex={-1}
                    className={`opt${i === kb ? " kb" : ""}${c.id === categoryId ? " on" : ""}`}
                    onClick={() => pick(c.id)}
                  >
                    {p && <span className="path">{p.name} ›</span>}
                    {c.name}
                  </button>
                );
              })}
            </>
          ) : (
            <div className="hd">{q.trim() ? `找不到「${q.trim()}」` : "還沒有用過的分類——打字搜尋"}</div>
          )}
          {cat && (
            <>
              <div className="sep" />
              <button type="button" tabIndex={-1} className="opt is-quiet" onClick={() => pick(null)}>
                改回未分類
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── 時刻（小字「14:32」可點改；Enter／blur 送、Esc 還原） ── */
function TimeField({ value, onCommit }: { value: string; onCommit(hhmm: string): void }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(value);
  if (!edit) {
    return (
      <button
        type="button"
        className="ns-tk-time"
        title="改時刻"
        onClick={() => {
          setText(value);
          setEdit(true);
        }}
      >
        {value}
      </button>
    );
  }
  const done = () => {
    setEdit(false);
    const t = text.trim();
    if (t && t !== value) onCommit(t);
  };
  return (
    <input
      className="ns-tk-timein"
      autoFocus
      aria-label="時刻"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          done();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setEdit(false);
        }
      }}
    />
  );
}

/* ── 折算額的行內輸入 ── */
function ConvInput({ initial, onDone, onCancel }: { initial: string; onDone(text: string): void; onCancel(): void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  return (
    <input
      className="ns-tk-convin"
      autoFocus
      inputMode="decimal"
      aria-label="折算額"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (!done.current) onDone(text);
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onDone(text);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}

/* ── 轉入金額（不同幣別轉帳；空＝照匯率自動） ── */
function ToAmountField(props: {
  isNew: boolean;
  currency: string;
  placeholder: string;
  value: string;
  onDraft(text: string): void;
  onCommit(text: string): void;
}) {
  const [text, setText] = useState(props.value);
  return (
    <span className="ns-tk-toamt">
      <input
        className="ns-tk-textin"
        inputMode="decimal"
        aria-label="轉入金額"
        placeholder={props.placeholder}
        value={props.isNew ? props.value : text}
        onChange={(e) => (props.isNew ? props.onDraft(e.target.value) : setText(e.target.value))}
        onBlur={() => {
          if (!props.isNew && text.trim() !== "" && text !== props.value) props.onCommit(text);
        }}
      />
      <small>{props.currency}</small>
    </span>
  );
}

/* ───────── 帳戶版 ───────── */

function AcctCard({ acc }: { acc: AccountRow }) {
  const accounts = useTicketStore((s) => s.accounts);
  const currencies = useTicketStore((s) => s.currencies);
  const curByCode = useTicketStore((s) => s.curByCode);
  const balances = useTicketStore((s) => s.balances);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const store = useTicketStore.getState;
  const [adj, setAdj] = useState<string | null>(null);
  const adjRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  const bal = balances[acc.id] ?? 0;
  const cur = curByCode[acc.currency];
  const dec = cur?.decimals ?? 2;
  const liability = ACCOUNT_GROUPS.some((g) => g.key === acc.group_key && g.liability);
  // 幣別鎖：store 沒有「這個帳戶有沒有帳」——有餘額一定有帳，先鎖；餘額 0 但有帳的由 repository 擋（toast）
  const locked = bal !== 0;
  const archived = acc.archived_at !== null;

  let diff: number | null = null;
  if (adj !== null && adj.trim() !== "" && cur) {
    const t = tryParse(adj, cur, true, true);
    if (t !== null) diff = planAdjust(bal, t) ?? 0;
  }
  const hint =
    adj === null || adj.trim() === ""
      ? "填目標餘額，會生成一筆「精算」補上差額"
      : diff === null
        ? "看不懂這個數字"
        : diff === 0
          ? "和目前餘額相同，不用精算"
          : null;

  const confirmAdj = async () => {
    if (adj === null) return;
    const ok = await store().adjustBalance(acc.id, adj);
    if (ok) {
      setAdj(null);
      setTimeout(() => cardRef.current?.querySelector<HTMLButtonElement>(".ns-tk-adj button")?.focus(), 0);
    }
  };

  return (
    <article ref={cardRef} className="ns-tk-acctcard" aria-label="帳戶詳情">
      <div className="ns-tk-ac-over">
        帳戶{liability ? " · 負債" : ""}
        {archived ? " · 已封存" : ""}
      </div>
      <CommitInput
        className="ns-tk-ac-name"
        value={acc.name}
        ariaLabel="帳戶名稱"
        required
        onCommit={(name) => void store().updateAccount(acc.id, { name })}
      />
      <div className="ns-tk-fields is-acct">
        <FieldRow label="群組">
          <select
            className="ns-tk-select"
            aria-label="群組"
            value={ACCOUNT_GROUPS.some((g) => g.key === acc.group_key) ? acc.group_key : "other"}
            onChange={(e) => void store().updateAccount(acc.id, { group: e.target.value as AccountGroup })}
          >
            {ACCOUNT_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
                {g.liability ? "（負債）" : ""}
              </option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="幣別" top={locked}>
          <select
            className="ns-tk-select"
            aria-label="幣別"
            value={acc.currency}
            disabled={locked}
            onChange={(e) => void store().updateAccount(acc.id, { currency: e.target.value })}
          >
            {currencies.map((c) => (
              <option key={c.id} value={c.code}>
                {c.code} {c.name}
              </option>
            ))}
          </select>
          {locked && <span className="ns-tk-lock">已有帳，幣別鎖定</span>}
        </FieldRow>
      </div>

      <div className="ns-tk-balance">
        <span className="lbl">目前餘額</span>
        <div className="v">
          <Money minor={bal} currency={acc.currency} />
          <small>{acc.currency}</small>
        </div>
        <div className="ns-tk-adj">
          {adj === null ? (
            <button
              type="button"
              className="ns-tk-btn"
              onClick={() => {
                setAdj("");
                setTimeout(() => adjRef.current?.focus(), 0);
              }}
            >
              調整餘額…
            </button>
          ) : (
            <>
              <div className="ns-tk-adjrow">
                <label>
                  目標餘額
                  <input
                    ref={adjRef}
                    className="ns-tk-textin"
                    inputMode="decimal"
                    value={adj}
                    placeholder={amountInputText(bal, dec)}
                    onChange={(e) => setAdj(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        void confirmAdj();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setAdj(null);
                      }
                    }}
                  />
                </label>
                <button type="button" className="ns-tk-btn primary" disabled={!diff} onClick={() => void confirmAdj()}>
                  確定
                </button>
                <button type="button" className="ns-tk-btn quiet" onClick={() => setAdj(null)}>
                  取消
                </button>
              </div>
              <p className="ns-tk-adjhint" aria-live="polite">
                {hint ?? (
                  <>
                    會生成一筆精算 <b>{diff !== null && diff > 0 ? "＋" : ""}{diff !== null ? moneyText(diff, dec) : ""}</b>（備註「餘額調整」）
                  </>
                )}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="ns-tk-acctfoot">
        {archived ? (
          <button type="button" className="ns-tk-btn quiet" onClick={() => void store().unarchiveAccount(acc.id)}>
            取消封存
          </button>
        ) : (
          <button type="button" className="ns-tk-btn quiet" onClick={() => store().archiveAccount(acc.id)}>
            封存
          </button>
        )}
        <button
          type="button"
          className="ns-tk-btn quiet"
          aria-pressed={filterAccountId === acc.id}
          onClick={() => void store().setFilter(filterAccountId === acc.id ? null : acc.id)}
        >
          {filterAccountId === acc.id ? "看全部帳" : "只看這個帳戶"}
        </button>
        <span className="note">{archived ? "仍計入合計" : acctLabel(acc, accounts) !== acc.name ? groupLabel(acc.group_key) : ""}</span>
      </div>
    </article>
  );
}
