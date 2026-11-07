/**
 * useOutlineKeyboard——大綱容器的「導航模式」按鍵表（UI Flow 2.0／2.0a／2.0b／2.0d／2.0e 的鍵盤入口）。
 * 雙模式鐵則：target 是 input／textarea 時整張表停用（編輯語義由輸入框自理）；組字中（IME）一律不攔。
 * 取捨：Ctrl+. 交給 App 層 useGlobalHotkeys 切換側板（這裡只接無修飾鍵的 `.`），避免兩層同時處理互相抵銷。
 *
 * M3 ⑦：鍵位字面值搬進 registry（`ui/shell/hotkeys.ts`，決策記錄 :190「registry 單一來源」）——
 * 這裡只剩「id → 動作」的接線，鍵位本身由 `resolveHotkey("outline", e)` 查表決定（行為零變）。
 */
import { useEffect, type KeyboardEvent } from "react";
import { useBoardStore } from "../../store/boardStore";
import { useUiStore } from "../../store/uiStore";
import { isEditableTarget, resolveHotkey } from "../shell/hotkeys";

export interface OutlineKeyActions {
  /** Ctrl+A：多選這一頁看得到的列（回饋乙） */
  selectAll(): void;
  /** Shift+↑↓：從游標擴選（回饋乙） */
  extendSelection(delta: 1 | -1): void;
  moveSelection(delta: 1 | -1): void;
  expandSelected(): void;
  collapseSelected(): void;
  addSibling(): void;
  addTicket(): void;
  /** 丁 D-主-249：新增支線（主題）——頁首「＋ 新增 ▾」與列 ⋯ 的入口（沒有快捷鍵） */
  addBranch(): void;
  indentSelected(): void;
  outdentSelected(): void;
  completeSelected(): void;
  /** 本班運休／取消運休（定期券限定）——與今日視圖同鍵同義（M3 ④） */
  suspendSelected(): void;
  scheduleSelected(offsetDays: 0 | 1): void;
  openPanel(): void;
  deleteSelected(): void;
  reorderSelected(delta: 1 | -1): void;
  escape(): void;
  switchRoute(dir: 1 | -1): void;
  renameSelected(): void;
}

/**
 * 路線圖的分頁鍵（⑫；契約 §1）：大綱｜看板、路線｜篩選。掛在 window：路線一覽沒有鍵盤容器，看板焦點也可能在分頁籤或卡上。
 * 對話框、選單開著不攔（選單自己把鍵截住了，對話框要這裡看 target）；看板分頁自己的表不吃這兩顆，鍵會冒到這裡。
 */
export function useRouteMapViewKeys(): void {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented || isEditableTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], .ns-qa-pop')) return;
      // 確認框開著、焦點掉到 body 也一樣（同看板的鍵盤後援）
      if (e.target === document.body && document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const hit = resolveHotkey("outline", e);
      if (hit?.id !== "outline.view.1" && hit?.id !== "outline.view.2") return;
      e.preventDefault();
      const second = hit.id === "outline.view.2";
      const b = useBoardStore.getState();
      if (useUiStore.getState().routeOverview) b.setOverviewTab(second ? "filter" : "routes");
      else b.setRouteLayout(second ? "board" : "outline");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function useOutlineKeyboard(a: OutlineKeyActions) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isEditableTarget(e.target)) return; // 編輯模式：輸入框自己處理 Enter／Esc／Tab
    const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
    if (onButton && (e.key === "Enter" || e.key === " ")) return; // 讓聚焦中的按鈕自己啟動

    // 查表：沒登錄的鍵位（含帶 Ctrl／Alt 的組合，如 Ctrl+.／Ctrl+U）一律放行給全域表或瀏覽器
    const hit = resolveHotkey("outline", e);
    if (!hit) return;
    switch (hit.id) {
      case "outline.move.up":
        a.moveSelection(-1);
        break;
      case "outline.move.down":
        a.moveSelection(1);
        break;
      case "outline.reorder.up":
        a.reorderSelected(-1);
        break;
      case "outline.reorder.down":
        a.reorderSelected(1);
        break;
      case "outline.expand":
        a.expandSelected();
        break;
      case "outline.collapse":
        a.collapseSelected();
        break;
      case "outline.add.ticket":
        a.addTicket();
        break;
      case "outline.add.sibling":
        a.addSibling();
        break;
      case "outline.outdent":
        a.outdentSelected();
        break;
      case "outline.indent":
        a.indentSelected();
        break;
      case "outline.complete":
        a.completeSelected();
        break;
      case "outline.delete":
        a.deleteSelected();
        break;
      case "outline.escape":
        a.escape();
        break;
      case "outline.rename":
        a.renameSelected();
        break;
      case "outline.panel":
        a.openPanel();
        break;
      case "outline.route.prev":
        a.switchRoute(-1);
        break;
      case "outline.route.next":
        a.switchRoute(1);
        break;
      case "outline.schedule.today":
        a.scheduleSelected(0);
        break;
      case "outline.schedule.tomorrow":
        a.scheduleSelected(1);
        break;
      // 與今日頁同鍵同義（M3 ④ 評審 should-6）
      case "outline.suspend":
        a.suspendSelected();
        break;
      // 多選（回饋乙）：Ctrl+A 全選看得到的列、Shift+↑↓ 擴選；Esc 清多選在 escape() 裡先問
      case "outline.select.all":
        a.selectAll();
        break;
      case "outline.select.extend.up":
        a.extendSelection(-1);
        break;
      case "outline.select.extend.down":
        a.extendSelection(1);
        break;
      default:
        return; // registry 有、這張表還沒接線的 id：當作沒處理
    }
    e.preventDefault();
    e.stopPropagation();
  };
}
