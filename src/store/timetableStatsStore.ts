/**
 * timetableStatsStore——時刻表線③ 統計頁與週視圖的資料（③ 契約 §3.3、0-6、0-7、0-9、0-10；甲席）。
 *
 * **只讀**：向 repository 要 `listBlocksSlim(最早那期的開始 → 現在)` 一次，交給 `domain/timetableStats.ts` 的純函式算完，存結果。
 * 不塞進 `timetableStore` 的 state（統計頁沒開時不載）。寫入（目標的新增／編輯／刪除）走 `timetableStore` 的 `createGoal` 等。
 *
 * 載入時機：
 *   - `load()`／`loadWeek()` 由統計頁／週視圖掛上時叫（叫了就算「開著」）；離開時叫 `release("stats" | "week")`（忘了叫只是多重算幾次）。
 *   - 開著的期間，下列變了就自動重算（合併成一趟、重算期間舊結果留著，不閃成空）：`timetableStore.rev`／`ready`
 *     （寫入、同步、reload 都會讓它變）、`longRunMaxMin`（設定、同步）、運行中那班的任務預計時間（`linkInfo`）、`uiStore.dayStartHour`／`weekStart`、
 *     `nodeStore.routes`／`tree`（**只在窗內用到的路線／節點有變時**；評審 #10）。
 *   - 目標（`goals`）跟正在看的期無關，資料另讀、不做節點查詢；它要的歷史比趨勢窗還早時（since 目標起點一年前），
 *     那一份只在 `rev` 變時才重抓（翻期不重抓；評審 #4）。
 *   - 正在看的期存「參考日」`ref`／`weekRef`（那一期裡的某一天），`key`／`weekKey` 是依目前設定對齊過的第一天（給顯示用）；
 *     對齊後的 key 不寫回 `ref`，週起點來回改才不漂移（評審 #7）。
 *   - 換日（#72）：`checkDay()` 比對「算的時候的今天」，不同就重算；停在「本期／本週」的跟著換，翻到過去某一期的留在原地。
 *     統計頁開著時 UI 每分鐘用 `useNow` 叫一次（只比字串，不重算）；`timetableStore.ensureFreshDay` → `refresh` → `rev` 變也會帶動重算。
 * `period` 存本機鍵 `timetable_stats_period`（手機 `_mobile`，兩殼各記）；第一次＝週。
 */
import { create } from "zustand";
import { timetableRepo } from "../data/timetableRepository";
import { nodeRepo, settingsRepo } from "../data";
import { todayKey } from "../lib/date";
import { isoOf, thresholdOf } from "../domain/timetable";
import { taskEstimateOf } from "../domain/timetableLink";
import {
  ROUTE_GONE,
  ROUTE_NONE,
  buildGoals,
  buildStats,
  buildWeek,
  dayRolledOver,
  goalsFromMs,
  parseGoal,
  periodWindow,
  resolveViewKey,
  routeKeyOf,
  routesChanged,
  staleNodeIds,
  statsFromMs,
  stepView,
  toStatsSpan,
  viewChangedSince,
  type Goal,
  type GoalView,
  type NodeRoute,
  type StatsPeriod,
  type StatsResult,
  type StatsSpan,
  type WeekResult,
} from "../domain/timetableStats";
import { useNodeStore } from "./nodeStore";
import { timetableShell, useTimetableStore } from "./timetableStore";
import { useUiStore } from "./uiStore";

export type { Goal, GoalView, StatsResult, WeekResult } from "../domain/timetableStats";

export const KEY_STATS_PERIOD = "timetable_stats_period"; // 本地；手機加 `_mobile`

/** 路線的顯示名（來自 nodeStore.routes；已刪除或找不到的另標） */
export interface RouteName {
  name: string;
  deleted: boolean;
}

