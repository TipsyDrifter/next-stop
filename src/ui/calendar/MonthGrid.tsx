/**
 * MonthGrid——月間頁：**一張紙，不是 42 張卡**（M3 ⑤ WP2）。
 *
 * 視覺真相＝prototypes/m3-ext-calendar.html :487-523（`.month-card／.wk-head／.grid`）＋ :1022-1036（render）。
 * 材質（粉彩霧面玻璃＋顆粒／銀河月光票紙）全在 calendar.css，本檔只負責結構與資料。
 * 深面紀律（規格 §6）：月卡用「頁」材質，不開第二塊書封級深面。
 *
 * 星期列用 `WEEKDAY_ORDER`＋`WEEKDAY_LABEL`（一…六・日；六日＝`.we` 淡），不各算各的（約束表「週起始日」）。
 */
import { WEEKDAY_LABEL, WEEKDAY_ORDER } from "../../domain";
import { DayCell } from "./DayCell";
import { useCalendar } from "./useCalendarController";

const EMPTY_ENTRIES: never[] = [];

export function MonthGrid() {
  const c = useCalendar();
  // 鍵盤焦點的落點：選取格 →（本月的）今天 → 本月 1 日
  const focusDay =
    c.selectedDay && c.selectedDay >= c.range.from && c.selectedDay <= c.range.to
      ? c.selectedDay
      : c.today >= c.range.from && c.today <= c.range.to
        ? c.today
        : c.range.from;

  return (
    <div className="month-card">
      <div className="wk-head" aria-hidden>
        {WEEKDAY_ORDER.map((d) => (
          <span key={d} className={d === 0 || d === 6 ? "we" : undefined}>
            {WEEKDAY_LABEL[d]}
          </span>
        ))}
      </div>
      <div className="grid" role="grid" aria-label="月曆">
        {c.days.map((day) => {
          const inRange = day >= c.range.from && day <= c.range.to;
          return (
            <DayCell
              key={day}
              day={day}
              inRange={inRange}
              isToday={day === c.today}
              entries={c.byDate.entries[day] ?? EMPTY_ENTRIES}
              dues={c.byDate.dues[day] ?? EMPTY_ENTRIES}
              count={c.byDate.counts[day]}
              nodes={c.nodes}
              routes={c.routes}
              selected={inRange && day === focusDay}
              truncate
              onOpen={(anchor) => c.openDay(day, anchor)}
              onTip={(anchor) => (anchor ? c.showTip(day, anchor) : c.hideTip())}
            />
          );
        })}
      </div>
    </div>
  );
}
