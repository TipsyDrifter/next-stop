/**
 * 方針畫面共用的讀取（戊；方針擴充 辛 §7）：今天、要看的那一期、那一期的方針與已排、收合、自動回顧排隊。
 * 桌機告示（今日、行程表、年鑑）與手機一行、面板都吃 `useAimView`；`useWeekAims` 是週方針的舊介面，內部包它。
 */
import { useEffect, useMemo, useRef } from "react";
import { addDays, todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { useMinuteTick } from "../schedule/useMinuteTick";
import {
  adjacentKey,
  currentKeyOf,
  doneCount,
  foldedOfKey,
  pendingReviewKeys,
  pendingReviewWeek,
  periodOfKey,
  periodTitle,
  stationHeadText,
  stationIdOfKey,
  weekOnOf,
  type AimPeriod,
  type PeriodTitle,
  type PlanCount,
  type WeekAimRow,
} from "../../domain/weekAims";
import { useAimPlaceOf, type AimPlace } from "./parts";

const EMPTY: WeekAimRow[] = [];

/** 今天（依日界線、每分鐘重算）與每週起始日 */
export function useAimToday(): { today: string; weekStart: 0 | 1 } {
  const now = useMinuteTick();
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const weekStart = useUiStore((s) => s.weekStart);
  return { today: todayKey(dayStartHour, new Date(now)), weekStart };
}

export interface AimView {
  today: string;
  weekStart: 0 | 1;
  aimKey: string;
  period: AimPeriod;
  /** 標題、拉丁小字、關係字（這週／這個月…） */
  head: PeriodTitle;
  /** 頁首的日期；車站＝站名・日期 */
  rangeText: string;
  aims: WeekAimRow[];
  /** 這一期還沒載到（第一次） */
  loading: boolean;
  folded: boolean;
  count: { done: number; total: number };
  /** 車站鍵：這站所屬的路線（沒掛的句子看這條路線，§2）；其他期間 null */
  stationRouteId: string | null;
  /** 那句的「已排 N 張・済 M」：看掛的節點；車站沒掛的看路線 */
  countOf(aim: WeekAimRow): PlanCount | undefined;
  /** 一句掛的地方（路線或支線，D-主-281）；沒掛或找不到＝null */
  placeOf(id: string | null): AimPlace | null;
}

/** 任何期間鍵的讀取。載入、節點異動重算已排（連續幾次收成一次）、節點異動重讀掛的支線名（全集 #15）都在這裡 */
export function useAimView(aimKey: string): AimView {
  const { today, weekStart } = useAimToday();
  const period = periodOfKey(aimKey);
  const aims = useWeekAimStore((s) => s.weeks[aimKey]) ?? EMPTY;
  const loaded = useWeekAimStore((s) => s.weeks[aimKey] !== undefined);
  const planned = useWeekAimStore((s) => s.planned[aimKey]);
  const foldRaw = useWeekAimStore((s) => s.foldRaw[period]);
  const placeOf = useAimPlaceOf();
  const stationId = stationIdOfKey(aimKey);
  const station = useNodeStore((s) => (stationId ? (s.stations.find((x) => x.id === stationId) ?? null) : null));

  useEffect(() => {
    const st = useWeekAimStore.getState();
    void st.loadSettings();
    void st.loadWeek(aimKey);
  }, [aimKey]);

  // 節點有變（蓋章、建票、改期、同步拉到）⇒ 重算「已排 N 張・済 M」；車站到站（期間變了）也算
  const todayRows = useNodeStore((s) => s.today.rows);
  const calNodes = useNodeStore((s) => s.calendar.nodes);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = window.setTimeout(() => void useWeekAimStore.getState().refreshPlanned(aimKey), 250);
    return () => window.clearTimeout(t);
  }, [todayRows, calNodes, station, aimKey]);

  // 全集 #15：支線改名不該等下次載週——所有節點異動最後都走 nodeStore.refresh → loadSidebar 換掉 routes
  const routes = useNodeStore((s) => s.routes);
  const firstRoutes = useRef(true);
  useEffect(() => {
    if (firstRoutes.current) {
      firstRoutes.current = false;
      return;
    }
    const t = window.setTimeout(() => void useWeekAimStore.getState().refreshAimNodes(), 250);
    return () => window.clearTimeout(t);
  }, [routes]);

  const head = periodTitle(aimKey, today, weekStart);
  const stationRouteId = station?.parent_id ?? null;
  return {
    today,
    weekStart,
    aimKey,
    period,
    head,
    rangeText: period === "station" ? stationHeadText(station) : head.range,
    aims,
    loading: !loaded,
    folded: foldedOfKey(foldRaw, today, aimKey),
    count: doneCount(aims),
    stationRouteId,
    countOf: (aim) => {
      const id = aim.node_id ?? stationRouteId;
      return id ? planned?.[id] : undefined;
    },
    placeOf,
  };
}

