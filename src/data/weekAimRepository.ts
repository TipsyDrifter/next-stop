/**
 * 週方針的資料層介面（戊；契約 §2、§3）＋App 共用的單例。
 *
 * 兩個實作：`SqliteWeekAimRepository`（真機；前端直連 SQL）與 `MemoryWeekAimRepository`（`?mock=1`）。
 * 錯誤慣例：輸入不合法一律 `throw new RangeError("<人話>")`；store 接住後 toast `e.message`。
 * 寫入慣例：一支寫入＝一個 WriteBatch、只送變了的欄、軟刪除；新列與還原送完整列（核心同一套）。
 * 「已排」與回顧的數字只讀既有表（nodes／occurrences／time_blocks／tk_entries），不寫別人的表。
 */
import type { NodeKind } from "../domain";
import type { AimSavePlan, PlanCount, ReviewStat, WeekAimRow } from "../domain/weekAims";
import { MOCK_MODE, WIPED_MODE, nodeRepo } from "./index";
import { SqliteWeekAimRepository } from "./sqliteWeekAimRepository";
import { MemoryWeekAimRepository } from "./memoryWeekAimRepository";

/** 「已排」與回顧要查的節點（掛的路線／支線） */
export interface AimNodeRef {
  id: string;
  kind: NodeKind;
}

export interface ReviewResult {
  /** 節點 id → 這週的三個數 */
  stats: Record<string, ReviewStat>;
  /** 主幣別（售票口欄的格式）；售票口沒資料＝null */
  money: { code: string; decimals: number } | null;
}

export interface WeekAimRepository {
  /** week_on 落在 [from, to] 的方針（含已刪：刪了的帶到下週要看得到「被刪過」）；照 week_on、順序 */
  listRange(from: string, to: string): Promise<WeekAimRow[]>;
  getAim(id: string, opts?: { withDeleted?: boolean }): Promise<WeekAimRow | null>;
  /**
   * 寫方針框存檔（D-主-261）：一批寫完。creates 的 id 給了（帶過來的決定性 id）就用它——那一列已存在（含已刪）
   * ＝整列蓋回來並復活；沒給＝隨機 uuid。新句超過 MAX_AIMS 已由純函式擋，這裡再擋一次（同一週活著的列數）。
   */
  saveWeek(weekOn: string, plan: AimSavePlan): Promise<void>;
  /** 蓋済（at＝ISO）／取消（null）；狀態沒變不寫 */
  setDone(id: string, at: string | null): Promise<void>;
  deleteAim(id: string): Promise<void>;
  restoreAim(id: string): Promise<void>;
  /**
   * 「已排 N 張・済 M」（D-主-257）：每個節點底下、執行日落在 [from, to] 的車票／列車／車廂（定期券不算）。
   * 路線＝`route_id`＝路線（含掛這條路線標籤的臨時票）；其他種類＝子樹。
   */
  plannedCounts(nodes: readonly AimNodeRef[], from: string, to: string): Promise<Record<string, PlanCount>>;
  /** 回顧的三個數（D-主-258）；dayStartHour＝日界線（済與時間塊的「這週」用日界線日） */
  reviewStats(nodes: readonly AimNodeRef[], weekOn: string, dayStartHour: number): Promise<ReviewResult>;
}

function makeWeekAimRepo(): WeekAimRepository {
  if (!MOCK_MODE) return new SqliteWeekAimRepository();
  return new MemoryWeekAimRepository({ nodeRepo, seedDemo: !WIPED_MODE });
}

export const weekAimRepo: WeekAimRepository = makeWeekAimRepo();
