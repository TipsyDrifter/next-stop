/**
 * scheduleModel——日程 UI 的小工具（④ 契約 §5；乙席）。不讀 store、不碰 DOM，兩殼共用。
 *
 * - 縱軸：一天＝日界線窗 24 小時，位置一律用「窗內百分比」（＝週視圖 WeekGrid 的算法）。
 *   預定那一邊用 timeGridModel 的牆鐘分鐘（自 00:00 起，可 ≥ 1440）：pct＝(min − axisMin) / 1440；
 *   實績那一邊用毫秒：pct＝(t − 窗開始) / 窗長。兩者在非 DST 日完全重合。
 * - 差多少的字：完整說法一律走甲席的 `fmtPlanDelta`（§5.6）；桌機「差多少」欄把它拆成兩行、
 *   手機與窄桌機的單行短說法（D-時-87「晚25分・多15分」）在這裡組。
 * - TT_TEXT 沒有、只有畫面用得到的字放 `SCHED_UI`（回報有列）。
 */
import { MIN, fmtDur } from "../../../domain/timetable";
import { DUR_SAME_MIN, PLAN_TEXT, fmtPlanDelta, startOnTime, type PlanCompare, type PlanItem } from "../../../domain/timetableSchedule";

/** 畫面專用的字（TT_TEXT 沒有的；契約 §5 與原型的說法） */
export const SCHED_UI = {
  colPlan: "預定",
  colDelta: "差多少",
  colActual: "實績",
  prevDay: "前一天",
  nextDay: "後一天",
  toToday: "回到今天",
  yesterday: "昨天",
  tomorrow: "明天",
  deskKeys: "← → 換日・T 今天・拖曳吸附 15 分",
  pastNote: "過去的日子只能看：拖不動，點卡只看細節。",
  noRecord: "沒有紀錄",
  trayNoteEdit: "拖到預定欄，或點一下再點位置",
  trayNoteEditMobile: "點一下再點位置・長按拖",
  trayNoteRo: "只能看",
  trayEmptyPast: "這天沒有沒排的票",
  pickHintDesk: "點預定欄的位置排上去（或直接拖過去）",
  notYet: "還沒到",
  emptyPast: "這天沒有排時刻的票",
  dropMissed: "沒放到預定欄",
  dropMissedSub: "拖到「預定」那一欄才會排上去",
  open: "打開 ›",
  /** 「打開 ›」拆兩段：窄卡只留記號 */
  openWord: "打開 ",
  openMark: "›",
  repeat: "定期券",
  /** 誤點票在「還沒排」的標籤；有原本的時刻就一起印（照存的字，29:15 也照印；D-主-34） */
  lateTag: (md: string, time?: string | null) => (time ? `誤點・${md} ${time}` : `誤點・${md}`),
  temp: "臨時車票",
  dateLine: (md: string) => `執行日 ${md}`,
  /** 誤點的單發票（D-時-80 改題）：還在原日，時刻一寫就改到今天 */
  lateLine: (md: string) => `誤點・原定 ${md}（排上去＝改到今天）`,
  repeatLine: (rule: string, t: string | null) => `定期券・${rule}${t ? ` ${t}` : ""}`,
  estimate: "預計",
  actual: "實際",
  noEstimate: "沒填（畫 45 分虛線）",
  actualNone: { doneNoTime: "済了，沒有連到時間塊", future: "還沒到", past: "這天沒有紀錄", notStarted: "還沒開始" },
  /** n＝算進時長的塊數（待確認的不算，旁邊另標 actualPending） */
  actualTotal: (dur: string, n: number) => `共 ${dur}${n > 1 ? `（${n} 塊）` : ""}`,
  actualPending: "（待確認）",
  teikiNote: (rule: string) => `定期券：在這裡排＝只改這一班，規則照舊是${rule}`,
  teikiSkipped: "這一班運休（在車票上取消運休）",
  revert: (t: string) => `改回 ${t}`,
  /** 例子照日界線算（h=6 ⇒「5:00 → 29:00」）；h=0 沒有凌晨那段，不提 */
  timeHint: (h: number) =>
    h > 0 ? `可以打 ${24 + h - 1}:00；比日界線早的會算今天深夜（${h - 1}:00 → ${24 + h - 1}:00）` : "打 14:15 或 1415 都可以",
  timeNext: (note: string) => `＝${note}`,
  timeErrEmpty: "打一個時刻，例如 14:15；要清掉用「清除時刻」",
  timeErrBad: "看不懂這個時刻：打 14:15 或 1415",
  timeErrRange: (lo: string, hi: string) => `這一天的時刻在 ${lo}–${hi} 之間`,
  timePreview: (t: string, note: string | null) => `→ ${t} 発${note ? `　＝${note}` : ""}　Enter 套用`,
  runningNow: "運行中",
  departOnlyToday: "只有今天能発車",
  readonly: "過去的日子只能看",
} as const;

