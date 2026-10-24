/**
 * ScheduleSummary——日程頂上的日期列與一行總結（④ 契約 §5.1、D-時-72、83；乙席）。
 * 長相＝原型 v-h.js navHtml／sumHtml（.vh-nav／.vh-sum）→ 正式版 `.ns-tt-sched-nav`／`.ns-tt-sched-sum`（timetable.css §L）。
 *
 * - 日期列：DateNav ‹「10/20（一）」＋今天／昨天／明天 › ＋「今天」chip（UI 丙-4 D9）。跟軸共用 `timetableStore.dayKey`。
 *   日程可以往未來翻（D-時-79：今天以後能排），所以 › 不像軸那樣停在今天。
 * - 總結：今天與過去＝`schedPlanned`（「排了 6 件・済 3・只記時間 1・準點 2」，D-時-83 改題）、未來＝`schedFuture`；排了 0 件 ⇒ 不出總結、改一句空狀態（`schedEmpty`）。
 *   數字照 TT_TEXT 的字、只把數字抬成粗體（＝原型 .vh-sumline b）。過去的日子多一行淡字「過去的日子只能看…」。
 */
import { Fragment } from "react";
import { TT_TEXT } from "../../../store/timetableStore";
import { MIN } from "../../../domain/timetable";
import { DateNav } from "../../common/DateNav";
import { DnTitle } from "../parts/DateNavTitle";
import { SCHED_UI, mdw, splitNums } from "./scheduleModel";
import type { SchedulePage } from "./useSchedulePage";

/**
 * UI 丙-4 D9：自畫的 ‹ › 與「回到今天」膠囊換共用 DateNav（兩殼同一顆）。動作＝`page.stepDay`／`page.toToday`
 * （＝鍵盤 ←／→／T 走的同一支 setDayKey）；日程能翻到未來 ⇒ › 不停用；「今天」chip 已在今天就原地不動。
 */
export function ScheduleNav({ page }: { page: SchedulePage }) {
  const { dayKey, todayKey } = page;
  const isToday = dayKey === todayKey;
  const tag = dayKey === page.date ? page.dayTag : isToday ? TT_TEXT.schedToday : null;
  return (
    <div className="ns-tt-sched-nav">
      <DateNav
        className="ns-tt-dnav"
        title={<DnTitle text={mdw(dayKey)} tag={tag} />}
        onPrev={() => page.stepDay(-1)}
        onNext={() => page.stepDay(1)}
        onToday={() => {
          if (!isToday) page.toToday();
        }}
        isToday={isToday}
      />
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
