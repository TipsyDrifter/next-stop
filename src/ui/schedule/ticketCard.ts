/**
 * ticketCard——手機票卡模型（主線車次①；契約 §3.7）。
 *
 * 手機今日子頁與行程表串流共用同一支 `MobileTicket`，但資料來源不同（今日切片 `TodayRow`／日曆切片的
 * `DayRowModel`／締切層的 `NodeRow`）。三個轉換函式把三種來源摺成同一個 `TicketCardModel`，元件只畫欄位、不再判口徑。
 *
 *   cardFromTodayRow  **逐欄重現** MobileTicket.tsx:55-96 的算法——今日子頁畫面一個像素都不能變
 *   cardFromDayRow    串流班次列（`dayRowModel`＝日曆同一把尺；`canStampRow` 決定能不能蓋、`stampHint` 用 DayRow.tsx:150-162 的句子）
 *   cardFromDue       「只在締切日浮出來」的單發票（沒有執行日；契約 §0-1 第 14 條）
 */
import { describeRule, parseRule, type NodeKind, type NodeRow } from "../../domain";
import type { TodayRow } from "../../data";
import { isTimeOverridden, timeOfRow } from "../../domain/scheduledTime";
import { canStampRow, mmdd, type DayRowModel } from "../calendar/DayRow";

export interface TicketCardModel {
  /** 今日：node id；串流：dayRowModel.key；締切卡：`due-${date}-${id}` */
  key: string;
  nodeId: string;
  name: string;
  kind: NodeKind;
  routeId: string | null;
  /** null＝不畫票號（§0-1 第 12 條：手機沒載過票號表） */
  serial: string | null;
  /** MobileTicket.tsx:68 同一條 */
  fare: "定期券" | "臨時券" | "乘車券";
  /** describeRule(rule) */
  ruleText: string | null;
  isRepeat: boolean;
  /** 節點執行日（sheet 判「清除執行日」） */
  scheduledOn: string | null;
  /** 這張卡在講的那一天（今日：occurrence?.due_on ?? scheduled_on；串流：entry.date；締切卡：due_on） */
  railDate: string | null;
  dueOn: string | null;
  carriedFrom: string | null;
  done: boolean;
  suspended: boolean;
  paused: boolean;
  /** carry＝今日頁誤點區（原定 M/D・延誤 N 天）；inday＝串流原日（誤點中・延誤 N 天）；due＝締切浮出（締切 M/D 赭 chip）；null */
  late: "carry" | "inday" | "due" | null;
  /** 串流恆 null */
  children: { done: number; total: number } | null;
  /** 今日恆 true；串流＝canStampRow(row) */
  stampable: boolean;
  /** stampable=false 時按下去吐的那一句 */
  stampHint: string | null;
  /** 定期券歷史班次（row.isHistory） */
  readOnly: boolean;
  /** 這張卡講的那一班的有效時刻（主線②）；null＝沒填。誤點卡也填（契約 §0-1 第 19 條）；締切卡講的是締切日不是班次 ⇒ null */
  time: string | null;
  /** 來自逐班覆寫（卡上「本班」靛字） */
  timeOverridden: boolean;
  /** 每班／單發票的時刻（node.scheduled_time；sheet aside 用） */
  ruleTime: string | null;
  /** 預計（D-主-12「・90 分」） */
  estimateMin: number | null;
  /** 入鋏中（status === "doing"）：已過時刻也不轉赭（§4.5-1） */
  doing: boolean;
}

/** MobileTicket.tsx:68 同一條：定期券＞臨時券（根層車票）＞乘車券 */
function fareOf(isRepeat: boolean, parentId: string | null): TicketCardModel["fare"] {
  return isRepeat ? "定期券" : parentId === null ? "臨時券" : "乘車券";
}

/**
 * 今日切片的一列 → 卡（MobileTicket.tsx:55-96 逐欄）。
 * `today` 收著不用：「延誤 N 天」與締切 chip 的赭色仍由 MobileTicket 以 `today` prop 算（元件那段沒搬），
 * 簽名留著是契約 §3.7 的形狀——三支轉換函式同款。
 */
