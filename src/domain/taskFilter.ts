/**
 * 篩選清單與常用篩選（第五本第三梯 ⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §2、§3）的純邏輯，兩殼共用。
 *
 * 條件同組「任一」、跨組「而且」。範圍＝葉節點任務；收進車庫的路線不算，除非條件明確選了那條路線。
 * 有子項的列車與車廂（`has_kids`）只有「誤點」條件會收，其他條件看不到它們（見 `isTaskOverdue`）。
 * 荷札存 key（`tags.name_key`），父含子走 `isUnder`；比對需要的「這張票掛了哪些 key」由呼叫端從 tagStore.index 給。
 * 純函式、不碰 store／DOM／Tauri；import 一律帶 `.ts`（scripts/tests 直接載入）。
 */
import type { NodeRow, Priority } from "./node.ts";
import { isUnder } from "./tags.ts";

export type DueCond = "overdue" | "today" | "week" | "month" | "has" | "none";
export type TaskStatusCond = "open" | "done" | "all";
/** 版面：清單／跨路線依狀態看板 */
export type FilterLayout = "list" | "board";
export type TaskSort = "smart" | "scheduled" | "priority" | "updated";

/** `routes` 裡代表「沒掛路線的臨時車票」的值 */
export const TEMP_ROUTE = "temp";

export interface TaskFilter {
  /** 路線 id 或 TEMP_ROUTE；空＝不限 */
  routes: string[];
  /** 荷札 key；空＝不限 */
  tags: string[];
  due: DueCond | null;
  status: TaskStatusCond;
  late: boolean;
  high: boolean;
}

export const DEFAULT_TASK_FILTER: TaskFilter = { routes: [], tags: [], due: null, status: "open", late: false, high: false };

export function isDefaultTaskFilter(f: TaskFilter): boolean {
  return !f.routes.length && !f.tags.length && f.due === null && f.status === "open" && !f.late && !f.high;
}

export const DUE_LABEL: Record<DueCond, string> = {
  overdue: "已過",
  today: "今天",
  week: "7 天內",
  month: "本月",
  has: "有締切",
  none: "沒有締切",
};
export const STATUS_COND_LABEL: Record<TaskStatusCond, string> = { open: "未済", done: "済", all: "全部" };
export const TASK_SORT_LABEL: Record<TaskSort, string> = { smart: "締切", scheduled: "執行日", priority: "優先", updated: "最近更新" };

/** 目前班次（定期券才有）的最小形狀 */
export interface OccurrenceLike {
  status: string;
  due_on: string;
}

/** repository `listTasks` 的一列：`has_kids`＝底下還有活的子項（這種列不是卡） */
export type TaskRow = NodeRow & { has_kids?: boolean };

export type TaskNode = Pick<NodeRow, "id" | "kind" | "parent_id" | "route_id" | "status" | "scheduled_on" | "due_on" | "priority" | "updated_at"> & { has_kids?: boolean };

/** 済了沒：活著的定期券看目前班次（同 routeHead.isRouteNodeDone） */
export function isTaskDone(node: Pick<NodeRow, "status">, occ: OccurrenceLike | undefined): boolean {
  return occ ? occ.status === "done" : node.status === "done";
}

/** 有結局＝済或本班運休；有結局就不算誤點、也不算締切已過（同 OutlineRow 的 settled） */
export function isTaskSettled(node: Pick<NodeRow, "status">, occ: OccurrenceLike | undefined): boolean {
  return isTaskDone(node, occ) || occ?.status === "skipped";
}

/** 誤點＝過了執行日還沒有結局（定期券講「這一班」那天；同 OutlineRow 的 schedLate） */
export function isTaskLate(node: Pick<NodeRow, "status" | "scheduled_on">, occ: OccurrenceLike | undefined, today: string): boolean {
  const railDate = occ?.due_on ?? node.scheduled_on;
  return !!railDate && railDate < today && !isTaskSettled(node, occ);
}

