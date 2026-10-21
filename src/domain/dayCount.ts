/**
 * 同一天的完成數——一把尺一種說法（磨光⑤ N11）。
 *
 * 之前桌機今日、手機今日、串流今日列、手機行程表各算各的：前兩者「済才算完成」，串流把運休也算進「完成」，
 * 字樣又有「完成 d/t」「蓋了 d 張，還有 l 張」「完成 d/t・還有 l 張」三種。這裡收成一支：
 *   done ＝済的張數（運休不算完成）／total ＝這一天的張數／left ＝還沒交代的張數（済與運休都扣掉）
 * 「済＋運休」＝結清；left 為 0 且 total > 0 ⇒ 全部結清。
 *
 * 純函式、不碰 store／DOM；各殼把自己的列轉成 `DayCountItem` 再丟進來（判準函式各殼已有，這裡不重寫）。
 */

/** 一張票在這一天的結局：done＝済；settled＝済或運休（done 一定 settled） */
export interface DayCountItem {
  done: boolean;
  settled: boolean;
}

export interface DayCount {
  done: number;
  total: number;
  left: number;
}

export function dayCount(items: readonly DayCountItem[]): DayCount {
  let done = 0;
  let settled = 0;
  for (const it of items) {
    if (it.done) done++;
    // done 必定算結清，即使呼叫端忘了把 settled 一起設
    if (it.settled || it.done) settled++;
  }
  return { done, total: items.length, left: items.length - settled };
}

/**
 * 文案兩段：`main`＝「完成 d/t」（UI 把數字包 `<b>`）、`tail`＝「還有 l 張」或「全部結清」。
 * total 為 0 ⇒ null（不顯示）。
 */
export function dayCountParts(c: DayCount): { done: number; total: number; tail: string } | null {
  if (c.total <= 0) return null;
  return { done: c.done, total: c.total, tail: c.left > 0 ? `還有 ${c.left} 張` : "全部結清" };
}

/** 純文字版：「完成 3/9・還有 6 張」「完成 9/9・全部結清」；total 為 0 ⇒ 空字串 */
export function dayCountText(c: DayCount): string {
  const p = dayCountParts(c);
  return p ? `完成 ${p.done}/${p.total}・${p.tail}` : "";
}
