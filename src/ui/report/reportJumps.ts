/**
 * 運行報告的去處（② 運行報告 D-主-188 ＋ v1.33 3A-1 單日分流輕入口）。兩殼共用，`shell` 決定怎麼換頁。
 * 核心的頁照既有函式；三線的頁走 `lineReportJump` 或直達當日時間軸／帳目清單（全部包裹於 `runAtomicNav`）。
 */
import { nodeRepo } from "../../data";
import { lineById } from "../../lines/index.ts";
import { lineReportJump } from "../../lines/runtime";
import { gotoTimetable } from "../../lines/timetableTagEntities";
import type { LineId, ReportJumpTarget } from "../../lines/types";
import { runAtomicNav } from "../../store/navHistoryStore";
import { useNodeStore } from "../../store/nodeStore";
import { useNotesStore } from "../../store/notesStore";
import { useReportStore } from "../../store/reportStore";
import { useTicketStore } from "../../store/ticketStore";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { jumpToNode } from "../common/QuickJump";
import { jumpToNodeMobile, revealOnRouteMap } from "../mobile/routeMapReveal";
import { notesFlush } from "../notes/notesFlush";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";

export type ReportShellKind = "desktop" | "mobile";

export function isLineOpen(id: LineId, shell: ReportShellKind): boolean {
  const m = lineById(id);
  return (shell === "desktop" ? m.page.status : m.mobile.status) === "open";
}

/** 進運行報告（今日小結、更多頁的入口：一律回到運行報告總表） */
export function openReport(shell: ReportShellKind): void {
  void runAtomicNav(() => {
    useReportStore.getState().closeDaySpread();
    const ui = useUiStore.getState();
    if (shell === "desktop") ui.setPage("report");
    else ui.setMobileTab("report");
  });
}

export function goToday(shell: ReportShellKind): void {
  void runAtomicNav(() => {
    const ui = useUiStore.getState();
    if (shell === "desktop") ui.setPage("today");
    else {
      useScheduleUiStore.getState().setMobileSub("today");
      ui.setMobileTab("today");
    }
  });
}

/** 行程表（手機在今日 tab 的「行程表」子頁） */
export function goCalendar(shell: ReportShellKind): void {
  void runAtomicNav(() => {
    const ui = useUiStore.getState();
    if (shell === "desktop") ui.setPage("calendar");
    else {
      useScheduleUiStore.getState().setMobileSub("schedule");
      ui.setMobileTab("today");
    }
  });
}

/** 路線圖開這條路線 */
export async function goRoute(routeId: string, shell: ReportShellKind): Promise<void> {
  await runAtomicNav(async () => {
    if (shell === "mobile") {
      revealOnRouteMap(routeId, null);
      return;
    }
    const ui = useUiStore.getState();
    await useNodeStore.getState().openRoute(routeId);
    ui.setPage("routemap");
    ui.setZoom(null);
    ui.select(null);
  });
}

/** 跳到某張票（締切卡／蓋済明細的一筆）：同 Ctrl+P 選中 */
export async function goNode(nodeId: string, shell: ReportShellKind): Promise<void> {
  await runAtomicNav(async () => {
    const node = await nodeRepo.getNode(nodeId);
    if (!node || node.deleted_at !== null) {
      useUiStore.getState().showToast({ message: "找不到這張票（可能已經刪除）" });
      return;
    }
    if (shell === "desktop") await jumpToNode(node);
    else await jumpToNodeMobile(node);
  });
}

/** 3A-1：前往當日時刻表時間軸（桌機 split／axis、手機 axis） */
export async function goTimetableDay(day: string, shell: ReportShellKind): Promise<void> {
  if (!isLineOpen("timetable", shell)) return;
  await runAtomicNav(async () => {
    try {
      await gotoTimetable(shell);
    } catch (e) {
      console.warn("運行報告：打開時刻表失敗", e);
      return;
    }
    const tt = useTimetableStore.getState();
    const onAxis = tt.view === "axis" || (shell === "desktop" && tt.view === "split");
    if (!onAxis) tt.setView(shell === "mobile" ? "axis" : "split");
    await tt.setDayKey(day);
  });
}

/** 3A-1：前往當日售票口帳目清單並定位至該日 */
export async function goTicketDay(day: string, shell: ReportShellKind): Promise<void> {
  if (!isLineOpen("ticket", shell)) return;
  await runAtomicNav(async () => {
    const ui = useUiStore.getState();
    if (shell === "desktop") ui.setPage("ticket");
    else ui.setMobileTab("ticket");
    try {
      await useTicketStore.getState().init(shell);
    } catch (e) {
      console.warn("運行報告：打開售票口失敗", e);
      return;
    }
    await useTicketStore.getState().jumpToDay(day);
  });
}

/** v1.33 手帳跨頁：前往旅客筆記該日日記（支援直接進入既有篇編輯或打開空白草稿） */
export async function goDiaryDay(
  day: string,
  shell: ReportShellKind,
  opts?: { editEntryId?: string | null; openDraft?: boolean },
): Promise<void> {
  if (!isLineOpen("notes", shell)) return;
  await runAtomicNav(async () => {
    await notesFlush.fn?.();
    const ui = useUiStore.getState();
    if (shell === "desktop") ui.setPage("notes");
    else ui.setMobileTab("notes");
    const ns = useNotesStore.getState();
    if (ns.diaryQuery) await ns.setDiaryQuery("");
    ns.openDiaryAt(day);
    await ns.loadDiary();
    if (opts?.openDraft) {
      ns.openDiaryDraft();
    } else if (opts?.editEntryId) {
      ns.selectDiaryEntry(opts.editEntryId);
      ns.setDiaryEditing(opts.editEntryId);
    }
  });
}

/** v1.33 手帳跨頁：前往「車窓・理想手札」 */
export async function goIdealTecho(shell: ReportShellKind): Promise<void> {
  await runAtomicNav(() => {
    const ui = useUiStore.getState();
    if (shell === "desktop") ui.setPage("ideal");
    else ui.setMobileTab("ideal");
  });
}

/** 三線的去處；沒通車或沒填＝null */
export function lineJump(id: LineId, target: ReportJumpTarget, shell: ReportShellKind): (() => void) | null {
  return lineReportJump(id, target, shell);
}
