/**
 * MobileTicketStats——售票口手機的統計視圖（②契約 §5.3【統計】、0-1／D-票-27、0-6～0-9、0-22；丙席擁有）。
 *
 * 單欄由上而下：
 *   三數卡（收入／支出／淨額橫排三格＋「N 筆收支」；compactMoney）
 *   →「月｜年」小切換
 *   →（第③階段，月模式）預算卡 MobileBudgetCard
 *   → 趨勢 12 根（卡頭「月對月」＋圖例）（inline SVG、寬度＝容器實際像素；支出墨、收入金、選中月 accent；條頂 compact 小字——
 *      12 個月 × 兩個數放不下，收入數字只印選中月，同原型）；點一根 ⇒ 切到那個月（年模式先切回月）
 *   → 切面「分類｜帳戶｜路線」（側欄已篩帳戶時「帳戶」不出，0-8）＋「支出｜收入」
 *   → 占比列（名稱｜金額｜%，條在下一行全寬；觸控高 ≥ 44）：主分類點＝展開／收起子分類（store.drill，一次一個）；
 *      其他列點＝drillToList（切清單＋帶篩選）
 *   → 淨退回區
 * 每個數字的出處：overview＝statsOverview、trend＝monthlyTrend、列＝breakdown（store.stats，純函式算好）。
 */
import { useEffect, useRef, useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { roundelStyle } from "../../common/roundel";
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
} from "../../../domain/ticketView";
import { IconRight } from "./mobileBits";
import { useViewSwipe } from "./MobileViewBar";
import { MobileBudgetCard } from "./plan/MobileBudgetCard";

export function MobileTicketStats() {
  const stats = useTicketStore((s) => s.stats);
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
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
          <Overview stats={stats} dec={dec} />
          <div className="ns-tk-mst-span">
            <span className="ns-tk-mseg" role="group" aria-label="統計期間">
              {(["month", "year"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={span === k} onClick={() => void setSpan(k)}>
                  {k === "month" ? "月" : "年"}
                </button>
              ))}
            </span>
          </div>
          {/* 第③階段（③契約 §5.5；原型題一）：預算卡放在「月｜年」下面——放最上面的話切「年」卡片消失、這列會跳位 */}
          {span === "month" && <MobileBudgetCard />}
          <section className="ns-tk-mst-card">
            {/* 圖例搬進趨勢卡自己的標題列：留在「月｜年」那一列會像在標預算卡 */}
            <div className="ns-tk-mst-cardh">
              <b>各月比較</b>
              <span className="ns-tk-mst-legend" aria-hidden>
                <i className="sw exp" />
                支出
                <i className="sw inc" />
                收入
              </span>
            </div>
            <Trend stats={stats} dec={dec} />
          </section>
          <Facets />
          <section className="ns-tk-mst-card">
            <Breakdown stats={stats} dec={dec} />
          </section>
        </>
      )}
    </div>
  );
}

/* ───────── 三數卡 ───────── */

function Overview({ stats, dec }: { stats: StatsData; dec: number }) {
  const o = stats.overview;
  const netAbs = compactMoney(Math.abs(o.net), dec);
  return (
    <div className="ns-tk-mst-over">
      <div className="num inc">
        <span>收入</span>
        <b>＋{compactMoney(o.income, dec)}</b>
      </div>
      <div className="num">
        <span>支出</span>
        <b>{compactMoney(o.expense, dec)}</b>
      </div>
      <div className="num net">
        <span>淨額</span>
        {/* 0-1：淨額為負顯示 − 前綴、不變色 */}
        <b>{o.net < 0 ? "−" + netAbs : o.net > 0 ? "＋" + netAbs : netAbs}</b>
      </div>
      <small className="cnt">{o.count} 筆收支</small>
    </div>
  );
}

/* ───────── 趨勢 12 根 ───────── */

/** 圖高；底下兩行字：月份（H−17）與跨年那根的年份小字（H−4）——375 寬每根只有 ~26px，「'25 11」擠一行會跟隔壁疊字 */
const TREND_H = 160;

