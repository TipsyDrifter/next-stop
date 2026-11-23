/**
 * 篩選清單與常用篩選（第五本第三梯 ⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §2、§3）的純邏輯，兩殼共用。
 *
 * 條件同組「任一」、跨組「而且」。範圍＝列車／車廂／車票任務（含掛在列車／車廂上的條件）；收進車庫的路線不算，除非條件明確選了那條路線。
 * 荷札存 key（`tags.name_key`），父含子走 `isUnder`；比對需要的「這張票掛了哪些 key」由呼叫端從 tagStore.index 給。
 * 純函式、不碰 store／DOM／Tauri；import 一律帶 `.ts`（scripts/tests 直接載入）。
 */
import type { NodeKind, NodeRow, Priority } from "./node.ts";
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
export const TASK_SORT_LABEL: Record<TaskSort, string> = { smart: "締切", scheduled: "乘車日", priority: "優先", updated: "最近更新" };

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

/** 有結局＝済、途中下車（paused）或本班運休；有結局就不算誤點、也不算締切已過（同 OutlineRow 的 settled） */
export function isTaskSettled(node: Pick<NodeRow, "status">, occ: OccurrenceLike | undefined): boolean {
  return isTaskDone(node, occ) || node.status === "paused" || occ?.status === "skipped";
}

/** 誤點＝過了乘車日還沒有結局（定期券講「這一班」那天；同 OutlineRow 的 schedLate） */
export function isTaskLate(node: Pick<NodeRow, "status" | "scheduled_on">, occ: OccurrenceLike | undefined, today: string): boolean {
  const railDate = occ?.due_on ?? node.scheduled_on;
  return !!railDate && railDate < today && !isTaskSettled(node, occ);
}

/**
 * 「誤點」條件與排序的口徑：過了乘車日沒結局，加上沒排乘車日而締切已到或已過——單列判定跟路線一覽與今日頁的誤點數（`dayCount.lateCount`）同一把尺。
 * 那個數字也算有子項的列車與車廂，所以「誤點」條件打開時 `matchTask` 把它們一起收，「誤點 N」點進來才對得上數；其他條件照舊只看葉節點。
 * 票面的延着章照舊只看乘車日（`isTaskLate`，同大綱）。
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
  const occ = ctx.occurrences[node.id];
  const routes = ctx.aliveRoute ? f.routes.filter((r) => r === TEMP_ROUTE || ctx.aliveRoute!(r)) : f.routes;
  const tags = ctx.aliveTag ? f.tags.filter((k) => ctx.aliveTag!(k)) : f.tags;
  const route = routeKeyOf(node, ctx.aliveRoute);
  if (routes.length ? !routes.includes(route) : ctx.depot.has(route)) return false;
  if (tags.length) {
    const mine = ctx.tagsOf(node.id);
    if (!tags.some((k) => mine.some((m) => isUnder(m, k)))) return false;
  }
  if (f.status === "open" && isTaskSettled(node, occ)) return false;
  if (f.status === "done" && !isTaskDone(node, occ)) return false;
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
 * 排序：smart＝誤點在前→締切近→乘車日近；其餘照各自的欄；最後都以 id 定序（兩台順序一致）。
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

/* ── 命中子樹縮排視圖（Bug 2 · D-FB-1） ── */

export interface FilteredOutlineHolder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface FilteredOutlineRoute {
  id: string;
}

export type FilteredOutlineRole = "hit" | "ancestor" | "child";

export interface FilteredOutlineItem<T extends TaskNode & { name: string } = TaskRow> {
  id: string;
  kind: NodeKind;
  name: string;
  parentId: string | null;
  routeId: string | null;
  depth: number;
  /** true＝本身直接命中篩選條件；false＝為補齊脈絡的祖先容器或命中母列車帶出的子項 */
  matched: boolean;
  role: FilteredOutlineRole;
  /** train／car／ticket 帶原列；branch 為 null（holders 只帶最小容器欄位） */
  node: T | null;
  /** 容器進度（供進度環顯示）；葉節點或無任務子孫為 null */
  progress: { done: number; total: number } | null;
}

export interface FilteredOutlineGroup<T extends TaskNode & { name: string } = TaskRow> {
  /** 路線 id 或 TEMP_ROUTE（未掛路線／已刪路線的臨時車票） */
  routeKey: string;
  /** 路線 id；TEMP_ROUTE 為 null */
  routeId: string | null;
  items: FilteredOutlineItem<T>[];
}

