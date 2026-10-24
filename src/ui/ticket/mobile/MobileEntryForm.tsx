/**
 * MobileEntryForm——手機「記一筆」全螢幕表單（車次①契約 §5.3、0-6、0-8；**D-票-23 定稿＝原型表單 A 現行版**）。
 * 根 `div.ns-tk-mform`，portal 到 body（同 MobileAttachPicker 的理由：從 `.m-page` 裡開的 fixed 面板蓋不過 tab bar）。
 *
 * 由上而下（原型 app.js mobForm 的 A 分支）：
 *   頂列「取消」・「記一筆／這一筆」・「存」（UI 丙-5 H5：殼換共用 MFullPage，書封色頂列）
 *   → 類型三選「支出｜收入｜轉帳」＝內文第一列 Segmented（丙-5 D4、P5 A 案：MFullPage 標題只收字串；校正票是唯讀「精算」）
 *   → 金額大字（inputmode=decimal 系統鍵盤，不自建數字鍵盤；右側幣別 chip 開 sheet）；外幣時下一行「≈ NT$ … · 匯率 …」可改折算額
 *   → 帳戶 chips 橫捲（轉帳＝「從」「到」兩列；不同幣別時多一欄「轉入金額」）——磨光⑥ 契約 §2-3（D-票-63）：最前面是「常用」
 *     （30 天次數前 3；帳戶 ≤ 3 個時沒有），小標與虛線隔開，後面照舊是手動順序的完整清單；最後一顆「＋ 新增帳戶」（丙-5 D3）
 *   → （收支）「常用」格子（磨光⑥ §2-3：30 天次數，不滿 8 個用最近用過補；原本叫「最近」）＋完整兩層格子（主分類一格一格、點開在那一列下方展子分類）；
 *     完整格子最後一格「＋ 新增…」開小 sheet：打名字建在目前類型下、建完選上；sheet 裡的「管理分類…」開分類管理（丙-5 D3，規範 §2.5）
 *   → 「更多欄位」折疊：日期（MobileDatePicker）・時刻（ClockInput mobile，丙-5 F3）・備註・路線・（舊票，第③階段）定期——「設成定期… ›」或唯讀「每月 1 日 · 管理 ›」
 *   → 底部：新票「存並繼續」（存後清金額與備註、留帳戶分類）／舊票「刪除」
 *
 * 新票＝store 的 `draft`（`openNew`／`setDraft`／`saveDraft`）。舊票＝本地草稿，按「存」才送一次 `updateEntry`
 *   （手機的頂列有明確的「取消／存」，與原型 A 相同；桌機詳情板的即時存是另一種殼的作法——偏離 0-8 字面，見回報）。
 * 高度吃 `--m-vvh`（軟鍵盤彈出時視覺視窗的高；useVisualViewportHeight），底部鈕不被鍵盤蓋住。
 * 殼（丙-5 H5）：MFullPage 的本文裡放 `div.ns-tk-mform`（捲動區＋底列），本檔的樣式全掛在它底下；返回層 id 交給 MFullPage（"ticket.form"，
 *   返回鍵＝左鈕＝取消）。疊在表單上的 sheet（幣別、日期、新增分類）共用 "ticket.form.pick"（"dialog"）；「＋ 新增帳戶」與「管理分類…」
 *   走 store 的 openDialog，由 MobileSheetHost 疊在表單上面（表單開著時它登記成 "dialog"）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { addDays, todayKey } from "../../../lib/date";
import { roundelStyle } from "../../common/roundel";
import { MobileDatePicker } from "../../common/MobileDatePicker";
import { MFullPage } from "../../common/MFullPage";
import { MSheet } from "../../common/MSheet";
import { Segmented } from "../../common/Segmented";
import { ClockInput, clockDraftsOkIn } from "../../common/ClockInput";
import { useBackLayer } from "../../mobile/backStack";
import { shortDayKey } from "../../common/DatePicker";
import {
  MAIN_CURRENCY,
  MAIN_SYMBOL,
  atOf,
  bareName,
  categoryLabel,
  categoryTree,
  convertMinor,
  localTime,
  moneyText,
  orderAccounts,
  parseAmount,
  type AccountRow,
  type CategoryRow,
  type EntryDraft,
  type EntryPatch,
  type EntryRow,
} from "../../../domain/ticket";
import { IconCaret, IconRight, groupLabelOf, nextDraft, useImeGuard } from "./mobileBits";
import { msToWallHHMM, ticketClockBounds, ticketClockValue } from "../ticketClock";
import { parseFixedRule } from "../../../domain/ticketPlan";
import { useLinkedRepeat } from "../plan/RepeatField";
import { describeRule } from "../../../domain/repeat";

type Mode = "new" | "edit";

export function MobileEntryForm() {
  const panel = useTicketStore((s) => s.panel);
  const draft = useTicketStore((s) => s.draft);
  const entry = useTicketStore((s) => (s.panel.kind === "entry" ? (s.entries.find((e) => e.id === (s.panel as { id: string }).id) ?? null) : null));
  const closePanel = useTicketStore((s) => s.closePanel);

  // 舊票不在目前載入的清單裡（同步刪了、換了篩選）⇒ 收起
  const gone = panel.kind === "entry" && !entry;
  useEffect(() => {
    if (gone) closePanel();
  }, [gone, closePanel]);

  if (panel.kind === "new") return draft ? <NewEntry draft={draft} /> : null;
  if (panel.kind === "entry" && entry) return <EditEntry row={entry} />;
  return null;
}

/* ═══════════ 新票（store 的 draft） ═══════════ */

