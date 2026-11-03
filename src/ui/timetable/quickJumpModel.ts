/**
 * 時刻表⑦ 頁首搜尋（`quickJump.ts`）的純函式——從那邊抽出來給 node 測試直接載（整合席）。
 */
import { recallKey } from "../../domain/recall.ts";

/** 名字比對：NFKC＋小寫包含（同備註記憶）；開頭對到的排前面，其餘照原順序；term 空＝全部照原順序 */
export function matchByName<T extends { name: string }>(rows: readonly T[], term: string): T[] {
  const q = recallKey(term);
  if (!q) return rows.slice();
  const head: T[] = [];
  const mid: T[] = [];
  for (const r of rows) {
    const k = recallKey(r.name);
    const at = k.indexOf(q);
    if (at === 0) head.push(r);
    else if (at > 0) mid.push(r);
  }
  return [...head, ...mid];
}

/** 每組先各給一格（有對到的話）、剩下照組的順序補；輸出仍照組的順序（畫面上同一種排在一起） */
export function fairTake<T>(lists: readonly (readonly T[])[], limit: number): T[] {
  const take = lists.map(() => 0);
  let left = limit;
  lists.forEach((l, i) => {
    if (left > 0 && l.length > 0) {
      take[i] = 1;
      left--;
    }
  });
  lists.forEach((l, i) => {
    const more = Math.min(left, l.length - take[i]);
    if (more > 0) {
      take[i] += more;
      left -= more;
    }
  });
  return lists.flatMap((l, i) => l.slice(0, take[i]));
}
