/**
 * timetablePlanStore——時刻表線⑦「作息範本」與「某一天的預定」（作息落地的段＋車票第二段起）的資料與寫入（⑦ 契約 §3、§4）。
 *
 * **讀**：範本整份（`listRoutines`，含封存）；預定按天載（`loadDays(from, to)`：`listPlans` 含已刪的墓碑——落地判定要看，D-時-160），
 *   每一天算成 `DayRoutine`（`dayRoutineOf`：已落地＝列、虛擬＝自動範本的段、過去的虛擬日不畫）放 `days`；車票的第二段起按票載（`loadNode`）。
 *   UI 用 `rowsForDay(day)`／`slotsForDay(day)`／`slotsByNode[nodeId]` 讀；沒載過的天回 null／[]，UI 先叫 `loadDays`。
 * **落地**（D-時-160）：今天＝時刻表載好（`timetableStore.ready` 變 true）與換日（`todayKey` 變了）時 `ensureDay(今天)`；
 *   其他日子＝使用者動了那天的任何一段之前（`applyRoutine`／`addRoutineItem`／`editPlan`／`deletePlan` 先 `landDay`）。
 *   落地**只寫本機、不送 op**（`materializePlans`：本機已有的列不碰）；使用者真的動的那幾段才是一般寫入、照常送 op（op 怎麼帶見 repository）。
 *   過去的日子不落地、也不能改（D-時-79 同一條：只能排今天和以後）。
 * **收到就補齊**：每次讀進某幾天（載入、寫完重讀、同步 reload）都跑 `planFillRoutine`——另一台只同步過來它動過的段，
 *   這台把那一套其餘的段在本機補上（同樣只寫本機），兩台畫出來才是同一天。
 * **寫**：同一時間一筆（`queue` 串起來）；錯誤 toast 理由（RangeError 的人話）。寫完重讀受影響的天／票。
 * **同步**：`reload(ctx)`（`timetable.mount.tsx` 的 reload 叫）——範本或預定表有變就重讀；`wiped` 整批清掉快取。
 * 時刻的範圍守門（日界線）在這裡（repository 不知道日界線，只驗格式與先後）。
 */
import { create } from "zustand";
import { timetableRepo } from "../data/timetableRepository";
import { uuid } from "../lib/db";
import { clockMinutes, clockRange, clockText, todayKey, type ClockText } from "../lib/date";
import { TIME_FORMAT_MSG } from "../domain/scheduledTime";
import {
  adhocsOfDay,
  dayRoutineOf,
  isAdhocRow,
  isMaterialized,
  planApplyRoutine,
  planEnsureMaterialized,
  planFillRoutine,
  planUndoApplyRoutine,
  routineHasItems,
  type DayRoutine,
  type PlanPatch,
  type PlanUpsert,
  type RoutineInput,
  type RoutineItem,
  type TimePlanRow,
  type TimeRoutineRow,
} from "../domain/timetableRoutine";
import type { LineReloadContext } from "../lines/types";
import { useTimetableStore } from "./timetableStore";
import { useUiStore } from "./uiStore";

export type { DayRoutine, RoutineItem, RoutineSeg, TimePlanRow, TimeRoutineRow } from "../domain/timetableRoutine";

/** 改一段作息（undefined＝不動；label null／空白＝清掉、用分類名） */
export interface RoutineSegPatch {
  cat?: string;
  s?: ClockText;
  e?: ClockText;
  label?: string | null;
}

/** 改車票的一段（undefined＝不動；day＝搬到另一天） */
export interface SlotPatch {
  day?: string;
  s?: ClockText;
  e?: ClockText;
  /**
   * 給了 s、沒給 e：true＝整段搬過去、長度照**資料庫裡現在的**（夾在這一天的終點）——在寫入鎖裡算，
   * 剛排進佇列的「改結束」先寫完才量長度（反方評審 #5：不用畫面快照的舊長度）
   */
  keepLength?: boolean;
}

/** v1.29 D-時-191：新增或修改一段臨時班次預留時段 */
export interface AdhocInput {
  day: string;
  s: ClockText;
  e: ClockText;
  label?: string | null;
  categoryId?: string | null;
  routeId?: string | null;
  nodeId?: string | null;
}

