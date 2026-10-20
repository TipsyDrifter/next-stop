/**
 * DatePicker——挑一天的小浮層（桌機；旅客筆記車次② D-筆-30 抽出的共用元件）。
 *
 * 長相＝快選 chip 一排＋原生日期欄（`<input type="date">`），上面一行小標；底子是旅客筆記車次①的 DatePop。
 * 給了 `marks`（旅客筆記車次③ 0-6 甲、D-筆-46 修訂）⇒ 原生日期欄換成自畫月格 `DayGrid`（可換月、有記號的日子下方朱點、今天外框）；
 * 沒給＝原生欄照舊（今日頁推遲小卡不傳，行為零變）。
 * 用處：旅客筆記（收件匣「排某天」、筆記「改日期」、日記「跳到哪一天／改日期」——日記兩處傳 marks）、今日頁推遲小卡的「選日期…」。
 * 手機版是同目錄的 `MobileDatePicker`（底部面板）。
 *
 * 行為：
 *   - 開啟時焦點落在第一顆 chip（沒有 chip 就是日期欄），並把自己捲進視野
 *   - Esc 收起（自理並 stopPropagation，不漏給頁面的鍵盤表）；點外面收起（mousedown capture；
 *     帶 `data-pop-toggle` 的元素除外——那是開關鈕，讓它自己切換，否則會「關了又被它打開」）
 *   - 日期欄（D-主-36；判斷邏輯在 `datePickRules.ts`）：月曆點選造成的 change 立即送出；鍵盤造成的 change
 *     （數字、↑↓、Backspace／Delete）**不送**——打到一半湊出的合法日期不算選好了。Enter：值合格（完整、年 ≥ 1970、
 *     在 min／max 內）⇒ 送出；不合格 ⇒ 還原成開啟時的值＋欄下一行小字（下一次輸入時消失）。失焦／點外面關閉＝不送出
 *   - 日期欄的 keydown 先判 IME 組字（isComposing／keyCode 229）
 * 樣式在 `./datepicker.css`（`.ns-datepick*`，不依賴任何一條線的 class）；呼叫端用 `className` 調位置。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { DayGrid } from "./DayGrid";
import { isDateEditKey, isPickableDay, resolveDateEnter, shouldPickOnChange } from "./datePickRules";
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
  /** 有記號的日子（YYYY-MM-DD）；**有給才畫自製月格**取代原生日期欄（D-筆-46 修訂） */
  marks?: ReadonlySet<string>;
  /** 月格掛上時一次、之後每次換月：YYYY-MM（呼叫端補查那個月的記號；沒給就只有呼叫端原本給的那些） */
  onMonthChange?(month: string): void;
  /** 記號的意思（月格下的圖例與讀屏字，例「寫過日記」） */
  marksLabel?: string;
  /** 今天（月格的外框）；省略＝依 uiStore.dayStartHour 算的今天 */
  today?: string;
}

/** "2026-10-05" → "10/5"（chip 小字；不經 Date.parse） */
export function shortDayKey(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return m && d ? `${m}/${d}` : key;
}

export { isPickableDay };

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
  marks,
  onMonthChange,
  marksLabel,
  today,
}: DatePickerProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const rootRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(rootRef, onClose);
  /** 最近一次 change 是鍵盤造成的（keydown 設、keyup／失焦／滑鼠按下清；change 在兩者之間同步發生） */
  const typingRef = useRef(false);
  /** Enter 不合格時欄下那一行小字；下一次輸入即消失 */
  const [hint, setHint] = useState<string | null>(null);

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
      style={float && !quick && !marks ? { width: 240 } : undefined}
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
        {!marks && (
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
                const out = resolveDateEnter(e.currentTarget.value, min, max);
                if (out.kind === "pick") onPick(out.day);
                else {
                  e.currentTarget.value = value ?? ""; // 還原成開啟時的值（defaultValue 那個）
                  setHint(out.hint);
                }
                return;
              }
              if (isDateEditKey(e.key, e.altKey)) {
                typingRef.current = true;
                setHint(null);
              }
            }}
            onKeyUp={() => {
              typingRef.current = false;
            }}
            onBlur={() => {
              typingRef.current = false;
            }}
            onMouseDown={() => {
              typingRef.current = false;
            }}
            onChange={(e) => {
              // 鍵盤造成的 change 只更新欄位本身；月曆點選才在這裡送出
              if (shouldPickOnChange(e.target.value, typingRef.current, value ?? "", min, max)) onPick(e.target.value);
            }}
          />
        )}
      </div>
      {!marks && hint && (
        <div className="ns-datepick-hint" role="status">
          {hint}
        </div>
      )}
      {marks && (
        <DayGrid
          variant="desk"
          value={value}
          today={today ?? todayKey(dayStartHour)}
          min={min}
          max={max}
          marks={marks}
          marksLabel={marksLabel}
          onMonthChange={onMonthChange}
          onPick={onPick}
        />
      )}
    </div>
  );
}
