/**
 * timetableScheduleStore——時刻表線④「日程」的資料與排時刻（④ 契約 §3.2、0-4、0-5、0-6；甲席）。
 *
 * **讀**：日程頁開著（`attach()` 之後）才載；天＝`timetableStore.dayKey`（跟軸共用）。
 *   `nodeRepo.listCalendar(d, d, { todayDateKey, dayStartHour })` → 主線純函式 `timeGridModel`（預定那一邊跟主線行程表時段視圖一把尺）。
 *   **不叫** `nodeStore.loadCalendar`（會換掉行程表與日曆共用的唯一切片）、**不叫** `syncRepeats`（那是寫入；nodeStore 自己會跑）。
 *   重算合併成一趟（dirty 迴圈）；重算期間舊結果留著、不閃空；算到一半天或日界線變了 ⇒ 這份作廢（下一趟已排好）。
 * **訂閱**（開著時）：`timetableStore.dayKey`／`todayKey`、`uiStore.dayStartHour`、`nodeStore.today`／`tree`／`calendar`
 *   （nodeStore 每次寫入成功都 `refresh()` ⇒ `loadToday` 一定換掉 `today`；選了路線時 `reloadRoute` 換掉 `tree`——④ 契約 §9-2 讀碼確認）。
 *   時刻表的 `rev` 不用訂：實績直接讀 `timetableStore.dayBlocks`（`useScheduleCompare`）。
 * **寫**（`placeAt`）：只走主線 nodeStore 既有入口（單發票 `updateNode({scheduled_time})`、定期券這一班 `setRunTime`／`clearRunTime`）；
 *   守門 → 拍撤回 → 執行 → 收據 toast＋「撤回」；失敗時 nodeStore 已 toast，這裡不再 toast（toast 只有一格）。同一時間只有一筆寫入在飛。
 * **誤點**（使用者改題 D-時-80）：今天的日程另從 `nodeStore.today.rows` 取誤點的單發票（`lateItemsOf`）塞進 `items`、
 *   今日切片不是今天（直接進日程、或今天換日）⇒ 先 `loadToday(今天)`（`ensureTodaySlice`；沙盒後修正 F1）；
 *   key 照 `${今天}-${id}`、依序記在 `lateKeys`（「還沒排」排在當天的票之後）；排上去＝`updateNode({ scheduled_on: 今天, scheduled_time })`
 *   一次呼叫（主線先改道 reschedule 再寫時刻），撤回＝改回原日＋原時刻。定期券的漏班只數（`lateRepeatCount`）。
 * **⑦ 車票第二段起**（D-時-162；C 席）：compute 另讀 `timetablePlanStore.slotsForDay(那天)`（沒載過先 `loadDays`）做成 `slots`
 *   （key `${date}-${nodeId}-seg-${planId}`；票不在 listCalendar 裡就 `getNode`，刪了＝不畫、蓋済＝段也済），跟第一段一起排 lane 成 `blocks`。
 *   對照：同一天有好幾段的票，連到它的塊用 `assignSpansToSegments` 分給各段；總結照舊只數 `items`（算張數）。
 *   寫入走 plan store（`moveSlot`／`addSegment`，同一把 `locked`、收據＋撤回）；`picked` 也可以是段的 key（換位置）或 `addSegKey(nodeId)`（再排一段）。
 */
import { useMemo } from "react";
import { create } from "zustand";
import { nodeRepo } from "../data";
import type { NodeRow } from "../domain/node";
import { toSpan, type TimeBlockRow } from "../domain/timetable";
import {
  canScheduleDay,
  comparePlan,
  daySummary,
  lateItemsOf,
  planItemOf,
  planTimeWrite,
  planUndo,
  undoWritable,
  type DaySummary,
  type LinkedSpan,
  type PlanCompare,
  type PlanItem,
  type TimeWrite,
} from "../domain/timetableSchedule";
import { TIME_FORMAT_MSG } from "../domain/scheduledTime";
import { clockMinutes, clockText, isClockInRange, todayKey, type ClockText } from "../lib/date";
import { timeGridModel, type TimeGridDay } from "../ui/schedule/timeGridModel";
import { schedBlocksOf, segmentSpansOf, slotItemsOf, type SchedBlock, type SlotItem } from "../ui/timetable/schedule/slotModel";
import { useNodeStore } from "./nodeStore";
import { TT_TEXT, blockIsLongRun, useTimetableStore } from "./timetableStore";
import { useTimetablePlanStore, type TimePlanRow } from "./timetablePlanStore";
import { useUiStore } from "./uiStore";

