/**
 * useTodayKeyboard——今日視圖容器的「導航模式」按鍵表（UI Flow 1.0；M3 ③ WP2）。
 *
 * 雙模式鐵則（照 useOutlineKeyboard.ts:34-36 逐條）：
 *   1. 組字中（IME，isComposing／keyCode 229）一律不攔——Enter／Space／`.`／`T`／`L`／`U` 全是組字期功能鍵。
 *   2. target 是 input／textarea／select／contentEditable 時整張表停用（編輯語義由輸入框自理）。
 *   3. 聚焦中的 <button> 上的 Enter／Space 讓按鈕自己啟動。
 *   4. Ctrl／Cmd 組合鍵歸 App 層 useGlobalHotkeys（Ctrl+1/2/3、Ctrl+P、Ctrl+.、Ctrl+,），這裡一律放行。
 *
 * `disabled`＝草稿列／行內日誌／推遲小卡任一開著（覆蓋層自己吃鍵）→ 整張表停用。
 *   唯一例外是 Esc：一律轉成 escape()。理由是護欄——推遲小卡在 WP2 只有空殼（DeferPopover 回 null），
 *   沒有 Esc 退路的話 deferTarget 一開就再也關不掉；WP3 填完內容後這條也仍然是對的（小卡自己攔到 Esc
 *   就不會冒泡上來，攔不到才由這裡收尾）。
 *
 * 鍵位表（實施計畫 §3 WP2）：
 *   ↑↓ 移動選取・Alt+↑↓ 今日手動序・Space 済・Enter 臨時車票草稿・Shift+Enter 收件匣票
 *   T／Shift+T 排今天／明天・`.` 詳情側板・L 行內日誌・U 運休／取消運休（M3 ④）
 *   ・Delete soft delete＋undo・Esc 收覆蓋層
 *
 * M3 ⑦：鍵位字面值搬進 registry（`ui/shell/hotkeys.ts`，決策記錄 :190「registry 單一來源」）——
 * 這裡只剩「id → 動作」的接線，鍵位本身由 `resolveHotkey("today", e)` 查表決定（行為零變）。
 */
import type { KeyboardEvent } from "react";
import { isEditableTarget, matches, resolveHotkey } from "../shell/hotkeys";

export interface TodayKeyActions {
  moveSelection(delta: 1 | -1): void;
  /** 今日手動序（Alt+↑↓）；誤點列會被 store 擋下並吐一句 toast */
  reorderSelected(delta: 1 | -1): void;
  completeSelected(): void;
  /** Enter：清單尾插一張臨時車票草稿 */
  openDraft(): void;
  /** Shift+Enter：建無日期票（流入收件匣，M4 開張） */
  createInboxTicket(): void;
  /** T＝今天／Shift+T＝明天 */
  scheduleSelected(offsetDays: 0 | 1): void;
  openPanel(): void;
  /** L：選中列行內記一句 */
  openLogForSelected(): void;
  /** U：定期券本班運休／取消運休（M3 ④）；非定期券會吐一句 toast */
  suspendSelected(): void;
  deleteSelected(): void;
  escape(): void;
}

export function useTodayKeyboard(a: TodayKeyActions, disabled = false) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isEditableTarget(e.target)) return; // 編輯模式：輸入框自己處理 Enter／Esc／Tab
    if (disabled) {
      // 覆蓋層開著：只留 Esc 這條退路（見檔頭）
      if (matches(e, "today.escape")) {
        e.preventDefault();
        e.stopPropagation();
        a.escape();
      }
      return;
    }
    const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
    if (onButton && (e.key === "Enter" || e.key === " ")) return; // 讓聚焦中的按鈕自己啟動

    // 查表：沒登錄的鍵位（含帶 Ctrl／Alt 的組合，如 Ctrl+.／Ctrl+U）一律放行給全域表或瀏覽器
    const hit = resolveHotkey("today", e);
    if (!hit) return;
    switch (hit.id) {
      case "today.move.up":
        a.moveSelection(-1);
        break;
      case "today.move.down":
        a.moveSelection(1);
        break;
      case "today.reorder.up":
        a.reorderSelected(-1);
        break;
      case "today.reorder.down":
        a.reorderSelected(1);
        break;
      case "today.inbox":
        a.createInboxTicket();
        break;
      case "today.draft":
        a.openDraft();
        break;
      case "today.complete":
        a.completeSelected();
        break;
      case "today.delete":
        a.deleteSelected();
        break;
      case "today.escape":
        a.escape();
        break;
      case "today.panel":
        a.openPanel();
        break;
      case "today.schedule.today":
        a.scheduleSelected(0);
        break;
      case "today.schedule.tomorrow":
        a.scheduleSelected(1);
        break;
      case "today.log":
        a.openLogForSelected();
        break;
      case "today.suspend":
        a.suspendSelected();
        break;
      default:
        return; // registry 有、這張表還沒接線的 id：當作沒處理
    }
    e.preventDefault();
    e.stopPropagation();
  };
}
