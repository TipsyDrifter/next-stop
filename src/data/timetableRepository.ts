/**
 * 時刻表線的資料層介面（車次①a 契約 §3.4；甲席 Stage 0 介面先行）。
 *
 * 兩個實作：`SqliteTimetableRepository`（真機；前端直連 SQL，不加 Rust command）與
 * `MemoryTimetableRepository`（`?mock=1`）。兩者對本檔**只用 `import type`**，執行期不循環；
 * `./index` 不 import 本線任何檔。
 *
 * 錯誤慣例：輸入不合法一律 `throw new RangeError("<人話>")`；store 接住後 toast `e.message`。
 * 寫入慣例：每支寫入＝讀現況 → 純函式算 `WritePlan`（`src/domain/timetable.ts`）→ 一個 `WriteBatch` 落。
 * 設定（全域保險上限、視圖、通知開關）**不在 repository**：store 直接用 `settingsRepo`。
 */
import type {
  TimeBlockRow,
  TimeCategoryRow,
  CoverSummary,
  LongRunChoice,
  DayBlockSegment,
  MergePreview,
} from "../domain/timetable";
import { MOCK_MODE, WIPED_MODE } from "./index";
import { SqliteTimetableRepository } from "./sqliteTimetableRepository";
import { MemoryTimetableRepository } from "./memoryTimetableRepository";

export interface CreateCategoryInput {
  /** null＝新增頂層組 */
  parentId: string | null;
  /** trim 後非空，否則 RangeError("分類名稱不能是空的") */
  name: string;
  /** 1–8 */
  colorIdx: number;
  defaultMin: number | null;
}

/** ①a 三欄＋①b 三欄（搬組／封存／換圓牌字） */
export interface CategoryPatch {
  /** 改名：圓牌字只在「還是自動的」（＝舊名第一字或 null）時跟著換（①b①c 契約 §3.3-3） */
  name?: string;
  colorIdx?: number;
  defaultMin?: number | null;
  /** 搬到另一個頂層組（只對子分類；目標必須是未刪除的頂層組，否則 RangeError「找不到這個分組」） */
  parentId?: string;
  /** true＝封存（archived_at = now）、false＝還原（null）。只對子分類（頂層組 ⇒ RangeError「分組不能封存」） */
  archived?: boolean;
  /** 一個字（Array.from(trim).length === 1，否則 RangeError「圓牌字只能一個字」）。只對子分類 */
  glyph?: string;
}

/** 合併預演的結果（型別定義在 domain，這裡轉出） */
export type { MergePreview };

export interface DepartOptions {
  estimateMin?: number | null;
}

export interface TimetableRepository {
  /* ── 分類 ── */
  /** 未刪除（含封存）；順序：頂層組 position，再各組子分類 position；同 position 以 created_at */
  listCategories(): Promise<TimeCategoryRow[]>;
  /** 含已刪除的總列數（起手分類「表是空的才種」的判斷用） */
  countCategoriesIncludingDeleted(): Promise<number>;
  /** 表完全沒有列（含墓碑）才種 19 列＋19 筆完整 upsert op；回 true＝這次種了。內部自己再數一次（冪等） */
  ensureStarterCategories(): Promise<boolean>;
  /** glyph：子分類＝name 的第一個字元（Array.from(name)[0]）；頂層組＝null。position＝同層最大值 +1 */
  createCategory(input: CreateCategoryInput): Promise<TimeCategoryRow>;
  updateCategory(id: string, patch: CategoryPatch): Promise<void>;
  /** 同一層的新順序（position 依陣列重排 0..n-1；只對 position 真的變了的列送 op） */
  reorderCategories(parentId: string | null, orderedIds: readonly string[]): Promise<void>;

  /* ── 時間塊：讀 ── */
  /** 未刪除且 ended_at IS NULL，started_at 遞減（正常 0 或 1 筆；同步後可能暫時 2 筆） */
  listRunning(): Promise<TimeBlockRow[]>;
  /** 未刪除、與 [fromIso, toIso) 相交：started_at < toIso AND (ended_at IS NULL OR ended_at > fromIso)；started_at 遞增 */
  listBlocks(fromIso: string, toIso: string): Promise<TimeBlockRow[]>;
  /** 給旅客筆記線（接縫 §6.3-1）：某個日界線日的時間塊，已在日界線切開、運行中回到「現在」為止 */
  listDaySegments(dateKey: string, dayStartHour: number): Promise<DayBlockSegment[]>;

