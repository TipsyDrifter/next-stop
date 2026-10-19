/**
 * stats/stack——D-時-63「統計圖用子分類的顏色」的堆疊順序（乙席）。
 * 占比長條、趨勢直條、清單頂層列的迷你長條都用這一份：依頂層一組一組排（組序＝占比清單的順序），組內照子分類，
 * 頂層自己直接有塊（沒分到子分類）的那段排在組尾、用頂層自己的色。不用頂層的 color_idx 代表整組（起手資料三個頂層都是 1）。
 * 過濾某個頂層＝只畫它那一組；過濾某個子分類＝單色。
 */
import type { TimeCategoryRow } from "../../../domain/timetable";
import type { ShareGroup } from "../../../domain/timetableStats";
import { catColor } from "./format";

export interface Seg {
  id: string;
  ms: number;
  color: string;
}
export interface SegGroup {
  /** 頂層 id */
  id: string;
  ms: number;
  segs: Seg[];
}

/** 排序依據：占比清單的順序（本期時數）優先，沒出現的照分類 position */
export interface StackOrder {
  rank: Map<string, number>;
}

export function stackOrder(groups: readonly ShareGroup[]): StackOrder {
  const rank = new Map<string, number>();
  let i = 0;
  for (const g of groups) {
    rank.set(g.id, i++);
    for (const c of g.children) rank.set(c.id, i++);
  }
  return { rank };
}

const topOf = (id: string, catById: Record<string, TimeCategoryRow>): string => catById[id]?.parent_id ?? id;

/**
 * byCategory（分類 id → 毫秒）→ 依頂層分組的段。`filter`：頂層 id ⇒ 只留那一組；子分類 id ⇒ 只留它一段。
 */
export function stackOf(
  byCategory: Readonly<Record<string, number>>,
  order: StackOrder,
  catById: Record<string, TimeCategoryRow>,
  filter: string | null = null,
): SegGroup[] {
  const filterIsTop = filter !== null && (catById[filter]?.parent_id ?? null) === null;
  const groups = new Map<string, SegGroup>();
  for (const id of Object.keys(byCategory)) {
    const ms = byCategory[id] ?? 0;
    if (!(ms > 0)) continue;
    const top = topOf(id, catById);
    if (filter !== null && (filterIsTop ? top !== filter : id !== filter)) continue;
    let g = groups.get(top);
    if (!g) {
      g = { id: top, ms: 0, segs: [] };
      groups.set(top, g);
    }
    g.ms += ms;
    g.segs.push({ id, ms, color: catColor(catById[id]) });
  }
  const big = Number.MAX_SAFE_INTEGER;
  const pos = (id: string): number => catById[id]?.position ?? 0;
  const cmp = (a: string, b: string): number =>
    (order.rank.get(a) ?? big) - (order.rank.get(b) ?? big) || pos(a) - pos(b) || (a < b ? -1 : a > b ? 1 : 0);
  const out = Array.from(groups.values());
  for (const g of out) {
    // 頂層自己那段排組尾
    g.segs.sort((a, b) => (a.id === g.id ? 1 : 0) - (b.id === g.id ? 1 : 0) || cmp(a.id, b.id));
  }
  out.sort((a, b) => cmp(a.id, b.id));
  return out;
}

/** 占比清單的一組 → 它的段（子分類依清單順序；頂層自己直接有的時數＝組時數 − 子分類合計，排組尾） */
export function groupSegs(g: ShareGroup, catById: Record<string, TimeCategoryRow>): Seg[] {
  const segs: Seg[] = [];
  let kids = 0;
  for (const c of g.children) {
    if (c.ms > 0) segs.push({ id: c.id, ms: c.ms, color: catColor(catById[c.id]) });
    kids += Math.max(0, c.ms);
  }
  const own = g.ms - kids;
  if (own > 1000) segs.push({ id: g.id, ms: own, color: catColor(catById[g.id]) });
  return segs;
}
