/**
 * useOutlineController——大綱的狀態機：可見列（zoom／摺疊／已完成收起〔清單底摺疊列〕／草稿列）、行內編輯狀態、以及所有流程動作
 * （F1 完成流／F2 新增流／F3 刪除流、升降層、排程、zoom、切路線）。Outline.tsx 只負責畫，鍵盤表在 useOutlineKeyboard。
 * 對應 UI Flow 2.0／2.0a／2.0b／2.0c／2.0d／2.0e。
 * 取捨：新增走「本地草稿列 → 提交才 createNode」（空白／Esc 不產生垃圾節點、不污染 undo 堆疊）；
 *       草稿尚無文字時的 Tab／Shift+Tab 是純本地改目標（鏡射 store 的 adaptKind 規則），有文字才提交後真的升降層。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { capsOfHotkey } from "../shell/hotkeys";
import {
  KIND_LABEL,
  canHaveChildren,
  defaultChildKind,
  isTaskKind,
  parseRule,
  type NodeKind,
  type NodeRow,
} from "../../domain";
import { REPEAT_RESCHEDULE_MSG } from "../../data";
import {
  adaptKind,
  ancestorsOf,
  siblingsOf,
  useNodeStore,
  type TreeIndex,
} from "../../store/nodeStore";
import { completeNodeFlow, moveRunFlow, suspendNodeFlow } from "./nodeFlows";
import { DESKTOP_GUARD_WORDS, rowGuards } from "./rowGuards";
import type { PopMenuItem } from "../common/PopMenu";
import { requestMoveTo } from "../common/moveTo";
import { moveTargetRule } from "../../domain/moveTo";
import { PARKED_ADD_WHY } from "../../domain/depot";
import { useUiStore } from "../../store/uiStore";
import { confirmAndDeleteNode } from "../common/deleteNodeFlow";
import { addDays, todayKey } from "../../lib/date";
import type { CommitVia } from "../common/InlineInput";
import type { QuickExtra } from "../common/quickadd/useQuickAdd";
import type { OutlineKeyActions } from "./useOutlineKeyboard";
import { useSelectionStore } from "../../store/selectionStore";
import { clearIfAny, extendBy, pickClick, selectAll } from "../common/selection/desktopSelection";
import { armOpenOnClick } from "../common/selection/openOnClick";

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
  /** extra：草稿列換成建票列（回饋甲）後 chips／語法設好的欄位，一起帶進 createNode；改名不帶 */
  commit(text: string, via: CommitVia, extra?: QuickExtra): void;
  cancel(): void;
  tab(text: string, shift: boolean, extra?: QuickExtra): void;
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
  /**
   * 列的 mousedown 先問多選（Ctrl／⌘／Shift＋點；回饋乙）：回 true＝是多選的點，不要再單選。
   * 回 false（純單擊票面、不是控件）時順手登記「放開就開詳情側板」（回饋甲 D-主-132；拖曳不開）
   */
  pick(
    id: string,
    e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: EventTarget | null; clientX?: number; clientY?: number; button?: number },
  ): boolean;
  /** 定期券的執行日 chip：chip 印的那一班改到別天（⑥ D-主-295） */
  moveRun(id: string, from: string, to: string): void;
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
): { rows: VisibleRow[]; doneHidden: number; doneShown: number } {
  const out: VisibleRow[] = [];
  // 摺疊列「済 N 張」的 N（UI 丙-3 修訂）：收起時＝這次被藏起來的最上層已完成節點（子孫跟著藏、不另算）；
  // 展開時＝目前畫出來的已完成節點。只算展開中的父節點底下（摺起來的父節點本來就看不到）。
  let doneHidden = 0;
  let doneShown = 0;
  const walk = (ids: string[], depth: number, parentId: string) => {
    for (const id of ids) {
      const n = tree.byId[id];
      if (!n) continue;
      if (hideDone && isDone(n)) doneHidden++;
      else {
        if (isDone(n)) doneShown++;
        out.push({ type: "node", id, depth });
        const open = !collapsed[id] || (draft !== null && draft.parentId === id);
        if (open) walk(tree.childrenOf[id] ?? NONE, depth + 1, id);
      }
      if (draft && draft.afterId === id) out.push({ type: "draft", depth });
    }
    if (draft && draft.parentId === parentId && draft.afterId === null) out.push({ type: "draft", depth });
  };
  walk(rootChildren, 0, rootId);
  return { rows: out, doneHidden, doneShown };
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
  const built = useMemo(
    () => (rootId ? buildRows(tree, rootId, rootChildren, collapsed, hideDone, draft, isDoneNode) : { rows: [], doneHidden: 0, doneShown: 0 }),
    [tree, rootId, rootChildren, collapsed, hideDone, draft, isDoneNode],
  );
  const rows = built.rows;
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
    // 多選不跨路線（回饋乙）
    if (useSelectionStore.getState().scope === "outline") useSelectionStore.getState().clear();
    useUiStore.getState().setZoom(null);
    if (routeId && document.activeElement === document.body) containerRef.current?.focus();
  }, [routeId, setEdit, containerRef]);

  // 清單換了（完成被收起、刪掉、摺起來、同步拉走）：多選只留畫面上還看得到的（回饋乙）
  const visibleKey = rows.map((r) => (r.type === "node" ? r.id : "")).join("|");
  useEffect(() => {
    useSelectionStore.getState().prune("outline", visibleKey.split("|").filter(Boolean));
  }, [visibleKey]);

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
      toast(`${KIND_LABEL[n.kind]}已經是最底層，無法再往內聚焦`);
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
      toast("已到目前範圍的最上層——先按 Esc 退出聚焦，才能再往上一層");
      return false;
    }
    const r = await ns().outdent(id);
    if (!r.ok) toast(r.reason);
    return r.ok;
  };

  /* ───────── 運休（M3 ④ D-④-2；大綱的 `U` 與「點運休章＝取消」共用這一條） ───────── */
  /**
   * 本班運休／取消運休——與今日視圖的 `U` 同一條路（nodeStore.skipOccurrence）。
   * 兩頁同義同鍵（M3 ④ 評審 should-6）。**只有定期券能運休**，其餘吐 REPEAT_ONLY_MSG。
   */
  // 手機殼班：流程本體抽到 nodeFlows.ts（手機路線圖的検印鈕走同一支）
  const suspendNode = (id: string, skip?: boolean) => suspendNodeFlow(id, skip);

  /* ───────── F1 完成流（D2／D4；本體在 nodeFlows.completeNodeFlow，兩殼同一支） ───────── */
  const completeNode = (id: string) =>
    completeNodeFlow(id, (fid) => {
      setFreshId(fid);
      // 動畫結束事件是主要清除點；reduced-motion（animation:none 不發 animationend）用計時器兜底（寫入完成後起算）
      return () => setTimeout(() => setFreshId((cur) => (cur === fid ? null : cur)), 800);
    });

  /* ───────── F3 刪除流（D3） ───────── */
  const deleteNodeFlow = (id: string) => {
    const n = ns().tree.byId[id];
    if (!n) return;
    // 確認與 toast 在共用流程（失物招領 §5-6）；這裡只管大綱自己的事：刪後選哪一列、聚焦在被刪的範圍要退出來
    void confirmAndDeleteNode(id, {
      around: async (del) => {
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
        if (await del()) ui().select(next);
      },
    });
  };

  /* ───────── F2 新增流：草稿 ───────── */
  // O-3：已到站的路線不開草稿（Enter／Tab／選單都走這裡）；說一句怎麼加
  const parked = !!route?.arrived_on;
  const startDraft = (d: Omit<DraftEdit, "mode">) => {
    if (parked) {
      ui().showToast({ message: PARKED_ADD_WHY }, 3600);
      return;
    }
    setEdit({ mode: "draft", ...d });
  };

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
      if (!prev) return toast("上面沒有可以放進去的項目");
      if (!canHaveChildren(prev.kind)) return toast("車票／車站底下不能再放項目");
      if (ui().hideDone && prev.status === "done") return toast("上一層已完成、收起來了——請先點「列車」標題旁的「済・顯示」");
      const kind = adaptKind(d.kind, prev.kind);
      if (!kind) return toast("這個項目不能放在那裡");
      ui().setCollapsed(prev.id, false);
      setEdit({ ...d, parentId: prev.id, afterId: null, kind });
    } else {
      if (d.parentId === root) {
        return toast(root === rid ? "已經在路線最上層——要換路線，用 ⋯ 選單的「移動到…」" : "已到目前範圍的最上層——先按 Esc 退出聚焦，才能再往上一層");
      }
      const parent = t.byId[d.parentId];
      if (!parent || !rid) return;
      const gpId = parent.parent_id && parent.parent_id !== rid && t.byId[parent.parent_id] ? parent.parent_id : rid;
      const gpKind: NodeKind = gpId === rid ? "route" : t.byId[gpId].kind;
      const kind = adaptKind(d.kind, gpKind);
      if (!kind) return toast("這個項目不能移到那一層");
      setEdit({ ...d, parentId: gpId, afterId: parent.id, kind });
    }
  };

  const createFromDraft = async (d: DraftEdit, name: string, extra?: QuickExtra): Promise<NodeRow | null> => {
    const row = await ns().createNode({ ...extra?.input, kind: d.kind, name, parentId: d.parentId, afterId: d.afterId ?? undefined });
    if (!row) {
      setEdit(null);
      toast("新增失敗——請再試一次");
      return null;
    }
    await extra?.afterCreate(row); // 建票列的荷札：建好之後掛
    return row;
  };

  const draftCommit = async (d: DraftEdit, text: string, via: CommitVia, extra?: QuickExtra) => {
    if (editRef.current !== d || busyRef.current) return;
    const name = text.trim();
    if (!name) {
      cancelEdit(via === "enter");
      return;
    }
    busyRef.current = true;
    try {
      const row = await createFromDraft(d, name, extra);
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

  const draftTab = async (d: DraftEdit, text: string, shift: boolean, extra?: QuickExtra) => {
    if (editRef.current !== d || busyRef.current) return;
    const name = text.trim();
    if (!name) {
      retargetDraft(d, shift);
      return;
    }
    busyRef.current = true;
    try {
      const row = await createFromDraft(d, name, extra);
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
        toast(`先選一班列車或車廂，再按 ${capsOfHotkey("outline.add.ticket")} 新增車票`);
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
      // 丁 D-主-245：支線底下可以直接放車票（加在支線裡的最後）
      if (target.kind === "branch") {
        ui().setCollapsed(target.id, false);
        startDraft({ parentId: target.id, afterId: null, kind: "ticket", anchorId: n?.id ?? null });
        return;
      }
      toast("這裡不能新增車票");
    },
    addBranch() {
      // 丁 D-主-249：新增落點＝有選中的列：它後面同一層（那一層放不下支線〔在列車裡〕就往上找到能放的那一層、接在那一列後面）；
      //   沒選中：聚焦在支線＝支線裡的最後；聚焦在列車／車廂＝放不進；其餘＝路線最後
      const { rootId: root, zoom: z, routeId: rid } = st.current;
      if (!root) return;
      const t = ns().tree;
      const holds = (parentId: string) => {
        const k = parentId === rid ? "route" : t.byId[parentId]?.kind;
        return k === "route" || k === "branch";
      };
      let n = selNode();
      while (n && !holds(parentKey(n))) n = t.byId[parentKey(n)];
      if (n) {
        startDraft({ parentId: parentKey(n), afterId: n.id, kind: "branch", anchorId: n.id });
        return;
      }
      if (z && z.kind !== "branch") {
        toast(`${KIND_LABEL[z.kind]}裡不能放支線——支線放在路線或支線底下`);
        return;
      }
      startDraft({ parentId: root, afterId: null, kind: "branch", anchorId: null });
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
      // 丁 D-主-247：支線沒有日期（T／Shift+T 對支線不作用，說一句理由）
      if (n.kind === "branch") {
        toast("支線是主題，沒有執行日——裡面的列車和車票各自排");
        return;
      }
      const { today: td } = st.current;
      const next = offset ? addDays(td, 1) : td;
      // 定期券：大綱講的是目前班次（scheduled_on，交代完＝下一班），只改那一班（⑥ D-主-295）；沒有班次才吐指路句
      if (parseRule(n.repeat_rule)) {
        if (n.scheduled_on) void moveRunFlow(n.id, n.scheduled_on, next);
        else toast(REPEAT_RESCHEDULE_MSG);
        return;
      }
      void ns().updateNode(n.id, { scheduled_on: next });
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
      if (clearIfAny("outline")) return; // 回饋乙：Esc 先清多選
      if (st.current.zoom) zoomOut();
      else ui().setPanelOpen(false);
    },
    selectAll() {
      selectAll("outline", visibleIds());
    },
    extendSelection(delta) {
      const next = extendBy("outline", delta, visibleIds(), ui().selectedId);
      if (next) ui().select(next);
    },
    switchRoute(dir) {
      // 讀 store 即時值——連按兩下也不會算到舊路線。只在還在跑的路線之間切（車庫與回顧 D-主-206）
      const { liveRoutes: rs, routeId: cur } = ns();
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
      // 保險：定期券的 chip 走 moveRun（講得出哪一班），這裡講不出，別的入口誤呼就吐指路句
      if (field === "scheduled_on" && parseRule(ns().tree.byId[id]?.repeat_rule ?? null)) {
        toast(REPEAT_RESCHEDULE_MSG);
        return;
      }
      // 磨光⑦（D-主-67）：執行日 chip 親手選到今天以前＝補記
      void ns().updateNode(id, field === "scheduled_on" ? { scheduled_on: value } : { due_on: value }, { backfill: field === "scheduled_on" });
    },
    moveRun: (id, from, to) => void moveRunFlow(id, from, to),
    focusContainer,
    pick: (id, e) => {
      if (pickClick("outline", id, visibleIds(), e, ui().selectedId)) return true;
      // 回饋甲 D-主-132：單擊票面＝選中＋開詳情側板（選中由列接著呼叫 select；放開時還是它才開）
      armOpenOnClick(e, () => {
        if (ui().selectedId === id) ui().setPanelOpen(true);
      });
      return false;
    },
  };

  /* ───────── 列的 ⋯ 選單（10-20 磨光②；outline.add.*／indent／outdent／reorder／rename／panel／delete 的滑鼠入口） ───────── */
  /**
   * 有鍵的項目＝鍵盤同一條路：先選中那一列（跟鍵盤一樣「對選取動手」），再叫 keys 的同名動作。
   * 停用條件逐條鏡射 nodeStore.indent／outdent／reorder 與 keys.addTicket／outdentNode 的拒絕理由
   * （做不到的那項不讓點，滑過看得到同一句話）；真的點下去仍由原本那條路把關。
   * 第七項「移動到…」（磨光⑤ B1）只有滑鼠入口、沒有鍵；挑選器在側板。
   */
  const menuFor = (id: string): PopMenuItem[] => {
    const t = ns().tree;
    const { routeId: rid, zoom: z } = st.current;
    const n = t.byId[id];
    // 停用理由與手機路線圖 ⋯ sheet 同一支（rowGuards.ts；手機殼班抽出，字一字不差）
    const g = rowGuards(t, rid, z?.id ?? null, id, { siblingsOf, adaptKind }, DESKTOP_GUARD_WORDS);
    if (!n || !g) return [];
    const { indentWhy, outdentWhy, ticketWhy } = g;
    /** 先選中、焦點回大綱容器，再做（新增類會開草稿列、草稿自己拿焦點） */
    const run = (fn: () => void) => () => {
      ui().select(id);
      focusContainer();
      fn();
    };
    const item = (
      key: string,
      label: string,
      hotkeyId: string,
      why: string | null,
      fn: () => void,
      cut = false,
      danger = false,
    ): PopMenuItem => ({
      key,
      label,
      hotkeyId,
      disabled: why !== null,
      why: why ?? undefined,
      cut,
      danger,
      onSelect: run(fn),
    });
    // 分組（虛線隔開）：新增｜這一列本身（改名…）｜編排 ▾（移動到…、降層｜升層、上移｜下移）｜刪除（赭、最後；視覺規範 §2.4）。
    // UI 丙-3 B3（E14／E15）補「改名」「刪除」＝F2／Delete 的滑鼠入口（雙擊標題是加速，不算可點的入口）。
    // 回饋乙：排序與層級收進可展開的「編排 ▾」（PopMenu group；跟手機票卡 sheet 同一種結構），頂層回到 §2.4 的 ≤7。
    //   有了拖曳之後它們仍是可點的入口（拖曳和快捷鍵都是加速），所以收起來不砍掉。右鍵選單＝這一份（contextMenu.tsx）。
    const arrange = (it: PopMenuItem): PopMenuItem => ({ ...it, group: "編排" });
    // 回饋甲 D-主-134（入口體檢 G）：補「詳情」「排今天／排明天」（定期券＝這一班改到今天／明天）「運休／取消運休」（定期券才出）——手機路線圖 ⋯ 本來就有。
    //   頂層要守 ≤7：新增兩項收進「新增 ▾」（頁首「＋ 新增 ▾」與清單尾常駐列才是主入口，這裡是順手的替代）、排程兩項（定期券多運休）收進「排程 ▾」。
    //   頂層＝新增 ▾｜詳情・改名・選取｜排程 ▾｜編排 ▾｜刪除。
    const teiki = parseRule(n.repeat_rule) !== null;
    const occ = ns().currentOccurrences[id];
    // 定期券的「這一班」＝目前班次（scheduled_on）；退役或沒有班次就淡掉
    const runWhy = n.status === "done" || !n.scheduled_on ? "這張定期券沒有下一班" : null;
    return [
      { ...item("sibling", `同層新增${KIND_LABEL[n.kind]}`, "outline.add.sibling", parked ? PARKED_ADD_WHY : null, keys.addSibling), group: "新增" },
      { ...item("ticket", "新增車票", "outline.add.ticket", parked ? PARKED_ADD_WHY : ticketWhy, keys.addTicket), group: "新增" },
      // 丁 D-主-249：新增支線（主題）——列車、車廂裡放不下，會接到它所在的那一層（keys.addBranch 往上找）；車庫裡的路線淡掉（O-3）
      ...(n.kind === "branch"
        ? []
        : [{ key: "branch", label: "新增支線（主題）", group: "新增", disabled: parked, why: parked ? PARKED_ADD_WHY : undefined, onSelect: run(keys.addBranch) } as PopMenuItem]),
      // 鏡射「.」：選中＋開側板（單擊票面也會開；這裡是 ⋯ 的可點入口）
      { key: "panel", label: "詳情", hotkeyId: "outline.panel", cut: true, onSelect: () => row.openPanel(id) },
      item("rename", "改名", "outline.rename", null, keys.renameSelected),
      // 回饋乙：多選的可點入口（Ctrl／Shift＋點是加速）。已在多選中＝把這張加進去
      {
        key: "pick",
        label: "選取",
        onSelect: () => {
          const sel = useSelectionStore.getState();
          if (sel.scope === "outline" && sel.ids.length) {
            if (!sel.ids.includes(id)) sel.toggle("outline", id, visibleIds());
          } else sel.start("outline", id);
          ui().select(id);
          focusContainer();
        },
      },
      // 排程（鏡射 T／Shift+T＝keys.scheduleSelected）：定期券＝這一班改到今天／明天（⑥ D-主-295），加運休（鏡射 U＝keys.suspendSelected）
      // 丁 D-主-247：支線是主題，沒有日期 ⇒ 不出排程
      ...(n.kind === "branch"
        ? []
        : teiki
        ? [
            {
              ...item(
                "suspend",
                occ?.status === "skipped" ? "取消運休" : "運休",
                "outline.suspend",
                null,
                keys.suspendSelected,
                true,
              ),
              group: "排程",
            },
            { ...item("sched-today", "這一班改到今天", "outline.schedule.today", runWhy, () => keys.scheduleSelected(0)), group: "排程" },
            { ...item("sched-tomorrow", "這一班改到明天", "outline.schedule.tomorrow", runWhy, () => keys.scheduleSelected(1)), group: "排程" },
          ]
        : [
            { ...item("sched-today", "排今天", "outline.schedule.today", null, () => keys.scheduleSelected(0), true), group: "排程" },
            { ...item("sched-tomorrow", "排明天", "outline.schedule.tomorrow", null, () => keys.scheduleSelected(1)), group: "排程" },
          ]),
      // 磨光⑤ B1（D-主-55）：跨路線搬遷。沒有快捷鍵（不給 hotkeyId）；挑選器開在側板（requestMoveTo＝選中＋開側板＋請它打開）
      // 種類搬不了（moveTargetRule 回 null）就不出——側板那顆鈕同一條規則，兩個入口不會一個有一個沒有
      ...(moveTargetRule(n.kind)
        ? [arrange({ key: "move", label: "移動到…", cut: true, onSelect: () => requestMoveTo(id) })]
        : []),
      arrange(item("indent", "降層", "outline.indent", indentWhy, keys.indentSelected, !moveTargetRule(n.kind))),
      arrange(item("outdent", "升層", "outline.outdent", outdentWhy, keys.outdentSelected)),
      arrange(item("up", "上移", "outline.reorder.up", g.upWhy, () => keys.reorderSelected(-1))),
      arrange(item("down", "下移", "outline.reorder.down", g.downWhy, () => keys.reorderSelected(1))),
      item("delete", "刪除", "outline.delete", null, keys.deleteSelected, true, true),
    ];
  };

  /* ───────── 行內編輯回呼（依目前 edit 綁定） ───────── */
  let draftHandlers: EditHandlers | null = null;
  let renameHandlers: EditHandlers | null = null;
  if (edit?.mode === "draft") {
    const d: DraftEdit = edit;
    draftHandlers = {
      commit: (text, via, extra) => void draftCommit(d, text, via, extra),
      cancel: cancelEdit,
      tab: (text, shift, extra) => void draftTab(d, text, shift, extra),
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
    /** 這條路線已收進車庫：不發券（O-3） */
    parked,
    line,
    tree,
    currentOccurrences,
    isDoneNode,
    zoom,
    crumbs,
    rows,
    doneHidden: built.doneHidden,
    doneShown: built.doneShown,
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
    menuFor,
    zoomTo,
    startFirstDraft: () => keys.addSibling(),
  };
}
