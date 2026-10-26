/**
 * NodeRepository——資料存取的「車站櫃台」介面（可攜性保險）。
 * 業務邏輯與 UI 只跟這個介面說話；今天後面是 SQLite（tauri-plugin-sql），
 * 將來手機端換儲存、或接同步服務，只換實作不動上層。
 */
import type { NodeKind, NodeRow, Occurrence, OccurrenceSeed, OccurrenceStatus, RepeatRule, WorkLog } from "../domain";
import { currentDue, firstFixedDate, lastFixedDate, parseRule, projectAfter, projectFixed } from "../domain";
import { clockInstant, compareClock, dayWindow, isInDay } from "../lib/date";
// 時刻規則住 domain/scheduledTime.ts（結構型別、不 import data/），讓 compareTodayRows／sortByDateThenNode 的時刻鍵能在 node --test 裡測；
// UI 取這些值一律經 data/index.ts 的明列 export，不直接 import 本檔的值（主線②契約 §0-1 第 10 條）
import {
  effectiveTime,
  overridesFromRows,
  serializeTimeOverrides,
  timeOfRow,
  type TimeOverrideRow,
} from "../domain/scheduledTime";
import type { FullSearchHit } from "../domain/fullSearch";

export interface CreateNodeInput {
  kind: NodeKind;
  name: string;
  /** 父節點；幹線與臨時車票為 null */
  parentId: string | null;
  /** 插在這個兄弟之後；省略＝放最後 */
  afterId?: string | null;
  /** 臨時車票的路線標籤（統計／查找用） */
  routeTagId?: string | null;
  color?: string | null;
  code?: string | null;
  description?: string | null;
  scheduledOn?: string | null;
}

export type NodePatch = Partial<
  Pick<
    NodeRow,
    | "name"
    | "description"
    | "color"
    | "code"
    | "status"
    | "scheduled_on"
    | "due_on"
    | "priority"
    | "estimate_min"
    | "progress"
    | "time_spent_min"
    | "mood"
    | "repeat_rule"
    | "expected_on"
    | "arrived_on"
    /**
     * 預定時刻（主線②；營業日表記 'HH:MM'，null＝清除）。單發票＝這張票的時刻、定期券＝每班時刻。
     * 寫入驗格式＋範圍（update() 的 opts.dayStartHour 必帶，見 NodeRepository.update）。
     * 注意：`time_overrides` **不在這裡**——UI 不准讀改寫那串 JSON，唯一入口是 setRunTime／clearRunTime。
     */
    | "scheduled_time"
    /** 繰越來源日；一般走 reschedule 自動寫，這裡開放給修正／清除 */
    | "carried_from"
    /**
     * 臨時車票的路線標籤（a18–a21）。只允許 parent_id IS NULL 的 ticket；
     * 寫入時 line_id 自動跟著標籤路線同步（等同 setRouteTag，兩條路同一段實作）。
     */
    | "route_id"
  >
>;

/**
 * 今日分區（決定畫面上落在哪一段；WP2 用）：
 *   late ＝執行日已過且未完成（誤點區主體，補済後仍留原位＝「結局上前、來歷退後」）
 *   due  ＝沒排執行日、但締切已到或已過（D-③-7，誤點區尾段、赭 chip、不蓋延着）
 *   today＝其餘（執行日＝今天；以及今天完成的零星票——不進誤點區）
 */
export type TodayBucket = "late" | "due" | "today";

/**
 * 定期券「這一列正在講的那一班」（M3 ④）——今日列、大綱列、側板検印區共用這個形狀。
 * 取值規則見 pickTodayOccurrence；非定期券恆 null。
 */
export interface CurrentOccurrence {
  id: string;
  status: OccurrenceStatus;
  /** 班次日 YYYY-MM-DD（誤點班次的「原定 M/D」就是它） */
  due_on: string;
}

/**
 * 今日視圖的一列。今日列不在當前路線樹裡，`serialOf`／`autoProgress` 那套算不出來，
 * 所以車廂格（直屬子項數／完成數）與票號一併由 repository 算好帶出來。
 */
export interface TodayRow extends NodeRow {
  /** 直屬子項數（存活） */
  child_total: number;
  /** 直屬子項裡已完成的數量 */
  child_done: number;
  /** 票號「MMDD-NN」＝建立日（本地）＋當日全域發券序，與大綱／側板同一枚號碼 */
  serial: string;
  bucket: TodayBucket;
  /**
   * 定期券這一班的結局（M3 ④ D-④-2）：
   *   `{status:'done'}`    ＝這班済了（済蓋在班次上，不是 nodes.status）
   *   `{status:'skipped'}` ＝這班運休
   *   null                  ＝這班還沒有結局，或這不是定期券
   * 非定期券（含退役的定期券）一律 null——那種列的完成仍然看 `status === 'done'`。
   */
  occurrence: CurrentOccurrence | null;
}

/**
 * 日曆／統計用的一格（WP5 `listSchedule`）——平面陣列，一列＝某張票在某一天的一班。
 *   kind='single' ＝單發票（scheduled_on 落在區間）；kind='repeat' ＝定期券的班次
 *   occurrence_status ＝該班次的結局（null＝還沒有結局／單發票）
 *   is_late ＝這一班的日子已過、而且沒被交代掉（統計的「漏班」＝lazy 推導，不落庫）
 *   is_done ＝這一班已済（定期券看班次結局；單發票看 `nodes.status`）——日曆每格的「3 班 2 済」
 *   is_assumed ＝「假設準時」推出來的假想班次（只有 `opts.projectAfter` 的間隔模型會有；日曆畫虛線）
 */
export interface ScheduleEntry {
  date: string;
  node_id: string;
  kind: "single" | "repeat";
  occurrence_status: OccurrenceStatus | null;
  is_late: boolean;
  /** 已済（定期券＝班次 done；單發票＝節點 done）。單發票的結局不在 occurrence_status 裡，要看這格 */
  is_done: boolean;
  /** 假想班次：間隔模型在 `projectAfter` 開啟時往後推的第二班起（第一班＝目前班次，恆 false） */
  is_assumed: boolean;
  /** 這一班的有效時刻（effectiveTime(node, date)；主線②）；null＝沒填 */
  time: string | null;
}

/**
 * 日曆一格的計數（WP5 `countByDate`；r4「每格計數含臨時車票與重複班次」）。
 *   total＝這天的班次數；done／skipped＝已交代的兩種結局；open＝還沒交代（total − done − skipped）
 *   late＝其中已經漏掉的（`is_late`）；assumed＝其中是假想班次的（畫虛線用，仍計入 total）
 */
export interface DateCount {
  date: string;
  total: number;
  done: number;
  skipped: number;
  open: number;
  late: number;
  assumed: number;
}

