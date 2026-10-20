/**
 * MobileEntryForm——手機「記一筆」全螢幕表單（車次①契約 §5.3、0-6、0-8；**D-票-23 定稿＝原型表單 A 現行版**）。
 * 根 `div.ns-tk-mform`，portal 到 body（同 MobileAttachPicker 的理由：從 `.m-page` 裡開的 fixed 面板蓋不過 tab bar）。
 *
 * 由上而下（原型 app.js mobForm 的 A 分支）：
 *   頂列「取消」・「支出｜收入｜轉帳」・「存」
 *   → 金額大字（inputmode=decimal 系統鍵盤，不自建數字鍵盤；右側幣別 chip 開 sheet）；外幣時下一行「≈ NT$ … · 匯率 …」可改折算額
 *   → 帳戶 chips 橫捲（轉帳＝「從」「到」兩列；不同幣別時多一欄「轉入金額」）
 *   → （收支）「最近」格子＋完整兩層格子（主分類一格一格、點開在那一列下方展子分類）
 *   → 「更多欄位」折疊：日期（MobileDatePicker）・時刻・備註・路線・（舊票，第③階段）定期——「設成定期… ›」或唯讀「每月 1 日 · 管理 ›」
 *   → 底部：新票「存並繼續」（存後清金額與備註、留帳戶分類）／舊票「刪除」
 *
 * 新票＝store 的 `draft`（`openNew`／`setDraft`／`saveDraft`）。舊票＝本地草稿，按「存」才送一次 `updateEntry`
 *   （手機的頂列有明確的「取消／存」，與原型 A 相同；桌機詳情板的即時存是另一種殼的作法——偏離 0-8 字面，見回報）。
 * 高度吃 `--m-vvh`（軟鍵盤彈出時視覺視窗的高；useVisualViewportHeight），底部鈕不被鍵盤蓋住。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { addDays, todayKey } from "../../../lib/date";
import { roundelStyle } from "../../common/roundel";
import { MobileDatePicker } from "../../common/MobileDatePicker";
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
import { IconCaret, IconRight, MSheet, groupLabelOf, nextDraft, useImeGuard } from "./mobileBits";
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
  const catById = useTicketStore((s) => s.catById);
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
      onPatch={(p) => setD((prev) => nextDraft(prev, p, accById, catById))}
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
const SIGN: Record<EntryDraft["kind"], string> = { expense: "", income: "＋", transfer: "⇄" };

function FormShell({
  mode,
  adjust,
  entry,
  draft: d,
  amtRef,
  onPatch,
  onSave,
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
  const recent = useTicketStore((s) => s.recent);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);

  const [sheet, setSheet] = useState<"currency" | "date" | null>(null);
  // 磨光①（主線手機殼契約 §1.5、§9.3）：返回鍵＝「取消」（新帳 requestEscape：有內容先問；舊帳 closePanel）。
  // 幣別／日期 sheet 疊在全螢幕表單上：權重要比 "full" 高才會先關它，所以登記成 "dialog"（toast 也跟著移到頂帶下方，不壓在 sheet 上）
  useBackLayer("ticket.form", true, onCancel, "full");
  useBackLayer("ticket.form.pick", sheet !== null, () => setSheet(null), "dialog");
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
  const dupName = (a: AccountRow) => accounts.filter((x) => x.name === a.name && x.deleted_at === null).length > 1;

  /* 分類 */
  const tree = useMemo(() => categoryTree(categories, catKind, { includeArchived: false }), [categories, catKind]);
  const recentCats = useMemo(
    () =>
      recent[catKind]
        .map((id) => catById[id])
        .filter((c): c is CategoryRow => !!c && c.deleted_at === null && c.archived_at === null && c.kind === catKind)
        .slice(0, 8),
    [recent, catKind, catById],
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

  /* 舊票開啟＝焦點進對話框根（新票由金額欄 autoFocus）；關閉時還回開它的那一行 */
  useEffect(() => {
    if (mode !== "edit") return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      const back = prev && prev.isConnected && prev !== document.body ? prev : document.querySelector<HTMLElement>(".ns-tk-mrow.is-last");
      back?.focus({ preventScroll: true });
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

  /* 完整格子：四欄；展開的子分類區塊插在「那一列」的最後一格之後 */
  const fullGrid = () => {
    const cells: ReactNode[] = [];
    const openIdx = tree.findIndex((t) => t.parent.id === openMain);
    const rowEnd = openIdx < 0 ? -1 : Math.min(tree.length - 1, Math.floor(openIdx / 4) * 4 + 3);
    tree.forEach((t, i) => {
      cells.push(mainCell(t.parent, t.children.length > 0));
      if (i === rowEnd && tree[openIdx].children.length > 0) {
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
    });
    return <div className="ns-tk-mgrid">{cells}</div>;
  };

  const chips = (which: "from" | "to") => {
    const cur = which === "from" ? d.accountId : d.toAccountId;
    const list = which === "to" ? chipAccounts.filter((a) => a.id !== d.accountId) : chipAccounts;
    return (
      <div className="ns-tk-mf-accts" role="group" aria-label={which === "from" ? "帳戶" : "轉入帳戶"}>
        {list.map((a) => (
          <button
            key={a.id}
            type="button"
            className={"ns-tk-mchip" + (a.id === cur ? " on" : "")}
            aria-pressed={a.id === cur}
            disabled={adjust}
            onClick={() => onPatch(which === "from" ? { accountId: a.id } : { toAccountId: a.id, toAmountText: null })}
          >
            {a.name}
            {dupName(a) && <small>{groupLabelOf(a.group_key)}</small>}
          </button>
        ))}
        {list.length === 0 && <span className="ns-tk-mf-none">{which === "to" ? "只有一個帳戶，轉不出去" : "還沒有帳戶"}</span>}
      </div>
    );
  };

  return createPortal(
    <div ref={rootRef} className="ns-tk-mform" tabIndex={-1} data-kind={adjust ? "adjust" : kind} role="dialog" aria-modal="true" aria-label={isNew ? "記一筆" : "這一筆"}>
      <div className="ns-tk-mf-top">
        <button type="button" className="ns-tk-mbtn quiet" onClick={onCancel}>
          取消
        </button>
        {adjust ? (
          <span className="ns-tk-mkind is-locked">精算</span>
        ) : (
          <span className="ns-tk-mkind" role="group" aria-label="類型">
            {KINDS.map((k) => (
              <button key={k.key} type="button" aria-pressed={kind === k.key} onClick={() => onPatch({ kind: k.key })}>
                {k.label}
              </button>
            ))}
          </span>
        )}
        <button type="button" className="ns-tk-mbtn primary" onClick={() => onSave(false)}>
          存
        </button>
      </div>

      <div className="ns-tk-mf-scroll">
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
                <p className="ns-tk-mf-lbl">最近</p>
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
                <input
                  type="time"
                  className="ns-tk-mf-time"
                  value={d.time}
                  aria-label="時刻"
                  onChange={(e) => {
                    if (e.target.value) onPatch({ time: e.target.value });
                  }}
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
          <button type="button" className="ns-tk-mbtn" onClick={() => onSave(true)}>
            存並再記</button>
        ) : (
          <button type="button" className="ns-tk-mbtn danger" onClick={onDelete}>
            刪除
          </button>
        )}
      </div>

      {sheet === "currency" && (
        <MSheet title="幣別" over onClose={() => setSheet(null)}>
          {currencies.map((c) => (
            <button
              key={c.id}
              type="button"
              className={"m-sheet-item ns-tk-msheet-row" + (c.code === curCode ? " is-on" : "")}
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
          <button type="button" className="m-sheet-item is-cancel" onClick={() => setSheet(null)}>
            取消
          </button>
        </MSheet>
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
        />
      )}
    </div>,
    document.body,
  );
}
