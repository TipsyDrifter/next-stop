/**
 * TicketLedger——售票口桌機頁的主欄「帳簿」（車次①契約 §5.1、0-1、0-2、0-4；乙席）。
 *
 *   main.ns-tk-ledger.is-compact（自己捲；緊湊密度 D-票-21）
 *   ├─ PageHeader.ns-tk-pagehead（UI 丙-5 A1：身分式，跟其他五頁同一副骨架）
 *   │     眉標 {售票口, Ticket Office}・大標 DateNav（‹ 10月 › 今天；統計年模式 unit="year"「‹ 2026 年 › 今年」；搜尋中＝「搜尋結果」）
 *   │     補述 2026年（搜尋中＝文字鈕「‹ 回 10 月」）・stats 本月支出／收入（搜尋中＝找到 N 筆…）
 *   │     工具列［清單｜月曆｜統計］［＋ 記一筆］［搜尋］［⚙ 管帳］（管帳＝共用 PopMenu，B1）
 *   ├─ div.ns-tk-subbar（A4／P3 A 案：頁首下一列，清單視圖常駐；月曆／統計不畫）
 *   │     左＝帳戶篩選 chip（書封點帳戶）／搜尋框＋FilterChips（搜尋開著）・右＝排序
 *   └─ div.ns-tk-book（一張霧面紙，不打孔——帳簿行不是票卡）；空帳本＝EmptyState（A5，頁首此時不給「＋ 記一筆」）
 *       └─ ul.ns-tk-list（listbox，焦點容器 tabIndex=0；鍵盤表由頁根的 useTicketKeyboard 接）
 *           li.ns-tk-day（日付小字＋當日小計淡字）／li.ns-tk-row（帳簿行）／li.ns-tk-monthrule（往前接的月份）
 *           li.ns-tk-loadmore（捲到底自動接前一個月；IntersectionObserver）／空狀態 li.ns-tk-empty
 *
 * 只讀 store、只叫 store 的動作（§2.5）；domain 的純函式直接用（moneyText／rowAmount／monthTitle…）。
 * 本檔另外 export 桌機三個元件共用的小件：`TkIcon`（1.3px 細線圖示）、`acctLabel`（同名帳戶加群組）、`TkRoundel`。
 *
 * 第②階段（②契約 §5.1、0-15、0-16）：搜尋作用中（清單＋有條件）⇒ 大標換成「搜尋結果」、清單畫 resultDays
 *   （跨月、日分組頭印年、每頁 300 筆）。main 依 view 換成 TicketCalendar／TicketStats。
 * UI 丙-5 A6：1280 寬開著大票（340）時主欄剛好 704、PageHeader 不切窄版；頁首實寬只剩約 644，
 *   DateNav／「今天」不換行、年份補述在頁首窄於 720 時收起（container query）、stats 單行省略（ticket.css T1 區）。
 *   UI 丙-7：頁首外距改吃 --page-pad-x 後頁首剩 600，全套工具列放不下 ⇒ 頁首 <720 一併強制 PageHeader 窄版（useHeadNarrow）。
 *   月曆跳回來（jumpToDay）⇒ store.pendingDay：捲到那一天的日分組頭、閃一下；那天沒帳 ⇒ 捲到最接近的日、帳簿頂端貼一行淡字「10/8 沒有紀錄」3 秒（sticky：頁首此時已捲出畫面）。
 *
 * 磨光⑥ 契約 §2-4（D-票-64）：「排序」（FilterChips 的 SortButton；UI 丙-5 起在頁首下一列右端）；搜尋結果依 store.resultSort 畫——
 *   日期排序照舊日分組（舊到新＝組與組內都反過來，store 已排好）；金額排序＝平面清單 ul.is-flat：不分日、每列前面多一欄日期「10/21（三）」，
 *   沒有月份分隔與日小計（月曆跳日本來就會先關搜尋）。↑↓ 照 results 走（useTicketKeyboard），300 筆分頁照 results 切；
 *   選到還沒畫出來的那一頁（↑↓ 走過頭）⇒ 自動翻到那一頁。
 *
 * 往前接月份的停點：store 沒有「最早一筆在哪個月」，所以連續 3 個月都空就停止自動接、改成手按「繼續往前」
 * （不然沒有更早的帳時會一路往前載空月）。見回報 needs。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { useNodeStore } from "../../store/nodeStore";
import { todayKey } from "../../lib/date";
import { formatChord, hotkeyById } from "../shell/hotkeys";
import { roundelStyle } from "../common/roundel";
import {
  ACCOUNT_GROUPS,
  MAIN_CURRENCY,
  MAIN_SYMBOL,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  addMonths,
  monthOf,
  monthTitle,
  moneyText,
  rowAmount,
  type AccountRow,
  type CategoryRow,
  type DayGroup,
  type EntryRow,
} from "../../domain/ticket";
import type { NodeRow } from "../../domain/node";
import { RESULT_PAGE, VIEW_TEXT, flatDayText, isAmountSort, isFilterActive, pageResults, resultSummary } from "../../domain/ticketView";
import { PageHeader } from "../common/PageHeader";
import { DateNav } from "../common/DateNav";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import { EmptyState } from "../common/EmptyState";
import { IconBack, IconClose, IconPlus } from "../common/icons";
// 第②階段（②契約 §5.1）：頁首視圖切換／搜尋列／篩選 chips、月曆與統計視圖
import { switchView, viewTabItems } from "./view/ViewSwitch";
import { SearchBar, focusTicketSearch } from "./view/SearchBar";
import { FilterChips, SortButton } from "./view/FilterChips";
import { TicketCalendar } from "./view/TicketCalendar";
import { TicketStats } from "./view/TicketStats";

/* ───────── 共用小件（桌機三個元件共用） ───────── */

