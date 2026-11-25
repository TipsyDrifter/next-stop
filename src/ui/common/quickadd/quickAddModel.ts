/**
 * 建票列的規則（回饋甲 D-主-127、128、135；契約 §一 A）——純函式，桌機票形草稿列與手機底部輸入列共用。
 *
 *   - 值的來源有三層：chip 設的 ＞ 文字認出來的（domain/quickAdd parseQuickAdd）＞ 呼叫端給的預設（掛到、乘車日）。
 *     chip 改值時文字裡同種片段一起拿掉（useQuickAdd 叫 stripTokens），所以「chip 優先」只是保險。
 *   - 掛到決定建成什麼（resolveQuickTarget）：無路線＝臨時車票；路線／支線＝列車｜車票二選一（車票＝掛路線標籤的臨時車票）；
 *     列車／車廂＝車票。父節點規則照 allowedChildKinds 走、不寫死（巢狀放寬後自動跟上）。
 *   - toast 只在「票離開眼前」時出（leaveNote）：無日期進收件匣、建到別天、建到別條路線。
 */
// 帶 .ts 副檔名、只 import 純函式模組：scripts/tests/quick-add-model.test.ts 以 node 直接載入
import { allowedChildKinds, KIND_LABEL, type NodeKind, type Priority } from "../../../domain/node.ts";
import { formatDateRangeBadge, isRangeCoveringDay, normalizeDateRange } from "../../../domain/dateRange.ts";
import type { AttachTarget } from "../../../domain/notes.ts";
import { placeholderTicketTitle, type QuickAddParse, type QuickTokenKind } from "../../../domain/quickAdd.ts";

/** 掛到哪（＝AttachPicker 的值，討論 5 擴充支援掛到 ticket）；routeId null＝無路線 */
export type QuickDest = Omit<AttachTarget, "nodeKind"> & { nodeKind: AttachTarget["nodeKind"] | "ticket" };
export const NO_DEST: QuickDest = { routeId: null, nodeId: null, nodeKind: null };

/** 掛到路線（或支線）時建成什麼：車票＝掛路線的車票（或支線下直屬車票）；支線＝路線或支線底下的主題支線 */
export type RouteKind = "ticket" | "branch";

/** chips 的七格（也是挑選器的 key；第三梯操作 6 補上 station） */
export type QuickChipKey = "dest" | "station" | "date" | "time" | "due" | "priority" | "tags";

/** 每格 chip 改值時要從文字裡拿掉的片段種類（幾點那格管開始＋長度兩種） */
export const CHIP_TOKENS: Readonly<Record<QuickChipKey, readonly QuickTokenKind[]>> = {
  dest: ["dest"],
  station: [],
  date: ["date"],
  time: ["time", "length"],
  due: ["due"],
  priority: ["priority"],
  tags: ["tag"],
};

/** chip 設的值；欄位不存在＝這格沒用 chip 設（看文字、再看預設） */
export interface QuickChips {
  dest?: QuickDest;
  stationId?: string | null;
  scheduledOn?: string | null;
  scheduledEnd?: string | null;
  /** 是否為多日乘車日（僅跨日區間時有意義；false＝期間自由券） */
  isMultiDay?: boolean;
  scheduledTime?: string | null;
  estimateMin?: number | null;
  dueOn?: string | null;
  /** 締切與乘車日同步（當 scheduledOn 改變時，dueOn 自動跟隨） */
  syncDueWithScheduled?: boolean;
  priority?: Priority | null;
  tags?: readonly string[];
}

/** 呼叫端給的預設（今日＝無路線＋今天；路線圖＝這條路線＋無日期；串流＝那一天；行內編輯＝既有欄位值） */
export interface QuickDefaults {
  dest: QuickDest;
  stationId?: string | null;
  scheduledOn: string | null;
  scheduledEnd?: string | null;
  isMultiDay?: boolean;
  scheduledTime?: string | null;
  estimateMin?: number | null;
  dueOn?: string | null;
  /** 初始是否啟用「締切同乘車日」（如行內編輯既有 `due_on === scheduled_on` 車票） */
  syncDueWithScheduled?: boolean;
  priority?: Priority | null;
  tags?: readonly string[];
  /** 乘車日空著時 chip 寫「無日期」（今日 Shift+Enter、手機今日）；false＝空著就是空著（路線圖：列車本來就不一定排日子） */
  noDateLabel?: boolean;
}

