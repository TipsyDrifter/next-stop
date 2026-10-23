/**
 * MobileTicketOffice——售票口手機頁（車次①契約 §5.3、0-5、0-9、0-35；原型 `prototypes/售票口-整頁.html` 手機 mobTicket）。
 * 根 `div.m-page.ns-tk-m`。整合前從「更多」那一列進來會收到 `onBack`；本頁不理它（點別的 tab 再回「更多」就回到清單，0-35）。
 *
 * 由上而下：
 *   合計帶 `.ns-tk-mtotal`（資產／負債／合計＋右端滑桿「管理」鈕，D-票-24）
 *   → 帳戶卡橫捲 `.ns-tk-mcards`（「全部 · N 個帳戶」＋各帳戶；點＝篩選、再點＝回全部；右上 › 或長按＝帳戶頁；
 *     有封存的帳戶時多一張「封存 N」卡開清單——封存卡本身不列，但手機也要找得回來「取消封存」；最後一張「＋」新增帳戶）
 *   → 月份列 `.ns-tk-mmonth`（‹ 2026 年 10 月 ›＋「＋ 記一筆」）＋本月合計一行（篩選＝全部時）
 *   → 帳簿 `ul.ns-tk-mlist`（日分組、單欄；點一筆＝MobileEntryForm 編輯態；捲到底自動接前一個月）
 * 第②階段（②契約 §5.3、0-15、0-16）：
 *   合計帶右端多一顆放大鏡（開 MobileSearchSheet；有篩選時亮一顆點）；帳戶卡下面是視圖列 MobileViewBar；
 *   月份列在統計「年」模式改成「‹ 2026 年 ›」（‹ › 切年）；搜尋模式（清單＋有條件）時月份列換成篩選 chips 列＋「找到 N 筆…」、
 *   清單畫 resultDays（跨月印月份分隔、300 筆一頁）；月曆點格跳回來（pendingDay）⇒ 捲到那天的日分組頭、閃一下；
 *   那天沒帳 ⇒ 淡字「10/8 沒有紀錄」3 秒（dayNotice）。清單容器與月曆／統計一樣掛左右滑換視圖（useViewSwipe）。
 * 磨光⑥ 契約 §2-1／§2-4（D-票-61、D-票-64）：管理 sheet「分類管理」下面多一列「帳戶順序」；月份列多一顆「排序」（開排序 sheet，
 *   選日期・新到舊以外的 ⇒ 開這個月的搜尋）；搜尋時條件列最前面一顆「排序」chip（開同一個 sheet）。結果依 store.resultSort：
 *   日期排序照舊日分組；金額排序＝平面清單（不分日、每列第二行前面帶日期「10/21（三）」、沒有月份分隔與日小計），300 筆分頁照 results 切。
 * 全螢幕表單／帳戶頁／對話框 sheet 都由 store 的 `panel`／`dialog` 決定畫不畫（兩殼共用一份 store，永不同時渲染）。
 *
 * UI 只讀 store、只叫 store 的動作；金額顯示走 domain 的純函式（moneyText／rowAmount…），不經浮點。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { roundelStyle } from "../../common/roundel";
import {
  MAIN_CURRENCY,
  MAIN_SYMBOL,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  addMonths,
  archivedAccounts,
  categoryTree,
  groupAccounts,
  isLiability,
  monthOf,
  monthTitle,
  moneyText,
  rowAmount,
  type AccountRow,
  type DayGroup,
  type EntryRow,
} from "../../../domain/ticket";
import { useBackLayer } from "../../mobile/backStack";
import { MobileEntryForm } from "./MobileEntryForm";
import { MobileAccountPage } from "./MobileAccountPage";
import { MobileSheetHost } from "./MobileSheetHost";
import { IconLeft, IconPlus, IconRight, IconSliders, MSheet, splitDayLabel } from "./mobileBits";
// 第②階段（②契約 §5.3）：視圖列＋月曆／統計視圖＋搜尋 sheet（掛在合計帶的放大鏡上）
import { MobileViewBar, useViewSwipe } from "./MobileViewBar";
import { MobileTicketCalendar } from "./MobileTicketCalendar";
import { MobileTicketStats } from "./MobileTicketStats";
import { IconSearch, MobileSearchSheet } from "./MobileSearchSheet";
import {
  DEFAULT_ENTRY_SORT,
  ENTRY_SORTS,
  ENTRY_SORT_TEXT,
  RESULT_PAGE,
  VIEW_TEXT,
  filterChips,
  flatDayText,
  isAmountSort,
  isFilterActive,
  pageResults,
  periodTitle,
  resultSummary,
  routeCtx,
} from "../../../domain/ticketView";
import { budgetScopes, effectiveBudget } from "../../../domain/ticketPlan";
import { chooseSort } from "../view/sortChoice";
import "../ticket.css";
import "../ticket-mobile.css";

const LONG_PRESS_MS = 520;

export function MobileTicketOffice(_props: { onBack?: () => void }) {
  const ready = useTicketStore((s) => s.ready);
  const error = useTicketStore((s) => s.error);
  const init = useTicketStore((s) => s.init);
  const panel = useTicketStore((s) => s.panel);
  const page = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 失敗已寫進 store.error（畫面顯示＋重試）；這裡只吞掉 rejection
    void init("mobile").catch(() => undefined);
  }, [init]);

  return (
    <div className="m-page ns-tk-m" ref={page}>
      {ready ? (
        <OfficeBody page={page} />
      ) : error ? (
        <div className="ns-tk-mstate" role="alert">
          <p>帳本打不開</p>
          <small>{error}</small>
          <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={() => void init("mobile").catch(() => undefined)}>
            再試一次
          </button>
        </div>
      ) : (
        <div className="ns-tk-mstate" aria-busy="true">
          <p>正在翻帳本…</p>
        </div>
      )}
      {(panel.kind === "new" || panel.kind === "entry") && <MobileEntryForm key={panel.kind === "entry" ? panel.id : "new"} />}
      {panel.kind === "account" && <MobileAccountPage key={panel.id} id={panel.id} />}
      <MobileSheetHost />
    </div>
  );
}

/* ═══════════ 本體（ready 之後） ═══════════ */

