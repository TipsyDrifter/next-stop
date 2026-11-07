/**
 * useRouteBoard——路線看板的欄（⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §1）。桌機 RouteBoard 與手機看板共用，不碰 DOM。
 *
 * 分欄算術在 domain/board.ts，這裡把它換成畫面要的樣子：欄名、計數、車站那一行小字、隱藏済之後的列。
 *   - 済的開關跟大綱同一個（uiStore.hideDone）：依狀態＝済欄收成窄條（仍是落點）；依列車、依車站＝那一欄不列已済的票，計數照算。
 *   - 依列車：直屬的票在前，車廂一段一個小標（`sub` 列）。小標也是一列（id＝`sub:<節點 id>`），讓拖曳的縫分得出
 *     「小標上面＝這一層」和「小標下面＝進那節車廂」；寫入前用 `resolveTrainDrop` 換回真正的父節點與鄰居。
 */
import { useMemo } from "react";
import type { NodeRow } from "../../domain";
import {
  NO_STATION_COL,
  STATUS_COLUMN_LABEL,
  SUB_ROW,
  TOP_COL,
  boardCards,
  resolveTrainDrop,
  stationColumns,
  statusColumns,
  trainColumns,
  type BoardCard,
  type BoardGroup,
  type BoardStatus,
  type BoardTree,
} from "../../domain/board";
import { compareSiblings } from "../../domain/nodeOrder";
import { isTaskDone, type OccurrenceLike } from "../../domain/taskFilter";

export type BoardRow = { type: "card"; card: BoardCard<NodeRow> } | { type: "sub"; id: string; label: string };

export { NO_STATION_COL, TOP_COL, resolveTrainDrop };

export interface BoardColumnModel {
  key: string;
  title: string;
  /** 欄名前的小字（最上層、支線） */
  pre?: string;
  status?: BoardStatus;
  /** 依列車：這一欄的節點；null＝最上層 */
  holder?: NodeRow | null;
  /** 依車站：這一站；null＝還沒排站 */
  station?: NodeRow | null;
  /** 依車站：欄名下那行小字（已到站 10/18、下一站・預定 11/20） */
  note?: string;
  arrived?: boolean;
  next?: boolean;
  /** 收成窄條（依狀態的済欄、隱藏中） */
  shut?: boolean;
  /** 畫出來的列（含依列車的小標） */
  rows: BoardRow[];
  /** 這一欄全部幾張、幾張済（含隱藏的） */
  total: number;
  done: number;
  /** 欄底一句（跨路線済欄超過上限：還有幾張沒顯示） */
  foot?: string;
}

export interface RouteBoardInput {
  tree: BoardTree<NodeRow>;
  routeId: string;
  /** 聚焦的那一節；範圍跟著縮 */
  zoom: NodeRow | null;
  /** 範圍最上層的節點（聚焦的那一節底下，否則路線最上層） */
  rootIds: readonly string[];
  /** 全部車站（nodeStore.stations），這裡挑這條路線的 */
  stations: readonly NodeRow[];
  occurrences: Readonly<Record<string, OccurrenceLike | undefined>>;
  group: BoardGroup;
  hideDone: boolean;
}

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/** 這條路線的車站：照車站順序、含已到站 */
export function routeStations(stations: readonly NodeRow[], routeId: string | null): NodeRow[] {
  return routeId ? stations.filter((s) => s.parent_id === routeId).sort(compareSiblings) : [];
}

/** 欄名下的小字；下一站＝第一個還沒到的 */
function stationNote(s: NodeRow, nextId: string | null): string | undefined {
  if (s.arrived_on) return `已到站 ${md(s.arrived_on)}`;
  if (s.id === nextId) return s.expected_on ? `下一站・預定 ${md(s.expected_on)}` : "下一站";
  return s.expected_on ? `預定 ${md(s.expected_on)}` : undefined;
}

export function useRouteBoard({ tree, routeId, zoom, rootIds, stations, occurrences, group, hideDone }: RouteBoardInput) {
  return useMemo(() => {
    const done = (n: NodeRow) => isTaskDone(n, occurrences[n.id]);
    const count = (cards: readonly BoardCard<NodeRow>[]) => ({ total: cards.length, done: cards.filter((c) => done(c.node)).length });
    const visible = (cards: readonly BoardCard<NodeRow>[]) => (hideDone ? cards.filter((c) => !done(c.node)) : cards);
    const asRows = (cards: readonly BoardCard<NodeRow>[]): BoardRow[] => cards.map((card) => ({ type: "card", card }));
    const allCards = boardCards(tree, rootIds);

    let columns: BoardColumnModel[];
    if (group === "status") {
      columns = statusColumns(allCards, occurrences).map((c) => {
        const shut = c.status === "done" && hideDone;
        return { key: c.status, title: STATUS_COLUMN_LABEL[c.status], status: c.status, shut, rows: shut ? [] : asRows(c.cards), ...count(c.cards) };
      });
    } else if (group === "station") {
      const list = routeStations(stations, routeId);
      const nextId = list.find((s) => !s.arrived_on)?.id ?? null;
      columns = stationColumns(allCards, list).map((c) =>
        c.station
          ? {
              key: c.station.id,
              title: c.station.name,
              station: c.station,
              note: stationNote(c.station, nextId),
              arrived: !!c.station.arrived_on,
              next: c.station.id === nextId,
              rows: asRows(visible(c.cards)),
              ...count(c.cards),
            }
          : { key: NO_STATION_COL, title: "還沒排站", station: null, rows: asRows(visible(c.cards)), ...count(c.cards) },
      );
    } else {
      columns = trainColumns(tree, rootIds).map((c) => {
        const cards = visible(c.cards);
        // 直屬的在前、車廂一段一段（同一節車廂的票在 DFS 裡本來就連著）
        const rows: BoardRow[] = asRows(cards.filter((x) => !x.crumb.length));
        let sub: string | null = null;
        for (const card of cards) {
          if (!card.crumb.length) continue;
          const parent = card.node.parent_id ?? "";
          if (parent !== sub) {
            sub = parent;
            rows.push({ type: "sub", id: SUB_ROW + parent, label: card.crumb.join(" › ") });
          }
          rows.push({ type: "card", card });
        }
        if (!c.holder) {
          return {
            key: TOP_COL,
            title: zoom ? zoom.name : "臨時車票",
            pre: zoom ? "直屬" : "最上層",
            holder: null,
            rows,
            ...count(c.cards),
          };
        }
        return { key: c.holder.id, title: c.holder.name, pre: c.holder.kind === "branch" ? "支線" : undefined, holder: c.holder, rows, ...count(c.cards) };
      });
    }

    const cardRows = columns.flatMap((c) => c.rows.flatMap((r) => (r.type === "card" ? [r.card] : [])));
    return {
      columns,
      /** 看得到的卡（畫面順序）：多選、全選用 */
      order: cardRows.map((c) => c.node.id),
      /** 拖曳清單（含依列車的小標假列） */
      items: columns.flatMap((c) => c.rows.map((r) => ({ id: r.type === "card" ? r.card.node.id : r.id }))),
      /** 範圍內全部的卡（含隱藏的）：済 N 的 N */
      doneCount: allCards.filter((c) => done(c.node)).length,
      cardCount: allCards.length,
      topId: zoom ? zoom.id : routeId,
      topKind: zoom ? zoom.kind : ("route" as const),
    };
  }, [tree, routeId, zoom, rootIds, stations, occurrences, group, hideDone]);
}
