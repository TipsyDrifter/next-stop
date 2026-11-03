/**
 * 售票口線的運行報告跳轉（② 運行報告 D-主-188；`LineMount.reportJump`）。
 *   home ⇒ 售票口（帳本）；stats ⇒ 統計、本月。{ diary } 不歸這條線（不動作）。
 */
import type { ReportJumpTarget } from "./types";
import { useUiStore } from "../store/uiStore";
import { useTicketStore } from "../store/ticketStore";
import { monthOf } from "../domain/ticket";
import { todayKey } from "../lib/date";

export async function ticketReportJump(target: ReportJumpTarget, shell: "desktop" | "mobile"): Promise<void> {
  if (typeof target === "object") return;
  const ui = useUiStore.getState();
  if (shell === "desktop") ui.setPage("ticket");
  else ui.setMobileTab("ticket");
  try {
    await useTicketStore.getState().init(shell);
  } catch {
    return; // 錯誤已寫進 store.error，帳本會顯示並可重試
  }
  const st = () => useTicketStore.getState();
  if (target !== "stats") {
    if (st().view !== "list") await st().setView("list");
    return;
  }
  const m = monthOf(todayKey(ui.dayStartHour));
  if (st().month !== m) await st().setMonth(m);
  await st().setView("stats");
}
