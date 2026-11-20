/**
 * TicketStats——售票口桌機的統計視圖（②契約 §5.1【統計】、0-1、0-6～0-9；v1.33 3B 增列各切面「筆數」＆「依金額｜依筆數」排序＆「依路線」原地手風琴展開明細與 ↗ 跳路線圖）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { isTicketAmountMasked, useTicketStore } from "../../../store/ticketStore";
import { runAtomicNav } from "../../../store/navHistoryStore";
import { useUiStore } from "../../../store/uiStore";
import { useNodeStore } from "../../../store/nodeStore";
import { todayKey } from "../../../lib/date";
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
  type TrendPoint,
} from "../../../domain/ticketView";
import type { NodeRow } from "../../../domain/node";
import { TkIcon, TkRoundel } from "../TicketLedger";
import { BudgetCard } from "../plan/BudgetCard";
import { Tabs, type TabItem } from "../../common/Tabs";
import "../ticket-4-extras.css";
import "../ticket-4b.css";

const FACETS: readonly [Facet, string][] = [
  ["category", "分類"],
  ["account", "帳戶"],
  ["route", "路線"],
  ["tag", "荷札"],
];

const KINDS: readonly ["expense" | "income", string][] = [
  ["expense", "支出"],
  ["income", "收入"],
];

const SORTS: readonly [BreakdownSort, string][] = [
  ["amount", "依金額"],
  ["count", "依筆數"],
];

const isUncat = (k: string): boolean => k === UNCAT_EXPENSE_ID || k === UNCAT_INCOME_ID;

/* ───────── 總覽三數 ───────── */

