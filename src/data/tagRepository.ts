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
  tagsBefore: Pick<TagRow, "id" | "name" | "deleted_at">[];
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
