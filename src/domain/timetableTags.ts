/**
 * 時刻表線・車次⑥「荷札接軌」的純函式層（⑥ 契約 §3.1、0-1、0-2、0-9、0-10、D-時-119；甲席）。
 *
 * 鐵則：**只准 import `./timetable.ts` 與 `./tags.ts`**（牙齒：`scripts/tests/timetable-tags.test.ts` 第 9 項），
 * 相對路徑一律帶 `.ts`（`node --test` 直載）；只用可剝除語法。
 *
 * 內容：
 *   1. 四種 `entity_type`（塊的手動荷札、分類／組的預設荷札、目標綁的荷札、塊排除的預設荷札；全放旅客筆記線的 taggings，D-時-112、114）
 *   2. `tagMapsOf`：`tagStore.index.ents` 濾成時刻表的四張對照
 *   3. 推導（D-時-110／111／134）：`catDefaults`（分類自己的＋所屬組的）、`defaultsAfterOff`（扣掉這一塊排除的）、`blockTags`（手動 ∪ 推導）、`underKey`
 *   4. 統計占比卡「荷札」面的樹狀列（`tagShareRows`；D-時-119）
 *
 * 推導一律用**含封存**的分類清單（封存的分類仍有歷史塊，同 ③ 0-5）；呼叫端傳整張 `categories`，這裡不濾封存。
 */
import type { TimeCategoryRow } from "./timetable.ts";
import { isUnder, parentOf } from "./tags.ts";

/* ───────────────────────── 1. entity_type ───────────────────────── */

/** 這一塊手動加的荷札（副活動等）；`entity_id`＝`time_blocks.id` */
export const TT_TAG_BLOCK = "timetable:block";
/** 分類（或組）的預設荷札；`entity_id`＝`time_categories.id` */
export const TT_TAG_CATEGORY = "timetable:category";
/** 目標綁的荷札；`entity_id`＝`time_goals.id` */
export const TT_TAG_GOAL = "timetable:goal";
/**
 * 這一塊不算的預設荷札（磨光③ 2-1，D-時-134）；`entity_id`＝`time_blocks.id`、tag＝被排除的那個預設荷札。
 * 只扣分類／組帶的那半（手動同 key 照樣在）；逐 key、不是子樹。荷札頁不算它的用量（登記 `counts: false`）。
 */
export const TT_TAG_BLOCK_OFF = "timetable:block-off";

export type TimetableTagEntityType = typeof TT_TAG_BLOCK | typeof TT_TAG_CATEGORY | typeof TT_TAG_GOAL | typeof TT_TAG_BLOCK_OFF;

/* ───────────────────────── 2. 四張對照 ───────────────────────── */

/** tagStore.index.ents 濾成時刻表的四張對照：實體 id → keys（name_key） */
export interface TimetableTagMaps {
  block: Record<string, readonly string[]>;
  category: Record<string, readonly string[]>;
  goal: Record<string, readonly string[]>;
  /** 塊 id → 這一塊排除的預設荷札 keys（D-時-134；不在預設裡的排除讀的時候自然無效） */
  off: Record<string, readonly string[]>;
}

/** 沒有任何荷札時用的空對照（index 還沒載、mock 沒種荷札） */
export const EMPTY_TAG_MAPS: TimetableTagMaps = Object.freeze({
  block: Object.freeze({}) as Record<string, readonly string[]>,
  category: Object.freeze({}) as Record<string, readonly string[]>,
  goal: Object.freeze({}) as Record<string, readonly string[]>,
  off: Object.freeze({}) as Record<string, readonly string[]>,
});

/**
 * `tagStore.index.ents`（或任何 `{type,id,keys}` 清單）→ 四張對照。別的 type 略過；同一個實體出現兩次（不該發生）＝keys 併起來去重。
 * keys 照原順序、去重（順序不保證；畫面要排序請用 `catDefaults`／`blockTags` 的回傳）。
 */
export function tagMapsOf(ents: readonly { type: string; id: string; keys: readonly string[] }[]): TimetableTagMaps {
  const out: { block: Record<string, string[]>; category: Record<string, string[]>; goal: Record<string, string[]>; off: Record<string, string[]> } = {
    block: {},
    category: {},
    goal: {},
    off: {},
  };
  for (const e of ents) {
    const m =
      e.type === TT_TAG_BLOCK ? out.block
      : e.type === TT_TAG_CATEGORY ? out.category
      : e.type === TT_TAG_GOAL ? out.goal
      : e.type === TT_TAG_BLOCK_OFF ? out.off
      : null;
    if (!m || !e.keys.length) continue;
    const have = m[e.id];
    if (!have) {
      const arr: string[] = [];
      for (const k of e.keys) if (!arr.includes(k)) arr.push(k);
      m[e.id] = arr;
    } else {
      for (const k of e.keys) if (!have.includes(k)) have.push(k);
    }
  }
  // 沙盒 F2：index 的順序跟同步到達的順序有關，兩台會不同 ⇒ 一律升冪（目標範圍字、運行列淡字兩台才一致）
  for (const m of [out.block, out.category, out.goal, out.off]) for (const id in m) m[id].sort();
  return out;
}