export interface BuildFilteredOutlineOptions<T extends TaskNode & { name: string } = TaskRow> {
  matched: readonly T[];
  allTasks: readonly T[];
  holders: readonly FilteredOutlineHolder[];
  routes: readonly FilteredOutlineRoute[];
  aliveRoute?: (id: string) => boolean;
  occurrences?: Readonly<Record<string, OccurrenceLike | undefined>>;
  /** 母列車／車廂本身命中時，是否自動帶出底下未單獨被過濾排除的子項（預設 true） */
  includeMatchedSubtree?: boolean;
  /** 決定命中母列車／車廂底下的子項是否一併呈現；省略＝全部存活子項皆呈現 */
  childVisible?: (child: T) => boolean;
}

/**
 * 篩選清單「命中子樹縮排視圖」（Bug 2）：
 * 在預設／路線排序下，將命中的節點按「路線 → 上層支線／列車／車廂標題脈絡（含未直接命中但有子孫命中的祖先容器）
 * → 縮排子車票」組裝成結構化樹狀清單。零 UI／DOM／Store 依賴。
 */
export function buildFilteredOutlineGroups<T extends TaskNode & { name: string } = TaskRow>(
  opts: BuildFilteredOutlineOptions<T>,
): FilteredOutlineGroup<T>[] {
  if (!opts.matched.length) return [];

  const taskById = new Map<string, T>();
  for (const t of opts.allTasks) taskById.set(t.id, t);
  for (const m of opts.matched) if (!taskById.has(m.id)) taskById.set(m.id, m);

  const holderById = new Map<string, FilteredOutlineHolder>();
  for (const h of opts.holders) holderById.set(h.id, h);

  const parentOf = (id: string): string | null => taskById.get(id)?.parent_id ?? holderById.get(id)?.parent_id ?? null;

  const childrenTasksByParent = new Map<string | null, T[]>();
  for (const t of opts.allTasks) {
    let list = childrenTasksByParent.get(t.parent_id);
    if (!list) childrenTasksByParent.set(t.parent_id, (list = []));
    list.push(t);
  }

  const childrenHoldersByParent = new Map<string | null, FilteredOutlineHolder[]>();
  for (const h of opts.holders) {
    let list = childrenHoldersByParent.get(h.parent_id);
    if (!list) childrenHoldersByParent.set(h.parent_id, (list = []));
    list.push(h);
  }

  const roleById = new Map<string, FilteredOutlineRole>();
  const routeKeyById = new Map<string, string>();
  const includeSubtree = opts.includeMatchedSubtree !== false;

  for (const m of opts.matched) {
    roleById.set(m.id, "hit");
    routeKeyById.set(m.id, routeKeyOf(m, opts.aliveRoute));
  }

  if (includeSubtree) {
    const walkKids = (parentId: string, rk: string, seen: Set<string>): void => {
      for (const c of childrenTasksByParent.get(parentId) ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (opts.childVisible && !opts.childVisible(c)) continue;
        if (!roleById.has(c.id)) roleById.set(c.id, "child");
        if (!routeKeyById.has(c.id)) routeKeyById.set(c.id, rk);
        walkKids(c.id, rk, seen);
      }
    };
    for (const m of opts.matched) {
      if (m.kind === "train" || m.kind === "car") {
        walkKids(m.id, routeKeyById.get(m.id)!, new Set([m.id]));
      }
    }
  }

  for (const id of [...roleById.keys()]) {
    const rk = routeKeyById.get(id) ?? TEMP_ROUTE;
    let cur = parentOf(id);
    const seen = new Set<string>([id]);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (!taskById.has(cur) && !holderById.has(cur)) break;
      if (!roleById.has(cur)) roleById.set(cur, "ancestor");
      if (!routeKeyById.has(cur)) routeKeyById.set(cur, rk);
      cur = parentOf(cur);
    }
  }

  const progressOf = (id: string, kind: NodeKind): { done: number; total: number } | null => {
    if (kind === "ticket") return null;
    const direct = childrenTasksByParent.get(id) ?? [];
    if (direct.length > 0) {
      let done = 0;
      for (const k of direct) {
        if (opts.occurrences ? isTaskDone(k, opts.occurrences[k.id]) : k.status === "done") done++;
      }
      return { done, total: direct.length };
    }
    if (kind !== "branch") return null;
    // 支線底下只有子支線、沒有直屬任務時，往子支線下統計任務進度
    const tasksUnder: T[] = [];
    const stack = [...(childrenHoldersByParent.get(id) ?? []).map((h) => h.id)];
    const seen = new Set<string>([id]);
    while (stack.length) {
      const hid = stack.pop()!;
      if (seen.has(hid)) continue;
      seen.add(hid);
      const tKids = childrenTasksByParent.get(hid);
      if (tKids?.length) tasksUnder.push(...tKids);
      for (const sub of childrenHoldersByParent.get(hid) ?? []) stack.push(sub.id);
    }
    if (!tasksUnder.length) return null;
    let done = 0;
    for (const k of tasksUnder) {
      if (opts.occurrences ? isTaskDone(k, opts.occurrences[k.id]) : k.status === "done") done++;
    }
    return { done, total: tasksUnder.length };
  };

  const mergeOrder = (holderKids: readonly FilteredOutlineHolder[], taskKids: readonly T[]): string[] => {
    const holderIndex = new Map<string, number>();
    holderKids.forEach((h, i) => holderIndex.set(h.id, i));
    const emitted = new Set<string>();
    const out: string[] = [];
    let hi = 0;
    for (const t of taskKids) {
      const idx = holderIndex.get(t.id);
      if (idx !== undefined) {
        while (hi < idx) {
          const hid = holderKids[hi++].id;
          if (!emitted.has(hid)) {
            emitted.add(hid);
            out.push(hid);
          }
        }
      }
      if (!emitted.has(t.id)) {
        emitted.add(t.id);
        out.push(t.id);
      }
    }
    while (hi < holderKids.length) {
      const hid = holderKids[hi++].id;
      if (!emitted.has(hid)) {
        emitted.add(hid);
        out.push(hid);
      }
    }
    return out;
  };

  const isTopInRoute = (id: string): boolean => {
    const p = parentOf(id);
    return !p || (!taskById.has(p) && !holderById.has(p));
  };

  const buildGroup = (routeKey: string): FilteredOutlineItem<T>[] => {
    const topHolders =
      routeKey === TEMP_ROUTE
        ? []
        : (childrenHoldersByParent.get(routeKey) ?? []).filter((h) => roleById.has(h.id) && routeKeyById.get(h.id) === routeKey);
    const topTasks = opts.allTasks.filter((t) => roleById.has(t.id) && routeKeyById.get(t.id) === routeKey && isTopInRoute(t.id));
    // matched 中可能出現未在 allTasks 裡的測試資料，補入 topTasks
    const topTaskSet = new Set(topTasks.map((t) => t.id));
    for (const m of opts.matched) {
      if (!topTaskSet.has(m.id) && routeKeyById.get(m.id) === routeKey && isTopInRoute(m.id)) {
        topTasks.push(m);
      }
    }

    const items: FilteredOutlineItem<T>[] = [];
    const visited = new Set<string>();

    const visit = (id: string, depth: number): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const task = taskById.get(id) ?? null;
      const holder = holderById.get(id) ?? null;
      const kind: NodeKind = task ? task.kind : "branch";
      const name = task ? task.name : (holder?.name ?? "");
      const role = roleById.get(id) ?? "ancestor";
      items.push({
        id,
        kind,
        name,
        parentId: parentOf(id),
        routeId: task ? task.route_id : (routeKey === TEMP_ROUTE ? null : routeKey),
        depth,
        matched: role === "hit",
        role,
        node: task,
        progress: progressOf(id, kind),
      });

      const subHolders = (childrenHoldersByParent.get(id) ?? []).filter((h) => roleById.has(h.id));
      const subTasks = (childrenTasksByParent.get(id) ?? []).filter((t) => roleById.has(t.id));
      for (const childId of mergeOrder(subHolders, subTasks)) {
        visit(childId, depth + 1);
      }
    };

    for (const rootId of mergeOrder(topHolders, topTasks)) {
      visit(rootId, 0);
    }
    return items;
  };

  const groups: FilteredOutlineGroup<T>[] = [];
  const seenKeys = new Set<string>();

  for (const r of opts.routes) {
    if (seenKeys.has(r.id)) continue;
    seenKeys.add(r.id);
    const items = buildGroup(r.id);
    if (items.length) groups.push({ routeKey: r.id, routeId: r.id, items });
  }

  const extraKeys = [...new Set(routeKeyById.values())]
    .filter((k) => k !== TEMP_ROUTE && !seenKeys.has(k))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const k of extraKeys) {
    seenKeys.add(k);
    const items = buildGroup(k);
    if (items.length) groups.push({ routeKey: k, routeId: k, items });
  }

  if ([...routeKeyById.values()].includes(TEMP_ROUTE)) {
    const items = buildGroup(TEMP_ROUTE);
    if (items.length) groups.push({ routeKey: TEMP_ROUTE, routeId: null, items });
  }

  return groups;
}
