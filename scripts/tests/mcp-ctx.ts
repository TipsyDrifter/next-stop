/**
 * 組一份 memory 版的 `McpCtx`（契約 §7）。
 * 載入鉤子在 `mcp-harness.ts`；src 底下的模組一律在這裡**動態** import——靜態 import 會在鉤子裝好之前就被解析。
 * 測試檔也照這樣：`const { addTasks } = await load("../../src/mcp/tools/tasks.ts")`。
 * 預設不種示範資料，測試自己建要的列，結果才好斷言。
 */
import "./mcp-harness.ts";
import type { McpAccess, McpCtx, McpModule } from "../../src/mcp/types.ts";

/** 在鉤子裝好之後動態載入 src 底下的模組（路徑相對於本檔） */
export function load<T = Record<string, unknown>>(rel: string): Promise<T> {
  return import(new URL(rel, import.meta.url).href) as Promise<T>;
}

export const ALL_WRITE: Record<McpModule, McpAccess> = {
  tasks: "write",
  timetable: "write",
  notes: "write",
  diary: "write",
  ledger: "write",
};

export async function makeCtx(
  opts: { now?: Date; dayStartHour?: number; longRunMaxMin?: number; access?: Partial<Record<McpModule, McpAccess>> } = {},
): Promise<McpCtx> {
  const { MemoryNodeRepository, MemorySettingsRepository } = await load<typeof import("../../src/data/memoryRepository.ts")>(
    "../../src/data/memoryRepository.ts",
  );
  const { MemoryNoteRepository } = await load<typeof import("../../src/data/memoryNoteRepository.ts")>("../../src/data/memoryNoteRepository.ts");
  const { MemoryTagRepository } = await load<typeof import("../../src/data/memoryTagRepository.ts")>("../../src/data/memoryTagRepository.ts");
  const { MemoryTimetableRepository } = await load<typeof import("../../src/data/memoryTimetableRepository.ts")>(
    "../../src/data/memoryTimetableRepository.ts",
  );
  const { MemoryTicketRepository } = await load<typeof import("../../src/data/memoryTicketRepository.ts")>(
    "../../src/data/memoryTicketRepository.ts",
  );
  const { todayKey } = await load<typeof import("../../src/lib/date.ts")>("../../src/lib/date.ts");

  const nodeRepo = new MemoryNodeRepository();
  const settingsRepo = new MemorySettingsRepository();
  const noteRepo = new MemoryNoteRepository(nodeRepo, { seed: false });
  const tagRepo = new MemoryTagRepository(nodeRepo, noteRepo, settingsRepo, { seed: false });
  const timetableRepo = new MemoryTimetableRepository({ seedDemo: false, nodeRepo, settingsRepo, tagRepo });
  const ticketRepo = new MemoryTicketRepository({ seedDemo: false });
  const dayStartHour = opts.dayStartHour ?? 6;
  const now = opts.now ?? new Date();
  return {
    deps: { nodeRepo, noteRepo, tagRepo, timetableRepo, ticketRepo },
    today: todayKey(dayStartHour, now),
    dayStartHour,
    now,
    longRunMaxMin: opts.longRunMaxMin ?? 840,
    access: { ...ALL_WRITE, ...opts.access },
  };
}
