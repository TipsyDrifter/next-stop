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
 *   → （收支）「常用」格子（磨光⑥ §2-3：30 天次數，不滿 8 個用最近用過補；原本叫「最近」）＋完整格子（售票口④ 第二輪 D-票-78：
 *     MobileCatDrill 一層一層點進去＋「選這一層」；返回鍵退一層＝"ticket.form.cat"）；
 *     每一層最後一格「＋ 新增…」開小 sheet：打名字建在目前類型、那一層底下，建完選上；sheet 裡的「管理分類…」開分類管理（丙-5 D3，規範 §2.5）
 *   → 「更多欄位」折疊：日期（MobileDatePicker）・時刻（ClockInput mobile，丙-5 F3）・路線・荷札
 *   → 底部：新票「存並繼續」（存後清金額與備註、留帳戶分類）／舊票「存成常用…」「刪除」
 *
 * 售票口④（手機席；D-票-66～70、74，原型 3-二-mobile-收合常用、1A、4、5、6-買了）：
 *   - 新票最上面一排常用票種小卡（點了整張填好）；從願望「買了」開的，類型下面一行「從願望清單帶入「X」· 存了就移到「已買」」
 *   - 常用分類只留一排 4 格（完整格子照舊在下面）；**備註與定期拿到「更多欄位」外**（分類格子下面，D-票-67）
 *   - 備註換 RecallInput（MobileEntryParts.MobileNoteField）：選了以前寫過的、分類還空著 ⇒ 帶上次那筆的分類，
 *     「分類」小標旁出「照上次」＋「復原」（D-票-70）
 *   - 定期列：新票＝草稿的 repeat（四顆小鈕常駐，存檔＝這筆照記＋從下一班建規則）；舊票連著規則＝「每月 1 日 · 下一班 12/1　管理 ›」
 *     （開完整規則編輯器）；沒連＝「不重複　設成定期…」，點了攤開同一組小鈕，按「存」時直接建規則（store.setEntryRepeatQuick）
 *   - 「更多欄位」裡多一列荷札：新票、舊票都是草稿（點選器 insert 模式交回名稱，按「存」才寫；舊票經 tagStore.setTags，它自己 toast＋復原）
 *
 * 新票＝store 的 `draft`（`openNew`／`setDraft`／`saveDraft`）。舊票＝本地草稿，按「存」才送一次 `updateEntry`
 *   （手機的頂列有明確的「取消／存」，與原型 A 相同；桌機詳情板的即時存是另一種殼的作法——偏離 0-8 字面，見回報）。
 * 高度吃 `--m-vvh`（軟鍵盤彈出時視覺視窗的高；useVisualViewportHeight），底部鈕不被鍵盤蓋住。
 * 殼（丙-5 H5）：MFullPage 的本文裡放 `div.ns-tk-mform`（捲動區＋底列），本檔的樣式全掛在它底下；返回層 id 交給 MFullPage（"ticket.form"，
 *   返回鍵＝左鈕＝取消）。疊在表單上的 sheet（幣別、日期、新增分類）共用 "ticket.form.pick"（"dialog"）；「＋ 新增帳戶」與「管理分類…」
 *   走 store 的 openDialog，由 MobileSheetHost 疊在表單上面（表單開著時它登記成 "dialog"）。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTicketStore, type TicketDraft } from "../../../store/ticketStore";
import { useTagStore } from "../../../store/tagStore";
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
  categoryPath,
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
import { quickFollowDay, quickRepeat, repeatLineText, type RepeatQuick, type RepeatQuickFreq } from "../../../domain/ticketPlan";
import { TK_TAG_ENTRY, cleanTagNames, tagNamesOf } from "../../../domain/ticketTags";
import { keyOf } from "../../../domain/tags";
import { useLinkedRepeat } from "../plan/RepeatField";
import { CatPathText, MobileCatDrill, levelFor } from "./MobileCatDrill";
import {
  MobileNoteField,
  RepeatPickSheets,
  RepeatQuickRow,
  TagDraftRow,
  TemplateCards,
  tagSummary,
  type RepeatPick,
} from "./MobileEntryParts";
import { commitCalcInput, hasCalcOperator } from "../../../domain/ticketCalc";
import { CalcIcon, CalcPreviewBadge, MobileCalcPad } from "../CalcPopover";

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

