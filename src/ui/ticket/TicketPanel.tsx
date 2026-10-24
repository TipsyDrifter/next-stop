/**
 * TicketPanel——售票口桌機頁的右側詳情板（車次①契約 §5.1、0-1、0-3、0-8、0-30；乙席）。
 * UI 丙-5 C1：殼換共用 `SidePanelFrame skin="ticket"`＝詳情側板的票皮變體（視覺規範 §2.4：同殼、340、× 在紙右上＝P1 A 案）；
 * 票券解剖畫在紙裡，不再是浮在 aside 裡的另一張卡。
 *
 *   aside.panel.ns-tk-panel[data-skin=ticket]（SidePanelFrame：寬 --panel-w 340、紙、從右滑入、× 在紙右上；store.panel＝none 時不渲染）
 *   ├─【票版】article.ns-tk-bigticket[data-kind]（攤開的大票；撕線左端打一個孔＝.panel-sheet 的 mask，位置跟著撕線走）
 *   │   ├─ .ns-tk-bt-stub   類型 Segmented（校正票唯讀「精算」）＋ No.MMDD-nn（右邊讓出 ×）
 *   │   ├─ .ns-tk-bt-tear   撕線（橫跨整張紙）
 *   │   ├─ .ns-tk-bt-face   前綴＋金額大字 input＋幣別 chip（小選單）；外幣下一行 .ns-tk-conv「≈ NT$ 3,155 · 匯率 31.55」可點改折算額
 *   │   │                    ＋ .ns-tk-bt-seal 検印位（TicketSeal）＋ .ns-tk-fields 帳戶／轉入／（轉入金額）／分類 combobox／日期 DateChip／
 *   │   │                    時刻 ClockInput compact（P2 A 案：獨立一列，說明行只在跨天時出現）／備註／路線
 *   │   └─ .ns-tk-bt-foot   操作列黏在紙底：新票＝存並再記 Ctrl+Enter・存檔 Enter（主鈕在右）・Esc 放棄；舊票＝刪除 Del＋「已存」
 *   └─【帳戶版】article.ns-tk-acctcard：名稱（行內改）・群組・幣別（有餘額鎖）・目前餘額＋調整餘額…・封存（同一支殼，C3）
 *
 * 新票＝明確存檔（Enter／Ctrl+Enter；store.setDraft／saveDraft）；舊票＝即時存（金額 600ms 去抖、時刻 400ms 去抖、其餘改了就送；
 * store.updateEntry，0-8）。輸入欄的鍵（ticket-entry scope）由本檔自理：Enter 存、Ctrl+Enter 存並再記、Esc 放棄／收起、
 * 分類欄 ↑↓ 選候選；小浮層的 ↑↓／Enter／Esc 不漏給頁面的鍵盤表。
 * 時刻框（.ns-clock）裡的 Enter 讓給 ClockInput：看得懂才叫 onEnter 存檔，打錯只還原、不存（丙-5 F1／風險 1）。
 * Esc（C2）：殼的 onEscape＝requestEscape（新票有內容先問；不直接關）；× 也走同一條。
 * 只讀 store、只叫 store 的動作（§2.5）；domain 的純函式直接用。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { useNodeStore } from "../../store/nodeStore";
import { todayKey } from "../../lib/date";
import { CommitInput, CommitTextarea, FieldRow, useDebouncedCommit } from "../common/fields";
import { SidePanelFrame } from "../common/SidePanelFrame";
import { Segmented } from "../common/Segmented";
import { DateChip } from "../common/DateChip";
import { ClockInput, clockDraftsOkIn } from "../common/ClockInput";
import {
  ACCOUNT_GROUPS,
  MAIN_CURRENCY,
  MAIN_SYMBOL,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  atOf,
  categoryLabel,
  convertMinor,
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
import { RepeatField, RepeatMakeButton, useLinkedRepeat } from "./plan/RepeatField";
import { msToWallHHMM, ticketClockBounds, ticketClockValue } from "./ticketClock";

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
export function useOutside(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
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
export function Pop({ label, onClose, children, className, search }: { label: string; onClose(): void; children: ReactNode; className?: string; search?: boolean }) {
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
  return <TicketFrame onBackToList={onBackToList}>{body}</TicketFrame>;
}

/**
 * 側板殼（SidePanelFrame 票皮）。× 與 Esc 都走 requestEscape（新票有內容先問；舊票／帳戶版直接收）——
 * 不用 closePanel：它不問就丟草稿（舊的 × 也是 requestEscape）。收起了才把焦點還給帳簿。
 *
 * 焦點：殼一掛上就把焦點拉進面板（核心側板的規則）。但售票口是「選一行就開」：↑↓ 在帳簿上走、點一行，
 * 焦點本來就該留在帳簿（不然下一個 ↑↓ 落在面板裡、鍵盤表不接）。所以掛上那一刻焦點原本在帳簿（或頁根）上的，還回去；
 * 要進面板的路（N、Enter／雙擊開帳、書封帳戶 ›）各自會把焦點放進來（金額欄或面板本身）。
 * 父層的 effect 晚於子層：這裡跑的時候 SidePanelFrame 已經 focus 過面板。
 */