export type { DaySummary, LinkedSpan, PlanCompare, PlanItem, PlanState, TimeWrite } from "../domain/timetableSchedule";

export interface ScheduleHover {
  kind: "plan" | "block";
  /** plan＝預定項 key；block＝時間塊 id */
  id: string;
}

export type { SchedBlock, SlotItem } from "../ui/timetable/schedule/slotModel";

/** ⑦ C 席：「再排一段」挑位置時 `picked` 放的記號（不是預定項的 key） */
const ADD_SEG = "addseg:";
export const addSegKey = (nodeId: string): string => ADD_SEG + nodeId;
export const addSegNode = (key: string | null): string | null => (key && key.startsWith(ADD_SEG) ? key.slice(ADD_SEG.length) : null);

export interface ScheduleState {
  /** 這份資料是哪一天（＝算的時候的 timetableStore.dayKey） */
  date: string;
  loading: boolean;
  error: string | null;
  /** timeGridModel 的那一天（blocks＝軸內有時刻、untimed＝沒時刻＋軸外）；還沒載過＝null */
  grid: TimeGridDay | null;
  /** key → 預定項（軸內、軸外、沒時刻都在；済／運休也在；今天另有誤點的單發票，`lateFrom` 不是 null） */
  items: Record<string, PlanItem>;
  /** 今天的誤點單發票的 key，依今日列的順序（「還沒排」排在當天的票之後；其他天空） */
  lateKeys: string[];
  /** listCalendar 的節點表（名稱、路線、預計）＋誤點單發票的節點（今日列） */
  nodes: Record<string, NodeRow>;
  /** 今天另有幾班定期券漏班、還沒交代（不進清單，只出一行灰字；只有 date＝今天；其他天 0） */
  lateRepeatCount: number;
  /** ⑦：key → 車票的第二段起（這一天；票刪掉的不在，D-時-162） */
  slots: Record<string, SlotItem>;
  /** ⑦：預定欄要畫的卡（第一段＋第二段起，同一套 lane），依開始 */
  blocks: SchedBlock[];
  /** 點選排時刻：選中的還沒排項（key）；⑦ 起也可以是第二段起的卡（slots 的 key＝換位置）或 `addSegKey(nodeId)`（再排一段） */
  picked: string | null;
  hover: ScheduleHover | null;
  /** 有一筆排時刻的寫入正在飛（重入鎖；UI 可以據此把拖曳／按鈕暫時停用） */
  busy: boolean;

  /** 重算一次（開著時訂閱會自己叫；回傳的 promise 在這一輪〔含合併進來的重算〕算完時 resolve） */
  load(): Promise<void>;
  /** 日程頁掛上時叫；回傳的函式在離開時叫（停止自動重算、清掉 picked／hover） */
  attach(): () => void;
  pick(key: string | null): void;
  setHover(h: ScheduleHover | null): void;
  /** 排、改、清都走這支（time null＝清除）：守門、收據 toast、撤回。回 true＝寫成功（或時刻沒變、不必寫） */
  placeAt(key: string, time: ClockText | null): Promise<boolean>;
  /** ⑦：第二段起換位置（time＝新的開始；長度不變）：收據＋撤回 */
  moveSlot(key: string, time: ClockText): Promise<boolean>;
  /** ⑦：再排一段（挑位置放下；長度＝預計，沒填 60 分）：收據＋撤回 */
  addSegment(nodeId: string, time: ClockText): Promise<boolean>;
  /** 定期券「改回每班時刻」（＝clearRun 這一班的覆寫）：同一把鎖、收據＋撤回、寫完重載。不是覆寫過的定期券 ⇒ false */
  revertRun(key: string): Promise<boolean>;
}

