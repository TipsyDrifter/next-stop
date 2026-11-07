/**
 * 走行圖（第五本第三梯 ③-2；D-主-551～558；視覺真相 `prototypes/車庫走行圖.html` 路網圖）：
 * 所有路線畫成一張私鐵網圖，到站實線＋終點雙圈、運行中虛線，車站是白點、只畫已到着的。點路線開記錄簿。
 * 版面全在 `domain/depotMap.ts`；這裡量容器寬度、把結果畫成 SVG。兩殼同一支：夠寬就橫排，窄的直立。
 * 點幹線名牌收合（D-主-559），圖例列有「全部收合／全部展開」；收了什麼記在這台。
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { buildRouteMap, layoutRouteMap, trunkKey, type LaidRoute, type LaidTrunk, type Pt } from "../../domain/depotMap";
import { fmtZhMD } from "../../domain/depot";
import { todayKey } from "../../lib/date";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { EmptyState } from "../common/EmptyState";
import { routeColor, useDayStartHour } from "./depotParts";
import "./routeNetwork.css";

/**
 * 上次量到的寬度：從記錄簿回來時本元件重新掛上，第一次畫就要有線——
 * DepotView 回車庫要把焦點放回剛才那條路線（[data-route-id]），找不到就落到頁根。
 */
let lastBox: { width: number; nameFs: number } | null = null;

function Term({ at, r = 7.5 }: { at: Pt; r?: number }) {
  return (
    <>
      <circle className="ns-rn-term" cx={at.x} cy={at.y} r={r} />
      <circle className="ns-rn-termc" cx={at.x} cy={at.y} r={+(r * 0.42).toFixed(1)} />
    </>
  );
}

const pressToClick = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/** 幹線名牌：有路線才是按鈕，點了收合／展開；沒路線的只是名牌 */
function TrunkPlate({ t, hitH, onToggle }: { t: LaidTrunk; hitH: number; onToggle: (key: string) => void }) {
  const key = trunkKey(t.trunk);
  const face = (
    <>
      <rect className="ns-rn-plate" x={t.plate.x} y={t.plate.y} width={t.plate.w} height={24} rx={2} />
      <text className="ns-rn-pt" x={t.labelX} y={t.plate.y + 16.5} textAnchor="middle">
        <title>{t.trunk.name}</title>
        {t.label}
      </text>
    </>
  );
  if (!t.foldable || !t.caret) return face;
  const { x, y } = t.caret;
  const verb = t.folded ? "展開" : "收合";
  return (
    <g
      className="ns-rn-fold"
      role="button"
      tabIndex={0}
      data-trunk-fold={key}
      aria-expanded={!t.folded}
      aria-label={`${verb}幹線${t.trunk.name}`}
      onClick={() => onToggle(key)}
      onKeyDown={pressToClick(() => onToggle(key))}
    >
      <title>{`${verb}「${t.trunk.name}」`}</title>
      <rect className="ns-rn-foldhit" x={t.plate.x - 4} y={t.plate.y + 12 - hitH / 2} width={t.plate.w + (t.count ? 90 : 8)} height={hitH} />
      {face}
      <path className="ns-rn-caret" d={t.folded ? `M${x - 2} ${y - 4}L${x + 2.5} ${y}L${x - 2} ${y + 4}` : `M${x - 4} ${y - 2}L${x} ${y + 2.5}L${x + 4} ${y - 2}`} />
      {t.count && (
        <text className="ns-rn-count" x={t.count.at.x} y={t.count.at.y}>
          {t.count.text}
        </text>
      )}
    </g>
  );
}

function RouteLine({ lr, onOpen, showNames }: { lr: LaidRoute; onOpen: (id: string) => void; showNames: boolean }) {
  const { route: r, running, badge, end, term } = lr;
  const color = routeColor(r);
  const line = `M${badge.x} ${badge.y}H${end.x}`;
  const hidden = lr.hiddenStations ? `・另有 ${lr.hiddenStations} 站` : "";
  const onKey = pressToClick(() => onOpen(r.id));
  return (
    <g
      className="ns-rn-r"
      role="button"
      tabIndex={0}
      data-route-id={r.id}
      aria-label={`${r.name}的記錄簿`}
      onClick={() => onOpen(r.id)}
      onKeyDown={onKey}
    >
      <title>{`${r.name}・${running ? "運行中" : `${fmtZhMD(r.arrived_on)} 到站`}${hidden}`}</title>
      <path className="ns-rn-hit" d={lr.fork + line} />
      <path className="ns-rn-fork" style={{ stroke: color }} d={lr.fork} />
      <circle className="ns-rn-jr" style={{ stroke: color }} cx={lr.junction.x} cy={lr.junction.y} r={3.4} />
      <path className={"ns-rn-ln" + (running ? " run" : "")} style={{ stroke: color }} d={line} />
      {lr.stations.map((s) => (
        <g key={s.id}>
          <circle className="ns-rn-stn" cx={s.x} cy={s.y} r={showNames ? 5 : 4.2}>
            <title>{`${s.name}・${fmtZhMD(s.day)} 到着`}</title>
          </circle>
          {s.label && (
            <text className="ns-rn-sl" x={s.x} y={s.y + 17} textAnchor="middle">
              {s.label}
            </text>
          )}
        </g>
      ))}
      {term && (
        <>
          <Term at={term.at} />
          <text className="ns-rn-date" x={term.dateAt.x} y={term.dateAt.y}>
            {term.date}
          </text>
          {showNames && term.name && (
            <text className="ns-rn-sl" x={term.at.x} y={term.at.y + 19} textAnchor="middle">
              {term.name}
            </text>
          )}
        </>
      )}
      <circle className="ns-rn-bd" style={{ stroke: color }} cx={badge.x} cy={badge.y} r={11} />
      {r.code ? (
        <text
          className={"ns-rn-bdt" + (r.code.length > 2 ? " long" : "")}
          style={{ fill: color }}
          x={badge.x}
          y={badge.y + 3.6}
          textAnchor="middle"
        >
          {r.code.length > 3 ? r.code.slice(0, 3) : r.code}
        </text>
      ) : (
        <circle style={{ fill: color }} cx={badge.x} cy={badge.y} r={3.5} />
      )}
      <text className="ns-rn-name" x={lr.labelAt.x} y={lr.labelAt.y}>
        {lr.label}
      </text>
    </g>
  );
}

