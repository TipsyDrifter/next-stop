/**
 * useSchedulePage——日程兩殼（ScheduleView 桌機／MobileTtSchedule 手機）共用的頁面狀態（④ 契約 §3.2、§5；乙席）。
 *
 * - 掛上 `attach()`、卸下 release；卸下時若 plan 面板還開著就關掉（面板只屬於日程頁，不跟到別頁）。
 * - 讀：`timetableScheduleStore`（grid／items／nodes／picked／hover）＋`useScheduleCompare(now)`（差多少、總結）。
 * - 對應描金（D-時-84、86）：作用中的預定項＝滑過的卡 → 滑過的塊所屬的卡 → 開著面板的卡 → 手機點亮的卡。
 * - 拖曳、點選、面板開關都在這裡收成幾支動作，兩殼只管排版。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ADHOC_TEXT, SEG_DEFAULT_MIN, addSegNode, scheduleSpansOf, useTimetableScheduleStore, useScheduleCompare, type AdhocItem } from "../../../store/timetableScheduleStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetablePlanStore } from "../../../store/timetablePlanStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { canScheduleDay } from "../../../domain/timetableSchedule";
import { categoryColorCss, msOf } from "../../../domain/timetable";
import { compareRoutineItem, routineSummaryText, type RoutineCompare } from "../../../domain/timetableRoutine";
import { addDays, clockMinutes, clockText, dayWindow, type ClockText } from "../../../lib/date";
import { useNow } from "../useNow";
import { useRouteById } from "../parts/LinkPicker";
import { SCHED_UI } from "./scheduleModel";
import { PLACEHOLDER_UI, isAddPlaceholder } from "./scheduleSeatModel";

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
  // ⑦（C 席）：車票第二段起、預定欄的卡（第一段＋第二段起同一套 lane）、作息
  const slots = useTimetableScheduleStore((s) => s.slots);
  const adhocs = useTimetableScheduleStore((s) => s.adhocs);
  const blocks = useTimetableScheduleStore((s) => s.blocks);
  const scheduleMode = useTimetableScheduleStore((s) => s.scheduleMode);
  const setScheduleMode = useTimetableScheduleStore((s) => s.setScheduleMode);
  const routineDay = useTimetablePlanStore((s) => s.days[date] ?? null);
  const slotsByNode = useTimetablePlanStore((s) => s.slotsByNode);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const ttDay = useTimetableStore((s) => s.dayKey);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const dayKey = useTimetableStore((s) => s.dayKey);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const sheet = useTimetableStore((s) => s.sheet);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const runOverrides = useNodeStore((s) => s.runOverrides);
  const rangeTickets = useNodeStore((s) => s.rangeTickets);
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
      if (s?.kind === "plan" || s?.kind === "slot" || s?.kind === "adhoc" || s?.kind === "routine") useTimetableStore.getState().closeSheet();
    };
  }, []);

  // 4B／4C：逐班覆寫（本班填空／待辦入座）或期間自由券更新時，同步重算日程投影
  useEffect(() => {
    void useTimetableScheduleStore.getState().load();
  }, [runOverrides, rangeTickets]);

  // ⑦：「第 N 段」要知道每張單發票在別天還有沒有段 ⇒ 這一天出現的票各讀一次它的第二段起（plan store 之後自己跟著寫入與同步重讀）
  useEffect(() => {
    const ps = useTimetablePlanStore.getState();
    const ids = new Set<string>();
    for (const it of Object.values(items)) if (it.kind === "single" && !it.lateFrom) ids.add(it.nodeId);
    for (const it of Object.values(slots)) ids.add(it.nodeId);
    for (const id of ids) if (!(id in ps.slotsByNode)) void ps.loadNode(id).catch(() => undefined);
  }, [items, slots]);

  // #72：開著過日界線 ⇒ todayKey 跟著翻（＝週視圖、統計的做法；只比字串，沒換日不做事）。
  // 不然標題「今天」、面板的 ±15／発車照舊（看 todayKey），預定欄卻已唯讀（cmp.canEdit 看 now）——兩邊各說各話
  useEffect(() => {
    void useTimetableStore.getState().ensureFreshDay();
  }, [now]);

  // 換天：點亮、選取、開著的面板都清掉
  useEffect(() => {
    setSel(null);
    const s = useTimetableStore.getState().sheet;
    if ((s?.kind === "plan" || s?.kind === "slot" || s?.kind === "adhoc") && !s.key.startsWith(dayKey + "-")) useTimetableStore.getState().closeSheet();
    if (s?.kind === "routine" && s.day !== dayKey) useTimetableStore.getState().closeSheet();
  }, [dayKey]);
  const win = useMemo(() => {
    const w = dayWindow(date, dayStartHour);
    return { start: msOf(w.start), end: msOf(w.end) };
  }, [date, dayStartHour]);

  const isToday = date === todayKey;
  const isPast = date < todayKey;
  const isFuture = date > todayKey;
  const canEdit = cmp.canEdit && !busy;
  /** 開著面板的卡：第一段（plan）、第二段起（slot）或臨時班次（adhoc） */
  const openKey = sheet?.kind === "plan" || sheet?.kind === "slot" || sheet?.kind === "adhoc" ? sheet.key : null;
  /** ⑦：開著面板的作息段 id */
  const openRoutineId = sheet?.kind === "routine" && sheet.day === date ? sheet.id : null;

  /* ── ⑦ 作息：每一段對實績（實績＝這一天的塊；時刻表的那一天還沒換過來時先不比） ── */
  const routineCmp = useMemo((): ReadonlyMap<string, RoutineCompare> => {
    const out = new Map<string, RoutineCompare>();
    if (!routineDay) return out;
    const spans = ttDay === date ? scheduleSpansOf(dayBlocks, { catById, longRunMaxMin, linkInfo }, now) : [];
    for (const g of routineDay.segs) out.set(g.id, compareRoutineItem(date, g, spans, now));
    return out;
  }, [routineDay, ttDay, date, dayBlocks, catById, longRunMaxMin, linkInfo, now]);
  /** 總結那一句（0 段 ⇒ null；未來日只寫段數，✎4） */
  const routineSummary = useMemo((): { total: number; ok: number | null; text: string } | null => {
    const list = [...routineCmp.values()];
    if (!list.length) return null;
    if (isFuture) return { total: list.length, ok: null, text: `作息 ${list.length} 段` };
    const text = routineSummaryText(list);
    return text ? { total: list.length, ok: list.filter((c) => c.onSchedule).length, text } : null;
  }, [routineCmp, isFuture]);

  /** 作用中的預定項（描金的那一張） */
  const activeKey = useMemo((): string | null => {
    if (hover?.kind === "plan" && (items[hover.id] || slots[hover.id] || adhocs[hover.id])) return hover.id;
    if (hover?.kind === "block") return cmp.planKeyOfBlock.get(hover.id) ?? null;
    return openKey ?? sel;
  }, [hover, items, slots, adhocs, cmp.planKeyOfBlock, openKey, sel]);
  const activeBlocks = useMemo(() => {
    if (activeKey) return new Set(cmp.cmp.get(activeKey)?.blockIds ?? []);
    // ⑦：作息段的面板開著 ⇒ 描它對到的塊
    return new Set(openRoutineId ? (routineCmp.get(openRoutineId)?.blockIds ?? []) : []);
  }, [activeKey, cmp.cmp, openRoutineId, routineCmp]);

  /** 4A：在時間軸指定時刻（或拖拉區間）建立雙邊互通的「預留席車票」，自動同步至今日頁與時刻表日程 */
  const createPlaceholderAt = useCallback(
    async (
      startHm: ClockText,
      opts?: {
        date?: string;
        durationMin?: number;
        routeId?: string | null;
        name?: string | null;
        openAfter?: boolean;
        switchToDayMode?: boolean;
      },
    ) => {
      const st = useTimetableScheduleStore.getState();
      const targetDate = opts?.date ?? st.date;
      const h = useUiStore.getState().dayStartHour;
      const tToday = useTimetableStore.getState().todayKey;
      if (!canScheduleDay(targetDate, tToday)) {
        useUiStore.getState().showToast({ message: TT_TEXT.schedPast });
        return null;
      }
      const sMin = clockMinutes(startHm);
      if (sMin === null) return null;
      const dur = Math.max(15, Math.min(1440, Math.round(opts?.durationMin ?? SEG_DEFAULT_MIN)));
      const endHm = clockText(Math.min(sMin + dur, h * 60 + 1440)) ?? startHm;
      const routeId = opts?.routeId ?? null;
      const routeName = routeId ? (routeById[routeId]?.name ?? null) : null;
      const name = (opts?.name?.trim() || routeName || PLACEHOLDER_UI.fallbackName).trim();

      const row = await useNodeStore.getState().createNode({
        kind: "ticket",
        name,
        parentId: null,
        routeTagId: routeId,
        scheduledOn: targetDate,
        scheduledTime: startHm,
        estimateMin: dur,
        dayStartHour: h,
        isPlaceholder: true,
      });
      if (!row) return null;
      if (isAddPlaceholder(useTimetableScheduleStore.getState().picked)) {
        useTimetableScheduleStore.getState().pick(null);
      }

      useUiStore.getState().showToast({
        message: PLACEHOLDER_UI.added(startHm, endHm),
        actionLabel: TT_TEXT.undo,
        onAction: () => {
          void useNodeStore.getState().deleteNode(row.id);
        },
      });

      if (opts?.switchToDayMode) {
        await useTimetableStore.getState().setDayKey(targetDate);
        useTimetableScheduleStore.getState().setScheduleMode("day");
      }
      await useTimetableScheduleStore.getState().load();
      if (opts?.openAfter !== false) {
        useTimetableStore.getState().openSheet({ kind: "plan", key: `${targetDate}-${row.id}` });
      }
      return row;
    },
    [routeById],
  );

  /** 4C Mode B：將選中的待辦車票直接入座至某張預留席／定期班次空位 */
  const seatTicketInto = useCallback(async (slotKey: string, ticketNodeId: string): Promise<boolean> => {
    const st = useTimetableScheduleStore.getState();
    const slotItem = st.items[slotKey];
    if (!slotItem) return false;
    const tToday = useTimetableStore.getState().todayKey;
    if (!canScheduleDay(slotItem.date, tToday)) {
      useUiStore.getState().showToast({ message: TT_TEXT.schedPast });
      return false;
    }
    const slotNode = st.nodes[slotItem.nodeId];
    const ticketNode = st.nodes[ticketNodeId] ?? useNodeStore.getState().today.byId[ticketNodeId];
    const slotName = slotNode?.name ?? PLACEHOLDER_UI.fallbackName;
    const ticketName = ticketNode?.name ?? "待辦車票";

    const res = await useNodeStore.getState().seatTicketIntoSlot(slotItem.nodeId, slotItem.date, ticketNodeId);
    if (!res.ok) return false;
    if (st.picked) st.pick(null);
    await st.load();
    useUiStore.getState().showToast({
      message: PLACEHOLDER_UI.seated(ticketName, slotName),
      actionLabel: TT_TEXT.undo,
      onAction: () => {
        void useNodeStore
          .getState()
          .releaseSeatedSlot(slotItem.nodeId, slotItem.date)
          .then(() => useTimetableScheduleStore.getState().load());
      },
    });
    return true;
  }, []);

  /** 點位置／拖放：還沒排的票＝排時刻（期間自由券自動經 planTimeWrite 收斂為當日單日票）；第二段起＝換位置；「＋ 預留席」＝建立預留席車票；「再排一段」＝加一段 */
  const place = useCallback(
    (key: string, min: number): void => {
      const t = clockText(min) as ClockText | null;
      if (!t) return;
      const st = useTimetableScheduleStore.getState();
      const add = addSegNode(key);
      if (isAddPlaceholder(key)) {
        void createPlaceholderAt(t, { durationMin: SEG_DEFAULT_MIN, openAfter: true });
        return;
      }
      if (add !== null) {
        void st.addSegment(add, t);
        return;
      }
      if (st.adhocs[key]) {
        void st.moveAdhoc(key, t);
        return;
      }
      if (st.slots[key]) {
        void st.moveSlot(key, t);
        return;
      }
      void st.placeAt(key, t);
    },
    [createPlaceholderAt],
  );

  const openPlan = useCallback((key: string): void => {
    setSel(null);
    const st = useTimetableScheduleStore.getState();
    useTimetableStore.getState().openSheet(
      st.adhocs[key] ? { kind: "adhoc", key } : st.slots[key] ? { kind: "slot", key } : { kind: "plan", key },
    );
  }, []);

  /** ⑦：點作息段開它的小面板 */
  const openRoutine = useCallback(
    (id: string): void => {
      setSel(null);
      useTimetableStore.getState().openSheet({ kind: "routine", day: date, id });
    },
    [date],
  );

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
    createPlaceholderAt,
    seatTicketInto,
    openPlan,
    stepDay,
    toToday,
    // ⑦（C 席）
    slots,
    adhocs,
    catById,
    blocks,
    slotsByNode,
    routineDay,
    routineCmp,
    routineSummary,
    openRoutineId,
    openRoutine,
    scheduleMode,
    setScheduleMode,
  };
}

