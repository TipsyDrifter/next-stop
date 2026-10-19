/**
 * TrendChart——趨勢直條（③ 契約 §5.2-4；D-時-51、63；乙席）。手寫 SVG（0-11：不加圖表庫），寬度＝容器實際像素（ResizeObserver）。
 * 日 14／週 8／月 6 根；子分類色、依頂層一組一組堆、組間 1px 紙色縫；本期那根描金、進行中的上緣一條虛線。
 * 過濾（清單點名稱）：頂層＝只畫它那一組（子分類色）、子分類＝單色。
 * 明細：桌機滑過、手機點一根 ⇒ 上面那行換成「10/13–10/19　96h12m」＋各頂層（或過濾那組的子分類）數字；預設＝本期那根。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { fmtDur } from "../../../domain/timetable";
import { type StatsResult } from "../../../domain/timetableStats";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { catColor, trendLabel, trendTick, useCatById } from "./format";
import { MiniBar } from "./parts";
import { stackOf, stackOrder } from "./stack";

const HOUR = 3_600_000;

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

export function TrendChart({ r, desktop }: { r: StatsResult; desktop: boolean }) {
  const catById = useCatById();
  const filter = useTimetableStatsStore((s) => s.filterCategoryId);
  const setFilter = useTimetableStatsStore((s) => s.setFilter);
  const [boxRef, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const T = TT_TEXT.statsUi;
  const n = r.trend.length;

  // 換期／換過濾：明細回到本期那根
  useEffect(() => {
    setPicked(null);
    setHover(null);
  }, [r.period, r.key, filter]);

  const order = stackOrder(r.groups);
  const stacks = r.trend.map((b) => stackOf(b.byCategory, order, catById, filter));
  const totals = stacks.map((gs) => gs.reduce((s, g) => s + g.ms, 0));
  const sel = hover ?? (picked !== null && picked < n ? picked : n - 1);

  const H = desktop ? 172 : 156;
  const padL = 34;
  const padB = 22;
  const padT = 12;
  const maxV = Math.max(HOUR, ...totals);
  const stepH = [1, 2, 3, 5, 10, 20, 30, 50, 100, 200].find((s) => maxV / HOUR / s <= 3) ?? 300;
  const top = Math.ceil(maxV / HOUR / stepH) * stepH * HOUR;
  const ih = H - padB - padT;
  const iw = Math.max(0, W - padL - 4);
  const slot = n ? iw / n : 0;
  const bw = Math.min(26, slot * 0.62);
  const y = (v: number): number => padT + ih - (v / top) * ih;
  const every = !desktop && r.period === "day" ? 2 : 1;

  const grid: ReactNode[] = [];
  for (let v = 0; v <= top + 1; v += stepH * HOUR) {
    grid.push(
      <g key={v}>
        <line className={"tr-grid" + (v === 0 ? " is-base" : "")} x1={padL} x2={W - 2} y1={y(v)} y2={y(v)} />
        <text className="tr-y" x={padL - 6} y={y(v) + 3.5} textAnchor="end">
          {v ? `${v / HOUR}h` : "0"}
        </text>
      </g>,
    );
  }

  const bars = r.trend.map((b, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - bw / 2;
    const gs = stacks[i];
    const segs: ReactNode[] = [];
    let acc = 0;
    gs.forEach((g, gi) => {
      g.segs.forEach((s, si) => {
        const y1 = y(acc + s.ms);
        const y0 = y(acc);
        // 組與組之間留 1px 紙色縫（下一組的底往上收 1px）；太矮的段不收，免得整段不見
        const gap = gi > 0 && si === 0 && y0 - y1 > 2 ? 1 : 0;
        segs.push(
          <rect
            key={s.id}
            className="tr-seg"
            x={x}
            y={y1}
            width={bw}
            height={Math.max(0.6, y0 - y1 - gap)}
            style={{ fill: s.color }}
            pointerEvents="none"
          />,
        );
        acc += s.ms;
      });
    });
    const yt = y(acc);
    return (
      <g key={b.key}>
        <rect
          className={"tr-hit" + (i === sel ? " is-sel" : "")}
          x={padL + slot * i + 1}
          y={padT - 8}
          width={Math.max(0, slot - 2)}
          height={ih + 8}
          rx={2}
          onMouseEnter={desktop ? () => setHover(i) : undefined}
          onClick={() => setPicked(i)}
        />
        {segs}
        {b.isCurrent && acc > 0 && (
          <rect className="tr-cur" x={x - 2} y={yt - 2} width={bw + 4} height={y(0) - yt + 2} rx={1.5} pointerEvents="none" />
        )}
        {b.inProgress && acc > 0 && <line className="tr-live" x1={x - 4} x2={x + bw + 4} y1={yt - 5} y2={yt - 5} pointerEvents="none" />}
        {(n - 1 - i) % every === 0 && (
          <text className={"tr-x" + (b.isCurrent ? " is-cur" : "")} x={cx} y={H - 6} textAnchor="middle">
            {trendTick(r.period, b.key)}
          </text>
        )}
      </g>
    );
  });

  // 明細列
  const sb = r.trend[sel];
  const sgs = stacks[sel] ?? [];
  const filterIsTop = filter !== null && (catById[filter]?.parent_id ?? null) === null;
  const detailParts =
    filter === null
      ? sgs.map((g) => ({ id: g.id, name: catById[g.id]?.name ?? T.catGone, ms: g.ms, segs: g.segs, dot: null as string | null }))
      : filterIsTop
        ? (sgs[0]?.segs ?? []).map((s) => ({ id: s.id, name: catById[s.id]?.name ?? T.catGone, ms: s.ms, segs: null, dot: s.color }))
        : [];
  const nameOf = (id: string): string => catById[id]?.name ?? T.catGone;

  return (
    <section className="ns-tt-stats-card ns-tt-stats-trend">
      <div className="ns-tt-stats-ch">
        <h3>{T.trendTitle}</h3>
        <span className="ns-tt-stats-ch-note">{T.trendNote(r.period)}</span>
        {filter !== null && (
          <button type="button" className="ns-tt-stats-fchip" title={T.filterClear} onClick={() => setFilter(null)}>
            {filterIsTop ? (
              <MiniBar segs={(stackOf(r.cur.byCategory, order, catById, filter)[0]?.segs ?? [])} />
            ) : (
              <i className="ns-tt-stats-dot" style={{ "--c": catColor(catById[filter]) } as CSSProperties} aria-hidden="true" />
            )}
            {T.filterChip(nameOf(filter))}
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>
      {sb && (
        <div className="ns-tt-stats-tdet" aria-live="polite">
          <span className="ns-tt-stats-tlbl ns-tt-num">
            {trendLabel(r.period, sb.key)}
            {sb.inProgress && <em>{T.toNow}</em>}
          </span>
          <b className="ns-tt-num ns-tt-stats-tsum">{fmtDur(totals[sel] ?? 0)}</b>
          {detailParts.map((p) => (
            <span key={p.id} className="ns-tt-stats-tpart">
              {p.segs ? (
                <MiniBar segs={p.segs} className="is-xs" />
              ) : (
                <i className="ns-tt-stats-dot" style={{ "--c": p.dot ?? "" } as CSSProperties} aria-hidden="true" />
              )}
              {p.name} <b className="ns-tt-num">{fmtDur(p.ms)}</b>
            </span>
          ))}
        </div>
      )}
      <div className="ns-tt-stats-tbox" ref={boxRef} onMouseLeave={desktop ? () => setHover(null) : undefined}>
        {W > 0 && (
          <svg className="ns-tt-stats-tsvg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={T.trendTitle}>
            {grid}
            {bars}
          </svg>
        )}
      </div>
    </section>
  );
}
