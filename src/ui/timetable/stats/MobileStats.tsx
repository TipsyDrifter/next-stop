/**
 * MobileStats——時刻表統計頁・手機（③ 契約 §5.2、§5.11；乙席）。不吃 props，自己從 store 讀；
 * 丙席在 `MobileTimetable` 的 `view === "stats"` 時掛在 `.m-page` 裡（頁面本身捲，這裡不另開捲軸）。
 * 一欄：期間列 → 摘要 → 目標 → 占比 → 趨勢 → 路線（空狀態：期間列 → 空 → 趨勢 → 目標）。
 * 趨勢明細＝點一根（觸控沒有滑過）；環比點一下冒小泡。
 */
import { TT_TEXT } from "../../../store/timetableStore";
import { useDayContext } from "./format";
import { GoalCards } from "./GoalCards";
import { PeriodBar } from "./PeriodBar";
import { RouteList } from "./RouteList";
import { ShareList } from "./ShareList";
import { StatsEmpty, useStatsResult } from "./StatsView";
import { SummaryStrip } from "./SummaryStrip";
import { TrendChart } from "./TrendChart";
import { useStatsPage } from "./useStatsPage";

export function MobileStats() {
  const now = useStatsPage();
  const { today, h, ws } = useDayContext(now);
  const { result: r, stale, error } = useStatsResult(today, h, ws);
  const empty = !!r && r.empty;

  return (
    <div className="ns-tt-stats is-mobile" data-period={r?.period ?? undefined}>
      <PeriodBar today={today} h={h} ws={ws} desktop={false} />
      <div className={"ns-tt-stats-body" + (stale && r ? " is-stale" : "")} aria-busy={stale}>
        {!r ? (
          <p className="ns-tt-stats-loading">{error ? TT_TEXT.statsUi.loadFailed(error) : TT_TEXT.statsUi.loading}</p>
        ) : empty ? (
          <>
            <StatsEmpty />
            <TrendChart r={r} desktop={false} />
            <GoalCards />
          </>
        ) : (
          <>
            <SummaryStrip r={r} ws={ws} desktop={false} />
            <GoalCards />
            <ShareList r={r} desktop={false} />
            <TrendChart r={r} desktop={false} />
            <RouteList r={r} desktop={false} />
          </>
        )}
      </div>
    </div>
  );
}
