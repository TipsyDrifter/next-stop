/**
 * 看板卡的 ⋯（右鍵同一份，D-主-153）——⑫ 契約 §1。路線看板與篩選清單（跨路線）共用；手機票卡 sheet 要現況、車站兩組時也接這裡。
 *
 * 頂層＝現況 ▾｜車站 ▾（有車站的路線才出）｜改期 ▾｜移動到…｜詳情｜選取｜刪除，七項（視覺規範 §2.4 上限），放不下的收在 group。
 * 規則都是既有的：現況走 boardActions（同看板換欄）、改期走 scheduleActions（行程表本來就跨路線）、
 * 移動到…走側板挑選器（requestMoveTo）、刪除走 deleteNodeFlow。這裡只排項目。
 */
import { KIND_LABEL, parseRule, type NodeRow } from "../../domain";
import type { TaskRow } from "../../domain/taskFilter";
import {
  STATUS_COLUMNS,
  STATUS_COLUMN_LABEL,
  cardStatus,
  inheritedStationOf,
  type StationParentNode,
} from "../../domain/board";
import { moveTargetRule } from "../../domain/moveTo";
import { PARKED_ADD_WHY } from "../../domain/depot";
import { addDays } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useSelectionStore } from "../../store/selectionStore";
import { useUiStore } from "../../store/uiStore";
import { confirmAndDeleteNode } from "../common/deleteNodeFlow";
import { requestMoveTo } from "../common/moveTo";
import type { PopMenuItem } from "../common/PopMenu";
import { makeScheduleActions } from "../schedule/scheduleActions";
import { moveCardToStatus, setCardsStation } from "./boardActions";
import { routeStations } from "./useRouteBoard";

const CHECK = "✓";

/** 「車站」那幾項（卡 ⋯、大綱 ⋯、選取列共用）：還沒排站（或繼承自父層）＋這條路線每一站 */
export function stationItems(
  nodes: readonly NodeRow[],
  routeId: string,
  group?: string,
  treeById?: Readonly<Record<string, StationParentNode>>,
): PopMenuItem[] {
  const ns = useNodeStore.getState();
  const list = routeStations(ns.stations, routeId);
  const stationMap = new Map(list.map((s) => [s.id, s]));
  const byId = treeById ?? (ns.routeId === routeId ? ns.tree.byId : undefined);
  const one = nodes.length === 1 ? nodes[0] : null;
  const ownId = one && one.station_id && stationMap.has(one.station_id) ? one.station_id : null;
  const parentInh = one ? inheritedStationOf({ ...one, station_id: null }, stationMap, byId) : { stationId: null, inheritedFrom: null };
  const inheritedName = parentInh.stationId ? (stationMap.get(parentInh.stationId)?.name ?? null) : null;
  const noneLabel =
    one && parentInh.inheritedFrom && inheritedName
      ? ownId === null
        ? `繼承自「${parentInh.inheritedFrom.name}」（${inheritedName}）`
        : `恢復繼承自「${parentInh.inheritedFrom.name}」（${inheritedName}）`
      : "還沒排站";
  const clearToastLabel =
    one && parentInh.inheritedFrom && inheritedName ? `繼承「${inheritedName}」` : "還沒排站";

  return [
    {
      key: "st:none",
      label: noneLabel,
      group,
      caps: one && ownId === null ? CHECK : undefined,
      onSelect: () => void setCardsStation(nodes, null, clearToastLabel),
    },
    ...list.map(
      (s): PopMenuItem => ({
        key: `st:${s.id}`,
        label: s.name,
        group,
        caps: one ? (ownId === s.id ? CHECK : ownId === null && parentInh.stationId === s.id ? "繼承" : undefined) : undefined,
        onSelect: () => void setCardsStation(nodes, s.id, `「${s.name}」`),
      }),
    ),
  ];
}

