/**
 * RoutineSegPanel——日程作息帶上點一段開的小面板（⑦ 契約 §3〈畫面〉；原型回報 2「點段的小面板」；原型 rtPanelBody；C 席；
 * sheet `{ kind: "routine", day, id }`）。兩殼共用本體：桌機＝ScheduleView 的 SchedPopover（貼在段旁）、手機＝MobileSheetHost 的 sheet。
 *
 *   div.ns-tt-panel.ns-tt-rtp
 *   ├ p.ns-tt-rtp-sub      12:00–13:00・1h・照表
 *   ├ Row「實際」          重疊、同分類的塊「12:20–12:50」＋「共 30m（1 塊）」＋差多少（fmtRoutineDelta）；沒有＝「這段時間沒有記到『用餐』」
 *   ├ Row「名字」          一行（placeholder＝分類名；空＝用分類名，D-時-167）；Enter／失焦存
 *   ├ CategoryGrid compact 只子分類（D-時-168；CategoryGrid 本來就只列子分類）
 *   ├ Row「開始」「結束」  ClockInput compact（停手才寫，useDebouncedClock）
 *   └ Actions              刪這段（toast 可復原）｜発車（只有今天，同 D-時-88：先關面板再 tapCategory）
 *
 * 即時存、沒有完成鈕（同 PlanPanel）。虛擬段（還沒落地）照樣改得動：plan store 先把整天落地再改，id 不變（uuid v5）。
 * 過去的日子只能看（store 也擋；這裡不給輸入框與刪除）。
 */
