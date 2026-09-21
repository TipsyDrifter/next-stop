/**
 * useCalendarController——日曆頁的**插槽契約**（M3 ⑤ WP2）。
 *
 * 一個頁面只呼叫一次（CalendarView），其餘元件（MonthGrid／WeekGrid／DayPopover／DueTip／
 * MonthHeaderNotes）一律用 `useCalendar()` 從 context 取同一份 api——Wave C 三席只填自己的檔，
 * 不改本檔的簽名。
 *
 * 它管的東西（草案 §3 WP2「控制器插槽」）：
 *   游標（在看哪個月／週；**不記憶**，進頁一律落今天＝D-⑤-1）、視圖（讀 uiStore.calendarView）、
 *   區間與載入（loadCalendar）、日界線今天（todayKey＋跨日 timer）、選取格、浮層目標、tip 目標、
 *   月／年跳轉小卡的開關與錨（⑤-b 追加 1）、依日期分組的 memo、格層鍵盤動作。
 *
 * 幾條刻意的設計：
 *   - **游標存的是「錨點日」`anchor`（YYYY-MM-DD），不是月份字串**：切月／週視圖時同一個錨點日
 *     自動落到「那一天所在的月／週」，不必為兩種視圖各存一份游標。
 *   - 區間＝月視圖當月 1 日～月底、週視圖該週一～日（技術自決，草案 §1 末段）；**前後月的 `.out`
 *     格不進區間**（原型 :1027-1028 只畫日數）。
 *   - 「今天」＝`todayKey(dayStartHour)`（D9 日界線 03:00），沿 ③ 的每分鐘 timer（雷區 8）：
 *     key 變了才 setState，不變完全不動。
 *   - 資料一律由 `nodeStore.calendar` 來；本檔不自己查 repository。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { NodeRow } from "../../domain";
import { WEEKDAY_ORDER } from "../../domain";
import type { DateCount, DueEntry, ScheduleEntry } from "../../data";
import { countByDate, DEV_FLAGS } from "../../data";
import { addDays, todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import type { CalendarKeyActions } from "./useCalendarKeyboard";

export type CalendarViewMode = "month" | "week";

/**
 * 跳轉可及的年份範圍（⑤-b 追加 1 派工指定 1970–2100）。
 * 手帳不是萬年曆——上下界一是給年份輸入欄一個防呆，二是讓 Ctrl+↑↓ 按到底時原地停住而不是無限往外飛。
 */
export const YEAR_MIN = 1970;
export const YEAR_MAX = 2100;

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

/** 浮層／tip 的目標：哪一天＋定位錨（格元素或格角〆） */
export interface CalendarDayTarget {
  day: string;
  anchor: HTMLElement | null;
}

/** 依日期分組的三張表（同一個 memo 出，WP3／WP4／WP5 共用） */
export interface CalendarByDate {
  entries: Record<string, ScheduleEntry[]>;
  dues: Record<string, DueEntry[]>;
  /** `countByDate(entries)`——每格「N 班」與頁首統計同一把尺（r4：含臨時車票與重複班次） */
  counts: Record<string, DateCount>;
}

export interface CalendarStats {
  /** 區間內班次總數（＝格內「N 班」的加總） */
  total: number;
  done: number;
  skipped: number;
  /** 還沒交代的（total − done − skipped）＝銀河統計的「還有 N 班」 */
  open: number;
  /** 區間內未完成的締切件數（D-⑤-5-2） */
  dues: number;
}

export interface CalendarControllerApi {
  view: CalendarViewMode;
  setView(view: CalendarViewMode): void;

