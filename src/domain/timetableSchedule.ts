/**
 * 時刻表線・車次④「日程」的純函式層（④ 契約 §3.1、0-5、0-6；甲席）。
 *
 * 鐵則：**只准 import `./timetable.ts`、`./scheduledTime.ts`、`../lib/date.ts`**（其餘只准 `import type`；
 * 牙齒：`scripts/tests/timetable-schedule.test.ts` 第 9 項），相對路徑一律帶 `.ts`（`node --test` 直載）；只用可剝除語法。
 * 時間一律毫秒；日界線日 key 是 `YYYY-MM-DD`；預定時刻是營業日表記（"25:00"＝隔天 01:00，`lib/date.ts`）。
 *
 * 內容：
 *   1. 預定項 `PlanItem`（`planItemOf`：ScheduleEntry＋節點 → 一個 `(nodeId, date)`；
 *      今天的誤點單發票 `lateItemsOf`：今日列 → 「還沒排」的誤點項，使用者改題 D-時-80）
 *   2. 實績對預定 `comparePlan`（D-時-81／82）、當天總結 `daySummary`（D-時-83）、差多少的字 `fmtPlanDelta`（§5.6）
 *   3. 寫入規劃 `planTimeWrite`／`planUndo`（0-5；執行在 `timetableScheduleStore` 的 `runTimeWrite`）
 *   4. 軸上的小工具 `snapClockMin`／`clockOfAxisMin`／`canScheduleDay`
 *
 * 「待確認」的判定不在這裡：store 用 `blockIsLongRun`（＝統計那一套門檻）算好塞進 `LinkedSpan.pending`。
 * 碎塊（整塊 < 60 秒）在這裡判，門檻＝`timetableStats.ts` 的 `TINY_MS`（D-時-44；測試釘住兩邊相等）。
 */
import { MIN, durOf, fmtDur, sliceSpans, type Span } from "./timetable.ts";
import { isTimeOverridden } from "./scheduledTime.ts";
import { clockInstant, clockText, dayWindow, isClockInRange, type ClockText } from "../lib/date.ts";
import type { ScheduleEntry, TodayRow } from "../data/nodeRepository";
import type { NodeRow } from "./node";

/** D-時-81（使用者改題 00:1x）：「早開始或晚 10 分內都算準點」——開始差 ≤ 10 分（含任何提早）＝準點，> 10 分＝晚 */
export const ON_TIME_LATE_MIN = 10;
export const DUR_SAME_MIN = 5; // 長短差 < 5 分不寫
export const SNAP_MIN = 15; // D-時-78：拖曳吸附
/** 碎塊：整塊 < 60 秒（＝`timetableStats.ts` 的 `TINY_MS`；本檔不能 import 它，測試釘住兩者相等） */
export const SCHED_TINY_MS = 60_000;

/** §5.6 的字（`TT_TEXT` 的 sched* 指到這裡；顯示端不手抄） */
export const PLAN_TEXT = {
  onTime: "準點",
  lateStart: (min: number) => `晚 ${minText(min)}開始`,
  running: "行駛中",
  notStarted: "還沒開始",
  doneNoTime: "済・沒記時間",
  over: (ms: number) => `多花 ${fmtDur(ms)}`,
  under: (ms: number) => `少 ${fmtDur(ms)}`,
  soFar: (actualMs: number, estMs: number) => `已 ${fmtDur(actualMs)}／預計 ${fmtDur(estMs)}`,
  /** 這一天的實績都是從前一天續過來的（沒有在窗內開始的塊）⇒ 開始那一半不比早晚（沙盒後修正 F4） */
  carried: "接續前一天",
  pendingNote: (n: number) => `（${n} 段待確認沒算）`,
  sep: "・",
} as const;

/** 「25 分」；一小時以上改 `fmtDur`（「1h25m」），免得出現「晚 660 分開始」 */
function minText(min: number): string {
  return min < 60 ? `${min} 分` : `${fmtDur(min * MIN)} `;
}

/* ───────────────────────── 1. 預定項 ───────────────────────── */

