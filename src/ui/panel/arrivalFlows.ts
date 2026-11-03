/**
 * 路線／幹線「到站・收進車庫」與「回到運行」的寫入流程（車庫與回顧 D-主-201～204、207；兩殼共用一支）。
 *
 * 入口：桌機路線側板底部、書封路線／幹線 ⋯；手機路線詳情頁、路線圖第一層幹線 ⋯；車庫記錄簿底部「回到運行」。
 * 計畫是純函式（domain/depot.ts 的 planArrival／planDeparture）；這裡只數沒済的票、問確認、寫、出 toast「復原」。
 *   - 還有沒済的票（列車／車廂／車票，含還在跑的定期券與掛標籤的臨時票）⇒ 確認框「還有 N 張沒済，一起收進車庫」；N=0 直接收。
 *   - 票的狀態一個都不動（收進去的不出現在今日、行程表；回到運行原樣回來）。
 */
import { nodeRepo } from "../../data";
import { planArrival, planDeparture } from "../../domain/depot";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";

const ns = () => useNodeStore.getState();
const ui = () => useUiStore.getState();

const nameOf = (id: string): { name: string; isLine: boolean } | null => {
  const s = ns();
  const line = s.lines.find((l) => l.id === id);
  if (line) return { name: line.name, isLine: true };
  const route = s.routes.find((r) => r.id === id);
  return route ? { name: route.name, isLine: false } : null;
};

/** 這幾條路線底下還沒済的票（列車／車廂／車票；定期券沒退役＝還在跑，算沒済） */
export async function countOpenTickets(routeIds: readonly string[]): Promise<number> {
  let n = 0;
  for (const rid of routeIds) {
    const rows = await nodeRepo.listRouteTree(rid).catch(() => []);
    n += rows.filter((r) => (r.kind === "train" || r.kind === "car" || r.kind === "ticket") && r.status !== "done").length;
  }
  return n;
}

export interface ArrivalFlowOptions {
  /** 真的寫之前（手機＝關詳情頁） */
  onConfirmed?: () => void;
}

/** 到站・收進車庫（路線或幹線） */
export async function requestArrive(targetId: string, opts: ArrivalFlowOptions = {}): Promise<void> {
  const who = nameOf(targetId);
  if (!who) return;
  const s = ns();
  const plan = planArrival(targetId, s.lines, s.routes, todayKey(ui().dayStartHour));
  if (!plan.writes.length) return;
  const open = await countOpenTickets(plan.routeIds);
  const run = async () => {
    opts.onConfirmed?.();
    const r = await ns().setArrival(plan.writes);
    if (!r.ok) {
      ui().showToast({ message: r.reason ?? "沒有收成功——請再試一次" }, 3600);
      return;
    }
    ui().showToast({
      message: who.isLine ? `幹線「${who.name}」收進車庫了` : `「${who.name}」收進車庫了`,
      actionLabel: "復原",
      onAction: () => void ns().setArrival(plan.undo),
    });
  };
  if (open === 0) {
    await run();
    return;
  }
  ui().askConfirm({
    title: who.isLine ? `幹線「${who.name}」到站？` : `「${who.name}」到站？`,
    body: `還有 ${open} 張沒済，一起收進車庫。回到運行時會原樣回來。`,
    confirmLabel: "收進車庫",
    onConfirm: () => void run(),
  });
}

/** 回到運行（路線或幹線；記錄簿、大綱頂上那一行） */
export async function requestDepart(targetId: string): Promise<void> {
  const who = nameOf(targetId);
  if (!who) return;
  const s = ns();
  const plan = planDeparture(targetId, s.lines, s.routes);
  if (!plan.writes.length) return;
  const r = await ns().setArrival(plan.writes);
  if (!r.ok) {
    ui().showToast({ message: r.reason ?? "沒有改成功——請再試一次" }, 3600);
    return;
  }
  ui().showToast({
    message: who.isLine ? `幹線「${who.name}」回到運行了` : `「${who.name}」回到運行了`,
    actionLabel: "復原",
    onAction: () => void ns().setArrival(plan.undo),
  });
}
