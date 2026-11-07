/**
 * useTaskFilter——篩選清單的結果與條件選項（⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §2、§3）。桌機 FilterView 與手機篩選共用。
 *
 * 比對與排序在 domain/taskFilter.ts；這裡接資料：
 *   - 任務從 boardStore（repository 原始結果）。掛上重查一次，之後 nodeStore 的切片換物件＝資料變了就再查（同完整搜尋）。
 *   - 荷札從 tagStore.index 比對（`entityType='node'`），index 沒載就載。指到已刪路線、荷札的條件不參與比對（`matchTask` 已會略過），
 *     這裡回 `deadRoutes`／`deadTags` 給畫面淡掉 chip，存檔不改寫（復原路線就回來）。
 *   - 路徑字：沿 holders 往上爬（不含路線與自己）。
 * 看板版面＝四欄就是狀態：狀態條件不算（`boardLayout`），有子項的列車不是卡（只在清單版面的「誤點」出現）。
 * 欄也在這裡算（兩殼同一份）：済欄跟大綱同一個開關（uiStore.hideDone），預設收成窄條；打開時只畫最近完成的 100 張（domain/board.recentDoneCards）。
 * 列的物件能留就留（內容沒變的列同一個物件）：一次寫入只有動到的那幾列重畫。
 */
import { useEffect, useMemo, useRef } from "react";
import { todayKey } from "../../lib/date";
import type { NodeRow } from "../../domain";
import { useBoardStore } from "../../store/boardStore";
import { useNodeStore } from "../../store/nodeStore";
import { useTagStore } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";
import { STATUS_COLUMNS, STATUS_COLUMN_LABEL, cardStatus, recentDoneCards } from "../../domain/board";
import {
  DUE_LABEL,
  TEMP_ROUTE,
  matchTask,
  routeKeyOf,
  sortTasks,
  type DueCond,
  type TaskFilter,
  type TaskFilterCtx,
  type TaskRow,
} from "../../domain/taskFilter";
import { isUnder } from "../../domain/tags";
import type { BoardColumnModel } from "./useRouteBoard";

export interface FilterRow {
  node: TaskRow;
  /** 祖先路徑（不含路線與自己） */
  crumb: string[];
  /** 所屬路線；沒掛路線＝null（臨時車票） */
  route: NodeRow | null;
  /** 這張掛的荷札（顯示名） */
  tags: string[];
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
  /** 荷札的層級（父含子：子往右縮） */
  depth?: number;
}

const DUE_ORDER: readonly DueCond[] = ["overdue", "today", "week", "month", "has", "none"];

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** 路線列會隨同步重載換物件：只看畫得到的那幾欄 */
const sameRoute = (a: NodeRow | null, b: NodeRow | null) =>
  a === b || (!!a && !!b && a.id === b.id && a.name === b.name && a.code === b.code && a.color === b.color && a.arrived_on === b.arrived_on);
const sameRow = (a: FilterRow, b: FilterRow) => a.node === b.node && sameRoute(a.route, b.route) && sameList(a.crumb, b.crumb) && sameList(a.tags, b.tags);

export type { TaskRow };

