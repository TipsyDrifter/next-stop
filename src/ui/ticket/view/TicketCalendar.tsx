/**
 * TicketCalendar——售票口桌機的月曆視圖（②契約 §5.1【日曆】、0-2、0-16；乙席）。長相照原型 `calendarHtml()`（月曆格 (a)）：
 *
 *   div.ns-tk-cal（一張霧面紙，同 .ns-tk-book）
 *   ├─ .ns-tk-cal-heads   七個週名（weekdayHeads(weekStart)；六日 .we）
 *   └─ .ns-tk-cal-grid.ns-daycells  5–6 列 × 7 格共用 DayCell（div.ns-daycell.ns-tk-calday[.is-out][.is-today][.is-on][.is-future][.is-over]）
 *         日號＝DayCell 的 .ns-daycell-num（今天赭字＋赭菱形）；格內（children）：「超」小牌・.vals：有收入 ⇒ .i「＋2,000」（gold-ink）在上；.x 支出（右下，大字）
 *
 * UI 丙-5 J1：格換共用 DayCell（視覺規範 §2.5「日曆格」：今天＝赭菱形、選中＝--sel-bg，跟行程表同一格）。
 *   金額放 DayCell 的 children 插槽；跟行程表一樣蓋掉格高（92 起）與內距——共用預設 64 放不下日號＋兩行金額。
 *   差異（刻意）：不畫墨點（D-票-28：金額本身就是「有事」）、不給「＋」（新票走頁首／N，月曆的 N 會預填焦點格）。
 *
 * - 格值全部取自 store.calendar（`calendarCells`，與清單日分組頭 `groupByDay` 同口徑）＋ `cellText(cell, 主幣別小數, false)`。
 * - 點格／Enter ⇒ `jumpToDay`（切清單、捲到那一天、選中第一筆）。
 * - 鍵盤焦點格（←→ ∓1 天、↑↓ ∓7 天，useTicketKeyboard 接）存在本檔的小 store `useCalFocus`，畫成 DayCell 的「選中」：
 *   不是帳本狀態（不進 ticketStore），只是這個視圖的游標；月份變了而焦點不在這個月 ⇒ 回到今天（本月）或該月 1 號。
 *   點擊面用 roving tabindex（只有焦點格 0）；焦點已在格上時，方向鍵移游標，DOM 焦點跟著搬（不然焦點環留在舊格）。
 *   滑鼠按下不搶焦點（格線 onMouseDown preventDefault）：焦點留在頁根，點完換到清單，鍵盤表照樣接得到。
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { MAIN_CURRENCY, moneyText, monthOf } from "../../../domain/ticket";
import { cellText, shortDay, weekdayHeads, type CalendarCell } from "../../../domain/ticketView";
import { useCalendarTodayFresh } from "../resume";
import { DayCell } from "../../common/DayCell";

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

  // 游標換格時，DOM 焦點若在格線裡就跟著搬（鍵盤從格上按方向鍵）；焦點不在格線裡（頁根）就不動，不搶焦點
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || focus === null || !grid.contains(document.activeElement)) return;
    grid.querySelector<HTMLElement>(`[data-day="${focus}"] .ns-daycell-hit`)?.focus({ preventScroll: true });
  }, [focus, calendar]);

  const heads = weekdayHeads(weekStart);
  return (
    <div className="ns-tk-cal" role="group" aria-label="月曆">
      <div className="ns-tk-cal-heads" aria-hidden>
        {heads.map((h) => (
          <span key={h} className={h === "六" || h === "日" ? "we" : undefined}>
            {h}
          </span>
        ))}
      </div>
      <div
        ref={gridRef}
        className="ns-tk-cal-grid ns-daycells"
        onMouseDown={(e) => e.preventDefault() /* 焦點留在頁根（鍵盤表接得到）；點了就換頁 */}
      >
        {(calendar ?? []).map((week) =>
          week.map((c) => {
            const t = cellText(c, dec, false);
            const over = c.inMonth && overDay === c.dayKey;
            const cls = "ns-tk-calday" + (c.dayKey > today ? " is-future" : "") + (over ? " is-over" : "");
            return (
              <DayCell
                key={c.dayKey}
                date={c.dayKey}
                today={c.isToday}
                out={!c.inMonth}
                selected={focus === c.dayKey}
                ariaLabel={cellLabel(c, dec) + (c.isToday ? "（今天）" : "") + (over ? "；這天超出當月總預算" : "")}
                tabIndex={focus === c.dayKey ? 0 : -1}
                className={cls}
                onClick={(day) => {
                  useCalFocus.getState().setDay(day);
                  void useTicketStore.getState().jumpToDay(day);
                }}
              >
                {over && <small className="over">超</small>}
                {(t.income || t.expense) && (
                  <span className="vals">
                    {t.income && <span className="i">{t.income}</span>}
                    {t.expense && <span className="x">{t.expense}</span>}
                  </span>
                )}
              </DayCell>
            );
          }),
        )}
      </div>
    </div>
  );
}
