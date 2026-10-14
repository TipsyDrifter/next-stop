/**
 * MobileSegmentedBar——手機今日 tab 內的兩段切換「今日｜行程表」（主線車次①；D-主-5、契約 §4.5）。
 *
 * 一條紙色的 tablist 掛在頂帶正下方（MobileToday 根 Fragment 的第一個子節點）；選中＝靛字＋靛底線
 *   （theme.css 契約 5：紙面強調用 --accent，金只給書封）。底線 `.m-sch-seg-ink` 用 transform 滑過去（0.2s；不跟手拖曳，✎）。
 * 狀態在 `scheduleUiStore.mobileSub`（P4：同一次開啟期間記住、不持久化、冷啟動回「今日」）。
 *
 * 同檔另出 `useSubSwipe`：內容區左右滑換子頁（評審 S5）。只掛在今日子頁的 `.m-page.m-today` 與行程表的 `.m-sch-stream`
 *   （兩個都是 touch-action: pan-y 的直向捲動容器），週條／月曆覆蓋層／sheet／草稿輸入框內一律不算：
 *   - 起點距螢幕左右邊 < 24px 不算（讓給 Android 系統返回手勢）
 *   - |dx| ≥ 56px 且 |dx| > 1.5 × |dy| 才算；今日往左 ⇒ 行程表、行程表往右 ⇒ 今日
 *   pointer 事件（滑鼠拖曳在 ?mock=1 也能驗）；直向捲動時瀏覽器會發 pointercancel，等於自動放棄。
 */
import { useEffect, type KeyboardEvent, type RefObject } from "react";
import { useScheduleUiStore, type MobileSub } from "../schedule/scheduleUiStore";
import "../schedule/schedule-mobile.css";

/** 系統返回手勢的邊緣保留帶（px） */
const EDGE_PX = 24;
/** 換頁門檻（px）與橫向主導比 */
const SWIPE_PX = 56;
const SWIPE_RATIO = 1.5;

export function MobileSegmentedBar() {
  const sub = useScheduleUiStore((s) => s.mobileSub);
  const setSub = useScheduleUiStore((s) => s.setMobileSub);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setSub("schedule");
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSub("today");
    }
  };

  const tab = (key: MobileSub, label: string) => (
    <button
      type="button"
      role="tab"
      id={`m-sch-seg-${key}`}
      aria-selected={sub === key}
      tabIndex={sub === key ? 0 : -1}
      onClick={() => setSub(key)}
      className="m-sch-seg-btn"
    >
      {label}
    </button>
  );

  return (
    <div className="m-sch-seg" role="tablist" aria-label="今日分頁" onKeyDown={onKeyDown}>
      {tab("today", "今日")}
      {tab("schedule", "行程表")}
      <span
        className="m-sch-seg-ink"
        aria-hidden
        style={{ transform: `translateX(${sub === "today" ? 0 : 100}%)` }}
      />
    </div>
  );
}

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
