/**
 * MobileTimeDays——手機行程表子頁的「3 天時段」（主線②；D-主-11、契約 §4.8；原型 `:638-649`、`:1227-1262`）。
 *
 * 畫布是甲的共用件 `<TimeGrid shell="mobile">`（DOM／class 契約在那支）；手機差異只靠 schedule-mobile.css 的
 * `[data-shell="mobile"] .ns-tg…` 覆寫。本檔只管「哪幾天、橫向翻頁、點了開哪張 sheet」：
 *
 *   頁＝3 天、**從今天對齊**（自決）：`pageStart(d) = today + 3·floor((d − today) / 3)`——今天永遠是某一頁的第一欄。
 *   欄寬 `cw = floor((容器寬 − 刻度欄 40) / 3)`（TimeGrid 的 `colWidth`，固定欄寬＋每 3 欄一個 scroll-snap 錨）。
 *   一次渲染 5 頁＝15 天（`[頁首 − 6, 頁首 + 8]`）；捲停在頭尾那一頁 ⇒ 以那頁為中心重排視窗、同一個 layout 裡把
 *   `scrollLeft` 擺回那一頁（與串流補載同一個用意），畫面不動。`ensureLoaded(第一天, 最後一天)` 讓串流視窗把資料撈到。
 *   捲停（`scrollend`；退路 140ms 去抖）⇒ `onPage(目前頁的第一天)`——父層更新週條底線與 focusDay，**不**發 requestScroll
 *   （避免與串流互相拉；切回「清單」時父層才把串流對齊到這一頁）。
 *
 * 命令式出口（父層的週條、月曆、「今日」鈕用）：`goToDay(day)` 捲到含那天的頁（不在視窗內就先重排視窗再瞬移）；
 *   `goToday()` 今天那頁＋縱向捲到現在前兩小時。
 * 點擊：塊／籤（含 TimeGrid 的「點附近」）⇒ `onPick(date, nodeId)` 開 ⋯ sheet；籤帶的「＋N」⇒ `onMore(date)`（切回清單）；`onHead` 無動作（手機沒有當日清單浮層、
 *   日期列草稿只在串流）。不做拖塊改時刻、拉長改預計、點空白建票（§4.8 末）。
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { NodeRow } from "../../domain";
import type { DueEntry, ScheduleEntry } from "../../data";
import { addDays, nowClockMinutes } from "../../lib/date";
import { TimeGrid, type TimeGridHandle } from "../schedule/TimeGrid";
import { timeGridModel } from "../schedule/timeGridModel";

/** 每頁天數／視窗頁數（5 頁＝15 天；當前頁放中間） */
const PAGE = 3;
const PAGES = 5;
const WINDOW_DAYS = PAGE * PAGES;
/** 刻度欄寬（schedule-mobile.css 的 --gw 同值） */
const GUTTER = 40;
/** 不支援 scrollend 時的捲停判定 */
const SETTLE_MS = 140;

function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

