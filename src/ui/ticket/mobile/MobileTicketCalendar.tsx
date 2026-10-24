/**
 * MobileTicketCalendar——售票口手機的月曆視圖（②契約 §5.3【日曆】、0-2 (a)、0-16、0-22、D-票-28；丙席擁有）。
 *
 * 7 欄、格高 ≥ 58px：日號左上；有收入的天先一行小字「＋N」（gold-ink），支出一個數在右下
 *   （兩個都走 `cellText(cell, dec, true)`＝compactMoney，≥ 10 萬縮「12.3萬」）；不用金點（D-票-28）。
 * UI 丙-5 J1：格換共用 DayCell（視覺規範 §2.5：今天＝赭字＋赭菱形，跟行程表同一格）；金額放 children 插槽。
 *   跟行程表一樣蓋掉格高與內距（共用預設 64 高、左右各 8——375 寬每格約 50px，內容只剩 33px，放不下「1,280」）；
 *   不畫墨點、不給「＋」（同桌機）。窄格的 container query 只挪「＋」與墨點，這裡兩樣都沒有，不受影響。
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
import { DayCell } from "../../common/DayCell";

export function MobileTicketCalendar() {
  const calendar = useTicketStore((s) => s.calendar);
  const month = useTicketStore((s) => s.month);
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
        {calendar === null ? (
          <p className="ns-tk-mcal-wait">正在排月曆…</p>
        ) : (
          <div className="ns-tk-mcal-grid ns-daycells" role="group" aria-label={`${Number(month.slice(5, 7))}月每天的收支`}>
            {calendar.flatMap((week) =>
              week.map((c) => (
                <Cell key={c.dayKey} c={c} dec={dec} future={c.dayKey > today} over={c.inMonth && c.dayKey === overDay} onPick={pick} />
              )),
            )}
          </div>
        )}
      </div>
      <p className="ns-tk-mcal-hint">點日期跳回那天的清單</p>
    </div>
  );
}

function Cell({ c, dec, future, over, onPick }: { c: CalendarCell; dec: number; future: boolean; over: boolean; onPick(day: string): void }) {
  const t = c.inMonth ? cellText(c, dec, true) : { expense: "", income: null };
  const label =
    shortDay(c.dayKey) +
    (c.count === 0
      ? "：沒有紀錄"
      : `：支出 ${moneyText(c.expense, dec, { whole: true })}${c.income !== 0 ? `、收入 ${moneyText(c.income, dec, { whole: true })}` : ""}`) +
    (c.isToday ? "（今天）" : "") +
    (over ? "；這天超出當月總預算" : "");
  const cls = "ns-tk-mcalday" + (future ? " is-future" : "") + (over ? " is-over" : "");
  return (
    <DayCell date={c.dayKey} today={c.isToday} out={!c.inMonth} ariaLabel={label} className={cls} onClick={onPick}>
      {over && <small className="over">超</small>}
      {(t.income !== null || t.expense !== "") && (
        <span className="vals">
          {t.income !== null && <span className="i">{t.income}</span>}
          {t.expense !== "" && <span className="x">{t.expense}</span>}
        </span>
      )}
    </DayCell>
  );
}
