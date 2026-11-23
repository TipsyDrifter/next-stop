/**
 * ScheduleGrid——日程的時間軸：預定｜刻度｜實績三欄（④ 契約 §5.1–§5.5；第四梯 D-FB-7：支援空白軸拖拉／雙擊直接建立預留席車票）。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { hourTicks } from "../../schedule/timeGridModel";
import { clockText, nowClockMinutes, type ClockText } from "../../../lib/date";
import { fmtClock } from "../../../domain/timetable";
import { TT_TEXT } from "../../../store/timetableStore";
import { EmptyState } from "../../common/EmptyState";
import { ActualColumn } from "./ActualColumn";
import { PlanColumn, type CardLayout, type CreateRangePreview } from "./PlanColumn";
import { RoutineStrip } from "./RoutineStrip";
import { RT_UI } from "./routineModel";
import { SCHED_UI, minFrac, pct, snapFrac } from "./scheduleModel";
import { computeDragCreateRange } from "./scheduleSeatModel";
import type { SchedulePage } from "./useSchedulePage";
import type { DragSrc, DragView } from "./useScheduleDrag";

export interface ScheduleGridProps {
  page: SchedulePage;
  layout: CardLayout;
  hourPx: number;
  drag: DragView | null;
  onDragStart(key: string, src: DragSrc): (e: ReactPointerEvent<HTMLElement>) => void;
  swallowClick(): boolean;
  /** 給拖曳 hook 量位置用 */
  pcolRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function ScheduleGrid({
  page,
  layout,
  hourPx,
  drag,
  onDragStart,
  swallowClick,
  pcolRef,
  scrollRef,
}: ScheduleGridProps) {
  const { date, dayStartHour, now, win, grid, isToday, isFuture, canEdit, picked, activeKey, cmp, items, slots, blocks } =
    page;
  const hasRoutine = (page.routineDay?.segs.length ?? 0) > 0;
  const H = hourPx;
  const dayPx = 24 * H;
  const ticks = hourTicks(dayStartHour).slice(1, -1);
  const nowMin = isToday ? nowClockMinutes(date, dayStartHour, now) : null;
  const nightFrac = minFrac(1440, dayStartHour);
  /** 點選中、桌機滑鼠在預定欄上：金線跟著走 */
  const [pickHint, setPickHint] = useState<number | null>(null);
  /** 第四梯 4A：空白處上下拖拉建立「預留席車票」的動態時段預覽 */
  const [createRange, setCreateRange] = useState<CreateRangePreview | null>(null);
  const blankDragRef = useRef<{
    pointerId: number;
    startY: number;
    anchorMin: number;
    active: boolean;
    range: CreateRangePreview | null;
  } | null>(null);
  const swallowBlankUntilRef = useRef(0);

  /* ── 量：clientY → 分鐘 ── */
  const minAtY = (clientY: number): number | null => {
    const pc = pcolRef.current;
    if (!pc) return null;
    const r = pc.getBoundingClientRect();
    if (r.height <= 0) return null;
    return snapFrac((clientY - r.top) / r.height, dayStartHour);
  };

  /* ── 空白處上下拖拉建立預留席車票 ── */
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const cur = blankDragRef.current;
      if (!cur || e.pointerId !== cur.pointerId) return;
      const dy = Math.abs(e.clientY - cur.startY);
      if (!cur.active && dy < 8) return;
      cur.active = true;
      const pc = pcolRef.current;
      if (!pc) return;
      const r = pc.getBoundingClientRect();
      if (r.height <= 0) return;
      const rawMin = dayStartHour * 60 + ((e.clientY - r.top) / r.height) * 1440;
      const range = computeDragCreateRange(cur.anchorMin, rawMin, dayStartHour);
      cur.range = range;
      setCreateRange(range);
    };
    const finish = (commit: boolean) => (e: PointerEvent): void => {
      const cur = blankDragRef.current;
      if (!cur || e.pointerId !== cur.pointerId) return;
      blankDragRef.current = null;
      if (!cur.active || !cur.range) {
        setCreateRange(null);
        return;
      }
      swallowBlankUntilRef.current = Date.now() + 320;
      const finalRange = cur.range;
      setCreateRange(null);
      if (commit) {
        const startHm = clockText(finalRange.startMin) as ClockText | null;
        if (startHm) {
          void page.createPlaceholderAt(startHm, {
            durationMin: finalRange.durationMin,
            openAfter: true,
          });
        }
      }
    };
    const onUp = finish(true);
    const onCancel = finish(false);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && blankDragRef.current?.active) {
        e.preventDefault();
        e.stopPropagation();
        blankDragRef.current = null;
        setCreateRange(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [dayStartHour, page, pcolRef]);

  const onPcolPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!canEdit || picked || drag || e.button !== 0 || e.pointerType !== "mouse") return;
    if ((e.target as HTMLElement | null)?.closest(".ns-tt-sched-card, .ns-tt-rt")) return;
    const m = minAtY(e.clientY);
    if (m === null) return;
    blankDragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      anchorMin: m,
      active: false,
      range: null,
    };
  };

  /* ── 進頁捲動（每一天一次；grid 載到那一天才捲） ── */
  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !grid || grid.date !== date) return;
    const sig = `${date}|${dayStartHour}|${H}`;
    if (scrolledFor.current === sig) return;
    scrolledFor.current = sig;
    let y: number;
    if (nowMin !== null) y = minFrac(nowMin, dayStartHour) * dayPx - 2.6 * H;
    else {
      const first = blocks[0];
      y = (first ? minFrac(first.startMin, dayStartHour) : minFrac(8 * 60, dayStartHour)) * dayPx - 0.6 * H;
    }
    el.scrollTop = Math.max(0, y);
  }, [grid, blocks, date, dayStartHour, H, dayPx, nowMin, scrollRef]);

  /* ── 滑過一張卡：刻度欄的金線（預定開始 → 實際開始） ── */
  let lag: { top: number; height: number; early: boolean } | null = null;
  if (activeKey && !drag && !createRange) {
    const b = blocks.find((x) => x.key === activeKey);
    const c = cmp.cmp.get(activeKey);
    if (b && c && c.startDeltaMin !== null && c.startDeltaMin !== 0) {
      const y1 = minFrac(b.startMin, dayStartHour);
      const y2 = Math.max(0, Math.min(1, minFrac(b.startMin + c.startDeltaMin, dayStartHour)));
      lag = { top: Math.min(y1, y2), height: Math.abs(y2 - y1), early: y2 < y1 };
    }
  }

  const hintMin = createRange ? createRange.startMin : drag ? drag.min : picked ? pickHint : null;
  const nowLbl = nowMin !== null ? fmtClock(now) : null;

  const onPcolClick = (e: ReactMouseEvent): void => {
    if (swallowClick() || Date.now() < swallowBlankUntilRef.current) return;
    if (picked) {
      const m = minAtY(e.clientY);
      setPickHint(null);
      if (m !== null) page.place(picked, m);
      return;
    }
    if (page.sel) page.setSel(null);
  };

  const onPcolDoubleClick = (e: ReactMouseEvent): void => {
    if (!canEdit || picked || Date.now() < swallowBlankUntilRef.current) return;
    if ((e.target as HTMLElement | null)?.closest(".ns-tt-sched-card, .ns-tt-rt")) return;
    const m = minAtY(e.clientY);
    if (m === null) return;
    const t = clockText(m) as ClockText | null;
    if (t) void page.createPlaceholderAt(t, { durationMin: 60, openAfter: true });
  };

  const cls =
    "ns-tt-sched-grid" +
    (canEdit ? "" : " is-ro") +
    (picked ? " is-picking" : "") +
    (drag || createRange ? " is-dragging" : "") +
    (activeKey && (items[activeKey] || slots[activeKey] || page.adhocs[activeKey]) && !drag && !createRange
      ? " is-hl"
      : "") +
    (page.openRoutineId && !activeKey && !drag && !createRange ? " is-hl" : "");

  return (
    <div className={cls} ref={scrollRef} style={{ "--ns-tt-sched-h": H + "px" } as CSSProperties}>
      <div className="ns-tt-sched-ghead">
        <span className={"ns-tt-sched-gh-p" + (hasRoutine ? " has-rt" : "")}>
          {hasRoutine && <span className="ns-tt-rt-gh">{RT_UI.col}</span>}
          {SCHED_UI.colPlan}
          {layout === "rail" && <i>{SCHED_UI.colDelta}</i>}
        </span>
        <span className="ns-tt-sched-gh-t" aria-hidden="true" />
        <span className="ns-tt-sched-gh-a">{SCHED_UI.colActual}</span>
      </div>
      <div className="ns-tt-sched-gbody" style={{ height: dayPx + "px" }}>
        <div
          className={"ns-tt-sched-pcol is-" + layout + (hasRoutine ? " has-rt" : "")}
          ref={pcolRef}
          onPointerDown={onPcolPointerDown}
          onClick={onPcolClick}
          onDoubleClick={onPcolDoubleClick}
          onPointerMove={(e) => {
            if (picked && e.pointerType === "mouse") setPickHint(minAtY(e.clientY));
          }}
          onPointerLeave={() => setPickHint(null)}
        >
          {nightFrac < 1 && (
            <>
              <div className="ns-tt-sched-night" style={{ top: pct(nightFrac), height: pct(1 - nightFrac) }} aria-hidden="true" />
              <div className="ns-tt-sched-mid" style={{ top: pct(nightFrac) }} aria-hidden="true" />
            </>
          )}
          {hasRoutine && <RoutineStrip page={page} hourPx={H} swallowClick={swallowClick} />}
          <PlanColumn
            page={page}
            layout={layout}
            hourPx={H}
            drag={drag}
            createRange={createRange}
            onDragStart={onDragStart}
            swallowClick={swallowClick}
            minAtY={minAtY}
          />
          {grid && grid.date === date && blocks.length === 0 && !createRange && (
            <EmptyState
              inline
              tone="first"
              className="ns-tt-sched-pempty"
              title={page.isPast ? SCHED_UI.emptyPast : TT_TEXT.schedEmpty}
            />
          )}
          {hintMin !== null && hintMin !== undefined && (
            <div className="ns-tt-sched-hint" style={{ top: pct(minFrac(hintMin, dayStartHour)) }} aria-hidden="true" />
          )}
        </div>

        <div className="ns-tt-sched-gut" aria-hidden="true">
          {ticks.map((t) => {
            const near = nowMin !== null && Math.abs(t.min - nowMin) < 13;
            return (
              <span
                key={t.h}
                className={"ns-tt-sched-hl" + (t.night ? " is-nite" : "") + (near ? " is-hidden" : "")}
                style={{ top: pct(minFrac(t.min, dayStartHour)) }}
              >
                <span className="ns-tt-num">{t.label}</span>
                {t.sub && <small>{t.night && t.h > 24 ? `深夜 ${t.sub}` : t.sub}</small>}
              </span>
            );
          })}
          {nowMin !== null && nowLbl && (
            <span className="ns-tt-sched-nowpill ns-tt-num" style={{ top: pct(minFrac(nowMin, dayStartHour)) }}>
              {nowLbl}
            </span>
          )}
          {hintMin !== null && hintMin !== undefined && (
            <span className="ns-tt-sched-hintlbl ns-tt-num" style={{ top: pct(minFrac(hintMin, dayStartHour)) }}>
              {clockText(hintMin)}
            </span>
          )}
          {lag && (
            <span
              className={"ns-tt-sched-lag" + (lag.early ? " is-early" : "")}
              style={{ top: pct(lag.top), height: pct(lag.height) }}
            />
          )}
        </div>

        <div className="ns-tt-sched-acol">
          {nightFrac < 1 && (
            <>
              <div className="ns-tt-sched-night" style={{ top: pct(nightFrac), height: pct(1 - nightFrac) }} aria-hidden="true" />
              <div className="ns-tt-sched-mid" style={{ top: pct(nightFrac) }} aria-hidden="true" />
            </>
          )}
          {(isFuture || (isToday && now < win.end)) && (
            <div
              className="ns-tt-sched-fut"
              style={{ top: isFuture ? "0%" : pct((now - win.start) / (win.end - win.start)) }}
              aria-hidden="true"
            >
              {isFuture && <span>{SCHED_UI.notYet}</span>}
            </div>
          )}
          <ActualColumn page={page} hourPx={H} />
        </div>

        {nowMin !== null && (
          <div className="ns-tt-sched-now" style={{ top: pct(minFrac(nowMin, dayStartHour)) }} aria-hidden="true">
            <b />
          </div>
        )}
      </div>
    </div>
  );
}
