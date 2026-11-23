/**
 * useAttachOptions——「掛到哪」挑選器的**資料**（車次①；契約 §2.0、§2.5 第 4 點、0-6）。
 *
 * 桌機 `AttachPicker`（乙席）與手機 `MobileAttachPicker`（丙席）共用這份資料、畫面各寫：
 *   - `routes`：第一層路線清單（與側欄、路線篩選同一份 `nodeStore.routes`，已依 position 排好）
 *   - `loadTree(routeId)`：該路線底下的支線／列車／車廂，攤平成「父先子後、同層依 position」的縮排清單；
 *     車票與車站不列。`depth` 0＝路線的直接子節點。
 *
 * `selectable`（契約 §2.0 表格的欄；§2.5 簽名之外另加、只加不改）：預設三種都可選；
 * 傳 `kinds`（例：收件匣「掛進列車」＝`["train","car"]`）時不在其中的種類回 false——UI 以灰字當群組頭。
 */
import { useCallback, useMemo } from "react";
import { nodeRepo } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import type { NodeRow } from "../../domain";
import { compareSiblings } from "../../domain/nodeOrder";

export type AttachKind = "branch" | "train" | "car" | "ticket";

export interface AttachOption {
  id: string;
  kind: AttachKind;
  name: string;
  /** 0＝路線的直接子節點（含掛該路線標籤的根層車票） */
  depth: number;
  /** 依 loadTree 的 kinds 參數；沒傳＝true */
  selectable: boolean;
}

export interface RouteLineGroup<R extends Pick<NodeRow, "line_id"> = NodeRow> {
  /** 幹線 id；無幹線（或幹線不在清單內）為 null */
  lineId: string | null;
  /** 幹線原始名稱；無幹線為「其他」 */
  lineName: string;
  /** 選單分組標頭：有幹線為「幹線・{lineName}」，無幹線為「其他」 */
  header: string;
  routes: R[];
}

/** 依幹線順序將路線分組（空幹線不輸出；無幹線或找不到幹線者歸入「其他」） */
export function groupRoutesByLine<R extends Pick<NodeRow, "line_id">>(
  routes: readonly R[],
  lines: readonly Pick<NodeRow, "id" | "name">[],
): RouteLineGroup<R>[] {
  if (routes.length === 0) return [];
  const lineIds = new Set(lines.map((l) => l.id));
  const byLine = new Map<string, R[]>();
  const other: R[] = [];
  for (const r of routes) {
    if (r.line_id && lineIds.has(r.line_id)) {
      const list = byLine.get(r.line_id);
      if (list) list.push(r);
      else byLine.set(r.line_id, [r]);
    } else {
      other.push(r);
    }
  }
  const out: RouteLineGroup<R>[] = [];
  for (const l of lines) {
    const list = byLine.get(l.id);
    if (list && list.length > 0) {
      out.push({ lineId: l.id, lineName: l.name, header: `幹線・${l.name}`, routes: list });
    }
  }
  if (other.length > 0) {
    out.push({ lineId: null, lineName: "其他", header: "其他", routes: other });
  }
  return out;
}

const ATTACH_KINDS: readonly string[] = ["branch", "train", "car", "ticket"];

/** 純函式：把 listRouteTree 的平面列攤成縮排清單（父先子後；同層依兄弟順序 compareSiblings，含掛路線標籤的根層車票） */
export function flattenAttachTree(
  routeId: string,
  rows: readonly NodeRow[],
  kinds?: readonly AttachKind[],
): AttachOption[] {
  const children = new Map<string, NodeRow[]>();
  for (const n of rows) {
    if (n.deleted_at) continue;
    if (!ATTACH_KINDS.includes(n.kind)) continue;
    const parentId = n.parent_id ?? (n.route_id === routeId ? routeId : null);
    if (!parentId) continue;
    const list = children.get(parentId);
    if (list) list.push(n);
    else children.set(parentId, [n]);
  }
  for (const list of children.values()) list.sort(compareSiblings);
  const out: AttachOption[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string, depth: number) => {
    for (const n of children.get(parentId) ?? []) {
      if (seen.has(n.id)) continue; // 防壞資料成環
      seen.add(n.id);
      const kind = n.kind as AttachKind;
      out.push({ id: n.id, kind, name: n.name, depth, selectable: kinds ? kinds.includes(kind) : true });
      walk(n.id, depth + 1);
    }
  };
  walk(routeId, 0);
  return out;
}

export function useAttachOptions(): {
  lines: NodeRow[];
  routes: NodeRow[];
  routeGroups: RouteLineGroup<NodeRow>[];
  loadTree(routeId: string, kinds?: readonly AttachKind[]): Promise<AttachOption[]>;
} {
  // 車庫與回顧 D-主-206 #14：收進車庫的路線不再能新掛筆記
  const lines = useNodeStore((s) => s.liveLines);
  const routes = useNodeStore((s) => s.liveRoutes);
  const routeGroups = useMemo(() => groupRoutesByLine(routes, lines), [routes, lines]);
  const loadTree = useCallback(async (routeId: string, kinds?: readonly AttachKind[]) => {
    const rows = await nodeRepo.listRouteTree(routeId);
    return flattenAttachTree(routeId, rows, kinds);
  }, []);
  return { lines, routes, routeGroups, loadTree };
}
