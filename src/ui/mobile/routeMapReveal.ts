/**
 * routeMapReveal——手機「跳到某張票」（磨光① A7；接縫 #89；契約 §2.3、§9.4）。
 *
 * 根因：手機路線圖的「開了哪條路線、縮放到哪、展開哪張詳情」是 `MobileRouteMap` 的本地狀態，今日頁也沒人讀 `selectedId`，
 * 所以從別處跳過來只能切 tab、落在第一層／清單頂端。這是一類（路線圖四處＋今日三處），收成這一支：
 *   - `useRevealStore`：可訂閱的請求槽（已經停在那個 tab 上也接得到，例如手機搜尋）。
 *     `MobileRouteMap` 收 `target === "routemap"`：進路線 →（樹載好後）展開祖先、`detailId`、捲到、閃一下（D-主-48）。
 *     `MobileToday` 收 `target === "today"`：切回今日段、捲到那張票卡、閃一下。
 *     旅客筆記的 `MobileNotes` 收 `target === "inbox"`：換到收件匣段、選中那張臨時票、捲到它。收完叫 `consume(nonce)`。
 *   - `jumpToNodeMobile(node)`：手機版的 `jumpToNode`（QuickJump.tsx），邊界規則同一套。
 *     收件匣那支也走請求槽（核心不 import 旅客筆記；由旅客筆記來讀）——旅客筆記 tab 不讀 `selectedId`，只切 tab 會落在原本那一段。
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { parseRule, type NodeRow } from "../../domain";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";

export interface RevealRequest {
  target: "routemap" | "today" | "inbox";
  /** routemap：要進的路線；today／inbox：不用 */
  routeId: string | null;
  /** 要指出的節點；routemap 給 null＝只進路線第二層（統計依路線） */
  nodeId: string | null;
  nonce: number;
}

interface RevealState {
  req: RevealRequest | null;
  request(r: Omit<RevealRequest, "nonce">): void;
  /** 只收掉自己看到的那一張（中間又來新請求就不動） */
  consume(nonce: number): void;
}

let nonce = 0;
export const useRevealStore: UseBoundStore<StoreApi<RevealState>> = create<RevealState>()((set, get) => ({
  req: null,
  request: (r) => set({ req: { ...r, nonce: ++nonce } }),
  consume: (n) => {
    if (get().req?.nonce === n) set({ req: null });
  },
}));

/** 進手機路線圖的某條路線（可指定節點）。路線載入交給 MobileRouteMap（它自己 `openRoute`），這裡只切 tab＋下請求 */
export function revealOnRouteMap(routeId: string, nodeId: string | null = null): void {
  useRevealStore.getState().request({ target: "routemap", routeId, nodeId });
  useUiStore.getState().setMobileTab("routemap");
}

/** 今日頁指出某張票（切回今日段） */
export function revealOnToday(nodeId: string): void {
  useScheduleUiStore.getState().setMobileSub("today");
  useRevealStore.getState().request({ target: "today", routeId: null, nodeId });
  useUiStore.getState().setMobileTab("today");
}

/** 旅客筆記的收件匣指出某張臨時票（換到收件匣段、選中） */
export function revealInbox(nodeId: string): void {
  useRevealStore.getState().request({ target: "inbox", routeId: null, nodeId });
  useUiStore.getState().setMobileTab("notes");
}

export interface JumpMobileOptions {
  /** 沒日期、沒路線、沒済的臨時票＝收件匣的票；給了就交給呼叫端，沒給＝`revealInbox` */
  onInbox?: (node: NodeRow) => void;
}

/**
 * 手機版 `jumpToNode`：
 *   - 臨時票（parent_id null）有執行日 ⇒ 今日（排在未來 ⇒ toast 說哪天，照桌機句子）；沒執行日沒路線沒済 ⇒ 收件匣
 *   - 路線 ⇒ 路線圖第二層；樹內節點 ⇒ 路線圖、展開到它；沒路線 ⇒ toast
 */
export async function jumpToNodeMobile(node: NodeRow, opts: JumpMobileOptions = {}): Promise<void> {
  const ui = useUiStore.getState();
  if (node.deleted_at !== null) {
    ui.showToast({ message: "找不到這張票（可能已經刪除）" });
    return;
  }
  if (node.kind === "route") {
    revealOnRouteMap(node.id, null);
    return;
  }
  if (
    node.kind === "ticket" &&
    !node.parent_id &&
    !(node.route_id && !node.scheduled_on) &&
    !(node.status === "done" && !node.scheduled_on)
  ) {
    if (!node.scheduled_on) {
      if (opts.onInbox) opts.onInbox(node);
      else revealInbox(node.id);
      return;
    }
    if (node.scheduled_on > todayKey(ui.dayStartHour)) {
      ui.setMobileTab("today");
      const [, m, d] = node.scheduled_on.split("-");
      const when = parseRule(node.repeat_rule) ? `的下一班是 ${Number(m)}/${Number(d)}` : `排在 ${Number(m)}/${Number(d)}`;
      ui.showToast({ message: `「${node.name}」${when}，今天還不會出現在清單裡` });
      return;
    }
    revealOnToday(node.id);
    return;
  }
  if (!node.route_id) {
    ui.showToast({ message: `「${node.name}」不屬於任何路線，無法跳轉` });
    return;
  }
  // 路線樹由 MobileRouteMap 進路線時載入；這裡先開，讓已經停在路線圖的情形也立刻有樹
  void useNodeStore.getState().openRoute(node.route_id);
  revealOnRouteMap(node.route_id, node.id);
}
