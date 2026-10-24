/**
 * ScheduleGrid——日程的時間軸：預定｜刻度｜實績三欄（④ 契約 §5.1–§5.5；〈原型定案〉1、3、5；乙席）。兩殼共用 DOM。
 * 長相＝原型 v-h.js gridHtml（.vh-grid）→ 正式版 `div.ns-tt-sched-grid`（timetable.css §L）。
 *
 *   div.ns-tt-sched-grid[.is-ro|.is-picking|.is-dragging|.is-hl]（自己捲；手機、桌機都是整天一條、不整頁捲）
 *   ├ div.ns-tt-sched-ghead      sticky 欄頭「預定（差多少）｜｜實績」
 *   └ div.ns-tt-sched-gbody      高＝24 × 每小時（桌機 48px、手機 44px）
 *       ├ div.ns-tt-sched-pcol   預定欄（PlanColumn；點選排時刻時十字游標、滑過出金線）
 *       ├ div.ns-tt-sched-gut    刻度：每小時；24:00 以後「25:00」＋小字「深夜 1 時」（主線 hourTicks）；現在的時刻牌；
 *       │                        拖曳／點選的「14:15」標籤；滑過一張卡時的金線（預定開始 → 實際開始）
 *       ├ div.ns-tt-sched-acol   實績欄（ActualColumn）＋現在以後的淡斜紋
 *       └ div.ns-tt-sched-now    現在線（橫過三欄）
 *
 * 進頁捲動：今天＝現在往上約 2.6 小時；其他天＝第一張預定往上 0.6 小時（沒有就 08:00）。每一天只捲一次，之後照使用者的位置。
 * UI 丙-4 D7：預定欄一張都沒有時的那句換成共用 EmptyState（inline）；照舊浮在欄中央、不吃指標（點下去仍落到欄上排時刻）。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { hourTicks } from "../../schedule/timeGridModel";
import { clockText, nowClockMinutes } from "../../../lib/date";
import { fmtClock } from "../../../domain/timetable";
import { TT_TEXT } from "../../../store/timetableStore";
import { EmptyState } from "../../common/EmptyState";
import { ActualColumn } from "./ActualColumn";
import { PlanColumn, type CardLayout } from "./PlanColumn";
import { SCHED_UI, minFrac, pct, snapFrac } from "./scheduleModel";
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

export function ScheduleGrid({ page, layout, hourPx, drag, onDragStart, swallowClick, pcolRef, scrollRef }: ScheduleGridProps) {
  const { date, dayStartHour, now, win, grid, isToday, isFuture, canEdit, picked, activeKey, cmp, items } = page;
  const H = hourPx;
  const dayPx = 24 * H;
  const ticks = hourTicks(dayStartHour).slice(1, -1);
  const nowMin = isToday ? nowClockMinutes(date, dayStartHour, now) : null;
  const nightFrac = minFrac(1440, dayStartHour);
  /** 點選中、桌機滑鼠在預定欄上：金線跟著走 */
  const [pickHint, setPickHint] = useState<number | null>(null);

  /* ── 量：clientY → 分鐘 ── */
  const minAtY = (clientY: number): number | null => {
    const pc = pcolRef.current;
    if (!pc) return null;
    const r = pc.getBoundingClientRect();
    if (r.height <= 0) return null;
    return snapFrac((clientY - r.top) / r.height, dayStartHour);
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
      const first = grid.blocks[0];
      y = (first ? minFrac(first.startMin, dayStartHour) : minFrac(8 * 60, dayStartHour)) * dayPx - 0.6 * H;
    }
    el.scrollTop = Math.max(0, y);
  }, [grid, date, dayStartHour, H, dayPx, nowMin, scrollRef]);

  /* ── 滑過一張卡：刻度欄的金線（預定開始 → 實際開始） ── */
  let lag: { top: number; height: number; early: boolean } | null = null;
  if (activeKey && !drag) {
    const b = grid?.blocks.find((x) => x.key === activeKey);
    const c = cmp.cmp.get(activeKey);
    if (b && c && c.startDeltaMin !== null && c.startDeltaMin !== 0) {
      const y1 = minFrac(b.startMin, dayStartHour);
      const y2 = Math.max(0, Math.min(1, minFrac(b.startMin + c.startDeltaMin, dayStartHour)));
      lag = { top: Math.min(y1, y2), height: Math.abs(y2 - y1), early: y2 < y1 };
    }
  }

  const hintMin = drag ? drag.min : picked ? pickHint : null;
  const nowLbl = nowMin !== null ? fmtClock(now) : null;

  const onPcolClick = (e: ReactMouseEvent): void => {
    if (swallowClick()) return;
    if (picked) {
      const m = minAtY(e.clientY);
      setPickHint(null);
      if (m !== null) page.place(picked, m);
      return;
    }
    if (page.sel) page.setSel(null);
  };

  const cls =
    "ns-tt-sched-grid" +
    (canEdit ? "" : " is-ro") +
    (picked ? " is-picking" : "") +
    (drag ? " is-dragging" : "") +
    (activeKey && items[activeKey] && !drag ? " is-hl" : "");

  return (
    <div className={cls} ref={scrollRef} style={{ "--ns-tt-sched-h": H + "px" } as CSSProperties}>
      <div className="ns-tt-sched-ghead">
        <span className="ns-tt-sched-gh-p">
          {SCHED_UI.colPlan}
          {layout === "rail" && <i>{SCHED_UI.colDelta}</i>}
        </span>
        <span className="ns-tt-sched-gh-t" aria-hidden="true" />
        <span className="ns-tt-sched-gh-a">{SCHED_UI.colActual}</span>
      </div>
      <div className="ns-tt-sched-gbody" style={{ height: dayPx + "px" }}>
        <div
          className={"ns-tt-sched-pcol is-" + layout}
          ref={pcolRef}
          onClick={onPcolClick}
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
          <PlanColumn page={page} layout={layout} hourPx={H} drag={drag} onDragStart={onDragStart} swallowClick={swallowClick} minAtY={minAtY} />
          {grid && grid.date === date && grid.blocks.length === 0 && (
            <EmptyState inline tone="first" className="ns-tt-sched-pempty" title={page.isPast ? SCHED_UI.emptyPast : TT_TEXT.schedEmpty} />
          )}
          {hintMin !== null && hintMin !== undefined && (
            <div className="ns-tt-sched-hint" style={{ top: pct(minFrac(hintMin, dayStartHour)) }} aria-hidden="true" />
          )}
        </div>

        <div className="ns-tt-sched-gut" aria-hidden="true">
          {ticks.map((t) => {
            const near = nowMin !== null && Math.abs(t.min - nowMin) < 13;
            return (
              <span key={t.h} className={"ns-tt-sched-hl" + (t.night ? " is-nite" : "") + (near ? " is-hidden" : "")} style={{ top: pct(minFrac(t.min, dayStartHour)) }}>
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
            <div className="ns-tt-sched-fut" style={{ top: isFuture ? "0%" : pct((now - win.start) / (win.end - win.start)) }} aria-hidden="true">
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

