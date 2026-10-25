/**
 * 當天足跡的時間塊提供者（車次②契約 0-8、§3.7 留的插槽；日記足跡班填，契約 `docs/research/2026-10-25-旅客筆記-日記足跡班-契約.md` §2.1）。
 *
 * 只讀時刻表線：`timetableRepo.listDaySegments`（時刻表 ⑤ 契約 §6.3-1 為本線開的唯讀查詢）＋`nodeRepo.getNode` 查連結名；
 *   連結字樣（「（原車票已刪）」等）用時刻表的 `linkLabelOf`，跟時刻表實際欄同一套（D-筆-68）。時刻表檔案一行不改。
 * 讀的人只有 notesStore.loadFootprint（`blocks = dayBlocksProvider ? await dayBlocksProvider(fpDay, h) : null`）；UI 不直接讀。
 * 時刻表寫入後的重讀在 `useTimetableWriteReload.ts`（另開一檔，免得 notesStore ↔ 本檔互相 import）。
 */
import { nodeRepo } from "../../data";
import { timetableRepo } from "../../data/timetableRepository";
import { KIND_LABEL, type NodeRow } from "../../domain/node";
import { mapSegment, type FootprintBlock } from "../../domain/notes";
import type { DayBlockSegment } from "../../domain/timetable";
import { linkLabelOf, type LinkInfo } from "../../domain/timetableLink";

export type DayBlocksProvider = (dateKey: string, dayStartHour: number) => Promise<FootprintBlock[]>;

/** 節點列 → linkLabelOf 要的那一格（只填它會讀的欄；同 timetableStore 的 linkInfoOf） */
function infoOf(id: string, n: NodeRow | null): LinkInfo {
  if (!n) return { id, kind: "", kindLabel: "", name: "", routeId: null, estimateMin: null, code: null, deleted: false, missing: true };
  return {
    id,
    kind: n.kind,
    kindLabel: KIND_LABEL[n.kind] ?? n.kind,
    name: n.name,
    routeId: n.kind === "route" ? n.id : n.route_id,
    estimateMin: n.estimate_min,
    code: n.kind === "route" ? n.code : null,
    deleted: n.deleted_at !== null,
    missing: false,
  };
}

/** 一段的連結字；沒連結＝null */
function linkTextOf(seg: DayBlockSegment, links: Record<string, LinkInfo>): string | null {
  return linkLabelOf({ node_id: seg.nodeId, route_id: seg.routeId }, links);
}

export const dayBlocksProvider: DayBlocksProvider | null = async (dateKey, dayStartHour) => {
  const segs = await timetableRepo.listDaySegments(dateKey, dayStartHour);
  const ids = [...new Set(segs.flatMap((s) => (s.nodeId !== null ? [s.nodeId] : s.routeId !== null ? [s.routeId] : [])))];
  // 照時刻表 loadLinkInfo 的寫法（方法不可拆離物件）；查不到／讀失敗那格當 missing，不讓整份足跡失敗
  const nodes = await Promise.all(ids.map((id) => nodeRepo.getNode(id).catch(() => null)));
  const links: Record<string, LinkInfo> = {};
  ids.forEach((id, i) => (links[id] = infoOf(id, nodes[i])));
  return segs.map((s) => mapSegment(s, linkTextOf(s, links)));
};

