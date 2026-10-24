/**
 * PlanPanel——日程上點已排的卡開的小面板（④ 契約 §5.5、D-時-78、79、88；〈原型定案〉2、4；乙席；sheet `{ kind: "plan", key }`）。
 * 長相＝原型 v-h.js panelBody（.vh-pp）。兩殼共用本體：
 *   桌機＝貼在卡右邊的浮層（schedule/PlanPopover 包它；蓋在「差多少」欄上），手機＝MobileSheetHost 的 sheet（SheetPanel 的 plan 那一支）。
 *
 *   div.ns-tt-panel.ns-tt-plan
 *   ├ div.ns-tt-plan-h      路線圓牌（沒路線＝虛線「臨」）、路線名、「執行日 10/20（一）」或「定期券・每天 20:00」、本班／済／運休
 *   ├ Row「時刻」           ClockInput compact（−15｜可打字的框｜＋15；框下說明行＝這一天的日期、25:00 寫「＝隔天」、打錯說哪裡錯）｜発
 *   │                       過去的日子／運休＝只顯示時刻（＋「＝隔天 01:00」）
 *   ├ Row「預計」           fmtDur 或「沒填（畫 45 分虛線）」（預計照舊在側板改，契約 §1）
 *   ├ Row「實際」           連到的時間塊「10:25–11:40、…」＋「共 1h15m（2 塊）」＋差多少（fmtPlanDelta）
 *   ├ p.ns-tt-plan-teiki    定期券：「在這裡排＝只改這一班…」＋（覆寫過）「改回 20:00」＝clearRun
 *   └ Actions               清除時刻｜打開車票｜発車（只有今天、還沒済／運休，D-時-88；這張正在跑＝停用「運行中」）
 *
 * 寫入一律走 `timetableScheduleStore.placeAt`（守門、收據、撤回都在 store）；「改回」走 store 的 `revertRun`
 * （同一把鎖、同一套收據＋撤回，撤回＝planUndo）。誤點的單發票（`lateFrom`，D-時-80 改題）照樣能開：頭一行寫「誤點・原定 10/17」，
 * 時刻一寫＝執行日改到今天（placeAt 處理）；它還沒有這一天的時刻，所以不出「清除時刻」。発車＝先關面板再 `departFromPlan`（departFromTask 在面板開著時不發車）。
 * 輸入框：Enter 套用；失焦時按的是按鈕 ⇒ 丟掉草稿（不先寫再做按鈕的事），焦點真的離開才套用（修正席）。
 *
 * UI 丙-4 C5：自畫的 −15｜輸入框｜+15 換成全 App 那支 `ClockInput variant="compact"`（解析、範圍、打錯抖一下、跨天日期都是它的）。
 * - 值換算：時刻表的 `"HH:MM"`（營業日表記，25:00＝隔天 01:00）↔ 毫秒＝執行日 00:00 起算的分鐘；範圍＝`clockRange(日界線)`。
 * - 寫入節流：ClockInput 的 ±15 可以長按連跳，每一步都 `placeAt` 會撞同一把寫入鎖（忙著的那幾下被丟掉、框裡的數字亂跳）、
 *   還一步一個 toast。改成框裡先畫（`pend`），停手 COMMIT_MS 才寫一次；面板關掉時還沒寫的照寫（清除時刻除外，它自己蓋過去）。
 * - 「丟草稿」的鈕：面板的清除時刻／打開車票／発車／改回都帶 `data-tt-drop-draft`（ClockInput 失焦時看到就丟掉打到一半的字），
 *   保住上面那條「按按鈕不先寫草稿」；外框的 × 由 PlanPopover 帶。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MIN, fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { SCHED_TINY_MS, canScheduleDay } from "../../../domain/timetableSchedule";
import { describeRule, parseRule } from "../../../domain/repeat";
import { clockMinutes, clockRange, clockText, nextDayNote } from "../../../lib/date";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import {
  canDepartPlan,
  departFromPlan,
  scheduleSpansOf,
  useScheduleCompare,
  useTimetableScheduleStore,
} from "../../../store/timetableScheduleStore";
import { useUiStore } from "../../../store/uiStore";
import { useNow } from "../useNow";
import { RouteRoundel, useRouteById } from "../parts/LinkPicker";
import { SCHED_UI, deltaFull, mdw, toneOf } from "../schedule/scheduleModel";
import { openTicket } from "../schedule/openTicket";
import { ClockInput } from "../../common/ClockInput";
import { Actions, Row, Sub, type PanelProps } from "./controls";

export interface PlanPanelProps extends PanelProps {
  /** 「打開車票」怎麼跳（桌機 jumpToNode／手機換 tab）；SheetPanel 只在手機用到 ⇒ 預設 mobile */
  shell?: "desktop" | "mobile";
}

