/**
 * useOutlineController——大綱的狀態機：可見列（zoom／摺疊／隱藏已完成／草稿列）、行內編輯狀態、以及所有流程動作
 * （F1 完成流／F2 新增流／F3 刪除流、升降層、排程、zoom、切路線）。Outline.tsx 只負責畫，鍵盤表在 useOutlineKeyboard。
 * 對應 UI Flow 2.0／2.0a／2.0b／2.0c／2.0d／2.0e。
 * 取捨：新增走「本地草稿列 → 提交才 createNode」（空白／Esc 不產生垃圾節點、不污染 undo 堆疊）；
 *       草稿尚無文字時的 Tab／Shift+Tab 是純本地改目標（鏡射 store 的 adaptKind 規則），有文字才提交後真的升降層。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  KIND_LABEL,
  canHaveChildren,
  defaultChildKind,
  isTaskKind,
  parseRule,
  type NodeKind,
  type NodeRow,
} from "../../domain";
import { REPEAT_ONLY_MSG, REPEAT_RESCHEDULE_MSG, type CurrentOccurrence } from "../../data";
import {
  adaptKind,
  ancestorsOf,
  descendantCount,
  openDescendantCount,
  useNodeStore,
  type TreeIndex,
} from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import type { CommitVia } from "./InlineInput";
import type { OutlineKeyActions } from "./useOutlineKeyboard";

export type VisibleRow = { type: "node"; id: string; depth: number } | { type: "draft"; depth: number };

export interface DraftEdit {
  mode: "draft";
  /** 路線 id（根層）或節點 id */
  parentId: string;
  /** 插在這個兄弟之後；null＝該層末尾 */
  afterId: string | null;
  kind: NodeKind;
  /** 取消時回到的選取 */
  anchorId: string | null;
}
export interface RenameEdit {
  mode: "rename";
  id: string;
  /** Enter 提交後是否接著開下一筆草稿（草稿經 Tab 轉正後＝true，F2 改名＝false） */
  chain: boolean;
}
export type EditState = DraftEdit | RenameEdit;

export interface EditHandlers {
  commit(text: string, via: CommitVia): void;
  cancel(): void;
  tab(text: string, shift: boolean): void;
}

export interface NodeCounts {
  total: number;
  open: number;
}

export interface RowActions {
  select(id: string): void;
  toggleCollapse(id: string): void;
  zoomInto(id: string): void;
  complete(id: string): void;
  rename(id: string): void;
  openPanel(id: string): void;
  setDate(id: string, field: "scheduled_on" | "due_on", value: string | null): void;
  /** 定期券的執行日 chip 是唯讀的：點了只吐一句話（D-④-3） */
  noteRepeatDate(): void;
  focusContainer(): void;
}

export interface Crumb {
  id: string | null;
  label: string;
}

const NONE: string[] = [];

function computeCounts(tree: TreeIndex): Record<string, NodeCounts> {
  const out: Record<string, NodeCounts> = {};
  const visit = (id: string): NodeCounts => {
    let total = 0;
    let open = 0;
    for (const c of tree.childrenOf[id] ?? NONE) {
      const cc = visit(c);
      total += 1 + cc.total;
      open += (tree.byId[c]?.status === "done" ? 0 : 1) + cc.open;
    }
    const r = { total, open };
    out[id] = r;
    return r;
  };
  for (const id of tree.roots) visit(id);
  return out;
}

function buildRows(
  tree: TreeIndex,
  rootId: string,
  rootChildren: string[],
  collapsed: Record<string, boolean>,
  hideDone: boolean,
  draft: DraftEdit | null,
  isDone: (n: NodeRow) => boolean,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (ids: string[], depth: number, parentId: string) => {
    for (const id of ids) {
      const n = tree.byId[id];
      if (!n) continue;
      if (!(hideDone && isDone(n))) {
        out.push({ type: "node", id, depth });
        const open = !collapsed[id] || (draft !== null && draft.parentId === id);
        if (open) walk(tree.childrenOf[id] ?? NONE, depth + 1, id);
      }
      if (draft && draft.afterId === id) out.push({ type: "draft", depth });
    }
    if (draft && draft.parentId === parentId && draft.afterId === null) out.push({ type: "draft", depth });
  };
  walk(rootChildren, 0, rootId);
  return out;
}

function collectDescendants(tree: TreeIndex, id: string): Set<string> {
  const set = new Set<string>();
  const stack = [...(tree.childrenOf[id] ?? NONE)];
  while (stack.length) {
    const c = stack.pop() as string;
    set.add(c);
    stack.push(...(tree.childrenOf[c] ?? NONE));
  }
  return set;
}

