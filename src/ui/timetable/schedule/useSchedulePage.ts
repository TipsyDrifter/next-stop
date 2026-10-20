/**
 * useSchedulePage——日程兩殼（ScheduleView 桌機／MobileTtSchedule 手機）共用的頁面狀態（④ 契約 §3.2、§5；乙席）。
 *
 * - 掛上 `attach()`、卸下 release；卸下時若 plan 面板還開著就關掉（面板只屬於日程頁，不跟到別頁）。
 * - 讀：`timetableScheduleStore`（grid／items／nodes／picked／hover）＋`useScheduleCompare(now)`（差多少、總結）。
 * - 對應描金（D-時-84、86）：作用中的預定項＝滑過的卡 → 滑過的塊所屬的卡 → 開著面板的卡 → 手機點亮的卡。
 * - 拖曳、點選、面板開關都在這裡收成幾支動作，兩殼只管排版。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTimetableScheduleStore, useScheduleCompare } from "../../../store/timetableScheduleStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { msOf } from "../../../domain/timetable";
import { addDays, clockText, dayWindow, type ClockText } from "../../../lib/date";
import { useNow } from "../useNow";
import { useRouteById } from "../parts/LinkPicker";
import { SCHED_UI } from "./scheduleModel";

export type ScheduleShell = "desktop" | "mobile";

export function useSchedulePage(shell: ScheduleShell) {
  const date = useTimetableScheduleStore((s) => s.date);
  const grid = useTimetableScheduleStore((s) => s.grid);
  const nodes = useTimetableScheduleStore((s) => s.nodes);
  const items = useTimetableScheduleStore((s) => s.items);
  const lateKeys = useTimetableScheduleStore((s) => s.lateKeys);
  const lateRepeatCount = useTimetableScheduleStore((s) => s.lateRepeatCount);
  const picked = useTimetableScheduleStore((s) => s.picked);
  const hover = useTimetableScheduleStore((s) => s.hover);
  const busy = useTimetableScheduleStore((s) => s.busy);
  const error = useTimetableScheduleStore((s) => s.error);
  const dayKey = useTimetableStore((s) => s.dayKey);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const sheet = useTimetableStore((s) => s.sheet);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const routeById = useRouteById();
  const now = useNow(30_000);
  const cmp = useScheduleCompare(now);

  /** 手機：第一下點亮的卡（D-時-86；再點一下或按「打開 ›」才開面板） */
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const st = useTimetableScheduleStore.getState();
    const off = st.attach();
    return () => {
      off();
      const s = useTimetableStore.getState().sheet;
      if (s?.kind === "plan") useTimetableStore.getState().closeSheet();
    };
  }, []);

  // #72：開著過日界線 ⇒ todayKey 跟著翻（＝週視圖、統計的做法；只比字串，沒換日不做事）。
  // 不然標題「今天」、面板的 ±15／発車照舊（看 todayKey），預定欄卻已唯讀（cmp.canEdit 看 now）——兩邊各說各話
  useEffect(() => {
    void useTimetableStore.getState().ensureFreshDay();
  }, [now]);

  // 換天：點亮、選取、開著的面板都清掉
  useEffect(() => {
    setSel(null);
    const s = useTimetableStore.getState().sheet;
    if (s?.kind === "plan" && !s.key.startsWith(dayKey + "-")) useTimetableStore.getState().closeSheet();
  }, [dayKey]);

  const win = useMemo(() => {
    const w = dayWindow(date, dayStartHour);
    return { start: msOf(w.start), end: msOf(w.end) };
  }, [date, dayStartHour]);

  const isToday = date === todayKey;
  const isPast = date < todayKey;
  const isFuture = date > todayKey;
  const canEdit = cmp.canEdit && !busy;
  const openKey = sheet?.kind === "plan" ? sheet.key : null;

  /** 作用中的預定項（描金的那一張） */
  const activeKey = useMemo((): string | null => {
    if (hover?.kind === "plan" && items[hover.id]) return hover.id;
    if (hover?.kind === "block") return cmp.planKeyOfBlock.get(hover.id) ?? null;
    return openKey ?? sel;
  }, [hover, items, cmp.planKeyOfBlock, openKey, sel]);
  const activeBlocks = useMemo(
    () => new Set(activeKey ? (cmp.cmp.get(activeKey)?.blockIds ?? []) : []),
    [activeKey, cmp.cmp],
  );

  const place = useCallback((key: string, min: number): void => {
    const t = clockText(min) as ClockText | null;
    if (t) void useTimetableScheduleStore.getState().placeAt(key, t);
  }, []);

  const openPlan = useCallback((key: string): void => {
    setSel(null);
    useTimetableStore.getState().openSheet({ kind: "plan", key });
  }, []);

  const stepDay = useCallback((n: number): void => {
    const s = useTimetableStore.getState();
    void s.setDayKey(addDays(s.dayKey, n));
  }, []);
  const toToday = useCallback((): void => {
    const s = useTimetableStore.getState();
    void s.setDayKey(s.todayKey);
  }, []);

  const dayTag = isToday ? TT_TEXT.schedToday : date === addDays(todayKey, -1) ? SCHED_UI.yesterday : date === addDays(todayKey, 1) ? SCHED_UI.tomorrow : null;

  return {
    shell,
    date,
    dayKey,
    todayKey,
    grid,
    nodes,
    items,
    lateKeys,
    lateRepeatCount,
    picked,
    hover,
    busy,
    error,
    dayStartHour,
    routeById,
    now,
    cmp,
    win,
    isToday,
    isPast,
    isFuture,
    canEdit,
    openKey,
    sel,
    setSel,
    activeKey,
    activeBlocks,
    dayTag,
    place,
    openPlan,
    stepDay,
    toToday,
  };
}

export type SchedulePage = ReturnType<typeof useSchedulePage>;

/** 車票的路線色（卡左緣、清單點）：有路線＝路線本色；沒有＝第 8 色 */
export function routeColorOf(page: Pick<SchedulePage, "nodes" | "routeById">, nodeId: string): string {
  const n = page.nodes[nodeId];
  const r = n?.route_id ? page.routeById[n.route_id] : undefined;
  return r?.color ?? "var(--ns-tt-cat-8)";
}
