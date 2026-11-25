/**
 * SelectionBar——桌機多選的選取列（回饋乙 D-主-152；第二梯操作 9 完全體 D-FB-4）。
 *
 * 選了 ≥1 張就在內容區（App 的 <main>）底部浮出一條 `.techo-card`：
 *   第一層精練排列：
 *     「已選 N 張」［全選］｜［狀態・印記 ▾］［乘車日］［締切］［時間・長度］［移動到…］［車站（同路線有車站即顯示）］［更多 ▾］｜［× 取消］
 *   更多 ▾ 收納：優先級 ▾（高中低）、荷札…、定期規則…、本班運休、取消運休、刪除 N 張（赭）。
 *
 * 規範：一個區域一顆主鈕（法則 03）——選取列本身全是次鈕／文字鈕；材質＝浮（§1.5）；
 *   小卡＝錨定浮層（§2.4：乘車日／締切用 DatePicker、狀態／車站／更多用 PopMenu、時間・長度／定期規則／荷札用錨定小卡、移動到…用 AttachPicker）。
 * 動作一律呼叫 store/batchActions（一批寫完、一則 toast、一次復原）；做不到的停用並說原因（title）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { REPEATABLE_KINDS, nodeRepo } from "../../../data";
import { WEEKDAY_LABEL, WEEKDAY_ORDER, describeRule, parseRule, type NodeRow, type Priority } from "../../../domain";
import { applyDurationMin, applyEndClock, applyStartClock, deriveClockSpan } from "../../../domain/clockSpan";
import { dedupeSubtreeRoots, moveTargetRule } from "../../../domain/moveTo";
import { todayKey } from "../../../lib/date";
import {
  batchAttachTag,
  batchDelete,
  batchDetachTag,
  batchMoveTo,
  batchSetDate,
  batchSetDue,
  batchSetPriority,
  batchSetRepeat,
  batchSetStation,
  batchSetStatusAndSeal,
  batchSetTimeSpan,
  batchSkip,
} from "../../../store/batchActions";
import { useNodeStore } from "../../../store/nodeStore";
import { useSelectionStore, type SelectionScope, visibleIn } from "../../../store/selectionStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { routeStations } from "../../board/useRouteBoard";
import { usePopDismiss } from "../../notes/notesBits";
import type { AttachKind } from "../../notes/useAttachOptions";
import { clockBounds, clockSeed, clockToMs, msToClock } from "../../panel/clockValue";
import { NumberField } from "../../panel/fields";
import {
  ACTIVE_MODE_OPTIONS,
  COUNT_MAX,
  END_OPTIONS,
  FREQ_OPTIONS,
  INTERVAL_UNIT,
  LAST_WEEKDAY_WHY,
  buildRule,
  draftOf,
  intervalMax,
  pickEnd,
  pickFreq,
  switchMode,
  toggleWeekday,
  type RepeatDraft,
} from "../../panel/panelRules";
import { capsOfHotkey } from "../../shell/hotkeys";
import { AttachPicker } from "../AttachPicker";
import { ClockInput } from "../ClockInput";
import { DateChip } from "../DateChip";
import { dueQuickSet, scheduledQuickSet } from "../datePickRules";
import { DatePicker } from "../DatePicker";
import { DurationPicker } from "../DurationPicker";
import { OverlineText } from "../PageHeader";
import { PopMenu, type PopMenuItem } from "../PopMenu";
import { Segmented } from "../Segmented";
import { AnchoredLayer } from "../quickadd/QuickAddPickers";
import "../../notes/notes.css";
import "../moveTo.css";
import "./selection.css";

export interface SelectionBarProps {
  scope: SelectionScope;
  /** 這一頁的節點（選到的 id → 節點）；查不到的不算 */
  lookup(id: string): NodeRow | undefined;
}

type Pop = "status" | "date" | "due" | "time" | "move" | "station" | "more" | "tag" | "repeat" | null;

const PRIORITY: { value: Priority; label: string }[] = [
  { value: "high", label: "高" },
  { value: "mid", label: "中" },
  { value: "low", label: "低" },
];

const STATION_KINDS = new Set<NodeRow["kind"]>(["branch", "train", "car", "ticket"]);

