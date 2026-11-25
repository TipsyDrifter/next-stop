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
 * UI 丙-5 換裝（契約 §1 B2、E2、H1～H4、H6；§5 P4 A 案）——由上而下改成：
 *   分頁籤列 `div.ns-tk-mtop.ns-tabrow`（MobileViewBar：清單｜月曆｜統計＋末端「管帳」；頁內 sticky，跟丙-4 時刻表同一做法）
 *   → 篩選列 `.ns-tk-mfrow`（清單視圖）：左「篩選」chip（有條件時「篩選 · N」＋淡字摘要＋「清除」）、右「排序」
 *     ——搜尋只剩頂帶一顆（E6），合計帶的放大鏡退役；舊搜尋模式的條件 chips 橫捲列收成這一列
 *   → 合計帶（只留三格數字；放大鏡與滑桿兩顆鈕拿掉）→ 帳戶卡
 *   → 月份列：共用 DateNav（‹ 10月 ›＋「今天」；統計年模式 unit="year"＋「今年」）＋右側「＋ 記一筆」（「排序」搬到篩選列）；
 *     搜尋模式時換成「找到 N 筆…」一行
 *   → 帳簿；空帳本＝共用 EmptyState（這時月份列不給「＋ 記一筆」：同一動作同頁一個入口）
 *   管帳／排序／封存的帳戶三張 sheet 換共用 MSheet（list 型）；返回層＝本檔 useBackLayer("ticket.office.sheet")＋MSheet `backId` 同 id 合併。
 *
 * 售票口④（手機席；D-票-68、69）：管帳 sheet 多一列「常用票種」（改名、刪除、排序；MobileTemplateSheet）。
 *   （原分頁籤第四格「願望」於壬 D-主-513 拆除、移到候車室頁。）
 *
 * 售票口④ 第二輪（手機席；D-票-77、79）：分頁籤列四格「清單｜月曆｜統計｜帳戶」——帳戶頁（MobileAccountsView）留合計帶、
 *   不畫帳戶卡橫捲列與月份列（那一頁本身就是完整的帳戶目錄、沒有月份可翻）。橫捲列在清單／月曆／統計照留：它是這幾頁的目錄
 *   （點＝篩這個帳戶，同桌機側欄頁務件，側欄不動 ⇒ 手機也不動），帳戶頁管的是帳戶本身（餘額走勢、新增、排序、封存的）。
 *   帳簿列分類只寫最後兩段（D-票-78）。
 *
 * UI 只讀 store、只叫 store 的動作；金額顯示走 domain 的純函式（moneyText／rowAmount…），不經浮點。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { isTicketAmountMasked, isTicketManageTab, useTicketStore } from "../../../store/ticketStore";
import { useTagStore } from "../../../store/tagStore";
import { TK_TAG_ENTRY, TK_TAG_REPEAT, entityTagMap, tagNameOf } from "../../../domain/ticketTags";
import { TagPills, useMergedEntityTagKeys } from "../../common/TagPills";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { roundelStyle } from "../../common/roundel";
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  addMonths,
  archivedAccounts,
  categoryPath,
  currencySymbol,
  formatDisplayMoney,
  groupAccounts,
  groupByDay,
  isLiability,
  mainCurrencyOf,
  maskedMoneyText,
  monthOf,
  monthRangeLabel,
  monthTitle,
  moneyText,
  rowAmount,
  type AccountRow,
  type DayGroup,
  type EntryRow,
} from "../../../domain/ticket";
import { installmentBadgeText } from "../../../domain/ticketInstallment";
import { useBackLayer } from "../../mobile/backStack";
import { MobileEntryForm } from "./MobileEntryForm";
import { MobileAccountPage } from "./MobileAccountPage";
import { MobileSheetHost } from "./MobileSheetHost";
import { TicketLockGate, TicketUnmaskPrompt } from "../parts/TicketLockGate";
import { IconPlus, IconRight, splitDayLabel } from "./mobileBits";
import { MobileViewBar, useViewSwipe } from "./MobileViewBar";
import { MobileFilterBar } from "./MobileFilterBar";
import { MobileTicketCalendar } from "./MobileTicketCalendar";
import { MobileTicketStats } from "./MobileTicketStats";
import { MobileSearchSheet } from "./MobileSearchSheet";
import { MobileAccountsView } from "./MobileAccountsView";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { DateNav } from "../../common/DateNav";
import { EmptyState } from "../../common/EmptyState";
import {
  RESULT_PAGE,
  VIEW_TEXT,
  filterMonthEntries,
  flatDayText,
  inMonthSummary,
  isAmountSort,
  isFilterActive,
  isInMonthFilterActive,
  pageResults,
  periodTitle,
  resultSummary,
  routeCtx,
  type EntrySort,
} from "../../../domain/ticketView";
import "../ticket.css";
import "../ticket-mobile.css";
import "../ticket-4-mobile.css";
import "../ticket-4b-mobile.css";

