/**
 * WeekGrid——行程表週視圖「2×4 八分割・週間見開き」（v1.37 2A-3）。
 *
 * 版面結構（語意 class 預留給 2B-Resp 窄視窗銜接）：
 *   .month-card.wk-spread（撐滿主欄高度之雙排四格見開き）
 *     ├── .wk-row-band.wk-row-top（上排 4 格：該週前 4 天，完全尊重 weekStart）
 *     │     ├── .wk-ribbons（若有 isMultiDayTicket 跨上排，連續橫跨對應格位）
 *     │     └── .wk-row-grid > .wk-day × 4
 *     └── .wk-row-band.wk-row-bot（下排 4 格：該週後 3 天 ＋ 第 8 格本週總覽專欄）
 *           ├── .wk-ribbons（若有 isMultiDayTicket 跨下排，橫跨前 3 格、不碰第 8 格）
 *           └── .wk-row-grid > .wk-day × 3 ＋ .wk-summary
 *
 * 每日大格（.wk-day）：
 *   - 格頭：星期＋日期（今日赭菱形＋今日標記）、日記記號、當日預估總時數（2.5h）、締切數 〆（hover 出 DueTip）
 *   - 格內車票小卡（可捲動）：原地蓋済／途中下車／運休、時刻、預估時長、票名（點開詳情側板）、
 *     路線左色條、<NodeCrumb />、常駐素雅 <EntityTagPills />、⋯ 選單／右鍵、跨格拖曳改期（useDragReorder）
 *   - 格內未完成締切精簡小列（〆）
 *   - 格底輕巧「＋ 車票」快捷鈕（點擊就地展開 QuickAddRow 精簡建票列，僅今天與未來）
 *
 * 第 8 格「本週總覽專欄」（.wk-summary）：
 *   1. 本週方針（直接複用 useAimView / AimStamp / RouteTag ＋ 一鍵開啟行路企劃書）
 *   2. 本週期間自由券（篩選與本週重疊之 isFlexibleRangeTicket，零額外 SQL，可原地蓋済／開詳情）
 *   3. 本週小結（已蓋済 / 總班次、預估總時數、待處理締切數 ＋ 本週行路企劃書入口）
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { isTaskKind, parseRule, WEEKDAY_LABEL, type NodeRow } from "../../domain";
import {
  compareRangeDrawerRows,
  formatDateRangeBadge,
  hasDateSpan,
  isFlexibleRangeTicket,
  isMultiDayTicket,
} from "../../domain/dateRange";
import { formatDurationShort } from "../../domain/duration";
import { effectiveEstimateMin } from "../../domain/scheduledTime";
import { aimNumeral, weekOnOf } from "../../domain/weekAims";
import type { DueEntry, ScheduleEntry } from "../../data";
import { addDays, isClockPast } from "../../lib/date";
import { batchSetDate } from "../../store/batchActions";
import { scheduleSnapshot, useNodeStore } from "../../store/nodeStore";
import { useSelectionStore } from "../../store/selectionStore";
import { useUiStore } from "../../store/uiStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { rowContextMenu } from "../common/contextMenu";
import { useDragReorder } from "../common/dragReorder";
import { IconDots, IconPlus } from "../common/icons";
import { NodeCrumb } from "../common/NodeCrumb";
import { PopMenu, rowsOf, type PopMenuItem } from "../common/PopMenu";
import { PriorityMark } from "../common/PriorityMark";
import { NO_DEST, QuickAddRow, type QuickDefaults } from "../common/quickadd";
import { armOpenOnClick } from "../common/selection/openOnClick";
import { EntityTagPills } from "../common/TagPills";
import { moveRunFlow, toggleStopoverFlow } from "../outline/nodeFlows";
import { HISTORY_MSG, makeScheduleActions, scheduleRowMenu, type ScheduleActions } from "../schedule/scheduleActions";
import { mdw } from "../schedule/streamModel";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { SealStopover, SealSuspended } from "../stamps";
import { DeferPopover, type DeferRow } from "../today/DeferPopover";
import { AimStamp, RouteTag } from "../weekAims/parts";
import { useAimView } from "../weekAims/useWeekAims";
import { WeekAimsEditorHost } from "../weekAims/WeekAimsEditor";
import "../weekAims/weekAims.css";
import { canStampRow, dayRowModel, mmdd, type DayRowModel } from "./DayRow";
import { diffCalendarDays, formatEstHours, layoutMultiDayRibbons, type RibbonSegment } from "./multiDayRibbon";
import { dateOf, useCalendar } from "./useCalendarController";
import "./week.css";

export interface WeekGridProps {
  /** 該週的第一天（週首依設定；YYYY-MM-DD） */
  weekStart: string;
  /** 從週首起的七天 */
  days: string[];
}

const EMPTY_ENTRIES: ScheduleEntry[] = [];
const EMPTY_DUES: DueEntry[] = [];

