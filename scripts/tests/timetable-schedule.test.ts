/**
 * 時刻表線④・日程純函式測試（④ 契約 §4 第 1–9 項；甲席）。
 * 跑法：`node --test scripts/tests/timetable-schedule.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 時區：測資一律用本地時刻 `T(h, mi)`＝2026-10-20 那一天（h ≥ 24 由 Date 進位到隔天），不寫 UTC 字面值。
 * 契約 §4 的 9 項各一個 describe（編號對得上）；末尾另有 planItemOf 與碎塊門檻對齊統計的兩支。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MIN } from "../../src/domain/timetable.ts";
import { TINY_MS } from "../../src/domain/timetableStats.ts";
import {
  ON_TIME_LATE_MIN,
  SCHED_TINY_MS,
  SNAP_MIN,
  canScheduleDay,
  clockOfAxisMin,
  comparePlan,
  daySummary,
  fmtPlanDelta,
  lateItemsOf,
  planItemOf,
  planTimeWrite,
  PLAN_TEXT,
  planUndo,
  snapClockMin,
  startOnTime,
  undoWritable,
  type LinkedSpan,
  type PlanCompare,
  type PlanItem,
} from "../../src/domain/timetableSchedule.ts";
import type { ScheduleEntry, TodayRow } from "../../src/data/nodeRepository.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const D = "2026-10-20";
/** 2026-10-20 的本地 h:mi（h ≥ 24 ⇒ 隔天） */
const T = (h: number, mi = 0, sec = 0): number => new Date(2026, 9, 20, h, mi, sec).getTime();

let seq = 0;
function span(start: number, end: number | null, nodeId: string | null = "n1", extra: Partial<LinkedSpan> = {}): LinkedSpan {
  return { id: `b${++seq}`, categoryId: "c", start, end, ack: false, nodeId, pending: false, ...extra };
}

function item(p: Partial<PlanItem> = {}): PlanItem {
  const nodeId = p.nodeId ?? "n1";
  const date = p.date ?? D;
  return {
    key: `${date}-${nodeId}`,
    nodeId,
    date,
    kind: "single",
    time: "14:00",
    overridden: false,
    estimateMin: null,
    done: false,
    skipped: false,
    lateFrom: null,
    ...p,
  };
}

/* ───────── 1. 每一種 state；準點邊界（D-時-81 改題：早開始或晚 10 分內） ───────── */

