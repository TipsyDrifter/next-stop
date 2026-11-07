/**
 * 跳轉落點碰上看板分頁（⑫）：兩殼的「跳到某張票」（桌機 jumpToNode、手機 MobileRouteMap 的落點）都在這裡分岔，不各判一次。
 *
 * 路線圖記著看板時，目標可能不是看得到的卡：有子項的列車、隱藏中的済票、支線。這種切回大綱（這次不寫記憶），跳轉才看得到東西；
 * 是卡就留在看板，看板自己捲過去（boardStore.cardReveal）。Ctrl+P、今日、提醒、運行報告都走這兩條跳轉，所以封這裡就夠。
 */
import { isVisibleCard } from "../../domain/board";
import { useBoardStore } from "../../store/boardStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";

/** 回 true＝留在看板（呼叫端不要再做大綱那套落點） */
export function landOnBoard(id: string): boolean {
  const b = useBoardStore.getState();
  if (b.routeLayout !== "board") return false;
  const { tree, currentOccurrences } = useNodeStore.getState();
  if (isVisibleCard(tree, id, currentOccurrences[id], useUiStore.getState().hideDone)) {
    b.requestCardReveal(id);
    return true;
  }
  b.showOutlineOnce();
  return false;
}
