/**
 * scheduleSeatModel——第四梯（討論 6 · D-FB-7）時刻表日程「預留席車票、本班填空（Mode A）與待辦入座頂替（Mode B）」純邏輯模型。
 *
 * 純 TypeScript、零 React／DOM／Store 相依，供單日日程、週／三日時段、日程小面板與 `node --test` 直接載入共用：
 *   1. 退役孤立 `adhoc` 後的「預留席車票」常數與空白軸拖拉區間計算（`computeDragCreateRange`）。
 *   2. 預定卡與待排籤的統一顯示推導（`planItemDisplay`）：預留席虛線牌、Mode A 本班填空 `具體內容（↻ 母定期名）`、Mode B 待辦入座 `入座 ↻ 母空位名`、期間自由券區間徽章。
 *   3. Mode B 待辦入座候選篩選與優先排序（`canSeatIntoSlot`、`isEligibleSeatCandidate`、`sortSeatCandidates`）。
 */
import type { NodeRow } from "../../../domain/node";
import { formatDateRangeBadge, hasDateSpan, isRangeCoveringDay } from "../../../domain/dateRange.ts";
import { hasRepeatRule } from "../../../domain/scheduledTime.ts";
import type { PlanItem } from "../../../domain/timetableSchedule.ts";

/** 點選「＋ 預留席」後準備在時間軸點放位置的記號（向下相容舊記號 `addadhoc`） */
export const ADD_PLACEHOLDER_KEY = "addplaceholder";

export function isAddPlaceholder(key: string | null): boolean {
  return key === ADD_PLACEHOLDER_KEY || key === "addadhoc";
}

export const PLACEHOLDER_UI = {
  tag: "預留席",
  fallbackName: "預留席",
  addBtn: "＋ 預留席",
  addBtnCompact: "＋預留",
  pickAdd: "點一下預定欄放下「預留席」（預設 1h），或直接在空白處上下拖拉時段",
  added: (s: string, e: string) => `已建立預留席 ${s}–${e}`,
  deleted: "已刪除預留席車票",
  promoted: (name: string) => `已填入「${name}」並轉為正式車票`,
  seated: (ticketName: string, slotName: string) => `「${ticketName}」已入座「${slotName}」`,
  released: (slotName: string) => `已釋出預留席「${slotName}」`,
} as const;

/** 判斷節點是否為「預留席車票」（`is_placeholder === 1`） */
export function isPlaceholderNode(
  node: Pick<NodeRow, "is_placeholder"> | null | undefined,
): boolean {
  return Boolean(node && node.is_placeholder);
}

/** 判斷某張日程預定項是否可作為「待辦入座」的目標空位（未完成、未運休、尚未入座的定期班次或預留席車票） */
export function canSeatIntoSlot(
  item: Pick<PlanItem, "kind" | "done" | "skipped" | "seatedInto"> | null | undefined,
  node: Pick<NodeRow, "is_placeholder"> | null | undefined,
): boolean {
  if (!item || item.done || item.skipped || item.seatedInto) return false;
  return item.kind === "repeat" || isPlaceholderNode(node);
}

/** 判斷某個節點是否可作為「坐進預留空位」的待辦車票候選（排除定期券、預留席自身、已完成／暫停、非任務節點與容器節點） */
export function isEligibleSeatCandidate(
  node: Pick<
    NodeRow,
    "id" | "kind" | "status" | "deleted_at" | "repeat_rule" | "is_placeholder"
  >,
  slotNodeId: string,
  hasChildren = false,
): boolean {
  if (node.id === slotNodeId) return false;
  if (node.deleted_at !== null) return false;
  if (node.status === "done" || node.status === "paused") return false;
  if (node.kind !== "ticket" && node.kind !== "car" && node.kind !== "train") return false;
  if (hasChildren) return false;
  if (hasRepeatRule(node.repeat_rule)) return false;
  if (isPlaceholderNode(node)) return false;
  return true;
}

/**
 * 排序待辦入座候選清單：
 *   1. 與預留空位同路線（`route_id === preferredRouteId`）者最優先；
 *   2. 已排在當天或區間涵蓋當天者次之，再來是未排日期／其他日期；
 *   3. 關鍵字搜尋過濾（名稱比對）。
 */
export function sortSeatCandidates<
  T extends Pick<
    NodeRow,
    "id" | "name" | "route_id" | "scheduled_on" | "scheduled_end" | "created_at"
  >,
