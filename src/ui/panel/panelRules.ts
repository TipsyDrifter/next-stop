/**
 * 詳情面板的純規則——桌機側板（TaskFields／RepeatRuleEditor）與手機詳情頁（mobile/detail）**同一份**（手機殼班 D-主-82：同一個意思只有一個定義）。
 * 不碰 React、store、repository：`scripts/tests/panel-rules.test.ts` 用 node 直接載入（只准 `import type`＋帶 .ts 的 domain/repeat、domain/node）。
 * 寫入流程（現況改值、検印、運休、轉種類）在 `outline/nodeFlows.ts`；重複規則草稿的 React 那半（去抖寫回、外部改動重置）在 `./useRepeatDraft.ts`。
 *
 * 一、重複規則的草稿模型（M3 ④ WP3；D-主-78 手機照這份欄位）：模式／頻率／星期／每月／完成後／起算日，沒有「終止」。
 *   規矩：「是不是定期券」只認 parseRule；規則不完整（每週沒選星期／每月沒填日／完成後沒填天數）**不送**——
 *   送出去 parseRule 會 null，等於把票清成乘車券；切進「固定排程」預帶起算日的星期／號數，一點就是完整規則（M3 ④ 評審 should-8）。
 * 二、票種轉換（手機詳情頁的乘車券⇄定期券）＝重複模式的捷徑：切定期券＝在編輯器點「固定排程」那一下；切回＝「不重複」。
 * 三、現況／検印：定期券三態、現況可選格、検印區怎麼畫與章旁那句。
 * 四、子孫數的那把尺（改已完成要不要問「連同 N 個」、刪除要不要確認）：樹裡算到底，不在樹裡數不清就回 null。
 */
import type { NodeKind, NodeRow, NodeStatus, Priority, RepeatFreq, RepeatRule } from "../../domain";
import type { CurrentOccurrence } from "../../data/nodeRepository";
import { KIND_LABEL, canHaveChildren } from "../../domain/node.ts";
import { WEEKDAY_LABEL, afterRule, describeRule, fixedRule, parseRule } from "../../domain/repeat.ts";

/* ───────────── 一、重複規則草稿 ───────────── */

export type EditMode = "none" | "fixed" | "after";

export interface RepeatDraft {
  mode: EditMode;
  freq: RepeatFreq;
  /** getDay() 索引（0＝日）；畫面排列順序另看 WEEKDAY_ORDER */
  byweekday: number[];
  /** v1 只給一個日子（規則 JSON 仍是陣列，引擎認多個） */
  monthday: number | null;
  days: number | null;
  start: string;
}

export const MODE_OPTIONS: readonly { value: EditMode; label: string }[] = [
  { value: "none", label: "不重複" },
  { value: "fixed", label: "固定排程" },
  { value: "after", label: "完成後間隔" },
];

export const FREQ_OPTIONS: readonly { value: RepeatFreq; label: string }[] = [
  { value: "daily", label: "每日" },
  { value: "weekly", label: "每週" },
  { value: "monthly", label: "每月" },
];

/** 節點現況 → 草稿。起算日：規則裡的 start ＞ 執行日 ＞ 今天（D-④-6） */
export function draftOf(node: Pick<NodeRow, "repeat_rule" | "scheduled_on">, today: string): RepeatDraft {
  const rule = parseRule(node.repeat_rule);
  const start = rule?.start ?? node.scheduled_on ?? today;
  if (!rule) return { mode: "none", freq: "daily", byweekday: [], monthday: null, days: null, start };
  if (rule.mode === "after") {
    return { mode: "after", freq: "daily", byweekday: [], monthday: null, days: rule.days, start: rule.start };
  }
  return {
    mode: "fixed",
    freq: rule.freq,
    byweekday: rule.byweekday ?? [],
    monthday: rule.bymonthday?.[0] ?? null,
    days: null,
    start: rule.start,
  };
}

/** 草稿 → 規則；`null`＝「不重複」或**規則還不完整**（兩者由 draft.mode 分辨） */
export function buildRule(d: RepeatDraft): RepeatRule | null {
  if (d.mode === "none") return null;
  if (d.mode === "after") return d.days && d.days >= 1 ? afterRule(d.days, d.start) : null;
  if (d.freq === "weekly") {
    return d.byweekday.length ? fixedRule("weekly", d.start, { byweekday: [...d.byweekday].sort((a, b) => a - b) }) : null;
  }
  if (d.freq === "monthly") return d.monthday ? fixedRule("monthly", d.start, { bymonthday: [d.monthday] }) : null;
  return fixedRule("daily", d.start);
}