function NewEntry({ draft }: { draft: EntryDraft }) {
  const setDraft = useTicketStore((s) => s.setDraft);
  const saveDraft = useTicketStore((s) => s.saveDraft);
  const closePanel = useTicketStore((s) => s.closePanel);
  const requestEscape = useTicketStore((s) => s.requestEscape);
  const amtRef = useRef<HTMLInputElement | null>(null);
  const busy = useRef(false);

  const save = async (again: boolean) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const ok = await saveDraft({ again });
      if (!ok) return;
      if (again) amtRef.current?.focus();
      else closePanel();
    } finally {
      busy.current = false;
    }
  };

  return (
    <FormShell
      mode="new"
      adjust={false}
      draft={draft}
      amtRef={amtRef}
      onPatch={setDraft}
      onSave={(again) => void save(again)}
      onCancel={requestEscape}
    />
  );
}

/* ═══════════ 舊票（本地草稿，按「存」送一次 patch） ═══════════ */

function draftFromRow(row: EntryRow, dec: number): EntryDraft {
  return {
    kind: row.kind === "adjust" ? "expense" : row.kind,
    amountText: moneyText(row.amount_minor, dec).replace(/,/g, ""),
    currency: row.currency,
    accountId: row.account_id,
    toAccountId: row.to_account_id,
    categoryId: row.category_id,
    dayKey: row.occurred_on,
    time: localTime(row.occurred_at),
    note: row.note,
    routeId: row.route_id,
    mainOverrideText: null,
    toAmountText: null,
  };
}