/* ───────── 模組層狀態 ───────── */

let attachCount = 0;
let running: Promise<void> | null = null;
let dirty = false;
/** compute 開跑幾次了（attach 等今日切片時用：載完那一刻若訂閱已經排過一趟，就不再補） */
let computeSeq = 0;
/** 正在補載的今日切片（同一天只叫一次 loadToday；StrictMode 雙掛載、todayKey 與日界線兩支訂閱同時到都只載一趟） */
let todayLoad: { key: string; p: Promise<void> } | null = null;
/** 正在飛的那一筆寫入（重入鎖；null＝沒有） */
let writing: Promise<boolean> | null = null;

const dayStart = (): number => useUiStore.getState().dayStartHour;

const toast = (message: string, actionLabel?: string, onAction?: () => void): void =>
  useUiStore.getState().showToast(actionLabel ? { message, actionLabel, onAction } : { message });

/** 今天的誤點（從 nodeStore.today 取；不是今天、或今日切片不是今天 ⇒ 空） */
function lateOf(date: string, today: string): { items: PlanItem[]; repeatCount: number; rows: Record<string, NodeRow> } {
  const none = { items: [], repeatCount: 0, rows: {} };
  if (date !== today) return none;
  const t = useNodeStore.getState().today;
  if (t.dateKey !== today) return none;
  const late = lateItemsOf(t.rows, today);
  const rows: Record<string, NodeRow> = {};
  for (const it of late.items) {
    const r = t.byId[it.nodeId];
    if (r) rows[it.nodeId] = r;
  }
  return { ...late, rows };
}

/**
 * 誤點那一行要今日切片是今天（沙盒後修正 F1）：`nodeStore.today` 停在前一天 ⇒ `lateOf` 回空、誤點清單是空的。
 * attach、今天換日（`todayKey` 變了＝開著跨過日界線或改了日界線）、日界線變了都叫；切片已是今天 ⇒ null。
 * 載完 `nodeStore.today` 換參照 ⇒ 下面的訂閱會重算（不用自己再排）。
 */
function ensureTodaySlice(): Promise<void> | null {
  const today = todayKey(dayStart(), new Date());
  const ns = useNodeStore.getState();
  if (ns.today.dateKey === today) return null;
  if (todayLoad?.key === today) return todayLoad.p;
  const p: Promise<void> = ns.loadToday(today).finally(() => {
    if (todayLoad?.p === p) todayLoad = null;
  });
  todayLoad = { key: today, p };
  return p;
}

/* ───────── ⑦ C 席：車票的第二段起 ───────── */

/** compute 自己在載 time_plans（訂閱看到 rowsByDay 換了不必再排一趟：compute 載完就讀最新的） */
let selfPlanLoad = 0;

/** 訂閱用：這一天的車票段有沒有變（作息段的寫入不必重抓 listCalendar） */
function slotSig(rows: readonly TimePlanRow[] | undefined): string {
  if (!rows) return "";
  return rows
    .filter((r) => r.node_id !== null)
    .map((r) => `${r.id}|${r.updated_at}|${r.deleted_at ?? ""}|${r.start_hm}|${r.end_hm}`)
    .join(",");
}