export interface StatsState {
  period: StatsPeriod;
  /** 正在看的期的第一天（依目前週起點／日界線對齊過；followCurrent 時每次重算都會跟著今天）。**顯示用**，別拿它當「看哪一期」的依據 */
  key: string;
  /** 正在看的期的參考日（那一期裡的某一天；翻期時設成新那期的第一天）。設定改了不會動它——`key` 由它重新對齊 */
  ref: string;
  /** 停在「本期」（0-7）：換日時跟著換；使用者翻到過去某一期就是 false */
  followCurrent: boolean;
  /** 週視圖正在看的週的第一天（對齊過，顯示用）與參考日（同 key／ref） */
  weekKey: string;
  weekRef: string;
  weekFollow: boolean;
  /** D-時-51：趨勢只看這一類（頂層或子分類 id）；null＝全部 */
  filterCategoryId: string | null;
  loading: boolean;
  error: string | null;
  result: StatsResult | null;
  week: WeekResult | null;
  /** 沒封存的目標的進度（永遠是「現在」所在的那一期，跟 period／key 無關） */
  goals: GoalView[];
  /** 目標面板用：沒封存、讀得懂的目標（原樣，含編輯用欄位）／封存的目標（「已封存的目標」區叫回用） */
  goalList: Goal[];
  archivedGoals: Goal[];
  /** result.routes 用到的路線 id → 名字 */
  routeNames: Record<string, RouteName>;

  setPeriod(p: StatsPeriod): void;
  /** 翻期：+1 下一期、−1 上一期；不能翻到未來（到本期就停） */
  step(delta: number): void;
  toCurrent(): void;
  setFilter(id: string | null): void;
  weekStep(delta: number): void;
  weekToCurrent(): void;
  /** 統計頁掛上／需要重算時叫；叫了就算「開著」。回傳的 promise 在這一輪（含合併進來的重算）算完時 resolve */
  load(): Promise<void>;
  /** 週視圖同上 */
  loadWeek(): Promise<void>;
  /** 離開統計頁／週視圖時叫，停止自動重算 */
  release(kind: "stats" | "week"): void;
  /** #72：算的時候的今天跟現在的今天不同 ⇒ 重算（只比字串；沒開著就什麼都不做） */
  checkDay(): void;
}

/* ───────── 模組層狀態 ───────── */

const attached = { stats: false, week: false };
let periodRestored = false;

/** node_id → 所屬路線（`rev` 變不清；nodeStore 的 tree 裡那個節點解出來的路線變了才清，見訂閱） */
const nodeRouteCache = new Map<string, NodeRoute>();
/** 上一趟統計「趨勢窗內」出現過的節點 id、結果裡用到的路線 id（nodeStore 變動只在跟這兩組有關時才重算；評審 #10） */
let windowNodeIds = new Set<string>();
let usedRouteKeys: string[] = [];
/** 目標需要的歷史比趨勢窗還早時，那一份 listBlocks 的快取（只在 rev 變、或換日時重抓；評審 #4） */
let goalSpansCache: { rev: number; today: string; from: number; spans: StatsSpan[] } | null = null;

const uiNow = () => useUiStore.getState();

function currentKeyOf(p: StatsPeriod): string {
  const { dayStartHour: h, weekStart } = uiNow();
  return periodWindow(p, todayKey(h, new Date()), h, weekStart).key;
}

function currentWeekKey(): string {
  return currentKeyOf("week");
}

function storageKey(): string {
  return timetableShell() === "mobile" ? `${KEY_STATS_PERIOD}_mobile` : KEY_STATS_PERIOD;
}

async function restorePeriodOnce(): Promise<void> {
  if (periodRestored) return;
  periodRestored = true;
  try {
    const raw = await settingsRepo.get(storageKey());
    if (raw === "day" || raw === "week" || raw === "month") {
      const s = useTimetableStatsStore.getState();
      if (raw !== s.period) {
        const { dayStartHour: h, weekStart } = uiNow();
        useTimetableStatsStore.setState({ period: raw, key: resolveViewKey(raw, s.followCurrent, s.ref, todayKey(h, new Date()), h, weekStart) });
      }
    }
  } catch {
    /* 本機鍵讀不到就用預設（週） */
  }
}

/** 把窗內出現過的 node_id 解成所屬路線（逐一 getNode，Promise.all；快取；讀失敗當找不到） */
async function resolveNodeRoutes(spans: readonly StatsSpan[]): Promise<void> {
  const want = new Set<string>();
  for (const s of spans) if (s.nodeId !== null && !nodeRouteCache.has(s.nodeId)) want.add(s.nodeId);
  if (!want.size) return;
  const ids = Array.from(want);
  const nodes = await Promise.all(ids.map((id) => nodeRepo.getNode(id).catch(() => null)));
  ids.forEach((id, i) => {
    const n = nodes[i];
    if (!n || n.deleted_at !== null) nodeRouteCache.set(id, { gone: true, routeId: null });
    else nodeRouteCache.set(id, { gone: false, routeId: n.kind === "route" ? n.id : n.route_id });
  });
}

