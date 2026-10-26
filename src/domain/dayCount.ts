/**
 * 同一天的完成數——一把尺一種說法（磨光⑤ N11）。
 *
 * 之前桌機今日、手機今日、串流今日列、手機行程表各算各的：前兩者「済才算完成」，串流把運休也算進「完成」，
 * 字樣又有「完成 d/t」「蓋了 d 張，還有 l 張」「完成 d/t・還有 l 張」三種。這裡收成一支：
 *   done ＝済的張數（運休不算完成）／total ＝這一天的張數／left ＝還沒交代的張數（済與運休都扣掉）
 * 「済＋運休」＝結清；left 為 0 且 total > 0 ⇒ 全部結清。
 *
 * 純函式、不碰 store／DOM；各殼把自己的列轉成 `DayCountItem` 再丟進來（判準函式各殼已有，這裡不重寫）。
 * 手機殼班（接縫 #104）：誤點數 `lateCount` 也在這裡（檔尾），今日頁與行程表同一支。
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

/* ───────────── 誤點數（手機殼班；接縫 #104）───────────── */

/**
 * 誤點數也收在這把尺上：之前今日頁數「誤點區有幾列」（今天補済的那張還留在原位，也被算進去），
 * 行程表的誤點列數「還沒交代的」——同一天兩頁差一張。收成一支：**誤點＝還沒交代**（済或運休就不算，同上面 left 的口徑）。
 * 今日頁誤點區裡今天剛補済的票照舊留在原位（結局上前、來歷退後），只是不再被數成誤點。
 */

/** 今日切片一列的子集（TodayRow 直接吃得進來；測試可手造） */
export interface LateCountRow {
  bucket: "late" | "due" | "today";
  status: string;
  scheduled_on: string | null;
  due_on: string | null;
  occurrence: { status: string; due_on: string } | null;
}

export interface LateCount {
  /** 還沒交代的誤點張數 */
  count: number;
  /** 這些列「有效日」的最小值（跳到最早那天用）；count 為 0 ⇒ null */
  earliest: string | null;
}

/**
 * 誤點數：今日切片裡 `bucket !== "today"`、**沒交代**（＝useTodayController `isSettledRow` 取反：
 * `occurrence === null && status !== "done"`；這裡不 import React 檔，所以照寫一份）的列。
 * 有效日：late ⇒ 班次日（`occurrence?.due_on ?? scheduled_on`，compareTodayRows 同一把尺）；due ⇒ 締切日。
 * 有效日晚於 today 的列不算（誤點／締切的定義本來就是「已過」；防今日切片過期）。
 */
export function lateCount(rows: readonly LateCountRow[], today: string): LateCount {
  let count = 0;
  let earliest: string | null = null;
  for (const r of rows) {
    if (r.bucket === "today") continue;
    if (r.occurrence !== null || r.status === "done") continue;
    // 走到這裡 occurrence 一定是 null（有班次記錄＝交代過），班次日 `occurrence?.due_on ?? scheduled_on` 就是 scheduled_on
    const eff = r.bucket === "late" ? r.scheduled_on : r.due_on;
    if (eff === null || eff > today) continue;
    count++;
    if (earliest === null || eff < earliest) earliest = eff;
  }
  return { count, earliest };
}

/** 誤點區標題的計數字：還有沒交代的 ⇒「N 件」；誤點區的票今天都交代了（區還在、票留原位）⇒「已交代」（同串流過去日的字） */
export function lateCountText(c: LateCount): string {
  return c.count > 0 ? `${c.count} 件` : "已交代";
}