  /* ── 時間塊：寫（每支＝讀現況 → 純函式算 WritePlan → 一個 WriteBatch 落） ── */
  /** 發車／換車：[at, 運行中) 蓋掉既有紀錄（§4.3 planDepart）。at 晚於現在會被夾成現在。①b：opts.estimateMin＝這一班的預估 */
  depart(categoryId: string, atIso: string, opts?: DepartOptions): Promise<{ block: TimeBlockRow; summary: CoverSummary }>;
  /** 到站：所有運行中的塊結束於 at（夾在 [自己的開始, 現在]）；回被結束的列 */
  arrive(atIso?: string): Promise<TimeBlockRow[]>;
  /** 撤回到站：沒有別的運行中、也沒有開始於它結束之後的塊，才把 ended_at 改回 NULL；回成功與否 */
  undoArrive(id: string): Promise<boolean>;
  /** 改運行中那班的出發時間（往前挪會蓋掉前面的紀錄） */
  restart(id: string, atIso: string): Promise<CoverSummary>;
  /** 補記一塊（必須 start < end ≤ 現在） */
  fill(categoryId: string, startIso: string, endIso: string): Promise<{ block: TimeBlockRow; summary: CoverSummary }>;
  /** 改一塊已結束的塊的分類與起訖（蓋到的照補記規則處理）；運行中的塊丟 RangeError */
  editBlock(id: string, input: { categoryId: string; startIso: string; endIso: string }): Promise<CoverSummary>;
  /** 單點切開；at 不在 (開始, 結束或現在) 之內回 null */
  split(id: string, atIso: string, categoryId2: string): Promise<TimeBlockRow | null>;
  /** 「其實到幾點」三選一（§4.3 planResolveLongRun） */
  resolveLongRun(id: string, endIso: string, choice: LongRunChoice, categoryId2?: string): Promise<void>;
  softDelete(id: string): Promise<void>;
  /** 復原軟刪除；復原的那一塊視為最新，蓋到的照補記規則處理 */
  restore(id: string): Promise<CoverSummary>;
  /** 預演：這段時間寫下去會蓋掉幾塊（UI 先告知用；不寫入） */
  previewCover(startIso: string, endIso: string | null, exceptId: string | null): Promise<CoverSummary>;

  /* ── ①b（①b①c 契約 §3.2；只加不改） ── */
  /** 運行中那班的預估；不是運行中 ⇒ RangeError「只能改運行中那一班的預估」 */
  setEstimate(id: string, estimateMin: number | null): Promise<void>;
  /** 多切點（§4.3 planSplitMulti）；回切完之後的各段（依時間：原 id 在前） */
  splitMulti(id: string, cutsIso: readonly string[], categoryIds: readonly string[]): Promise<TimeBlockRow[]>;
  /** 合併預演；沒有可合併的鄰居回 null。boundIso＝畫面上那一側的界線（上：看的那天的起點；下：min(那天的終點, 現在)） */
  previewMerge(id: string, dir: "prev" | "next", boundIso: string): Promise<MergePreview | null>;
  /** 合併（§4.4 planMerge）；回 null＝沒得併 */
  merge(id: string, dir: "prev" | "next", boundIso: string): Promise<MergePreview | null>;
  /** 給 ①c 的通知格：最近用過的分類 id，依最後一次開始時刻遞減（started_at >= sinceIso、未刪除；最多 limit 個） */
  listRecentCategoryIds(sinceIso: string, limit: number): Promise<string[]>;

  /* ── ①c 預留（甲寫、丙用） ── */
  /** 這個 id 的列在不在（含已刪除） */
  blockExists(id: string): Promise<boolean>;
  /** 佇列発車（§4.5 planDepartPending）。回 null＝被後來的紀錄整段蓋住、沒寫 */
  departPending(categoryId: string, atIso: string, opts: { fixedId: string; untilNext: boolean }): Promise<TimeBlockRow | null>;
  /** 佇列到着（§4.5 planArriveBefore）。回被結束的列；[]＝沒有開始早於 at 的運行中 */
  arrivePending(atIso: string): Promise<TimeBlockRow[]>;

  /* ── 同步後整理 ── */
  /** 全部未刪除的塊跑一次 planReconcile；回寫了幾筆（0＝本來就乾淨） */
  reconcile(): Promise<number>;
}

export const timetableRepo: TimetableRepository = MOCK_MODE
  ? new MemoryTimetableRepository({ seedDemo: !WIPED_MODE })
  : new SqliteTimetableRepository();
