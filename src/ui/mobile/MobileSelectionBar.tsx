/**
 * MobileSelectionBar——手機的選取列（回饋乙 D-主-152；第二梯操作 9 完全體 D-FB-4）。
 * 今日、行程表、路線圖第二層與篩選／看板各掛一個（傳自己的 scope）；選了 ≥1 張才出現。
 *
 * 第一層精練排列（可橫向輕滑，左右兩端固定張數與取消）：
 *   「已選 N 張」｜［狀態・印記］［乘車日］［締切］［時間］［移動］［車站（同路線有車站即顯示）］［更多］｜［取消］
 * 「更多」收納：全選這一頁、優先級…、荷札…、定期規則…、本班運休、取消運休、刪除 N 張。
 *
 * 返回層：選取本身登記一層 "page"；子面板統一共用 `SHEET_LAYER`（`MobileAttachPicker` 自管；定期規則內的日期子面板另疊 `REPEAT_DATE_LAYER`）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { REPEATABLE_KINDS, nodeRepo } from "../../data";
import { WEEKDAY_LABEL, WEEKDAY_ORDER, describeRule, parseRule, type NodeRow, type Priority } from "../../domain";
import { applyDurationMin, applyEndClock, applyStartClock, deriveClockSpan } from "../../domain/clockSpan";
import { dedupeSubtreeRoots, moveTargetRule } from "../../domain/moveTo";
import { TAG_ENTITY_NODE_KINDS, keysOfEntity, suggest } from "../../domain/tags";
import { todayKey } from "../../lib/date";
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
} from "../../store/batchActions";
import { useNodeStore } from "../../store/nodeStore";
import { useSelectionStore, type SelectionScope, visibleIn } from "../../store/selectionStore";
import { useTagStore } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";
import { routeStations } from "../board/useRouteBoard";
import { ClockInput } from "../common/ClockInput";
import { dueQuickSet, scheduledQuickSet } from "../common/datePickRules";
import { DurationPicker } from "../common/DurationPicker";
import { MSheet, MSheetItem } from "../common/MSheet";
import { MobileAttachPicker } from "../common/MobileAttachPicker";
import { MobileDatePicker } from "../common/MobileDatePicker";
import { Segmented } from "../common/Segmented";
import type { AttachKind } from "../notes/useAttachOptions";
import { clockBounds, clockSeed, clockToMs, msToClock } from "../panel/clockValue";
import {
  ACTIVE_MODE_OPTIONS,
  COUNT_MAX,
  END_OPTIONS,
  FREQ_OPTIONS,
  INTERVAL_UNIT,
  LAST_WEEKDAY_WHY,
  PRIORITY_OPTIONS,
  buildRule,
  draftOf,
  intervalMax,
  mdwText,
  pickEnd,
  pickFreq,
  switchMode,
  toggleWeekday,
  type RepeatDraft,
} from "../panel/panelRules";
import { useBackLayer } from "./backStack";
import { useScopeSelection } from "./mobileSelect";
import "./mobile-polish.css";
import "./routemap/ticket-sheet.css";
import "../common/moveTo.css";
import "../common/quickadd/quickadd.css";
import "../common/selection/selection.css";

const SHEET_LAYER = "core.selectionSheet";
const REPEAT_DATE_LAYER = "core.selectionRepeatDate";

type Sheet = "status" | "date" | "due" | "time" | "move" | "station" | "more" | "priority" | "tags" | "repeat" | null;

const STATION_KINDS = new Set<NodeRow["kind"]>(["branch", "train", "car", "ticket"]);

/** 選到的那幾張的節點：路線樹＞今日切片＞行程表切片 */
function nodeOf(id: string): NodeRow | undefined {
  const s = useNodeStore.getState();
  return s.tree.byId[id] ?? s.today.byId[id] ?? s.calendar.nodes[id];
}