/** 日期 key 的星期（getDay 索引）；只用本地 new Date(y,m-1,d)，不經 Date.parse（④ 的坑） */
export function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).getDay() : new Date().getDay();
}

/** 切進「固定排程」／換頻率時把缺的欄位預帶成一條完整規則：每週＝起算日那個星期、每月＝起算日的號數 */
export function fillFixed(d: RepeatDraft): RepeatDraft {
  if (d.freq === "weekly" && !d.byweekday.length) return { ...d, byweekday: [weekdayOfKey(d.start)] };
  if (d.freq === "monthly" && !d.monthday) return { ...d, monthday: Number(d.start.slice(8, 10)) || 1 };
  return d;
}

/** 換模式（「模式」那排的 onChange）：完成後間隔沒填過天數＝1、固定排程補齊 */
export function switchMode(d: RepeatDraft, mode: EditMode): RepeatDraft {
  if (mode === d.mode) return d;
  if (mode === "after") return { ...d, mode: "after", days: d.days ?? 1 };
  if (mode === "fixed") return fillFixed({ ...d, mode: "fixed" });
  return { ...d, mode };
}

/** 票種轉換：定期券＝切「固定排程」、乘車券＝「不重複」（檔頭二） */
export function switchFare(d: RepeatDraft, teiki: boolean): RepeatDraft {
  return switchMode(d, teiki ? (d.mode === "none" ? "fixed" : d.mode) : "none");
}

/** 最後一顆星期為什麼熄不掉（兩殼點了都吐這句；第三輪桌機補上——原本點了什麼都不發生） */
export const LAST_WEEKDAY_WHY = "每週至少要選一天";

/**
 * 有子項的列車／車廂為什麼不能設重複（桌機重複段那句灰字、手機重複段的段頭小字與「定期券」格點了的 toast，兩殼同一句）。
 * 主詞照種類（車廂就寫車廂；第三輪——原本一律寫「列車」）。repository 擋下時的原句另在 data 層，不是這句。
 */
export function repeatKidsWhy(kind: NodeKind): string {
  return `有子項的${KIND_LABEL[kind]}不能設重複`;
}

/**
 * 星期 chip：點一下開／關；**最後一顆不給熄**（每週至少要有一天，熄了規則就不完整、寫不回去）——
 * 熄不掉時原樣回傳**同一個陣列**（呼叫端用 `===` 認出「沒變」，兩殼都吐 LAST_WEEKDAY_WHY）。
 */
export function toggleWeekday(days: number[], d: number): number[] {
  const on = days.includes(d);
  if (on && days.length === 1) return days;
  return on ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b);
}

/** 規則還缺什麼（完整時回 null） */
export function missingHint(d: RepeatDraft): string | null {
  if (d.mode === "none") return null;
  if (d.mode === "after") return d.days && d.days >= 1 ? null : "填一個天數";
  if (d.freq === "weekly") return d.byweekday.length ? null : "選一個星期";
  if (d.freq === "monthly") return d.monthday ? null : "填一個日子";
  return null;
}

/**
 * 「重複」段標題右邊那句：完整＝describeRule；不完整而庫裡還有舊規則＝「仍照『…』發車——…後生效」
 * （規則不完整時不送，票仍照庫裡那條發車——把這個真相說出口）；不重複＝「不重複」（桌機段頭不印，手機段頭收合時要有字）。
 */
export function repeatAside(d: RepeatDraft, savedRuleJson: string | null | undefined): string {
  const rule = buildRule(d);
  if (rule) return describeRule(rule);
  const hint = missingHint(d);
  const saved = parseRule(savedRuleJson);
  if (hint && saved) return `仍照「${describeRule(saved)}」發車——${hint}後生效`;
  return hint ?? "不重複";
}

/** 日期 key → 「10/12（週一）」（検印段頭的本班日、手機詳情頁的日期列）；只用本地 new Date(y,m-1,d) */
export function mdwText(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return `${m}/${d}（週${WEEKDAY_LABEL[new Date(y, m - 1, d).getDay()]}）`;
}

/* ───────────── 三、現況／検印 ───────────── */

export const STATUS_OPTIONS: readonly { value: NodeStatus; label: string }[] = [
  { value: "todo", label: "未開始" },
  { value: "doing", label: "進行中" },
  { value: "done", label: "已完成" },
  { value: "paused", label: "途中下車" },
];

