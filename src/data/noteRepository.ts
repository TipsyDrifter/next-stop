/**
 * NoteRepository——旅客筆記（notes 表）的資料存取介面（車次①；契約 §3.3）。
 *
 * 實作：`sqliteNoteRepository.ts`（真機，tauri-plugin-sql 前端直連）、`memoryNoteRepository.ts`（`?mock=1`）；
 * 工廠單例在 `noteRepo.ts`。UI 不直接碰 repository——一律經 `src/store/notesStore.ts`。
 *
 * 寫入一律 soft delete、UUID、UTC ISO 時間戳，並照 `sqliteNodeRepository.ts` 的形狀累加同步 op（`tbl: "notes"`）。
 * 建車票不經這裡：一律走既有 `nodeRepo.create`／`move`（D-筆-18）。
 */
import type { NodeKind, NodeRow } from "../domain";
import type { NoteKind, NoteRow } from "../domain/notes";

/** 列表用的一列：NoteRow ＋ 由 node_id JOIN nodes 推出來的欄（不存表） */
export interface NoteListItem extends NoteRow {
  /** 掛的節點所屬路線：節點是路線＝它自己；支線／列車／車廂＝nodes.route_id；沒掛＝null */
  route_id: string | null;
  node_name: string | null;
  node_kind: NodeKind | null;
  /** node_id 有值但節點不在（被刪或還沒同步到）＝true ⇒ 畫面顯示「原節點已刪除」 */
  node_missing: boolean;
}

export interface CreateNoteInput {
  /** 車次①一律 "note" */
  kind: NoteKind;
  /** 已去尾端空白；可為空字串（新筆記草稿不經這裡，見 store） */
  body: string;
  title?: string | null;
  /** 路線／支線／列車／車廂的 id；不驗 kind（UI 的挑選器已限制） */
  nodeId?: string | null;
  inbox: boolean;
  /** 省略＝now */
  notedAt?: string;
}

/** 可改的欄；undefined＝不動，null＝清空 */
export type NotePatch = Partial<Pick<NoteRow, "title" | "body" | "noted_at" | "node_id" | "inbox">>;

export interface NotesQuery {
  /** undefined＝不篩；"none"＝沒掛節點的；字串＝該路線（含掛在其支線／列車／車廂上的） */
  routeId?: string | "none";
  /** 比對 title 與 body（LIKE，大小寫依 SQLite 預設：ASCII 不分、中文逐字）；空白＝不篩 */
  query?: string;
  /** 預設 200 */
  limit?: number;
  /** 預設 0 */
  offset?: number;
}

export interface NoteRepository {
  /** 收件匣：kind='note' AND inbox=1 AND alive；noted_at DESC, created_at DESC */
  listInbox(): Promise<NoteListItem[]>;
  /** 筆記的家：kind='note' AND inbox=0 AND alive；同上排序 */
  listNotes(q?: NotesQuery): Promise<NoteListItem[]>;
  getNote(id: string): Promise<NoteListItem | null>;
  /**
   * 收件匣的車票（D-筆-17）：kind='ticket' AND parent_id IS NULL AND scheduled_on IS NULL
   * AND route_id IS NULL AND status != 'done' AND alive；created_at DESC。
   * 唯讀查 nodes。契約 0-7 甲案放行後改為轉呼叫 nodeRepo.listInboxTickets()。
   */
  listInboxTickets(): Promise<NodeRow[]>;
  create(input: CreateNoteInput): Promise<NoteRow>;
  update(id: string, patch: NotePatch): Promise<void>;
  softDelete(id: string): Promise<void>;
  restore(ids: string[]): Promise<void>;
}
