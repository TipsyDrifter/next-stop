/**
 * MobileTicketStats——售票口手機的統計視圖（②契約 §5.3【統計】；v1.33 3B 增列各切面「筆數」＆「依金額｜依筆數」排序＆「依路線」原地手風琴展開明細與 ↗ 跳路線圖）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBackLayer } from "../../mobile/backStack";
import { revealOnRouteMap } from "../../mobile/routeMapReveal";
import { runAtomicNav } from "../../../store/navHistoryStore";
import { isTicketAmountMasked, useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { roundelStyle } from "../../common/roundel";
import {
  MASK_STARS,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  categoryLabel,
  formatDisplayMoney,
  mainCurrencyOf,
  maskedMoneyText,
  monthOf,
  moneyText,
  rowAmount,
} from "../../../domain/ticket";
import {
  GONE_KEY,
  NO_ROUTE_KEY,
  NO_TAG_KEY,
  UNSPLIT_KEY,
  VIEW_TEXT,
  compactMoney,
  periodRange,
  routeBreakdownEntries,
  routeCtx,
  shareText,
  shortDay,
  statsCrumbs,
  type BreakdownRow,
  type BreakdownSort,
  type EntryFilter,
  type Facet,
  type StatsData,
} from "../../../domain/ticketView";
import { IconLeft, IconRight } from "./mobileBits";
import { useViewSwipe } from "./MobileViewBar";
import { MobileBudgetCard } from "./plan/MobileBudgetCard";
import { Tabs, type TabItem } from "../../common/Tabs";
import "../ticket-4-extras.css";

const SPAN_TABS: readonly TabItem<"month" | "year">[] = [
  { key: "month", label: "月" },
  { key: "year", label: "年" },
];

export function MobileTicketStats() {
  const stats = useTicketStore((s) => s.stats);
  const mainCur = useTicketStore((s) => mainCurrencyOf(s.curByCode));
  const masked = useTicketStore(isTicketAmountMasked);
  const dec = mainCur.decimals;
  const mainCode = mainCur.code;
  const span = useTicketStore((s) => s.span);
  const setSpan = useTicketStore((s) => s.setSpan);
  const ref = useRef<HTMLDivElement | null>(null);
  useViewSwipe(ref);

  return (
    <div className="ns-tk-mstats" ref={ref}>
      {stats === null ? (
        <p className="ns-tk-mnone" aria-busy="true">
          正在算…
        </p>
      ) : (
        <>
          <Overview stats={stats} dec={dec} mainCode={mainCode} masked={masked} />
          <div className="ns-tk-mst-span">
            <Tabs items={SPAN_TABS} value={span} onChange={(k) => void setSpan(k)} size="md" aria-label="統計期間" />
          </div>
          {span === "month" && <MobileBudgetCard />}
          <section className="ns-tk-mst-card">
            <div className="ns-tk-mst-cardh">
              <b>各月比較</b>
              <span className="ns-tk-mst-legend" aria-hidden>
                <i className="sw exp" />
                支出
                <i className="sw inc" />
                收入
              </span>
            </div>
            <Trend stats={stats} dec={dec} mainCode={mainCode} masked={masked} />
          </section>
          <Facets />
          <section className="ns-tk-mst-card">
            <Breakdown stats={stats} dec={dec} mainCode={mainCode} masked={masked} />
          </section>
        </>
      )}
    </div>
  );
}

/* ───────── 三數卡 ───────── */

function Overview({ stats, dec, mainCode, masked }: { stats: StatsData; dec: number; mainCode: string; masked: boolean }) {
  const o = stats.overview;
  const incText = masked ? maskedMoneyText(mainCode, { prefix: "＋" }) : `＋${compactMoney(o.income, dec)}`;
  const expText = masked ? maskedMoneyText(mainCode) : compactMoney(o.expense, dec);
  const netAbs = compactMoney(Math.abs(o.net), dec);
  const netText = masked
    ? maskedMoneyText(mainCode, { prefix: o.net > 0 ? "＋" : undefined })
    : o.net < 0
      ? "−" + netAbs
      : o.net > 0
        ? "＋" + netAbs
        : netAbs;
  return (
    <div className="ns-tk-mst-over">
      <div className="num inc">
        <span>收入</span>
        <b>{incText}</b>
      </div>
      <div className="num">
        <span>支出</span>
        <b>{expText}</b>
      </div>
      <div className="num net">
        <span>淨額</span>
        <b>{netText}</b>
      </div>
      <small className="cnt">{o.count} 筆收支</small>
    </div>
  );
}

