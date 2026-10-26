/**
 * streamModel——行程表串流的純函式層（主線車次①；契約 §3.1、§3.3 的視窗函式、§3.4 誤點列）。
 *
 * 這一檔是「串流長什麼樣」的唯一真相：兩端（桌機 StreamView／手機 MobileSchedule）只負責畫。
 *   streamModel(input)   把一個視窗 [from, to] 的 entries／dues 摺成段落：day（逐日）、gap（連續空白 ≥2 天壓一行）、
 *                        edge（before／after 邊界行，依 scheduleBounds）
 *   initialWindow／extendWindow／ensureWindow／canLoadOlder／canLoadNewer／sectionOf   視窗與補載
 *   mdw／nextMonday／sheetDeferItems   手機 ⋯ sheet 與段標題的日期文案
 *   lateSummary   誤點列（P8：算「張」，沿今日切片）
 *
 * **只准 `import type` ＋ `addDays`（帶 .ts 副檔名）**：`scripts/tests/stream-model.test.ts` 用 node 直接載這個檔，
 * 沒有 resolve hook、不能碰 React／store／repository（同 notes-logic.test.ts:2、64-65 的做法）。
 */
import type { DueEntry, ScheduleBounds, ScheduleEntry } from "../../data/nodeRepository";
import { addDays } from "../../lib/date.ts";
import { lateCount, type LateCountRow } from "../../domain/dayCount.ts";

export type { ScheduleBounds } from "../../data/nodeRepository";

/** 串流一列（班次層）。time＝這一班的有效時刻（車次②；建列時取 `entry.time`，沒填＝undefined，結構沒改） */
export interface StreamRow {
  entry: ScheduleEntry;
  time?: string;
}

export interface StreamDaySection {
  kind: "day";
  /** `d:${date}` */
  key: string;
  /** YYYY-MM-DD */
  date: string;
  rel: "today" | "tomorrow" | null;
  /** date < today */
  past: boolean;
  /** 該日 entries，順序＝calendar.entries 的順序（已是 date→created_at→position→id，nodeRepository.ts sortByDateThenNode） */
  rows: StreamRow[];
  /** 該日 dues（同上排序） */
  dues: DueEntry[];
  /** rows 與 dues 都空 */
  empty: boolean;
  /** 是攤開的空白區間／「以後」邊界裡的逐日行（UI 縮排＋前置短線） */
  inRun: boolean;
}

export interface StreamGapSection {
  kind: "gap";
  /** `g:${from}` */
  key: string;
  /** 連續空白日（≥2 天，不含今天） */
  from: string;
  to: string;
  count: number;
  /** 區間內任一天在 expanded ⇒ true；open 時其後緊跟 count 個 inRun day 段 */
  open: boolean;
  /** to < today */
  past: boolean;
}

export interface StreamEdgeSection {
  kind: "edge";
  key: "e:before" | "e:after";
  side: "before" | "after";
  /** before：label 日＝to（「to 以前 — 無班次」）；after：label 日＝from（「from 以後 — 尚無班次」）。
   *  from／to＝被吃進邊界行的空白日；長度可為 0（from > to） */
  from: string;
  to: string;
  /** 只有 after 能攤開；before 恆 false */
  open: boolean;
}

export type StreamSection = StreamDaySection | StreamGapSection | StreamEdgeSection;

export interface StreamInput {
  entries: readonly ScheduleEntry[];
  dues: readonly DueEntry[];
  /** 串流視窗（閉區間） */
  from: string;
  to: string;
  today: string;
  /** null＝還沒查到（不出邊界行、兩端都允許補載） */
  bounds: ScheduleBounds | null;
  /** 攤開的日 key（scheduleUiStore.expanded） */
  expanded: ReadonlySet<string>;
}

/** from..to（閉區間）逐日；to < from ⇒ 空陣列 */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * 串流段落（契約 §3.1 規則 1–7）。純函式、不改輸入、同輸入同輸出。
 *   1. 空白日＝沒有 entries 也沒有 dues、且不是今天（今天恆為 day 段）；只看視窗內的資料
 *   2. 連續空白 ≥2 天 ⇒ gap；單獨一天 ⇒ day（empty）；gap open 時其後逐日輸出 inRun day 段
 *   3. before 邊界：bounds 已知且 from <= earliest（或庫裡空）⇒ 開頭的連續空白日改成一行 edge before
 *   4. after 邊界：bounds 已知、無無界定期券、to >= latest（或庫裡空）⇒ 尾端的連續空白日改成一行 edge after（可攤開）
 *   5. 段序＝日期序；key 穩定   6. rel：今日／明日   7. 純函式
 */