/**
 * 路線彙總（紀念章進度弧；③ 遺留、草案 §6-8）。
 *   stations_total／stations_arrived ＝這條路線底下的車站與其中已到站的（`arrived_on` 非空），
 *     口徑與畫面一致＝`parent_id === routeId`（TodayView 的進度弧、StationList 同一把尺）
 *   nodes_total／nodes_done ＝這條路線名下的任務（`route_id === routeId` 的 train／car／ticket，
 *     含掛路線標籤的臨時車票）與其中 `status='done'` 的。
 *     ⚠ 未退役的定期券永遠不算 done（済蓋在班次上，D-④-2）——進度弧的母數要知道這件事。
 */
export interface RouteProgress {
  stations_total: number;
  stations_arrived: number;
  nodes_total: number;
  nodes_done: number;
}

/**
 * 締切層的一格（M3 ⑤ 決策 11「有締切之日格角赭色〆」）——`due_on` 落在區間的票。
 * **含沒排執行日的票**（決策 11 補的那個洞：那種票只會在締切日浮出來），
 * 也含定期券的 `due_on`（那是系列的死線，與班次無關）。
 * 只收**未完成**的（D-⑤-5-2：赭＝時刻注意，已済的死線不再需要注意）。
 */
export interface DueEntry {
  date: string;
  node_id: string;
}

/**
 * 日曆一個區間要的全部資料（M3 ⑤ WP1）——一趟查詢、三張表：
 *   entries ＝執行日層（＝`buildSchedule`；固定排程全投、間隔模型只投目前一班，`projectAfter` 恆 false）
 *   dues    ＝締切層（口徑見 DueEntry）
 *   nodes   ＝ entries／dues 提到的節點（票名、route_id、kind、status、scheduled_on、due_on、repeat_rule…）
 *
 * 每格計數仍用 `countByDate(entries)`；浮層列的「済了沒／運休了沒」直接讀該 `ScheduleEntry`
 * （每一天各自一筆，不必查 `currentOccurrences`）；**「是不是目前班次」＝`entry.date === nodes[id].scheduled_on`**。
 */
export interface CalendarData {
  entries: ScheduleEntry[];
  dues: DueEntry[];
  nodes: Record<string, NodeRow>;
}

/**
 * 串流的邊界（主線車次① P5）：`listCalendar` 在任何區間可能吐出東西的最早／最晚一天。
 * 行程表串流補到這兩端就停、出「以前／以後」邊界行；語義＝純函式 `buildScheduleBounds`（§3.2）。
 */
export interface ScheduleBounds {
  /** null＝庫裡沒有任何會出現在行程表的東西 */
  earliest: string | null;
  /** null＝同上；openEndedRepeat 為 true 時這個值只代表「非無界部分」的最晚日 */
  latest: string | null;
  /** 有未退役（status != 'done'）、固定排程、until 為 null 的定期券 ⇒ 未來無界，串流不出「以後」邊界 */
  openEndedRepeat: boolean;
}

export interface SidebarData {
  lines: NodeRow[];
  routes: NodeRow[];
  stations: NodeRow[];
}

