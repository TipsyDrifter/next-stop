/**
 * MobileViewBar——售票口手機頁的「清單｜日曆｜統計」（②契約 §5.3 `.ns-tk-mviews`；丙席擁有）。
 *
 * 寫法照 MobileSegmentedBar（tablist＋滑動底線、←→ 換頁、roving tabIndex），class 用 `.ns-tk-mviews*`、
 * CSS 在 ticket-mobile.css「手機視圖列」分區（不 import schedule-mobile.css）。狀態在 `ticketStore.view`（不持久化，0-17）。
 *
 * 同檔另出 `useViewSwipe`：內容區左右滑換視圖（門檻同 useSubSwipe：邊緣 24px 不算、|dx| ≥ 56、1.5 倍主導）。
 * 只掛在 `.ns-tk-mlist`／`.ns-tk-mcal`／`.ns-tk-mstats` 三個直向捲動容器（CSS 給 touch-action: pan-y）；
 * 往左滑＝下一個視圖、往右滑＝上一個，到頭不繞回。
 */
import { useEffect, type KeyboardEvent, type RefObject } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import type { TicketView } from "../../../domain/ticketView";

const TABS: readonly { view: TicketView; label: string }[] = [
  { view: "list", label: "清單" },
  { view: "calendar", label: "日曆" },
  { view: "stats", label: "統計" },
];
const ORDER: readonly TicketView[] = TABS.map((t) => t.view);

/** 系統返回手勢的邊緣保留帶（px）；換頁門檻（px）與橫向主導比——與 useSubSwipe 同值 */
const EDGE_PX = 24;
const SWIPE_PX = 56;
const SWIPE_RATIO = 1.5;

function stepView(cur: TicketView, d: 1 | -1): TicketView | null {
  const i = ORDER.indexOf(cur) + d;
  return i < 0 || i >= ORDER.length ? null : ORDER[i];
}

export function MobileViewBar() {
  const view = useTicketStore((s) => s.view);
  const setView = useTicketStore((s) => s.setView);
  const idx = ORDER.indexOf(view);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    const next = stepView(view, d);
    e.preventDefault();
    if (!next) return;
    void setView(next);
    // 焦點跟著選中的 tab 走（roving tabIndex）
    const btn = e.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`);
    btn?.focus();
  };

  return (
    <div className="ns-tk-mviews" role="tablist" aria-label="視圖" onKeyDown={onKeyDown}>
      {TABS.map((t) => (
        <button
          key={t.view}
          type="button"
          role="tab"
          data-view={t.view}
          aria-selected={view === t.view}
          tabIndex={view === t.view ? 0 : -1}
          className={"ns-tk-mview" + (view === t.view ? " is-on" : "")}
          onClick={() => {
            if (view !== t.view) void setView(t.view);
          }}
        >
          {t.label}
        </button>
      ))}
      <span className="ns-tk-mviews-ink" aria-hidden style={{ transform: `translateX(${idx * 100}%)` }} />
    </div>
  );
}

/**
 * 內容區左右滑換視圖。輸入框、橫捲的 chips 列、趨勢圖內起手不算（趨勢圖要點條、手指常帶一點橫移）。
 * pointer 事件（滑鼠拖曳在 ?mock=1 也能驗）；直向捲動時瀏覽器發 pointercancel，等於自動放棄。
 */
export function useViewSwipe(ref: RefObject<HTMLElement | null>): void {
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
      if (t?.closest("input, textarea, [contenteditable], .ns-tk-mfilters, .ns-tk-mst-trend")) return;
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
      const st = useTicketStore.getState();
      const next = stepView(st.view, dx < 0 ? 1 : -1);
      if (!next) return;
      // 滑動換頁的那一下不要再被當成點擊（點到格子／列會跳走）：之後 350ms 內的 click 吞掉
      swallowUntil = Date.now() + 350;
      void st.setView(next);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pid) active = false;
    };
    let swallowUntil = 0;
    const click = (e: MouseEvent) => {
      if (Date.now() >= swallowUntil) return;
      swallowUntil = 0;
      e.stopPropagation();
      e.preventDefault();
    };

    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("click", click, true);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("click", click, true);
    };
  }, [ref]);
}