export interface AdhocPatch {
  day?: string;
  s?: ClockText;
  e?: ClockText;
  label?: string | null;
  categoryId?: string | null;
  routeId?: string | null;
  nodeId?: string | null;
  keepLength?: boolean;
}

export interface TimetablePlanState {
  /** 範本（未刪除、含封存），position 序 */
  routines: TimeRoutineRow[];
  routinesLoaded: boolean;
  /** day → 那一天的 time_plans 列（**含已刪**；作息段與車票段都在） */
  rowsByDay: Record<string, TimePlanRow[]>;
  /** day → 算好的作息（`rowsForDay` 回這個） */
  days: Record<string, DayRoutine>;
  /** nodeId → 那張票的第二段起（活著的，day → 開始時刻） */
  slotsByNode: Record<string, TimePlanRow[]>;
  /** 有一筆寫入正在飛（UI 可以據此暫停拖曳／按鈕） */
  busy: boolean;
  error: string | null;

  /** 讀範本（並重算已載的天）；第一次之後也會把今天落地 */
  load(): Promise<void>;
  /** 讀 [from, to] 每一天的預定、算 `days` */
  loadDays(from: string, to: string): Promise<void>;
  /** 讀一張票的第二段起 */
  loadNode(nodeId: string): Promise<TimePlanRow[]>;
  /** 落地（D-時-160）：只有今天會自動落地；其他日子什麼都不做。回 true＝這次寫了 */
  ensureDay(dayKey: string): Promise<boolean>;
  /** 那一天的作息（虛擬或已落地；只含活著的段）；沒載過＝null */
  rowsForDay(dayKey: string): DayRoutine | null;
  /** 那一天的車票段（活著的，開始時刻序）；沒載過＝[] */
  slotsForDay(dayKey: string): TimePlanRow[];
  /** v1.29 D-時-191：那一天的臨時班次列（活著的，開始時刻序）；沒載過＝[] */
  adhocsForDay(dayKey: string): TimePlanRow[];

  /* ── 某一天的作息 ── */
  /** 換成某一套（同一套＝重新套用）；null＝這天不套。`out.undo`：寫成功才有，收回新段、還原舊段（走一般寫入、照常送 op；撤回用） */
  applyRoutine(day: string, routineId: string | null, out?: { undo?: () => Promise<boolean> }): Promise<boolean>;
  /** 加一段（手動，routine_id NULL） */
  addRoutineItem(day: string, item: RoutineItem): Promise<boolean>;
  /** 改一段（虛擬段也可以：先整天落地） */
  editPlan(day: string, id: string, patch: RoutineSegPatch): Promise<boolean>;
  /** 刪一段（虛擬段也可以：先整天落地、這段寫成已刪） */
  deletePlan(day: string, id: string): Promise<boolean>;
  /** 復原刪掉的一段（撤回用） */
  restorePlan(day: string, id: string): Promise<boolean>;

  /* ── 範本 ── */
  createRoutine(input: RoutineInput): Promise<TimeRoutineRow | null>;
  updateRoutine(id: string, patch: Partial<RoutineInput>): Promise<boolean>;
  archiveRoutine(id: string, on: boolean): Promise<boolean>;
  deleteRoutine(id: string): Promise<boolean>;
  restoreRoutine(id: string): Promise<boolean>;
  reorderRoutines(orderedIds: readonly string[]): Promise<boolean>;

  /* ── 車票的第二段起（D-時-162） ── */
  addSlot(nodeId: string, day: string, s: ClockText, e: ClockText): Promise<TimePlanRow | null>;
  /** `out.prev`：寫入前那一段的起訖（撤回用；寫成功才有） */
  editSlot(id: string, patch: SlotPatch, out?: { prev?: { s: ClockText; e: ClockText } }): Promise<boolean>;
  deleteSlot(id: string): Promise<boolean>;
  restoreSlot(id: string): Promise<boolean>;

  /* ── v1.29 D-時-191：臨時班次預留時段 ── */
  addAdhoc(input: AdhocInput): Promise<TimePlanRow | null>;
  editAdhoc(id: string, patch: AdhocPatch, out?: { prev?: { s: ClockText; e: ClockText } }): Promise<boolean>;
  deleteAdhoc(id: string): Promise<boolean>;
  restoreAdhoc(id: string): Promise<boolean>;

  reload(ctx: LineReloadContext): Promise<void>;
}