function stationRouteOf(nodes: readonly NodeRow[], stations: readonly NodeRow[]): string | null {
  if (!nodes.length) return null;
  const rid = nodes[0].route_id;
  if (!rid) return null;
  if (!nodes.every((n) => n.route_id === rid && STATION_KINDS.has(n.kind))) return null;
  return stations.some((st) => st.parent_id === rid && st.deleted_at === null) ? rid : null;
}

const toast = (message: string) => useUiStore.getState().showToast({ message }, 3600);

/* ── 圖示（1.3px 細線，同 tab bar 筆觸） ── */
function IconCal() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.4" y="3.4" width="11.2" height="10" rx="1" />
      <path d="M2.4 6.6h11.2M5.4 2v2.6M10.6 2v2.6" />
    </svg>
  );
}
function IconDue() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.2 2.5v11" />
      <path d="M3.2 3.2h7.6l-1.8 2.6 1.8 2.6H3.2" />
    </svg>
  );
}
function IconClockMini() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.8V8l2.3 1.5" />
    </svg>
  );
}
function IconMove() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 5.5V3.4c0-.5.4-.9.9-.9h3l1.4 1.6h4.8c.5 0 .9.4.9.9v1.5" />
      <path d="M2.5 7.5v5.1c0 .5.4.9.9.9h9.2c.5 0 .9-.4.9-.9V8.4" />
      <path d="M6 10.4h4.6M9 8.8l1.6 1.6L9 12" />
    </svg>
  );
}
function IconStation() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="4.8" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
    </svg>
  );
}
function IconDots() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden>
      <g fill="currentColor">
        <circle cx="3.2" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="12.8" cy="8" r="1.3" />
      </g>
    </svg>
  );
}