const LONG_PRESS_MS = 520;

export function MobileTicketOffice(_props: { onBack?: () => void }) {
  const ready = useTicketStore((s) => s.ready);
  const error = useTicketStore((s) => s.error);
  const init = useTicketStore((s) => s.init);
  const panel = useTicketStore((s) => s.panel);
  const hasLockPin = useTicketStore((s) => s.hasLockPin);
  const lockUnlocked = useTicketStore((s) => s.lockUnlocked);
  const locked = hasLockPin && !lockUnlocked;
  const page = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 失敗已寫進 store.error（畫面顯示＋重試）；這裡只吞掉 rejection
    void init("mobile").catch(() => undefined);
  }, [init]);

  return (
    <div className="m-page ns-tk-m" ref={page}>
      {ready ? (
        locked ? (
          <TicketLockGate />
        ) : (
          <OfficeBody page={page} />
        )
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
      {!locked && (panel.kind === "new" || panel.kind === "entry") && <MobileEntryForm key={panel.kind === "entry" ? panel.id : "new"} />}
      {!locked && panel.kind === "account" && <MobileAccountPage key={panel.id} id={panel.id} />}
      {!locked && <MobileSheetHost />}
      <TicketUnmaskPrompt shell="mobile" />
    </div>
  );
}

/* ═══════════ 本體（ready 之後） ═══════════ */

function OfficeBody({ page }: { page: RefObject<HTMLDivElement | null> }) {
  const totals = useTicketStore((s) => s.totals);
  const curByCode = useTicketStore((s) => s.curByCode);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const accounts = useTicketStore((s) => s.accounts);
  const balances = useTicketStore((s) => s.balances);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const month = useTicketStore((s) => s.month);
  const monthSum = useTicketStore((s) => s.monthSum);
  const hasAny = useTicketStore((s) => s.hasAny);
  const entries = useTicketStore((s) => s.entries);
  const days = useTicketStore((s) => s.days);
  const setFilter = useTicketStore((s) => s.setFilter);
  const stepMonth = useTicketStore((s) => s.stepMonth);
  const openNew = useTicketStore((s) => s.openNew);
  const openAccount = useTicketStore((s) => s.openAccount);
  const openDialog = useTicketStore((s) => s.openDialog);
  const dialog = useTicketStore((s) => s.dialog);
  const view = useTicketStore((s) => s.view);
  const span = useTicketStore((s) => s.span);
  const period = useTicketStore((s) => s.period);
  const searchOpen = useTicketStore((s) => s.searchOpen);
  const filter = useTicketStore((s) => s.filter);
  const results = useTicketStore((s) => s.results);
  const listFilter = useTicketStore((s) => s.listFilter);
  const listSort = useTicketStore((s) => s.listSort);
  const entriesVersion = useTicketStore((s) => s.entriesVersion);
  const dayNotice = useTicketStore((s) => s.dayNotice);
  const setMonth = useTicketStore((s) => s.setMonth);
  const monthStartDay = useTicketStore((s) => s.monthStartDay);
  const masked = useTicketStore(isTicketAmountMasked);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const routes = useNodeStore((s) => s.routes);
  const tagIndex = useTagStore((s) => s.index);

  const [sheet, setSheet] = useState<"archived" | null>(null);
  const [searchSheet, setSearchSheet] = useState(false);
  useBackLayer("ticket.office.sheet", sheet !== null, () => setSheet(null));

  // 0-16：月曆點到沒帳的日 ⇒ 淡字 3 秒
  useEffect(() => {
    if (dayNotice === null) return;
    const t = setTimeout(() => useTicketStore.getState().clearDayNotice(), 3000);
    return () => clearTimeout(t);
  }, [dayNotice]);

  const mainCur = mainCurrencyOf(curByCode);
  const mainCode = mainCur.code;
  const mainDec = mainCur.decimals;
  const live = groupAccounts(accounts);
  const liveCount = live.reduce((n, g) => n + g.accounts.length, 0);
  const archived = archivedAccounts(accounts);
  const thisMonth = monthOf(todayKey(dayStartHour), monthStartDay);
  const thisYear = thisMonth.slice(0, 4);
  const rangeLabel = monthRangeLabel(month, monthStartDay);
  const yearMode = view === "stats" && span === "year";
  const filterOn = isFilterActive(filter);
  const searching = view === "list" && searchOpen && filterOn;
  const inMonthActive = view === "list" && !searching && isInMonthFilterActive(listFilter, listSort, filterAccountId);
  const monthRows = useMemo(() => {
    void entriesVersion;
    if (!inMonthActive) return [];
    const ctx = {
      accById,
      catById,
      curByCode,
      ...routeCtx(routes),
      entryTags: entityTagMap(tagIndex, TK_TAG_ENTRY),
      tagName: tagNameOf(tagIndex),
    };
    return filterMonthEntries(
      entries,
      month,
      { ...listFilter, accountId: listFilter.accountId ?? filterAccountId },
      listSort,
      ctx,
      monthStartDay,
    );
  }, [inMonthActive, entries, month, listFilter, listSort, filterAccountId, accById, catById, curByCode, routes, tagIndex, entriesVersion, monthStartDay]);
  const monthSummaryText = useMemo(
    () => (inMonthActive ? inMonthSummary(monthRows, mainDec, { masked, currency: mainCode }) : null),
    [inMonthActive, monthRows, mainDec, masked, mainCode],
  );
  // 空帳本（清單視圖、不在搜尋）＝EmptyState 接手「＋ 記一筆」，月份列就不給第二顆（A5／H6）
  const emptyBook = view === "list" && !searching && !hasAny;
  const closeSheet = () => setSheet(null);
  const thenOpen = (fn: () => void) => () => {
    setSheet(null);
    fn();
  };

  /** 「＋ 記一筆」：一律走 openNew（兩殼同一條路，磨光③ 2-16）——一個帳戶都沒有時它先開新增帳戶、建完接著打開記一筆 */
  const add = () => openNew();

  const wasSearching = useRef(searching);
  useLayoutEffect(() => {
    if (searching && !wasSearching.current && page.current) page.current.scrollTop = 0;
    wasSearching.current = searching;
  }, [searching, page]);

  const isManageOpen = dialog !== null && (dialog.kind === "manage" || isTicketManageTab(dialog.kind));

  return (
    <>
      <MobileViewBar manageOpen={isManageOpen} onManage={() => openDialog({ kind: "manage", tab: "categories" })} />
      {view === "list" && (hasAny || searching || inMonthActive) && (
        <MobileFilterBar
          searching={searching}
          summaryText={searching ? (results === null ? "正在找…" : resultSummary(results, mainDec, { masked, currency: mainCode })) : monthSummaryText}
          onOpenSearchSheet={() => setSearchSheet(true)}
        />
      )}

      {/* 合計帶：只留三格數字（丙-5 B2：放大鏡與滑桿鈕拿掉——搜尋在頂帶、篩選在篩選列、管帳在分頁籤列末端） */}
      <div className="ns-tk-mtotal">
        <div className="ns-tk-mstat">
          <span>資產</span>
          <b>{formatDisplayMoney(totals.asset, mainDec, { masked, currency: mainCode })}</b>
        </div>
        <div className="ns-tk-mstat">
          <span>負債</span>
          <b>{formatDisplayMoney(totals.liability, mainDec, { masked, currency: mainCode })}</b>
        </div>
        <div className="ns-tk-mstat sum">
          <span>合計</span>
          <b>{formatDisplayMoney(totals.net, mainDec, { masked, currency: mainCode })}</b>
        </div>
      </div>

      {view !== "accounts" && (
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
                balanceText={formatDisplayMoney(balances[a.id] ?? 0, curByCode[a.currency]?.decimals ?? 2, {
                  masked,
                  currency: a.currency,
                })}
                code={!masked && a.currency !== mainCode ? a.currency : null}
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
      )}

      {view === "accounts" ? null : searching ? (
        <p className="ns-tk-mmsum ns-tk-mfound" role="status">
          <FoundText />
        </p>
      ) : (
        <div className="ns-tk-mmonth">
          <DateNav
            className="ns-tk-mdnav"
            unit={yearMode ? "year" : "month"}
            title={yearMode ? periodTitle(period) : navMonthTitle(month, thisYear)}
            todayLabel={yearMode ? "今年" : "今天"}
            isToday={yearMode ? period.key === thisYear : month === thisMonth}
            label={yearMode ? "翻年份" : "翻月份"}
            onPrev={() => void stepMonth(-1)}
            onNext={() => void stepMonth(1)}
            nextDisabled={yearMode ? period.key >= thisYear : month >= thisMonth}
            // 回本月：setMonth 連 period 一起換（年模式下 periodOf(本月, "year")＝今年），refresh 在統計視圖會重算統計
            onToday={() => {
              if (yearMode ? period.key !== thisYear : month !== thisMonth) void setMonth(thisMonth);
            }}
          />
          {!yearMode && rangeLabel && <span className="ns-tk-mrange">{rangeLabel}</span>}
          {!emptyBook && (
            <button type="button" className="ns-btn btn-ghost ns-btn--sm ns-tk-madd" onClick={add}>
              <IconPlus />
              記一筆
            </button>
          )}
        </div>
      )}
      {view === "list" && !searching && monthSum && (monthSum.income !== 0 || monthSum.expense !== 0) && (
        <p className="ns-tk-mmsum">
          收入 <b className="pos">{formatDisplayMoney(monthSum.income, mainDec, { prefix: "＋", masked, currency: mainCode })}</b> · 支出{" "}
          <b>{formatDisplayMoney(monthSum.expense, mainDec, { masked, currency: mainCode })}</b>
        </p>
      )}
      {view === "list" && dayNotice && (
        <p className="ns-tk-mnotice" role="status">
          {dayNotice}
        </p>
      )}

      {view === "accounts" ? (
        <MobileAccountsView />
      ) : view === "calendar" ? (
        <MobileTicketCalendar />
      ) : view === "stats" ? (
        <MobileTicketStats />
      ) : searching ? (
        <Results />
      ) : hasAny ? (
        <Ledger days={days} inMonthActive={inMonthActive} monthRows={monthRows} listSort={listSort} filterAccountId={filterAccountId} />
      ) : (
        <EmptyState
          tone="first"
          className="ns-tk-mblank"
          title="這本帳還是空的"
          action={{ label: "記一筆", icon: <IconPlus />, onClick: add }}
        />
      )}

      {searchSheet && <MobileSearchSheet onClose={() => setSearchSheet(false)} />}

      {sheet === "archived" && (
        <MSheet list title="封存的帳戶" backId="ticket.office.sheet" onClose={closeSheet}>
          {archived.map((a) => (
            <MSheetItem key={a.id} onClick={thenOpen(() => openAccount(a.id))}>
              {a.name}
              <small>
                {formatDisplayMoney(balances[a.id] ?? 0, curByCode[a.currency]?.decimals ?? 2, {
                  masked,
                  currency: a.currency,
                })}
                {!masked && a.currency !== mainCode ? ` ${a.currency}` : ""}
              </small>
            </MSheetItem>
          ))}
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

function Ledger({
  days,
  inMonthActive,
  monthRows,
  listSort,
  filterAccountId,
}: {
  days: DayGroup[];
  inMonthActive: boolean;
  monthRows: readonly EntryRow[];
  listSort: EntrySort;
  filterAccountId: string | null;
}) {
  const month = useTicketStore((s) => s.month);
  const loadedMonths = useTicketStore((s) => s.loadedMonths);
  const loadOlderMonth = useTicketStore((s) => s.loadOlderMonth);
  const curByCode = useTicketStore((s) => s.curByCode);
  const monthStartDay = useTicketStore((s) => s.monthStartDay);
  const masked = useTicketStore(isTicketAmountMasked);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const mainCur = mainCurrencyOf(curByCode);
  const mainCode = mainCur.code;
  const mainDec = mainCur.decimals;
  const last = loadedMonths.length ? loadedMonths[loadedMonths.length - 1] : month;
  const olderTitle = monthTitle(addMonths(last, -1));

  // 捲到底自動接前一個月（同 MobileNoteList 的哨兵作法）
  const sentinel = useRef<HTMLLIElement | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (inMonthActive) return;
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
  }, [inMonthActive]);

  const book = useRef<HTMLDivElement | null>(null);
  useViewSwipe(book);
  const flash = usePendingDayScroll(book);

  const flat = inMonthActive && isAmountSort(listSort);
  const items = inMonthActive
    ? flat
      ? monthRows.map((e) => <Row key={e.id} e={e} day={flatDayText(e.occurred_on, false)} />)
      : dayItems(groupByDay(monthRows, filterAccountId), month, today, mainDec, mainCode, masked, monthStartDay, flash)
    : dayItems(days, month, today, mainDec, mainCode, masked, monthStartDay, flash);

  return (
    <div className="ns-tk-mbook" ref={book}>
      <ul className={"ns-tk-mlist" + (flat ? " is-flat" : "")} aria-label="帳簿">
        {inMonthActive ? (
          monthRows.length === 0 && (
            <li className="ns-tk-mnone">
              {VIEW_TEXT.emptyResults}
              <small>這個月沒有符合條件的帳，可翻月或清除篩選</small>
            </li>
          )
        ) : (
          days.length === 0 && <li className="ns-tk-mnone">這個月還沒有紀錄</li>
        )}
        {items}
        {!inMonthActive && (
          <li ref={sentinel} className="ns-tk-mloadmore">
            <button type="button" onClick={() => void loadOlderMonth()}>
              接著看 {olderTitle}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * 日分組 → li 列表（月份分隔＋日分組頭＋各筆）。`firstMonth`＝第一組之前「已經印在頁首」的月——
 * 清單＝頁首那個月（不重印）；搜尋結果傳 null ⇒ 跨月時每個月都印分隔（0-14：日分組頭多印年月）。
 */
function dayItems(
  days: readonly DayGroup[],
  firstMonth: string | null,
  today: string,
  mainDec: number,
  mainCode: string,
  masked: boolean,
  monthStartDay: number,
  flash: string | null,
  limit = Infinity,
): ReactElement[] {
  const items: ReactElement[] = [];
  let prevMonth = firstMonth;
  let left = limit;
  for (const g of days) {
    if (left <= 0) break;
    const m = monthOf(g.dayKey, monthStartDay);
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
          {g.expense !== 0 && formatDisplayMoney(g.expense, mainDec, { masked, currency: mainCode })}
          {g.expense !== 0 && g.income !== 0 && " · "}
          {g.income !== 0 && <span className="pos">{formatDisplayMoney(g.income, mainDec, { prefix: "＋", masked, currency: mainCode })}</span>}
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

/* ═══════════ 篩選列（丙-5 H2／H3、P4 A 案）與搜尋結果（0-14、0-15） ═══════════ */

/**
 * 月份標題（月份列 DateNav）：今年的月只寫「10月」（同桌機頁首大標；手機 343 寬放得下 ‹ › 今天 ＋ 記一筆），
 * 別年的寫「2025年10月」（手機沒有桌機頁首的年份補述，翻到去年要看得出來）
 */
function navMonthTitle(month: string, thisYear: string): string {
  const [y, m] = month.split("-");
  return (y === thisYear ? "" : `${y}年`) + `${parseInt(m, 10)}月`;
}

/** 搜尋模式的「找到 N 筆 · 支出 X · 收入 Y」（月份列的替身） */
function FoundText() {
  const results = useTicketStore((s) => s.results);
  const mainCur = useTicketStore((s) => mainCurrencyOf(s.curByCode));
  const masked = useTicketStore(isTicketAmountMasked);
  return <>{results === null ? "正在找…" : resultSummary(results, mainCur.decimals, { masked, currency: mainCur.code })}</>;
}

function Results() {
  const results = useTicketStore((s) => s.results);
  const resultDays = useTicketStore((s) => s.resultDays);
  const resultSort = useTicketStore((s) => s.resultSort);
  const curByCode = useTicketStore((s) => s.curByCode);
  const monthStartDay = useTicketStore((s) => s.monthStartDay);
  const masked = useTicketStore(isTicketAmountMasked);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const mainCur = mainCurrencyOf(curByCode);
  const mainCode = mainCur.code;
  const mainDec = mainCur.decimals;
  const [page, setPage] = useState(1);
  // 條件一變（results 換一份）就回第一頁
  useEffect(() => setPage(1), [results]);

  const book = useRef<HTMLDivElement | null>(null);
  useViewSwipe(book);
  const flash = usePendingDayScroll(book);

  const all = results ?? [];
  const shownRows = pageResults(all, page);
  const shown = shownRows.length;
  const months = new Set(all.map((e) => monthOf(e.occurred_on, monthStartDay)));
  // 日期排序：只有一個月 ⇒ 那個月印一次在最上面；跨月 ⇒ 每個月一條分隔（firstMonth＝null）。
  // 金額排序：平面清單，每列帶日期（跨年才印年）
  const spanYears = new Set(all.map((e) => e.occurred_on.slice(0, 4))).size > 1;
  const items = isAmountSort(resultSort)
    ? shownRows.map((e) => <Row key={e.id} e={e} day={flatDayText(e.occurred_on, spanYears)} />)
    : dayItems(resultDays, null, today, mainDec, mainCode, masked, monthStartDay, flash, shown);

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
  const masked = useTicketStore(isTicketAmountMasked);
  const route = useNodeStore((s) => (e.route_id ? (s.routes.find((r) => r.id === e.route_id) ?? null) : null));
  const tagRefs = useMemo(
    () =>
      e.repeat_id
        ? ([
            [TK_TAG_ENTRY, e.id],
            [TK_TAG_REPEAT, e.repeat_id],
          ] as const)
        : ([[TK_TAG_ENTRY, e.id]] as const),
    [e.id, e.repeat_id],
  );
  const tagKeys = useMergedEntityTagKeys(tagRefs);
  const onPickTag = (key: string) => {
    const st = useTicketStore.getState();
    const cur = st.searchOpen ? st.filter.tagKeys : st.listFilter.tagKeys;
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    if (st.searchOpen) void st.patchFilter({ tagKeys: next });
    else void st.patchListFilter({ tagKeys: next });
  };

  const mainCur = mainCurrencyOf(curByCode);
  const mainCode = mainCur.code;
  const mainDec = mainCur.decimals;
  const mainSym = currencySymbol(mainCode);
  const amt = rowAmount(e, filterAccountId, accById, mainCode);
  const dec = curByCode[amt.currency]?.decimals ?? 2;
  const accName = (id: string | null) => (id ? (accById[id]?.name ?? "（帳戶已刪除）") : "—");

  const itemText = (e.item ?? "").trim();
  const noteText = (e.note ?? "").trim();
  const instBadge = installmentBadgeText(e);
  const feeCurCode = accById[e.account_id]?.currency ?? e.currency;
  const feeDec = curByCode[feeCurCode]?.decimals ?? 2;
  const feeText =
    e.fee_minor && e.fee_minor > 0
      ? masked
        ? maskedMoneyText(feeCurCode)
        : `${currencySymbol(feeCurCode)} ${moneyText(e.fee_minor, feeDec)}`
      : null;

  let cat: ReactElement;
  let isUncat = false;
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
    isUncat = !c || c.id === UNCAT_INCOME_ID || c.id === UNCAT_EXPENSE_ID;
    // 售票口④ 第二輪（D-票-78）：只寫最後兩段「外食 › 午餐」；完整路徑在這一筆的表單（「分類」小標）
    const path = c && !isUncat ? categoryPath(c, catById) : [];
    const p = path.length > 1 ? path[path.length - 2] : undefined;
    cat = isUncat ? (
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

  /* v1.38 3A：主字優先顯示 item（空則退回分類名／note）；item 與 note 皆有值時，淡色副字呈現分類與隨筆 */
  let primary: ReactElement;
  let subCat: ReactElement | null = null;
  let subNote = noteText;
  if (itemText !== "") {
    if (e.kind === "adjust") {
      primary = (
        <>
          <span className="seikan">精算</span>
          {itemText}
        </>
      );
      subCat = <>{accName(e.account_id)}</>;
    } else {
      primary = <>{itemText}</>;
      subCat = e.kind === "transfer" || !isUncat ? cat : null;
    }
  } else if (e.kind !== "transfer" && e.kind !== "adjust" && isUncat && noteText !== "") {
    primary = <>{noteText}</>;
    subCat = null;
    subNote = "";
  } else {
    primary = cat;
    subCat = null;
  }

  const hasSubLine = Boolean(day !== undefined || route || subCat || subNote);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        className={"ns-tk-mrow" + (selectedId === e.id ? " is-last" : "")}
        data-kind={e.kind}
        onClick={() => openEntry(e.id)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            openEntry(e.id);
          }
        }}
      >
        <span className="sg">{SIGN[e.kind]}</span>
        <span className="main">
          {/* 第③階段（✎-5）＋ v1.38 3B：主字包 .ct 負責省略號，分期小牌與定期小標永遠看得到 */}
          <span className="c">
            <span className="ct">{primary}</span>
            {instBadge && <span className="ns-tk-minst">{instBadge}</span>}
            {e.repeat_id && <span className="ns-tk-mrep">定期</span>}
          </span>
          {hasSubLine && (
            <span className="nt">
              {day !== undefined && <span className="dt">{day}</span>}
              {route && (
                <span className="roundel" aria-hidden style={roundelStyle(route.color)}>
                  {route.code ?? route.name.slice(0, 1)}
                </span>
              )}
              {subCat && <span className="cat">{subCat}</span>}
              {subCat && subNote && (
                <span className="sep" aria-hidden>
                  ·
                </span>
              )}
              {subNote && <span className="t">{subNote}</span>}
            </span>
          )}
          {tagKeys.length > 0 && (
            <TagPills keys={tagKeys} max={3} compact onPick={onPickTag} className="ns-tk-mrtags" />
          )}
        </span>
        <span className="a">
          <b>{masked ? maskedMoneyText(amt.currency) : moneyText(amt.minor, dec)}</b>
          {!masked && amt.currency !== mainCode && <span className="cur">{amt.currency}</span>}
          {!masked && amt.convMain !== null && (
            <span className="conv">
              ≈ {mainSym} {moneyText(amt.convMain, mainDec, { whole: true })}
            </span>
          )}
          {feeText && <span className="fee">含手續費 {feeText}</span>}
        </span>
      </div>
    </li>
  );
}
