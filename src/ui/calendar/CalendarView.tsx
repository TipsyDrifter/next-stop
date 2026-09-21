/**
 * CalendarView——日曆視圖（UI Flow ⑤；M3 ⑤ WP2）。結構與 class 逐字移植自
 *   prototypes/m3-ext-calendar.html（頁首 :879-915、月卡 :917-923、頁尾 :942-945）。
 * 兩主題共用同一份 DOM，文案差異用 .theme-pastel-only／.theme-galaxy-only 兩份都畫、CSS 擇一顯示。
 *
 * 版面（由上而下）：
 *   header.day（overline 兩份文案／date-line「9月・2026年・September」＋頁邊手寫／月統計／
 *     cal-ctl ‹ › 今日 seg／日付印 92px -6°＝Q8）
 *   → 月卡一張紙（MonthGrid：wk-head ＋ 35／42 格）／週視圖（WeekGrid，WP4）
 *   → page-foot
 *
 * 頁面殼契約（沿 TodayView 的 WP0 慣例）：根節點帶 `.page`（z-index 蓋過 SkyLayer）與 `.ns-calendar`
 *   （CSS 前綴，權重抬一級，避免被 techo.css 同權重蓋掉；雷區 4）；星空由 App.tsx 統一掛
 *   （非今日頁＝density "reduced"，日曆頁無流星無列車，決策 10／氛11），本檔不碰。
 *
 * 插槽（Wave C 三席只填自己的檔，不改契約，詳見各檔檔頭）：
 *   `DayPopover`（WP3）＝當日清單兩段，`popTarget` 非 null 時掛載
 *   `WeekGrid`（WP4）＝週視圖，`view==="week"` 時掛載
 *   `DueTip`／`MonthHeaderNotes`（WP5）＝〆 hover 明細／頁邊手寫＋統計列
 *   `MonthJump`（⑤-b 追加 1）＝月／年快速跳轉小卡，`jumpOpen` 時掛載；入口＝date-line 的月份大字鈕
 * 資料一律經 `useCalendar()`（＝`useCalendarController` 的 context），不各自查 store。
 */
import { useRef } from "react";
import { addDays } from "../../lib/date";
import { DateSeal } from "../stamps";
import { DayPopover } from "./DayPopover";
import { DueTip } from "./DueTip";
import { MonthGrid } from "./MonthGrid";
import { MonthHeaderNotes } from "./MonthHeaderNotes";
import { MonthJump } from "./MonthJump";
import { WeekGrid } from "./WeekGrid";
import { CalendarProvider, dateOf, useCalendarController } from "./useCalendarController";
import { useCalendarKeyboard } from "./useCalendarKeyboard";
import "./calendar.css";

const MONTH_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * 週視圖頁首的三段文字（主人拍板 ⑤-c：週視圖頁首大字＝該週日期區間，不再寫週一所在的月）。
 *   同月   `9月7日 – 13日`／`2026年`／`Sep 7 – 13`
 *   跨月   `4月26日 – 5月2日`／`2027年`／`Apr 26 – May 2`
 *   跨年   `12月28日 – 1月3日`／`2026年 – 2027年`／`Dec 28 – Jan 3`
 *          （跨年只在年份欄標兩個年份——大字維持「M月D日 – M月D日」一種形狀，不另生一套格式）
 * 月視圖不走這裡（維持「9月・2026年・September」）。
 */
export function weekHeading(weekStartKey: string): { d: string; w: string; latin: string } {
  const a = dateOf(weekStartKey);
  const b = dateOf(addDays(weekStartKey, 6));
  const sameYear = a.getFullYear() === b.getFullYear();
  const sameMonth = sameYear && a.getMonth() === b.getMonth();
  const abbr = (d: Date) => MONTH_EN[d.getMonth()].slice(0, 3);
  return {
    d: sameMonth
      ? `${a.getMonth() + 1}月${a.getDate()}日 – ${b.getDate()}日`
      : `${a.getMonth() + 1}月${a.getDate()}日 – ${b.getMonth() + 1}月${b.getDate()}日`,
    w: sameYear ? `${a.getFullYear()}年` : `${a.getFullYear()}年 – ${b.getFullYear()}年`,
    latin: sameMonth
      ? `${abbr(a)} ${a.getDate()} – ${b.getDate()}`
      : `${abbr(a)} ${a.getDate()} – ${abbr(b)} ${b.getDate()}`,
  };
}