export function RouteNetwork({ onOpen }: { onOpen: (routeId: string) => void }) {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const stations = useNodeStore((s) => s.stations);
  const h = useDayStartHour();
  const mapFolded = useDepotStore((s) => s.mapFolded);
  const setMapFolded = useDepotStore((s) => s.setMapFolded);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(lastBox);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const nameFs = parseFloat(getComputedStyle(el).getPropertyValue("--fs-ui")) || 12.5;
      const width = Math.floor(el.clientWidth);
      if (width <= 0) return;
      setBox((b) => {
        lastBox = b && b.width === width && b.nameFs === nameFs ? b : { width, nameFs };
        return lastBox;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [lines.length, routes.length]);

  const today = todayKey(h);
  const trunks = useMemo(() => buildRouteMap(lines, routes, stations), [lines, routes, stations]);
  const folds = useMemo(() => new Set(mapFolded), [mapFolded]);
  const layout = useMemo(() => {
    if (!box) return null;
    return layoutRouteMap(trunks, box.width, today, box.nameFs, folds);
  }, [trunks, box, today, folds]);

  const foldKeys = useMemo(() => trunks.filter((t) => t.routes.length).map(trunkKey), [trunks]);
  const allFolded = foldKeys.length > 0 && foldKeys.every((k) => folds.has(k));

  const plateOf = (key: string) => wrapRef.current?.querySelector<SVGElement>(`[data-trunk-fold="${CSS.escape(key)}"]`);
  const toggle = (key: string) => {
    // 寬版的名牌在幹線中段，收起來會往上跑：記下位置，畫完捲回去，名牌留在手指底下
    const top = plateOf(key)?.getBoundingClientRect().top;
    anchor.current = top === undefined ? null : { key, top };
    // 只留還在的幹線：刪掉的幹線不必一直記著
    const next = folds.has(key) ? mapFolded.filter((k) => k !== key) : [...mapFolded.filter((k) => foldKeys.includes(k)), key];
    setMapFolded(next);
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a) return;
    const el = plateOf(a.key);
    if (!el) return;
    const scroller = el.closest(".page, .m-page");
    if (scroller) scroller.scrollTop += el.getBoundingClientRect().top - a.top;
  }, [mapFolded]);

  if (!lines.length && !routes.length) {
    return <EmptyState tone="first" title="走行圖還是空的" desc="開第一條路線，這張圖就從這裡長出來。" />;
  }

  const net = layout?.mode === "net";
  return (
    <div className="ns-depot-paper ns-rn">
      <div className="ns-rn-h">
        <span className="lg">
          <i />
          到站
        </span>
        <span className="lg">
          <i className="dash" />
          運行中
        </span>
        <span className="lg">
          <i className="dot" />
          車站
        </span>
        <span className="hint">點路線看記錄簿</span>
        {foldKeys.length > 1 && (
          <button type="button" className="ns-btn btn-text ns-rn-foldall" onClick={() => setMapFolded(allFolded ? [] : foldKeys)}>
            {allFolded ? "全部展開" : "全部收合"}
          </button>
        )}
      </div>
      <div ref={wrapRef} className="ns-rn-wrap">
        {layout && (
          <svg className="ns-rn-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="路線走行圖">
            <path className="ns-rn-spine" d={layout.spine} />
            <Term at={layout.hub} r={8} />
            <text className="ns-rn-hub" x={layout.hub.x + 16} y={layout.hub.y + 5}>
              私鐵手帳
            </text>
            {layout.trunks.map((t) => (
              <g key={t.trunk.id ?? "none"} role="group" aria-label={`幹線${t.trunk.name}`}>
                {t.feeder && <path className="ns-rn-spine" d={t.feeder} />}
                <path className="ns-rn-trunk" d={t.solid} />
                <path className="ns-rn-trunk-in" d={t.solid} />
                {t.tail && <path className="ns-rn-trunk run" d={t.tail} />}
                {t.term && (
                  <>
                    <Term at={t.term.at} r={net ? 8 : 7.5} />
                    <text className="ns-rn-date" x={t.term.dateAt.x} y={t.term.dateAt.y}>
                      {t.term.date}
                    </text>
                  </>
                )}
                {t.routes.map((lr) => (
                  <RouteLine key={lr.route.id} lr={lr} onOpen={onOpen} showNames={net} />
                ))}
                <TrunkPlate t={t} hitH={net ? 34 : 44} onToggle={toggle} />
                <circle className="ns-rn-j" cx={t.junction.x} cy={t.junction.y} r={4} />
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
