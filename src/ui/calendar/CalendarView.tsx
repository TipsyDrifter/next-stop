/**
 * CalendarView——日曆視圖（UI Flow ⑤；M3 ⑤ WP2）。結構與 class 逐字移植自
 *   prototypes/m3-ext-calendar.html（頁首 :879-915、月卡 :917-923、頁尾 :942-945）。
 *
 * ── UI 丙-3（契約 §1 D1～D4、§5 P4）：頁首換共用 PageHeader 身分式 ──
 *   眉標 {行程表, Schedule}・大標＝DateNav（« ‹ 月份／週區間 › » ＋「今天」；« » 只在月、週；標題點開 MonthJump）・
 *   補述＝年份＋拉丁小字＋（粉彩）頁邊手寫・統計列＝MonthStats（串流不畫）・日付印 92 -6°・
 *   工具列［分頁籤 月／週／時段／串流］［＋ 車票］［搜尋］，第四格空著（行程表沒有線內管理）。
 *   「＋ 車票」（P4＝B 底端）：月／週／時段＝開今天的日浮層、底端草稿列已聚焦（在別的月份先回本月）；串流＝今天的日列草稿。
 *   空狀態（D3）：載入完、整個區間沒有班次也沒有締切 ⇒ 內容區中央一張 EmptyState，頁首「＋ 車票」藏起來（規範 §2.7）。
 *   舊 header.day／.cal-ctl／.seg／.mj-trigger 一併退役。
 *
 * 版面（由上而下）：PageHeader → 月卡一張紙（MonthGrid）／週（WeekGrid）／時段（WeekTimeGrid）／串流（StreamView）→ page-foot
 *
 * 頁面殼契約（沿 TodayView 的 WP0 慣例）：根節點帶 `.page`（z-index 蓋過 SkyLayer）與 `.ns-calendar`
 *   （CSS 前綴，權重抬一級，避免被 techo.css 同權重蓋掉；雷區 4）；星空由 App.tsx 統一掛
 *   （非今日頁＝density "reduced"，日曆頁無流星無列車，決策 10／氛11），本檔不碰。
 *
 * 插槽（Wave C 三席只填自己的檔，不改契約，詳見各檔檔頭）：
 *   `DayPopover`（WP3）＝當日清單兩段，`popTarget` 非 null 時掛載（`popTarget.draft`＝底端草稿列開著）
 *   `WeekGrid`（WP4）＝週視圖，`view==="week"` 時掛載
 *   `DueTip`／`MonthMarginNote`／`MonthStats`（WP5）＝〆 hover 明細／頁邊手寫／統計列
 *   `MonthJump`（⑤-b 追加 1）＝月／年快速跳轉小卡，`jumpOpen` 時掛載；入口＝DateNav 的標題鈕
 *   `StreamView`（主線車次①）＝「串流」排列，`view==="stream"` 時掛載：頁面本身不捲（`.is-stream`），
 *     串流自己捲、頁尾也畫在捲動內容裡；頁首的 ‹ ›／今天／月份字改走 scroll-spy（控制器 §2.2-1）
 *   `WeekTimeGrid`（主線②）＝「時段」排列（週的另一種排法，D-主-13 第四段），`view==="time"` 時掛載：
 *     頁面本身不捲（`.is-time`），畫布自己捲；頁首、‹ ›、鍵盤全照週
 * 資料一律經 `useCalendar()`（＝`useCalendarController` 的 context），不各自查 store。
 *
 * 使用者可見的頁名「行程表」（D-主-2／P2）：`PageId`／scope／settings key 仍叫 calendar，只改字。
 */
import { useRef } from "react";
import { addDays } from "../../lib/date";
import { useUiStore } from "../../store/uiStore";
import { hotkeyCaps } from "../common/PopMenu";
import { PageHeader } from "../common/PageHeader";
import { DateNav } from "../common/DateNav";
import { EmptyState } from "../common/EmptyState";
import { IconPlus } from "../common/icons";
import type { TabItem } from "../common/Tabs";
import { DateSeal } from "../stamps";
import { StreamView } from "../schedule/StreamView";
import { WeekTimeGrid } from "../schedule/WeekTimeGrid";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";
import { DayPopover } from "./DayPopover";
import { DueTip } from "./DueTip";
import { MonthGrid } from "./MonthGrid";
import { MonthMarginNote, MonthStats } from "./MonthHeaderNotes";
import { MonthJump } from "./MonthJump";
import { WeekGrid } from "./WeekGrid";
import { CalendarProvider, dateOf, useCalendarController, type CalendarViewMode } from "./useCalendarController";
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

