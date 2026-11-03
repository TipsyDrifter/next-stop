/**
 * FullSearchSideAux——完整搜尋頁的書封頁務件（丁 D-主-238；規則 D-主-234；視覺真相＝prototypes/design-structure-側欄.html A1「完整搜尋」欄）。
 * 經 `pageViews.tsx` 的 `installPageSidebarAux` 登記（核心頁的插槽，D-主-235）。之前這頁畫「我的路線」、點了會跳去路線圖。
 *
 * 三組篩選（狀態、種類、路線）＋每項命中數；點了＝改頁內同一份 `searchStore.filter`（頁首的篩選列照舊，兩處同步）。
 * 數字＝「其他兩組照目前選的、這一組換成這一項」時找到幾件（同頁首路線選單的口徑，`filterHits`）。
 * 路線只列有命中的（多→少），目前選著的就算 0 件也留著；「臨時車票」有命中才列。
 */
import type { ReactNode } from "react";
import type { NodeRow } from "../../domain";
import {
  KIND_FILTER_LABEL,
  STATUS_FILTER_LABEL,
  filterHits,
  isTempTicket,
  type FullSearchFilter,
  type KindFilter,
  type StatusFilter,
} from "../../domain/fullSearch";
import { useNodeStore } from "../../store/nodeStore";
import { useSearchStore } from "../../store/searchStore";
import { roundelStyle } from "../common/roundel";

const STATUS_OPTS: readonly StatusFilter[] = ["all", "open", "done"];
const KIND_OPTS: readonly KindFilter[] = ["all", "ticket", "tree"];

function sameRoute(a: FullSearchFilter["route"], b: FullSearchFilter["route"]): boolean {
  if (typeof a === "object" && typeof b === "object") return a.routeId === b.routeId;
  return a === b;
}

export function FullSearchSideAux() {
  const hits = useSearchStore((s) => s.hits);
  const filter = useSearchStore((s) => s.filter);
  const setFilter = useSearchStore((s) => s.setFilter);
  const occ = useNodeStore((s) => s.currentOccurrences);
  const routes = useNodeStore((s) => s.routes);

  const isDone = (n: NodeRow) => {
    const o = occ[n.id];
    return o ? o.status === "done" : n.status === "done";
  };
  const count = (patch: Partial<FullSearchFilter>) => filterHits(hits, { ...filter, ...patch }, isDone).length;

  const routeCounts = new Map<string, number>();
  let temp = 0;
  for (const { node } of filterHits(hits, { ...filter, route: "all" }, isDone)) {
    if (isTempTicket(node)) temp++;
    const rid = node.kind === "route" ? node.id : node.route_id;
    if (rid) routeCounts.set(rid, (routeCounts.get(rid) ?? 0) + 1);
  }
  const picked = typeof filter.route === "object" ? filter.route.routeId : null;
  if (picked && !routeCounts.has(picked)) routeCounts.set(picked, 0);
  const routeRows = routes
    .filter((r) => routeCounts.has(r.id))
    .sort((a, b) => routeCounts.get(b.id)! - routeCounts.get(a.id)! || a.name.localeCompare(b.name));

  const item = (key: string, on: boolean, label: ReactNode, n: number, onClick: () => void, mark?: ReactNode) => (
    <button key={key} type="button" className={`line-item${on ? " active" : ""}`} aria-pressed={on} onClick={onClick}>
      {mark}
      <span className="line-name">{label}</span>
      <span className="n">{n}</span>
    </button>
  );

  return (
    <div className="lines page-aux" aria-label="完整搜尋的篩選">
      <h2>篩選 FILTERS</h2>
      <div className="page-aux-body">
        <p className="trunk">狀態</p>
        {STATUS_OPTS.map((s) =>
          item(`st:${s}`, filter.status === s, STATUS_FILTER_LABEL[s], count({ status: s }), () =>
            setFilter({ status: s }),
          ),
        )}
        <p className="trunk">種類</p>
        {KIND_OPTS.map((k) => item(`kd:${k}`, filter.kind === k, KIND_FILTER_LABEL[k], count({ kind: k }), () => setFilter({ kind: k })))}
        <p className="trunk">路線</p>
        {item("rt:all", filter.route === "all", "全部", count({ route: "all" }), () => setFilter({ route: "all" }), <span aria-hidden className="roundel is-blank" />)}
        {(temp > 0 || filter.route === "temp") &&
          item("rt:temp", filter.route === "temp", "臨時車票", temp, () => setFilter({ route: "temp" }), <span aria-hidden className="roundel is-blank" />)}
        {routeRows.map((r) =>
          item(
            `rt:${r.id}`,
            sameRoute(filter.route, { routeId: r.id }),
            r.name,
            routeCounts.get(r.id)!,
            () => setFilter({ route: { routeId: r.id } }),
            <span aria-hidden className="roundel" style={roundelStyle(r.color)}>
              {r.code ?? ""}
            </span>,
          ),
        )}
      </div>
    </div>
  );
}
