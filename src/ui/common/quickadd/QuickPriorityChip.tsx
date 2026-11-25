/**
 * 票面行內快改小鈕群（v1.31 D-1.31-5「誤點票與一般車票票面行內快改一致化」＋「未排程車票滑過輕量快改入口」）：
 *   - `QuickPriorityChip`：原地開共用 `PopMenu`（高／中／低，標出目前設定），平時放在 `.meta-hover`（滑過／選中／聚焦才現身）
 *     或包在票名前的高優先赭點外層，不常駐空白膠囊。
 *   - `QuickDueChip`：今日列「締切 M/D」（含誤點區與締切段）與 `.meta-hover`「＋締切」原地開共用 `DatePicker`（含「＝同乘車日」與清除）。
 *   - `QuickExecChip`：行程表締切列（`DueRow`）「執行 M/D／未排乘車日」原地開共用 `DatePicker`（挑過去＝補記，同側板與大綱）。
 *
 * 全部沿用列內按鈕紀律：`tabIndex={-1}`、`onMouseDown={(e) => e.preventDefault()}` 不搶清單焦點；
 * portal 浮層一律經 `StopBubble` 吞掉冒泡，避免誤觸開詳情側板或單鍵快捷鍵；`DatePicker` 帶 `.ns-qa-pop` 讓當日浮層保持開啟。
 */
import { useRef, useState, type ReactNode } from "react";
import type { Priority } from "../../../domain";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { DatePicker, dateRangeQuickSet } from "../DatePicker";
import { dueQuickSet, scheduledQuickSet } from "../datePickRules";
import { PopMenu } from "../PopMenu";
import { PRIORITY_TEXT } from "./quickAddModel";
import { StopBubble } from "./reattach";

const LEVELS: readonly Priority[] = ["high", "mid", "low"];

export function QuickPriorityChip({
  nodeId,
  priority,
  className,
  children,
  onDone,
}: {
  nodeId: string;
  priority: Priority;
  /** 長相跟同一群的空日期 chip 走（今日＝`chip chip-btn`、大綱＝`ns-datechip is-empty`、赭點外殼＝`ns-prio-btn`） */
  className: string;
  /** 有給就包在裡面（例：高優先的赭色小點）；省略時依目前優先級印「＋優先」或「優先・低」 */
  children?: ReactNode;
  /** 選單收起後（今日／大綱＝焦點還給清單容器） */
  onDone?(): void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onDone?.();
  };
  const label = priority === "mid" ? "＋優先" : `優先・${PRIORITY_TEXT[priority]}`;
  return (
    <>
      <button
        ref={btn}
        type="button"
        tabIndex={-1}
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`優先順序（目前：${PRIORITY_TEXT[priority]}）`}
        title={`優先順序（目前：${PRIORITY_TEXT[priority]}・點擊切換）`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {children ?? label}
      </button>
      {open && (
        <StopBubble>
          <PopMenu
            anchor={btn.current}
            overline={{ zh: "優先順序", latin: "Priority" }}
            label="優先順序"
            items={LEVELS.map((p) => ({
              key: p,
              label: p === "mid" ? `${PRIORITY_TEXT[p]}（一般）` : PRIORITY_TEXT[p],
              note: p === priority ? "目前" : undefined,
              onSelect: () => {
                if (p !== priority) void useNodeStore.getState().updateNode(nodeId, { priority: p });
              },
            }))}
            onClose={close}
            returnFocus={() => {
              onDone?.();
              return null;
            }}
          />
        </StopBubble>
      )}
    </>
  );
}

export function QuickDueChip({
  nodeId,
  dueOn,
  scheduledOn,
  today,
  className,
  title = "點擊設定或修改締切日",
  children,
  onDone,
}: {
  nodeId: string;
  dueOn: string | null;
  scheduledOn?: string | null;
  today: string;
  className: string;
  title?: string;
  children: ReactNode;
  onDone?(): void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const weekStart = useUiStore((s) => s.weekStart);
  const close = () => {
    setOpen(false);
    onDone?.();
  };
  const quick = dueQuickSet(today, { scheduledOn, weekStart });
  return (
    <>
      <button
        ref={btn}
        type="button"
        tabIndex={-1}
        data-pop-toggle
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {children}
      </button>
      {open && (
        <StopBubble>
          <DatePicker
            anchor={btn.current}
            className="ns-qa-pop"
            label="締切日"
            value={dueOn}
            markValue={Boolean(dueOn)}
            today={today}
            quick={quick}
            onPick={(d) => {
              setOpen(false);
              if (d !== dueOn) void useNodeStore.getState().updateNode(nodeId, { due_on: d });
              onDone?.();
            }}
            onClear={
              dueOn
                ? () => {
                    setOpen(false);
                    void useNodeStore.getState().updateNode(nodeId, { due_on: null });
                    onDone?.();
                  }
                : undefined
            }
            clearLabel="清除締切日"
            onClose={close}
          />
        </StopBubble>
      )}
    </>
  );
}

export function QuickExecChip({
  nodeId,
  scheduledOn,
  scheduledEnd = null,
  isMultiDay = false,
  today,
  className,
  title = "點擊設定或修改乘車日",
  children,
  onDone,
}: {
  nodeId: string;
  scheduledOn: string | null;
  scheduledEnd?: string | null;
  isMultiDay?: boolean;
  today: string;
  className: string;
  title?: string;
  children: ReactNode;
  onDone?(): void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const weekStart = useUiStore((s) => s.weekStart);
  const close = () => {
    setOpen(false);
    onDone?.();
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        tabIndex={-1}
        data-pop-toggle
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {children}
      </button>
      {open && (
        <StopBubble>
          <DatePicker
            anchor={btn.current}
            className="ns-qa-pop"
            label="乘車日"
            value={scheduledOn}
            endValue={scheduledEnd}
            isMultiDay={isMultiDay}
            allowRange
            rangeQuick={dateRangeQuickSet(today, weekStart)}
            markValue={Boolean(scheduledOn)}
            today={today}
            quick={scheduledQuickSet(today, weekStart)}
            onPick={(d) => {
              setOpen(false);
              if (d !== scheduledOn || scheduledEnd !== null || isMultiDay) {
                if (d < today) {
                  void useNodeStore
                    .getState()
                    .updateNode(nodeId, { scheduled_on: d, scheduled_end: null, is_multi_day: null }, { backfill: true });
                } else {
                  void useNodeStore.getState().reschedule(nodeId, d, { scheduledEnd: null, isMultiDay: false });
                }
              }
              onDone?.();
            }}
            onPickRange={(s, e, multi) => {
              setOpen(false);
              if (!e && s < today) {
                void useNodeStore
                  .getState()
                  .updateNode(nodeId, { scheduled_on: s, scheduled_end: null, is_multi_day: null }, { backfill: true });
              } else {
                void useNodeStore.getState().reschedule(nodeId, s, { scheduledEnd: e, isMultiDay: Boolean(multi) });
              }
              onDone?.();
            }}
            onClear={
              scheduledOn
                ? () => {
                    setOpen(false);
                    void useNodeStore.getState().reschedule(nodeId, null);
                    onDone?.();
                  }
                : undefined
            }
            clearLabel="無日期"
            onClose={close}
          />
        </StopBubble>
      )}
    </>
  );
}
