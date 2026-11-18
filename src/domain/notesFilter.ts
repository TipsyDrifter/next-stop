/**
 * 旅客筆記線・「筆記」與「收件匣」的排序切換與 `#荷札` 組合篩選純函式模型（v1.32 2B-2）。
 *
 * 鐵則：
 *   - 零 UI／Store／Tauri 執行期相依；相對引用一律帶 `.ts` 副檔名，供 `node --test` 直接載入。
 *   - 不改動 `src/domain/index.ts`。
 *
 * 支援能力：
 *   1. 排序切換（`NoteSort`）：
 *      - `"updated"`（最近修改）：筆記看 `updated_at DESC, created_at DESC`；收件匣臨時車票看 `updated_at DESC`
 *      - `"created"`（建立時間）：筆記看 `noted_at DESC, created_at DESC`；收件匣臨時車票看 `created_at DESC`
 *   2. `#荷札` 組合篩選：
 *      - 多選採 AND 交集（同時掛有所有選取荷札的項目才留），每枚皆支援 `isUnder` 父荷札含子荷札
 *      - 筆記列表比對 `note`（`notes:note`）實體；收件匣同時涵蓋未整理筆記（`note`）與臨時車票（`node`／`task:ticket`）
 */
import { isUnder, keyOf, type TagEnt, type TagIndex } from "./tags.ts";

export type NoteSort = "updated" | "created";

export const NOTE_SORT_OPTIONS: readonly { value: NoteSort; label: string }[] = [
  { value: "updated", label: "最近修改" },
  { value: "created", label: "建立時間" },
];

export type InboxFilterKind = "all" | "note" | "ticket";

export interface AvailableTagOption {
  key: string;
  /** 完整顯示名（保留原大小寫，如 `讀書/日文`） */
  name: string;
  /** 末段顯示名（如 `日文`） */
  seg: string;
  /** 階層深度（0＝根層） */
  depth: number;
  /** 符合範圍內（含子孫荷札去重後）的項目數 */
  count: number;
}

/** 正規化實體種類別名：`notes:note` → `note`、`task:ticket` → `node` */
export function normalizeTagEntityType(type: string): string {
  if (type === "notes:note") return "note";
  if (type === "task:ticket") return "node";
  return type;
}

/** 正規化篩選荷札 key 陣列（去空白、轉小寫 key、去重） */
export function normalizeTagFilterKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const k = keyOf(raw) ?? raw.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 比對單一實體的荷札 `entityTagKeys` 是否滿足 `filterTagKeys` 組合篩選：
 *   - 空篩選恆為 `true`
 *   - 多枚篩選採 AND 交集；每枚皆以 `isUnder(ek, fk)` 比對（選父荷札 `#讀書` 可命中 `#讀書/日文`）
 */
export function matchEntityTags(
  entityTagKeys: readonly string[],
  filterTagKeys: readonly string[],
): boolean {
  const normalized = normalizeTagFilterKeys(filterTagKeys);
  if (normalized.length === 0) return true;
  if (entityTagKeys.length === 0) return false;
  for (const fk of normalized) {
    if (!entityTagKeys.some((ek) => isUnder(ek, fk))) return false;
  }
  return true;
}

/**
 * 從 `tagStore.index.ents` 篩出符合 `filterTagKeys` 組合條件的實體 id 集合。
 * `excludeKinds` 可排除例如 `"diary"`，避免只算筆記時混入日記。
 */
export function matchingEntityIdsByTags(
  ents: readonly TagEnt[],
  entityTypes: readonly string[],
  filterTagKeys: readonly string[],
  opts?: { excludeKinds?: readonly string[] },
): Set<string> {
  const wantedTypes = new Set(entityTypes.map(normalizeTagEntityType));
  const excludedKinds = opts?.excludeKinds ? new Set(opts.excludeKinds) : null;
  const normalized = normalizeTagFilterKeys(filterTagKeys);
  const out = new Set<string>();
  if (normalized.length === 0) return out;

  for (const e of ents) {
    if (!wantedTypes.has(normalizeTagEntityType(e.type))) continue;
    if (excludedKinds && e.kind && excludedKinds.has(e.kind)) continue;
    if (matchEntityTags(e.keys, normalized)) {
      out.add(e.id);
    }
  }
  return out;
}