function OfficeBody({ page }: { page: RefObject<HTMLDivElement | null> }) {
  const totals = useTicketStore((s) => s.totals);
  const curByCode = useTicketStore((s) => s.curByCode);
  const accounts = useTicketStore((s) => s.accounts);
  const balances = useTicketStore((s) => s.balances);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const month = useTicketStore((s) => s.month);
  const monthSum = useTicketStore((s) => s.monthSum);
  const hasAny = useTicketStore((s) => s.hasAny);
  const days = useTicketStore((s) => s.days);
  const categories = useTicketStore((s) => s.categories);
  const currencies = useTicketStore((s) => s.currencies);
  const setFilter = useTicketStore((s) => s.setFilter);
  const stepMonth = useTicketStore((s) => s.stepMonth);
  const openNew = useTicketStore((s) => s.openNew);
  const openAccount = useTicketStore((s) => s.openAccount);
  const openDialog = useTicketStore((s) => s.openDialog);
  const startImport = useTicketStore((s) => s.startImport);
  const view = useTicketStore((s) => s.view);
  const span = useTicketStore((s) => s.span);
  const period = useTicketStore((s) => s.period);
  const searchOpen = useTicketStore((s) => s.searchOpen);
  const filter = useTicketStore((s) => s.filter);
  const dayNotice = useTicketStore((s) => s.dayNotice);
  const budgets = useTicketStore((s) => s.budgets);
  const repeats = useTicketStore((s) => s.repeats);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const [sheet, setSheet] = useState<"manage" | "archived" | "sort" | null>(null);
  const resultSort = useTicketStore((s) => s.resultSort);
  const [searchSheet, setSearchSheet] = useState(false);
  // 磨光①（主線手機殼契約 §1.5）：管理／封存 sheet 的返回鍵＝「取消」。搜尋 sheet 自己登記（MobileSearchSheet）；
  // 記帳表單、帳戶頁、對話框各在自己的元件登記——都只在售票口 tab 畫，切走時那層跟著放掉（store 的 panel 留著，切回來再登記）
  useBackLayer("ticket.office.sheet", sheet !== null, () => setSheet(null));

  // 0-16：月曆點到沒帳的日 ⇒ 淡字 3 秒
  useEffect(() => {
    if (dayNotice === null) return;
    const t = setTimeout(() => useTicketStore.getState().clearDayNotice(), 3000);
    return () => clearTimeout(t);
  }, [dayNotice]);

  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;
  const live = groupAccounts(accounts);
  const liveCount = live.reduce((n, g) => n + g.accounts.length, 0);
  const archived = archivedAccounts(accounts);
  const thisMonth = monthOf(todayKey(dayStartHour));
  const yearMode = view === "stats" && span === "year";
  const filterOn = isFilterActive(filter);
  const searching = view === "list" && searchOpen && filterOn;

  /** 「＋ 記一筆」：一律走 openNew（兩殼同一條路，磨光③ 2-16）——一個帳戶都沒有時它先開新增帳戶、建完接著打開記一筆 */
  const add = () => openNew();

  // 進入搜尋模式（統計下鑽 drillToList、搜尋 sheet 帶條件關上）⇒ 捲回頂端，讓 chips 列與「清除 ×」露出來
  // （原型 drill() 也是 mpage.scrollTop = 0）。不然 .m-page 會留著統計／帳簿原本捲到的位置，條件列在畫面外。
  // layout effect：在換成結果清單的那一幀畫出來之前就歸零，不會先閃一下舊位置。
  const wasSearching = useRef(searching);
  useLayoutEffect(() => {
    if (searching && !wasSearching.current && page.current) page.current.scrollTop = 0;
    wasSearching.current = searching;
  }, [searching, page]);

  const catCount = (kind: "income" | "expense") =>
    categoryTree(categories, kind, { includeArchived: false }).filter((t) => t.parent.id !== UNCAT_INCOME_ID && t.parent.id !== UNCAT_EXPENSE_ID)
      .length;

  // 第③階段：管理 sheet 兩列的小字（0-14）——「總預算 15,000 · 分類 2」／「進行中 3 · 已暫停 1」；都沒有 ⇒「還沒有」
  const budgetScopeList = budgetScopes(budgets);
  const totalEff = effectiveBudget(budgets, { kind: "total" }, thisMonth);
  const catBudgets = budgetScopeList.filter((x) => x.kind === "category").length;
  const budgetSummary =
    budgetScopeList.length === 0
      ? "還沒有"
      : [totalEff ? `總預算 ${moneyText(totalEff.row.amount_minor, mainDec, { whole: true })}` : null, catBudgets ? `分類 ${catBudgets}` : null]
          .filter((x): x is string => x !== null)
          .join(" · ") || "還沒有";
  const pausedN = repeats.filter((r) => r.paused_at !== null).length;
  const repeatSummary = repeats.length === 0 ? "還沒有" : `進行中 ${repeats.length - pausedN} · 已暫停 ${pausedN}`;

  return (
    <>
      <div className="ns-tk-mtotal">
        <div className="ns-tk-mstat">
          <span>資產</span>
          <b>{moneyText(totals.asset, mainDec)}</b>
        </div>
        <div className="ns-tk-mstat">
          <span>負債</span>
          <b>{moneyText(totals.liability, mainDec)}</b>
        </div>
        <div className="ns-tk-mstat sum">
          <span>合計</span>
          <b>{moneyText(totals.net, mainDec)}</b>
        </div>
        <button
          type="button"
          className="ns-tk-mmanage ns-tk-msearch"
          aria-label={filterOn ? "搜尋與篩選（已套用）" : "搜尋與篩選"}
          aria-haspopup="dialog"
          aria-expanded={searchSheet}
          onClick={() => setSearchSheet(true)}
        >
          <IconSearch />
          {filterOn && <i className="dot" aria-hidden />}
        </button>
        <button
          type="button"
          className="ns-tk-mmanage"
          aria-label="管理"
          title="管帳：分類、帳戶順序、預算、定期帳、幣別、匯入"
          aria-haspopup="menu"
          aria-expanded={sheet === "manage"}
          onClick={() => setSheet("manage")}
        >
          <IconSliders />
        </button>
      </div>

      <div className="ns-tk-mcards" role="group" aria-label="帳戶">
        <div className={"ns-tk-mcard all" + (filterAccountId === null ? " on" : "")}>
          <button type="button" className="hit" aria-pressed={filterAccountId === null} onClick={() => void setFilter(null)}>
            <span className="n">全部</span>
            <span className="g">{liveCount} 個帳戶</span>
            <span className="b" />
          </button>
        </div>
        {live.map(({ group, accounts: list }) =>
          list.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              groupLabel={group.label + (group.liability ? " · 負債" : "")}
              balanceText={moneyText(balances[a.id] ?? 0, curByCode[a.currency]?.decimals ?? 2)}
              code={a.currency !== MAIN_CURRENCY ? a.currency : null}
              zero={(balances[a.id] ?? 0) === 0}
              on={filterAccountId === a.id}
              onPick={() => void setFilter(filterAccountId === a.id ? null : a.id)}
              onOpen={() => openAccount(a.id)}
            />
          )),
        )}
        {archived.length > 0 && (
          <div className="ns-tk-mcard arch">
            <button type="button" className="hit" onClick={() => setSheet("archived")} aria-haspopup="dialog">
              <span className="n">封存</span>
              <span className="g">{archived.length} 個帳戶</span>
              <span className="b" />
            </button>
          </div>
        )}
        <div className="ns-tk-mcard add">
          <button type="button" className="hit" aria-label="新增帳戶" onClick={() => openDialog({ kind: "newAccount" })}>
            <IconPlus size={16} />
          </button>
        </div>
      </div>

      <MobileViewBar />

      {searching ? (
        <SearchRow onEdit={() => setSearchSheet(true)} onSort={() => setSheet("sort")} />
      ) : (
        <div className="ns-tk-mmonth">
          <button
            type="button"
            className="ns-tk-mnav"
            aria-label={yearMode ? "上一年" : "上一個月"}
            onClick={() => void stepMonth(-1)}
          >
            <IconLeft />
          </button>
          <h2 className="techo-title">{yearMode ? periodTitle(period) : monthTitle(month)}</h2>
          <button
            type="button"
            className="ns-tk-mnav"
            aria-label={yearMode ? "下一年" : "下一個月"}
            disabled={yearMode ? period.key >= thisMonth.slice(0, 4) : month >= thisMonth}
            onClick={() => void stepMonth(1)}
          >
            <IconRight />
          </button>
          {view === "list" && hasAny && (
            <button type="button" className="ns-tk-msort" aria-haspopup="dialog" aria-expanded={sheet === "sort"} onClick={() => setSheet("sort")}>
              排序
            </button>
          )}
          <button type="button" className="ns-btn btn-ghost ns-tk-madd" onClick={add}>
            <IconPlus />
            記一筆
          </button>
        </div>
      )}
      {view === "list" && !searching && monthSum && (monthSum.income !== 0 || monthSum.expense !== 0) && (
        <p className="ns-tk-mmsum">
          收入 <b className="pos">{moneyText(monthSum.income, mainDec, { prefix: "＋" })}</b> · 支出 <b>{moneyText(monthSum.expense, mainDec)}</b>
        </p>
      )}
      {view === "list" && dayNotice && (
        <p className="ns-tk-mnotice" role="status">
          {dayNotice}
        </p>
      )}

      {view === "calendar" ? (
        <MobileTicketCalendar />
      ) : view === "stats" ? (
        <MobileTicketStats />
      ) : searching ? (
        <Results />
      ) : hasAny ? (
        <Ledger days={days} />
      ) : (
        <div className="ns-tk-mempty">
          <p>這本帳還是空的</p>
          <button type="button" className="ns-btn btn-seal ns-tk-mbtn" onClick={add}>
            記第一筆
          </button>
          <button type="button" className="ns-tk-mlink" onClick={() => void startImport("mobile")}>
            或從財務管家匯入…
          </button>
        </div>
      )}

      {searchSheet && <MobileSearchSheet onClose={() => setSearchSheet(false)} />}

      {sheet === "manage" && (
        <MSheet title="售票口 · 管帳" onClose={() => setSheet(null)}>
          <button
            type="button"
            className="m-sheet-item ns-tk-msheet-row"
            onClick={() => {
              setSheet(null);
              openDialog({ kind: "categories" });
            }}
          >
            分類管理<small>支出 {catCount("expense")} · 收入 {catCount("income")}</small>
          </button>
          {/* 磨光⑥ 契約 §2-1（D-票-61）：帳戶順序 */}
          <button
            type="button"
            className="m-sheet-item ns-tk-msheet-row"
            onClick={() => {
              setSheet(null);
              openDialog({ kind: "accountOrder" });
            }}
          >
            帳戶順序<small>{liveCount} 個帳戶</small>
          </button>
          {/* 第③階段（③契約 0-14、§5.5）：預算、定期帳 */}
          <button
            type="button"
            className="m-sheet-item ns-tk-msheet-row"
            onClick={() => {
              setSheet(null);
              openDialog({ kind: "budgets" });
            }}
          >
            預算<small>{budgetSummary}</small>
          </button>
          <button
            type="button"
            className="m-sheet-item ns-tk-msheet-row"
            onClick={() => {
              setSheet(null);
              openDialog({ kind: "repeats" });
            }}
          >
            定期帳<small>{repeatSummary}</small>
          </button>
          <button
            type="button"
            className="m-sheet-item ns-tk-msheet-row"
            onClick={() => {
              setSheet(null);
              openDialog({ kind: "currencies" });
            }}
          >
            幣別與匯率<small>{currencies.map((c) => c.code).join(" · ")}</small>
          </button>
          <button
            type="button"
            className="m-sheet-item ns-tk-msheet-row"
            onClick={() => {
              setSheet(null);
              void startImport("mobile");
            }}
          >
            從財務管家匯入…<small>.mmbak</small>
          </button>
          <button type="button" className="m-sheet-item is-cancel" onClick={() => setSheet(null)}>
            取消
          </button>
        </MSheet>
      )}

      {sheet === "sort" && (
        // 清單本身永遠是日期・新到舊；搜尋中才是 store.resultSort
        <MSheet title="排序" onClose={() => setSheet(null)}>
          {ENTRY_SORTS.map((k) => {
            const on = (searching ? resultSort : DEFAULT_ENTRY_SORT) === k;
            return (
              <button
                key={k}
                type="button"
                className={"m-sheet-item ns-tk-msheet-row" + (on ? " is-on" : "")}
                aria-pressed={on}
                onClick={() => {
                  setSheet(null);
                  if (!on) chooseSort(k);
                }}
              >
                {ENTRY_SORT_TEXT[k]}
                {!searching && k !== DEFAULT_ENTRY_SORT && <small>{monthTitle(month)}</small>}
              </button>
            );
          })}
          <button type="button" className="m-sheet-item is-cancel" onClick={() => setSheet(null)}>
            取消
          </button>
        </MSheet>
      )}

      {sheet === "archived" && (
        <MSheet title="封存的帳戶" onClose={() => setSheet(null)}>
          {archived.map((a) => (
            <button
              key={a.id}
              type="button"
              className="m-sheet-item ns-tk-msheet-row"
              onClick={() => {
                setSheet(null);
                openAccount(a.id);
              }}
            >
              {a.name}
              <small>
                {moneyText(balances[a.id] ?? 0, curByCode[a.currency]?.decimals ?? 2)}
                {a.currency !== MAIN_CURRENCY ? ` ${a.currency}` : ""}
              </small>
            </button>
          ))}
          <button type="button" className="m-sheet-item is-cancel" onClick={() => setSheet(null)}>
            取消
          </button>
        </MSheet>
      )}
    </>
  );
}

