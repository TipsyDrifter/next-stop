/**
 * 週方針畫面共用的讀取（戊）：今天、要看的那週、那週的方針與已排、收合、要不要自動出上週回顧。
 * 桌機帶子（今日、行程表週檢視）與手機一行（今日、行程表）都吃這一支，畫面各寫。
 */
import { useEffect, useRef } from "react";
import { addDays, todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { doneCount, foldedOf, pendingReviewWeek, weekOnOf, type WeekAimRow } from "../../domain/weekAims";
import { useAimPlaceOf, type AimPlace } from "./parts";

const EMPTY: WeekAimRow[] = [];

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
  planned: ReturnType<typeof useWeekAimStore.getState>["planned"][string] | undefined;
  folded: boolean;
  count: { done: number; total: number };
  /** 新的一週第一次打開要自動出的上週回顧（只有今日頁的帶子吃；其他地方 null） */
  pendingReview: string | null;
  /** 一句掛的地方（路線或支線，D-主-281）；沒掛或找不到＝null */
  placeOf(id: string | null): AimPlace | null;
}

/**
 * @param day 要看哪一天所在的週；省略＝今天
 * @param autoReview 今日頁的帶子＝true（新的一週自動出上週回顧，D-主-260）
 */
export function useWeekAims(day?: string | null, autoReview = false): WeekAimsView {
  const now = useMinuteTick();
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const weekStart = useUiStore((s) => s.weekStart);
  const today = todayKey(dayStartHour, new Date(now));
  const curWeek = weekOnOf(today, weekStart);
  const weekOn = day ? weekOnOf(day, weekStart) : curWeek;
  const prevWeek = addDays(weekOn, -7);

  const aims = useWeekAimStore((s) => s.weeks[weekOn]) ?? EMPTY;
  const loaded = useWeekAimStore((s) => s.weeks[weekOn] !== undefined);
  const prevAims = useWeekAimStore((s) => s.weeks[prevWeek]);
  const planned = useWeekAimStore((s) => s.planned[weekOn]);
  const foldRaw = useWeekAimStore((s) => s.foldRaw);
  const reviewSeen = useWeekAimStore((s) => s.reviewSeen);
  const settingsLoaded = useWeekAimStore((s) => s.settingsLoaded);
  const placeOf = useAimPlaceOf();

  useEffect(() => {
    const st = useWeekAimStore.getState();
    void st.loadSettings();
    void st.loadWeek(weekOn);
  }, [weekOn]);

  // 節點有變（蓋章、建票、改期、同步拉到）⇒ 重算「已排 N 張・済 M」；連續幾次變動收成一次
  const todayRows = useNodeStore((s) => s.today.rows);
  const calNodes = useNodeStore((s) => s.calendar.nodes);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = window.setTimeout(() => void useWeekAimStore.getState().refreshPlanned(weekOn), 250);
    return () => window.clearTimeout(t);
  }, [todayRows, calNodes, weekOn]);

  const pendingReview =
    autoReview && weekOn === curWeek && settingsLoaded && prevAims !== undefined
      ? pendingReviewWeek(today, weekStart, prevAims.length > 0, reviewSeen)
      : null;

  return {
    today,
    weekStart,
    weekOn,
    curWeek,
    aims,
    loading: !loaded,
    planned,
    folded: foldedOf(foldRaw, today, weekOn),
    count: doneCount(aims),
    pendingReview,
    placeOf,
  };
}