export const PRIORITY_OPTIONS: readonly { value: Priority; label: string }[] = [
  { value: "low", label: "低" },
  { value: "mid", label: "中" },
  { value: "high", label: "高" },
];

/**
 * 定期券的三態（M3 ④）：teiki＝活著的定期券（済蓋在班次上）；retired＝掛著規則但 status='done'（退役；
 * 走一般那一套，取消済＝解除退役重新排班——否則検印讀不到班次、側板變死區，M3 ④ 評審 should-5）。
 */
export function teikiState(node: Pick<NodeRow, "repeat_rule" | "status">): { teiki: boolean; retired: boolean } {
  const ruled = parseRule(node.repeat_rule) !== null;
  return { teiki: ruled && node.status !== "done", retired: ruled && node.status === "done" };
}

/** 現況可選的格：活著的定期券不給「已完成」（＝退役，v1 不從這裡做；済要蓋在検印的那一班上），並附一句指路 */
export function statusChoices(node: Pick<NodeRow, "repeat_rule" | "status">): {
  options: readonly { value: NodeStatus; label: string }[];
  note: string | null;
} {
  const { teiki } = teikiState(node);
  return teiki
    ? { options: STATUS_OPTIONS.filter((o) => o.value !== "done"), note: "定期券：在検印欄蓋班次" }
    : { options: STATUS_OPTIONS, note: null };
}

export interface StampView {
  /** teiki＝本班済／運休＋本班時刻；plain＝車票的済章；none＝不畫検印（列車／車廂用現況） */
  mode: "teiki" | "plain" | "none";
  done: boolean;
  suspended: boolean;
  /** 本班日（teiki 才有意義）＝班次 due_on ＞ scheduled_on——交代完的票 scheduled_on 已指向下一班，直接印會說謊 */
  railDate: string | null;
  /** 章旁那句 */
  meta: string;
  /** 章這顆鈕做什麼（讀屏名稱） */
  action: string;
  /** 退役定期券的指路句；不是退役＝null */
  retiredNote: string | null;
}

/** 検印區怎麼畫：車票＝済章、定期券（任何種類）＝本班済／運休、列車／車廂＝只有定期券才有検印、退役的印一句指路 */
export function stampViewOf(
  node: Pick<NodeRow, "kind" | "repeat_rule" | "status" | "scheduled_on">,
  occ: CurrentOccurrence | undefined,
): StampView {
  const { teiki, retired } = teikiState(node);
  const ticket = node.kind === "ticket";
  if (teiki) {
    const done = occ?.status === "done";
    const suspended = occ?.status === "skipped";
    return {
      mode: "teiki",
      done,
      suspended,
      railDate: occ?.due_on ?? node.scheduled_on,
      meta: done ? "本班已済" : suspended ? "本班運休" : "點一下蓋本班",
      action: suspended ? "取消本班運休" : done ? "取消本班済章" : "蓋本班済章",
      retiredNote: null,
    };
  }
  const done = node.status === "done";
  return {
    mode: ticket ? "plain" : "none",
    done,
    suspended: false,
    railDate: null,
    meta: done ? "已完成" : "點一下蓋章",
    action: done ? "取消完成" : "蓋章完成",
    retiredNote: retired ? (ticket ? "定期券已停用——取消済章就會重新排班" : "定期券已停用——更改狀態就會重新排班") : null,
  };
}

/* ───────────── 四、子孫數 ───────────── */

/**
 * 子孫數（未完成的或全部，看呼叫端給哪個 treeCount）——nodeFlows.openKidsOf（改已完成）與 useMobileToday.liveChildCount（刪除）的判準
 * （手機殼班第三輪，D-主-83）：
 *   - 車票、車站不能有子項＝0。
 *   - 已載入的路線樹有這張＝`treeCount`（呼叫端用樹算到底；不在樹裡傳 null）。
 *   - 不在樹裡只剩今日切片的 child_total——那是**直屬**數（SQL 只數 parent_id＝自己），而列車、車廂底下都可能再套一層
 *     （allowedChildKinds("car")＝車廂＋車票），直屬數不能冒充子孫數 ⇒ 有子項＝null（不知道，呼叫端一律先問）；切片說沒有＝0。
 *   - 切片也沒有這張＝null。
 */
export function kidCountOf(
  kind: NodeKind,
  treeCount: number | null,
  slice: { child_total: number } | undefined,
): number | null {
  if (!canHaveChildren(kind)) return 0;
  if (treeCount !== null) return treeCount;
  if (!slice) return null;
  return slice.child_total > 0 ? null : 0;
}
