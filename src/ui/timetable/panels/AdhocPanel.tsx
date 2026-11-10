/**
 * AdhocPanel——日程上點「臨時班次／主題預留時段」開的小面板（第三梯・討論 6；sheet `{ kind: "adhoc", key }`）。
 * 兩殼共用本體：桌機＝ScheduleView 的 SchedPopover、手機＝MobileSheetHost 的 sheet。
 *
 *   div.ns-tt-panel.ns-tt-plan.ns-tt-adhoc
 *   ├ div.ns-tt-plan-h        路線圓牌（未綁＝虛線「臨」）、路線／支線或分類名、「這一段在 11/3（二）」、臨時小牌
 *   ├ Row「主題」             臨時主題名稱輸入框（選填，未填顯示路線／支線或分類名）
 *   ├ Row「開始」「結束」     ClockInput compact（停手才寫）
 *   ├ Row「路線／支線」       可選綁定活躍路線或支線（點同一個取消綁定）
 *   ├ Row「分類」             CategoryGrid compact（點同一個取消綁定）
 *   ├ Row「實際」             自動對照當天同路線／支線或同分類的時間塊＋共計＋差多少
 *   └ Actions                 刪除｜轉為正式車票｜▶ 発車（今天）
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { MIN, fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { SCHED_TINY_MS, canScheduleDay } from "../../../domain/timetableSchedule";
import { clockMinutes, clockRange, clockText } from "../../../lib/date";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { ADHOC_TEXT, scheduleSpansOf, useScheduleCompare, useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { useTimetablePlanStore, type AdhocPatch } from "../../../store/timetablePlanStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { useNow } from "../useNow";
import { ClockInput } from "../../common/ClockInput";
import { CategoryGrid } from "../parts/CategoryGrid";
import { RouteRoundel, useLiveBranches, useRouteById } from "../parts/LinkPicker";
import { RT_UI, SEG_UI } from "../schedule/routineModel";
import { SCHED_UI, deltaFull, mdw, toneOf } from "../schedule/scheduleModel";
import { openTicket } from "../schedule/openTicket";
import { useDebouncedClock } from "../schedule/useDebouncedClock";
import { Actions, Row, Sub, type PanelProps } from "./controls";
import "../schedule/schedule7.css";

export function AdhocPanel({ onDone, shell = "mobile" }: PanelProps & { shell?: "desktop" | "mobile" }) {
  const sheet = useTimetableStore((s) => s.sheet);
  const key = sheet?.kind === "adhoc" ? sheet.key : "";
  const item = useTimetableScheduleStore((s) => s.adhocs[key]);
  const nodes = useTimetableScheduleStore((s) => s.nodes);
  const busy = useTimetablePlanStore((s) => s.busy) || useTimetableScheduleStore((s) => s.busy);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const ttDay = useTimetableStore((s) => s.dayKey);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const h = useUiStore((s) => s.dayStartHour);
  const liveRoutes = useNodeStore((s) => s.liveRoutes);
  const liveBranches = useLiveBranches(liveRoutes);
  const routeById = useRouteById();
  const now = useNow(30_000);
  const all = useScheduleCompare(now);
  const c = all.cmp.get(key);

  const [label, setLabel] = useState(item?.label ?? "");
  useEffect(() => {
    setLabel(item?.label ?? "");
  }, [item?.label]);

  const midnight = item ? new Date(`${item.date}T00:00:00`).getTime() : 0;
  const sMs = item?.time ? midnight + (clockMinutes(item.time) ?? 0) * MIN : 0;
  const eMs = item ? midnight + (clockMinutes(item.end) ?? 0) * MIN : 0;
  const toText = (ms: number) => clockText(Math.round((ms - midnight) / MIN));
  const edit = (patch: AdhocPatch): Promise<boolean> =>
    item ? useTimetablePlanStore.getState().editAdhoc(item.planId, patch) : Promise.resolve(false);

  const start = useDebouncedClock(sMs, (ms) => {
    const t = toText(ms);
    if (!t || !item) return Promise.resolve(false);
    return useTimetableScheduleStore.getState().moveAdhoc(key, t);
  });
  const end = useDebouncedClock(eMs, (ms) => {
    const t = toText(ms);
    return t && item ? edit({ e: t }) : Promise.resolve(false);
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
      <div className="ns-tt-panel ns-tt-plan ns-tt-adhoc">
        <Sub>找不到這班臨時班次</Sub>
      </div>
    );
  }

  const isToday = item.date === todayKey;
  const isPast = item.date < todayKey;
  const editable = canScheduleDay(item.date, todayKey);
  const branch = item.branchNodeId ? (nodes[item.branchNodeId] ?? liveBranches.find((b) => b.id === item.branchNodeId) ?? null) : null;
  const effRouteId = item.routeId ?? branch?.route_id ?? null;
  const route = effRouteId ? (routeById[effRouteId] ?? null) : null;
  const cat = item.categoryId ? catById[item.categoryId] : undefined;
  const fallbackTitle = branch
    ? `${route ? `${route.name} › ` : ""}${branch.name}`
    : route?.name ?? cat?.name ?? ADHOC_TEXT.fallbackName;
  const delta = deltaFull(item, c, isPast, TT_TEXT.schedSkipped);
  const counted = blocks.filter((b) => !b.pending).length;
  const range = clockRange(h);
  const lo = midnight + range.min * MIN;
  const hi = midnight + range.max * MIN;
  const hiEnd = midnight + (range.max + 1) * MIN;
  const actualNone = all.isFuture
    ? SCHED_UI.actualNone.future
    : isPast
      ? SCHED_UI.actualNone.past
      : SCHED_UI.actualNone.notStarted;

  const commitLabel = (): void => {
    const v = label.trim();
    if (v === (item.label ?? "")) return;
    void edit({ label: v || null });
  };
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
    void ps.deleteAdhoc(planId).then((ok) => {
      if (ok) useUiStore.getState().showToast({ message: ADHOC_TEXT.deleted, actionLabel: TT_TEXT.undo, onAction: () => void ps.restoreAdhoc(planId) });
    });
  };
  const convert = (): void => {
    start.cancel();
    end.cancel();
    commitLabel();
    onDone();
    void useTimetableScheduleStore.getState().convertAdhocToTicket(key).then((row) => {
      if (row) void openTicket(row.id, shell);
    });
  };
  const depart = (): void => {
    start.cancel();
    end.cancel();
    commitLabel();
    onDone();
    void useTimetableScheduleStore.getState().departFromAdhoc(key);
  };

  return (
    <div className="ns-tt-panel ns-tt-plan ns-tt-adhoc">
      <div className="ns-tt-plan-h">
        <RouteRoundel route={route} />
        <span className="ns-tt-plan-meta">
          <b>{fallbackTitle}</b>
          <small>{SEG_UI.dateLine(mdw(item.date))}</small>
        </span>
        <em className="ns-tt-sched-tag is-adhoc">{ADHOC_TEXT.tag}</em>
      </div>

      {editable ? (
        <>
          <Row k="主題">
            <input
              className="ns-tt-rtp-name"
              value={label}
              maxLength={40}
              placeholder={`臨時主題（未填顯示「${fallbackTitle}」）`}
              aria-label="臨時主題"
              enterKeyHint="done"
              onChange={(e) => setLabel(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitLabel();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </Row>
          <Row k={RT_UI.start} time>
            <ClockInput variant="compact" value={start.shown} lo={lo} hi={hi} onChange={start.change} label={RT_UI.start} refDay={item.date} />
          </Row>
          <Row k={RT_UI.end} time>
            <ClockInput variant="compact" value={end.shown} lo={lo} hi={hiEnd} onChange={end.change} label={RT_UI.end} refDay={item.date} />
          </Row>
          <Row k="路線／支線" top>
            <div className="ns-tt-chips ns-tt-adhoc-routes">
              {liveRoutes.map((r) => {
                const on = item.routeId === r.id && item.branchNodeId === null;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={"ns-tt-opt" + (on ? " is-on" : "")}
                    style={{ "--c": r.color ?? "var(--ns-tt-cat-8)" } as CSSProperties}
                    aria-pressed={on}
                    onClick={() => void edit(on ? { routeId: null, nodeId: null } : { routeId: r.id, nodeId: null })}
                  >
                    <RouteRoundel route={r} />
                    {r.name}
                  </button>
                );
              })}
              {liveBranches.map((b) => {
                const r = b.route_id ? (routeById[b.route_id] ?? null) : null;
                const on = item.branchNodeId === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    className={"ns-tt-opt" + (on ? " is-on" : "")}
                    style={{ "--c": r?.color ?? "var(--ns-tt-cat-8)" } as CSSProperties}
                    aria-pressed={on}
                    onClick={() => void edit(on ? { routeId: null, nodeId: null } : { routeId: b.route_id, nodeId: b.id })}
                  >
                    <RouteRoundel route={r} />
                    {r ? `${r.name} › ${b.name}` : b.name}
                  </button>
                );
              })}
            </div>
          </Row>
          <Row k="分類" top>
            <div className="ns-tt-rtp-cats">
              <CategoryGrid
                compact
                selected={item.categoryId}
                onPick={(cid) => {
                  void edit({ categoryId: cid === item.categoryId ? null : cid });
                }}
              />
            </div>
          </Row>
          <Row k="位置">
            <span className="ns-tt-segrow">
              <span className="ns-tt-plan-faint">預留 {fmtDur((item.estimateMin ?? 60) * MIN)}</span>
              <button type="button" className="ns-tt-opt is-solid" data-tt-drop-draft="" disabled={busy} onClick={() => pickThen(key)}>
                {SEG_UI.move}
              </button>
            </span>
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

      {!editable && <p className="ns-tt-plan-ro">{SCHED_UI.readonly}</p>}

      <Actions>
        {editable && (
          <button type="button" className="ns-btn btn-ghost ns-btn-danger is-aux" data-tt-drop-draft="" disabled={busy} onClick={del}>
            {RT_UI.del}
          </button>
        )}
        {editable && (
          <button type="button" className="ns-btn btn-ghost" data-tt-drop-draft="" disabled={busy} onClick={convert}>
            轉為正式車票
          </button>
        )}
        {isToday && (
          <button type="button" className="ns-btn btn-seal" data-tt-drop-draft="" disabled={busy} onClick={depart}>
            ▶ 発車
          </button>
        )}
      </Actions>
    </div>
  );
}
