/**
 * 當天足跡的「時間」段提供者（車次②契約 0-8、§3.7）。
 * 本車次恆 null＝時刻表線尚未通車，足跡欄底顯示「時刻表通車後，這裡會多出當天的時間」。
 * 時刻表線的 listDaySegments 進 main 後，由旅客筆記線的小車次在這裡填：
 *   import { timetableRepo } from "../../data/timetableRepository";
 *   export const dayBlocksProvider: DayBlocksProvider | null = (d, h) => timetableRepo.listDaySegments(d, h).then((segs) => segs.map(mapSegment));
 * 並寫 mapSegment（DayBlockSegment → FootprintBlock：blockId→id、categoryName→label、glyph、colorIdx、from、to、running）。
 * 讀的人只有 notesStore.loadFootprint（`blocks = dayBlocksProvider ? await dayBlocksProvider(fpDay, h) : null`）；UI 不直接讀。
 */
import type { FootprintBlock } from "../../domain/notes";

export type DayBlocksProvider = (dateKey: string, dayStartHour: number) => Promise<FootprintBlock[]>;

export const dayBlocksProvider: DayBlocksProvider | null = null;
