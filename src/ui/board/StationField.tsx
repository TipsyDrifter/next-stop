/**
 * 側板「車站」一列（⑫；契約 §5）：沒有子項的車票、列車、車廂，而且在有車站的路線上才出；臨時車票沒掛路線時不出。
 * 整欄 LWW，存在 nodes.station_id；車站被刪、票搬到別條路線＝讀取時當沒掛（effectiveStation），不改寫，復原就回來。
 * `useStationField` 兩殼共用（手機詳情頁同一列）；桌機一律走 Choice（放得下分段鈕、放不下底線下拉）。
 */
import type { NodeRow } from "../../domain";
import { effectiveStation } from "../../domain/board";
import { useBoardStore } from "../../store/boardStore";
import { useNodeStore } from "../../store/nodeStore";
import { FieldRow } from "../common/fields";
import { Choice } from "../panel/Choice";
import { routeStations } from "./useRouteBoard";

const NONE = "";

export interface StationFieldModel {
  value: string;
  /** value＝NONE 代表還沒排站 */
  options: { value: string; label: string }[];
  set(value: string): void;
}

/** 不該出這一列＝null */
export function useStationField(node: NodeRow): StationFieldModel | null {
  const stations = useNodeStore((s) => s.stations);
  const updateNode = useNodeStore((s) => s.updateNode);
  const hasKids = useNodeStore((s) => {
    if (node.kind === "ticket") return false;
    if (s.tree.byId[node.id]) return (s.tree.childrenOf[node.id]?.length ?? 0) > 0;
    const row = s.today.byId[node.id];
    return row ? row.child_total > 0 : null;
  });
  // 不在目前路線樹、也不在今日切片的列車（從篩選清單點開）：任務清單裡有它＝葉節點
  const isTask = useBoardStore((s) => hasKids === null && s.tasks.some((t) => t.id === node.id));
  if (node.kind !== "ticket" && node.kind !== "train" && node.kind !== "car") return null;
  if (hasKids === true || (hasKids === null && !isTask) || !node.route_id) return null;
  const list = routeStations(stations, node.route_id);
  if (!list.length) return null;
  const current = effectiveStation(node, new Map(list.map((s) => [s.id, s])));
  return {
    value: current ?? NONE,
    options: [{ value: NONE, label: "還沒排站" }, ...list.map((s) => ({ value: s.id, label: s.name }))],
    set: (v) => void updateNode(node.id, { station_id: v === NONE ? null : v }),
  };
}

export function StationFieldRow({ node }: { node: NodeRow }) {
  const f = useStationField(node);
  if (!f) return null;
  return (
    <FieldRow label="車站">
      <Choice value={f.value} options={f.options} onChange={f.set} ariaLabel="車站" />
    </FieldRow>
  );
}
