/**
 * 時刻表線的運行報告跳轉（② 運行報告 D-主-188；`LineMount.reportJump`）。
 *   home ⇒ 時刻表首頁；stats ⇒ 統計分頁、看「日」的本期（＝運行報告卡片答的今天）；{ day } ⇒ 那天的日程（⑨ 提醒點開）。{ diary } 不歸這條線（不動作）。
 */
import type { ReportJumpTarget } from "./types";
import { gotoTimetable } from "./timetableTagEntities";
import { useTimetableStore } from "../store/timetableStore";
import { useTimetableStatsStore } from "../store/timetableStatsStore";

export async function timetableReportJump(target: ReportJumpTarget, shell: "desktop" | "mobile"): Promise<void> {
  if (typeof target === "object" && !("day" in target)) return;
  try {
    await gotoTimetable(shell);
  } catch (e) {
    console.warn("運行報告：打開時刻表失敗", e); // 錯誤已寫進 store.error，停在時刻表頁
    return;
  }
  if (typeof target === "object") {
    const tt = useTimetableStore.getState();
    tt.setView("schedule");
    await tt.setDayKey(target.day);
    return;
  }
  if (target !== "stats") return;
  useTimetableStore.getState().setView("stats");
  const st = useTimetableStatsStore.getState();
  st.setPeriod("day");
  st.toCurrent();
}
