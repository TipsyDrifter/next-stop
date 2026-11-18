/**
 * 時刻表線・時間軸與台帳明細的純函式篩選與排序模型（v1.32 2B-2）。
 *
 * 鐵則：零 UI／Store／Tauri 執行期相依，相對引用一律帶 `.ts` 副檔名，供 `node --test` 直接載入。
 *
 * 支援篩選維度（跨維度 AND 交集）：
 *   1. `categoryIds`：分類（選頂層分組自動涵蓋其下所有子分類；可複選聯集）
 *   2. `routeId`：路線或支線（`null` 全部、`"none"` 未掛路線、路線 id、或支線節點 id 含底下子孫）
 *   3. `tagKeys`：`#荷札` 組合篩選（AND 交集；比對時間塊自身與分類帶入且未被單塊排除的荷札，父荷札含子荷札）
 *   4. `query`：關鍵字（比對分類／分組名、連結任務／所屬路線名、時間塊備註、荷札名）
 *
 * 支援排序模式：
 *   - `timeAsc`（預設：營業日時間 早→晚；未啟用任何篩選時維持帶 `gap` 空檔的完整時間軸）
 *   - `timeDesc`（時間 新→舊 台帳明細）
 *   - `durDesc`（時長 長→短 台帳明細）
 *   - `durAsc`（時長 短→長 台帳明細）
 */
import { segmentsOfDay, toSpan, type AxisItem, type TimeBlockRow, type TimeCategoryRow } from "./timetable.ts";
import { linkLabelOf, linkOfRow, type LinkInfo } from "./timetableLink.ts";
import { blockTags, underKey, type TimetableTagMaps } from "./timetableTags.ts";
import { keyOf } from "./tags.ts";

export type TimetableSort = "timeAsc" | "timeDesc" | "durDesc" | "durAsc";

export const TIMETABLE_SORT_OPTIONS: readonly { value: TimetableSort; label: string; shortLabel: string }[] = [
  { value: "timeAsc", label: "時間 早→晚", shortLabel: "早→晚" },
  { value: "timeDesc", label: "時間 新→舊", shortLabel: "新→舊" },
  { value: "durDesc", label: "時長 長→短", shortLabel: "長→短" },
  { value: "durAsc", label: "時長 短→長", shortLabel: "短→長" },
];

/** `routeId` 篩選「未掛路線（含未連結與無路線臨時車票）」的保留常數 */
export const NO_ROUTE_FILTER = "none";

export interface TimetableFilter {
  /** 選取的分類或頂層分組 id（空陣列＝不篩分類） */
  categoryIds: readonly string[];
  /** `null`＝全部；`"none"`＝未掛路線；其餘＝指定路線 id 或支線節點 id */
  routeId: string | null;
  /** 選取的 `#荷札` name_key（多選為 AND 組合篩選，每枚皆支援父含子） */
  tagKeys: readonly string[];
  /** 關鍵字搜尋 */
  query: string;
  /** 排序模式 */
  sort: TimetableSort;
}

export const DEFAULT_TIMETABLE_FILTER: TimetableFilter = {
  categoryIds: [],
  routeId: null,
  tagKeys: [],
  query: "",
  sort: "timeAsc",
};

export type AxisBlockItem = Extract<AxisItem, { kind: "block" }>;

export interface FilteredBlockItem {
  item: AxisBlockItem;
  row: TimeBlockRow;
  /** 夾進營業日窗 `[w.start, min(w.end, now)]` 後的毫秒時長 */
  durMs: number;
  /** 該時間塊生效的荷札 name_key 陣列（手動 ∪ 分類預設 − 單塊排除） */
  tagKeys: string[];
}

export interface TimetableFilterResult {
  /** 是否進入台帳明細模式（任一篩選條件啟用，或排序非 `timeAsc`） */
  active: boolean;
  /** 是否有任一篩選條件啟用（不含單純切換排序） */
  hasCriteria: boolean;
  /** 原始營業日時間軸項目（含 `gap` 空檔，供預設時間軸直接渲染） */
  axisItems: AxisItem[];
  /** 符合篩選並依 `sort` 排好的時間塊明細 */
  blocks: FilteredBlockItem[];
  /** 符合條件的時間塊數 */
  count: number;
  /** 符合條件的時間塊於當日窗內的合計毫秒數 */
  totalMs: number;
}

/** 是否有任一篩選條件（不含排序） */
export function hasTimetableFilterCriteria(f: TimetableFilter): boolean {
  return (
    f.categoryIds.length > 0 ||
    f.routeId !== null ||
    f.tagKeys.length > 0 ||
    f.query.trim().length > 0
  );
}

