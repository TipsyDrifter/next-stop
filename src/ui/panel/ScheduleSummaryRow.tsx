/**
 * ScheduleSummaryRow——v1.36 三段式大硬券（D-1.36-6）「時段與預估」單行漸進式揭露膠囊。
 *
 * 平時收合為單行膠囊（省下約 150px 雙排長度矩陣視覺噪音）：
 *   - 有值：`14:00–15:30 · 1h30m`／`每班 08:00–08:30 · 30m`／`14:00 発`／`預估 1h30m`（右側附展開 ▾）
 *   - 空值：`＋ 排時段／預估長度`（素雅虛線框）
 * 點擊膠囊後原地展開完整時段編輯器（桌機 TimeSpanField＋LengthField；手機 SpanButtons＋LengthField）與「收起 ▴」。
 * 另提供 `useHasExtraSlots(node, shell)` 靜默偵測車票是否已有「其他時段（timetable.slots）」，僅在有資料或展開時呈現。
 */
import { useEffect, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { lineNodeFields } from "../../lines/runtime";
import { useTimetablePlanStore } from "../../store/timetablePlanStore";
import { formatScheduleSummary } from "./panelRules";

/** 靜默檢查該節點是否已有時刻表「其他時段（time_plans）」資料，供漸進式揭露決定是否常駐顯示 */
export function useHasExtraSlots(node: NodeRow, shell: "desktop" | "mobile"): boolean {
  const hasScheduleSlot = lineNodeFields(shell).some(
    (f) => f.id === "timetable.slots" && f.kinds.includes(node.kind),
  );
  const rows = useTimetablePlanStore((s) => s.slotsByNode[node.id]);

  useEffect(() => {
    if (!hasScheduleSlot || rows !== undefined) return;
    useTimetablePlanStore
      .getState()
      .loadNode(node.id)
      .catch(() => undefined);
  }, [hasScheduleSlot, node.id, rows]);

  return hasScheduleSlot && (rows?.length ?? 0) > 0;
}

export interface ScheduleSummaryChipProps {
  start: string | null;
  estimateMin: number | null;
  lockedDate?: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** 桌機或手機樣式變體 */
  variant: "desktop" | "mobile";
  /** 展開時原地呈現的編輯器內容（時段＋長度） */
  children: ReactNode;
}

export function ScheduleSummaryChip({
  start,
  estimateMin,
  lockedDate = false,
  expanded,
  onToggle,
  variant,
  children,
}: ScheduleSummaryChipProps) {
  const summary = formatScheduleSummary({ start, estimateMin, lockedDate });
  const isMobile = variant === "mobile";

  return (
    <div className={isMobile ? "m-dt-sched-sum" : "panel-sched-sum"}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={
          summary.hasValue
            ? `時段與預估：${summary.text}（點一下${expanded ? "收起" : "展開編輯"}）`
            : `時段與預估：未設定（點一下${expanded ? "收起" : "排時段或預估長度"}）`
        }
        className={
          (isMobile ? "m-dt-sched-pill" : "panel-sched-pill") +
          (summary.hasValue ? " has-val" : " is-empty") +
          (expanded ? " is-open" : "")
        }
        onClick={onToggle}
      >
        <span className={isMobile ? "m-dt-sched-text" : "panel-sched-text"}>{summary.text}</span>
        <span className={isMobile ? "m-dt-sched-caret" : "panel-sched-caret"} aria-hidden="true">
          {expanded ? "收起 ▴" : summary.hasValue ? "▾" : ""}
        </span>
      </button>

      {expanded && <div className={isMobile ? "m-dt-sched-body" : "panel-sched-body"}>{children}</div>}
    </div>
  );
}
