/**
 * openReminderTarget——點開通知（或提醒頁「最近的提醒」的一列）之後去哪（⑨ 契約 §4）。兩殼同一支，`shell` 決定怎麼換頁。
 *
 * - node：同 Ctrl+P 選中（`goNode`）。桌機選中就開側板；手機的跳轉只捲到票卡，所以另外開全螢幕詳情——使用者點的是「那張票」，要直接看到它。
 *   定期券跳那張票，不到某一班（跳轉 API 都不收班次）。
 * - day：行程表那一天。today：今日頁（誤點區在最上面）。review：今日頁打開那週的回顧。
 * - ticketDay／routine：走各線的 `reportJump`（核心不直接碰線的頁）；線沒通車＝退回只開 App。
 * 冷啟動時路線可能還沒載好，跳之前先等一次側欄（`jumpToNode` 要靠它判斷票的家）。
 */
import { lineReportJump } from "../../lines/runtime";
import type { ReminderTarget } from "../../domain/reminders";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { useMobileDetailStore } from "../mobile/detail/mobileDetailStore";
import { goCalendar, goNode, goToday } from "../report/reportJumps";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";

export async function openReminderTarget(t: ReminderTarget, shell: "desktop" | "mobile"): Promise<void> {
  const ui = useUiStore.getState();
  ui.setSettingsOpen(false);
  if (useNodeStore.getState().routes.length === 0) await useNodeStore.getState().loadSidebar();
  switch (t.kind) {
    case "node":
      await goNode(t.id, shell);
      if (shell === "mobile") useMobileDetailStore.getState().open(t.id);
      return;
    case "day":
      goCalendar(shell);
      useScheduleUiStore.getState().requestDay(t.day);
      return;
    case "today":
      goToday(shell);
      return;
    case "review":
      goToday(shell);
      useWeekAimStore.getState().requestReview(t.weekOn);
      return;
    case "ticketDay":
      lineReportJump("ticket", { day: t.day }, shell)?.();
      return;
    case "routine":
      lineReportJump("timetable", { day: t.day }, shell)?.();
      return;
  }
}
