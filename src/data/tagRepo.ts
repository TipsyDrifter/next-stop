/**
 * 荷札 repository 單例（旅客筆記車次③契約 §3.3；照 `noteRepo.ts`）。
 *
 * 不放進 `src/data/index.ts`（集中檔）：本線自己的工廠，`MOCK_MODE`／`WIPED_MODE`／`nodeRepo`／`settingsRepo` 從那裡借。
 * mock＝記憶體實作（`?wiped=1` 時一顆種子都不種）；真機＝SQLite。別線也從這裡拿 `tagRepo`（介面見 `tagRepository.ts`）。
 */
import { MOCK_MODE, WIPED_MODE, nodeRepo, settingsRepo } from "./index";
import { noteRepo } from "./noteRepo";
import type { TagRepository } from "./tagRepository";
import { MemoryTagRepository } from "./memoryTagRepository";
import type { MemoryNoteRepository } from "./memoryNoteRepository";
import { SqliteTagRepository } from "./sqliteTagRepository";

export const tagRepo: TagRepository = MOCK_MODE
  ? new MemoryTagRepository(nodeRepo, noteRepo as MemoryNoteRepository, settingsRepo, { seed: !WIPED_MODE })
  : new SqliteTagRepository();
