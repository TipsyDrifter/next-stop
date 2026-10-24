/**
 * PeriodBar——統計頁的期間列（③ 契約 §5.2-1；乙席）：分段鈕「日｜週｜月」＋ ‹ 期名 › ＋「今天」。
 * 期名以 store 的 `period`／`key` 為準（評審 #8：換期後到新結果回來之前，不能照舊結果畫出錯的期）。
 * 未來的期翻不過去（› 到本期就停，store 也夾）。桌機帶鍵帽 D／W／M 與「← → 換期」提示。
 * 鍵帽字照 manifest（`hotkeyById`＋`formatChord`，整合席登記 D-時-57 後接上；不手抄）。
 *
 * UI 丙-4 D9：自畫的 ‹ › 與「回到本期」膠囊換共用 DateNav（「今天」chip＝回到本期；箭頭的字跟著期：前一天／上一週／上個月）。
 * 動作＝鍵盤 ←／→／T 的同一支 `step`／`toCurrent`（TimetableView 的 KEY_ACTIONS 也是叫這兩支）；已在本期 › 停用、chip 原地不動。
 * 分段鈕與鍵位提示留在 DateNav 兩旁。
 */
import { periodWindow, type StatsPeriod } from "../../../domain/timetableStats";
import { formatChord, hotkeyById } from "../../shell/hotkeys";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { DateNav } from "../../common/DateNav";
import { DnTitle } from "../parts/DateNavTitle";
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
      <DateNav
        className="ns-tt-dnav"
        unit={period}
        label="翻期間"
        title={<DnTitle text={pn.name} tag={pn.tag} />}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        nextDisabled={!canNext}
        onToday={() => {
          if (!isCur) toCurrent();
        }}
        isToday={isCur}
      />
      {desktop && <span className="ns-tt-stats-keys">{T.keysHint}</span>}
    </div>
  );
}
