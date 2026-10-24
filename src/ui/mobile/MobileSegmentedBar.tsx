/**
 * MobileSegmentedBar——手機今日 tab「今日｜行程表」兩子頁的左右滑（主線車次①；D-主-5、契約 §4.5；評審 S5）。
 *
 * UI 丙-3 F2（契約 §1 F2；視覺規範 §2.2）：本檔原本的兩段切換 `.m-sch-seg`（自畫 tablist＋滑塊）退役——
 *   分頁籤改成共用 `Tabs`，畫在頂帶下一列（`MobileTopBand` 的 tabsRow；讀 `scheduleUiStore.mobileSub`，不碰 MobileShell）。
 *   檔名沿用（兩個子頁都從這裡 import `useSubSwipe`），只剩左右滑這一支。
 *
 * `useSubSwipe`：內容區左右滑換子頁。只掛在今日子頁的 `.m-page.m-today` 與行程表的 `.m-sch-stream`
 *   （兩個都是 touch-action: pan-y 的直向捲動容器），週條／月曆覆蓋層／sheet／草稿輸入框內一律不算：
 *   - 起點距螢幕左右邊 < 24px 不算（讓給 Android 系統返回手勢）
 *   - |dx| ≥ 56px 且 |dx| > 1.5 × |dy| 才算；今日往左 ⇒ 行程表、行程表往右 ⇒ 今日
 *   pointer 事件（滑鼠拖曳在 ?mock=1 也能驗）；直向捲動時瀏覽器會發 pointercancel，等於自動放棄。
 *   狀態在 `scheduleUiStore.mobileSub`（P4：同一次開啟期間記住、不持久化、冷啟動回「今日」）。
 */
import { useEffect, type RefObject } from "react";
import { useScheduleUiStore, type MobileSub } from "../schedule/scheduleUiStore";

/** 系統返回手勢的邊緣保留帶（px） */
const EDGE_PX = 24;
/** 換頁門檻（px）與橫向主導比 */
const SWIPE_PX = 56;
const SWIPE_RATIO = 1.5;

/**
 * 內容區左右滑換子頁。`dir`＝這個容器屬於哪一個子頁（決定哪個方向有效）。
 * 輸入框／草稿列內起手不算（打字時手指常常橫滑選字）。
 */
export function useSubSwipe(ref: RefObject<HTMLElement | null>, dir: MobileSub): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let sx = 0;
    let sy = 0;
    let pid = -1;
    let active = false;

    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable], .m-sch-draft")) return;
      const w = window.innerWidth;
      if (e.clientX < EDGE_PX || e.clientX > w - EDGE_PX) return;
      sx = e.clientX;
      sy = e.clientY;
      pid = e.pointerId;
      active = true;
    };
    const up = (e: PointerEvent) => {
      if (!active || e.pointerId !== pid) return;
      active = false;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= SWIPE_RATIO * Math.abs(dy)) return;
      const ui = useScheduleUiStore.getState();
      if (dx < 0 && dir === "today") ui.setMobileSub("schedule");
      else if (dx > 0 && dir === "schedule") ui.setMobileSub("today");
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pid) active = false;
    };

    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [ref, dir]);
}
