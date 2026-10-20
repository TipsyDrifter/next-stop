/**
 * DayGrid——共用日期挑選器的「自畫月格」（旅客筆記車次③ 0-6 甲、D-筆-46 修訂；示意＝prototypes/旅客筆記-日記選日期-參考圖.html「大日期的挑選器」）。
 *
 * 只在呼叫端傳了 `marks` 時由 `DatePicker`（桌機）／`MobileDatePicker`（手機）畫，取代原生日期欄；沒傳＝原生欄照舊（今日頁推遲零變）。
 *
 *   月份列：‹ 上個月 「2026 年 10 月」 下個月 ›（整個月都在 min／max 外的那一邊反灰）
 *   欄頭＋42 格（6 列固定，換月不跳高）：週首讀 uiStore.weekStart
 *   格：`marks` 裡的日＝數字下方一枚朱點（--color-seal）、今天＝外框、`value`＝底色、min／max 外＝反灰不可點
 *   圖例（給了 `marksLabel` 才畫）：「• 寫過日記」
 *
 * 鍵盤（只在格上；roving tabindex，Tab 進出整張格只停一次）：←→ ±1 天、↑↓ ±7 天、PageUp／PageDown ±1 月、Home／End 月初／月底、
 * Enter／Space＝按鈕本身。越過月界自動換月。處理過的鍵 preventDefault＋stopPropagation，不漏給頁面的鍵盤表。
 *
 * `onMonthChange(month)`：**掛上時呼叫一次**（開啟時那個月）、之後每次換月再呼叫——呼叫端據此補查那個月的記號。
 *
 * 樣式在 `./datepicker.css`：桌機 `.ns-datepick-grid*`、手機 `.ns-mdatepick-grid*`（掛 `[data-shell="mobile"]`）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useUiStore } from "../../store/uiStore";
import {
  canShowMonth,
  focusDayOf,
  initialMonth,
  inRange,
  monthCells,
  monthOfDay,
  monthTitle,
  moveFocus,
  shiftMonth,
  weekHeads,
} from "./monthGridMath";

export interface DayGridProps {
  /** 目前的日子（底色）；null／省略＝沒有 */
  value?: string | null;
  /** 今天（外框；也決定沒有 value 時開在哪個月） */
  today: string;
  min?: string;
  max?: string;
  /** 有記號的日子（YYYY-MM-DD） */
  marks: ReadonlySet<string>;
  /** 記號的意思（圖例字與每格的讀屏字，例「寫過日記」）；省略＝不畫圖例、讀屏念「有記號」 */
  marksLabel?: string;
  /** 掛上時一次、之後每次換月：YYYY-MM */
  onMonthChange?(month: string): void;
  onPick(day: string): void;
  /** desk＝桌機小浮層裡（.ns-datepick-grid*）；mobile＝手機底部面板裡（.ns-mdatepick-grid*，格高 44px） */
  variant: "desk" | "mobile";
}

const NAV_ICON = { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6 } as const;

export function DayGrid({ value, today, min, max, marks, marksLabel, onMonthChange, onPick, variant }: DayGridProps) {
  const weekStart = useUiStore((s) => s.weekStart);
  const [month, setMonth] = useState(() => initialMonth(value, today, min, max));
  /** 鍵盤焦點日（只在 month 裡才有意義；換月時重算） */
  const [focusDay, setFocusDay] = useState(() => focusDayOf(month, value, today, min, max));
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
    const to = moveFocus(rovingDay, e.key, min, max);
    if (to === null) {
      // 認得的鍵但走不動（到邊界）也吃掉，免得方向鍵捲動頁面或被頁面鍵盤表當成上下選取
      if (/^(Arrow|Page|Home$|End$)/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    moveDom.current = true;
    if (monthOfDay(to) !== month) setMonth(monthOfDay(to));
    setFocusDay(to);
  };

  const what = marksLabel ?? "有記號";
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
        className={`${p}-days`}
        role="group"
        aria-label={`${monthTitle(month)}，方向鍵移動、Enter 選取`}
        onKeyDown={onGridKey}
      >
        {weekHeads(weekStart).map((w) => (
          <span key={w} className="wd" aria-hidden>
            {w}
          </span>
        ))}
        {monthCells(month, weekStart).map((key, i) => {
          if (!key) return <span key={`b${i}`} className="blank" aria-hidden />;
          const marked = marks.has(key);
          const cls = ["day", marked && "mk", key === today && "today", key === value && "sel"].filter(Boolean).join(" ");
          const n = Number(key.slice(8));
          return (
            <button
              key={key}
              type="button"
              className={cls}
              data-day={key}
              tabIndex={key === rovingDay ? 0 : -1}
              disabled={!inRange(key, min, max)}
              aria-label={`${Number(key.slice(5, 7))} 月 ${n} 日${key === today ? "，今天" : ""}${marked ? `，${what}` : ""}`}
              aria-pressed={key === value}
              aria-current={key === today ? "date" : undefined}
              onFocus={() => setFocusDay(key)}
              onClick={() => onPick(key)}
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
