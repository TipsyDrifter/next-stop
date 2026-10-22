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
  TimeBlockSlim,
  TimeCategoryRow,
  TimeGoalRow,
  CoverSummary,
  LongRunChoice,
  DayBlockSegment,
  MergePreview,
  BlockLink,
} from "../domain/timetable";
import type { GoalInput } from "../domain/timetableStats";
import type { PaintUndo } from "../domain/timetableGrid";
import { MOCK_MODE, WIPED_MODE, nodeRepo, settingsRepo } from "./index";
import { SqliteTimetableRepository } from "./sqliteTimetableRepository";
import { MemoryTimetableRepository } from "./memoryTimetableRepository";
import { tagRepo } from "./tagRepo"; // ⑥：塊的手動荷札搬家、目標的荷札（注入，repository 本身不 import 單例）

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
  /** ②：新一班的連結；不給＝沒連 */
  link?: BlockLink | null;
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
  /** ③ 效能（沙盒回報 F1②）：語義同 `listBlocks`（未刪除、overlap 條件、started_at 遞增），只取統計要的 8 欄
   *  （id、category_id、started_at、ended_at、estimate_min、node_id、route_id、long_run_ack）。plugin-sql 的成本在 IPC 傳列數×欄數 */
  listBlocksSlim(fromIso: string, toIso: string): Promise<TimeBlockSlim[]>;
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
  /** 補記一塊（必須 start < end ≤ 現在）。②：opts.link＝新一塊的連結。
   *  磨光⑤ 收尾：opts.ack＝使用者按了「確定記這麼長」⇒ 新塊 long_run_ack＝1（不給＝0，照舊） */
  fill(
    categoryId: string,
    startIso: string,
    endIso: string,
    opts?: { link?: BlockLink | null; ack?: boolean },
  ): Promise<{ block: TimeBlockRow; summary: CoverSummary }>;
  /** 改一塊已結束的塊的分類與起訖（蓋到的照補記規則處理）；運行中的塊丟 RangeError。②：input.link 不給＝不動連結。
   *  磨光⑤ 收尾：input.ack＝按了「確定記這麼長」⇒ long_run_ack＝1（不給＝照舊：換分類歸 0、其餘不動） */
  editBlock(
    id: string,
    input: { categoryId: string; startIso: string; endIso: string; link?: BlockLink | null; ack?: boolean },
  ): Promise<CoverSummary>;
  /** 磨光⑦（planEditRunning）：改運行中那一班的分類、出發時間、連結（link 不給＝不動）；已到站 ⇒ RangeError */
  editRunning(id: string, input: { categoryId: string; startIso: string; link?: BlockLink | null }): Promise<CoverSummary>;
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

  /* ── ②（② 契約 §3.3、§3.4；只加不改） ── */
  /** 改一塊的連結（運行中、已結束都可以）；null＝取消連結。找不到或已刪除 ⇒ RangeError「找不到這一塊」；
   *  link 指的節點不是 LINKABLE_KINDS ⇒ RangeError「只能連到車票、列車或車廂」 */
  setLink(id: string, link: BlockLink | null): Promise<void>;
  /** ② 契約 0-4：先節點、再路線；回能用的分類 id 與它是從哪一段來的；都沒有＝null。
   *  nodeId null＝只連路線（「連到…」選了只連路線）⇒ 跳過節點段、只查路線段 */
  lastCategoryFor(nodeId: string | null, routeId: string | null): Promise<{ categoryId: string; from: "node" | "route" } | null>;
  /** 未刪除、node_id 在清單裡的塊（清單每 400 個一批查；空清單回 []），started_at 遞增 */
  listBlocksByNodes(nodeIds: readonly string[]): Promise<TimeBlockRow[]>;
  /** 未刪除、屬於這條路線的塊（② 契約 0-5：經節點推導＋只連這條路線），started_at 遞增 */
  listBlocksByRoute(routeId: string): Promise<TimeBlockRow[]>;

  /* ── ③（③ 契約 §3.2；只加不改） ── */
  /**
   * 取一塊（`syncRowLabel` 用）。預設不含已刪除；`{ withDeleted: true }` ⇒ 已刪除的也回（真的沒有這個 id 才回 null）。
   * 統計用的長區間讀取走 `listBlocksSlim`（只取 8 欄；沙盒回報 F1②）。
   */
  getBlock(id: string, opts?: { withDeleted?: boolean }): Promise<TimeBlockRow | null>;
  /** 時數目標：未刪除（含封存），position 遞增、同 position 以 created_at。讀不懂的列（新版寫的）照樣回，由 `parseGoal` 擋 */
  listGoals(): Promise<TimeGoalRow[]>;
  /** 取一個目標；預設不含已刪除，`withDeleted` 同 `getBlock` */
  getGoal(id: string, opts?: { withDeleted?: boolean }): Promise<TimeGoalRow | null>;
  /** 驗證規則在 `normalizeGoalInput`（不合法 ⇒ RangeError）；position＝最大值 +1 */
  createGoal(input: GoalInput): Promise<TimeGoalRow>;
  /** 只送真的變了的欄（逐欄 LWW）；目標不存在 ⇒ RangeError「找不到這個目標」；新版寫的（parseGoal 不認得）⇒ RangeError */
  updateGoal(id: string, patch: Partial<GoalInput>): Promise<void>;
  /** true＝封存（archived_at = now）、false＝叫回（null）；狀態沒變不送 op */
  archiveGoal(id: string, on: boolean): Promise<void>;
  /** 軟刪除（deleted_at） */
  deleteGoal(id: string): Promise<void>;
  /** 復原軟刪除（撤回用） */
  restoreGoal(id: string): Promise<void>;

  /* ── ⑤（⑤ 契約 0-5、§3.2；只加不改） ── */
  /**
   * ⑤：方眼塗色。mode "fill"＝planFill（新塊 long_run_ack＝1，〈原型定案〉5）；"live"＝planPaintLive（換車＝planDepart(at=start)；
   * 同分類而且選區頭早於它＝planRestart；同分類而且不早於它＝什麼都不寫：回運行中那班、summary 全 0、undo 兩個清單都空）。
   * 回撤回用的快照（PaintUndo：寫完讀回、`updated_at` 真的變了的列才記）。
   */
  paint(
    categoryId: string,
    startIso: string,
    endIso: string,
    mode: "fill" | "live",
  ): Promise<{ block: TimeBlockRow; summary: CoverSummary; undo: PaintUndo }>;
  /** ⑤：撤回一次塗色。任何一列的現況 `updated_at` 跟塗完時不同（另一台改過、整理動過）⇒ 一列都不動、回 false */
  undoPaint(undo: PaintUndo): Promise<boolean>;

  /* ── ⑥（⑥ 契約 0-8、0-11、§3.2；只加不改） ── */
  /**
   * 上次呼叫以來，這個 repository 有沒有寫過荷札的 taggings（塊的手動荷札跟著 `fromId`／合併搬、目標的荷札、`&tt=stats` 的示範荷札），
   * 呼叫＝讀完歸零。store 的 `write()`／`reload()` 寫完叫它，回 true 而且 `tagStore.index` 已載 ⇒ `loadIndex()`（0-8 必改段）。
   * 兩支寫入同時跑時可能把別支的也一起回報（只是多重載一次 index）。
   */
  consumeTagWrites(): boolean;
  /*
   * 目標的荷札（0-4、0-11）：`createGoal`／`updateGoal` 收 `GoalInput.tagNames`——先寫目標列、再
   * `tagRepo.setTags('timetable:goal', id, tagNames)`（兩個交易；`tagNames` 沒給＝不動荷札）。scope：有荷札或原本就是 v2 ⇒ v2（v2 有黏性）。
   * 名稱不合法 ⇒ RangeError（旅客筆記的訊息），目標列不寫。
   */
}

export const timetableRepo: TimetableRepository = MOCK_MODE
  ? new MemoryTimetableRepository({ seedDemo: !WIPED_MODE, nodeRepo, settingsRepo, tagRepo })
  : new SqliteTimetableRepository({ tagRepo });
