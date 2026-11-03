/**
 * nodeOrder——節點兄弟順序的唯一定義（回饋乙；結接縫 #108／點子 #119）。
 *
 * 兩件事：
 *   ① **比較器** `compareSiblings`：有排序鍵（`sort_key`）的在前、照**位元組序**（`<`）比；沒鍵的接在後面照
 *      position → created_at → id。SQL 端（`listSidebar`／`listRouteTree`）寫成
 *      `ORDER BY (sort_key IS NULL), sort_key, position, created_at, id`，SQLite 預設 BINARY 排序＝這裡的 `<`。
 *      ⚠ 不能用 `localeCompare`：base62 鍵的大小寫相對順序在 locale 比較下會變（`src/domain/fracIndex.ts` 檔頭）。
 *   ② **顯示群組** `groupFor`／`inGroup`：「兄弟」＝畫面上的同一份清單，不是同一個 parent_id——
 *      路線最上層的列車／支線（parent＝路線）和掛這條路線標籤的根層臨時車票（parent＝NULL、route_id＝路線）
 *      在大綱裡是同一份清單（`listRouteTree`＋`nodeStore.indexTree` 把兩者都放進 roots），所以共用一套鍵（#119）。
 *      車站雖然也掛在路線底下，畫面上是另一份清單（側欄、車站清單），自成一組。
 *
 * 零 runtime import：node test 直接載入。
 */

/** 比較器要用到的欄位（NodeRow 的子集） */
export interface SiblingOrderFields {
  id: string;
  sort_key: string | null;
  position: number;
  created_at: string;
}

const cmpBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 兄弟順序：有鍵在前（位元組序）→ 沒鍵在後；同鍵或都沒鍵時 position → created_at → id（與 SQL 的 ORDER BY 同一句） */
export function compareSiblings(a: SiblingOrderFields, b: SiblingOrderFields): number {
  const ak = a.sort_key;
  const bk = b.sort_key;
  if ((ak === null) !== (bk === null)) return ak === null ? 1 : -1;
  if (ak !== null && bk !== null && ak !== bk) return cmpBytes(ak, bk);
  return a.position - b.position || cmpBytes(a.created_at, b.created_at) || cmpBytes(a.id, b.id);
}

/** SQL 版的同一句（`listSidebar`／`listRouteTree` 與 repository 內部讀群組共用） */
export const SIBLING_ORDER_SQL = "(sort_key IS NULL), sort_key, position, created_at, id";

/**
 * 顯示群組（＝畫面上的一份清單；排序鍵只在群組內有意義）：
 *   - `routeTop`：路線最上層——路線的非車站子節點 ∪ 掛這條路線標籤的根層臨時車票
 *   - `stations`：路線的車站
 *   - `root`：根層同種類（幹線）
 *   - `inbox`：沒有路線標籤的根層臨時車票（收件匣）——**不排序**，照 created_at，不給鍵
 *   - `children`：其他父節點的子節點（幹線底下的路線、支線／列車／車廂底下的項目）
 */
export type SiblingGroup =
  | { type: "routeTop"; routeId: string }
  | { type: "stations"; routeId: string }
  | { type: "root"; kind: string }
  | { type: "inbox" }
  | { type: "children"; parentId: string };

/** 一列「放在哪」的描述：父節點（＋它的種類）、自己的種類、根層臨時車票的路線標籤 */
export interface SlotSpec {
  parentId: string | null;
  parentKind: string | null;
  kind: string;
  /** 只有根層車票用得到（路線標籤）；其餘忽略 */
  routeId: string | null;
}

export function groupFor(s: SlotSpec): SiblingGroup {
  if (s.parentId === null) {
    if (s.kind === "ticket") return s.routeId ? { type: "routeTop", routeId: s.routeId } : { type: "inbox" };
    return { type: "root", kind: s.kind };
  }
  if (s.parentKind === "route") {
    return s.kind === "station" ? { type: "stations", routeId: s.parentId } : { type: "routeTop", routeId: s.parentId };
  }
  return { type: "children", parentId: s.parentId };
}

/** 群組的字串鍵（分組用）；同一份清單＝同一個鍵 */
export function groupKey(g: SiblingGroup): string {
  switch (g.type) {
    case "routeTop":
    case "stations":
      return `${g.type}:${g.routeId}`;
    case "root":
      return `root:${g.kind}`;
    case "inbox":
      return "inbox";
    case "children":
      return `children:${g.parentId}`;
  }
}

export function sameGroup(a: SiblingGroup, b: SiblingGroup): boolean {
  return groupKey(a) === groupKey(b);
}

/** 收件匣不排序（照 created_at）：不給鍵、不回填 */
export function isOrderedGroup(g: SiblingGroup): boolean {
  return g.type !== "inbox";
}

/** 這一列屬不屬於群組 g（只看自己的欄位；`children` 的父節點若是路線，呼叫端應改用 routeTop／stations） */
export function inGroup(
  row: { parent_id: string | null; kind: string; route_id: string | null },
  g: SiblingGroup,
): boolean {
  switch (g.type) {
    case "routeTop":
      return (
        (row.parent_id === g.routeId && row.kind !== "station") ||
        (row.parent_id === null && row.kind === "ticket" && row.route_id === g.routeId)
      );
    case "stations":
      return row.parent_id === g.routeId && row.kind === "station";
    case "root":
      return row.parent_id === null && row.kind === g.kind;
    case "inbox":
      return row.parent_id === null && row.kind === "ticket" && row.route_id === null;
    case "children":
      return row.parent_id === g.parentId;
  }
}

/** 收件匣（不排序的群組）的順序：created_at → id */
export function compareCreated(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  return cmpBytes(a.created_at, b.created_at) || cmpBytes(a.id, b.id);
}

/**
 * 拖曳的落點錨：放在 after 之後、before 之前（鄰居 id；null＝開放端）。
 * 換算成格位見 `nodeSortKey.ts` 的 `slotFromAnchor`——拖曳中清單被同步重載也不會落錯格（錨比整數 index 穩）。
 */
export interface SlotAnchor {
  after: string | null;
  before: string | null;
}

/** 一列在顯示序裡的上下鄰居（復原記「原鄰居」用）；不在清單裡＝接在最後 */
export function anchorAround(order: readonly string[], id: string): SlotAnchor {
  const i = order.indexOf(id);
  if (i < 0) return { after: order.length ? order[order.length - 1] : null, before: null };
  return { after: i > 0 ? order[i - 1] : null, before: i + 1 < order.length ? order[i + 1] : null };
}
