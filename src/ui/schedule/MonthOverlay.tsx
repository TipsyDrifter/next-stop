/**
 * MonthOverlay——手機行程表的月曆覆蓋層（主線車次①；契約 §4.4「月曆覆蓋層」、原型 :572-613／:1567-1621）。
 *
 * 蓋在串流之上（`position:absolute; inset:0` 於 `.m-sch-main`）：暗幕＋從上滑下的面板（星期字 ×7 ＋ 35／42 格）。
 * 開著時週條收合、‹ › 出現在月份鈕右邊翻月（那兩顆在 WeekStrip，月份狀態在 MobileSchedule）；本檔只畫格子。
 * 格：今天＝靛菱形＋靛內環（P7）、選中（focusDay）＝靛內框、月外 .is-out 0.32、過去字淡；點與〆同週條（`DayDots`）。
 * 點日 ⇒ onPick（父層關覆蓋層、120ms 後 requestScroll）；點暗幕／Esc ⇒ onClose。
 * 元素常駐（開合靠 .is-open 的 visibility／transform 過場），`aria-hidden` 關著時為 true。
 */
import { useEffect, useMemo } from "react";
import { WEEKDAY_LABEL } from "../../domain";
import { addDays } from "../../lib/date";
import { dateOf, weekStart, weekdayOrderOf } from "../calendar/useCalendarController";
import { DayDots, dayAria, type DayMark } from "./WeekStrip";

export interface MonthOverlayProps {
  open: boolean;
  /** 顯示的年月（m＝0 起） */
  year: number;
  month: number;
  today: string;
  focusDay: string;
  firstDow: number;
  marks: ReadonlyMap<string, DayMark>;
  onPick(day: string): void;
  onClose(): void;
}

/** 該月的格子（35 或 42 格；第六列全在月外就不畫，原型 :1574） */
export function monthCells(year: number, month: number, firstDow: number): { key: string; out: boolean }[] {
  const first = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const start = weekStart(first, firstDow);
  const out: { key: string; out: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const k = addDays(start, i);
    const isOut = dateOf(k).getMonth() !== month;
    if (i >= 35 && isOut) break;
    out.push({ key: k, out: isOut });
  }
  return out;
}

export function MonthOverlay({ open, year, month, today, focusDay, firstDow, marks, onPick, onClose }: MonthOverlayProps) {
  const cells = useMemo(() => monthCells(year, month, firstDow), [year, month, firstDow]);
  const order = useMemo(() => weekdayOrderOf(firstDow), [firstDow]);

  // Esc 關覆蓋層（IME 護欄照鐵則 6）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className={"m-sch-cal" + (open ? " is-open" : "")} aria-hidden={!open}>
      <div className="m-sch-cal-veil" role="presentation" onClick={onClose} />
      <div className="m-sch-cal-panel" role="dialog" aria-modal={open || undefined} aria-label={`${month + 1}月・${year} 月曆`}>
        <div className="m-sch-cal-dow" aria-hidden>
          {order.map((dow) => (
            <span key={dow}>{WEEKDAY_LABEL[dow]}</span>
          ))}
        </div>
        <div className="m-sch-cal-grid">
          {cells.map(({ key, out }) => {
            const d = dateOf(key);
            return (
              <button
                key={key}
                type="button"
                className={
                  "m-sch-cal-d" +
                  (key === today ? " is-today" : "") +
                  (out ? " is-out" : "") +
                  (key < today ? " is-past" : "") +
                  (key === focusDay ? " is-sel" : "")
                }
                aria-label={dayAria(key)}
                aria-current={key === focusDay ? "date" : undefined}
                tabIndex={open ? 0 : -1}
                onClick={() => onPick(key)}
              >
                <span className="m-sch-cal-n">
                  <b>{d.getDate()}</b>
                </span>
                <DayDots mark={marks.get(key)} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
