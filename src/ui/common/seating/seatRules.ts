/**
 * seatRules——第四梯 4C（D-FB-7）預留席空位與待辦入座的純規則與文案格式化。
 * 帶 .ts 副檔名且零 React／零 CSS 相依，方便 UI 元件與 `node --test` 共用。
 */
import type { NodeRow } from "../../../domain/node.ts";
import { parseRule } from "../../../domain/repeat.ts";
import { hasDateSpan } from "../../../domain/dateRange.ts";
import type { SeatingSlotRef } from "../../../domain/scheduledTime.ts";
import { lengthText } from "../quickadd/quickAddModel.ts";

/** 某節點／班次是否可作為「預留空位（Slot）」供其他待辦車票入座 */
export function canActAsSeatSlot(
  node: Pick<NodeRow, "repeat_rule" | "is_placeholder" | "scheduled_on" | "scheduled_end" | "status">,
  settled = false,
): boolean {
  if (settled || node.status === "paused") return false;
  if (parseRule(node.repeat_rule) !== null) return true;
  return Boolean(node.is_placeholder) && !hasDateSpan(node);
}

/** 某節點是否可被選來入座頂替預留空位（排除定期券、預留席自身、已結案、已入座其他空位者） */
export function canBeSeatedCandidate(
  node: Pick<NodeRow, "id" | "kind" | "repeat_rule" | "is_placeholder" | "status">,
  slotId: string,
  alreadySeatedIds: ReadonlySet<string>,
): boolean {
  if (node.id === slotId) return false;
  if (node.kind !== "ticket" && node.kind !== "car" && node.kind !== "train") return false;
  if (node.status === "done" || node.status === "paused") return false;
  if (parseRule(node.repeat_rule) !== null) return false;
  if (node.is_placeholder) return false;
  if (alreadySeatedIds.has(node.id)) return false;
  return true;
}

/** 入座徽章顯示文案（例：`入座 ↻ 每日閱讀席 · 1h` 或 `入座 預留席 · 30 分`） */
export function formatSeatBadgeText(seat: SeatingSlotRef): string {
  const prefix = seat.isRecurring ? "↻ " : "";
  const dur = seat.slotEstimateMin && seat.slotEstimateMin > 0 ? ` · ${lengthText(seat.slotEstimateMin)}` : "";
  return `入座 ${prefix}${seat.slotName}${dur}`;
}

/** Mode A 本班填空母定期副標文案（例：`↻ 每日閱讀席 · 1h`） */
export function formatRunOriginText(motherName: string, estimateMin: number | null | undefined): string {
  const dur = estimateMin && estimateMin > 0 ? ` · ${lengthText(estimateMin)}` : "";
  return `↻ ${motherName}${dur}`;
}