/** 0-9 依路線（規則在純函式 `routeKeyOf`；這裡只負責餵它快取的節點解析結果） */
function routeOf(s: StatsSpan): string {
  return routeKeyOf(s, s.nodeId === null ? undefined : nodeRouteCache.get(s.nodeId));
}

/** 這一塊的門檻分鐘：已結束的＝預估 → 分類預設 → 全域；運行中那班多一層任務的預計時間（與 `blockIsLongRun` 一致，0-8） */
function thresholdFn(): (s: StatsSpan) => number | null {
  const { catById, longRunMaxMin, linkInfo } = useTimetableStore.getState();
  return (s) =>
    thresholdOf(
      s.estimateMin,
      catById[s.categoryId] ?? null,
      longRunMaxMin,
      s.end === null ? taskEstimateOf({ node_id: s.nodeId, route_id: s.routeId }, linkInfo) : null,
    )?.min ?? null;
}

async function routeNamesOf(result: StatsResult): Promise<Record<string, RouteName>> {
  const out: Record<string, RouteName> = {};
  const live = new Map(useNodeStore.getState().routes.filter((r) => r.deleted_at === null).map((r) => [r.id, r.name] as const));
  const missing: string[] = [];
  for (const r of result.routes) {
    if (r.key === ROUTE_NONE || r.key === ROUTE_GONE) continue;
    const name = live.get(r.key);
    if (name !== undefined) out[r.key] = { name, deleted: false };
    else missing.push(r.key);
  }
  if (missing.length) {
    const nodes = await Promise.all(missing.map((id) => nodeRepo.getNode(id).catch(() => null)));
    missing.forEach((id, i) => {
      const n = nodes[i];
      out[id] = n ? { name: n.name, deleted: n.deleted_at !== null } : { name: "（已刪除的路線）", deleted: true };
    });
  }
  return out;
}

/* ───────── 計算（一趟一趟排隊，重算請求合併） ───────── */

let statsRunning: Promise<void> | null = null;
let statsDirty = false;
let weekRunning: Promise<void> | null = null;
let weekDirty = false;

/**
 * 目標要用的時間塊（不做節點查詢）：起點不早於趨勢窗那一份（`statsSpans` 已涵蓋到現在）⇒ 直接用；
 * 更早（since 目標起點一年前）⇒ 另讀 `[goalFrom, now]`，同一個 `rev`＋同一天內重用（翻期不重抓）。
 */
async function goalSpansFor(
  goalFrom: number | null,
  statsFrom: number,
  statsSpans: StatsSpan[],
  now: number,
  today: string,
  rev: number,
): Promise<StatsSpan[]> {
  if (goalFrom === null) return [];
  if (goalFrom >= statsFrom) return statsSpans;
  const c = goalSpansCache;
  if (c && c.rev === rev && c.today === today && c.from <= goalFrom) return c.spans;
  const rows = await timetableRepo.listBlocksSlim(isoOf(goalFrom), isoOf(now));
  const spans = rows.map(toStatsSpan);
  goalSpansCache = { rev, today, from: goalFrom, spans };
  return spans;
}