export interface NodeRepository {
  /** 側欄：幹線／路線／車站（依 position 排好） */
  listSidebar(): Promise<SidebarData>;
  /** 某條路線的整棵大綱（支線／列車／車廂／車票，不含車站），依 position 排好 */
  listRouteTree(routeId: string): Promise<NodeRow[]>;
  /**
   * 全站票號表（id →「MMDD-NN」）＝當日全域發券序（規則見 buildSerialMap）。
   * 大綱票根與側板票頭吃這張表；今日列的 serial 也由同一張表蓋上去（四處同一把尺）。
   */
  listSerials(): Promise<Record<string, string>>;
  getNode(id: string): Promise<NodeRow | null>;
  /** 逐班時刻覆寫列的身世（同步通知要講出「哪張票哪一班」用；查不到＝null，含已軟刪的列也給） */
  getTimeOverrideRef(id: string): Promise<{ nodeId: string; dueOn: string } | null>;
  create(input: CreateNodeInput): Promise<NodeRow>;
  /**
   * 欄位補丁。`mood` 會鏡射到定期券的「目前班次」（D-④-2），故與 setCompleted 同款帶日界線參數：
   * opts.dateKey／dayStartHour 省略＝依系統預設日界線的今天（呼叫端應一律帶 store 的設定值，
   * 否則日界線改成 0／5 的使用者在凌晨填心情會鏡到隔壁班或靜默不寫）。
   *
   * 主線②：`"scheduled_time" in patch` 且值非 null ⇒ opts.dayStartHour 必須有值（沒有 ⇒ throw TIME_FORMAT_MSG，
   * 不走 `?? 3` 預設去當範圍）且 isClockInRange(v, opts.dayStartHour)，否則 throw TIME_FORMAT_MSG；null＝清除。兩種實作同一句。
   */
  update(id: string, patch: NodePatch, opts?: { dateKey?: string; dayStartHour?: number }): Promise<void>;
  /**
   * 搬移到新父節點的第 index 位（同父＝重排；跨路線會更新子樹的 line_id／route_id）。
   * newKind：升降層時「類型跟位置走」（車廂升到路線層變列車……），省略＝不變。
   */
  move(id: string, newParentId: string | null, index: number, newKind?: NodeKind): Promise<void>;
  /** 就地改類型（如 列車⇄支線），會驗證與父／子節點的相容性 */
  setKind(id: string, kind: NodeKind): Promise<void>;
  /** soft delete 整個子樹，回傳被刪的 id（供 undo） */
  softDelete(id: string): Promise<string[]>;
  restore(ids: string[]): Promise<void>;
  /**
   * 完成／取消完成；done＋cascade＝連同未完成子項。回傳受影響 id。
   *
   * 定期券分支（M3 ④ D-④-2）：節點有規則且**未退役**（status != 'done'）時，
   * 済蓋的是「目前班次」——寫／撤一列 occurrence（due_on＝`scheduled_on`）＋一枚済事件，
   * `nodes.status` 一個字都不動，寫完立刻重跑該節點的同步（班次往前推）。
   * 反悔（done=false）＝soft delete「這一列現在顯示的那一班」（pickTodayOccurrence 同一把尺）＋撤最新一枚済。
   * cascade 時子樹裡的定期券照 D2 走**退役**（`status='done'`），不寫 occurrence。
   * opts.dateKey／dayStartHour 省略＝依日界線的今天。
   */
  setCompleted(
    id: string,
    done: boolean,
    opts?: { cascade?: boolean; dateKey?: string; dayStartHour?: number },
  ): Promise<string[]>;
  /**
   * 今日聚合（a2／a8／D-③-7／r2）——四條 OR，只收 train／car／ticket：
   *   1. 執行日＝dateKey
   *   2. 執行日 < dateKey 且未完成（誤點）
   *   3. 未完成、締切 <= dateKey、且不在 1／2（沒排執行日的死線也要浮上首頁）
   *   4. 已完成、completed_at 落在 dateKey 的日界線視窗內，**且本來就有 1／2／3 條的資格**
   *      （執行日 <= dateKey，或無執行日但締切 <= dateKey）——「昨天排的票今天補済留原位」，
   *      不是「今天完成的一切」；否則列車 cascade 蓋章會把沒排執行日的子票全部拉進今日清單。
   * 回傳已排好：late（依原執行日）→ due（依締切）→ today（today_position NULLS LAST, created_at）。
   * 副作用：today 分區裡 today_position 還是 NULL 的列，就地 lazy 指派全域 max+1（＝新聚合尾插，r7）。
   */
  listToday(dateKey: string, dayStartHour?: number): Promise<TodayRow[]>;
  /** 依給定順序把 today_position 重寫成 0..n-1（今日手動序的唯一寫入點） */
  assignTodayPositions(ids: string[]): Promise<void>;
  /**
   * 把 id 挪到今日清單（today 分區）的第 index 位。
   * 主線②（D-主-10）：index 的座標系＝**手排座標** `manualOrderIds(listToday(…))`（只算沒時刻的 today 列）；
   * 有時刻的列不在這個座標系裡。⚠ store 不經此路（直接用 assignTodayPositions），這支只給測試。
   */
  moveToday(id: string, index: number, dateKey: string, dayStartHour?: number): Promise<void>;
  /** 臨時車票掛／卸路線標籤（同步寫 line_id）；只允許 parent_id IS NULL 的 ticket */
  setRouteTag(ticketId: string, routeId: string | null): Promise<void>;
  /**
   * 改執行日的唯一入口（推遲／`T`／`Shift+T`／日期 chip／清除執行日都走這裡）：
   * - 從「今天或過去」挪到更晚的一天（含誤點票按 `T` 挪到今天）→ 寫 carried_from＝原執行日
   *   （繰越章的資料來源，M3-1：只隨手動改期長出來，過期票不自動順延）
   * - 推到未來日或清成 NULL → today_position 清回 NULL（下次進今日算新聚合、尾插）
   * todayDateKey＝呼叫端當下的日界線今天。
   */
  reschedule(id: string, nextDate: string | null, todayDateKey: string, opts?: RescheduleOpts): Promise<RescheduleResult>;
  /**
   * 名稱模糊搜尋（含臨時車票，不含幹線）。
   * 主線②（接縫 #67）：query 是字面字串、不是 LIKE 樣式——SQL 實作要 `escapeLike`（lib/sql.ts）＋ `ESCAPE '\'`（反斜線當跳脫字元），
   * 否則打 `%` 或 `_` 會列出全部；記憶體實作用 includes，本來就沒有萬用字元。
   */
  search(query: string, limit?: number): Promise<NodeRow[]>;
  /**
   * 完整搜尋（完整搜尋班 D-主-112）：名稱＋概要＋乘務記錄（只算手記、不含系統事件與已刪的記錄），**不設上限**。
   * 範圍同 `search`：含臨時車票、不含幹線與已刪除。每個節點只回一筆、帶最好的命中欄（名稱 → 概要 → 乘務記錄）
   * 與那一欄的原文（乘務記錄取最新一則命中的）；排序、篩選、摘錄在 domain/fullSearch.ts。query 是字面字串（同 `search`）。
   */
  searchFull(query: string): Promise<FullSearchHit[]>;
  /**
   * 收件匣的車票（旅客筆記 D-筆-17；車次①契約 0-7 甲案）：根層 ticket、無執行日、無路線標籤、
   * 未完成、未刪；created_at DESC。唯讀。
   */
  listInboxTickets(): Promise<NodeRow[]>;
  addWorkLog(nodeId: string, body: string): Promise<WorkLog>;
  listWorkLogs(nodeId: string): Promise<WorkLog[]>;

  // ───────────── 重複任務引擎（M3 ④）─────────────

