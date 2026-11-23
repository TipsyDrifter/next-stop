/**
 * 側板「車站」一列（⑫；契約 §5 ＋ 第三梯 Bug 3）：
 *   支線、列車（含底下有子項者）、車廂、車票，只要隸屬有車站的路線皆可指定車站；無路線臨時票不出。
 *   整欄 LWW，存在 nodes.station_id；當自身未顯式指定（station_id === null）且由祖先支線／列車／車廂繼承時，
 *   清楚顯示「繼承自『○○』（站名）」，支援隨時覆寫為其他站或恢復繼承。
 */
import { useEffect, useMemo, useState } from "react";
import { nodeRepo } from "../../data";
import type { NodeRow } from "../../domain";
import { inheritedStationOf, type StationParentNode } from "../../domain/board";
import { useNodeStore } from "../../store/nodeStore";
import { FieldRow } from "../common/fields";
import { Select } from "../common/Select";
import { routeStations } from "./useRouteBoard";

const NONE = "";

export interface StationFieldModel {
  value: string;
  /** 是否正由祖先繼承有效車站（自身未顯式覆寫） */
  inherited: boolean;
  /** value＝NONE 代表還沒排站或繼承自父層 */
  options: { value: string; label: string }[];
  set(value: string): void;
}

const CAN_ASSIGN_STATION = new Set(["branch", "train", "car", "ticket"]);

/** 不該出這一列＝null */
export function useStationField(node: NodeRow): StationFieldModel | null {
  const stations = useNodeStore((s) => s.stations);
  const treeRouteId = useNodeStore((s) => s.routeId);
  const treeById = useNodeStore((s) => s.tree.byId);
  const routes = useNodeStore((s) => s.routes);
  const updateNode = useNodeStore((s) => s.updateNode);

  const needRemoteTree =
    CAN_ASSIGN_STATION.has(node.kind) &&
    !!node.route_id &&
    !!node.parent_id &&
    treeRouteId !== node.route_id &&
    !routes.some((r) => r.id === node.parent_id);

  const [remoteById, setRemoteById] = useState<Record<string, StationParentNode> | undefined>(undefined);

  useEffect(() => {
    if (!needRemoteTree || !node.route_id) {
      setRemoteById(undefined);
      return;
    }
    let alive = true;
    nodeRepo
      .listRouteTree(node.route_id)
      .then((rows) => {
        if (!alive) return;
        setRemoteById(Object.fromEntries(rows.map((r) => [r.id, r])));
      })
      .catch(() => {
        if (alive) setRemoteById(undefined);
      });
    return () => {
      alive = false;
    };
  }, [needRemoteTree, node.route_id, node.parent_id]);

  const list = useMemo(() => routeStations(stations, node.route_id), [stations, node.route_id]);
  if (!CAN_ASSIGN_STATION.has(node.kind) || !node.route_id || !list.length) return null;

  const stationMap = new Map(list.map((s) => [s.id, s]));
  const byId: Readonly<Record<string, StationParentNode>> | undefined =
    treeRouteId === node.route_id ? treeById : remoteById;

  const ownId = node.station_id && stationMap.has(node.station_id) ? node.station_id : null;
  const parentInh = inheritedStationOf({ ...node, station_id: null }, stationMap, byId);
  const inheritedStationName = parentInh.stationId ? (stationMap.get(parentInh.stationId)?.name ?? null) : null;

  const noneLabel =
    parentInh.inheritedFrom && inheritedStationName
      ? ownId === null
        ? `繼承自「${parentInh.inheritedFrom.name}」（${inheritedStationName}）`
        : `恢復繼承自「${parentInh.inheritedFrom.name}」（${inheritedStationName}）`
      : "還沒排站";

  return {
    value: ownId ?? NONE,
    inherited: ownId === null && !!parentInh.stationId,
    options: [{ value: NONE, label: noneLabel }, ...list.map((s) => ({ value: s.id, label: s.name }))],
    set: (v) => void updateNode(node.id, { station_id: v === NONE ? null : v }),
  };
}

export function StationFieldRow({ node }: { node: NodeRow }) {
  const f = useStationField(node);
  if (!f) return null;
  return (
    <FieldRow label="車站">
      <span className="ns-select-wrap panel-select">
        <Select
          className="techo-input"
          aria-label="車站"
          value={f.value}
          onChange={(v) => {
            if (v !== f.value) f.set(v);
          }}
        >
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </span>
    </FieldRow>
  );
}