/** 合起來的結果：送出時寫進去的值 */
export interface QuickValues {
  name: string;
  /** 實際建立名稱：一般票取 `name`；預留席未填標題時取路線／荷札預設標題 */
  effectiveName: string;
  /** 4A 免標題預留席：未填標題但具備 @路線／#荷札 ＋ 時間／日期／區間訊號 */
  isPlaceholder: boolean;
  dest: QuickDest;
  stationId: string | null;
  scheduledOn: string | null;
  scheduledEnd: string | null;
  /** 是否為多日乘車日（跨日且為多日時 true，其餘一律 false） */
  isMultiDay: boolean;
  scheduledTime: string | null;
  estimateMin: number | null;
  dueOn: string | null;
  /** 締切是否與乘車日同步（由 `=` 語法或膠囊開啟） */
  syncDueWithScheduled: boolean;
  priority: Priority | null;
  tags: string[];
  /** 「設過」的格（從文字認出來或點 chip 改過）＝chip 亮起 */
  on: ReadonlySet<QuickChipKey>;
}

/**
 * 三層合一。`nodeKindOf` 把文字 @路線/子項 認出來的節點 id 換成種類（支線／列車／車廂／車票；查不到當列車）。
 * `positional`（大綱位置型草稿列）：掛到由位置決定，不看 @。
 */
