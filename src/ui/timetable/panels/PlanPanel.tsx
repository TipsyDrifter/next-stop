/**
 * PlanPanel——日程上點已排的卡開的小面板（④ 契約 §5.5；第四梯 D-FB-7：預留席轉正／掛路線、Mode A 本班填空、Mode B 待辦入座與釋出）。
 * 兩殼共用本體：桌機＝schedule/PlanPopover 貼在卡旁的浮層，手機＝MobileSheetHost 的 MSheet。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { nodeRepo } from "../../../data";
import type { TaskRow } from "../../../domain/taskFilter";
import { MIN, fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { SCHED_TINY_MS, canScheduleDay } from "../../../domain/timetableSchedule";
import { describeRule, parseRule } from "../../../domain/repeat";
import { placeholderTicketTitle } from "../../../domain/quickAdd";
import { arrivalClock, clockMinutes, clockRange, clockText, nextDayNote } from "../../../lib/date";
import { applyEndClock, CLOCK_SPAN_MAX_MIN } from "../../../domain/clockSpan";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetablePlanStore } from "../../../store/timetablePlanStore";
import { useNodeStore } from "../../../store/nodeStore";
import { SEG_UI, segTotalOf } from "../schedule/routineModel";
import "../schedule/schedule7.css";
import {
  addSegKey,
  canDepartPlan,
  departFromPlan,
  scheduleSpansOf,
  useScheduleCompare,
  useTimetableScheduleStore,
} from "../../../store/timetableScheduleStore";
import { useUiStore } from "../../../store/uiStore";
import { useNow } from "../useNow";
import { groupRoutesByLine } from "../../notes/useAttachOptions";
import { RouteRoundel, useRouteById } from "../parts/LinkPicker";
import { SCHED_UI, deltaFull, mdw, toneOf } from "../schedule/scheduleModel";
import {
  PLACEHOLDER_UI,
  canSeatIntoSlot,
  isEligibleSeatCandidate,
  isPlaceholderNode,
  planItemDisplay,
  sortSeatCandidates,
} from "../schedule/scheduleSeatModel";
import { openTicket } from "../schedule/openTicket";
import { ClockInput } from "../../common/ClockInput";
import { DurationPicker } from "../../common/DurationPicker";
import { Select } from "../../common/Select";
import { Actions, Row, Sub, type PanelProps } from "./controls";

export interface PlanPanelProps extends PanelProps {
  /** 「打開車票」怎麼跳（桌機 jumpToNode／手機換 tab）；SheetPanel 只在手機用到 ⇒ 預設 mobile */
  shell?: "desktop" | "mobile";
}

const STEP = 15;
const COMMIT_MS = 450;

