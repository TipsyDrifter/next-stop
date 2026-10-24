/**
 * PlanPopover——桌機日程的小面板：貼在卡右邊的浮層（〈原型定案〉2、D-時-86；原型 v-h.js placePop／.vh-pop；乙席）。
 * 狀態仍是 `timetableStore.sheet = { kind: "plan", key }`（面板開著時頁面鍵盤表整張停用，跟其他面板一樣），
 * 只是不走 DesktopSheetHost 的置中 DialogShell——那邊對 plan 回 null，這裡自己畫。
 *
 *   div.ns-tt-sched-veil（透明，點了關）
 *   div.ns-tt-sched-pop.techo-card[role=dialog]：標題列（車票名＋×）＋ PlanPanel（會捲）＋按鈕列（不捲）
 *
 * UI 丙-4 D4／C1：材質換成全 App 浮層同一張 `.techo-card`（霧面玻璃，同 Ctrl+P），刪掉 CSS 手抄的實心紙＋陰影；
 * 按鈕列不再 sticky 在會捲的本文底（玻璃上要墊實心底才擋得住捲過去的字），改成本文之外的一列 `.ns-tt-sched-pop-f`——
 * 跟 DialogShell／MSheet 的黏底 foot 同一個做法（`TtFootContext`，PlanPanel 的 `<Actions>` portal 進來）。
 * × 帶 `data-tt-drop-draft`：時刻框打到一半按 × ＝丟掉草稿、不寫（同 PlanPanel 其他按鈕）。
 *
 * 位置：卡的左緣＋min(卡寬, 200)＋12，頂端對齊卡頂 −6；放不下往上收、往左收（視窗內留 12px）。
 * 時間軸捲動、視窗改大小時跟著重算；卡捲出可見範圍就貼在邊上（不關，免得打到一半被收掉）。Esc／×／點旁邊＝關。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTimetableStore } from "../../../store/timetableStore";
import { useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { PlanPanel } from "../panels/PlanPanel";
import { TtFootContext, useTtFoot } from "../panels/controls";

const W = 316;
const MARGIN = 12;

export function PlanPopover({ planKey, rootRef, scrollRef }: { planKey: string; rootRef: RefObject<HTMLElement | null>; scrollRef: RefObject<HTMLElement | null> }) {
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  const name = useTimetableScheduleStore((s) => {
    const it = s.items[planKey];
    return it ? (s.nodes[it.nodeId]?.name ?? "") : "";
  });
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [shown, setShown] = useState(false);
  const titleId = useId();
  const { foot, el } = useTtFoot(true);

  useLayoutEffect(() => {
    const place = (): void => {
      const box = boxRef.current;
      const card = rootRef.current?.querySelector<HTMLElement>(`.ns-tt-sched-card[data-key="${CSS.escape(planKey)}"]`);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const bh = box?.offsetHeight ?? 360;
      let left = vw / 2 - W / 2;
      let top = 160;
      if (card) {
        const r = card.getBoundingClientRect();
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
  }, [planKey, rootRef, scrollRef]);

  // 進場：先放好位置再淡入（transform 從左邊滑 8px）
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // 開的時候焦點進面板；關的時候還給那張卡
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    boxRef.current?.focus({ preventScroll: true });
    return () => {
      const card = rootRef.current?.querySelector<HTMLElement>(`.ns-tt-sched-card[data-key="${CSS.escape(planKey)}"]`);
      (card ?? prev)?.focus?.({ preventScroll: true });
    };
  }, [planKey, rootRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
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
          <b id={titleId}>{name}</b>
          <button type="button" className="ns-close ns-close--sm" aria-label="關閉" data-tt-drop-draft="" onClick={closeSheet}>
            ×
          </button>
        </div>
        <TtFootContext.Provider value={el}>
          <div className="ns-tt-sched-pop-b">
            <PlanPanel key={planKey} onDone={closeSheet} shell="desktop" />
          </div>
        </TtFootContext.Provider>
        <div className="ns-tt-sched-pop-f">{foot}</div>
      </div>
    </>,
    document.body,
  );
}
