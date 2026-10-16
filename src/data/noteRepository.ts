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
import type { FootprintDay, NoteKind, NoteRow } from "../domain/notes";

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
  /** "note"＝筆記；"diary"＝日記（車次②；要帶 entryDate） */
  kind: NoteKind;
  /** 已去尾端空白；可為空字串（新筆記草稿不經這裡，見 store） */
  body: string;
  title?: string | null;
  /** 路線／支線／列車／車廂的 id；不驗 kind（UI 的挑選器已限制） */
  nodeId?: string | null;
  inbox: boolean;
  /** 省略＝now */
  notedAt?: string;
  /**
   * 車次②：kind==="diary" 時必填（YYYY-MM-DD 日界線日，呼叫端用 todayKey／dayKeyOf 算好；缺 ⇒ RangeError「日記要有日期」）；
   * kind==="note" 時忽略（筆記的 entry_date 恆 NULL）
   */
  entryDate?: string | null;
}

/** 可改的欄；undefined＝不動，null＝清空。車次②加 kind／entry_date（0-10「記成日記」就地改 kind、0-5 改日記日期） */
export type NotePatch = Partial<Pick<NoteRow, "title" | "body" | "noted_at" | "node_id" | "inbox" | "kind" | "entry_date">>;

/** 日記頁內搜尋（車次② §3.3） */
export interface DiarySearchQuery {
  /** 比對 title 與 body（LIKE，與筆記同）；空白＝回空陣列（日記沒有「全部清單」） */
  query: string;
  /** 預設 100 */
  limit?: number;
  /** 預設 0 */
  offset?: number;
}

export interface NotesQuery {
  /** undefined＝不篩；"none"＝沒掛節點的；字串＝該路線（含掛在其支線／列車／車廂上的） */
  routeId?: string | "none";
  /**
   * 車次④ P5：只列掛在這個節點與它底下的筆記（支線／列車／車廂；側板「還有 N 則 → 到旅客筆記看」點下去的篩選）。
   * 與 `routeId` 互斥（同時給時 underNode 優先）；路線的側板照舊用 `routeId`。
   * `ids`＝要比對的節點 id（呼叫端給 `[node.id, ...descendantIds]`；實作會自己補上 `id`）；`label`＝篩選列顯示的「› {label}」。
   */
  underNode?: { id: string; ids: string[]; label: string };
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

  /* ── 車次②・日記（§3.3；只加） ── */
  /** 某一天的日記：kind='diary' AND entry_date=$day AND alive；noted_at ASC, created_at ASC（0-4） */
  listDiary(day: string): Promise<NoteListItem[]>;
  /** 頁內搜尋：kind='diary' AND alive AND (title LIKE OR body LIKE)；entry_date DESC, noted_at DESC；空白＝[] */
  searchDiary(q: DiarySearchQuery): Promise<NoteListItem[]>;
  /** 區間（含兩端）內有日記的日子：{ [day]: 篇數 } */
  listDiaryMarks(from: string, to: string): Promise<Record<string, number>>;
  /** ＝Object.keys(listDiaryMarks(from, to))，升冪；給 mount 的 calendarDayMarks 一行接上 */
  listDiaryDays(from: string, to: string): Promise<string[]>;

  /* ── 車次②・當天足跡（唯讀查核心三表；0-3 甲）。dayStartHour 必填、沒有預設值 ── */
  /** 那天（日界線日）的済章與手記；`blocks` 恆 null（時間塊由 store 經 footprintBlocks 插槽補） */
  listFootprints(day: string, dayStartHour: number): Promise<FootprintDay>;
  /** 區間（含兩端）內「有足跡」的日子，升冪（頁務件月曆的空心點、手機月份條） */
  listFootprintDays(from: string, to: string, dayStartHour: number): Promise<string[]>;

  /* ── 階段④（契約 §3.1＋§0-0 P4；只加） ── */
  /**
   * 掛在這些節點上的筆記（側板筆記區）：kind='note' AND inbox=0 AND alive AND node_id IN (ids)。
   * 排序＝直接掛在 `here` 的在前，其餘 noted_at DESC, created_at DESC（P4：底下有很多較新的也不擠掉直接掛的）；
   * ids 空＝[]；limit 預設 50。收件匣的筆記不算——側板與「還有 N 則」點進去的清單（listNotes 只列 inbox=0）要對得上（評審 nice）。
   */
  listByNodes(nodeIds: readonly string[], here: string, limit?: number): Promise<NoteListItem[]>;
  /** 同上的筆數（側板「還有 N 則」、刪除確認句）；ids 空＝0 */
  countByNodes(nodeIds: readonly string[]): Promise<number>;
  /** 筆記的家的總數：kind='note' AND inbox=0 AND alive（書封「筆記 N」、手機「筆記 N」；0-16） */
  countNotes(): Promise<number>;
  /** Ctrl+P：kind 由參數挑、alive、title／body LIKE；筆記＝noted_at DESC、日記＝entry_date DESC；空字＝[]；limit 必填；收件匣的也算 */
  searchQuick(kind: NoteKind, query: string, limit: number): Promise<NoteListItem[]>;
}