type CssVars = CSSProperties & Record<`--${string}`, string | number>;

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

const weekDraftDefaultsCache = new Map<string, QuickDefaults>();
function weekDraftDefaults(day: string): QuickDefaults {
  let d = weekDraftDefaultsCache.get(day);
  if (!d) {
    d = { dest: NO_DEST, scheduledOn: day, noDateLabel: true };
    weekDraftDefaultsCache.set(day, d);
  }
  return d;
}

/** 計算某日未取消之單日／定期票預估總分鐘數 */
function dayEstimateMinutes(entries: readonly ScheduleEntry[], nodes: Record<string, NodeRow>): number {
  let sum = 0;
  for (const e of entries) {
    if (e.occurrence_status === "skipped") continue;
    const node = nodes[e.node_id];
    if (!node || node.status === "paused") continue;
    if (hasDateSpan(node)) continue;
    const est = effectiveEstimateMin({
      estimate_min: node.estimate_min,
      seated_into: e.seated_into ?? null,
    });
    if (est && est > 0) sum += est;
  }
  return sum;
}

function openNodeDetail(nodeId: string): void {
  const ui = useUiStore.getState();
  ui.select(nodeId);
  ui.setPanelOpen(true);
}

/** 跨格拖曳多日行程色帶：整段平移至目標日作為新起日（維持天數與 isMultiDay 旗標，附復原） */
async function shiftMultiDayTicket(node: NodeRow, targetStart: string): Promise<void> {
  if (!node.scheduled_on || !node.scheduled_end) return;
  const spanDays = diffCalendarDays(node.scheduled_end, node.scheduled_on);
  const nextEnd = addDays(targetStart, spanDays);
  const prev = {
    ...scheduleSnapshot(node),
    scheduled_end: node.scheduled_end,
    is_multi_day: node.is_multi_day,
  };
  await useNodeStore.getState().reschedule(node.id, targetStart, {
    scheduledEnd: nextEnd,
    isMultiDay: true,
  });
  useUiStore.getState().showToast({
    message: `多日行程已平移至 ${formatDateRangeBadge(targetStart, nextEnd)}`,
    actionLabel: "復原",
    onAction: () => void useNodeStore.getState().updateNode(node.id, prev),
  });
}