  /**
   * 掛／改／清除重複規則——寫 `repeat_rule` 的**唯一入口**（M3-5a／D-④-6）。
   * 驗：kind ∈ {train,car,ticket}、沒有存活子節點、規則 JSON 合法。
   * 掛規則時起算日由呼叫端放進 `rule.start`（＝原執行日，無則今天）；寫回後立刻對這個節點跑同步，
   * `scheduled_on` 從此＝「目前班次日」。清規則（rule=null）＝票變回乘車券，
   * `scheduled_on` 留在現值、occurrences 保留成歷史（D-④-5）。
   */
  setRepeatRule(id: string, rule: RepeatRule | null, dateKey: string, dayStartHour?: number): Promise<void>;
  /**
   * 定期券逐班時刻（主線②）：給 dueOn 這一班設時刻；time=null＝「本班無時刻」。
   * 驗：節點存活；parseRule 非 null（否則 throw TIME_REPEAT_ONLY_MSG）；dueOn 合 YYYY-MM-DD；time 非 null 時 isClockInRange。
   * 寫法（D-主-120）：`node_time_overrides` 的 (票, dueOn) 那一列 upsert（id＝overrideId，兩台同鍵同列）＋一筆 op；
   *       `nodes` 一個欄位都不動。**過去班次的覆寫一律保留**（那是歷史，D-主-32；不在這裡 prune）；
   *       未來的由換規則時軟刪（setRepeatRule）。
   * 不驗 dueOn 是不是規則日（對未來任何一天、或已運休的班寫都允許；那天沒班就沒人讀它）。
   */
  setRunTime(id: string, dueOn: string, time: string | null, dayStartHour: number): Promise<void>;
  /** 改回每班時刻＝軟刪 [dueOn] 那一列（沒有＝什麼都不寫）。驗同上（不驗 time） */
  clearRunTime(id: string, dueOn: string): Promise<void>;
  /**
   * lazy 同步（D-④-7）：對所有存活、未退役、有規則的節點重算目前班次日，
   * 變了才寫回 `scheduled_on`；回傳這一輪真的變動的 id。同一個 dateKey 跑兩次結果相同（冪等）。
   * **呼叫點＝`nodeStore.refresh()`／`loadToday()` 的開頭**（要在 Promise.all 之前跑完，
   * 否則大綱 chip 會顯示上一班直到下次 refresh）。
   *
   * 註：不清 `today_position`（偏離草案 §4 一處，理由見實作註解）。
   */
  syncRepeats(dateKey: string, dayStartHour?: number): Promise<string[]>;
  /**
   * 運休／取消運休（氛5：跳過班次，不是第四種 status）。
   * skip=true → 目前班次寫一列 `status='skipped'` 的 occurrence（不寫済事件、不動 `nodes.status`），
   * 重跑同步＝下一班從今天起算（固定＝下一個規則日；間隔＝今天＋N，D-④-3）。
   * skip=false → soft delete 這一列現在顯示的那枚運休，重跑同步（票面回空欄、不留痕）。
   * 對沒有規則的節點會 throw。
   *
   * `dueOn`（M3 ⑤ D-⑤-2 修訂「提前請假」）＝指定要運休／取消運休的**那一班**：
   *   省略／null ＝現行語義（「這一列在講的那一班」＝`pickTodayOccurrence()?.due_on ?? scheduled_on`）；
   *   給定時——固定排程：必須是規則日、且 >= 目前班次日（`scheduled_on`），否則 throw
   *     `REPEAT_FUTURE_ONLY_MSG`（過去的漏班、非規則日一律擋下——歷史唯讀，D-⑤-3）；
   *   ——完成後間隔：未來班次不存在（下一班取決於何時完成），只允許 `dueOn === scheduled_on`。
   *   該班次已經有 `done` 結局 → throw `REPEAT_DONE_MSG`（一班只有一個結局，優先於上面的範圍檢查）。
   *   取消（skip=false）＝soft delete **該班次**的 skipped 列；沒有就 no-op。
   */
  skipOccurrence(
    id: string,
    skip: boolean,
    dateKey: string,
    dayStartHour?: number,
    dueOn?: string | null,
  ): Promise<void>;
  /** 某張票的班次記錄（新→舊）；from／to＝班次日的閉區間過濾。統計／Logbook 讀這裡 */
  listOccurrences(nodeId: string, from?: string, to?: string): Promise<Occurrence[]>;
  /**
   * 全站「目前班次」表（node_id → CurrentOccurrence）——大綱列／側板検印／QuickJump 判
   * 「這張定期券的目前班次済了沒」都查這張表（與今日列的 `TodayRow.occurrence` 同一把尺）。
   * 沒有結局的班次不會出現在表裡；非定期券也不會。
   */
  listCurrentOccurrences(dateKey: string, dayStartHour?: number): Promise<Record<string, CurrentOccurrence>>;
  /**
   * 日曆／統計用的班次投影（WP5，⑤ 的接口）：單發票＋定期券。
   * 定期券 fixed＝規則投影（projectFixed，不落庫）；after＝只投目前班次一班
   * （下一班取決於何時完成）——`opts.projectAfter=true` 才會**假設準時**把後續班次一併投出來，
   * 那些列標 `is_assumed`（日曆畫虛線），預設 **false**。
   * 兩種模式都會補上區間內**已經有結局的班次**（済／運休的歷史）。退役的定期券只剩歷史、不再投影。
   */
  listSchedule(
    from: string,
    to: string,
    opts?: { todayDateKey?: string; dayStartHour?: number; projectAfter?: boolean },
  ): Promise<ScheduleEntry[]>;
  /**
   * 日曆一個區間的三張表（M3 ⑤ WP1；語義＝純函式 `buildCalendar`，兩種實作只負責撈資料）。
   * 與 `listSchedule` 同一趟 SQL（`SELECT * FROM nodes WHERE alive AND kind IN (…)`），
   * 多帶締切層與節點表——`listSchedule` 保留不動（④ 的契約與 probe 不受影響）。
   */
  listCalendar(
    from: string,
    to: string,
    opts?: { todayDateKey?: string; dayStartHour?: number },
  ): Promise<CalendarData>;
  /**
   * 路線彙總（紀念章進度弧；③ 遺留）——車站到站數與任務完成數各一組，口徑見 RouteProgress。
   * 不存在／不是路線的 id 回四個 0（呼叫端不必先查存在）。
   */
  routeProgress(routeId: string): Promise<RouteProgress>;
  /**
   * 串流邊界（主線車次① P5）。唯讀；語義＝純函式 `buildScheduleBounds`，
   * 兩種實作只負責撈資料（與 `listCalendar` 同一趟 SELECT＋occurrences）。
   */
  scheduleBounds(): Promise<ScheduleBounds>;
}

// ───────────── 兩種實作共用的純函式（語義單一真相，SQLite／Memory 都吃這裡）─────────────

/**
 * 這一列落在今日的哪一段（規則見 TodayBucket）。
 *
 * effectiveDate（M3 ④）＝這一列真正在講的那一天。定期券蓋済之後 `scheduled_on` 已經被引擎推到下一班，
 * 但這一列還留在今天（済留原位 r2）——分區與「原定 M/D」要看**班次日**＝`occurrence.due_on ?? scheduled_on`。
 * 省略＝沿用 `scheduled_on`（非定期券的行為一個字都沒變）。
 */
/**
 * 磨光⑦（D-主-67；使用者 10-21：「補記過去的任務，建票當時就會立刻被判為誤點」）：改期的選項。
 * `backfill`＝這次改期是使用者在**日期欄親手選的日子**（側板執行日、大綱日期 chip）——選到今天以前就當補記。
 * 推遲、T／Shift+T、各種「復原」都不帶（復原常把誤點票放回過去的原執行日，那不是補記）。
 */
export interface RescheduleOpts {
  backfill?: boolean;
  /** 補記完成時刻用的日界線；沒給＝3 */
  dayStartHour?: number;
}
export interface RescheduleResult {
  /** true＝這次改期順便補記了（直接済在那一天） */
  backfilled: boolean;
}

/**
 * 補記的完成時刻（UTC ISO）；不算補記 ⇒ null。補記＝還沒済、不是定期券、沒有未完成的子票、執行日改到今天以前。
 * 時刻：有預定時刻 ⇒ 那天那個時刻（營業日表記，25:00＝隔天 01:00）；沒有 ⇒ 那天日界線視窗結束前一秒。
 * 一律夾在那天的日界線視窗裡（統計、日記、行程表都把它算在那天；不進今天的今日清單、不算今天的完成數）。
 */
export function backfillAtOf(
  node: Pick<NodeRow, "status" | "repeat_rule" | "scheduled_time">,
  nextDate: string | null,
  todayDateKey: string,
  dayStartHour: number,
  openChildren: number,
): string | null {
  if (nextDate === null || nextDate >= todayDateKey) return null;
  if (node.status === "done" || parseRule(node.repeat_rule) || openChildren > 0) return null;
  const w = dayWindow(nextDate, dayStartHour);
  const lo = Date.parse(w.start);
  const hi = Date.parse(w.end) - 1000;
  const t = node.scheduled_time ? clockInstant(nextDate, node.scheduled_time) : null;
  return new Date(Math.min(hi, Math.max(lo, t ?? hi))).toISOString();
}

export function todayBucketOf(
  row: Pick<NodeRow, "scheduled_on" | "due_on">,
  dateKey: string,
  effectiveDate?: string | null,
): TodayBucket {
  const on = effectiveDate === undefined ? row.scheduled_on : effectiveDate;
  if (on !== null && on < dateKey) return "late";
  if (on === null && row.due_on !== null && row.due_on <= dateKey) return "due";
  return "today";
}