export interface PlanItem {
  /** `${date}-${nodeId}`（＝timeGridModel 的 key＝dayRowModel.key） */
  key: string;
  nodeId: string;
  date: string;
  kind: "single" | "repeat";
  /** 這一天的有效時刻（ScheduleEntry.time＝effectiveTime(node, date)）；null＝沒排 */
  time: ClockText | null;
  /** isTimeOverridden(node, date)：時刻來自這一班的覆寫（卡上「本班」） */
  overridden: boolean;
  /** 節點的預計分鐘（> 0 才算；0／null＝沒填） */
  estimateMin: number | null;
  done: boolean;
  skipped: boolean;
  /**
   * 誤點的單發票（使用者改題 D-時-80）：原執行日 `YYYY-MM-DD`；一般的預定項＝null。
   * 只在今天的日程有：`date`＝今天、`time`＝它原本的 `scheduled_time`；排上去＝執行日改到今天＋排時刻（`planTimeWrite`）。
   * 它不在當天的預定欄、不算進總結（`daySummary` 跳過），只在「還沒排」清單裡。
   */
  lateFrom: string | null;
}

/** ScheduleEntry（listCalendar 的一列）＋節點 → 預定項。節點找不到 ⇒ 沒有預計、沒有覆寫 */
export function planItemOf(e: ScheduleEntry, node: Pick<NodeRow, "estimate_min" | "time_overrides" | "repeat_rule"> | null | undefined): PlanItem {
  const est = node?.estimate_min ?? null;
  return {
    key: `${e.date}-${e.node_id}`,
    nodeId: e.node_id,
    date: e.date,
    kind: e.kind,
    time: e.time,
    overridden: e.kind === "repeat" && node != null ? isTimeOverridden(node, e.date) : false,
    estimateMin: typeof est === "number" && est > 0 ? est : null,
    done: e.is_done,
    skipped: e.occurrence_status === "skipped",
    lateFrom: null,
  };
}

/**
 * 今天的誤點（使用者改題 D-時-80）：今日列裡 `bucket === "late"`、還沒交代（不是 done）的那些，分兩堆——
 * - 單發票（沒有重複規則）＝做成 `PlanItem`（`lateFrom`＝原執行日、`date`＝今天、`time`＝原本的 `scheduled_time`），依今日列的順序；
 * - 定期券的漏班（有規則、這一班還沒有結局）＝只數（主線 `REPEAT_RESCHEDULE_MSG` 擋改執行日，不進清單）。
 * 只有締切過了、沒有執行日的列（bucket "due"）不在這裡。
 */
export function lateItemsOf(
  rows: readonly Pick<TodayRow, "id" | "bucket" | "status" | "repeat_rule" | "occurrence" | "scheduled_on" | "scheduled_time" | "estimate_min">[],
  today: string,
): { items: PlanItem[]; repeatCount: number } {
  const items: PlanItem[] = [];
  let repeatCount = 0;
  for (const r of rows) {
    if (r.bucket !== "late" || r.status === "done") continue;
    if (r.repeat_rule && r.repeat_rule.trim()) {
      if (r.occurrence === null) repeatCount++;
      continue;
    }
    if (!r.scheduled_on || r.scheduled_on >= today) continue;
    const est = r.estimate_min;
    items.push({
      key: `${today}-${r.id}`,
      nodeId: r.id,
      date: today,
      kind: "single",
      time: (r.scheduled_time as ClockText | null) ?? null,
      overridden: false,
      estimateMin: typeof est === "number" && est > 0 ? est : null,
      done: false,
      skipped: false,
      lateFrom: r.scheduled_on,
    });
  }
  return { items, repeatCount };
}

/* ───────────────────────── 2. 實績對預定 ───────────────────────── */

/**
 * D-時-81 改題後沒有「早」：提早開始也是 onTime（提早多少看刻度欄的金線）。
 * `carried`＝有實績、已結束，但都是從前一天續過來的塊（窗內沒有開始）⇒ 沒有開始可比，只比長短（沙盒後修正 F4）。
 */
export type PlanState = "upcoming" | "running" | "onTime" | "late" | "carried" | "notStarted" | "doneNoTime" | "skipped";