export function streamModel(input: StreamInput): StreamSection[] {
  const { entries, dues, from, to, today, bounds, expanded } = input;
  const days = eachDay(from, to);
  if (!days.length) return [];

  const rowsByDate = new Map<string, StreamRow[]>();
  for (const e of entries) {
    if (e.date < from || e.date > to) continue;
    const list = rowsByDate.get(e.date);
    const row: StreamRow = { entry: e, time: e.time ?? undefined };
    if (list) list.push(row);
    else rowsByDate.set(e.date, [row]);
  }
  const duesByDate = new Map<string, DueEntry[]>();
  for (const d of dues) {
    if (d.date < from || d.date > to) continue;
    const list = duesByDate.get(d.date);
    if (list) list.push(d);
    else duesByDate.set(d.date, [d]);
  }
  const isBlank = (d: string): boolean => d !== today && !rowsByDate.has(d) && !duesByDate.has(d);

  const daySection = (date: string, inRun: boolean): StreamDaySection => {
    const rows = rowsByDate.get(date) ?? [];
    const dd = duesByDate.get(date) ?? [];
    return {
      kind: "day",
      key: `d:${date}`,
      date,
      rel: date === today ? "today" : date === addDays(today, 1) ? "tomorrow" : null,
      past: date < today,
      rows,
      dues: dd,
      empty: rows.length === 0 && dd.length === 0,
      inRun,
    };
  };

  // 規則 3：before 邊界吃掉開頭的連續空白日（可為 0 天）
  let start = 0;
  let before: StreamEdgeSection | null = null;
  if (bounds !== null && (bounds.earliest === null || from <= bounds.earliest)) {
    while (start < days.length && isBlank(days[start])) start++;
    before = {
      kind: "edge",
      key: "e:before",
      side: "before",
      from,
      to: start > 0 ? days[start - 1] : addDays(from, -1),
      open: false,
    };
  }

  // 規則 4：after 邊界吃掉尾端的連續空白日（可為 0 天；不吃進 before 已吃掉的）
  let end = days.length;
  let after: StreamEdgeSection | null = null;
  let afterRun: string[] = [];
  if (bounds !== null && !bounds.openEndedRepeat && (bounds.latest === null || to >= bounds.latest)) {
    while (end > start && isBlank(days[end - 1])) end--;
    afterRun = days.slice(end);
    after = {
      kind: "edge",
      key: "e:after",
      side: "after",
      from: end < days.length ? days[end] : addDays(to, 1),
      to,
      open: afterRun.some((d) => expanded.has(d)),
    };
  }

  const out: StreamSection[] = [];
  if (before) out.push(before);

  // 規則 1–2：中段逐日；連續空白 ≥2 壓成 gap
  let i = start;
  while (i < end) {
    const d = days[i];
    if (!isBlank(d)) {
      out.push(daySection(d, false));
      i++;
      continue;
    }
    let j = i;
    while (j < end && isBlank(days[j])) j++;
    const run = days.slice(i, j);
    if (run.length === 1) {
      out.push(daySection(d, false));
    } else {
      const open = run.some((x) => expanded.has(x));
      out.push({
        kind: "gap",
        key: `g:${run[0]}`,
        from: run[0],
        to: run[run.length - 1],
        count: run.length,
        open,
        past: run[run.length - 1] < today,
      });
      if (open) for (const x of run) out.push(daySection(x, true));
    }
    i = j;
  }

  if (after) {
    out.push(after);
    if (after.open) for (const x of afterRun) out.push(daySection(x, true));
  }
  return out;
}

/* ───────────── 視窗（契約 §3.1 下半；§0-1 第 6 條：上限＝整段寬度一年） ───────────── */

/** 初始視窗 [today−3, today+21] */
export const INITIAL_BEFORE = 3;
export const INITIAL_AFTER = 21;
/** 每次往上／往下補 14 天 */
export const STEP_DAYS = 14;
/** 視窗整段寬度上限（天數，含首尾）；`projectFixed` 一次最多投 400 天，超過會靜默截斷 */
export const MAX_SPAN_DAYS = 365;

export interface StreamWindow {
  from: string;
  to: string;
}

/** 兩個日期 key 相差幾天（a − b）；不經 Date.parse，避免 date-only 被當 UTC 而跨日 */
function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()) / 86_400_000);
}

/** 視窗的天數（含首尾） */
function spanOf(from: string, to: string): number {
  return diffDays(to, from) + 1;
}

export function initialWindow(today: string): StreamWindow {
  return { from: addDays(today, -INITIAL_BEFORE), to: addDays(today, INITIAL_AFTER) };
}

