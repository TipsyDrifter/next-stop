/**
 * 當天足跡的「時間」段提供者（車次②契約 0-8、§3.7）。
 * 目前恆 null＝足跡不畫「時間」段（磨光③ 2-7 起欄底也不再寫「時刻表通車後…」；接上留給下一輪 B1）。
 * 時刻表線的 listDaySegments 進 main 後，由旅客筆記線的小車次在這裡填：
 *   import { timetableRepo } from "../../data/timetableRepository";
 *   export const dayBlocksProvider: DayBlocksProvider | null = (d, h) => timetableRepo.listDaySegments(d, h).then((segs) => segs.map(mapSegment));
 * 並寫 mapSegment（DayBlockSegment → FootprintBlock：blockId→id、categoryName→label、glyph、colorIdx、from、to、running）。
 * 讀的人只有 notesStore.loadFootprint（`blocks = dayBlocksProvider ? await dayBlocksProvider(fpDay, h) : null`）；UI 不直接讀。
 */
import type { FootprintBlock } from "../../domain/notes";

export type DayBlocksProvider = (dateKey: string, dayStartHour: number) => Promise<FootprintBlock[]>;

export const dayBlocksProvider: DayBlocksProvider | null = null;
