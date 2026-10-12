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

/** ①a 只開放這三欄（搬組／封存／換圓牌字在 ①b） */
export interface CategoryPatch {
  name?: string;
  colorIdx?: number;
  defaultMin?: number | null;
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
  /** 發車／換車：[at, 運行中) 蓋掉既有紀錄（§4.3 planDepart）。at 晚於現在會被夾成現在 */
  depart(categoryId: string, atIso: string): Promise<{ block: TimeBlockRow; summary: CoverSummary }>;
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

  /* ── 同步後整理 ── */
  /** 全部未刪除的塊跑一次 planReconcile；回寫了幾筆（0＝本來就乾淨） */
  reconcile(): Promise<number>;
}

export const timetableRepo: TimetableRepository = MOCK_MODE
  ? new MemoryTimetableRepository({ seedDemo: !WIPED_MODE })
  : new SqliteTimetableRepository();