/* ═══════════ 帳戶卡 ═══════════ */

function AccountCard({
  account,
  groupLabel,
  balanceText,
  code,
  zero,
  on,
  onPick,
  onOpen,
}: {
  account: AccountRow;
  groupLabel: string;
  balanceText: string;
  code: string | null;
  zero: boolean;
  on: boolean;
  onPick(): void;
  onOpen(): void;
}) {
  // 長按＝帳戶頁（右上 › 是看得見的同一條路；長按是給熟手的捷徑，不是唯一入口）
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  return (
    <div className={"ns-tk-mcard" + (on ? " on" : "") + (zero ? " is-zero" : "") + (isLiability(account.group_key) ? " is-lia" : "")}>
      <button
        type="button"
        className="hit"
        aria-pressed={on}
        onPointerDown={() => {
          fired.current = false;
          cancel();
          timer.current = setTimeout(() => {
            fired.current = true;
            onOpen();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (fired.current) {
            fired.current = false;
            return;
          }
          onPick();
        }}
      >
        <span className="n">{account.name}</span>
        <span className="g">{groupLabel}</span>
        <span className="b">
          {balanceText}
          {code && <small>{code}</small>}
        </span>
      </button>
      <button type="button" className="go" aria-label={`${account.name}的帳戶頁`} onClick={onOpen}>
        <IconRight size={11} />
      </button>
    </div>
  );
}

/* ═══════════ 帳簿 ═══════════ */

function Ledger({ days }: { days: DayGroup[] }) {
  const month = useTicketStore((s) => s.month);
  const loadedMonths = useTicketStore((s) => s.loadedMonths);
  const loadOlderMonth = useTicketStore((s) => s.loadOlderMonth);
  const curByCode = useTicketStore((s) => s.curByCode);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;
  const last = loadedMonths.length ? loadedMonths[loadedMonths.length - 1] : month;
  const olderTitle = monthTitle(addMonths(last, -1));

  // 捲到底自動接前一個月（同 MobileNoteList 的哨兵作法）。observer 只建一次、只在「進入視野」那一刻觸發：
  // 接上來的月份是空的、哨兵仍在視野內時不會連環觸發（一路載到很久以前），要再往前就點那一行。
  const sentinel = useRef<HTMLLIElement | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((ents) => {
      if (!ents.some((x) => x.isIntersecting) || busy.current) return;
      busy.current = true;
      void useTicketStore
        .getState()
        .loadOlderMonth()
        .finally(() => {
          busy.current = false;
        });
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const book = useRef<HTMLDivElement | null>(null);
  useViewSwipe(book);
  const flash = usePendingDayScroll(book);

  const items = dayItems(days, month, today, mainDec, flash);

  return (
    <div className="ns-tk-mbook" ref={book}>
      <ul className="ns-tk-mlist" aria-label="帳簿">
        {days.length === 0 && <li className="ns-tk-mnone">這個月還沒有紀錄</li>}
        {items}
        <li ref={sentinel} className="ns-tk-mloadmore">
          <button type="button" onClick={() => void loadOlderMonth()}>
            接著看 {olderTitle}
          </button>
        </li>
      </ul>
    </div>
  );
}

/**
 * 日分組 → li 列表（月份分隔＋日分組頭＋各筆）。`firstMonth`＝第一組之前「已經印在頁首」的月——
 * 清單＝頁首那個月（不重印）；搜尋結果傳 null ⇒ 跨月時每個月都印分隔（0-14：日分組頭多印年月）。
 */
function dayItems(days: readonly DayGroup[], firstMonth: string | null, today: string, mainDec: number, flash: string | null, limit = Infinity): ReactElement[] {
  const items: ReactElement[] = [];
  let prevMonth = firstMonth;
  let left = limit;
  for (const g of days) {
    if (left <= 0) break;
    const m = monthOf(g.dayKey);
    if (m !== prevMonth) {
      items.push(
        <li key={"m-" + m} className="ns-tk-mmonthrule">
          {monthTitle(m)}
        </li>,
      );
      prevMonth = m;
    }
    const [d, w] = splitDayLabel(g.label);
    items.push(
      <li key={"d-" + g.dayKey} className={"ns-tk-mday" + (flash === g.dayKey ? " is-flash" : "")} data-day={g.dayKey}>
        <span className="d">{d}</span>
        <span className="w">{w}</span>
        {g.dayKey === today && <span className="today">今天</span>}
        <span className="s">
          {g.expense !== 0 && moneyText(g.expense, mainDec)}
          {g.expense !== 0 && g.income !== 0 && " · "}
          {g.income !== 0 && <span className="pos">{moneyText(g.income, mainDec, { prefix: "＋" })}</span>}
        </span>
      </li>,
    );
    for (const e of g.entries) {
      if (left-- <= 0) break;
      items.push(<Row key={e.id} e={e} />);
    }
  }
  return items;
}

/**
 * 0-16：store 的 pendingDay（月曆點格、quickJump）⇒ 捲到那天的日分組頭、閃一下，然後 consumePendingDay。
 * 回傳正在閃的日 key（1.6 秒後清掉）。
 */
function usePendingDayScroll(root: RefObject<HTMLElement | null>): string | null {
  const pendingDay = useTicketStore((s) => s.pendingDay);
  const days = useTicketStore((s) => s.days);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (pendingDay === null) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-day="${pendingDay}"]`);
    if (!el) return; // 那天的列還沒畫出來：等 days 更新再試
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setFlash(pendingDay);
    useTicketStore.getState().consumePendingDay();
  }, [pendingDay, days, root]);
  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);
  return flash;
}

/* ═══════════ 搜尋模式（0-14、0-15）：篩選 chips 列＋結果 ═══════════ */

/** 月份列的替身：條件 chips 橫捲（點＝回 sheet 改）＋「清除」＋「找到 N 筆 · 支出 X · 收入 Y」 */
function SearchRow({ onEdit, onSort }: { onEdit(): void; onSort(): void }) {
  const filter = useTicketStore((s) => s.filter);
  const results = useTicketStore((s) => s.results);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const closeSearch = useTicketStore((s) => s.closeSearch);
  const resultSort = useTicketStore((s) => s.resultSort);
  const routes = useNodeStore((s) => s.routes);
  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;
  const chips = filterChips(filter, { accById, catById, curByCode, ...routeCtx(routes) });
  const text = filter.text.trim();

  return (
    <>
      <div className="ns-tk-mfilters" role="group" aria-label="搜尋條件">
        {/* 排序（磨光⑥ §2-4）：預設不亮；點＝排序 sheet */}
        <button type="button" className={"ns-tk-mfchip" + (resultSort !== DEFAULT_ENTRY_SORT ? " is-on" : "")} aria-haspopup="dialog" onClick={onSort}>
          {resultSort !== DEFAULT_ENTRY_SORT ? ENTRY_SORT_TEXT[resultSort] : "排序"}
        </button>
        {text !== "" && (
          <button type="button" className="ns-tk-mfchip is-on" onClick={onEdit}>
            「{text}」
          </button>
        )}
        {chips.map((c) => (
          <button key={c.key} type="button" className="ns-tk-mfchip is-on" onClick={onEdit}>
            {c.label}
          </button>
        ))}
        <button type="button" className="ns-tk-mfchip is-clear" onClick={closeSearch}>
          清除 <span aria-hidden>×</span>
        </button>
      </div>
      <p className="ns-tk-mmsum ns-tk-mfound" role="status">
        {results === null ? "正在找…" : resultSummary(results, mainDec)}
      </p>
    </>
  );
}

function Results() {
  const results = useTicketStore((s) => s.results);
  const resultDays = useTicketStore((s) => s.resultDays);
  const resultSort = useTicketStore((s) => s.resultSort);
  const curByCode = useTicketStore((s) => s.curByCode);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;
  const [page, setPage] = useState(1);
  // 條件一變（results 換一份）就回第一頁
  useEffect(() => setPage(1), [results]);

  const book = useRef<HTMLDivElement | null>(null);
  useViewSwipe(book);
  const flash = usePendingDayScroll(book);

  const all = results ?? [];
  const shownRows = pageResults(all, page);
  const shown = shownRows.length;
  const months = new Set(all.map((e) => monthOf(e.occurred_on)));
  // 日期排序：只有一個月 ⇒ 那個月印一次在最上面；跨月 ⇒ 每個月一條分隔（firstMonth＝null）。
  // 金額排序：平面清單，每列帶日期（跨年才印年）
  const spanYears = new Set(all.map((e) => e.occurred_on.slice(0, 4))).size > 1;
  const items = isAmountSort(resultSort)
    ? shownRows.map((e) => <Row key={e.id} e={e} day={flatDayText(e.occurred_on, spanYears)} />)
    : dayItems(resultDays, null, today, mainDec, flash, shown);

  return (
    <div className="ns-tk-mbook is-results" ref={book}>
      <ul className={"ns-tk-mlist" + (isAmountSort(resultSort) ? " is-flat" : "")} aria-label={`搜尋結果${months.size > 1 ? `，跨 ${months.size} 個月` : ""}`}>
        {results !== null && all.length === 0 && (
          <li className="ns-tk-mnone">
            {VIEW_TEXT.emptyResults}
            <small>換個字、或把篩選放寬一點</small>
          </li>
        )}
        {items}
        {all.length > shown && (
          <li className="ns-tk-mloadmore">
            <button type="button" onClick={() => setPage(page + 1)}>
              {VIEW_TEXT.more(Math.min(RESULT_PAGE, all.length - shown))}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

const SIGN: Record<EntryRow["kind"], string> = { income: "＋", expense: "", transfer: "⇄", adjust: "±" };

/** day＝平面清單（金額排序）的日期字，畫在第二行最前面 */
function Row({ e, day }: { e: EntryRow; day?: string }) {
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const selectedId = useTicketStore((s) => s.selectedId);
  const openEntry = useTicketStore((s) => s.openEntry);
  const route = useNodeStore((s) => (e.route_id ? (s.routes.find((r) => r.id === e.route_id) ?? null) : null));

  const amt = rowAmount(e, filterAccountId, accById);
  const dec = curByCode[amt.currency]?.decimals ?? 2;
  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;
  const accName = (id: string | null) => (id ? (accById[id]?.name ?? "（帳戶已刪除）") : "—");

  let cat: ReactElement;
  if (e.kind === "transfer") {
    cat = (
      <>
        {accName(e.account_id)}
        <span className="arr">→</span>
        {accName(e.to_account_id)}
      </>
    );
  } else if (e.kind === "adjust") {
    cat = (
      <>
        <span className="seikan">精算</span>
        {accName(e.account_id)}
      </>
    );
  } else {
    const c = e.category_id ? catById[e.category_id] : undefined;
    const uncat = !c || c.id === UNCAT_INCOME_ID || c.id === UNCAT_EXPENSE_ID;
    const p = c?.parent_id ? catById[c.parent_id] : undefined;
    cat = uncat ? (
      <span className="unc">{c ? c.name : "（分類已刪除）"}</span>
    ) : p ? (
      <>
        {p.name}
        <span className="gt">›</span>
        {c!.name}
      </>
    ) : (
      <>{c!.name}</>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={"ns-tk-mrow" + (selectedId === e.id ? " is-last" : "")}
        data-kind={e.kind}
        onClick={() => openEntry(e.id)}
      >
        <span className="sg">{SIGN[e.kind]}</span>
        <span className="main">
          {/* 第③階段（✎-5）：定期帳記的（或被「設成定期」連上的）帳在分類後接小標；分類字包 .ct 負責省略號，小標永遠看得到 */}
          <span className="c">
            <span className="ct">{cat}</span>
            {e.repeat_id && <span className="ns-tk-mrep">定期</span>}
          </span>
          {(e.note || route || day !== undefined) && (
            <span className="nt">
              {day !== undefined && <span className="dt">{day}</span>}
              {route && (
                <span className="roundel" aria-hidden style={roundelStyle(route.color)}>
                  {route.code ?? route.name.slice(0, 1)}
                </span>
              )}
              <span className="t">{e.note}</span>
            </span>
          )}
        </span>
        <span className="a">
          <b>{moneyText(amt.minor, dec)}</b>
          {amt.currency !== MAIN_CURRENCY && <span className="cur">{amt.currency}</span>}
          {amt.convMain !== null && (
            <span className="conv">
              ≈ {MAIN_SYMBOL} {moneyText(amt.convMain, mainDec, { whole: true })}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