  /** 月視圖＝該月 1 日 key；週視圖＝該週一 key */
  cursor: string;
  /** ±1 月（月視圖）／±1 週（週視圖） */
  go(delta: number): void;
  /**
   * 跳到指定年月（⑤-b 追加 1）：月視圖＝該月，週視圖＝該月 1 日所在的那一週。
   * 年份夾在 1970–2100、月份夾在 1–12（呼叫端不必自己夾）。
   */
  jumpTo(year: number, month: number): void;
  /** 回到今天所在的月／週，並選取今天 */
  goToday(): void;
  /** 這個視圖要載的資料區間（月＝1 日～月底；週＝一～日） */
  range: { from: string; to: string };
  /** 畫出來的格（月＝35／42 格含前後月；週＝7 格），一律 YYYY-MM-DD */
  days: string[];
  /** 日界線今天（跨 03:00 自動重算） */
  today: string;

  selectedDay: string | null;
  selectDay(day: string | null): void;

  popTarget: CalendarDayTarget | null;
  openDay(day: string, anchor: HTMLElement | null): void;
  closeDay(): void;

  tipTarget: CalendarDayTarget | null;
  showTip(day: string, anchor: HTMLElement | null): void;
  hideTip(): void;

  /** 月／年快速跳轉小卡（⑤-b 追加 1）：null＝關；非 null＝開，值是定位錨（頁首的月份大字鈕） */
  jumpAnchor: HTMLElement | null;
  jumpOpen: boolean;
  openJump(anchor: HTMLElement | null): void;
  closeJump(): void;

  byDate: CalendarByDate;
  /** entries／dues 提到的節點（票名、route_id、scheduled_on…） */
  nodes: Record<string, NodeRow>;
  routes: NodeRow[];
  /** 節點的路線（無路線＝undefined，呼叫端用 `--route-none`） */
  routeOf(nodeId: string): NodeRow | undefined;

  stats: CalendarStats;
  /** 覆蓋層開著＝格層鍵盤表停用（只留 Esc） */
  blocked: boolean;
  keys: CalendarKeyActions;
  focusContainer(): void;
}

/* ═══════════ 日期小工具（本地日期，不經 Date.parse 以免 date-only 被當 UTC） ═══════════ */

