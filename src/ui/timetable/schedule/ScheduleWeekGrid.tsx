/**
 * ScheduleWeekGrid——「時刻表 › 日程」內的「週時段（手機：三日時段）」互動排程畫布（第三梯・討論 6 方案 A）。
 *
 * 將原本唯讀的「行程表 › 時段」收斂進「時刻表 › 日程」，並升級為完整互動排程：
 * - 桌機顯示一週 7 天（週一～週日）；手機顯示 3 天（前一天、當天、後一天）。
 * - 頂端「未定時」籤帶：列出各日未排時刻的車票，點選籤再點下方任意日期與時段即可排入時刻（跨日點放會一併改乘車日）；
 *   左上角提供「＋ 臨時」按鈕，點選後點任意時段（或在空白時段雙擊）即可建立虛線邊框的「臨時班次／主題預留時段」。
 * - 時段格內同時顯示：已排時刻車票、車票第 2+ 段（第 N 段）、以及臨時班次（虛線車廂邊框＋「臨時」小牌）。
 * - 支援滑鼠拖曳／點選搬移時段塊（跨時段或跨日），以及點日欄頭一鍵切回該日的「單日（預定 vs 實績）」對照視圖。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { nodeRepo } from "../../../data";
import { WEEKDAY_LABEL, type NodeRow } from "../../../domain";
import { MIN, fmtDur } from "../../../domain/timetable";
import { canScheduleDay, planItemOf, planTimeWrite, planUndo, type PlanItem } from "../../../domain/timetableSchedule";
import { addDays, clockText, isClockPast, nextDayNote, nowClockMinutes, type ClockText } from "../../../lib/date";
import { useNodeStore } from "../../../store/nodeStore";
import { ADHOC_TEXT, SEG_TEXT, runScheduleWrite, useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { useTimetablePlanStore } from "../../../store/timetablePlanStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { hourTicks, timeGridModel, type TimeGridDay, type TimeGridUntimed } from "../../schedule/timeGridModel";
import "../../schedule/timegrid.css";
import { openTicket } from "./openTicket";
import { segNumberOf } from "./routineModel";
import { SCHED_UI, snapFrac } from "./scheduleModel";
import { adhocItemsOf, schedBlocksOf, slotItemsOf, type AdhocItem, type SchedBlock, type SlotItem } from "./slotModel";
import { adhocDisplayOf, routeColorOf, type SchedulePage } from "./useSchedulePage";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 給定 YYYY-MM-DD，回傳該週週一～週日的 7 個日期 key */
export function weekDaysOf(dayKey: string): string[] {
  const d = dateOf(dayKey);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const offsetToMon = dow === 0 ? -6 : 1 - dow;
  const mon = addDays(dayKey, offsetToMon);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

/** 手機三日時段：以 dayKey 為中心的前後共 3 天 */
export function threeDaysOf(dayKey: string): string[] {
  return [addDays(dayKey, -1), dayKey, addDays(dayKey, 1)];
}

interface DayPack {
  date: string;
  grid: TimeGridDay;
  items: Record<string, PlanItem>;
  slots: Record<string, SlotItem>;
  adhocs: Record<string, AdhocItem>;
  blocks: SchedBlock[];
}

type PickTarget =
  | { kind: "addadhoc" }
  | { kind: "untimed"; date: string; key: string; nodeId: string; name: string; item: PlanItem }
  | {
      kind: "block";
      date: string;
      key: string;
      blockKind: "plan" | "slot" | "adhoc";
      name: string;
      time: string;
      nodeId: string;
      planId: string | null;
      item: PlanItem;
    };

interface WeekDragState {
  target: Exclude<PickTarget, { kind: "addadhoc" }>;
  startX: number;
  startY: number;
  active: boolean;
  hoverDate: string | null;
  hoverMin: number | null;
  estimateMin: number;
}

export function ScheduleWeekGrid({ page }: { page: SchedulePage }) {
  const { shell, dayKey, todayKey, dayStartHour, now, routeById, catById, slotsByNode } = page;
  const mobile = shell === "mobile";
  const H = mobile ? 48 : 44;
  const minH = mobile ? 24 : 18;
  const shortH = mobile ? 36 : 30;
  const maxChips = mobile ? 3 : 4;
  const axisMin = dayStartHour * 60;

  const days = useMemo(() => (mobile ? threeDaysOf(dayKey) : weekDaysOf(dayKey)), [mobile, dayKey]);
  const fromKey = days[0];
  const toKey = days[days.length - 1];

  const nodeToday = useNodeStore((s) => s.today);
  const nodeTree = useNodeStore((s) => s.tree);
  const nodeCal = useNodeStore((s) => s.calendar);
  const rowsByDay = useTimetablePlanStore((s) => s.rowsByDay);

  const [calData, setCalData] = useState<{
    days: TimeGridDay[];
    nodes: Record<string, NodeRow>;
  } | null>(null);

  const [pickTarget, setPickTarget] = useState<PickTarget | null>(null);
  const [dragState, setDragState] = useState<WeekDragState | null>(null);
  const [hoverSlot, setHoverSlot] = useState<{ date: string; min: number } | null>(null);
  const swallowRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gutRef = useRef<HTMLDivElement>(null);

  // 載入這 7 天（或 3 天）的 listCalendar 與 time_plans
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [data] = await Promise.all([
          nodeRepo.listCalendar(fromKey, toKey, { todayDateKey: todayKey, dayStartHour }),
          useTimetablePlanStore.getState().loadDays(fromKey, toKey),
        ]);
        if (cancelled) return;
        const nodes: Record<string, NodeRow> = { ...data.nodes };
        const ps = useTimetablePlanStore.getState();
        const extraIds = new Set<string>();
        for (const d of days) {
          for (const r of ps.slotsForDay(d)) if (r.node_id) extraIds.add(r.node_id);
          for (const r of ps.adhocsForDay(d)) {
            if (r.node_id) extraIds.add(r.node_id);
            if (r.route_id) extraIds.add(r.route_id);
          }
        }
        for (const id of extraIds) {
          if (nodes[id]) continue;
          const n = await nodeRepo.getNode(id).catch(() => null);
          if (n && n.deleted_at === null) nodes[id] = n;
        }
        if (cancelled) return;
        const gDays = timeGridModel({
          days,
          entries: data.entries,
          dues: data.dues,
          nodes,
          dayStartHour,
        });
        setCalData({ days: gDays, nodes });
      } catch {
        // ignore transient load error
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromKey, toKey, todayKey, dayStartHour, days, nodeToday, nodeTree, nodeCal]);

  // 組裝每一天的 items / slots / adhocs / blocks
  const packs = useMemo((): DayPack[] => {
    if (!calData) return [];
    const nodes = calData.nodes;
    return calData.days.map((g) => {
      const d = g.date;
      const items: Record<string, PlanItem> = {};
      for (const b of g.blocks) {
        const it = planItemOf(b.entry, nodes[b.entry.node_id]);
        items[it.key] = it;
      }
      for (const u of g.untimed) {
        const it = planItemOf(u.entry, nodes[u.entry.node_id]);
        items[it.key] = it;
      }
      const dayRows = rowsByDay[d] ?? [];
      const slotRows = dayRows.filter((r) => r.deleted_at === null && r.node_id !== null && r.kind !== "adhoc");
      const adhocRows = dayRows.filter((r) => r.deleted_at === null && r.kind === "adhoc");
      const slots = slotItemsOf(d, slotRows, nodes, items);
      const adhocs = adhocItemsOf(d, adhocRows);
      const blocks = schedBlocksOf(g, slots, dayStartHour, adhocs);
      return { date: d, grid: g, items, slots, adhocs, blocks };
    });
  }, [calData, rowsByDay, dayStartHour]);

  const nodes = calData?.nodes ?? page.nodes;
  const pageWithNodes = useMemo(
    () => ({ nodes, routeById, catById }),
    [nodes, routeById, catById],
  );

  // 進頁自動捲到現在線或 08:00
  const nowMin = useMemo(() => {
    if (!days.includes(todayKey)) return null;
    return nowClockMinutes(todayKey, dayStartHour, now);
  }, [days, todayKey, dayStartHour, now]);
  const nowTop = nowMin === null ? null : ((nowMin - axisMin) / 60) * H;
  const ticks = useMemo(() => hourTicks(dayStartHour), [dayStartHour]);
  const nightHours = Math.max(0, Math.min(24, dayStartHour));

  const mountedScroll = useRef(false);
  useLayoutEffect(() => {
    if (mountedScroll.current || !packs.length) return;
    const el = scrollRef.current;
    if (!el) return;
    mountedScroll.current = true;
    const targetMin = nowMin !== null ? nowMin - 120 : 8 * 60;
    el.scrollTop = Math.max(((targetMin - axisMin) / 60) * H, 0);
  }, [packs.length, nowMin, axisMin, H]);

  /** 在指定日期與分鐘執行排入／搬移／新建臨時班次 */
  const commitTargetAt = useCallback(
    async (target: PickTarget, destDate: string, min: number) => {
      const time = clockText(min) as ClockText | null;
      if (!time) return;
      if (!canScheduleDay(destDate, todayKey)) {
        useUiStore.getState().showToast({ message: TT_TEXT.schedPast });
        return;
      }
      const schedStore = useTimetableScheduleStore.getState();
      const planStore = useTimetablePlanStore.getState();
      const ns = useNodeStore.getState();

      if (target.kind === "addadhoc") {
        setPickTarget(null);
        await useTimetableStore.getState().setDayKey(destDate);
        schedStore.setScheduleMode("day");
        await schedStore.addAdhocAt(time, { date: destDate, openAfter: true });
        return;
      }

      if (target.kind === "untimed") {
        setPickTarget(null);
        const it = target.item;
        if (destDate === target.date) {
          const msg = it.time === null ? TT_TEXT.schedPlaced(time) : TT_TEXT.schedMoved(time);
          await runScheduleWrite(planTimeWrite(it, time), planUndo(it), msg);
        } else if (it.kind === "single") {
          await ns.updateNode(it.nodeId, { scheduled_on: destDate, scheduled_time: time });
          useUiStore.getState().showToast({ message: `已排到 ${destDate.slice(5).replace("-", "/")} ${time}` });
        } else {
          useUiStore.getState().showToast({ message: "定期券只能排在當班日期" });
        }
        return;
      }

      if (target.kind === "block") {
        setPickTarget(null);
        if (target.blockKind === "adhoc" && target.planId) {
          const ad = packs.find((p) => p.date === target.date)?.adhocs[target.key];
          if (!ad) return;
          if (destDate === target.date) {
            const out: { prev?: { s: ClockText; e: ClockText } } = {};
            const ok = await planStore.editAdhoc(target.planId, { s: time, keepLength: true }, out);
            if (ok) {
              const back = out.prev;
              useUiStore.getState().showToast({
                message: TT_TEXT.schedMoved(time),
                ...(back ? { actionLabel: TT_TEXT.undo, onAction: () => void planStore.editAdhoc(target.planId!, back) } : {}),
              });
            }
          } else {
            const len = ad.estimateMin ?? 60;
            const e = clockText(Math.min(min + len, dayStartHour * 60 + 1440));
            if (!e) return;
            const row = await planStore.addAdhoc({
              day: destDate,
              s: time,
              e,
              label: ad.label,
              categoryId: ad.categoryId,
              routeId: ad.routeId,
              nodeId: ad.branchNodeId,
            });
            if (row) {
              await planStore.deleteAdhoc(ad.planId);
              useUiStore.getState().showToast({ message: `已移到 ${destDate.slice(5).replace("-", "/")} ${time}` });
            }
          }
          return;
        }
        if (target.blockKind === "slot" && target.planId) {
          if (destDate === target.date) {
            const out: { prev?: { s: ClockText; e: ClockText } } = {};
            const ok = await planStore.editSlot(target.planId, { s: time, keepLength: true }, out);
            if (ok) {
              const back = out.prev;
              useUiStore.getState().showToast({
                message: TT_TEXT.schedMoved(time),
                ...(back ? { actionLabel: TT_TEXT.undo, onAction: () => void planStore.editSlot(target.planId!, back) } : {}),
              });
            }
          } else {
            const sl = packs.find((p) => p.date === target.date)?.slots[target.key];
            const len = sl?.estimateMin ?? 60;
            const e = clockText(Math.min(min + len, dayStartHour * 60 + 1440));
            if (!e) return;
            const row = await planStore.addSlot(target.nodeId, destDate, time, e);
            if (row) {
              await planStore.deleteSlot(target.planId);
              useUiStore.getState().showToast({ message: `已移到 ${destDate.slice(5).replace("-", "/")} ${time}` });
            }
          }
          return;
        }
        // plan (第一段)
        const it = target.item;
        if (destDate === target.date) {
          await runScheduleWrite(planTimeWrite(it, time), planUndo(it), TT_TEXT.schedMoved(time));
        } else if (it.kind === "single") {
          await ns.updateNode(it.nodeId, { scheduled_on: destDate, scheduled_time: time });
          useUiStore.getState().showToast({ message: `已改到 ${destDate.slice(5).replace("-", "/")} ${time}` });
        } else {
          useUiStore.getState().showToast({ message: "定期券只能在同一天調整時刻" });
        }
      }
    },
    [todayKey, packs, dayStartHour],
  );

  // 指標拖曳（支援從未定時籤或已排時段卡拖到任意日欄與時刻）
  useEffect(() => {
    if (!dragState) return;
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const active = dragState.active || Math.hypot(dx, dy) >= 6;
      if (!active) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest<HTMLElement>(".ns-tg-col[data-day]");
      if (!col) {
        setDragState((s) => (s ? { ...s, active: true, hoverDate: null, hoverMin: null } : null));
        return;
      }
      const d = col.dataset.day ?? null;
      const r = col.getBoundingClientRect();
      const min = r.height > 0 ? snapFrac((e.clientY - r.top) / r.height, dayStartHour) : null;
      setDragState((s) => (s ? { ...s, active: true, hoverDate: d, hoverMin: min } : null));
    };
    const onUp = () => {
      const cur = dragState;
      setDragState(null);
      if (cur.active) {
        swallowRef.current = true;
        setTimeout(() => {
          swallowRef.current = false;
        }, 80);
        if (cur.hoverDate && cur.hoverMin !== null) {
          void commitTargetAt(cur.target, cur.hoverDate, cur.hoverMin);
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragState, dayStartHour, commitTargetAt]);

  const startDrag = (target: Exclude<PickTarget, { kind: "addadhoc" }>, estimateMin: number) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || target.date < todayKey) return;
    setDragState({
      target,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      hoverDate: null,
      hoverMin: null,
      estimateMin,
    });
  };

  /** 切換到指定日期的「單日（預定 vs 實績）」並可打開面板 */
  const switchToDay = async (date: string, openSheet?: { kind: "plan" | "slot" | "adhoc"; key: string }) => {
    await useTimetableStore.getState().setDayKey(date);
    useTimetableScheduleStore.getState().setScheduleMode("day");
    if (openSheet) {
      await useTimetableScheduleStore.getState().load();
      useTimetableStore.getState().openSheet(openSheet);
    }
  };

  const onColClick = (e: MouseEvent<HTMLDivElement>, date: string) => {
    if (swallowRef.current) return;
    if ((e.target as HTMLElement).closest(".ns-tg-blk")) return;
    const col = e.currentTarget;
    const rect = col.getBoundingClientRect();
    if (rect.height <= 0) return;
    const min = snapFrac((e.clientY - rect.top) / rect.height, dayStartHour);
    if (pickTarget) {
      void commitTargetAt(pickTarget, date, min);
      return;
    }
    // 沒選東西時點日欄空白：切該日為當前日
    void useTimetableStore.getState().setDayKey(date);
  };

  const onColDoubleClick = (e: MouseEvent<HTMLDivElement>, date: string) => {
    if ((e.target as HTMLElement).closest(".ns-tg-blk")) return;
    if (date < todayKey) return;
    const col = e.currentTarget;
    const rect = col.getBoundingClientRect();
    if (rect.height <= 0) return;
    const min = snapFrac((e.clientY - rect.top) / rect.height, dayStartHour);
    void commitTargetAt({ kind: "addadhoc" }, date, min);
  };

  const headCells = packs.map((p) => {
    const dt = dateOf(p.date);
    const wd = WEEKDAY_LABEL[dt.getDay()];
    const total = p.blocks.length + p.grid.untimed.length;
    const isToday = p.date === todayKey;
    const label = `${dt.getMonth() + 1}月${dt.getDate()}日 週${wd}${isToday ? "（今天）" : ""}${total ? `，${total} 班` : ""}（點擊查看單日預定 vs 實績）`;
    return (
      <div
        key={p.date}
        className={cx("ns-tg-dh", isToday && "is-today", p.date < todayKey && "is-past", p.date === dayKey && "is-sel")}
        data-day={p.date}
        aria-label={label}
        title={label}
        onClick={() => void switchToDay(p.date)}
      >
        <span className="wd">{mobile ? wd : `週${wd}`}</span>
        <span className="dn">{mobile ? `${dt.getMonth() + 1}/${dt.getDate()}` : dt.getDate()}</span>
        {!mobile && <span className="cnt">{total ? `${total} 班` : " "}</span>}
        {p.grid.dues.length > 0 && (
          <span className={cx("sime", dt.getDate() % 2 === 0 && "alt")} aria-hidden title={`締切 ${p.grid.dues.length} 件`}>
            〆{p.grid.dues.length > 1 && <span className="n">{p.grid.dues.length}</span>}
          </span>
        )}
      </div>
    );
  });

  const bandCells = packs.map((p) => {
    const band: TimeGridUntimed[] = [
      ...p.grid.untimed.filter((u) => u.outOfAxis),
      ...p.grid.untimed.filter((u) => !u.outOfAxis),
    ].filter((u) => !u.entry.is_done && u.entry.occurrence_status !== "skipped");
    const shown = band.slice(0, maxChips);
    const rest = band.length - shown.length;
    return (
      <div
        key={p.date}
        className={cx("ns-tg-bc", p.date === todayKey && "is-today", p.date === dayKey && "is-sel")}
        data-day={p.date}
      >
        {shown.map((u) => {
          const e = u.entry;
          const node = nodes[e.node_id];
          const name = node?.name ?? "？";
          const key = `${p.date}-${e.node_id}`;
          const it = p.items[key];
          if (!it) return null;
          const isPicked = pickTarget?.kind === "untimed" && pickTarget.key === key;
          const targetObj: Exclude<PickTarget, { kind: "addadhoc" }> = {
            kind: "untimed",
            date: p.date,
            key,
            nodeId: e.node_id,
            name,
            item: it,
          };
          return (
            <button
              key={key}
              type="button"
              className={cx("ns-tg-chip", u.outOfAxis && "oob", isPicked && "is-sel")}
              data-row-key={key}
              data-node={e.node_id}
              title={p.date >= todayKey ? `${name}（點一下再點時段排入，或直接拖到下方時段）` : name}
              onPointerDown={startDrag(targetObj, it.estimateMin ?? 45)}
              onClick={(ev) => {
                ev.stopPropagation();
                if (swallowRef.current) return;
                if (p.date < todayKey) {
                  void openTicket(e.node_id, shell);
                  return;
                }
                setPickTarget(isPicked ? null : targetObj);
              }}
            >
              <i className="dot" style={{ background: routeColorOf(pageWithNodes, e.node_id) }} />
              <span className="nm">{name}</span>
              {u.outOfAxis && e.time && <span className="oob-t">{e.time}</span>}
            </button>
          );
        })}
        {rest > 0 && (
          <button
            type="button"
            className="ns-tg-more"
            title={`還有 ${rest} 張未定時的票（點擊切換至該日單日視圖）`}
            onClick={() => void switchToDay(p.date)}
          >
            ＋{rest}
          </button>
        )}
      </div>
    );
  });

  const gutter = (
    <div className="ns-tg-gut" ref={gutRef}>
      {ticks.map((t, i) => {
        if (i === 0 || i === ticks.length - 1) return null;
        if (nowMin !== null && Math.abs(t.min - nowMin) < 14) return null;
        const top = ((t.min - axisMin) / 60) * H;
        const sub = mobile ? (t.h === 24 ? t.sub : null) : t.sub;
        return (
          <span key={t.h} className={cx("hl", t.night && "nite")} style={{ top }}>
            {mobile ? pad2(t.h) : t.label}
            {sub && <small>{sub}</small>}
          </span>
        );
      })}
      {nowMin !== null && nowTop !== null && (
        <span className="nowpill" style={{ top: nowTop }}>
          {clockText(nowMin)}
        </span>
      )}
    </div>
  );

  const cols = packs.map((p) => {
    const isToday = p.date === todayKey;
    const ghostHere =
      (dragState?.active && dragState.hoverDate === p.date && dragState.hoverMin !== null
        ? { min: dragState.hoverMin, len: dragState.estimateMin, name: dragState.target.name }
        : null) ??
      (pickTarget && hoverSlot?.date === p.date && p.date >= todayKey
        ? {
            min: hoverSlot.min,
            len: pickTarget.kind === "addadhoc" ? 60 : (pickTarget.item.estimateMin ?? 45),
            name: pickTarget.kind === "addadhoc" ? ADHOC_TEXT.fallbackName : pickTarget.name,
          }
        : null);

    return (
      <div
        key={p.date}
        className={cx(
          "ns-tg-col",
          isToday && "is-today",
          p.date < todayKey && "is-past",
          p.date === dayKey && "is-sel",
          pickTarget && p.date >= todayKey && "is-picking",
        )}
        data-day={p.date}
        onClick={(e) => onColClick(e, p.date)}
        onDoubleClick={(e) => onColDoubleClick(e, p.date)}
        onPointerMove={(e) => {
          if (!pickTarget || p.date < todayKey || e.pointerType !== "mouse") return;
          const r = e.currentTarget.getBoundingClientRect();
          if (r.height <= 0) return;
          const m = snapFrac((e.clientY - r.top) / r.height, dayStartHour);
          setHoverSlot({ date: p.date, min: m });
        }}
        onPointerLeave={() => setHoverSlot((cur) => (cur?.date === p.date ? null : cur))}
      >
        {nightHours > 0 && (
          <>
            <div className="ns-tg-night" style={{ top: (24 - nightHours) * H, height: nightHours * H }} />
            <div className="ns-tg-midnight" style={{ top: (24 - nightHours) * H }} />
          </>
        )}
        {nowTop !== null && <div className={cx("ns-tg-now", !isToday && "ghost")} style={{ top: nowTop }} />}

        {p.blocks.map((b) => {
          const adhoc = b.slotId !== null ? p.adhocs[b.key] : undefined;
          const slot = b.slotId !== null && !adhoc ? p.slots[b.key] : undefined;
          const it = adhoc ?? slot ?? p.items[b.key];
          if (!it) return null;
          const adDisp = adhoc ? adhocDisplayOf(pageWithNodes, adhoc) : null;
          const name = adDisp ? adDisp.name : (nodes[it.nodeId]?.name ?? "？");
          const rc = adDisp ? adDisp.color : routeColorOf(pageWithNodes, it.nodeId);
          const time = it.time ?? "";
          const top = ((b.startMin - axisMin) / 60) * H;
          const dur = b.endMin - b.startMin;
          const height = Math.min(Math.max((dur / 60) * H, minH), Math.max(24 * H - top, 0));
          const short = height < shortH;
          const lc = Math.max(1, Math.floor((height - 19) / 14.3));
          const nx = time ? nextDayNote(time) : null;
          const segNo = !adhoc && it.kind === "single" ? segNumberOf(nodes[it.nodeId], it.nodeId, slotsByNode[it.nodeId], slot ? slot.planId : "main") : null;
          const segTag = segNo && segNo.total > 1 ? SEG_TEXT.tag(segNo.n) : null;
          const isPicked = pickTarget?.kind === "block" && pickTarget.key === b.key;
          const past = !it.done && !it.skipped && isClockPast(p.date, time, now);
          const blockKind: "plan" | "slot" | "adhoc" = adhoc ? "adhoc" : slot ? "slot" : "plan";
          const targetObj: Exclude<PickTarget, { kind: "addadhoc" }> = {
            kind: "block",
            date: p.date,
            key: b.key,
            blockKind,
            name,
            time,
            nodeId: it.nodeId,
            planId: adhoc?.planId ?? slot?.planId ?? null,
            item: it,
          };

          const style = {
            "--rc": rc,
            "--lc": lc,
            top,
            height,
            left: `calc(${(b.lane / b.lanes) * 100}% + 2px)`,
            width: `calc(${100 / b.lanes}% - 4px)`,
          } as CSSProperties;

          return (
            <button
              key={b.key}
              type="button"
              className={cx(
                "ns-tg-blk",
                adhoc && "is-adhoc",
                short && "short",
                it.done && "done",
                it.skipped && "skipped",
                past && "past",
                b.noEstimate && "noest",
                isPicked && "is-sel",
              )}
              data-row-key={b.key}
              style={style}
              title={`${time}${nx ? `（${nx}）` : ""}・${it.estimateMin ? fmtDur(it.estimateMin * MIN) : "長度未定"}　${name}${adhoc ? "（臨時班次）" : ""}`}
              onPointerDown={startDrag(targetObj, it.estimateMin ?? 45)}
              onClick={(ev) => {
                ev.stopPropagation();
                if (swallowRef.current) return;
                if (pickTarget && pickTarget.kind !== "block") {
                  const colRect = ev.currentTarget.parentElement?.getBoundingClientRect();
                  if (colRect && colRect.height > 0) {
                    const m = snapFrac((ev.clientY - colRect.top) / colRect.height, dayStartHour);
                    void commitTargetAt(pickTarget, p.date, m);
                  }
                  return;
                }
                if (isPicked) {
                  setPickTarget(null);
                  void switchToDay(p.date, { kind: blockKind, key: b.key });
                } else {
                  setPickTarget(targetObj);
                }
              }}
            >
              <span className="bt">
                {time}
                {adhoc && <em className="ns-tt-sched-tag is-adhoc">{ADHOC_TEXT.tag}</em>}
                {!adhoc && segTag && <em className="ns-tt-sched-tag is-seg">{segTag}</em>}
                {nx && !short && !mobile && <span className="nx">{nx}</span>}
              </span>
              <span className="bn">{name}</span>
              {it.done && (
                <span className="mini-seal" aria-hidden>
                  済
                </span>
              )}
            </button>
          );
        })}

        {ghostHere && (
          <div
            className="ns-tt-sched-ghost"
            style={{
              top: ((ghostHere.min - axisMin) / 60) * H,
              height: Math.max((ghostHere.len / 60) * H, minH),
              left: "2px",
              right: "2px",
              width: "calc(100% - 4px)",
            }}
            aria-hidden="true"
          >
            <span className="ns-tt-num">{clockText(ghostHere.min)}</span>
            <b>{ghostHere.name}</b>
          </div>
        )}
      </div>
    );
  });

  return (
    <div className="ns-tt-wksched">
      {pickTarget && (
        <div className="ns-tt-wk-pickbar">
          <span className="ns-tt-wk-picktxt">
            {pickTarget.kind === "addadhoc"
              ? ADHOC_TEXT.pickAdd
              : pickTarget.kind === "untimed"
                ? `已選「${pickTarget.name}」——點下方任意時段排入時刻`
                : `已選「${pickTarget.name}」（${pickTarget.time}）——點新時段改時刻，或再點一次開面板`}
          </span>
          <div className="ns-tt-wk-pickacts">
            {pickTarget.kind === "untimed" && (
              <button
                type="button"
                className="ns-tt-opt is-solid"
                onClick={() => {
                  const id = pickTarget.nodeId;
                  setPickTarget(null);
                  void openTicket(id, shell);
                }}
              >
                {SCHED_UI.open}
              </button>
            )}
            {pickTarget.kind === "block" && (
              <>
                <button
                  type="button"
                  className="ns-tt-opt is-solid"
                  onClick={() => {
                    const { date, blockKind, key } = pickTarget;
                    setPickTarget(null);
                    void switchToDay(date, { kind: blockKind, key });
                  }}
                >
                  單日對照與詳情 ›
                </button>
                {pickTarget.blockKind === "adhoc" && (
                  <button
                    type="button"
                    className="ns-tt-opt is-solid"
                    onClick={() => {
                      const { date, key } = pickTarget;
                      setPickTarget(null);
                      void (async () => {
                        await useTimetableStore.getState().setDayKey(date);
                        await useTimetableScheduleStore.getState().load();
                        const row = await useTimetableScheduleStore.getState().convertAdhocToTicket(key);
                        if (row) void openTicket(row.id, shell);
                      })();
                    }}
                  >
                    轉為正式車票
                  </button>
                )}
              </>
            )}
            <button type="button" className="ns-tt-opt" onClick={() => setPickTarget(null)}>
              {TT_TEXT.schedPickCancel}
            </button>
          </div>
        </div>
      )}
      <div className="ns-tg" data-shell={shell} style={{ "--n": days.length } as CSSProperties}>
        <div className="ns-tg-scroll" ref={scrollRef}>
          <div className="ns-tg-grid">
            <div className="ns-tg-row ns-tg-head">
              <div className="ns-tg-corner" />
              {headCells}
            </div>
            <div className="ns-tg-row ns-tg-band">
              <div className="ns-tg-corner ns-tt-wk-corner">
                <span>未定時</span>
                <button
                  type="button"
                  className={"ns-tt-sched-adhoc-btn is-compact" + (pickTarget?.kind === "addadhoc" ? " is-pick" : "")}
                  onClick={() => setPickTarget(pickTarget?.kind === "addadhoc" ? null : { kind: "addadhoc" })}
                  title="在週時段任意位置放下臨時班次"
                >
                  ＋臨時
                </button>
              </div>
              {bandCells}
            </div>
            <div className="ns-tg-row ns-tg-body">
              {gutter}
              {cols}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