export function PlanPanel({ onDone, shell = "mobile" }: PlanPanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const ttDay = useTimetableStore((s) => s.dayKey);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const key = sheet?.kind === "plan" ? sheet.key : "";
  const item = useTimetableScheduleStore((s) => s.items[key]);
  const node = useTimetableScheduleStore((s) => (item ? s.nodes[item.nodeId] : undefined));
  const busy = useTimetableScheduleStore((s) => s.busy);
  const placeAt = useTimetableScheduleStore((s) => s.placeAt);
  const setEstimate = useTimetableScheduleStore((s) => s.setEstimate);
  const revertRun = useTimetableScheduleStore((s) => s.revertRun);
  const liveLines = useNodeStore((s) => s.liveLines);
  const liveRoutes = useNodeStore((s) => s.liveRoutes);
  const h = useUiStore((s) => s.dayStartHour);
  const routeById = useRouteById();
  const now = useNow(30_000);
  const all = useScheduleCompare(now);
  const c = all.cmp.get(key);
  const segTotal = useTimetablePlanStore((s) => (item ? segTotalOf(item.nodeId, s.slotsByNode[item.nodeId]) : 1));

  // Mode A 本班填空 ＆ 預留席轉正草稿
  const [customDraft, setCustomDraft] = useState(item?.customTitle ?? "");
  const [promoteDraft, setPromoteDraft] = useState("");
  useEffect(() => {
    setCustomDraft(item?.customTitle ?? "");
  }, [item?.customTitle, key]);
  useEffect(() => {
    setPromoteDraft("");
  }, [key]);

  // Mode B 待辦入座挑選器狀態
  const [seatOpen, setSeatOpen] = useState(false);
  const [seatQuery, setSeatQuery] = useState("");
  const [seatTasks, setSeatTasks] = useState<TaskRow[] | null>(null);
  useEffect(() => {
    setSeatOpen(false);
    setSeatQuery("");
    setSeatTasks(null);
  }, [key]);

  useEffect(() => {
    if (!seatOpen || seatTasks !== null) return;
    let alive = true;
    nodeRepo
      .listTasks()
      .then((rows) => {
        if (alive) setSeatTasks(rows);
      })
      .catch(() => {
        if (alive) setSeatTasks([]);
      });
    return () => {
      alive = false;
    };
  }, [seatOpen, seatTasks]);

  const routeGroups = useMemo(() => groupRoutesByLine(liveRoutes, liveLines), [liveRoutes, liveLines]);
  const liveRouteIds = useMemo(() => new Set(liveRoutes.map((r) => r.id)), [liveRoutes]);

  // UI 丙-4 C5：時刻 ↔ 毫秒（執行日 00:00 起算；營業日表記 25:00＝隔天 01:00）
  const midnight = item ? new Date(`${item.date}T00:00:00`).getTime() : 0;
  const itemMs = item?.time ? midnight + (clockMinutes(item.time) ?? 0) * MIN : null;
  const [pend, setPend] = useState<number | null>(null);
  const pendRef = useRef<number | null>(null);
  const commitT = useRef(0);
  const seq = useRef(0);
  const [estPend, setEstPend] = useState<number | null | undefined>(undefined);
  const estPendRef = useRef<number | null | undefined>(undefined);
  const estCommitT = useRef(0);
  const estSeq = useRef(0);

  const write = (ms: number, my: number): void => {
    const t = clockText(Math.round((ms - midnight) / MIN));
    if (!t) {
      if (seq.current === my) setPend(null);
      return;
    }
    void placeAt(key, t).then((ok) => {
      if (!ok && seq.current === my) setPend(null);
    });
  };
  const writeEst = (estMin: number | null, my: number): void => {
    void setEstimate(key, estMin).then((ok) => {
      if (!ok && estSeq.current === my) {
        estPendRef.current = undefined;
        setEstPend(undefined);
      }
    });
  };
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (commitT.current) {
      window.clearTimeout(commitT.current);
      commitT.current = 0;
      if (pendRef.current !== null) write(pendRef.current, seq.current);
    }
    if (estCommitT.current) {
      window.clearTimeout(estCommitT.current);
      estCommitT.current = 0;
      if (estPendRef.current !== undefined) writeEst(estPendRef.current, estSeq.current);
    }
  };
  useEffect(() => {
    if (!commitT.current) {
      pendRef.current = null;
      setPend(null);
    }
  }, [item?.time]);
  useEffect(() => {
    if (!estCommitT.current) {
      estPendRef.current = undefined;
      setEstPend(undefined);
    }
  }, [item?.estimateMin]);
  useEffect(() => () => flushRef.current(), []);

  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const blocks = useMemo(() => {
    if (!c || ttDay !== item?.date) return [];
    const ids = new Set(c.blockIds);
    const mine = dayBlocks.filter((r) => ids.has(r.id));
    const pending = new Set(
      scheduleSpansOf(mine, { catById, longRunMaxMin, linkInfo }, now)
        .filter((s) => s.pending)
        .map((s) => s.id),
    );
    return mine
      .filter((r) => r.ended_at === null || msOf(r.ended_at) - msOf(r.started_at) >= SCHED_TINY_MS)
      .sort((a, b) => msOf(a.started_at) - msOf(b.started_at))
      .map((r) => ({ row: r, pending: pending.has(r.id) }));
  }, [c, dayBlocks, ttDay, item?.date, catById, longRunMaxMin, linkInfo, now]);

  const seatCandidates = useMemo(() => {
    if (!item || !seatTasks) return [];
    const eligible = seatTasks.filter(
      (r) =>
        (!r.route_id || liveRouteIds.has(r.route_id)) &&
        isEligibleSeatCandidate(r, item.nodeId, r.has_kids),
    );
    return sortSeatCandidates(eligible, {
      preferredRouteId: node?.route_id ?? null,
      targetDate: item.date,
      query: seatQuery,
    }).slice(0, 30);
  }, [item, seatTasks, liveRouteIds, node?.route_id, seatQuery]);

  if (!item || !c) {
    return (
      <div className="ns-tt-panel ns-tt-plan">
        <Sub>找不到這一班</Sub>
      </div>
    );
  }

  const isToday = item.date === todayKey;
  const isPast = item.date < todayKey;
  const editable = canScheduleDay(item.date, todayKey) && !item.skipped;
  const route = node?.route_id ? (routeById[node.route_id] ?? null) : null;
  const disp = planItemDisplay(item, node, route?.name);
  const placeholder = isPlaceholderNode(node);
  const canSeat = editable && canSeatIntoSlot(item, node);
  const rule = item.kind === "repeat" ? parseRule(node?.repeat_rule) : null;
  const ruleText = rule ? describeRule(rule) : "";
  const everyRun = node?.scheduled_time ?? null;
  const next = item.time ? nextDayNote(item.time) : null;
  const delta = deltaFull(item, c, isPast, TT_TEXT.schedSkipped);
  const live = running?.node_id === item.nodeId;
  const counted = blocks.filter((b) => !b.pending).length;

  const range = clockRange(h);
  const loMs = midnight + range.min * MIN;
  const hiMs = midnight + range.max * MIN;
  const fallbackMs = Math.max(
    loMs,
    Math.min(hiMs, midnight + Math.round((now - midnight) / MIN / STEP) * STEP * MIN),
  );
  const shown = pend ?? itemMs ?? fallbackMs;
  const effEst = estPend !== undefined ? estPend : (item.estimateMin ?? null);

  const change = (ms: number): void => {
    const my = ++seq.current;
    pendRef.current = ms;
    setPend(ms);
    window.clearTimeout(commitT.current);
    commitT.current = window.setTimeout(() => {
      commitT.current = 0;
      write(ms, my);
    }, COMMIT_MS);
  };
  const changeEst = (nextEst: number | null, immediate = false): void => {
    const my = ++estSeq.current;
    estPendRef.current = nextEst;
    setEstPend(nextEst);
    window.clearTimeout(estCommitT.current);
    if (immediate) {
      estCommitT.current = 0;
      writeEst(nextEst, my);
      return;
    }
    estCommitT.current = window.setTimeout(() => {
      estCommitT.current = 0;
      writeEst(nextEst, my);
    }, COMMIT_MS);
  };
  const changeEnd = (endMs: number): void => {
    const startText = clockText(Math.round((shown - midnight) / MIN));
    const endText = clockText(Math.round((endMs - midnight) / MIN));
    if (!startText || !endText) return;
    const res = applyEndClock({ startHm: startText, durationMin: effEst }, endText, h);
    if (res.ok && res.durationMin !== null) {
      changeEst(res.durationMin, false);
    }
  };

  /** Mode A：提交本班具體內容（定期班次） */
  const commitCustomTitle = async (nextRaw?: string): Promise<void> => {
    const val = (nextRaw !== undefined ? nextRaw : customDraft).trim();
    const cur = (item.customTitle ?? "").trim();
    if (val === cur) return;
    const res = await useNodeStore.getState().setRunCustomTitle(item.nodeId, item.date, val || null);
    if (res.ok) {
      await useTimetableScheduleStore.getState().load();
    }
  };

  /** 4A：預留席原地填入具體標題並轉為正式車票 */
  const commitPromotePlaceholder = async (): Promise<void> => {
    if (!node || !placeholder) return;
    const trimmed = promoteDraft.trim();
    if (!trimmed) return;
    const prevName = node.name;
    const res = await useNodeStore.getState().updateNode(node.id, {
      name: trimmed,
      is_placeholder: null,
    });
    if (!res.ok) return;
    setPromoteDraft("");
    await useTimetableScheduleStore.getState().load();
    useUiStore.getState().showToast({
      message: PLACEHOLDER_UI.promoted(trimmed),
      actionLabel: TT_TEXT.undo,
      onAction: () => {
        void useNodeStore
          .getState()
          .updateNode(node.id, { name: prevName, is_placeholder: 1 })
          .then(() => useTimetableScheduleStore.getState().load());
      },
    });
  };

  /** 4A：預留席切換掛載路線 */
  const handlePlaceholderRouteChange = async (nextRouteId: string): Promise<void> => {
    if (!node) return;
    const rid = nextRouteId || null;
    const ns = useNodeStore.getState();
    const prevRouteName = route?.name ?? null;
    const nextRoute = rid ? (routeById[rid] ?? null) : null;
    const res = await ns.setRouteTag(node.id, rid);
    if (!res.ok) return;
    // 若標題仍是預設「預留席」或前一條路線名，自動跟著換成新路線名
    if (node.name === PLACEHOLDER_UI.fallbackName || (prevRouteName && node.name === prevRouteName)) {
      const autoName = placeholderTicketTitle({ routeName: nextRoute?.name ?? null });
      await ns.updateNode(node.id, { name: autoName });
    }
    await useTimetableScheduleStore.getState().load();
  };

  /** Mode B：選擇一張待辦車票入座到此空位 */
  const handlePickSeatCandidate = async (cand: TaskRow): Promise<void> => {
    const slotNodeId = item.nodeId;
    const dueOn = item.date;
    const slotName = node?.name ?? PLACEHOLDER_UI.fallbackName;
    const res = await useNodeStore.getState().seatTicketIntoSlot(slotNodeId, dueOn, cand.id);
    if (!res.ok) return;
    setSeatOpen(false);
    await useTimetableScheduleStore.getState().load();
    // 切換面板至入座後的那張待辦車票（因原空殼預留席已自動隱藏）
    useTimetableStore.getState().openSheet({ kind: "plan", key: `${dueOn}-${cand.id}` });
    useUiStore.getState().showToast({
      message: PLACEHOLDER_UI.seated(cand.name, slotName),
      actionLabel: TT_TEXT.undo,
      onAction: () => {
        void useNodeStore
          .getState()
          .releaseSeatedSlot(slotNodeId, dueOn)
          .then(() => useTimetableScheduleStore.getState().load());
      },
    });
  };

  /** Mode B：釋出目前已入座的預留席 */
  const handleReleaseSeat = async (): Promise<void> => {
    const ref = item.seatedInto;
    if (!ref) return;
    const res = await useNodeStore.getState().releaseSeatedSlot(ref.slotNodeId, ref.dueOn);
    if (!res.ok) return;
    await useTimetableScheduleStore.getState().load();
    useTimetableStore.getState().openSheet({ kind: "plan", key: `${item.date}-${ref.slotNodeId}` });
    useUiStore.getState().showToast({
      message: PLACEHOLDER_UI.released(ref.slotName),
    });
  };

  const deletePlaceholder = (): void => {
    if (!node) return;
    window.clearTimeout(commitT.current);
    commitT.current = 0;
    window.clearTimeout(estCommitT.current);
    estCommitT.current = 0;
    onDone();
    const targetId = node.id;
    void useNodeStore.getState().deleteNode(targetId).then((ids) => {
      if (ids.length > 0) {
        useUiStore.getState().showToast({
          message: PLACEHOLDER_UI.deleted,
          actionLabel: TT_TEXT.undo,
          onAction: () => {
            void useNodeStore.getState().restoreNodes(ids);
          },
        });
      }
    });
  };

  const clear = (): void => {
    window.clearTimeout(commitT.current);
    commitT.current = 0;
    window.clearTimeout(estCommitT.current);
    estCommitT.current = 0;
    onDone();
    void placeAt(key, null);
  };
  const revert = (): void => {
    if (busy || !editable) return;
    void revertRun(key);
  };
  const open = (): void => {
    onDone();
    void openTicket(item.nodeId, shell);
  };
  const depart = (): void => {
    onDone();
    departFromPlan(key);
  };
  const again = (): void => {
    onDone();
    useTimetableScheduleStore.getState().pick(addSegKey(item.nodeId));
  };

  const showDepart = isToday && canDepartPlan(item);
  const canClearTime =
    editable &&
    !item.lateFrom &&
    (item.kind === "repeat" || (node?.scheduled_time !== null && node?.scheduled_time !== undefined));
  const actualNone = item.done
    ? SCHED_UI.actualNone.doneNoTime
    : all.isFuture
      ? SCHED_UI.actualNone.future
      : isPast
        ? SCHED_UI.actualNone.past
        : SCHED_UI.actualNone.notStarted;

  return (
    <div className="ns-tt-panel ns-tt-plan">
      <div className="ns-tt-plan-h">
        <RouteRoundel route={route} />
        <span className="ns-tt-plan-meta">
          <b>{route?.name ?? (placeholder ? PLACEHOLDER_UI.tag : SCHED_UI.temp)}</b>
          <small>
            {item.kind === "repeat"
              ? SCHED_UI.repeatLine(ruleText, everyRun)
              : item.lateFrom
                ? SCHED_UI.lateLine(mdw(item.lateFrom))
                : SCHED_UI.dateLine(mdw(item.date))}
          </small>
        </span>
        {disp.badgeKind === "placeholder" && (
          <em className="ns-tt-sched-tag is-placeholder">{PLACEHOLDER_UI.tag}</em>
        )}
        {disp.badgeKind === "seated" && (
          <em className="ns-tt-sched-tag is-seated">{disp.badgeText}</em>
        )}
        {disp.badgeKind === "filled" && (
          <em className="ns-tt-sched-tag is-filled">{disp.badgeText}</em>
        )}
        {item.overridden && <em className="ns-tt-sched-tag">{TT_TEXT.schedRun}</em>}
        {item.skipped && <em className="ns-tt-sched-tag is-cancel">{TT_TEXT.schedSkipped}</em>}
        {item.done && (
          <span className="ns-tt-plan-seal" aria-label={TT_TEXT.schedDone}>
            {TT_TEXT.schedDone}
          </span>
        )}
      </div>

      {/* 4A：預留席車票原地填入具體事項轉正 ＋ 路線指定 */}
      {placeholder && editable && (
        <>
          <Row k="具體事項" top>
            <div className="ns-tt-seat-box">
              <div className="ns-tt-seat-inline">
                <input
                  className="ns-tt-rtp-name"
                  value={promoteDraft}
                  maxLength={80}
                  placeholder="填入具體事項（Enter 轉為正式車票）"
                  aria-label="填入具體事項"
                  onChange={(e) => setPromoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitPromotePlaceholder();
                    }
                  }}
                />
                {promoteDraft.trim() !== "" && (
                  <button
                    type="button"
                    className="ns-tt-opt is-solid"
                    data-tt-drop-draft=""
                    disabled={busy}
                    onClick={() => void commitPromotePlaceholder()}
                  >
                    轉正
                  </button>
                )}
              </div>
            </div>
          </Row>
          {node?.parent_id === null && (
            <Row k="路線">
              <span className="ns-select-wrap ns-tt-adhoc-select">
                <Select
                  className="techo-input"
                  aria-label="預留席路線"
                  value={node.route_id ?? ""}
                  onChange={(val) => void handlePlaceholderRouteChange(val)}
                >
                  <option value="">不掛路線</option>
                  {routeGroups.map((g) => (
                    <optgroup key={g.lineId ?? "other"} label={g.header}>
                      {g.routes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.code ? `${r.code} ${r.name}` : r.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </span>
            </Row>
          )}
        </>
      )}

      {/* 4C Mode A：定期班次「本班內容」填空 */}
      {item.kind === "repeat" && editable && (
        <Row k="本班內容" top>
          <div className="ns-tt-seat-box">
            <div className="ns-tt-seat-inline">
              <input
                className="ns-tt-rtp-name"
                value={customDraft}
                maxLength={80}
                placeholder={`填寫本班具體事項（未填顯示「${node?.name ?? ""}」）`}
                aria-label="本班內容"
                onChange={(e) => setCustomDraft(e.target.value)}
                onBlur={() => void commitCustomTitle()}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitCustomTitle();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              {item.customTitle && (
                <button
                  type="button"
                  className="ns-tt-opt"
                  data-tt-drop-draft=""
                  disabled={busy}
                  onClick={() => {
                    setCustomDraft("");
                    void commitCustomTitle("");
                  }}
                >
                  還原原名
                </button>
              )}
            </div>
            <small className="ns-tt-seat-note">
              只套用這一班，下一期自動恢復「{node?.name ?? ""}」
            </small>
          </div>
        </Row>
      )}

      {/* 4C Mode B：目前已入座某預留席 ⇒ 顯示母預留資訊與一鍵「釋出預留席」 */}
      {item.seatedInto && (
        <Row k="預留席" top>
          <div className="ns-tt-seat-active">
            <span className="ns-tt-seat-active-txt">
              已入座「{item.seatedInto.isRecurring ? `↻ ${item.seatedInto.slotName}` : item.seatedInto.slotName}」
              {item.seatedInto.slotEstimateMin
                ? ` · ${fmtDur(item.seatedInto.slotEstimateMin * MIN)}`
                : ""}
            </span>
            {editable && (
              <button
                type="button"
                className="ns-tt-opt is-solid"
                data-tt-drop-draft=""
                disabled={busy}
                onClick={() => void handleReleaseSeat()}
              >
                釋出預留席
              </button>
            )}
          </div>
        </Row>
      )}

      {/* 4C Mode B：預留席／定期班次可「⇄ 配對待辦入座」 */}
      {canSeat && (
        <Row k="待辦入座" top>
          <div className="ns-tt-seat-box">
            <div className="ns-tt-seat-inline">
              <button
                type="button"
                className={"ns-tt-opt" + (seatOpen ? " is-solid" : "")}
                data-tt-drop-draft=""
                aria-expanded={seatOpen}
                onClick={() => setSeatOpen((v) => !v)}
              >
                {seatOpen ? "收起候選清單" : "⇄ 配對待辦入座"}
              </button>
              {!seatOpen && (
                <small className="ns-tt-seat-note">讓既有車票坐進此時段，時數不重算</small>
              )}
            </div>
            {seatOpen && (
              <div className="ns-tt-seat-picker">
                <input
                  className="ns-tt-rtp-name"
                  type="search"
                  value={seatQuery}
                  placeholder="搜尋要入座的待辦車票…"
                  aria-label="搜尋要入座的待辦車票"
                  onChange={(e) => setSeatQuery(e.target.value)}
                />
                <div className="ns-tt-seat-list" role="listbox" aria-label="可入座的待辦車票">
                  {seatTasks === null ? (
                    <span className="ns-tt-plan-faint">載入待辦車票中…</span>
                  ) : seatCandidates.length === 0 ? (
                    <span className="ns-tt-plan-faint">找不到可入座的待辦車票</span>
                  ) : (
                    seatCandidates.map((cand) => {
                      const candRoute = cand.route_id ? routeById[cand.route_id] : undefined;
                      return (
                        <button
                          key={cand.id}
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="ns-tt-seat-opt"
                          data-tt-drop-draft=""
                          onClick={() => void handlePickSeatCandidate(cand)}
                        >
                          <i
                            className="ns-tt-sched-rdot"
                            style={{ "--rc": candRoute?.color ?? "var(--ns-tt-cat-8)" } as React.CSSProperties}
                            aria-hidden="true"
                          />
                          <span className="nm">{cand.name}</span>
                          {candRoute && <small className="rt">{candRoute.name}</small>}
                          {cand.estimate_min ? (
                            <small className="est ns-tt-num">{fmtDur(cand.estimate_min * MIN)}</small>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </Row>
      )}

      {editable ? (
        <>
          <Row k={TT_TEXT.schedTimeLabel} time>
            <ClockInput
              variant="compact"
              value={shown}
              lo={loMs}
              hi={hiMs}
              onChange={change}
              label={TT_TEXT.schedTimeLabel}
              refDay={item.date}
            />
            <span className="ns-tt-plan-hatsu">発</span>
          </Row>
          <Row k="結束" time={effEst !== null}>
            {effEst !== null ? (
              <>
                <ClockInput
                  variant="compact"
                  value={shown + effEst * MIN}
                  lo={shown + MIN}
                  hi={shown + CLOCK_SPAN_MAX_MIN * MIN}
                  onChange={changeEnd}
                  label="結束時刻"
                  refDay={item.date}
                />
                <span className="ns-tt-plan-hatsu">着</span>
              </>
            ) : (
              <button
                type="button"
                className="ns-tt-opt is-solid"
                data-tt-drop-draft=""
                disabled={busy}
                onClick={() => changeEst(60, true)}
              >
                ＋ 設結束時刻
              </button>
            )}
          </Row>
        </>
      ) : (
        <Row k={TT_TEXT.schedTimeLabel}>
          <b className="ns-tt-num ns-tt-plan-ptime">
            {item.time ?? "—"}
            {item.time && item.estimateMin ? ` → ${arrivalClock(item.time, item.estimateMin) ?? ""} 着` : ""}
          </b>
          {!item.estimateMin && <span className="ns-tt-plan-hatsu">発</span>}
          {next && <small className="ns-tt-plan-pnx">{SCHED_UI.timeNext(next)}</small>}
        </Row>
      )}

      <Row k={SCHED_UI.estimate} top={editable}>
        {editable ? (
          <DurationPicker
            value={effEst}
            onChange={(m) => changeEst(m, true)}
            compact
            liveCommit
            ariaLabel={SCHED_UI.estimate}
          />
        ) : item.estimateMin ? (
          <span className="ns-tt-num">{fmtDur(item.estimateMin * MIN)}</span>
        ) : (
          <span className="ns-tt-plan-faint">{SCHED_UI.noEstimate}</span>
        )}
      </Row>

      {!item.skipped && (
        <Row k={SCHED_UI.actual} top>
          <span className="ns-tt-plan-act">
            {blocks.length ? (
              <>
                <span className="ns-tt-num">
                  {blocks
                    .map(
                      ({ row: b, pending }) =>
                        `${fmtClock(msOf(b.started_at))}–${b.ended_at ? fmtClock(msOf(b.ended_at)) : SCHED_UI.runningNow}${pending ? SCHED_UI.actualPending : ""}`,
                    )
                    .join("、")}
                </span>
                {counted > 0 && <small>{SCHED_UI.actualTotal(fmtDur(c.actualMs), counted)}</small>}
              </>
            ) : (
              <span className="ns-tt-plan-faint">{actualNone}</span>
            )}
            {delta && blocks.length > 0 && <span className={"ns-tt-plan-diff is-" + toneOf(c)}>{delta}</span>}
          </span>
        </Row>
      )}

      {item.kind === "single" && !placeholder && editable && !item.lateFrom && (
        <Row k={SEG_UI.rowKey}>
          <span className="ns-tt-segrow">
            <span className="ns-tt-plan-faint">{SEG_UI.count(segTotal)}</span>
            <button
              type="button"
              className="ns-tt-opt is-solid"
              data-tt-drop-draft=""
              disabled={busy}
              onClick={again}
            >
              {SEG_UI.again}
            </button>
          </span>
        </Row>
      )}

      {item.kind === "repeat" && (
        <p className="ns-tt-plan-teiki">
          {item.skipped ? (
            SCHED_UI.teikiSkipped
          ) : (
            <>
              {SCHED_UI.teikiNote(`${ruleText}${everyRun ? " " + everyRun : ""}`)}
              {item.overridden && editable && (
                <button
                  type="button"
                  className="ns-tt-opt is-ghostlink"
                  data-tt-drop-draft=""
                  disabled={busy}
                  onClick={revert}
                >
                  {SCHED_UI.revert(everyRun ?? "—")}
                </button>
              )}
            </>
          )}
        </p>
      )}

      {!editable && !item.skipped && <p className="ns-tt-plan-ro">{SCHED_UI.readonly}</p>}

      <Actions>
        {placeholder && editable && (
          <button
            type="button"
            className="ns-btn btn-ghost ns-btn-danger is-aux"
            data-tt-drop-draft=""
            disabled={busy}
            onClick={deletePlaceholder}
          >
            刪除
          </button>
        )}
        {canClearTime && (
          <button
            type="button"
            className="ns-btn btn-ghost is-aux"
            data-tt-drop-draft=""
            disabled={busy}
            onClick={clear}
          >
            {TT_TEXT.schedClear}
          </button>
        )}
        <button type="button" className="ns-btn btn-ghost" data-tt-drop-draft="" onClick={open}>
          {TT_TEXT.schedOpenTicket}
        </button>
        {showDepart && (
          <button
            type="button"
            className="ns-btn btn-seal"
            data-tt-drop-draft=""
            disabled={live}
            title={live ? TT_TEXT.alreadyRunning : undefined}
            onClick={depart}
          >
            {live ? SCHED_UI.runningNow : "発車"}
          </button>
        )}
      </Actions>
    </div>
  );
}
