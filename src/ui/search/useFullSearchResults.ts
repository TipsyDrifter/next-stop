/**
 * 完整搜尋兩殼共用的「結果怎麼算」：searchStore 的原始命中 → 篩選 → 排序（domain/fullSearch），
 * 加上每列要的済、淡字路線、日期欄。資料變了（nodeStore 的切片換物件＝重載過）就請 store 重查一次。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { NodeRow } from "../../domain";
import { dateCell, filterHits, isDefaultFilter, keepOrder, rankHits, type DateCell, type FullSearchHit } from "../../domain/fullSearch";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useSearchStore } from "../../store/searchStore";
import { useUiStore } from "../../store/uiStore";
import { quickJumpContext } from "../common/QuickJump";

export interface FullSearchRowModel {
  hit: FullSearchHit;
  done: boolean;
  /** 淡字：所屬路線名（路線＝幹線名；臨時車票＝「臨時車票」） */
  context: string;
  /** 右側日期欄（執行日／今天／下一班／締切；沒有＝null） */
  date: DateCell | null;
}

export interface RouteOption {
  id: string;
  name: string;
  count: number;
}

export function useFullSearchResults() {
  const hits = useSearchStore((s) => s.hits);
  const filter = useSearchStore((s) => s.filter);
  const routes = useNodeStore((s) => s.routes);
  const lines = useNodeStore((s) => s.lines);
  const occ = useNodeStore((s) => s.currentOccurrences);
  const tree = useNodeStore((s) => s.tree);
  const today = useNodeStore((s) => s.today);
  /** 側板寫乘務記錄只重載這一份（tree／today 不換物件），也要算資料變了（反方評審 #5） */
  const workLogs = useNodeStore((s) => s.workLogs);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  // 掛上就重查一次（不經入口回來——「‹ 回到剛才」、?page=——也要看到離開期間的變動，反方評審 #4），
  // 之後資料變了再查。切片每次重載都換物件，當版本號用；重查同一個字不動選中與捲動
  useEffect(() => {
    useSearchStore.getState().refresh();
  }, [tree, today, occ, workLogs]);

  /** 済看目前班次（定期券的済蓋在班次上；同 Ctrl+P） */
  const isDone = useCallback((n: NodeRow) => {
    const o = occ[n.id];
    return o ? o.status === "done" : n.status === "done";
  }, [occ]);

  const todayStr = todayKey(dayStartHour);

  // 清單不動（沙盒 F1）：同一次搜尋（hitsTerm 與 viewTick 沒變＝沒換字、沒換篩選）裡重查，已在清單上的照舊位置
  const hitsTerm = useSearchStore((s) => s.hitsTerm);
  const viewTick = useSearchStore((s) => s.viewTick);
  const frozen = useRef<{ term: string; tick: number; order: Map<string, number> } | null>(null);

  const rows = useMemo<FullSearchRowModel[]>(() => {
    const ranked = rankHits(filterHits(hits, filter, isDone), isDone);
    const f = frozen.current;
    const same = f !== null && f.term === hitsTerm && f.tick === viewTick;
    const { hits: ordered, order } = keepOrder(ranked, same ? f.order : null);
    frozen.current = { term: hitsTerm, tick: viewTick, order };
    return ordered.map((hit) => {
      const done = isDone(hit.node);
      return {
        hit,
        done,
        context: quickJumpContext(hit.node, routes, lines),
        date: dateCell(hit.node, done, todayStr),
      };
    });
  }, [hits, filter, isDone, routes, lines, todayStr, hitsTerm, viewTick]);

  /**
   * 路線篩選的選項：只列「在其他兩組篩選之下有命中」的路線，按命中數多→少（全部路線動輒幾十條，列不完也沒用）。
   * 目前選著的路線就算 0 件也留著，免得選項自己消失。
   */
  const routeOptions = useMemo<RouteOption[]>(() => {
    const base = filterHits(hits, { ...filter, route: "all" }, isDone);
    const count = new Map<string, number>();
    for (const { node } of base) {
      const rid = node.kind === "route" ? node.id : node.route_id;
      if (rid) count.set(rid, (count.get(rid) ?? 0) + 1);
    }
    const picked = typeof filter.route === "object" ? filter.route.routeId : null;
    if (picked && !count.has(picked)) count.set(picked, 0);
    return routes
      .filter((r) => count.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, count: count.get(r.id)! }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [hits, filter, isDone, routes]);

  return { rows, total: hits.length, filtered: !isDefaultFilter(filter), routeOptions };
}
