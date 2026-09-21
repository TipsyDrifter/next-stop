/**
 * useCalendarKeyboard——日曆「格層」按鍵表（M3 ⑤ WP2；拍板 D-⑤-4，月／週同一張表）。
 *
 * 雙模式鐵則照 useTodayKeyboard.ts:4-8 逐條抄（a10／雷區 10）：
 *   1. 組字中（isComposing／keyCode 229）一律不攔——`Space`／`Enter` 都是組字期功能鍵。
 *   2. target 是 input／textarea／select／contentEditable 時整張表停用。
 *   3. 聚焦中的 <button>（‹ ›／今日／seg）上的 Enter／Space 讓按鈕自己啟動。
 *   4. Ctrl／Cmd 組合鍵**原則上**歸 App 層 useGlobalHotkeys（Ctrl+1/2/3／P／./,），一律放行——
 *      唯一的例外是 `Ctrl+方向鍵`（⑤-b 追加 1 的月／年跳轉）：全域表沒有這四個鍵位，
 *      本表攔下來自己用，不會蓋到任何全域快捷鍵。`Alt+方向鍵`（上一頁／下一頁）仍一律放行。
 *
 * 鍵位（拍板 D-⑤-4 ＋ ⑤-b 追加 1）：
 *   `←→` 換日・`↑↓` 換週（±7 天）・`PageUp／PageDown` 換月（週視圖＝換週）
 *   `Ctrl+←→` 換月・`Ctrl+↑↓` 換年（**兩個視圖都以月／年為單位**，與 PageUp/Down 的「週視圖＝換週」不同）
 *   `Home` 回今天・`Enter／Space` 開當日清單・`Esc` 收覆蓋層
 *   **不給 `M／W`**（視圖切換走頁首 seg，不佔字母鍵）；`T` 不在本表（與 D6「排上今天」撞語義）。
 *
 * `disabled`＝當日清單浮層開著（浮層自己吃鍵，鍵表由 WP3 負責）→ 整張表停用、只留 Esc
 * （與今日頁同一條護欄：浮層攔不到 Esc 時由這裡收尾）。
 *
 * M3 ⑦：鍵位字面值搬進 registry（`ui/shell/hotkeys.ts`，決策記錄 :190「registry 單一來源」）——
 * 這裡只剩「id → 動作」的接線，鍵位本身由 `resolveHotkey("calendar", e)` 查表決定（行為零變）。
 */
import type { KeyboardEvent } from "react";
import { isEditableTarget, matches, resolveHotkey } from "../shell/hotkeys";

export interface CalendarKeyActions {
  /** ←→ ±1 天／↑↓ ±7 天；跨出本月／本週時游標跟著推 */
  moveDay(delta: number): void;
  /** PageUp／PageDown：月視圖＝±1 月，週視圖＝±1 週 */
  movePage(delta: 1 | -1): void;
  /** Ctrl+←→：±1 月（月／週視圖同語義，⑤-b 追加 1） */
  jumpMonth(delta: number): void;
  /** Ctrl+↑↓：±1 年（同上） */
  jumpYear(delta: number): void;
  /** Home：回今天所在的月／週並選取今天 */
  goToday(): void;
  /** Enter／Space：開當日清單浮層 */
  openSelected(): void;
  escape(): void;
}

export function useCalendarKeyboard(a: CalendarKeyActions, disabled = false) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isEditableTarget(e.target)) return;
    if (disabled) {
      if (matches(e, "calendar.escape")) {
        e.preventDefault();
        e.stopPropagation();
        a.escape();
      }
      return;
    }
    const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
    if (onButton && (e.key === "Enter" || e.key === " ")) return; // ‹ ›／今日／seg 自己啟動

    // 查表：方向鍵無修飾＝日／週，Ctrl（Cmd）＝月／年（⑤-b 追加 1）；Alt+方向鍵沒登錄＝放行（瀏覽器上下頁）
    const hit = resolveHotkey("calendar", e);
    if (!hit) return;
    switch (hit.id) {
      case "calendar.month.prev":
        a.jumpMonth(-1);
        break;
      case "calendar.day.prev":
        a.moveDay(-1);
        break;
      case "calendar.month.next":
        a.jumpMonth(1);
        break;
      case "calendar.day.next":
        a.moveDay(1);
        break;
      case "calendar.year.prev":
        a.jumpYear(-1);
        break;
      case "calendar.week.prev":
        a.moveDay(-7);
        break;
      case "calendar.year.next":
        a.jumpYear(1);
        break;
      case "calendar.week.next":
        a.moveDay(7);
        break;
      case "calendar.page.prev":
        a.movePage(-1);
        break;
      case "calendar.page.next":
        a.movePage(1);
        break;
      case "calendar.today":
        a.goToday();
        break;
      case "calendar.open":
        a.openSelected();
        break;
      case "calendar.escape":
        a.escape();
        break;
      default:
        return; // registry 有、這張表還沒接線的 id：當作沒處理
    }
    e.preventDefault();
    e.stopPropagation();
  };
}
