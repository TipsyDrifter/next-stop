/**
 * sealRepo——一段日子裡的済章（② 運行報告 D-主-181；契約 §1）。只讀、0 migration。
 *
 * 規則全在 `domain/seals.ts`：SQLite 用那裡的兩句 SELECT；mock 逐日走 `noteRepo.listFootprints`
 * （記憶體實作的足跡也是 seals.ts 的純函式，語義同一份）。
 * 誰在用：運行報告（今天的済、每日運行實績）；之後的車庫、駅スタンプ（③）。
 */
import { MOCK_MODE } from "./index";
import { noteRepo } from "./noteRepo";
import { getDb } from "../lib/db";
import { addDays, dayWindow } from "../lib/date";
import { SEAL_NODE_SQL, SEAL_OCC_SQL, dedupeSeals, sealOfRow, type SealFact, type SealRow } from "../domain/seals";

export interface SealRepository {
  /**
   * `fromDay`～`toDay`（含兩端，YYYY-MM-DD）這幾個日界線日裡的済章：依完成時刻排序、同一節點同一時刻只留一枚。
   * `fromDay > toDay` ⇒ 空陣列。
   */
  listSeals(fromDay: string, toDay: string, dayStartHour: number): Promise<SealFact[]>;
}

class SqliteSealRepository implements SealRepository {
  async listSeals(fromDay: string, toDay: string, dayStartHour: number): Promise<SealFact[]> {
    if (fromDay > toDay) return [];
    const db = await getDb();
    const start = dayWindow(fromDay, dayStartHour).start;
    const end = dayWindow(toDay, dayStartHour).end;
    const [a, b] = await Promise.all([
      db.select<SealRow[]>(SEAL_NODE_SQL, [start, end]),
      db.select<SealRow[]>(SEAL_OCC_SQL, [start, end]),
    ]);
    return dedupeSeals([...a, ...b].map(sealOfRow));
  }
}

/** mock：逐日拿足跡的済章（假資料量小，一個月幾十次記憶體查詢） */
class FootprintSealRepository implements SealRepository {
  async listSeals(fromDay: string, toDay: string, dayStartHour: number): Promise<SealFact[]> {
    const out: SealFact[] = [];
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
      const f = await noteRepo.listFootprints(d, dayStartHour);
      out.push(...f.seals);
    }
    return dedupeSeals(out);
  }
}

export const sealRepo: SealRepository = MOCK_MODE ? new FootprintSealRepository() : new SqliteSealRepository();
