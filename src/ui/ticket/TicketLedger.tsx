/**
 * TicketLedger——售票口桌機頁的主欄「帳簿」（車次①契約 §5.1、0-1、0-2、0-4；乙席）。
 *
 *   main.ns-tk-ledger.is-compact（自己捲；緊湊密度 D-票-21）
 *   ├─ header.ns-tk-head    overline「售票口 — TICKET OFFICE」＋「＋ 記一筆 N」｜‹ 2026 年 10 月 › ＋ 右側本月合計（篩選＝全部時）
 *   │                        ＋ 篩選中 chip（原型 P-5 的延伸：篩選了哪個帳戶、× 清掉）
 *   └─ div.ns-tk-book（一張霧面紙，不打孔——帳簿行不是票卡）
 *       └─ ul.ns-tk-list（listbox，焦點容器 tabIndex=0；鍵盤表由頁根的 useTicketKeyboard 接）
 *           li.ns-tk-day（日付小字＋當日小計淡字）／li.ns-tk-row（帳簿行）／li.ns-tk-monthrule（往前接的月份）
 *           li.ns-tk-loadmore（捲到底自動接前一個月；IntersectionObserver）／空狀態 li.ns-tk-empty
 *
 * 只讀 store、只叫 store 的動作（§2.5）；domain 的純函式直接用（moneyText／rowAmount／monthTitle…）。
 * 本檔另外 export 桌機三個元件共用的小件：`TkIcon`（1.3px 細線圖示）、`acctLabel`（同名帳戶加群組）、`TkRoundel`。
 *
 * 第②階段（②契約 §5.1、0-15、0-16；長相照原型 deskMain()）：
 *   頁首第一列多了 SearchBar；第二列＝‹ 月份 ›（統計年模式「‹ 2026 年 ›」）＋本月合計（只在清單）＋ ViewSwitch（最右）；
 *   搜尋作用中（清單＋有條件）⇒ 第二列換成「搜尋結果 ‹ 回 2026 年 10 月」、清單畫 resultDays（跨月、日分組頭印年、每頁 300 筆）；
 *   第三列 FilterChips（搜尋開著才出）。main 依 view 換成 TicketCalendar／TicketStats。
 *   月曆跳回來（jumpToDay）⇒ store.pendingDay：捲到那一天的日分組頭、閃一下；那天沒帳 ⇒ 捲到最接近的日、帳簿頂端貼一行淡字「10/8 沒有紀錄」3 秒（sticky：頁首此時已捲出畫面）。
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
import { RESULT_PAGE, VIEW_TEXT, isFilterActive, pageResults } from "../../domain/ticketView";
// 第②階段（②契約 §5.1）：頁首視圖切換／搜尋列／篩選 chips、月曆與統計視圖——Stage 0 掛樁，乙席接手
import { ViewSwitch } from "./view/ViewSwitch";
import { SearchBar } from "./view/SearchBar";
import { FilterChips } from "./view/FilterChips";
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
  // 管理入口＝滑桿（D-票-24；原型第二版 mgrSliders 逐字）
  sliders: (
    <>
      <path d="M2.4 3.4h6.4M11.6 3.4h2" />
      <circle cx="10.2" cy="3.4" r="1.4" />
      <path d="M2.4 8h1.6M6.8 8h6.8" />
      <circle cx="5.4" cy="8" r="1.4" />
      <path d="M2.4 12.6h7.6M12.8 12.6h.8" />
      <circle cx="11.4" cy="12.6" r="1.4" />
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
  if (!a) return "（帳戶已不在）";
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
  if (!c) return <span className="unc">（分類已不在）</span>;
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
  const pendingDay = useTicketStore((s) => s.pendingDay);
  const dayNotice = useTicketStore((s) => s.dayNotice);

  const today = todayKey(dayStartHour);
  const thisMonth = monthOf(today);
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

  /* 搜尋結果分頁（0-14：先畫 300 筆）；結果換了就回第一頁 */
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [results]);

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

  /* 一筆帳簿行（月份清單與搜尋結果共用） */
  const rowOf = (e: EntryRow): ReactNode => {
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
        <span className="ns-tk-main">
          <span className="ns-tk-cat">
            <EntryCat e={e} />
          </span>
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
      for (const g of resultDays) {
        const ents = g.entries.filter((e) => shownIds.has(e.id));
        if (!ents.length) break;
        pushDay(resultItems, ents.length === g.entries.length ? g : { ...g, entries: ents }, spanMonths);
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
      <header className="ns-tk-head">
        <div className="ns-tk-headrow">
          <span className="ns-tk-overline">售票口 — TICKET OFFICE</span>
          <SearchBar />
          <button type="button" className="ns-tk-newbtn" onClick={() => store().openNew()} title="記一筆">
            <TkIcon name="plus" size={11} />
            記一筆
            <kbd className="ns-tk-kbd">{capsOf("ticket.new")}</kbd>
          </button>
        </div>
        <div className="ns-tk-headrow is-month is-views">
          {searching ? (
            <h1 className="techo-title is-search">
              搜尋結果
              <button
                type="button"
                className="ns-tk-btn quiet"
                title={`回到月份清單（${capsOf("ticket.escape")}）`}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => store().closeSearch()}
              >
                <TkIcon name="left" size={11} />回 {monthTitle(month)}
              </button>
            </h1>
          ) : (
            <>
              <button
                type="button"
                className="ns-tk-mnav"
                aria-label={`${yearMode ? "上一年" : "上一個月"}（${capsOf("ticket.month.prev")}）`}
                title={`${yearMode ? "上一年" : "上一個月"}（${capsOf("ticket.month.prev")}）`}
                onClick={() => void store().stepMonth(-1)}
              >
                <TkIcon name="left" />
              </button>
              <h1 className="techo-title">{yearMode ? `${period.key} 年` : monthTitle(month)}</h1>
              <button
                type="button"
                className="ns-tk-mnav"
                aria-label={`${yearMode ? "下一年" : "下一個月"}（${capsOf("ticket.month.next")}）`}
                title={`${yearMode ? "下一年" : "下一個月"}（${capsOf("ticket.month.next")}）`}
                disabled={yearMode ? period.key >= thisMonth.slice(0, 4) : month >= thisMonth}
                onClick={() => void store().stepMonth(1)}
              >
                <TkIcon name="right" />
              </button>
            </>
          )}
          {view === "list" && !searching && monthSum && filterAccountId === null && (monthSum.income !== 0 || monthSum.expense !== 0) && (
            <span className="ns-tk-monthsum">
              收入 <b className="pos">{moneyText(monthSum.income, mainDec, { prefix: "＋" })}</b> · 支出{" "}
              <b>{moneyText(monthSum.expense, mainDec)}</b>
            </span>
          )}
          <ViewSwitch />
        </div>
        {filterAcc && (
          <div className="ns-tk-filterchip">
            篩選：{acctLabel(filterAcc, accounts)}
            <button type="button" aria-label="清除篩選" title="清除篩選" onClick={() => void store().setFilter(null)}>
              <TkIcon name="x" size={11} />
            </button>
          </div>
        )}
        <FilterChips />
      </header>

      {error && !ready ? (
        <div className="ns-tk-error" role="alert">
          <p>帳本讀不出來：{error}</p>
          <button type="button" className="ns-tk-btn" onClick={() => void store().init("desktop").catch(() => undefined)}>
            再試一次
          </button>
        </div>
      ) : view === "calendar" ? (
        <TicketCalendar />
      ) : view === "stats" ? (
        <TicketStats />
      ) : ready && !hasAny && !searching ? (
        <div className="ns-tk-book is-empty">
          <div className="ns-tk-empty is-book">
            <p>這本帳還是空的</p>
            <button type="button" className="ns-tk-btn primary" onClick={() => store().openNew()}>
              記第一筆
            </button>
            <button type="button" className="ns-tk-emptylink" onClick={() => void store().startImport("desktop")}>
              或從財務管家匯入…
            </button>
          </div>
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
            className="ns-tk-list"
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
                  title={autoLoad ? "捲到底會自動接上" : undefined}
                >
                  {autoLoad ? "繼續往前" : "前幾個月沒有紀錄，再往前翻"} · {monthTitle(prevMonth)}
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