/** 是否啟用篩選或非預設排序（為 `false` 時維持既有含 `gap` 的完整時間軸） */
export function isTimetableFilterActive(f: TimetableFilter): boolean {
  return hasTimetableFilterCriteria(f) || f.sort !== "timeAsc";
}

/**
 * 展開分類篩選集合：選中頂層分組（`parent_id === null`）時，自動納入其下所有子分類 id；
 * 單選子分類則只納該子分類。
 */
export function expandCategoryFilterIds(
  selectedIds: readonly string[],
  categories: readonly TimeCategoryRow[],
): Set<string> {
  const out = new Set<string>();
  if (selectedIds.length === 0) return out;
  const childrenByGroup = new Map<string, string[]>();
  for (const c of categories) {
    if (c.deleted_at !== null) continue;
    if (c.parent_id !== null) {
      let arr = childrenByGroup.get(c.parent_id);
      if (!arr) {
        arr = [];
        childrenByGroup.set(c.parent_id, arr);
      }
      arr.push(c.id);
    }
  }
  for (const id of selectedIds) {
    out.add(id);
    const kids = childrenByGroup.get(id);
    if (kids) {
      for (const k of kids) out.add(k);
    }
  }
  return out;
}

/** 時間塊所屬的有效路線 id（連節點看 `links[nodeId].routeId`；只連路線看 `route_id`；都無或無路線臨時車票回 `null`） */
export function effectiveBlockRouteId(
  row: Pick<TimeBlockRow, "node_id" | "route_id">,
  links: Readonly<Record<string, LinkInfo>>,
): string | null {
  const l = linkOfRow(row);
  if (l.nodeId !== null) return links[l.nodeId]?.routeId ?? null;
  return l.routeId;
}

/**
 * 比對時間塊是否符合路線／支線篩選：
 *   - `null`：全部通過
 *   - `"none"`：未掛路線（未連結，或連到無路線的臨時車票）
 *   - 支線 id（存在於 `branchNodeIds[routeId]` 或 `links[routeId]?.kind === "branch"`）：
 *     時間塊直接連到該支線，或連到該支線底下的子孫任務節點
 *   - 路線 id：時間塊的有效路線 id 等於該路線 id
 */
export function matchBlockRoute(
  row: Pick<TimeBlockRow, "node_id" | "route_id">,
  routeId: string | null,
  links: Readonly<Record<string, LinkInfo>>,
  branchNodeIds?: Readonly<Record<string, readonly string[]>>,
): boolean {
  if (routeId === null) return true;
  if (routeId === NO_ROUTE_FILTER) {
    return effectiveBlockRouteId(row, links) === null;
  }
  const branchMembers = branchNodeIds?.[routeId];
  const isBranch = branchMembers !== undefined || links[routeId]?.kind === "branch";
  if (isBranch) {
    const l = linkOfRow(row);
    if (l.nodeId === null) return false;
    if (l.nodeId === routeId) return true;
    return branchMembers ? branchMembers.includes(l.nodeId) : false;
  }
  return effectiveBlockRouteId(row, links) === routeId;
}

/**
 * 比對時間塊生效荷札是否滿足 `filterTagKeys` 組合篩選（AND 交集；每枚篩選鍵支援 `underKey` 父含子）。
 */
export function matchBlockTags(
  effectiveTagKeys: readonly string[],
  filterTagKeys: readonly string[],
): boolean {
  if (filterTagKeys.length === 0) return true;
  for (const raw of filterTagKeys) {
    const fk = keyOf(raw) ?? raw.trim().toLowerCase();
    if (!fk) continue;
    if (!effectiveTagKeys.some((bk) => underKey(bk, fk))) return false;
  }
  return true;
}

/**
 * 比對關鍵字：分類名、頂層分組名、連結任務名、所屬路線名、時間塊備註、荷札顯示名與 key。
 */
