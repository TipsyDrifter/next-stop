/**
 * 建票列的規則（回饋甲 D-主-127、128、135；契約 §一 A）——純函式，桌機票形草稿列與手機底部輸入列共用。
 *
 *   - 值的來源有三層：chip 設的 ＞ 文字認出來的（domain/quickAdd parseQuickAdd）＞ 呼叫端給的預設（掛到、執行日）。
 *     chip 改值時文字裡同種片段一起拿掉（useQuickAdd 叫 stripTokens），所以「chip 優先」只是保險。
 *   - 掛到決定建成什麼（resolveQuickTarget）：無路線＝臨時車票；路線／支線＝列車｜車票二選一（車票＝掛路線標籤的臨時車票）；
 *     列車／車廂＝車票。父節點規則照 allowedChildKinds 走、不寫死（巢狀放寬後自動跟上）。
 *   - toast 只在「票離開眼前」時出（leaveNote）：無日期進收件匣、建到別天、建到別條路線。
 */
// 帶 .ts 副檔名、只 import 純函式模組：scripts/tests/quick-add-model.test.ts 以 node 直接載入
import { allowedChildKinds, KIND_LABEL, type NodeKind, type Priority } from "../../../domain/node.ts";
import type { AttachTarget } from "../../../domain/notes.ts";
import type { QuickAddParse, QuickTokenKind } from "../../../domain/quickAdd.ts";

/** 掛到哪（＝AttachPicker 的值）；routeId null＝無路線 */
export type QuickDest = AttachTarget;
export const NO_DEST: QuickDest = { routeId: null, nodeId: null, nodeKind: null };

/** 掛到路線（或支線）時建成什麼：列車＝路線底下的列車；車票＝掛這條路線標籤的臨時車票 */
export type RouteKind = "train" | "ticket";

/** chips 的六格（也是挑選器的 key） */
export type QuickChipKey = "dest" | "date" | "time" | "due" | "priority" | "tags";

/** 每格 chip 改值時要從文字裡拿掉的片段種類（幾點那格管開始＋長度兩種） */
export const CHIP_TOKENS: Readonly<Record<QuickChipKey, readonly QuickTokenKind[]>> = {
  dest: ["dest"],
  date: ["date"],
  time: ["time", "length"],
  due: ["due"],
  priority: ["priority"],
  tags: ["tag"],
};

/** chip 設的值；欄位不存在＝這格沒用 chip 設（看文字、再看預設） */
export interface QuickChips {
  dest?: QuickDest;
  scheduledOn?: string | null;
  scheduledTime?: string | null;
  estimateMin?: number | null;
  dueOn?: string | null;
  priority?: Priority | null;
  tags?: readonly string[];
}

/** 呼叫端給的預設（今日＝無路線＋今天；路線圖＝這條路線＋無日期；串流＝那一天） */
export interface QuickDefaults {
  dest: QuickDest;
  scheduledOn: string | null;
  /** 執行日空著時 chip 寫「無日期」（今日 Shift+Enter、手機今日）；false＝空著就是空著（路線圖：列車本來就不一定排日子） */
  noDateLabel?: boolean;
}

/** 合起來的結果：送出時寫進去的值 */
export interface QuickValues {
  name: string;
  dest: QuickDest;
  scheduledOn: string | null;
  scheduledTime: string | null;
  estimateMin: number | null;
  dueOn: string | null;
  priority: Priority | null;
  tags: string[];
  /** 「設過」的格（從文字認出來或點 chip 改過）＝chip 亮起 */
  on: ReadonlySet<QuickChipKey>;
}

/**
 * 三層合一。`nodeKindOf` 把文字 @路線/列車 認出來的節點 id 換成種類（列車或車廂；查不到當列車）。
 * `positional`（大綱位置型草稿列）：掛到由位置決定，不看 @。
 */
