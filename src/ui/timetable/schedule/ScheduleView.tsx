/**
 * ScheduleView——時刻表桌機頁的「日程」視圖（④ 契約 §5.1、§5.10；〈原型定案〉；D-時-71～89；乙席）。
 * 長相＝原型 prototypes/時刻表-④.html 桌機（v-h.js schedHtml is-desk）。
 *
 *   section.ns-tt-sched.is-desk（flex:1、自己不捲；捲的是時間軸）
 *   ├ div.ns-tt-sched-top    ScheduleNav（‹ 10/20（一）今天 ›、回到今天）＋ ScheduleSummary（總結一行）＋ 右側操作提示
 *   ├ div.ns-tt-sched-main
 *   │   ├ UnscheduledTray mode="side"（左欄 200px）
 *   │   └ div.ns-tt-sched-gwrap → ScheduleGrid（預定｜刻度｜實績；layout＝視窗 ≥1100px 時「差多少」另一欄 128px，窄了印在卡內第二行）
 *   ├ div.ns-tt-sched-float  拖清單項時跟著指標的小籤（portal 到 body）
 *   └ PlanPopover            sheet { kind: "plan" } 時貼在卡右邊的小面板
 *
 * 整合席掛法：TimetableView 的 schedule 分支＝`<div className="ns-tt-col is-right is-wide"><RunDock variant="desktop" /><ScheduleView /></div>`
 * （運行列在頁首下，同週／統計）；本元件自己 flex:1 撐滿、時間軸自己捲。DesktopSheetHost 對 plan 不畫（浮層在這裡）。
 * 鍵盤：←／→／T 換日由整合席接（KEY_ACTIONS 在 schedule 分支走 setDayKey，同軸）；Esc 在這裡收（取消點選；面板由 PlanPopover 收）。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { ScheduleGrid } from "./ScheduleGrid";
import { ScheduleNav, ScheduleSummary } from "./ScheduleSummary";
import { UnscheduledTray } from "./UnscheduledTray";
import { PlanPopover } from "./PlanPopover";
import { SCHED_UI } from "./scheduleModel";
import { routeColorOf, useSchedulePage, type SchedulePage } from "./useSchedulePage";
import { useScheduleDrag, type DragView } from "./useScheduleDrag";

/** 「差多少」另開一欄的視窗寬（D-時-89） */
const RAIL_MIN_VW = 1100;
const HOUR_PX = 48;

function useWide(): boolean {
  const q = `(min-width: ${RAIL_MIN_VW}px)`;
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = (): void => setWide(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [q]);
  return wide;
}

/** 兩殼共用：Esc 取消點選（面板開著時不管，交給面板） */
export function usePickEscape(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      const st = useTimetableScheduleStore.getState();
      if (st.picked === null || useTimetableStore.getState().sheet !== null) return;
      e.preventDefault();
      st.pick(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** 拖清單項時跟著指標的小籤（＝原型 .vh-float）；指標在預定欄上＝金框 */
export function DragFloat({ page, drag }: { page: SchedulePage; drag: DragView | null }) {
  if (!drag || drag.src !== "list") return null;
  const it = page.items[drag.key];
  if (!it) return null;
  return createPortal(
    <div
      className={"ns-tt-sched-float" + (drag.min !== null ? " is-over" : "")}
      style={{ left: drag.x + "px", top: drag.y + "px", "--rc": routeColorOf(page, it.nodeId) } as CSSProperties}
      aria-hidden="true"
    >
      <i className="ns-tt-sched-rdot" />
      {page.nodes[it.nodeId]?.name ?? "？"}
    </div>,
    document.body,
  );
}

export function ScheduleView() {
  const page = useSchedulePage("desktop");
  const wide = useWide();
  const rootRef = useRef<HTMLElement>(null);
  const pcolRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { drag, onPointerDown, swallowClick } = useScheduleDrag({
    enabled: page.canEdit,
    dayStartHour: page.dayStartHour,
    pcolRef,
    scrollRef,
    onDrop: (key, min) => {
      useTimetableScheduleStore.getState().setHover(null);
      page.place(key, min);
    },
    onMiss: (src) => {
      if (src === "list") useUiStore.getState().showToast({ message: `${SCHED_UI.dropMissed}：${SCHED_UI.dropMissedSub}` });
    },
  });
  usePickEscape();

  return (
    <section ref={rootRef} className="ns-tt-sched is-desk" aria-label={TT_TEXT.viewSchedule}>
      <div className="ns-tt-sched-top">
        <ScheduleNav page={page} />
        <ScheduleSummary page={page} />
        <span className="ns-tt-sched-keys">{SCHED_UI.deskKeys}</span>
      </div>
      {page.error && !page.grid && <p className="ns-tt-sched-err">⚠ {page.error}</p>}
      <div className="ns-tt-sched-main">
        <UnscheduledTray page={page} mode="side" drag={drag} onDragStart={onPointerDown} swallowClick={swallowClick} />
        <div className="ns-tt-sched-gwrap">
          <ScheduleGrid
            page={page}
            layout={wide ? "rail" : "inline"}
            hourPx={HOUR_PX}
            drag={drag}
            onDragStart={onPointerDown}
            swallowClick={swallowClick}
            pcolRef={pcolRef}
            scrollRef={scrollRef}
          />
        </div>
      </div>
      <DragFloat page={page} drag={drag} />
      {page.openKey && <PlanPopover planKey={page.openKey} rootRef={rootRef} scrollRef={scrollRef} />}
    </section>
  );
}
