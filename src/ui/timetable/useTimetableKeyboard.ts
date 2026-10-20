/**
 * useTimetableKeyboard——時刻表頁的「導航模式」按鍵表（車次①a 契約 §5.7；scope `timetable`；乙席接線）。
 * 寫法照 `useTodayKeyboard.ts`：IME 護欄 → isEditableTarget 放行 → 任何面板開著整張表停用 →
 * 聚焦中的 button 上的 Enter／Space 放行 → `resolveHotkey("timetable", e)` → switch。
 *
 * 車次①b 加七個 id（←／→／T／R／E／S／F，①b①c 契約 §5.9）。id 一律以字串字面值出現（`pnpm probe:hotkeys` 牙齒 3）。
 * 接線全在 `TimetableView.tsx`（回 false＝放行、不 preventDefault）。←／→ 在聚焦的 button 上照樣作用（不屬 Enter／Space）。
 * F2（契約 0-13）：疊層關掉後焦點落在 body、keydown 不經過 `.page` ⇒ TimetableView 在 window 掛後援監聽，
 * 原生事件也走同一支 `handleTimetableKey`。
 * 全域 `Ctrl+5` 由地基的 `navHotkeys()` 產生，不在這張表。
 *
 * 車次③（③ 契約 §5.8、D-時-57；整合席）：加七個 id——1–4 切視圖（`showView`）、D／W／M 換統計的期（`statsPeriod`，
 * 不在統計視圖回 false 放行）。←／→／T 不另登記：同一組 `dayPrev`／`dayNext`／`dayToday` 由接線端依 view 分派
 * （週視圖＝換週／回本週，統計＝換期／回本期，其餘＝換日）。面板開著時照舊整張表停用。
 *
 * 車次④（④ 契約 0-7、§5.10；D-時-74；整合席）：加 `timetable.view.5`＝日程。←／→／T 在日程＝換日（接線端分派）。
 * 車次⑤（⑤ 契約 0-6；D-時-92、104；整合席）：加 `timetable.view.6`＝方眼。←／→／T 在方眼＝換日（同軸）；Esc 由方眼元件自己處理、不進這張表；
 *   Enter 照舊＝到着（不給方眼）。
 */
import type { KeyboardEvent } from "react";
import { isEditableTarget, resolveHotkey, type KeyLike } from "../shell/hotkeys";

/** 1–6 對應的視圖（＝切換鈕六格的順序，D-時-46；④ D-時-74 加日程；⑤ D-時-92 加方眼） */
export type TimetableKeyView = "split" | "axis" | "week" | "stats" | "schedule" | "grid";
/** D／W／M 對應的統計期 */
export type TimetableKeyPeriod = "day" | "week" | "month";

export interface TimetableKeyActions {
  /** N：発車／換車 → store.requestDepart() */
  depart(): void;
  /** Enter：到着（運行中才有效）→ store.requestArrive()；沒有運行中＝放行 */
  arrive(): boolean;
  /** V：切換視圖 → store.toggleView(shell) */
  toggleView(): void;

  /* 車次①b（①b①c 契約 §5.9）的七支；回 false＝放行 */
  /** ←：前一天 → setDayKey(addDays(dayKey, -1))；③：週視圖＝上一週、統計＝上一期 */
  dayPrev(): void;
  /** →：後一天；看今天時回 false（放行）；③：週視圖＝下一週、統計＝下一期（已在本週／本期回 false） */
  dayNext(): boolean;
  /** T：回今天；已是今天回 false（放行）；③：週視圖＝回到本週、統計＝回到本期（已在本週／本期回 false） */
  dayToday(): boolean;
  /** R：有運行中 ⇒ openSheet restart；否則回 false（放行） */
  restart(): boolean;
  /** E：openSheet categories */
  settings(): void;
  /** S：有運行中且已跑 ≥ 2 分 ⇒ openSheet split；否則回 false（放行） */
  split(): boolean;
  /** F：store.requestFillLatestGap() */
  fill(): void;

  /* 車次③（③ 契約 §5.8）的兩支 */
  /** 1–6：store.setView(v) */
  showView(v: TimetableKeyView): void;
  /** D／W／M：統計 store.setPeriod(p)；不在統計視圖回 false（放行） */
  statsPeriod(p: TimetableKeyPeriod): boolean;
}

/** React 合成事件與原生 `KeyboardEvent` 共同的形狀（F2 的 body 後援監聽也走同一支 handler，①b①c 契約 §5.9 末條） */
export type TimetableKeyEvent = KeyLike & {
  target: EventTarget | null;
  isComposing?: boolean;
  keyCode?: number;
  preventDefault(): void;
  stopPropagation(): void;
};

/**
 * 表本體：IME 護欄 → isEditableTarget 放行 → 面板開著停用 → 聚焦 button 上的 Enter／Space 放行 → resolveHotkey → switch。
 * 原生事件直接餵；React 事件由 hook 把 `nativeEvent.isComposing` 補進來（合成事件本身沒有 isComposing）。
 */
export function handleTimetableKey(e: TimetableKeyEvent, a: TimetableKeyActions, disabled: boolean): void {
  if (e.isComposing || e.keyCode === 229) return;
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
    case "timetable.day.prev":
      a.dayPrev();
      break;
    case "timetable.day.next":
      if (!a.dayNext()) return;
      break;
    case "timetable.day.today":
      if (!a.dayToday()) return;
      break;
    case "timetable.restart":
      if (!a.restart()) return;
      break;
    case "timetable.settings":
      a.settings();
      break;
    case "timetable.split":
      if (!a.split()) return;
      break;
    case "timetable.fill":
      a.fill();
      break;
    case "timetable.view.1":
      a.showView("split");
      break;
    case "timetable.view.2":
      a.showView("axis");
      break;
    case "timetable.view.3":
      a.showView("week");
      break;
    case "timetable.view.4":
      a.showView("stats");
      break;
    case "timetable.view.5":
      a.showView("schedule");
      break;
    case "timetable.view.6":
      a.showView("grid");
      break;
    case "timetable.stats.day":
      if (!a.statsPeriod("day")) return;
      break;
    case "timetable.stats.week":
      if (!a.statsPeriod("week")) return;
      break;
    case "timetable.stats.month":
      if (!a.statsPeriod("month")) return;
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

export function useTimetableKeyboard(a: TimetableKeyActions, disabled = false) {
  return (e: KeyboardEvent<HTMLElement>) => {
    handleTimetableKey(
      {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        target: e.target,
        isComposing: e.nativeEvent.isComposing,
        keyCode: e.keyCode,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
      },
      a,
      disabled,
    );
  };
}
