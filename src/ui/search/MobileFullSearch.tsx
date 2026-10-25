/**
 * MobileFullSearch——手機完整搜尋（完整搜尋班；契約 docs/research/2026-10-25-主線-完整搜尋班-契約.md；
 * 視覺真相＝prototypes/主線-完整搜尋.html ④）。
 *
 * 由 MobileQuickJump 掛（疊在快速搜尋之上，不動手機殼與頂帶）：快速搜尋有字時底部「看全部結果」、空白時頂部「完整搜尋」。
 * MFullPage 全螢幕（左「‹ 返回」＝退回快速搜尋，字還在；返回鍵同一件事，D-主-117）。
 *   頭（黏在上面）：大號底線搜尋框＋可橫向滑的篩選 chip 列＋統計行；身：兩行的結果列。
 *   點一列＝跳到那張票（`onPick` 由快速搜尋接：先把兩層一起收，再 `jumpToNodeMobile`）。
 *   路線篩選＝底部 sheet（疊在全螢幕頁上，backKind="dialog"）。
 * 列數不設上限（D-主-115）：一次畫 RESULT_PAGE 列，捲到底接下一批；狀態留在 searchStore（D-主-118）。
 */
import { useEffect, useId, useRef, useState } from "react";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { useSearchStore } from "../../store/searchStore";
import { MFullPage } from "../common/MFullPage";
import { MSheet, MSheetItem } from "../common/MSheet";
import { FullSearchField, FullSearchFilters, FullSearchMobileRow, FullSearchStats, ListTail, routeFilterText } from "./FullSearchParts";
import { useFullSearchResults } from "./useFullSearchResults";

export function MobileFullSearch({ onBack, onPick }: { onBack(): void; onPick(node: NodeRow): void }) {
  const query = useSearchStore((s) => s.query);
  const hitsTerm = useSearchStore((s) => s.hitsTerm);
  const pending = useSearchStore((s) => s.pending);
  const shown = useSearchStore((s) => s.shown);
  const filter = useSearchStore((s) => s.filter);
  const routes = useNodeStore((s) => s.routes);
  const { showMore, setFilter, setActive } = useSearchStore.getState();
  const { rows, total, filtered, routeOptions } = useFullSearchResults();

  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [routeSheet, setRouteSheet] = useState(false);
  const listId = useId();

  const term = hitsTerm;
  const visible = rows.slice(0, shown);
  const typing = query.trim() !== hitsTerm || pending;

  // 換字、換篩選＝捲回頂（反方評審 #1）
  const viewTick = useSearchStore((s) => s.viewTick);
  const mountedTick = useRef(viewTick);
  useEffect(() => {
    if (viewTick === mountedTick.current) return;
    const body = bodyRef.current?.closest(".ns-mfull-body");
    if (body) body.scrollTop = 0;
  }, [viewTick]);

  // 捲動容器＝MFullPage 的身（.ns-mfull-body）；哨兵進視窗就接下一批
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && showMore(), {
      root: bodyRef.current?.closest(".ns-mfull-body") ?? null,
      rootMargin: "400px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rows.length, showMore]);

  const pickRoute = (route: typeof filter.route) => {
    setFilter({ route });
    setRouteSheet(false);
  };

  return (
    <MFullPage title="完整搜尋" left={{ label: "返回", back: true, onClick: onBack }} backId="core.fullsearch">
      <div ref={bodyRef} className="ns-fs-m">
        <div className="ns-fs-m-head">
          <FullSearchField autoFocus={!query} />
          <FullSearchFilters
            separators
            routeText={routeFilterText(filter.route, routeOptions, (id) => routes.find((r) => r.id === id)?.name)}
            routeOpen={routeSheet}
            onRoute={() => setRouteSheet(true)}
          />
          {hitsTerm && <FullSearchStats count={rows.length} total={total} filtered={filtered} pending={typing && !rows.length} />}
        </div>

        {!hitsTerm ? (
          !query.trim() && <p className="ns-fs-hint">名稱、概要、乘務記錄都會找，結果不限筆數。點一列就跳到那裡。</p>
        ) : rows.length === 0 ? (
          !typing && (
            <p className="ns-fs-hint">
              {total > 0 ? `「${term}」共 ${total} 件，都被篩選擋下了。` : `名稱、概要、乘務記錄裡都找不到「${term}」。`}
            </p>
          )
        ) : (
          <>
            <ul id={listId} role="listbox" aria-label="搜尋結果" className={`ns-fs-list${typing ? " is-stale" : ""}`}>
              {visible.map((r) => (
                <FullSearchMobileRow
                  key={r.hit.node.id}
                  id={`${listId}-${r.hit.node.id}`}
                  row={r}
                  term={term}
                  active={false}
                  onPick={() => {
                    setActive(r.hit.node.id);
                    onPick(r.hit.node);
                  }}
                />
              ))}
            </ul>
            <ListTail more={visible.length < rows.length} total={rows.length} sentinelRef={sentinelRef} />
          </>
        )}
      </div>

      {routeSheet && (
        <MSheet title="依路線篩選" onClose={() => setRouteSheet(false)} backKind="dialog" list>
          <MSheetItem onClick={() => pickRoute("all")}>全部路線</MSheetItem>
          <MSheetItem onClick={() => pickRoute("temp")}>臨時車票</MSheetItem>
          {routeOptions.map((r, i) => (
            <MSheetItem key={r.id} cut={i === 0} onClick={() => pickRoute({ routeId: r.id })}>
              {r.name}（{r.count}）
            </MSheetItem>
          ))}
        </MSheet>
      )}
    </MFullPage>
  );
}
