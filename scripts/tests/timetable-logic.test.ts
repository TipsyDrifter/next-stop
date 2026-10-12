/**
 * 時刻表線・純函式單元測試（車次①a 契約 §4.6；甲席）。
 * 跑法：`node --test scripts/tests/timetable-logic.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 放 `scripts/` 而不是 `src/`：tsconfig 的 include 只有 src，不會去找 node:test 的型別。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi).getTime()` 造本地時刻，不寫 UTC 字面值。
 *
 * Stage 0（甲席）：A 區 1–12、B 區 13–22 的骨架都在；標 `todo` 的在 Stage 1 補實作與斷言。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIN,
  RECONCILE_WINDOW_DAYS,
  STARTER_CATEGORIES,
  TIMETABLE_ID_NAMESPACE,
  canUndoArrive,
  colorSlot,
  currentRunning,
  fmtClock,
  fmtDur,
  fmtHMS,
  gapTotal,
  inReconcileWindow,
  isLongRun,
  longRunDefaultEnd,
  longRunThreshold,
  planArrive,
  planDepart,
  planEdit,
  planFill,
  planReconcile,
  planResolveLongRun,
  planRestart,
  planSplit,
  reconcileWindowStart,
  reconcileWriteKey,
  segmentsOfDay,
  totalsByCategory,
  weekStartKey,
  type KeyedSpan,
  type Span,
  type WritePlan,
} from "../../src/domain/timetable.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/* ───────── 測試用小工具 ───────── */

/** 今天本地 (h, mi)；d 偏移天數 */
const T = (h: number, mi: number, d = 0): number => new Date(2026, 9, 6 + d, h, mi).getTime();
const NOW = T(15, 42);

const mk = (id: string, cat: string, start: number, end: number | null, ack = false): Span => ({ id, categoryId: cat, start, end, ack });

/** 把 WritePlan 套到 spans（純記憶體；id 隨機 uuid 的 insert 用 `ins-N`） */
function apply(spans: readonly Span[], plan: WritePlan): Span[] {
  const map = new Map<string, Span>();
  for (const s of spans) map.set(s.id, { ...s });
  for (const p of plan.patches) {
    const s = map.get(p.id);
    if (!s) continue;
    if (p.start !== undefined) s.start = p.start;
    if (p.end !== undefined) s.end = p.end;
    if (p.categoryId !== undefined) s.categoryId = p.categoryId;
    if (p.ack !== undefined) s.ack = p.ack;
  }
  plan.inserts.forEach((i, n) => {
    const id = i.key ?? `ins-${n}`;
    map.set(id, { id, categoryId: i.categoryId, start: i.start, end: i.end, ack: i.ack });
  });
  for (const d of plan.deletes) map.delete(d);
  return Array.from(map.values()).sort((a, b) => a.start - b.start);
}

function assertNoOverlap(spans: readonly Span[], now = NOW): void {
  const s = spans.filter((x) => !(x.end !== null && x.end <= x.start)).slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < s.length; i++) {
    const prevEnd = s[i - 1].end ?? now;
    assert.ok(prevEnd <= s[i].start, `重疊：${s[i - 1].id}(${fmtClock(s[i - 1].start)}–${fmtClock(prevEnd)}) 與 ${s[i].id}(${fmtClock(s[i].start)})`);
  }
}

const runningCount = (spans: readonly Span[]): number => spans.filter((s) => s.end === null).length;

/** 示範資料（＝原型 shared.js；今天，日界線 03:00） */
function demo(): Span[] {
  return [
    mk("b1", "sleep", T(3, 0), T(7, 40)),
    mk("b2", "move", T(8, 10), T(8, 40)),
    mk("b3", "class", T(8, 40), T(10, 30)),
    mk("b4", "rest", T(10, 30), T(10, 50)),
    mk("b5", "class", T(10, 50), T(12, 10)),
    mk("b6", "meal", T(12, 10), T(13, 0)),
    mk("b7", "study", T(13, 30), T(14, 20)),
    mk("b8", "rest", T(14, 20), T(14, 35)),
    mk("b9", "create", T(14, 35), null),
  ];
}
const DAY = { start: T(3, 0), end: T(3, 0, 1) };

/* ───────── A. 原型冒煙測試的語義項逐條移植 ───────── */

