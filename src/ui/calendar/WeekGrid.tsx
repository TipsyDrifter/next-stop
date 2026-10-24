/**
 * WeekGrid——週視圖（M3 ⑤ WP4）。
 *
 * ── UI 丙-3 D4：格換成 `CalendarCell`（共用 common/DayCell 外殼）──
 *   下面三條差異照舊，只是 DOM 換了：星期字改掛 `.ns-daycell-num::after`（flex order 排到數字前）、
 *   〆 與月格一樣在格右上的 `.cal-corner`（「＋」左邊），不再轉 grid-template-areas。
 *
 * 鐵律（D-⑤-1 甲，草案 :23／派工「禁止另畫」）：**週＝月格元件換排列**——七欄一列、每欄就是
 * 月視圖那顆格（日數＋路線色點清單＋〆＋今天菱形），與月格的差異**只有三條**：
 *
 *   ① 格高不設 96px 下限，自然撐開（week.css `.wk-row .cell{min-height:0}`）
 *   ② 清單不截斷、不出「＋N」（`truncate={false}`——週的價值就是看全）
 *   ③ `wk-head` 那一列換成欄頭「一 10・二 11…」（線框 :731-765／:925-940 的 `.wd` 語彙，週末淡），
 *      〆 跟著錨到日付標籤旁（線框 :758「無框欄裡角標歸屬會歧義」）
 *
 * 三條差異全部在 week.css 出——`DayCell` 的 DOM 一個字都沒改（它不是本席 own 的檔）：
 *   ③ 的星期字＝ `.ch::before` 的 `content: var(--wd-N)`，N＝欄序；變數由本檔從 `WEEKDAY_LABEL`
 *     寫進 `.wk-row` 的 inline style（CSS 不另抄一份「一二三四五六日」，星期序＝控制器的 `weekOrder`；
 *     週末淡的欄位依 `data-week-start` 換，見 week.css），
 *   ③ 的〆位置＝把 `.cell` 轉成 `grid-template-areas`（`.ch`／`.sime` 同一列、`.items` 第二列），
 *     `.sime` 由 absolute 改 static——DOM 順序不變，位置由格區換。
 *
 * 其餘（點欄開當日清單、〆 hover tip、鍵盤、浮層、‹ ›／今日／PageUp-Down）全部沿用月視圖那一套：
 * 游標／區間／格由 `useCalendarController` 依 `view` 算好（`go` 走 ±7 天、`movePage` 同），本檔不重算。
 */
import { useMemo, useRef, type CSSProperties } from "react";
import { WEEKDAY_LABEL } from "../../domain";
import { CalendarCell, useAddOutOfTabOrder } from "./CalendarCell";
import { useCalendar } from "./useCalendarController";
import "./week.css";

export interface WeekGridProps {
  /** 該週的第一天（週首依設定；YYYY-MM-DD） */
  weekStart: string;
  /** 從週首起的七天 */
  days: string[];
}

const EMPTY_ENTRIES: never[] = [];

/** 允許 `--*` 自訂屬性的 inline style（同 ambience/starfield.ts:22 的慣例） */
type CssVars = CSSProperties & Record<`--${string}`, string>;

/**
 * 欄頭星期字：`--wd-1`…`--wd-7`（含引號，直接餵 CSS `content`）。
 * 順序＝控制器的 `weekOrder`（依設定的週首排；預設一…六・日），與 `wk-head` 同序，不各算各的。
 */
function wdVars(order: readonly number[]): CssVars {
  return order.reduce<CssVars>((vars, dow, i) => {
    vars[`--wd-${i + 1}`] = `"${WEEKDAY_LABEL[dow] ?? ""}"`;
    return vars;
  }, {});
}

export function WeekGrid({ weekStart, days }: WeekGridProps) {
  const c = useCalendar();
  const rowRef = useRef<HTMLDivElement>(null);
  useAddOutOfTabOrder(rowRef); // 格線只留落點格一個 Tab stop
  const WD_VARS = useMemo(() => wdVars(c.weekOrder), [c.weekOrder]);
  // 鍵盤焦點的落點：選取格 →（本週的）今天 → 週首那天（與 MonthGrid 同一套）
  const focusDay =
    c.selectedDay && c.selectedDay >= c.range.from && c.selectedDay <= c.range.to
      ? c.selectedDay
      : c.today >= c.range.from && c.today <= c.range.to
        ? c.today
        : weekStart;

  return (
    <div className="month-card">
      <div
        ref={rowRef}
        className="wk-row"
        role="group"
        aria-label={`${Number(weekStart.slice(5, 7))}月${Number(weekStart.slice(8, 10))}日起的一週`}
        style={WD_VARS}
        data-week-start={c.weekOrder[0]}
      >
        {days.map((day) => {
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
              truncate={false}
              onOpen={(anchor) => c.openDay(day, anchor)}
              onAdd={() => c.addOn(day)}
              onTip={(anchor) => (anchor ? c.showTip(day, anchor) : c.hideTip())}
            />
          );
        })}
      </div>
    </div>
  );
}
