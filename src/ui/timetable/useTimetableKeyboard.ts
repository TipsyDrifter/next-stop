/**
 * useTimetableKeyboard——時刻表頁的「導航模式」按鍵表（車次①a 契約 §5.7；scope `timetable`；乙席接線）。
 * 寫法照 `useTodayKeyboard.ts`：IME 護欄 → isEditableTarget 放行 → 任何面板開著整張表停用 →
 * 聚焦中的 button 上的 Enter 放行 → `resolveHotkey("timetable", e)` → switch。
 *
 * 三個 id 以字串字面值出現（`pnpm probe:hotkeys` 牙齒 3）。接線在 `TimetableView.tsx`：
 *   depart → store.requestDepart()；arrive → 有運行中才 store.requestArrive()（回 false＝放行）；toggleView → store.toggleView("desktop")。
 * 全域 `Ctrl+5` 由地基的 `navHotkeys()` 產生，不在這張表。
 */
import type { KeyboardEvent } from "react";
import { isEditableTarget, resolveHotkey } from "../shell/hotkeys";

export interface TimetableKeyActions {
  /** N：発車／換車 → store.requestDepart() */
  depart(): void;
  /** Enter：到着（運行中才有效）→ store.requestArrive()；沒有運行中＝放行 */
  arrive(): boolean;
  /** V：切換視圖 → store.toggleView(shell) */
  toggleView(): void;
}

export function useTimetableKeyboard(a: TimetableKeyActions, disabled = false) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isEditableTarget(e.target)) return;
    if (disabled) return; // 面板開著：整張表停用（DialogShell 自己吃 Esc）
    const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
    if (onButton && (e.key === "Enter" || e.key === " ")) return;
    const hit = resolveHotkey("timetable", e);
    if (!hit) return;
    switch (hit.id) {
      case "timetable.depart":
        a.depart();
        break;
      case "timetable.arrive":
        if (!a.arrive()) return; // 沒有運行中：不 preventDefault、放行
        break;
      case "timetable.view":
        a.toggleView();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
}