function Trend({ stats, dec }: { stats: StatsData; dec: number }) {
  const month = useTicketStore((s) => s.month);
  const span = useTicketStore((s) => s.span);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const thisMonth = monthOf(todayKey(dayStartHour));
  const box = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(320);

  // SVG 寬度＝容器實際像素（不縮放，字級才是真的 8.5px）
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
          const showI = isCur && p.income !== 0;
          if (showI && Math.abs(ye - yi) < fs + 2) {
            if (yi <= ye) yi = ye - (fs + 2);
            else ye = yi - (fs + 2);
          }
          const aria = `${y} 年 ${m} 月：支出 ${moneyText(p.expense, dec, { whole: true })}、收入 ${moneyText(p.income, dec, { whole: true })}`;
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
              {!future && p.expense !== 0 && (
                <text className="v" x={xe + bw / 2} y={ye} textAnchor="middle">
                  {compactMoney(p.expense, dec)}
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

/* ───────── 切面 ───────── */

const FACETS: readonly { key: Facet; label: string }[] = [
  { key: "category", label: "分類" },
  { key: "account", label: "帳戶" },
  { key: "route", label: "路線" },
];

function Facets() {
  const facet = useTicketStore((s) => s.facet);
  const facetKind = useTicketStore((s) => s.facetKind);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const setFacet = useTicketStore((s) => s.setFacet);
  const setFacetKind = useTicketStore((s) => s.setFacetKind);
  return (
    <div className="ns-tk-mst-facets">
      <span className="ns-tk-mseg" role="group" aria-label="切面">
        {FACETS.filter((f) => !(f.key === "account" && filterAccountId !== null)).map((f) => (
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
    </div>
  );
}

/* ───────── 占比列 ───────── */

function Breakdown({ stats, dec }: { stats: StatsData; dec: number }) {
  const facet = useTicketStore((s) => s.facet);
  const facetKind = useTicketStore((s) => s.facetKind);
  const drill = useTicketStore((s) => s.drill);
  const setDrill = useTicketStore((s) => s.setDrill);
  const drillToList = useTicketStore((s) => s.drillToList);
  const routes = useNodeStore((s) => s.routes);
  const bd = stats.breakdown;

  if (!bd.rows.length && !bd.refunds.length) return <p className="ns-tk-mst-empty">{VIEW_TEXT.emptyStats}</p>;

  const max = Math.max(0.0001, ...bd.rows.map((r) => r.share));

  /** 下鑽到底的篩選（0-15）；null＝這一列沒得篩（分類／帳戶／路線已不在） */
  const drillOf = (r: BreakdownRow, parentKey: string | null): Partial<EntryFilter> | null => {
    if (r.key === GONE_KEY) return null;
    const kinds = [facetKind] as const;
    if (facet === "category") {
      // 「未細分」＝直接記在主分類本身；EntryFilter 沒有「只要主分類本身」這一格，帶主分類（含子分類）——近似，記在回報
      const id = r.key === UNSPLIT_KEY ? parentKey : r.key;
      return id ? { categoryIds: [id], kinds } : null;
    }
    if (facet === "account") return { accountId: r.key, kinds };
    return { routeId: r.key === NO_ROUTE_KEY ? "none" : r.key, kinds };
  };

  const name = (r: BreakdownRow, child: boolean) => {
    const faint = r.key === UNSPLIT_KEY || r.key === GONE_KEY || r.key === NO_ROUTE_KEY || r.key === UNCAT_EXPENSE_ID || r.key === UNCAT_INCOME_ID;
    if (facet === "route" && !child) {
      const rt = routes.find((x) => x.id === r.key);
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
    const isParent = !child && !!r.children && r.children.length > 0;
    const open = isParent && drill === r.key;
    const target = isParent ? null : drillOf(r, parentKey);
    const w = (r.share / max) * 100;
    return (
      <li key={(child ? parentKey + "/" : "") + r.key} className={"row" + (isParent ? " is-parent" : "") + (open ? " is-open" : "") + (child ? " is-child" : "")}>
        <button
          type="button"
          aria-expanded={isParent ? open : undefined}
          disabled={!isParent && target === null}
          title={isParent ? (open ? "收起子分類" : "展開子分類") : target ? "到清單看這些帳" : undefined}
          onClick={() => {
            if (isParent) setDrill(open ? null : r.key);
            else if (target) void drillToList(target);
          }}
        >
          <span className="c" aria-hidden>
            {isParent && <IconRight size={10} />}
          </span>
          <span className="n">{name(r, child)}</span>
          <span className="v">{compactMoney(r.minor, dec)}</span>
          <span className="p">{shareText(r.share)}</span>
          <span className="bar" aria-hidden>
            <i style={{ width: `${w.toFixed(1)}%` }} />
          </span>
        </button>
      </li>
    );
  };

  const items: ReturnType<typeof row>[] = [];
  for (const r of bd.rows) {
    items.push(row(r, false, null));
    if (r.children && r.children.length && drill === r.key) for (const k of r.children) items.push(row(k, true, r.key));
  }

  return (
    <>
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
              {r.label} <b>{moneyText(r.minor, dec, { whole: true })}</b>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
