/**
 * 看板（第五本第三梯 ⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §1）的純邏輯，兩殼共用。
 *
 * 卡＝葉節點任務：車票，以及沒有子項的列車、車廂。有子項的列車、支線、車站不是卡。
 * 依狀態、依車站：欄內順序＝大綱順序（`sort_key` 是兄弟間的順序，跨列車的同欄沒有對應的資料，所以不手排）。
 * 依列車：欄＝路線最上層＋每個直屬的列車與支線；放在誰旁邊就進誰那一層，空欄進那一欄的節點。
 * 純函式、不碰 store／DOM；import 帶 `.ts`（scripts/tests 直接載入）。
 */
import type { NodeKind, NodeRow, NodeStatus } from "./node.ts";
import { isTaskDone, type OccurrenceLike } from "./taskFilter.ts";

export type BoardGroup = "status" | "train" | "station";
export type BoardStatus = NodeStatus;

/** 欄的順序（兩殼同一份） */
export const STATUS_COLUMNS: readonly BoardStatus[] = ["todo", "doing", "paused", "done"];
export const STATUS_COLUMN_LABEL: Record<BoardStatus, string> = { todo: "未開始", doing: "進行中", paused: "途中下車", done: "済" };

export const parseBoardGroup = (raw: string | null): BoardGroup => (raw === "train" || raw === "station" ? raw : "status");
export const BOARD_GROUP_LABEL: Record<BoardGroup, string> = { status: "依狀態", train: "依列車", station: "依車站" };

export type BoardNode = Pick<NodeRow, "id" | "kind" | "parent_id" | "name" | "status">;

export interface BoardTree<N extends BoardNode = BoardNode> {
  byId: Record<string, N>;
  childrenOf: Record<string, string[] | undefined>;
}

export function isCardKind(kind: NodeKind): boolean {
  return kind === "ticket" || kind === "train" || kind === "car";
}

/** 這張卡在哪一欄：済看目前班次（同大綱的済章），其餘看 nodes.status */
export function cardStatus(node: Pick<NodeRow, "status">, occ: OccurrenceLike | undefined): BoardStatus {
  if (isTaskDone(node, occ)) return "done";
  return node.status === "done" ? "todo" : node.status;
}

/** 這一張現在在看板上看得到嗎（跳轉落點用；聚焦已清）：要是卡，而且沒被「隱藏済」收起來 */
export function isVisibleCard<N extends BoardNode>(tree: BoardTree<N>, id: string, occ: OccurrenceLike | undefined, hideDone: boolean): boolean {
  const n = tree.byId[id];
  if (!n || !isCardKind(n.kind) || (tree.childrenOf[id]?.length ?? 0) > 0) return false;
  return !(hideDone && isTaskDone(n, occ));
}

/** 跨路線看板的済欄最多畫幾張：済只會越積越多，要找舊的走清單版面 */
export const DONE_COLUMN_LIMIT = 100;

/**
 * 済欄要畫哪幾張：最近完成的在前，超過上限的只算張數。
 * 單發票看 completed_at；定期券的完成時刻在班次上、列上只有班次日（已済的目前班次都是最近幾天的），再沒有才看 updated_at。
 */
export function recentDoneCards<T extends { node: Pick<NodeRow, "id" | "completed_at" | "updated_at"> }>(
  rows: readonly T[],
  occurrences: Readonly<Record<string, OccurrenceLike | undefined>>,
  limit = DONE_COLUMN_LIMIT,
): { shown: T[]; rest: number } {
  const stamp = (r: T) => r.node.completed_at ?? occurrences[r.node.id]?.due_on ?? r.node.updated_at;
  const sorted = [...rows].sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0));
  return { shown: sorted.slice(0, limit), rest: Math.max(0, sorted.length - limit) };
}

export interface BoardCard<N extends BoardNode = BoardNode> {
  node: N;
  /** 祖先路徑（不含路線與自己），給卡上那行小字：「單字 › 第 1 週」 */
  crumb: string[];
}

/** 從這些根節點起攤平成大綱順序的卡；祖先路徑從 `crumb` 接下去 */
export function boardCards<N extends BoardNode>(tree: BoardTree<N>, rootIds: readonly string[], crumb: readonly string[] = []): BoardCard<N>[] {
  const out: BoardCard<N>[] = [];
  const walk = (id: string, path: readonly string[]) => {
    const n = tree.byId[id];
    if (!n) return;
    const kids = tree.childrenOf[id] ?? [];
    if (!kids.length) {
      if (isCardKind(n.kind)) out.push({ node: n, crumb: [...path] });
      return;
    }
    for (const k of kids) walk(k, [...path, n.name]);
  };
  for (const id of rootIds) walk(id, crumb);
  return out;
}

export interface StatusColumn<N extends BoardNode = BoardNode> {
  status: BoardStatus;
  cards: BoardCard<N>[];
}

export function statusColumns<N extends BoardNode>(
  cards: readonly BoardCard<N>[],
  occurrences: Readonly<Record<string, OccurrenceLike | undefined>>,
): StatusColumn<N>[] {
  return STATUS_COLUMNS.map((status) => ({
    status,
    cards: cards.filter((c) => cardStatus(c.node, occurrences[c.node.id]) === status),
  }));
}