/** 移動到…：選到的種類能不能放進同一種父節點（先做祖先去重，子車票跟著母列車整棵走） */
function moveRuleOf(nodes: NodeRow[]): { rule: ReturnType<typeof moveTargetRule>; why: string | null } {
  const rules = nodes.map((n) => moveTargetRule(n.kind));
  if (!nodes.length) return { rule: null, why: "沒有選到可以搬的項目" };
  if (rules.some((r) => r === null)) return { rule: null, why: "選到的項目裡有不能搬的種類" };
  const first = rules[0]!;
  if (rules.some((r) => r!.label !== first.label)) return { rule: null, why: "選到的種類不同（車票、車廂要放進列車；列車、支線要放進路線），放不進同一個地方" };
  return { rule: first, why: null };
}

/** 只要選中項目同屬一條有車站的路線，跨大綱／今日／看板／篩選／行程表一律啟用「車站」批量指派 */
function stationRouteOf(nodes: readonly NodeRow[], stations: readonly NodeRow[]): string | null {
  if (!nodes.length) return null;
  const rid = nodes[0].route_id;
  if (!rid) return null;
  if (!nodes.every((n) => n.route_id === rid && STATION_KINDS.has(n.kind))) return null;
  return stations.some((st) => st.parent_id === rid && st.deleted_at === null) ? rid : null;
}

function batchStationMenuItems(ids: readonly string[], nodes: readonly NodeRow[], routeId: string): PopMenuItem[] {
  const list = routeStations(useNodeStore.getState().stations, routeId);
  const sharedStation =
    nodes.length > 0 && nodes.every((n) => n.station_id === nodes[0].station_id) ? nodes[0].station_id : undefined;
  return [
    {
      key: "st:none",
      label: "還沒排站（清除車站）",
      caps: sharedStation === null ? "✓" : undefined,
      onSelect: () => void batchSetStation(ids, null),
    },
    ...list.map(
      (s): PopMenuItem => ({
        key: `st:${s.id}`,
        label: s.name,
        caps: sharedStation === s.id ? "✓" : undefined,
        onSelect: () => void batchSetStation(ids, s.id),
      }),
    ),
  ];
}

const SELECT_ALL_HOTKEY: Record<SelectionScope, string> = {
  today: "today.select.all",
  outline: "outline.select.all",
  schedule: "daylist.select.all",
  board: "board.select.all",
};