/* ───────── 模組層 ───────── */

const dayStart = (): number => useUiStore.getState().dayStartHour;
const today = (): string => todayKey(dayStart(), new Date());

const toast = (message: string): void => useUiStore.getState().showToast({ message });

/** 一次一筆寫入（串起來，不吃掉） */
let queue: Promise<unknown> = Promise.resolve();

function serialWrite<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

/** 營業日表記的範圍守門：開始在這一天之內、結束晚於開始而且不超過這一天的終點（"30:00" 在日界線 06:00 下可以當結束） */
function checkRange(s: ClockText, e: ClockText): void {
  const a = clockMinutes(s);
  const b = clockMinutes(e);
  const r = clockRange(dayStart());
  if (a === null || b === null || a < r.min || a > r.max || b > r.max + 1) throw new RangeError(TIME_FORMAT_MSG);
  if (!(b > a)) throw new RangeError("結束時間要晚於開始時間");
}

function checkFutureDay(day: string): void {
  if (day < today()) throw new RangeError("過去的日子不能排");
}

/** 寫入外殼：鎖、錯誤 toast（RangeError 是人話；其他印 console 再給一句）、回 true＝寫成功 */
async function run(fn: () => Promise<void>): Promise<boolean> {
  return serialWrite(async () => {
    useTimetablePlanStore.setState({ busy: true });
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof RangeError) toast(e.message);
      else {
        console.warn("時刻表：預定沒寫好", e);
        toast("沒存好，再試一次");
      }
      return false;
    } finally {
      useTimetablePlanStore.setState({ busy: false });
    }
  });
}

async function recomputeDays(days: readonly string[]): Promise<void> {
  const s = useTimetablePlanStore.getState();
  const t = today();
  const out: Record<string, DayRoutine> = {};
  for (const d of days) {
    const rows = s.rowsByDay[d];
    if (rows) out[d] = await dayRoutineOf(d, rows, s.routines, t);
  }
  useTimetablePlanStore.setState((cur) => ({ days: { ...cur.days, ...out } }));
}

async function readDays(days: readonly string[]): Promise<void> {
  const uniq = Array.from(new Set(days)).sort();
  if (!uniq.length) return;
  const rows = await timetableRepo.listPlans(uniq[0], uniq[uniq.length - 1]);
  const byDay: Record<string, TimePlanRow[]> = {};
  for (const d of uniq) byDay[d] = [];
  for (const r of rows) if (byDay[r.day]) byDay[r.day].push(r);
  useTimetablePlanStore.setState((cur) => ({ rowsByDay: { ...cur.rowsByDay, ...byDay } }));
}

/**
 * 收到就補齊（⑦ 契約 §3、`planFillRoutine`）：快取裡這幾天出現過某一套的列 ⇒ 把那套本機還沒有的段補上（只寫本機、不送 op）。
 * 回補了的那幾天（呼叫端重讀）。範本還沒讀＝不補；寫不進去只記 console（畫面照收到的畫，下次讀進來再補）。
 */
async function fillDays(days: readonly string[]): Promise<string[]> {
  const s = useTimetablePlanStore.getState();
  if (!s.routinesLoaded) return [];
  const rows: PlanUpsert[] = [];
  const touched: string[] = [];
  for (const d of days) {
    const cached = s.rowsByDay[d];
    if (!cached) continue;
    const add = await planFillRoutine(d, cached, s.routines);
    if (!add.length) continue;
    rows.push(...add);
    touched.push(d);
  }
  if (!rows.length) return [];
  try {
    await timetableRepo.materializePlans(rows);
  } catch (e) {
    console.warn("時刻表：作息沒補齊", e);
    return [];
  }
  return touched;
}

/** 重讀這幾天（含補齊）並重算 */
async function refetchDays(days: readonly string[]): Promise<void> {
  const uniq = Array.from(new Set(days)).sort();
  if (!uniq.length) return;
  await readDays(uniq);
  const filled = await fillDays(uniq);
  if (filled.length) await readDays(filled);
  await recomputeDays(uniq);
}

/** 範本變了、列沒重讀（載入、同步只帶來範本）：補齊之後重算已載的天 */
async function fillAndRecompute(days: readonly string[]): Promise<void> {
  const filled = await fillDays(days);
  if (filled.length) await readDays(filled);
  await recomputeDays(days);
}