async function compute(): Promise<void> {
  computeSeq++;
  const date = useTimetableStore.getState().dayKey;
  const h = dayStart();
  const today = todayKey(h, new Date());
  useTimetableScheduleStore.setState({ loading: true });
  try {
    const data = await nodeRepo.listCalendar(date, date, { todayDateKey: today, dayStartHour: h });
    // 算的期間天或日界線換了 ⇒ 這份作廢（訂閱已經把 dirty 打上，下一趟會重抓）
    if (useTimetableStore.getState().dayKey !== date || dayStart() !== h) {
      dirty = true;
      return;
    }
    const grid = timeGridModel({ days: [date], entries: data.entries, dues: data.dues, nodes: data.nodes, dayStartHour: h })[0] ?? null;
    const items: Record<string, PlanItem> = {};
    for (const e of data.entries) {
      if (e.date !== date) continue;
      const it = planItemOf(e, data.nodes[e.node_id]);
      items[it.key] = it;
    }
    // 誤點的單發票接在後面；同一張已經在這一天的 listCalendar 裡（剛排上來、今日切片還沒換）⇒ 以 listCalendar 為準
    const late = lateOf(date, today);
    const lateKeys: string[] = [];
    for (const it of late.items) {
      if (items[it.key]) continue;
      items[it.key] = it;
      lateKeys.push(it.key);
    }
    // ⑦：第二段起（time_plans）——那一天沒載過就先載（作息帶也用同一份）；票不在這一天的 listCalendar ⇒ 另查節點（刪了＝不畫）
    const nodes: Record<string, NodeRow> = { ...late.rows, ...data.nodes };
    if (!(date in useTimetablePlanStore.getState().rowsByDay)) {
      selfPlanLoad++;
      try {
        await useTimetablePlanStore.getState().loadDays(date, date);
      } finally {
        selfPlanLoad--;
      }
    }
    const slotRows = useTimetablePlanStore.getState().slotsForDay(date);
    for (const id of new Set(slotRows.map((r) => r.node_id as string))) {
      if (nodes[id]) continue;
      const n = await nodeRepo.getNode(id).catch(() => null);
      if (n && n.deleted_at === null) nodes[id] = n;
    }
    if (useTimetableStore.getState().dayKey !== date || dayStart() !== h) {
      dirty = true;
      return;
    }
    const slots = slotItemsOf(date, slotRows, nodes, items);
    const cur = useTimetableScheduleStore.getState();
    useTimetableScheduleStore.setState({
      date,
      grid,
      items,
      slots,
      blocks: schedBlocksOf(grid, slots, h),
      lateKeys,
      nodes,
      lateRepeatCount: late.repeatCount,
      // 換了天或那一項不在了 ⇒ 選取／滑過清掉
      picked:
        cur.picked !== null && (items[cur.picked] || slots[cur.picked] || addSegNode(cur.picked) !== null) && cur.date === date ? cur.picked : null,
      hover: cur.date === date ? cur.hover : null,
      loading: false,
      error: null,
    });
  } catch (e) {
    useTimetableScheduleStore.setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** 排一趟：正在算 ⇒ 標記「算完再來一趟」並回同一個 promise */
function run(): Promise<void> {
  if (running) {
    dirty = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        dirty = false;
        await compute();
      } while (dirty && attachCount > 0);
    } finally {
      running = null;
      if (attachCount === 0) useTimetableScheduleStore.setState({ loading: false });
    }
  })();
  return running;
}

/**
 * 上游變了：開著 ⇒ 排一趟；關著但還有一趟在算 ⇒ 標 dirty（那一趟的輸入可能已經舊了；
 * 馬上又掛上時迴圈會再算一趟——attach 看到有一趟在算就不另排，靠的是這個）
 */
function reloadIfOpen(): void {
  if (attachCount > 0) void run();
  else if (running) dirty = true;
}

/**
 * 執行器（§3.2）：寫入規劃 → nodeStore 既有入口。成功時 nodeStore 會自己 refresh（today 換掉 ⇒ 訂閱重載）。
 * 失敗時 nodeStore 已 toast，回 false。
 */
