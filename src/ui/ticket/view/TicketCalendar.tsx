/**
 * TicketCalendar——售票口桌機的月曆視圖（②契約 §5.1【日曆】、0-2、0-16；乙席）。長相照原型 `calendarHtml()`（月曆格 (a)）：
 *
 *   div.ns-tk-cal（一張霧面紙，同 .ns-tk-book）
 *   ├─ .ns-tk-cal-heads   七個週名（weekdayHeads(weekStart)；六日 .we）
 *   └─ .ns-tk-cal-grid    5–6 列 × 7 格 button.ns-tk-cal-cell[.is-out][.is-today][.is-future][.is-focus]
 *         .d 日號（今天多一個小字「今天」）・.vals：有收入 ⇒ .i「＋2,000」（gold-ink）在上；.x 支出（右下，大字）
 *
 * - 格值全部取自 store.calendar（`calendarCells`，與清單日分組頭 `groupByDay` 同口徑）＋ `cellText(cell, 主幣別小數, false)`。
 * - 點格／Enter ⇒ `jumpToDay`（切清單、捲到那一天、選中第一筆）。
 * - 鍵盤焦點格 `.is-focus`（←→ ∓1 天、↑↓ ∓7 天，useTicketKeyboard 接）存在本檔的小 store `useCalFocus`：
 *   不是帳本狀態（不進 ticketStore），只是這個視圖的游標；月份變了而焦點不在這個月 ⇒ 回到今天（本月）或該月 1 號。
 */
import { useEffect } from "react";
import { create } from "zustand";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { MAIN_CURRENCY, moneyText, monthOf } from "../../../domain/ticket";
import { cellText, shortDay, weekdayHeads, type CalendarCell } from "../../../domain/ticketView";
import { useCalendarTodayFresh } from "../resume";

/** 月曆的鍵盤游標（只在這個視圖有意義；不持久化） */
export const useCalFocus = create<{ day: string | null; setDay(d: string | null): void }>((set) => ({
  day: null,
  setDay: (day) => set({ day }),
}));

/** 某個月的預設焦點日：今天在這個月 ⇒ 今天；否則 1 號 */
export function defaultFocusDay(month: string, today: string): string {
  return monthOf(today) === month ? today : `${month}-01`;
}

function cellLabel(c: CalendarCell, dec: number): string {
  if (c.count === 0) return `${shortDay(c.dayKey)}：沒有紀錄`;
  const parts = [`支出 ${moneyText(c.expense, dec)}`];
  if (c.income !== 0) parts.push(`收入 ${moneyText(c.income, dec)}`);
  return `${shortDay(c.dayKey)}：${parts.join("、")}`;
}

export function TicketCalendar() {
  const calendar = useTicketStore((s) => s.calendar);
  const month = useTicketStore((s) => s.month);
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const weekStart = useUiStore((s) => s.weekStart);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const focus = useCalFocus((s) => s.day);
  const overDay = useTicketStore((s) => s.overDay); // 第③階段（③契約 §5.4、✎-6）：本月總預算被超過的那一天
  const today = todayKey(dayStartHour);
  useCalendarTodayFresh(); // 頁面一直開著跨午夜：回前景時今日格跟上

  // 換月（[ ]、‹ ›）⇒ 焦點不在這個月就重設
  useEffect(() => {
    const d = useCalFocus.getState().day;
    if (d === null || monthOf(d) !== month) useCalFocus.getState().setDay(defaultFocusDay(month, today));
  }, [month, today]);

  const heads = weekdayHeads(weekStart);
  return (
    <div className="ns-tk-cal" role="grid" aria-label="月曆">
      <div className="ns-tk-cal-heads" role="row">
        {heads.map((h) => (
          <span key={h} role="columnheader" className={h === "六" || h === "日" ? "we" : undefined}>
            {h}
          </span>
        ))}
      </div>
      <div className="ns-tk-cal-grid">
        {(calendar ?? []).map((week) =>
          week.map((c) => {
            const t = cellText(c, dec, false);
            const over = c.inMonth && overDay === c.dayKey;
            const cls =
              "ns-tk-cal-cell" +
              (c.inMonth ? "" : " is-out") +
              (c.isToday ? " is-today" : "") +
              (c.dayKey > today ? " is-future" : "") +
              (focus === c.dayKey ? " is-focus" : "") +
              (over ? " is-over" : "");
            return (
              <button
                key={c.dayKey}
                type="button"
                role="gridcell"
                className={cls}
                aria-label={cellLabel(c, dec) + (over ? "；這天超出本月總預算" : "")}
                aria-current={c.isToday ? "date" : undefined}
                onMouseDown={(e) => e.preventDefault() /* 焦點留在頁根（鍵盤表接得到）；點了就換頁 */}
                onClick={() => {
                  useCalFocus.getState().setDay(c.dayKey);
                  void useTicketStore.getState().jumpToDay(c.dayKey);
                }}
              >
                <span className="d">
                  {Number(c.dayKey.slice(8))}
                  {c.isToday && <small>今天</small>}
                  {over && <small className="over">超</small>}
                </span>
                <span className="vals">
                  {t.income && <span className="i">{t.income}</span>}
                  {t.expense && <span className="x">{t.expense}</span>}
                </span>
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