/**
 * 「這一列現在正在講的那一班」（M3 ④；今日列／大綱列／側板検印／反悔的目標 都吃這個）：
 *   1. 優先取**今天的日界線視窗內寫下的**那一筆（済留原位／運休留原位；多筆取班次日最新的）
 *      ——但只認「這一列在講的那一班」，見下方「提前請假」的排除規則。
 *   2. 否則取 `due_on = scheduled_on` 那一筆（＝目前班次已經有結局，例如提前蓋章）
 *   3. 都沒有＝這班還沒有結局 → null
 * 「寫下的時刻」＝`completed_at ?? updated_at`（done 有蓋章時刻；skipped 用運休當下）。
 *
 * ⚠ 提前請假（M3 ⑤ D-⑤-2 修訂）：`skipOccurrence` 現在可以對**未來班次**寫運休。
 * 那一列也是「今天寫下的」，若照舊取班次日最大者，今天的列會從空欄／済翻成運休（與 `3c5ec07`
 * 修過的漏洞同型）。所以視窗內的候選分兩段取：
 *   1a 班次日 <= 今天 的取最新——過去／今天的結局一定是這一列在講的那一班；
 *   1b 都沒有時，才看未來班次，而且只認**已經被引擎推走**的（`due_on < scheduled_on`）＝
 *      寫下當時它就是目前班次（提前蓋済／對未來的目前班次按 U）；多筆取最早的那一班。
 *      提前請假寫的是更後面的班次（`due_on >= scheduled_on`，引擎沒被推走）→ 不算數。
 */
export function pickTodayOccurrence<T extends OccurrenceSeed>(
  occurrences: readonly T[],
  scheduledOn: string | null,
  dateKey: string,
  dayStartHour = 3,
): T | null {
  let past: T | null = null;
  let future: T | null = null;
  for (const o of occurrences) {
    if (!isInDay(o.completed_at ?? o.updated_at, dateKey, dayStartHour)) continue;
    if (o.due_on <= dateKey) {
      if (!past || o.due_on > past.due_on) past = o;
    } else if (scheduledOn !== null && o.due_on < scheduledOn) {
      if (!future || o.due_on < future.due_on) future = o;
    }
  }
  if (past) return past;
  if (future) return future;
  if (scheduledOn === null) return null;
  return occurrences.find((o) => o.due_on === scheduledOn) ?? null;
}

/**
 * 退役定期券的執行日（D-主-122，#103 ☎3 甲「最後一班」）＝最後一筆済的班次日；一班都沒済過 ⇒ null。
 *
 * 為什麼是同步資料的純函數：退役後引擎不再排班，舊做法讓 scheduled_on 凍在各台自己最後算到的值——
 * 一台先済再退役（已推到明天）、另一台一次收到兩筆（停在今天），兩台從此不同。改成只吃 occurrences 的
 * due_on／status（兩台同步後相同、與時區無關），各台 syncRepeats 自己算就自動收斂，不必進 oplog。
 */
export function retiredScheduledOn(occurrences: readonly Pick<OccurrenceSeed, "due_on" | "status">[]): string | null {
  let last: string | null = null;
  for (const o of occurrences) {
    if (o.status === "done" && (last === null || o.due_on > last)) last = o.due_on;
  }
  return last;
}

/**
 * 今日第四條「退役定期券、執行日 NULL（一班都沒済過）」那一支的資格（D-主-122；兩種實作共用）。
 *
 * 第四條的本意是「本來就在今天清單裡的票今天完成了」（否則列車一起完成時，從沒排進今天的子票會全部冒出來）。
 * 以前退役票的 scheduled_on 凍在退役前的目前班次，靠 `scheduled_on <= 今天` 判得出來；改成「最後一班」之後
 * 沒済過的退役票是 NULL，這個線索沒了——改用「依規則，今天退役那一刻它的目前班次是不是已經到了（≤ 今天）」補回來
 * （退役就發生在今天，所以用今天算＝用退役當下算）。有締切到期、或今天交代過某一班的，原本的分支就收了，不必走這裡。
 */
export function retiredWasDueToday(
  node: Pick<NodeRow, "repeat_rule">,
  occurrences: readonly OccurrenceSeed[],
  dateKey: string,
  dayStartHour: number,
): boolean {
  const rule = parseRule(node.repeat_rule);
  if (!rule) return false;
  const due = currentDue(rule, occurrences, dateKey, dayStartHour);
  return due !== null && due <= dateKey;
}

/**
 * 覆寫列的讀取守門（D-主-120）：依「目前規則」決定哪些班次日的覆寫算數。
 *
 * 換規則只軟刪得到這台看過的未來列；另一台併發設的（或「編輯勝刪除」復活的）覆寫會活下來。
 * 落在新規則**班次日**上的照舊生效（與整欄 LWW 時代的已知取捨相同）；落在**未來的非班次日**的在這裡忽略——
 * 固定排程才判得出來（完成後間隔的班次日取決於何時完成，一律放行）。
 * 今天以前的列一律放行：換規則只清 ≥ 今天的，過去的是歷史（D-主-32；舊規則的班次日不是新規則的班次日很正常）。
 * `today` 差幾小時（日界線）無妨——守門只擋「併發復活、又落在未來非班次日」這種邊角。
 */
export function overrideKeepOf(repeatRule: string | null, today: string): ((dueOn: string) => boolean) | undefined {
  const rule = parseRule(repeatRule);
  if (!rule || rule.mode !== "fixed") return undefined;
  return (d) => d < today || d < rule.start || firstFixedDate(rule, d) === d;
}

/**
 * 把覆寫列摺回 `NodeRow.time_overrides`（讀取面保形：effectiveTime／UI 照舊讀那串 JSON）。
 * 每一列都覆寫：舊欄 `nodes.time_overrides` 停止讀取——沒有列的票一律 null，不會漏出舊欄的殘值。
 * 沒有規則的票也照實摺（B1 封口要看得到殘留；effectiveTime 對沒規則的票本來就不讀）。
 * 原地改 `nodes` 並回傳同一個陣列（呼叫端剛從 DB／記憶體複製出來的列，不會污染別人）。
 */
export function attachTimeOverrides<T extends Pick<NodeRow, "id" | "repeat_rule" | "time_overrides">>(
  nodes: T[],
  rows: readonly TimeOverrideRow[],
  today: string,
): T[] {
  const byNode = new Map<string, TimeOverrideRow[]>();
  for (const r of rows) {
    if (r.deleted_at) continue;
    let list = byNode.get(r.node_id);
    if (!list) byNode.set(r.node_id, (list = []));
    list.push(r);
  }
  for (const n of nodes) {
    const list = byNode.get(n.id);
    n.time_overrides = list ? serializeTimeOverrides(overridesFromRows(list, overrideKeepOf(n.repeat_rule, today))) : null;
  }
  return nodes;
}

