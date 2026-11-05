/**
 * MobileWeekAims——手機週方針的舊介面（戊 D-主-262），內部包 `MobileAimsLine`（方針擴充 辛 §7）。
 *
 *   - 今日分頁頂端（`<MobileWeekAims />`）：看今天那週，底下兩行上層，新的一期一行字換成回顧（D-主-373）。
 *   - 行程表週條下方（`<MobileWeekAims day={那天} />`）：看週條那一週。
 */
import { weekOnOf } from "../../domain/weekAims";
import { MobileAimsLine } from "./MobileAimsLine";
import { useAimToday } from "./useWeekAims";

export function MobileWeekAims({ day, onOpenStation }: { day?: string | null; onOpenStation?: (stationId: string) => void }) {
  const { today, weekStart } = useAimToday();
  return <MobileAimsLine aimKey={weekOnOf(day ?? today, weekStart)} upper={!day} autoReview={!day} onOpenStation={onOpenStation} />;
}