export interface CardMenuOpts {
  today: string;
  /** 路線收進車庫：看板唯讀（契約 §1），改東西的項目淡掉 */
  parked: boolean;
  /** 畫面順序（「選取」加進多選要排順序） */
  order: readonly string[];
  /** 開推遲小卡（「選日期…」），錨由呼叫端決定 */
  openDefer(node: NodeRow): void;
}

export function boardCardMenu(node: TaskRow, opts: CardMenuOpts): PopMenuItem[] {
  const { today, parked } = opts;
  const ns = useNodeStore.getState();
  const ui = useUiStore.getState();
  const occ = ns.currentOccurrences[node.id];
  const actions = makeScheduleActions("desktop");
  const isBranch = node.kind === "branch";
  const teiki = parseRule(node.repeat_rule) !== null;
  const why = parked ? PARKED_ADD_WHY : undefined;
  const current = cardStatus(node, occ);
  const skipped = occ?.status === "skipped";
  const settled = current === "done" || skipped;

  const status = isBranch
    ? []
    : STATUS_COLUMNS.map(
        (s): PopMenuItem => ({
          key: `status:${s}`,
          label: STATUS_COLUMN_LABEL[s],
          group: "現況",
          caps: s === current ? CHECK : undefined,
          disabled: parked,
          why,
          onSelect: () => void moveCardToStatus(node, s),
        }),
      );

  const stations = node.route_id && routeStations(ns.stations, node.route_id).length ? stationItems([node], node.route_id, "車站", ns.tree.byId) : [];
  const stationGroup = parked ? stations.map((s) => ({ ...s, disabled: true, why })) : stations;

  const dated = (key: string, label: string, day: string): PopMenuItem => ({
    key,
    label,
    group: "改期",
    disabled: parked || settled,
    why: why ?? "這張已經有結局了",
    onSelect: () => actions.defer({ kind: "due", node }, day),
  });
  const reschedule: PopMenuItem[] = isBranch
    ? []
    : [
    ...(teiki
      ? [
          {
            key: "suspend",
            label: skipped ? "取消運休" : "運休",
            group: "改期",
            disabled: parked,
            why,
            onSelect: () =>
              void ns.skipOccurrence(node.id, !skipped).then((r) => {
                if (!r.ok && r.reason) ui.showToast({ message: r.reason }, 3600);
              }),
          } satisfies PopMenuItem,
        ]
      : []),
    dated("today", teiki ? "這一班改到今天" : "今天", today),
    dated("tomorrow", teiki ? "這一班改到明天" : "明天", addDays(today, 1)),
    {
      key: "pick",
      label: teiki ? "這一班改到…" : "選日期…",
      group: "改期",
      disabled: parked || settled,
      why: why ?? "這張已經有結局了",
      onSelect: () => opts.openDefer(node),
    },
  ];

  return [
    ...status,
    ...stationGroup,
    ...reschedule,
    ...(moveTargetRule(node.kind) ? [{ key: "move", label: "移動到…", disabled: parked, why, onSelect: () => requestMoveTo(node.id) } satisfies PopMenuItem] : []),
    {
      key: "panel",
      label: "詳情",
      hotkeyId: "board.open",
      cut: true,
      onSelect: () => {
        ui.select(node.id);
        ui.setPanelOpen(true);
      },
    },
    // 多選的可點入口（Ctrl／Shift＋點是加速）；已在多選中＝把這張加進去（同大綱）
    {
      key: "pick-card",
      label: "選取",
      disabled: parked,
      why,
      onSelect: () => {
        const sel = useSelectionStore.getState();
        if (sel.scope === "board" && sel.ids.length) {
          if (!sel.ids.includes(node.id)) sel.toggle("board", node.id, opts.order);
        } else sel.start("board", node.id);
        ui.select(node.id);
      },
    },
    { key: "del", label: "刪除", cut: true, danger: true, onSelect: () => void confirmAndDeleteNode(node.id) },
  ];
}

export const cardOverline = (node: Pick<NodeRow, "kind">) => ({ zh: `這張${KIND_LABEL[node.kind]}`, latin: "Card" });