export function SelectionBar({ scope, lookup }: SelectionBarProps) {
  const ids = useSelectionStore((s) => (s.scope === scope ? s.ids : null));
  const clear = useSelectionStore((s) => s.clear);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const weekStart = useUiStore((s) => s.weekStart);
  const treeVer = useNodeStore((s) => s.tree);
  const todayVer = useNodeStore((s) => s.today);
  const stations = useNodeStore((s) => s.stations);
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const tagIndex = useTagStore((s) => s.index);
  const [pop, setPop] = useState<Pop>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const btns = useRef<Partial<Record<Exclude<Pop, null>, HTMLButtonElement | null>>>({});

  useLayoutEffect(() => {
    setHost(probe.current?.closest("main") ?? document.body);
  }, []);

  const count = ids?.length ?? 0;
  const open = count > 0;
  useEffect(() => {
    if (!open) {
      setPop(null);
      return;
    }
    document.documentElement.setAttribute("data-selbar", "desktop");
    return () => document.documentElement.removeAttribute("data-selbar");
  }, [open]);

  useEffect(() => () => useSelectionStore.getState().clear(), []);

  const nodes = useMemo(
    () => (ids ?? []).map((id) => lookup(id)).filter((n): n is NodeRow => !!n),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, lookup, treeVer, todayVer],
  );
  const [extraById, setExtraById] = useState<Record<string, NodeRow>>({});
  const selRouteKey = useMemo(() => {
    const rids = new Set<string>();
    const activeRouteId = useNodeStore.getState().routeId;
    for (const n of nodes) if (n.route_id && n.route_id !== activeRouteId) rids.add(n.route_id);
    return [...rids].sort().join(",");
  }, [nodes]);
  useEffect(() => {
    if (!selRouteKey) {
      setExtraById({});
      return;
    }
    let alive = true;
    void Promise.all(selRouteKey.split(",").map((rid) => nodeRepo.listRouteTree(rid)))
      .then((lists) => {
        if (!alive) return;
        const map: Record<string, NodeRow> = {};
        for (const list of lists) for (const r of list) map[r.id] = r;
        setExtraById(map);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selRouteKey, treeVer]);

  const moveRootIds = useMemo(() => {
    if (!ids?.length) return [];
    const s = useNodeStore.getState();
    return dedupeSubtreeRoots(ids, (id) => (lookup(id) ?? s.tree.byId[id] ?? s.today.byId[id] ?? s.calendar.nodes[id] ?? extraById[id])?.parent_id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, lookup, treeVer, todayVer, extraById]);
  const moveRootSet = useMemo(() => new Set(moveRootIds), [moveRootIds]);
  const moveRootNodes = useMemo(
    () => moveRootIds.map((id) => lookup(id) ?? useNodeStore.getState().tree.byId[id] ?? extraById[id]).filter((n): n is NodeRow => !!n),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [moveRootIds, lookup, treeVer, extraById],
  );

  const teikiNodes = useMemo(() => nodes.filter((n) => parseRule(n.repeat_rule) !== null), [nodes]);
  const teikiCount = teikiNodes.length;
  const skippedTeikiCount = useMemo(
    () => teikiNodes.filter((n) => currentOccurrences[n.id]?.status === "skipped").length,
    [teikiNodes, currentOccurrences],
  );
  const unskippedTeikiCount = teikiCount - skippedTeikiCount;
  const repeatableCount = useMemo(() => nodes.filter((n) => REPEATABLE_KINDS.includes(n.kind)).length, [nodes]);
  const anyDone = useMemo(
    () => nodes.some((n) => (parseRule(n.repeat_rule) ? currentOccurrences[n.id]?.status === "done" : n.status === "done")),
    [nodes, currentOccurrences],
  );
  const anyPaused = useMemo(() => nodes.some((n) => n.status === "paused"), [nodes]);
  const anyHasScheduled = useMemo(() => nodes.some((n) => !!n.scheduled_on), [nodes]);
  const anyHasDue = useMemo(() => nodes.some((n) => !!n.due_on), [nodes]);
  const move = moveRuleOf(moveRootNodes);
  const datable = nodes.filter((n) => !parseRule(n.repeat_rule)).length;
  const schedulableCount = nodes.filter((n) => n.kind !== "branch").length;
  const stationRoute = useMemo(() => stationRouteOf(nodes, stations), [nodes, stations]);

  if (!open) return <span ref={probe} hidden />;

  const sel = ids!;
  const toggle = (p: Exclude<Pop, null>) => setPop((cur) => (cur === p ? null : p));
  const closePop = () => setPop(null);
  const today = todayKey(dayStartHour);
  const sameDay = nodes.length && nodes.every((n) => n.scheduled_on === nodes[0].scheduled_on) ? nodes[0].scheduled_on : null;
  const sameDue = nodes.length && nodes.every((n) => n.due_on === nodes[0].due_on) ? nodes[0].due_on : null;

  const visible = visibleIn(scope);
  const bar = (
    <div className="ns-selbar techo-card" role="toolbar" aria-label="選取列" onKeyDown={(e) => onBarKey(e, closePop, clear, pop)}>
      <span className="cnt" aria-live="polite">
        已選 <b>{count}</b> 張
      </span>
      {visible.length > count && (
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-text"
          title={`全選這一頁（${capsOfHotkey(SELECT_ALL_HOTKEY[scope])}）`}
          onClick={() => useSelectionStore.getState().set(scope, visibleIn(scope))}
        >
          全選
        </button>
      )}
      <span className="sep" aria-hidden />

      <button
        type="button"
        ref={(el) => void (btns.current.status = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="menu"
        aria-expanded={pop === "status"}
        data-pop-toggle
        disabled={schedulableCount === 0}
        title={schedulableCount === 0 ? "支線沒有推進狀態與済章" : "改推進狀態或蓋／取消済章、途中下車"}
        onClick={() => toggle("status")}
      >
        狀態・印記 ▾
      </button>

      <button
        type="button"
        ref={(el) => void (btns.current.date = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "date"}
        data-pop-toggle
        disabled={datable === 0 || schedulableCount === 0}
        title={datable === 0 ? "定期券的乘車日照規則排，不能直接改" : "批量設定或清除乘車日"}
        onClick={() => toggle("date")}
      >
        乘車日
      </button>

      <button
        type="button"
        ref={(el) => void (btns.current.due = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "due"}
        data-pop-toggle
        disabled={schedulableCount === 0}
        title="批量設定締切日、設為同乘車日或清除"
        onClick={() => toggle("due")}
      >
        締切
      </button>

      <button
        type="button"
        ref={(el) => void (btns.current.time = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "time"}
        data-pop-toggle
        disabled={schedulableCount === 0}
        title="批量設定開始／結束時刻與預計時長"
        onClick={() => toggle("time")}
      >
        時間・長度
      </button>

      <button
        type="button"
        ref={(el) => void (btns.current.move = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "move"}
        data-pop-toggle
        disabled={!move.rule}
        title={move.why ?? "搬到別的路線、支線、列車或車票下"}
        onClick={() => toggle("move")}
      >
        移動到…
      </button>

      {stationRoute && (
        <button
          type="button"
          ref={(el) => void (btns.current.station = el)}
          className="ns-btn ns-btn--sm btn-ghost"
          aria-haspopup="menu"
          aria-expanded={pop === "station"}
          data-pop-toggle
          title="把選中的項目指派到同一車站"
          onClick={() => toggle("station")}
        >
          車站
        </button>
      )}

      <button
        type="button"
        ref={(el) => void (btns.current.more = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="menu"
        aria-expanded={pop === "more"}
        data-pop-toggle
        title="優先級、荷札、定期規則、本班運休／取消運休、刪除"
        onClick={() => toggle("more")}
      >
        更多 ▾
      </button>

      <span className="sep" aria-hidden />
      <button type="button" className="ns-btn ns-btn--sm btn-text x" title="取消選取（Esc）" onClick={clear}>
        × 取消
      </button>

      {pop === "status" && (
        <PopMenu
          anchor={btns.current.status ?? null}
          overline={{ zh: `已選 ${count} 張`, latin: "Status & Seal" }}
          label={`${count} 張的狀態與印記`}
          items={[
            { key: "done", label: "蓋済", onSelect: () => void batchSetStatusAndSeal(sel, "done") },
            {
              key: "uncomplete",
              label: "取消蓋済",
              disabled: !anyDone,
              why: "選到的項目尚未蓋済",
              onSelect: () => void batchSetStatusAndSeal(sel, "uncomplete"),
            },
            { key: "todo", label: "未開始", cut: true, onSelect: () => void batchSetStatusAndSeal(sel, "todo") },
            { key: "doing", label: "進行中", onSelect: () => void batchSetStatusAndSeal(sel, "doing") },
            { key: "paused", label: "途中下車", onSelect: () => void batchSetStatusAndSeal(sel, "paused") },
            {
              key: "unpause",
              label: "解除途中下車",
              disabled: !anyPaused,
              why: "選到的項目沒有途中下車",
              onSelect: () => void batchSetStatusAndSeal(sel, "unpause"),
            },
          ]}
          onClose={closePop}
        />
      )}

      {pop === "date" && (
        <DatePicker
          label={`改 ${datable} 張的乘車日`}
          anchor={btns.current.date ?? null}
          value={sameDay}
          markValue
          quick={scheduledQuickSet(today, weekStart)}
          today={today}
          onPick={(d) => {
            closePop();
            void batchSetDate(sel, d);
          }}
          onClear={() => {
            closePop();
            void batchSetDate(sel, null);
          }}
          clearLabel="清除乘車日"
          onClose={closePop}
        />
      )}

      {pop === "due" && (
        <DatePicker
          label={`改 ${count} 張的締切日`}
          anchor={btns.current.due ?? null}
          value={sameDue}
          markValue
          quick={dueQuickSet(today, { dynamicSync: anyHasScheduled, weekStart })}
          today={today}
          onPick={(d) => {
            closePop();
            if (d === "") void batchSetDue(sel, "sync");
            else void batchSetDue(sel, d);
          }}
          onClear={
            anyHasDue
              ? () => {
                  closePop();
                  void batchSetDue(sel, null);
                }
              : undefined
          }
          clearLabel="清除締切日"
          onClose={closePop}
        />
      )}

      {pop === "time" && btns.current.time && (
        <AnchoredLayer anchor={btns.current.time} onClose={closePop}>
          <BatchTimePop ids={sel} nodes={nodes} today={today} dayStartHour={dayStartHour} onClose={closePop} />
        </AnchoredLayer>
      )}

      {pop === "station" && stationRoute && (
        <PopMenu
          anchor={btns.current.station ?? null}
          overline={{ zh: `已選 ${count} 張`, latin: "Station" }}
          label={`把 ${count} 張指派到哪一站`}
          items={batchStationMenuItems(sel, nodes, stationRoute)}
          onClose={closePop}
        />
      )}

      {pop === "more" && (
        <PopMenu
          anchor={btns.current.more ?? null}
          overline={{ zh: `已選 ${count} 張`, latin: "More" }}
          label={`${count} 張的其他動作`}
          items={[
            ...PRIORITY.map((p) => ({
              key: `prio-${p.value}`,
              label: p.label,
              group: "優先級",
              onSelect: () => void batchSetPriority(sel, p.value),
            })),
            { key: "tag", label: "荷札…", onSelect: () => setPop("tag") },
            {
              key: "repeat",
              label: "定期規則…",
              disabled: repeatableCount === 0,
              why: "選到的種類不能設定期規則",
              onSelect: () => setPop("repeat"),
            },
            {
              key: "skip",
              label: "本班運休",
              cut: true,
              disabled: unskippedTeikiCount === 0,
              why: teikiCount === 0 ? "運休只給定期券——選到的都不是" : "選到的定期券本班皆已運休",
              onSelect: () => void batchSkip(sel, true),
            },
            {
              key: "unskip",
              label: "取消運休",
              disabled: skippedTeikiCount === 0,
              why: teikiCount === 0 ? "只有定期券能取消運休" : "選到的定期券目前沒有運休",
              onSelect: () => void batchSkip(sel, false),
            },
            { key: "delete", label: `刪除 ${count} 張`, cut: true, danger: true, onSelect: () => batchDelete(sel) },
          ]}
          onClose={closePop}
        />
      )}

      {pop === "tag" && <TagPop ids={sel} onClose={closePop} hasIndex={!!tagIndex} />}

      {pop === "repeat" && btns.current.more && (
        <AnchoredLayer anchor={btns.current.more} onClose={closePop}>
          <BatchRepeatPop ids={sel} nodes={nodes} teikiCount={teikiCount} today={today} onClose={closePop} />
        </AnchoredLayer>
      )}

      {pop === "move" && move.rule && (
        <div className="ns-moveto ns-selbar-pop is-move">
          <AttachPicker
            depth={move.rule.depth}
            kinds={move.rule.depth === "node" ? (move.rule.kinds as AttachKind[]) : undefined}
            routeSelectable={move.rule.routeSelectable}
            value={{ routeId: (moveRootNodes[0] ?? nodes[0])?.route_id ?? null, nodeId: null, nodeKind: null }}
            label={`${move.rule.label}（${moveRootIds.length} 項）`}
            float
            excludeId={moveRootIds.length === 1 ? moveRootIds[0] : undefined}
            {...({ excludeIds: moveRootSet } as Record<string, unknown>)}
            onPick={(t) => {
              closePop();
              const parentId = t.nodeId ?? t.routeId;
              if (!parentId) return;
              void (async () => {
                const p = await nodeRepo.getNode(parentId);
                await batchMoveTo(moveRootIds, parentId, p?.name);
              })();
            }}
            onClose={closePop}
          />
        </div>
      )}
    </div>
  );

  return (
    <>
      <span ref={probe} hidden />
      {host && createPortal(<div className="ns-selbar-dock">{bar}</div>, host)}
    </>
  );
}

/** 選取列上的 Esc：有小卡先收小卡；沒有就取消選取 */
function onBarKey(e: KeyboardEvent, closePop: () => void, clear: () => void, pop: Pop) {
  if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  e.stopPropagation();
  if (pop) closePop();
  else clear();
}

const DIAL_EDGE_OPTS = [
  { value: "start" as const, label: "撥開始" },
  { value: "end" as const, label: "撥結束" },
];

/** 批量設定「時間・長度」小卡：開始時刻 ⇄ 結束時刻 ⇄ 持續時長 雙向互推 */
function BatchTimePop({
  ids,
  nodes,
  today,
  dayStartHour,
  onClose,
}: {
  ids: readonly string[];
  nodes: readonly NodeRow[];
  today: string;
  dayStartHour: number;
  onClose(): void;
}) {
  const sharedDay = nodes.length && nodes.every((n) => n.scheduled_on === nodes[0].scheduled_on) ? nodes[0].scheduled_on : null;
  const refDay = sharedDay ?? today;
  const sharedStart = nodes.length && nodes.every((n) => n.scheduled_time === nodes[0].scheduled_time) ? nodes[0].scheduled_time : null;
  const sharedLen = nodes.length && nodes.every((n) => n.estimate_min === nodes[0].estimate_min) ? nodes[0].estimate_min : null;

  const { lo, hi } = useMemo(() => clockBounds(refDay, dayStartHour), [refDay, dayStartHour]);
  const [seed] = useState(() => clockSeed(refDay, today, dayStartHour));
  const [startHm, setStartHm] = useState<string | null>(sharedStart);
  const [len, setLen] = useState<number | null>(sharedLen);
  const [touchedStart, setTouchedStart] = useState(false);
  const [touchedLen, setTouchedLen] = useState(false);
  const [activeDial, setActiveDial] = useState<"start" | "end">("start");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const span = useMemo(() => deriveClockSpan(startHm, len), [startHm, len]);
  const startShownMs = (span.startHm ? clockToMs(span.startHm, refDay) : null) ?? seed;
  const effectiveStartHm = span.startHm ?? msToClock(startShownMs, refDay) ?? "09:00";
  const startMsForEnd = clockToMs(effectiveStartHm, refDay) ?? lo;
  const endCurrentMs = span.endHm ? clockToMs(span.endHm, refDay) : null;
  const endLo = startMsForEnd + 60_000;
  const endHi = Math.max(hi, startMsForEnd + 12 * 3_600_000, endCurrentMs ?? 0);
  const endShownMs = endCurrentMs ?? Math.min(startMsForEnd + (span.durationMin ?? 60) * 60_000, endHi);

  const onStartChange = (ms: number) => {
    const t = msToClock(ms, refDay);
    if (!t) return;
    const res = applyStartClock({ startHm: span.startHm, durationMin: span.durationMin }, t, dayStartHour);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    setErrMsg(null);
    setTouchedStart(true);
    setStartHm(res.startHm);
    setLen(res.durationMin);
  };

  const onEndChange = (ms: number) => {
    const t = msToClock(ms, refDay);
    if (!t) return;
    const res = applyEndClock({ startHm: effectiveStartHm, durationMin: span.durationMin }, t, dayStartHour);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    setErrMsg(null);
    setTouchedStart(true);
    setTouchedLen(true);
    setStartHm(res.startHm);
    setLen(res.durationMin);
  };

  const onLenChange = (nextMin: number | null) => {
    const res = applyDurationMin({ startHm: span.startHm, durationMin: span.durationMin }, nextMin);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    setErrMsg(null);
    setTouchedLen(true);
    setStartHm(res.startHm);
    setLen(res.durationMin);
  };

  const apply = () => {
    onClose();
    if (!touchedStart && !touchedLen) {
      const seeded = msToClock(startShownMs, refDay);
      void batchSetTimeSpan(ids, { scheduledTime: seeded });
      return;
    }
    void batchSetTimeSpan(ids, {
      ...(touchedStart ? { scheduledTime: span.startHm } : {}),
      ...(touchedLen ? { estimateMin: span.durationMin } : {}),
    });
  };

  return (
    <div className="ns-qa-card is-time techo-card" role="dialog" aria-label={`改 ${ids.length} 張的時間與長度`}>
      <div className="ns-qa-timehead">
        <span className="ns-qa-cardlabel">時間・長度（{ids.length} 張）</span>
        <Segmented<"start" | "end">
          compact
          options={DIAL_EDGE_OPTS}
          value={activeDial}
          onChange={setActiveDial}
          aria-label="站鐘錶盤對象"
        />
      </div>

      <div className="ns-qa-spanbox">
        <div className="ns-qa-spanrow" onFocusCapture={() => setActiveDial("start")}>
          <div className="ns-qa-spanlbl">
            <span>開始時刻</span>
            {span.startHm && (
              <button
                type="button"
                className="ns-qa-clearlink"
                onClick={() => {
                  setErrMsg(null);
                  setTouchedStart(true);
                  setStartHm(null);
                }}
              >
                不排時刻
              </button>
            )}
          </div>
          <ClockInput
            variant="compact"
            picker={activeDial === "start" ? "inline" : false}
            value={startShownMs}
            lo={lo}
            hi={hi}
            refDay={refDay}
            label="開始時刻"
            dateLabel="other"
            autoFocus
            onChange={onStartChange}
            onEnter={apply}
          />
        </div>

        <div className="ns-qa-spanrow" onFocusCapture={() => setActiveDial("end")}>
          <div className="ns-qa-spanlbl">
            <span>結束時刻</span>
            <span className="ns-qa-spansub">{span.endHm ? "改結束自動反推時長" : "點選或輸入即反推時長"}</span>
          </div>
          <ClockInput
            variant="compact"
            picker={activeDial === "end" ? "inline" : false}
            value={endShownMs}
            lo={endLo}
            hi={endHi}
            refDay={refDay}
            label="結束時刻"
            dateLabel="other"
            onChange={onEndChange}
            onEnter={() => {
              if (!touchedLen && span.durationMin === null) onEndChange(endShownMs);
              apply();
            }}
          />
        </div>
      </div>

      {errMsg && (
        <p className="ns-qa-timeerr" role="status">
          {errMsg}
        </p>
      )}

      <div className="ns-qa-cardlabel">持續時長</div>
      <DurationPicker compact liveCommit value={span.durationMin} onChange={onLenChange} onEnter={apply} ariaLabel="持續時長" />

      <div className="ns-qa-cardfoot">
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-text"
          onClick={() => {
            onClose();
            void batchSetTimeSpan(ids, { scheduledTime: null, estimateMin: null });
          }}
        >
          清除時間與長度
        </button>
        <button type="button" className="ns-btn ns-btn--sm btn-seal" onClick={apply}>
          套用
        </button>
      </div>
    </div>
  );
}

/** 批量設定「定期規則」小卡（可設定固定排程／完成後間隔，或一鍵改回乘車券） */
function BatchRepeatPop({
  ids,
  nodes,
  teikiCount,
  today,
  onClose,
}: {
  ids: readonly string[];
  nodes: readonly NodeRow[];
  teikiCount: number;
  today: string;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<RepeatDraft>(() => {
    const first = nodes.find((n) => parseRule(n.repeat_rule)) ?? nodes[0];
    const base = first ? draftOf(first, today) : draftOf({ repeat_rule: null, scheduled_on: today }, today);
    return base.mode === "none" ? switchMode(base, "fixed") : base;
  });
  const built = useMemo(() => buildRule(draft), [draft]);

  return (
    <div className="ns-selbar-repeat techo-card" role="dialog" aria-label={`改 ${ids.length} 張的定期規則`}>
      <p className="techo-overline">
        <OverlineText value={{ zh: `定期規則 · ${ids.length} 張`, latin: "Repeat Rule" }} />
      </p>
      <p className="ns-selbar-repeat-desc">{built ? describeRule(built) : "請補齊欄位後套用"}</p>

      <div className="ns-selbar-repeat-grid">
        <span className="lbl">模式</span>
        <Segmented
          compact
          options={ACTIVE_MODE_OPTIONS}
          value={draft.mode === "after" ? "after" : "fixed"}
          onChange={(v) => setDraft((d) => switchMode(d, v))}
          aria-label="重複方式"
        />

        {draft.mode === "fixed" && (
          <>
            <span className="lbl">頻率</span>
            <Segmented
              compact
              options={FREQ_OPTIONS}
              value={draft.freq}
              onChange={(v) => setDraft((d) => pickFreq(d, v))}
              aria-label="重複頻率"
            />

            <span className="lbl">間隔</span>
            <div className="inline-num">
              <span>每</span>
              <NumberField
                value={draft.interval}
                onCommit={(v) => setDraft((d) => ({ ...d, interval: v ?? 1 }))}
                ariaLabel={`每幾${INTERVAL_UNIT[draft.freq]}`}
                unit={INTERVAL_UNIT[draft.freq]}
                min={1}
                max={intervalMax(draft.freq)}
                placeholder="1"
              />
            </div>

            {draft.freq === "weekly" && (
              <>
                <span className="lbl">星期</span>
                <div className="ns-selbar-wk7" role="group" aria-label="星期">
                  {WEEKDAY_ORDER.map((wd) => {
                    const on = draft.byweekday.includes(wd);
                    return (
                      <button
                        key={wd}
                        type="button"
                        className={on ? "is-on" : ""}
                        aria-pressed={on}
                        onClick={() => {
                          setDraft((d) => {
                            const next = toggleWeekday(d.byweekday, wd);
                            if (next === d.byweekday) useUiStore.getState().showToast({ message: LAST_WEEKDAY_WHY }, 3200);
                            return { ...d, byweekday: next };
                          });
                        }}
                      >
                        {WEEKDAY_LABEL[wd]}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {draft.freq === "monthly" && (
              <>
                <span className="lbl">每月</span>
                <NumberField
                  value={draft.monthday}
                  onCommit={(v) => setDraft((d) => ({ ...d, monthday: v }))}
                  ariaLabel="每月幾日"
                  unit="日"
                  min={1}
                  max={31}
                  placeholder="1"
                />
              </>
            )}
          </>
        )}

        {draft.mode === "after" && (
          <>
            <span className="lbl">完成後</span>
            <NumberField
              value={draft.days}
              onCommit={(v) => setDraft((d) => ({ ...d, days: v }))}
              ariaLabel="完成後幾天"
              unit="天"
              min={1}
              placeholder="3"
            />
          </>
        )}

        <span className="lbl">起算日</span>
        <DateChip
          date={draft.start}
          onPick={(v) => setDraft((d) => ({ ...d, start: v ?? today }))}
          allowPast
          label="起算日"
        />

        <span className="lbl">結束</span>
        <Segmented
          compact
          options={END_OPTIONS}
          value={draft.endMode}
          onChange={(v) => setDraft((d) => pickEnd(d, v, today, 0))}
          aria-label="結束條件"
        />

        {draft.endMode === "until" && (
          <>
            <span className="lbl">結束日</span>
            <DateChip
              date={draft.until}
              min={draft.start}
              onPick={(v) => setDraft((d) => ({ ...d, until: v }))}
              label="結束日"
            />
          </>
        )}

        {draft.endMode === "count" && (
          <>
            <span className="lbl">次數</span>
            <NumberField
              value={draft.count}
              onCommit={(v) => setDraft((d) => ({ ...d, count: v }))}
              ariaLabel="做滿幾次"
              unit="次"
              min={1}
              max={COUNT_MAX}
              placeholder="10"
            />
          </>
        )}
      </div>

      <div className="ns-qa-cardfoot">
        {teikiCount > 0 && (
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-text"
            onClick={() => {
              onClose();
              void batchSetRepeat(ids, null);
            }}
          >
            改回乘車券
          </button>
        )}
        <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-seal"
          disabled={!built}
          onClick={() => {
            if (!built) return;
            onClose();
            void batchSetRepeat(ids, built);
          }}
        >
          套用定期規則
        </button>
      </div>
    </div>
  );
}

/** 荷札小卡：上面列出這批共同掛著的（點 × 摘下）；下面輸入名字（Enter 掛上，沒有就建），打字時給幾個現成的荷札 */
function TagPop({ ids, onClose, hasIndex }: { ids: readonly string[]; onClose: () => void; hasIndex: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  usePopDismiss(ref, onClose);
  useEffect(() => {
    void useTagStore.getState().loadIndex();
    input.current?.focus();
  }, []);
  const ts = useTagStore.getState();
  const common = hasIndex
    ? ids
        .map((id) => new Set(ts.keysOf("node", id)))
        .reduce<Set<string> | null>((acc, s) => (acc ? new Set([...acc].filter((k) => s.has(k))) : s), null) ?? new Set<string>()
    : new Set<string>();
  const sug = hasIndex && q.trim() ? ts.suggest(q, { limit: 5 }) : null;
  const attach = (name: string) => {
    if (!name.trim()) return;
    onClose();
    void batchAttachTag(ids, name.trim());
  };
  return (
    <div ref={ref} className="ns-selbar-pop is-tag techo-card" role="dialog" aria-label={`替 ${ids.length} 張掛荷札`}>
      <p className="techo-overline">
        <OverlineText value={{ zh: "荷札", latin: "Tags" }} />
      </p>
      {common.size > 0 && (
        <div className="row">
          {[...common].map((k) => (
            <button
              key={k}
              type="button"
              className="ns-selbar-tag"
              title={`從這 ${ids.length} 張摘下 #${ts.nameOf(k)}`}
              onClick={() => {
                onClose();
                void batchDetachTag(ids, k);
              }}
            >
              #{ts.nameOf(k)} <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={input}
        className="techo-input"
        type="text"
        placeholder="荷札名稱，Enter 掛上"
        aria-label="要掛上的荷札名稱"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            attach(q);
          }
        }}
      />
      {sug && (sug.items.length > 0 || sug.create) && (
        <div className="row">
          {sug.items.map((it) => (
            <button key={it.key} type="button" className="ns-selbar-tag" onClick={() => attach(it.name)}>
              #{it.name}
            </button>
          ))}
          {sug.create && (
            <button type="button" className="ns-selbar-tag is-add" onClick={() => attach(sug.create!.name)}>
              ＋ 建立 #{sug.create.name}
            </button>
          )}
        </div>
      )}
      <p className="hint">只列出這 {ids.length} 張共同掛著的荷札。</p>
    </div>
  );
}
