/**
 * RouteList——依路線原地樹狀手風琴展開（v1.33 操作 2：路線 › 支線 › 列車 › 車廂 › 車票）。
 * - 每層皆顯示「本層加總（含子孫）的累積時數與執行次數」（例如 `4h 10m · 9 次`），路線直屬臨時班次與容器直屬紀錄清楚歸列，層層加總嚴格吻合不重不漏。
 * - 每個真實路線／節點列右側附輕巧 `↗` 圖示按鈕，經 `navHistoryStore.runAtomicNav(...)` 原子跳轉定位至路線圖對應路線／節點。
 * - 支援接收來自路線側板／手機路線詳情 `↗` 的 `focusStatsRoute` 請求，自動展開該路線並捲動高亮。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { KIND_LABEL } from "../../../domain";
import { fmtDur } from "../../../domain/timetable";
import {
  ROUTE_GONE,
  ROUTE_NONE,
  ROUTE_NOROUTE,
  fmtPct,
  sortRouteShares,
  sortRouteTreeNodes,
  type RouteTreeNode,
  type RouteTreeNodeKind,
  type StatsResult,
} from "../../../domain/timetableStats";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useNodeStore } from "../../../store/nodeStore";
import { roundelStyle } from "../../common/roundel";
import { KIND_GLYPH } from "../../outline/OutlineRow";
import { Delta } from "./parts";
import {
  STATS_ROUTE_FOCUS_EVENT,
  clearFocusedStatsRoute,
  jumpFromStatsToRouteNode,
  peekFocusedStatsRoute,
} from "./statsJumps";

function TreeKindBadge({ node }: { node: RouteTreeNode }) {
  if (node.kind === "direct") {
    return (
      <span role="img" aria-label="直屬紀錄" className="ns-kind-badge is-dashed">
        直
      </span>
    );
  }
  if (node.kind === "gone") {
    return (
      <span role="img" aria-label="已刪除項目" className="ns-kind-badge is-dashed is-done">
        ✕
      </span>
    );
  }
  const kindKey = node.kind as Exclude<RouteTreeNodeKind, "direct" | "gone">;
  const label = node.isTempTicket ? "臨時車票" : KIND_LABEL[kindKey];
  const glyph = node.isTempTicket ? "臨" : KIND_GLYPH[kindKey];
  return (
    <span
      role="img"
      aria-label={label}
      className={`ns-kind-badge${node.isTempTicket ? " is-dashed" : ""}${node.done ? " is-done" : ""}`}
    >
      {glyph}
    </span>
  );
}

function RouteTreeRows({
  nodes,
  depth,
  rec,
  desktop,
  openNodes,
  onToggleNode,
}: {
  nodes: readonly RouteTreeNode[];
  depth: number;
  rec: number;
  desktop: boolean;
  openNodes: Record<string, boolean>;
  onToggleNode: (id: string) => void;
}) {
  const T = TT_TEXT.statsUi;
  const shell = desktop ? "desktop" : "mobile";

  return (
    <>
      {nodes.map((tn) => {
        const hasKids = tn.children.length > 0;
        const isOpen = !!openNodes[tn.id];
        const canJump = tn.kind !== "gone";
        return (
          <div key={tn.id} role="listitem" className="ns-tt-stats-rtree-item">
            <div
              className={
                "ns-tt-stats-row is-kid ns-tt-stats-rtrow" +
                (isOpen ? " is-open" : "") +
                (tn.kind === "direct" || tn.kind === "gone" ? " is-aux" : "")
              }
              style={{ "--d": depth } as CSSProperties}
            >
              {hasKids ? (
                <button
                  type="button"
                  className="ns-tt-stats-exp"
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "收起" : "展開"}「${tn.name}」`}
                  onClick={() => onToggleNode(tn.id)}
                >
                  <i>›</i>
                </button>
              ) : (
                <span className="ns-tt-stats-exp is-blank" />
              )}
              {hasKids ? (
                <button
                  type="button"
                  className="ns-tt-stats-rname ns-tt-stats-rtname"
                  aria-expanded={isOpen}
                  onClick={() => onToggleNode(tn.id)}
                >
                  <TreeKindBadge node={tn} />
                  <span>{tn.name}</span>
                </button>
              ) : (
                <span className="ns-tt-stats-rname is-static ns-tt-stats-rtname">
                  <TreeKindBadge node={tn} />
                  <span>{tn.name}</span>
                </span>
              )}
              <span className="ns-tt-stats-rv ns-tt-num">
                {fmtDur(tn.ms)}
                <em className="ns-tt-stats-rc">· {T.countTimes(tn.count)}</em>
              </span>
              <span className="ns-tt-stats-rp ns-tt-num">{fmtPct(tn.ms, rec)}</span>
              <span className="ns-tt-stats-rd ns-tt-num">
                <Delta ms={tn.ms - tn.prevMs} prevMs={tn.prevMs} showTitle={desktop} />
              </span>
              {canJump ? (
                <button
                  type="button"
                  className="ns-iconbtn ns-tt-stats-rjump"
                  aria-label={tn.nodeId ? `前往路線圖定位「${tn.name}」` : "打開所屬路線"}
                  title={tn.nodeId ? "前往路線圖定位" : "前往路線圖"}
                  onClick={() => void jumpFromStatsToRouteNode(tn.routeId, tn.nodeId, shell)}
                >
                  <span aria-hidden="true">↗</span>
                </button>
              ) : (
                <span className="ns-tt-stats-rjump-sp" aria-hidden="true" />
              )}
            </div>
            {hasKids && isOpen && (
              <div className="ns-tt-stats-kids is-new">
                <RouteTreeRows
                  nodes={tn.children}
                  depth={depth + 1}
                  rec={rec}
                  desktop={desktop}
                  openNodes={openNodes}
                  onToggleNode={onToggleNode}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function RouteList({ r, desktop }: { r: StatsResult; desktop: boolean }) {
  const routeNames = useTimetableStatsStore((s) => s.routeNames);
  const sortBy = useTimetableStatsStore((s) => s.sortBy);
  const routes = useNodeStore((s) => s.routes);
  const rootRef = useRef<HTMLElement>(null);
  const [openRoutes, setOpenRoutes] = useState<Record<string, boolean>>({});
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  const [flashRouteId, setFlashRouteId] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const T = TT_TEXT.statsUi;
  const rec = r.cur.recordedMs;
  const shell = desktop ? "desktop" : "mobile";

  const sortedRoutes = useMemo(() => sortRouteShares(r.routes, sortBy), [r.routes, sortBy]);

  useEffect(() => {
    const onFocus = () => setFocusTick((n) => n + 1);
    window.addEventListener(STATS_ROUTE_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(STATS_ROUTE_FOCUS_EVENT, onFocus);
  }, []);

  useEffect(() => {
    const targetId = peekFocusedStatsRoute();
    if (!targetId || !sortedRoutes.length) return;
    clearFocusedStatsRoute();
    if (!sortedRoutes.some((row) => row.key === targetId)) return;
    setOpenRoutes((prev) => ({ ...prev, [targetId]: true }));
    setFlashRouteId(targetId);
    const raf = requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-route-id="${CSS.escape(targetId)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const timer = setTimeout(() => setFlashRouteId((cur) => (cur === targetId ? null : cur)), 1500);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [sortedRoutes, focusTick]);

  if (!sortedRoutes.length) return null;

  const toggleRoute = (id: string): void => {
    setOpenRoutes((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleNode = (id: string): void => {
    setOpenNodes((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <section ref={rootRef} className="ns-tt-stats-card ns-tt-stats-routes">
      <div className="ns-tt-stats-ch">
        <h3>{T.routesTitle}</h3>
        <span className="ns-tt-stats-ch-note">{T.routesNote}・點路線展開階層</span>
      </div>
      <div className="ns-tt-stats-list" role="list">
        {sortedRoutes.map((row) => {
          const special = row.key === ROUTE_NONE || row.key === ROUTE_GONE || row.key === ROUTE_NOROUTE;
          const info = routeNames[row.key];
          const node = special ? null : routes.find((x) => x.id === row.key) ?? null;
          const deleted = !special && (info?.deleted ?? !node);
          const name =
            row.key === ROUTE_NONE
              ? TT_TEXT.routeNone
              : row.key === ROUTE_NOROUTE
                ? TT_TEXT.routeNoRoute
                : row.key === ROUTE_GONE
                  ? TT_TEXT.routeGone
                  : deleted
                    ? T.routeDeleted(info?.name ?? "？")
                    : (info?.name ?? node?.name ?? "？");

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

          const rawTree = !special ? r.routeTrees[row.key] ?? [] : [];
          const treeNodes = rawTree.length > 0 ? sortRouteTreeNodes(rawTree, sortBy) : [];
          const hasTree = treeNodes.length > 0;
          const isOpen = !!openRoutes[row.key];
          const canJump = !special && !deleted;

          return (
            <div
              key={row.key}
              role="listitem"
              data-route-id={row.key}
              className={flashRouteId === row.key ? "ns-tt-stats-rflash" : undefined}
            >
              <div className={"ns-tt-stats-row is-route is-tree-head" + (isOpen ? " is-open" : "")}>
                {hasTree ? (
                  <button
                    type="button"
                    className="ns-tt-stats-exp"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "收起" : "展開"}「${name}」階層`}
                    onClick={() => toggleRoute(row.key)}
                  >
                    <i>›</i>
                  </button>
                ) : (
                  <span className="ns-tt-stats-exp is-blank" />
                )}
                {hasTree ? (
                  <button
                    type="button"
                    className="ns-tt-stats-rname ns-tt-stats-rhead-btn"
                    aria-expanded={isOpen}
                    onClick={() => toggleRoute(row.key)}
                  >
                    <span className="ns-tt-stats-rlead">{lead}</span>
                    <span>{name}</span>
                  </button>
                ) : (
                  <span className="ns-tt-stats-rname is-static ns-tt-stats-rhead-btn">
                    <span className="ns-tt-stats-rlead">{lead}</span>
                    <span>{name}</span>
                  </span>
                )}
                <span className="ns-tt-stats-rv ns-tt-num">
                  {fmtDur(row.ms)}
                  <em className="ns-tt-stats-rc">· {T.countTimes(row.count)}</em>
                </span>
                <span className="ns-tt-stats-rp ns-tt-num">{fmtPct(row.ms, rec)}</span>
                <span className="ns-tt-stats-rd ns-tt-num">
                  <Delta ms={row.ms - row.prevMs} prevMs={row.prevMs} showTitle={desktop} />
                </span>
                {canJump ? (
                  <button
                    type="button"
                    className="ns-iconbtn ns-tt-stats-rjump"
                    aria-label={`前往路線圖查看「${name}」`}
                    title="前往路線圖"
                    onClick={() => void jumpFromStatsToRouteNode(row.key, null, shell)}
                  >
                    <span aria-hidden="true">↗</span>
                  </button>
                ) : (
                  <span className="ns-tt-stats-rjump-sp" aria-hidden="true" />
                )}
              </div>
              {hasTree && isOpen && (
                <div className="ns-tt-stats-kids is-new">
                  <RouteTreeRows
                    nodes={treeNodes}
                    depth={1}
                    rec={rec}
                    desktop={desktop}
                    openNodes={openNodes}
                    onToggleNode={toggleNode}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
