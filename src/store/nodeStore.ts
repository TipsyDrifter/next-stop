/**
 * nodeStore——側欄資料＋當前路線的大綱樹索引＋所有 mutation 動作。
 * 元件不碰 repository，一律經 store；每次 mutation 後重新載入（資料量小、正確優先）。
 * 升降層採「類型跟位置走」（車廂升到路線層變列車……），規則見 adaptKind。
 */
import { create } from "zustand";
import {
  allowedChildKinds,
  canHaveChildren,
  parseRule,
  type NodeKind,
  type NodeRow,
  type RepeatRule,
  type WorkLog,
} from "../domain";
import {
  nodeRepo,
  reorderIds,
  type CreateNodeInput,
  type CurrentOccurrence,
  type DueEntry,
  type NodePatch,
  type ScheduleEntry,
  type TodayRow,
} from "../data";
import { todayKey } from "../lib/date";
import { useUiStore } from "./uiStore";

/**
 * 今日切片（M3 ③ WP1）——今日列不在當前路線樹裡，另存一份索引給今日視圖用。
 * dateKey＝這份資料算的是哪一天（依日界線）；跨 03:00 時 App 層重算 key、重新 loadToday。
 */
export interface TodayIndex {
  rows: TodayRow[];
  byId: Record<string, TodayRow>;
  dateKey: string | null;
}

const EMPTY_TODAY: TodayIndex = { rows: [], byId: {}, dateKey: null };

function indexToday(rows: TodayRow[], dateKey: string): TodayIndex {
  const byId: Record<string, TodayRow> = {};
  for (const r of rows) byId[r.id] = r;
  return { rows, byId, dateKey };
}

/**
 * 日曆切片（M3 ⑤ WP1）——一個區間的三張表＋這一份資料算的是哪一天（日界線今天）。
 * from／to 為 null＝還沒載過任何區間（`refresh()` 據此決定要不要順手重載）。
 * 游標（正在看哪個月／週）**不在這裡**，留在 `useCalendarController` 的本地 state（不記憶，進頁一律落今天）。
 */
export interface CalendarIndex {
  from: string | null;
  to: string | null;
  dateKey: string | null;
  entries: ScheduleEntry[];
  dues: DueEntry[];
  nodes: Record<string, NodeRow>;
}

const EMPTY_CALENDAR: CalendarIndex = {
  from: null,
  to: null,
  dateKey: null,
  entries: [],
  dues: [],
  nodes: {},
};

/**
 * 同區間去重（草案 §5-7）：同一個 (from,to,dateKey) 正在飛的請求只打一次——
 * 月視圖掛載＋控制器 effect 同時叫 loadCalendar 時不會撈兩趟。飛完就清，下一次 mutation 後照樣重載。
 */
let calendarInflight: { key: string; p: Promise<void> } | null = null;

/** 現在的日界線今天（設定裡的 day_start_hour，預設 03:00） */
function currentDateKey(): string {
  return todayKey(useUiStore.getState().dayStartHour);
}

function dayStart(): number {
  return useUiStore.getState().dayStartHour;
}

export interface TreeIndex {
  byId: Record<string, NodeRow>;
  childrenOf: Record<string, string[]>;
  /** 直屬於路線的頂層節點（依 position） */
  roots: string[];
}

const EMPTY_TREE: TreeIndex = { byId: {}, childrenOf: {}, roots: [] };

export function indexTree(rows: NodeRow[], routeId: string): TreeIndex {
  const byId: Record<string, NodeRow> = {};
  const childrenOf: Record<string, string[]> = {};
  const roots: string[] = [];
  for (const r of rows) byId[r.id] = r;
  for (const r of rows) {
    if (r.parent_id && r.parent_id !== routeId && byId[r.parent_id]) {
      (childrenOf[r.parent_id] ??= []).push(r.id);
    } else {
      roots.push(r.id); // 直屬路線（或孤兒保底）
    }
  }
  return { byId, childrenOf, roots };
}

/** 兄弟清單與自己的索引（根層＝路線直屬） */
export function siblingsOf(tree: TreeIndex, routeId: string | null, id: string): { siblings: string[]; index: number } {
  const node = tree.byId[id];
  if (!node) return { siblings: [], index: -1 };
  const siblings =
    node.parent_id && node.parent_id !== routeId && tree.byId[node.parent_id]
      ? (tree.childrenOf[node.parent_id] ?? [])
      : tree.roots;
  return { siblings, index: siblings.indexOf(id) };
}

