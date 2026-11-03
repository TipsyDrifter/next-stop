/**
 * 車庫與駅スタンプ的 repository 單例（車庫與回顧 ③）。不放進 `src/data/index.ts`（集中檔）——同 noteRepo.ts 的做法。
 * mock＝記憶體實作（借核心記憶體庫的 depotDump、筆記與時刻表的公開方法）；真機＝SQLite。
 */
import { MOCK_MODE, nodeRepo } from "./index";
import type { DepotRepository } from "./depotRepository";
import { SqliteDepotRepository } from "./depotRepository";
import { MemoryDepotRepository } from "./memoryDepotRepository";
import type { MemoryNodeRepository } from "./memoryRepository";
import { noteRepo } from "./noteRepo";
import { timetableRepo } from "./timetableRepository";

export const depotRepo: DepotRepository = MOCK_MODE
  ? new MemoryDepotRepository(nodeRepo as MemoryNodeRepository, () => noteRepo, () => timetableRepo)
  : new SqliteDepotRepository();
