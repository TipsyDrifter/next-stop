/**
 * WeekView——時刻表頁的「週」視圖（③ 契約 §5.1、§5.5、0-7、0-10；D-時-46、54、66；丙席）。兩殼共用，`shell` 只換尺寸與字。
 *
 *   section.ns-tt-week[.is-desk]
 *   ├ div.ns-tt-week-bar   ‹ 「10/13–10/19」＋本週／上週 › 、「回到本週」（不是本週才出）、右側圖例（待確認斜紋／現在線）
 *   ├ WeekGrid
 *   └ p.ns-tt-week-foot    操作說明一行
 *
 * - 掛上叫 `statsStore.loadWeek()`、卸下 `release("week")`（甲席回報：要在 `timetableStore.init` 之後——init 沒好時
 *   loadWeek 什麼都不算，等 `ready` 變了由 store 的訂閱自己補算）。
 * - #72（0-7）：開著的期間每分鐘一次——停在本週 ⇒ `loadWeek()` 重算（運行中那塊長大、跨過日界線就換到新的一週）；
 *   翻到過去的週 ⇒ 只 `checkDay()`（只比字串）。
 * - 點塊（0-10）：`setDayKey(那天)` → `setView(桌機＝上次的兩欄或只看軸；手機＝軸)` → 等 refresh 完，照軸的點擊語義開面板：
 *   待確認 ⇒ 其實到幾點（longRun）、運行中 ⇒ 不開面板（同軸：toast「運行中」那句）、其餘 ⇒ 改一塊（edit）。
 * - 點空白：`openSheet({ kind: "fill", start, end })`（那段空白的起訖；未來的部分 segmentsOfDay 已夾到現在）。
 */
import { useEffect, useRef } from "react";
import { blockMarker, TT_TEXT, useTimetableStore, type TimetableView } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useUiStore } from "../../../store/uiStore";
import { shiftPeriod } from "../../../domain/timetableStats";
import { weekStartKey } from "../../../domain/timetable";
import { addDays } from "../../../lib/date";
import { formatChord, hotkeyById } from "../../shell/hotkeys";
import { useNow } from "../useNow";
import { WeekGrid, type WeekBlockItem } from "./WeekGrid";

/** 桌機上次停的「兩欄／只看軸」（點塊跳軸時回到它；TimetableView 每次 view 變了就記） */
let lastDeskAxisView: TimetableView = "split";
export function rememberDeskAxisView(v: TimetableView): void {
  if (v === "split" || v === "axis") lastDeskAxisView = v;
}

/** 點一塊：跳到那天的軸、打開那塊（0-10）。匯出給整合席的鍵盤（週視圖目前沒有鍵選塊，備用） */
export async function jumpToWeekBlock(shell: "desktop" | "mobile", dateKey: string, blockId: string): Promise<void> {
  const tt = useTimetableStore.getState();
  const loaded = tt.setDayKey(dateKey); // dayKey 立刻換（軸先畫對的那天），refresh 在背景跑
  tt.setView(shell === "mobile" ? "axis" : lastDeskAxisView);
  await loaded;
  const s = useTimetableStore.getState();
  const row = s.dayBlocks.find((r) => r.id === blockId);
  if (!row) return; // 這一塊剛好被同步整理掉：停在那天的軸就好
  const m = blockMarker(row, s.catById, s.longRunMaxMin, Date.now(), s.linkInfo);
  if (m.kind !== "none" && m.pending) {
    s.openSheet({ kind: "longRun", blockId, then: null });
    return;
  }
  if (row.ended_at === null) {
    useUiStore.getState().showToast({ message: TT_TEXT.runningHint });
    return;
  }
  s.openSheet({ kind: "edit", blockId });
}

function mdOf(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
}

export function WeekView({ shell }: { shell: "desktop" | "mobile" }) {
  const week = useTimetableStatsStore((s) => s.week);
  const weekKey = useTimetableStatsStore((s) => s.weekKey);
  const weekFollow = useTimetableStatsStore((s) => s.weekFollow);
  const error = useTimetableStatsStore((s) => s.error);
  const weekStart = useUiStore((s) => s.weekStart);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const now = useNow(60_000);
  const T = TT_TEXT.weekUi;
  const isDesk = shell === "desktop";

  useEffect(() => {
    const st = useTimetableStatsStore.getState();
    void st.loadWeek();
    return () => useTimetableStatsStore.getState().release("week");
  }, []);

  // #72：每分鐘一次（useNow 在背景停、回前景立刻跳一次）；掛上那一次上面已經算了，跳過
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const st = useTimetableStatsStore.getState();
    if (st.weekFollow) void st.loadWeek();
    else st.checkDay();
  }, [now]);

  const key = week?.key ?? weekKey;
  const isCurrent = week ? week.isCurrent : weekFollow;
  const tag = isCurrent
    ? T.tagThisWeek
    : week && week.todayKey && key === shiftPeriod("week", weekStartKey(week.todayKey, weekStart), -1, weekStart)
      ? T.tagLastWeek
      : null;
  const todayKeyHot = hotkeyById("timetable.day.today");

  return (
    <section className={"ns-tt-week" + (isDesk ? " is-desk" : "")} aria-label={T.tagThisWeek}>
      <div className="ns-tt-week-bar">
        <span className="ns-tt-week-nav">
          <button
            type="button"
            className="ns-tt-week-arrow"
            aria-label={T.prevWeek}
            onClick={() => useTimetableStatsStore.getState().weekStep(-1)}
          >
            ‹
          </button>
          <span className="ns-tt-week-name">
            <b className="ns-tt-num">
              {mdOf(key)}–{mdOf(addDays(key, 6))}
            </b>
            {tag && <em>{tag}</em>}
          </span>
          <button
            type="button"
            className="ns-tt-week-arrow"
            aria-label={T.nextWeek}
            disabled={isCurrent}
            onClick={() => useTimetableStatsStore.getState().weekStep(1)}
          >
            ›
          </button>
        </span>
        {!isCurrent && (
          <button type="button" className="ns-tt-week-tocur" onClick={() => useTimetableStatsStore.getState().weekToCurrent()}>
            {TT_TEXT.weekToCurrent}
            {isDesk && todayKeyHot && (
              <kbd className="ns-tt-kbd" aria-hidden="true">
                {formatChord(todayKeyHot.chords[0]).join("+")}
              </kbd>
            )}
          </button>
        )}
        <span className="ns-tt-week-legend" aria-hidden="true">
          <i className="is-pend" />
          {T.legendPending}
          <i className="is-now" />
          {T.legendNow}
        </span>
      </div>

      {error && !week && <p className="ns-tt-week-err">⚠ {error}</p>}

      {week ? (
        <WeekGrid
          week={week}
          shell={shell}
          now={Math.max(now, week.now)}
          onBlock={(dateKey: string, it: WeekBlockItem) => void jumpToWeekBlock(shell, dateKey, it.span.id)}
          onGap={(from, to) => openSheet({ kind: "fill", start: from, end: to })}
        />
      ) : (
        <div className="ns-tt-week-grid is-loading" aria-busy="true" />
      )}

      <p className="ns-tt-week-foot">{T.foot(isDesk)}</p>
    </section>
  );
}