/**
 * 票號「No.MMDD-NN」＝建立日（本地）＋**當日全域發券序**（M3-2 拍板）。
 * 號碼跨父節點、跨路線、跨 kind 算，樹上算不出來——一律查 store 的 serials 表
 * （repository 的 listSerials／buildSerialMap 出的同一張表，今日列的 serial 也吃它）。
 */
export function serialOf(serials: Record<string, string>, id: string): string {
  return serials[id] ?? "";
}

/** 升降層時「類型跟位置走」：掛不上就試 列車⇄車廂 互換，再不行回 null（擋下） */
export function adaptKind(kind: NodeKind, newParentKind: NodeKind): NodeKind | null {
  const allowed = allowedChildKinds(newParentKind);
  if (allowed.includes(kind)) return kind;
  if (kind === "car" && allowed.includes("train")) return "train";
  if (kind === "train" && allowed.includes("car")) return "car";
  return null;
}

/** 祖先鏈（不含自己、不含路線），由近到遠 */
export function ancestorsOf(tree: TreeIndex, routeId: string | null, id: string): string[] {
  const out: string[] = [];
  let cur = tree.byId[id]?.parent_id ?? null;
  while (cur && cur !== routeId && tree.byId[cur]) {
    out.push(cur);
    cur = tree.byId[cur].parent_id;
  }
  return out;
}