/* ───────── 趨勢 12 根 ───────── */

const TREND_H = 160;

function Trend({ stats, dec, mainCode, masked }: { stats: StatsData; dec: number; mainCode: string; masked: boolean }) {
  const month = useTicketStore((s) => s.month);
  const monthStartDay = useTicketStore((s) => s.monthStartDay);
  const span = useTicketStore((s) => s.span);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const thisMonth = monthOf(todayKey(dayStartHour), monthStartDay);
  const box = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(320);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 0) setW(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pick = async (m: string) => {
    const st = useTicketStore.getState();
    if (m > thisMonth) return;
    if (st.span === "year") await st.setSpan("month");
    if (m !== useTicketStore.getState().month) await useTicketStore.getState().setMonth(m);
  };

  const pts = stats.trend;
  const base = TREND_H - 32;
  const top = 26;
  const max = Math.max(1, ...pts.map((p) => Math.max(p.expense, p.income)));
  const gw = W / pts.length;
  const bw = Math.min(9, gw * 0.3);
  const gap = 2;
  const fs = 8.5;
  const hOf = (v: number) => Math.max(v > 0 ? 1.5 : 0, (Math.max(0, v) / max) * (base - top));
  const cur = span === "month" ? month : null;

  return (
    <div ref={box} className="ns-tk-mst-trendbox">
      <svg
        className="ns-tk-mst-trend"
        width={W}
        height={TREND_H}
        viewBox={`0 0 ${W} ${TREND_H}`}
        role="group"
        aria-label="每月趨勢：支出與收入"
      >
        <line className="base" x1={0} x2={W} y1={base + 0.5} y2={base + 0.5} />
        {pts.map((p, i) => {
          const cx = gw * i + gw / 2;
          const isCur = p.month === cur;
          const future = p.month > thisMonth;
          const y = p.month.slice(0, 4);
          const m = Number(p.month.slice(5, 7));
          const yearLab = span === "month" && (i === 0 || m === 1) ? `'${y.slice(2)}` : null;
          const xe = cx - bw - gap / 2;
          const xi = cx + gap / 2;
          const he = hOf(p.expense);
          const hi = hOf(p.income);
          let ye = base - he - 4;
          let yi = base - hi - 4;
          const showI = !masked && isCur && p.income !== 0;
          if (showI && Math.abs(ye - yi) < fs + 2) {
            if (yi <= ye) yi = ye - (fs + 2);
            else ye = yi - (fs + 2);
          }
          const aria = `${y} 年 ${m} 月：支出 ${formatDisplayMoney(p.expense, dec, { whole: true, masked, currency: mainCode })}、收入 ${formatDisplayMoney(
            p.income,
            dec,
            { whole: true, masked, currency: mainCode },
          )}`;
          return (
            <g
              key={p.month}
              className={"g" + (isCur ? " is-cur" : "") + (future ? " is-future" : "")}
              role={future ? undefined : "button"}
              tabIndex={future ? undefined : 0}
              aria-label={aria}
              aria-pressed={future ? undefined : isCur}
              onClick={() => void pick(p.month)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void pick(p.month);
                }
              }}
            >
              <rect className="hit" x={gw * i + 1} y={0} width={Math.max(0, gw - 2)} height={TREND_H} rx={2} />
              <text className="m" x={cx} y={TREND_H - 17} textAnchor="middle">
                {m}
              </text>
              {yearLab && (
                <text className="yr" x={cx} y={TREND_H - 4} textAnchor="middle">
                  {yearLab}
                </text>
              )}
              <rect className="exp" x={xe} y={base - he} width={bw} height={he} rx={1} />
              <rect className="inc" x={xi} y={base - hi} width={bw} height={hi} rx={1} />
              {!future && p.expense !== 0 && (!masked || isCur) && (
                <text className="v" x={xe + bw / 2} y={ye} textAnchor="middle">
                  {masked ? MASK_STARS : compactMoney(p.expense, dec)}
                </text>
              )}
              {!future && showI && (
                <text className="v is-inc" x={xi + bw / 2} y={yi} textAnchor="middle">
                  {compactMoney(p.income, dec)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ───────── 切面與排序 ───────── */

const FACETS: readonly { key: Facet; label: string }[] = [
  { key: "category", label: "分類" },
  { key: "account", label: "帳戶" },
  { key: "route", label: "路線" },
  { key: "tag", label: "荷札" },
];

const SORTS: readonly { key: BreakdownSort; label: string }[] = [
  { key: "amount", label: "依金額" },
  { key: "count", label: "依筆數" },
];

function Facets() {
  const facet = useTicketStore((s) => s.facet);
  const facetKind = useTicketStore((s) => s.facetKind);
  const statsSort = useTicketStore((s) => s.statsSort);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const setFacet = useTicketStore((s) => s.setFacet);
  const setFacetKind = useTicketStore((s) => s.setFacetKind);
  const setStatsSort = useTicketStore((s) => s.setStatsSort);
  const shown = FACETS.filter((f) => !(f.key === "account" && filterAccountId !== null));
  return (
    <div className="ns-tk-mst-facets">
      <span className={"ns-tk-mseg" + (shown.length > 3 ? " is-4" : "")} role="group" aria-label="切面">
        {shown.map((f) => (
          <button key={f.key} type="button" aria-pressed={facet === f.key} onClick={() => setFacet(f.key)}>
            {f.label}
          </button>
        ))}
      </span>
      <span className="ns-tk-mseg" role="group" aria-label="支出或收入">
        {(["expense", "income"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={facetKind === k} onClick={() => setFacetKind(k)}>
            {k === "expense" ? "支出" : "收入"}
          </button>
        ))}
      </span>
      <span className="ns-tk-mseg ns-tk-mst-sortseg" role="group" aria-label="統計排序">
        {SORTS.map((s) => (
          <button key={s.key} type="button" aria-pressed={statsSort === s.key} onClick={() => setStatsSort(s.key)}>
            {s.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/* ───────── 依路線原地手風琴明細 ───────── */

function MobileRouteEntriesAccordion({
  routeKey,
  routeLabel,
  kind,
  target,
  mainCode,
  masked,
}: {
  routeKey: string;
  routeLabel: string;
  kind: "expense" | "income";
  target: Partial<EntryFilter> | null;
  mainCode: string;
  masked: boolean;
}) {
  const statsEntries = useTicketStore((s) => s.statsEntries);
  const period = useTicketStore((s) => s.period);
  const monthStartDay = useTicketStore((s) => s.monthStartDay);
  const catById = useTicketStore((s) => s.catById);
  const accById = useTicketStore((s) => s.accById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const jumpToEntry = useTicketStore((s) => s.jumpToEntry);
  const drillToList = useTicketStore((s) => s.drillToList);
  const routes = useNodeStore((s) => s.routes);

  const list = useMemo(() => {
    const r = periodRange(period, monthStartDay);
    return routeBreakdownEntries(statsEntries, r, routeKey, kind, routeCtx(routes));
  }, [statsEntries, period, monthStartDay, routeKey, kind, routes]);

  const withYear = period.span === "year" || new Set(list.map((e) => e.occurred_on.slice(0, 4))).size > 1;

  return (
    <li className="ns-tk-mst-rtdetail">
      <ul className="ns-tk-mst-rtlist" aria-label={`「${routeLabel}」的帳目明細`}>
        {list.map((e) => {
          const amt = rowAmount(e, filterAccountId, accById, mainCode);
          const curDec = curByCode[amt.currency]?.decimals ?? 2;
          const foreign = amt.currency !== mainCode;
          const catText = categoryLabel(e.category_id ? (catById[e.category_id] ?? null) : null, catById, { short: true });
          const dateStr = withYear ? `${e.occurred_on.slice(0, 4)}/${shortDay(e.occurred_on)}` : shortDay(e.occurred_on);
          return (
            <li key={e.id}>
              <button
                type="button"
                className="ns-tk-mst-rtitem"
                onClick={() => {
                  runAtomicNav(() => {
                    void jumpToEntry(e.id);
                  });
                }}
              >
                <span className="top">
                  <span className="dt">{dateStr}</span>
                  <span className="cat">{catText}</span>
                  <span className="amt">
                    {amt.prefix}
                    <b>{masked ? maskedMoneyText(amt.currency) : moneyText(amt.minor, curDec)}</b>
                    {!masked && foreign && <small className="cur">{amt.currency}</small>}
                  </span>
                </span>
                {e.note && <span className="nt">{e.note}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {target && list.length > 0 && (
        <div className="ns-tk-mst-rtfoot">
          <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => void drillToList(target)}>
            在帳簿篩選全部（{list.length} 筆）›
          </button>
        </div>
      )}
    </li>
  );
}

/* ───────── 占比列 ───────── */

function Breakdown({ stats, dec, mainCode, masked }: { stats: StatsData; dec: number; mainCode: string; masked: boolean }) {
  const facet = useTicketStore((s) => s.facet);
  const facetKind = useTicketStore((s) => s.facetKind);
  const statsSort = useTicketStore((s) => s.statsSort);
  const drill = useTicketStore((s) => s.drill);
  const setDrill = useTicketStore((s) => s.setDrill);
  const drillToList = useTicketStore((s) => s.drillToList);
  const statsRoot = useTicketStore((s) => s.statsRoot);
  const setStatsRoot = useTicketStore((s) => s.setStatsRoot);
  const catById = useTicketStore((s) => s.catById);
  const routes = useNodeStore((s) => s.routes);
  const bd = stats.breakdown;

  const root = facet === "category" ? statsRoot : null;
  const crumbs = root !== null ? statsCrumbs(root, catById) : [];
  const upId = crumbs.length > 1 ? crumbs[crumbs.length - 2].id : null;
  useBackLayer("ticket.stats.root", root !== null, () => setStatsRoot(upId), "page");
  const crumbBar =
    root !== null ? (
      <div className="ns-tk-mst-crumb">
        <nav aria-label="分類的層">
          <button type="button" className="back" aria-label="回上一層" onClick={() => setStatsRoot(upId)}>
            <IconLeft size={15} />
          </button>
          {crumbs.map((c, i) =>
            i < crumbs.length - 1 ? (
              <span key={c.id ?? "all"} className="part">
                {i > 0 && (
                  <span className="sl" aria-hidden>
                    ›
                  </span>
                )}
                <button type="button" className="seg" onClick={() => setStatsRoot(c.id)}>
                  {c.label}
                </button>
              </span>
            ) : (
              <span key={c.id ?? "all"} className="part">
                <span className="sl" aria-hidden>
                  ›
                </span>
                <b aria-current="location">{c.label}</b>
              </span>
            ),
          )}
        </nav>
        <span className="sum">
          合計 {masked ? maskedMoneyText(mainCode) : compactMoney(bd.total, dec)}
          <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => void drillToList({ categoryIds: [root], kinds: [facetKind] })}>
            看明細
          </button>
        </span>
      </div>
    ) : null;

  if (!bd.rows.length && !bd.refunds.length)
    return (
      <>
        {crumbBar}
        <p className="ns-tk-mst-empty">{VIEW_TEXT.emptyStats}</p>
      </>
    );

  const maxShare = Math.max(0.0001, ...bd.rows.map((r) => r.share));
  const maxCount = Math.max(1, ...bd.rows.map((r) => r.count));

  const drillOf = (r: BreakdownRow, parentKey: string | null): Partial<EntryFilter> | null => {
    if (r.key === GONE_KEY) return null;
    const kinds = [facetKind] as const;
    if (facet === "category") {
      const id = r.key === UNSPLIT_KEY ? (parentKey ?? root) : r.key;
      return id ? { categoryIds: [id], kinds } : null;
    }
    if (facet === "tag") {
      if (r.key === NO_TAG_KEY) return null;
      const key = r.key === UNSPLIT_KEY ? parentKey : r.key;
      return key ? { tagKeys: [key], kinds } : null;
    }
    if (facet === "account") return { accountId: r.key, kinds };
    return { routeId: r.key === NO_ROUTE_KEY ? "none" : r.key, kinds };
  };

  const name = (r: BreakdownRow, child: boolean) => {
    const faint =
      r.key === UNSPLIT_KEY || r.key === GONE_KEY || r.key === NO_ROUTE_KEY || r.key === NO_TAG_KEY || r.key === UNCAT_EXPENSE_ID || r.key === UNCAT_INCOME_ID;
    if (facet === "route" && !child) {
      const rt = routes.find((x) => x.id === r.key && x.deleted_at === null);
      return (
        <>
          {rt ? (
            <span className="roundel" aria-hidden style={roundelStyle(rt.color)}>
              {rt.code ?? rt.name.slice(0, 1)}
            </span>
          ) : (
            <span className="roundel is-empty" aria-hidden />
          )}
          <span className={"t" + (faint ? " is-faint" : "")}>{r.label}</span>
        </>
      );
    }
    return <span className={"t" + (faint ? " is-faint" : "")}>{r.label}</span>;
  };

  const row = (r: BreakdownRow, child: boolean, parentKey: string | null) => {
    const isRouteAccordion = facet === "route" && !child;
    const isParent = (!child && !!r.children && r.children.length > 0) || isRouteAccordion;
    const open = isParent && drill === r.key;
    const enter = facet === "category" && child && !!r.deeper && r.key !== UNSPLIT_KEY && r.key !== GONE_KEY;
    const target = isParent || enter ? null : drillOf(r, parentKey);
    const liveRoute =
      isRouteAccordion && r.key !== NO_ROUTE_KEY && r.key !== GONE_KEY ? routes.find((x) => x.id === r.key && x.deleted_at === null) : undefined;
    const w = statsSort === "count" ? (r.count / maxCount) * 100 : (r.share / maxShare) * 100;
    return (
      <li
        key={(child ? parentKey + "/" : "") + r.key}
        className={
          "row" +
          (isParent ? " is-parent" : "") +
          (open ? " is-open" : "") +
          (child ? " is-child" : "") +
          (enter ? " is-deeper" : "") +
          (liveRoute ? " has-jump" : "")
        }
      >
        <button
          type="button"
          className="hit"
          aria-expanded={isParent ? open : undefined}
          disabled={!isParent && !enter && target === null}
          title={
            isRouteAccordion
              ? `${open ? "收起" : "展開"}「${r.label}」的帳目明細`
              : isParent
                ? `${open ? "收起" : "展開"}子${facet === "tag" ? "荷札" : "分類"}`
                : enter
                  ? "進入這一層"
                  : target
                    ? "到清單看這些帳"
                    : undefined
          }
          onClick={() => {
            if (isParent) setDrill(open ? null : r.key);
            else if (enter) setStatsRoot(r.key);
            else if (target) void drillToList(target);
          }}
        >
          <span className="c" aria-hidden>
            {isParent && <IconRight size={10} />}
          </span>
          <span className="n">
            {name(r, child)}
            {enter && (
              <span className="go">
                進入
                <IconRight size={9} />
              </span>
            )}
          </span>
          <span className="cnt">{r.count} 筆</span>
          <span className="v">{masked ? maskedMoneyText(mainCode) : compactMoney(r.minor, dec)}</span>
          <span className="p">{shareText(r.share)}</span>
          <span className="bar" aria-hidden>
            <i style={{ width: `${Math.min(100, w).toFixed(1)}%` }} />
          </span>
        </button>
        {liveRoute && (
          <button
            type="button"
            className="ns-tk-mst-jump"
            aria-label={`前往路線圖查看「${r.label}」`}
            title={`前往路線圖「${r.label}」`}
            onClick={() => {
              runAtomicNav(() => {
                revealOnRouteMap(r.key, null);
              });
            }}
          >
            ↗
          </button>
        )}
      </li>
    );
  };

  const items: ReactNode[] = [];
  for (const r of bd.rows) {
    items.push(row(r, false, null));
    if (facet === "route" && drill === r.key) {
      items.push(
        <MobileRouteEntriesAccordion
          key={`rt-det-${r.key}`}
          routeKey={r.key}
          routeLabel={r.label}
          kind={facetKind}
          target={drillOf(r, null)}
          mainCode={mainCode}
          masked={masked}
        />,
      );
    } else if (r.children && r.children.length && drill === r.key) {
      for (const k of r.children) items.push(row(k, true, r.key));
    }
  }

  return (
    <>
      {crumbBar}
      {facet === "tag" && bd.rows.length > 0 && <p className="ns-tk-mst-tagnote">{VIEW_TEXT.tagNote(facetKind)}</p>}
      {bd.rows.length > 0 ? (
        <ul className={"ns-tk-mst-rows is-" + facetKind} aria-label="占比">
          {items}
        </ul>
      ) : (
        <p className="ns-tk-mst-empty">{VIEW_TEXT.emptyStats}</p>
      )}
      {bd.refunds.length > 0 && (
        <div className="ns-tk-mst-refunds">
          <span className="hd">{VIEW_TEXT.refunds}</span>
          {bd.refunds.map((r) => (
            <span key={r.key} className="it">
              {r.label}（{r.count} 筆） <b>{formatDisplayMoney(r.minor, dec, { whole: true, masked, currency: mainCode })}</b>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