/**
 * 今日告示的自動回顧排隊（D-主-373）：新的一期第一次打開，上一期有方針又沒看過回顧 ⇒ 週→月→年。
 * 回還要看的期間鍵（第一個＝現在該出的）；`enabled` false 或還沒載完＝空。看過與否靠 store 的 reviewSeen，關掉一張就輪下一張。
 */
export function usePendingReviews(enabled: boolean): string[] {
  const { today, weekStart } = useAimToday();
  const week = currentKeyOf("week", today, weekStart);
  const month = currentKeyOf("month", today, weekStart);
  const year = currentKeyOf("year", today, weekStart);
  const [pw, pm, py] = [adjacentKey(week, -1), adjacentKey(month, -1), adjacentKey(year, -1)];
  const prevWeek = useWeekAimStore((s) => s.weeks[pw]);
  const prevMonth = useWeekAimStore((s) => s.weeks[pm]);
  const prevYear = useWeekAimStore((s) => s.weeks[py]);
  const seen = useWeekAimStore((s) => s.reviewSeen);
  const settingsLoaded = useWeekAimStore((s) => s.settingsLoaded);

  useEffect(() => {
    if (!enabled) return;
    const st = useWeekAimStore.getState();
    void st.loadSettings();
    // 載一期會連上一期一起載
    for (const k of [week, month, year]) void st.loadWeek(k);
  }, [enabled, week, month, year]);

  return useMemo(() => {
    if (!enabled || !settingsLoaded || prevWeek === undefined || prevMonth === undefined || prevYear === undefined) return [];
    const lists: Record<string, WeekAimRow[]> = { [pw]: prevWeek, [pm]: prevMonth, [py]: prevYear };
    return pendingReviewKeys(today, weekStart, (k) => (lists[k]?.length ?? 0) > 0, seen);
  }, [enabled, settingsLoaded, prevWeek, prevMonth, prevYear, pw, pm, py, today, weekStart, seen]);
}

export interface WeekAimsView {
  today: string;
  weekStart: 0 | 1;
  /** 要看的那週（週首） */
  weekOn: string;
  /** 今天那週的週首 */
  curWeek: string;
  aims: WeekAimRow[];
  /** 這週還沒載到（第一次） */
  loading: boolean;
  planned: Record<string, PlanCount> | undefined;
  folded: boolean;
  count: { done: number; total: number };
  /** 新的一週第一次打開要自動出的上週回顧（只有今日頁的帶子吃；其他地方 null） */
  pendingReview: string | null;
  /** 一句掛的地方（路線或支線，D-主-281）；沒掛或找不到＝null */
  placeOf(id: string | null): AimPlace | null;
}

/**
 * 週方針的舊介面（戊），內部包 `useAimView`。
 * @param day 要看哪一天所在的週；省略＝今天
 * @param autoReview 今日頁的帶子＝true（新的一週自動出上週回顧，D-主-260）
 */
export function useWeekAims(day?: string | null, autoReview = false): WeekAimsView {
  const { today, weekStart } = useAimToday();
  const curWeek = weekOnOf(today, weekStart);
  const weekOn = day ? weekOnOf(day, weekStart) : curWeek;
  const v = useAimView(weekOn);
  const prevAims = useWeekAimStore((s) => s.weeks[addDays(weekOn, -7)]);
  const planned = useWeekAimStore((s) => s.planned[weekOn]);
  const reviewSeen = useWeekAimStore((s) => s.reviewSeen.week);
  const settingsLoaded = useWeekAimStore((s) => s.settingsLoaded);
  const pendingReview =
    autoReview && weekOn === curWeek && settingsLoaded && prevAims !== undefined
      ? pendingReviewWeek(today, weekStart, prevAims.length > 0, reviewSeen)
      : null;
  return {
    today,
    weekStart,
    weekOn,
    curWeek,
    aims: v.aims,
    loading: v.loading,
    planned,
    folded: v.folded,
    count: v.count,
    pendingReview,
    placeOf: v.placeOf,
  };
}
