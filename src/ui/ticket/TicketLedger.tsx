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
 * 往前接月份的停點：store 沒有「最早一筆在哪個月」，所以連續 3 個月都空就停止自動接、改成手按「繼續往前」
 * （不然沒有更早的帳時會一路往前載空月）。見回報 needs。
 */
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
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
  }, [autoLoad, loadedMonths]);

  const store = useTicketStore.getState;
  const filterAcc = filterAccountId ? accById[filterAccountId] : undefined;
  const panelOpen = panel.kind === "entry";

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
    const [d, w] = g.label.split(" ");
    items.push(
      <li key={`d-${g.dayKey}`} className="ns-tk-day" role="presentation">
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
      const active = panelOpen && selectedId === e.id;
      const amt = rowAmount(e, filterAccountId, accById);
      const cur = curByCode[amt.currency];
      const foreign = amt.currency !== MAIN_CURRENCY;
      const route = e.route_id ? routeById[e.route_id] : undefined;
      items.push(
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
        </li>,
      );
    }
  });

  return (
    <main className="ns-tk-ledger techo-scroll is-compact" aria-label="帳簿">
      <header className="ns-tk-head">
        <div className="ns-tk-headrow">
          <span className="ns-tk-overline">售票口 — TICKET OFFICE</span>
          <button type="button" className="ns-tk-newbtn" onClick={() => store().openNew()} title="記一筆">
            <TkIcon name="plus" size={11} />
            記一筆
            <kbd className="ns-tk-kbd">{capsOf("ticket.new")}</kbd>
          </button>
        </div>
        <div className="ns-tk-headrow is-month">
          <button
            type="button"
            className="ns-tk-mnav"
            aria-label={`上一個月（${capsOf("ticket.month.prev")}）`}
            title={`上一個月（${capsOf("ticket.month.prev")}）`}
            onClick={() => void store().stepMonth(-1)}
          >
            <TkIcon name="left" />
          </button>
          <h1 className="techo-title">{monthTitle(month)}</h1>
          <button
            type="button"
            className="ns-tk-mnav"
            aria-label={`下一個月（${capsOf("ticket.month.next")}）`}
            title={`下一個月（${capsOf("ticket.month.next")}）`}
            disabled={month >= thisMonth}
            onClick={() => void store().stepMonth(1)}
          >
            <TkIcon name="right" />
          </button>
          {monthSum && filterAccountId === null && (monthSum.income !== 0 || monthSum.expense !== 0) && (
            <span className="ns-tk-monthsum">
              收入 <b className="pos">{moneyText(monthSum.income, mainDec, { prefix: "＋" })}</b> · 支出{" "}
              <b>{moneyText(monthSum.expense, mainDec)}</b>
            </span>
          )}
        </div>
        {filterAcc && (
          <div className="ns-tk-filterchip">
            篩選：{acctLabel(filterAcc, accounts)}
            <button type="button" aria-label="清除篩選" title="清除篩選" onClick={() => void store().setFilter(null)}>
              <TkIcon name="x" size={11} />
            </button>
          </div>
        )}
      </header>

      {error && !ready ? (
        <div className="ns-tk-error" role="alert">
          <p>帳本讀不出來：{error}</p>
          <button type="button" className="ns-tk-btn" onClick={() => void store().init("desktop").catch(() => undefined)}>
            再試一次
          </button>
        </div>
      ) : ready && !hasAny ? (
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
          <ul
            ref={listRef}
            className="ns-tk-list"
            tabIndex={0}
            role="listbox"
            aria-label="帳簿"
            aria-activedescendant={selectedId ? `tk-row-${selectedId}` : undefined}
          >
            {items}
            {ready && hasAny && (
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