export async function runTimeWrite(w: TimeWrite): Promise<boolean> {
  const ns = useNodeStore.getState();
  let r: { ok: boolean };
  // 誤點項：執行日＋時刻（＋撤回時的 carried_from）一次呼叫（updateNode 先改道 reschedule、再把其餘欄位當一般欄位寫，nodeStore.ts updateNode；同今日頁撤回）
  if (w.op === "setTime" && w.scheduledOn !== undefined && w.carriedFrom !== undefined) {
    r = await ns.updateNode(w.id, { scheduled_on: w.scheduledOn, scheduled_time: w.time, carried_from: w.carriedFrom });
  } else if (w.op === "setTime" && w.scheduledOn !== undefined) r = await ns.updateNode(w.id, { scheduled_on: w.scheduledOn, scheduled_time: w.time });
  else if (w.op === "setTime") r = await ns.updateNode(w.id, { scheduled_time: w.time });
  else if (w.op === "setRun") r = await ns.setRunTime(w.id, w.date, w.time);
  else r = await ns.clearRunTime(w.id, w.date);
  return r.ok;
}

/**
 * 一筆寫入（含撤回）都包在鎖裡；寫完不論成敗都重抓一次（nodeStore 沒換參照時的保險；合併進 dirty 迴圈）。
 * 有一筆在飛：一般寫入直接回 false（拖、按鈕在 busy 時本來就停用）；`wait`（撤回）⇒ 排在後面、等前一筆寫完再跑，
 * 不默默吃掉（toast 的撤回按下去 toast 就收了，吃掉＝使用者以為撤回了）。
 */
function locked(fn: () => Promise<boolean>, wait = false): Promise<boolean> {
  if (writing) {
    if (!wait) return Promise.resolve(false);
    const again = (): Promise<boolean> => locked(fn, true);
    return writing.then(again, again);
  }
  useTimetableScheduleStore.setState({ busy: true });
  const p = (async () => {
    try {
      return await fn();
    } finally {
      writing = null;
      useTimetableScheduleStore.setState({ busy: false });
      reloadIfOpen();
    }
  })();
  writing = p;
  return p;
}

/**
 * 寫一筆時刻＋收據 toast＋「撤回」（placeAt 與面板的「改回」共用；撤回再走一次執行器、不再出撤回，失敗 nodeStore 會 toast）。
 * 撤回寫不回去（舊時刻在現在的日界線外＝軸外的票）⇒ 收據補一句、不出撤回（`undoWritable`）。
 * `after`＝寫成功、出收據之前要做的事（例如清掉 picked）。
 */
export function runScheduleWrite(w: TimeWrite, undo: TimeWrite, msg: string, after?: () => void): Promise<boolean> {
  return locked(async () => {
    const ok = await runTimeWrite(w);
    if (!ok) return false; // nodeStore 已 toast
    after?.();
    if (undoWritable(undo, dayStart())) toast(msg, TT_TEXT.undo, () => void locked(() => runTimeWrite(undo), true));
    else toast(msg + TT_TEXT.schedNoUndo(undo.op === "clearRun" ? "" : (undo.time ?? "")));
    return true;
  });
}

/* ───────── store ───────── */