export function matchBlockQuery(
  row: TimeBlockRow,
  query: string,
  ctx: {
    catById: Readonly<Record<string, TimeCategoryRow | undefined>>;
    links: Readonly<Record<string, LinkInfo>>;
    effectiveTagKeys: readonly string[];
    tagNames?: Readonly<Record<string, string>>;
    routeNames?: Readonly<Record<string, string>>;
  },
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const cat = ctx.catById[row.category_id];
  if (cat?.name && cat.name.toLowerCase().includes(q)) return true;
  const group = cat?.parent_id ? ctx.catById[cat.parent_id] : undefined;
  if (group?.name && group.name.toLowerCase().includes(q)) return true;

  if (row.note && row.note.toLowerCase().includes(q)) return true;

  const l = linkOfRow(row);
  if (l.nodeId !== null) {
    const info = ctx.links[l.nodeId];
    if (info && !info.missing && info.name.toLowerCase().includes(q)) return true;
  } else if (l.routeId !== null) {
    const rName = ctx.routeNames?.[l.routeId] ?? ctx.links[l.routeId]?.name;
    if (rName && rName.toLowerCase().includes(q)) return true;
  }
  const label = linkLabelOf(row, ctx.links);
  if (label && label.toLowerCase().includes(q)) return true;

  const effRouteId = effectiveBlockRouteId(row, ctx.links);
  if (effRouteId !== null) {
    const routeName = ctx.routeNames?.[effRouteId] ?? ctx.links[effRouteId]?.name;
    if (routeName && routeName.toLowerCase().includes(q)) return true;
  }

  const qTag = q.startsWith("#") ? q.slice(1).trim() : q;
  if (qTag) {
    for (const k of ctx.effectiveTagKeys) {
      if (k.toLowerCase().includes(qTag)) return true;
      const disp = ctx.tagNames?.[k];
      if (disp && disp.toLowerCase().includes(qTag)) return true;
    }
  }
  return false;
}

function cmpIdAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 依指定模式排序篩選後的時間塊明細（回傳新陣列，不改輸入） */
export function sortFilteredBlocks(
  blocks: readonly FilteredBlockItem[],
  sort: TimetableSort,
): FilteredBlockItem[] {
  const copy = blocks.slice();
  switch (sort) {
    case "timeAsc":
      copy.sort((a, b) => a.item.from - b.item.from || a.item.to - b.item.to || cmpIdAsc(a.row.id, b.row.id));
      return copy;
    case "timeDesc":
      copy.sort((a, b) => b.item.from - a.item.from || b.item.to - a.item.to || cmpIdAsc(b.row.id, a.row.id));
      return copy;
    case "durDesc":
      copy.sort((a, b) => b.durMs - a.durMs || b.item.from - a.item.from || cmpIdAsc(a.row.id, b.row.id));
      return copy;
    case "durAsc":
      copy.sort((a, b) => a.durMs - b.durMs || a.item.from - b.item.from || cmpIdAsc(a.row.id, b.row.id));
      return copy;
  }
}

export interface FilterTimetableDayInput {
  dayBlocks: readonly TimeBlockRow[];
  window: { start: number; end: number };
  now: number;
  filter: TimetableFilter;
  categories: readonly TimeCategoryRow[];
  links: Readonly<Record<string, LinkInfo>>;
  tagMaps: TimetableTagMaps;
  tagNames?: Readonly<Record<string, string>>;
  routeNames?: Readonly<Record<string, string>>;
  branchNodeIds?: Readonly<Record<string, readonly string[]>>;
}

/**
 * 單一入口：計算營業日完整時間軸 `axisItems`，並在啟用篩選／排序時產出 `blocks` 明細與合計。
 */
export function filterTimetableDay(input: FilterTimetableDayInput): TimetableFilterResult {
  const { dayBlocks, window: w, now, filter, categories, links, tagMaps, tagNames, routeNames, branchNodeIds } = input;
  const spans = dayBlocks.map(toSpan);
  const axisItems = segmentsOfDay(spans, w, now);
  const hasCriteria = hasTimetableFilterCriteria(filter);
  const active = hasCriteria || filter.sort !== "timeAsc";

  const rowsById: Record<string, TimeBlockRow | undefined> = {};
  for (const r of dayBlocks) rowsById[r.id] = r;

  const catById: Record<string, TimeCategoryRow | undefined> = {};
  for (const c of categories) catById[c.id] = c;

  const allowedCats = expandCategoryFilterIds(filter.categoryIds, categories);

  const matched: FilteredBlockItem[] = [];
  let totalMs = 0;

  for (const it of axisItems) {
    if (it.kind !== "block") continue;
    const row = rowsById[it.span.id];
    if (!row) continue;

    if (allowedCats.size > 0 && !allowedCats.has(row.category_id)) continue;
    if (!matchBlockRoute(row, filter.routeId, links, branchNodeIds)) continue;

    const effTags = blockTags({ id: row.id, categoryId: row.category_id }, categories, tagMaps);
    if (!matchBlockTags(effTags, filter.tagKeys)) continue;

    if (
      !matchBlockQuery(row, filter.query, {
        catById,
        links,
        effectiveTagKeys: effTags,
        tagNames,
        routeNames,
      })
    ) {
      continue;
    }

    const durMs = Math.max(0, it.to - it.from);
    matched.push({ item: it, row, durMs, tagKeys: effTags });
    totalMs += durMs;
  }

  const blocks = sortFilteredBlocks(matched, filter.sort);
  return {
    active,
    hasCriteria,
    axisItems,
    blocks,
    count: blocks.length,
    totalMs,
  };
}
