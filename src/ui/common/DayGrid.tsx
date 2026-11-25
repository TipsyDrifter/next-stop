/**
 * DayGrid——共用日期挑選器的「自畫月格」（旅客筆記車次③ 0-6 甲、D-筆-46 修訂；示意＝prototypes/旅客筆記-日記選日期-參考圖.html「大日期的挑選器」）。
 *
 * 由 `DatePicker`（桌機）／`MobileDatePicker`（手機）畫。磨光⑤ S8（D-主-54：日期挑選統一成 App 自畫）起**一律**畫月格、
 * 不再退回原生日期欄；`marks` 變可選（沒給＝沒有記號點）。
 *
 *   月份列：‹ 上個月 「2026 年 10 月」 下個月 ›（整個月都在 min／max 外的那一邊反灰）
 *   欄頭＋42 格（6 列固定，換月不跳高）：週首讀 uiStore.weekStart
 *   格：`marks` 裡的日＝數字下方一枚墨點（--stamp-ink；磨光⑤：記號不是済，朱改墨）、今天＝外框、`value`＝底色、min／max 外＝反灰不可點
 *   圖例（給了 `marksLabel` 才畫）：「• 寫過日記」
 *
 * 鍵盤（只在格上；roving tabindex，Tab 進出整張格只停一次）：←→ ±1 天、↑↓ ±7 天、PageUp／PageDown ±1 月、Home／End 月初／月底、
 * Enter＝選（自己處理並擋冒泡：時刻表的 window 後援會把漏出去的 Enter 當「到着」）、Space＝按鈕本身（只擋冒泡）；
 * Esc 不在這裡——由外層挑選器收起。越過月界自動換月。規則全在純函式 `gridKeyAction`（monthGridMath.ts；測試
 * scripts/tests/day-grid-keys.test.ts）。處理過的鍵 preventDefault＋stopPropagation，不漏給頁面的鍵盤表。
 *
 * `onMonthChange(month)`：**掛上時呼叫一次**（開啟時那個月）、之後每次換月再呼叫——呼叫端據此補查那個月的記號。
 *
 * 樣式在 `./datepicker.css`：桌機 `.ns-datepick-grid*`、手機 `.ns-mdatepick-grid*`（掛 `[data-shell="mobile"]`）。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useUiStore } from "../../store/uiStore";
import { dayRangeRole, normalizeDragRange } from "./datePickRules";
import {
  canShowMonth,
  focusDayOf,
  gridKeyAction,
  initialMonth,
  inRange,
  monthCells,
  monthOfDay,
  monthTitle,
  shiftMonth,
  weekHeads,
} from "./monthGridMath";

export interface DayGridProps {
  /** 目前的日子（底色；區間時為起日）；null／省略＝沒有 */
  value?: string | null;
  /** 區間訖日（有值且 > value 時畫區間連帶）；null／省略＝單日 */
  endValue?: string | null;
  /** 區間模式已點第一下起日、等待點選訖日時的暫存起日 */
  draftStart?: string | null;
  /** 今天（外框；也決定沒有 value 時開在哪個月） */
  today: string;
  min?: string;
  max?: string;
  /** 有記號的日子（YYYY-MM-DD）；省略＝沒有記號（磨光⑤ S8：所有日期挑選都畫月格，記號變可選） */
  marks?: ReadonlySet<string>;
  /** 記號的意思（圖例字與每格的讀屏字，例「寫過日記」）；省略＝不畫圖例、讀屏念「有記號」 */
  marksLabel?: string;
  /** 掛上時一次、之後每次換月：YYYY-MM */
  onMonthChange?(month: string): void;
  onPick(day: string): void;
  /** 是否允許在月格上按住滑過多格直接拖出多日乘車日（v1.37 2A-2） */
  allowDragRange?: boolean;
  /** 按住滑過多格放開後（起訖不同日）提交多日區間 */
  onDragRange?(start: string, end: string): void;
  /** desk＝桌機小浮層裡（.ns-datepick-grid*）；mobile＝手機底部面板裡（.ns-mdatepick-grid*，格高 44px） */
  variant: "desk" | "mobile";
}

const NAV_ICON = { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6 } as const;
const NO_MARKS: ReadonlySet<string> = new Set();