async function computeStats(): Promise<void> {
  const tt = useTimetableStore.getState();
  if (!tt.ready) return; // 起手分類與第一次 refresh 還沒好：等 ready／rev 變了再來（訂閱會叫）
  const st = useTimetableStatsStore.getState();
  const { dayStartHour: h, weekStart } = uiNow();
  const { period, followCurrent: follow, ref } = st;
  const now = Date.now();
  const today = todayKey(h, new Date(now));
  const key = resolveViewKey(period, follow, ref, today, h, weekStart);
  useTimetableStatsStore.setState({ loading: true });
  try {
    const goalRows = await timetableRepo.listGoals();
    const all: Goal[] = [];
    for (const r of goalRows) {
      const g = parseGoal(r, h);
      if (g) all.push(g);
    }
    const active = all.filter((g) => !g.archived);
    const archivedGoals = all.filter((g) => g.archived);
    const from = statsFromMs(period, key, h, weekStart);
    const win = periodWindow(period, key, h, weekStart);
    const rows = await timetableRepo.listBlocksSlim(isoOf(from), isoOf(Math.max(now, win.end)));
    const spans = rows.map(toStatsSpan);
    // 節點只解趨勢窗內的塊（目標另算、不查節點）
    await resolveNodeRoutes(spans);
    windowNodeIds = new Set(spans.flatMap((s) => (s.nodeId === null ? [] : [s.nodeId])));
    const th = thresholdFn();
    const cats = useTimetableStore.getState().categories;
    const result = buildStats({ spans, cats, goals: active, period, key, now, h, weekStart, thresholdMin: th, routeOf });
    const goalSpans = await goalSpansFor(goalsFromMs(active, now, h, weekStart), from, spans, now, today, tt.rev);
    const goals = buildGoals(active, goalSpans, cats, { now, h, weekStart, thresholdMin: th });
    const routeNames = await routeNamesOf(result);
    // 算的期間使用者又換了期 ⇒ 這份作廢（下一趟已經排好；沒排下一趟〔例如已 release〕就把 loading 放下）
    const cur = useTimetableStatsStore.getState();
    if (viewChangedSince({ period, follow, key }, { period: cur.period, follow: cur.followCurrent, ref: cur.ref }, today, h, weekStart)) {
      if (!statsDirty) useTimetableStatsStore.setState({ loading: false });
      return;
    }
    usedRouteKeys = result.routes.map((r) => r.key);
    useTimetableStatsStore.setState({ key, result, goals, goalList: active, archivedGoals, routeNames, loading: false, error: null });
  } catch (e) {
    useTimetableStatsStore.setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

async function computeWeek(): Promise<void> {
  const tt = useTimetableStore.getState();
  if (!tt.ready) return;
  const st = useTimetableStatsStore.getState();
  const { dayStartHour: h, weekStart } = uiNow();
  const { weekFollow: follow, weekRef: ref } = st;
  const now = Date.now();
  const today = todayKey(h, new Date(now));
  const key = resolveViewKey("week", follow, ref, today, h, weekStart);
  try {
    const win = periodWindow("week", key, h, weekStart);
    const rows = await timetableRepo.listBlocksSlim(isoOf(win.start), isoOf(Math.max(now, win.end)));
    const spans = rows.map(toStatsSpan);
    const week = buildWeek({ spans, key, now, h, weekStart, thresholdMin: thresholdFn() });
    const cur = useTimetableStatsStore.getState();
    if (viewChangedSince({ period: "week", follow, key }, { period: "week", follow: cur.weekFollow, ref: cur.weekRef }, today, h, weekStart)) return;
    useTimetableStatsStore.setState({ weekKey: key, week, error: null });
  } catch (e) {
    useTimetableStatsStore.setState({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** 排一趟統計：正在算 ⇒ 標記「算完再來一趟」並回同一個 promise */
function runStats(): Promise<void> {
  if (statsRunning) {
    statsDirty = true;
    return statsRunning;
  }
  statsRunning = (async () => {
    try {
      do {
        statsDirty = false;
        await computeStats();
      } while (statsDirty);
    } finally {
      statsRunning = null;
    }
  })();
  return statsRunning;
}

function runWeek(): Promise<void> {
  if (weekRunning) {
    weekDirty = true;
    return weekRunning;
  }
  weekRunning = (async () => {
    try {
      do {
        weekDirty = false;
        await computeWeek();
      } while (weekDirty);
    } finally {
      weekRunning = null;
    }
  })();
  return weekRunning;
}

function reloadOpen(): void {
  if (attached.stats) void runStats();
  if (attached.week) void runWeek();
}

/* ───────── store ───────── */

export const useTimetableStatsStore = create<StatsState>((set, get) => ({
  period: "week",
  key: currentKeyOf("week"),
  ref: currentKeyOf("week"),
  followCurrent: true,
  weekKey: currentWeekKey(),
  weekRef: currentWeekKey(),
  weekFollow: true,
  filterCategoryId: null,
  loading: false,
  error: null,
  result: null,
  week: null,
  goals: [],
  goalList: [],
  archivedGoals: [],
  routeNames: {},

  setPeriod(p) {
    const s = get();
    if (p === s.period) return;
    const { dayStartHour: h, weekStart } = uiNow();
    const curKey = currentKeyOf(p);
    // 停在本期就跟著今天；翻到過去某一期的，換成「包含那一天」的新期（參考日不動）。
    // 沒開著（已 release）也照改——下次 load() 會依這個狀態重算
    const key = resolveViewKey(p, s.followCurrent, s.ref, todayKey(h, new Date()), h, weekStart);
    set({ period: p, key, followCurrent: key === curKey, filterCategoryId: null });
    void settingsRepo.set(storageKey(), p).catch(() => undefined);
    if (attached.stats) void runStats();
  },

  step(delta) {
    const s = get();
    const { dayStartHour: h, weekStart } = uiNow();
    const r = stepView(s.period, s.followCurrent, s.ref, todayKey(h, new Date()), delta, h, weekStart); // 未來的期不能翻
    if (!r) return;
    set({ key: r.key, ref: r.ref, followCurrent: r.follow });
    if (attached.stats) void runStats();
  },

  toCurrent() {
    const s = get();
    const cur = currentKeyOf(s.period);
    set({ key: cur, ref: cur, followCurrent: true });
    if (attached.stats) void runStats();
  },

  setFilter(id) {
    set({ filterCategoryId: id });
  },

  weekStep(delta) {
    const s = get();
    const { dayStartHour: h, weekStart } = uiNow();
    const r = stepView("week", s.weekFollow, s.weekRef, todayKey(h, new Date()), delta, h, weekStart);
    if (!r) return;
    set({ weekKey: r.key, weekRef: r.ref, weekFollow: r.follow });
    if (attached.week) void runWeek();
  },

  weekToCurrent() {
    const cur = currentWeekKey();
    set({ weekKey: cur, weekRef: cur, weekFollow: true });
    if (attached.week) void runWeek();
  },

  async load() {
    attached.stats = true;
    await restorePeriodOnce();
    await runStats();
  },

  async loadWeek() {
    attached.week = true;
    await runWeek();
  },

  release(kind) {
    attached[kind] = false;
  },

  checkDay() {
    const { dayStartHour: h } = uiNow();
    const nowKey = todayKey(h, new Date());
    if (attached.stats) {
      const r = get().result;
      if (r && dayRolledOver(r.todayKey, nowKey)) void runStats();
    }
    if (attached.week) {
      const w = get().week;
      if (w && dayRolledOver(w.todayKey, nowKey)) void runWeek();
    }
  },
}));

/* ───────── 模組層訂閱：開著的期間，上游變了就重算 ───────── */

/** 運行中那班的任務預計時間（門檻的一層，只套運行中那班；0-8）：linkInfo 變了、跟統計有關的只有這個 */
function runningTaskEstimate(s: ReturnType<typeof useTimetableStore.getState>): number | null {
  return s.running ? taskEstimateOf(s.running, s.linkInfo) : null;
}

useTimetableStore.subscribe((s, p) => {
  // 評審 #9：全域上限（設定、同步）與運行中那班的任務預計時間也是待確認的判定依據，變了就重算
  if (s.rev !== p.rev || s.ready !== p.ready || s.longRunMaxMin !== p.longRunMaxMin || runningTaskEstimate(s) !== runningTaskEstimate(p)) reloadOpen();
});

useUiStore.subscribe((s, p) => {
  if (s.dayStartHour !== p.dayStartHour || s.weekStart !== p.weekStart) {
    // 日界線、週起點變了：「停在本期」的 key 要跟著重算（computeStats 內處理）；翻到過去的期維持 key、窗跟著新設定走
    reloadOpen();
  }
});

useNodeStore.subscribe((s, p) => {
  // 評審 #10：nodeStore 任何編輯都會換 tree／routes 的物件；只在「窗內出現過的節點解出來的路線變了」或「用到的路線改名／刪除」時才重算
  let rerun = false;
  if (s.tree !== p.tree) {
    const stale = staleNodeIds(Array.from(nodeRouteCache.keys()), nodeRouteCache, p.tree.byId, s.tree.byId);
    for (const id of stale) {
      nodeRouteCache.delete(id);
      if (windowNodeIds.has(id)) rerun = true;
    }
  }
  if (s.routes !== p.routes && routesChanged(usedRouteKeys, p.routes, s.routes)) rerun = true;
  if (rerun && attached.stats) void runStats();
});
