/**
 * ScheduleSummary——日程頂上的日期列與一行總結（④ 契約 §5.1、D-時-72、83；乙席）。
 * 長相＝原型 v-h.js navHtml／sumHtml（.vh-nav／.vh-sum）→ 正式版 `.ns-tt-sched-nav`／`.ns-tt-sched-sum`（timetable.css §L）。
 *
 * - 日期列：‹「10/20（一）」＋今天／昨天／明天 ›；不是今天時「回到今天」（桌機帶鍵帽 T）。跟軸共用 `timetableStore.dayKey`。
 *   日程可以往未來翻（D-時-79：今天以後能排），所以 › 不像軸那樣停在今天。
 * - 總結：今天與過去＝`schedPlanned`（「排了 6 件・済 3・只記時間 1・準點 2」，D-時-83 改題）、未來＝`schedFuture`；排了 0 件 ⇒ 不出總結、改一句空狀態（`schedEmpty`）。
 *   數字照 TT_TEXT 的字、只把數字抬成粗體（＝原型 .vh-sumline b）。過去的日子多一行淡字「過去的日子只能看…」。
 */
import { Fragment } from "react";
import { TT_TEXT } from "../../../store/timetableStore";
import { MIN } from "../../../domain/timetable";
import { formatChord, hotkeyById } from "../../shell/hotkeys";
import { SCHED_UI, mdw, splitNums } from "./scheduleModel";
import type { SchedulePage } from "./useSchedulePage";

export function ScheduleNav({ page }: { page: SchedulePage }) {
  const { dayKey, todayKey, shell } = page;
  const isToday = dayKey === todayKey;
  const todayHot = shell === "desktop" ? hotkeyById("timetable.day.today") : undefined;
  const tag = dayKey === page.date ? page.dayTag : isToday ? TT_TEXT.schedToday : null;
  return (
    <div className="ns-tt-sched-nav">
      <span className="ns-tt-sched-pnav">
        <button type="button" className="ns-tt-sched-arrow" aria-label={SCHED_UI.prevDay} onClick={() => page.stepDay(-1)}>
          ‹
        </button>
        <span className="ns-tt-sched-pname">
          <b className="ns-tt-num">{mdw(dayKey)}</b>
          {tag && <em>{tag}</em>}
        </span>
        <button type="button" className="ns-tt-sched-arrow" aria-label={SCHED_UI.nextDay} onClick={() => page.stepDay(1)}>
          ›
        </button>
      </span>
      {!isToday && (
        <button type="button" className="ns-tt-sched-tocur" onClick={page.toToday}>
          {SCHED_UI.toToday}
          {todayHot && (
            <kbd className="ns-tt-kbd" aria-hidden="true">
              {formatChord(todayHot.chords[0]).join("+")}
            </kbd>
          )}
        </button>
      )}
    </div>
  );
}

export function ScheduleSummary({ page }: { page: SchedulePage }) {
  const { summary, isFuture } = page.cmp;
  const loaded = page.grid !== null && page.grid.date === page.date;
  const text = !loaded
    ? " "
    : summary.planned === 0
      ? null
      : isFuture
        ? TT_TEXT.schedFuture(summary.planned, summary.plannedMin * MIN, summary.noEstimate)
        : TT_TEXT.schedPlanned(summary.planned, summary.stamped, summary.timedOnly, summary.onTime);
  return (
    <div className={"ns-tt-sched-sum" + (page.isPast ? " is-past" : "")}>
      {text === null ? (
        <p className="ns-tt-sched-sumline is-empty">{TT_TEXT.schedEmpty}</p>
      ) : (
        <p className="ns-tt-sched-sumline">
          {splitNums(text).map((p, i) =>
            p.num ? (
              <b key={i} className="ns-tt-num">
                {p.t}
              </b>
            ) : (
              <Fragment key={i}>{p.t.split("・").map((x, j) => (j === 0 ? x : [<i key={"s" + j}>・</i>, x]))}</Fragment>
            ),
          )}
        </p>
      )}
      {page.isPast && <p className="ns-tt-sched-ro">{SCHED_UI.pastNote}</p>}
    </div>
  );
}