export const useTimetableScheduleStore = create<ScheduleState>((set, get) => ({
  date: useTimetableStore.getState().dayKey,
  loading: false,
  error: null,
  grid: null,
  items: {},
  lateKeys: [],
  nodes: {},
  lateRepeatCount: 0,
  slots: {},
  blocks: [],
  picked: null,
  hover: null,
  busy: false,

  load() {
    return run();
  },

  attach() {
    attachCount++;
    // 誤點那一行要今日切片：直接進日程頁、沒去過今日頁 ⇒ 先載今日切片再算（同 TodayTickets 的做法）。
    // 不跟 listCalendar 並行：並行的話切片載完、today 換參照，訂閱又排一趟 ⇒ 進一次頁 listCalendar 兩趟（沙盒觀察二）。
    // 載完 today 換參照 ⇒ 訂閱排那一趟；載失敗（today 沒換）⇒ 這裡補一趟。
    const slice = ensureTodaySlice();
    if (slice) {
      const seq = computeSeq;
      set({ loading: true });
      void slice.then(() => {
        if (running || computeSeq !== seq) return;
        if (attachCount > 0) void run();
        else set({ loading: false }); // 載完前就離開了：別讓 loading 卡在 true
      });
    } else if (!running) {
      // 已經有一趟在算（StrictMode 雙掛載的第二次 attach、或剛離開又馬上回來）⇒ 不另排：
      // 輸入沒變就是同一份；離開期間上游變了的話 reloadIfOpen 已經把 dirty 打上，迴圈會再算一趟
      void run();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      attachCount = Math.max(0, attachCount - 1);
      if (attachCount === 0) set({ picked: null, hover: null });
    };
  },

  pick(key) {
    set({ picked: key });
  },

  setHover(h) {
    const cur = get().hover;
    if (cur === h || (cur !== null && h !== null && cur.kind === h.kind && cur.id === h.id)) return;
    set({ hover: h });
  },

  placeAt(key, time) {
    const item = get().items[key];
    if (!item) return Promise.resolve(false); // 資料還沒到（或那一項已經不在這一天）
    const h = dayStart();
    if (!canScheduleDay(item.date, todayKey(h, new Date()))) {
      toast(TT_TEXT.schedPast);
      return Promise.resolve(false);
    }
    if (time !== null && !isClockInRange(time, h)) {
      toast(TIME_FORMAT_MSG);
      return Promise.resolve(false);
    }
    // 誤點項：排＝改到今天＋排時刻，一定要有時刻（清掉沒有意義：它本來就不在這一天的預定欄）
    if (item.lateFrom && time === null) return Promise.resolve(false);
    if (time === item.time && !item.lateFrom) {
      // 沒變：不寫（定期券寫了等於多一筆同值的「本班」覆寫，之後改每班時刻就跟不上）。誤點項時刻一樣也要寫（執行日要改）
      if (get().picked === key) set({ picked: null });
      return Promise.resolve(true);
    }
    const msg =
      item.lateFrom && time !== null
        ? TT_TEXT.schedLateMoved(time)
        : time === null
          ? TT_TEXT.schedCleared
          : item.time === null
            ? TT_TEXT.schedPlaced(time)
            : TT_TEXT.schedMoved(time);
    return runScheduleWrite(planTimeWrite(item, time), planUndo(item), msg, () => {
      if (get().picked === key) set({ picked: null });
    });
  },

  revertRun(key) {
    const item = get().items[key];
    if (!item || item.kind !== "repeat" || !item.overridden || item.skipped) return Promise.resolve(false);
    const h = dayStart();
    if (!canScheduleDay(item.date, todayKey(h, new Date()))) {
      toast(TT_TEXT.schedPast);
      return Promise.resolve(false);
    }
    const every = get().nodes[item.nodeId]?.scheduled_time ?? null;
    // 同一把鎖、同一套收據／撤回（撤回＝planUndo：寫回這一班原本的覆寫；舊覆寫在日界線外 ⇒ 不出撤回）；寫完 locked() 會重載
    return runScheduleWrite(
      { op: "clearRun", id: item.nodeId, date: item.date },
      planUndo(item),
      every ? TT_TEXT.schedReverted(every) : TT_TEXT.schedRevertedNone,
    );
  },

  moveSlot(key, time) {
    const it = get().slots[key];
    if (!it) return Promise.resolve(false);
    const h = dayStart();
    if (!canScheduleDay(it.date, todayKey(h, new Date()))) {
      toast(TT_TEXT.schedPast);
      return Promise.resolve(false);
    }
    const s = clockMinutes(time);
    if (s === null || !isClockInRange(time, h)) {
      toast(TIME_FORMAT_MSG);
      return Promise.resolve(false);
    }
    if (time === it.time) {
      if (get().picked === key) set({ picked: null });
      return Promise.resolve(true);
    }
    return locked(async () => {
      // 長度在 plan store 的寫入鎖裡照資料庫現在的算（keepLength）：剛改的「結束」還在佇列裡也不會被舊長度蓋回去（反方評審 #5）
      const out: { prev?: { s: ClockText; e: ClockText } } = {};
      const ok = await useTimetablePlanStore.getState().editSlot(it.planId, { s: time, keepLength: true }, out);
      if (!ok) return false; // plan store 已 toast
      if (get().picked === key) set({ picked: null });
      const back = out.prev;
      if (back) toast(TT_TEXT.schedMoved(time), TT_TEXT.undo, () => void useTimetablePlanStore.getState().editSlot(it.planId, back));
      else toast(TT_TEXT.schedMoved(time));
      return true;
    });
  },

  addSegment(nodeId, time) {
    const date = get().date;
    const h = dayStart();
    if (!canScheduleDay(date, todayKey(h, new Date()))) {
      toast(TT_TEXT.schedPast);
      return Promise.resolve(false);
    }
    const s = clockMinutes(time);
    if (s === null || !isClockInRange(time, h)) {
      toast(TIME_FORMAT_MSG);
      return Promise.resolve(false);
    }
    const est = get().nodes[nodeId]?.estimate_min ?? null;
    const len = typeof est === "number" && est > 0 ? est : SEG_DEFAULT_MIN;
    const e = clockText(Math.min(s + len, h * 60 + 1440));
    if (!e) return Promise.resolve(false);
    return locked(async () => {
      const row = await useTimetablePlanStore.getState().addSlot(nodeId, date, time, e);
      if (!row) return false;
      const key = addSegKey(nodeId);
      if (get().picked === key) set({ picked: null });
      toast(SEG_TEXT.added(time, e), TT_TEXT.undo, () => void useTimetablePlanStore.getState().deleteSlot(row.id));
      return true;
    });
  },
}));