/** 窗內百分比（夾在 0–1）→ CSS 字 */
export const pct = (x: number): string => (Math.max(0, Math.min(1, x)) * 100).toFixed(3) + "%";

/** 預定那一邊：牆鐘分鐘 → 窗內比例 */
export const minFrac = (min: number, dayStartHour: number): number => (min - dayStartHour * 60) / 1440;

/** 窗內比例 → 牆鐘分鐘（未吸附） */
export const fracMin = (f: number, dayStartHour: number): number => dayStartHour * 60 + f * 1440;

/** 拖曳／點位置：比例 → 吸附 15 分、夾在 [軸頭, 軸尾−15] */
export function snapFrac(f: number, dayStartHour: number, step = 15): number {
  const lo = dayStartHour * 60;
  const hi = lo + 1440 - step;
  const m = Math.round(fracMin(f, dayStartHour) / step) * step;
  return Math.max(lo, Math.min(hi, m));
}

/** 「10/19（一）」 */
const WD = "日一二三四五六";
export function mdw(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${m}/${d}（${WD[new Date(y, m - 1, d).getDay()]}）`;
}

/** 卡與欄的語氣（＝原型 diffLines 的 tone） */
export type DeltaTone = "ok" | "off" | "live" | "late" | "done" | "cancel" | "future";

/**
 * 有實績、已結束的那幾種：比得出早晚的（onTime／late；D-時-81 改題後沒有「早」），
 * 加上只有前一天續過來的塊、開始那一半寫「接續前一天」的（carried；沙盒後修正 F4）
 */
const settledWithStart = (c: PlanCompare): boolean =>
  (c.startDeltaMin !== null || c.state === "carried") && c.state !== "running" && c.state !== "skipped";

export function toneOf(c: PlanCompare): DeltaTone {
  if (c.state === "onTime") return "ok";
  if (c.state === "running") return "live";
  if (c.state === "notStarted") return "late";
  if (c.state === "doneNoTime") return "done";
  if (c.state === "skipped") return "cancel";
  if (settledWithStart(c)) return "off"; // late、carried（不比早晚，語氣跟「晚」一樣平）
  return "future";
}

/** 完整說法（面板、title）：fmtPlanDelta；過去的日子沒做的＝「沒有紀錄」（D-時-86）；運休＝「運休」 */
export function deltaFull(item: PlanItem, c: PlanCompare, isPast: boolean, skippedText: string): string | null {
  if (c.state === "skipped") return skippedText;
  if (c.state === "notStarted" && isPast) return SCHED_UI.noRecord;
  return fmtPlanDelta(c, item.estimateMin);
}

/**
 * 開始那一段：準點與否一律聽甲席的判定（已結束＝state；運行中＝startOnTime），這裡只負責說法——
 * 準點的門檻（D-時-81：改題後「早開始或晚 10 分內」）只活在 domain 一處；提早也只寫「準點」（提早多少看刻度欄的金線）。
 */
function startKind(c: PlanCompare): "on" | "late" | "carried" | null {
  if (c.startDeltaMin === null) return c.carried ? "carried" : null;
  const on = c.state === "running" ? startOnTime(c) : c.state === "onTime";
  return on ? "on" : "late";
}

function startText(c: PlanCompare): string | null {
  const k = startKind(c);
  return k === null ? null : k === "on" ? PLAN_TEXT.onTime : k === "carried" ? PLAN_TEXT.carried : PLAN_TEXT.lateStart(c.startDeltaMin ?? 0);
}

/**
 * 桌機「差多少」欄（128px）的幾行：一行一個意思，免得擠成省略號。字一律是 PLAN_TEXT（＝fmtPlanDelta 用的那一份）。
 * 有實績：開始／長短；運行中：行駛中／開始／已 40m／預計 1h；其他狀態一行；待確認的補註另起一行。
 */
export function deltaLines(item: PlanItem, c: PlanCompare, isPast: boolean, skippedText: string): string[] {
  const out: string[] = [];
  const st = startText(c);
  if (c.state === "running") {
    // 語序同 fmtPlanDelta（§5.6「行駛中・晚 5 分開始・已…」）
    out.push(PLAN_TEXT.running);
    if (st) out.push(st);
    if (item.estimateMin) out.push(PLAN_TEXT.soFar(c.actualMs, item.estimateMin * MIN));
  } else if (settledWithStart(c)) {
    if (st) out.push(st);
    const dd = c.durDeltaMin;
    if (dd !== null && dd >= DUR_SAME_MIN) out.push(PLAN_TEXT.over(dd * MIN));
    else if (dd !== null && dd <= -DUR_SAME_MIN) out.push(PLAN_TEXT.under(-dd * MIN));
  } else {
    const full = deltaFull(item, c, isPast, skippedText);
    if (full) out.push(c.pendingCount > 0 ? full.replace(PLAN_TEXT.pendingNote(c.pendingCount), "") : full);
  }
  if (c.pendingCount > 0) out.push(PLAN_TEXT.pendingNote(c.pendingCount));
  return out;
}

const shortMin = (n: number): string => (n < 60 ? `${n}分` : fmtDur(n * MIN));

/** 單行短說法（手機卡、窄桌機卡；D-時-87）：「晚25分・多15分」「準點」「行駛中・已40m」；完整的點開看 */
export function deltaShort(item: PlanItem, c: PlanCompare, isPast: boolean, skippedText: string): string | null {
  const k = startKind(c);
  const d = c.startDeltaMin ?? 0;
  const start = k === null ? null : k === "on" ? PLAN_TEXT.onTime : k === "carried" ? PLAN_TEXT.carried : `晚${shortMin(d)}`;
  if (c.state === "running") return [PLAN_TEXT.running, start, `已${fmtDur(c.actualMs)}`].filter(Boolean).join(PLAN_TEXT.sep);
  if (settledWithStart(c)) {
    const parts = [start ?? ""];
    const dd = c.durDeltaMin;
    if (dd !== null && dd >= DUR_SAME_MIN) parts.push(`多${shortMin(dd)}`);
    else if (dd !== null && dd <= -DUR_SAME_MIN) parts.push(`少${shortMin(-dd)}`);
    return parts.filter(Boolean).join(PLAN_TEXT.sep);
  }
  return deltaFull(item, c, isPast, skippedText);
}

/** 字串裡的數字（含 4h30m 這種）包成粗體：總結行照 TT_TEXT 的字，只把數字抬起來（＝原型 .vh-sumline b） */
export function splitNums(s: string): { t: string; num: boolean }[] {
  const out: { t: string; num: boolean }[] = [];
  const re = /\d+h\d+m|\d+h|\d+m|\d+/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: s.slice(last, m.index), num: false });
    out.push({ t: m[0], num: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: s.slice(last), num: false });
  return out;
}