export function useOutlineController(containerRef: RefObject<HTMLDivElement | null>) {
  const routeId = useNodeStore((s) => s.routeId);
  const routes = useNodeStore((s) => s.routes);
  const lines = useNodeStore((s) => s.lines);
  const tree = useNodeStore((s) => s.tree);
  /** 全站定期券的「目前班次」表（M3 ④）——大綱的済／運休都看它，不看 nodes.status */
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const loading = useNodeStore((s) => s.loading);
  const selectedId = useUiStore((s) => s.selectedId);
  const zoomId = useUiStore((s) => s.zoomId);
  const collapsed = useUiStore((s) => s.collapsed);
  const hideDone = useUiStore((s) => s.hideDone);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const [edit, setEditState] = useState<EditState | null>(null);
  const editRef = useRef<EditState | null>(null);
  const setEdit = useCallback((e: EditState | null) => {
    editRef.current = e;
    setEditState(e);
  }, []);
  const busyRef = useRef(false);
  const [freshId, setFreshId] = useState<string | null>(null);

  const route = routes.find((r) => r.id === routeId);
  const line = route ? lines.find((l) => l.id === route.line_id) : undefined;
  const zoom: NodeRow | null = zoomId && tree.byId[zoomId] ? tree.byId[zoomId] : null;
  const rootId = zoom ? zoom.id : routeId;
  const rootChildren = zoom ? (tree.childrenOf[zoom.id] ?? NONE) : tree.roots;
  const counts = useMemo(() => computeCounts(tree), [tree]);
  const draft = edit?.mode === "draft" ? edit : null;
  /**
   * 済了沒（M3 ④ 全站口徑，與今日列的 isDoneRow 同一把尺）：
   * 活著的定期券看「目前班次」的結局，其餘（含退役定期券，表裡恆無值）看 nodes.status。
   */
  const isDoneNode = useCallback(
    (n: Pick<NodeRow, "id" | "status">): boolean => {
      const occ = currentOccurrences[n.id];
      return occ ? occ.status === "done" : n.status === "done";
    },
    [currentOccurrences],
  );
  const rows = useMemo(
    () => (rootId ? buildRows(tree, rootId, rootChildren, collapsed, hideDone, draft, isDoneNode) : []),
    [tree, rootId, rootChildren, collapsed, hideDone, draft, isDoneNode],
  );
  const today = todayKey(dayStartHour);

  const crumbs = useMemo<Crumb[]>(() => {
    if (!zoom) return [];
    const chain = ancestorsOf(tree, routeId, zoom.id).reverse();
    return [
      { id: null, label: route?.name ?? "路線" },
      ...chain.map((id) => ({ id, label: tree.byId[id]?.name ?? "…" })),
      { id: zoom.id, label: zoom.name },
    ];
  }, [zoom, tree, routeId, route]);

  // 最新值放 ref，動作函式不吃舊 closure
  const st = useRef({ rows, rootId, routeId, zoom, today });
  st.current = { rows, rootId, routeId, zoom, today };

  // 換路線：收掉草稿、退出 zoom（側欄／跳轉也會重設，這裡是保險）；沒人持有焦點時把焦點給大綱，鍵盤流立刻可用
  useEffect(() => {
    setEdit(null);
    useUiStore.getState().setZoom(null);
    if (routeId && document.activeElement === document.body) containerRef.current?.focus();
  }, [routeId, setEdit, containerRef]);

  /* ───────── 小工具 ───────── */
  const ui = () => useUiStore.getState();
  const ns = () => useNodeStore.getState();
  const toast = (message?: string) => {
    if (message) ui().showToast({ message }, 3600);
  };
  const focusContainer = () => containerRef.current?.focus();
  const visibleIds = () => st.current.rows.flatMap((r) => (r.type === "node" ? [r.id] : []));
  /** 目前「看得見」的選取節點（被摺疊／隱藏的選取視同無選取） */
  const selNode = (): NodeRow | null => {
    const id = ui().selectedId;
    if (!id || !visibleIds().includes(id)) return null;
    return ns().tree.byId[id] ?? null;
  };
  /** 節點的父鍵：路線直屬＝routeId，其餘＝parent_id */
  const parentKey = (n: NodeRow): string => {
    const { routeId: rid } = st.current;
    const t = ns().tree;
    return n.parent_id && n.parent_id !== rid && t.byId[n.parent_id] ? n.parent_id : (rid ?? "");
  };

  /* ───────── zoom ───────── */
  const zoomTo = (id: string | null) => {
    const { zoom: z, routeId: rid } = st.current;
    if (z) {
      const chain = ancestorsOf(ns().tree, rid, z.id); // 近→遠
      const k = id ? chain.indexOf(id) : chain.length;
      ui().expand(chain.slice(0, k < 0 ? chain.length : k));
      ui().select(z.id);
    }
    ui().setZoom(id);
  };
  const zoomOut = () => {
    const { zoom: z, routeId: rid } = st.current;
    if (!z) return;
    const p = z.parent_id;
    zoomTo(p && p !== rid && ns().tree.byId[p] ? p : null);
  };
  const zoomInto = (id: string) => {
    const n = ns().tree.byId[id];
    if (!n) return;
    if (!canHaveChildren(n.kind)) {
      toast(`${KIND_LABEL[n.kind]}是葉節點，沒有下層可以聚焦`);
      return;
    }
    ui().setZoom(id);
    ui().select(ns().tree.childrenOf[id]?.[0] ?? null);
  };

  /* ───────── 升降層（導航／編輯共用） ───────── */
  const indentNode = async (id: string): Promise<boolean> => {
    const r = await ns().indent(id);
    if (!r.ok) {
      toast(r.reason);
      return false;
    }
    const p = ns().tree.byId[id]?.parent_id;
    if (p) ui().setCollapsed(p, false);
    return true;
  };
  const outdentNode = async (id: string): Promise<boolean> => {
    const { zoom: z } = st.current;
    const n = ns().tree.byId[id];
    if (z && n && n.parent_id === z.id) {
      toast("已到聚焦範圍的頂層——先按 Esc 退出聚焦再升層");
      return false;
    }
    const r = await ns().outdent(id);
    if (!r.ok) toast(r.reason);
    return r.ok;
  };

  /* ───────── 運休（M3 ④ D-④-2；大綱的 `U` 與「點運休章＝取消」共用這一條） ───────── */
  /**
   * 本班運休／取消運休——與今日視圖的 `U` 同一條路（nodeStore.skipOccurrence）。
   * 大綱補這個鍵是因為共用文案 REPEAT_RESCHEDULE_MSG 就寫著「跳過本班按 U」：
   * 補鍵而不是改文案，兩頁同義同鍵（M3 ④ 評審 should-6）。**只有定期券能運休**，其餘吐 REPEAT_ONLY_MSG。
   */
  const suspendNode = async (id: string, skip?: boolean) => {
    const n = ns().tree.byId[id];
    if (!n) return;
    if (!parseRule(n.repeat_rule)) {
      toast(REPEAT_ONLY_MSG);
      return;
    }
    const next = skip ?? ns().currentOccurrences[id]?.status !== "skipped";
    const r = await ns().skipOccurrence(id, next);
    if (!r.ok) toast(r.reason);
  };

  /* ───────── F1 完成流（D2／D4） ───────── */
  const completeNode = async (id: string) => {
    const t = ns().tree;
    const n = t.byId[id];
    if (!n) return;
    // 定期券：済蓋在「目前班次」上（repository 已分支），反悔＝撤這一班；nodes.status 一路是 todo。
    const occ: CurrentOccurrence | undefined = ns().currentOccurrences[id];
    // 運休中的班次：點在運休章上（或 Space）＝**取消運休**（A 原型 :60-62／:1061 的検印輪替最後一步），
    // 要蓋済就再來一次。直接蓋會蓋到引擎已推走的「下一班」頭上，故先撤運休再說。
    if (occ?.status === "skipped") {
      await suspendNode(id, false);
      return;
    }
    if (occ ? occ.status === "done" : n.status === "done") {
      await ns().setCompleted(id, false);
      return;
    }
    const finish = async (cascade: boolean) => {
      setFreshId(id);
      await ns().setCompleted(id, true, cascade ? true : undefined);
      // 動畫結束事件是主要清除點；reduced-motion（animation:none 不發 animationend）用計時器兜底
      setTimeout(() => setFreshId((cur) => (cur === id ? null : cur)), 800);
      if (isTaskKind(n.kind)) ui().setCompleteCardFor(id);
    };
    const open = canHaveChildren(n.kind) ? openDescendantCount(t, id) : 0;
    if (open > 0) {
      ui().askConfirm({
        title: `連同 ${open} 個未完成子項一起完成？`,
        body: `「${n.name}」底下還有 ${open} 個未完成的子項，會一併蓋上済章。`,
        confirmLabel: "一起完成",
        onConfirm: () => void finish(true),
      });
      return;
    }
    await finish(false);
  };

  /* ───────── F3 刪除流（D3） ───────── */
  const deleteNodeFlow = (id: string) => {
    const t = ns().tree;
    const n = t.byId[id];
    if (!n) return;
    const count = descendantCount(t, id);
    const run = async () => {
      const desc = collectDescendants(ns().tree, id);
      // 刪後選取：下一個非子孫的可見列，否則上一列
      const ids = visibleIds();
      const i = ids.indexOf(id);
      let next: string | null = null;
      for (let j = i + 1; j < ids.length; j++) {
        if (!desc.has(ids[j])) {
          next = ids[j];
          break;
        }
      }
      if (!next && i > 0) next = ids[i - 1];
      const z = ui().zoomId;
      if (z && (z === id || desc.has(z))) {
        const { routeId: rid } = st.current;
        ui().setZoom(n.parent_id && n.parent_id !== rid && ns().tree.byId[n.parent_id] ? n.parent_id : null);
      }
      await ns().deleteNode(id);
      ui().select(next);
      ui().showToast({
        message: `已刪除『${n.name}』${count ? `（含 ${count} 個子項）` : ""}`,
        actionLabel: "復原",
        onAction: () => void ns().undoDelete(),
      });
    };
    if (count >= 5) {
      ui().askConfirm({
        title: `連同 ${count} 個子項一起刪除？`,
        body: `『${n.name}』底下的 ${count} 個節點會一起移除；10 秒內可從底部提示復原。`,
        confirmLabel: "刪除",
        danger: true,
        onConfirm: () => void run(),
      });
    } else {
      void run();
    }
  };

  /* ───────── F2 新增流：草稿 ───────── */
  const startDraft = (d: Omit<DraftEdit, "mode">) => setEdit({ mode: "draft", ...d });

  /** viaKeyboard：Esc／空白 Enter 取消＝選取回錨點、焦點還給容器；blur 取消代表使用者點去別處——不動選取、不搶焦點 */
  const cancelEdit = (viaKeyboard = true) => {
    const e = editRef.current;
    setEdit(null);
    if (!viaKeyboard) return;
    if (e?.mode === "draft") ui().select(e.anchorId);
    focusContainer();
  };

  /** 草稿還沒有字時的 Tab／Shift+Tab：純本地改目標（規則鏡射 store 的 indent／outdent） */
  const retargetDraft = (d: DraftEdit, shift: boolean) => {
    const t = ns().tree;
    const { routeId: rid, rootId: root } = st.current;
    if (!shift) {
      const sibs = d.parentId === rid ? t.roots : (t.childrenOf[d.parentId] ?? NONE);
      const prevId = d.afterId ?? sibs[sibs.length - 1];
      const prev = prevId ? t.byId[prevId] : undefined;
      if (!prev) return toast("上面沒有可以掛靠的節點");
      if (!canHaveChildren(prev.kind)) return toast("車票／車站底下不能掛東西");
      if (ui().hideDone && prev.status === "done") return toast("上面的節點已完成且隱藏中——先關掉「隱藏已完成」");
      const kind = adaptKind(d.kind, prev.kind);
      if (!kind) return toast("這種節點不能掛在那裡");
      ui().setCollapsed(prev.id, false);
      setEdit({ ...d, parentId: prev.id, afterId: null, kind });
    } else {
      if (d.parentId === root) {
        return toast(root === rid ? "已經在路線頂層——跨路線請用「移動到…」" : "已到聚焦範圍的頂層——先按 Esc 退出聚焦再升層");
      }
      const parent = t.byId[d.parentId];
      if (!parent || !rid) return;
      const gpId = parent.parent_id && parent.parent_id !== rid && t.byId[parent.parent_id] ? parent.parent_id : rid;
      const gpKind: NodeKind = gpId === rid ? "route" : t.byId[gpId].kind;
      const kind = adaptKind(d.kind, gpKind);
      if (!kind) return toast("這種節點不能升到那一層");
      setEdit({ ...d, parentId: gpId, afterId: parent.id, kind });
    }
  };

  const createFromDraft = async (d: DraftEdit, name: string): Promise<NodeRow | null> => {
    const row = await ns().createNode({ kind: d.kind, name, parentId: d.parentId, afterId: d.afterId ?? undefined });
    if (!row) {
      setEdit(null);
      toast("新增失敗——請再試一次");
      return null;
    }
    return row;
  };

  const draftCommit = async (d: DraftEdit, text: string, via: CommitVia) => {
    if (editRef.current !== d || busyRef.current) return;
    const name = text.trim();
    if (!name) {
      cancelEdit(via === "enter");
      return;
    }
    busyRef.current = true;
    try {
      const row = await createFromDraft(d, name);
      if (!row) return;
      if (via === "enter") {
        ui().select(row.id);
        startDraft({ parentId: d.parentId, afterId: row.id, kind: d.kind, anchorId: row.id }); // 連打
      } else {
        setEdit(null); // blur 提交：使用者已點去別處，選取與焦點都不動
      }
    } finally {
      busyRef.current = false;
    }
  };

  const draftTab = async (d: DraftEdit, text: string, shift: boolean) => {
    if (editRef.current !== d || busyRef.current) return;
    const name = text.trim();
    if (!name) {
      retargetDraft(d, shift);
      return;
    }
    busyRef.current = true;
    try {
      const row = await createFromDraft(d, name);
      if (!row) return;
      ui().select(row.id);
      await (shift ? outdentNode(row.id) : indentNode(row.id));
      setEdit({ mode: "rename", id: row.id, chain: true }); // 保持輸入焦點，可繼續連打
    } finally {
      busyRef.current = false;
    }
  };

  /* ───────── 行內改名 ───────── */
  const renameCommit = async (r: RenameEdit, text: string, via: CommitVia) => {
    if (editRef.current !== r || busyRef.current) return;
    busyRef.current = true;
    try {
      const n = ns().tree.byId[r.id];
      const name = text.trim();
      if (n && name && name !== n.name) await ns().updateNode(r.id, { name });
      const after = ns().tree.byId[r.id];
      if (via === "enter" && r.chain && after) {
        startDraft({ parentId: parentKey(after), afterId: after.id, kind: after.kind, anchorId: after.id });
      } else {
        setEdit(null);
        if (via === "enter") focusContainer();
      }
    } finally {
      busyRef.current = false;
    }
  };

  const renameTab = async (r: RenameEdit, text: string, shift: boolean) => {
    if (editRef.current !== r || busyRef.current) return;
    busyRef.current = true;
    try {
      const n = ns().tree.byId[r.id];
      const name = text.trim();
      if (n && name && name !== n.name) await ns().updateNode(r.id, { name });
      await (shift ? outdentNode(r.id) : indentNode(r.id));
    } finally {
      busyRef.current = false;
    }
  };

  /* ───────── 鍵盤動作表 ───────── */
  const keys: OutlineKeyActions = {
    moveSelection(delta) {
      const ids = visibleIds();
      if (!ids.length) return;
      const i = ids.indexOf(ui().selectedId ?? "");
      const j = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(Math.max(i + delta, 0), ids.length - 1);
      ui().select(ids[j]);
    },
    expandSelected() {
      const n = selNode();
      if (!n) return;
      const kids = ns().tree.childrenOf[n.id] ?? NONE;
      if (!kids.length) return;
      if (ui().collapsed[n.id]) ui().setCollapsed(n.id, false);
      else {
        const ids = visibleIds();
        const first = kids.find((k) => ids.includes(k));
        if (first) ui().select(first);
      }
    },
    collapseSelected() {
      const n = selNode();
      if (!n) return;
      const kids = ns().tree.childrenOf[n.id] ?? NONE;
      if (kids.length && !ui().collapsed[n.id]) {
        ui().setCollapsed(n.id, true);
        return;
      }
      const { rootId: root } = st.current;
      const p = n.parent_id;
      if (p && p !== root && ns().tree.byId[p]) ui().select(p);
    },
    addSibling() {
      const { rootId: root, zoom: z } = st.current;
      if (!root) return;
      const n = selNode();
      if (!n) {
        const kind: NodeKind = z ? (defaultChildKind(z.kind) ?? "car") : "train";
        startDraft({ parentId: root, afterId: null, kind, anchorId: null });
        return;
      }
      startDraft({ parentId: parentKey(n), afterId: n.id, kind: n.kind, anchorId: n.id });
    },
    addTicket() {
      const { zoom: z } = st.current;
      const n = selNode();
      const target = n ?? z;
      if (!target) {
        toast("先選一班列車或車廂，再按 Ctrl+Enter 新增車票");
        return;
      }
      if (isTaskKind(target.kind)) {
        ui().setCollapsed(target.id, false);
        startDraft({ parentId: target.id, afterId: null, kind: "ticket", anchorId: n?.id ?? null });
        return;
      }
      if (target.kind === "ticket" && n) {
        startDraft({ parentId: parentKey(n), afterId: n.id, kind: "ticket", anchorId: n.id });
        return;
      }
      toast("支線底下不能直接掛車票——先建一班列車");
    },
    indentSelected() {
      const n = selNode();
      if (n) void indentNode(n.id);
    },
    outdentSelected() {
      const n = selNode();
      if (n) void outdentNode(n.id);
    },
    completeSelected() {
      const n = selNode();
      if (n) void completeNode(n.id);
    },
    suspendSelected() {
      const n = selNode();
      if (n) void suspendNode(n.id);
    },
    scheduleSelected(offset) {
      const n = selNode();
      if (!n) return;
      // 定期券的班次由規則排定，單次改期一律擋下（D-④-3；repository 也會 throw，這裡先給一句話）
      if (parseRule(n.repeat_rule)) {
        toast(REPEAT_RESCHEDULE_MSG);
        return;
      }
      const { today: td } = st.current;
      void ns().updateNode(n.id, { scheduled_on: offset ? addDays(td, 1) : td });
    },
    openPanel() {
      ui().setPanelOpen(true);
    },
    deleteSelected() {
      const n = selNode();
      if (n) deleteNodeFlow(n.id);
    },
    reorderSelected(delta) {
      const n = selNode();
      if (!n) return;
      void ns().reorder(n.id, delta).then((r) => {
        if (!r.ok) toast(r.reason);
      });
    },
    escape() {
      if (st.current.zoom) zoomOut();
      else ui().setPanelOpen(false);
    },
    switchRoute(dir) {
      const { routes: rs, routeId: cur } = ns(); // 讀 store 即時值——連按兩下也不會算到舊路線
      if (!rs.length) return;
      const i = rs.findIndex((r) => r.id === cur);
      const j = i < 0 ? 0 : (i + dir + rs.length) % rs.length;
      if (rs[j].id === cur) return;
      ui().select(null);
      void ns().openRoute(rs[j].id);
    },
    renameSelected() {
      const n = selNode();
      if (n) setEdit({ mode: "rename", id: n.id, chain: false });
    },
  };

  /* ───────── 滑鼠動作表 ───────── */
  const row: RowActions = {
    select: (id) => ui().select(id),
    toggleCollapse: (id) => ui().toggleCollapsed(id),
    zoomInto,
    complete: (id) => void completeNode(id),
    rename: (id) => {
      ui().select(id);
      setEdit({ mode: "rename", id, chain: false });
    },
    openPanel: (id) => {
      ui().select(id);
      ui().setPanelOpen(true);
    },
    setDate: (id, field, value) => {
      // 保險：定期券的執行日 chip 在票面上已經是唯讀的，這裡再擋一次（別的入口誤呼也吐同一句話）
      if (field === "scheduled_on" && parseRule(ns().tree.byId[id]?.repeat_rule ?? null)) {
        toast(REPEAT_RESCHEDULE_MSG);
        return;
      }
      void ns().updateNode(id, field === "scheduled_on" ? { scheduled_on: value } : { due_on: value });
    },
    noteRepeatDate: () => toast(REPEAT_RESCHEDULE_MSG),
    focusContainer,
  };

  /* ───────── 行內編輯回呼（依目前 edit 綁定） ───────── */
  let draftHandlers: EditHandlers | null = null;
  let renameHandlers: EditHandlers | null = null;
  if (edit?.mode === "draft") {
    const d: DraftEdit = edit;
    draftHandlers = {
      commit: (text, via) => void draftCommit(d, text, via),
      cancel: cancelEdit,
      tab: (text, shift) => void draftTab(d, text, shift),
    };
  } else if (edit?.mode === "rename") {
    const r: RenameEdit = edit;
    renameHandlers = {
      commit: (text, via) => void renameCommit(r, text, via),
      cancel: cancelEdit,
      tab: (text, shift) => void renameTab(r, text, shift),
    };
  }

  return {
    routeId,
    route,
    line,
    tree,
    currentOccurrences,
    isDoneNode,
    zoom,
    crumbs,
    rows,
    rootChildren,
    counts,
    selectedId,
    collapsed,
    edit,
    draftHandlers,
    renameHandlers,
    freshId,
    clearFresh: () => setFreshId(null),
    today,
    hideDone,
    loading,
    keys,
    row,
    zoomTo,
    startFirstDraft: () => keys.addSibling(),
  };
}
