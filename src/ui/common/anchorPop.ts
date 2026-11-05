/**
 * 錨定浮層的共用小件（DatePicker、TimePicker）：點外面收起、落點、卡裡的 Tab 停點。
 * 從 DatePicker 抽出；規則不變。
 */
import { useEffect, type RefObject } from "react";

/** 點浮層外面就收起；anchor 本身與帶 `data-pop-toggle` 的元素（開關鈕）除外 */
export function useOutsideDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, anchor?: HTMLElement | null): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      const t = e.target;
      if (!el || !(t instanceof Node)) return;
      if (el.contains(t)) return;
      if (anchor?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-pop-toggle]")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [ref, onClose, anchor]);
}

/** 卡裡 Tab 會停的元素（roving 的格子只有那一格是 tabIndex 0；錶盤是帶 tabindex 的 div） */
export function tabStops(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>("button, input, [tabindex]") ?? []).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
}

/** anchor 模式的落點：anchor 下方 6px、左緣對齊；下方放不下翻到上方；夾進視窗（同 PopMenu）。anchor 沒有框（被收起）＝null，留在原處 */
export function placeBelow(anchor: HTMLElement, el: HTMLElement): { top: number; left: number } | null {
  const { offsetWidth: w, offsetHeight: h } = el;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const M = 12;
  const r = anchor.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  let top = r.bottom + 6;
  if (top + h > vh - M) top = Math.max(M, r.top - h - 6);
  const left = Math.max(M, Math.min(r.left, vw - w - M));
  return { top: Math.round(top), left: Math.round(left) };
}