const ICONS = {
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  left: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  right: <path d="M6 3.5 10.5 8 6 12.5" />,
  x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  caret: <path d="M4 6l4 4 4-4" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.6 10.6 14 14" />
    </>
  ),
} satisfies Record<string, ReactNode>;

/** 1.3px 細線幾何圖示（16 viewBox；旅客筆記原型同筆觸） */
export function TkIcon({ name, size = 14 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

/** 群組的中文名（不認得的 group_key 當「其他」） */
export function groupLabel(key: string): string {
  return (ACCOUNT_GROUPS.find((g) => g.key === key) ?? ACCOUNT_GROUPS[ACCOUNT_GROUPS.length - 1]).label;
}

/** 帳戶名；同名的未刪帳戶（兩張「悠遊卡」）後面補「（群組）」 */
export function acctLabel(a: AccountRow | undefined, accounts: readonly AccountRow[]): string {
  if (!a) return "（帳戶已刪除）";
  const dup = accounts.some((x) => x.id !== a.id && x.deleted_at === null && x.name === a.name);
  return dup ? `${a.name}（${groupLabel(a.group_key)}）` : a.name;
}

/** 路線圓牌（亮盤深字；換算見 common/roundel.ts）；route＝null ⇒ 虛線空圓 */
export function TkRoundel({ route }: { route: NodeRow | null | undefined }) {
  if (!route) return <span aria-hidden className="roundel ns-tk-rd empty" />;
  return (
    <span aria-hidden className="roundel ns-tk-rd" style={roundelStyle(route.color)}>
      {route.code ?? ""}
    </span>
  );
}

/** 鍵帽字（registry 單一來源；不在 UI 寫死 Ctrl+…） */
export function capsOf(id: string): string {
  const hk = hotkeyById(id);
  return hk ? formatChord(hk.chords[0]).join("+") : "";
}

const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

/** 帳簿行的「分類」欄（0-2／§5.1：主 › 子；轉帳＝帳戶 → 帳戶；校正＝墨小字「精算」＋帳戶） */
export function EntryCat({ e }: { e: EntryRow }) {
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  if (e.kind === "transfer") {
    return (
      <>
        {acctLabel(accById[e.account_id], accounts)}
        <span className="arr">→</span>
        {acctLabel(e.to_account_id ? accById[e.to_account_id] : undefined, accounts)}
      </>
    );
  }
  if (e.kind === "adjust") {
    return (
      <>
        <span className="seikan">精算</span>
        {acctLabel(accById[e.account_id], accounts)}
      </>
    );
  }
  if (!e.category_id || isUncat(e.category_id)) return <span className="unc">未分類</span>;
  const c: CategoryRow | undefined = catById[e.category_id];
  if (!c) return <span className="unc">（分類已刪除）</span>;
  const p = c.parent_id ? catById[c.parent_id] : undefined;
  if (!p) return <>{c.name}</>;
  return (
    <>
      {p.name}
      <span className="gt">›</span>
      {c.name}
    </>
  );
}

/* ───────── 帳簿 ───────── */

/** 連續幾個空月後停止自動往前接 */
const AUTO_EMPTY_STOP = 3;

/** 售票口頁首窄版門檻（頁首本身的寬）：同 ticket.css T1 區 `@container tk-head (max-width: 719px)` */
const TK_HEAD_COMPACT_BELOW = 720;

/** 量主欄裡 `.ns-tk-pagehead` 的寬：< below ⇒ true。側板開關、視窗拖拉即時跟上 */
function useHeadNarrow(mainRef: RefObject<HTMLElement | null>, below: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const head = mainRef.current?.querySelector<HTMLElement>(".ns-tk-pagehead");
    if (!head) return;
    const measure = () => setNarrow(head.getBoundingClientRect().width < below);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(head);
    return () => ro.disconnect();
  }, [mainRef, below]);
  return narrow;
}