/* ───────────────────────── 3. 推導 ───────────────────────── */

/** `cats` 陣列 → id 對照（同一個陣列只建一次；store 的 categories 換了才是新陣列） */
const catIndexCache = new WeakMap<readonly TimeCategoryRow[], Map<string, TimeCategoryRow>>();
function catIndexOf(cats: readonly TimeCategoryRow[]): Map<string, TimeCategoryRow> {
  let m = catIndexCache.get(cats);
  if (!m) {
    m = new Map();
    for (const c of cats) m.set(c.id, c);
    catIndexCache.set(cats, m);
  }
  return m;
}

const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 0-2：分類的預設荷札＝分類自己的 ∪ 所屬組的。回 `{ own, fromGroup }` 給畫面分兩種牌子（「來自分類「…」」／「來自組「…」」）。
 * - `own`＝`timetable:category` 這個分類的 keys（升冪）；
 * - `fromGroup`＝它的組（`parent_id`）的 keys，**扣掉 own 已經有的**（同一個 key 只畫一顆，歸分類自己），升冪；
 * - 組本身（頂層）沒有 fromGroup；分類或組在 `cats` 裡找不到 ⇒ 只算自己的。
 * 不看封存（封存的照推導）；刪除的分類由荷札 index 的存活過濾處理（它的 taggings 不會出現在 index 裡）。
 */
export function catDefaults(catId: string, cats: readonly TimeCategoryRow[], m: TimetableTagMaps): { own: string[]; fromGroup: string[] } {
  const own = (m.category[catId] ?? []).slice().sort(asc);
  const c = catIndexOf(cats).get(catId);
  const parent = c?.parent_id ?? null;
  if (parent === null || !catIndexOf(cats).has(parent)) return { own, fromGroup: [] };
  const fromGroup = (m.category[parent] ?? []).filter((k) => !own.includes(k)).sort(asc);
  return { own, fromGroup };
}

/**
 * D-時-134：這一塊**實際生效**的預設荷札＝`catDefaults` 扣掉這一塊排除的（`m.off[blockId]`）；形狀同 `catDefaults`。
 * 逐 key 扣（排除 #高效 不影響 #高效/深度）；不在預設裡的排除略過。這一塊沒排除任何東西 ⇒ 跟 `catDefaults` 一樣。
 * 運行列淡字（`runTagKeys`）改呼叫它；面板要畫「被排除的牌子」仍用 `catDefaults` 拿全部、再用 `isBlockOff` 判。
 */
export function defaultsAfterOff(blockId: string, catId: string, cats: readonly TimeCategoryRow[], m: TimetableTagMaps): { own: string[]; fromGroup: string[] } {
  const d = catDefaults(catId, cats, m);
  const off = m.off?.[blockId];
  if (!off || !off.length) return d;
  return { own: d.own.filter((k) => !off.includes(k)), fromGroup: d.fromGroup.filter((k) => !off.includes(k)) };
}

/** 這一塊有沒有排除 key 這個預設荷札（只看 key 本身，不看子孫） */
export function isBlockOff(blockId: string, key: string, m: TimetableTagMaps): boolean {
  return !!m.off?.[blockId]?.includes(key);
}

/**
 * 0-1：塊的全部 keys＝這一塊手動加的（`timetable:block`）∪ 它的分類推導出來的（`catDefaults` 的 own＋fromGroup）；去重、升冪。
 * D-時-134：推導那半先扣掉這一塊排除的（`timetable:block-off`）；手動那半不扣（同 key 也手動掛著＝照樣在）。
 * 統計（`StatsSpan.tagKeys`）、目標、面板都用它。分類沒有預設、塊沒手動 ⇒ 空陣列。
 */
export function blockTags(b: { id: string; categoryId: string }, cats: readonly TimeCategoryRow[], m: TimetableTagMaps): string[] {
  const manual = m.block[b.id];
  const own = m.category[b.categoryId];
  const c = catIndexOf(cats).get(b.categoryId);
  const parent = c?.parent_id ?? null;
  const group = parent !== null && catIndexOf(cats).has(parent) ? m.category[parent] : undefined;
  if (!manual && !own && !group) return [];
  // 舊資料／舊呼叫端造的對照可能沒有 off 這張（`?.`）
  const off = m.off?.[b.id];
  const out: string[] = [];
  if (manual) for (const k of manual) if (!out.includes(k)) out.push(k);
  for (const list of [own, group]) if (list) for (const k of list) if (!out.includes(k) && !(off && off.includes(k))) out.push(k);
  return out.sort(asc);
}

