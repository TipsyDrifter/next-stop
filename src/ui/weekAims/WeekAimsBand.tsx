/**
 * WeekAimsBand——週方針告示的舊介面（戊 D-主-262），內部包 `AimsBand`（方針擴充 辛 §7）。
 *
 *   - 今日頁首下方（`<WeekAimsBand />`）：`TodayAimsBand`，預設看今天那週，最下面一行能切到本月、今年（D-主-377）。
 *   - 行程表「週」檢視頂端（`<WeekAimsBand day={週首} wide />`）：看畫面上那一週，四句橫排。
 *   - 行程表「時段」檢視頂端（`<WeekAimsBand day={週首} wide pinFolded />`）：同一週，固定收合、可展開（D-主-379）。
 */
import { currentKeyOf, weekOnOf } from "../../domain/weekAims";
import { useWeekAimStore } from "../../store/weekAimStore";
import { AimsBand } from "./AimsBand";
import { useAimToday } from "./useWeekAims";

/** 今日那張：切換只活在這次打開，換頁再回來還在、關 App 回本週（存在 store 的記憶體） */
function TodayAimsBand() {
  const { today, weekStart } = useAimToday();
  const pick = useWeekAimStore((s) => s.todayPick);
  return <AimsBand aimKey={currentKeyOf(pick, today, weekStart)} ribbon autoReview />;
}

export function WeekAimsBand({ day, wide = false, pinFolded = false }: { day?: string | null; wide?: boolean; pinFolded?: boolean }) {
  const { today, weekStart } = useAimToday();
  if (!day && !wide) return <TodayAimsBand />;
  return <AimsBand aimKey={weekOnOf(day ?? today, weekStart)} wide={wide} pinFolded={pinFolded} autoReview={!wide} />;
}