export interface PlanCompare {
  state: PlanState;
  /**
   * 第一塊**在這一天窗內開始**的（不算碎塊）真實開始 − 預定開始，取整分（對稱四捨五入）；
   * 沒實績、沒時刻、或實績全是從前一天續過來的（`carried`）＝null
   */
  startDeltaMin: number | null;
  /** 有時刻、有實績（不算碎塊），但沒有一塊在窗內開始＝全是從前一天續過來的（運行中也可能是 true；卡上開始那一半寫「接續前一天」） */
  carried: boolean;
  /** 實際（分，取整）− 預計；只在有預計、有實績、不是運行中時有值 */
  durDeltaMin: number | null;
  /** 窗內聯集、扣碎塊與待確認；運行中算到 now */
  actualMs: number;
  /** 連到這張、在窗內的待確認塊數（碎塊不算） */
  pendingCount: number;
  /** 描金用：連到這張、在窗內的塊 id（含碎塊與待確認），依開始時間 */
  blockIds: string[];
}

/** 實績那邊的一塊：Span＋連到的節點（只看 node_id；只連路線的＝null）＋待確認（store 用 blockIsLongRun 算好） */
export interface LinkedSpan extends Span {
  nodeId: string | null;
  pending: boolean;
}

const roundSym = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

function msWindow(date: string, h: number): { start: number; end: number } {
  const w = dayWindow(date, h);
  return { start: Date.parse(w.start), end: Date.parse(w.end) };
}

/** 這一塊跟窗相交（運行中到 now；零長度塊看開始落不落在窗內） */
function inWindow(s: Span, w: { start: number; end: number }, now: number): boolean {
  const end = s.end ?? Math.max(now, s.start);
  if (end <= s.start) return s.start >= w.start && s.start < w.end;
  return s.start < w.end && end > w.start;
}

/**
 * 一張預定項的實績（0-6）：那一天日界線窗內、`nodeId` 相同的塊（定期券的塊連系列本身，用窗切＝那一班）。
 * - 碎塊（整塊 < 60 秒、**已結束**的）不算開始也不算時長；運行中的塊不當碎塊（剛発車那一分鐘就該是「行駛中」）。
 * - 待確認算「開始」、不算時長；`pendingCount` 數它。
 * - 開始＝第一塊**在窗內開始**的那一塊的 `start`（沙盒後修正 F4，取代契約 0-6「續過來的用它自己的 started_at」）：
 *   從前一天跨日界線續過來的塊照樣算進這一天窗內的時長、照樣算「有實績」，但不當開始——
 *   不然前一天 01:00 起跑的塊會被算成隔天那班「早 24 小時開始＝準點」。
 *   這一天只有續過來的塊 ⇒ `startDeltaMin` null、`carried` true；已結束＝state `carried`（不算準點也不算晚），運行中照舊 `running`。
 */
export function comparePlan(item: PlanItem, spans: readonly LinkedSpan[], h: number, now: number): PlanCompare {
  const w = msWindow(item.date, h);
  const mine = spans
    .filter((s) => s.nodeId === item.nodeId && inWindow(s, w, now))
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const blockIds = mine.map((s) => s.id);
  const real = mine.filter((s) => s.end === null || durOf(s, now) >= SCHED_TINY_MS);
  const pendingCount = real.filter((s) => s.pending).length;
  const counted = real.filter((s) => !s.pending);
  const actualMs = sliceSpans(counted, w, now).reduce((t, x) => t + x.ms, 0); // ＝unionMs(counted, now, w)
  const running = real.some((s) => s.end === null);
  const has = real.length > 0;
  // 窗內開始的第一塊（real 已依開始排序；inWindow 保證開始 < 窗尾）
  const first = real.find((s) => s.start >= w.start) ?? null;
  const planned = item.time === null ? null : clockInstant(item.date, item.time);
  const carried = has && first === null && planned !== null; // 沒時刻的票本來就不比開始，不標
  const startDeltaMin = first !== null && planned !== null ? roundSym((first.start - planned) / MIN) : null;

  let state: PlanState;
  if (item.skipped) state = "skipped";
  else if (has && running) state = "running";
  else if (has && startDeltaMin !== null) state = startDeltaMin > ON_TIME_LATE_MIN ? "late" : "onTime";
  else if (carried) state = "carried"; // 只有續過來的塊：沒有開始可比，長短照算
  else if (has) state = "upcoming"; // 沒時刻的票有實績：不比早晚
  else if (item.done) state = "doneNoTime";
  else if (planned !== null && planned <= now) state = "notStarted";
  else state = "upcoming";

  // 只有待確認塊（沒有一塊算進時長）⇒ 不比長短：沒做少，只是還沒確認
  const durDeltaMin =
    item.estimateMin !== null && counted.length > 0 && !running && state !== "skipped" ? roundSym(actualMs / MIN) - item.estimateMin : null;
  return { state, startDeltaMin, carried, durDeltaMin, actualMs, pendingCount, blockIds };
}

