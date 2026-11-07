/**
 * 看板卡「選日期…」的推遲小卡：一頁一個，錨在那張卡的 ⋯（找不到就照 DeferPopover 的置中）。
 * DeferPopover 的列由呼叫端注入，所以跨路線、不在今日切片裡的票一樣能開（行程表串流同一招）。
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { DeferPopover, type DeferRow } from "../today/DeferPopover";

export function useCardDefer(): { open(node: NodeRow): void; popover: ReactNode } {
  const [target, setTarget] = useState<{ node: NodeRow; anchor: HTMLElement | null } | null>(null);
  const occ = useNodeStore((s) => (target ? s.currentOccurrences[target.node.id] : undefined));
  const open = useCallback((node: NodeRow) => {
    const anchor = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"] button[aria-haspopup="menu"]`);
    setTarget({ node, anchor });
  }, []);
  const row = useMemo<DeferRow | null>(
    () => (target ? { ...target.node, occurrence: occ ?? null, railDate: occ?.due_on ?? target.node.scheduled_on } : null),
    [target, occ],
  );
  const popover = target && row ? <DeferPopover row={row} anchor={target.anchor} onClose={() => setTarget(null)} /> : null;
  return { open, popover };
}