import { useEffect, useMemo, useState } from "react";
import { MIN, fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { SCHED_TINY_MS } from "../../../domain/timetableSchedule";
import { compareRoutineItem, fmtRoutineDelta, segName } from "../../../domain/timetableRoutine";
import { clockMinutes, clockRange, clockText, type ClockText } from "../../../lib/date";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { scheduleSpansOf } from "../../../store/timetableScheduleStore";
import { useTimetablePlanStore, type RoutineSegPatch } from "../../../store/timetablePlanStore";
import { useUiStore } from "../../../store/uiStore";
import { useNow } from "../useNow";
import { ClockInput } from "../../common/ClockInput";
import { CategoryGrid } from "../parts/CategoryGrid";
import { RT_UI } from "../schedule/routineModel";
import { SCHED_UI } from "../schedule/scheduleModel";
import { useDebouncedClock } from "../schedule/useDebouncedClock";
import { Actions, Row, Sub, type PanelProps } from "./controls";
import "../schedule/schedule7.css";

export function RoutineSegPanel({ onDone }: PanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const day = sheet?.kind === "routine" ? sheet.day : "";
  const id = sheet?.kind === "routine" ? sheet.id : "";
  const seg = useTimetablePlanStore((s) => s.days[day]?.segs.find((g) => g.id === id) ?? null);
  const busy = useTimetablePlanStore((s) => s.busy);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const catById = useTimetableStore((s) => s.catById);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const ttDay = useTimetableStore((s) => s.dayKey);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const running = useTimetableStore((s) => s.running);
  const h = useUiStore((s) => s.dayStartHour);
  const now = useNow(30_000);

  const midnight = day ? new Date(`${day}T00:00:00`).getTime() : 0;
  const sMs = seg ? midnight + (clockMinutes(seg.s) ?? 0) * MIN : 0;
  const eMs = seg ? midnight + (clockMinutes(seg.e) ?? 0) * MIN : 0;
  const toText = (ms: number): ClockText | null => clockText(Math.round((ms - midnight) / MIN));
  const edit = (patch: RoutineSegPatch): Promise<boolean> =>
    useTimetablePlanStore.getState().editPlan(day, id, patch);
  const start = useDebouncedClock(sMs, (ms) => {
    const t = toText(ms);
    return t ? edit({ s: t }) : Promise.resolve(false);
  });
  const end = useDebouncedClock(eMs, (ms) => {
    const t = toText(ms);
    return t ? edit({ e: t }) : Promise.resolve(false);
  });

  const [name, setName] = useState(seg?.label ?? "");
  useEffect(() => setName(seg?.label ?? ""), [seg?.label]);

  const spans = useMemo(
    () => (ttDay === day ? scheduleSpansOf(dayBlocks, { catById, longRunMaxMin, linkInfo }, now) : []),
    [ttDay, day, dayBlocks, catById, longRunMaxMin, linkInfo, now],
  );
  const c = useMemo(() => (seg ? compareRoutineItem(day, seg, spans, now) : null), [seg, day, spans, now]);
  const blocks = useMemo(() => {
    if (!c) return [];
    const ids = new Set(c.blockIds);
    const pend = new Set(spans.filter((s) => s.pending).map((s) => s.id));
    return dayBlocks
      .filter((r) => ids.has(r.id) && (r.ended_at === null || msOf(r.ended_at) - msOf(r.started_at) >= SCHED_TINY_MS))
      .sort((a, b) => msOf(a.started_at) - msOf(b.started_at))
      .map((r) => ({ row: r, pending: pend.has(r.id) }));
  }, [c, dayBlocks, spans]);

  if (!seg || !c) {
    return (
      <div className="ns-tt-panel ns-tt-rtp">
        <Sub>找不到這一段</Sub>
      </div>
    );
  }

  const cat = seg.cat ? catById[seg.cat] : undefined;
  const catName = cat?.name ?? "？";
  const editable = day >= todayKey;
  const isToday = day === todayKey;
  const range = clockRange(h);
  const lo = midnight + range.min * MIN;
  const hi = midnight + range.max * MIN;
  const hiEnd = midnight + (range.max + 1) * MIN;
  const len = Math.max(0, eMs - sMs);
  const delta = fmtRoutineDelta(c);
  const counted = blocks.filter((b) => !b.pending).length;
  const live = running?.category_id === seg.cat;

  const commitName = (): void => {
    const v = name.trim();
    if (v === (seg.label ?? "")) return;
    void edit({ label: v || null });
  };
  const del = (): void => {
    start.cancel();
    end.cancel();
    onDone();
    const ps = useTimetablePlanStore.getState();
    void ps.deletePlan(day, id).then((ok) => {
      if (ok) useUiStore.getState().showToast({ message: RT_UI.deleted, actionLabel: TT_TEXT.undo, onAction: () => void ps.restorePlan(day, id) });
    });
  };
  const depart = (): void => {
    if (!seg.cat) return;
    onDone();
    useTimetableStore.getState().tapCategory(seg.cat);
  };

  const actualNone =
    c.state === "upcoming" ? RT_UI.upcoming : c.state === "notStarted" ? RT_UI.notStarted : RT_UI.missed(catName);

  return (
    <div className="ns-tt-panel ns-tt-rtp">
      <p className="ns-tt-rtp-sub ns-tt-num">
        {seg.s}–{seg.e}・{fmtDur(len)}
        {c.onSchedule && (
          <>
            ・<b>{RT_UI.onSchedule}</b>
          </>
        )}
      </p>

      <Row k={RT_UI.actual} top>
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
              {delta && <span className={"ns-tt-plan-diff " + (c.state === "late" ? "is-late" : c.state === "running" ? "is-live" : "is-ok")}>{delta}</span>}
            </>
          ) : (
            <span className="ns-tt-plan-faint">{actualNone}</span>
          )}
        </span>
      </Row>

      {editable ? (
        <>
          <Row k={RT_UI.name}>
            <input
              className="ns-tt-rtp-name"
              value={name}
              maxLength={40}
              placeholder={RT_UI.namePh(catName)}
              aria-label={RT_UI.name}
              enterKeyHint="done"
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitName();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </Row>
          <div className="ns-tt-rtp-cats">
            <CategoryGrid compact selected={seg.cat} onPick={(cid) => {
                if (cid !== seg.cat) void edit({ cat: cid });
              }} />
          </div>
          <Row k={RT_UI.start} time>
            <ClockInput variant="compact" value={start.shown} lo={lo} hi={hi} onChange={start.change} label={RT_UI.start} refDay={day} />
          </Row>
          <Row k={RT_UI.end} time>
            <ClockInput variant="compact" value={end.shown} lo={lo} hi={hiEnd} onChange={end.change} label={RT_UI.end} refDay={day} />
          </Row>
        </>
      ) : (
        <>
          <Row k={RT_UI.name}>
            <span>{segName(seg, catName)}</span>
          </Row>
          <p className="ns-tt-plan-ro">{RT_UI.readonly}</p>
        </>
      )}

      {editable && (
        <Actions>
          <button type="button" className="ns-btn btn-ghost ns-btn-danger is-aux" data-tt-drop-draft="" disabled={busy} onClick={del}>
            {RT_UI.del}
          </button>
          {isToday && seg.cat && (
            <button type="button" className="ns-btn btn-seal" data-tt-drop-draft="" disabled={live} title={live ? TT_TEXT.alreadyRunning : undefined} onClick={depart}>
              {live ? SCHED_UI.runningNow : "発車"}
            </button>
          )}
        </Actions>
      )}
    </div>
  );
}
