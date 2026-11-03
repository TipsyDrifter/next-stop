/**
 * nodeSortKey——排序鍵的「要寫哪幾列」（回饋乙）：落點錨→格位、一次放好幾張、存量回填。
 * 純函式；鍵的算術在 `./fracIndex`，順序與群組的定義在 `./nodeOrder`。兩個 repository（SQLite／記憶體）共用，
 * 兩台輸入一樣就算出一樣的鍵（決定性）。
 */
import { isValidKey, keysBetween } from "./fracIndex";
import {
  compareSiblings,
  groupFor,
  groupKey,
  isOrderedGroup,
  type SiblingOrderFields,
  type SlotAnchor,
} from "./nodeOrder";

export interface KeyWrite {
  id: string;
  key: string;
}

/**
 * 落點錨 → 格位（`rest`＝目的地群組拿掉要搬的那幾張之後的顯示序）。
 * 先認 after（找得到＝它的下一格）；找不到再認 before（它的那一格）；兩個都不在：after 本來就是 null＝最上面，
 * 否則（鄰居剛被刪、被同步搬走）放最後。
 */
export function slotFromAnchor(rest: readonly string[], anchor: SlotAnchor): number {
  if (anchor.after !== null) {
    const i = rest.indexOf(anchor.after);
    if (i >= 0) return i + 1;
  }
  if (anchor.before !== null) {
    const i = rest.indexOf(anchor.before);
    if (i >= 0) return i;
  }
  return anchor.after === null ? 0 : rest.length;
}

/**
 * 顯示序 `order`（已照 compareSiblings 排好、每項帶目前的鍵）裡，把 `ids` 依序放到「拿掉它們之後的第 index 格」要寫哪些列。
 * 同 fracIndex 的 `keyForSlot`（單張版）的規則：通常只回要搬的那幾張；上下鄰居同鍵或沒鍵／壞鍵、夾在縫裡擋路時，
 * 把擋路的那幾列一起重新給鍵（只動擋住這個縫的最少列）。回傳照顯示序。
 */
export function keysForSlot(
  order: readonly { id: string; key: string | null }[],
  ids: readonly string[],
  index: number,
): KeyWrite[] {
  if (!ids.length) return [];
  const moving = new Set(ids);
  const rest = order.filter((x) => !moving.has(x.id));
  const at = Math.max(0, Math.min(index, rest.length));
  const usable = (k: string | null): k is string => k !== null && isValidKey(k);
  let lo = at - 1;
  while (lo >= 0 && !usable(rest[lo].key)) lo--;
  const a = lo >= 0 ? (rest[lo].key as string) : null;
  let hi = at;
  while (hi < rest.length && !(usable(rest[hi].key) && (a === null || (rest[hi].key as string) > a))) hi++;
  const b = hi < rest.length ? (rest[hi].key as string) : null;
  const before = rest.slice(lo + 1, at).map((x) => x.id);
  const after = rest.slice(at, hi).map((x) => x.id);
  const all = [...before, ...ids, ...after];
  const keys = keysBetween(a, b, all.length);
  return all.map((x, i) => ({ id: x, key: keys[i] }));
}

/** 回填要用到的欄位 */
export interface BackfillRow extends SiblingOrderFields {
  kind: string;
  parent_id: string | null;
  route_id: string | null;
}

/**
 * 存量回填（0014 之前的列、舊版那台建的列）：每個顯示群組裡 sort_key 為 NULL 的列，照目前的顯示序
 * 接在該群組最後一個合法鍵後面（整組都沒鍵＝從頭給）。收件匣不排序、不給鍵。
 * `kindOf`：父節點的種類（認得出「父節點是路線」才分得出 routeTop／stations）；父節點不在（孤兒）＝null。
 * 決定性：輸入一樣（兩台同步收斂後）就算出一樣的鍵——值相同的 op 對面套用時不算撞。
 */
export function planSortKeyBackfill(rows: readonly BackfillRow[], kindOf: (id: string) => string | null): KeyWrite[] {
  const groups = new Map<string, BackfillRow[]>();
  for (const r of rows) {
    const g = groupFor({
      parentId: r.parent_id,
      parentKind: r.parent_id ? kindOf(r.parent_id) : null,
      kind: r.kind,
      routeId: r.route_id,
    });
    if (!isOrderedGroup(g)) continue;
    const k = groupKey(g);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  const out: KeyWrite[] = [];
  // 群組照鍵名排：輸出順序也決定性（測試與 op 先後好比對）
  for (const k of [...groups.keys()].sort()) {
    const list = groups.get(k)!.slice().sort(compareSiblings);
    const missing = list.filter((r) => r.sort_key === null);
    if (!missing.length) continue;
    let last: string | null = null;
    for (const r of list) if (r.sort_key !== null && isValidKey(r.sort_key)) last = r.sort_key;
    const keys = keysBetween(last, null, missing.length);
    missing.forEach((r, i) => out.push({ id: r.id, key: keys[i] }));
  }
  return out;
}