export function mergeQuick(
  parse: QuickAddParse,
  chips: QuickChips,
  defaults: QuickDefaults,
  nodeKindOf: (id: string) => QuickDest["nodeKind"],
  positional = false,
  destNameOf?: (dest: QuickDest) => string | null,
): QuickValues {
  const on = new Set<QuickChipKey>();
  const pick = <T>(key: QuickChipKey, chip: T | undefined, typed: T | undefined, base: T): T => {
    if (chip !== undefined) {
      on.add(key);
      return chip;
    }
    if (typed !== undefined) {
      on.add(key);
      return typed;
    }
    return base;
  };
  const typedDest: QuickDest | undefined =
    !positional && parse.dest
      ? {
          routeId: parse.dest.routeId,
          nodeId: parse.dest.nodeId,
          nodeKind: parse.dest.nodeId ? (nodeKindOf(parse.dest.nodeId) ?? "train") : "route",
        }
      : undefined;
  const typedTime = parse.scheduledTime;
  const timeOn = chips.scheduledTime !== undefined || chips.estimateMin !== undefined;

  // 乘車日與期間區間：chip ＞ 文字語法 ＞ 預設，統一經 normalizeDateRange 正規化
  let resolvedScheduled: string | null;
  let resolvedScheduledEnd: string | null;
  let resolvedMultiDay = false;
  const dateChipTouched =
    chips.scheduledOn !== undefined || chips.scheduledEnd !== undefined || chips.isMultiDay !== undefined;
  if (dateChipTouched) {
    const norm = normalizeDateRange(chips.scheduledOn ?? null, chips.scheduledEnd ?? null);
    resolvedScheduled = norm.scheduledOn;
    resolvedScheduledEnd = norm.scheduledEnd;
    resolvedMultiDay = Boolean(norm.scheduledEnd && chips.isMultiDay);
    on.add("date");
  } else if (parse.scheduledOn !== undefined) {
    const norm = normalizeDateRange(parse.scheduledOn, parse.scheduledEnd ?? null);
    resolvedScheduled = norm.scheduledOn;
    resolvedScheduledEnd = norm.scheduledEnd;
    resolvedMultiDay = false;
    on.add("date");
  } else {
    const norm = normalizeDateRange(defaults.scheduledOn, defaults.scheduledEnd ?? null);
    resolvedScheduled = norm.scheduledOn;
    resolvedScheduledEnd = norm.scheduledEnd;
    resolvedMultiDay = Boolean(norm.scheduledEnd && defaults.isMultiDay);
  }

  // 締切與同乘車日：chip 明確指定 ＞ 文字語法（`=`／`〆=` vs `〆日期`）＞ 預設（區間票同乘車日對齊訖日或起日）
  const syncAnchor = resolvedScheduledEnd ?? resolvedScheduled;
  let syncDue = false;
  let resolvedDue: string | null;
  if (chips.syncDueWithScheduled !== undefined) {
    syncDue = chips.syncDueWithScheduled;
    if (syncDue) {
      resolvedDue = syncAnchor;
      on.add("due");
    } else if (chips.dueOn !== undefined) {
      resolvedDue = chips.dueOn;
      if (resolvedDue !== null) on.add("due");
    } else if (parse.dueSameAsScheduled) {
      syncDue = true;
      resolvedDue = syncAnchor;
      on.add("due");
    } else if (parse.dueOn !== undefined) {
      resolvedDue = parse.dueOn;
      on.add("due");
    } else {
      resolvedDue = null;
    }
  } else if (chips.dueOn !== undefined) {
    resolvedDue = chips.dueOn;
    if (resolvedDue !== null) on.add("due");
  } else if (parse.dueSameAsScheduled) {
    syncDue = true;
    resolvedDue = syncAnchor;
    on.add("due");
  } else if (parse.dueOn !== undefined) {
    resolvedDue = parse.dueOn;
    on.add("due");
  } else if (defaults.syncDueWithScheduled) {
    syncDue = true;
    resolvedDue = syncAnchor;
  } else {
    resolvedDue = defaults.dueOn ?? null;
  }

  const resolvedDest = pick("dest", chips.dest, typedDest, defaults.dest);
  let resolvedStationId: string | null = null;
  if (chips.stationId !== undefined) {
    resolvedStationId = chips.stationId;
    if (resolvedStationId !== null) on.add("station");
  } else if (resolvedDest.routeId && resolvedDest.routeId === defaults.dest.routeId && defaults.stationId) {
    resolvedStationId = defaults.stationId;
  }

  const resolvedTime = timeOn
    ? (chips.scheduledTime ?? null)
    : typedTime !== undefined
      ? typedTime
      : (defaults.scheduledTime ?? null);
  const resolvedEstimate = timeOn
    ? (chips.estimateMin ?? null)
    : parse.estimateMin !== undefined
      ? parse.estimateMin
      : (defaults.estimateMin ?? null);

  let resolvedTags: string[] = [];
  if (chips.tags !== undefined) {
    resolvedTags = [...chips.tags];
    if (resolvedTags.length) on.add("tags");
  } else if (parse.tags.length) {
    resolvedTags = Array.from(new Set([...(defaults.tags ?? []), ...parse.tags.map((t) => t.name)]));
    on.add("tags");
  } else if (defaults.tags?.length) {
    resolvedTags = [...defaults.tags];
  }

  const trimmedName = parse.name.trim();
  const hasExplicitScheduleOrTime =
    Boolean(parse.isPlaceholder) ||
    dateChipTouched ||
    parse.scheduledOn !== undefined ||
    parse.scheduledEnd !== undefined ||
    resolvedScheduledEnd !== null ||
    timeOn ||
    typedTime !== undefined ||
    parse.estimateMin !== undefined ||
    resolvedTime !== null ||
    resolvedEstimate !== null;
  const hasCategory = Boolean(resolvedDest.routeId) || resolvedTags.length > 0;
  const isPlaceholder = !trimmedName && hasCategory && hasExplicitScheduleOrTime;
  const effectiveName = trimmedName
    ? trimmedName
    : isPlaceholder
      ? (parse.placeholderTitle ??
        placeholderTicketTitle({
          routeName: destNameOf?.(resolvedDest) ?? null,
          tagNames: resolvedTags,
        }))
      : "";

  const v: QuickValues = {
    name: parse.name,
    effectiveName,
    isPlaceholder,
    dest: resolvedDest,
    stationId: resolvedStationId,
    scheduledOn: resolvedScheduled,
    scheduledEnd: resolvedScheduledEnd,
    isMultiDay: resolvedMultiDay,
    scheduledTime: resolvedTime,
    estimateMin: resolvedEstimate,
    dueOn: resolvedDue,
    syncDueWithScheduled: syncDue,
    priority: pick("priority", chips.priority, parse.priority, defaults.priority ?? null),
    tags: resolvedTags,
    on,
  };
  if (timeOn || typedTime !== undefined || parse.estimateMin !== undefined) {
    if (v.scheduledTime !== null || v.estimateMin !== null) on.add("time");
  }
  if (!syncDue && v.dueOn === null) {
    on.delete("due");
  }
  if (v.priority === null) on.delete("priority");
  return v;
}