/** occurrence → 給 UI 的窄形狀（TodayRow.occurrence／listCurrentOccurrences 同一份） */
export function toCurrentOccurrence(o: Occurrence): CurrentOccurrence {
  return { id: o.id, status: o.status, due_on: o.due_on };
}

// ───────────── 重複任務引擎的共用常數（兩種實作＋UI toast 同一份字）─────────────

/** 能掛重複規則的身分（M3-5a：車票＋無子節點的列車／車廂；有子樹者 v1 進 backlog） */
export const REPEATABLE_KINDS: readonly NodeKind[] = ["train", "car", "ticket"];

/** 定期券被單次改期（推遲／T／日期 chip）時擋下的那句話（D-④-3） */
export const REPEAT_RESCHEDULE_MSG = "定期券的班次由規則排定——跳過本班按 U、改規則按 .";

/** 對沒有規則的節點呼叫運休時的那句話 */
export const REPEAT_ONLY_MSG = "只有定期券能運休";

/**
 * 已蓋済的班次再按運休時擋下的那句話（一班只有一個結局；「運休中不能蓋済」的反向守門）。
 * 對象是「這一列現在正在講的那一班」（pickTodayOccurrence 同一把尺），不是引擎已經推走的下一班。
 */
export const REPEAT_DONE_MSG = "本班已済——取消済章後再運休";

/**
 * 指定班次運休時，班次日不合法的那句話（M3 ⑤ D-⑤-2 修訂「提前請假」）。
 * 涵蓋三種擋下：過去的漏班（歷史唯讀）、不是規則日的日子、完成後間隔模型的未來班次（不存在）。
 */
export const REPEAT_FUTURE_ONLY_MSG = "只能對目前或未來的班次運休";

/**
 * `listSchedule` 的共用核心（兩種實作只負責把 nodes／occurrences 撈出來餵進來，語義只有這一份）。
 * 單發票＝`scheduled_on` 落在區間；定期券＝投影 ∪ 區間內已有結局的班次（退役的只剩後者）。
 * 回傳**排好的**：日期 → 建立時刻 → 同層 position → id（見 `sortByDateThenNode`；日曆三處共用）。
 */
export function buildSchedule(
  nodes: readonly NodeRow[],
  occByNode: Record<string, Occurrence[]>,
  from: string,
  to: string,
  todayDateKey: string,
  dayStartHour = 3,
  opts: { projectAfter?: boolean } = {},
): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  for (const node of nodes) {
    if (node.deleted_at !== null) continue;
    if (node.kind !== "train" && node.kind !== "car" && node.kind !== "ticket") continue;
    const rule = parseRule(node.repeat_rule);
    if (!rule) {
      const d = node.scheduled_on;
      if (d && d >= from && d <= to) {
        out.push({
          date: d,
          node_id: node.id,
          kind: "single",
          occurrence_status: null,
          is_late: d < todayDateKey && node.status !== "done",
          is_done: node.status === "done",
          is_assumed: false,
          time: effectiveTime(node, d),
        });
      }
      continue;
    }
    const occs = occByNode[node.id] ?? [];
    /** 班次日 → 是不是假想班次（真實的一律蓋掉假想的） */
    const dates = new Map<string, boolean>();
    const add = (d: string, assumed: boolean) => {
      if (!dates.has(d) || !assumed) dates.set(d, assumed);
    };
    if (node.status !== "done") {
      if (rule.mode === "fixed") {
        for (const d of projectFixed(rule, from, to)) add(d, false);
      } else {
        // 間隔模型只投「目前班次」一班——下一班取決於何時完成（草案 §6-6）
        const due = node.scheduled_on ?? currentDue(rule, occs, todayDateKey, dayStartHour);
        if (due) {
          if (due >= from && due <= to) add(due, false);
          // ⑤ 要「假設準時、虛線續投」時才往後推；第二班起標 is_assumed（第一班是真的目前班次）
          if (opts.projectAfter) {
            for (const d of projectAfter(rule, due, to)) if (d !== due && d >= from) add(d, true);
          }
        }
      }
    }
    for (const o of occs) if (o.due_on >= from && o.due_on <= to) add(o.due_on, false);
    for (const d of [...dates.keys()].sort()) {
      const o = occs.find((x) => x.due_on === d) ?? null;
      out.push({
        date: d,
        node_id: node.id,
        kind: "repeat",
        occurrence_status: o ? o.status : null,
        // 統計的漏班＝規則日已過、沒有任何結局（lazy 推導，不落庫；草案 §6-7）
        is_late: d < todayDateKey && !o,
        is_done: o?.status === "done",
        is_assumed: dates.get(d) === true,
        time: effectiveTime(node, d),
      });
    }
  }
  return sortByDateThenNode(out, nodes);
}

/**
 * 同一天內的班次／締切順序（M3 ⑤ 修正席 should 3）——**日期 → 〔主線②：時刻，有的在前〕→ 建立時刻 → 同層 position → id**。
 *
 * 原本只有 `node_id.localeCompare`＝UUID 字串序，等於亂數：格內露出的「前 2 筆」與「＋N」藏了什麼、
 * 浮層十幾列的排法，都取決於 UUID 長相（mock 每次重整還會換一套）。改用今日清單收尾比較的**同一把尺**
 * （`compareTodayRows` 末行：created_at → position → id），月格、週格、當日浮層三處共用這一份排序
 * ——它們吃的都是這個陣列。
 *
 * 尺的選擇：`created_at` ＝「先開的票先排」，與路線側欄／大綱的手感一致，且真機上穩定。
 * **済／運休沉底沒有做**（留給主人：日曆是「那天發生了什麼」的紀錄，把已交代的沉到最後會讓
 * 格內前兩筆永遠是未完成的票——要不要這樣，是一句話的事）。
 */
function sortByDateThenNode<T extends { date: string; node_id: string; time?: string | null }>(
  rows: T[],
  nodes: readonly NodeRow[],
): T[] {
  const meta: Record<string, { created_at: string; position: number }> = {};
  for (const n of nodes) meta[n.id] = { created_at: n.created_at, position: n.position };
  return rows.sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate !== 0) return byDate;
    // 主線②（D-主-10）：有時刻的在前、照時刻；dues 沒有 time ⇒ 兩邊都當 null，順序不變
    const byTime = compareClock(a.time, b.time);
    if (byTime !== 0) return byTime;
    const ma = meta[a.node_id];
    const mb = meta[b.node_id];
    if (ma && mb) {
      const byCreated = ma.created_at.localeCompare(mb.created_at);
      if (byCreated !== 0) return byCreated;
      if (ma.position !== mb.position) return ma.position - mb.position;
    }
    return a.node_id.localeCompare(b.node_id);
  });
}

