/**
 * 時刻表・磨光⑦（試用回饋第二班）——純函式測試。
 * 跑法：`node --test scripts/tests/timetable-polish7.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * - D-時-151：已結束的塊不看分類預設長度判「長時間運行」（使用者 10-21：「蠻多正常記錄的時間塊被判定成長時間運行」）。
 * - D-時-150：合併時下一塊正在跑 ⇒ 保留運行中那一列、抄當前塊的分類／預估／連結過去。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MIN, blockThresholdOf, planEditRunning, planMerge, runMarker, type BlockLink, type Span } from "../../src/domain/timetable.ts";

const at = (h: number, mi = 0): number => new Date(2026, 9, 22, h, mi).getTime();
const NOW = at(15, 0);
const mk = (id: string, cat: string, start: number, end: number | null, ack = false): Span => ({ id, categoryId: cat, start, end, ack });

describe("D-時-151 blockThresholdOf：已結束的塊不看分類預設長度", () => {
  const cat = { default_min: 60 };
  test("已結束、比分類預設長、短於全域上限 ⇒ 沒有門檻來源是分類、不標", () => {
    const s = mk("a", "read", at(9, 0), at(12, 0)); // 3h
    const th = blockThresholdOf(true, null, cat, 14 * 60);
    assert.deepEqual(th, { min: 14 * 60, source: "global" });
    assert.deepEqual(runMarker(s, th, NOW), { kind: "none" });
  });
  test("運行中同樣條件 ⇒ 照舊用分類預設長度、標「長時間運行・待確認」", () => {
    const s = mk("r", "read", at(12, 0), null); // 跑了 3h
    const th = blockThresholdOf(false, null, cat, 14 * 60);
    assert.deepEqual(th, { min: 60, source: "category" });
    assert.deepEqual(runMarker(s, th, NOW), { kind: "long", pending: true });
  });
  test("已結束、這一班自己設過預估 ⇒ 照舊用預估（誤點）", () => {
    const s = mk("a", "read", at(9, 0), at(10, 0));
    const th = blockThresholdOf(true, 30, cat, 14 * 60);
    assert.deepEqual(th, { min: 30, source: "estimate" });
    assert.deepEqual(runMarker(s, th, NOW), { kind: "late", overMs: 30 * MIN, pending: true });
  });
  test("已結束、任務預計就算傳進來也不看；超過全域上限照標（忘記停車）", () => {
    assert.deepEqual(blockThresholdOf(true, null, cat, 14 * 60, 45), { min: 14 * 60, source: "global" });
    const s = mk("a", "read", at(0, 0), NOW); // 15h
    assert.deepEqual(runMarker(s, blockThresholdOf(true, null, cat, 14 * 60), NOW), { kind: "long", pending: true });
    assert.equal(blockThresholdOf(true, null, cat, 0), null, "全域上限關掉 ⇒ 已結束的塊沒有門檻");
  });
  test("運行中那班照舊四層（預估 → 任務 → 分類 → 全域）", () => {
    assert.deepEqual(blockThresholdOf(false, 20, cat, 840, 45), { min: 20, source: "estimate" });
    assert.deepEqual(blockThresholdOf(false, null, cat, 840, 45), { min: 45, source: "task" });
    assert.deepEqual(blockThresholdOf(false, null, null, 840), { min: 840, source: "global" });
  });
});

describe("D-時-150 合併、下一塊正在跑：保留運行中那一列、內容換成當前塊的", () => {
  const linkA: BlockLink = { nodeId: "task-x", routeId: null };
  const NONE: BlockLink = { nodeId: null, routeId: null };
  const spans = [mk("s", "read", at(9, 0), at(10, 0), true), mk("N", "meal", at(10, 0), null)];
  const info: Record<string, { estimateMin: number | null; link: BlockLink }> = {
    s: { estimateMin: 120, link: linkA },
    N: { estimateMin: null, link: NONE },
  };
  test("patch 運行中那列：start、分類、預估、連結都換成當前塊的；ack 歸 0；當前塊刪除", () => {
    const out = planMerge(spans, { id: "s", dir: "next", bound: at(23, 0), now: NOW, infoOf: (x) => info[x] })!;
    assert.deepEqual(out.plan.deletes, ["s"]);
    assert.deepEqual(out.plan.patches, [{ id: "N", start: at(9, 0), ack: false, categoryId: "read", estimateMin: 120, link: linkA }]);
    assert.deepEqual(out.plan.inserts, []);
    assert.deepEqual(out.plan.absorbedInto, [{ from: "s", to: "N", off: true }]);
    assert.deepEqual(out.preview, { keepId: "N", categoryId: "read", start: at(9, 0), end: null, gapMs: 0, absorbId: "s", intoRunning: true });
  });
  test("兩邊預估、連結本來就一樣 ⇒ 不重寫那兩欄（逐欄 LWW）", () => {
    const same = { s: { estimateMin: null, link: NONE }, N: { estimateMin: null, link: NONE } };
    const sameCat = [mk("s", "meal", at(9, 0), at(10, 0)), mk("N", "meal", at(10, 0), null)];
    const out = planMerge(sameCat, { id: "s", dir: "next", bound: at(23, 0), now: NOW, infoOf: (x) => same[x as "s" | "N"] })!;
    assert.deepEqual(out.plan.patches, [{ id: "N", start: at(9, 0), ack: false }]);
  });
  test("沒給 infoOf ⇒ 只換分類（預估、連結不動）", () => {
    const out = planMerge(spans, { id: "s", dir: "next", bound: at(23, 0), now: NOW })!;
    assert.deepEqual(out.plan.patches, [{ id: "N", start: at(9, 0), ack: false, categoryId: "read" }]);
  });
  test("已結束的鄰居緊貼：當前塊延伸、鄰居刪除；當前塊的 ack 照留（不出 ack patch）", () => {
    const ended = [mk("s", "read", at(9, 0), at(10, 0), true), mk("N", "meal", at(10, 0), at(11, 0))];
    const out = planMerge(ended, { id: "s", dir: "next", bound: at(23, 0), now: NOW, infoOf: (x) => info[x] })!;
    assert.deepEqual(out.plan.patches, [{ id: "s", end: at(11, 0) }]);
    assert.deepEqual(out.plan.deletes, ["N"]);
    assert.equal(out.preview.intoRunning, false);
  });
});

describe("D-時-152 planEditRunning：改運行中那一班", () => {
  const LINK: BlockLink = { nodeId: "task-x", routeId: null };
  const NONE: BlockLink = { nodeId: null, routeId: null };
  const base = () => [mk("p", "meal", at(11, 0), at(12, 0)), mk("r", "read", at(12, 0), null, true)];

  test("只換分類 ⇒ patch 分類＋ack 歸 0；不蓋任何東西、不動 start", () => {
    const plan = planEditRunning(base(), { id: "r", categoryId: "work", start: at(12, 0), now: NOW });
    assert.deepEqual(plan, { patches: [{ id: "r", categoryId: "work", ack: false }], inserts: [], deletes: [] });
  });
  test("出發時間往前蓋到前一塊 ⇒ 前一塊切短（同 planRestart）、start 往前", () => {
    const plan = planEditRunning(base(), { id: "r", categoryId: "read", start: at(11, 30), now: NOW });
    assert.deepEqual(plan.patches, [{ id: "p", end: at(11, 30) }, { id: "r", start: at(11, 30) }]);
  });
  test("什麼都沒變 ⇒ 空 plan；連結一樣 ⇒ 不寫；連結不同 ⇒ 成對寫", () => {
    assert.deepEqual(planEditRunning(base(), { id: "r", categoryId: "read", start: at(12, 0), now: NOW, link: null, curLink: NONE }), { patches: [], inserts: [], deletes: [] });
    const p = planEditRunning(base(), { id: "r", categoryId: "read", start: at(12, 0), now: NOW, link: LINK, curLink: NONE });
    assert.deepEqual(p.patches, [{ id: "r", link: LINK }]);
  });
  test("出發時間晚於現在 ⇒ 夾到現在−1 分；已到站的塊 ⇒ RangeError", () => {
    const p = planEditRunning(base(), { id: "r", categoryId: "read", start: NOW + 5 * MIN, now: NOW });
    assert.deepEqual(p.patches, [{ id: "r", start: NOW - MIN }]);
    assert.throws(() => planEditRunning(base(), { id: "p", categoryId: "read", start: at(11, 0), now: NOW }), RangeError);
  });
  test("併進運行中那列時，當前塊的排除也要搬（absorbedInto.off，評審 #4）；其他合併只搬手動荷札", () => {
    const spans = [mk("s", "read", at(9, 0), at(10, 0)), mk("N", "meal", at(10, 0), null)];
    const run = planMerge(spans, { id: "s", dir: "next", bound: at(23, 0), now: NOW })!;
    assert.deepEqual(run.plan.absorbedInto, [{ from: "s", to: "N", off: true }]);
    const ended = [mk("s", "read", at(9, 0), at(10, 0)), mk("N", "meal", at(10, 0), at(11, 0))];
    assert.deepEqual(planMerge(ended, { id: "s", dir: "next", bound: at(23, 0), now: NOW })!.plan.absorbedInto, [{ from: "N", to: "s" }]);
  });
});
