/**
 * TicketStats——售票口桌機的統計視圖（②契約 §5.1【統計】、0-1、0-6～0-9；D-票-27：橫條排名＋12 根直條；乙席）。
 * 長相照原型 `deskStats()`：
 *
 *   div.ns-tk-stats
 *   ├─ .ns-tk-st-top             三數卡 .ns-tk-st-over（收入／支出／淨額＋「N 筆收支」）・右：「月｜年」分頁籤 Tabs.ns-tk-st-span
 *                                 （UI 丙-5 J2：期間是「換一種看法」＝分頁籤，視覺規範 §2.2；下面的切面、支出｜收入仍是分段鈕）
 *   ├─ section.ns-tk-st-card     「月對月」：svg.ns-tk-st-trend 12 根（每月兩條：支出墨、收入 gold-ink；條頂 compactMoney）
 *   │                              選中月 .is-cur；點一根 ⇒ 切到那個月（年模式點 ⇒ 回月模式並選那個月）；未來的月不能點
 *   └─ section.ns-tk-st-card     「占比」：.ns-tk-st-facets（分類｜帳戶｜路線・支出｜收入）＋ ul.ns-tk-st-rows 橫條排名＋淨退回
 *         主分類（有子分類）⇒ 點展開（store.drill，一次一個）；其餘列 ⇒ drillToList（切清單＋帶篩選，0-15）
 *
 * 每個數字的來源：三數＝statsOverview、12 根＝monthlyTrend、橫條＝breakdown（全在 store.stats，純函式算好）。
 * 橫條長度＝該列 share ÷ 最大那列 share（原型做法：最大的一列畫滿，比例仍是 share 的比例）；% 字是 shareText(share)。
 * 圖不加圖表庫（0-23）：svg 寬度＝容器實際像素（ResizeObserver），不縮放字。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { useNodeStore } from "../../../store/nodeStore";
import { todayKey } from "../../../lib/date";
import { MAIN_CURRENCY, UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, monthOf, moneyText } from "../../../domain/ticket";
import {
  GONE_KEY,
  NO_ROUTE_KEY,
  UNSPLIT_KEY,
  VIEW_TEXT,
  compactMoney,
  shareText,
  type BreakdownRow,
  type EntryFilter,
  type Facet,
  type StatsData,
  type TrendPoint,
} from "../../../domain/ticketView";
import type { NodeRow } from "../../../domain/node";
import { TkIcon, TkRoundel } from "../TicketLedger";
import { BudgetCard } from "../plan/BudgetCard";
import { Tabs, type TabItem } from "../../common/Tabs";

const FACETS: readonly [Facet, string][] = [
  ["category", "分類"],
  ["account", "帳戶"],
  ["route", "路線"],
];
const KINDS: readonly ["expense" | "income", string][] = [
  ["expense", "支出"],
  ["income", "收入"],
];

const isUncat = (k: string): boolean => k === UNCAT_EXPENSE_ID || k === UNCAT_INCOME_ID;

/* ───────── 總覽三數 ───────── */

function Overview({ stats, dec }: { stats: StatsData; dec: number }) {
  const o = stats.overview;
  return (
    <div className="ns-tk-st-over" aria-label="總覽">
      <div className="ns-tk-st-num inc">
        <span>收入</span>
        <b>{moneyText(o.income, dec, { prefix: o.income > 0 ? "＋" : undefined })}</b>
      </div>
      <div className="ns-tk-st-num">
        <span>支出</span>
        <b>{moneyText(o.expense, dec)}</b>
      </div>
      <div className="ns-tk-st-num net">
        <span>淨額</span>
        {/* 0-1：淨額為負顯示 − 前綴、不變色；正數帶 ＋（原型） */}
        <b>{moneyText(o.net, dec, { prefix: o.net > 0 ? "＋" : undefined })}</b>
      </div>
      <small className="cnt">{o.count} 筆收支</small>
    </div>
  );
}