/** key 是不是落在 k 或它底下（`k` 或 `k/…`；不會把 `高鐵` 算進 `高`）——同旅客筆記的 `isUnder` */
export function underKey(key: string, k: string): boolean {
  return isUnder(key, k);
}

/**
 * 0-8：塊的手動荷札要從 `from` 抄到 `to`（切開／蓋掉／整理切出的新塊＝`{to: 新 id, from: fromId}`；合併＝`{to: 留下的, from: 被吞的}`）。
 * 整理成要寫的清單：去重（同一對只留一次）、`to === from` 略過、空 id 略過；順序照第一次出現。`carryBlockTags` 先過它再寫。
 */
export function carryPairs(pairs: readonly { to: string; from: string }[]): { to: string; from: string }[] {
  const seen = new Set<string>();
  const out: { to: string; from: string }[] = [];
  for (const p of pairs) {
    if (!p.to || !p.from || p.to === p.from) continue;
    const k = p.to + "\u0001" + p.from;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ to: p.to, from: p.from });
  }
  return out;
}

/* ───────────────────────── 4. 占比卡「荷札」面的列（D-時-119） ───────────────────────── */

/** `tagShareRows` 要的荷札資訊：`tagStore.index.byKey[key]`（`TagNode`）直接合用 */
export interface TagLookupNode {
  /** 全路徑顯示名（保留大小寫，不含 #） */
  name: string;
  /** false＝虛資料夾（只存在於路徑中段） */
  real: boolean;
}

/** 占比卡「荷札」面的一列（樹攤平；父層的 ms 含子孫、同一塊不重複算——`windowTotals.byTag` 已經算好） */
export interface TagShareRow {
  key: string;
  /** 全路徑顯示名（index 找不到＝key） */
  name: string;
  /** 末段（樹狀縮排時畫這個） */
  seg: string;
  /** 1＝頂層 */
  depth: number;
  /** 父層 key；頂層 null */
  parent: string | null;
  /** 底下有列（本期或上期有時數的子荷札）⇒ 畫 ▸ */
  hasKids: boolean;
  /** false＝虛資料夾（「虛資料夾」淡字） */
  real: boolean;
  ms: number;
  prevMs: number;
}

/**
 * 依荷札的列（D-時-119）：輸入本期與上期的 `byTag`（`windowTotals` 算的，含虛資料夾父層），
 * 輸出攤平的樹——順序同荷札頁的 `flattenTree`（同層依顯示名升冪、父在子前、全部展開；收合由畫面依 `parent` 決定）；
 * **只列本期或上期 > 0 的**。「沒掛荷札」不在這裡（`untaggedMs` 另給，畫面永遠放最後一列）。
 * `lookup(key)`＝顯示名與是不是真荷札；`(k) => tagStore.index?.byKey[k]` 直接可用。找不到 ⇒ name＝key、real＝false。
 */
export function tagShareRows(
  cur: Readonly<Record<string, number>>,
  prev: Readonly<Record<string, number>>,
  lookup: (key: string) => TagLookupNode | null | undefined,
): TagShareRow[] {
  const keys = new Set<string>();
  for (const k of Object.keys(cur)) if ((cur[k] ?? 0) > 0) keys.add(k);
  for (const k of Object.keys(prev)) if ((prev[k] ?? 0) > 0) keys.add(k);
  if (!keys.size) return [];
  // 父層一定也在（byTag 每個前綴都累加）；萬一缺（呼叫端自己湊的資料），把子孫掛到最近的在場祖先、找不到就當頂層
  const parentIn = (k: string): string | null => {
    let p = parentOf(k);
    while (p !== null && !keys.has(p)) p = parentOf(p);
    return p;
  };
  const info = new Map<string, { name: string; real: boolean }>();
  for (const k of keys) {
    const n = lookup(k);
    info.set(k, n ? { name: n.name, real: n.real } : { name: k, real: false });
  }
  const kids = new Map<string | null, string[]>();
  for (const k of keys) {
    const p = parentIn(k);
    const arr = kids.get(p);
    if (arr) arr.push(k);
    else kids.set(p, [k]);
  }
  const byName = (a: string, b: string): number => {
    const x = info.get(a)!.name;
    const y = info.get(b)!.name;
    return x < y ? -1 : x > y ? 1 : asc(a, b);
  };
  for (const arr of kids.values()) arr.sort(byName);
  const out: TagShareRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const k of kids.get(parent) ?? []) {
      const n = info.get(k)!;
      const sub = kids.get(k);
      const i = n.name.lastIndexOf("/");
      out.push({
        key: k,
        name: n.name,
        seg: i < 0 ? n.name : n.name.slice(i + 1),
        depth,
        parent,
        hasKids: !!sub && sub.length > 0,
        real: n.real,
        ms: cur[k] ?? 0,
        prevMs: prev[k] ?? 0,
      });
      if (sub) walk(k, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}