/** 建成什麼 */
export interface QuickTarget {
  kind: NodeKind;
  parentId: string | null;
  /** 臨時車票的路線標籤 */
  routeTagId: string | null;
  /** 掛到路線（或支線）＝可在「車票｜支線」之間選（僅路線大綱顯示切換鈕） */
  canChoose: boolean;
}

/** 掛到 → 建成什麼（操作 2：路線與支線下可在「車票｜支線」間切換；無路線／列車／車廂／車票下固定建車票） */
export function resolveQuickTarget(dest: QuickDest, routeKind: RouteKind = "ticket"): QuickTarget {
  if (!dest.routeId) return { kind: "ticket", parentId: null, routeTagId: null, canChoose: false };
  const parentId = dest.nodeId ?? dest.routeId;
  const parentKind: NodeKind = dest.nodeId ? (dest.nodeKind && dest.nodeKind !== "route" ? dest.nodeKind : "train") : "route";
  if (parentKind === "ticket") return { kind: "ticket", parentId, routeTagId: null, canChoose: false };
  const allowed = allowedChildKinds(parentKind);
  const canBranch = allowed.includes("branch");
  if (canBranch) {
    if (routeKind === "branch") {
      return { kind: "branch", parentId, routeTagId: null, canChoose: true };
    }
    // 支線底下直接掛車票（D-主-245）；路線頂層建掛路線標籤的車票（加子項時自動升格列車）
    if (allowed.includes("ticket")) {
      return { kind: "ticket", parentId, routeTagId: null, canChoose: true };
    }
    return { kind: "ticket", parentId: null, routeTagId: dest.routeId, canChoose: true };
  }
  if (allowed.includes("ticket")) return { kind: "ticket", parentId, routeTagId: null, canChoose: false };
  return { kind: "ticket", parentId: null, routeTagId: dest.routeId, canChoose: false };
}

/** 票根的長相：徽章字、徽章虛線、票根小字、票種（右上角） */
export interface QuickStubLook {
  badge: string;
  dashed: boolean;
  lineName: string;
  fare: string;
}

const BADGE: Partial<Record<NodeKind, string>> = { train: "列", car: "廂", ticket: "票", branch: "支" };

export function stubLook(t: Pick<QuickTarget, "kind" | "parentId" | "routeTagId">, isPlaceholder = false): QuickStubLook {
  if (t.kind === "branch") {
    return { badge: "支", dashed: true, lineName: "支線", fare: "支線" };
  }
  if (isPlaceholder) {
    return { badge: "預", dashed: true, lineName: "預留席", fare: "預留席" };
  }
  if (t.kind === "ticket" && !t.parentId && !t.routeTagId) {
    return { badge: "臨", dashed: true, lineName: "無路線", fare: "臨時券" };
  }
  // 掛路線標籤的臨時車票（沒有父節點）：票根與右上角說同一件事，都是「臨」
  if (t.kind === "ticket" && !t.parentId) {
    return { badge: "臨", dashed: true, lineName: "臨時車票", fare: "臨時券" };
  }
  return {
    badge: BADGE[t.kind] ?? KIND_LABEL[t.kind].slice(0, 1),
    // 同大綱票根（OutlineRow badgeClass）：列車／車廂／支線＝虛線圈、車票＝實線圈
    dashed: t.kind !== "ticket",
    lineName: KIND_LABEL[t.kind],
    fare: t.parentId ? "乘車券" : "臨時券",
  };
}

/** 優先順序的字（chip、挑選器） */
export const PRIORITY_TEXT: Readonly<Record<Priority, string>> = { high: "高", mid: "中", low: "低" };

/** 長度分段鈕（契約 §一 A「15／30／60／90／120／自訂」） */
export const LENGTH_PRESETS: readonly number[] = [15, 30, 60, 90, 120];

