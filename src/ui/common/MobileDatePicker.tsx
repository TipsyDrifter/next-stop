/**
 * MobileDatePicker——手機的「挑一天」底部面板（旅客筆記車次② D-筆-30 抽出的共用元件；桌機版＝同目錄 `DatePicker`）。
 * 底子是旅客筆記車次①的 MobileDatePick。
 *
 * 長相：拉柄＋標題（虛線底）＋快選 chip 一排（與 `value` 同日的亮起）＋「指定日期」原生日期欄＋整寬「取消」。
 * 給了 `marks`（旅客筆記車次③ 0-6 甲、D-筆-46 修訂：「手機版同一套」）⇒ 原生日期欄換成自畫月格 `DayGrid`（格高 44px）；
 * 沒給＝原生欄照舊。
 * 為什麼是底部面板而不是錨定小浮層：拇指按得到、暗幕點哪都關得掉；「取消」是清清楚楚的一格。
 * 以 portal 掛到 body：從 `.m-page`（z-index 1 的疊放脈絡）裡開的時候，不搬出去的話 fixed 暗幕再高的 z-index
 * 也蓋不過 tab bar。`[data-shell="mobile"]` 也掛在 <html> 上，所以樣式選擇器照樣命中。
 * 樣式在 `./datepicker.css`（`.ns-mdatepick*`，每條掛 `[data-shell="mobile"]`；不依賴任何一條線的 class）。
 */
import { createPortal } from "react-dom";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { isPickableDay, shortDayKey, type DateQuick } from "./DatePicker";
import { DayGrid } from "./DayGrid";
import "./datepicker.css";

export type { DateQuick } from "./DatePicker";

export interface MobileDatePickerProps {
  /** 面板標題（也是 dialog 的 aria-label） */
  title: string;
  /** 目前的值（同日的 chip 亮起；不在 chip 裡＝日期欄預填並亮起）；null＝沒有 */
  value: string | null;
  /** YYYY-MM-DD；含 */
  min?: string;
  /** YYYY-MM-DD；含 */
  max?: string;
  quick: readonly DateQuick[];
  onPick(day: string): void;
  onClose(): void;
  /** 日期欄前的小字（預設「指定日期」） */
  fieldLabel?: string;
  /** 有記號的日子（YYYY-MM-DD）；**有給才畫自製月格**取代原生日期欄（D-筆-46 修訂） */
  marks?: ReadonlySet<string>;
  /** 月格掛上時一次、之後每次換月：YYYY-MM（呼叫端補查那個月的記號） */
  onMonthChange?(month: string): void;
  /** 記號的意思（月格下的圖例與讀屏字，例「寫過日記」） */
  marksLabel?: string;
  /** 今天（月格的外框）；省略＝依 uiStore.dayStartHour 算的今天 */
  today?: string;
}

export function MobileDatePicker({
  title,
  value,
  min,
  max,
  quick,
  onPick,
  onClose,
  fieldLabel = "指定日期",
  marks,
  onMonthChange,
  marksLabel,
  today,
}: MobileDatePickerProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const custom = value !== null && !quick.some((q) => q.day === value);
  return createPortal(
    <div className="ns-mdatepick-veil" role="presentation" onClick={onClose}>
      <div
        className="ns-mdatepick"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ns-mdatepick-grip" aria-hidden />
        <p className="ns-mdatepick-title">{title}</p>
        <div className="ns-mdatepick-body">
          <div className="ns-mdatepick-chips">
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                className={"ns-mdatepick-chip" + (value === q.day ? " on" : "")}
                aria-pressed={value === q.day}
                onClick={() => onPick(q.day)}
              >
                {q.label}
                <span className="sub">{shortDayKey(q.day)}</span>
              </button>
            ))}
          </div>
          {marks ? (
            <DayGrid
              variant="mobile"
              value={value}
              today={today ?? todayKey(dayStartHour)}
              min={min}
              max={max}
              marks={marks}
              marksLabel={marksLabel}
              onMonthChange={onMonthChange}
              onPick={onPick}
            />
          ) : (
            <label className="ns-mdatepick-field">
              <span className="lab">{fieldLabel}</span>
              <input
                type="date"
                className={"ns-mdatepick-date" + (custom ? " on" : "")}
                value={custom && value ? value : ""}
                min={min}
                max={max}
                onChange={(e) => {
                  const v = e.target.value;
                  if (isPickableDay(v, min, max)) onPick(v);
                }}
              />
            </label>
          )}
        </div>
        <button type="button" className="ns-mdatepick-cancel" onClick={onClose}>
          取消
        </button>
      </div>
    </div>,
    document.body,
  );
}
