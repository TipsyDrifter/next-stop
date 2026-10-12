/**
 * DepartBoard——發車台（車次①a 契約 §5.1；乙席）。＝原型 v-d.js:29-38。
 * section.ns-tt-board：標題列 h3「發車台」＋右上 button.ns-tt-edit「編輯」（開 categories 面板）
 * ＋ CategoryGrid（非 compact、totals＝今日合計、runningId＝運行中那班的分類）。點分類＝`store.tapCategory`。
 */
import { useMemo } from "react";
import { msOf, toSpan, totalsByCategory } from "../../../domain/timetable";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { dayWindow } from "../../../lib/date";
import { CategoryGrid } from "./CategoryGrid";
import { useNow } from "../useNow";

export function DepartBoard() {
  const todayKey = useTimetableStore((s) => s.todayKey);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const running = useTimetableStore((s) => s.running);
  const tapCategory = useTimetableStore((s) => s.tapCategory);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useNow(1000);

  const totals = useMemo(() => {
    const w = dayWindow(todayKey, dayStartHour);
    return totalsByCategory(todayBlocks.map(toSpan), { start: msOf(w.start), end: msOf(w.end) }, now);
  }, [todayBlocks, todayKey, dayStartHour, now]);

  return (
    <section className="ns-tt-board" aria-label="發車台">
      <div className="ns-tt-board-head">
        <h3 className="ns-tt-board-title">發車台</h3>
        <button type="button" className="ns-tt-edit" onClick={() => openSheet({ kind: "categories" })}>
          編輯
        </button>
      </div>
      <CategoryGrid selected={null} onPick={tapCategory} totals={totals} runningId={running?.category_id ?? null} />
    </section>
  );
}
