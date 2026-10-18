/**
 * useLinkedTime——側板「時間」列的資料（車次② 契約 §5.6、0-5、0-6；丙）。
 *
 * - 節點（車票／列車／車廂／支線）：`store.subtreeNodes(node)`（含自己）→ id 清單 → `store.linkedBlocks({ nodeIds })`
 *   → `linkedTotals(..., { self: { nodeId } })`；手填＝子樹每個節點的 `time_spent_min`（null 當 0）分自己／底下
 *   （自己那一份用傳進來的 `node`，改完手填立刻跟著換）。
 * - 路線：`store.linkedBlocks({ routeId })` → `linkedTotals(..., { self: { routeId } })`；手填＝`store.routeNodes(routeId)`
 *   每個節點的 `time_spent_min` 加總算「底下」，路線自己的 `time_spent_min` 算「自己」；`monthMs`＝本月（日界線的
 *   這個月 1 號起到現在，只算時間塊）。
 * - 重查時機：`node.id`、`node.time_spent_min`、`nodeStore.tree`、`timetableStore.rev` 變了（rev＝每次 refresh +1，
 *   寫入、同步、回前景都會走到）；重查期間照舊顯示上一份（不閃），換了節點才先回 `ready:false`。
 * - 有運行中那班在範圍裡 ⇒ `useNow(60_000)` 每分鐘重算（不重查）。
 * - UI 只叫 store（契約 §1-5）；不碰任何 repository。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../../domain/node";
import { MIN, msOf } from "../../../domain/timetable";
import { linkedTotals, monthStartKey, toLinkedSpan, unionMs, type LinkedSpan } from "../../../domain/timetableLink";
import { dayWindow, todayKey } from "../../../lib/date";
import { useNodeStore } from "../../../store/nodeStore";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { useNow } from "../useNow";

export interface LinkedTime {
  ready: boolean;
  /** 合計（含手填） */
  totalMs: number;
  /** 自己（含自己的手填） */
  selfMs: number;
  /** 底下（含子孫的手填） */
  belowMs: number;
  /** 自己的手填（node.time_spent_min） */
  manualMin: number | null;
  /** 只有路線有（本月，只算時間塊） */
  monthMs: number | null;
  /** 有運行中那班在這個範圍裡 */
  running: boolean;
}

interface Loaded {
  /** 這一份是哪個節點的 */
  id: string;
  spans: LinkedSpan[];
  /** 子孫（路線＝路線樹的節點）的手填合計（分） */
  belowManualMin: number;
}

const EMPTY: LinkedTime = { ready: false, totalMs: 0, selfMs: 0, belowMs: 0, manualMin: null, monthMs: null, running: false };

export function useLinkedTime(node: NodeRow): LinkedTime {
  const tree = useNodeStore((s) => s.tree);
  const rev = useTimetableStore((s) => s.rev);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [data, setData] = useState<Loaded | null>(null);
  // effect 讀最新的 node，但只在契約列的那幾樣變了才重查（node 物件每次 nodeStore 重載都會換）
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const isRoute = node.kind === "route";

  useEffect(() => {
    let alive = true;
    const n = nodeRef.current;
    const st = useTimetableStore.getState();
    const load = async (): Promise<Loaded> => {
      if (n.kind === "route") {
        const [rows, nodes] = await Promise.all([st.linkedBlocks({ routeId: n.id }), st.routeNodes(n.id)]);
        let below = 0;
        for (const x of nodes) if (x.id !== n.id) below += x.time_spent_min ?? 0;
        return { id: n.id, spans: rows.map(toLinkedSpan), belowManualMin: below };
      }
      const sub = await st.subtreeNodes(n);
      const ids = sub.map((x) => x.id);
      if (!ids.includes(n.id)) ids.push(n.id);
      const rows = await st.linkedBlocks({ nodeIds: ids });
      let below = 0;
      for (const x of sub) if (x.id !== n.id) below += x.time_spent_min ?? 0;
      return { id: n.id, spans: rows.map(toLinkedSpan), belowManualMin: below };
    };
    load().then(
      (d) => {
        if (alive) setData(d);
      },
      (e: unknown) => console.warn("[tt:time] 讀時間失敗：", e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [node.id, node.kind, node.route_id, node.time_spent_min, tree, rev]);

  const running = !!data && data.id === node.id && data.spans.some((s) => s.end === null);
  const now = useNow(60_000);
  const manual = node.time_spent_min;

  return useMemo<LinkedTime>(() => {
    if (!data || data.id !== node.id) return { ...EMPTY, manualMin: manual };
    const t = linkedTotals(data.spans, { self: isRoute ? { routeId: node.id } : { nodeId: node.id }, now });
    const selfManual = (manual ?? 0) * MIN;
    const belowManual = data.belowManualMin * MIN;
    let monthMs: number | null = null;
    if (isRoute) {
      const start = msOf(dayWindow(monthStartKey(todayKey(dayStartHour)), dayStartHour).start);
      monthMs = unionMs(data.spans, now, { start, end: now });
    }
    return {
      ready: true,
      totalMs: t.totalMs + selfManual + belowManual,
      selfMs: t.selfMs + selfManual,
      belowMs: t.belowMs + belowManual,
      manualMin: manual,
      monthMs,
      running,
    };
    // now 只在有運行中那班時才需要跟著變；沒有時 useNow 照跳，重算的結果相同（便宜）
  }, [data, node.id, isRoute, manual, now, dayStartHour, running]);
}
