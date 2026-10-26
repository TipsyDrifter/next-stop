/**
 * 荷札 repository 介面（旅客筆記車次③契約 §3.3）——**給時刻表線與售票口線的接口，簽名寫死**。
 *
 * 別線怎麼用（契約 §3.3 末、0-12）：
 *   - 讀寫一律經這份介面，不直接寫 SQL、不自建表。
 *   - `entity_type` 用 `'<頁面id>:<自訂>'`（例 `'timetable:block'`、`'ticket:txn'`），不可用裸 `'ticket'`。
 *   - `taggings` 不隨實體的刪除／復原連動：本線只認得 `'node'`／`'note'` 的實體表（讀取一律 JOIN 實體存活）；
 *     別線的實體本線不檢查存活 ⇒ **別線刪實體時自己 `detach`**（或日後加的批次摘除），否則牌子上的數字會多算。
 *   - 寫入都回 `TagReceipt`，toast 的「復原」＝`undo(receipt)`（新的 op、新的 HLC——不是回捲）。
 *
 * 實作：`sqliteTagRepository.ts`（真機）／`memoryTagRepository.ts`（`?mock=1`）；單例在 `tagRepo.ts`。
 * 決定性 id：`tagId(key)`／`taggingId(type, entityId, tagId)`（本檔下方；兩台同名同 id 的前提，永不改算法）。
 */
import type { NoteRow } from "../domain/notes";
import type { NodeRow } from "../domain";
import type { DeletePlan, RenamePlan, TagIndexSource } from "../domain/tags";
import { TAG_ID_NAMESPACE, TAGGING_ID_NAMESPACE } from "../domain/tags.ts";
import { uuidv5 } from "../lib/uuidv5.ts";

/** 本線 'node'／'note'；別線用 '<頁面id>:<自訂>'（例 'timetable:block'），不可用裸 'ticket' */
export type TagEntityType = "node" | "note" | `${string}:${string}`;

export interface TagRow {
  id: string;
  name: string;
  name_key: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /**
   * 改名去向（同步引擎班 D-主-121，migration 0013）：改名／併入軟刪舊荷札時記新荷札的 id；NULL／沒有＝沒改過名。
   * 「存活＋有去向」＝被另一台的併發掛載「編輯勝刪除」救回來的空殼，`reconcileRenamed` 會把它收掉。
   * 選填只為了不動既有建列的地方（舊程式不帶這欄＝NULL，語義一樣）。
   */
  renamed_to?: string | null;
}
export interface TaggingRow {
  id: string;
  entity_type: TagEntityType;
  entity_id: string;
  tag_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 點父看子回來的一列（§3.4 (c)）；node／note 以外的 entity_type 回 kind:"other"，由該線自己補資料 */
export type TaggedItem =
  | {
      kind: "node";
      id: string;
      node: Pick<NodeRow, "id" | "name" | "kind" | "route_id" | "status" | "scheduled_on" | "parent_id" | "repeat_rule">;
      matched: string[];
    }
  | {
      kind: "note";
      id: string;
      note: Pick<NoteRow, "id" | "kind" | "title" | "body" | "entry_date" | "noted_at">;
      matched: string[];
    }
  | { kind: "other"; entityType: TagEntityType; id: string; matched: string[] };

export interface AttachResult {
  key: string;
  name: string;
  created: boolean;
  already: boolean;
  receipt: TagReceipt;
}
/** `create` 的結果（UI 丙-6 ☎-1）：created＝新建或復活（主人眼中它原本不在）；false＝本來就活著、什麼都沒寫 */
export interface CreateTagResult {
  key: string;
  name: string;
  created: boolean;
  receipt: TagReceipt;
}
export interface BackfillResult {
  tagCount: number;
  placeCount: number;
  createdTags: number;
}
export interface SyncBodyResult {
  added: string[];
  removed: string[];
}

/** 復原用的收據（契約 0-15）：改前的列與新建的 id；undo 整批寫回（新的 op、新的 HLC） */
export interface TagReceipt {
  createdTagIds: string[];
  createdTaggingIds: string[];
  /** `renamed_to`：改前的改名去向（D-主-121；undo 要連它一起寫回，否則復原改名後舊荷札活著又帶去向＝被整理收掉） */
  tagsBefore: (Pick<TagRow, "id" | "name" | "deleted_at"> & { renamed_to?: string | null })[];
  taggingsBefore: Pick<TaggingRow, "id" | "deleted_at">[];
  notesBefore: { id: string; body: string }[];
}

export interface TagRepository {
  /* ── 讀 ── */
  /** 樹與計數的來源：存活的 tags 全部＋存活且實體存活的 taggings（契約 0-12；別線 entity_type 不查實體） */
  loadIndexSource(): Promise<TagIndexSource>;
  /** 某實體掛的荷札（存活）；name_key 升冪 */
  listTagsOf(entityType: TagEntityType, entityId: string): Promise<TagRow[]>;
  /** 點父看子：掛著 key 或它任何子孫的實體（含子孫＝ name_key = key OR LIKE key/%）；entityType 省略＝全部 */
  listUnder(key: string, entityType?: TagEntityType): Promise<TaggedItem[]>;
  /** 手機點選器「最近用過」（裝置本地；最多 6 個 key） */
  recentKeys(): Promise<string[]>;

