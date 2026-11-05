/**
 * routineModel——日程的作息帶與車票分段的小工具（⑦ 契約 §3、§4；原型回報 1、2、4、✎4–6；C 席）。不讀 store、不碰 DOM，兩殼共用。
 *
 * - 作息帶的短說法（原型回報 1、✎5）：桌機「準點」「晚 20 分」＋「少 30 分」、「沒記到」；手機「準點」「晚 20」、「沒記」——不用 ◆。
 *   完整句子一律走 domain 的 `fmtRoutineDelta`（tooltip、面板）。
 * - 車票「第 N 段」（原型回報 4、✎6）：照時間先後把所有段（第一段＝主線的「執行日＋幾點」、第二段起＝time_plans）一起數；只有一段不印。
 * - 畫面專用的字放 `RT_UI`（回報有列）。
 * 值的 import 一律帶 `.ts`（`node --test` 直載：`scripts/tests/timetable-7-ui-model.test.ts`）。
 */
import { MIN, fmtDur } from "../../../domain/timetable.ts";
import { DUR_SAME_MIN, ON_TIME_LATE_MIN } from "../../../domain/timetableSchedule.ts";
import { slotsOfNode, type RoutineCompare, type TimePlanRow } from "../../../domain/timetableRoutine.ts";
import { clockMinutes } from "../../../lib/date.ts";
import type { NodeRow } from "../../../domain/node";

/** 作息帶與選單、面板的字 */
export const RT_UI = {
  col: "作息",
  pickWord: "作息",
  off: "不套",
  empty: "＋作息範本",
  menuLabel: "這天的作息",
  menuHead: (md: string, name: string | null) => (name ? `${md}照「${name}」` : `${md}不套作息`),
  switchTo: (n: string) => `換成「${n}」`,
  applyTo: (n: string) => `套用「${n}」`,
  switchMore: "換成別套…",
  reapply: "重新套用",
  skipDay: "這天不套",
  addSeg: "＋加一段",
  editTpl: "編輯範本…",
  back: "‹ 返回",
  /** 那套範本 0 段（或讀不懂）：選單上停用、括號寫這句 */
  noSegs: "還沒有段",
  pastWhy: "過去的日子只能看",
  /** 未來日（虛擬）只寫段數（✎4） */
  sumFuture: (n: number) => `作息 ${n} 段`,
  /** 手機總結第二行：鈕已經寫「作息」，後面只接數字 */
  sumMobile: (n: number, ok: number | null) => (ok === null ? `${n} 段` : `${n} 段・照表 ${ok}`),
  /* 面板 */
  name: "名字",
  start: "開始",
  end: "結束",
  actual: "實際",
  del: "刪這段",
  deleted: "已刪除這段",
  onSchedule: "照表",
  upcoming: "還沒到",
  notStarted: "還沒開始",
  missed: (cat: string) => `這段時間沒有記到「${cat}」`,
  readonly: "過去的日子只能看",
  namePh: (cat: string) => cat || "名字",
  added: (s: string, e: string) => `已加一段 ${s}–${e}`,
} as const;

/** 車票分段的字（面板） */
export const SEG_UI = {
  rowKey: "分段",
  count: (n: number) => `共 ${n} 段`,
  again: "再排一段",
  move: "換位置",
  pickAdd: (name: string, len: string) => `點預定欄的位置排上去・${name} ${len}`,
  pickMove: (name: string, tag: string) => `點預定欄的位置移過去・${name}${tag ? " " + tag : ""}`,
  dateLine: (md: string) => `這一段在 ${md}`,
} as const;

export type RtTone = "ok" | "late" | "miss" | "live" | "wait";

/** 窄帶上的短說法（一行一個意思）；upcoming ⇒ []（還沒到開始時刻不比） */
export function rtShortLines(c: RoutineCompare, desk: boolean): { t: string; tone: RtTone }[] {
  const n = (m: number): string => (m < 60 ? (desk ? `${m} 分` : `${m}`) : fmtDur(m * MIN));
  const start = (): { t: string; tone: RtTone } | null => {
    const d = c.startDeltaMin;
    if (d === null) return null;
    return d > ON_TIME_LATE_MIN ? { t: `晚 ${n(d)}`, tone: "late" } : { t: "準點", tone: "ok" };
  };
  const out: { t: string; tone: RtTone }[] = [];
  switch (c.state) {
    case "upcoming":
      return out;
    case "missed":
      out.push({ t: desk ? "沒記到" : "沒記", tone: "miss" });
      return out;
    case "notStarted":
      out.push({ t: desk ? "還沒開始" : "還沒", tone: "wait" });
      return out;
    case "running": {
      out.push({ t: "運行中", tone: "live" });
      const s = start();
      if (s) out.push(s);
      return out;
    }
    default: {
      const s = start();
      if (s) out.push(s);
      const dd = c.durDeltaMin;
      if (dd !== null && dd <= -DUR_SAME_MIN) out.push({ t: `少 ${n(-dd)}`, tone: "wait" });
      else if (dd !== null && dd >= DUR_SAME_MIN) out.push({ t: `多 ${n(dd)}`, tone: "wait" });
      return out;
    }
  }
}

/**
 * 一張票的「第 N 段」：第一段（單發票的執行日＋幾點）＋第二段起（活著的），照日子、開始時刻排；
 * which＝"main"（第一段）或 time_plans 的 id。找不到 ⇒ null；total＝總段數（只有一段時畫面不印牌子）。
 */
export function segNumberOf(
  node: Pick<NodeRow, "scheduled_on" | "scheduled_time" | "repeat_rule"> | undefined,
  nodeId: string,
  slotRows: readonly TimePlanRow[] | undefined,
  which: string,
): { n: number; total: number } | null {
  const segs: { id: string; day: string; min: number }[] = [];
  if (node && node.scheduled_on && node.scheduled_time && !(node.repeat_rule && node.repeat_rule.trim())) {
    segs.push({ id: "main", day: node.scheduled_on, min: clockMinutes(node.scheduled_time) ?? 0 });
  }
  for (const r of slotsOfNode(slotRows ?? [], nodeId)) segs.push({ id: r.id, day: r.day, min: clockMinutes(r.start_hm) ?? 0 });
  segs.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || a.min - b.min || (a.id === "main" ? -1 : b.id === "main" ? 1 : a.id < b.id ? -1 : 1));
  const i = segs.findIndex((s) => s.id === which);
  if (i < 0) return null;
  return { n: i + 1, total: segs.length };
}

/** 段數（含第一段）；第一段沒時刻也算 1（面板「共 N 段」） */
export function segTotalOf(nodeId: string, slotRows: readonly TimePlanRow[] | undefined): number {
  return 1 + slotsOfNode(slotRows ?? [], nodeId).length;
}