/** 往 side 補 STEP_DAYS；超過 MAX_SPAN_DAYS 就從另一端收掉 */
export function extendWindow(w: StreamWindow, side: "older" | "newer"): StreamWindow {
  if (side === "older") {
    const from = addDays(w.from, -STEP_DAYS);
    const to = spanOf(from, w.to) > MAX_SPAN_DAYS ? addDays(from, MAX_SPAN_DAYS - 1) : w.to;
    return { from, to };
  }
  const to = addDays(w.to, STEP_DAYS);
  const from = spanOf(w.from, to) > MAX_SPAN_DAYS ? addDays(to, -(MAX_SPAN_DAYS - 1)) : w.from;
  return { from, to };
}

/**
 * 保證 [from, to] 都在視窗裡（跳轉／月曆翻月用）；放不下 MAX_SPAN 時改成以 from 為錨的新視窗
 * [from−3, max(to, from+21)]（再夾上限）。已在裡面 ⇒ 回同一個物件（memo 友善）。
 */
export function ensureWindow(w: StreamWindow, from: string, to: string): StreamWindow {
  if (to < from) [from, to] = [to, from];
  if (from >= w.from && to <= w.to) return w;
  const nf = from < w.from ? from : w.from;
  const nt = to > w.to ? to : w.to;
  if (spanOf(nf, nt) <= MAX_SPAN_DAYS) return { from: nf, to: nt };
  const f = addDays(from, -INITIAL_BEFORE);
  const wide = addDays(from, INITIAL_AFTER);
  let t = to > wide ? to : wide;
  if (spanOf(f, t) > MAX_SPAN_DAYS) t = addDays(f, MAX_SPAN_DAYS - 1);
  return { from: f, to: t };
}

/** 能不能往上補：沒有 before 邊界 */
export function canLoadOlder(sections: readonly StreamSection[]): boolean {
  return !sections.some((s) => s.kind === "edge" && s.side === "before");
}

/** 能不能往下補：沒有收著的 after 邊界 */
export function canLoadNewer(sections: readonly StreamSection[]): boolean {
  return !sections.some((s) => s.kind === "edge" && s.side === "after" && !s.open);
}

/** 某天落在哪一段（goTo 用）：day 段回它；在收著的 gap／after 邊界裡回那個段（goTo 要先攤開）；before 邊界裡回 before */
export function sectionOf(sections: readonly StreamSection[], day: string): StreamSection | null {
  for (const s of sections) if (s.kind === "day" && s.date === day) return s;
  for (const s of sections) {
    if (s.kind === "day") continue;
    if (day >= s.from && day <= s.to) return s;
  }
  return null;
}

/* ───────────── 日期文案（手機 sheet／段標題） ───────────── */

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** 本地 Date（不經 Date.parse，避免 date-only 被當 UTC 而跨日；DeferPopover.tsx:71-74 同款） */
function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 「M/D（週X）」（useTodayController.whenText 同一格式） */
export function mdw(day: string): string {
  const d = dateOf(day);
  return `${d.getMonth() + 1}/${d.getDate()}（週${WEEK_ZH[d.getDay()]}）`;
}

/** 嚴格晚於 day 的最近星期一（DeferPopover.tsx:96-100 同一算法；今天就是週一 → 七天後那個週一） */
export function nextMonday(day: string): string {
  const dow = dateOf(day).getDay(); // 0=日
  const delta = (8 - dow) % 7 || 7;
  return addDays(day, delta);
}

/**
 * 手機 ⋯ sheet 的兩個改期項（契約 §4.6）。base＝max(today, railDate ?? today)：
 *   無執行日 ⇒「排到明天」＝today+1；未來票 ⇒「往後推一天」＝railDate+1；過去／今天的票 ⇒「推遲到明天」＝today+1
 *   monday＝嚴格晚於 base 的下週一
 */
export function sheetDeferItems(
  railDate: string | null,
  scheduledOn: string | null,
  today: string,
): { first: { label: "推遲到明天" | "往後推一天" | "排到明天"; day: string }; monday: string } {
  const rail = railDate ?? today;
  const base = rail > today ? rail : today;
  const label = scheduledOn === null ? "排到明天" : rail > today ? "往後推一天" : "推遲到明天";
  return { first: { label, day: addDays(base, 1) }, monday: nextMonday(base) };
}

/* ───────────── 誤點列（P8，契約 §3.4） ───────────── */

/** TodayRow 的子集（測試可手造）；形狀＝domain/dayCount 的 LateCountRow */
export type LateRowSeed = LateCountRow;

/**
 * 誤點列：張數與最早那天。算法收進 domain/dayCount 的 `lateCount`（手機殼班，接縫 #104：今日頁的「誤點 N 件」吃同一支），
 * 這裡只留原名給串流與既有測試。
 */
export function lateSummary(rows: readonly LateRowSeed[], today: string): { count: number; earliest: string | null } {
  return lateCount(rows, today);
}
