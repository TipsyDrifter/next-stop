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
import { useCallback } from "react";
import { nodeRepo } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import type { NodeRow } from "../../domain";

export type AttachKind = "branch" | "train" | "car";

export interface AttachOption {
  id: string;
  kind: AttachKind;
  name: string;
  /** 0＝路線的直接子節點 */
  depth: number;
  /** 依 loadTree 的 kinds 參數；沒傳＝true */
  selectable: boolean;
}

const ATTACH_KINDS: readonly string[] = ["branch", "train", "car"];

/** 純函式：把 listRouteTree 的平面列攤成縮排清單（父先子後；同層依 position，原陣列已排好） */
export function flattenAttachTree(
  routeId: string,
  rows: readonly NodeRow[],
  kinds?: readonly AttachKind[],
): AttachOption[] {
  const children = new Map<string, NodeRow[]>();
  for (const n of rows) {
    if (!ATTACH_KINDS.includes(n.kind) || !n.parent_id) continue;
    const list = children.get(n.parent_id);
    if (list) list.push(n);
    else children.set(n.parent_id, [n]);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position);
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
  routes: NodeRow[];
  loadTree(routeId: string, kinds?: readonly AttachKind[]): Promise<AttachOption[]>;
} {
  const routes = useNodeStore((s) => s.routes);
  const loadTree = useCallback(async (routeId: string, kinds?: readonly AttachKind[]) => {
    const rows = await nodeRepo.listRouteTree(routeId);
    return flattenAttachTree(routeId, rows, kinds);
  }, []);
  return { routes, loadTree };
}