describe("1. comparePlan 的每一種 state 與準點邊界", () => {
  test("upcoming：還沒到預定、沒實績", () => {
    const c = comparePlan(item(), [], 6, T(13, 0));
    assert.equal(c.state, "upcoming");
    assert.equal(c.startDeltaMin, null);
    assert.equal(fmtPlanDelta(c, null), null);
  });
  test("notStarted：預定已過、沒實績、沒済", () => {
    const c = comparePlan(item(), [], 6, T(14, 1));
    assert.equal(c.state, "notStarted");
    assert.equal(fmtPlanDelta(c, null), "還沒開始");
  });
  test("預定剛好等於 now ⇒ notStarted（≤ now）", () => {
    assert.equal(comparePlan(item(), [], 6, T(14, 0)).state, "notStarted");
  });
  test("doneNoTime：済了沒記時間", () => {
    const c = comparePlan(item({ done: true }), [], 6, T(15, 0));
    assert.equal(c.state, "doneNoTime");
    assert.equal(fmtPlanDelta(c, null), "済・沒記時間");
  });
  test("skipped：運休不算，就算有實績", () => {
    const c = comparePlan(item({ skipped: true }), [span(T(14, 0), T(15, 0))], 6, T(16, 0));
    assert.equal(c.state, "skipped");
    assert.equal(c.durDeltaMin, null);
    assert.equal(fmtPlanDelta(c, 60), null);
  });
  test("running：有一塊運行中", () => {
    const c = comparePlan(item(), [span(T(14, 3), null)], 6, T(14, 30));
    assert.equal(c.state, "running");
    assert.equal(c.startDeltaMin, 3);
    assert.equal(fmtPlanDelta(c, null), "行駛中・準點");
  });
  test("running＋晚開始：+10 仍準點、+11 晚；提早也只寫準點", () => {
    assert.equal(fmtPlanDelta(comparePlan(item(), [span(T(14, 10), null)], 6, T(14, 30)), null), "行駛中・準點");
    const c = comparePlan(item(), [span(T(14, 11), null)], 6, T(14, 30));
    assert.equal(fmtPlanDelta(c, null), "行駛中・晚 11 分開始");
    const early = comparePlan(item(), [span(T(13, 15), null)], 6, T(14, 30));
    assert.equal(fmtPlanDelta(early, null), "行駛中・準點");
  });
  test("running 剛発車不到一分鐘也算行駛中（運行中的塊不當碎塊）", () => {
    const c = comparePlan(item(), [span(T(14, 0), null)], 6, T(14, 0, 20));
    assert.equal(c.state, "running");
  });
  test("邊界：+10 分＝準點、+11 分＝晚", () => {
    const on = comparePlan(item(), [span(T(14, 10), T(14, 30))], 6, T(15));
    assert.equal(on.state, "onTime");
    assert.equal(fmtPlanDelta(on, null), "準點");
    const late = comparePlan(item(), [span(T(14, 11), T(14, 30))], 6, T(15));
    assert.equal(late.state, "late");
    assert.equal(late.startDeltaMin, 11);
    assert.equal(fmtPlanDelta(late, null), "晚 11 分開始");
  });
  test("提早多少都＝準點（提早 45 分；字只寫「準點」，startDeltaMin 照實留給金線）", () => {
    const early = comparePlan(item(), [span(T(13, 15), T(14, 30))], 6, T(15));
    assert.equal(early.state, "onTime");
    assert.equal(early.startDeltaMin, -45);
    assert.equal(fmtPlanDelta(early, null), "準點");
    assert.equal(comparePlan(item(), [span(T(13, 54), T(14, 30))], 6, T(15)).state, "onTime");
  });
  test("ON_TIME_LATE_MIN＝10", () => assert.equal(ON_TIME_LATE_MIN, 10));
  test("一小時以上的差寫成 1h25m（不寫「晚 85 分」）", () => {
    const c = comparePlan(item(), [span(T(15, 25), T(15, 40))], 6, T(16));
    assert.equal(fmtPlanDelta(c, null), "晚 1h25m 開始");
  });
  test("済了而且有實績 ⇒ 照早晚，不是 doneNoTime", () => {
    assert.equal(comparePlan(item({ done: true }), [span(T(14, 2), T(14, 40))], 6, T(15)).state, "onTime");
  });
  test("只看 nodeId 相同的塊；別張票、只連路線（nodeId null）的不算", () => {
    const c = comparePlan(item(), [span(T(14, 0), T(15, 0), "n2"), span(T(14, 0), T(15, 0), null)], 6, T(16));
    assert.equal(c.state, "notStarted");
    assert.deepEqual(c.blockIds, []);
  });
});

/* ───────── 2. 25:00 ───────── */

describe("2. 25:00 的預定（日界線 06:00 與 03:00）", () => {
  for (const h of [6, 3]) {
    test(`日界線 ${h}:00：預定開始＝隔天 01:00；實績 01:03 ⇒ 準點`, () => {
      const it = item({ time: "25:00" });
      const c = comparePlan(it, [span(T(25, 3), T(25, 40))], h, T(26));
      assert.equal(c.state, "onTime");
      assert.equal(c.startDeltaMin, 3);
      // 隔天 01:00 之前 ⇒ 還沒到
      assert.equal(comparePlan(it, [], h, T(24, 59)).state, "upcoming");
      assert.equal(comparePlan(it, [], h, T(25, 0)).state, "notStarted");
    });
  }
  test("隔天 01:00 的塊不會被算進隔天那一天的同一張（窗不同）", () => {
    const next = item({ time: "25:00", date: "2026-10-21", key: "2026-10-21-n1" });
    const c = comparePlan(next, [span(T(25, 3), T(25, 40))], 6, T(26));
    assert.deepEqual(c.blockIds, []);
  });
});

/* ───────── 3. 定期券的窗 ───────── */

