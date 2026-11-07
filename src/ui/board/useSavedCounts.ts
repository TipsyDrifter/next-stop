/**
 * 每條常用篩選現在符合幾張（書封用；不重查，吃 boardStore 已有的 tasks）。
 * 比對同 useTaskFilter：同一支 matchTask、同一份 ctx 規則；版面是看板的那條不看狀態（四欄就是狀態）。
 */
import { useMemo } from "react";
import { todayKey } from "../../lib/date";
import { matchTask, type TaskFilterCtx } from "../../domain/taskFilter";
import { useBoardStore } from "../../store/boardStore";
import { useNodeStore } from "../../store/nodeStore";
import { useTagStore } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";

export function useSavedCounts(): Record<string, number> {
  const saved = useBoardStore((s) => s.saved);
  const tasks = useBoardStore((s) => s.tasks);
  const routes = useNodeStore((s) => s.routes);
  const occurrences = useNodeStore((s) => s.currentOccurrences);
  const index = useTagStore((s) => s.index);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  return useMemo(() => {
    if (!saved.length) return {};
    const tagsById = new Map<string, string[]>();
    for (const e of index?.ents ?? []) if (e.type === "node") tagsById.set(e.id, e.keys);
    const live = new Set(routes.map((r) => r.id));
    const ctx: TaskFilterCtx = {
      today: todayKey(dayStartHour),
      occurrences,
      tagsOf: (id) => tagsById.get(id) ?? [],
      depot: new Set(routes.filter((r) => r.arrived_on).map((r) => r.id)),
      aliveRoute: (id) => live.has(id),
      aliveTag: (k) => !index || !!index.byKey[k],
    };
    const out: Record<string, number> = {};
    for (const s of saved) {
      const f = s.layout === "board" ? { ...s.filter, status: "all" as const } : s.filter;
      out[s.id] = tasks.filter((n) => matchTask(n, f, ctx) && !(s.layout === "board" && n.has_kids)).length;
    }
    return out;
  }, [saved, tasks, routes, occurrences, index, dayStartHour]);
}
