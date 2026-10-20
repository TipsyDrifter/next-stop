/**
 * MobileTicketCalendar——售票口手機的月曆視圖（②契約 §5.3【日曆】、0-2 (a)、0-16、0-22、D-票-28；丙席擁有）。
 *
 * 7 欄、格 `button` 高 ≥ 56px：日號左上；有收入的天先一行小字「＋N」（gold-ink），支出一個數在右下
 *   （兩個都走 `cellText(cell, dec, true)`＝compactMoney，≥ 10 萬縮「12.3萬」）；不用金點（D-票-28）。
 * 格值＝store.calendar（`calendarCells`，與清單日分組頭同口徑）；本月外的格只有淡日號。
 * 第③階段（③契約 §5.5、✎-6）：store.overDay 那一格加 `is-over`、日號後小字「超」（墨色，格不上色；一個月最多一格）。
 * 點格＝`jumpToDay`（切清單、捲到那天）。手機的「選中」只是清單那一列亮起：store 的 `select` 會順手開詳情（桌機右側板），
 *   手機那是全螢幕表單、會把剛捲到的清單蓋掉，所以跳完若開了 entry 面板就收起（選取留著）。
 */
import { useRef } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { MAIN_CURRENCY, moneyText } from "../../../domain/ticket";
import { cellText, shortDay, weekdayHeads, type CalendarCell } from "../../../domain/ticketView";
import { useViewSwipe } from "./MobileViewBar";
import { useCalendarTodayFresh } from "../resume";

export function MobileTicketCalendar() {
  const calendar = useTicketStore((s) => s.calendar);
  const overDay = useTicketStore((s) => s.overDay); // 第③階段（✎-6）：本月總預算被超過的那一天
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const weekStart = useUiStore((s) => s.weekStart);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const ref = useRef<HTMLDivElement | null>(null);
  useViewSwipe(ref);
  useCalendarTodayFresh(); // 頁面一直開著跨午夜：回前景時今日格跟上

  const heads = weekdayHeads(weekStart);
  // 週末欄（字稍深）：weekStart 1 ⇒ 末兩欄；0 ⇒ 首尾
  const isWeekend = (i: number) => (weekStart === 1 ? i >= 5 : i === 0 || i === 6);

  const pick = async (day: string) => {
    const st = useTicketStore.getState();
    await st.jumpToDay(day);
    const after = useTicketStore.getState();
    if (after.panel.kind === "entry") after.closePanel();
  };

  return (
    <div className="ns-tk-mcal" ref={ref}>
      <div className="ns-tk-mcal-sheet">
        <div className="ns-tk-mcal-heads" aria-hidden>
          {heads.map((h, i) => (
            <span key={h} className={isWeekend(i) ? "we" : undefined}>
              {h}
            </span>
          ))}
        </div>
        <div className="ns-tk-mcal-grid" role="grid" aria-label="本月每天的收支">
          {calendar === null ? (
            <p className="ns-tk-mcal-wait">正在排月曆…</p>
          ) : (
            calendar.map((week) => (
              <div key={week[0].dayKey} className="ns-tk-mcal-week" role="row">
                {week.map((c) => (
                  <Cell key={c.dayKey} c={c} dec={dec} future={c.dayKey > today} over={c.inMonth && c.dayKey === overDay} onPick={pick} />
                ))}
              </div>
            ))
          )}
        </div>
      </div>
      <p className="ns-tk-mcal-hint">點日期跳回那天的清單</p>
    </div>
  );
}

function Cell({ c, dec, future, over, onPick }: { c: CalendarCell; dec: number; future: boolean; over: boolean; onPick(day: string): void }) {
  const t = c.inMonth ? cellText(c, dec, true) : { expense: "", income: null };
  const d = Number(c.dayKey.slice(8, 10));
  const label =
    shortDay(c.dayKey) +
    (c.count === 0
      ? "：沒有紀錄"
      : `：支出 ${moneyText(c.expense, dec, { whole: true })}${c.income !== 0 ? `、收入 ${moneyText(c.income, dec, { whole: true })}` : ""}`) +
    (c.isToday ? "（今天）" : "") +
    (over ? "；這天超出本月總預算" : "");
  const cls =
    "ns-tk-mcal-cell" +
    (c.inMonth ? "" : " is-out") +
    (c.isToday ? " is-today" : "") +
    (future ? " is-future" : "") +
    (c.count > 0 && c.inMonth ? " has" : "") +
    (over ? " is-over" : "");
  return (
    <button type="button" role="gridcell" className={cls} aria-label={label} onClick={() => onPick(c.dayKey)}>
      <span className="d">
        {d}
        {over && <small className="over">超</small>}
      </span>
      <span className="vals">
        {t.income !== null && <span className="i">{t.income}</span>}
        {t.expense !== "" && <span className="x">{t.expense}</span>}
      </span>
    </button>
  );
}