export interface TicketLedgerProps {
  listRef: RefObject<HTMLUListElement | null>;
  /** 雙擊一行＝開這一筆（焦點進詳情板金額欄） */
  onOpen(id: string): void;
}

export function TicketLedger({ listRef, onOpen }: TicketLedgerProps) {
  const ready = useTicketStore((s) => s.ready);
  const error = useTicketStore((s) => s.error);
  const hasAny = useTicketStore((s) => s.hasAny);
  const month = useTicketStore((s) => s.month);
  const loadedMonths = useTicketStore((s) => s.loadedMonths);
  const days = useTicketStore((s) => s.days);
  const entries = useTicketStore((s) => s.entries);
  const monthSum = useTicketStore((s) => s.monthSum);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const selectedId = useTicketStore((s) => s.selectedId);
  const panel = useTicketStore((s) => s.panel);
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const routes = useNodeStore((s) => s.routes);
  const view = useTicketStore((s) => s.view);
  const span = useTicketStore((s) => s.span);
  const period = useTicketStore((s) => s.period);
  const searchOpen = useTicketStore((s) => s.searchOpen);
  const filter = useTicketStore((s) => s.filter);
  const results = useTicketStore((s) => s.results);
  const resultDays = useTicketStore((s) => s.resultDays);
  const resultSort = useTicketStore((s) => s.resultSort);
  const pendingDay = useTicketStore((s) => s.pendingDay);
  const dayNotice = useTicketStore((s) => s.dayNotice);

  const today = todayKey(dayStartHour);
  const thisMonth = monthOf(today);
  // 頁首 stats 的月份字：看的是當月寫「本月」，翻到別的月份寫「9月」（跟大標的「9月」同寫法；年份大標旁邊已經有了）
  const monthWord = month === thisMonth ? "本月" : `${Number(month.slice(5, 7))}月`;
  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;
  const routeById = useMemo(() => {
    const m: Record<string, NodeRow> = {};
    for (const r of routes) m[r.id] = r;
    return m;
  }, [routes]);

  // 有帳的月（判斷往前接的停點、月份分隔）
  const monthsWithRows = useMemo(() => new Set(entries.map((e) => monthOf(e.occurred_on))), [entries]);
  const months = loadedMonths.length ? loadedMonths : [month];
  let trailingEmpty = 0;
  for (let i = months.length - 1; i >= 1; i--) {
    if (monthsWithRows.has(months[i])) break;
    trailingEmpty++;
  }
  const oldest = months[months.length - 1];
  const prevMonth = addMonths(oldest, -1);
  const autoLoad = ready && hasAny && trailingEmpty < AUTO_EMPTY_STOP;

  /* 捲到底自動接前一個月（同 MobileNoteList 的做法；載入中不重複觸發） */
  const sentinelRef = useRef<HTMLLIElement>(null);
  const loadingRef = useRef(false);
  useEffect(() => {
    loadingRef.current = false; // loadedMonths 變了＝上一次接完
  }, [loadedMonths]);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !autoLoad || typeof IntersectionObserver === "undefined") return;
    const root = el.closest(".ns-tk-ledger");
    const io = new IntersectionObserver(
      (list) => {
        if (!list.some((x) => x.isIntersecting) || loadingRef.current) return;
        loadingRef.current = true;
        void useTicketStore.getState().loadOlderMonth();
      },
      { root, rootMargin: "0px 0px 160px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [autoLoad, loadedMonths, view]); // view：切回清單時哨兵是新的 DOM，要重掛

  const store = useTicketStore.getState;
  const filterAcc = filterAccountId ? accById[filterAccountId] : undefined;
  const panelOpen = panel.kind === "entry";
  const searching = view === "list" && searchOpen && isFilterActive(filter); // 0-15：清單畫搜尋結果
  const yearMode = view === "stats" && span === "year";
  const emptyBook = view === "list" && ready && !hasAny && !searching; // A5：EmptyState 出現時頁首不給「＋ 記一筆」
  const tabItems = useMemo(() => viewTabItems(), []);

  /* B1：頁首「⚙ 管帳」開共用 PopMenu（anchor＝那顆鈕；再點一次＝收） */
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const manageItems: PopMenuItem[] = [
    { key: "categories", label: "分類管理", onSelect: () => store().openDialog({ kind: "categories" }) },
    // 磨光⑥ 契約 §2-1（D-票-61）：帳戶順序；第③階段（③契約 0-14）：預算…、定期帳…
    { key: "accountOrder", label: "帳戶順序", onSelect: () => store().openDialog({ kind: "accountOrder" }) },
    { key: "budgets", label: "預算…", onSelect: () => store().openDialog({ kind: "budgets" }) },
    { key: "repeats", label: "定期帳…", onSelect: () => store().openDialog({ kind: "repeats" }) },
    { key: "currencies", label: "幣別與匯率", onSelect: () => store().openDialog({ kind: "currencies" }) },
    { key: "import", label: "從財務管家匯入…", cut: true, onSelect: () => void store().startImport("desktop") },
  ];

  /* A3：頁首放大鏡——沒開 ⇒ 開搜尋並聚焦框；開著但沒條件 ⇒ 收起；開著有條件 ⇒ 聚焦框（不丟掉條件） */
  const onSearchBtn = () => {
    const s = store();
    if (s.searchOpen && !isFilterActive(s.filter)) {
      s.closeSearch();
      return;
    }
    s.openSearch();
    focusTicketSearch();
  };

  /* 統計年模式「今年」：store 只有一步一年的 stepMonth，往後走到今年（年模式不動 month） */
  const thisYear = thisMonth.slice(0, 4);
  const toThisYear = async () => {
    for (let n = 0; n < 50 && useTicketStore.getState().period.key < thisYear; n++) await store().stepMonth(1);
    for (let n = 0; n < 50 && useTicketStore.getState().period.key > thisYear; n++) await store().stepMonth(-1);
  };
  const monthNo = `${Number(month.slice(5, 7))}月`;
  const backLabel = month.slice(0, 4) === thisYear ? monthNo : monthTitle(month); // 「‹ 回 10 月」；別年才帶年

  /* 搜尋結果分頁（0-14：先畫 300 筆）；結果換了就回第一頁 */
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [results]);
  // ↑↓ 在結果裡走（results 全部）走到還沒畫的那一頁 ⇒ 翻過去（不然選中的那一行不在畫面上）
  useEffect(() => {
    if (!results || selectedId === null) return;
    const i = results.findIndex((e) => e.id === selectedId);
    if (i >= page * RESULT_PAGE) setPage(Math.floor(i / RESULT_PAGE) + 1);
  }, [results, selectedId, page]);
  const flat = searching && isAmountSort(resultSort);
  // 平面清單跨年 ⇒ 日期欄要印年（「2025/10/21（三）」），欄寬跟著放寬
  const flatSpanYears = flat && !!results && new Set(results.map((e) => e.occurred_on.slice(0, 4))).size > 1;

  /* 切視圖／搜尋收起時焦點若掉到 body（清單、chip、「回 N 月」鈕卸載了）⇒ 還給清單／頁根，鍵盤表才接得到。
     一支 effect 收全部入口（1／2／3、點分頁、Esc、點「回 N 月」、篩選鈕），不在每條路各自補 focus */
  useEffect(() => {
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (a !== null && a !== document.body) return;
      const root = document.querySelector<HTMLElement>(".page.ns-tk");
      (root?.querySelector<HTMLElement>(".ns-tk-list") ?? root)?.focus({ preventScroll: true });
    });
    return () => clearTimeout(t);
  }, [view, searchOpen]);

  /* 切視圖 ⇒ main 捲回頂：不然清單捲深處切統計／日曆，舊 scrollTop 被夾成新內容的高度，頁首捲出畫面。
     layout effect＝畫出新視圖前就歸零（不閃一下中段）；月曆 Enter 跳回清單的捲到那天在下面 setTimeout 裡，晚於這裡 */
  const mainRef = useRef<HTMLElement>(null);
  const lastView = useRef(view);
  useLayoutEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [view]);

  /* UI 丙-7：頁首實寬 <720 ⇒ 強制窄版（分頁籤改下拉、記一筆收成圖示鈕）。
     PageHeader 的自動窄版量主欄（<704 才收），但售票口大標是整組 DateNav（‹ 10月 › 今天），比別頁寬；
     1280 開側板時主欄剛好 704、頁首只剩 600，全套擠不下、「今天」會壓到分頁籤。
     門檻 720 跟 ticket.css T1 區的 container query（年份收起）同一條。頁首是區塊元素，寬度不隨窄版與否變，不會來回切。 */
  const headNarrow = useHeadNarrow(mainRef, TK_HEAD_COMPACT_BELOW);

  /* 月曆跳回清單（0-16）／Ctrl+P 跳到一筆：捲到那一天、閃一下 */
  const [flashDay, setFlashDay] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingDay || view !== "list") return;
    const t = setTimeout(() => {
      const list = listRef.current;
      const head = list?.querySelector<HTMLElement>(`li.ns-tk-day[data-day="${pendingDay}"]`);
      if (!list || !head) return; // 還沒載到（setMonth 的 refresh 還沒回來）：days 變了會再試
      head.scrollIntoView({ block: "start" }); // 不用 smooth：切月後往前接月份會改版面，平滑捲動會被打斷
      // 那天沒帳（dayNotice）＝捲到最接近的日但不閃：閃的是「你點的那一天」（原型同）
      if (useTicketStore.getState().dayNotice === null) setFlashDay(pendingDay);
      useTicketStore.getState().consumePendingDay();
    });
    return () => clearTimeout(t);
  }, [pendingDay, view, days, listRef]);
  useEffect(() => {
    if (!flashDay) return;
    const t = setTimeout(() => setFlashDay(null), 1600);
    return () => clearTimeout(t);
  }, [flashDay]);
  useEffect(() => {
    if (!dayNotice) return;
    const t = setTimeout(() => useTicketStore.getState().clearDayNotice(), 3000);
    return () => clearTimeout(t);
  }, [dayNotice]);

  /* 一筆帳簿行（月份清單與搜尋結果共用）；day＝平面清單（金額排序）每列前面的日期字 */
  const rowOf = (e: EntryRow, day?: string): ReactNode => {
    const active = panelOpen && selectedId === e.id;
    const amt = rowAmount(e, filterAccountId, accById);
    const cur = curByCode[amt.currency];
    const foreign = amt.currency !== MAIN_CURRENCY;
    const route = e.route_id ? routeById[e.route_id] : undefined;
    return (
      <li
        key={e.id}
        id={`tk-row-${e.id}`}
        role="option"
        aria-selected={selectedId === e.id}
        className={`ns-tk-row${active ? " is-active" : ""}`}
        data-kind={e.kind}
        onMouseDown={(ev) => ev.preventDefault() /* 焦點留在清單（鍵盤表接得到） */}
        onClick={() => {
          store().select(e.id);
          listRef.current?.focus({ preventScroll: true });
        }}
        onDoubleClick={() => onOpen(e.id)}
      >
        <span className="ns-tk-sign" aria-hidden>
          {amt.prefix}
        </span>
        {day !== undefined && <span className="ns-tk-rday">{day}</span>}
        <span className="ns-tk-main">
          <span className="ns-tk-cat">
            <EntryCat e={e} />
          </span>
          {/* 第③階段（③契約 §5.4、✎-5）：定期記的帳（規則已刪也照標） */}
          {e.repeat_id && (
            <span className="ns-tk-rep" title="定期帳記的">
              定期
            </span>
          )}
          {e.note && <span className="ns-tk-note">{e.note}</span>}
        </span>
        <span className="ns-tk-route">
          {route && (
            <>
              <TkRoundel route={route} />
              {route.code}
            </>
          )}
        </span>
        <span
          className="ns-tk-amt"
          title={foreign && amt.convMain !== null ? `≈ ${MAIN_SYMBOL} ${moneyText(amt.convMain, mainDec, { whole: true })}` : undefined}
        >
          <b>{moneyText(amt.minor, cur?.decimals ?? 2)}</b>
          {foreign && <span className="cur">{amt.currency}</span>}
        </span>
        <i className="rule" aria-hidden />
      </li>
    );
  };

  /* 一天：分組頭（日付小字＋當日小計）＋帳簿行；withYear＝搜尋結果跨月時印年 */
  const pushDay = (out: ReactNode[], g: DayGroup, withYear: boolean) => {
    const [d, w] = g.label.split(" ");
    out.push(
      <li key={`d-${g.dayKey}`} className={"ns-tk-day" + (flashDay === g.dayKey ? " is-flash" : "")} role="presentation" data-day={g.dayKey}>
        <span className="d">{withYear ? `${g.dayKey.slice(0, 4)}/${d}` : d}</span>
        <span className="w">{w}</span>
        {g.dayKey === today && <span className="today">今天</span>}
        <span className="s">
          {g.expense !== 0 && moneyText(g.expense, mainDec)}
          {g.expense !== 0 && g.income !== 0 && " · "}
          {g.income !== 0 && <span className="pos">{moneyText(g.income, mainDec, { prefix: "＋" })}</span>}
        </span>
      </li>,
    );
    for (const e of g.entries) out.push(rowOf(e));
  };

  /* 搜尋結果（0-14）：不分月、新到舊、日分組（日小計＝整天的結果，分頁切在日中間也照整天算） */
  const resultItems: ReactNode[] = [];
  if (searching) {
    if (results === null) {
      resultItems.push(
        <li key="finding" className="ns-tk-empty is-month" role="presentation">
          正在找…
        </li>,
      );
    } else if (!results.length) {
      resultItems.push(
        <li key="none" className="ns-tk-empty" role="presentation">
          {VIEW_TEXT.emptyResults}
          <small>換個字、或把篩選放寬一點</small>
        </li>,
      );
    } else {
      const shown = pageResults(results, page);
      const shownIds = new Set(shown.map((e) => e.id));
      const spanMonths = new Set(results.map((e) => monthOf(e.occurred_on))).size > 1;
      if (flat) {
        // 金額排序：平面清單，每列帶日期（跨年才印年）
        for (const e of shown) resultItems.push(rowOf(e, flatDayText(e.occurred_on, flatSpanYears)));
      } else {
        for (const g of resultDays) {
          const ents = g.entries.filter((e) => shownIds.has(e.id));
          if (!ents.length) break;
          pushDay(resultItems, ents.length === g.entries.length ? g : { ...g, entries: ents }, spanMonths);
        }
      }
      if (results.length > shown.length) {
        resultItems.push(
          <li key="more" className="ns-tk-loadmore" role="presentation">
            <button type="button" onMouseDown={(ev) => ev.preventDefault()} onClick={() => setPage(page + 1)}>
              {VIEW_TEXT.more(Math.min(RESULT_PAGE, results.length - shown.length))}
              <TkIcon name="caret" size={11} />
            </button>
          </li>,
        );
      }
    }
  }

  /* 清單：月份分隔＋日分組＋帳簿行 */
  const items: ReactNode[] = [];
  const headHasRows = monthsWithRows.has(months[0]);
  if (ready && hasAny && !headHasRows) {
    items.push(
      <li key="empty-head" className="ns-tk-empty is-month">
        這個月還沒有紀錄
        {filterAcc && <small>篩選：{acctLabel(filterAcc, accounts)}</small>}
      </li>,
    );
  }
  let curMonth = months[0];
  days.forEach((g: DayGroup) => {
    const m = monthOf(g.dayKey);
    if (m !== curMonth) {
      curMonth = m;
      items.push(
        <li key={`m-${m}`} className="ns-tk-monthrule" role="presentation">
          {monthTitle(m)}
        </li>,
      );
    }
    pushDay(items, g, false);
  });

  return (
    <main ref={mainRef} className="ns-tk-ledger techo-scroll is-compact" aria-label="帳簿" data-view={view}>
      <PageHeader
        variant="identity"
        className="ns-tk-pagehead"
        compact={headNarrow ? true : undefined}
        overline={{ zh: "售票口", latin: "Ticket Office" }}
        title={
          searching ? (
            "搜尋結果"
          ) : yearMode ? (
            <DateNav
              unit="year"
              label="翻年份"
              title={`${period.key} 年`}
              todayLabel="今年"
              isToday={period.key === thisYear}
              nextDisabled={period.key >= thisYear}
              onPrev={() => void store().stepMonth(-1)}
              onNext={() => void store().stepMonth(1)}
              onToday={() => void toThisYear()}
            />
          ) : (
            <DateNav
              unit="month"
              label="翻月份"
              title={monthNo}
              isToday={month === thisMonth}
              nextDisabled={month >= thisMonth}
              onPrev={() => void store().stepMonth(-1)}
              onNext={() => void store().stepMonth(1)}
              onToday={() => void store().setMonth(thisMonth)}
            />
          )
        }
        aside={
          searching ? (
            <button
              type="button"
              className="ns-btn ns-btn--sm btn-text ns-tk-backbtn"
              title={`回到月份清單（${capsOf("ticket.escape")}）`}
              aria-label={`回 ${backLabel}`}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => store().closeSearch()}
            >
              {/* 頁首窄（1280 開大票）時字收起、只剩「‹」，大標那一行才不折（ticket.css T1 區 container query） */}
              <IconBack size={12} />
              <span className="ns-tk-backlbl">回 {backLabel}</span>
            </button>
          ) : yearMode ? undefined : (
            <span className="ns-tk-headyear">{month.slice(0, 4)}年</span>
          )
        }
        stats={
          searching ? (
            results ? resultSummary(results, mainDec) : "正在找…"
          ) : view !== "stats" && monthSum && filterAccountId === null && (monthSum.income !== 0 || monthSum.expense !== 0) ? (
            <>
              {/* 「本月／9月」在頁首窄（1280 開大票）時收起，讓收入那段不被省略掉（ticket.css T1 區 container query） */}
              <span className="ns-tk-statlbl">{monthWord}</span>支出 <b>{moneyText(monthSum.expense, mainDec)}</b> ・ 收入{" "}
              <b className="pos">{moneyText(monthSum.income, mainDec, { prefix: "＋" })}</b>
            </>
          ) : view !== "stats" && filterAcc ? (
            // 篩帳戶時 store 不算本月收支（轉帳兩頭算不清）：改寫筆數，stats 行不消失、頁首高度不跳
            <>
              {monthWord} <b>{entries.filter((e) => monthOf(e.occurred_on) === month).length}</b> 筆
            </>
          ) : undefined
        }
        tabs={{ items: tabItems, value: view, onChange: switchView, "aria-label": "切換檢視" }}
        add={emptyBook ? undefined : { label: "記一筆", title: `記一筆（${capsOf("ticket.new")}）`, onClick: () => store().openNew() }}
        search={{ onOpen: onSearchBtn, title: `搜尋（${capsOf("ticket.search")}）`, expanded: searchOpen }}
        manage={{
          label: "管帳",
          title: "管帳：分類、帳戶順序、預算、定期帳、幣別與匯率、匯入",
          haspopup: "menu",
          expanded: menuAt !== null,
          onClick: (e) => setMenuAt(menuAt ? null : e.currentTarget),
        }}
      />
      {menuAt && (
        <PopMenu
          anchor={menuAt}
          overline={{ zh: "管帳", latin: "Manage" }}
          label="管帳"
          items={manageItems}
          onClose={() => setMenuAt(null)}
        />
      )}

      {/* A4／P3 A 案：頁首下一列（清單視圖常駐；月曆／統計不畫）。左＝帳戶篩選 chip／搜尋框＋條件 chip，右＝排序 */}
      {view === "list" && !(error && !ready) && !(emptyBook && !filterAcc && !searchOpen) && (
        <div className="ns-tk-subbar">
          <div className="l">
            {filterAcc && (
              <span className="chip ns-chip is-on ns-tk-acctchip">
                帳戶：{acctLabel(filterAcc, accounts)}
                <button type="button" aria-label="清除帳戶篩選" title="清除帳戶篩選" onClick={() => void store().setFilter(null)}>
                  <IconClose size={11} />
                </button>
              </span>
            )}
            {searchOpen && (
              <>
                <SearchBar />
                <FilterChips />
              </>
            )}
          </div>
          {hasAny && (
            <div className="r">
              <SortButton />
            </div>
          )}
        </div>
      )}

      {error && !ready ? (
        <div className="ns-tk-error" role="alert">
          <p>帳本讀不出來：{error}</p>
          <button type="button" className="ns-btn btn-ghost ns-tk-btn" onClick={() => void store().init("desktop").catch(() => undefined)}>
            再試一次
          </button>
        </div>
      ) : view === "calendar" ? (
        <TicketCalendar />
      ) : view === "stats" ? (
        <TicketStats />
      ) : ready && !hasAny && !searching ? (
        <div className="ns-tk-book is-empty">
          <EmptyState
            tone="first"
            title="這本帳還是空的"
            action={{ label: "記一筆", icon: <IconPlus />, onClick: () => store().openNew() }}
            secondary={{ label: "從財務管家匯入…", onClick: () => void store().startImport("desktop") }}
          />
        </div>
      ) : (
        <div className="ns-tk-book">
          {dayNotice && (
            // 0-16：「10/8 沒有紀錄」——捲動後頁首已出畫面，所以貼在帳簿頂端（sticky），3 秒後收
            <div className="ns-tk-daynote" role="status">
              <span>{dayNotice}</span>
            </div>
          )}
          <ul
            ref={listRef}
            className={"ns-tk-list" + (flat ? " is-flat" : "") + (flatSpanYears ? " is-year" : "")}
            tabIndex={0}
            role="listbox"
            aria-label="帳簿"
            aria-activedescendant={selectedId ? `tk-row-${selectedId}` : undefined}
          >
            {searching ? resultItems : items}
            {ready && hasAny && !searching && (
              <li ref={sentinelRef} className="ns-tk-loadmore" role="presentation">
                <button
                  type="button"
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => void store().loadOlderMonth()}
                  title={autoLoad ? "捲到底會自動載入" : undefined}
                >
                  {autoLoad ? "繼續往前" : "前幾個月沒紀錄，再往前翻"} · {monthTitle(prevMonth)}
                  <TkIcon name="caret" size={11} />
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </main>
  );
}