export function MobileSelectionBar({ scope, lookup = nodeOf }: { scope: SelectionScope; lookup?: (id: string) => NodeRow | undefined }) {
  const ids = useScopeSelection(scope);
  const [sheet, setSheet] = useState<Sheet>(null);
  const close = () => setSheet(null);
  const active = ids.length > 0;
  useBackLayer(`core.selection.${scope}`, active, () => useSelectionStore.getState().clear(), "page");
  useBackLayer(SHEET_LAYER, active && sheet !== null && sheet !== "move", close);

  useEffect(() => {
    if (!active) setSheet(null);
  }, [active]);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const weekStart = useUiStore((s) => s.weekStart);

  const treeVer = useNodeStore((s) => s.tree);
  const todayVer = useNodeStore((s) => s.today);
  const stations = useNodeStore((s) => s.stations);
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const picks = useMemo(() => ids.map(lookup).filter((n): n is NodeRow => !!n), [ids, lookup, treeVer, todayVer]);
  const [extraById, setExtraById] = useState<Record<string, NodeRow>>({});
  const selRouteKey = useMemo(() => {
    const rids = new Set<string>();
    const activeRouteId = useNodeStore.getState().routeId;
    for (const n of picks) if (n.route_id && n.route_id !== activeRouteId) rids.add(n.route_id);
    return [...rids].sort().join(",");
  }, [picks]);
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
    if (!active) return [];
    const s = useNodeStore.getState();
    return dedupeSubtreeRoots(ids, (id) => (lookup(id) ?? s.tree.byId[id] ?? s.today.byId[id] ?? s.calendar.nodes[id] ?? extraById[id])?.parent_id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ids, lookup, treeVer, todayVer, extraById]);
  const moveRootSet = useMemo(() => new Set(moveRootIds), [moveRootIds]);

  const move = useMemo(() => {
    if (!active) return null;
    const rules = moveRootIds.map((id) => {
      const n = lookup(id) ?? nodeOf(id) ?? extraById[id];
      return n ? moveTargetRule(n.kind) : null;
    });
    if (!rules.length) return { why: "沒有選到可以搬的項目", rule: null };
    if (rules.some((r) => r === null)) return { why: "選到的項目裡有不能移動的", rule: null };
    if (new Set(rules.map((r) => r!.label)).size > 1) return { why: "選到的種類放不進同一個地方", rule: null };
    return { why: null, rule: rules[0]! };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, moveRootIds, lookup, extraById]);

  const stationRoute = useMemo(() => stationRouteOf(picks, stations), [picks, stations]);

  if (!active) return null;
  const today = todayKey(dayStartHour);
  const count = ids.length;
  const nodes = picks;
  const teikiNodes = nodes.filter((n) => parseRule(n.repeat_rule) !== null);
  const teikiCount = teikiNodes.length;
  const skippedTeikiCount = teikiNodes.filter((n) => currentOccurrences[n.id]?.status === "skipped").length;
  const unskippedTeikiCount = teikiCount - skippedTeikiCount;
  const repeatable = nodes.some((n) => REPEATABLE_KINDS.includes(n.kind));
  const taggable = nodes.every((n) => TAG_ENTITY_NODE_KINDS.includes(n.kind));
  const schedulable = nodes.some((n) => n.kind !== "branch");
  const datable = nodes.some((n) => !parseRule(n.repeat_rule) && n.kind !== "branch");
  const anyDone = nodes.some((n) => (parseRule(n.repeat_rule) ? currentOccurrences[n.id]?.status === "done" : n.status === "done"));
  const anyPaused = nodes.some((n) => n.status === "paused");
  const anyHasScheduled = nodes.some((n) => !!n.scheduled_on);
  const anyHasDue = nodes.some((n) => !!n.due_on);

  const sameDay = nodes.length && nodes.every((n) => n.scheduled_on === nodes[0].scheduled_on) ? nodes[0].scheduled_on : null;
  const sameDue = nodes.length && nodes.every((n) => n.due_on === nodes[0].due_on) ? nodes[0].due_on : null;
  const snapshot = () => [...useSelectionStore.getState().ids];

  const run = (fn: (ids: string[]) => unknown) => () => {
    const cur = snapshot();
    close();
    void fn(cur);
  };
  const explain = (why: string) => () => toast(why);

  const stationList = stationRoute ? routeStations(stations, stationRoute) : [];
  const sharedStation =
    nodes.length > 0 && nodes.every((n) => n.station_id === nodes[0].station_id) ? nodes[0].station_id : undefined;

  return (
    <>
      <div className="m-selbar-dock">
        <div className="m-selbar techo-card" role="toolbar" aria-label="選取列">
          <span className="m-selbar-cnt" aria-live="polite">
            已選<b>{count}</b>張
          </span>
          <div className="m-selbar-acts">
            <button
              type="button"
              className={"m-selbar-ib" + (!schedulable ? " is-off" : "")}
              aria-label={`狀態與印記——${count} 張`}
              title="狀態・印記"
              onClick={schedulable ? () => setSheet("status") : explain("支線沒有推進狀態與済章")}
            >
              <span className="m-selbar-seal" aria-hidden>
                済
              </span>
              狀態
            </button>
            <button
              type="button"
              className={"m-selbar-ib" + (!datable ? " is-off" : "")}
              aria-label="改乘車日…"
              title="乘車日"
              onClick={datable ? () => setSheet("date") : explain("定期券的乘車日照規則排，不能直接改")}
            >
              <IconCal />
              乘車日
            </button>
            <button
              type="button"
              className={"m-selbar-ib" + (!schedulable ? " is-off" : "")}
              aria-label="改締切日…"
              title="締切"
              onClick={schedulable ? () => setSheet("due") : explain("支線不設定締切日")}
            >
              <IconDue />
              締切
            </button>
            <button
              type="button"
              className={"m-selbar-ib" + (!schedulable ? " is-off" : "")}
              aria-label="改時間與長度…"
              title="時間・長度"
              onClick={schedulable ? () => setSheet("time") : explain("支線不排時間與長度")}
            >
              <IconClockMini />
              時間
            </button>
            <button
              type="button"
              className={"m-selbar-ib" + (move?.why ? " is-off" : "")}
              aria-label="移動到…"
              aria-disabled={move?.why ? true : undefined}
              title={move?.why ?? "移動到…"}
              onClick={move?.why ? explain(move.why) : () => setSheet("move")}
            >
              <IconMove />
              移動
            </button>
            {stationRoute && (
              <button
                type="button"
                className="m-selbar-ib"
                aria-label="指派車站…"
                title="車站"
                onClick={() => setSheet("station")}
              >
                <IconStation />
                車站
              </button>
            )}
            <button type="button" className="m-selbar-ib" aria-label="更多動作" aria-haspopup="dialog" title="更多" onClick={() => setSheet("more")}>
              <IconDots />
              更多
            </button>
          </div>
          <button type="button" className="m-selbar-x" onClick={() => useSelectionStore.getState().clear()}>
            取消
          </button>
        </div>
      </div>

      {sheet === "status" && (
        <MSheet list title="狀態與印記" overline={`已選 ${count} 張`} backId={SHEET_LAYER} onClose={close}>
          <MSheetItem onClick={run((cur) => batchSetStatusAndSeal(cur, "done"))}>蓋済</MSheetItem>
          <MSheetItem
            off={!anyDone}
            onClick={anyDone ? run((cur) => batchSetStatusAndSeal(cur, "uncomplete")) : explain("選到的項目尚未蓋済")}
          >
            取消蓋済
          </MSheetItem>
          <MSheetItem cut onClick={run((cur) => batchSetStatusAndSeal(cur, "todo"))}>
            未開始
          </MSheetItem>
          <MSheetItem onClick={run((cur) => batchSetStatusAndSeal(cur, "doing"))}>進行中</MSheetItem>
          <MSheetItem onClick={run((cur) => batchSetStatusAndSeal(cur, "paused"))}>途中下車</MSheetItem>
          <MSheetItem
            off={!anyPaused}
            onClick={anyPaused ? run((cur) => batchSetStatusAndSeal(cur, "unpause")) : explain("選到的項目沒有途中下車")}
          >
            解除途中下車
          </MSheetItem>
        </MSheet>
      )}

      {sheet === "more" && (
        <MSheet list title={`已選 ${count} 張`} backId={SHEET_LAYER} onClose={close}>
          {visibleIn(scope).length > count && (
            <MSheetItem
              onClick={() => {
                useSelectionStore.getState().set(scope, visibleIn(scope));
                close();
              }}
            >
              全選這一頁
            </MSheetItem>
          )}
          <MSheetItem onClick={() => setSheet("priority")}>優先級…</MSheetItem>
          <MSheetItem off={!taggable} onClick={taggable ? () => setSheet("tags") : explain("荷札只能掛在車票、列車、車廂上")}>
            荷札…
          </MSheetItem>
          <MSheetItem off={!repeatable} onClick={repeatable ? () => setSheet("repeat") : explain("選到的種類不能設定期規則")}>
            定期規則…
          </MSheetItem>
          <MSheetItem
            cut
            off={unskippedTeikiCount === 0}
            onClick={
              unskippedTeikiCount > 0
                ? run((cur) => batchSkip(cur, true))
                : explain(teikiCount === 0 ? "只有定期券能運休" : "選到的定期券本班皆已運休")
            }
          >
            本班運休
          </MSheetItem>
          <MSheetItem
            off={skippedTeikiCount === 0}
            onClick={
              skippedTeikiCount > 0
                ? run((cur) => batchSkip(cur, false))
                : explain(teikiCount === 0 ? "只有定期券能取消運休" : "選到的定期券目前沒有運休")
            }
          >
            取消運休
          </MSheetItem>
          <MSheetItem cut danger onClick={run(batchDelete)}>
            刪除 {count} 張
          </MSheetItem>
        </MSheet>
      )}

      {sheet === "priority" && (
        <MSheet list title="優先級" backId={SHEET_LAYER} onClose={close}>
          {[...PRIORITY_OPTIONS].reverse().map((o) => (
            <MSheetItem key={o.value} onClick={run((cur) => batchSetPriority(cur, o.value as Priority))}>
              {o.label}
            </MSheetItem>
          ))}
        </MSheet>
      )}

      {sheet === "station" && stationRoute && (
        <MSheet list title="車站" overline={`已選 ${count} 張`} backId={SHEET_LAYER} onClose={close}>
          <MSheetItem
            className={sharedStation === null ? "is-cur" : undefined}
            onClick={run((cur) => batchSetStation(cur, null))}
          >
            還沒排站（清除車站）
          </MSheetItem>
          {stationList.map((st) => (
            <MSheetItem
              key={st.id}
              className={sharedStation === st.id ? "is-cur" : undefined}
              onClick={run((cur) => batchSetStation(cur, st.id))}
            >
              {st.name}
            </MSheetItem>
          ))}
        </MSheet>
      )}

      {sheet === "date" && (
        <MobileDatePicker
          title={`改乘車日・${count} 張`}
          value={sameDay}
          today={today}
          quick={scheduledQuickSet(today, weekStart)}
          onPick={(d) => run((cur) => batchSetDate(cur, d))()}
          onClear={run((cur) => batchSetDate(cur, null))}
          clearLabel="清除乘車日"
          onClose={close}
          backId={SHEET_LAYER}
        />
      )}

      {sheet === "due" && (
        <MobileDatePicker
          title={`改締切日・${count} 張`}
          value={sameDue}
          today={today}
          quick={dueQuickSet(today, { dynamicSync: anyHasScheduled, weekStart })}
          onPick={(d) => run((cur) => batchSetDue(cur, d === "" ? "sync" : d))()}
          onClear={anyHasDue ? run((cur) => batchSetDue(cur, null)) : undefined}
          clearLabel="清除締切日"
          onClose={close}
          backId={SHEET_LAYER}
        />
      )}

      {sheet === "time" && (
        <MobileBatchTimeSheet
          ids={ids}
          nodes={nodes}
          today={today}
          dayStartHour={dayStartHour}
          onClose={close}
        />
      )}

      {sheet === "repeat" && (
        <MobileBatchRepeatSheet
          ids={ids}
          nodes={nodes}
          teikiCount={teikiCount}
          today={today}
          onClose={close}
        />
      )}

      {sheet === "move" && move?.rule && (
        <MobileAttachPicker
          title={move.rule.label}
          depth={move.rule.depth}
          kinds={move.rule.depth === "node" ? (move.rule.kinds as readonly AttachKind[]) : undefined}
          routeSelectable={move.rule.routeSelectable}
          value={null}
          excludeId={moveRootIds.length === 1 ? moveRootIds[0] : undefined}
          {...({ excludeIds: moveRootSet } as Record<string, unknown>)}
          onPick={(t) => {
            const parentId = t.nodeId ?? t.routeId;
            close();
            if (parentId) void batchMoveTo(moveRootIds, parentId);
          }}
          onClose={close}
        />
      )}

      {sheet === "tags" && <TagSheet ids={ids} onClose={close} />}
    </>
  );
}

