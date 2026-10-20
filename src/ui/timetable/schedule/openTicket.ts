/**
 * openTicket——日程面板的「打開車票」（④ 契約 §5.5；乙席）。
 * 桌機：核心 `jumpToNode`（QuickJump.tsx；邊界規則只有那一份：臨時票有執行日→今日頁選中、樹內節點→路線圖展開選中）。
 * 手機：核心 `jumpToNodeMobile`（routeMapReveal.ts；磨光① A7）——同一套邊界規則換成手機的 tab：
 *   臨時票→今日 tab 捲到那張票卡並閃一下（排在未來的照舊 toast）；樹內節點→路線圖進那條路線、展開到那張票。
 *   日程上的票一定有執行日，不會落到收件匣那一支。
 */
import { nodeRepo } from "../../../data";
import { useUiStore } from "../../../store/uiStore";
import { jumpToNode } from "../../common/QuickJump";
import { jumpToNodeMobile } from "../../mobile/routeMapReveal";

export async function openTicket(nodeId: string, shell: "desktop" | "mobile"): Promise<void> {
  const node = await nodeRepo.getNode(nodeId).catch(() => null);
  const ui = useUiStore.getState();
  if (!node || node.deleted_at !== null) {
    ui.showToast({ message: "找不到這張車票（可能已刪除）" });
    return;
  }
  if (shell === "desktop") {
    await jumpToNode(node);
    return;
  }
  await jumpToNodeMobile(node);
}