  /* ── 寫（每支一個交易；回收據給復原） ── */
  /** 掛：名稱不合法 ⇒ RangeError(reason)；entityType==="node" 且節點 kind 不在 ticket/train/car ⇒ RangeError("這裡掛不上荷札")；
   *  tag 不存在就建（已刪除就復活、沿用先建的 name）；已掛著 ⇒ already:true、不寫 */
  attach(entityType: TagEntityType, entityId: string, rawName: string): Promise<AttachResult>;
  /** 單純建一個荷札、不掛在任何東西上（荷札頁「＋ 新荷札」；UI 丙-6 ☎-1，只加不改）＝attach 去掉掛載那段：
   *  名稱不合法 ⇒ RangeError(reason)；不存在就建、已刪除就復活（沿用先建的 name）；已存活 ⇒ created:false、不寫、收據空 */
  create(rawName: string): Promise<CreateTagResult>;
  /** 摘：tagging soft delete；本來就沒掛 ⇒ 不寫、收據空 */
  detach(entityType: TagEntityType, entityId: string, key: string): Promise<TagReceipt>;
  /** 一次掛好幾個、摘好幾個（手機點選器「完成」；一個交易、一張收據） */
  setTags(entityType: TagEntityType, entityId: string, rawNames: readonly string[]): Promise<{ receipt: TagReceipt; created: string[] }>;
  /** 筆記／日記內文→taggings 單向推導（契約 0-13）：parseTags(body) 的 keys 與現有存活 taggings 做差，掛多的、摘少的；只對 entity_type='note' */
  syncBodyTags(noteId: string, body: string): Promise<SyncBodyResult>;
  /** 通車補掛（契約 0-9）：所有存活 notes（note＋diary）跑一次 syncBodyTags；每 50 則一個交易；回「找到幾個荷札、幾處」 */
  backfill(): Promise<BackfillResult>;
  /** 改名／搬層級／併入：plan 由 domain.planRename 算（含子孫、衝突）；一個交易：建或復活新名、搬 taggings、舊名 soft delete、改寫筆記與日記內文 */
  rename(plan: RenamePlan): Promise<TagReceipt>;
  /** 刪除（連子孫）：plan 由 domain.planDelete 算；一個交易：tags／taggings soft delete、內文 removeTagText */
  remove(plan: DeletePlan): Promise<TagReceipt>;
  /** 復原：新建的列 soft delete、改過的列寫回收據值、內文寫回；一個交易 */
  undo(receipt: TagReceipt): Promise<void>;
  /** 手機點選器用：把 key 推到最近用過的最前（裝置本地） */
  pushRecent(key: string): Promise<void>;

