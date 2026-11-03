/**
 * SchedPopover——桌機日程的小面板殼（⑦ C 席）：作息段（RoutineSegPanel）與車票第二段起（SlotPanel）用；
 * 做法與長相同 PlanPopover（`.ns-tt-sched-veil`＋`.ns-tt-sched-pop.techo-card`、標題列＋會捲的本文＋不捲的按鈕列、
 * 貼在錨點右邊、放不下往上／往左收、時間軸捲動跟著重算、Esc／×／點旁邊＝關、開的時候焦點進面板、關的時候還給錨點）。
 * PlanPopover 照舊（第一段的卡），不改它的程式；這支只是把錨點與標題換成參數。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTimetableStore } from "../../../store/timetableStore";
import { TtFootContext, useTtFoot } from "../panels/controls";

const W = 316;
const MARGIN = 12;

export interface SchedPopoverProps {
  /** 錨點的 CSS 選擇器（在 rootRef 裡找；找不到＝置中偏上） */
  anchor: string;
  /** 開著的是哪一個（換了＝重新定位） */
  openId: string;
  title: ReactNode;
  rootRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function SchedPopover({ anchor, openId, title, rootRef, scrollRef, children }: SchedPopoverProps) {
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [shown, setShown] = useState(false);
  const titleId = useId();
  const { foot, el } = useTtFoot(true);

  useLayoutEffect(() => {
    const place = (): void => {
      const box = boxRef.current;
      const target = rootRef.current?.querySelector<HTMLElement>(anchor);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const bh = box?.offsetHeight ?? 360;
      let left = vw / 2 - W / 2;
      let top = 160;
      if (target) {
        const r = target.getBoundingClientRect();
        left = r.left + Math.min(r.width, 200) + MARGIN;
        top = r.top - 6;
        const sc = scrollRef.current?.getBoundingClientRect();
        if (sc) top = Math.max(sc.top, Math.min(sc.bottom - 40, top));
      }
      left = Math.max(MARGIN, Math.min(vw - W - MARGIN, left));
      top = Math.max(MARGIN, Math.min(vh - bh - MARGIN, top));
      setPos((p) => (p && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top }));
    };
    place();
    const sc = scrollRef.current;
    sc?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    const ro = typeof ResizeObserver !== "undefined" && boxRef.current ? new ResizeObserver(place) : null;
    if (ro && boxRef.current) ro.observe(boxRef.current);
    return () => {
      sc?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [anchor, openId, rootRef, scrollRef]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    boxRef.current?.focus({ preventScroll: true });
    return () => {
      const target = rootRef.current?.querySelector<HTMLElement>(anchor);
      (target ?? prev)?.focus?.({ preventScroll: true });
    };
  }, [anchor, openId, rootRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        closeSheet();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeSheet]);

  return createPortal(
    <>
      <div className="ns-tt-sched-veil" onPointerDown={closeSheet} aria-hidden="true" />
      <div
        ref={boxRef}
        className={"ns-tt-sched-pop techo-card" + (shown && pos ? " is-open" : "")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={pos ? { left: pos.left + "px", top: pos.top + "px", width: W + "px" } : { visibility: "hidden", width: W + "px" }}
      >
        <div className="ns-tt-sched-pop-h">
          <b id={titleId}>{title}</b>
          <button type="button" className="ns-close ns-close--sm" aria-label="關閉" data-tt-drop-draft="" onClick={closeSheet}>
            ×
          </button>
        </div>
        <TtFootContext.Provider value={el}>
          <div className="ns-tt-sched-pop-b">{children}</div>
        </TtFootContext.Provider>
        <div className="ns-tt-sched-pop-f">{foot}</div>
      </div>
    </>,
    document.body,
  );
}