const STEP = 15;
/** 停手多久才寫（ms）：長按連跳每 45–170ms 一步，停下來才寫一次 */
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
  const revertRun = useTimetableScheduleStore((s) => s.revertRun);
  const h = useUiStore((s) => s.dayStartHour);
  const routeById = useRouteById();
  const now = useNow(30_000);
  const all = useScheduleCompare(now);
  const c = all.cmp.get(key);

  // UI 丙-4 C5：時刻 ↔ 毫秒（執行日 00:00 起算；營業日表記 25:00＝隔天 01:00）
  const midnight = item ? new Date(`${item.date}T00:00:00`).getTime() : 0;
  const itemMs = item?.time ? midnight + (clockMinutes(item.time) ?? 0) * MIN : null;
  /** 框裡已改、還沒寫進去的值（停手 COMMIT_MS 才寫）；寫成功後 item.time 換了就收掉 */
  const [pend, setPend] = useState<number | null>(null);
  const pendRef = useRef<number | null>(null);
  const commitT = useRef(0);
  const seq = useRef(0);
  const write = (ms: number, my: number): void => {
    const t = clockText(Math.round((ms - midnight) / MIN));
    if (!t) {
      if (seq.current === my) setPend(null);
      return;
    }
    // 寫不進去（鎖著、守門擋下）⇒ 框退回原值；寫進去了等 item.time 換掉再收（不然重載前會閃回舊值）
    void placeAt(key, t).then((ok) => {
      if (!ok && seq.current === my) setPend(null);
    });
  };
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (!commitT.current) return;
    window.clearTimeout(commitT.current);
    commitT.current = 0;
    if (pendRef.current !== null) write(pendRef.current, seq.current);
  };
  // 時刻從外面變了（寫完重載、拖、同步）而手上沒有等著寫的 ⇒ 框跟著 item
  useEffect(() => {
    if (!commitT.current) {
      pendRef.current = null;
      setPend(null);
    }
  }, [item?.time]);
  // 面板關掉時還沒寫的照寫（清除時刻先把它取消了）
  useEffect(() => () => flushRef.current(), []);

  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const blocks = useMemo(() => {
    if (!c || ttDay !== item?.date) return [];
    const ids = new Set(c.blockIds);
    const mine = dayBlocks.filter((r) => ids.has(r.id));
    const pending = new Set(scheduleSpansOf(mine, { catById, longRunMaxMin, linkInfo }, now).filter((s) => s.pending).map((s) => s.id));
    // 碎塊（已結束、整塊 < 60 秒）不列（差多少也不算它，D-時-44）；運行中的照列；待確認的照列、旁邊標「待確認」、不算進「（N 塊）」
    return mine
      .filter((r) => r.ended_at === null || msOf(r.ended_at) - msOf(r.started_at) >= SCHED_TINY_MS)
      .sort((a, b) => msOf(a.started_at) - msOf(b.started_at))
      .map((r) => ({ row: r, pending: pending.has(r.id) }));
  }, [c, dayBlocks, ttDay, item?.date, catById, longRunMaxMin, linkInfo, now]);

  // UI 丙-4 C4：退路只寫一句，不放「關閉」字鈕（規範 §4：不改東西只是關＝×／返回／點暗幕）
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
  const rule = item.kind === "repeat" ? parseRule(node?.repeat_rule) : null;
  const ruleText = rule ? describeRule(rule) : "";
  const everyRun = node?.scheduled_time ?? null;
  const next = item.time ? nextDayNote(item.time) : null;
  const delta = deltaFull(item, c, isPast, TT_TEXT.schedSkipped);
  const live = running?.node_id === item.nodeId;
  /** 算進「共 X（N 塊）」的塊數（待確認的列出來但不算） */
  const counted = blocks.filter((b) => !b.pending).length;

  const range = clockRange(h);
  const loMs = midnight + range.min * MIN;
  const hiMs = midnight + range.max * MIN;
  // 還沒排時刻（理論上欄上的卡都有；防禦）：框從「現在」取整到 15 分起算，不先寫
  const fallbackMs = Math.max(loMs, Math.min(hiMs, midnight + Math.round((now - midnight) / MIN / STEP) * STEP * MIN));
  const shown = pend ?? itemMs ?? fallbackMs;
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
  const clear = (): void => {
    // 等著寫的時刻作廢（不然關面板時先寫它、清除那一下撞鎖被丟掉）
    window.clearTimeout(commitT.current);
    commitT.current = 0;
    onDone();
    void placeAt(key, null);
  };
  const revert = (): void => {
    if (busy || !editable) return;
    // store.revertRun：clearRun＋同一把鎖、同一套收據／撤回（舊覆寫在日界線外 ⇒ 不出撤回）、寫完重載
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

  const showDepart = isToday && canDepartPlan(item);
  const actualNone =
    item.done ? SCHED_UI.actualNone.doneNoTime : all.isFuture ? SCHED_UI.actualNone.future : isPast ? SCHED_UI.actualNone.past : SCHED_UI.actualNone.notStarted;

  return (
    <div className="ns-tt-panel ns-tt-plan">
      <div className="ns-tt-plan-h">
        <RouteRoundel route={route} />
        <span className="ns-tt-plan-meta">
          <b>{route?.name ?? SCHED_UI.temp}</b>
          <small>
            {item.kind === "repeat"
              ? SCHED_UI.repeatLine(ruleText, everyRun)
              : item.lateFrom
                ? SCHED_UI.lateLine(mdw(item.lateFrom))
                : SCHED_UI.dateLine(mdw(item.date))}
          </small>
        </span>
        {item.overridden && <em className="ns-tt-sched-tag">{TT_TEXT.schedRun}</em>}
        {item.skipped && <em className="ns-tt-sched-tag is-cancel">{TT_TEXT.schedSkipped}</em>}
        {item.done && (
          <span className="ns-tt-plan-seal" aria-label={TT_TEXT.schedDone}>
            {TT_TEXT.schedDone}
          </span>
        )}
      </div>

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
        </>
      ) : (
        <Row k={TT_TEXT.schedTimeLabel}>
          <b className="ns-tt-num ns-tt-plan-ptime">{item.time ?? "—"}</b>
          <span className="ns-tt-plan-hatsu">発</span>
          {next && <small className="ns-tt-plan-pnx">{SCHED_UI.timeNext(next)}</small>}
        </Row>
      )}

      <Row k={SCHED_UI.estimate}>
        {item.estimateMin ? <span className="ns-tt-num">{fmtDur(item.estimateMin * MIN)}</span> : <span className="ns-tt-plan-faint">{SCHED_UI.noEstimate}</span>}
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

      {item.kind === "repeat" && (
        <p className="ns-tt-plan-teiki">
          {item.skipped ? (
            SCHED_UI.teikiSkipped
          ) : (
            <>
              {SCHED_UI.teikiNote(`${ruleText}${everyRun ? " " + everyRun : ""}`)}
              {item.overridden && editable && (
                <button type="button" className="ns-tt-opt is-ghostlink" data-tt-drop-draft="" disabled={busy} onClick={revert}>
                  {SCHED_UI.revert(everyRun ?? "—")}
                </button>
              )}
            </>
          )}
        </p>
      )}

      {!editable && !item.skipped && <p className="ns-tt-plan-ro">{SCHED_UI.readonly}</p>}

      <Actions>
        {editable && !item.lateFrom && (
          <button type="button" className="ns-btn btn-ghost is-aux" data-tt-drop-draft="" disabled={busy} onClick={clear}>
            {TT_TEXT.schedClear}
          </button>
        )}
        <button type="button" className="ns-btn btn-ghost" data-tt-drop-draft="" onClick={open}>
          {TT_TEXT.schedOpenTicket}
        </button>
        {showDepart && (
          <button type="button" className="ns-btn btn-seal" data-tt-drop-draft="" disabled={live} title={live ? TT_TEXT.alreadyRunning : undefined} onClick={depart}>
            {live ? SCHED_UI.runningNow : "発車"}
          </button>
        )}
      </Actions>
    </div>
  );
}