/**
 * 運休要蓋在哪一班（兩種實作共用的守門＋班次日口徑，M3 ④＋⑤）。回傳要蓋 skipped 的班次日；
 * null＝這條規則算不出任何班次（呼叫端什麼都不寫）。不合法一律 throw（訊息就是上面那三個常數）。
 *
 * dueOn 省略／null＝現行語義：「這一列在講的那一班」（`pickTodayOccurrence` 同一把尺，
 *   誤點列退回 `scheduled_on`）；已済 → `REPEAT_DONE_MSG`。
 * dueOn 給定＝M3 ⑤「提前請假」：該班次已済一樣擋（優先），再驗範圍——
 *   固定排程＝必須是規則日（含 start／until 邊界）且不早於目前班次日；
 *   完成後間隔＝未來班次不存在，只有目前班次那一天能運休。
 */
export function resolveSkipDate(
  rule: RepeatRule,
  occurrences: readonly OccurrenceSeed[],
  scheduledOn: string | null,
  dateKey: string,
  dayStartHour = 3,
  dueOn?: string | null,
): string | null {
  const target = pickTodayOccurrence(occurrences, scheduledOn, dateKey, dayStartHour);
  // 班次日口徑：優先取目前這一班的 due_on——蓋済後 scheduled_on 已被引擎推到下一班，
  // 直接用它會把「明天那班」預先運休。誤點列的 target 為 null，仍退回 scheduled_on＝原定日。
  const current = target?.due_on ?? scheduledOn ?? currentDue(rule, occurrences, dateKey, dayStartHour);
  if (dueOn === undefined || dueOn === null) {
    // 一班只有一個結局：已済的班次要先撤済才能運休（「運休中不能蓋済」的反向守門）
    if (target?.status === "done") throw new Error(REPEAT_DONE_MSG);
    return current;
  }
  if (occurrences.find((o) => o.due_on === dueOn)?.status === "done") throw new Error(REPEAT_DONE_MSG);
  if (current === null) throw new Error(REPEAT_FUTURE_ONLY_MSG);
  if (rule.mode === "after") {
    if (dueOn !== current) throw new Error(REPEAT_FUTURE_ONLY_MSG);
  } else {
    if (dueOn < current) throw new Error(REPEAT_FUTURE_ONLY_MSG);
    // 是不是規則日：firstFixedDate 回「dueOn 當天或之後的第一個規則日」，相等＝dueOn 自己就是
    if (firstFixedDate(rule, dueOn) !== dueOn) throw new Error(REPEAT_FUTURE_ONLY_MSG);
  }
  return dueOn;
}

/**
 * `listCalendar` 的共用核心（M3 ⑤ WP1；兩種實作只負責把 nodes／occurrences 撈出來餵進來）。
 * 執行日層＝`buildSchedule`（`projectAfter` 恆 false，D-⑤-2「只畫真的」）；
 * 締切層＝`due_on` 落在區間、存活、任務 kind、未完成（D-⑤-5-2）；
 * 節點表＝上面兩層提到的節點（不是整個資料庫）。
 */
export function buildCalendar(
  nodes: readonly NodeRow[],
  occByNode: Record<string, Occurrence[]>,
  from: string,
  to: string,
  todayDateKey: string,
  dayStartHour = 3,
): CalendarData {
  const entries = buildSchedule(nodes, occByNode, from, to, todayDateKey, dayStartHour, { projectAfter: false });
  const byId: Record<string, NodeRow> = {};
  const dues: DueEntry[] = [];
  for (const node of nodes) {
    byId[node.id] = node;
    if (node.deleted_at !== null) continue;
    if (node.kind !== "train" && node.kind !== "car" && node.kind !== "ticket") continue;
    if (node.status === "done") continue;
    const d = node.due_on;
    if (d && d >= from && d <= to) dues.push({ date: d, node_id: node.id });
  }
  sortByDateThenNode(dues, nodes); // 締切層與執行日層同一把尺（見 sortByDateThenNode）
  const table: Record<string, NodeRow> = {};
  for (const e of entries) if (byId[e.node_id]) table[e.node_id] = byId[e.node_id];
  for (const e of dues) if (byId[e.node_id]) table[e.node_id] = byId[e.node_id];
  return { entries, dues, nodes: table };
}

/**
 * `scheduleBounds` 的共用核心（主線車次① P5；兩種實作只負責把 nodes／occurrences 撈出來餵進來）。
 * 過濾與 `buildCalendar` 同一把尺（存活、kind ∈ {train, car, ticket}）。候選日：
 *   無規則（單發票，含 legacy 自由文字）｜`scheduled_on`（任何 status）；`due_on`（只在未完成——締切層只收未完成）
 *   有規則、任何 status　　　　　　　　　｜所有存活 occurrence 的 `due_on`（班次結局＝歷史，退役也留）
 *   有規則、未退役　　　　　　　　　　　｜`due_on`（系列死線）；fixed：`firstFixedDate(rule, rule.start)`（投影從 start 起，
 *     `buildSchedule` 對過去沒結局的每一班都標 is_late，所以起點要算進來，契約 §0-1 第 7 條），
 *     `until` 非 null 另加 `lastFixedDate(rule, rule.until)`、為 null ⇒ `openEndedRepeat`；after：`scheduled_on`（只投目前一班）
 * `earliest`／`latest`＝候選日 min／max；沒有候選 ⇒ 兩個都 null。
 */
export function buildScheduleBounds(
  nodes: readonly NodeRow[],
  occByNode: Record<string, Occurrence[]>,
): ScheduleBounds {
  let earliest: string | null = null;
  let latest: string | null = null;
  let openEndedRepeat = false;
  const add = (d: string | null | undefined) => {
    if (!d) return;
    if (earliest === null || d < earliest) earliest = d;
    if (latest === null || d > latest) latest = d;
  };
  for (const node of nodes) {
    if (node.deleted_at !== null) continue;
    if (node.kind !== "train" && node.kind !== "car" && node.kind !== "ticket") continue;
    const rule = parseRule(node.repeat_rule);
    if (!rule) {
      add(node.scheduled_on);
      if (node.status !== "done") add(node.due_on);
      continue;
    }
    for (const o of occByNode[node.id] ?? []) add(o.due_on);
    if (node.status === "done") continue;
    add(node.due_on);
    if (rule.mode === "fixed") {
      add(firstFixedDate(rule, rule.start));
      if (rule.until !== null) add(lastFixedDate(rule, rule.until));
      else openEndedRepeat = true;
    } else {
      add(node.scheduled_on);
    }
  }
  return { earliest, latest, openEndedRepeat };
}

/**
 * 日曆每格計數（WP5）——把 `listSchedule` 的平面陣列摺成 date → DateCount。
 * 沒有班次的日子**不會**出現在表裡（日曆自己決定空格怎麼畫）；口徑見 DateCount。
 */
