/**
 * DepartBoard——發車台（車次①a 契約 §5.1；乙席）。＝原型 v-d.js:29-38。
 * section.ns-tt-board：標題列 h3「發車台」＋ CategoryGrid（非 compact、totals＝今日合計、runningId＝運行中那班的分類）。
 * 點分類＝`store.tapCategory`。
 * UI 丙-4 A3（§5 P6）：標題列右上的「編輯」拿掉——分類與設定的入口只留頁首第四格（桌機，＋E 鍵）與籤列末端「管理」（手機），
 *   同一件事一個叫法（規範 E27）。
 *
 * 車次②（② 契約 §5.4、☎一-4；乙席）：標題列之後、分類格之前一排「今日車票」（TodayTickets；沒有車票整段不畫）。
 * 手機發車台檢視同一個元件（MobileTimetable 用的就是這個 DepartBoard）；軸檢視不出。
 */
import { useMemo } from "react";
import { msOf, toSpan, totalsByCategory } from "../../../domain/timetable";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { dayWindow } from "../../../lib/date";
import { CategoryGrid } from "./CategoryGrid";
import { TodayTickets } from "./TodayTickets";
import { useNow } from "../useNow";

export function DepartBoard() {
  const todayKey = useTimetableStore((s) => s.todayKey);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const running = useTimetableStore((s) => s.running);
  const tapCategory = useTimetableStore((s) => s.tapCategory);
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
      </div>
      <TodayTickets />
      <CategoryGrid selected={null} onPick={tapCategory} totals={totals} runningId={running?.category_id ?? null} />
    </section>
  );
}