/** 工具列第一格：四種排列（分頁籤，規範 §2.2；舊 `.seg` 四鈕退役） */
const VIEW_TABS: readonly TabItem<CalendarViewMode>[] = [
  { key: "month", label: "月", hotkeyTitle: "按月看" },
  { key: "week", label: "週", hotkeyTitle: "按週看" },
  { key: "time", label: "時段", hotkeyTitle: "時段：一週七天照幾點排" },
  { key: "stream", label: "串流", hotkeyTitle: "串流：從今天往上下捲" },
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
  const stream = c.view === "stream";
  /** 時段（主線②）：週的另一種排法——頁首／‹ ›／統計全照週 */
  const timeView = c.view === "time";
  // 串流時格層表只剩 Esc（StreamView 自己吃 daylist 那張表）
  const onKeyDown = useCalendarKeyboard(c.keys, c.blocked || stream);
  const streamEmpty = useScheduleUiStore((st) => st.streamEmpty);
  const focusDay = useScheduleUiStore((st) => st.focusDay);

  const cur = dateOf(c.cursor);
  const monthEn = MONTH_EN[cur.getMonth()];
  // 頁首三段：月視圖＝月／年／英文月名；週視圖＝日期區間／年／latin 區間（標題仍是 MonthJump 的觸發鈕，
  // 小卡的「目前月」照舊由 cursor（週視圖＝該週週一；串流＝focusDay 的月）決定，契約不動）
  const week = c.view === "week" || timeView ? weekHeading(c.cursor) : null;
  /** 頁首「« »」換年鈕只在月、週（磨光⑤ K4） */
  const yearCtl = c.view === "month" || c.view === "week";
  /** 空狀態（D3）：月／週／時段＝控制器載入完的區間；串流＝StreamView 查到的邊界 */
  const empty = stream ? streamEmpty : c.empty;
  /** 「今天」chip 的 title 用：目前看的區間含今天（串流＝捲到的那天就是今天） */
  const atToday = stream ? (focusDay ?? c.today) === c.today : c.today >= c.range.from && c.today <= c.range.to;

  /** 「＋ 車票」（P4）：串流＝今天的日列草稿（捲回今天）；其餘＝今天的日浮層＋底端草稿列 */
  const addTicket = () => {
    if (stream) {
      const st = useScheduleUiStore.getState();
      st.setDraftDay(c.today);
      // 今天那一段已經在畫面上：草稿列（在那一段最後）一聚焦瀏覽器就會捲進視野，不另發捲動——
      // 發了反而會把畫面拉回今天的標題列、草稿列被推到視窗外。不在（捲遠了）才請串流先回到今天。
      const sec = containerRef.current?.querySelector(`.ns-sch-day[data-day="${c.today}"]`);
      if (!sec) st.requestScroll(c.today);
      return;
    }
    c.addTicket();
  };
  const openSearch = () => useUiStore.getState().setQuickJumpOpen(true);

  const titleText = week ? week.d : `${cur.getMonth() + 1}月`;

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
      aria-label="行程表"
      className={stream ? "page ns-calendar is-stream" : timeView ? "page ns-calendar is-time" : "page ns-calendar"}
    >
      <CalendarProvider value={c}>
        <div className="sheet">
          <PageHeader
            variant="identity"
            className="ns-cal-head"
            overline={{ zh: "行程表", latin: "Schedule" }}
            title={
              <DateNav
                unit={c.view === "month" ? "month" : "week"}
                label={c.view === "month" ? "翻月份" : "翻週"}
                // 標題＝月／年快速跳轉的入口（⑤-b 追加 1）；說明掛在字上（DateNav 的標題鈕不收 title）
                title={<span title="跳到其他月份（Ctrl+←→ 換月・Ctrl+↑↓ 換年）">{titleText}</span>}
                onPrev={() => c.go(-1)}
                onNext={() => c.go(1)}
                // 換年（磨光⑤ K4、D-主-60）：月、週才有「« »」；時段、串流不加（串流按週捲）
                onPrevYear={yearCtl ? () => c.keys.jumpYear(-1) : undefined}
                onNextYear={yearCtl ? () => c.keys.jumpYear(1) : undefined}
                onToday={c.goToday}
                isToday={atToday}
                onTitle={(a) => (c.jumpOpen ? c.closeJump() : c.openJump(a))}
                titleExpanded={c.jumpOpen}
              />
            }
            aside={
              <>
                <span>{week ? week.w : `${cur.getFullYear()}年`}</span>
                <span className="ns-pagehead-latin">{week ? week.latin : monthEn}</span>
                {/* 頁邊手寫（粉彩；銀河 calendar.css 藏）。串流沒有「本區間」⇒ 不畫 */}
                {!stream && <MonthMarginNote range={c.range} today={c.today} />}
              </>
            }
            stats={stream ? undefined : <MonthStats />}
            // 日付印一枚示意（92px＝Q8、-6°＝原型 :485；每格日付印不做＝D-⑤-5-1）
            stamp={<DateSeal date={dateOf(c.today)} size={92} rotate={-6} title={`日付印 ${c.today}`} />}
            tabs={{ items: VIEW_TABS, value: c.view, onChange: c.setView, "aria-label": "切換檢視" }}
            // 空狀態出現時藏起來：同一個動作同頁一個入口（規範 §2.7，空狀態自己有「＋ 車票」）
            add={empty ? undefined : { label: "車票", onClick: addTicket, title: "在今天新增車票" }}
            search={{ onOpen: openSearch, title: `搜尋（${hotkeyCaps("global.quickjump")}）` }}
          />

          {/* ═══ 月間頁／週視圖／時段／串流 ═══ */}
          {stream ? (
            <StreamView />
          ) : (
            <div className="ns-cal-body">
              {timeView ? (
                <WeekTimeGrid />
              ) : c.view === "week" ? (
                <WeekGrid weekStart={c.cursor} days={c.days} />
              ) : (
                <MonthGrid />
              )}
              {/* D3：載入完、整個區間空 ⇒ 內容區中央（格照畫、卡片浮在上面；只有卡片本身吃滑鼠，其餘點得到格） */}
              {c.empty && (
                <div className="ns-cal-empty">
                  <EmptyState
                    className="techo-card"
                    tone="first"
                    stamp={
                      <span className="stamp">
                        <span className="hint">検印</span>
                      </span>
                    }
                    title={c.view === "month" ? "這個月還沒有車票" : "這週還沒有車票"}
                    desc="點格子右上的＋，在那天建一張。"
                    action={{ label: "車票", icon: <IconPlus />, onClick: addTicket }}
                  />
                </div>
              )}
            </div>
          )}

          {/* 串流的頁尾畫在捲動內容的最後（StreamView），這裡不畫 */}
          {!stream && (
            <footer className="page-foot">
              <span>私鐵手帳・行程表</span>
              <span className="fr">
                {monthEn} {cur.getFullYear()}
              </span>
            </footer>
          )}
        </div>

        {/* 當日清單浮層（底端草稿列由 popTarget.draft 決定；seq 變＝重開） */}
        {c.popTarget && (
          <DayPopover
            day={c.popTarget.day}
            anchor={c.popTarget.anchor}
            draft={c.popTarget.draft === true}
            seq={c.popTarget.seq ?? 0}
            onClose={c.closeDay}
          />
        )}
        {/* 〆 hover 明細（WP5 填內容） */}
        {c.tipTarget && <DueTip day={c.tipTarget.day} anchor={c.tipTarget.anchor} />}
        {/* 月／年快速跳轉小卡（⑤-b 追加 1；錨＝DateNav 的標題鈕） */}
        {c.jumpOpen && <MonthJump anchor={c.jumpAnchor} />}
      </CalendarProvider>
    </section>
  );
}