/**
 * 「誤點」條件與排序的口徑：過了執行日沒結局，加上沒排執行日而締切已到或已過——單列判定跟路線一覽與今日頁的誤點數（`dayCount.lateCount`）同一把尺。
 * 那個數字也算有子項的列車與車廂，所以「誤點」條件打開時 `matchTask` 把它們一起收，「誤點 N」點進來才對得上數；其他條件照舊只看葉節點。
 * 票面的延着章照舊只看執行日（`isTaskLate`，同大綱）。
 */
export function isTaskOverdue(node: Pick<NodeRow, "status" | "scheduled_on" | "due_on">, occ: OccurrenceLike | undefined, today: string): boolean {
  if (isTaskLate(node, occ, today)) return true;
  return !occ && !node.scheduled_on && !!node.due_on && node.due_on <= today && !isTaskSettled(node, occ);
}

/** 兩個 YYYY-MM-DD 差幾天（b − a）；用 UTC 算，不受日光節約影響 */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function matchDue(cond: DueCond, node: TaskNode, occ: OccurrenceLike | undefined, today: string): boolean {
  const due = node.due_on;
  if (cond === "none") return !due;
  if (!due) return false;
  switch (cond) {
    case "has":
      return true;
    case "overdue":
      return due < today && !isTaskSettled(node, occ);
    case "today":
      return due === today;
    case "week": {
      const d = dayDiff(today, due);
      return d >= 0 && d <= 7;
    }
    case "month":
      return due.slice(0, 7) === today.slice(0, 7);
  }
}

/**
 * 這張票算哪條路線：掛路線的臨時車票算那條路線（route_id 就是標籤）；沒路線＝TEMP_ROUTE。
 * 路線刪了、票還掛著標籤（`softDelete` 只走 parent_id 子樹）：畫面顯示「臨時車票」，比對與計數也算臨時車票；資料不改，復原路線就回去。
 */
export function routeKeyOf(node: Pick<NodeRow, "route_id">, aliveRoute?: (id: string) => boolean): string {
  if (!node.route_id) return TEMP_ROUTE;
  return aliveRoute && !aliveRoute(node.route_id) ? TEMP_ROUTE : node.route_id;
}

export interface TaskFilterCtx {
  today: string;
  occurrences: Readonly<Record<string, OccurrenceLike | undefined>>;
  /** 這張票掛的荷札 keys */
  tagsOf(id: string): readonly string[];
  /** 收進車庫的路線 id */
  depot: ReadonlySet<string>;
  /** 還存在的路線與荷札（指到已刪的條件不參與比對，§3）；省略＝都當存在 */
  aliveRoute?(id: string): boolean;
  aliveTag?(key: string): boolean;
}

export function matchTask(node: TaskNode, f: TaskFilter, ctx: TaskFilterCtx): boolean {
  if (node.has_kids && !f.late) return false;
  const occ = ctx.occurrences[node.id];
  const routes = ctx.aliveRoute ? f.routes.filter((r) => r === TEMP_ROUTE || ctx.aliveRoute!(r)) : f.routes;
  const tags = ctx.aliveTag ? f.tags.filter((k) => ctx.aliveTag!(k)) : f.tags;
  const route = routeKeyOf(node, ctx.aliveRoute);
  if (routes.length ? !routes.includes(route) : ctx.depot.has(route)) return false;
  if (tags.length) {
    const mine = ctx.tagsOf(node.id);
    if (!tags.some((k) => mine.some((m) => isUnder(m, k)))) return false;
  }
  if (f.status !== "all" && isTaskDone(node, occ) !== (f.status === "done")) return false;
  if (f.due && !matchDue(f.due, node, occ, ctx.today)) return false;
  if (f.late && !isTaskOverdue(node, occ, ctx.today)) return false;
  if (f.high && node.priority !== "high") return false;
  return true;
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, mid: 1, low: 2 };

