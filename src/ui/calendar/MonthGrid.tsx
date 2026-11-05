/**
 * MonthGrid——月間頁：**一張紙，不是 42 張卡**（M3 ⑤ WP2）。
 *
 * 視覺真相＝prototypes/m3-ext-calendar.html :487-523（`.month-card／.wk-head／.grid`）＋ :1022-1036（render）。
 * 材質（粉彩霧面玻璃＋顆粒／銀河月光票紙）全在 calendar.css，本檔只負責結構與資料。
 * 深面紀律（規格 §6）：月卡用「頁」材質，不開第二塊書封級深面。
 *
 * UI 丙-3 D4：每格換 `CalendarCell`（共用 common/DayCell 外殼；格內「＋」＝開那天的浮層＋草稿列）。
 *
 * 方針擴充（辛 D-主-380）：那天預定到站、還沒到站的車站在日數旁一枚 ◎，點了開車站小卡（小卡的本地 state 在這裡）。週檢視不做。
 *
 * 星期列用控制器的 `weekOrder`（依設定的週首排；預設一…六・日）＋`WEEKDAY_LABEL`（六日＝`.we` 淡），不各算各的（約束表「週起始日」）。
 */
import { useMemo, useRef } from "react";
import { WEEKDAY_LABEL } from "../../domain";
import { compareSiblings } from "../../domain/nodeOrder";
import { stationDayMarks } from "../../domain/weekAims";
import { useNodeStore } from "../../store/nodeStore";
import { useStationCard } from "../weekAims/StationCard";
import { CalendarCell, useAddOutOfTabOrder, useDateDropTargets } from "./CalendarCell";
import { useCalendar } from "./useCalendarController";

const EMPTY_ENTRIES: never[] = [];

export function MonthGrid() {
  const c = useCalendar();
  const gridRef = useRef<HTMLDivElement>(null);
  useAddOutOfTabOrder(gridRef); // 格線只留落點格一個 Tab stop
  useDateDropTargets(gridRef); // 回饋乙：格子是「拖到日期＝改期」的落點
  const stations = useNodeStore((s) => s.stations);
  const allRoutes = useNodeStore((s) => s.routes);
  const stationMarks = useMemo(() => stationDayMarks([...stations].sort(compareSiblings), allRoutes), [stations, allRoutes]);
  const stationCard = useStationCard();
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
        {c.weekOrder.map((d) => (
          <span key={d} className={d === 0 || d === 6 ? "we" : undefined}>
            {WEEKDAY_LABEL[d]}
          </span>
        ))}
      </div>
      <div ref={gridRef} className="grid" role="group" aria-label="月曆">
        {c.days.map((day) => {
          const inRange = day >= c.range.from && day <= c.range.to;
          return (
            <CalendarCell
              key={day}
              day={day}
              inRange={inRange}
              isToday={day === c.today}
              isPast={day < c.today}
              entries={c.byDate.entries[day] ?? EMPTY_ENTRIES}
              dues={c.byDate.dues[day] ?? EMPTY_ENTRIES}
              count={c.byDate.counts[day]}
              nodes={c.nodes}
              routes={c.routes}
              focusable={inRange && day === focusDay}
              open={c.popTarget?.day === day}
              truncate
              onOpen={(anchor) => c.openDay(day, anchor)}
              onAdd={() => c.addOn(day)}
              onTip={(anchor) => (anchor ? c.showTip(day, anchor) : c.hideTip())}
              stationMarks={stationMarks.get(day)}
              onStation={stationCard.open}
            />
          );
        })}
      </div>
      {stationCard.node}
    </div>
  );
}
