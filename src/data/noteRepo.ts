/**
 * 旅客筆記線的 repository 單例（車次①契約 §2.1）。
 *
 * 不放進 `src/data/index.ts`（集中檔）：本線自己的工廠，`MOCK_MODE`／`WIPED_MODE`／`nodeRepo` 從那裡借。
 * mock＝記憶體實作（`?wiped=1` 時一顆種子都不種，公約 §六）；真機＝SQLite。
 */
import { MOCK_MODE, WIPED_MODE, nodeRepo } from "./index";
import type { NoteRepository } from "./noteRepository";
import { MemoryNoteRepository } from "./memoryNoteRepository";
import { SqliteNoteRepository } from "./sqliteNoteRepository";

export const noteRepo: NoteRepository = MOCK_MODE
  ? new MemoryNoteRepository(nodeRepo, { seed: !WIPED_MODE })
  : new SqliteNoteRepository();