/**
 * 彙整特定畫面（筆記列表或收件匣）可點選的 `#荷札` 清單與對應項目數：
 *   - 依 `index` 樹狀順序展開，父層計數自動去重納入子孫荷札的項目，方便點選父荷札篩整組
 *   - 若提供 `allowedIds`（如收件匣目前待整理的筆記＋臨時車票 id 集合），只統計該集合內的項目
 *   - 已選取的 `selectedKeys` 即便計數歸零也保留在清單中，確保使用者能隨時取消選取
 */
export function collectAvailableTags(
  index: TagIndex | null,
  opts: {
    entityTypes: readonly string[];
    allowedIds?: ReadonlySet<string>;
    excludeKinds?: readonly string[];
    selectedKeys?: readonly string[];
  },
): AvailableTagOption[] {
  const selected = normalizeTagFilterKeys(opts.selectedKeys ?? []);
  const selectedSet = new Set(selected);
  if (!index) {
    return selected.map((k) => {
      const parts = k.split("/");
      return { key: k, name: k, seg: parts[parts.length - 1] ?? k, depth: Math.max(0, parts.length - 1), count: 0 };
    });
  }

  const wantedTypes = new Set(opts.entityTypes.map(normalizeTagEntityType));
  const excludedKinds = opts.excludeKinds ? new Set(opts.excludeKinds) : null;
  const entitiesByKey = new Map<string, Set<string>>();

  const addEntKey = (key: string, entToken: string): void => {
    let set = entitiesByKey.get(key);
    if (!set) {
      set = new Set();
      entitiesByKey.set(key, set);
    }
    set.add(entToken);
  };

  for (const e of index.ents) {
    const normType = normalizeTagEntityType(e.type);
    if (!wantedTypes.has(normType)) continue;
    if (excludedKinds && e.kind && excludedKinds.has(e.kind)) continue;
    if (opts.allowedIds && !opts.allowedIds.has(e.id)) continue;

    const entToken = `${normType}:${e.id}`;
    for (const rawKey of e.keys) {
      let cur: string | null = rawKey;
      while (cur) {
        addEntKey(cur, entToken);
        const nodeParent: string | null | undefined = index.byKey[cur]?.parent;
        if (nodeParent !== undefined) {
          cur = nodeParent;
        } else {
          const slash = cur.lastIndexOf("/");
          cur = slash > 0 ? cur.slice(0, slash) : null;
        }
      }
    }
  }

  const out: AvailableTagOption[] = [];
  const emitted = new Set<string>();

  const walk = (key: string): void => {
    const node = index.byKey[key];
    if (!node) return;
    const count = entitiesByKey.get(key)?.size ?? 0;
    if (count > 0 || selectedSet.has(key)) {
      out.push({
        key: node.key,
        name: node.name,
        seg: node.seg,
        depth: node.depth,
        count,
      });
      emitted.add(node.key);
    }
    for (const childKey of node.children) {
      walk(childKey);
    }
  };

  for (const rootKey of index.roots) {
    walk(rootKey);
  }

  for (const k of selected) {
    if (emitted.has(k)) continue;
    const node = index.byKey[k];
    const parts = (node?.name ?? k).split("/");
    out.push({
      key: k,
      name: node?.name ?? k,
      seg: node?.seg ?? parts[parts.length - 1] ?? k,
      depth: node?.depth ?? Math.max(0, parts.length - 1),
      count: entitiesByKey.get(k)?.size ?? 0,
    });
  }

  return out;
}

/** 筆記列表在當前排序下對應的時間戳（供月份分組標題與列尾日期對齊排序依據） */
export function noteTimestampOf(
  note: { noted_at: string; updated_at: string },
  sort: NoteSort,
): string {
  return sort === "updated" ? note.updated_at : note.noted_at;
}