function TicketFrame({ onBackToList, children }: { onBackToList(): void; children: ReactNode }) {
  const escape = () => {
    useTicketStore.getState().requestEscape();
    if (useTicketStore.getState().panel.kind === "none") onBackToList();
  };
  // 掛上之前（render 時）焦點在哪：只在第一次 render 記
  const before = useRef<Element | null | undefined>(undefined);
  if (before.current === undefined) before.current = typeof document !== "undefined" ? document.activeElement : null;
  useEffect(() => {
    const prev = before.current;
    if (useTicketStore.getState().panel.kind !== "entry") return; // 新票（金額欄自己拿焦點）、帳戶版（書封 › 開的）照殼的規則
    if (!(prev instanceof HTMLElement) || !prev.isConnected) return;
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || !a.classList.contains("ns-tk-panel")) return; // 子層已把焦點放進欄位：不搶
    if (prev.closest(".ns-tk-list") || prev.matches(".page.ns-tk")) prev.focus({ preventScroll: true });
  }, []);
  return (
    <SidePanelFrame skin="ticket" className="ns-tk-panel" ariaLabel="詳情板" closeLabel="收起詳情板" onClose={escape} onEscape={escape}>
      {children}
    </SidePanelFrame>
  );
}

/* ───────── 大票 ───────── */