const MOBILE_DIAL_OPTS = [
  { value: "start" as const, label: "撥開始" },
  { value: "end" as const, label: "撥結束" },
];

/** 手機批量「時間・長度」面板（開始時刻 ⇄ 結束時刻 ⇄ 持續時長 雙向互推） */
function MobileBatchTimeSheet({
  ids,
  nodes,
  today,
  dayStartHour,
  onClose,
}: {
  ids: string[];
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
    const next = msToClock(ms, refDay);
    if (!next) return;
    const res = applyStartClock({ startHm: span.startHm, durationMin: span.durationMin }, next, dayStartHour);
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
    const next = msToClock(ms, refDay);
    if (!next) return;
    const res = applyEndClock({ startHm: effectiveStartHm, durationMin: span.durationMin }, next, dayStartHour);
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

  const save = () => {
    const cur = [...ids];
    onClose();
    if (!touchedStart && !touchedLen) {
      void batchSetTimeSpan(cur, { scheduledTime: msToClock(startShownMs, refDay) });
      return;
    }
    void batchSetTimeSpan(cur, {
      ...(touchedStart ? { scheduledTime: span.startHm } : {}),
      ...(touchedLen ? { estimateMin: span.durationMin } : {}),
    });
  };

  return (
    <MSheet
      title="時間・長度"
      overline={`已選 ${ids.length} 張`}
      height="full"
      backId={SHEET_LAYER}
      onClose={onClose}
      foot={
        <>
          <button
            type="button"
            className="ns-btn btn-ghost"
            onClick={() => {
              const cur = [...ids];
              onClose();
              void batchSetTimeSpan(cur, { scheduledTime: null, estimateMin: null });
            }}
          >
            清除
          </button>
          <button type="button" className="ns-btn btn-seal" onClick={save}>
            套用
          </button>
        </>
      }
    >
      <div className="ns-qa-msheet">
        <div className="ns-qa-timehead">
          <span className="ns-qa-cardlabel">開始與結束時刻</span>
          <Segmented<"start" | "end">
            compact
            options={MOBILE_DIAL_OPTS}
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
              variant="mobile"
              picker={activeDial === "start" ? "inline" : false}
              quick={[]}
              value={startShownMs}
              lo={lo}
              hi={hi}
              refDay={refDay}
              label="開始時刻"
              dateLabel="other"
              onChange={onStartChange}
              onEnter={save}
            />
          </div>

          <div className="ns-qa-spanrow" onFocusCapture={() => setActiveDial("end")}>
            <div className="ns-qa-spanlbl">
              <span>結束時刻</span>
              <span className="ns-qa-spansub">{span.endHm ? "改結束自動反推時長" : "點選或輸入即反推時長"}</span>
            </div>
            <ClockInput
              variant="mobile"
              picker={activeDial === "end" ? "inline" : false}
              quick={[]}
              value={endShownMs}
              lo={endLo}
              hi={endHi}
              refDay={refDay}
              label="結束時刻"
              dateLabel="other"
              onChange={onEndChange}
              onEnter={save}
            />
          </div>
        </div>

        {errMsg && (
          <p className="ns-qa-timeerr" role="status">
            {errMsg}
          </p>
        )}

        <div className="ns-qa-cardlabel">持續時長</div>
        <DurationPicker liveCommit value={span.durationMin} onChange={onLenChange} onEnter={save} ariaLabel="持續時長" />
      </div>
    </MSheet>
  );
}

/** 手機批量「定期規則」面板 */
function MobileBatchRepeatSheet({
  ids,
  nodes,
  teikiCount,
  today,
  onClose,
}: {
  ids: string[];
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
  const [datePick, setDatePick] = useState<"start" | "until" | null>(null);
  useBackLayer(REPEAT_DATE_LAYER, datePick !== null, () => setDatePick(null), "dialog");

  const built = useMemo(() => buildRule(draft), [draft]);
  const stepInt = (cur: number | null, delta: number, min: number, max: number) =>
    Math.max(min, Math.min(max, (cur ?? min) + delta));

  return (
    <>
      <MSheet
        title="定期規則"
        overline={`已選 ${ids.length} 張`}
        height="full"
        backId={SHEET_LAYER}
        onClose={onClose}
        foot={
          <>
            {teikiCount > 0 && (
              <button
                type="button"
                className="ns-btn btn-ghost"
                onClick={() => {
                  const cur = [...ids];
                  onClose();
                  void batchSetRepeat(cur, null);
                }}
              >
                改回乘車券
              </button>
            )}
            <button
              type="button"
              className="ns-btn btn-seal"
              disabled={!built}
              onClick={() => {
                if (!built) return;
                const cur = [...ids];
                onClose();
                void batchSetRepeat(cur, built);
              }}
            >
              套用定期規則
            </button>
          </>
        }
      >
        <div className="ns-qa-msheet">
          <p className="ns-selbar-repeat-desc">{built ? describeRule(built) : "請補齊欄位後套用"}</p>
          <div className="ns-selbar-repeat-grid is-mobile">
            <span className="lbl">模式</span>
            <Segmented
              options={ACTIVE_MODE_OPTIONS}
              value={draft.mode === "after" ? "after" : "fixed"}
              onChange={(v) => setDraft((d) => switchMode(d, v))}
              aria-label="重複方式"
            />

            {draft.mode === "fixed" && (
              <>
                <span className="lbl">頻率</span>
                <Segmented
                  options={FREQ_OPTIONS}
                  value={draft.freq}
                  onChange={(v) => setDraft((d) => pickFreq(d, v))}
                  aria-label="重複頻率"
                />

                <span className="lbl">間隔</span>
                <div className="ns-selbar-mstep">
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm"
                    onClick={() => setDraft((d) => ({ ...d, interval: stepInt(d.interval, -1, 1, intervalMax(d.freq)) }))}
                  >
                    −
                  </button>
                  <span>
                    每 <b>{draft.interval}</b> {INTERVAL_UNIT[draft.freq]}
                  </span>
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm"
                    onClick={() => setDraft((d) => ({ ...d, interval: stepInt(d.interval, 1, 1, intervalMax(d.freq)) }))}
                  >
                    ＋
                  </button>
                </div>

                {draft.freq === "weekly" && (
                  <>
                    <span className="lbl">星期</span>
                    <div className="ns-selbar-wk7 is-mobile" role="group" aria-label="星期">
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
                                if (next === d.byweekday) toast(LAST_WEEKDAY_WHY);
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
                    <div className="ns-selbar-mstep">
                      <button
                        type="button"
                        className="ns-btn btn-ghost ns-btn--sm"
                        onClick={() => setDraft((d) => ({ ...d, monthday: stepInt(d.monthday, -1, 1, 31) }))}
                      >
                        −
                      </button>
                      <span>
                        <b>{draft.monthday ?? 1}</b> 日
                      </span>
                      <button
                        type="button"
                        className="ns-btn btn-ghost ns-btn--sm"
                        onClick={() => setDraft((d) => ({ ...d, monthday: stepInt(d.monthday, 1, 1, 31) }))}
                      >
                        ＋
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {draft.mode === "after" && (
              <>
                <span className="lbl">完成後</span>
                <div className="ns-selbar-mstep">
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm"
                    onClick={() => setDraft((d) => ({ ...d, days: stepInt(d.days, -1, 1, 365) }))}
                  >
                    −
                  </button>
                  <span>
                    <b>{draft.days ?? 1}</b> 天
                  </span>
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm"
                    onClick={() => setDraft((d) => ({ ...d, days: stepInt(d.days, 1, 1, 365) }))}
                  >
                    ＋
                  </button>
                </div>
              </>
            )}

            <span className="lbl">起算日</span>
            <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => setDatePick("start")}>
              {mdwText(draft.start)} ›
            </button>

            <span className="lbl">結束</span>
            <Segmented
              options={END_OPTIONS}
              value={draft.endMode}
              onChange={(v) => setDraft((d) => pickEnd(d, v, today, 0))}
              aria-label="結束條件"
            />

            {draft.endMode === "until" && (
              <>
                <span className="lbl">結束日</span>
                <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => setDatePick("until")}>
                  {draft.until ? mdwText(draft.until) : "選結束日"} ›
                </button>
              </>
            )}

            {draft.endMode === "count" && (
              <>
                <span className="lbl">次數</span>
                <div className="ns-selbar-mstep">
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm"
                    onClick={() => setDraft((d) => ({ ...d, count: stepInt(d.count, -1, 1, COUNT_MAX) }))}
                  >
                    −
                  </button>
                  <span>
                    <b>{draft.count ?? 10}</b> 次
                  </span>
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm"
                    onClick={() => setDraft((d) => ({ ...d, count: stepInt(d.count, 1, 1, COUNT_MAX) }))}
                  >
                    ＋
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </MSheet>

      {datePick && (
        <MobileDatePicker
          title={datePick === "start" ? "起算日" : "結束日"}
          value={datePick === "start" ? draft.start : draft.until}
          min={datePick === "until" ? draft.start : undefined}
          today={today}
          quick={scheduledQuickSet(today, useUiStore.getState().weekStart)}
          backId={REPEAT_DATE_LAYER}
          backKind="dialog"
          onPick={(d) => {
            setDraft((prev) => (datePick === "start" ? { ...prev, start: d } : { ...prev, until: d }));
            setDatePick(null);
          }}
          onClose={() => setDatePick(null)}
        />
      )}
    </>
  );
}

/** 荷札：打字掛上（沒有就建）、點常用的掛上、點已掛的拿掉 */
function TagSheet({ ids, onClose }: { ids: string[]; onClose(): void }) {
  const index = useTagStore((s) => s.index);
  const [q, setQ] = useState("");
  const composing = useRef(false);
  useEffect(() => {
    if (!useTagStore.getState().index) void useTagStore.getState().loadIndex();
  }, []);
  const attached = useMemo(() => {
    if (!index) return [];
    const keys = new Set<string>();
    for (const id of ids) for (const k of keysOfEntity(index, "node", id)) keys.add(k);
    return [...keys].map((k) => ({ key: k, name: index.byKey[k]?.name ?? k })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }, [index, ids]);
  const items = index ? suggest(index, q, { limit: 10 }).items : [];
  const attach = (name: string) => {
    const n = name.trim().replace(/^#/, "");
    if (!n) return;
    onClose();
    void batchAttachTag([...ids], n);
  };
  return (
    <MSheet
      title="荷札"
      overline={`已選 ${ids.length} 張`}
      backId={SHEET_LAYER}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" disabled={!q.trim()} onClick={() => attach(q)}>
            掛上
          </button>
        </>
      }
    >
      <div className="m-seltag-row">
        <input
          className="m-nt-input m-txs-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
            if (e.key === "Enter") {
              e.preventDefault();
              attach(q);
            }
          }}
          placeholder="荷札名稱（沒有就新建）"
          aria-label="要掛上的荷札名稱"
          enterKeyHint="done"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <p className="m-seltag-h">{q.trim() ? "符合的荷札" : "常用"}</p>
      {items.length ? (
        <div className="m-seltag-chips">
          {items.map((it) => (
            <button key={it.key} type="button" className="m-seltag-chip" onClick={() => attach(it.name)}>
              #{it.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="m-seltag-empty">{index ? "還沒有荷札——打字後按「掛上」新建一個" : "荷札載入中…"}</p>
      )}
      {attached.length > 0 && (
        <>
          <p className="m-seltag-h">已掛的（點一下從選到的票上拿掉）</p>
          <div className="m-seltag-chips">
            {attached.map((t) => (
              <button
                key={t.key}
                type="button"
                className="m-seltag-chip is-rm"
                aria-label={`拿掉荷札 ${t.name}`}
                onClick={() => {
                  onClose();
                  void batchDetachTag([...ids], t.key);
                }}
              >
                #{t.name}　×
              </button>
            ))}
          </div>
        </>
      )}
    </MSheet>
  );
}