/* ───────── 月對月 12 根 ───────── */

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Trend({ points, cur, span, thisMonth, dec }: { points: TrendPoint[]; cur: string; span: "month" | "year"; thisMonth: string; dec: number }) {
  const [boxRef, W] = useWidth<HTMLDivElement>();
  const H = 176;
  const base = H - 22;
  const top = 30;
  const fs = 10;
  const max = Math.max(1, ...points.map((p) => Math.max(p.expense, p.income)));
  const gw = W / 12;
  const bw = Math.min(18, gw * 0.3);
  const gap = 3;
  const hOf = (v: number) => Math.max(v > 0 ? 1.5 : 0, (Math.max(0, v) / max) * (base - top));

  const pick = (m: string) => {
    if (m > thisMonth) return;
    const st = useTicketStore.getState();
    void (async () => {
      if (st.month !== m) await st.setMonth(m);
      if (useTicketStore.getState().span === "year") await useTicketStore.getState().setSpan("month");
    })();
  };
  const onKey = (e: KeyboardEvent<SVGGElement>, m: string) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    pick(m);
  };

  return (
    <div ref={boxRef} className="ns-tk-st-trendbox">
      {W > 0 && (
        <svg className="ns-tk-st-trend" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label="每月趨勢：支出與收入">
          <line className="tr-base" x1={0} x2={W} y1={base + 0.5} y2={base + 0.5} />
          {points.map((p, i) => {
            const cx = gw * i + gw / 2;
            const isCur = p.month === cur;
            const future = p.month > thisMonth;
            const [y, m] = p.month.split("-");
            const lab = span === "month" && (i === 0 || m === "01") ? `'${y.slice(2)} ${Number(m)}` : String(Number(m));
            const xe = cx - bw - gap / 2;
            const xi = cx + gap / 2;
            const he = hOf(p.expense);
            const hi = hOf(p.income);
            // 條頂印金額：兩個數太近就把高的那個往上疊一行（不重疊；原型做法）
            let ye = base - he - 4;
            let yi = base - hi - 4;
            if (p.income && p.expense && Math.abs(ye - yi) < fs + 2) {
              if (yi <= ye) yi = ye - (fs + 2);
              else ye = yi - (fs + 2);
            }
            const title = `${Number(y)} 年 ${Number(m)} 月：支出 ${moneyText(p.expense, dec)}、收入 ${moneyText(p.income, dec)}`;
            return (
              <g
                key={p.month}
                className={"tr-g" + (isCur ? " is-cur" : "") + (future ? " is-future" : "")}
                role={future ? undefined : "button"}
                tabIndex={future ? undefined : 0}
                aria-label={future ? undefined : title}
                aria-pressed={future ? undefined : isCur}
                onClick={() => pick(p.month)}
                onKeyDown={(e) => onKey(e, p.month)}
              >
                <title>{title}</title>
                <rect className="tr-hit" x={gw * i + 1} y={0} width={Math.max(0, gw - 2)} height={H} rx={2} />
                <text className="tr-m" x={cx} y={H - 6} textAnchor="middle">
                  {lab}
                </text>
                <rect className="tr-exp" x={xe} y={base - he} width={bw} height={he} rx={1} />
                <rect className="tr-inc" x={xi} y={base - hi} width={bw} height={hi} rx={1} />
                {!future && p.expense !== 0 && (
                  <text className="tr-v" x={xe + bw / 2} y={ye} textAnchor="middle">
                    {compactMoney(p.expense, dec)}
                  </text>
                )}
                {!future && p.income !== 0 && (
                  <text className="tr-v is-inc" x={xi + bw / 2} y={yi} textAnchor="middle">
                    {compactMoney(p.income, dec)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/* ───────── 占比橫條 ───────── */

/** 統計下鑽到底（0-15）：這一列帶什麼篩選；null＝這一列不能下鑽（「（…已不在）」沒有篩選條件表達得出來） */
function drillOf(facet: Facet, key: string, parentKey: string | null): Partial<EntryFilter> | null {
  if (key === GONE_KEY) return null;
  if (facet === "category") {
    // 「未細分」＝直接記在主分類本身的帳：篩選只能表達「主分類（含子分類）」，近似帶主分類（原型同）
    if (key === UNSPLIT_KEY) return parentKey ? { categoryIds: [parentKey] } : null;
    return { categoryIds: [key] };
  }
  if (facet === "account") return { accountId: key };
  return { routeId: key === NO_ROUTE_KEY ? "none" : key };
}

function RowName({ row, facet, routeById }: { row: BreakdownRow; facet: Facet; routeById: Record<string, NodeRow> }) {
  const faint = row.key === UNSPLIT_KEY || row.key === GONE_KEY || isUncat(row.key);
  if (facet === "route") {
    return (
      <>
        <TkRoundel route={row.key === NO_ROUTE_KEY || row.key === GONE_KEY ? null : routeById[row.key]} />
        <span className={"t" + (faint || row.key === NO_ROUTE_KEY ? " is-faint" : "")}>{row.label}</span>
      </>
    );
  }
  return <span className={"t" + (faint ? " is-faint" : "")}>{row.label}</span>;
}

function Bars({ stats, facet, kind, drill, dec }: { stats: StatsData; facet: Facet; kind: "expense" | "income"; drill: string | null; dec: number }) {
  const routes = useNodeStore((s) => s.routes);
  const routeById = useMemo(() => {
    const m: Record<string, NodeRow> = {};
    for (const r of routes) m[r.id] = r;
    return m;
  }, [routes]);
  const bd = stats.breakdown;
  if (!bd.rows.length && !bd.refunds.length) return <p className="ns-tk-empty">{VIEW_TEXT.emptyStats}</p>;
  const max = Math.max(0.0001, ...bd.rows.map((r) => r.share));
  const store = useTicketStore.getState;

  const li = (r: BreakdownRow, parent: BreakdownRow | null) => {
    const isParent = !parent && !!r.children && r.children.length > 0;
    const open = isParent && drill === r.key;
    const target = isParent ? null : drillOf(facet, r.key, parent ? parent.key : null);
    const kindLabel = kind === "expense" ? "支出" : "收入";
    return (
      <li key={(parent ? parent.key + "/" : "") + r.key} className={"ns-tk-st-row" + (isParent ? " is-parent" : "") + (open ? " is-open" : "") + (parent ? " is-child" : "")}>
        <button
          type="button"
          aria-expanded={isParent ? open : undefined}
          disabled={!isParent && target === null}
          title={isParent ? (open ? "收起子分類" : "展開子分類") : target ? `到清單看這些帳（${kindLabel}）` : "這些帳的分類、帳戶或路線已刪除，無法篩選"}
          onClick={() => {
            if (isParent) store().setDrill(open ? null : r.key);
            else if (target) void store().drillToList({ ...target, kinds: [kind] });
          }}
        >
          <span className="c">{isParent && <TkIcon name="right" size={10} />}</span>
          <span className="n">
            <RowName row={r} facet={facet} routeById={routeById} />
          </span>
          <span className="bar" aria-hidden>
            <i style={{ width: `${((r.share / max) * 100).toFixed(1)}%` }} />
          </span>
          <span className="v">{moneyText(r.minor, dec)}</span>
          <span className="p">{shareText(r.share)}</span>
        </button>
      </li>
    );
  };

  return (
    <>
      <ul className={"ns-tk-st-rows is-" + kind}>
        {bd.rows.map((r) => [li(r, null), ...(drill === r.key && r.children ? r.children.map((k) => li(k, r)) : [])])}
      </ul>
      {bd.refunds.length > 0 && (
        <div className="ns-tk-st-refunds">
          <span className="hd">{VIEW_TEXT.refunds}</span>
          {bd.refunds.map((r) => (
            <span key={r.key} className="it">
              {r.label} <b>{moneyText(r.minor, dec)}</b>
            </span>
          ))}
          <small>退款大於支出的{facet === "category" ? "分類" : facet === "account" ? "帳戶" : "路線"}不計入圖表與總額</small>
        </div>
      )}
    </>
  );
}

/** 統計期間（月｜年）：分頁籤的兩段 */
const SPAN_TABS: readonly TabItem<"month" | "year">[] = [
  { key: "month", label: "月" },
  { key: "year", label: "年" },
];

/* ───────── 視圖 ───────── */

export function TicketStats() {
  const stats = useTicketStore((s) => s.stats);
  const span = useTicketStore((s) => s.span);
  const month = useTicketStore((s) => s.month);
  const facet = useTicketStore((s) => s.facet);
  const facetKind = useTicketStore((s) => s.facetKind);
  const drill = useTicketStore((s) => s.drill);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const thisMonth = monthOf(todayKey(dayStartHour));
  const store = useTicketStore.getState;

  if (!stats) {
    return (
      <div className="ns-tk-stats is-loading" aria-busy="true">
        <p className="ns-tk-empty">正在算…</p>
      </div>
    );
  }
  const facets = FACETS.filter(([k]) => !(k === "account" && filterAccountId !== null)); // 0-8：已篩帳戶 ⇒ 帳戶切面沒意義
  const cur = month; // 年模式也標出 month 那一根（原型同；回清單就是那個月）

  return (
    <div className="ns-tk-stats">
      <div className="ns-tk-st-top">
        <Overview stats={stats} dec={dec} />
        <Tabs items={SPAN_TABS} value={span} onChange={(k) => void store().setSpan(k)} size="md" aria-label="統計期間" className="ns-tk-st-span" />
      </div>

      {/* 第③階段（③契約 §5.1、✎-2）：三數卡之後、月對月之前；只在月模式（Stage 0 甲席掛樁） */}
      {span === "month" && <BudgetCard />}

      <section className="ns-tk-st-card" aria-label="各月比較">
        <div className="ns-tk-st-h">
          <h2>各月比較</h2>
          <small>{span === "year" ? "這一年 1–12 月" : "近 12 個月"}・點長條切到該月</small>
          <span className="ns-tk-st-legend" aria-hidden>
            <i className="sw exp" />
            支出
            <i className="sw inc" />
            收入
          </span>
        </div>
        <Trend points={stats.trend} cur={cur} span={span} thisMonth={thisMonth} dec={dec} />
      </section>

      <section className="ns-tk-st-card" aria-label="占比">
        <div className="ns-tk-st-h">
          <h2>占比</h2>
          <small>{facet === "category" ? "點主分類可展開，點子分類可看明細" : "點任一列可看明細"}</small>
        </div>
        <div className="ns-tk-st-facets">
          <span className="ns-tk-seg" role="group" aria-label="切面">
            {facets.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={facet === k} onClick={() => store().setFacet(k)}>
                {l}
              </button>
            ))}
          </span>
          <span className="ns-tk-seg" role="group" aria-label="支出或收入">
            {KINDS.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={facetKind === k} onClick={() => store().setFacetKind(k)}>
                {l}
              </button>
            ))}
          </span>
        </div>
        <Bars stats={stats} facet={facet} kind={facetKind} drill={drill} dec={dec} />
      </section>
    </div>
  );
}