export type SchedulePage = ReturnType<typeof useSchedulePage>;

/** 車票的路線色（卡左緣、清單點）：有路線＝路線本色；沒有＝第 8 色 */
export function routeColorOf(page: Pick<SchedulePage, "nodes" | "routeById">, nodeId: string): string {
  const n = page.nodes[nodeId];
  const r = n?.route_id ? page.routeById[n.route_id] : undefined;
  return r?.color ?? "var(--ns-tt-cat-8)";
}

/** 臨時班次的顯示名稱與色票（主題名 → 支線名 → 路線名 → 分類名 → 臨時班次） */
export function adhocDisplayOf(
  page: Pick<SchedulePage, "nodes" | "routeById" | "catById">,
  ad: AdhocItem,
): { name: string; color: string; sub: string | null } {
  const br = ad.branchNodeId ? page.nodes[ad.branchNodeId] : undefined;
  const effRouteId = ad.routeId ?? br?.route_id ?? null;
  const rt = effRouteId ? page.routeById[effRouteId] : undefined;
  const cat = ad.categoryId ? page.catById[ad.categoryId] : undefined;
  const linkLabel = br ? (rt ? `${rt.name} › ${br.name}` : br.name) : rt?.name ?? null;
  const fallback = linkLabel ?? cat?.name ?? ADHOC_TEXT.fallbackName;
  const name = ad.label?.trim() || fallback;
  const sub = ad.label?.trim() ? (linkLabel ?? cat?.name ?? null) : (linkLabel && cat ? cat.name : null);
  const color = rt?.color ?? categoryColorCss(cat, 8);
  return { name, color, sub };
}
