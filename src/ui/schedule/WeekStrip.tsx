/**
 * WeekStrip——手機行程表子頁頂端的週條（主線車次①；契約 §4.4「週條」、原型 :234-336／:1258-1358）。
 *
 * 一條橫向 scroll-snap 的軌道，以今天所在週為中心 ±52 週（105 週）；週首＝`uiStore.weekStart`
 *   （`weekStart()`／`columnOf()`／`weekdayOrderOf()` 取 useCalendarController 已 export 的純函式，與桌機日曆同一把尺）。
 * 頭一列：月份鈕（「10月・2026」＋拉丁月名＋caret；點＝開合月曆覆蓋層）、月曆開著時才出現的 ‹ ›、右端「今日」小框。
 * 日格：星期字＋日數＋點（≤3 顆，路線色；已済 .32）＋〆（當天有締切）。今天＝靛菱形＋靛內環（P7，不用金）；
 *   選中（focusDay＝串流目前捲到的那天）＝靛內框。
 *
 * 互動（都往上丟、本檔不碰 store）：點日 ⇒ onPickDay；停在某週 90ms ⇒ onWeekSettle（父層更新月份字＋ ensureLoaded）；
 *   focusDay 變 ⇒ 該週捲進視野；滑鼠拖曳換週（觸控走原生 scroll-snap）；寬度變 ⇒ 用 ResizeObserver 把「應該停的那週」擺回。
 * 週條區不接子頁切換手勢（自己會橫捲；useSubSwipe 只掛在串流容器）。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { WEEKDAY_LABEL } from "../../domain";
import { addDays } from "../../lib/date";
import { dateOf, weekStart } from "../calendar/useCalendarController";

/** 一天在週條／月曆上的記號（MobileSchedule 從 calendar 切片算；color＝路線色字串，無路線＝var(--route-none)） */
export interface DayMark {
  dots: { color: string; done: boolean }[];
  due: boolean;
}

export const MONTH_EN = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** 以今天所在週為中心的週數（前後各 52） */
const HALF_WEEKS = 52;
const WEEK_COUNT = HALF_WEEKS * 2 + 1;
/** 停週後更新月份字的去抖（ms；原型 :1319） */
const SETTLE_MS = 90;