export function mergeQuick(
  parse: QuickAddParse,
  chips: QuickChips,
  defaults: QuickDefaults,
  nodeKindOf: (id: string) => QuickDest["nodeKind"],
  positional = false,
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
  const v: QuickValues = {
    name: parse.name,
    dest: pick("dest", chips.dest, typedDest, defaults.dest),
    scheduledOn: pick("date", chips.scheduledOn, parse.scheduledOn, defaults.scheduledOn),
    scheduledTime: timeOn ? (chips.scheduledTime ?? null) : (typedTime ?? null),
    estimateMin: timeOn ? (chips.estimateMin ?? null) : (parse.estimateMin ?? null),
    dueOn: pick("due", chips.dueOn, parse.dueOn, null),
    priority: pick("priority", chips.priority, parse.priority, null),
    tags: [],
    on,
  };
  if (timeOn || typedTime !== undefined || parse.estimateMin !== undefined) {
    if (v.scheduledTime !== null || v.estimateMin !== null) on.add("time");
  }
  if (chips.tags !== undefined) {
    v.tags = [...chips.tags];
    if (v.tags.length) on.add("tags");
  } else if (parse.tags.length) {
    v.tags = parse.tags.map((t) => t.name);
    on.add("tags");
  }
  // 清掉的值不算「設過」（chip 清成無日期也還是亮：那是主人的明確選擇，收件匣）
  if (v.dueOn === null) on.delete("due");
  if (v.priority === null) on.delete("priority");
  return v;
}

/** 建成什麼 */
export interface QuickTarget {
  kind: NodeKind;
  parentId: string | null;
  /** 臨時車票的路線標籤 */
  routeTagId: string | null;
  /** 掛到路線（或支線）＝可在「列車｜車票」之間選 */
  canChoose: boolean;
}

/** 掛到 → 建成什麼（契約 §一 A「掛到決定建成什麼」；種類跟 allowedChildKinds 走） */
export function resolveQuickTarget(dest: QuickDest, routeKind: RouteKind): QuickTarget {
  if (!dest.routeId) return { kind: "ticket", parentId: null, routeTagId: null, canChoose: false };
  const parentId = dest.nodeId ?? dest.routeId;
  const parentKind: NodeKind = dest.nodeId ? (dest.nodeKind && dest.nodeKind !== "route" ? dest.nodeKind : "train") : "route";
  const allowed = allowedChildKinds(parentKind);
  if (allowed.includes("ticket")) return { kind: "ticket", parentId, routeTagId: null, canChoose: false };
  // 路線／支線：底下放列車；或建成掛這條路線標籤的臨時車票（現行規則：車票不直接掛在路線底下）
  const inner: NodeKind | undefined = allowed.includes("train") ? "train" : allowed.find((k) => k !== "station");
  if (!inner || routeKind === "ticket") {
    return { kind: "ticket", parentId: null, routeTagId: dest.routeId, canChoose: !!inner };
  }
  return { kind: inner, parentId, routeTagId: null, canChoose: true };
}

/** 票根的長相：徽章字、徽章虛線、票根小字、票種（右上角） */
export interface QuickStubLook {
  badge: string;
  dashed: boolean;
  lineName: string;
  fare: string;
}

const BADGE: Partial<Record<NodeKind, string>> = { train: "列", car: "廂", ticket: "票", branch: "支" };

export function stubLook(t: Pick<QuickTarget, "kind" | "parentId" | "routeTagId">): QuickStubLook {
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

/** 執行日 chip 的字：今天／明天／後天＋其餘 M/D（週X） */
export function dateChipText(key: string, today: string): string {
  const diff = Math.round((Date.UTC(...ymd(key)) - Date.UTC(...ymd(today))) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "後天";
  return dayText(key);
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
  v: { scheduledOn: string | null; target: QuickTarget; routeId: string | null },
  routeName: (id: string) => string | null,
): string | null {
  const inbox = v.target.kind === "ticket" && !v.target.parentId && !v.target.routeTagId && !v.scheduledOn;
  const elsewhere = (): string => {
    if (inbox) return INBOX_NOTE;
    if (v.scheduledOn) return `已排到 ${dayText(v.scheduledOn)}`;
    const name = v.routeId ? routeName(v.routeId) : null;
    return name ? `已建到「${name}」` : "已建好";
  };
  switch (here.kind) {
    case "today":
      return v.scheduledOn === here.dateKey ? null : elsewhere();
    case "day":
      return v.scheduledOn === here.day ? null : elsewhere();
    case "route": {
      if (v.routeId === here.routeId) return null;
      if (inbox) return INBOX_NOTE;
      const name = v.routeId ? routeName(v.routeId) : null;
      if (name) return `已建到「${name}」`;
      return v.scheduledOn ? `已排到 ${dayText(v.scheduledOn)}` : "已建好";
    }
    case "none":
      return null;
  }
}
