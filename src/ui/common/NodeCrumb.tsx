/**
 * NodeCrumb — 全站 5 大抽離視圖共用之精簡淡色上層脈絡（D-1.36-2）。
 *
 * 顯示「支線 › 列車 › 車廂」（不含路線名，避免與票根重複），直接讀取 nodeStore.taskHolders 零 N+1 查詢。
 * 適用：今日頁、行程表、時刻表日程、快速跳轉（Ctrl+P）、完整搜尋。
 */
import { useMemo } from "react";
import type { TaskHolderRow } from "../../data/nodeRepository";
import { useNodeStore } from "../../store/nodeStore";
import "./nodecrumb.css";

const EMPTY_SEGMENTS: readonly string[] = [];

/** 由 parentId 沿 taskHolders 向上回溯出 [最外層支線, ..., 直屬父列車/車廂]（不含路線本身） */
export function parentCrumbOf(
  parentId: string | null | undefined,
  holders: Readonly<Record<string, TaskHolderRow>>,
): readonly string[] {
  if (!parentId) return EMPTY_SEGMENTS;
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = parentId;
  while (cur && !seen.has(cur)) {
    const h: TaskHolderRow | undefined = holders[cur];
    if (!h) break;
    seen.add(cur);
    out.push(h.name);
    cur = h.parent_id;
  }
  if (!out.length) return EMPTY_SEGMENTS;
  out.reverse();
  return out;
}

export function useParentCrumb(parentId: string | null | undefined): readonly string[] {
  const holders = useNodeStore((s) => s.taskHolders);
  return useMemo(() => parentCrumbOf(parentId, holders), [parentId, holders]);
}

export function NodeCrumb({
  parentId,
  segments,
  compact = false,
  className,
}: {
  parentId?: string | null;
  /** 若呼叫端已自行組好段名，可直接傳入覆寫 */
  segments?: readonly string[];
  compact?: boolean;
  className?: string;
}) {
  const computed = useParentCrumb(segments ? null : parentId);
  const list = segments ?? computed;
  if (!list.length) return null;
  const full = list.join(" › ");
  return (
    <span className={"ns-nodecrumb" + (compact ? " is-compact" : "") + (className ? ` ${className}` : "")} title={full}>
      {list.map((seg, i) => (
        <span key={i} className="ns-nodecrumb-seg">
          {i > 0 && (
            <span className="ns-nodecrumb-sep" aria-hidden>
              ›
            </span>
          )}
          {seg}
        </span>
      ))}
    </span>
  );
}
