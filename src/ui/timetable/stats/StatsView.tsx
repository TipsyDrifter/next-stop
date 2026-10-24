/**
 * StatsView——時刻表統計頁・桌機（③ 契約 §5.2；〈原型定案〉1；乙席）。不吃 props，自己從 store 讀；
 * 丙席在 `TimetableView` 的 `view === "stats"` 時掛上（RunDock 由丙放在它上面）。
 *
 *   div.ns-tt-stats[data-shell-kind="desktop"]（自己捲；寬 < 760px 退成一欄）
 *   ├─ PeriodBar（整寬）
 *   ├─ SummaryStrip（整寬；空狀態不畫）
 *   └─ div.ns-tt-stats-cols：左＝占比與環比＋依路線（〈原型定案〉1：路線放左欄）；右＝趨勢＋時數目標
 *
 * 掛上 `load()`、卸下 `release("stats")`、每分鐘 `checkDay()`（useStatsPage）。
 * 評審 #8：換期之後到新結果回來之前，`result` 還是舊的期 ⇒ 期間列照 store 的 period／key 畫，下面整片淡掉（`is-stale`），不畫出錯的期名。
 */
import { useEffect, useRef, useState } from "react";
import { periodWindow } from "../../../domain/timetableStats";
import { EmptyState } from "../../common/EmptyState";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useDayContext } from "./format";
import { GoalCards } from "./GoalCards";
import { PeriodBar } from "./PeriodBar";
import { RouteList } from "./RouteList";
import { ShareList } from "./ShareList";
import { SummaryStrip } from "./SummaryStrip";
import { TrendChart } from "./TrendChart";
import { useStatsPage } from "./useStatsPage";

/** 兩欄撐不開的門檻（量的是統計區自己的寬） */
const ONE_COL_PX = 760;

/** 現在畫的結果是不是正在看的那一期（評審 #8） */
export function useStatsResult(today: string, h: number, ws: 0 | 1) {
  const result = useTimetableStatsStore((s) => s.result);
  const period = useTimetableStatsStore((s) => s.period);
  const key = useTimetableStatsStore((s) => s.key);
  const follow = useTimetableStatsStore((s) => s.followCurrent);
  const error = useTimetableStatsStore((s) => s.error);
  const want = follow ? periodWindow(period, today, h, ws).key : key;
  const stale = !result || result.period !== period || result.key !== want;
  return { result, stale, error };
}

/** 統計空狀態的說明句（UI 丙-4 D7；只在這一支用） */
const STATS_EMPTY_DESC = "発車、到着之後，時數會算在這裡。";

/**
 * 這一期沒有任何紀錄（兩殼共用；MobileStats 也掛）。UI 丙-4 D7：換成共用 EmptyState（tone first，規範 §2.7），
 * 原本的「三站虛線」插畫留下來當印章位的記號。不給鈕：第一步（発車／補記）就在正上方的運行列與 F 鍵，同頁不另開第二個入口。
 */
export function StatsEmpty() {
  return (
    <section className="ns-tt-stats-card ns-tt-stats-empty">
      <EmptyState
        tone="first"
        stamp={
          <span className="ns-tt-stats-empty-rail">
            <i />
            <i />
            <i />
          </span>
        }
        title={TT_TEXT.statsEmpty}
        desc={STATS_EMPTY_DESC}
      />
    </section>
  );
}

export function StatsView() {
  const now = useStatsPage();
  const { today, h, ws } = useDayContext(now);
  const { result: r, stale, error } = useStatsResult(today, h, ws);
  const rootRef = useRef<HTMLDivElement>(null);
  const [oneCol, setOneCol] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setOneCol((entries[0]?.contentRect.width ?? el.clientWidth) < ONE_COL_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const empty = !!r && r.empty;
  const body = !r ? (
    <p className="ns-tt-stats-loading">{error ? TT_TEXT.statsUi.loadFailed(error) : TT_TEXT.statsUi.loading}</p>
  ) : (
    <>
      {!empty && <SummaryStrip r={r} ws={ws} desktop />}
      <div className={"ns-tt-stats-cols" + (oneCol ? " is-one" : "")}>
        <div className="ns-tt-stats-col">
          {empty ? <StatsEmpty /> : <ShareList r={r} desktop />}
          {!empty && <RouteList r={r} desktop />}
        </div>
        <div className="ns-tt-stats-col">
          <TrendChart r={r} desktop />
          <GoalCards />
        </div>
      </div>
    </>
  );

  return (
    <div ref={rootRef} className="ns-tt-stats is-desktop" data-period={r?.period ?? undefined}>
      <PeriodBar today={today} h={h} ws={ws} desktop />
      <div className={"ns-tt-stats-body" + (stale && r ? " is-stale" : "")} aria-busy={stale}>
        {body}
      </div>
    </div>
  );
}