/** 開始準點（onTime，或運行中而開始差 ≤ 10 分〔含任何提早〕） */
export function startOnTime(c: PlanCompare): boolean {
  if (c.state === "onTime") return true;
  return c.state === "running" && c.startDeltaMin !== null && c.startDeltaMin <= ON_TIME_LATE_MIN;
}

/** 有記到時間（0-6）：正在跑、或實際 ≥ 60 秒、或有待確認塊 */
function hasTime(c: PlanCompare | undefined): boolean {
  return c !== undefined && (c.state === "running" || c.actualMs >= SCHED_TINY_MS || c.pendingCount > 0);
}

export interface DaySummary {
  /** 排了＝有時刻（軸內、軸外都算）、不是運休、不是誤點項 */
  planned: number;
  /** 済＝排了的裡面蓋了済的 */
  stamped: number;
  /** 只記時間＝排了的裡面有記到時間（含正在跑、含待確認塊）但還沒蓋済的（與 stamped 互斥） */
  timedOnly: number;
  onTime: number;
  /** 排了的預計加總（分） */
  plannedMin: number;
  /** 排了裡沒預計的件數 */
  noEstimate: number;
}

/**
 * 當天總結（D-時-83；使用者改題 00:1x：済與「有時間但沒章」分開）：済／只記時間／準點只數「排了」的那些。
 * 未來的日子済、只記時間、準點恆 0（畫面只印「排了 N 件・共 X」）。誤點項（`lateFrom`）不是這一天排的，不算。
 */
export function daySummary(items: readonly PlanItem[], cmp: ReadonlyMap<string, PlanCompare>, isFuture: boolean): DaySummary {
  const s: DaySummary = { planned: 0, stamped: 0, timedOnly: 0, onTime: 0, plannedMin: 0, noEstimate: 0 };
  for (const it of items) {
    if (it.time === null || it.skipped || it.lateFrom) continue;
    s.planned++;
    if (it.estimateMin !== null) s.plannedMin += it.estimateMin;
    else s.noEstimate++;
    if (isFuture) continue;
    const c = cmp.get(it.key);
    if (it.done) s.stamped++;
    else if (hasTime(c)) s.timedOnly++;
    if (c && startOnTime(c)) s.onTime++;
  }
  return s;
}

/**
 * 卡旁的差多少（§5.6）：開始那一段＋「・」＋長短那一段，待確認補在最後；upcoming／skipped ⇒ null。
 * 例：「晚 25 分開始・多花 40m」「準點」「行駛中・晚 5 分開始・已 40m／預計 1h」「済・沒記時間」「還沒開始」「接續前一天・少 15m」。
 */
export function fmtPlanDelta(c: PlanCompare, estimateMin: number | null): string | null {
  if (c.state === "upcoming" || c.state === "skipped") return null;
  const parts: string[] = [];
  const d = c.startDeltaMin;
  switch (c.state) {
    case "onTime":
      parts.push(PLAN_TEXT.onTime);
      break;
    case "late":
      parts.push(PLAN_TEXT.lateStart(d ?? 0));
      break;
    case "running":
      parts.push(PLAN_TEXT.running);
      if (d !== null) parts.push(d > ON_TIME_LATE_MIN ? PLAN_TEXT.lateStart(d) : PLAN_TEXT.onTime);
      else if (c.carried) parts.push(PLAN_TEXT.carried);
      break;
    case "carried":
      parts.push(PLAN_TEXT.carried);
      break;
    case "notStarted":
      parts.push(PLAN_TEXT.notStarted);
      break;
    case "doneNoTime":
      parts.push(PLAN_TEXT.doneNoTime);
      break;
  }
  const est = typeof estimateMin === "number" && estimateMin > 0 ? estimateMin : null;
  if (c.state === "running") {
    if (est !== null) parts.push(PLAN_TEXT.soFar(c.actualMs, est * MIN));
  } else if (c.durDeltaMin !== null) {
    if (c.durDeltaMin >= DUR_SAME_MIN) parts.push(PLAN_TEXT.over(c.durDeltaMin * MIN));
    else if (c.durDeltaMin <= -DUR_SAME_MIN) parts.push(PLAN_TEXT.under(-c.durDeltaMin * MIN));
  }
  let out = parts.join(PLAN_TEXT.sep);
  if (c.pendingCount > 0) out += PLAN_TEXT.pendingNote(c.pendingCount);
  return out;
}