/** 含 d 的那一頁的第一天（從今天對齊） */
export function pageStartOf(d: string, today: string): string {
  return addDays(today, PAGE * Math.floor(diffDays(d, today) / PAGE));
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export interface MobileTimeDaysHandle {
  goToDay(day: string, smooth?: boolean): void;
  goToday(): void;
}

export interface MobileTimeDaysProps {
  today: string;
  dayStartHour: number;
  now: number;
  /** 串流視窗的 calendar 切片（entries 已含 time） */
  entries: readonly ScheduleEntry[];
  dues: readonly DueEntry[];
  nodes: Record<string, NodeRow>;
  routes: NodeRow[];
  /** 掛載時落在含這天的頁 */
  initialDay: string;
  /** ⋯ sheet 開著的那一塊（`${date}-${node_id}`）⇒ 塊加 .is-sel */
  selectedKey: string | null;
  ensureLoaded(from: string, to: string): void;
  /** 停在某一頁（first＝那頁第一天） */
  onPage(first: string): void;
  onPick(date: string, nodeId: string): void;
  /** 點籤帶的「＋N」：第三張起的未定時票畫布裡點不到 ⇒ 父層切回「清單」並對齊到那一天 */
  onMore(date: string): void;
  handleRef?: Ref<MobileTimeDaysHandle>;
}

export function MobileTimeDays({
  today,
  dayStartHour,
  now,
  entries,
  dues,
  nodes,
  routes,
  initialDay,
  selectedKey,
  ensureLoaded,
  onPage,
  onPick,
  onMore,
  handleRef,
}: MobileTimeDaysProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<TimeGridHandle | null>(null);
  const [cw, setCw] = useState(0);
  const [page, setPage] = useState(() => pageStartOf(initialDay, today));
  const [winStart, setWinStart] = useState(() => addDays(pageStartOf(initialDay, today), -2 * PAGE));
  /** 視窗重排／量到欄寬之後要瞬移到的頁（第一天）；smooth＝重排之後改平滑；clock＝同時縱向捲到這個牆鐘分鐘（「今日」鈕） */
  const pendingRef = useRef<{ day: string; smooth: boolean; clock?: number } | null>({ day: page, smooth: false });
  // 事件監聽只綁一次，經 ref 取最新值
  const st = useRef({ winStart, page, cw, today, dayStartHour });
  st.current = { winStart, page, cw, today, dayStartHour };
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;

  const days = useMemo(() => Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(winStart, i)), [winStart]);
  const model = useMemo(
    () => timeGridModel({ days, entries, dues, nodes, dayStartHour }),
    [days, entries, dues, nodes, dayStartHour],
  );

  // 視窗的資料：讓串流視窗涵蓋這 15 天
  useEffect(() => {
    ensureLoaded(days[0], days[days.length - 1]);
  }, [days, ensureLoaded]);

  // 欄寬＝(容器寬 − 刻度欄) / 3（轉向、鍵盤收放都會變）
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (!w) return;
      const next = Math.max(1, Math.floor((w - GUTTER) / PAGE));
      if (next !== st.current.cw) {
        // 寬度變了：重排後停回同一頁
        pendingRef.current = pendingRef.current ?? { day: st.current.page, smooth: false };
        setCw(next);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 視窗重排／欄寬變了之後停回該停的頁（同一個 layout，畫面不跳）
  useLayoutEffect(() => {
    const g = gridRef.current;
    if (!g || !cw) return;
    const p = pendingRef.current;
    if (p) {
      pendingRef.current = null;
      if (p.clock !== undefined) g.scrollToDayClock(p.day, p.clock, p.smooth);
      else g.scrollToDay(p.day, p.smooth);
    }
  }, [winStart, cw]);

  // App 開著過了日界線、today 換日：頁對齊（pageStartOf）、視窗和 scroll-snap 錨都是「從今天對齊」，
  // 不重排的話頁首會和 goToDay／「今日」用新 today 算的頁錯開 1–2 欄，mandatory snap 把畫面拉回舊的錨
  const alignedToday = useRef(today);
  useEffect(() => {
    if (alignedToday.current === today) return;
    alignedToday.current = today;
    const first = pageStartOf(st.current.page, today);
    const next = addDays(first, -2 * PAGE);
    setPage(first);
    if (first !== st.current.page) onPageRef.current(first);
    if (next === st.current.winStart) {
      gridRef.current?.scrollToDay(first, false);
    } else {
      pendingRef.current = { day: first, smooth: false };
      setWinStart(next);
    }
  }, [today]);

  /** 視窗以 first 那頁為中心重排（first 已是頁首） */
  const recenter = useCallback((first: string) => {
    const next = addDays(first, -2 * PAGE);
    const shift = diffDays(next, st.current.winStart);
    if (shift === 0) return;
    // 補償用「停回那一頁」的絕對位置，不用 scrollLeft −= shift·cw：最後一頁捲不滿（3·cw＋刻度欄比容器窄 1–2px，
    // scrollLeft 被夾在最大值），相對補償會把那 1–2px 的誤差帶進新視窗、之後每頁都歪
    pendingRef.current = { day: first, smooth: false };
    setWinStart(next);
  }, []);

  // 捲停 ⇒ 目前頁；停在頭尾那一頁 ⇒ 重排視窗
  useEffect(() => {
    const sc = gridRef.current?.scroller();
    if (!sc) return;
    let timer = 0;
    let lastLeft = sc.scrollLeft;
    const settle = () => {
      window.clearTimeout(timer);
      const { cw: w, winStart: ws, page: cur } = st.current;
      if (!w) return;
      const idx = Math.max(0, Math.min(PAGES - 1, Math.round(sc.scrollLeft / (w * PAGE))));
      const first = addDays(ws, idx * PAGE);
      if (first !== cur) {
        setPage(first);
        onPageRef.current(first);
      }
      if (idx === 0 || idx === PAGES - 1) recenter(first);
    };
    const onScroll = () => {
      // 只看橫向：縱向捲動不判頁
      if (sc.scrollLeft === lastLeft) return;
      lastLeft = sc.scrollLeft;
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, SETTLE_MS);
    };
    const onEnd = () => {
      if (Math.abs(sc.scrollLeft - lastLeft) > 0.5) lastLeft = sc.scrollLeft;
      settle();
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    sc.addEventListener("scrollend", onEnd);
    return () => {
      window.clearTimeout(timer);
      sc.removeEventListener("scroll", onScroll);
      sc.removeEventListener("scrollend", onEnd);
    };
    // 捲動容器在量到欄寬之後才掛（cw 0 → 正數那一次）
  }, [cw > 0, recenter]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 捲到含 day 的那一頁。clock 有值（「今日」鈕）⇒ 縱向也在**同一次** scrollTo 裡到位：
   * 橫向、縱向分兩次發平滑捲動會互相中止（視窗內：橫向停在半路；視窗外：重排後的瞬移把縱向的平滑捲動取消）。
   */
  const goTo = useCallback((day: string, smooth: boolean, clock?: number) => {
    const { winStart: ws } = st.current;
    const first = pageStartOf(day, st.current.today);
    setPage(first);
    onPageRef.current(first);
    const k = diffDays(first, ws);
    if (k >= 0 && k <= WINDOW_DAYS - PAGE) {
      const sm = smooth && !reducedMotion();
      if (clock !== undefined) gridRef.current?.scrollToDayClock(first, clock, sm);
      else gridRef.current?.scrollToDay(first, sm);
      return;
    }
    // 不在視窗裡：以那頁為中心重排視窗，重排完瞬移過去（不補償舊的 scrollLeft；縱向一起在 layout effect 裡到位）
    pendingRef.current = { day: first, smooth: false, clock };
    setWinStart(addDays(first, -2 * PAGE));
  }, []);

  const goToDay = useCallback((day: string, smooth = true) => goTo(day, smooth), [goTo]);

  useImperativeHandle(
    handleRef,
    () => ({
      goToDay,
      goToday: () => {
        // 縱向：現在前兩小時（今天的營業日外＝08:00）。自己算、不叫 grid.scrollToNow——視窗剛重排時
        // grid 手上的 days 還是舊的（不含今天），它會退回 08:00
        const nowMin = nowClockMinutes(st.current.today, st.current.dayStartHour, Date.now());
        goTo(st.current.today, true, nowMin !== null ? nowMin - 120 : 8 * 60);
      },
    }),
    [goToDay, goTo],
  );

  return (
    <div className="m-sch-tg" ref={wrapRef}>
      {cw > 0 && (
        <TimeGrid
          days={model}
          dayStartHour={dayStartHour}
          now={now}
          today={today}
          routes={routes}
          nodes={nodes}
          shell="mobile"
          colWidth={cw}
          snapEvery={PAGE}
          selectedKey={selectedKey}
          handleRef={gridRef}
          onPick={(date, nodeId) => onPick(date, nodeId)}
          onHead={() => {}}
          onMore={onMore}
        />
      )}
    </div>
  );
}