describe("A. 原型冒煙測試移植", () => {
  test("1. 時間格式", () => {
    assert.equal(fmtDur(80 * MIN), "1h20m");
    assert.equal(fmtDur(45 * MIN), "45m");
    assert.equal(fmtDur(120 * MIN), "2h");
    assert.equal(fmtDur(0), "0m");
    assert.equal(fmtHMS(4030 * 1000), "1:07:10");
    assert.equal(fmtClock(T(8, 5)), "08:05");
  });

  test("2. 示範資料：兩段空白、合計 60 分、一班運行中、無重疊", () => {
    const items = segmentsOfDay(demo(), DAY, NOW);
    const gaps = items.filter((i) => i.kind === "gap");
    assert.equal(gaps.length, 2);
    assert.deepEqual(gaps.map((g) => [fmtClock(g.from), fmtClock(g.to)]), [["07:40", "08:10"], ["13:00", "13:30"]]);
    assert.equal(gapTotal(items), 60 * MIN);
    const r = currentRunning(demo());
    assert.ok(r && r.categoryId === "create" && r.start === T(14, 35));
    assertNoOverlap(demo());
  });

  test("3. 起手分類：19 列＝3 組＋16 子分類；子分類都有預設長度、parent 都指到組", () => {
    assert.equal(STARTER_CATEGORIES.length, 19);
    const groups = STARTER_CATEGORIES.filter((c) => c.parentId === null);
    const leaves = STARTER_CATEGORIES.filter((c) => c.parentId !== null);
    assert.equal(groups.length, 3);
    assert.equal(leaves.length, 16);
    const gid = new Set(groups.map((g) => g.id));
    for (const c of leaves) {
      assert.ok(gid.has(c.parentId!), `${c.key} 的 parent 不是組`);
      assert.ok(typeof c.defaultMin === "number" && c.defaultMin > 0, `${c.key} 沒有預設長度`);
      assert.ok(c.glyph && Array.from(c.glyph).length === 1, `${c.key} 圓牌字不是一個字`);
    }
    assert.equal(new Set(STARTER_CATEGORIES.map((c) => c.id)).size, 19);
  });

  test("4. 創作跑 1h07m 未超過 4h ⇒ 不是長時間運行", () => {
    const r = currentRunning(demo())!;
    assert.equal(isLongRun(r, 240, NOW), false);
  });

  test("5. 補記 07:40–08:10 後剩一段空白；無重疊", () => {
    const plan = planFill(demo(), { categoryId: "move", start: T(7, 40), end: T(8, 10), now: NOW });
    const after = apply(demo(), plan);
    assertNoOverlap(after);
    assert.equal(segmentsOfDay(after, DAY, NOW).filter((i) => i.kind === "gap").length, 1);
  });

  test("6. 補記 09:00–09:30 蓋在上課中間 ⇒ 上課切成兩段；無重疊", () => {
    const plan = planFill(demo(), { categoryId: "rest", start: T(9, 0), end: T(9, 30), now: NOW });
    assert.equal(plan.inserts.filter((i) => i.inherit).length, 1);
    const after = apply(demo(), plan);
    assertNoOverlap(after);
    const cls = after.filter((s) => s.categoryId === "class").map((s) => [fmtClock(s.start), fmtClock(s.end!)]);
    assert.deepEqual(cls, [["08:40", "09:00"], ["09:30", "10:30"], ["10:50", "12:10"]]);
  });

  test("7. 換車：舊的到站時刻＝新的開始、新的運行中", () => {
    const plan = planDepart(demo(), { categoryId: "meal", at: NOW, now: NOW });
    const after = apply(demo(), plan);
    assert.equal(runningCount(after), 1);
    const old = after.find((s) => s.id === "b9")!;
    const nu = currentRunning(after)!;
    assert.equal(old.end, nu.start);
    assert.equal(nu.categoryId, "meal");
    assertNoOverlap(after);
  });

  test("8. 改 10 分前：前一塊被切短、無重疊", () => {
    const plan = planRestart(demo(), { id: "b9", at: T(14, 25), now: NOW });
    const after = apply(demo(), plan);
    assert.equal(after.find((s) => s.id === "b8")!.end, T(14, 25));
    assert.equal(after.find((s) => s.id === "b9")!.start, T(14, 25));
    assertNoOverlap(after);
  });

  test("9. 到站；撤回到站", () => {
    const plan = planArrive(demo(), { now: NOW });
    const after = apply(demo(), plan);
    assert.equal(runningCount(after), 0);
    assert.equal(after.find((s) => s.id === "b9")!.end, NOW);
    assert.equal(canUndoArrive(after, "b9"), true);
    const next = apply(after, planDepart(after, { categoryId: "rest", at: NOW + MIN, now: NOW + MIN }));
    assert.equal(canUndoArrive(next, "b9"), false);
  });

  test("10. 單點切開：前段沿用、後段換分類、前段尾＝後段頭；切點超出範圍回 null", () => {
    const plan = planSplit(demo(), { id: "b3", at: T(9, 30), categoryId2: "study", now: NOW });
    assert.ok(plan);
    const after = apply(demo(), plan);
    const a = after.find((s) => s.id === "b3")!;
    const b = after.find((s) => s.id === "ins-0")!;
    assert.equal(a.categoryId, "class");
    assert.equal(b.categoryId, "study");
    assert.equal(a.end, b.start);
    assert.equal(b.end, T(10, 30));
    assert.equal(planSplit(demo(), { id: "b3", at: T(8, 40), categoryId2: "study", now: NOW }), null);
    assert.equal(planSplit(demo(), { id: "b3", at: T(10, 30), categoryId2: "study", now: NOW }), null);
  });

  test("11. 洗漱 06:30 発跑到 15:42 ⇒ 長時間運行（門檻 60）", () => {
    assert.equal(isLongRun(mk("w", "wash", T(6, 30), null), 60, NOW), true);
  });

  test("12. 其實在睡覺：洗漱 06:30–07:30、睡覺 07:30–運行中、洗漱 ack=1", () => {
    const spans = [mk("w", "wash", T(6, 30), null)];
    const plan = planResolveLongRun(spans, { id: "w", end: T(7, 30), choice: "cat", categoryId2: "sleep", now: NOW });
    const after = apply(spans, plan);
    const w = after.find((s) => s.id === "w")!;
    const s = currentRunning(after)!;
    assert.equal(w.end, T(7, 30));
    assert.equal(w.ack, true);
    assert.equal(s.categoryId, "sleep");
    assert.equal(s.start, T(7, 30));
    assert.equal(s.end, null);
  });
});