/* ───────────────────────── 3. 寫入規劃（0-5） ───────────────────────── */

export type TimeWrite =
  /** scheduledOn（選填）＝順便把執行日改到這一天（誤點項：排＝改到今天、撤回＝改回原日；執行器一次 `updateNode`） */
  | { op: "setTime"; id: string; time: ClockText | null; scheduledOn?: string }
  | { op: "setRun"; id: string; date: string; time: ClockText | null }
  | { op: "clearRun"; id: string; date: string };

/**
 * 單發票＝改 `scheduled_time`；定期券＝只改這一班（`setRunTime`；清除＝`setRun` 帶 null＝「這一班沒有時刻」，D-時-73）。
 * 誤點項（`lateFrom`）＝執行日改到 `item.date`（今天）＋排時刻（D-時-80 改題）。
 */
export function planTimeWrite(item: PlanItem, time: ClockText | null): TimeWrite {
  if (item.kind === "repeat") return { op: "setRun", id: item.nodeId, date: item.date, time };
  if (item.lateFrom) return { op: "setTime", id: item.nodeId, time, scheduledOn: item.date };
  return { op: "setTime", id: item.nodeId, time };
}

/**
 * 撤回（依寫入「之前」的 item）：單發票寫回舊值；定期券改之前就是覆寫 ⇒ 寫回舊覆寫（可能是 null），不是 ⇒ 清掉這一班的覆寫。
 * 誤點項＝執行日改回原日＋時刻寫回原本的（已知限制：`reschedule` 動過的繰越／今日序回不去，見施工回報〈使用者改題〉）。
 */
export function planUndo(item: PlanItem): TimeWrite {
  if (item.kind === "single" && item.lateFrom) return { op: "setTime", id: item.nodeId, time: item.time, scheduledOn: item.lateFrom };
  if (item.kind === "repeat") {
    return item.overridden
      ? { op: "setRun", id: item.nodeId, date: item.date, time: item.time }
      : { op: "clearRun", id: item.nodeId, date: item.date };
  }
  return { op: "setTime", id: item.nodeId, time: item.time };
}

/**
 * 撤回寫得回去嗎：要寫回的舊時刻在現在的日界線下不合法（軸外的票，例如日界線 01:00 時存的 24:30、後來改成 00:00）
 * ⇒ repository 的 assertClockWritable 會拒收 ⇒ 這筆不提供撤回、只出收據（要真的寫回軸外的值得主線放寬守門）。
 * clearRun 不寫時刻，永遠寫得回去。
 */
export function undoWritable(undo: TimeWrite, h: number): boolean {
  if (undo.op === "clearRun" || undo.time === null) return true;
  return isClockInRange(undo.time, h);
}

/* ───────────────────────── 4. 軸上的小工具 ───────────────────────── */

/** 四捨五入到 step 分（預設 15，D-時-78） */
export function snapClockMin(min: number, step: number = SNAP_MIN): number {
  const s = step > 0 ? step : 1;
  return Math.round(min / s) * s;
}

/** 自這一天 00:00 起的牆鐘分鐘 ⇒ 營業日表記（1515 ⇒ "25:15"）。非整數先四捨五入；夾在 [0, 5999] */
export function clockOfAxisMin(min: number): ClockText {
  const m = Math.min(5999, Math.max(0, Math.round(Number.isFinite(min) ? min : 0)));
  return clockText(m) as ClockText;
}

/** 這一天能不能排（D-時-79：今天和以後） */
export function canScheduleDay(date: string, todayKey: string): boolean {
  return date >= todayKey;
}