export function CalendarView() {
  const containerRef = useRef<HTMLElement>(null);
  const c = useCalendarController(containerRef);
  const onKeyDown = useCalendarKeyboard(c.keys, c.blocked);

  const cur = dateOf(c.cursor);
  const monthEn = MONTH_EN[cur.getMonth()];
  // 頁首三段：月視圖＝月／年／英文月名；週視圖＝日期區間／年／latin 區間（大字仍是 MonthJump 的觸發鈕，
  // 小卡的「目前月」照舊由 cursor（週視圖＝該週週一）決定，契約不動）
  const week = c.view === "week" ? weekHeading(c.cursor) : null;

  return (
    <section
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      // 捲動即關浮層（技術自決；原型的浮層是 fixed、不跟捲動）
      onScroll={() => {
        if (c.popTarget) c.closeDay();
        if (c.tipTarget) c.hideTip();
      }}
      aria-label="日曆"
      className="page ns-calendar"
    >
      <CalendarProvider value={c}>
        <div className="sheet">
          {/* ═══ 頁首（原型 header.day :879-915） ═══ */}
          <header className="day">
            <div className="day-head">
              <p className="overline">
                <span className="theme-pastel-only">Calendar</span>
                <span className="theme-galaxy-only">日曆 — CALENDAR</span>
              </p>
              <div className="date-line">
                {/* 月份大字＝月／年快速跳轉的入口（⑤-b 追加 1）。無邊框、hover 才現底，
                    字本身的排版與位置與改鈕之前一模一樣（底色走 ::before，不佔版面） */}
                <button
                  type="button"
                  className="mj-trigger"
                  aria-label="跳到其他月份"
                  aria-haspopup="dialog"
                  aria-expanded={c.jumpOpen}
                  title="跳到其他月份（Ctrl+←→ 換月・Ctrl+↑↓ 換年）"
                  onClick={(e) => (c.jumpOpen ? c.closeJump() : c.openJump(e.currentTarget))}
                >
                  <span className="d">{week ? week.d : `${cur.getMonth() + 1}月`}</span>
                  <span className="w">{week ? week.w : `${cur.getFullYear()}年`}</span>
                </button>
                <span className="latin">{week ? week.latin : monthEn}</span>
                {/* 頁邊手寫＋統計列（WP5 覆蓋；.month-stats 由 CSS 換到下一行） */}
                <MonthHeaderNotes range={c.range} today={c.today} />
              </div>

              <div className="cal-ctl">
                <button
                  type="button"
                  className="chev"
                  title={c.view === "month" ? "上個月" : "上一週"}
                  aria-label={c.view === "month" ? "上個月" : "上一週"}
                  onClick={() => c.go(-1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="chev"
                  title={c.view === "month" ? "下個月" : "下一週"}
                  aria-label={c.view === "month" ? "下個月" : "下一週"}
                  onClick={() => c.go(1)}
                >
                  ›
                </button>
                <button
                  type="button"
                  className="today-chip"
                  title="跳回今天所在的月份（Home）"
                  onClick={c.goToday}
                >
                  今日
                </button>
                <span className="gap" />
                <div className="seg" role="group" aria-label="視圖切換">
                  <button
                    type="button"
                    className={c.view === "month" ? "on" : undefined}
                    aria-pressed={c.view === "month"}
                    title="月視圖"
                    onClick={() => c.setView("month")}
                  >
                    月
                  </button>
                  <button
                    type="button"
                    className={c.view === "week" ? "on" : undefined}
                    aria-pressed={c.view === "week"}
                    title="週視圖"
                    onClick={() => c.setView("week")}
                  >
                    週
                  </button>
                </div>
              </div>
            </div>

            {/* 日付印一枚示意（92px＝Q8、-6°＝原型 :485；每格日付印不做＝D-⑤-5-1） */}
            <DateSeal
              className="date-stamp"
              date={dateOf(c.today)}
              size={92}
              rotate={-6}
              title={`日付印 ${c.today}`}
            />
          </header>

          {/* ═══ 月間頁／週視圖 ═══ */}
          {c.view === "week" ? <WeekGrid weekStart={c.cursor} days={c.days} /> : <MonthGrid />}

          <footer className="page-foot">
            <span>私鐵手帳・日曆</span>
            <span className="fr">
              {monthEn} {cur.getFullYear()}
            </span>
          </footer>
        </div>

        {/* 當日清單浮層（WP3 填內容；WP2 是空殼，事件已接） */}
        {c.popTarget && (
          <DayPopover day={c.popTarget.day} anchor={c.popTarget.anchor} onClose={c.closeDay} />
        )}
        {/* 〆 hover 明細（WP5 填內容） */}
        {c.tipTarget && <DueTip day={c.tipTarget.day} anchor={c.tipTarget.anchor} />}
        {/* 月／年快速跳轉小卡（⑤-b 追加 1；錨＝上面那顆月份大字鈕） */}
        {c.jumpOpen && <MonthJump anchor={c.jumpAnchor} />}
      </CalendarProvider>
    </section>
  );
}