/** 沒有日期的排最後 */
function byDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

/**
 * 排序：smart＝誤點在前→締切近→執行日近；其餘照各自的欄；最後都以 id 定序（兩台順序一致）。
 * 比較用位元組序，不用 localeCompare（日期與 id 都是 ASCII，同 nodeOrder 的規矩）。
 */
export function sortTasks<N extends TaskNode>(nodes: readonly N[], sort: TaskSort, ctx: Pick<TaskFilterCtx, "today" | "occurrences">): N[] {
  const late = (n: N) => (isTaskOverdue(n, ctx.occurrences[n.id], ctx.today) ? 0 : 1);
  const tie = (a: N, b: N) => byDate(a.due_on, b.due_on) || byDate(a.scheduled_on, b.scheduled_on) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...nodes].sort((a, b) => {
    switch (sort) {
      case "smart":
        return late(a) - late(b) || tie(a, b);
      case "scheduled":
        return byDate(a.scheduled_on, b.scheduled_on) || tie(a, b);
      case "priority":
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || tie(a, b);
      case "updated":
        return (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0) || tie(a, b);
    }
  });
}

/**
 * 荷札改過名：條件裡的舊 key 換成現在的 key（連續改名照鏈走；碰到環就停在環上最後一個沒走過的值）。存檔不動，下次寫入才落地——
 * 只讀不寫，兩台才不會因為各自「修正」互相蓋檔。回傳同一個物件＝沒變。
 */
export function followTagRenames(f: TaskFilter, renames: readonly { from: string; to: string }[]): TaskFilter {
  if (!f.tags.length || !renames.length) return f;
  const next = new Map(renames.map((r) => [r.from, r.to]));
  const resolve = (key: string): string => {
    const seen = new Set([key]);
    let cur = key;
    for (let to = next.get(cur); to !== undefined && !seen.has(to); to = next.get(cur)) {
      seen.add(to);
      cur = to;
    }
    return cur;
  };
  const tags = [...new Set(f.tags.map(resolve))];
  return tags.length === f.tags.length && tags.every((k, i) => k === f.tags[i]) ? f : { ...f, tags };
}

/* ── 常用篩選：settings 一格 JSON ── */

export interface SavedFilter {
  id: string;
  name: string;
  filter: TaskFilter;
  layout: FilterLayout;
}

const DUE_VALUES: readonly string[] = ["overdue", "today", "week", "month", "has", "none"];
const STATUS_VALUES: readonly string[] = ["open", "done", "all"];

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

/** 不認得的欄丟掉、壞值回預設——另一台版本比較新時不炸（§3） */
export function parseTaskFilter(raw: unknown): TaskFilter {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    routes: stringList(o.routes),
    tags: stringList(o.tags),
    due: typeof o.due === "string" && DUE_VALUES.includes(o.due) ? (o.due as DueCond) : null,
    status: typeof o.status === "string" && STATUS_VALUES.includes(o.status) ? (o.status as TaskStatusCond) : "open",
    late: o.late === true,
    high: o.high === true,
  };
}

export function parseSavedFilters(raw: string | null | undefined): SavedFilter[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: SavedFilter[] = [];
  for (const it of v) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || seen.has(o.id)) continue;
    if (typeof o.name !== "string" || !o.name.trim()) continue;
    seen.add(o.id);
    out.push({ id: o.id, name: o.name, filter: parseTaskFilter(o.filter), layout: o.layout === "board" ? "board" : "list" });
  }
  return out;
}

export function serializeSavedFilters(list: readonly SavedFilter[]): string {
  return JSON.stringify(list);
}

/** 版面與排序的記憶（本機設定）：不認得的值回預設 */
export const parseFilterLayout = (raw: string | null): FilterLayout => (raw === "board" ? "board" : "list");
export const parseTaskSort = (raw: string | null): TaskSort =>
  raw === "scheduled" || raw === "priority" || raw === "updated" ? raw : "smart";