describe("3. 定期券：用窗切那一班", () => {
  const rep = item({ kind: "repeat", time: "07:00" });
  test("同 nodeId、落在前一天窗內的塊不算", () => {
    const yesterday = span(new Date(2026, 9, 19, 7, 2).getTime(), new Date(2026, 9, 19, 7, 30).getTime());
    const c = comparePlan(rep, [yesterday], 6, T(8));
    assert.equal(c.state, "notStarted");
    assert.deepEqual(c.blockIds, []);
  });
  test("跨日界線續過來的塊（05:00 起，日界線 06:00）：不當開始（沙盒後修正 F4）；時長只算窗內", () => {
    const cross = span(T(5, 0), T(7, 0));
    const c = comparePlan(item({ kind: "repeat", time: "06:00", estimateMin: 60 }), [cross], 6, T(8));
    assert.equal(c.startDeltaMin, null);
    assert.equal(c.carried, true);
    assert.equal(c.state, "carried");
    assert.equal(c.actualMs, 60 * MIN); // 06:00–07:00
    assert.equal(c.durDeltaMin, 0);
  });
  test("跨到隔天的塊：裁到窗尾", () => {
    const c = comparePlan(item({ time: "29:00" }), [span(T(29, 30), T(31, 0))], 6, T(32));
    assert.equal(c.actualMs, 30 * MIN); // 隔天 05:30–06:00
  });
});

/* ───────── 4. 碎塊與待確認 ───────── */

describe("4. 碎塊與待確認", () => {
  test("碎塊（< 60 秒、已結束）不當第一塊、不進時長，但在 blockIds（描金用）", () => {
    const tiny = span(T(13, 50), T(13, 50, 30));
    const real = span(T(14, 2), T(14, 32));
    const c = comparePlan(item({ estimateMin: 30 }), [tiny, real], 6, T(15));
    assert.equal(c.startDeltaMin, 2);
    assert.equal(c.state, "onTime");
    assert.equal(c.actualMs, 30 * MIN);
    assert.deepEqual(c.blockIds, [tiny.id, real.id]);
  });
  test("只有碎塊 ⇒ 當作沒實績", () => {
    const c = comparePlan(item(), [span(T(14, 0), T(14, 0, 45))], 6, T(15));
    assert.equal(c.state, "notStarted");
    assert.equal(c.actualMs, 0);
  });
  test("60 秒整不是碎塊", () => {
    const c = comparePlan(item(), [span(T(14, 0), T(14, 1))], 6, T(15));
    assert.equal(c.state, "onTime");
    assert.equal(c.actualMs, MIN);
  });
  test("待確認：算開始、不算時長、pendingCount 對、字補「（1 段待確認沒算）」", () => {
    const pend = span(T(14, 20), T(17, 0), "n1", { pending: true });
    const ok = span(T(17, 5), T(17, 35));
    const c = comparePlan(item({ estimateMin: 30 }), [pend, ok], 6, T(18));
    assert.equal(c.startDeltaMin, 20);
    assert.equal(c.state, "late");
    assert.equal(c.pendingCount, 1);
    assert.equal(c.actualMs, 30 * MIN);
    assert.equal(c.durDeltaMin, 0);
    assert.equal(fmtPlanDelta(c, 30), "晚 20 分開始（1 段待確認沒算）");
  });
  test("碎塊不算待確認數", () => {
    const c = comparePlan(item(), [span(T(14, 0), T(14, 0, 10), "n1", { pending: true }), span(T(14, 1), T(14, 20))], 6, T(15));
    assert.equal(c.pendingCount, 0);
  });
  test("重疊的塊時長不重複計（聯集）", () => {
    const c = comparePlan(item({ estimateMin: 60 }), [span(T(14, 0), T(15, 0)), span(T(14, 30), T(15, 10))], 6, T(16));
    assert.equal(c.actualMs, 70 * MIN);
  });
  test("SCHED_TINY_MS 與統計的 TINY_MS 同一把尺（D-時-44）", () => assert.equal(SCHED_TINY_MS, TINY_MS));
});

/* ───────── 5. 長短 ───────── */

