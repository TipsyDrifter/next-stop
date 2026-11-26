/**
 * 跨模組輕量相片附件櫃單例選擇器（v1.39 4A-1）。
 * 真機走 `SqliteAttachmentRepository`；`?mock=1` 走 `MemoryAttachmentRepository`。
 */
import { MOCK_MODE, WIPED_MODE } from "./index";
import type { AttachmentRepository } from "./attachmentRepository";
import { SqliteAttachmentRepository } from "./sqliteAttachmentRepository";
import { MemoryAttachmentRepository, type DemoAttachmentTargets } from "./memoryAttachmentRepository";
import { addDays, dayWindow, todayKey } from "../lib/date";

async function resolveMockDemoTargets(): Promise<DemoAttachmentTargets> {
  const out: DemoAttachmentTargets = {};
  try {
    const today = todayKey(6);
    const [{ ticketRepo }, { timetableRepo }] = await Promise.all([
      import("./ticketRepository"),
      import("./timetableRepository"),
    ]);
    const entries = await ticketRepo.listEntries(addDays(today, -3), addDays(today, 1), null);
    const exp = entries.find((e) => e.deleted_at === null && e.kind === "expense") ?? entries[0];
    if (exp) out.ticketEntryId = exp.id;

    const w = dayWindow(today, 3);
    const blocks = await timetableRepo.listBlocks(w.start, w.end);
    const blk = blocks.find((b) => b.ended_at !== null) ?? blocks[0];
    if (blk) out.timetableBlockId = blk.id;
  } catch {
    /* 示範附件定位失敗不影響主流程 */
  }
  return out;
}

export const attachmentRepo: AttachmentRepository = MOCK_MODE
  ? new MemoryAttachmentRepository({
      seedDemo: !WIPED_MODE,
      resolveTargets: !WIPED_MODE ? resolveMockDemoTargets : undefined,
    })
  : new SqliteAttachmentRepository();