/* ───────── B. Plan 第五節第 2 點指出的缺口 ───────── */

describe("B. 缺口補測", () => {
  test("13. 其實到幾點・三選項", () => {
    const spans = [mk("w", "wash", T(6, 30), null)];
    const gap = apply(spans, planResolveLongRun(spans, { id: "w", end: T(7, 30), choice: "gap", now: NOW }));
    assert.equal(gap[0].end, T(7, 30));
    assert.equal(gap[0].ack, true);
    assert.equal(runningCount(gap), 0);
    const keep = apply(spans, planResolveLongRun(spans, { id: "w", end: T(7, 30), choice: "keep", now: NOW }));
    assert.equal(keep[0].end, null);
    assert.equal(keep[0].ack, true);
    assert.equal(longRunDefaultEnd(spans[0], 60, NOW), T(7, 30));
    assert.equal(longRunDefaultEnd(spans[0], 24 * 60, NOW), NOW - MIN);
    assert.equal(longRunDefaultEnd(spans[0], 0, NOW), T(6, 31));
    assert.throws(() => planResolveLongRun(spans, { id: "w", end: T(7, 30), choice: "cat", now: NOW }), RangeError);
  });

  test("14. 門檻來源", () => {
    assert.equal(longRunThreshold({ default_min: 60 }, 840), 60);
    assert.equal(longRunThreshold({ default_min: null }, 840), 840);
    assert.equal(longRunThreshold({ default_min: null }, 0), null);
    assert.equal(longRunThreshold(null, 840), 840);
    assert.equal(isLongRun(mk("w", "wash", T(6, 30), null, true), 60, NOW), false);
    assert.equal(isLongRun(mk("w", "wash", T(6, 30), null), null, NOW), false);
  });

  test("15. 跨日界線：06:00 與 03:00 各跑一次", () => {
    for (const h of [6, 3]) {
      const spans = [mk("s", "sleep", T(1, 0), T(8, 0))];
      const prev = { start: T(h, 0, -1), end: T(h, 0) };
      const cur = { start: T(h, 0), end: T(h, 0, 1) };
      const a = segmentsOfDay(spans, prev, NOW).filter((i) => i.kind === "block");
      const b = segmentsOfDay(spans, cur, NOW).filter((i) => i.kind === "block");
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
      assert.ok(a[0].kind === "block" && a[0].contToNext && !a[0].contFromPrev);
      assert.ok(b[0].kind === "block" && b[0].contFromPrev && !b[0].contToNext);
      assert.equal(a[0].to - a[0].from, (h - 1) * 60 * MIN);
      assert.equal(b[0].to - b[0].from, (8 - h) * 60 * MIN);
      assert.equal(totalsByCategory(spans, prev, NOW).sleep, (h - 1) * 60 * MIN);
      assert.equal(totalsByCategory(spans, cur, NOW).sleep, (8 - h) * 60 * MIN);
    }
    // 運行中跨日 ⇒ 今天那項 running 且 contFromPrev
    const run = [mk("r", "create", T(23, 0, -1), null)];
    const b = segmentsOfDay(run, { start: T(6, 0), end: T(6, 0, 1) }, NOW).filter((i) => i.kind === "block");
    assert.ok(b[0].kind === "block" && b[0].running && b[0].contFromPrev);
  });

  test("15b. 前一天軸的跨日段（沙盒回報 D2）：已結束的帶真實結束時刻、運行中的 contToNext＋running", () => {
    // Axis 用 span.end 顯示「續・HH:MM 着」、span.end === null 顯示「續 ›」——這裡鎖住它倚賴的資料
    const ended = segmentsOfDay([mk("s", "sleep", T(1, 0), T(8, 0))], { start: T(6, 0, -1), end: T(6, 0) }, NOW);
    const e = ended.find((i) => i.kind === "block");
    assert.ok(e && e.kind === "block" && e.contToNext && !e.running);
    assert.equal(e.span.end, T(8, 0));
    assert.equal(e.to, T(6, 0)); // 軸上夾在日界線
    const running = segmentsOfDay([mk("r", "create", T(23, 0, -1), null)], { start: T(6, 0, -1), end: T(6, 0) }, NOW);
    const r = running.find((i) => i.kind === "block");
    assert.ok(r && r.kind === "block" && r.contToNext && r.running && !r.contFromPrev);
    assert.equal(r.span.end, null);
  });

  test("16. 重疊不重複計；負時長當 0", () => {
    const spans = [mk("a", "x", T(9, 0), T(10, 0)), mk("b", "y", T(9, 30), T(10, 30))];
    const t = totalsByCategory(spans, DAY, NOW);
    assert.equal(t.x + t.y, 90 * MIN);
    assert.equal(t.y, 60 * MIN);
    const neg = totalsByCategory([mk("n", "z", T(10, 0), T(9, 0))], DAY, NOW);
    assert.equal(neg.z ?? 0, 0);
  });

  test("17. 接上一塊：planEdit 把 start 設成上一塊的 end ⇒ 無重疊、無空白", () => {
    const plan = planEdit(demo(), { id: "b2", categoryId: "move", start: T(7, 40), end: T(8, 40), now: NOW });
    const after = apply(demo(), plan);
    assertNoOverlap(after);
    const items = segmentsOfDay(after, DAY, NOW);
    assert.equal(items.filter((i) => i.kind === "gap").length, 1);
    assert.throws(() => planEdit(demo(), { id: "b9", categoryId: "create", start: T(14, 35), end: NOW, now: NOW }), RangeError);
  });

  test("17b. planEdit 的 patch 只帶變了的欄（逐欄 LWW：沒改的欄不能重新戳成最新）", () => {
    // b2 = move 08:10–08:40；只改分類
    const onlyCat = planEdit(demo(), { id: "b2", categoryId: "rest", start: T(8, 10), end: T(8, 40), now: NOW });
    assert.deepEqual(onlyCat.patches, [{ id: "b2", categoryId: "rest", ack: false }]);
    assert.deepEqual(onlyCat.deletes, []);
    // 只改開始（往後挪 10 分，不蓋到別塊）
    const onlyStart = planEdit(demo(), { id: "b2", categoryId: "move", start: T(8, 20), end: T(8, 40), now: NOW });
    assert.deepEqual(onlyStart.patches, [{ id: "b2", start: T(8, 20) }]);
    // 只改結束（往前縮）
    const onlyEnd = planEdit(demo(), { id: "b2", categoryId: "move", start: T(8, 10), end: T(8, 30), now: NOW });
    assert.deepEqual(onlyEnd.patches, [{ id: "b2", end: T(8, 30) }]);
    // 什麼都沒變 ⇒ 空 plan
    assert.deepEqual(planEdit(demo(), { id: "b2", categoryId: "move", start: T(8, 10), end: T(8, 40), now: NOW }), {
      patches: [],
      inserts: [],
      deletes: [],
    });
  });

  test("18. 出發早於運行中那班的開始（契約 0-11）⇒ 那班被收掉、前面的塊被切短、無重疊", () => {
    const spans = [mk("a", "rest", T(14, 20), T(15, 0)), mk("r", "create", T(15, 0), null)];
    const plan = planDepart(spans, { categoryId: "meal", at: T(14, 40), now: NOW });
    assert.deepEqual(plan.deletes, ["r"]);
    const after = apply(spans, plan);
    assertNoOverlap(after);
    assert.equal(after.find((s) => s.id === "a")!.end, T(14, 40));
    assert.equal(runningCount(after), 1);
  });

  test("19. 補記蓋到運行中的塊 ⇒ 前段已結束＋補記＋後段仍運行中（inherit）", () => {
    const spans = [mk("r", "create", T(1, 0), null)];
    const plan = planFill(spans, { categoryId: "meal", start: T(2, 0), end: T(3, 0), now: NOW });
    const after = apply(spans, plan);
    assertNoOverlap(after);
    assert.equal(after.find((s) => s.id === "r")!.end, T(2, 0));
    const tail = after.find((s) => s.end === null)!;
    assert.equal(tail.categoryId, "create");
    assert.equal(tail.start, T(3, 0));
    assert.equal(plan.inserts.find((i) => i.inherit)!.fromId, "r");
  });

  describe("20. planReconcile", () => {
    const K = (s: Span, writeKey: string): KeyedSpan => ({ ...s, writeKey });
    const applyK = (spans: readonly KeyedSpan[], plan: WritePlan): KeyedSpan[] =>
      apply(spans, plan).map((s) => ({ ...s, writeKey: spans.find((k) => k.id === s.id)?.writeKey ?? "z" }));

    test("a. 兩筆運行中、寫入較晚的開始較早 ⇒ 存活者＝寫入較晚那筆", () => {
      const spans = [K(mk("early", "x", T(9, 0), null), "0002|"), K(mk("late", "y", T(10, 0), null), "0001|")];
      const after = applyK(spans, planReconcile(spans));
      assert.equal(runningCount(after), 1);
      assert.equal(currentRunning(after)!.id, "early");
      const l = after.find((s) => s.id === "late")!;
      assert.equal(l.end, T(10, 0)); // max(自己的 start, 存活者的 start)
      assert.ok(l.end! >= l.start);
    });

    test("b. 離線三塊 vs 另一台換車造成重疊 ⇒ 寫入較晚者完整、較早者被切；片段 key＝`${id}|${ISO}`", () => {
      const spans = [
        K(mk("a", "x", T(9, 0), T(12, 0)), "0001|"),
        K(mk("b", "y", T(10, 0), T(11, 0)), "0002|"),
      ];
      const plan = planReconcile(spans);
      const after = applyK(spans, plan);
      assertNoOverlap(after);
      assert.equal(after.find((s) => s.id === "b")!.start, T(10, 0));
      assert.equal(after.find((s) => s.id === "a")!.end, T(10, 0));
      assert.equal(plan.inserts.length, 1);
      assert.equal(plan.inserts[0].key, `a|${new Date(T(11, 0)).toISOString()}`);
      assert.equal(plan.inserts[0].start, T(11, 0));
      assert.equal(plan.inserts[0].end, T(12, 0));
    });

    test("b2. 一台離線記三塊、另一台一班蓋在中間（寫入較晚）⇒ 較晚者完整、前塊切短、中塊收掉、後塊挪頭", () => {
      const spans = [
        K(mk("a", "x", T(9, 0), T(10, 0)), "0001|"),
        K(mk("b", "y", T(10, 0), T(11, 0)), "0001|"),
        K(mk("c", "z", T(11, 0), T(12, 0)), "0001|"),
        K(mk("r", "w", T(9, 30), T(11, 30)), "0002|"),
      ];
      const plan = planReconcile(spans);
      const after = applyK(spans, plan);
      assertNoOverlap(after);
      const r = after.find((s) => s.id === "r")!;
      assert.equal(r.start, T(9, 30));
      assert.equal(r.end, T(11, 30));
      assert.equal(after.find((s) => s.id === "a")!.end, T(9, 30));
      assert.deepEqual(plan.deletes, ["b"]);
      assert.equal(after.find((s) => s.id === "c")!.start, T(11, 30));
      assert.equal(plan.inserts.length, 0);
    });

    test("g. 寫入鍵的排序不變量：真 hlc 形狀 vs 沒有格子（hlc 位置放 ' '）", () => {
      // hlc = <13 位 ms><4 位 hex>-<device 前 8 碼>；沒有格子的列 = " " + "|" + updated_at（sqlite 實作 COALESCE(…, ' ')）
      const hlcOld = "1759999000000000a-aaaaaaaa";
      const hlcNew = "1759999900000000a-bbbbbbbb";
      const u = (h: number, mi: number): string => new Date(T(h, mi)).toISOString();
      // 空白 0x20 小於 0-9／a-f／'-' ⇒ 沒格子的列永遠排最早；'|'（0x7C）反而會排最晚
      assert.ok(" |" + u(15, 0) < hlcOld + "|" + u(9, 0));
      assert.ok(!("|" + u(9, 0) < hlcOld + "|" + u(15, 0)), "空字串＋'|' 會反過來排最晚（這就是不能用 '' 的原因）");
      assert.ok(hlcOld + "|" + u(15, 0) < hlcNew + "|" + u(9, 0), "hlc 先比，updated_at 只在 hlc 相同時才算");
      // 兩班運行中：沒格子那筆 updated_at 較晚，但有 hlc 的那筆才是「寫入較晚」
      const spans = [
        K(mk("nocell", "x", T(9, 0), null), " |" + u(15, 0)),
        K(mk("cell", "y", T(10, 0), null), hlcOld + "|" + u(9, 0)),
      ];
      const after = applyK(spans, planReconcile(spans));
      assert.equal(runningCount(after), 1);
      assert.equal(currentRunning(after)!.id, "cell");
      assert.equal(after.find((s) => s.id === "nocell")!.end, T(10, 0));
      // 兩筆都有格子：hlc 毫秒大的贏
      const spans2 = [
        K(mk("older", "x", T(9, 0), null), hlcOld + "|" + u(15, 0)),
        K(mk("newer", "y", T(10, 0), null), hlcNew + "|" + u(9, 0)),
      ];
      const after2 = applyK(spans2, planReconcile(spans2));
      assert.equal(currentRunning(after2)!.id, "newer");
    });

    /*
     * D-時-26：寫入鍵只看 started_at 那一格。下面兩支用「格子」模擬 sync_cells（col → hlc），
     * 新鍵＝reconcileWriteKey(cells.started_at, updated_at)（＝sqlite 實作），舊鍵＝整列 MAX（＝改訂前的 SQL），
     * 兩者並排，證明差別就出在「結束／分類那幾格不再進鍵」。
     */
    const hlcAt = (ms: number, dev: string): string => `${ms}0000-${dev}`; // <13 位 ms><4 位 hex>-<device 8 碼>
    type Cells = Record<string, string>;
    const newKey = (cells: Cells, upd: number): string => reconcileWriteKey(cells.started_at, new Date(upd).toISOString());
    const oldKey = (cells: Cells, upd: number): string => {
      const vals = Object.keys(cells).map((k) => cells[k]).sort();
      return (vals.length ? vals[vals.length - 1] : " ") + "|" + new Date(upd).toISOString();
    };

    test("h. 沙盒 F3：電腦那班 14:00 発、一直開著到 17:30 才寫結束；手機離線記 14:30–15:00、15:00–16:00 ⇒ 手機兩段保留、工作切成兩片", () => {
      const PC = "aaaaaaaa";
      const PHONE = "bbbbbbbb";
      // W：14:00 在電腦按発車（started_at 等格戳 14:00）；17:30 換車才寫下 ended_at（戳 17:30，updated_at 也是 17:30）
      const wCells: Cells = { category_id: hlcAt(T(14, 0), PC), started_at: hlcAt(T(14, 0), PC), ended_at: hlcAt(T(17, 30), PC) };
      // P1／P2：手機離線，14:30、15:00 発車；結束各在 15:00、16:00 寫下
      const p1Cells: Cells = { category_id: hlcAt(T(14, 30), PHONE), started_at: hlcAt(T(14, 30), PHONE), ended_at: hlcAt(T(15, 0), PHONE) };
      const p2Cells: Cells = { category_id: hlcAt(T(15, 0), PHONE), started_at: hlcAt(T(15, 0), PHONE), ended_at: hlcAt(T(16, 0), PHONE) };
      const W = mk("W", "work", T(14, 0), T(17, 30));
      const P1 = mk("P1", "move", T(14, 30), T(15, 0));
      const P2 = mk("P2", "meal", T(15, 0), T(16, 0));

      // 對照：舊鍵（整列 MAX）下 W 最晚 ⇒ 手機兩段被整段收掉——這就是 F3
      const old = [K(W, oldKey(wCells, T(17, 30))), K(P1, oldKey(p1Cells, T(15, 0))), K(P2, oldKey(p2Cells, T(16, 0)))];
      assert.deepEqual(planReconcile(old).deletes.slice().sort(), ["P1", "P2"]);

      // 新鍵：W 的鍵停在 14:00（結束那格不進鍵），P1／P2 都比它晚発車
      const spans = [K(W, newKey(wCells, T(17, 30))), K(P1, newKey(p1Cells, T(15, 0))), K(P2, newKey(p2Cells, T(16, 0)))];
      assert.ok(spans[0].writeKey < spans[1].writeKey && spans[1].writeKey < spans[2].writeKey);
      const plan = planReconcile(spans);
      const after = applyK(spans, plan);
      assertNoOverlap(after);
      assert.deepEqual(plan.deletes, []);
      // P1、P2 原樣
      assert.deepEqual(after.find((s) => s.id === "P1"), spans[1]);
      assert.deepEqual(after.find((s) => s.id === "P2"), spans[2]);
      // W：第一片回原 id 14:00–14:30；第二片 16:00–17:30 是 insert，key＝`W|<16:00 ISO>`、繼承 W
      const w = after.find((s) => s.id === "W")!;
      assert.equal(w.start, T(14, 0));
      assert.equal(w.end, T(14, 30));
      assert.equal(plan.inserts.length, 1);
      assert.equal(plan.inserts[0].key, `W|${new Date(T(16, 0)).toISOString()}`);
      assert.equal(plan.inserts[0].fromId, "W");
      assert.equal(plan.inserts[0].inherit, true);
      assert.equal(plan.inserts[0].categoryId, "work");
      assert.equal(plan.inserts[0].start, T(16, 0));
      assert.equal(plan.inserts[0].end, T(17, 30));
      // 冪等：套用後再跑 ⇒ 空 plan
      assert.deepEqual(planReconcile(after), { patches: [], inserts: [], deletes: [] });
      // 決定性：輸入順序打亂 ⇒ 輸出相同
      for (let n = 0; n < 6; n++) {
        const shuffled = spans.slice().sort(() => (((n * 7919 + 13) % 3) - 1));
        assert.deepEqual(planReconcile(shuffled), plan);
      }
      assert.deepEqual(planReconcile(spans.slice().reverse()), plan);
    });

    test("i. 多筆運行中：存活者＝較晚発車者；同一列改分類不影響優先序", () => {
      const PC = "aaaaaaaa";
      const PHONE = "bbbbbbbb";
      // A：電腦 09:00 発車，11:00 在電腦把分類從「讀書」改成「工作」（category_id 那格與 updated_at 都是 11:00）
      const aCells: Cells = { category_id: hlcAt(T(11, 0), PC), started_at: hlcAt(T(9, 0), PC) };
      // B：手機 10:00 発車，之後沒動
      const bCells: Cells = { category_id: hlcAt(T(10, 0), PHONE), started_at: hlcAt(T(10, 0), PHONE) };
      const A = mk("A", "work", T(9, 0), null);
      const B = mk("B", "move", T(10, 0), null);

      // 改分類前後，A 的新鍵只差在 updated_at（hlc 段不變）⇒ 仍排在 B 之後
      const aBefore = newKey({ category_id: hlcAt(T(9, 0), PC), started_at: hlcAt(T(9, 0), PC) }, T(9, 0));
      const aAfter = newKey(aCells, T(11, 0));
      const bKey = newKey(bCells, T(10, 0));
      assert.equal(aBefore.split("|")[0], aAfter.split("|")[0]);
      assert.ok(aAfter < bKey && aBefore < bKey);

      // 對照：舊鍵（整列 MAX）下改分類讓 A 變成最晚 ⇒ A 存活、B 被收在 10:00（零長度）
      const old = [K(A, oldKey(aCells, T(11, 0))), K(B, oldKey(bCells, T(10, 0)))];
      assert.equal(currentRunning(applyK(old, planReconcile(old)))!.id, "A");

      // 新鍵：B 較晚発車 ⇒ B 存活；A 收在 max(A.start, B.start) = 10:00
      const spans = [K(A, aAfter), K(B, bKey)];
      const plan = planReconcile(spans);
      const after = applyK(spans, plan);
      assert.equal(runningCount(after), 1);
      assert.equal(currentRunning(after)!.id, "B");
      const a = after.find((s) => s.id === "A")!;
      assert.equal(a.start, T(9, 0));
      assert.equal(a.end, T(10, 0));
      assertNoOverlap(after);
      assert.deepEqual(planReconcile(after), { patches: [], inserts: [], deletes: [] });
      assert.deepEqual(planReconcile(spans.slice().reverse()), plan);
    });

    test("j. reconcileWriteKey：沒有 started_at 那一格（null／undefined／''）⇒ hlc 位置放 ' '、排在任何真 hlc 之前", () => {
      const u = new Date(T(15, 0)).toISOString();
      assert.equal(reconcileWriteKey(null, u), " |" + u);
      assert.equal(reconcileWriteKey(undefined, u), " |" + u);
      assert.equal(reconcileWriteKey("", u), " |" + u);
      assert.ok(reconcileWriteKey(null, u) < reconcileWriteKey(hlcAt(T(9, 0), "aaaaaaaa"), new Date(T(9, 0)).toISOString()));
    });

    test("c. end < start ⇒ 夾零、ack=0", () => {
      const spans = [K(mk("z", "x", T(10, 0), T(9, 0), true), "0001|")];
      const plan = planReconcile(spans);
      assert.deepEqual(plan.patches, [{ id: "z", end: T(10, 0), ack: false }]);
    });

    test("d. 冪等：輸出再跑一次 ⇒ 空 plan", () => {
      const spans = [
        K(mk("a", "x", T(9, 0), T(12, 0)), "0001|"),
        K(mk("b", "y", T(10, 0), T(11, 0)), "0002|"),
        K(mk("r1", "x", T(13, 0), null), "0003|"),
        K(mk("r2", "y", T(12, 30), null), "0004|"),
        K(mk("z", "x", T(10, 0), T(9, 0)), "0005|"),
      ];
      const after = applyK(spans, planReconcile(spans));
      assertNoOverlap(after);
      assert.equal(runningCount(after), 1);
      assert.deepEqual(planReconcile(after), { patches: [], inserts: [], deletes: [] });
    });

    test("e. 決定性：輸入順序打亂 10 次 ⇒ 輸出相同", () => {
      const spans = [
        K(mk("a", "x", T(9, 0), T(12, 0)), "0001|"),
        K(mk("b", "y", T(10, 0), T(11, 0)), "0002|"),
        K(mk("c", "z", T(11, 30), T(14, 0)), "0003|"),
        K(mk("r1", "x", T(13, 0), null), "0004|"),
        K(mk("r2", "y", T(12, 30), null), "0005|"),
      ];
      const want = planReconcile(spans);
      for (let n = 0; n < 10; n++) {
        const shuffled = spans.slice().sort(() => (((n * 7919 + 13) % 3) - 1));
        assert.deepEqual(planReconcile(shuffled), want);
      }
    });

    test("f. 乾淨輸入 ⇒ 空 plan", () => {
      const spans = demo().map((s, i) => K(s, `000${i}|`));
      assert.deepEqual(planReconcile(spans), { patches: [], inserts: [], deletes: [] });
    });
  });

  test("21. 起手分類 id＝uuid v5(TIMETABLE_ID_NAMESPACE, 'timetable:'+key)；命名空間＝v5(DNS, 'timetable.nextstop.shitetsu.app')；Rust alive_filter 含全部 19 個 id", () => {
    const hexToBytes = (hex: string): Buffer => Buffer.from(hex.replace(/-/g, ""), "hex");
    const v5 = (ns: string, name: string): string => {
      const h = createHash("sha1").update(Buffer.concat([hexToBytes(ns), Buffer.from(name, "utf8")])).digest();
      const b = Buffer.from(h.subarray(0, 16));
      b[6] = (b[6] & 0x0f) | 0x50;
      b[8] = (b[8] & 0x3f) | 0x80;
      const s = b.toString("hex");
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    };
    const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    assert.equal(v5(DNS, "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2"); // RFC 4122 範例
    assert.equal(v5(DNS, "timetable.nextstop.shitetsu.app"), TIMETABLE_ID_NAMESPACE);
    for (const c of STARTER_CATEGORIES) assert.equal(c.id, v5(TIMETABLE_ID_NAMESPACE, `timetable:${c.key}`), c.key);
    const rs = readFileSync(path.join(ROOT, "src-tauri/src/sync/tables/timetable.rs"), "utf8");
    const m = rs.match(/const TIME_CATEGORIES_ALIVE[\s\S]*?;/);
    assert.ok(m, "timetable.rs 沒有 TIME_CATEGORIES_ALIVE");
    for (const c of STARTER_CATEGORIES) assert.ok(m[0].includes(`'${c.id}'`), `alive_filter 缺 ${c.key}`);
  });

  test("22. colorSlot 與 weekStartKey", () => {
    assert.equal(colorSlot(0), 8);
    assert.equal(colorSlot(9), 1);
    assert.equal(colorSlot(8), 8);
    assert.equal(colorSlot(1), 1);
    assert.equal(weekStartKey("2026-10-11"), "2026-10-05"); // 週日 → 前一個週一
    assert.equal(weekStartKey("2026-10-05"), "2026-10-05"); // 週一
    assert.equal(weekStartKey("2026-10-06"), "2026-10-05"); // 週二
  });

  test("23. 零長度塊夾在空白中間（沙盒回報 D1）⇒ 依時間排序、空白切成前後兩段", () => {
    // 沙盒那組：創作 16:41–16:54、興趣被整理夾成零長度在 17:04、吃飯 17:12 発（運行中）
    const now = T(17, 30);
    const spans = [
      mk("create", "create", T(16, 41), T(16, 54)),
      mk("hobby", "hobby", T(17, 4), T(17, 4)),
      mk("meal", "meal", T(17, 12), null),
    ];
    const items = segmentsOfDay(spans, DAY, now);
    const shape = items.map((i) =>
      i.kind === "gap" ? `gap ${fmtClock(i.from)}–${fmtClock(i.to)}` : `${i.span.id}${i.zero ? "(0)" : ""} ${fmtClock(i.from)}`,
    );
    assert.deepEqual(shape, [
      "gap 03:00–16:41",
      "create 16:41",
      "gap 16:54–17:04",
      "hobby(0) 17:04",
      "gap 17:04–17:12",
      "meal 17:12",
    ]);
    for (let i = 1; i < items.length; i++) assert.ok(items[i].from >= items[i - 1].from, `第 ${i} 項排序倒退`);
    assert.equal(gapTotal(items), (16 * 60 + 41 - 180 + 10 + 8) * MIN);
    // 零長度塊落在別的塊裡面（髒資料）⇒ 不產生負長度空白、游標不倒退
    const inside = segmentsOfDay([mk("a", "x", T(16, 41), T(16, 54)), mk("z", "y", T(16, 45), T(16, 45))], DAY, now);
    assert.deepEqual(
      inside.map((i) => (i.kind === "gap" ? `gap ${fmtClock(i.from)}–${fmtClock(i.to)}` : i.span.id)),
      ["gap 03:00–16:41", "a", "z", "gap 16:54–17:30"],
    );
  });

  test("24. 整理只掃最近 RECONCILE_WINDOW_DAYS 天＋所有運行中（契約 §9-6 退路；沙盒回報 F2）", () => {
    assert.equal(RECONCILE_WINDOW_DAYS, 62);
    const now = T(12, 0);
    const floor = reconcileWindowStart(now);
    assert.equal(now - floor, 62 * 24 * 60 * MIN);
    const H = 60 * MIN;
    const D = 24 * H;
    // 窗口判斷本身
    assert.equal(inReconcileWindow(mk("old", "x", floor - 3 * D, floor - 2 * D), floor), false, "窗外的舊塊不掃");
    assert.equal(inReconcileWindow(mk("edge", "x", floor - 2 * H, floor + 2 * H), floor), true, "跨下緣的塊要掃");
    assert.equal(inReconcileWindow(mk("runOld", "x", floor - 10 * D, null), floor), true, "運行中一律掃");
    assert.equal(inReconcileWindow(mk("recent", "x", floor + D, floor + D + H), floor), true);
    assert.equal(inReconcileWindow(mk("dirty", "x", floor + H, floor - 5 * D), floor), true, "開始在窗內、結束被改到窗外 ⇒ 要掃才夾得到零");

    // 套到整理：窗外兩筆互相重疊的舊塊不被碰；跨下緣的塊與窗內的塊重疊 ⇒ 照常整理
    const K = (s: Span, writeKey: string): KeyedSpan => ({ ...s, writeKey });
    const all = [
      K(mk("oldA", "x", floor - 3 * D, floor - 2 * D), "0001|"),
      K(mk("oldB", "y", floor - 3 * D + H, floor - 2 * D + H), "0002|"),
      K(mk("edge", "x", floor - 2 * H, floor + 2 * H), "0001|"),
      K(mk("recent", "y", floor + H, floor + 3 * H), "0002|"),
    ];
    const scanned = all.filter((s) => inReconcileWindow(s, floor));
    assert.deepEqual(scanned.map((s) => s.id), ["edge", "recent"]);
    const plan = planReconcile(scanned);
    assert.deepEqual(plan, { patches: [{ id: "edge", end: floor + H }], inserts: [], deletes: [] });
    // 對照：不限窗口時舊塊會被整理（證明窗口確實擋掉了東西）
    const full = planReconcile(all);
    assert.ok(full.patches.some((p) => p.id === "oldA"), "全表整理會動到 oldA");
  });
});