describe("5. 長短", () => {
  test("預計 60、實績 100 ⇒「晚 25 分開始・多花 40m」", () => {
    const c = comparePlan(item({ estimateMin: 60 }), [span(T(14, 25), T(16, 5))], 6, T(17));
    assert.equal(c.durDeltaMin, 40);
    assert.equal(fmtPlanDelta(c, 60), "晚 25 分開始・多花 40m");
  });
  test("少 15m", () => {
    const c = comparePlan(item({ estimateMin: 60 }), [span(T(14, 0), T(14, 45))], 6, T(17));
    assert.equal(fmtPlanDelta(c, 60), "準點・少 15m");
  });
  test("差 4 分不寫；差 5 分寫", () => {
    const c4 = comparePlan(item({ estimateMin: 60 }), [span(T(14, 0), T(15, 4))], 6, T(17));
    assert.equal(fmtPlanDelta(c4, 60), "準點");
    const c5 = comparePlan(item({ estimateMin: 60 }), [span(T(14, 0), T(15, 5))], 6, T(17));
    assert.equal(fmtPlanDelta(c5, 60), "準點・多花 5m");
    const cm5 = comparePlan(item({ estimateMin: 60 }), [span(T(14, 0), T(14, 55))], 6, T(17));
    assert.equal(fmtPlanDelta(cm5, 60), "準點・少 5m");
  });
  test("沒預計 ⇒ 只寫早晚", () => {
    const c = comparePlan(item(), [span(T(14, 25), T(16, 5))], 6, T(17));
    assert.equal(c.durDeltaMin, null);
    assert.equal(fmtPlanDelta(c, null), "晚 25 分開始");
  });
  test("運行中 ⇒「已 40m／預計 1h」、不寫多花", () => {
    const c = comparePlan(item({ estimateMin: 60 }), [span(T(14, 0), null)], 6, T(14, 40));
    assert.equal(c.durDeltaMin, null);
    assert.equal(c.actualMs, 40 * MIN);
    assert.equal(fmtPlanDelta(c, 60), "行駛中・準點・已 40m／預計 1h");
  });
  test("沒實績 ⇒ 不寫長短（不寫「少 1h」）", () => {
    const c = comparePlan(item({ estimateMin: 60 }), [], 6, T(15));
    assert.equal(c.durDeltaMin, null);
    assert.equal(fmtPlanDelta(c, 60), "還沒開始");
  });
});

/* ───────── 6. daySummary（D-時-83 改題：済與只記時間分開） ───────── */

describe("6. daySummary", () => {
  const its: PlanItem[] = [
    item({ nodeId: "a", key: "a", time: "09:00", estimateMin: 30 }), // 準點、沒済 ⇒ 只記時間
    item({ nodeId: "b", key: "b", time: "10:00", estimateMin: 60 }), // 晚、沒済 ⇒ 只記時間
    item({ nodeId: "c", key: "c", time: "11:00", done: true }), // 済沒記時間 ⇒ 済
    item({ nodeId: "d", key: "d", time: "12:00", skipped: true, estimateMin: 90 }), // 運休：不算排了
    item({ nodeId: "e", key: "e", time: "13:00" }), // 還沒開始：都不算
    item({ nodeId: "f", key: "f", time: null, done: true }), // 沒時刻：不算排了
    item({ nodeId: "g", key: "g", time: "14:00" }), // 只有待確認塊 ⇒ 只記時間
    item({ nodeId: "h", key: "h", time: "15:00", estimateMin: 45 }), // 運行中、開始準點 ⇒ 只記時間＋準點
    item({ nodeId: "i", key: "i", time: "08:00", done: true }), // 有實績又済 ⇒ 済（不算只記時間）＋準點
    item({ nodeId: "j", key: "j", time: "07:00", estimateMin: 20, lateFrom: "2026-10-17" }), // 誤點項：不是這天排的，不算
    item({ nodeId: "k", key: "k", time: "15:30" }), // 剛発車 20 秒（運行中）⇒ 只記時間；晚 29 分
  ];
  const spans = [
    span(T(9, 2), T(9, 30), "a"),
    span(T(10, 20), T(11, 0), "b"),
    span(T(14, 10), T(18, 0), "g", { pending: true }),
    span(T(15, 3), null, "h"),
    span(T(8, 3), T(8, 30), "i"),
    span(T(7, 0), T(7, 20), "j"),
    span(T(15, 59, 40), null, "k"),
  ];
  const now = T(16, 0);
  const cmp = new Map<string, PlanCompare>(its.map((i) => [i.key, comparePlan(i, spans, 6, now)]));
  test("排了＝有時刻、不是運休、不是誤點項；済＝排了裡蓋済的；只記時間＝有時間（含運行中、待確認）沒済；兩者互斥", () => {
    const s = daySummary(its, cmp, false);
    assert.equal(s.planned, 8); // a b c e g h i k
    assert.equal(s.stamped, 2); // c i
    assert.equal(s.timedOnly, 5); // a b g h k
    assert.equal(s.onTime, 4); // a g（待確認塊 +10 分開始＝準點） h i
  });
  test("未來日：plannedMin＝預計加總、noEstimate＝沒預計的件數；済／只記時間／準點 0", () => {
    const s = daySummary(its, new Map(), true);
    assert.equal(s.planned, 8);
    assert.equal(s.plannedMin, 30 + 60 + 45);
    assert.equal(s.noEstimate, 5); // c e g i k
    assert.equal(s.stamped, 0);
    assert.equal(s.timedOnly, 0);
    assert.equal(s.onTime, 0);
  });
  test("排了 0", () => {
    assert.deepEqual(daySummary([item({ time: null })], new Map(), false), {
      planned: 0,
      stamped: 0,
      timedOnly: 0,
      onTime: 0,
      plannedMin: 0,
      noEstimate: 0,
    });
  });
});