/** 筆記兩筆比較函式（與 SQLite `ORDER BY` 完全同義） */
export function compareNotesBySort(
  a: { id?: string; noted_at: string; created_at: string; updated_at: string },
  b: { id?: string; noted_at: string; created_at: string; updated_at: string },
  sort: NoteSort,
): number {
  const primary =
    sort === "updated"
      ? b.updated_at.localeCompare(a.updated_at)
      : b.noted_at.localeCompare(a.noted_at);
  if (primary !== 0) return primary;
  const secondary = b.created_at.localeCompare(a.created_at);
  if (secondary !== 0) return secondary;
  if (a.id !== undefined && b.id !== undefined) return a.id.localeCompare(b.id);
  return 0;
}

/** 依指定排序回傳新陣列（不變動原陣列） */
export function sortNoteItems<T extends { id?: string; noted_at: string; created_at: string; updated_at: string }>(
  notes: readonly T[],
  sort: NoteSort,
): T[] {
  return notes.slice().sort((a, b) => compareNotesBySort(a, b, sort));
}

export interface InboxNoteLike {
  id: string;
  noted_at: string;
  created_at: string;
  updated_at: string;
}

export interface InboxTicketLike {
  id: string;
  created_at: string;
  updated_at: string;
}

export type FilteredInboxItem<N extends InboxNoteLike, T extends InboxTicketLike> =
  | { kind: "note"; id: string; at: string; createdAt: string; note: N; tagKeys: string[] }
  | { kind: "ticket"; id: string; at: string; createdAt: string; ticket: T; tagKeys: string[] };

export interface BuildInboxItemsInput<N extends InboxNoteLike, T extends InboxTicketLike> {
  notes: readonly N[];
  tickets: readonly T[];
  kind: InboxFilterKind;
  sort: NoteSort;
  tagKeys: readonly string[];
  tagEnts: readonly TagEnt[];
}

/**
 * 收件匣合併清單（支援種類篩選 ＋ `#荷札` 組合篩選 ＋ 最近修改／建立時間排序）：
 *   - 筆記荷札讀 `note`（`notes:note`），臨時車票荷札讀 `node`（`task:ticket`）
 *   - `sort === "updated"`：筆記與臨時車票皆依 `updated_at DESC`
 *   - `sort === "created"`：筆記依 `noted_at DESC`、臨時車票依 `created_at DESC`
 */
export function buildInboxItems<N extends InboxNoteLike, T extends InboxTicketLike>(
  input: BuildInboxItemsInput<N, T>,
): FilteredInboxItem<N, T>[] {
  const { notes, tickets, kind, sort, tagKeys, tagEnts } = input;
  const normFilterKeys = normalizeTagFilterKeys(tagKeys);

  const noteTagMap = new Map<string, string[]>();
  const ticketTagMap = new Map<string, string[]>();
  for (const e of tagEnts) {
    const t = normalizeTagEntityType(e.type);
    if (t === "note") noteTagMap.set(e.id, e.keys);
    else if (t === "node") ticketTagMap.set(e.id, e.keys);
  }

  const out: FilteredInboxItem<N, T>[] = [];

  if (kind !== "ticket") {
    for (const n of notes) {
      const keys = noteTagMap.get(n.id) ?? [];
      if (!matchEntityTags(keys, normFilterKeys)) continue;
      const at = sort === "updated" ? n.updated_at : n.noted_at;
      out.push({ kind: "note", id: n.id, at, createdAt: n.created_at, note: n, tagKeys: keys });
    }
  }

  if (kind !== "note") {
    for (const t of tickets) {
      const keys = ticketTagMap.get(t.id) ?? [];
      if (!matchEntityTags(keys, normFilterKeys)) continue;
      const at = sort === "updated" ? t.updated_at : t.created_at;
      out.push({ kind: "ticket", id: t.id, at, createdAt: t.created_at, ticket: t, tagKeys: keys });
    }
  }

  out.sort(
    (a, b) =>
      b.at.localeCompare(a.at) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );

  return out;
}