export function useTaskFilter() {
  const tasks = useBoardStore((s) => s.tasks);
  const holders = useBoardStore((s) => s.holders);
  const filter = useBoardStore((s) => s.filter);
  const sort = useBoardStore((s) => s.sort);
  const layout = useBoardStore((s) => s.layout);
  const routes = useNodeStore((s) => s.routes);
  const occurrences = useNodeStore((s) => s.currentOccurrences);
  const tree = useNodeStore((s) => s.tree);
  const todaySlice = useNodeStore((s) => s.today);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const index = useTagStore((s) => s.index);
  const hideDone = useUiStore((s) => s.hideDone);

  useEffect(() => void useBoardStore.getState().ensureLoaded(), []);
  // 切片每次重載都換物件，當版本號用（同 useFullSearchResults）
  useEffect(() => void useBoardStore.getState().refresh(), [tree, todaySlice, occurrences, routes]);
  useEffect(() => {
    if (!index) void useTagStore.getState().loadIndex();
  }, [index]);

  const today = todayKey(dayStartHour);
  const boardLayout = layout === "board";

  const tagsById = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of index?.ents ?? []) if (e.type === "node") m.set(e.id, e.keys);
    return m;
  }, [index]);

  const ctx = useMemo<TaskFilterCtx>(() => {
    const live = new Set(routes.map((r) => r.id));
    return {
      today,
      occurrences,
      tagsOf: (id) => tagsById.get(id) ?? [],
      depot: new Set(routes.filter((r) => r.arrived_on).map((r) => r.id)),
      aliveRoute: (id) => live.has(id),
      // index 還沒載到＝先都當存在，不要閃一下全部淡掉
      aliveTag: (key) => !index || !!index.byKey[key],
    };
  }, [routes, today, occurrences, tagsById, index]);

  const effective = useMemo<TaskFilter>(() => (boardLayout ? { ...filter, status: "all" } : filter), [filter, boardLayout]);

  const lastRows = useRef<FilterRow[]>([]);
  const rows = useMemo<FilterRow[]>(() => {
    const byId = new Map(holders.map((h) => [h.id, h]));
    const routeById = new Map(routes.map((r) => [r.id, r]));
    const crumbOf = (n: NodeRow): string[] => {
      const out: string[] = [];
      let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
      for (let guard = 0; cur && guard < 32; guard++) {
        out.unshift(cur.name);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      return out;
    };
    const hit = sortTasks(tasks.filter((n) => matchTask(n, effective, ctx) && !(boardLayout && n.has_kids)), sort, ctx);
    const prev = new Map(lastRows.current.map((r) => [r.node.id, r]));
    const next = hit.map((node) => {
      const row: FilterRow = {
        node,
        crumb: crumbOf(node),
        route: node.route_id ? (routeById.get(node.route_id) ?? null) : null,
        tags: (tagsById.get(node.id) ?? []).map((k) => index?.byKey[k]?.name ?? k),
      };
      const old = prev.get(node.id);
      return old && sameRow(old, row) ? old : row;
    });
    if (next.length === lastRows.current.length && next.every((r, i) => r === lastRows.current[i])) return lastRows.current;
    lastRows.current = next;
    return next;
  }, [tasks, holders, routes, effective, sort, ctx, tagsById, index, boardLayout]);

  /* 看板版面的四欄（兩殼同一份） */
  const columns = useMemo<BoardColumnModel[]>(() => {
    if (!boardLayout) return [];
    return STATUS_COLUMNS.map((status) => {
      const cards = rows.filter((r) => cardStatus(r.node, occurrences[r.node.id]) === status);
      const shut = status === "done" && hideDone;
      const recent = status === "done" ? recentDoneCards(cards, occurrences) : { shown: cards, rest: 0 };
      return {
        key: status,
        title: STATUS_COLUMN_LABEL[status],
        status,
        shut,
        rows: shut ? [] : recent.shown.map((r) => ({ type: "card" as const, card: { node: r.node, crumb: r.crumb } })),
        total: cards.length,
        done: status === "done" ? cards.length : 0,
        foot: !shut && recent.rest > 0 ? `還有 ${recent.rest} 張較早完成的沒顯示，到清單版面看` : undefined,
      };
    });
  }, [boardLayout, rows, occurrences, hideDone]);

  /** 看得到的順序：多選、全選、鍵盤用（看板版面不含收起來、超過上限的済） */
  const order = useMemo(
    () => (boardLayout ? columns.flatMap((c) => c.rows.flatMap((r) => (r.type === "card" ? [r.card.node.id] : []))) : rows.map((r) => r.node.id)),
    [boardLayout, columns, rows],
  );
  const doneCount = useMemo(() => columns.find((c) => c.status === "done")?.total ?? 0, [columns]);

  const deadRoutes = useMemo(() => filter.routes.filter((r) => r !== TEMP_ROUTE && !routes.some((x) => x.id === r)), [filter.routes, routes]);
  const deadTags = useMemo(() => (index ? filter.tags.filter((k) => !index.byKey[k]) : []), [filter.tags, index]);

  /** 條件選項與計數（開那顆 chip 才算）；計數＝其他條件不變、只換這一組的結果 */
  const options = (k: "routes" | "tags" | "due"): FilterOption[] => {
    const noDepot: TaskFilterCtx = { ...ctx, depot: new Set() };
    if (k === "routes") {
      const base = tasks.filter((n) => matchTask(n, { ...effective, routes: [] }, noDepot));
      const tally = new Map<string, number>();
      for (const n of base) {
        const key = routeKeyOf(n, ctx.aliveRoute);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      const opts: FilterOption[] = routes
        // 收進車庫的路線照樣選得到，名字後面標「車庫」（同完整搜尋 D-主-223）；條件明確選了才算進結果
        .map((r) => ({ value: r.id, label: r.arrived_on ? `${r.name}・車庫` : r.name, count: tally.get(r.id) ?? 0 }));
      // 指到已刪路線的條件也列出來，才拿得掉（兩殼同一份）
      return [...deadRoutes.map((v) => ({ value: v, label: "已刪除的路線", count: 0 })), ...opts, { value: TEMP_ROUTE, label: "臨時車票", count: tally.get(TEMP_ROUTE) ?? 0 }];
    }
    if (k === "tags") {
      if (!index) return [];
      const base = tasks.filter((n) => matchTask(n, { ...effective, tags: [] }, ctx));
      const out: FilterOption[] = deadTags.map((v) => ({ value: v, label: `#${v}（已刪除）`, count: 0 }));
      const walk = (keys: readonly string[], depth: number) => {
        for (const key of keys) {
          const node = index.byKey[key];
          if (!node) continue;
          const count = base.filter((n) => (tagsById.get(n.id) ?? []).some((m) => isUnder(m, key))).length;
          // 只留掛在任務上的荷札（筆記的荷札在這裡選了也不會有結果），但選著的就算 0 也留著
          if (count > 0 || filter.tags.includes(key)) out.push({ value: key, label: `#${node.name}`, count, depth });
          walk(node.children, depth + 1);
        }
      };
      walk(index.roots, 0);
      return out;
    }
    return DUE_ORDER.map((d) => ({
      value: d,
      label: DUE_LABEL[d],
      count: tasks.filter((n) => matchTask(n, { ...effective, due: d }, ctx)).length,
    }));
  };

  return { rows, columns, order, doneCount, boardLayout, deadRoutes, deadTags, options, today, tagName: (k: string) => index?.byKey[k]?.name ?? k };
}