type PopKind = "acct" | "toacct" | "cur" | "route" | null;

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
  const linkedRepeat = useLinkedRepeat(row); // 第③階段：連著還在的規則才出「定期」列（規則已刪 ⇒ 底部出「設成定期…」）
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

  // 新票：開啟時焦點在金額。殼（SidePanelFrame）第一次掛上會在這之後把焦點拉到面板本身 ⇒ 下一拍再放一次
  useEffect(() => {
    if (!isNew) return;
    amtRef.current?.focus();
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (a === null || a === document.body || (a instanceof HTMLElement && a.classList.contains("ns-tk-panel"))) amtRef.current?.focus();
    });
    return () => clearTimeout(t);
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

  /* ── 時刻（丙-5 F1：共用 ClockInput compact；換算在 ticketClock.ts——存回一律牆鐘，不用 panel/clockValue 的 msToClock）──
     範圍＝這個帳日的日界線起 24 小時；新票改草稿（Enter 才存），舊票先換畫面、400ms 去抖才 updateEntry（±15 長按不會每格寫庫），
     離開大票（卸載）時 useDebouncedCommit 會立刻送出。 */
  const { lo: clockLo, hi: clockHi } = ticketClockBounds(vm.dayKey, dayStartHour);
  /** 舊票：畫面上的時刻（去抖中、還沒寫回）；null＝跟著 row 走 */
  const [clockDraft, setClockDraft] = useState<number | null>(null);
  const clockPending = useRef(false);
  const clockCommit = useDebouncedCommit<number>((ms) => {
    clockPending.current = false;
    if (row && ms !== Date.parse(row.occurred_at)) patch({ occurredAt: new Date(ms).toISOString() });
    else setClockDraft(null);
  }, 400);
  const rowAt = row?.occurred_at;
  useEffect(() => {
    if (!clockPending.current) setClockDraft(null); // 寫回的值回來了（或別處改了、換了一天）
  }, [rowAt, vm.dayKey]);
  const clockMs = row ? (clockDraft ?? Date.parse(row.occurred_at)) : (ticketClockValue(vm.dayKey, vm.time, dayStartHour) ?? clockLo);
  const onClock = (ms: number) => {
    if (isNew) {
      store().setDraft({ time: msToWallHHMM(ms) });
      return;
    }
    clockPending.current = true;
    setClockDraft(ms);
    clockCommit.schedule(ms);
  };
  /** 改日期時帶著的時刻：舊票去抖中的那個也算（送出前先收掉，免得兩筆 updateEntry 互蓋） */
  const takeClockHHMM = (): string => {
    if (clockDraft === null) return vm.time;
    clockCommit.cancel();
    clockPending.current = false;
    return msToWallHHMM(clockDraft);
  };

  /* ── 存檔（新票）──
     存檔鈕、存並再記、別的欄的 Enter／Ctrl+Enter 都走這裡：時刻框剛打錯、還沒回去看過 ⇒ 不存、焦點回框（風險 1；
     不擋的話打的字已還原成舊時刻，會默默存進去）。 */
  const save = async (again: boolean) => {
    if (!clockDraftsOkIn(ticketRef.current)) return;
    const ok = await store().saveDraft({ again });
    if (ok && again) amtRef.current?.focus();
  };
  const onTicketKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const t = e.target as HTMLElement;
    const editable = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
    if (isNew && e.key === "Enter" && editable && !e.shiftKey && !e.altKey) {
      // 時刻框：Enter 由 ClockInput 自己判（看得懂才 onEnter＝存檔；打錯只還原、不存）——它只 preventDefault、會冒到這裡
      if (t.closest(".ns-tk-pop, .ns-datepick, .ns-clock")) return;
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

  /* 撕線左端的孔：打在 .panel-sheet 上（mask，見 ticket.css T2 區），位置＝撕線在紙上的 y；內容捲動時跟著撕線走 */
  const ticketRef = useRef<HTMLElement>(null);
  const enterAgain = useRef(false);
  useLayoutEffect(() => {
    const tear = ticketRef.current?.querySelector<HTMLElement>(".ns-tk-bt-tear");
    const sheet = ticketRef.current?.closest<HTMLElement>(".panel-sheet");
    const scroller = ticketRef.current?.closest<HTMLElement>(".panel-scroll");
    if (!tear || !sheet) return;
    const place = () => sheet.style.setProperty("--tk-tear-y", `${Math.round(tear.getBoundingClientRect().top - sheet.getBoundingClientRect().top)}px`);
    place();
    scroller?.addEventListener("scroll", place, { passive: true });
    return () => {
      scroller?.removeEventListener("scroll", place);
      sheet.style.removeProperty("--tk-tear-y");
    };
  }, []);

  const savedFlash = !isNew && savedAt !== null && Date.now() - savedAt < 2500;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!savedFlash) return;
    const t = setTimeout(() => tick((n) => n + 1), 2600);
    return () => clearTimeout(t);
  }, [savedAt, savedFlash]);

  const serial = row ? serialOf(row, entries.filter((x) => x.occurred_on === row.occurred_on)) : "NEW";
  const balText = (a: AccountRow) => moneyText(balances[a.id] ?? 0, curByCode[a.currency]?.decimals ?? 2);

  return (
    <article
      ref={ticketRef}
      className={`ns-tk-bigticket${isNew ? " is-new" : ""}`}
      data-kind={vm.kind}
      aria-label={isNew ? "新票" : "這一筆"}
      onKeyDownCapture={(e) => {
        enterAgain.current = e.key === "Enter" && (e.ctrlKey || e.metaKey); // 時刻框的 Enter 由 ClockInput 叫 onEnter，那裡讀不到修飾鍵
      }}
      onKeyDown={onTicketKeyDown}
    >
      <div className="ns-tk-bt-stub">
        {vm.kind === "adjust" ? (
          <span className="ns-tk-kind is-locked" title="精算不能改類型">
            精算
          </span>
        ) : (
          <Segmented<"expense" | "income" | "transfer">
            className="ns-tk-kindseg"
            aria-label="類型"
            options={KINDS.map((o) => ({ value: o.k, label: o.label }))}
            value={vm.kind}
            onChange={setKind}
          />
        )}
        <span className="ns-tk-serial">{serial}</span>
      </div>
      <div className="ns-tk-bt-tear" aria-hidden />

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
              title={vm.kind === "transfer" ? "轉帳幣別會跟著轉出帳戶" : "換幣別"}
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
                    <span className="r">{c.is_main === 1 ? "主要幣別" : `1 ＝ ${c.rate_to_main}`}</span>
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
              onCreated={(id) => (isNew ? store().setDraft({ accountId: id }) : patch({ accountId: id }))}
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
                onCreated={(id) => (isNew ? store().setDraft({ toAccountId: id, toAmountText: null }) : patch({ toAccountId: id }))}
              />
            </FieldRow>
          )}
          {crossCur && toAcc && toCur && (
            <FieldRow label="轉入金額">
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
            {/* J3：共用日期 chip（桌機 DatePicker 錨定浮層）；帳不能記到未來 ⇒ max＝今天，往前不設限 */}
            <DateChip
              date={vm.dayKey}
              label="日期"
              allowPast
              max={today}
              today={today}
              onPick={(day) => {
                if (!day) return;
                if (isNew) store().setDraft({ dayKey: day });
                else {
                  try {
                    patch({ occurredOn: day, occurredAt: atOf(day, takeClockHHMM(), dayStartHour) });
                  } catch (e) {
                    toast(errMsg(e));
                  }
                }
              }}
            />
          </FieldRow>
          <FieldRow label="時刻" top>
            {/* F1（P2 A 案）：時刻獨立一列、compact（±15）；說明行只在跨天時寫日期（"other"：日期已在上一列） */}
            <span className="ns-tk-clock">
              <ClockInput
                variant="compact"
                label="時刻"
                value={clockMs}
                lo={clockLo}
                hi={clockHi}
                refDay={vm.dayKey}
                dateLabel="other"
                onChange={onClock}
                onEnter={() => {
                  if (isNew) void save(enterAgain.current);
                  else clockCommit.flush();
                }}
              />
            </span>
          </FieldRow>
          <FieldRow label="備註" top>
            {isNew ? (
              <textarea
                className="ns-tk-textin"
                rows={1}
                placeholder="備註"
                aria-label="備註"
                value={vm.note}
                onChange={(e) => store().setDraft({ note: e.target.value })}
              />
            ) : (
              <div className="ns-tk-notewrap">
                <CommitTextarea value={vm.note} rows={1} ariaLabel="備註" placeholder="備註" onCommit={(note) => patch({ note })} />
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
          {/* 第③階段（③契約 §5.4）：定期記的（或「設成定期」連上的）帳多一列「定期」；規則已刪的不出（收尾修正） */}
          {row && linkedRepeat && (
            <FieldRow label="定期">
              <RepeatField entry={row} />
            </FieldRow>
          )}
        </div>
      </div>

      {/* 操作列黏在紙底（規範 §2.4「操作列黏底」；內容短時靠 margin-top:auto 推到底） */}
      <div className="ns-tk-bt-foot">
          {isNew ? (
            <>
              {/* 次鈕在左、主鈕在右（視覺規範 §2.3；UI 丙-1 起主鈕＝實心墨 .btn-seal） */}
              <button type="button" className="ns-btn btn-ghost ns-tk-btn" onClick={() => void save(true)}>
                存並再記<kbd className="ns-tk-kbd">{capsOf("ticket-entry.again")}</kbd>
              </button>
              <button type="button" className="ns-btn btn-seal ns-tk-btn" onClick={() => void save(false)}>
                存檔<kbd className="ns-tk-kbd">{capsOf("ticket-entry.save")}</kbd>
              </button>
              <span className="ns-tk-esc">{capsOf("ticket-entry.escape")} 放棄</span>
            </>
          ) : (
            <>
              {row && <RepeatMakeButton entry={row} />}
              <button type="button" className="ns-btn btn-ghost ns-btn-danger ns-tk-btn" onClick={() => row && void store().deleteEntry(row.id)}>
                刪除<kbd className="ns-tk-kbd">{capsOf("ticket.delete")}</kbd>
              </button>
              <span className={`ns-tk-saved${savedFlash ? " flash" : ""}`} aria-live="polite">
                {savedFlash ? "已存" : "自動存檔"}
              </span>
            </>
          )}
      </div>
    </article>
  );
}

/* ── 帳戶挑選鈕＋浮層（依群組分區；封存的不列）。磨光⑥ 契約 §2-3（D-票-63）：最上面多一組「常用」（30 天次數前 3；
   帳戶 ≤ 3 個時 store 給空的就不畫），下面照舊是手動順序的完整清單（重複出現沒關係） ── */
export function AcctPick(props: {
  open: boolean;
  onToggle(): void;
  onClose(): void;
  acc: AccountRow | undefined;
  exclude: string | null;
  balText(a: AccountRow): string;
  onPick(id: string): void;
  /** 選單底「新增帳戶」建好之後（給了才接：大票新票填回草稿、舊票直接改這一筆＝丙-5 D2） */
  onCreated?(id: string): void;
}) {
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const frequentIds = useTicketStore((s) => s.frequent.accounts);
  const groups = groupAccounts(accounts);
  const frequent = frequentIds
    .map((id) => accById[id])
    .filter((a): a is AccountRow => !!a && a.deleted_at === null && a.archived_at === null && a.id !== props.exclude);
  const opt = (a: AccountRow) => (
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
  );
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
          {frequent.length > 0 && (
            <div role="group" aria-label="常用" className="is-frequent">
              <div className="hd">常用</div>
              {frequent.map(opt)}
              <div className="sep" />
            </div>
          )}
          {groups.map(({ group, accounts: list }) => {
            const opts = list.filter((a) => a.id !== props.exclude);
            if (!opts.length) return null;
            return (
              <div key={group.key} role="group" aria-label={group.label}>
                <div className="hd">{group.label}</div>
                {opts.map(opt)}
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
              // 給了 onCreated ⇒ 建完直接選上它（磨光③ 2-16；丙-5 D2 舊票也給）
              const pick = props.onCreated;
              useTicketStore.getState().openDialog({ kind: "newAccount", ...(pick ? { then: { pick } } : {}) });
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
export function RoutePop({ routes, current, onClose, onPick }: { routes: NodeRow[]; current: string | null; onClose(): void; onPick(id: string | null): void }) {
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
          不選
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

/* ── 分類 combobox（打字即搜：子分類優先、顯示「主 › 子」；空白列「常用」（磨光⑥ §2-3：30 天次數，不滿 8 個用最近用過補）；↑↓ Enter）
   丙-5 D1（規範 §2.5「新增 X 在 X 旁邊」）：浮層最後固定兩列——「＋ 新增分類」（打了字、又沒有同名的 ⇒「＋ 新增分類「字」」，
   建在目前類型下、主分類，建完直接選上；沒打字 ⇒ 點了把焦點放回欄上、提示打名字）與「管理…」（分類管理對話框）。
   兩列也在 ↑↓ 的輪替裡。打的字找不到任何分類時反白不自動落在「新增」：要 ↓ 或點擊才建（分類只能封存、不能刪，
   打錯字按 Enter 就多一個清不掉的分類——評審 R1）；這時 Enter 照舊交給新票存檔。
   `manage={false}`：已經在對話框裡（定期帳規則編輯器）——開分類管理會把那個對話框換掉，不給這一列。 ── */
export function CategoryCombo({
  kind,
  categoryId,
  onPick,
  manage = true,
}: {
  kind: "income" | "expense";
  categoryId: string | null;
  onPick(id: string | null): void;
  manage?: boolean;
}) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const recent = useTicketStore((s) => s.frequent[kind]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [kb, setKb] = useState(-1); // -1＝還沒挑（空白時 Enter 留給新票存檔）
  const [askName, setAskName] = useState(false); // 沒打字就按「＋ 新增分類」：placeholder 改成請打名字
  const [busy, setBusy] = useState(false);
  const navved = useRef(false); // 反白是 ↑↓ 挑的（不是打字自動落的）
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useOutside(wrapRef, () => setOpen(false));

  const cat = categoryId && !isUncat(categoryId) ? catById[categoryId] : undefined;
  const label = cat ? categoryLabel(cat, catById) : "";
  const options: CategoryRow[] = useMemo(() => {
    if (q.trim()) return matchCategories(q, categories, kind).slice(0, 12);
    return recent.map((id) => catById[id]).filter((c): c is CategoryRow => !!c && c.deleted_at === null && c.archived_at === null && c.kind === kind);
  }, [q, categories, kind, recent, catById]);
  const name = q.trim();
  // 同類型、沒刪的已有同名（含封存：repository 會擋重名，別讓人按了才吃 toast）⇒ 不給「新增「字」」
  const taken = name !== "" && categories.some((c) => c.kind === kind && c.deleted_at === null && c.name.trim() === name);
  type Act = "add" | "manage";
  const acts: Act[] = [...(taken ? [] : (["add"] as Act[])), ...(manage ? (["manage"] as Act[]) : [])];
  const total = options.length + acts.length;
  const actAt = (i: number): Act | null => (i >= options.length && i < total ? acts[i - options.length] : null);

  // 挑完只收浮層、焦點留在欄上（不 blur：焦點掉到 body 會讓 Enter 存檔／Esc 放棄／Tab 移欄全接不到）
  const pick = (id: string | null) => {
    setOpen(false);
    setQ("");
    setKb(-1);
    setAskName(false);
    if (id !== categoryId) onPick(id);
  };
  const add = async () => {
    if (!name) {
      setAskName(true);
      setKb(-1);
      inputRef.current?.focus();
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const row = await useTicketStore.getState().createCategory({ kind, name, parentId: null });
      if (row) pick(row.id); // 回來時已 refresh 過，catById 裡有它（失敗 store 會 toast，浮層留著）
    } finally {
      setBusy(false);
    }
  };
  const openManager = () => {
    setOpen(false);
    setQ("");
    setKb(-1);
    useTicketStore.getState().openDialog({ kind: "categories" });
  };
  const run = (a: Act) => (a === "add" ? void add() : openManager());

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!open) setOpen(true);
      navved.current = true;
      const n = total;
      if (n) setKb((i) => (i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n));
    } else if (e.key === "Enter" && open && kb >= 0 && kb < total) {
      // 打了字或用 ↑↓ 挑過：Enter＝做反白那一列（新票的「Enter 存檔」要等分類挑完）
      const a = actAt(kb);
      // 打字落在「管理…」（打的是封存分類的名字、找不到又不能新增）不算挑了它：讓 Enter 照舊（新票存檔）
      if (a === "manage" && !navved.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (a) run(a);
      else pick(options[kb].id);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQ("");
      setAskName(false);
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
        placeholder={askName ? "打新分類的名字" : cat ? "" : "打字搜尋，或選常用的"}
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
          // 有符合的才反白第一個；找不到時 0 會是「＋ 新增分類「字」」那一列——不自動落在那裡（要 ↓ 或點擊才建）
          setKb(e.target.value.trim() && matchCategories(e.target.value, categories, kind).length > 0 ? 0 : -1);
          navved.current = false;
          setOpen(true);
        }}
        onBlur={(e) => {
          // 點浮層的選項時 mousedown 已 preventDefault，不會走到這裡；真的離開欄位才收
          if (wrapRef.current?.contains(e.relatedTarget as Node)) return;
          setOpen(false);
          setQ("");
          setAskName(false);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="ns-tk-pop is-cat" role="listbox" aria-label="分類選項" onMouseDown={(e) => e.preventDefault()}>
          {options.length > 0 ? (
            <>
              <div className="hd">{name ? "符合" : "常用"}</div>
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
            <div className="hd">{name ? `找不到「${name}」` : "打字搜尋分類"}</div>
          )}
          {(cat || acts.length > 0) && <div className="sep" />}
          {cat && (
            <button type="button" tabIndex={-1} className="opt is-quiet" onClick={() => pick(null)}>
              改回未分類
            </button>
          )}
          {acts.map((a, j) => {
            const i = options.length + j;
            return (
              <button
                key={a}
                type="button"
                role="option"
                aria-selected={i === kb}
                tabIndex={-1}
                className={`opt is-add${i === kb ? " kb" : ""}`}
                disabled={a === "add" && busy}
                onClick={() => run(a)}
              >
                {a === "add" ? (
                  <>
                    <TkIcon name="plus" size={11} />
                    {name ? `新增分類「${name}」` : "新增分類"}
                  </>
                ) : (
                  "管理…"
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
      ? "填目標餘額，會記一筆「精算」補差額"
      : diff === null
        ? "請輸入有效的數字"
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
          {locked && <span className="ns-tk-lock">已有帳，不能改幣別</span>}
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
              className="ns-btn btn-ghost ns-tk-btn"
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
                <button type="button" className="ns-btn btn-ghost ns-tk-btn" onClick={() => setAdj(null)}>
                  取消
                </button>
                <button type="button" className="ns-btn btn-seal ns-tk-btn" disabled={!diff} onClick={() => void confirmAdj()}>
                  確定
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
          <button type="button" className="ns-btn btn-ghost ns-tk-btn" onClick={() => void store().unarchiveAccount(acc.id)}>
            取消封存
          </button>
        ) : (
          <button type="button" className="ns-btn btn-ghost ns-btn-danger ns-tk-btn" onClick={() => store().archiveAccount(acc.id)}>
            封存
          </button>
        )}
        <button
          type="button"
          className="ns-btn btn-ghost ns-tk-btn"
          aria-pressed={filterAccountId === acc.id}
          onClick={() => void store().setFilter(filterAccountId === acc.id ? null : acc.id)}
        >
          {filterAccountId === acc.id ? "看全部帳" : "只看這個帳戶"}
        </button>
        <span className="note">{archived ? "仍算進總額" : acctLabel(acc, accounts) !== acc.name ? groupLabel(acc.group_key) : ""}</span>
      </div>
    </article>
  );
}
