/**
 * SummaryStrip——摘要三格＋環比總述（③ 契約 §5.2-2；〈原型定案〉1；乙席）。
 *   已記錄｜未記錄｜待確認 n 班（兩行：小字「待確認 2 班」＋大字時數；0 班變灰、不可點）
 *   下一行「比上週同期：已記錄 ▲3h10m」，再下一行淡字寫出比的是哪一段。
 * 三格加起來＝這一期到現在的有效長度（契約 7.1-3；domain 保證 recorded＋pending＋unrecorded＝effective）。
 */
import { fmtDur } from "../../../domain/timetable";
import { shiftPeriod, type StatsResult } from "../../../domain/timetableStats";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { compareSpanText } from "./format";
import { Delta } from "./parts";

export function SummaryStrip({ r, ws, desktop }: { r: StatsResult; ws: 0 | 1; desktop: boolean }) {
  const openSheet = useTimetableStore((s) => s.openSheet);
  const T = TT_TEXT.statsUi;
  const c = r.cur;
  const n = c.pendingIds.length;
  const same = r.compare === "sameSpan";
  const prevKey = shiftPeriod(r.period, r.key, -1, ws);
  return (
    <>
      <div className="ns-tt-stats-sum">
        <div className="ns-tt-stats-cell">
          <span className="k">{TT_TEXT.statsRecorded}</span>
          <b className="ns-tt-num">{fmtDur(c.recordedMs)}</b>
        </div>
        <div className="ns-tt-stats-cell">
          <span className="k">{TT_TEXT.statsUnrecorded}</span>
          <b className="ns-tt-num">{fmtDur(c.unrecordedMs)}</b>
        </div>
        <button
          type="button"
          className={"ns-tt-stats-cell is-pend" + (n ? "" : " is-zero")}
          disabled={!n}
          title={n ? T.pendingTip : T.pendingNone}
          onClick={() => openSheet({ kind: "pendingList", from: r.window.start, to: r.window.end, goalId: null })}
        >
          <span className="k">{T.pendingCount(n)}</span>
          <b className="ns-tt-num">{n ? fmtDur(c.pendingMs) : "—"}</b>
          {n > 0 && (
            <span className="ns-tt-stats-cell-go" aria-hidden="true">
              ›
            </span>
          )}
        </button>
      </div>
      <div className="ns-tt-stats-cmp">
        <p>
          {TT_TEXT.statsCompare(r.period, same)}：{T.cmpRecorded} <Delta ms={c.recordedMs - r.prev.recordedMs} prevMs={r.prev.recordedMs} showTitle={desktop} />
        </p>
        <p className="ns-tt-stats-cmp-span ns-tt-num">{compareSpanText(r.period, r.prevWindow, same, prevKey)}</p>
      </div>
    </>
  );
}