/** 子孫數（不含自己） */
export function descendantCount(tree: TreeIndex, id: string): number {
  let n = 0;
  const stack = [...(tree.childrenOf[id] ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    n++;
    stack.push(...(tree.childrenOf[c] ?? []));
  }
  return n;
}

/** 未完成子孫數 */
export function openDescendantCount(tree: TreeIndex, id: string): number {
  let n = 0;
  const stack = [...(tree.childrenOf[id] ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (tree.byId[c]?.status !== "done") n++;
    stack.push(...(tree.childrenOf[c] ?? []));
  }
  return n;
}

/** 有子項時的自動進度（完成子孫／全部子孫，百分比）；無子項回 null */
export function autoProgress(tree: TreeIndex, id: string): number | null {
  const total = descendantCount(tree, id);
  if (!total) return null;
  const open = openDescendantCount(tree, id);
  return Math.round(((total - open) / total) * 100);
}

export interface ActionResult {
  ok: boolean;
  /** 被擋下或失敗時的一句話（給 toast） */
  reason?: string;
}

interface NodeStore {
  lines: NodeRow[];
  routes: NodeRow[];
  stations: NodeRow[];
  routeId: string | null;
  tree: TreeIndex;
  /** 全站票號表（id →「MMDD-NN」）＝當日全域發券序；大綱票根與側板票頭讀它（serialOf） */
  serials: Record<string, string>;
  /** 今日視圖的資料（與 tree 平行，今日列多半不在當前路線樹裡） */
  today: TodayIndex;
  /** 日曆視圖的資料（M3 ⑤）：目前載進來的那個區間的班次／締切／節點表 */
  calendar: CalendarIndex;
  /**
   * 全站定期券的「目前班次」表（node_id → {id, status, due_on}；M3 ④）。
   * 大綱列／側板検印／QuickJump 判「這張定期券的目前班次済了沒」都讀它——
   * 與今日列的 `TodayRow.occurrence` 是同一把尺（repository 的 pickTodayOccurrence）。
   * 沒有結局的班次不會出現在表裡（`currentOccurrences[id]` 為 undefined＝這班還沒交代）。
   */
  currentOccurrences: Record<string, CurrentOccurrence>;
  workLogs: Record<string, WorkLog[]>;
  loading: boolean;
  error: string | null;
  lastDeleted: string[] | null;

  loadSidebar: () => Promise<void>;
  openRoute: (routeId: string | null) => Promise<void>;
  reloadRoute: () => Promise<void>;
  /** 重載今日聚合；省略 dateKey＝依日界線的今天（跨 03:00 由 App 層帶新 key 進來） */
  loadToday: (dateKey?: string) => Promise<void>;
  /**
   * 載入日曆一個區間（M3 ⑤）：開頭先跑 `syncRepeats`（與 loadToday 同款，D-④-7 lazy 同步），
   * 再一趟 `listCalendar`。換月／換週／進頁都叫這支；同區間同時被叫兩次只會撈一趟。
   */
  loadCalendar: (from: string, to: string) => Promise<void>;
  /** 今日手動序：把 id 挪到 today 分區的第 index 位（拖曳與 Alt+↑↓ 的唯一入口） */
  moveToday: (id: string, index: number) => Promise<ActionResult>;
  /** 臨時車票掛／卸路線標籤（同步寫 line_id） */
  setRouteTag: (ticketId: string, routeId: string | null) => Promise<ActionResult>;
  /** 改執行日的唯一入口：推遲／T／Shift+T／日期 chip／清除執行日；順帶寫繰越、清今日序 */
  reschedule: (id: string, date: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  createNode: (input: CreateNodeInput) => Promise<NodeRow | null>;
  /**
   * 欄位補丁。回傳 ActionResult：`scheduled_on` 被 repository 擋下（定期券的班次由規則排定）時
   * ok=false＋一句話 toast，**不**寫 error 欄位——那會在 App 頂端釘一條不會自己消失的紅字橫幅（M3 ④ 評審 must）。
   */
  updateNode: (id: string, patch: NodePatch) => Promise<ActionResult>;
  moveNode: (id: string, newParentId: string | null, index: number, newKind?: NodeKind) => Promise<ActionResult>;
  reorder: (id: string, delta: 1 | -1) => Promise<ActionResult>;
  indent: (id: string) => Promise<ActionResult>;
  outdent: (id: string) => Promise<ActionResult>;
  setKind: (id: string, kind: NodeKind) => Promise<ActionResult>;
  deleteNode: (id: string) => Promise<string[]>;
  undoDelete: () => Promise<void>;
  setCompleted: (id: string, done: boolean, cascade?: boolean) => Promise<void>;
  /**
   * 掛／改／清除重複規則（M3 ④）——側板編輯器的唯一入口。
   * rule=null＝清除（票變回乘車券，過去的班次記錄保留）。驗證在 repository（身分／子項／JSON）。
   */
  setRepeatRule: (id: string, rule: RepeatRule | null) => Promise<ActionResult>;
  /**
   * 本班運休／取消運休（`U`、推遲小卡定期券版、側板検印區都走這裡）。
   * `dueOn`＝指定班次（M3 ⑤「提前請假」：日曆浮層對未來班次按運休）；省略＝這一列在講的那一班。
   * 班次日不合法會被 repository 擋下（`REPEAT_FUTURE_ONLY_MSG`／`REPEAT_DONE_MSG`），照原句走 ActionResult。
   */
  skipOccurrence: (id: string, skip: boolean, dueOn?: string | null) => Promise<ActionResult>;
  searchNodes: (query: string) => Promise<NodeRow[]>;
  loadWorkLogs: (nodeId: string) => Promise<void>;
  addWorkLog: (nodeId: string, body: string) => Promise<void>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useNodeStore = create<NodeStore>((set, get) => ({
  lines: [],
  routes: [],
  stations: [],
  routeId: null,
  tree: EMPTY_TREE,
  serials: {},
  today: EMPTY_TODAY,
  calendar: EMPTY_CALENDAR,
  currentOccurrences: {},
  workLogs: {},
  loading: false,
  error: null,
  lastDeleted: null,

  async loadSidebar() {
    try {
      const data = await nodeRepo.listSidebar();
      set({ lines: data.lines, routes: data.routes, stations: data.stations, error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  async openRoute(routeId) {
    set({ routeId, tree: EMPTY_TREE });
    if (routeId) await get().reloadRoute();
  },

  async reloadRoute() {
    const routeId = get().routeId;
    if (!routeId) return;
    set({ loading: true });
    try {
      // 票號表跟著樹一起載：發券序是全域的（別條路線今天建的票也佔號），
      // 只重載當前路線的節點是算不出號碼的。目前班次表同理（大綱列要判定期券済了沒）。
      const [rows, serials, currentOccurrences] = await Promise.all([
        nodeRepo.listRouteTree(routeId),
        nodeRepo.listSerials(),
        nodeRepo.listCurrentOccurrences(currentDateKey(), dayStart()),
      ]);
      set({ tree: indexTree(rows, routeId), serials, currentOccurrences, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: message(e) });
    }
  },

  async loadToday(dateKey) {
    const key = dateKey ?? currentDateKey();
    const h = dayStart();
    try {
      // 先把定期券的班次推到位（lazy 同步 D-④-7），再聚合——否則今天的班次日還是上一班的
      await nodeRepo.syncRepeats(key, h);
      const [rows, currentOccurrences] = await Promise.all([
        nodeRepo.listToday(key, h),
        nodeRepo.listCurrentOccurrences(key, h),
      ]);
      set({ today: indexToday(rows, key), currentOccurrences, error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  async loadCalendar(from, to) {
    const key = currentDateKey();
    const h = dayStart();
    const dedupe = `${from}|${to}|${key}`;
    if (calendarInflight?.key === dedupe) return calendarInflight.p;
    const p = (async () => {
      try {
        // 先把定期券的班次推到位（與 loadToday 同款；日曆的投影要吃最新的 scheduled_on）
        await nodeRepo.syncRepeats(key, h);
        // 目前班次表跟著日曆一起載（與 loadToday／reloadRoute 同一把尺）：浮層要判「這一列在講的
        // 是不是這一班」——直接進日曆頁（?page=calendar）時 loadToday 沒跑過，沒有它就會把今天
        // 剛交代掉的那一班當成歷史鎖住（蓋済之後引擎已把 scheduled_on 推到下一班）
        const [data, currentOccurrences] = await Promise.all([
          nodeRepo.listCalendar(from, to, { todayDateKey: key, dayStartHour: h }),
          nodeRepo.listCurrentOccurrences(key, h),
        ]);
        set({ calendar: { from, to, dateKey: key, ...data }, currentOccurrences, error: null });
      } catch (e) {
        set({ error: message(e) });
      }
    })();
    calendarInflight = { key: dedupe, p };
    try {
      await p;
    } finally {
      if (calendarInflight?.key === dedupe) calendarInflight = null;
    }
  },

  async moveToday(id, index) {
    const { today } = get();
    const ids = today.rows.filter((r) => r.bucket === "today").map((r) => r.id);
    if (!ids.includes(id)) return { ok: false, reason: "誤點區的票不能拖——要排上今天請按 T" };
    try {
      await nodeRepo.assignTodayPositions(reorderIds(ids, id, index));
      await get().loadToday(today.dateKey ?? undefined);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
  },

  async setRouteTag(ticketId, routeId) {
    try {
      await nodeRepo.setRouteTag(ticketId, routeId);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
  },

  async reschedule(id, date) {
    try {
      await nodeRepo.reschedule(id, date, currentDateKey());
      await get().refresh();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  async refresh() {
    // 班次同步要在 Promise.all **之前**跑完（雷區 1）：reloadRoute 若讀到舊的 scheduled_on，
    // 大綱 chip 會停在上一班直到下一次 refresh。syncRepeats 冪等，loadToday 裡再跑一次也無妨。
    try {
      await nodeRepo.syncRepeats(currentDateKey(), dayStart());
    } catch (e) {
      set({ error: message(e) });
    }
    // 第四項：日曆載過區間就同區間重載——浮層裡蓋章／推遲／運休之後格子才會跟著動（M3 ⑤）
    const cal = get().calendar;
    await Promise.all([
      get().loadSidebar(),
      get().reloadRoute(),
      get().loadToday(get().today.dateKey ?? undefined),
      cal.from && cal.to ? get().loadCalendar(cal.from, cal.to) : Promise.resolve(),
    ]);
  },

  async createNode(input) {
    try {
      const row = await nodeRepo.create(input);
      await get().refresh();
      return row;
    } catch (e) {
      set({ error: message(e) });
      return null;
    }
  },

  async updateNode(id, patch) {
    // 執行日一律改道 reschedule：繰越（carried_from）與今日序清空的規則只留一份，
    // 側板日期 chip／T／Shift+T／推遲 popover 走哪條路進來都一樣。
    // repeat_rule 同理改道 setRepeatRule（身分驗證＋掛規則後立刻算目前班次日只留一份，M3 ④）。
    const { scheduled_on, repeat_rule, ...rest } = patch;
    if ("scheduled_on" in patch) {
      // 定期券在這裡會被 repository throw 掉（D-④-3）。那不是「壞掉」而是一句指路：
      // 走 toast＋ActionResult，不寫 error 欄位（紅字橫幅是常駐的，要等下一次成功 refresh 才清）。
      try {
        await nodeRepo.reschedule(id, scheduled_on ?? null, currentDateKey());
      } catch (e) {
        const reason = message(e);
        useUiStore.getState().showToast({ message: reason }, 4000);
        await get().refresh(); // 讓畫面退回庫裡的真相（別停在使用者剛打的那個日子）
        return { ok: false, reason };
      }
    }
    try {
      if ("repeat_rule" in patch) {
        const rule = parseRule(repeat_rule ?? null);
        if (repeat_rule && repeat_rule.trim() && !rule) throw new Error("重複規則格式不正確");
        await nodeRepo.setRepeatRule(id, rule, currentDateKey(), dayStart());
      }
      // dateKey／dayStartHour 帶進去：mood 會鏡射到定期券的目前班次，日界線要與畫面同一把尺
      if (Object.keys(rest).length) {
        await nodeRepo.update(id, rest, { dateKey: currentDateKey(), dayStartHour: dayStart() });
      }
      await get().refresh();
      return { ok: true };
    } catch (e) {
      const reason = message(e);
      set({ error: reason });
      return { ok: false, reason };
    }
  },

  async moveNode(id, newParentId, index, newKind) {
    try {
      await nodeRepo.move(id, newParentId, index, newKind);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
  },

  async reorder(id, delta) {
    const { tree, routeId } = get();
    const node = tree.byId[id];
    if (!node) return { ok: false, reason: "節點不存在" };
    const { siblings, index } = siblingsOf(tree, routeId, id);
    const j = index + delta;
    if (j < 0 || j >= siblings.length) return { ok: false, reason: delta < 0 ? "已經在最上面" : "已經在最下面" };
    const target = tree.byId[siblings[j]];
    const newIndex = delta < 0 ? target.position : target.position + 1;
    return get().moveNode(id, node.parent_id, newIndex);
  },

  async indent(id) {
    const { tree, routeId } = get();
    const node = tree.byId[id];
    if (!node) return { ok: false, reason: "節點不存在" };
    const { siblings, index } = siblingsOf(tree, routeId, id);
    if (index <= 0) return { ok: false, reason: "上面沒有可以掛靠的節點" };
    const prev = tree.byId[siblings[index - 1]];
    if (!canHaveChildren(prev.kind)) return { ok: false, reason: "車票／車站底下不能掛東西" };
    const newKind = adaptKind(node.kind, prev.kind);
    if (!newKind) return { ok: false, reason: "這種節點不能掛在那裡" };
    const kids = tree.childrenOf[prev.id] ?? [];
    const newIndex = kids.length ? Math.max(...kids.map((k) => tree.byId[k].position)) + 1 : 0;
    return get().moveNode(id, prev.id, newIndex, newKind);
  },

  async outdent(id) {
    const { tree, routeId } = get();
    const node = tree.byId[id];
    if (!node) return { ok: false, reason: "節點不存在" };
    if (!node.parent_id || node.parent_id === routeId || !tree.byId[node.parent_id]) {
      return { ok: false, reason: "已經在路線頂層——跨路線請用「移動到…」" };
    }
    const parent = tree.byId[node.parent_id];
    const gpId = parent.parent_id;
    const gpKind: NodeKind = gpId && gpId !== routeId && tree.byId[gpId] ? tree.byId[gpId].kind : "route";
    const newKind = adaptKind(node.kind, gpKind);
    if (!newKind) return { ok: false, reason: "這種節點不能升到那一層" };
    return get().moveNode(id, gpId ?? routeId, parent.position + 1, newKind);
  },

  async setKind(id, kind) {
    try {
      await nodeRepo.setKind(id, kind);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
  },

  async deleteNode(id) {
    try {
      const ids = await nodeRepo.softDelete(id);
      set({ lastDeleted: ids });
      await get().refresh();
      return ids;
    } catch (e) {
      set({ error: message(e) });
      return [];
    }
  },

  async undoDelete() {
    const ids = get().lastDeleted;
    if (!ids) return;
    try {
      await nodeRepo.restore(ids);
      set({ lastDeleted: null });
      await get().refresh();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  async setCompleted(id, done, cascade) {
    try {
      // dateKey／dayStartHour 帶進去：定期券的済蓋在「今天這一班」上，日界線要與畫面同一把尺
      await nodeRepo.setCompleted(id, done, { cascade, dateKey: currentDateKey(), dayStartHour: dayStart() });
      await get().refresh();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  async setRepeatRule(id, rule) {
    try {
      await nodeRepo.setRepeatRule(id, rule, currentDateKey(), dayStart());
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
  },

  async skipOccurrence(id, skip, dueOn) {
    try {
      await nodeRepo.skipOccurrence(id, skip, currentDateKey(), dayStart(), dueOn);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
  },

  async searchNodes(query) {
    try {
      return await nodeRepo.search(query);
    } catch (e) {
      set({ error: message(e) });
      return [];
    }
  },

  async loadWorkLogs(nodeId) {
    try {
      const logs = await nodeRepo.listWorkLogs(nodeId);
      set((s) => ({ workLogs: { ...s.workLogs, [nodeId]: logs } }));
    } catch (e) {
      set({ error: message(e) });
    }
  },

  async addWorkLog(nodeId, body) {
    if (!body.trim()) return;
    try {
      await nodeRepo.addWorkLog(nodeId, body);
      await get().loadWorkLogs(nodeId);
    } catch (e) {
      set({ error: message(e) });
    }
  },
}));
