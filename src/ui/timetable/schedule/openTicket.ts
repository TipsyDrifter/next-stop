/**
 * openTicket——日程面板的「打開車票」（④ 契約 §5.5；乙席）。
 * 桌機：核心 `jumpToNode`（QuickJump.tsx；邊界規則只有那一份：臨時票有執行日→今日頁選中、樹內節點→路線圖展開選中）。
 * 手機：手機沒有共用的「跳到某張票」入口（MergeNotices.tsx 檔頭記過）；照旅客筆記手機荷札頁的那支（MobileTagPage.tsx goNode）
 *   換成手機的 tab：臨時票→今日 tab 選中；樹內節點→路線圖 tab（openRoute＋選中）。日程上的票一定有執行日，不會落到收件匣那一支。
 */
import { nodeRepo } from "../../../data";
import { parseRule } from "../../../domain/repeat";
import { todayKey } from "../../../lib/date";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { jumpToNode } from "../../common/QuickJump";

export async function openTicket(nodeId: string, shell: "desktop" | "mobile"): Promise<void> {
  const node = await nodeRepo.getNode(nodeId).catch(() => null);
  const ui = useUiStore.getState();
  if (!node || node.deleted_at !== null) {
    ui.showToast({ message: "找不到這張票（可能已經刪除）" });
    return;
  }
  if (shell === "desktop") {
    await jumpToNode(node);
    return;
  }
  if (node.kind === "ticket" && !node.parent_id) {
    ui.select(node.id);
    ui.setMobileTab("today");
    if (node.scheduled_on && node.scheduled_on > todayKey(ui.dayStartHour)) {
      const [, m, d] = node.scheduled_on.split("-");
      const when = parseRule(node.repeat_rule) ? `的下一班是 ${Number(m)}/${Number(d)}` : `排在 ${Number(m)}/${Number(d)}`;
      ui.showToast({ message: `『${node.name}』${when}，今天的清單還看不到` });
    }
    return;
  }
  if (!node.route_id) {
    ui.showToast({ message: `「${node.name}」沒有所屬路線，暫時無法跳轉` });
    return;
  }
  await useNodeStore.getState().openRoute(node.route_id);
  ui.select(node.id);
  ui.setMobileTab("routemap");
}