/* ───────── 7. planTimeWrite／planUndo ───────── */

describe("7. 寫入規劃與撤回", () => {
  test("單發票：setTime；撤回寫回舊值（含 null）", () => {
    const it = item({ time: "14:00" });
    assert.deepEqual(planTimeWrite(it, "15:30"), { op: "setTime", id: "n1", time: "15:30" });
    assert.deepEqual(planTimeWrite(it, null), { op: "setTime", id: "n1", time: null });
    assert.deepEqual(planUndo(it), { op: "setTime", id: "n1", time: "14:00" });
    assert.deepEqual(planUndo(item({ time: null })), { op: "setTime", id: "n1", time: null });
  });
  test("定期券：只改這一班（setRun）；清除＝setRun 帶 null", () => {
    const it = item({ kind: "repeat", time: "07:00" });
    assert.deepEqual(planTimeWrite(it, "09:30"), { op: "setRun", id: "n1", date: D, time: "09:30" });
    assert.deepEqual(planTimeWrite(it, null), { op: "setRun", id: "n1", date: D, time: null });
  });
  test("定期券沒覆寫過 ⇒ 撤回＝clearRun（回到每班時刻）", () => {
    assert.deepEqual(planUndo(item({ kind: "repeat", time: "07:00", overridden: false })), { op: "clearRun", id: "n1", date: D });
  });
  test("定期券覆寫過 ⇒ 撤回＝setRun 舊覆寫值（可能是 null＝這一班沒有時刻）", () => {
    assert.deepEqual(planUndo(item({ kind: "repeat", time: "09:30", overridden: true })), { op: "setRun", id: "n1", date: D, time: "09:30" });
    assert.deepEqual(planUndo(item({ kind: "repeat", time: null, overridden: true })), { op: "setRun", id: "n1", date: D, time: null });
  });
});

/* ───────── 8. 軸上的小工具 ───────── */

describe("8. snapClockMin、clockOfAxisMin、canScheduleDay", () => {
  test("snapClockMin：四捨五入到 15 分（預設）", () => {
    assert.equal(SNAP_MIN, 15);
    assert.equal(snapClockMin(847), 840);
    assert.equal(snapClockMin(848), 855); // 847.5 以上進位
    assert.equal(snapClockMin(1507), 1500);
    assert.equal(snapClockMin(1508), 1515);
    assert.equal(snapClockMin(62, 30), 60);
  });
  test("clockOfAxisMin：≥ 1440 ⇒ 25:xx；補零；夾範圍", () => {
    assert.equal(clockOfAxisMin(855), "14:15");
    assert.equal(clockOfAxisMin(1515), "25:15");
    assert.equal(clockOfAxisMin(375), "06:15");
    assert.equal(clockOfAxisMin(14.6), "00:15");
    assert.equal(clockOfAxisMin(-5), "00:00");
  });
  test("canScheduleDay：今天和以後", () => {
    assert.equal(canScheduleDay("2026-10-20", "2026-10-20"), true);
    assert.equal(canScheduleDay("2026-10-21", "2026-10-20"), true);
    assert.equal(canScheduleDay("2026-10-19", "2026-10-20"), false);
  });
});

/* ───────── 9. 純度牙齒 ───────── */