function diffDays(a: string, b: string): number {
  return Math.round((dateOf(a).getTime() - dateOf(b).getTime()) / 86_400_000);
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 「10月12日 週一」（日格 aria-label） */
export function dayAria(key: string): string {
  const d = dateOf(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 週${WEEKDAY_LABEL[d.getDay()]}`;
}

/** 點與〆（週條與月曆共用的小 DOM） */
export function DayDots({ mark }: { mark: DayMark | undefined }) {
  return (
    <span className="m-sch-dots" aria-hidden>
      {mark?.dots.map((d, i) => (
        <i key={i} className={"m-sch-dot" + (d.done ? " is-done" : "")} style={{ color: d.color }} />
      ))}
      {mark?.due && <i className="m-sch-shime">〆</i>}
    </span>
  );
}

export interface WeekStripProps {
  today: string;
  /** 串流目前捲到的那天（.is-sel） */
  focusDay: string;
  /** 週首 getDay() 值（uiStore.weekStart） */
  firstDow: number;
  marks: ReadonlyMap<string, DayMark>;
  /** 月份鈕顯示的年月（m＝0 起；月曆開著時跟月曆走） */
  label: { y: number; m: number };
  calOpen: boolean;
  onToggleCal(): void;
  /** 月曆開著時的 ‹ › */
  onShiftMonth(n: 1 | -1): void;
  onPickDay(day: string): void;
  onToday(): void;
  /** 停在某一週（first＝該週週首） */
  onWeekSettle(first: string): void;
}

const WeekRow = memo(function WeekRow({
  first,
  today,
  sel,
  marks,
  onPickDay,
}: {
  first: string;
  today: string;
  /** 本週內被選中的那天（不在本週＝null） */
  sel: string | null;
  marks: ReadonlyMap<string, DayMark>;
  onPickDay(day: string): void;
}) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(first, i)), [first]);
  return (
    <div className="m-sch-wk-week" data-first={first}>
      {days.map((k) => {
        const d = dateOf(k);
        return (
          <button
            key={k}
            type="button"
            className={
              "m-sch-wk-day" + (k === today ? " is-today" : "") + (k < today ? " is-past" : "") + (k === sel ? " is-sel" : "")
            }
            aria-label={dayAria(k)}
            aria-current={k === sel ? "date" : undefined}
            onClick={() => onPickDay(k)}
          >
            <span className="m-sch-wk-w">{WEEKDAY_LABEL[d.getDay()]}</span>
            <span className="m-sch-wk-n">
              <b>{d.getDate()}</b>
            </span>
            <DayDots mark={marks.get(k)} />
          </button>
        );
      })}
    </div>
  );
});

export function WeekStrip({
  today,
  focusDay,
  firstDow,
  marks,
  label,
  calOpen,
  onToggleCal,
  onShiftMonth,
  onPickDay,
  onToday,
  onWeekSettle,
}: WeekStripProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  /** 週條「應該」停在第幾週（寬度變動時用它重新對齊；原型 stripWant） */
  const wantRef = useRef(HALF_WEEKS);
  const settleTimer = useRef(0);
  const lastSettled = useRef<string | null>(null);

  const firstWeek = useMemo(() => addDays(weekStart(today, firstDow), -HALF_WEEKS * 7), [today, firstDow]);
  const weeks = useMemo(() => Array.from({ length: WEEK_COUNT }, (_, i) => addDays(firstWeek, i * 7)), [firstWeek]);

  const weekIdxOf = useCallback(
    (day: string) => Math.floor(diffDays(weekStart(day, firstDow), firstWeek) / 7),
    [firstDow, firstWeek],
  );
  const currentIdx = useCallback(() => {
    const t = trackRef.current;
    return t && t.clientWidth ? Math.round(t.scrollLeft / t.clientWidth) : wantRef.current;
  }, []);

  const scrollToWeek = useCallback(
    (idx: number, smooth: boolean) => {
      const t = trackRef.current;
      if (!t || idx < 0 || idx >= WEEK_COUNT) return;
      wantRef.current = idx;
      if (!t.clientWidth) return; // 版面還沒排好：ResizeObserver 量到寬度再擺
      if (idx === currentIdx()) return;
      t.scrollTo({ left: idx * t.clientWidth, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
    },
    [currentIdx],
  );

  // 第一次掛載：直接停在今天那週（auto）
  useLayoutEffect(() => {
    scrollToWeek(weekIdxOf(today), false);
  }, [weekIdxOf, scrollToWeek, today]);

  // focusDay 變 ⇒ 該週捲進視野（smooth）
  useEffect(() => {
    scrollToWeek(weekIdxOf(focusDay), true);
  }, [focusDay, weekIdxOf, scrollToWeek]);

  // 寬度變（轉向、第一次量到寬度）：把應該停的那週擺回
  useEffect(() => {
    const t = trackRef.current;
    if (!t || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!t.clientWidth) return;
      t.scrollTo({ left: wantRef.current * t.clientWidth, behavior: "auto" });
    });
    ro.observe(t);
    return () => ro.disconnect();
  }, []);

  // 停週 90ms 後回報（父層更新月份字＋補載那一週）
  const onScroll = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const t = trackRef.current;
      if (!t || !t.clientWidth) return;
      const idx = currentIdx();
      wantRef.current = idx;
      const first = weeks[idx];
      if (!first || first === lastSettled.current) return;
      lastSettled.current = first;
      onWeekSettle(first);
    }, SETTLE_MS);
  }, [currentIdx, weeks, onWeekSettle]);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  // 滑鼠拖曳換週（觸控走原生 scroll-snap；原型 :1321-1353）
  useEffect(() => {
    const t = trackRef.current;
    if (!t) return;
    let sx = 0;
    let sl = 0;
    let down = false;
    let moved = false;
    const killNextClick = () => {
      const kill = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      t.addEventListener("click", kill, { capture: true, once: true });
      window.setTimeout(() => t.removeEventListener("click", kill, { capture: true }), 50);
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      down = true;
      moved = false;
      sx = e.clientX;
      sl = t.scrollLeft;
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - sx;
      if (!moved && Math.abs(dx) > 5) {
        moved = true;
        t.classList.add("is-drag");
      }
      if (moved) t.scrollLeft = sl - dx;
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      if (!moved) return;
      const w = t.clientWidth || 1;
      const dx = e.clientX - sx;
      let i = Math.round(sl / w);
      if (Math.abs(dx) > w * 0.18) i += dx < 0 ? 1 : -1;
      i = Math.max(0, Math.min(WEEK_COUNT - 1, i));
      wantRef.current = i;
      t.scrollTo({ left: i * w, behavior: reducedMotion() ? "auto" : "smooth" });
      window.setTimeout(() => t.classList.remove("is-drag"), 380);
      killNextClick();
    };
    t.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      t.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const selWeek = weekStart(focusDay, firstDow);

  return (
    <nav className={"m-sch-wk" + (calOpen ? " is-cal" : "")} aria-label="週條">
      <div className="m-sch-wk-head">
        <button
          type="button"
          className="m-sch-wk-month"
          aria-expanded={calOpen}
          aria-label={calOpen ? "收起月曆" : `${label.m + 1}月・${label.y}，展開月曆`}
          onClick={onToggleCal}
        >
          {label.m + 1}月・{label.y}
          <span className="lat">{MONTH_EN[label.m]}</span>
          <span className="caret" aria-hidden>
            ▾
          </span>
        </button>
        <span className="m-sch-wk-nav">
          <button type="button" className="m-sch-wk-chev" aria-label="上個月" onClick={() => onShiftMonth(-1)}>
            ‹
          </button>
          <button type="button" className="m-sch-wk-chev" aria-label="下個月" onClick={() => onShiftMonth(1)}>
            ›
          </button>
        </span>
        <button
          type="button"
          className={"m-sch-wk-today" + (focusDay === today ? " is-here" : "")}
          aria-label="捲回今天"
          onClick={onToday}
        >
          <span>今日</span>
        </button>
      </div>
      <div className="m-sch-wk-fold">
        <div className="m-sch-wk-track" ref={trackRef} onScroll={onScroll} aria-hidden={calOpen || undefined}>
          {weeks.map((first) => (
            <WeekRow
              key={first}
              first={first}
              today={today}
              sel={first === selWeek ? focusDay : null}
              marks={marks}
              onPickDay={onPickDay}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}
