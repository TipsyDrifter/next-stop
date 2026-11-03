/**
 * SlotPanel——日程上點車票第二段起的卡開的小面板（⑦ 契約 §4；原型回報 4；原型 planPanelBody 的 isSeg 那一支；C 席；
 * sheet `{ kind: "slot", key }`）。兩殼共用本體：桌機＝ScheduleView 的 SchedPopover、手機＝MobileSheetHost 的 sheet（卡照舊兩下才開）。
 *
 *   div.ns-tt-panel.ns-tt-plan
 *   ├ div.ns-tt-plan-h      路線圓牌、路線名、「這一段在 11/3（二）」、「第 3 段」、済
 *   ├ Row「開始」「結束」   ClockInput compact（停手才寫）；過去的日子只顯示
 *   ├ Row「實際」           分給這一段的塊（assignSpansToSegments）＋共計＋差多少
 *   ├ Row「分段」           共 N 段〔換位置〕〔再排一段〕——兩顆都是「收面板、進挑位置」（點預定欄的位置放下）
 *   └ Actions               刪這段（toast 可復原）｜打開車票｜発車（只有今天、還沒済）
 */
import { useMemo } from "react";
import { MIN, fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { SCHED_TINY_MS, canScheduleDay } from "../../../domain/timetableSchedule";
import { clockMinutes, clockRange, clockText } from "../../../lib/date";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { SEG_TEXT, addSegKey, scheduleSpansOf, useScheduleCompare, useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { useTimetablePlanStore } from "../../../store/timetablePlanStore";
import { useUiStore } from "../../../store/uiStore";
import { useNow } from "../useNow";
import { ClockInput } from "../../common/ClockInput";
import { RouteRoundel, useRouteById } from "../parts/LinkPicker";
import { RT_UI, SEG_UI, segNumberOf } from "../schedule/routineModel";
import { SCHED_UI, deltaFull, mdw, toneOf } from "../schedule/scheduleModel";
import { openTicket } from "../schedule/openTicket";
import { useDebouncedClock } from "../schedule/useDebouncedClock";
import { Actions, Row, Sub, type PanelProps } from "./controls";
import "../schedule/schedule7.css";

export function SlotPanel({ onDone, shell = "mobile" }: PanelProps & { shell?: "desktop" | "mobile" }) {
  const sheet = useTimetableStore((s) => s.sheet);
  const key = sheet?.kind === "slot" ? sheet.key : "";
  const item = useTimetableScheduleStore((s) => s.slots[key]);
  const node = useTimetableScheduleStore((s) => (item ? s.nodes[item.nodeId] : undefined));
  const slotRows = useTimetablePlanStore((s) => (item ? s.slotsByNode[item.nodeId] : undefined));
  const busy = useTimetablePlanStore((s) => s.busy);
  const running = useTimetableStore((s) => s.running);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const ttDay = useTimetableStore((s) => s.dayKey);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const h = useUiStore((s) => s.dayStartHour);
  const routeById = useRouteById();
  const now = useNow(30_000);
  const all = useScheduleCompare(now);
  const c = all.cmp.get(key);

  const midnight = item ? new Date(`${item.date}T00:00:00`).getTime() : 0;
  const sMs = item?.time ? midnight + (clockMinutes(item.time) ?? 0) * MIN : 0;
  const eMs = item ? midnight + (clockMinutes(item.end) ?? 0) * MIN : 0;
  const toText = (ms: number) => clockText(Math.round((ms - midnight) / MIN));
  const start = useDebouncedClock(sMs, (ms) => {
    const t = toText(ms);
    if (!t || !item) return Promise.resolve(false);
    // 改開始＝整段搬過去（長度不變；同拖曳）——要改長度用「結束」
    return useTimetableScheduleStore.getState().moveSlot(key, t);
  });
  const end = useDebouncedClock(eMs, (ms) => {
    const t = toText(ms);
    return t && item ? useTimetablePlanStore.getState().editSlot(item.planId, { e: t }) : Promise.resolve(false);
  });

  const blocks = useMemo(() => {
    if (!c || !item || ttDay !== item.date) return [];
    const ids = new Set(c.blockIds);
    const mine = dayBlocks.filter((r) => ids.has(r.id));
    const pend = new Set(scheduleSpansOf(mine, { catById, longRunMaxMin, linkInfo }, now).filter((s) => s.pending).map((s) => s.id));
    return mine
      .filter((r) => r.ended_at === null || msOf(r.ended_at) - msOf(r.started_at) >= SCHED_TINY_MS)
      .sort((a, b) => msOf(a.started_at) - msOf(b.started_at))
      .map((r) => ({ row: r, pending: pend.has(r.id) }));
  }, [c, item, ttDay, dayBlocks, catById, longRunMaxMin, linkInfo, now]);

  if (!item || !c) {
    return (
      <div className="ns-tt-panel ns-tt-plan">
        <Sub>找不到這一段</Sub>
      </div>
    );
  }

  const isToday = item.date === todayKey;
  const isPast = item.date < todayKey;
  const editable = canScheduleDay(item.date, todayKey);
  const route = node?.route_id ? (routeById[node.route_id] ?? null) : null;
  const seg = segNumberOf(node, item.nodeId, slotRows, item.planId);
  const total = seg?.total ?? 2;
  const delta = deltaFull(item, c, isPast, TT_TEXT.schedSkipped);
  const live = running?.node_id === item.nodeId && c.state === "running";
  const counted = blocks.filter((b) => !b.pending).length;
  const range = clockRange(h);
  const lo = midnight + range.min * MIN;
  const hi = midnight + range.max * MIN;
  const hiEnd = midnight + (range.max + 1) * MIN;
  const actualNone = item.done
    ? SCHED_UI.actualNone.doneNoTime
    : all.isFuture
      ? SCHED_UI.actualNone.future
      : isPast
        ? SCHED_UI.actualNone.past
        : SCHED_UI.actualNone.notStarted;

  const pickThen = (picked: string): void => {
    start.cancel();
    end.cancel();
    onDone();
    useTimetableScheduleStore.getState().pick(picked);
  };
  const del = (): void => {
    start.cancel();
    end.cancel();
    onDone();
    const ps = useTimetablePlanStore.getState();
    const planId = item.planId;
    void ps.deleteSlot(planId).then((ok) => {
      if (ok) useUiStore.getState().showToast({ message: SEG_TEXT.deleted, actionLabel: TT_TEXT.undo, onAction: () => void ps.restoreSlot(planId) });
    });
  };
  const open = (): void => {
    onDone();
    void openTicket(item.nodeId, shell);
  };
  const depart = (): void => {
    onDone();
    void useTimetableStore.getState().departFromTask(item.nodeId);
  };

  return (
    <div className="ns-tt-panel ns-tt-plan">
      <div className="ns-tt-plan-h">
        <RouteRoundel route={route} />
        <span className="ns-tt-plan-meta">
          <b>{route?.name ?? SCHED_UI.temp}</b>
          <small>{SEG_UI.dateLine(mdw(item.date))}</small>
        </span>
        {seg && seg.total > 1 && <em className="ns-tt-sched-tag is-seg">{SEG_TEXT.tag(seg.n)}</em>}
        {item.done && (
          <span className="ns-tt-plan-seal" aria-label={TT_TEXT.schedDone}>
            {TT_TEXT.schedDone}
          </span>
        )}
      </div>

      {editable ? (
        <>
          <Row k={RT_UI.start} time>
            <ClockInput variant="compact" value={start.shown} lo={lo} hi={hi} onChange={start.change} label={RT_UI.start} refDay={item.date} />
          </Row>
          <Row k={RT_UI.end} time>
            <ClockInput variant="compact" value={end.shown} lo={lo} hi={hiEnd} onChange={end.change} label={RT_UI.end} refDay={item.date} />
          </Row>
        </>
      ) : (
        <Row k={TT_TEXT.schedTimeLabel}>
          <b className="ns-tt-num ns-tt-plan-ptime">
            {item.time}–{item.end}
          </b>
        </Row>
      )}

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

      {editable && (
        <Row k={SEG_UI.rowKey}>
          <span className="ns-tt-segrow">
            <span className="ns-tt-plan-faint">{SEG_UI.count(total)}</span>
            <button type="button" className="ns-tt-opt is-solid" data-tt-drop-draft="" disabled={busy} onClick={() => pickThen(key)}>
              {SEG_UI.move}
            </button>
            <button type="button" className="ns-tt-opt is-solid" data-tt-drop-draft="" disabled={busy} onClick={() => pickThen(addSegKey(item.nodeId))}>
              {SEG_UI.again}
            </button>
          </span>
        </Row>
      )}

      {!editable && <p className="ns-tt-plan-ro">{SCHED_UI.readonly}</p>}

      <Actions>
        {editable && (
          <button type="button" className="ns-btn btn-ghost ns-btn-danger is-aux" data-tt-drop-draft="" disabled={busy} onClick={del}>
            {RT_UI.del}
          </button>
        )}
        <button type="button" className="ns-btn btn-ghost" data-tt-drop-draft="" onClick={open}>
          {TT_TEXT.schedOpenTicket}
        </button>
        {isToday && !item.done && (
          <button type="button" className="ns-btn btn-seal" data-tt-drop-draft="" disabled={live} title={live ? TT_TEXT.alreadyRunning : undefined} onClick={depart}>
            {live ? SCHED_UI.runningNow : "発車"}
          </button>
        )}
      </Actions>
    </div>
  );
}
