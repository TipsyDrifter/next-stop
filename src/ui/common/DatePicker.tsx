/**
 * DatePicker——挑一天的小浮層（桌機；旅客筆記車次② D-筆-30 抽出的共用元件）。
 *
 * 長相＝快選 chip 一排＋原生日期欄（`<input type="date">`），上面一行小標；底子是旅客筆記車次①的 DatePop。
 * 用處：旅客筆記（收件匣「排某天」、筆記「改日期」、日記「跳到哪一天／改日期」）、今日頁推遲小卡的「選日期…」。
 * 手機版是同目錄的 `MobileDatePicker`（底部面板）。
 *
 * 行為：
 *   - 開啟時焦點落在第一顆 chip（沒有 chip 就是日期欄），並把自己捲進視野
 *   - Esc 收起（自理並 stopPropagation，不漏給頁面的鍵盤表）；點外面收起（mousedown capture；
 *     帶 `data-pop-toggle` 的元素除外——那是開關鈕，讓它自己切換，否則會「關了又被它打開」）
 *   - 日期欄：用月曆點選才完整觸發 change；鍵盤逐位輸入會中途觸發，只接受完整、年份 ≥ 1970、落在 min／max 內的值；
 *     Enter 送出目前的值（同一套檢查）
 *   - 日期欄的 keydown 先判 IME 組字（isComposing／keyCode 229）
 * 樣式在 `./datepicker.css`（`.ns-datepick*`，不依賴任何一條線的 class）；呼叫端用 `className` 調位置。
 */
import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import "./datepicker.css";

/** 一顆快選 chip */
export interface DateQuick {
  label: string;
  /** YYYY-MM-DD */
  day: string;
}

export interface DatePickerProps {
  /** 小標（也是 dialog 的 aria-label） */
  label: string;
  /** 目前的日子（日期欄初值；`markValue` 時同日的 chip 亮起）；null／省略＝空 */
  value?: string | null;
  /** YYYY-MM-DD；含 */
  min?: string;
  /** YYYY-MM-DD；含 */
  max?: string;
  /** 快選 chip（例：明天／後天／下週一；今天／昨天／前天） */
  quick?: readonly DateQuick[];
  onPick(day: string): void;
  onClose(): void;
  /** true＝絕對定位的浮動卡（霧面票面，位置由呼叫端的 class 給 top／left）；false＝內嵌在版面裡的一塊 */
  float?: boolean;
  /** true＝與 `value` 同日的 chip 亮起（預設 false） */
  markValue?: boolean;
  /** 加在根節點上的 class（呼叫端調 margin／top／left 用） */
  className?: string;
}

/** "2026-10-05" → "10/5"（chip 小字；不經 Date.parse） */
export function shortDayKey(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return m && d ? `${m}/${d}` : key;
}

/** 日期欄的值能不能當成「選好了」：完整 YYYY-MM-DD、年份 ≥ 1970（逐位輸入會先經過 0002／0020）、落在 min／max 內 */
export function isPickableDay(d: string, min?: string, max?: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number(d.slice(0, 4)) >= 1970 && (!min || d >= min) && (!max || d <= max);
}

/** 點浮層外面就收起；帶 `data-pop-toggle` 的元素（開關鈕）除外 */
function useOutsideDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      const t = e.target;
      if (!el || !(t instanceof Node)) return;
      if (el.contains(t)) return;
      if (t instanceof Element && t.closest("[data-pop-toggle]")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [ref, onClose]);
}

export function DatePicker({
  label,
  value,
  min,
  max,
  quick,
  onPick,
  onClose,
  float = false,
  markValue = false,
  className,
}: DatePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(rootRef, onClose);

  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLElement>("button, input");
    first?.focus({ preventScroll: true });
    rootRef.current?.scrollIntoView({ block: "nearest" }); // 浮層別落在視野外
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const cls = ["ns-datepick", float && "float", className].filter(Boolean).join(" ");
  return (
    <div
      ref={rootRef}
      className={cls}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={float && !quick ? { width: 240 } : undefined}
    >
      <div className="ns-datepick-label">{label}</div>
      <div className="ns-datepick-chips">
        {quick?.map((q) => {
          const on = markValue && value === q.day;
          return (
            <button
              key={q.label}
              type="button"
              className={"ns-datepick-chip" + (on ? " on" : "")}
              aria-pressed={markValue ? on : undefined}
              onClick={() => onPick(q.day)}
            >
              {q.label}
              <span className="sub">{shortDayKey(q.day)}</span>
            </button>
          );
        })}
        <input
          type="date"
          className="ns-datepick-date"
          defaultValue={value ?? ""}
          min={min}
          max={max}
          aria-label="挑日期"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              const v = e.currentTarget.value;
              if (isPickableDay(v, min, max)) onPick(v);
            }
          }}
          onChange={(e) => {
            const v = e.target.value;
            if (isPickableDay(v, min, max) && v !== (value ?? "")) onPick(v);
          }}
        />
      </div>
    </div>
  );
}