export function cardFromTodayRow(row: TodayRow, _today: string): TicketCardModel {
  const rule = parseRule(row.repeat_rule);
  const done = row.occurrence ? row.occurrence.status === "done" : row.status === "done";
  const suspended = row.occurrence?.status === "skipped";
  const settled = done || suspended;
  return {
    key: row.id,
    nodeId: row.id,
    name: row.name,
    kind: row.kind,
    routeId: row.route_id,
    serial: row.serial,
    fare: fareOf(rule !== null, row.parent_id),
    ruleText: rule ? describeRule(rule) : null,
    isRepeat: rule !== null,
    scheduledOn: row.scheduled_on,
    railDate: row.occurrence?.due_on ?? row.scheduled_on,
    dueOn: row.due_on,
    carriedFrom: row.carried_from,
    done,
    suspended,
    paused: row.status === "paused" && !settled,
    late: row.bucket === "late" ? "carry" : row.bucket === "due" ? "due" : null,
    children: row.child_total > 0 ? { done: row.child_done, total: row.child_total } : null,
    stampable: true,
    stampHint: null,
    readOnly: false,
    time: timeOfRow(row),
    timeOverridden: isTimeOverridden(row, row.occurrence?.due_on ?? row.scheduled_on),
    ruleTime: row.scheduled_time,
    estimateMin: row.estimate_min,
    // 入鋏只算目前那一班：定期券的誤點班次（occurrence.due_on ≠ scheduled_on）不算
    doing: row.status === "doing" && (rule === null || (row.occurrence?.due_on ?? row.scheduled_on) === row.scheduled_on),
  };
}

/** DayRow.tsx:150-162 的同一組句子（只取「按不得」的分支；能按的卡 hint 為 null） */
function stampHintOf(row: DayRowModel): string | null {
  if (canStampRow(row)) return null;
  if (row.skipped) return "歷史班次唯讀——運休只能對目前或未來的班次";
  if (row.done) return "歷史班次唯讀";
  return row.isRepeat && (row.ahead || row.isFuture)
    ? `這班要到 ${mmdd(row.entry.date)} 才能蓋——済只蓋目前班次`
    : "歷史班次唯讀——只能交代目前班次";
}

/**
 * 串流班次列 → 卡。`today` 收著不用：歷史／未來／誤點都已由 `dayRowModel(…, today)` 算進 row（`late`＝entry.is_late），
 * 這裡不再判一次日期；簽名照契約 §3.7。
 */
export function cardFromDayRow(row: DayRowModel, serial: string | null, _today: string): TicketCardModel {
  const node = row.node;
  const rule = node ? parseRule(node.repeat_rule) : null;
  const settled = row.done || row.skipped;
  return {
    key: row.key,
    nodeId: row.entry.node_id,
    name: node?.name ?? "",
    kind: node?.kind ?? "ticket",
    routeId: node?.route_id ?? null,
    serial,
    fare: fareOf(row.isRepeat, node?.parent_id ?? null),
    ruleText: rule ? describeRule(rule) : null,
    isRepeat: row.isRepeat,
    scheduledOn: node?.scheduled_on ?? null,
    railDate: row.entry.date,
    dueOn: node?.due_on ?? null,
    carriedFrom: node?.carried_from ?? null,
    done: row.done,
    suspended: row.skipped,
    paused: node?.status === "paused" && !settled,
    late: row.late && !row.done && !row.skipped ? "inday" : null,
    children: null,
    stampable: canStampRow(row),
    stampHint: stampHintOf(row),
    readOnly: row.isHistory,
    time: row.entry.time,
    timeOverridden: node ? isTimeOverridden(node, row.entry.date) : false,
    ruleTime: node?.scheduled_time ?? null,
    estimateMin: node?.estimate_min ?? null,
    // 入鋏只算目前那一班（同 DayRow／TimeGrid）：定期券 status=doing 時，別的誤點班次照轉赭
    doing: node?.status === "doing" && (!row.isRepeat || node.scheduled_on === row.entry.date),
  };
}

/**
 * 締切層的單發票（沒有執行日、只在締切日浮出來）→ 卡。
 * `late = date <= today ? "due" : null`（MobileTicket.tsx:83 同一把尺）；一律可蓋、不唯讀。
 */
export function cardFromDue(node: NodeRow, date: string, serial: string | null, today: string): TicketCardModel {
  const rule = parseRule(node.repeat_rule);
  const done = node.status === "done";
  return {
    key: `due-${date}-${node.id}`,
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    routeId: node.route_id,
    serial,
    fare: fareOf(rule !== null, node.parent_id),
    ruleText: rule ? describeRule(rule) : null,
    isRepeat: rule !== null,
    scheduledOn: node.scheduled_on,
    railDate: date,
    dueOn: node.due_on,
    carriedFrom: node.carried_from,
    done,
    suspended: false,
    paused: node.status === "paused" && !done,
    late: date <= today ? "due" : null,
    children: null,
    stampable: true,
    stampHint: null,
    readOnly: false,
    // 締切卡講的是締切日、不是某一班 ⇒ 不印時刻（契約 §3.7）；ruleTime／estimateMin 留給 sheet 用
    time: null,
    timeOverridden: false,
    ruleTime: node.scheduled_time,
    estimateMin: node.estimate_min,
    doing: node.status === "doing" && (rule === null || node.scheduled_on === date),
  };
}