>(
  candidates: readonly T[],
  opts: {
    preferredRouteId?: string | null;
    targetDate: string;
    query?: string;
  },
): T[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const filtered = q
    ? candidates.filter((c) => c.name.toLowerCase().includes(q))
    : [...candidates];

  const dayRank = (c: T): number => {
    if (c.scheduled_on === opts.targetDate && !hasDateSpan(c)) return 0;
    if (isRangeCoveringDay(c, opts.targetDate)) return 1;
    if (c.scheduled_on === null) return 2;
    return 3;
  };

  return filtered.sort((a, b) => {
    const ra = opts.preferredRouteId && a.route_id === opts.preferredRouteId ? 0 : 1;
    const rb = opts.preferredRouteId && b.route_id === opts.preferredRouteId ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const da = dayRank(a);
    const db = dayRank(b);
    if (da !== db) return da - db;
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}

export type PlanBadgeKind = "placeholder" | "filled" | "seated" | "range" | null;

export interface PlanItemDisplay {
  /** 主顯示標題（填空時為具體內容；入座時為入座待辦名；預留席為路線／預留席名） */
  title: string;
  /** 母定期／母預留來源副標（如 `↻ 學習`） */
  originNote: string | null;
  /** 完整單行組合標題（供 tooltip／寬卡／面板副標使用，如 `念線代 Ch.3（↻ 學習）`） */
  fullTitle: string;
  /** 是否畫虛線預留席車廂框（僅尚未轉正、尚未入座、且未填本班內容的預留席為 true） */
  isPlaceholder: boolean;
  /** 卡角／清單專屬小牌種類 */
  badgeKind: PlanBadgeKind;
  /** 卡角／清單專屬小牌文字 */
  badgeText: string | null;
}

/**
 * 計算日程預定項（待排清單、單日時間軸、週／三日時段、彈窗標題）的統一呈現資訊。
 */
export function planItemDisplay(
  item: Pick<PlanItem, "kind" | "customTitle" | "seatedInto">,
  node: Pick<NodeRow, "name" | "is_placeholder" | "scheduled_on" | "scheduled_end"> | null | undefined,
  routeName?: string | null,
): PlanItemDisplay {
  const custom = item.customTitle?.trim() || null;
  const rawName = node?.name?.trim() || "";

  // 1. Mode B：待辦車票已入座頂替某預留席／定期班次
  if (item.seatedInto) {
    const title = custom ?? (rawName || "？");
    const slotPrefix = item.seatedInto.isRecurring ? "↻ " : "";
    const originNote = `${slotPrefix}${item.seatedInto.slotName}`;
    const badgeText = `入座 ${originNote}`;
    return {
      title,
      originNote,
      fullTitle: `${title}（${badgeText}）`,
      isPlaceholder: false,
      badgeKind: "seated",
      badgeText,
    };
  }

  // 2. Mode A：定期班次（或預留席）填寫了當班具體內容
  if (custom) {
    const baseName = rawName || routeName || PLACEHOLDER_UI.fallbackName;
    const originNote = item.kind === "repeat" ? `↻ ${baseName}` : baseName !== custom ? baseName : null;
    return {
      title: custom,
      originNote,
      fullTitle: originNote ? `${custom}（${originNote}）` : custom,
      isPlaceholder: false,
      badgeKind: "filled",
      badgeText: originNote ?? "本班內容",
    };
  }

  // 3. 4A：尚未填入具體事項的預留席車票（虛線框）
  if (isPlaceholderNode(node)) {
    const title = rawName || routeName || PLACEHOLDER_UI.fallbackName;
    return {
      title,
      originNote: null,
      fullTitle: title,
      isPlaceholder: true,
      badgeKind: "placeholder",
      badgeText: PLACEHOLDER_UI.tag,
    };
  }

  // 4. 4B / 2A：跨日票（期間自由券或多日乘車日，在待排區／未定時帶標註區間）
  if (node && hasDateSpan(node) && node.scheduled_on && node.scheduled_end) {
    const rangeBadge = formatDateRangeBadge(node.scheduled_on, node.scheduled_end);
    const title = rawName || "？";
    return {
      title,
      originNote: rangeBadge || null,
      fullTitle: rangeBadge ? `${title}（${rangeBadge}）` : title,
      isPlaceholder: false,
      badgeKind: rangeBadge ? "range" : null,
      badgeText: rangeBadge || null,
    };
  }

  // 5. 一般單發票／一般定期班次
  const title = rawName || "？";
  return {
    title,
    originNote: null,
    fullTitle: title,
    isPlaceholder: false,
    badgeKind: null,
    badgeText: null,
  };
}

/**
 * 計算在時間軸空白處上下拖拉建立預留席時的起訖分鐘（吸附至 `step` 分，保底至少 `step` 分，不超出當日軸界）。
 */
export function computeDragCreateRange(
  anchorMin: number,
  currentMin: number,
  dayStartHour: number,
  step = 15,
): { startMin: number; endMin: number; durationMin: number } {
  const axisMin = dayStartHour * 60;
  const axisMax = axisMin + 1440;
  const snap = (m: number) => Math.round(m / step) * step;
  const a = Math.max(axisMin, Math.min(axisMax - step, snap(anchorMin)));
  const b = Math.max(axisMin, Math.min(axisMax, snap(currentMin)));

  if (b >= a) {
    const endMin = Math.min(axisMax, Math.max(a + step, b));
    return { startMin: a, endMin, durationMin: endMin - a };
  }
  const startMin = Math.max(axisMin, b);
  const endMin = Math.min(axisMax, Math.max(startMin + step, a + step));
  return { startMin, endMin, durationMin: endMin - startMin };
}