export function DayGrid({
  value,
  endValue,
  draftStart,
  today,
  min,
  max,
  marks = NO_MARKS,
  marksLabel,
  onMonthChange,
  onPick,
  allowDragRange = false,
  onDragRange,
  variant,
}: DayGridProps) {
  const weekStart = useUiStore((s) => s.weekStart);
  const [month, setMonth] = useState(() => initialMonth(value, today, min, max));
  /** 鍵盤焦點日（只在 month 裡才有意義；換月時重算） */
  const [focusDay, setFocusDay] = useState(() => focusDayOf(month, value, today, min, max));
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  /** Pointer Drag 跨格選多日之即時預覽 */
  const [dragPreview, setDragPreview] = useState<{ start: string; end: string } | null>(null);
  const dragRef = useRef<{
    active: boolean;
    pointerId: number;
    anchor: string;
    current: string;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const onDragRangeRef = useRef(onDragRange);
  onDragRangeRef.current = onDragRange;
  const boundsRef = useRef({ min, max });
  boundsRef.current = { min, max };
  /** 方向鍵換月後要把真正的 DOM 焦點搬到新格（點箭頭換月時不搬，焦點留在箭頭上） */
  const moveDom = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const monthCb = useRef(onMonthChange);
  monthCb.current = onMonthChange;
  useEffect(() => {
    monthCb.current?.(month);
  }, [month]);

  useEffect(() => {
    if (!moveDom.current) return;
    moveDom.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus({ preventScroll: true });
  }, [focusDay, month]);

  // 停用拖曳或切換狀態時清除殘留拖曳狀態
  useEffect(() => {
    if (!allowDragRange) {
      dragRef.current = null;
      setDragPreview(null);
    }
  }, [allowDragRange]);

  useEffect(() => {
    if (!allowDragRange) return;
    const updateToDay = (dayKey: string | null) => {
      const d = dragRef.current;
      if (!d || !d.active || !dayKey) return;
      const { min: lo, max: hi } = boundsRef.current;
      if (!inRange(dayKey, lo, hi)) return;
      if (dayKey === d.current) return;
      d.current = dayKey;
      if (dayKey !== d.anchor) {
        d.moved = true;
        const norm = normalizeDragRange(d.anchor, dayKey);
        if (norm.end) setDragPreview({ start: norm.start, end: norm.end });
      } else if (d.moved) {
        setDragPreview({ start: d.anchor, end: d.anchor });
      }
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !d.active || e.pointerId !== d.pointerId) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const btn = hit instanceof Element ? hit.closest<HTMLButtonElement>("button[data-day]") : null;
      if (!btn || btn.disabled) return;
      if (gridRef.current && !gridRef.current.contains(btn)) return;
      updateToDay(btn.dataset.day ?? null);
    };
    const finish = (e: PointerEvent, commit: boolean) => {
      const d = dragRef.current;
      if (!d || !d.active || e.pointerId !== d.pointerId) return;
      dragRef.current = null;
      setDragPreview(null);
      if (commit && d.moved && d.current !== d.anchor) {
        const norm = normalizeDragRange(d.anchor, d.current);
        if (norm.end) {
          suppressClickRef.current = true;
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
          onDragRangeRef.current?.(norm.start, norm.end);
        }
      }
    };
    const onUp = (e: PointerEvent) => finish(e, true);
    const onCancel = (e: PointerEvent) => finish(e, false);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [allowDragRange]);

  const startDrag = (key: string, pickable: boolean, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!allowDragRange || !pickable) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragRef.current = { active: true, pointerId: e.pointerId, anchor: key, current: key, moved: false };
    setDragPreview(null);
  };

  const p = variant === "desk" ? "ns-datepick" : "ns-mdatepick";
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const go = (m: string) => {
    setMonth(m);
    setFocusDay(focusDayOf(m, value, today, min, max));
  };
  const rovingDay = monthOfDay(focusDay) === month ? focusDay : focusDayOf(month, value, today, min, max);

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || e.ctrlKey || e.altKey || e.metaKey) return;
    // Space 交給按鈕自己點（keyup 才觸發）；只擋冒泡——外層卡片或大綱的 Space 不該跟著動（磨光⑤ S8）
    if (e.key === " ") {
      e.stopPropagation();
      return;
    }
    const act = gridKeyAction(rovingDay, e.key, min, max);
    if (act === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (act.type === "pick") onPick(act.day);
    else if (act.type === "move") {
      moveDom.current = true;
      if (monthOfDay(act.day) !== month) setMonth(monthOfDay(act.day));
      setFocusDay(act.day);
    }
  };

  const what = marksLabel ?? "有記號";
  const effStart = dragPreview
    ? dragPreview.start
    : draftStart
      ? hoverDay && hoverDay !== draftStart
        ? hoverDay < draftStart
          ? hoverDay
          : draftStart
        : draftStart
      : (value ?? null);
  const effEnd = dragPreview
    ? dragPreview.end !== dragPreview.start
      ? dragPreview.end
      : null
    : draftStart
      ? hoverDay && hoverDay !== draftStart
        ? hoverDay < draftStart
          ? draftStart
          : hoverDay
        : null
      : (endValue ?? null);

  return (
    <div className={`${p}-grid`}>
      <div className={`${p}-gridhead`}>
        <button
          type="button"
          className={`${p}-gridnav`}
          aria-label="上個月"
          title="上個月"
          disabled={!canShowMonth(prev, min, max)}
          onClick={() => go(prev)}
        >
          <svg {...NAV_ICON} aria-hidden>
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <span className={`${p}-gridmonth`} aria-live="polite">
          {monthTitle(month)}
        </span>
        <button
          type="button"
          className={`${p}-gridnav`}
          aria-label="下個月"
          title="下個月"
          disabled={!canShowMonth(next, min, max)}
          onClick={() => go(next)}
        >
          <svg {...NAV_ICON} aria-hidden>
            <path d="m6 3 5 5-5 5" />
          </svg>
        </button>
      </div>
      <div
        ref={gridRef}
        className={`${p}-days${allowDragRange ? " can-drag" : ""}`}
        role="group"
        aria-label={`${monthTitle(month)}，方向鍵移動、Enter 選取`}
        onKeyDown={onGridKey}
        onMouseLeave={() => {
          if (hoverDay !== null) setHoverDay(null);
        }}
      >
        {weekHeads(weekStart).map((w) => (
          <span key={w} className="wd" aria-hidden>
            {w}
          </span>
        ))}
        {monthCells(month, weekStart).map((key, i) => {
          if (!key) return <span key={`b${i}`} className="blank" aria-hidden />;
          const marked = marks.has(key);
          const role = dayRangeRole(key, effStart, effEnd);
          const isSel = role === "single" || role === "start" || role === "end";
          const cls = [
            "day",
            marked && "mk",
            key === today && "today",
            isSel && "sel",
            role === "start" && "range-start",
            role === "end" && "range-end",
            role === "mid" && "in-range",
            draftStart === key && "range-draft",
          ]
            .filter(Boolean)
            .join(" ");
          const n = Number(key.slice(8));
          const pickable = inRange(key, min, max);
          return (
            <button
              key={key}
              type="button"
              className={cls}
              data-day={key}
              tabIndex={key === rovingDay ? 0 : -1}
              disabled={!pickable}
              aria-label={`${Number(key.slice(5, 7))} 月 ${n} 日${key === today ? "，今天" : ""}${marked ? `，${what}` : ""}`}
              aria-pressed={isSel}
              aria-current={key === today ? "date" : undefined}
              onFocus={() => setFocusDay(key)}
              onPointerDown={(e) => startDrag(key, pickable, e)}
              onPointerEnter={() => {
                const d = dragRef.current;
                if (d && d.active && pickable && key !== d.current) {
                  d.current = key;
                  if (key !== d.anchor) {
                    d.moved = true;
                    const norm = normalizeDragRange(d.anchor, key);
                    if (norm.end) setDragPreview({ start: norm.start, end: norm.end });
                  } else if (d.moved) {
                    setDragPreview({ start: d.anchor, end: d.anchor });
                  }
                }
              }}
              onMouseEnter={() => {
                if (draftStart && pickable) setHoverDay(key);
              }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onPick(key);
              }}
            >
              {n}
              {marked && <i className="dot" aria-hidden />}
            </button>
          );
        })}
      </div>
      {marksLabel && (
        <div className={`${p}-gridlegend`} aria-hidden>
          <i className="dot" />
          {marksLabel}
        </div>
      )}
    </div>
  );
}