function EditEntry({ row }: { row: EntryRow }) {
  const accById = useTicketStore((s) => s.accById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const updateEntry = useTicketStore((s) => s.updateEntry);
  const deleteEntry = useTicketStore((s) => s.deleteEntry);
  const closePanel = useTicketStore((s) => s.closePanel);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const showToast = useUiStore((s) => s.showToast);
  const adjust = row.kind === "adjust";
  const [d, setD] = useState<EntryDraft>(() => draftFromRow(row, curByCode[row.currency]?.decimals ?? 2));
  const busy = useRef(false);

  const save = async () => {
    if (busy.current) return;
    let patch: EntryPatch;
    try {
      patch = buildPatch(row, d, adjust, { accById, curByCode }, dayStartHour);
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (Object.keys(patch).length === 0) {
      closePanel();
      return;
    }
    busy.current = true;
    try {
      const before = useTicketStore.getState().savedAt;
      await updateEntry(row.id, patch);
      // updateEntry 失敗只吐 toast、不改 savedAt：成功才收起，失敗留著讓主人改
      if (useTicketStore.getState().savedAt !== before) closePanel();
    } finally {
      busy.current = false;
    }
  };

  return (
    <FormShell
      mode="edit"
      adjust={adjust}
      entry={row}
      draft={d}
      // 讀 store 的最新表：「＋ 新增帳戶」建完回填時，新帳戶不在這一次 render 的 accById 裡（幣別才跟得上）
      onPatch={(p) => setD((prev) => nextDraft(prev, p, useTicketStore.getState().accById, useTicketStore.getState().catById))}
      onSave={() => void save()}
      onCancel={closePanel}
      onDelete={() => void deleteEntry(row.id)}
    />
  );
}

/** 本地草稿 → 只含有變的欄位的 patch（parse 失敗丟 RangeError，訊息直接給 toast） */
function buildPatch(
  row: EntryRow,
  d: EntryDraft,
  adjust: boolean,
  ctx: { accById: Record<string, AccountRow>; curByCode: Record<string, { code: string; decimals: number }> },
  dayStartHour: number,
): EntryPatch {
  const p: EntryPatch = {};
  const kind = adjust ? row.kind : d.kind;
  const acc = d.accountId ? ctx.accById[d.accountId] : undefined;
  if (!acc) throw new RangeError("選一個帳戶");
  const currency = kind === "transfer" || adjust ? acc.currency : d.currency;
  const cur = ctx.curByCode[currency];
  if (!cur) throw new RangeError(`沒有這個幣別：${currency}`);
  const amount = parseAmount(d.amountText, cur, { allowNegative: adjust || kind === "expense" });
  if (!adjust && kind !== row.kind) p.kind = kind as EntryPatch["kind"];
  if (amount !== row.amount_minor) p.amountMinor = amount;
  if (currency !== row.currency) p.currency = currency;
  if (d.accountId !== row.account_id) p.accountId = d.accountId!;
  if (kind === "transfer") {
    if (!d.toAccountId) throw new RangeError("選轉入的帳戶");
    if (d.toAccountId !== row.to_account_id) p.toAccountId = d.toAccountId;
  }
  if (!adjust && kind !== "transfer" && d.categoryId !== row.category_id) p.categoryId = d.categoryId;
  if (d.note !== row.note) p.note = d.note;
  if (d.routeId !== row.route_id) p.routeId = d.routeId;
  if (d.dayKey !== row.occurred_on || d.time !== localTime(row.occurred_at)) {
    p.occurredOn = d.dayKey;
    p.occurredAt = atOf(d.dayKey, d.time, dayStartHour);
  }
  const main = ctx.curByCode[MAIN_CURRENCY];
  if (d.mainOverrideText !== null && d.mainOverrideText.trim() !== "" && main) {
    p.override = { ...p.override, mainMinor: parseAmount(d.mainOverrideText, main, { allowNegative: adjust || kind === "expense" }) };
  }
  if (kind === "transfer" && d.toAmountText !== null && d.toAmountText.trim() !== "" && d.toAccountId) {
    const toCur = ctx.curByCode[ctx.accById[d.toAccountId]?.currency ?? ""];
    if (toCur) p.override = { ...p.override, toAmountMinor: parseAmount(d.toAmountText, toCur, { allowNegative: false }) };
  }
  return p;
}

/* ═══════════ 表單本體（新舊共用） ═══════════ */

const KINDS: { key: EntryDraft["kind"]; label: string }[] = [
  { key: "expense", label: "支出" },
  { key: "income", label: "收入" },
  { key: "transfer", label: "轉帳" },
];
const KIND_OPTIONS = KINDS.map((k) => ({ value: k.key, label: k.label }));
const SIGN: Record<EntryDraft["kind"], string> = { expense: "", income: "＋", transfer: "⇄" };

function FormShell({
  mode,
  adjust,
  entry,
  draft: d,
  amtRef,
  onPatch,
  onSave: onSaveRaw,
  onCancel,
  onDelete,
}: {
  mode: Mode;
  adjust: boolean;
  /** 舊票那一列（第③階段「更多欄位」的「定期」列要看它的 repeat_id）；新票 undefined */
  entry?: EntryRow;
  draft: EntryDraft;
  amtRef?: RefObject<HTMLInputElement | null>;
  onPatch(p: Partial<EntryDraft>): void;
  onSave(again: boolean): void;
  onCancel(): void;
  onDelete?(): void;
}) {
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const currencies = useTicketStore((s) => s.currencies);
  const curByCode = useTicketStore((s) => s.curByCode);
  const frequent = useTicketStore((s) => s.frequent);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);

  const [sheet, setSheet] = useState<"currency" | "date" | "newCat" | null>(null);
  // 磨光①（主線手機殼契約 §1.5、§9.3）：返回鍵＝「取消」（新帳 requestEscape：有內容先問；舊帳 closePanel）——丙-5 起由 MFullPage
  // 以 backId "ticket.form" 登記（返回鍵＝左鈕），本檔不再另登一層。
  // 幣別／日期／新增分類 sheet 疊在全螢幕表單上：權重要比 "full" 高才會先關它，所以登記成 "dialog"（toast 也跟著移到頂帶下方，不壓在 sheet 上）；
  // 三支 sheet 都給同一個 backId ⇒ 跟這一行合併成一層，返回鍵按一次就關
  useBackLayer("ticket.form.pick", sheet !== null, () => setSheet(null), "dialog");
  const openDialog = useTicketStore((s) => s.openDialog);
  const createCategory = useTicketStore((s) => s.createCategory);
  const [more, setMore] = useState(mode === "edit" && (d.note !== "" || d.routeId !== null));
  const [editConv, setEditConv] = useState(false);
  const isNew = mode === "new";
  const kind = d.kind;
  const transfer = !adjust && kind === "transfer";
  const catKind = kind === "income" ? "income" : "expense";

  /* 帳戶 chips：未封存依群組順序；目前選中的即使已封存也列（舊票落在封存帳戶上） */
  const chipAccounts = useMemo(() => {
    const live = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null));
    for (const id of [d.accountId, d.toAccountId]) {
      if (id && accById[id] && !live.some((a) => a.id === id)) live.push(accById[id]);
    }
    return live;
  }, [accounts, accById, d.accountId, d.toAccountId]);
  /* 常用帳戶（store 已排好、最多 3 個）：只列未封存的 */
  const frequentAccounts = useMemo(
    () => frequent.accounts.map((id) => accById[id]).filter((a): a is AccountRow => !!a && a.deleted_at === null && a.archived_at === null),
    [frequent.accounts, accById],
  );
  const dupName = (a: AccountRow) => accounts.filter((x) => x.name === a.name && x.deleted_at === null).length > 1;

  /* 分類 */
  const tree = useMemo(() => categoryTree(categories, catKind, { includeArchived: false }), [categories, catKind]);
  const recentCats = useMemo(
    () =>
      frequent[catKind]
        .map((id) => catById[id])
        .filter((c): c is CategoryRow => !!c && c.deleted_at === null && c.archived_at === null && c.kind === catKind)
        .slice(0, 8),
    [frequent, catKind, catById],
  );
  const selCat = d.categoryId ? (catById[d.categoryId] ?? null) : null;
  const [openMain, setOpenMain] = useState<string | null>(() => (selCat ? (selCat.parent_id ?? selCat.id) : null));

  /* 金額與折算 */
  const acc = d.accountId ? accById[d.accountId] : undefined;
  const toAcc = d.toAccountId ? accById[d.toAccountId] : undefined;
  const curCode = transfer || adjust ? (acc?.currency ?? d.currency) : d.currency;
  const cur = curByCode[curCode];
  const main = curByCode[MAIN_CURRENCY];
  const mainDec = main?.decimals ?? 2;
  let amountMinor: number | null = null;
  try {
    if (cur && d.amountText.trim() !== "") amountMinor = parseAmount(d.amountText, cur, { allowNegative: true, allowZero: true });
  } catch {
    amountMinor = null;
  }
  const autoMain = cur && main && cur.code !== main.code && amountMinor !== null ? convertMinor(amountMinor, cur, main) : null;
  const toCur = transfer && toAcc ? curByCode[toAcc.currency] : undefined;
  const crossTransfer = !!(transfer && toCur && cur && toCur.code !== cur.code);
  const autoTo = crossTransfer && amountMinor !== null && cur && toCur ? convertMinor(amountMinor, cur, toCur) : null;

  /* 時刻（丙-5 F3）：帳日＋牆鐘 ↔ ClockInput 的毫秒（ticketClock.ts）；草稿時刻看不懂（理論上不會）就先擺在日界線那一刻 */
  const { lo: clockLo, hi: clockHi } = ticketClockBounds(d.dayKey, dayStartHour);
  const clockMs = ticketClockValue(d.dayKey, d.time, dayStartHour) ?? clockLo;

  const route = d.routeId ? (routes.find((r) => r.id === d.routeId) ?? null) : null;
  const linkedRule = useLinkedRepeat(entry); // 第③階段：連著還在的規則（規則已刪 ⇒ null，當成沒連）
  const moreSum =
    `${d.dayKey === today ? "今天" : shortDayKey(d.dayKey)} ${d.time} · ${d.note.trim() ? "有備註" : "無備註"} · ${
      route ? `${route.code ? route.code + " " : ""}${route.name}` : "不掛路線"
    }` + (linkedRule ? " · 定期" : "");

  /* 第③階段（③契約 §5.5、✎-4）：舊票「更多欄位」最後一列＝「定期」——連著還在的規則的唯讀「每月 1 日 · 管理 ›」，
     沒連的、或規則已刪的（收尾修正）「設成定期… ›」 */
  const makeRepeatFromEntry = useTicketStore((s) => s.makeRepeatFromEntry);
  const linkedRuleObj = linkedRule ? parseFixedRule(linkedRule.rule) : null;
  const openRepeats = () => {
    // 定期帳 sheet（z 45）在全螢幕表單（z 46）底下：先收起表單（沒按「存」的改動放掉，同「取消」）
    const st = useTicketStore.getState();
    st.closePanel();
    st.openDialog({ kind: "repeats" });
  };

  /* 選中的帳戶／路線 chip 捲進橫捲列的可視範圍（只動水平，不讓表單上下跳） */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 頂列「存」、存並再記、金額欄 Enter 都走這裡：時刻框剛打錯、還沒回去看過 ⇒ 不存、焦點回框（丙-5 風險 1；打的字已還原成舊時刻） */
  const onSave = (again: boolean): void => {
    if (!clockDraftsOkIn(rootRef.current)) return;
    onSaveRaw(again);
  };
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".ns-tk-mf-accts").forEach((row) => {
      const on = row.querySelector<HTMLElement>(".ns-tk-mchip.on");
      if (!on) return;
      const l = on.offsetLeft - row.offsetLeft;
      const r = l + on.offsetWidth;
      if (l < row.scrollLeft) row.scrollLeft = Math.max(0, l - 18);
      else if (r > row.scrollLeft + row.clientWidth) row.scrollLeft = r - row.clientWidth + 18;
    });
  }, [d.accountId, d.toAccountId, d.routeId, kind, more]);

  /* 開啟／關閉的焦點交給 MFullPage（useDialogFocus：開啟落頁、新票金額欄 autoFocus 優先；關閉還給開它的元素）。
     舊票補一條：開它的那一行已經不在（清單重畫）就還給最後開過的那一列 */
  useEffect(() => {
    if (mode !== "edit") return;
    return () => {
      const a = document.activeElement;
      if (a === null || a === document.body) document.querySelector<HTMLElement>(".ns-tk-mrow.is-last")?.focus({ preventScroll: true });
    };
  }, [mode]);

  const amtIme = useImeGuard((e) => {
    e.preventDefault();
    onSave(false);
  });

  const pickCat = (c: CategoryRow) => onPatch({ categoryId: c.id });
  const mainCell = (p: CategoryRow, hasKids: boolean) => {
    const selIn = !!selCat && (selCat.id === p.id || selCat.parent_id === p.id);
    return (
      <button
        key={p.id}
        type="button"
        className={"ns-tk-mcell" + (selIn ? " on" : "") + (p.id === openMain && !selIn ? " open" : "")}
        aria-expanded={hasKids ? p.id === openMain : undefined}
        aria-pressed={selIn}
        onClick={() => {
          // 點主分類＝選它；有子分類的另外在下方展開（再點一次已展開的＝收起）
          pickCat(p);
          if (hasKids) setOpenMain(openMain === p.id ? null : p.id);
          else setOpenMain(null);
        }}
      >
        {p.name}
      </button>
    );
  };

  /* 完整格子：四欄；展開的子分類區塊插在「那一列」的最後一格之後。
     最後一格固定「＋ 新增…」（規範 §2.5：分類選擇最後一格「＋ 新增…／管理…」；管理在開出來的 sheet 裡）——它也算一格，
     展開區塊照樣插在它那一列之後，不會把一列切成兩半 */
  const fullGrid = () => {
    const cells: ReactNode[] = [];
    const n = tree.length + 1;
    const openIdx = tree.findIndex((t) => t.parent.id === openMain);
    const rowEnd = openIdx < 0 || tree[openIdx].children.length === 0 ? -1 : Math.min(n - 1, Math.floor(openIdx / 4) * 4 + 3);
    for (let i = 0; i < n; i++) {
      const t = tree[i];
      cells.push(
        t ? (
          mainCell(t.parent, t.children.length > 0)
        ) : (
          <button key="add" type="button" className="ns-tk-mcell is-add" aria-haspopup="dialog" onClick={() => setSheet("newCat")}>
            ＋ 新增…
          </button>
        ),
      );
      if (i === rowEnd) {
        const op = tree[openIdx];
        cells.push(
          <div key={"subs-" + op.parent.id} className="ns-tk-msubs">
            <div className="hd">{op.parent.name} ›</div>
            <div className="ns-tk-mgrid">
              {op.children.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={"ns-tk-mcell" + (selCat?.id === c.id ? " on" : "")}
                  aria-pressed={selCat?.id === c.id}
                  onClick={() => pickCat(c)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>,
        );
      }
    }
    return <div className="ns-tk-mgrid">{cells}</div>;
  };

  const chips = (which: "from" | "to") => {
    const cur = which === "from" ? d.accountId : d.toAccountId;
    const list = which === "to" ? chipAccounts.filter((a) => a.id !== d.accountId) : chipAccounts;
    const freq = which === "to" ? frequentAccounts.filter((a) => a.id !== d.accountId) : frequentAccounts;
    const chip = (a: AccountRow, key: string) => (
      <button
        key={key}
        type="button"
        className={"ns-tk-mchip" + (a.id === cur ? " on" : "")}
        aria-pressed={a.id === cur}
        disabled={adjust}
        onClick={() => onPatch(which === "from" ? { accountId: a.id } : { toAccountId: a.id, toAmountText: null })}
      >
        {a.name}
        {dupName(a) && <small>{groupLabelOf(a.group_key)}</small>}
      </button>
    );
    return (
      <div className="ns-tk-mf-accts" role="group" aria-label={which === "from" ? "帳戶" : "轉入帳戶"}>
        {freq.length > 0 && (
          <>
            <span className="ns-tk-mf-acctsep is-lead" aria-hidden>
              常用
            </span>
            {freq.map((a) => chip(a, "f-" + a.id))}
            <span className="ns-tk-mf-acctsep" aria-hidden>
              全部
            </span>
          </>
        )}
        {list.map((a) => chip(a, a.id))}
        {list.length === 0 && <span className="ns-tk-mf-none">{which === "to" ? "只有一個帳戶，轉不出去" : "還沒有帳戶"}</span>}
        {!adjust && (
          <button
            type="button"
            className="ns-tk-mchip is-add"
            aria-haspopup="dialog"
            onClick={() =>
              // 建完回填到這一列（store 的 then.pick；新票＝setDraft、舊票＝本地草稿），新增帳戶 sheet 由 MobileSheetHost 疊在表單上
              openDialog({
                kind: "newAccount",
                then: { pick: (id) => onPatch(which === "from" ? { accountId: id } : { toAccountId: id, toAmountText: null }) },
              })
            }
          >
            ＋ 新增帳戶
          </button>
        )}
      </div>
    );
  };

  return (
    <MFullPage title={isNew ? "記一筆" : "這一筆"} left={{ label: "取消", onClick: onCancel }} right={{ label: "存", onClick: () => onSave(false) }} backId="ticket.form">
    <div ref={rootRef} className="ns-tk-mform" data-kind={adjust ? "adjust" : kind}>
      <div className="ns-tk-mf-scroll">
        {/* 類型＝內文第一列（P5 A 案）；校正票不能改類型，只寫「精算」 */}
        <div className="ns-tk-mf-kind">
          {adjust ? (
            <span className="ns-tk-mkind is-locked">精算</span>
          ) : (
            <Segmented options={KIND_OPTIONS} value={kind} onChange={(k) => onPatch({ kind: k })} aria-label="類型" />
          )}
        </div>
        <div className="ns-tk-mf-amt">
          <span className="sg">{adjust ? "±" : SIGN[kind]}</span>
          <input
            ref={amtRef}
            className="ns-tk-mamtin"
            inputMode="decimal"
            autoComplete="off"
            enterKeyHint="done"
            autoFocus={isNew}
            value={d.amountText}
            placeholder="0"
            aria-label="金額"
            onChange={(e) => onPatch({ amountText: e.target.value })}
            {...amtIme}
          />
          <button
            type="button"
            className="ns-tk-mcurchip"
            disabled={transfer || adjust || currencies.length < 2}
            aria-haspopup="dialog"
            aria-label={`幣別 ${curCode}`}
            onClick={() => setSheet("currency")}
          >
            {curCode}
          </button>
        </div>
        {cur && main && cur.code !== main.code ? (
          <div className="ns-tk-mf-conv">
            {editConv ? (
              <label>
                ≈ {MAIN_SYMBOL}
                <input
                  className="ns-tk-mf-convin"
                  inputMode="decimal"
                  autoComplete="off"
                  autoFocus
                  value={d.mainOverrideText ?? ""}
                  placeholder={autoMain !== null ? moneyText(autoMain, mainDec).replace(/,/g, "") : "0"}
                  aria-label="換算成主幣別的金額"
                  onChange={(e) => onPatch({ mainOverrideText: e.target.value })}
                />
              </label>
            ) : (
              <button type="button" onClick={() => setEditConv(true)} aria-label="改折算額">
                ≈ {MAIN_SYMBOL} <b>{d.mainOverrideText?.trim() ? d.mainOverrideText : autoMain !== null ? moneyText(autoMain, mainDec) : "—"}</b>
              </button>
            )}
            <span> · 匯率 {cur?.rate_to_main}</span>
          </div>
        ) : null}

        {transfer ? (
          <>
            <p className="ns-tk-mf-lbl">
              從<em>{acc?.name ?? "—"}</em>
            </p>
            {chips("from")}
            <p className="ns-tk-mf-lbl">
              到<em>{toAcc?.name ?? "—"}</em>
            </p>
            {chips("to")}
            {crossTransfer && toCur && (
              <label className="ns-tk-mf-toamt">
                <span>轉入金額</span>
                <input
                  inputMode="decimal"
                  autoComplete="off"
                  value={d.toAmountText ?? ""}
                  placeholder={autoTo !== null ? moneyText(autoTo, toCur.decimals).replace(/,/g, "") : "0"}
                  aria-label="轉入金額"
                  onChange={(e) => onPatch({ toAmountText: e.target.value })}
                />
                <small>{toCur.code}</small>
              </label>
            )}
          </>
        ) : adjust ? (
          <p className="ns-tk-mf-lbl">
            帳戶<em>{acc?.name ?? "—"}</em>
          </p>
        ) : (
          <>
            <p className="ns-tk-mf-lbl">
              帳戶<em>{acc ? acc.name + (dupName(acc) ? ` · ${groupLabelOf(acc.group_key)}` : "") : "—"}</em>
            </p>
            {chips("from")}
            {recentCats.length > 0 && (
              <>
                <p className="ns-tk-mf-lbl">常用</p>
                <div className="ns-tk-mf-cats">
                  <div className="ns-tk-mgrid">
                    {recentCats.map((c) => {
                      const p = c.parent_id ? catById[c.parent_id] : undefined;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={"ns-tk-mcell" + (selCat?.id === c.id ? " on" : "")}
                          aria-pressed={selCat?.id === c.id}
                          onClick={() => {
                            pickCat(c);
                            setOpenMain(c.parent_id ?? c.id);
                          }}
                        >
                          <span>
                            {p ? bareName(c.name) || c.name : c.name}
                            {p && <small>{bareName(p.name) || p.name}</small>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
            <p className="ns-tk-mf-lbl">
              分類<em>{selCat ? categoryLabel(selCat, catById) + (selCat.archived_at ? "（已封存）" : "") : "未選"}</em>
            </p>
            <div className="ns-tk-mf-cats">{fullGrid()}</div>
          </>
        )}

        <div className="ns-tk-mf-more">
          <button type="button" className="ns-tk-mf-moretog" aria-expanded={more} onClick={() => setMore(!more)}>
            更多欄位<span className="sum">{moreSum}</span>
            <IconCaret />
          </button>
          {more && (
            <div className="ns-tk-mf-morebody">
              <div className="ns-tk-mf-field">
                <span className="lbl">日期</span>
                <button type="button" className="ns-tk-mf-pick" aria-haspopup="dialog" onClick={() => setSheet("date")}>
                  {d.dayKey === today ? "今天" : shortDayKey(d.dayKey)}
                  <IconRight size={11} />
                </button>
              </div>
              {/* 時刻（丙-5 F3）：共用 ClockInput 手機變體（上方常用時刻 chip、±15）；範圍＝這個帳日的日界線 24 小時，存回一律牆鐘 HH:MM；
                  說明行只在跨天時寫日期（"other"：日期已在上一列）*/}
              <div className="ns-tk-mf-field top ns-tk-mf-clock">
                <span className="lbl">時刻</span>
                <ClockInput
                  variant="mobile"
                  label="時刻"
                  refDay={d.dayKey}
                  dateLabel="other"
                  value={clockMs}
                  lo={clockLo}
                  hi={clockHi}
                  onChange={(ms) => onPatch({ time: msToWallHHMM(ms) })}
                />
              </div>
              <label className="ns-tk-mf-field top">
                <span className="lbl">備註</span>
                <textarea
                  className="ns-tk-mf-note"
                  rows={2}
                  value={d.note}
                  placeholder="備註"
                  onChange={(e) => onPatch({ note: e.target.value })}
                />
              </label>
              <div className="ns-tk-mf-field">
                <span className="lbl">路線</span>
                <div className="ns-tk-mf-accts in-field" role="group" aria-label="路線">
                  <button
                    type="button"
                    className={"ns-tk-mchip" + (d.routeId === null ? " on" : "")}
                    aria-pressed={d.routeId === null}
                    onClick={() => onPatch({ routeId: null })}
                  >
                    不掛
                  </button>
                  {routes.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={"ns-tk-mchip" + (d.routeId === r.id ? " on" : "")}
                      aria-pressed={d.routeId === r.id}
                      onClick={() => onPatch({ routeId: r.id })}
                    >
                      <span className="roundel" aria-hidden style={roundelStyle(r.color)}>
                        {r.code ?? r.name.slice(0, 1)}
                      </span>
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
              {entry && !adjust && linkedRule ? (
                <div className="ns-tk-mf-field ns-tk-mf-rep is-ro">
                  <span className="lbl">定期</span>
                  <span className="v">{linkedRuleObj ? describeRule(linkedRuleObj) : "重複規則有誤"}</span>
                  <button type="button" className="ns-tk-mf-pick" aria-haspopup="dialog" onClick={openRepeats}>
                    管理
                    <IconRight size={11} />
                  </button>
                </div>
              ) : entry && !adjust ? (
                <div className="ns-tk-mf-field ns-tk-mf-rep">
                  <span className="lbl">定期</span>
                  <button type="button" className="ns-tk-mf-pick" aria-haspopup="dialog" onClick={() => makeRepeatFromEntry(entry.id)}>
                    設成定期…
                    <IconRight size={11} />
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
        <div className="ns-tk-mf-pad" />
      </div>

      <div className="ns-tk-mf-foot">
        {isNew ? (
          <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={() => onSave(true)}>
            存並再記</button>
        ) : (
          <button type="button" className="ns-btn btn-ghost ns-btn-danger ns-tk-mbtn" onClick={onDelete}>
            刪除
          </button>
        )}
      </div>
    </div>

      {sheet === "currency" && (
        <MSheet list title="幣別" onClose={() => setSheet(null)} backId="ticket.form.pick" backKind="dialog" className="ns-tk-mcursheet">
          {currencies.map((c) => (
            <button
              key={c.id}
              type="button"
              className="ns-msheet-item"
              aria-pressed={c.code === curCode}
              onClick={() => {
                onPatch({ currency: c.code });
                setEditConv(false);
                setSheet(null);
              }}
            >
              {c.code}
              <small>
                {c.name}
                {c.is_main === 1 ? " · 主幣別" : ` · 1 ${c.code} ＝ ${c.rate_to_main} ${MAIN_CURRENCY}`}
              </small>
            </button>
          ))}
        </MSheet>
      )}
      {sheet === "newCat" && (
        <NewCategorySheet
          kind={catKind}
          onClose={() => setSheet(null)}
          onCreate={async (name) => {
            const row = await createCategory({ kind: catKind, name, parentId: null });
            if (!row) return false; // 失敗 store 已吐 toast；sheet 留著讓主人改名
            pickCat(row);
            setOpenMain(null);
            setSheet(null);
            return true;
          }}
          onManage={() => {
            setSheet(null);
            openDialog({ kind: "categories" });
          }}
        />
      )}
      {sheet === "date" && (
        <MobileDatePicker
          title="這一筆的日期"
          value={d.dayKey}
          max={today}
          quick={[
            { label: "今天", day: today },
            { label: "昨天", day: addDays(today, -1) },
            { label: "前天", day: addDays(today, -2) },
          ]}
          onPick={(day) => {
            onPatch({ dayKey: day });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
          backId="ticket.form.pick"
          backKind="dialog"
        />
      )}
    </MFullPage>
  );
}

/* ═══════════ 新增分類 sheet（丙-5 D3） ═══════════ */

/**
 * 分類格最後一格「＋ 新增…」開的小 sheet：一個名稱欄＋黏底「取消｜新增」；建在目前類型（支出／收入）的主分類，建完由呼叫端選上。
 * 「管理分類…」（文字鈕，規範 §2.3「面板內『新增…』『管理…』」）關掉自己、開分類管理。疊在全螢幕表單上＝"dialog"（z 47）。
 */
function NewCategorySheet({
  kind,
  onClose,
  onCreate,
  onManage,
}: {
  kind: "expense" | "income";
  onClose(): void;
  /** 回 true＝建好了（呼叫端收 sheet）；false＝失敗，留著 */
  onCreate(name: string): Promise<boolean>;
  onManage(): void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const v = name.trim();
  const submit = async () => {
    if (busy || v === "") return;
    setBusy(true);
    try {
      await onCreate(v);
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void submit();
  });
  return (
    <MSheet
      title={kind === "income" ? "新增收入分類" : "新增支出分類"}
      onClose={onClose}
      backId="ticket.form.pick"
      backKind="dialog"
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" disabled={busy || v === ""} onClick={() => void submit()}>
            新增
          </button>
        </>
      }
    >
      <input
        className="techo-input ns-tk-mf-catname"
        value={name}
        placeholder="分類名稱"
        aria-label="分類名稱"
        autoFocus
        autoComplete="off"
        enterKeyHint="done"
        onChange={(e) => setName(e.target.value)}
        {...ime}
      />
      <button type="button" className="ns-btn ns-btn--sm btn-text ns-tk-mf-catmgr" onClick={onManage}>
        管理分類…
      </button>
    </MSheet>
  );
}
