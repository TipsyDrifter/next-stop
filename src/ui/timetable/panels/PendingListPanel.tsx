/**
 * PendingListPanel——待確認清單（③ 契約 §5.3；D-時-43、55；〈原型定案〉1；乙席）。
 * 標題「待確認 2 班」（`panels/index.ts` 的 sheetTitle）；每列「10/17（五）洗漱　08:12 起・跑了 52h」，由新到舊。
 * 只列正在看的那一期（sheet 沒帶 goalId）或那個目標現在的範圍（目標卡「看看 ›」帶 goalId）；內容即時讀 timetableStatsStore。
 * 點一列＝`openSheet({ kind: "longRun", blockId, then: null })`；修好之後回到這張清單（少一列）、清空就關掉並 toast「都確認好了」
 * ——接續在 `stats/useStatsPage.ts`（記住從哪來，longRun 確認成功 ⇒ 等重算完再開回來）。
 */
import { fmtClock, fmtDur } from "../../../domain/timetable";
import type { PendingItem } from "../../../domain/timetableStats";
import { todayKey } from "../../../lib/date";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useUiStore } from "../../../store/uiStore";
import { CategoryBadge } from "../CategoryBadge";
import { mdw } from "../stats/format";
import { markPendingReturn } from "../stats/useStatsPage";
import { Sub, type PanelProps } from "./controls";
import { EmptyState } from "../../common/EmptyState";

const EMPTY: PendingItem[] = [];

export function PendingListPanel(_props: PanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const catById = useTimetableStore((s) => s.catById);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const h = useUiStore((s) => s.dayStartHour);
  const goalId = sheet?.kind === "pendingList" ? (sheet.goalId ?? null) : null;
  const from = sheet?.kind === "pendingList" ? sheet.from : 0;
  const to = sheet?.kind === "pendingList" ? sheet.to : 0;
  const goalView = useTimetableStatsStore((s) => (goalId ? (s.goals.find((g) => g.goal.id === goalId) ?? null) : null));
  const periodItems = useTimetableStatsStore((s) => s.result?.pending ?? EMPTY);
  const items = goalId ? (goalView?.cur.pendingItems ?? EMPTY) : periodItems;
  const T = TT_TEXT.statsUi;

  const open = (b: PendingItem): void => {
    markPendingReturn({ blockId: b.id, goalId, from, to });
    openSheet({ kind: "longRun", blockId: b.id, then: null });
  };

  return (
    <div className="ns-tt-panel ns-tt-pend-panel">
      <Sub>
        {T.pendingSub}
        {goalView && <> {T.pendingGoalSub(goalView.goal.name)}</>}
      </Sub>
      {items.length === 0 ? (
        // UI 丙-4 D7／C4：空的時候換共用 EmptyState（區段級、「都好了」的語氣）；不放「關閉」字鈕（×／返回就是關）
        <EmptyState inline tone="done" title={T.pendingEmpty} />
      ) : (
        <div className="ns-tt-pend-list" role="list">
          {items.map((b) => {
            const cat = catById[b.categoryId] ?? null;
            return (
              <button type="button" role="listitem" key={b.id} className="ns-tt-pend-item" onClick={() => open(b)}>
                <CategoryBadge cat={cat} size="sm" />
                <span className="ns-tt-pend-main">
                  <b>
                    {mdw(todayKey(h, new Date(b.start)))}　{cat?.name ?? T.catGone}
                  </b>
                  <small className="ns-tt-num">{T.pendingRowSub(fmtClock(b.start), fmtDur(b.durMs), b.end === null)}</small>
                </span>
                <span className="ns-tt-pend-go" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 標題用（sheetTitle 叫）：「待確認 2 班」 */
export function pendingListTitle(goalId: string | null | undefined): string {
  const st = useTimetableStatsStore.getState();
  const n = goalId ? (st.goals.find((g) => g.goal.id === goalId)?.cur.pendingItems.length ?? 0) : (st.result?.pending.length ?? 0);
  return TT_TEXT.statsUi.pendingCount(n);
}