/** YYYY-MM-DD → 本地 Date */
export function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function keyOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 該月 1 日 */
export function monthStart(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

/** 該月最後一天 */
export function monthEnd(key: string): string {
  const d = dateOf(key);
  return keyOf(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/** ±N 月（日固定落 1 日，不會有 31 日溢位問題） */
export function addMonths(key: string, n: number): string {
  const d = dateOf(monthStart(key));
  return keyOf(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

/** 該週的週一（週起始＝WEEKDAY_ORDER[0]＝一，與 wk-head 同序） */
export function weekStart(key: string): string {
  return addDays(key, -columnOf(key));
}

/** 這一天在 wk-head 的第幾欄（0＝一 … 6＝日） */
export function columnOf(key: string): number {
  return WEEKDAY_ORDER.indexOf(dateOf(key).getDay());
}

/* ═══════════ context（一頁一份 api，子元件不再各自建 state） ═══════════ */

const Ctx = createContext<CalendarControllerApi | null>(null);

export const CalendarProvider = Ctx.Provider;

/** 子元件取控制器；沒有 Provider 就是接線錯了，直接丟以免默默畫出空頁 */
export function useCalendar(): CalendarControllerApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useCalendar 必須在 <CalendarProvider> 之內使用");
  return api;
}

/* ═══════════ 控制器本體 ═══════════ */

export function useCalendarController(containerRef: RefObject<HTMLElement | null>): CalendarControllerApi {
  const calendar = useNodeStore((s) => s.calendar);
  const routes = useNodeStore((s) => s.routes);
  const loadCalendar = useNodeStore((s) => s.loadCalendar);
  const view = useUiStore((s) => s.calendarView);
  const setCalendarView = useUiStore((s) => s.setCalendarView);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const [today, setToday] = useState(() => todayKey(dayStartHour));
  // 游標＝錨點日；月／週由 view 推。`?day=YYYY-MM-DD`（dev／mock 專用）＝直接落在那一天所在的月／週
  const [anchor, setAnchor] = useState(DEV_FLAGS.day ?? today);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [popTarget, setPopTarget] = useState<CalendarDayTarget | null>(null);
  const [tipTarget, setTipTarget] = useState<CalendarDayTarget | null>(null);
  // 月／年跳轉小卡：一份 state 同時管「開沒開」與「錨在哪」（外層 null＝關；內層 anchor 可為 null＝置中落位）
  const [jump, setJump] = useState<{ anchor: HTMLElement | null } | null>(null);

  /* ───────── 日界線今天：設定改了立刻重算，之後每分鐘看一次（雷區 8） ───────── */
  useEffect(() => {
    setToday(todayKey(dayStartHour));
  }, [dayStartHour]);

  useEffect(() => {
    const timer = setInterval(() => {
      const key = todayKey(useUiStore.getState().dayStartHour);
      setToday((prev) => (prev === key ? prev : key)); // 不變就完全不動（不觸發 render）
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  /* ───────── 游標 → 區間與格 ───────── */
  const cursor = view === "month" ? monthStart(anchor) : weekStart(anchor);
  const range = useMemo(
    () => (view === "month" ? { from: cursor, to: monthEnd(cursor) } : { from: cursor, to: addDays(cursor, 6) }),
    [view, cursor],
  );

  const days = useMemo(() => {
    if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(cursor, i));
    // 月：前置 lead 格（上個月）＋當月＋補滿整列（原型 :997-999 同一套算法）
    const lead = columnOf(cursor);
    const daysInMonth = dateOf(monthEnd(cursor)).getDate();
    const total = Math.ceil((lead + daysInMonth) / 7) * 7;
    return Array.from({ length: total }, (_, i) => addDays(cursor, i - lead));
  }, [view, cursor]);

  /* ───────── 載入（同區間去重由 store 負責；today 變了也要重撈 is_late） ───────── */
  useEffect(() => {
    void loadCalendar(range.from, range.to);
  }, [loadCalendar, range.from, range.to, today, dayStartHour]);

  /* ───────── 依日期分組 ───────── */
  const byDate = useMemo<CalendarByDate>(() => {
    const entries: Record<string, ScheduleEntry[]> = {};
    const dues: Record<string, DueEntry[]> = {};
    for (const e of calendar.entries) (entries[e.date] ??= []).push(e);
    for (const d of calendar.dues) (dues[d.date] ??= []).push(d);
    return { entries, dues, counts: countByDate(calendar.entries) };
  }, [calendar.entries, calendar.dues]);

  // 換月的那一瞬間 store 還是上一個區間的資料——統計只認落在本區間內的，免得數字閃一下錯的
  const stats = useMemo<CalendarStats>(() => {
    let total = 0;
    let done = 0;
    let skipped = 0;
    for (const e of calendar.entries) {
      if (e.date < range.from || e.date > range.to) continue;
      total++;
      if (e.is_done) done++;
      else if (e.occurrence_status === "skipped") skipped++;
    }
    const dues = calendar.dues.filter((d) => d.date >= range.from && d.date <= range.to).length;
    return { total, done, skipped, open: total - done - skipped, dues };
  }, [calendar.entries, calendar.dues, range.from, range.to]);

  const routeOf = useCallback(
    (nodeId: string): NodeRow | undefined => {
      const rid = calendar.nodes[nodeId]?.route_id;
      return rid ? routes.find((r) => r.id === rid) : undefined;
    },
    [calendar.nodes, routes],
  );

  /* ───────── 動作 ───────── */
  const focusContainer = useCallback(() => containerRef.current?.focus(), [containerRef]);

  const selectDay = useCallback((day: string | null) => setSelectedDay(day), []);

  const closeDay = useCallback(() => {
    setPopTarget(null);
    focusContainer();
  }, [focusContainer]);

  const openDay = useCallback((day: string, el: HTMLElement | null) => {
    setTipTarget(null); // 開浮層就收 tip（原型 :1147）
    setSelectedDay(day);
    setPopTarget({ day, anchor: el });
  }, []);

  const showTip = useCallback((day: string, el: HTMLElement | null) => setTipTarget({ day, anchor: el }), []);
  const hideTip = useCallback(() => setTipTarget(null), []);

  const openJump = useCallback((el: HTMLElement | null) => {
    setPopTarget(null); // 跳轉卡與當日浮層互斥（兩張卡同時開會搶「點外關閉」）
    setTipTarget(null);
    setJump({ anchor: el });
  }, []);

  const closeJump = useCallback(() => {
    setJump(null);
    focusContainer();
  }, [focusContainer]);

  const setView = useCallback(
    (next: CalendarViewMode) => {
      if (next === view) return;
      void setCalendarView(next); // 記憶＝settings key calendar_view（r4）
      setPopTarget(null);
      setTipTarget(null);
    },
    [view, setCalendarView],
  );

  const go = useCallback(
    (delta: number) => {
      setPopTarget(null);
      setTipTarget(null);
      setAnchor((prev) => (view === "month" ? addMonths(prev, delta) : addDays(prev, delta * 7)));
      setSelectedDay(null); // 換月＝焦點回格層起點，由 moveDay 重新落點
    },
    [view],
  );

  /**
   * 跳到指定年月（⑤-b 追加 1）。錨點日落該月 1 日 → 月視圖＝該月、週視圖＝含 1 日的那一週（拍板文字）。
   * 夾範圍在這一層做，呼叫端（小卡年份欄、Ctrl 方向鍵）不必各夾一次。
   */
  const jumpTo = useCallback((year: number, month: number) => {
    const y = clamp(Math.round(year), YEAR_MIN, YEAR_MAX);
    const m = clamp(Math.round(month), 1, 12);
    setPopTarget(null);
    setTipTarget(null);
    setAnchor(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`);
    setSelectedDay(null); // 與 go 同：換月＝焦點回格層起點，由 moveDay 重新落點
  }, []);

  /**
   * Ctrl+←→（±1 月）／Ctrl+↑↓（±1 年）——**月／年為單位，兩個視圖同語義**（拍板文字）。
   * 與 `jumpTo` 不同的是這裡保留日數（1/31 → 2/28 由 clampToMonth 夾），週視圖才會落在「下個月的同一天那一週」
   * 而不是每次都被拉回月初。年份出界就原地不動（不靜默繞回 1970）。
   */
  const shiftMonths = useCallback(
    (months: number) => {
      setPopTarget(null);
      setTipTarget(null);
      setAnchor((prev) => {
        const next = addMonths(prev, months);
        const y = Number(next.slice(0, 4));
        if (y < YEAR_MIN || y > YEAR_MAX) return prev;
        return clampToMonth(next, Number(prev.slice(8, 10)));
      });
      setSelectedDay(null);
    },
    [],
  );

  const goToday = useCallback(() => {
    setPopTarget(null);
    setTipTarget(null);
    setAnchor(today);
    setSelectedDay(today);
  }, [today]);

  /** 鍵盤移動的落點：選取格 → 今天（若在區間內）→ 區間第一天 */
  const cursorDay = useCallback((): string => {
    if (selectedDay && selectedDay >= range.from && selectedDay <= range.to) return selectedDay;
    if (today >= range.from && today <= range.to) return today;
    return range.from;
  }, [selectedDay, today, range.from, range.to]);

  const moveDay = useCallback(
    (delta: number) => {
      const next = addDays(cursorDay(), delta);
      if (next < range.from || next > range.to) {
        // 跨出本月／本週＝把游標推過去（錨點日就是落點，月／週自動跟著換）
        setAnchor(next);
      }
      setSelectedDay(next);
    },
    [cursorDay, range.from, range.to],
  );

  const movePage = useCallback(
    (delta: 1 | -1) => {
      const base = cursorDay();
      const next = view === "month" ? addMonths(base, delta) : addDays(base, delta * 7);
      setAnchor(next);
      // 月：落在新月的同一個日數（月底溢位由 addMonths 落 1 日→改取同日數保底）
      const day = view === "month" ? clampToMonth(next, Number(base.slice(8, 10))) : next;
      setSelectedDay(day);
      setPopTarget(null);
      setTipTarget(null);
    },
    [cursorDay, view],
  );

  const openSelected = useCallback(() => {
    const day = cursorDay();
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-day="${day}"]`) ?? null;
    openDay(day, el);
  }, [cursorDay, containerRef, openDay]);

  const escape = useCallback(() => {
    if (popTarget) closeDay();
    else if (jump) closeJump(); // 小卡自己也攔 Esc（不冒泡）；這條是焦點在卡外時的收尾護欄
    else if (tipTarget) hideTip();
  }, [popTarget, closeDay, jump, closeJump, tipTarget, hideTip]);

  const keys: CalendarKeyActions = useMemo(
    () => ({
      moveDay,
      movePage,
      jumpMonth: (d: number) => shiftMonths(d),
      jumpYear: (d: number) => shiftMonths(d * 12),
      goToday,
      openSelected,
      escape,
    }),
    [moveDay, movePage, shiftMonths, goToday, openSelected, escape],
  );

  /* ───────── 焦點：選取格變了就把焦點跟過去 ─────────
   * 只在「焦點本來就在日曆頁內」或「焦點掉到 body」時才搶——後者是換月的必然：
   * 舊格被卸載，瀏覽器把焦點丟回 body，不接住的話鍵盤流就在 PageDown 之後斷掉。
   * 焦點在別處（側欄、側板、搜尋）時一律不動，免得日曆偷走使用者正在打的地方。 */
  useEffect(() => {
    if (!selectedDay) return;
    const host = containerRef.current;
    const active = document.activeElement;
    if (!host || !(active === document.body || host.contains(active))) return;
    const cell = host.querySelector<HTMLElement>(`[data-day="${selectedDay}"]`);
    if (cell && cell !== active) cell.focus();
  }, [selectedDay, days, containerRef]);

  // 沒人持有焦點時把焦點給日曆頁，鍵盤流立刻可用（沿 useTodayController 的做法）
  useEffect(() => {
    if (document.activeElement === document.body) containerRef.current?.focus();
  }, [containerRef]);

  /* ───────── `?day=YYYY-MM-DD`：進頁直開該日的當日清單（dev／mock 專用，DEV_FLAGS） ─────────
   * 只開一次（開完關掉就不再自己跳出來）；錨取那一格的元素，浮層才會落在格下方而不是視窗置中。
   * effect 跑在子層 render 之後，格必定已在 DOM 裡。 */
  const devDayOpened = useRef(false);
  useEffect(() => {
    if (devDayOpened.current || !DEV_FLAGS.day) return;
    devDayOpened.current = true;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-day="${DEV_FLAGS.day}"]`) ?? null;
    openDay(DEV_FLAGS.day, el);
  }, [containerRef, openDay]);

  return {
    view,
    setView,
    cursor,
    go,
    jumpTo,
    goToday,
    range,
    days,
    today,
    selectedDay,
    selectDay,
    popTarget,
    openDay,
    closeDay,
    tipTarget,
    showTip,
    hideTip,
    jumpAnchor: jump?.anchor ?? null,
    jumpOpen: jump !== null,
    openJump,
    closeJump,
    byDate,
    nodes: calendar.nodes,
    routes,
    routeOf,
    stats,
    // 覆蓋層開著＝格層鍵盤表整張停用只留 Esc（當日浮層／月年跳轉小卡各自吃自己的鍵）
    blocked: popTarget !== null || jump !== null,
    keys,
    focusContainer,
  };
}

/** 換月時把日數夾回新月的範圍（1/31 PageDown → 2/28） */
function clampToMonth(monthKey: string, day: number): string {
  const last = dateOf(monthEnd(monthKey)).getDate();
  return `${monthKey.slice(0, 7)}-${String(Math.min(day, last)).padStart(2, "0")}`;
}
