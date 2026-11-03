/**
 * 單擊票面＝選中＋開詳情側板（回饋甲 D-主-132；契約 §一 D）——今日、大綱、行程表（當日浮層、串流、週／月）共用。
 *
 * 列的 mousedown 走完多選（`pickClick` 回 false＝純單擊）之後呼叫 `armOpenOnClick`：
 *   - 按在列裡的控件（章、⋯、chip、徽章、摺疊鈕、輸入框）＝不開——跟 pickClick 同一把尺（`onControl`）。
 *   - 只認左鍵；右鍵是右鍵選單。
 *   - 等放開才開：按下到放開移動超過 4px＝拖曳（useDragReorder 同一個門檻），不開。
 *     拖曳開始時開側板會讓清單變窄、落點跟著跑，所以不在 mousedown 當下開。
 * 鍵盤移動選取不經過這裡，不開側板（照舊按「.」）。
 */
import { MOUSE_SLOP_PX } from "../dragReorder/dragMath";
import { onControl } from "./desktopSelection";

type Press = { target: EventTarget | null; clientX?: number; clientY?: number; button?: number };

export function armOpenOnClick(e: Press, open: () => void): void {
  if (onControl(e.target)) return;
  if (e.button !== undefined && e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const up = (u: MouseEvent) => {
    window.removeEventListener("mouseup", up, true);
    if (u.button !== 0) return;
    if (x0 !== undefined && y0 !== undefined && Math.hypot(u.clientX - x0, u.clientY - y0) > MOUSE_SLOP_PX) return;
    open();
  };
  window.addEventListener("mouseup", up, true);
}