  /* ── 同步引擎班（D-主-121，只加） ── */
  /** 一列荷札（含已刪除）；沒有＝null。同步提示查名字與改名去向用 */
  getTagRow(id: string): Promise<TagRow | null>;
  /**
   * 拉取後整理「改名跟到底」：存活而且有 `renamed_to` 的荷札（＝改名後被另一台的併發掛載救回來的空殼），
   * 沿去向一路找到存活的終點（鏈式、最多 10 跳、繞圈就放棄），把殼上的存活掛載轉過去、殼再軟刪；
   * 掛在筆記上的連內文的 `#舊名` 一起改（不改的話下次存那則筆記會把舊名掛回來）。
   * 終點已經真的被刪了 ⇒ 不轉、殼留著（維持「編輯勝刪除」的本意）。一個交易；沒有殼＝不開交易、回空陣列。
   * `beforeBodyRewrite`：真的要改內文之前叫一次（store 用來先存完正在打的字、退出編輯）。
   */
  reconcileRenamed(opts?: { beforeBodyRewrite?: () => Promise<void> }): Promise<RenameFollow[]>;
}

/** `reconcileRenamed` 的一筆：哪個殼跟到哪裡、轉了幾處 */
export interface RenameFollow {
  fromId: string;
  fromName: string;
  toId: string;
  toKey: string;
  toName: string;
  /** 轉過去的掛載數（含不算用量的，例如時刻表的單塊排除） */
  moved: number;
}

/**
 * 收據記改前值時連 `renamed_to` 一起記（共用的 `recordTagBefore` 只記 name／deleted_at）。
 * 第一次記的那筆才補——之後再呼叫找到已有 `renamed_to` 鍵的就不動，跟「只記第一次的改前值」同一條規矩。
 * 兩份實作用；`record` 傳 `tagRepoShared.recordTagBefore`（本檔不 import 它，免得型別檔反過來依賴實作工具）。
 */
export function recordTagBeforeWithRename(
  r: TagReceipt,
  t: Pick<TagRow, "id" | "name" | "deleted_at" | "renamed_to">,
  record: (r: TagReceipt, t: Pick<TagRow, "id" | "name" | "deleted_at">) => void,
): void {
  record(r, t);
  const b = r.tagsBefore.find((x) => x.id === t.id);
  if (b && !("renamed_to" in b)) b.renamed_to = t.renamed_to ?? null;
}

/** 殼→終點那一次搬移的內文改寫計畫（＝`planRename` 只有一個 move 的形狀；`renameBody` 只讀 moves／oldKey／newName） */
export function followRenamePlan(from: Pick<TagRow, "name" | "name_key">, to: Pick<TagRow, "name" | "name_key">): RenamePlan {
  return {
    ok: true,
    same: false,
    oldKey: from.name_key,
    oldName: from.name,
    newKey: to.name_key,
    newName: to.name,
    moves: [{ from: from.name_key, to: to.name_key, toName: to.name }],
    conflicts: [],
    rootConflict: null,
    affected: { ticket: 0, train: 0, car: 0, note: 0, diary: 0, other: 0, total: 0 },
    childCount: 0,
    ownCount: 0,
  };
}

/** 改名去向最多跟幾跳（A→B→C…）；超過或繞圈＝當作找不到終點 */
export const RENAME_FOLLOW_MAX_HOPS = 10;

/**
 * 沿 `renamed_to` 找終點：途經的節點不論死活，只要還有去向就繼續；停在「存活且沒有去向」＝終點，
 * 停在「已刪且沒有去向」或查不到＝終點已死（null）。兩份實作共用，語義只寫一次。
 */
export async function followRename(
  startId: string,
  get: (id: string) => Promise<Pick<TagRow, "id" | "deleted_at" | "renamed_to"> | null>,
): Promise<string | null> {
  const seen = new Set<string>([startId]);
  let cur = (await get(startId))?.renamed_to ?? null;
  for (let hop = 0; cur && hop < RENAME_FOLLOW_MAX_HOPS; hop++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const t = await get(cur);
    if (!t) return null;
    if (t.renamed_to) {
      cur = t.renamed_to;
      continue;
    }
    return t.deleted_at === null ? t.id : null;
  }
  return null;
}

/* ── 決定性 id（兩台同名同 id；契約 §3.1、0-18） ── */

/** `tags.id` ＝ uuid v5(TAG_ID_NAMESPACE, name_key)；`key` 必須是 `normalizeName` 的 key */
export function tagId(key: string): Promise<string> {
  return uuidv5(TAG_ID_NAMESPACE, key);
}
/** `taggings.id` ＝ uuid v5(TAGGING_ID_NAMESPACE, `${entity_type}|${entity_id}|${tag_id}`) */
export function taggingId(entityType: TagEntityType, entityId: string, tagIdValue: string): Promise<string> {
  return uuidv5(TAGGING_ID_NAMESPACE, `${entityType}|${entityId}|${tagIdValue}`);
}
/** 空收據（沒有寫入時回這個；`isEmptyReceipt` 為 true 的收據不出 toast 的「復原」） */
export function emptyReceipt(): TagReceipt {
  return { createdTagIds: [], createdTaggingIds: [], tagsBefore: [], taggingsBefore: [], notesBefore: [] };
}
export function isEmptyReceipt(r: TagReceipt): boolean {
  return !r.createdTagIds.length && !r.createdTaggingIds.length && !r.tagsBefore.length && !r.taggingsBefore.length && !r.notesBefore.length;
}
