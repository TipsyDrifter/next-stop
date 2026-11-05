/**
 * 失物招領的 repository 單例（第五本第二梯 ⑦）。不放進 `src/data/index.ts`（集中檔）——同 depotRepo.ts 的做法。
 * mock＝記憶體實作（自帶幾筆假資料，`?wiped=1` 時一筆都不放）；真機＝SQLite，撿回走既有各 repo。
 */
import { MOCK_MODE, WIPED_MODE, nodeRepo, syncRepo } from "./index";
import type { LostFoundRepository } from "./lostFoundRepository";
import { SqliteLostFoundRepository } from "./lostFoundRepository";
import { MemoryLostFoundRepository } from "./memoryLostFoundRepository";
import { noteRepo } from "./noteRepo";
import { tagRepo } from "./tagRepo";
import { ticketRepo } from "./ticketRepository";
import { timetableRepo } from "./timetableRepository";
import { weekAimRepo } from "./weekAimRepository";

export const lostFoundRepo: LostFoundRepository = MOCK_MODE
  ? new MemoryLostFoundRepository({ seed: !WIPED_MODE })
  : new SqliteLostFoundRepository({
      nodes: nodeRepo,
      notes: noteRepo,
      tags: tagRepo,
      timetable: timetableRepo,
      ticket: ticketRepo,
      aims: weekAimRepo,
      readSnapshot: (key) => syncRepo.cloudSnapshotRead(key),
    });