export function WeekGrid({ weekStart, days }: WeekGridProps) {
  const c = useCalendar();
  const now = useMinuteTick();
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const firstDow = useUiStore((s) => s.weekStart);

  const actions = useMemo(() => makeScheduleActions("desktop"), []);
  const [draftDay, setDraftDay] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [deferState, setDeferState] = useState<{ row: DeferRow; anchor: HTMLElement | null } | null>(null);

  // 切換週別時收起就地草稿與推遲小卡
  useEffect(() => {
    setDraftDay(null);
    setDeferState(null);
  }, [weekStart]);

  const markFresh = useCallback((key: string) => {
    setFreshKey(key);
    window.setTimeout(() => setFreshKey((cur) => (cur === key ? null : cur)), 800);
  }, []);

  const routeById = useMemo(() => new Map(c.routes.map((r) => [r.id, r] as const)), [c.routes]);
  const allNodes = useMemo(() => Object.values(c.nodes), [c.nodes]);

  const topDays = useMemo(() => days.slice(0, 4), [days]);
  const botDays = useMemo(() => days.slice(4, 7), [days]);
  const weekEnd = days[days.length - 1] ?? addDays(weekStart, 6);

  const topRibbons = useMemo(
    () => layoutMultiDayRibbons(topDays, allNodes, c.today),
    [topDays, allNodes, c.today],
  );
  const botRibbons = useMemo(
    () => layoutMultiDayRibbons(botDays, allNodes, c.today),
    [botDays, allNodes, c.today],
  );

  // 鍵盤焦點落點：選取格 → 本週今天 → 週首
  const focusDay =
    c.selectedDay && c.selectedDay >= c.range.from && c.selectedDay <= c.range.to
      ? c.selectedDay
      : c.today >= c.range.from && c.today <= c.range.to
        ? c.today
        : weekStart;

  // 本週預估總分鐘（7 天合計）
  const weekEstMin = useMemo(
    () => days.reduce((acc, d) => acc + dayEstimateMinutes(c.byDate.entries[d] ?? EMPTY_ENTRIES, c.nodes), 0),
    [days, c.byDate.entries, c.nodes],
  );

  // 本週期間自由券（從 calendar.nodes 篩出與本週重疊者，零額外 SQL）
  const flexTickets = useMemo(() => {
    const list = allNodes.filter(
      (n) =>
        n.deleted_at === null &&
        isFlexibleRangeTicket(n) &&
        n.scheduled_on !== null &&
        n.scheduled_end !== null &&
        n.scheduled_on <= weekEnd &&
        n.scheduled_end >= weekStart,
    );
    const unsettled = list.filter((n) => n.status !== "done" && n.status !== "paused").sort(compareRangeDrawerRows);
    const settled = list.filter((n) => n.status === "done" || n.status === "paused").sort(compareRangeDrawerRows);
    return [...unsettled, ...settled];
  }, [allNodes, weekStart, weekEnd]);

  const openDefer = useCallback((row: DayRowModel, anchor: HTMLElement) => {
    if (!row.node) return;
    const st = row.entry.occurrence_status;
    const deferRow: DeferRow = {
      ...row.node,
      occurrence: st ? { id: `${row.node.id}:${row.entry.date}`, status: st, due_on: row.entry.date } : null,
      railDate: row.entry.date,
    };
    setDeferState((cur) => (cur?.row.id === row.node?.id && cur?.row.railDate === row.entry.date ? null : { row: deferRow, anchor }));
  }, []);

  const handleStamp = useCallback(
    (row: DayRowModel) => {
      if (actions.stamp({ kind: "entry", row })) markFresh(row.key);
    },
    [actions, markFresh],
  );

  const weekAimKey = weekOnOf(weekStart, firstDow);

  return (
    <>
      <div
        className="month-card wk-spread"
        role="group"
        aria-label={`${Number(weekStart.slice(5, 7))}月${Number(weekStart.slice(8, 10))}日起的週間見開き`}
        data-week-start={firstDow}
      >
        {/* ═══ 上排（前 4 天）═══ */}
        <div
          className={cx("wk-row-band wk-row-top", topRibbons.laneCount > 0 && "has-ribbons")}
          style={topRibbons.laneCount > 0 ? ({ "--wk-ribbon-lanes": topRibbons.laneCount } as CssVars) : undefined}
        >
          {topRibbons.laneCount > 0 && (
            <WeekRibbonBar
              segments={topRibbons.segments}
              routeById={routeById}
              today={c.today}
            />
          )}
          <div className="wk-row-grid">
            {topDays.map((day, idx) => (
              <WeekDayCell
                key={day}
                day={day}
                showMonthPrefix={idx === 0 || day.endsWith("-01")}
                isToday={day === c.today}
                isPast={day < c.today}
                entries={c.byDate.entries[day] ?? EMPTY_ENTRIES}
                dues={c.byDate.dues[day] ?? EMPTY_DUES}
                hasDiary={Boolean(c.marks[day]?.includes("notes"))}
                nodes={c.nodes}
                routeById={routeById}
                currentOccurrences={currentOccurrences}
                today={c.today}
                now={now}
                focusable={day === focusDay}
                selected={c.popTarget?.day === day}
                freshKey={freshKey}
                draftOpen={draftDay === day}
                onOpenDraft={() => setDraftDay(day)}
                onCloseDraft={() => setDraftDay((cur) => (cur === day ? null : cur))}
                onOpenDay={(anchor) => c.openDay(day, anchor)}
                onTip={(anchor) => (anchor ? c.showTip(day, anchor) : c.hideTip())}
                onStamp={handleStamp}
                onOpenDefer={openDefer}
                actions={actions}
              />
            ))}
          </div>
        </div>

        {/* ═══ 下排（後 3 天 ＋ 第 8 格本週總覽專欄）═══ */}
        <div
          className={cx("wk-row-band wk-row-bot", botRibbons.laneCount > 0 && "has-ribbons")}
          style={botRibbons.laneCount > 0 ? ({ "--wk-ribbon-lanes": botRibbons.laneCount } as CssVars) : undefined}
        >
          {botRibbons.laneCount > 0 && (
            <WeekRibbonBar
              segments={botRibbons.segments}
              routeById={routeById}
              today={c.today}
            />
          )}
          <div className="wk-row-grid">
            {botDays.map((day) => (
              <WeekDayCell
                key={day}
                day={day}
                showMonthPrefix={day.endsWith("-01")}
                isToday={day === c.today}
                isPast={day < c.today}
                entries={c.byDate.entries[day] ?? EMPTY_ENTRIES}
                dues={c.byDate.dues[day] ?? EMPTY_DUES}
                hasDiary={Boolean(c.marks[day]?.includes("notes"))}
                nodes={c.nodes}
                routeById={routeById}
                currentOccurrences={currentOccurrences}
                today={c.today}
                now={now}
                focusable={day === focusDay}
                selected={c.popTarget?.day === day}
                freshKey={freshKey}
                draftOpen={draftDay === day}
                onOpenDraft={() => setDraftDay(day)}
                onCloseDraft={() => setDraftDay((cur) => (cur === day ? null : cur))}
                onOpenDay={(anchor) => c.openDay(day, anchor)}
                onTip={(anchor) => (anchor ? c.showTip(day, anchor) : c.hideTip())}
                onStamp={handleStamp}
                onOpenDefer={openDefer}
                actions={actions}
              />
            ))}

            {/* 第 8 格：本週總覽專欄（方針・期間自由券・本週小結） */}
            <WeekSummaryCell
              weekAimKey={weekAimKey}
              flexTickets={flexTickets}
              routeById={routeById}
              stats={c.stats}
              weekEstMin={weekEstMin}
            />
          </div>
        </div>
      </div>

      {/* 行路企劃書工作台 Host（週視圖頂部已不掛外層 WeekAimsBand，由此處掛載確保編輯入口暢通） */}
      <WeekAimsEditorHost today={c.today} weekStart={firstDow} />

      {/* 推遲／改期小卡：portal 到 body，避免被 .month-card 的 backdrop-filter 建立包含塊導致 fixed 偏移 */}
      {deferState &&
        createPortal(
          <DeferPopover
            row={deferState.row}
            anchor={deferState.anchor}
            onClose={() => setDeferState(null)}
          />,
          document.body,
        )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════
 * 多日乘車色帶列（每排 4 欄對齊，支援點擊開詳情＋跨格拖曳平移起訖）
 * ═══════════════════════════════════════════════════════ */

function WeekRibbonBar({
  segments,
  routeById,
  today,
}: {
  segments: readonly RibbonSegment[];
  routeById: ReadonlyMap<string, NodeRow>;
  today: string;
}) {
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const segById = useMemo(() => new Map(segments.map((s) => [s.nodeId, s] as const)), [segments]);

  useDragReorder({
    root: rootEl,
    items: segments.map((s) => ({ id: s.nodeId })),
    slots: false,
    canDrag: (id) => {
      const seg = segById.get(id);
      if (!seg) return "無法移動此行程";
      if (seg.done) return "已蓋済的多日行程不能改期——要改先取消済章";
      if (seg.paused) return "途中下車中的行程請先解除再改期";
      return true;
    },
    onRefuse: (_id, why) => useUiStore.getState().showToast({ message: why }, 3500),
    resolve: (ids, place) => {
      if (place.kind !== "target" || place.type !== "date") return "拖到某一天的格子上，平移這趟多日行程";
      if (place.target < today) return "不能排到過去的日子";
      const seg = segById.get(ids[0]);
      if (seg?.node.scheduled_on === place.target) return "已經從這一天開始";
      return true;
    },
    onDrop: (ids, place) => {
      if (place.kind !== "target" || place.type !== "date") return;
      const seg = segById.get(ids[0]);
      if (seg) void shiftMultiDayTicket(seg.node, place.target);
    },
  });

  return (
    <div ref={setRootEl} className="wk-ribbons" role="list" aria-label="本排多日行程">
      {segments.map((seg) => {
        const route = seg.node.route_id ? routeById.get(seg.node.route_id) : undefined;
        const rangeText = seg.node.scheduled_on
          ? formatDateRangeBadge(seg.node.scheduled_on, seg.node.scheduled_end)
          : "";
        const statusSuffix = seg.done ? "（已済）" : seg.paused ? "（途中下車）" : seg.late ? "（誤點）" : "";
        const style: CssVars = {
          gridColumn: `${seg.startCol + 1} / span ${seg.span}`,
          gridRow: seg.lane + 1,
          "--ribbon-c": route?.color ?? "var(--route-none)",
        };
        return (
          <div
            key={seg.nodeId}
            role="button"
            tabIndex={0}
            data-drag-id={seg.nodeId}
            className={cx(
              "wk-ribbon",
              seg.continuesLeft && "is-cont-l",
              seg.continuesRight && "is-cont-r",
              seg.done && "is-done",
              seg.paused && "is-paused",
              seg.late && "is-late",
            )}
            style={style}
            title={`${seg.node.name}（${rangeText}）${statusSuffix}・點擊開詳情，拖曳可平移日期`}
            aria-label={`多日行程：${seg.node.name}，${rangeText}${statusSuffix}`}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              armOpenOnClick(e, () => openNodeDetail(seg.nodeId));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openNodeDetail(seg.nodeId);
              }
            }}
          >
            {seg.continuesLeft && (
              <span className="wk-ribbon-cont" aria-hidden>
                ‹
              </span>
            )}
            <span className="wk-ribbon-name">{seg.node.name}</span>
            {rangeText && <span className="wk-ribbon-range">{rangeText}</span>}
            {seg.done && (
              <span className="wk-ribbon-seal" aria-hidden>
                済
              </span>
            )}
            {seg.continuesRight && (
              <span className="wk-ribbon-cont" aria-hidden>
                ›
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
 * 單日大格（7 格共用）
 * ═══════════════════════════════════════════════════════ */

interface WeekDayCellProps {
  day: string;
  showMonthPrefix: boolean;
  isToday: boolean;
  isPast: boolean;
  entries: ScheduleEntry[];
  dues: DueEntry[];
  hasDiary: boolean;
  nodes: Record<string, NodeRow>;
  routeById: ReadonlyMap<string, NodeRow>;
  currentOccurrences: Record<string, { due_on: string }>;
  today: string;
  now: number;
  focusable: boolean;
  selected: boolean;
  freshKey: string | null;
  draftOpen: boolean;
  onOpenDraft(): void;
  onCloseDraft(): void;
  onOpenDay(anchor: HTMLElement): void;
  onTip(anchor: HTMLElement | null): void;
  onStamp(row: DayRowModel): void;
  onOpenDefer(row: DayRowModel, anchor: HTMLElement): void;
  actions: ScheduleActions;
}

function WeekDayCell({
  day,
  showMonthPrefix,
  isToday,
  isPast,
  entries,
  dues,
  hasDiary,
  nodes,
  routeById,
  currentOccurrences,
  today,
  now,
  focusable,
  selected,
  freshKey,
  draftOpen,
  onOpenDraft,
  onCloseDraft,
  onOpenDay,
  onTip,
  onStamp,
  onOpenDefer,
  actions,
}: WeekDayCellProps) {
  const d = dateOf(day);
  const dow = d.getDay();
  const isWeekend = dow === 0 || dow === 6;

  // 格內卡片只列單日與定期班次：多日乘車日已畫於上方色帶，期間自由券集中於第 8 格總覽專欄
  const cardRows = useMemo<DayRowModel[]>(() => {
    const out: DayRowModel[] = [];
    for (const e of entries) {
      const node = nodes[e.node_id];
      if (node && (isMultiDayTicket(node) || isFlexibleRangeTicket(node))) continue;
      const route = node?.route_id ? routeById.get(node.route_id) : undefined;
      out.push(dayRowModel(e, node, route, currentOccurrences[e.node_id]?.due_on ?? null, today));
    }
    return out;
  }, [entries, nodes, routeById, currentOccurrences, today]);

  const estMin = useMemo(() => dayEstimateMinutes(entries, nodes), [entries, nodes]);
  const estLabel = formatEstHours(estMin);

  // 跨格拖曳改期（useDragReorder；單日票走 batchSetDate，定期券走 moveRunFlow）
  const [cardsEl, setCardsEl] = useState<HTMLDivElement | null>(null);
  useDragReorder({
    root: cardsEl,
    items: cardRows.map((r) => ({ id: r.entry.node_id })),
    slots: false,
    dragIds: (id) => {
      const sel = useSelectionStore.getState();
      if (sel.scope !== "schedule" || !sel.ids.includes(id)) return [id];
      const batch = sel.ids.filter((x) => {
        const n = nodes[x];
        return !!n && !parseRule(n.repeat_rule);
      });
      return batch.length > 0 ? batch : [id];
    },
    canDrag: (id) => {
      const n = nodes[id];
      if (!n) return "這一張不能拖";
      const row = cardRows.find((r) => r.entry.node_id === id);
      if (!row) return "這一張不能拖";
      if (row.done) return "已蓋済的票不能改期——要改先取消済章";
      if (row.isRepeat) {
        if (row.skipped) return "運休中的班不能改期——要改先取消運休";
        if (row.isHistory) return HISTORY_MSG;
      }
      return true;
    },
    onRefuse: (_id, why) => useUiStore.getState().showToast({ message: why }, 3500),
    resolve: (_ids, place) => {
      if (place.kind !== "target" || place.type !== "date") return "拖到某一天的格子上，就改到那一天";
      if (place.target === day) return "已經是這一天";
      if (place.target < today) return "不能排到過去的日子";
      return true;
    },
    onDrop: (ids, place) => {
      if (place.kind !== "target" || place.type !== "date") return;
      if (parseRule(nodes[ids[0]]?.repeat_rule ?? null)) {
        void moveRunFlow(ids[0], day, place.target);
      } else {
        void batchSetDate(ids, place.target, `已改到 ${mdw(place.target)}`);
      }
    },
  });

  const dateText = showMonthPrefix ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getDate()}`;

  return (
    <section
      className={cx(
        "wk-day",
        isToday && "is-today",
        isPast && "is-past",
        isWeekend && "is-we",
        selected && "is-on",
      )}
      data-day={day}
      data-drop-target={day}
      data-drop-type="date"
      aria-label={`${d.getMonth() + 1}月${d.getDate()}日 週${WEEKDAY_LABEL[dow]}${isToday ? "（今天）" : ""}`}
    >
      {/* 格頭：星期＋日期＋今日標記 / 日記記號＋預估總時數＋締切數 〆 */}
      <header className="wk-day-head">
        <button
          type="button"
          className="wk-day-datebtn ns-daycell-hit-wk"
          tabIndex={focusable ? 0 : -1}
          aria-current={isToday ? "date" : undefined}
          title="點開當日完整清單與排時段"
          onClick={(e) => onOpenDay(e.currentTarget)}
        >
          <span className="wk-day-wd">{WEEKDAY_LABEL[dow]}</span>
          <span className="wk-day-num">{dateText}</span>
          {isToday && <span className="wk-day-today-tag">今日</span>}
        </button>

        <div className="wk-day-meta">
          {hasDiary && (
            <span className="wk-day-diary" title="當日有旅客日記" aria-label="有日記" />
          )}
          {estLabel && (
            <span className="wk-day-est" title={`當日預估總時數 ${estLabel}`}>
              {estLabel}
            </span>
          )}
          {dues.length > 0 && (
            <span
              className="wk-day-due-badge"
              title={`當日締切 ${dues.length} 件`}
              onMouseEnter={(e) => onTip(e.currentTarget)}
              onMouseLeave={() => onTip(null)}
            >
              〆{dues.length > 1 ? <span className="n">{dues.length}</span> : null}
            </span>
          )}
        </div>
      </header>

      {/* 格內可捲動區：車票小卡 ＋ 當日未完成締切小列 */}
      <div className="wk-day-body">
        <div ref={setCardsEl} className="wk-day-cards">
          {cardRows.map((row) => (
            <WeekTicketCard
              key={row.key}
              row={row}
              today={today}
              now={now}
              fresh={freshKey === row.key}
              onStamp={() => onStamp(row)}
              onOpenDefer={(anchor) => onOpenDefer(row, anchor)}
              actions={actions}
            />
          ))}
        </div>

        {dues.length > 0 && (
          <div className="wk-day-dues" aria-label="當日締切">
            {dues.map((due) => {
              const node = nodes[due.node_id];
              const name = node?.name ?? "";
              return (
                <button
                  key={`${due.date}-${due.node_id}`}
                  type="button"
                  className="wk-due-line"
                  title={`締切：${name}`}
                  onClick={() => openNodeDetail(due.node_id)}
                >
                  <span className="wk-due-mark" aria-hidden>
                    〆
                  </span>
                  <span className="wk-due-name">{name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 格底快捷建票（僅今天與未來） */}
      {!isPast && (
        <footer className="wk-day-foot">
          {draftOpen ? (
            <QuickAddRow
              variant="compact"
              className="wk-draft-qa"
              defaults={weekDraftDefaults(day)}
              here={{ kind: "day", day }}
              placeholder="新增車票…"
              onClose={onCloseDraft}
            />
          ) : (
            <button
              type="button"
              className="wk-day-add"
              title={`在 ${mmdd(day)} 新增車票`}
              onClick={onOpenDraft}
            >
              <IconPlus size={12} />
              <span>車票</span>
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════
 * 週見開き格內互動車票小卡（原地蓋済／途中下車／詳情／拖曳改期／⋯ 選單）
 * ═══════════════════════════════════════════════════════ */

function WeekTicketCard({
  row,
  today,
  now,
  fresh,
  onStamp,
  onOpenDefer,
  actions,
}: {
  row: DayRowModel;
  today: string;
  now: number;
  fresh: boolean;
  onStamp(): void;
  onOpenDefer(anchor: HTMLElement): void;
  actions: ScheduleActions;
}) {
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [menuItems, setMenuItems] = useState<PopMenuItem[] | null>(null);

  const node = row.node;
  const name = row.entry.custom_title || node?.name || "";
  const paused = node?.status === "paused" && !row.done && !row.skipped;
  const settled = row.done || row.skipped || paused;
  const doing = node?.status === "doing" && (!row.isRepeat || node.scheduled_on === row.entry.date);
  const time = row.entry.time;
  const pastTime = time !== null && !settled && !doing && isClockPast(row.entry.date, time, now);
  const effEst = effectiveEstimateMin({
    estimate_min: node?.estimate_min ?? null,
    seated_into: row.entry.seated_into ?? null,
  });
  const canStamp = canStampRow(row);
  const routeColor = row.route?.color ?? "var(--route-none)";

  const buildMenu = useCallback(
    (anchor: HTMLElement | null): PopMenuItem[] => {
      if (!node) return [];
      const base = scheduleRowMenu(actions, row, {
        today,
        openDefer: () => {
          if (anchor) onOpenDefer(anchor);
        },
      });
      if (row.isHistory || row.done || row.skipped) return base;
      if ((!row.isRepeat || row.isCurrent) && !base.some((it) => it.key === "stopover")) {
        const stopItem: PopMenuItem = {
          key: "stopover",
          label: node.status === "paused" ? "解除途中下車" : "途中下車",
          onSelect: () => void toggleStopoverFlow(node.id),
        };
        const delIdx = base.findIndex((it) => it.danger);
        const next = delIdx >= 0 ? [...base.slice(0, delIdx), stopItem, ...base.slice(delIdx)] : [...base, stopItem];
        if (rowsOf(next).length > 7) stopItem.group = "編排";
        return next;
      }
      return base;
    },
    [actions, node, onOpenDefer, row, today],
  );

  const stampTitle = row.skipped
    ? canStamp
      ? "本班運休中——點擊取消運休"
      : "過去的班次不能改"
    : paused
      ? "途中下車中——點擊解除恢復"
      : row.done
        ? row.isCurrent
          ? "取消「済」章"
          : "過去的班次不能改"
        : canStamp
          ? "蓋章完成（済）"
          : row.isRepeat && (row.ahead || row.isFuture)
            ? `這班要到 ${mmdd(row.entry.date)} 才能蓋——済只蓋目前班次`
            : HISTORY_MSG;

  const stampInner = (
    <>
      <span className="wk-seal-s" aria-hidden>
        済
      </span>
      {row.skipped && (
        <span className="wk-susp-slot" aria-hidden>
          <SealSuspended title="運休" />
        </span>
      )}
      {paused && !row.skipped && !row.done && (
        <span className="wk-susp-slot is-stopover" aria-hidden>
          <SealStopover title="途中下車" />
        </span>
      )}
    </>
  );

  return (
    <div
      className={cx(
        "wk-card",
        row.done && "is-done",
        row.skipped && "is-skipped",
        paused && "is-paused",
        row.late && !paused && "is-late",
        fresh && "is-fresh",
      )}
      style={{ "--wk-route-c": routeColor } as CssVars}
      data-drag-id={row.entry.node_id}
      onMouseDown={(e) => {
        if (!node || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
        armOpenOnClick(e, () => openNodeDetail(node.id));
      }}
      onContextMenu={
        node
          ? rowContextMenu(() => ({
              overline: { zh: "這張車票", latin: "Ticket" },
              label: `${name} 的動作`,
              items: buildMenu(moreBtnRef.current),
            }))
          : undefined
      }
    >
      {/* 原地検印欄 */}
      {canStamp ? (
        <button
          type="button"
          className="wk-card-stamp"
          aria-pressed={row.done}
          aria-label={row.skipped ? "取消本班運休" : paused ? "解除途中下車" : row.done ? "取消完成" : `蓋章完成：${name}`}
          title={stampTitle}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            onStamp();
          }}
          onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === " " || e.key === "Enter") e.stopPropagation();
          }}
        >
          {stampInner}
        </button>
      ) : (
        <span className="wk-card-stamp is-locked" role="img" aria-disabled title={stampTitle}>
          {stampInner}
        </span>
      )}

      {/* 主內容：上層脈絡・時刻/預估・票名・荷札 */}
      <div className="wk-card-main">
        {(time !== null || (effEst && effEst > 0) || row.isRepeat || node?.priority === "high") && (
          <div className="wk-card-meta">
            <PriorityMark priority={node?.priority} />
            {time !== null && (
              <span className={cx("wk-card-time", pastTime && "is-past")}>{time}</span>
            )}
            {effEst && effEst > 0 ? (
              <span className="wk-card-est">{formatDurationShort(effEst)}</span>
            ) : null}
            {row.isRepeat && (
              <span className="wk-card-rep" title="定期券" aria-label="定期券">
                ↻
              </span>
            )}
          </div>
        )}
        <NodeCrumb parentId={node?.parent_id} compact />
        <div className="wk-card-title" title={name}>
          {name}
        </div>
        {node && <EntityTagPills entityType="node" entityId={node.id} max={3} compact />}
      </div>

      {/* 常駐淡態 ⋯ 動作鈕（法則 05） */}
      {node && (
        <>
          <button
            ref={moreBtnRef}
            type="button"
            className="wk-card-more"
            aria-haspopup="menu"
            aria-expanded={menuItems !== null}
            aria-label={`「${name}」的更多動作`}
            title="更多動作（改期・途中下車・詳情）"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              setMenuItems((cur) => (cur ? null : buildMenu(moreBtnRef.current)));
            }}
          >
            <IconDots size={13} />
          </button>
          {menuItems && (
            <PopMenu
              anchor={moreBtnRef.current}
              overline={{ zh: "這張車票", latin: "Ticket" }}
              label={`「${name}」的更多動作`}
              items={menuItems}
              onClose={() => setMenuItems(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
 * 第 8 格「本週總覽專欄」：本週方針・本週期間自由券・本週小結
 * ═══════════════════════════════════════════════════════ */

function WeekSummaryCell({
  weekAimKey,
  flexTickets,
  routeById,
  stats,
  weekEstMin,
}: {
  weekAimKey: string;
  flexTickets: readonly NodeRow[];
  routeById: ReadonlyMap<string, NodeRow>;
  stats: { total: number; done: number; dues: number };
  weekEstMin: number;
}) {
  const aimView = useAimView(weekAimKey);
  const openWorkbench = () => useWeekAimStore.getState().openEditor(weekAimKey);
  const estLabel = formatEstHours(weekEstMin);

  const toggleFlexComplete = (node: NodeRow) => {
    if (node.status === "paused") {
      void toggleStopoverFlow(node.id);
      return;
    }
    const next = node.status !== "done";
    void useNodeStore.getState().setCompleted(node.id, next);
    const ui = useUiStore.getState();
    if (next && (isTaskKind(node.kind) || node.kind === "ticket")) ui.setCompleteCardFor(node.id);
    else if (!next && ui.completeCardFor === node.id) ui.setCompleteCardFor(null);
  };

  return (
    <aside className="wk-summary" aria-label="本週總覽專欄">
      <header className="wk-sum-head">
        <span className="wk-sum-title">本週總覽</span>
        <span className="wk-sum-latin">WEEKLY</span>
        <button
          type="button"
          className="ns-btn btn-text ns-btn--sm wk-sum-planbtn"
          title="展開本週行路企劃書（年・月・週三欄對照工作台）"
          onClick={openWorkbench}
        >
          企劃書 ›
        </button>
      </header>

      <div className="wk-summary-body">
        {/* 1. 本週方針 */}
        <section className="wk-sum-sec wk-sum-aims" aria-label="本週方針">
          <div className="wk-sum-sechead">
            <h4>本週方針</h4>
            {aimView.count.total > 0 && (
              <span className="wk-sum-count">
                済 <b>{aimView.count.done}</b>/{aimView.count.total}
              </span>
            )}
            <button
              type="button"
              className="wk-sum-act"
              onClick={openWorkbench}
              title="編輯本週方針"
            >
              {aimView.aims.length > 0 ? "改方針" : "＋ 寫方針"}
            </button>
          </div>
          {aimView.aims.length === 0 ? (
            <p className="wk-sum-empty">還沒寫本週的方針</p>
          ) : (
            <ol className="wk-aim-list">
              {aimView.aims.map((aim, idx) => {
                const place = aimView.placeOf(aim.node_id);
                return (
                  <li key={aim.id} className={cx("wk-aim-row", aim.done_at !== null && "is-done")}>
                    <span className="wk-aim-num" aria-hidden>
                      {aimNumeral(idx)}
                    </span>
                    <div className="wk-aim-main">
                      <span className="wk-aim-text" title={aim.text}>
                        {aim.text}
                      </span>
                      {place && <RouteTag place={place} shell="desktop" />}
                    </div>
                    <AimStamp aim={aim} />
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* 2. 本週期間自由券 */}
        <section className="wk-sum-sec wk-sum-flex" aria-label="本週期間自由券">
          <div className="wk-sum-sechead">
            <h4>期間自由券</h4>
            {flexTickets.length > 0 && <span className="wk-sum-count">{flexTickets.length} 張</span>}
          </div>
          {flexTickets.length === 0 ? (
            <p className="wk-sum-empty">本週無期間自由券</p>
          ) : (
            <ul className="wk-flex-list">
              {flexTickets.map((node) => {
                const route = node.route_id ? routeById.get(node.route_id) : undefined;
                const done = node.status === "done";
                const paused = node.status === "paused";
                const badge = node.scheduled_on
                  ? formatDateRangeBadge(node.scheduled_on, node.scheduled_end)
                  : "";
                return (
                  <li
                    key={node.id}
                    className={cx("wk-flex-row", done && "is-done", paused && "is-paused")}
                  >
                    <button
                      type="button"
                      className="wk-flex-stamp"
                      aria-pressed={done}
                      aria-label={paused ? `解除途中下車：${node.name}` : done ? `取消完成：${node.name}` : `蓋章完成：${node.name}`}
                      title={paused ? "途中下車中——點擊解除" : done ? "取消「済」章" : "一鍵蓋「済」"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFlexComplete(node);
                      }}
                    >
                      {done ? <span className="wk-flex-seal">済</span> : paused ? <span className="wk-flex-pause">休</span> : null}
                    </button>
                    <i
                      className="wk-flex-dot"
                      style={{ background: route?.color ?? "var(--route-none)" }}
                      aria-hidden
                    />
                    <button
                      type="button"
                      className="wk-flex-name"
                      title={`${node.name}（期間自由券 ${badge}）`}
                      onClick={() => openNodeDetail(node.id)}
                    >
                      {node.name}
                    </button>
                    {badge && <span className="wk-flex-badge">{badge}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 3. 本週小結 */}
        <section className="wk-sum-sec wk-sum-stats" aria-label="本週小結">
          <div className="wk-sum-sechead">
            <h4>本週小結</h4>
          </div>
          <div className="wk-stat-grid">
            <div className="wk-stat-item">
              <span className="wk-stat-k">班次</span>
              <span className="wk-stat-v">
                <b>{stats.done}</b>/{stats.total}
              </span>
            </div>
            <div className="wk-stat-item">
              <span className="wk-stat-k">預估</span>
              <span className="wk-stat-v">{estLabel || "—"}</span>
            </div>
            <div className={cx("wk-stat-item", stats.dues > 0 && "is-due")}>
              <span className="wk-stat-k">締切</span>
              <span className="wk-stat-v">{stats.dues} 件</span>
            </div>
          </div>
          <button
            type="button"
            className="ns-btn btn-ghost ns-btn--sm wk-sum-openbook"
            onClick={openWorkbench}
          >
            本週行路企劃書 ›
          </button>
        </section>
      </div>
    </aside>
  );
}
