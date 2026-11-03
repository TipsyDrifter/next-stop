/**
 * 旅客筆記線的運行報告跳轉（② 運行報告 D-主-188；`LineMount.reportJump`）。
 *   home／stats ⇒ 筆記頁；{ diary: day } ⇒ 那天的日記與當天足跡（桌機日記頁的足跡跟著 diaryDay；手機日記頁內嵌足跡）。
 * 換頁前先把編輯中的內容存掉（同行程表浮層「寫這天的日記」的 notesFlush）。
 */
import type { ReportJumpTarget } from "./types";
import { useUiStore } from "../store/uiStore";
import { useNotesStore } from "../store/notesStore";
import { notesFlush } from "../ui/notes/notesFlush";

export async function notesReportJump(target: ReportJumpTarget, shell: "desktop" | "mobile"): Promise<void> {
  await notesFlush.fn?.();
  const ui = useUiStore.getState();
  if (shell === "desktop") ui.setPage("notes");
  else ui.setMobileTab("notes");
  const st = useNotesStore.getState();
  if (typeof target === "object") st.openDiaryAt(target.diary);
  else st.setSection("notes");
}