describe("9. 純度牙齒", () => {
  test("timetableSchedule.ts 只 import ./timetable.ts、./scheduledTime.ts、../lib/date.ts（其餘只准 import type）", () => {
    const src = readFileSync(path.join(ROOT, "src/domain/timetableSchedule.ts"), "utf8");
    const all = Array.from(src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm));
    assert.ok(all.length > 0);
    const value = all.filter((m) => !m[1]).map((m) => m[2]);
    assert.deepEqual(Array.from(new Set(value)).sort(), ["../lib/date.ts", "./scheduledTime.ts", "./timetable.ts"]);
  });
});

/* ───────── 其他 ───────── */

describe("planItemOf", () => {
  const e = (p: Partial<ScheduleEntry>): ScheduleEntry => ({
    date: D,
    node_id: "n1",
    kind: "single",
    occurrence_status: null,
    is_late: false,
    is_done: false,
    is_assumed: false,
    time: "14:00",
    ...p,
  });
  test("單發票：key、時刻、預計（0 當沒填）", () => {
    const it = planItemOf(e({}), { estimate_min: 0, time_overrides: null, repeat_rule: null });
    assert.equal(it.key, `${D}-n1`);
    assert.equal(it.time, "14:00");
    assert.equal(it.estimateMin, null);
    assert.equal(it.overridden, false);
    assert.equal(planItemOf(e({}), { estimate_min: 45, time_overrides: null, repeat_rule: null }).estimateMin, 45);
  });
  test("定期券：本班覆寫、済、運休", () => {
    const node = { estimate_min: null, time_overrides: JSON.stringify({ [D]: "09:30" }), repeat_rule: "FREQ=DAILY" };
    const it = planItemOf(e({ kind: "repeat", time: "09:30", is_done: true }), node);
    assert.equal(it.overridden, true);
    assert.equal(it.done, true);
    assert.equal(planItemOf(e({ kind: "repeat", date: "2026-10-21", time: "07:00" }), node).overridden, false);
    assert.equal(planItemOf(e({ kind: "repeat", occurrence_status: "skipped" }), node).skipped, true);
  });
  test("節點找不到 ⇒ 沒預計、沒覆寫", () => {
    const it = planItemOf(e({ kind: "repeat" }), undefined);
    assert.equal(it.estimateMin, null);
    assert.equal(it.overridden, false);
  });
});

describe("修正席：撤回寫不寫得回去、只有待確認塊不比長短", () => {
  test("undoWritable：舊時刻在日界線範圍內 ⇒ true；軸外（h=0 時的 24:30）⇒ false；clearRun／null 永遠 true", () => {
    assert.equal(undoWritable({ op: "setTime", id: "n", time: "24:30" }, 1), true);
    assert.equal(undoWritable({ op: "setTime", id: "n", time: "24:30" }, 0), false);
    assert.equal(undoWritable({ op: "setRun", id: "n", date: D, time: "26:30" }, 1), false);
    assert.equal(undoWritable({ op: "setTime", id: "n", time: null }, 0), true);
    assert.equal(undoWritable({ op: "clearRun", id: "n", date: D }, 0), true);
  });
  test("只有待確認塊 ⇒ durDeltaMin null（不寫「少 1h」），早晚照算", () => {
    const c = comparePlan(item({ estimateMin: 60 }), [span(T(14, 2), T(17, 0), "n1", { pending: true })], 6, T(18));
    assert.equal(c.durDeltaMin, null);
    assert.equal(c.actualMs, 0);
    assert.equal(fmtPlanDelta(c, 60), "準點（1 段待確認沒算）");
  });
});