async function refetchNodes(nodeIds: readonly (string | null)[]): Promise<void> {
  for (const id of new Set(nodeIds)) {
    if (id === null || !(id in useTimetablePlanStore.getState().slotsByNode)) continue;
    const rows = await timetableRepo.listPlansByNode(id);
    useTimetablePlanStore.setState((cur) => ({ slotsByNode: { ...cur.slotsByNode, [id]: rows } }));
  }
}

/**
 * 那一天的列（含已刪）——寫入前一律重讀、不用快取：快取可能還沒收到剛同步下來的列，照舊快取判「沒落地」「找不到這一段」會判錯
 */
function rowsOf(day: string): Promise<TimePlanRow[]> {
  return timetableRepo.listPlans(day, day);
}

/**
 * 在某一天上動一段之前（D-時-160「動之前先把整天落地」）：算出這天在本機該落地／該補齊的列（還沒寫）。
 * `rows`＝資料庫裡現在的列（含已刪），`local`＝要在本機補上的列；兩者合起來＝這一天完整的樣子（驗證用）。
 */
async function dayDraft(day: string): Promise<{ rows: TimePlanRow[]; local: PlanUpsert[] }> {
  const rows = await rowsOf(day);
  const routines = useTimetablePlanStore.getState().routines;
  const local = isMaterialized(rows) ? await planFillRoutine(day, rows, routines) : await planEnsureMaterialized(day, rows, routines);
  return { rows, local };
}

/** 把 `dayDraft` 的本機列寫下去（只寫本機、不送 op）、回那天現在的列；使用者這次的改動接著照一般寫入做 */
async function landDay(day: string, draft: { rows: TimePlanRow[]; local: PlanUpsert[] }): Promise<TimePlanRow[]> {
  if (!draft.local.length) return draft.rows;
  await timetableRepo.materializePlans(draft.local);
  return rowsOf(day);
}

/** 這一天的某一段（資料庫裡的、或還沒落地的那一列）；活著的才算 */
function segOfDraft(draft: { rows: TimePlanRow[]; local: PlanUpsert[] }, id: string): Pick<PlanUpsert, "start_hm" | "end_hm"> | null {
  const row = draft.rows.find((r) => r.id === id);
  if (row) return row.deleted_at === null && row.node_id === null ? row : null;
  return draft.local.find((u) => u.id === id && !u.deleted) ?? null;
}