function Overview({ stats, dec, mainCode, masked }: { stats: StatsData; dec: number; mainCode: string; masked: boolean }) {
  const o = stats.overview;
  return (
    <div className="ns-tk-st-over" aria-label="總覽">
      <div className="ns-tk-st-num inc">
        <span>收入</span>
        <b>{formatDisplayMoney(o.income, dec, { prefix: o.income > 0 ? "＋" : undefined, masked, currency: mainCode })}</b>
      </div>
      <div className="ns-tk-st-num">
        <span>支出</span>
        <b>{formatDisplayMoney(o.expense, dec, { masked, currency: mainCode })}</b>
      </div>
      <div className="ns-tk-st-num net">
        <span>淨額</span>
        <b>{formatDisplayMoney(o.net, dec, { prefix: o.net > 0 ? "＋" : undefined, masked, currency: mainCode })}</b>
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

function Trend({
  points,
  cur,
  span,
  thisMonth,
  dec,
  mainCode,
  masked,
}: {
  points: TrendPoint[];
  cur: string;
  span: "month" | "year";
  thisMonth: string;
  dec: number;
  mainCode: string;
  masked: boolean;
}) {
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
            let ye = base - he - 4;
            let yi = base - hi - 4;
            if (p.income && p.expense && Math.abs(ye - yi) < fs + 2) {
              if (yi <= ye) yi = ye - (fs + 2);
              else ye = yi - (fs + 2);
            }
            const title = `${Number(y)} 年 ${Number(m)} 月：支出 ${formatDisplayMoney(p.expense, dec, { masked, currency: mainCode })}、收入 ${formatDisplayMoney(
              p.income,
              dec,
              { masked, currency: mainCode },
            )}`;
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
                {!future && p.expense !== 0 && (!masked || isCur) && (
                  <text className="tr-v" x={xe + bw / 2} y={ye} textAnchor="middle">
                    {masked ? MASK_STARS : compactMoney(p.expense, dec)}
                  </text>
                )}
                {!future && !masked && p.income !== 0 && (
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

function drillOf(facet: Facet, key: string, parentKey: string | null): Partial<EntryFilter> | null {
  if (key === GONE_KEY) return null;
  if (facet === "category") {
    if (key === UNSPLIT_KEY) return parentKey ? { categoryIds: [parentKey] } : null;
    return { categoryIds: [key] };
  }
  if (facet === "tag") {
    if (key === NO_TAG_KEY) return null;
    if (key === UNSPLIT_KEY) return parentKey ? { tagKeys: [parentKey] } : null;
    return { tagKeys: [key] };
  }
  if (facet === "account") return { accountId: key };
  return { routeId: key === NO_ROUTE_KEY ? "none" : key };
}

const FACET_NOUN: Record<Facet, string> = { category: "分類", account: "帳戶", route: "路線", tag: "荷札" };

function RowName({ row, facet, routeById }: { row: BreakdownRow; facet: Facet; routeById: Record<string, NodeRow> }) {
  const faint = row.key === UNSPLIT_KEY || row.key === GONE_KEY || row.key === NO_TAG_KEY || isUncat(row.key);
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

function canEnter(r: BreakdownRow, parent: BreakdownRow | null): boolean {
  if (!parent || r.key === UNSPLIT_KEY || r.key === GONE_KEY || isUncat(r.key)) return false;
  return !!r.deeper;
}

function Crumbs({
  root,
  total,
  what,
  dec,
  mainCode,
  masked,
}: {
  root: string | null;
  total: number;
  what: string;
  dec: number;
  mainCode: string;
  masked: boolean;
}) {
  const catById = useTicketStore((s) => s.catById);
  const crumbs = statsCrumbs(root, catById);
  const store = useTicketStore.getState;
  const last = crumbs[crumbs.length - 1];
  const here = useRef<HTMLElement>(null);
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    const a = document.activeElement;
    if (!a || a === document.body) here.current?.focus({ preventScroll: true });
  }, [root]);
  return (
    <nav className="ns-tk-st-crumbs" aria-label="分類層級">
      {crumbs.length > 1 && (
        <button
          type="button"
          className="ns-iconbtn back"
          aria-label={`回上一層：${crumbs[crumbs.length - 2].label}`}
          title="回上一層"
          onClick={() => store().setStatsRoot(crumbs[crumbs.length - 2].id)}
        >
          <TkIcon name="left" size={13} />
        </button>
      )}
      {crumbs.map((c, i) =>
        i < crumbs.length - 1 ? (
          <span key={c.id ?? "all"} className="seg">
            <button type="button" className="lk" onClick={() => store().setStatsRoot(c.id)}>
              {c.label}
            </button>
            <span className="sl" aria-hidden>
              ›
            </span>
          </span>
        ) : (
          <b key={c.id ?? "all"} ref={here} tabIndex={-1} aria-current="location">
            {c.label}
          </b>
        ),
      )}
      <span className="note">
        比例＝占{last.id === null ? what : `「${last.label}」`} {formatDisplayMoney(total, dec, { masked, currency: mainCode })}
      </span>
    </nav>
  );
}

function RouteEntriesAccordion({
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
  const routes = useNodeStore((s) => s.routes);
  const store = useTicketStore.getState;

  const list = useMemo(() => {
    const r = periodRange(period, monthStartDay);
    return routeBreakdownEntries(statsEntries, r, routeKey, kind, routeCtx(routes));
  }, [statsEntries, period, monthStartDay, routeKey, kind, routes]);

  const withYear = period.span === "year" || new Set(list.map((e) => e.occurred_on.slice(0, 4))).size > 1;

  return (
    <li className="ns-tk-st-rtdetail">
      <ul className="ns-tk-st-rtlist" aria-label={`「${routeLabel}」的帳目明細`}>
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
                className="ns-tk-st-rtitem"
                title="在帳簿開啟這一筆"
                onClick={() => {
                  runAtomicNav(() => {
                    void store().jumpToEntry(e.id);
                  });
                }}
              >
                <span className="dt">{dateStr}</span>
                <span className="cat">{catText}</span>
                <span className={"nt" + (e.note ? "" : " is-empty")}>{e.note || "—"}</span>
                <span className="amt">
                  {amt.prefix}
                  <b>{masked ? maskedMoneyText(amt.currency) : moneyText(amt.minor, curDec)}</b>
                  {!masked && foreign && <small className="cur">{amt.currency}</small>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {target && list.length > 0 && (
        <div className="ns-tk-st-rtfoot">
          <button
            type="button"
            className="ns-btn btn-text ns-btn--sm"
            onClick={() => void store().drillToList({ ...target, kinds: [kind] })}
          >
            在帳簿篩選全部（{list.length} 筆）›
          </button>
        </div>
      )}
    </li>
  );
}

function Bars({
  stats,
  facet,
  kind,
  drill,
  statsSort,
  dec,
  mainCode,
  masked,
  root,
  what,
}: {
  stats: StatsData;
  facet: Facet;
  kind: "expense" | "income";
  drill: string | null;
  statsSort: BreakdownSort;
  dec: number;
  mainCode: string;
  masked: boolean;
  root: string | null;
  what: string;
}) {
  const routes = useNodeStore((s) => s.routes);
  const routeById = useMemo(() => {
    const m: Record<string, NodeRow> = {};
    for (const r of routes) if (r.deleted_at === null) m[r.id] = r;
    return m;
  }, [routes]);
  const bd = stats.breakdown;
  const store = useTicketStore.getState;
  const showCrumbs = facet === "category" && (root !== null || bd.rows.some((r) => canEnter(r, null) || !!r.children?.some((k) => canEnter(k, r))));
  const crumbs = showCrumbs ? <Crumbs root={root} total={bd.total} what={what} dec={dec} mainCode={mainCode} masked={masked} /> : null;
  if (!bd.rows.length && !bd.refunds.length)
    return (
      <>
        {crumbs}
        <p className="ns-tk-empty">{VIEW_TEXT.emptyStats}</p>
      </>
    );
  const maxShare = Math.max(0.0001, ...bd.rows.map((r) => r.share));
  const maxCount = Math.max(1, ...bd.rows.map((r) => r.count));

  const li = (r: BreakdownRow, parent: BreakdownRow | null) => {
    const isRouteAccordion = facet === "route" && !parent;
    const isParent = (!parent && !!r.children && r.children.length > 0) || isRouteAccordion;
    const open = isParent && drill === r.key;
    const target = drillOf(facet, r.key, parent ? parent.key : root);
    const kindLabel = kind === "expense" ? "支出" : "收入";
    const go = facet === "category" && canEnter(r, parent);
    const liveRoute = isRouteAccordion && r.key !== NO_ROUTE_KEY && r.key !== GONE_KEY ? routeById[r.key] : undefined;
    const barPct = statsSort === "count" ? (r.count / maxCount) * 100 : (r.share / maxShare) * 100;

    return (
      <li
        key={(parent ? parent.key + "/" : "") + r.key}
        className={
          "ns-tk-st-row" +
          (isParent ? " is-parent" : "") +
          (open ? " is-open" : "") +
          (parent ? " is-child" : "") +
          (go ? " has-go" : "") +
          (liveRoute ? " has-jump" : "")
        }
      >
        <button
          type="button"
          aria-expanded={isParent ? open : undefined}
          disabled={!isParent && target === null}
          title={
            isRouteAccordion
              ? `${open ? "收起" : "展開"}「${r.label}」的帳目明細`
              : isParent
                ? `${open ? "收起" : "展開"}子${FACET_NOUN[facet]}`
                : target
                  ? `到清單看這些帳（${kindLabel}）`
                  : r.key === NO_TAG_KEY
                    ? "沒掛荷札的帳沒辦法用荷札篩選"
                    : "這些帳的分類、帳戶或路線已刪除，無法篩選"
          }
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
            <i style={{ width: `${Math.min(100, barPct).toFixed(1)}%` }} />
          </span>
          <span className="cnt">{r.count} 筆</span>
          <span className="v">{formatDisplayMoney(r.minor, dec, { masked, currency: mainCode })}</span>
          <span className="p">{shareText(r.share)}</span>
        </button>
        {go && (
          <button
            type="button"
            className="ns-tk-st-go"
            aria-label={`進入「${r.label}」`}
            title={`看「${r.label}」底下的分類`}
            onClick={() => store().setStatsRoot(r.key)}
          >
            進入
            <TkIcon name="right" size={9} />
          </button>
        )}
        {liveRoute && (
          <button
            type="button"
            className="ns-tk-st-jump"
            aria-label={`前往路線圖查看「${r.label}」`}
            title={`前往路線圖「${r.label}」`}
            onClick={() => {
              runAtomicNav(async () => {
                await useNodeStore.getState().openRoute(r.key);
                const ui = useUiStore.getState();
                ui.setPage("routemap");
                ui.setZoom(null);
                ui.select(null);
              });
            }}
          >
            ↗
          </button>
        )}
      </li>
    );
  };

  const renderedRows: ReactNode[] = [];
  for (const r of bd.rows) {
    renderedRows.push(li(r, null));
    if (facet === "route" && drill === r.key) {
      renderedRows.push(
        <RouteEntriesAccordion
          key={`rt-det-${r.key}`}
          routeKey={r.key}
          routeLabel={r.label}
          kind={kind}
          target={drillOf("route", r.key, null)}
          mainCode={mainCode}
          masked={masked}
        />,
      );
    } else if (drill === r.key && r.children) {
      for (const k of r.children) renderedRows.push(li(k, r));
    }
  }

  return (
    <>
      {crumbs}
      <ul className={"ns-tk-st-rows is-" + kind}>{renderedRows}</ul>
      {bd.refunds.length > 0 && (
        <div className="ns-tk-st-refunds">
          <span className="hd">{VIEW_TEXT.refunds}</span>
          {bd.refunds.map((r) => (
            <span key={r.key} className="it">
              {r.label}（{r.count} 筆） <b>{formatDisplayMoney(r.minor, dec, { masked, currency: mainCode })}</b>
            </span>
          ))}
          <small>退款大於支出的{FACET_NOUN[facet]}不計入圖表與總額</small>
        </div>
      )}
    </>
  );
}

const SPAN_TABS: readonly TabItem<"month" | "year">[] = [
  { key: "month", label: "月" },
  { key: "year", label: "年" },
];

/* ───────── 視圖 ───────── */

export function TicketStats() {
  const stats = useTicketStore((s) => s.stats);
  const span = useTicketStore((s) => s.span);
  const month = useTicketStore((s) => s.month);
  const monthStartDay = useTicketStore((s) => s.monthStartDay);
  const facet = useTicketStore((s) => s.facet);
  const facetKind = useTicketStore((s) => s.facetKind);
  const statsSort = useTicketStore((s) => s.statsSort);
  const drill = useTicketStore((s) => s.drill);
  const statsRoot = useTicketStore((s) => s.statsRoot);
  const period = useTicketStore((s) => s.period);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const mainCur = useTicketStore((s) => mainCurrencyOf(s.curByCode));
  const masked = useTicketStore(isTicketAmountMasked);
  const dec = mainCur.decimals;
  const mainCode = mainCur.code;
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const thisMonth = monthOf(todayKey(dayStartHour), monthStartDay);
  const store = useTicketStore.getState;

  if (!stats) {
    return (
      <div className="ns-tk-stats is-loading" aria-busy="true">
        <p className="ns-tk-empty">正在算…</p>
      </div>
    );
  }
  const facets = FACETS.filter(([k]) => !(k === "account" && filterAccountId !== null));
  const cur = month;
  const periodWord =
    span === "year" ? (period.key === thisMonth.slice(0, 4) ? "今年" : `${period.key} 年`) : month === thisMonth ? "本月" : `${Number(month.slice(5, 7))}月`;

  return (
    <div className="ns-tk-stats">
      <div className="ns-tk-st-top">
        <Overview stats={stats} dec={dec} mainCode={mainCode} masked={masked} />
        <Tabs items={SPAN_TABS} value={span} onChange={(k) => void store().setSpan(k)} size="md" aria-label="統計期間" className="ns-tk-st-span" />
      </div>

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
        <Trend points={stats.trend} cur={cur} span={span} thisMonth={thisMonth} dec={dec} mainCode={mainCode} masked={masked} />
      </section>

      <section className="ns-tk-st-card" aria-label="占比">
        <div className="ns-tk-st-h">
          <h2>占比</h2>
          <small>
            {facet === "category"
              ? "點主分類可展開，點子分類可看明細"
              : facet === "route"
                ? "點路線列原地展開當期明細，點 ↗ 前往路線圖"
                : facet === "tag"
                  ? "點上層荷札可展開，點子荷札可看明細"
                  : "點任一列可看明細"}
          </small>
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
          <span className="ns-tk-seg ns-tk-st-sortseg" role="group" aria-label="統計排序">
            {SORTS.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={statsSort === k} onClick={() => store().setStatsSort(k)}>
                {l}
              </button>
            ))}
          </span>
        </div>
        {facet === "tag" && stats.breakdown.rows.length > 0 && <p className="ns-tk-st-tagnote">{VIEW_TEXT.tagNote(facetKind)}</p>}
        <Bars
          stats={stats}
          facet={facet}
          kind={facetKind}
          drill={drill}
          statsSort={statsSort}
          dec={dec}
          mainCode={mainCode}
          masked={masked}
          root={statsRoot}
          what={periodWord + (facetKind === "expense" ? "支出" : "收入")}
        />
      </section>
    </div>
  );
}
