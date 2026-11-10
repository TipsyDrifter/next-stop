/**
 * 路線大綱的拖曳（回饋乙 D-主-151～153；契約 §2、§3）——共用元件 useDragReorder 的 tree 模式。
 *
 *   - items＝畫面上看得到的節點列（＋層級）；收起的已完成票不在裡面 ⇒ 落點用看得到的鄰居算，藏起來的票相對位置不變（契約 §3）。
 *   - 拖列車＝畫面上的子孫一起走（tree.carried）；停在摺起來的列上 600ms 自動展開。
 *   - 能不能放＝domain/dropRules.dropVerdict（種類同「移動到…」、臨時票例外、不能放進自己底下）；最上層＝路線，聚焦時＝聚焦的節點。
 *   - 放下＝nodeStore.moveToAnchor 一批寫入；toast「已移動」附「復原」（搬回原父節點、原鄰居之間；batchActions.moveWithUndo）。
 *   - 選了好幾張、拖的那張在裡面＝整批一起走（照畫面順序；已經跟著祖先走的子孫不另算）。
 *   - 外部落點：側欄路線列（data-drop-type="route"）＝移到那條路線最上層的最後（☎3②）。
 *   - 行內編輯中（草稿列、改名）不起拖。
 */
import { useCallback } from "react";
import type { NodeKind } from "../../domain";
import { PARKED_ADD_WHY } from "../../domain/depot";
import { dropVerdict } from "../../domain/dropRules";
import { APPEND, moveWithUndo } from "../../store/batchActions";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useDragReorder, type DropPlace, type Verdict } from "../common/dragReorder";
import { dragBatch } from "../common/selection/desktopSelection";
import type { VisibleRow } from "./useOutlineController";

const INDENT_PX = 28; // = OutlineRow.indentPx(1)

/** 側欄路線列當落點：判種類（車票不行、臨時票可以）＋已經在那裡的不搬 */
export function routeTargetVerdict(ids: readonly string[], routeId: string): Verdict {
  const t = useNodeStore.getState().tree;
  const v = dropVerdict(t, { id: routeId, kind: "route" }, ids, null);
  if (!v.ok) return v.why;
  const already = ids.every((id) => {
    const n = t.byId[id];
    return n && (n.parent_id === routeId || (n.parent_id === null && n.route_id === routeId));
  });
  return already ? "已經在這條路線的最上層" : true;
}

/** 拖到側欄路線：放到那條路線最上層的最後 */
export function dropOnRoute(ids: readonly string[], routeId: string): void {
  const name = useNodeStore.getState().routes.find((r) => r.id === routeId)?.name ?? "那條路線";
  void moveWithUndo(ids, routeId, APPEND, ids.length > 1 ? `已把 ${ids.length} 張移到「${name}」` : `已移到「${name}」`);
}

export function useOutlineDrag(opts: {
  root: HTMLElement | null;
  rows: VisibleRow[];
  top: { id: string; kind: NodeKind } | null;
  disabled: boolean;
  parked?: boolean;
}) {
  const { root, rows, top, disabled, parked } = opts;
  const items = rows.flatMap((r) => (r.type === "node" ? [{ id: r.id, depth: r.depth }] : []));
  const order = items.map((r) => r.id);

  /** 畫面上 ids 底下的子孫（照畫面順序）：攤平清單裡，緊接在它後面、層級比它深的那一段 */
  const carried = useCallback(
    (ids: readonly string[]): string[] => {
      const out: string[] = [];
      const set = new Set(ids);
      for (let i = 0; i < items.length; i++) {
        if (!set.has(items[i].id)) continue;
        const d = items[i].depth;
        for (let j = i + 1; j < items.length && items[j].depth > d; j++) if (!set.has(items[j].id)) out.push(items[j].id);
      }
      return out;
    },
    // items 每次 render 都是新陣列；以畫面順序＋層級為鍵
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items.map((r) => `${r.id}:${r.depth}`).join("|")],
  );

  useDragReorder({
    root,
    items,
    disabled: disabled || !top,
    canDrag: () => (parked ? PARKED_ADD_WHY : true),
    onRefuse: (_id, why) => useUiStore.getState().showToast({ message: why }, 3600),
    dragIds: (id) => {
      const batch = dragBatch("outline", id, order);
      // 祖先也在這一批的子孫不另搬（它跟著祖先走）
      const under = new Set(carried(batch));
      return batch.filter((x) => !under.has(x));
    },
    tree: {
      indent: INDENT_PX,
      carried,
      collapsed: (id) => !!useUiStore.getState().collapsed[id] && (useNodeStore.getState().tree.childrenOf[id]?.length ?? 0) > 0,
      expand: (id) => useUiStore.getState().setCollapsed(id, false),
    },
    resolve: (ids, place: DropPlace) => {
      if (!top) return "這裡放不下";
      if (place.kind === "target") return place.type === "route" ? routeTargetVerdict(ids, place.target) : "這裡放不下";
      const v = dropVerdict(useNodeStore.getState().tree, top, ids, place.parent);
      return v.ok ? true : v.why;
    },
    onDrop: (ids, place) => {
      if (!top) return;
      if (place.kind === "target") {
        if (place.type === "route") dropOnRoute(ids, place.target);
        return;
      }
      const v = dropVerdict(useNodeStore.getState().tree, top, ids, place.parent);
      if (!v.ok) return;
      // 放進摺起來的父節點：打開它，看得到落在哪
      if (place.parent) useUiStore.getState().setCollapsed(place.parent, false);
      void moveWithUndo(ids, v.parentId, { after: place.after, before: place.before }, ids.length > 1 ? `已移動 ${ids.length} 張` : "已移動");
    },
  });
}
