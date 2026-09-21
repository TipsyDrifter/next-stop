/**
 * useOutlineKeyboard——大綱容器的「導航模式」按鍵表（UI Flow 2.0／2.0a／2.0b／2.0d／2.0e 的鍵盤入口）。
 * 雙模式鐵則：target 是 input／textarea 時整張表停用（編輯語義由輸入框自理）；組字中（IME）一律不攔。
 * 取捨：Ctrl+. 交給 App 層 useGlobalHotkeys 切換側板（這裡只接無修飾鍵的 `.`），避免兩層同時處理互相抵銷。
 *
 * M3 ⑦：鍵位字面值搬進 registry（`ui/shell/hotkeys.ts`，決策記錄 :190「registry 單一來源」）——
 * 這裡只剩「id → 動作」的接線，鍵位本身由 `resolveHotkey("outline", e)` 查表決定（行為零變）。
 */
import type { KeyboardEvent } from "react";
import { isEditableTarget, resolveHotkey } from "../shell/hotkeys";

export interface OutlineKeyActions {
  moveSelection(delta: 1 | -1): void;
  expandSelected(): void;
  collapseSelected(): void;
  addSibling(): void;
  addTicket(): void;
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
      // 共用文案 REPEAT_RESCHEDULE_MSG 就寫著「跳過本班按 U」——大綱補鍵而不是改文案（M3 ④ 評審 should-6）
      case "outline.suspend":
        a.suspendSelected();
        break;
      default:
        return; // registry 有、這張表還沒接線的 id：當作沒處理
    }
    e.preventDefault();
    e.stopPropagation();
  };
}
