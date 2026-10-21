/**
 * 路線頭的統計——桌機大綱頁首與手機路線圖抬頭同一把尺（磨光⑤ N12）。
 *
 * 之前桌機寫「車票 3/9 済・進度 33%・項 15」（只數車票、済照班次判斷），手機寫「済 3/15」
 * （數全部節點、只看 nodes.status），同一條路線兩殼的分子分母對不上。現在兩殼都：
 *   - 分母只數 kind==='ticket' 的節點（車廂、列車、支線不算車票）
 *   - 済由呼叫端傳入的 `isDone` 判（活著的定期券看目前班次的結局、其餘看 status；兩殼各自接 currentOccurrences）
 *   - pct ＝ 車票済／車票總數 四捨五入到整數（沒有車票＝0）
 *   - items ＝ 範圍內全部節點數（車站不在樹裡）
 *
 * 純函式、不碰 store；樹的走訪另給 `flattenSubtrees`，只吃 `{ byId, childrenOf }` 的最小形狀。
 */

export interface RouteHeadNode {
  id: string;
  kind: string;
  status: string;
}

export interface RouteHeadStats {
  ticketDone: number;
  ticketTotal: number;
  /** 車票済／車票總數（0–100 整數）；沒有車票＝0 */
  pct: number;
  /** 範圍內全部節點數 */
  items: number;
}

export function routeHeadStats<N extends RouteHeadNode>(nodes: readonly N[], isDone: (n: N) => boolean): RouteHeadStats {
  let ticketTotal = 0;
  let ticketDone = 0;
  for (const n of nodes) {
    if (n.kind !== "ticket") continue;
    ticketTotal++;
    if (isDone(n)) ticketDone++;
  }
  const pct = ticketTotal > 0 ? Math.round((ticketDone / ticketTotal) * 100) : 0;
  return { ticketDone, ticketTotal, pct, items: nodes.length };
}

/**
 * 済了沒的共用規則（桌機 `isDoneNode` 同口徑）：活著的定期券看「目前班次」的結局，其餘看 nodes.status。
 * 手機路線圖用它；桌機大綱控制器自己包了一份同樣的 useCallback，兩邊改規則要一起改。
 */
export function isRouteNodeDone(
  n: { id: string; status: string },
  current: Readonly<Record<string, { status: string } | undefined>>,
): boolean {
  const occ = current[n.id];
  return occ ? occ.status === "done" : n.status === "done";
}

/** 從這些根節點起，把整棵子樹（含根本身）攤平成清單；樹裡找不到的 id 略過 */
export function flattenSubtrees<N>(
  tree: { byId: Record<string, N>; childrenOf: Record<string, string[] | undefined> },
  rootIds: readonly string[],
): N[] {
  const out: N[] = [];
  const walk = (id: string) => {
    const n = tree.byId[id];
    if (!n) return;
    out.push(n);
    for (const k of tree.childrenOf[id] ?? []) walk(k);
  };
  for (const id of rootIds) walk(id);
  return out;
}

/** 手機抬頭副標的統計段：「車票 3/9 済」；沒有車票＝空字串（呼叫端不加分隔） */
export function routeHeadTicketText(s: RouteHeadStats): string {
  return s.ticketTotal > 0 ? `車票 ${s.ticketDone}/${s.ticketTotal} 済` : "";
}