/** 真正掛的車站：車站還在、而且跟票同一條路線才算（搬到別條路線、車站被刪＝當沒掛，資料不改，復原就回來） */
export function effectiveStation(
  node: Pick<NodeRow, "station_id" | "route_id">,
  stations: ReadonlyMap<string, Pick<NodeRow, "parent_id">>,
): string | null {
  const id = node.station_id;
  if (!id) return null;
  const s = stations.get(id);
  return s && s.parent_id === node.route_id ? id : null;
}

export interface StationColumn<N extends BoardNode = BoardNode, S = NodeRow> {
  /** null＝還沒排站 */
  station: S | null;
  cards: BoardCard<N>[];
}

/** 依車站分欄：「還沒排站」一欄＋這條路線每一站（照車站順序、含已到站），欄內順序跟大綱 */
export function stationColumns<N extends BoardNode & Pick<NodeRow, "station_id" | "route_id">, S extends Pick<NodeRow, "id" | "parent_id">>(
  cards: readonly BoardCard<N>[],
  stations: readonly S[],
): StationColumn<N, S>[] {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const cols = new Map<string | null, BoardCard<N>[]>([[null, []], ...stations.map((s): [string, BoardCard<N>[]] => [s.id, []])]);
  for (const c of cards) cols.get(effectiveStation(c.node, byId))!.push(c);
  return [{ station: null, cards: cols.get(null)! }, ...stations.map((s) => ({ station: s, cards: cols.get(s.id)! }))];
}

export interface TrainColumn<N extends BoardNode = BoardNode> {
  /** 這一欄的節點；null＝這份清單的最上層（路線最上層，或聚焦那一節的直屬） */
  holder: N | null;
  cards: BoardCard<N>[];
}

/**
 * 依列車分欄：`rootIds` 裡有子項的節點與列車、支線各成一欄，其餘（直屬的車票）併成最上層那一欄。
 * 最上層那欄一律畫，是直屬車票的落點；沒有子項的列車照樣是一欄（空欄＝放進它）。
 */
export function trainColumns<N extends BoardNode>(tree: BoardTree<N>, rootIds: readonly string[]): TrainColumn<N>[] {
  const top: BoardCard<N>[] = [];
  const cols: TrainColumn<N>[] = [];
  for (const id of rootIds) {
    const n = tree.byId[id];
    if (!n || n.kind === "station") continue;
    const kids = tree.childrenOf[id] ?? [];
    if (n.kind === "ticket" || (n.kind === "car" && !kids.length)) {
      top.push({ node: n, crumb: [] });
      continue;
    }
    cols.push({ holder: n, cards: boardCards(tree, kids) });
  }
  return [{ holder: null, cards: top }, ...cols];
}

/**
 * 依列車的落點換算：放在誰旁邊就進誰那一層。
 * `after`／`before`＝畫面上的上下鄰居（可能在不同車廂）；回傳寫入要用的父節點與同層的鄰居錨。
 * `holderId`＝這一欄的節點；null＝最上層，父節點由呼叫端的 `topId`（路線或聚焦那一節）決定。
 */
export function trainDropPlace(
  tree: BoardTree<BoardNode>,
  topId: string,
  holderId: string | null,
  after: string | null,
  before: string | null,
): { parentId: string; after: string | null; before: string | null } {
  const home = holderId ?? topId;
  const parentOf = (id: string | null) => {
    if (!id) return null;
    const p = tree.byId[id]?.parent_id;
    // 路線最上層的票 parent_id 是 null（路線標籤）；樹裡找不到的父節點也當最上層
    return p && tree.byId[p] ? p : topId;
  };
  const parentId = parentOf(after) ?? parentOf(before) ?? home;
  return {
    parentId,
    after: after && parentOf(after) === parentId ? after : null,
    before: before && parentOf(before) === parentId ? before : null,
  };
}

/** 欄 key：依列車的最上層、依車站的還沒排站（其餘欄＝狀態或節點 id） */
export const TOP_COL = "$top";
export const NO_STATION_COL = "$none";
/** 依列車的車廂小標在拖曳清單裡是一列假列，id＝前綴＋節點 id：讓縫分得出小標上下 */
export const SUB_ROW = "sub:";
const isSubRow = (id: string | null): id is string => !!id && id.startsWith(SUB_ROW);

/**
 * 依列車的落點換算：把拖曳給的鄰居（可能是小標假列）換回真正的父節點與鄰居錨。
 * 縫在小標正下方＝進那節車廂的最前面；縫在小標正上方＝不進車廂、看上面那張（放在誰旁邊就進誰那一層）。
 * `col`＝這一欄的 key（TOP_COL 或節點 id）。
 */
export function resolveTrainDrop(
  tree: BoardTree<BoardNode>,
  topId: string,
  col: string,
  after: string | null,
  before: string | null,
): { parentId: string; after: string | null; before: string | null } {
  const nextCard = isSubRow(before) ? null : before;
  if (isSubRow(after)) return trainDropPlace(tree, topId, after.slice(SUB_ROW.length), null, nextCard);
  return trainDropPlace(tree, topId, col === TOP_COL ? null : col, after, nextCard);
}