function NewEntry({ draft }: { draft: TicketDraft }) {
  const setDraft = useTicketStore((s) => s.setDraft);
  const setDraftRepeat = useTicketStore((s) => s.setDraftRepeat);
  const saveDraft = useTicketStore((s) => s.saveDraft);
  const closePanel = useTicketStore((s) => s.closePanel);
  const requestEscape = useTicketStore((s) => s.requestEscape);
  const wishName = useTicketStore((s) => (draft.wishId ? (s.wishes.find((w) => w.id === draft.wishId)?.name ?? null) : null));
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
      tags={draft.tags}
      onTags={(tags) => setDraft({ tags })}
      quick={draft.repeat}
      onQuickFreq={setDraftRepeat}
      onQuick={(repeat) => setDraft({ repeat })}
      templateId={draft.fromTemplateId}
      wishName={wishName}
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

/** 兩份荷札名稱是不是同一組（比 key，不管順序與大小寫） */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const ka = a.map((n) => keyOf(n) ?? n).sort();
  const kb = b.map((n) => keyOf(n) ?? n).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function EditEntry({ row }: { row: EntryRow }) {
  const accById = useTicketStore((s) => s.accById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const updateEntry = useTicketStore((s) => s.updateEntry);
  const deleteEntry = useTicketStore((s) => s.deleteEntry);
  const closePanel = useTicketStore((s) => s.closePanel);
  const setEntryRepeatQuick = useTicketStore((s) => s.setEntryRepeatQuick);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const showToast = useUiStore((s) => s.showToast);
  const tagIndex = useTagStore((s) => s.index);
  const adjust = row.kind === "adjust";
  const linked = useLinkedRepeat(row);
  const [d, setD] = useState<EntryDraft>(() => draftFromRow(row, curByCode[row.currency]?.decimals ?? 2));
  /* 荷札草稿（售票口④）：index 載好才知道原本掛了什麼；null＝還不知道（這時按「存」不碰荷札） */
  const [tags, setTags] = useState<string[] | null>(() => (tagIndex ? tagNamesOf(tagIndex, TK_TAG_ENTRY, row.id) : null));
  const origTags = useRef<string[] | null>(tags);
  useEffect(() => {
    const ts = useTagStore.getState();
    if (!ts.index && !ts.loading) void ts.loadIndex();
  }, []);
  useEffect(() => {
    if (!tagIndex || origTags.current !== null) return;
    const now = tagNamesOf(tagIndex, TK_TAG_ENTRY, row.id);
    origTags.current = now;
    setTags(now);
  }, [tagIndex, row.id]);
  /* 定期快設（還沒連規則的帳按了「設成定期…」才有；null＝收著） */
  const [quick, setQuick] = useState<RepeatQuick | null>(null);
  const busy = useRef(false);

  const onPatch = (p: Partial<EntryDraft>) => {
    // 讀 store 的最新表：「＋ 新增帳戶」建完回填時，新帳戶不在這一次 render 的 accById 裡（幣別才跟得上）
    setD((prev) => nextDraft(prev, p, useTicketStore.getState().accById, useTicketStore.getState().catById));
    // 改記帳日 ⇒ 定期的星期幾／幾號（沒點改過的）跟著走（同新票 store.setDraft）
    const to = p.dayKey;
    if (to !== undefined && to !== d.dayKey) setQuick((q) => (q ? quickFollowDay(q, d.dayKey, to) : q));
  };

  const save = async () => {
    if (busy.current) return;
    let patch: EntryPatch;
    let names: string[] | null = null;
    try {
      patch = buildPatch(row, d, adjust, { accById, curByCode }, dayStartHour);
      if (tags !== null && origTags.current !== null && !sameTags(tags, origTags.current)) {
        // 先驗名稱（不合法 ⇒ 整筆不寫，同新票）
        const r = cleanTagNames(tags);
        if (!r.ok) throw new RangeError(`#${r.name.replace(/^#/, "")}：${r.reason}`);
        names = r.names;
      }
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e) });
      return;
    }
    const wantRepeat = !adjust && !linked && quick !== null && quick.freq !== "none" ? quick : null;
    if (Object.keys(patch).length === 0 && names === null && !wantRepeat) {
      closePanel();
      return;
    }
    busy.current = true;
    try {
      if (Object.keys(patch).length > 0) {
        const before = useTicketStore.getState().savedAt;
        await updateEntry(row.id, patch);
        // updateEntry 失敗只吐 toast、不改 savedAt：成功才往下，失敗留著讓主人改
        if (useTicketStore.getState().savedAt === before) return;
      }
      // 荷札：tagStore.setTags 一次寫完（它自己 toast「已掛上／摘下…」＋復原）；失敗它也自己說，帳已經存好就不回捲
      if (names !== null) await useTagStore.getState().setTags(TK_TAG_ENTRY, row.id, names);
      // 定期：從這筆（已存好的樣子）建規則、從下一班起、帶這筆的荷札；toast「已設定期：…」
      if (wantRepeat) await setEntryRepeatQuick(row.id, wantRepeat);
      closePanel();
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
      onPatch={onPatch}
      onSave={() => void save()}
      onCancel={closePanel}
      onDelete={() => void deleteEntry(row.id)}
      tags={tags ?? []}
      onTags={(next) => setTags(next)}
      quick={quick}
      onQuickFreq={(f) => setQuick((q) => quickRepeat(f, d.dayKey, q?.until ?? null))}
      onQuick={setQuick}
      // 點「設成定期…」＝想設：先選好「每月（記帳那天）」，不想要再點「不重複」
      onQuickOpen={() => setQuick(quickRepeat("monthly", d.dayKey))}
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
  tags,
  onTags,
  quick,
  onQuickFreq,
  onQuick,
  onQuickOpen,
  templateId = null,
  wishName = null,
}: {
  mode: Mode;
  adjust: boolean;
  /** 舊票那一列（「定期」列要看它的 repeat_id、「存成常用…」要它的 id）；新票 undefined */
  entry?: EntryRow;
  draft: EntryDraft;
  amtRef?: RefObject<HTMLInputElement | null>;
  onPatch(p: Partial<EntryDraft>): void;
  onSave(again: boolean): void;
  onCancel(): void;
  onDelete?(): void;
  /* 售票口④ */
  /** 荷札草稿（名稱；按「存」才寫） */
  tags: readonly string[];
  onTags(names: string[]): void;
  /** 定期快設：新票＝草稿的 repeat；舊票＝按了「設成定期…」才有（null＝收著） */
  quick: RepeatQuick | null;
  onQuickFreq(f: RepeatQuickFreq): void;
  onQuick(q: RepeatQuick): void;
  /** 舊票「設成定期…」：攤開快設 */
  onQuickOpen?(): void;
  /** 從哪張常用票種小卡填的（那張亮起） */
  templateId?: string | null;
  /** 從願望「買了」開的：願望名稱（類型下面那一行） */
  wishName?: string | null;
}) {
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const currencies = useTicketStore((s) => s.currencies);
  const curByCode = useTicketStore((s) => s.curByCode);
  const frequent = useTicketStore((s) => s.frequent);
  const routes = useNodeStore((s) => s.routes);
  // 路線選單只列還在跑的（車庫與回顧 D-主-206 #13）
  const liveRoutes = useNodeStore((s) => s.liveRoutes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);

  const [sheet, setSheet] = useState<"currency" | "date" | "newCat" | null>(null);
  // 磨光①（主線手機殼契約 §1.5、§9.3）：返回鍵＝「取消」（新帳 requestEscape：有內容先問；舊帳 closePanel）——丙-5 起由 MFullPage
  // 以 backId "ticket.form" 登記（返回鍵＝左鈕），本檔不再另登一層。
  // 幣別／日期／新增分類 sheet 疊在全螢幕表單上：權重要比 "full" 高才會先關它，所以登記成 "dialog"（toast 也跟著移到頂帶下方，不壓在 sheet 上）；
  // 三支 sheet 都給同一個 backId ⇒ 跟這一行合併成一層，返回鍵按一次就關
  useBackLayer("ticket.form.pick", sheet !== null, () => setSheet(null), "dialog");
  // 售票口④：定期列的星期幾／幾號／結束日面板（同樣疊在表單上＝"dialog"）
  const [repPick, setRepPick] = useState<RepeatPick | null>(null);
  useBackLayer("ticket.form.rep", repPick !== null, () => setRepPick(null), "dialog");
  const [calcOpen, setCalcOpen] = useState(false);
  useBackLayer("ticket.form.calc", calcOpen, () => setCalcOpen(false), "dialog");
  const openDialog = useTicketStore((s) => s.openDialog);
  const createCategory = useTicketStore((s) => s.createCategory);
  // 備註搬到折疊外之後（D-票-67），舊票有掛路線或荷札才預設攤開
  const [more, setMore] = useState(mode === "edit" && (d.routeId !== null || tags.length > 0));
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
  const recentCats = useMemo(
    () =>
      frequent[catKind]
        .map((id) => catById[id])
        .filter((c): c is CategoryRow => !!c && c.deleted_at === null && c.archived_at === null && c.kind === catKind)
        .slice(0, 4), // 售票口④ D-票-67：常用只留一排 4 格（備註與定期拿到折疊外，第一屏放得下）
    [frequent, catKind, catById],
  );
  const selCat = d.categoryId ? (catById[d.categoryId] ?? null) : null;
  // 售票口④ 第二輪（D-票-78）：格子一層一層點進去；打開改一筆時停在選中那一個所在的層
  const [catLevel, setCatLevel] = useState<string | null>(() => levelFor(d.categoryId, catById));
  // 新增分類 sheet 建在哪一層底下（按「＋ 新增…」時所在的那一層）
  const [newCatUnder, setNewCatUnder] = useState<string | null>(null);

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
  const linkedRule = useLinkedRepeat(entry); // 連著還在的規則（規則已刪 ⇒ null，當成沒連）
  // 備註與定期在折疊外（D-票-67）⇒ 摘要只寫折疊裡的：日期時刻 · 路線 · 荷札
  const tagSum = tagSummary(tags);
  const moreSum =
    `${d.dayKey === today ? "今天" : shortDayKey(d.dayKey)} ${d.time} · ${route ? `${route.code ? route.code + " " : ""}${route.name}` : "不掛路線"}` +
    (tagSum ? ` · ${tagSum}` : "");

  /* 定期列（D-票-66）：舊票連著規則「每月 1 日 · 下一班 12/1　管理 ›」開完整規則編輯器（疊在表單上，存完回到這一筆）；
     沒連的「不重複　設成定期…」攤開快設，按「存」才建規則；進階規則走快設裡的「更多設定…」（原本的 makeRepeatFromEntry） */
  const openRepeatEditor = useTicketStore((s) => s.openRepeatEditor);
  const makeRepeatFromEntry = useTicketStore((s) => s.makeRepeatFromEntry);

  /* 備註記憶（D-票-70）：選了以前寫過的、分類還空著 ⇒ 帶上次那筆的分類；`autoCat`＝帶上的那個（「照上次 · 復原」） */
  const lastCategoryForNote = useTicketStore((s) => s.lastCategoryForNote);
  const [autoCat, setAutoCat] = useState<string | null>(null);
  const onNotePick = (text: string) => {
    if (adjust || transfer || d.categoryId) return;
    const id = lastCategoryForNote(catKind, text);
    if (!id) return;
    onPatch({ categoryId: id });
    setAutoCat(id);
    setCatLevel(levelFor(id, catById));
  };
  const showAuto = autoCat !== null && d.categoryId === autoCat;

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

  const pickCat = (c: CategoryRow) => {
    setAutoCat(null);
    onPatch({ categoryId: c.id });
  };
  /* 分類格子（D-票-78）：一層一層點進去；每一層最後一格「＋ 新增…」（規範 §2.5），建在那一層底下 */
  const catGrid = (
    <MobileCatDrill
      kind={catKind}
      level={catLevel}
      onLevel={setCatLevel}
      picked={d.categoryId ? [d.categoryId] : []}
      onPick={pickCat}
      rootLabel={catKind === "income" ? "收入" : "支出"}
      backId="ticket.form.cat"
      backKind="full"
      tail={(lv) => (
        <button
          key="add"
          type="button"
          className="ns-tk-mcell is-add"
          aria-haspopup="dialog"
          onClick={() => {
            setNewCatUnder(lv);
            setSheet("newCat");
          }}
        >
          ＋ 新增…
        </button>
      )}
    />
  );

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
        {/* 售票口④ D-票-68：常用票種小卡（只在新票；點了整張填好、只差存檔） */}
        {isNew && <TemplateCards activeId={templateId} />}
        {/* 類型＝內文第一列（P5 A 案）；校正票不能改類型，只寫「精算」 */}
        <div className="ns-tk-mf-kind">
          {adjust ? (
            <span className="ns-tk-mkind is-locked">精算</span>
          ) : (
            <Segmented options={KIND_OPTIONS} value={kind} onChange={(k) => onPatch({ kind: k })} aria-label="類型" />
          )}
        </div>
        {/* 售票口④ D-票-69：從願望「買了」開的 */}
        {wishName !== null && <p className="ns-tk-mre-from">從願望清單帶入「{wishName}」· 存了就移到「已買」</p>}
        <div className="ns-tk-mf-amt">
          <span className="sg">{adjust ? "±" : SIGN[kind]}</span>
          <input
            ref={amtRef}
            className="ns-tk-mamtin"
            inputMode={calcOpen ? "none" : "text"}
            autoComplete="off"
            enterKeyHint="done"
            autoFocus={isNew}
            value={d.amountText}
            placeholder="0"
            aria-label="金額"
            onChange={(e) => onPatch({ amountText: e.target.value })}
            onBlur={() => {
              if (!calcOpen && hasCalcOperator(d.amountText)) {
                const next = commitCalcInput(d.amountText, {
                  allowNegative: adjust || kind === "expense",
                  decimals: cur?.decimals ?? 2,
                });
                if (next !== d.amountText) onPatch({ amountText: next });
              }
            }}
            {...amtIme}
          />
          <button
            type="button"
            className={`ns-tk-mcalcbtn${calcOpen ? " is-on" : ""}`}
            aria-label="小算盤鍵盤"
            aria-expanded={calcOpen}
            title="切換小算盤鍵盤"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setCalcOpen((o) => {
                const next = !o;
                if (next) amtRef?.current?.blur();
                return next;
              });
            }}
          >
            <CalcIcon size={16} />
          </button>
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
        {hasCalcOperator(d.amountText) && !calcOpen && (
          <div className="ns-tk-mf-calcrow">
            <CalcPreviewBadge
              value={d.amountText}
              decimals={cur?.decimals ?? 2}
              allowNegative={adjust || kind === "expense"}
              currencyPrefix={curCode === MAIN_CURRENCY ? MAIN_SYMBOL : curCode}
              onCommit={(v) => onPatch({ amountText: v })}
            />
          </div>
        )}
        {calcOpen && (
          <MobileCalcPad
            value={d.amountText}
            decimals={cur?.decimals ?? 2}
            allowNegative={adjust || kind === "expense"}
            onChange={(next) => onPatch({ amountText: next })}
            onDone={() => setCalcOpen(false)}
          />
        )}
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
                      // 小字＝上一層（多層時只寫直屬那一層；完整路徑在「分類」小標）
                      const path = categoryPath(c, catById);
                      const p = path.length > 1 ? path[path.length - 2] : undefined;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={"ns-tk-mcell" + (selCat?.id === c.id ? " on" : "")}
                          aria-pressed={selCat?.id === c.id}
                          onClick={() => {
                            pickCat(c);
                            setCatLevel(levelFor(c.id, catById));
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
            <p className="ns-tk-mf-lbl ns-tk-m4-catlbl">
              分類<em>{selCat ? <CatPathText cat={selCat} /> : "未選"}</em>
              {/* D-票-70：選了以前的備註順手帶上的分類 */}
              {showAuto && (
                <>
                  <span className="auto">照上次</span>
                  <button
                    type="button"
                    className="undo"
                    onClick={() => {
                      setAutoCat(null);
                      onPatch({ categoryId: null });
                    }}
                  >
                    復原
                  </button>
                </>
              )}
            </p>
            <div className="ns-tk-mf-cats">{catGrid}</div>
          </>
        )}

        {/* 售票口④ D-票-67：備註與定期在「更多欄位」外面（分類格子下面） */}
        <div className="ns-tk-m4-out">
          <MobileNoteField value={d.note} onChange={(note) => onPatch({ note })} onPick={onNotePick} />
          {adjust ? null : isNew && quick ? (
            <RepeatQuickRow
              value={quick}
              dayKey={d.dayKey}
              lead="存檔＝這筆照記，"
              onFreq={onQuickFreq}
              onPick={setRepPick}
            />
          ) : entry && linkedRule ? (
            <div className="ns-tk-mf-field ns-tk-mf-rep is-ro">
              <span className="lbl">定期</span>
              <span className="v">{repeatLineText(linkedRule)}</span>
              <button type="button" className="ns-tk-mf-pick" aria-haspopup="dialog" onClick={() => openRepeatEditor(linkedRule.id)}>
                管理
                <IconRight size={11} />
              </button>
            </div>
          ) : entry && quick ? (
            <RepeatQuickRow
              value={quick}
              dayKey={d.dayKey}
              lead="按「存」之後，"
              onFreq={onQuickFreq}
              onPick={setRepPick}
              onMore={() => makeRepeatFromEntry(entry.id)}
            />
          ) : entry ? (
            <div className="ns-tk-mf-field ns-tk-mf-rep">
              <span className="lbl">定期</span>
              <span className="v is-none">不重複</span>
              <button type="button" className="ns-tk-mf-pick" onClick={onQuickOpen}>
                設成定期…
              </button>
            </div>
          ) : null}
        </div>

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
                  {liveRoutes.map((r) => (
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
              {/* 售票口④ D-票-74：荷札（草稿；按「存」才寫） */}
              <TagDraftRow value={tags} onChange={onTags} title={isNew ? "荷札・記一筆" : "荷札・這一筆"} />
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
          <>
            {/* 售票口④ D-票-68：存成常用（取名的小面板由 MobileSheetHost 疊上來）；精算不能存 */}
            {entry && !adjust && (
              <button
                type="button"
                className="ns-btn btn-ghost ns-tk-mbtn"
                aria-haspopup="dialog"
                onClick={() => openDialog({ kind: "saveTemplate", entryId: entry.id })}
              >
                存成常用…
              </button>
            )}
            <button type="button" className="ns-btn btn-ghost ns-btn-danger ns-tk-mbtn" onClick={onDelete}>
              刪除
            </button>
          </>
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
          under={newCatUnder ? (catById[newCatUnder] ?? null) : null}
          onClose={() => setSheet(null)}
          onCreate={async (name) => {
            const parent = newCatUnder && catById[newCatUnder]?.kind === catKind ? newCatUnder : null;
            const row = await createCategory({ kind: catKind, name, parentId: parent });
            if (!row) return false; // 失敗 store 已吐 toast；sheet 留著讓主人改名
            pickCat(row);
            setCatLevel(parent); // 留在那一層，看得到剛建好、已選上的那一格
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
      {quick && (
        <RepeatPickSheets which={repPick} value={quick} dayKey={d.dayKey} backId="ticket.form.rep" onChange={onQuick} onClose={() => setRepPick(null)} />
      )}
    </MFullPage>
  );
}

/* ═══════════ 新增分類 sheet（丙-5 D3） ═══════════ */

/**
 * 分類格最後一格「＋ 新增…」開的小 sheet：一個名稱欄＋黏底「取消｜新增」；建在目前類型（支出／收入）、格子所在的那一層底下
 * （售票口④ 第二輪：頂層＝主分類；走進「外食」裡按的＝建在外食底下，名稱欄上一行淡字寫在哪），建完由呼叫端選上。
 * 「管理分類…」（文字鈕，規範 §2.3「面板內『新增…』『管理…』」）關掉自己、開分類管理。疊在全螢幕表單上＝"dialog"（z 47）。
 */
function NewCategorySheet({
  kind,
  under,
  onClose,
  onCreate,
  onManage,
}: {
  kind: "expense" | "income";
  /** 建在哪一個分類底下（null＝頂層） */
  under: CategoryRow | null;
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
      {under && (
        <p className="ns-tk-m4b-under">
          建在「<CatPathText cat={under} />」底下
        </p>
      )}
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