describe("使用者改題 D-時-80：誤點的單發票能排到今天", () => {
  const TODAY = "2026-10-20";
  const row = (p: Partial<TodayRow>): Pick<TodayRow, "id" | "bucket" | "status" | "repeat_rule" | "occurrence" | "scheduled_on" | "scheduled_time" | "estimate_min"> => ({
    id: "x",
    bucket: "late",
    status: "todo",
    repeat_rule: null,
    occurrence: null,
    scheduled_on: "2026-10-17",
    scheduled_time: null,
    estimate_min: null,
    ...p,
  });
  test("lateItemsOf：late＋單發票＋沒済 ⇒ PlanItem（date＝今天、lateFrom＝原日、time＝原時刻、預計）；照今日列的順序", () => {
    const r = lateItemsOf(
      [
        row({ id: "a", scheduled_time: "14:00", estimate_min: 60 }),
        row({ id: "b", scheduled_on: "2026-10-12" }),
        row({ id: "c", bucket: "today", scheduled_on: TODAY }), // 今天的：不是誤點
        row({ id: "d", status: "done" }), // 補済了：交代了
        row({ id: "e", bucket: "due", scheduled_on: null }), // 只有締切過了：不是誤點的執行日
        row({ id: "f", repeat_rule: "FREQ=DAILY" }), // 定期券漏班：只數
        row({ id: "g", repeat_rule: "FREQ=DAILY", occurrence: { id: "o", status: "skipped", due_on: "2026-10-18" } }), // 這班運休了：交代了
        row({ id: "h", estimate_min: 0 }), // 預計 0＝沒填
      ],
      TODAY,
    );
    assert.deepEqual(
      r.items.map((i) => i.nodeId),
      ["a", "b", "h"],
    );
    assert.equal(r.repeatCount, 1);
    assert.deepEqual(r.items[0], {
      key: `${TODAY}-a`,
      nodeId: "a",
      date: TODAY,
      kind: "single",
      time: "14:00",
      overridden: false,
      estimateMin: 60,
      done: false,
      skipped: false,
      lateFrom: "2026-10-17",
    });
    assert.equal(r.items[1].time, null);
    assert.equal(r.items[2].estimateMin, null);
  });
  test("planTimeWrite：誤點項＝setTime 帶 scheduledOn 今天", () => {
    const it = item({ date: TODAY, time: null, lateFrom: "2026-10-17" });
    assert.deepEqual(planTimeWrite(it, "14:15"), { op: "setTime", id: "n1", time: "14:15", scheduledOn: TODAY });
  });
  test("planUndo：誤點項＝改回原日＋原時刻（原本沒時刻 ⇒ null）", () => {
    assert.deepEqual(planUndo(item({ date: TODAY, time: "09:00", lateFrom: "2026-10-17" })), {
      op: "setTime",
      id: "n1",
      time: "09:00",
      scheduledOn: "2026-10-17",
    });
    assert.deepEqual(planUndo(item({ date: TODAY, time: null, lateFrom: "2026-10-17" })), {
      op: "setTime",
      id: "n1",
      time: null,
      scheduledOn: "2026-10-17",
    });
  });
  test("一般的單發票不帶 scheduledOn（不會順手改執行日）", () => {
    assert.equal("scheduledOn" in planTimeWrite(item(), "15:00"), false);
    assert.equal("scheduledOn" in planUndo(item()), false);
  });
});

/* ───────── 沙盒後修正 F4：「第一塊的開始」只看在窗內開始的塊 ───────── */