/** 分鐘 → 「30 分」「1h30」 */
export function lengthText(min: number): string {
  if (min < 60) return `${min} 分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${m < 10 ? `0${m}` : m}` : `${h}h`;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** "2026-11-15" → "11/15（日）"（票面日期 chip 同款） */
export function dayText(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return `${m}/${d}（${WEEK[new Date(y, m - 1, d).getDay()]}）`;
}

/** 乘車日 chip 的字：今天／明天／後天＋其餘 M/D（週X）；若有區間訖日則印「M/D–M/D」 */
export function dateChipText(key: string, today: string): string {
  const diff = Math.round((Date.UTC(...ymd(key)) - Date.UTC(...ymd(today))) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "後天";
  return dayText(key);
}

export function dateRangeChipText(
  start: string,
  end: string | null | undefined,
  today: string,
  isMultiDay?: boolean,
): string {
  if (end && end > start) {
    const badge = formatDateRangeBadge(start, end);
    return isMultiDay === false ? `期間 ${badge}` : badge;
  }
  return dateChipText(start, today);
}

function ymd(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, (m || 1) - 1, d || 1];
}

/** 呼叫端在哪一頁（決定「票離開眼前」） */
export type QuickHere =
  | { kind: "today"; dateKey: string }
  | { kind: "route"; routeId: string }
  | { kind: "day"; day: string }
  | { kind: "none" };

/** 無日期、無路線的票進收件匣的收據（＝今日頁 Shift+Enter 以前那一句 INBOX_TOAST） */
export const INBOX_NOTE = "已放進收件匣——到旅客筆記整理";

/**
 * 建好的票不在眼前時的收據字（null＝還在眼前，不出 toast）。
 * routeName：路線 id → 名稱（建到別條路線時寫名字）。
 */
export function leaveNote(
  here: QuickHere,
  v: {
    scheduledOn: string | null;
    scheduledEnd?: string | null;
    isMultiDay?: boolean;
    target: QuickTarget;
    routeId: string | null;
  },
  routeName: (id: string) => string | null,
): string | null {
  const inbox = v.target.kind === "ticket" && !v.target.parentId && !v.target.routeTagId && !v.scheduledOn;
  const hasRange = Boolean(v.scheduledOn && v.scheduledEnd && v.scheduledEnd > v.scheduledOn);
  const rangeMsg = () =>
    v.isMultiDay
      ? `已排入多日 ${formatDateRangeBadge(v.scheduledOn!, v.scheduledEnd!)}`
      : `已排入期間 ${formatDateRangeBadge(v.scheduledOn!, v.scheduledEnd!)}`;
  const elsewhere = (): string => {
    if (inbox) return INBOX_NOTE;
    if (hasRange && v.scheduledOn && v.scheduledEnd) return rangeMsg();
    if (v.scheduledOn) return `已排到 ${dayText(v.scheduledOn)}`;
    const name = v.routeId ? routeName(v.routeId) : null;
    return name ? `已建到「${name}」` : "已建好";
  };
  switch (here.kind) {
    case "today":
      if (hasRange && v.scheduledOn && v.scheduledEnd) {
        return isRangeCoveringDay({ scheduled_on: v.scheduledOn, scheduled_end: v.scheduledEnd }, here.dateKey)
          ? null
          : elsewhere();
      }
      return v.scheduledOn === here.dateKey ? null : elsewhere();
    case "day":
      if (hasRange && v.scheduledOn && v.scheduledEnd) {
        return isRangeCoveringDay({ scheduled_on: v.scheduledOn, scheduled_end: v.scheduledEnd }, here.day)
          ? null
          : elsewhere();
      }
      return v.scheduledOn === here.day ? null : elsewhere();
    case "route": {
      if (v.routeId === here.routeId) return null;
      if (inbox) return INBOX_NOTE;
      const name = v.routeId ? routeName(v.routeId) : null;
      if (name) return `已建到「${name}」`;
      if (hasRange && v.scheduledOn && v.scheduledEnd) return rangeMsg();
      return v.scheduledOn ? `已排到 ${dayText(v.scheduledOn)}` : "已建好";
    }
    case "none":
      return null;
  }
}
