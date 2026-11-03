/**
 * 書架（車庫與回顧 D-主-217；原型 `spine`／`shelf`）：到站的路線一本一本立著，依到站日排（新的在右）。
 *   - 書背一律等厚（厚度跟著済章數走就成了比大小）；寫代碼圓牌、直排名字、小済印＋済章數、到站日 M.D。
 *   - 同一條已到站幹線的路線用一對書擋夾成一組，上方一塊名牌（幹線名＋到站日）。
 *   - 點書背＝開乘車記錄簿。路線多了書架橫捲（掛上時捲到最右＝最新）。
 * 排序與分組是 `buildShelf`（domain/depot.ts）的事，這裡只畫。
 */
import { useLayoutEffect, useRef } from "react";
import { fmtMD, fmtZhMD, type ShelfItem } from "../../domain/depot";
import type { NodeRow } from "../../domain/node";
import { MiniSumi, RouteBadge, rcStyle } from "./depotParts";
import "./depot.css";

export interface ShelfProps {
  items: readonly ShelfItem[];
  /** 路線 id → 済章數 */
  routeSeals: Readonly<Record<string, number>>;
  /** 路線 id → 開業日 */
  openedOn: (route: NodeRow) => string;
  onOpen: (routeId: string) => void;
}

function Spine({ route, seals, opened, onOpen }: { route: NodeRow; seals: number; opened: string; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className="ns-depot-spine"
      style={rcStyle(route)}
      data-route-id={route.id}
      onClick={() => onOpen(route.id)}
      title={`${route.name}・${fmtZhMD(opened)} 開業 → ${fmtZhMD(route.arrived_on)} 到站`}
      aria-label={`${route.name}的記錄簿`}
    >
      <RouteBadge route={route} />
      <span className="ns-depot-sp-name">{route.name}</span>
      <span className="ns-depot-sp-n">
        <MiniSumi />
        {seals}
      </span>
      <span className="ns-depot-sp-d">{fmtMD(route.arrived_on)}</span>
    </button>
  );
}

export function Shelf({ items, routeSeals, openedOn, onOpen }: ShelfProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const count = items.length;
  // 掛上（與本數變了）時捲到最右＝最新的那本
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [count]);

  const spine = (r: NodeRow) => <Spine key={r.id} route={r} seals={routeSeals[r.id] ?? 0} opened={openedOn(r)} onOpen={onOpen} />;

  return (
    <div className="ns-depot-shelfwrap" ref={wrapRef}>
      <div className="ns-depot-shelfin">
        <div className="ns-depot-shelf">
          {items.map((it) =>
            it.type === "book" ? (
              spine(it.route)
            ) : (
              <div key={it.line.id} className="ns-depot-tgroup" role="group" aria-label={`幹線${it.line.name}`}>
                <p className="ns-depot-tplate" title={`幹線「${it.line.name}」・${fmtZhMD(it.line.arrived_on)} 到站`}>
                  <span>
                    <span className="k">幹線</span> {it.line.name}
                  </span>
                  <time dateTime={it.line.arrived_on ?? undefined}>{fmtMD(it.line.arrived_on)} 到站</time>
                </p>
                <div className="ns-depot-tbooks">
                  <span className="ns-depot-bookend" aria-hidden="true" />
                  {it.routes.map(spine)}
                  <span className="ns-depot-bookend is-r" aria-hidden="true" />
                </div>
              </div>
            ),
          )}
        </div>
        <div className="ns-depot-board" aria-hidden="true" />
      </div>
    </div>
  );
}