describe("沙盒後修正 F4：從前一天續過來的塊不當開始", () => {
  const D0 = "2026-10-19";
  /** 2026-10-19 的本地 h:mi */
  const Y = (h: number, mi = 0): number => new Date(2026, 9, 19, h, mi).getTime();
  const rep = (p: Partial<PlanItem> = {}): PlanItem => item({ kind: "repeat", time: "25:00", estimateMin: 60, ...p });

  test("續過來＋窗內再開始一塊：開始＝窗內那塊；時長兩塊都算（續過來的只算窗內那段）", () => {
    const cross = span(T(5, 0), T(6, 30)); // 前一天 05:00 起（日界線 06:00）⇒ 窗內 06:00–06:30
    const own = span(T(14, 20), T(15, 0));
    const c = comparePlan(item({ estimateMin: 60 }), [cross, own], 6, T(16));
    assert.equal(c.carried, false);
    assert.equal(c.startDeltaMin, 20);
    assert.equal(c.state, "late");
    assert.equal(c.actualMs, 70 * MIN);
    assert.equal(c.durDeltaMin, 10);
    assert.deepEqual(c.blockIds, [cross.id, own.id]);
    assert.equal(fmtPlanDelta(c, 60), "晚 20 分開始・多花 10m");
  });
  test("只有續過來的、已結束：沒有開始可比（不算準點也不算晚），卡上寫「接續前一天」，長短照算", () => {
    const c = comparePlan(item({ estimateMin: 60 }), [span(T(5, 0), T(6, 45))], 6, T(16));
    assert.equal(c.startDeltaMin, null);
    assert.equal(c.carried, true);
    assert.equal(c.state, "carried");
    assert.equal(c.actualMs, 45 * MIN);
    assert.equal(c.durDeltaMin, -15);
    assert.equal(startOnTime(c), false);
    assert.equal(fmtPlanDelta(c, 60), "接續前一天・少 15m");
    assert.equal(PLAN_TEXT.carried, "接續前一天");
  });
  test("S9 那一型：前一天 01:00 起跑、跨過日界線 02:00 還在跑 ⇒ 隔天那班「行駛中・接續前一天」，不是準點", () => {
    const run = span(T(1, 0), null); // 10/20 01:00 起（＝10/19 營業日的深夜）
    const now = T(2, 5);
    const next = rep(); // 10/20 那班 25:00（＝10/21 01:00）
    const c = comparePlan(next, [run], 2, now);
    assert.equal(c.state, "running");
    assert.equal(c.startDeltaMin, null); // 改之前是 −1440（早 24 小時＝準點）
    assert.equal(c.carried, true);
    assert.equal(startOnTime(c), false);
    assert.equal(c.actualMs, 5 * MIN); // 只算窗內 02:00–02:05
    assert.equal(fmtPlanDelta(c, 60), "行駛中・接續前一天・已 5m／預計 1h");
  });
  test("前一班不受影響：同一塊在前一天的窗內開始 ⇒ 前一班照常比開始", () => {
    const run = span(T(1, 0), null);
    const prev = rep({ date: D0, key: `${D0}-n1` }); // 10/19 那班 25:00＝10/20 01:00
    const c = comparePlan(prev, [run], 2, T(2, 5));
    assert.equal(c.state, "running");
    assert.equal(c.startDeltaMin, 0);
    assert.equal(c.carried, false);
    assert.equal(startOnTime(c), true);
    assert.equal(c.actualMs, 60 * MIN); // 01:00–02:00（窗尾）
  });
  test("前一班已結束的版本：前一天窗內開始、跨進今天 ⇒ 前一天照比、今天「接續前一天」", () => {
    const b = span(Y(23, 30), T(6, 40)); // 10/19 23:30 起到 10/20 06:40（日界線 06:00）
    const prev = comparePlan(item({ date: D0, key: `${D0}-n1`, time: "23:30", estimateMin: 60 }), [b], 6, T(12));
    assert.equal(prev.state, "onTime");
    assert.equal(prev.startDeltaMin, 0);
    assert.equal(prev.actualMs, 390 * MIN); // 23:30–06:00
    const today = comparePlan(item({ time: "06:00", estimateMin: 60 }), [b], 6, T(12));
    assert.equal(today.state, "carried");
    assert.equal(today.startDeltaMin, null);
    assert.equal(today.actualMs, 40 * MIN);
  });
  test("沒時刻的票只有續過來的塊：照舊 upcoming、不標 carried", () => {
    const c = comparePlan(item({ time: null }), [span(T(5, 0), T(7, 0))], 6, T(8));
    assert.equal(c.state, "upcoming");
    assert.equal(c.carried, false);
  });
  test("daySummary：只有續過來的那張算「只記時間」、不算準點", () => {
    const its = [
      item({ nodeId: "a", key: "a", time: "06:00", estimateMin: 60 }), // 只有續過來的、已結束
      item({ nodeId: "b", key: "b", time: "25:00" }), // 只有續過來的、還在跑
      item({ nodeId: "c", key: "c", time: "09:00" }), // 準點
    ];
    const spans = [span(T(5, 0), T(7, 0), "a"), span(T(5, 30), null, "b"), span(T(9, 3), T(9, 40), "c")];
    const now = T(10);
    const cmp = new Map<string, PlanCompare>(its.map((i) => [i.key, comparePlan(i, spans, 6, now)]));
    const s = daySummary(its, cmp, false);
    assert.equal(s.planned, 3);
    assert.equal(s.timedOnly, 3);
    assert.equal(s.onTime, 1); // 只有 c
  });
  test("誤點項（lateFrom）碰到續過來的塊也一樣不當開始（S9 單發票的 Δ −1440）", () => {
    const late = item({ time: "25:00", lateFrom: "2026-10-19" });
    const c = comparePlan(late, [span(T(1, 0), null)], 2, T(2, 5));
    assert.equal(c.startDeltaMin, null);
    assert.equal(c.carried, true);
  });
});