export function countByDate(entries: readonly ScheduleEntry[]): Record<string, DateCount> {
  const out: Record<string, DateCount> = {};
  for (const e of entries) {
    const c = (out[e.date] ??= {
      date: e.date,
      total: 0,
      done: 0,
      skipped: 0,
      open: 0,
      late: 0,
      assumed: 0,
    });
    c.total++;
    if (e.is_done) c.done++;
    else if (e.occurrence_status === "skipped") c.skipped++;
    else c.open++;
    if (e.is_late) c.late++;
    if (e.is_assumed) c.assumed++;
  }
  return out;
}

/** buildRouteProgress 只需要這幾格（SQLite 版只 SELECT 這幾欄，記憶體版直接餵整列） */
export type RouteProgressSeed = Pick<
  NodeRow,
  "kind" | "parent_id" | "route_id" | "status" | "arrived_on" | "deleted_at"
>;

/**
 * 路線彙總的共用核心（兩種實作只負責把候選節點撈出來：`parent_id = routeId OR route_id = routeId`）。
 * 語義見 RouteProgress；重複過濾 `deleted_at` 是保險（兩種實作都已經先濾過）。
 */
export function buildRouteProgress(routeId: string, candidates: readonly RouteProgressSeed[]): RouteProgress {
  const p: RouteProgress = { stations_total: 0, stations_arrived: 0, nodes_total: 0, nodes_done: 0 };
  for (const n of candidates) {
    if (n.deleted_at !== null) continue;
    if (n.kind === "station") {
      // 車站掛在路線底下（parent_id）——與進度弧、側板車站列表同一把尺
      if (n.parent_id !== routeId) continue;
      p.stations_total++;
      if (n.arrived_on) p.stations_arrived++;
      continue;
    }
    if (n.kind !== "train" && n.kind !== "car" && n.kind !== "ticket") continue;
    if (n.route_id !== routeId) continue;
    p.nodes_total++;
    if (n.status === "done") p.nodes_done++;
  }
  return p;
}

const BUCKET_RANK: Record<TodayBucket, number> = { late: 0, due: 1, today: 2 };

/** 今日清單排序：誤點（依原執行日）→ 締切（依締切日）→ 今天（有時刻的照時刻在前，其餘依今日序，未指派的排後面） */
export function compareTodayRows(a: TodayRow, b: TodayRow): number {
  const rank = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
  if (rank !== 0) return rank;
  if (a.bucket === "late") {
    // 誤點區依「原定日」排——定期券蓋済後 scheduled_on 已被推到下一班，要看班次日（M3 ④）
    const byDate = (a.occurrence?.due_on ?? a.scheduled_on ?? "").localeCompare(
      b.occurrence?.due_on ?? b.scheduled_on ?? "",
    );
    if (byDate !== 0) return byDate;
  } else if (a.bucket === "due") {
    const byDue = (a.due_on ?? "").localeCompare(b.due_on ?? "");
    if (byDue !== 0) return byDue;
  } else {
    // 主線②（D-主-10）：有時刻的照幾點排在前，沒時刻的接在後維持 today_position；兩個同時刻落到收尾比較
    const ta = timeOfRow(a);
    const byTime = compareClock(ta, timeOfRow(b));
    if (byTime !== 0) return byTime;
    if (ta === null) {
      const ap = a.today_position ?? Number.MAX_SAFE_INTEGER;
      const bp = b.today_position ?? Number.MAX_SAFE_INTEGER;
      if (ap !== bp) return ap - bp;
    }
  }
  // 同日／同序時的收尾比較：建立時刻→同層 position→id，讓同毫秒建立的票也有穩定順序
  return a.created_at.localeCompare(b.created_at) || a.position - b.position || a.id.localeCompare(b.id);
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** 票號「MMDD-NN」＝建立日（本地）＋當日全域發券序（1 起算）；大綱／側板／今日列共用 */
export function formatSerial(createdAt: string, serialNo: number): string {
  const d = new Date(createdAt);
  const mmdd = Number.isNaN(d.getTime()) ? "0000" : `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  return `${mmdd}-${pad2(serialNo)}`;
}

/** 算票號只需要這四格；兩種實作都餵一樣的東西進 buildSerialMap */
export type SerialSeed = Pick<NodeRow, "id" | "kind" | "created_at" | "position">;

/**
 * 會發券的 kind——畫面上真的會渲染票號的那幾種（大綱列 OutlineRow ＋ 側板票頭 NameBlock：
 * 支線／列車／車廂／車票）。幹線／路線／車站不是票、票頭也不畫 No.，故**不佔號**（M3-2 拍板）。
 * 這是唯一一份定義：記憶體版走 issuesSerial、SQLite 版走 SERIAL_KINDS_SQL，兩邊同源。
 */
export const SERIAL_KINDS: readonly NodeKind[] = ["branch", "train", "car", "ticket"];
/** 給 SQL 用的同一份清單：`WHERE kind IN (${SERIAL_KINDS_SQL})` */
export const SERIAL_KINDS_SQL: string = SERIAL_KINDS.map((k) => `'${k}'`).join(", ");
/** 這個 kind 發不發券（buildSerialMap 的入口過濾，兩種實作共用） */
export function issuesSerial(kind: NodeKind): boolean {
  return SERIAL_KINDS.includes(kind);
}

/** 發券日的分組鍵＝建立時刻的**本地**年月日（MMDD 會跨年撞號，分組要帶年份） */
function issueDayKey(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "invalid";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 全站票號表（id → 「MMDD-NN」）——M3-2 拍板「當日全域發券序」：
 * NN ＝該節點在「同一天建立的所有未刪除**會發券節點**」裡的序號（依 created_at → position → id），
 * **跨父節點、跨路線、跨發券 kind**——大綱、側板票頭、今日列吃的是同一把尺，同日不再撞號。
 * rows 餵存活全集即可（軟刪除的節點不進來就不佔號；幹線／路線／車站在這裡濾掉，也不佔號）。
 */
export function buildSerialMap(rows: SerialSeed[]): Record<string, string> {
  const byDay = new Map<string, SerialSeed[]>();
  for (const r of rows) {
    if (!issuesSerial(r.kind)) continue;
    const key = issueDayKey(r.created_at);
    const list = byDay.get(key);
    if (list) list.push(r);
    else byDay.set(key, [r]);
  }
  const out: Record<string, string> = {};
  for (const list of byDay.values()) {
    list.sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.position - b.position || a.id.localeCompare(b.id),
    );
    list.forEach((r, i) => {
      out[r.id] = formatSerial(r.created_at, i + 1);
    });
  }
  return out;
}

/** 把 id 從清單裡抽出來、插到第 index 位（拖曳／Alt+↑↓ 共用；index 會夾在範圍內） */
export function reorderIds(ids: string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  rest.splice(at, 0, id);
  return rest;
}
