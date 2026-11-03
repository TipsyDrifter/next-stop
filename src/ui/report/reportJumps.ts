/**
 * 運行報告的去處（② 運行報告 D-主-188；契約 §5）。兩殼共用，`shell` 決定怎麼換頁。
 * 核心的頁照既有函式；三線的頁走 `lineReportJump`（各線 mount 的 `reportJump`）——沒通車或沒填回 null，呼叫端把那個小元件畫成不可點。
 */
import { nodeRepo } from "../../data";
import { lineReportJump } from "../../lines/runtime";
import type { LineId, ReportJumpTarget } from "../../lines/types";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";
import { jumpToNode } from "../common/QuickJump";
import { jumpToNodeMobile, revealOnRouteMap } from "../mobile/routeMapReveal";

export type ReportShellKind = "desktop" | "mobile";

/** 進運行報告（今日小結、更多頁的入口） */
export function openReport(shell: ReportShellKind): void {
  const ui = useUiStore.getState();
  if (shell === "desktop") ui.setPage("report");
  else ui.setMobileTab("report");
}

export function goToday(shell: ReportShellKind): void {
  const ui = useUiStore.getState();
  if (shell === "desktop") ui.setPage("today");
  else {
    useScheduleUiStore.getState().setMobileSub("today");
    ui.setMobileTab("today");
  }
}

/** 行程表（手機在今日 tab 的「行程表」子頁） */
export function goCalendar(shell: ReportShellKind): void {
  const ui = useUiStore.getState();
  if (shell === "desktop") ui.setPage("calendar");
  else {
    useScheduleUiStore.getState().setMobileSub("schedule");
    ui.setMobileTab("today");
  }
}

/** 路線圖開這條路線 */
export async function goRoute(routeId: string, shell: ReportShellKind): Promise<void> {
  if (shell === "mobile") {
    revealOnRouteMap(routeId, null);
    return;
  }
  const ui = useUiStore.getState();
  await useNodeStore.getState().openRoute(routeId);
  ui.setPage("routemap");
  ui.setZoom(null);
  ui.select(null);
}

/** 跳到某張票（締切卡的一筆）：同 Ctrl+P 選中 */
export async function goNode(nodeId: string, shell: ReportShellKind): Promise<void> {
  const node = await nodeRepo.getNode(nodeId);
  if (!node || node.deleted_at !== null) {
    useUiStore.getState().showToast({ message: "找不到這張票（可能已經刪除）" });
    return;
  }
  if (shell === "desktop") await jumpToNode(node);
  else await jumpToNodeMobile(node);
}

/** 三線的去處；沒通車或沒填＝null */
export function lineJump(id: LineId, target: ReportJumpTarget, shell: ReportShellKind): (() => void) | null {
  return lineReportJump(id, target, shell);
}