/** ⑦：再排一段沒填預計時的長度（契約 §4） */
export const SEG_DEFAULT_MIN = 60;

/** ⑦ C 席：車票分段的字（收據、面板） */
export const SEG_TEXT = {
  tag: (n: number) => `第 ${n} 段`,
  added: (s: string, e: string) => `已再排一段 ${s}–${e}`,
  deleted: "已刪除這段",
} as const;

/* ───────── 給 UI 的 selector／hook ───────── */

/** 時間塊列 → 實績那邊的一塊（只看 node_id；待確認＝`blockIsLongRun`，與軸、統計同一把門檻） */
export function scheduleSpansOf(
  rows: readonly TimeBlockRow[],
  tt: Pick<ReturnType<typeof useTimetableStore.getState>, "catById" | "longRunMaxMin" | "linkInfo">,
  now: number,
): LinkedSpan[] {
  return rows.map((r) => ({
    ...toSpan(r),
    nodeId: r.node_id,
    pending: blockIsLongRun(r, tt.catById, tt.longRunMaxMin, now, tt.linkInfo),
  }));
}

export interface ScheduleCompare {
  /** 這一天的預定項，依時刻（沒時刻的在後）→ key */
  items: PlanItem[];
  /** key → 差多少（每一項都有，含沒時刻的） */
  cmp: ReadonlyMap<string, PlanCompare>;
  summary: DaySummary;
  isFuture: boolean;
  /** 今天以後才能排（D-時-79） */
  canEdit: boolean;
  /** 時間塊 id → 它連到的這一天的預定項 key（實績塊滑過時點亮預定卡用；沒連到這天的票＝不在表裡） */
  planKeyOfBlock: ReadonlyMap<string, string>;
}

