/**
 * PeriodBar——統計頁的期間列（③ 契約 §5.2-1；乙席）：分段鈕「日｜週｜月」＋ ‹ 期名 › ＋「回到本期」（只在不是本期時出現）。
 * 期名以 store 的 `period`／`key` 為準（評審 #8：換期後到新結果回來之前，不能照舊結果畫出錯的期）。
 * 未來的期翻不過去（› 到本期就停，store 也夾）。桌機帶鍵帽 D／W／M、T 與「← → 換期」提示。
 * 鍵帽字照 manifest（`hotkeyById`＋`formatChord`，整合席登記 D-時-57 後接上；不手抄）。
 */
import { periodWindow, type StatsPeriod } from "../../../domain/timetableStats";
import { formatChord, hotkeyById } from "../../shell/hotkeys";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { periodName } from "./format";
import { Kbd } from "./parts";

const PERIODS: readonly StatsPeriod[] = ["day", "week", "month"];
const KEY_ID: Record<StatsPeriod, string> = { day: "timetable.stats.day", week: "timetable.stats.week", month: "timetable.stats.month" };

/** 鍵帽字：manifest 有登記就照它；沒有就不畫 */
function capOf(id: string): string | null {
  const h = hotkeyById(id);
  return h ? formatChord(h.chords[0]).join("+") : null;
}

export function PeriodBar({ today, h, ws, desktop }: { today: string; h: number; ws: 0 | 1; desktop: boolean }) {
  const period = useTimetableStatsStore((s) => s.period);
  const key = useTimetableStatsStore((s) => s.key);
  const follow = useTimetableStatsStore((s) => s.followCurrent);
  const setPeriod = useTimetableStatsStore((s) => s.setPeriod);
  const step = useTimetableStatsStore((s) => s.step);
  const toCurrent = useTimetableStatsStore((s) => s.toCurrent);
  const T = TT_TEXT.statsUi;

  const curKey = periodWindow(period, today, h, ws).key;
  const shownKey = follow ? curKey : key;
  const isCur = shownKey === curKey;
  const canNext = shownKey < curKey;
  const pn = periodName(period, shownKey, today, h, ws);
  const todayCap = capOf("timetable.day.today");

  return (
    <div className="ns-tt-stats-pbar">
      <span className="ns-tt-stats-seg" role="group" aria-label={T.periodGroup}>
        {PERIODS.map((p) => {
          const cap = desktop ? capOf(KEY_ID[p]) : null;
          return (
            <button type="button" key={p} aria-pressed={period === p} className={period === p ? "is-on" : ""} onClick={() => setPeriod(p)}>
              {TT_TEXT.periodWord[p]}
              {cap && <Kbd k={cap} />}
            </button>
          );
        })}
      </span>
      <span className="ns-tt-stats-pnav">
        <button type="button" className="ns-tt-stats-arrow" aria-label={T.prevPeriod} onClick={() => step(-1)}>
          ‹
        </button>
        <span className="ns-tt-stats-pname" aria-live="polite">
          <b className="ns-tt-num">{pn.name}</b>
          {pn.tag && <em>{pn.tag}</em>}
        </span>
        <button type="button" className="ns-tt-stats-arrow" aria-label={T.nextPeriod} disabled={!canNext} onClick={() => step(1)}>
          ›
        </button>
      </span>
      {!isCur && (
        <button type="button" className="ns-tt-stats-tocur" onClick={toCurrent}>
          {TT_TEXT.statsToCurrent}
          {desktop && todayCap && <Kbd k={todayCap} />}
        </button>
      )}
      {desktop && <span className="ns-tt-stats-keys">{T.keysHint}</span>}
    </div>
  );
}