export const useTimetablePlanStore = create<TimetablePlanState>()((set, get) => ({
  routines: [],
  routinesLoaded: false,
  rowsByDay: {},
  days: {},
  slotsByNode: {},
  busy: false,
  error: null,

  async load() {
    try {
      const routines = await timetableRepo.listRoutines();
      set({ routines, routinesLoaded: true, error: null });
      await fillAndRecompute(Object.keys(get().rowsByDay));
      await get().ensureDay(today());
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async loadDays(from, to) {
    const days: string[] = [];
    // 'YYYY-MM-DD' 逐日（牆鐘；本地日期）
    const [y, m, d] = from.split("-").map(Number);
    for (let i = 0; i < 400; i++) {
      const dt = new Date(y, m - 1, d + i);
      const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      if (k > to) break;
      days.push(k);
    }
    try {
      await refetchDays(days);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async loadNode(nodeId) {
    const rows = await timetableRepo.listPlansByNode(nodeId);
    set((cur) => ({ slotsByNode: { ...cur.slotsByNode, [nodeId]: rows } }));
    return rows;
  },

  async ensureDay(dayKey) {
    if (dayKey !== today() || !get().routinesLoaded) return false;
    let wrote = false;
    await run(async () => {
      // 只寫本機、不送 op（另一台各自落地；同步只帶使用者動過的段）
      const rows = await planEnsureMaterialized(dayKey, await timetableRepo.listPlans(dayKey, dayKey), get().routines);
      if (rows.length) wrote = (await timetableRepo.materializePlans(rows)) > 0;
      await refetchDays([dayKey]);
    });
    return wrote;
  },

  rowsForDay(dayKey) {
    return get().days[dayKey] ?? null;
  },

  slotsForDay(dayKey) {
    const rows = get().rowsByDay[dayKey] ?? [];
    return rows
      .filter((r) => r.node_id !== null && !isAdhocRow(r) && r.deleted_at === null)
      .sort((a, b) => (a.start_hm < b.start_hm ? -1 : a.start_hm > b.start_hm ? 1 : 0) || (a.id < b.id ? -1 : 1));
  },

  adhocsForDay(dayKey) {
    return adhocsOfDay(get().rowsByDay[dayKey] ?? []);
  },

  /* ── 某一天的作息 ── */

  async applyRoutine(day, routineId, out) {
    return run(async () => {
      checkFutureDay(day);
      const target = routineId === null ? null : (get().routines.find((r) => r.id === routineId) ?? null);
      if (routineId !== null && !target) throw new RangeError("找不到這套範本");
      const draft = await dayDraft(day);
      // 先驗再落地（0 段、讀不懂的範本 ⇒ RangeError，那天什麼都不寫）
      if (target && !routineHasItems(target)) throw new RangeError(`「${target.name}」還沒有段`);
      // 先在本機落地（不送 op），舊那套才有列可以軟刪——墓碑照常送出去，另一台本機落地的那套也收得到、不會疊兩套
      const rows = await landDay(day, draft);
      const w = await planApplyRoutine(day, rows, target, get().routines);
      if (w.upserts.length || w.deletes.length) await timetableRepo.writePlans(w);
      await refetchDays([day]);
      if (out) {
        const back = planUndoApplyRoutine(rows, w);
        out.undo = () =>
          run(async () => {
            if (back.upserts.length || back.deletes.length) await timetableRepo.writePlans(back);
            await refetchDays([day]);
          });
      }
    });
  },

  async addRoutineItem(day, item) {
    return run(async () => {
      checkFutureDay(day);
      checkRange(item.s, item.e);
      if (!item.cat) throw new RangeError("每一段都要選分類");
      await landDay(day, await dayDraft(day));
      await timetableRepo.writePlans({
        upserts: [{ id: uuid(), day, start_hm: item.s, end_hm: item.e, category_id: item.cat, node_id: null, routine_id: null, label: item.n ?? null }],
        deletes: [],
      });
      await refetchDays([day]);
    });
  },

  async editPlan(day, id, patch) {
    return run(async () => {
      checkFutureDay(day);
      const draft = await dayDraft(day);
      const cur = segOfDraft(draft, id);
      if (!cur) throw new RangeError("找不到這一段");
      checkRange(patch.s ?? cur.start_hm, patch.e ?? cur.end_hm);
      // 虛擬段＝整天先在本機落地（不送 op），再改這一段（一般寫入；這列沒同步過 ⇒ op 帶完整列，另一台沒落地也建得起來）
      await landDay(day, draft);
      const p: PlanPatch = {};
      if (patch.cat !== undefined) p.category_id = patch.cat;
      if (patch.s !== undefined) p.start_hm = patch.s;
      if (patch.e !== undefined) p.end_hm = patch.e;
      if (patch.label !== undefined) p.label = patch.label;
      await timetableRepo.updatePlan(id, p);
      await refetchDays([day]);
    });
  },

  async deletePlan(day, id) {
    return run(async () => {
      checkFutureDay(day);
      const draft = await dayDraft(day);
      if (!segOfDraft(draft, id)) throw new RangeError("找不到這一段");
      await landDay(day, draft);
      await timetableRepo.deletePlan(id); // 沒同步過的列 ⇒ op 帶完整列＋deleted_at（另一台補齊時不會把它補回來）
      await refetchDays([day]);
    });
  },

  async restorePlan(day, id) {
    return run(async () => {
      await timetableRepo.restorePlan(id);
      await refetchDays([day]);
    });
  },

  /* ── 範本 ── */

  async createRoutine(input) {
    let row: TimeRoutineRow | null = null;
    const ok = await run(async () => {
      for (const it of input.items) checkRange(it.s, it.e);
      row = await timetableRepo.createRoutine(input);
      await afterRoutineWrite();
    });
    return ok ? row : null;
  },

  async updateRoutine(id, patch) {
    return run(async () => {
      if (patch.items) for (const it of patch.items) checkRange(it.s, it.e);
      await timetableRepo.updateRoutine(id, patch);
      await afterRoutineWrite();
    });
  },

  async archiveRoutine(id, on) {
    return run(async () => {
      await timetableRepo.archiveRoutine(id, on);
      await afterRoutineWrite();
    });
  },

  async deleteRoutine(id) {
    return run(async () => {
      await timetableRepo.deleteRoutine(id);
      await afterRoutineWrite();
    });
  },

  async restoreRoutine(id) {
    return run(async () => {
      await timetableRepo.restoreRoutine(id);
      await afterRoutineWrite();
    });
  },

  async reorderRoutines(orderedIds) {
    return run(async () => {
      await timetableRepo.reorderRoutines(orderedIds);
      await afterRoutineWrite();
    });
  },

  /* ── 車票的第二段起 ── */

  async addSlot(nodeId, day, s, e) {
    let row: TimePlanRow | null = null;
    const ok = await run(async () => {
      checkFutureDay(day);
      checkRange(s, e);
      const id = uuid();
      await timetableRepo.insertPlans([{ id, day, start_hm: s, end_hm: e, category_id: null, node_id: nodeId, routine_id: null, label: null }]);
      row = await timetableRepo.getPlan(id);
      await refetchDays([day]);
      if (!(nodeId in get().slotsByNode)) set((cur) => ({ slotsByNode: { ...cur.slotsByNode, [nodeId]: [] } }));
      await refetchNodes([nodeId]);
    });
    return ok ? row : null;
  },

  async editSlot(id, patch, out) {
    return run(async () => {
      const cur = await timetableRepo.getPlan(id);
      if (!cur || cur.node_id === null) throw new RangeError("找不到這一段");
      if (patch.day !== undefined) checkFutureDay(patch.day);
      let e = patch.e;
      if (patch.keepLength && patch.s !== undefined && e === undefined) {
        const s0 = clockMinutes(cur.start_hm);
        const e0 = clockMinutes(cur.end_hm);
        const sm = clockMinutes(patch.s);
        if (s0 === null || e0 === null || sm === null) throw new RangeError(TIME_FORMAT_MSG);
        e = clockText(Math.min(sm + (e0 - s0), clockRange(dayStart()).max + 1)) ?? undefined;
      }
      checkRange(patch.s ?? cur.start_hm, e ?? cur.end_hm);
      const p: PlanPatch = {};
      if (patch.day !== undefined) p.day = patch.day;
      if (patch.s !== undefined) p.start_hm = patch.s;
      if (e !== undefined) p.end_hm = e;
      await timetableRepo.updatePlan(id, p);
      if (out) out.prev = { s: cur.start_hm, e: cur.end_hm };
      await refetchDays([cur.day, ...(patch.day ? [patch.day] : [])].filter((d) => d in get().rowsByDay));
      await refetchNodes([cur.node_id]);
    });
  },

  async deleteSlot(id) {
    return run(async () => {
      const cur = await timetableRepo.getPlan(id);
      if (!cur || cur.node_id === null) throw new RangeError("找不到這一段");
      await timetableRepo.deletePlan(id);
      if (cur.day in get().rowsByDay) await refetchDays([cur.day]);
      await refetchNodes([cur.node_id]);
    });
  },

  async restoreSlot(id) {
    return run(async () => {
      await timetableRepo.restorePlan(id);
      const cur = await timetableRepo.getPlan(id);
      if (cur && cur.day in get().rowsByDay) await refetchDays([cur.day]);
      if (cur) await refetchNodes([cur.node_id]);
    });
  },

  /* ── v1.29 D-時-191：臨時班次預留時段 ── */

  async addAdhoc(input) {
    let row: TimePlanRow | null = null;
    const ok = await run(async () => {
      checkFutureDay(input.day);
      checkRange(input.s, input.e);
      const id = uuid();
      const label = input.label?.trim() || null;
      await timetableRepo.insertPlans([
        {
          id,
          day: input.day,
          start_hm: input.s,
          end_hm: input.e,
          category_id: input.categoryId ?? null,
          node_id: input.nodeId ?? null,
          routine_id: null,
          label,
          kind: "adhoc",
          route_id: input.routeId ?? null,
        },
      ]);
      row = await timetableRepo.getPlan(id);
      await refetchDays([input.day]);
    });
    return ok ? row : null;
  },

  async editAdhoc(id, patch, out) {
    return run(async () => {
      const cur = await timetableRepo.getPlan(id);
      if (!cur || !isAdhocRow(cur)) throw new RangeError("找不到這段臨時班次");
      if (patch.day !== undefined) checkFutureDay(patch.day);
      let e = patch.e;
      if (patch.keepLength && patch.s !== undefined && e === undefined) {
        const s0 = clockMinutes(cur.start_hm);
        const e0 = clockMinutes(cur.end_hm);
        const sm = clockMinutes(patch.s);
        if (s0 === null || e0 === null || sm === null) throw new RangeError(TIME_FORMAT_MSG);
        e = clockText(Math.min(sm + (e0 - s0), clockRange(dayStart()).max + 1)) ?? undefined;
      }
      checkRange(patch.s ?? cur.start_hm, e ?? cur.end_hm);
      const p: PlanPatch = {};
      if (patch.day !== undefined) p.day = patch.day;
      if (patch.s !== undefined) p.start_hm = patch.s;
      if (e !== undefined) p.end_hm = e;
      if (patch.label !== undefined) p.label = patch.label?.trim() || null;
      if (patch.categoryId !== undefined) p.category_id = patch.categoryId;
      if (patch.routeId !== undefined) p.route_id = patch.routeId;
      if (patch.nodeId !== undefined) p.node_id = patch.nodeId;
      await timetableRepo.updatePlan(id, p);
      if (out) out.prev = { s: cur.start_hm, e: cur.end_hm };
      await refetchDays([cur.day, ...(patch.day ? [patch.day] : [])].filter((d) => d in get().rowsByDay));
    });
  },

  async deleteAdhoc(id) {
    return run(async () => {
      const cur = await timetableRepo.getPlan(id);
      if (!cur || !isAdhocRow(cur)) throw new RangeError("找不到這段臨時班次");
      await timetableRepo.deletePlan(id);
      if (cur.day in get().rowsByDay) await refetchDays([cur.day]);
    });
  },

  async restoreAdhoc(id) {
    return run(async () => {
      await timetableRepo.restorePlan(id);
      const cur = await timetableRepo.getPlan(id);
      if (cur && cur.day in get().rowsByDay) await refetchDays([cur.day]);
    });
  },

  async reload(ctx) {
    if (ctx.wiped) {
      set({ routines: [], routinesLoaded: false, rowsByDay: {}, days: {}, slotsByNode: {}, error: null });
      if (useTimetableStore.getState().ready) await get().load();
      return;
    }
    const routinesChanged = ctx.changed.includes("time_routines");
    const plansChanged = ctx.changed.includes("time_plans");
    if (!routinesChanged && !plansChanged) return;
    try {
      if (routinesChanged) set({ routines: await timetableRepo.listRoutines(), routinesLoaded: true });
      if (plansChanged) {
        await refetchDays(Object.keys(get().rowsByDay));
        await refetchNodes(Object.keys(get().slotsByNode));
      } else {
        await fillAndRecompute(Object.keys(get().rowsByDay)); // 範本到了（例如剛還原的那套）⇒ 照樣補齊
      }
      // 不在這裡替今天落地（反方評審 #3）：落地只在載入、換日、動某一段之前（契約 D-時-160）——兩台規則一樣；
      // 別台改了範本，今天還沒落地就照新範本畫（虛擬），不會被收到同步的那一台搶先凍成舊版
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/** 範本寫完：重讀範本、重算已載的天（虛擬日的段跟著變；已落地的不變） */
async function afterRoutineWrite(): Promise<void> {
  useTimetablePlanStore.setState({ routines: await timetableRepo.listRoutines(), routinesLoaded: true });
  await recomputeDays(Object.keys(useTimetablePlanStore.getState().rowsByDay));
}

/* ───────── 訂閱：時刻表載好 ⇒ 讀範本＋今天落地；換日 ⇒ 新的今天落地 ───────── */

useTimetableStore.subscribe((s, p) => {
  if (s.ready && !p.ready) void useTimetablePlanStore.getState().load();
  else if (s.ready && s.todayKey !== p.todayKey && useTimetablePlanStore.getState().routinesLoaded) {
    void useTimetablePlanStore.getState().ensureDay(s.todayKey);
    void recomputeDays(Object.keys(useTimetablePlanStore.getState().rowsByDay)); // 「今天」換了 ⇒ 過去的虛擬日不再畫範本
  }
});