/** 純函式版（hook 之外也能用；now 由呼叫端給，UI 用 useNow） */
export function scheduleCompareOf(
  s: Pick<ScheduleState, "date" | "items"> & Partial<Pick<ScheduleState, "slots">>,
  rows: readonly TimeBlockRow[],
  tt: Pick<ReturnType<typeof useTimetableStore.getState>, "catById" | "longRunMaxMin" | "linkInfo">,
  h: number,
  now: number,
): ScheduleCompare {
  const today = todayKey(h, new Date(now));
  const items = Object.values(s.items).sort(
    (a, b) =>
      (a.time === null ? 1 : 0) - (b.time === null ? 1 : 0) ||
      (a.time !== null && b.time !== null ? (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const slots = Object.values(s.slots ?? {});
  const spans = scheduleSpansOf(rows, tt, now);
  const segSpans = segmentSpansOf(items, slots, spans, now);
  const cmp = new Map<string, PlanCompare>();
  const planKeyOfBlock = new Map<string, string>();
  // ⑦：第二段起也比（key 不同；總結的「排了 N 件」算張數，契約 §4——只有第二段起的票也算一件，沙盒 F-2）
  for (const it of slots) {
    const c = comparePlan(it, segSpans.get(it.key) ?? spans, h, now);
    cmp.set(it.key, c);
    for (const id of c.blockIds) planKeyOfBlock.set(id, it.key);
  }
  for (const it of items) {
    const c = comparePlan(it, segSpans.get(it.key) ?? spans, h, now);
    cmp.set(it.key, c);
    // 誤點項沒有預定卡（只在「還沒排」）：連到它的塊不點亮任何卡，免得滑過時整欄淡掉
    if (!it.lateFrom) for (const id of c.blockIds) planKeyOfBlock.set(id, it.key);
  }
  const isFuture = s.date > today;
  return { items, cmp, summary: daySummary(items, cmp, isFuture, slots), isFuture, canEdit: canScheduleDay(s.date, today), planKeyOfBlock };
}

/** 日程頁用：每個預定項的差多少＋總結（now 由 UI 給，例如 `useNow(60_000)`） */
export function useScheduleCompare(now: number): ScheduleCompare {
  const date = useTimetableScheduleStore((s) => s.date);
  const items = useTimetableScheduleStore((s) => s.items);
  const slots = useTimetableScheduleStore((s) => s.slots);
  const rows = useTimetableStore((s) => s.dayBlocks);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const h = useUiStore((s) => s.dayStartHour);
  return useMemo(
    () => scheduleCompareOf({ date, items, slots }, rows, { catById, longRunMaxMin, linkInfo }, h, now),
    [date, items, slots, rows, catById, longRunMaxMin, linkInfo, h, now],
  );
}

/** 面板的「発車」（§5.5、D-時-39；④ 契約 §9-4）：済／運休不出。正在跑那張照樣交給 departFromTask（它自己吐「已經在跑了」） */
export function canDepartPlan(item: PlanItem): boolean {
  return !item.done && !item.skipped;
}

export function departFromPlan(key: string): void {
  const item = useTimetableScheduleStore.getState().items[key];
  if (!item || !canDepartPlan(item)) return;
  void useTimetableStore.getState().departFromTask(item.nodeId);
}

/* ───────── 模組層訂閱：開著的期間，上游變了就重算 ───────── */

useTimetableStore.subscribe((s, p) => {
  // 今天換日（開著跨過日界線、或改了日界線）⇒ 今日切片也要換到新的今天，不然誤點清單是空的（F1）
  if (s.todayKey !== p.todayKey && attachCount > 0) ensureTodaySlice();
  if (s.dayKey !== p.dayKey || s.todayKey !== p.todayKey) reloadIfOpen();
});

useUiStore.subscribe((s, p) => {
  if (s.dayStartHour !== p.dayStartHour) {
    if (attachCount > 0) ensureTodaySlice(); // 同上（timetableStore 的 todayKey 要等它 refresh 完才換；這裡先補）
    reloadIfOpen();
  }
});

// ⑦：這一天的車票段變了（再排一段、換位置、刪、同步）⇒ 重算；作息段的寫入不算（slotSig 只看車票段）
useTimetablePlanStore.subscribe((s, p) => {
  if (attachCount === 0 || selfPlanLoad > 0 || s.rowsByDay === p.rowsByDay) return;
  const d = useTimetableStore.getState().dayKey;
  if (s.rowsByDay[d] !== p.rowsByDay[d] && slotSig(s.rowsByDay[d]) !== slotSig(p.rowsByDay[d])) void run();
});

useNodeStore.subscribe((s, p) => {
  if (attachCount === 0) return;
  if (s.today !== p.today || s.tree !== p.tree || s.calendar !== p.calendar) {
    void run();
  }
});
