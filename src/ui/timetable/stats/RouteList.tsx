/**
 * RouteList——依路線（③ 契約 §5.2-6；D-時-52；乙席）。
 * 每列＝路線圓牌、名稱、時數、百分比（分母＝已記錄）、環比；依時數排，最後「沒有路線的任務」「（已刪除的任務）」「沒連任務」（順序 domain 排好）。
 * 點一列＝打開那條路線：桌機走核心 `jumpToNode`（路線圖頁、開那條路線）；手機走核心 `revealOnRouteMap`（磨光① A7：路線圖 tab、直接進那條路線的第二層）。
 * 統計頁不往下鑽到列車。
 */
import { fmtDur } from "../../../domain/timetable";
import { ROUTE_GONE, ROUTE_NONE, ROUTE_NOROUTE, fmtPct, type StatsResult } from "../../../domain/timetableStats";
import { nodeRepo } from "../../../data";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useNodeStore } from "../../../store/nodeStore";
import { jumpToNode } from "../../common/QuickJump";
import { roundelStyle } from "../../common/roundel";
import { revealOnRouteMap } from "../../mobile/routeMapReveal";
import { Delta } from "./parts";

async function openRoute(id: string, desktop: boolean): Promise<void> {
  if (desktop) {
    const node = await nodeRepo.getNode(id).catch(() => null);
    if (node && node.deleted_at === null) await jumpToNode(node);
    return;
  }
  // 路線的載入交給手機路線圖（進路線時自己 openRoute）
  revealOnRouteMap(id, null);
}

export function RouteList({ r, desktop }: { r: StatsResult; desktop: boolean }) {
  const routeNames = useTimetableStatsStore((s) => s.routeNames);
  const routes = useNodeStore((s) => s.routes);
  const T = TT_TEXT.statsUi;
  const rec = r.cur.recordedMs;
  if (!r.routes.length) return null;

  return (
    <section className="ns-tt-stats-card ns-tt-stats-routes">
      <div className="ns-tt-stats-ch">
        <h3>{T.routesTitle}</h3>
        <span className="ns-tt-stats-ch-note">{T.routesNote}</span>
      </div>
      <div className="ns-tt-stats-list" role="list">
        {r.routes.map((row) => {
          const special = row.key === ROUTE_NONE || row.key === ROUTE_GONE || row.key === ROUTE_NOROUTE;
          const info = routeNames[row.key];
          const node = special ? null : routes.find((x) => x.id === row.key) ?? null;
          const deleted = !special && (info?.deleted ?? !node);
          const name = row.key === ROUTE_NONE ? TT_TEXT.routeNone : row.key === ROUTE_NOROUTE ? TT_TEXT.routeNoRoute : row.key === ROUTE_GONE ? TT_TEXT.routeGone : deleted ? T.routeDeleted(info?.name ?? "？") : (info?.name ?? node?.name ?? "？");
          const lead = special ? (
            <span className="ns-tt-stats-rlead-x" aria-hidden="true">
              {row.key === ROUTE_GONE ? "✕" : "—"}
            </span>
          ) : node?.code ? (
            <span className="roundel" style={roundelStyle(node.color)} aria-hidden="true">
              {node.code}
            </span>
          ) : (
            <span className="roundel" aria-hidden="true">
              <i className="dot" style={{ background: roundelStyle(node?.color).background }} />
            </span>
          );
          const cells = (
            <>
              <span className="ns-tt-stats-rlead">{lead}</span>
              <span className="ns-tt-stats-rname is-static">
                <span>{name}</span>
              </span>
              <span className="ns-tt-stats-rv ns-tt-num">{fmtDur(row.ms)}</span>
              <span className="ns-tt-stats-rp ns-tt-num">{fmtPct(row.ms, rec)}</span>
              <span className="ns-tt-stats-rd ns-tt-num">
                <Delta ms={row.ms - row.prevMs} prevMs={row.prevMs} showTitle={desktop} inert />
              </span>
            </>
          );
          return special || deleted ? (
            <div key={row.key} role="listitem" className="ns-tt-stats-row is-route">
              {cells}
            </div>
          ) : (
            <div key={row.key} role="listitem">
              <button type="button" className="ns-tt-stats-row is-route is-link" onClick={() => void openRoute(row.key, desktop)}>
                {cells}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
