/**
 * 時刻表線・任務連動的純函式單元測試（車次② 契約 §4.4 F 區；甲席）。
 * 跑法：`node --test scripts/tests/timetable-link.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi).getTime()` 造本地時刻（`T(h, mi)`，同 timetable-logic.test.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MIN,
  NO_LINK,
  insertLinkOf,
  planCover,
  planDepart,
  planEdit,
  planFill,
  planResolveLongRun,
  planSetLink,
  planSplit,
  planSplitMulti,
  runMarker,
  thresholdOf,
  type BlockLink,
  type Span,
} from "../../src/domain/timetable.ts";
import {
  LINK_MISSING_TEXT,
  WATCH_INIT,
  clipLabel,
  doneKeyOf,
  focusMs,
  linkDeletedText,
  linkLabelOf,
  linkOfRow,
  linkedTotals,
  monthStartKey,
  runLabel,
  taskEstimateOf,
  unionMs,
  watchStep,
  type LinkInfo,
  type LinkedSpan,
  type WatchEvent,
  type WatchState,
} from "../../src/domain/timetableLink.ts";

/* ───────── 測試用小工具 ───────── */

/** 今天本地 (h, mi)；d 偏移天數 */
const T = (h: number, mi: number, d = 0): number => new Date(2026, 9, 6 + d, h, mi).getTime();
const NOW = T(15, 42);

const mk = (id: string, cat: string, start: number, end: number | null, ack = false): Span => ({ id, categoryId: cat, start, end, ack });
const toNode = (nodeId: string): BlockLink => ({ nodeId, routeId: null });
const toRoute = (routeId: string): BlockLink => ({ nodeId: null, routeId });

const info = (id: string, over: Partial<LinkInfo> = {}): LinkInfo => ({
  id,
  kind: "ticket",
  kindLabel: "車票",
  name: `名-${id}`,
  routeId: null,
  estimateMin: null,
  code: null,
  deleted: false,
  missing: false,
  ...over,
});

const ls = (id: string, start: number, end: number | null, nodeId: string | null, routeId: string | null = null): LinkedSpan => ({
  id,
  start,
  end,
  nodeId,
  routeId,
});

/** 依序餵事件；回最後的狀態與每一步的 prompt */
function run(s: WatchState, events: readonly WatchEvent[]): { state: WatchState; prompts: (string | null)[] } {
  const prompts: (string | null)[] = [];
  let cur = s;
  for (const e of events) {
    const out = watchStep(cur, e);
    cur = out.state;
    prompts.push(out.prompt);
  }
  return { state: cur, prompts };
}
const obs = (key: string | null, doneKey: string | null | undefined, working = false): WatchEvent => ({ kind: "observe", key, doneKey, working });
const K = "b1|n1";
/** 已經看過一次「沒蓋済」的基準 */
const BASE: WatchState = { ...WATCH_INIT, key: K, base: null };

describe("F 區：任務連動（② 契約 §4.4）", () => {
  test("載入：兩支純函式模組 node 直接載得進來", () => {
    assert.deepEqual(NO_LINK, { nodeId: null, routeId: null });
    assert.deepEqual(linkOfRow({ node_id: null, route_id: null }), NO_LINK);
  });

  test("F1 planDepart 給 link ⇒ 新一班 insert 的 link 等於它；不給 ⇒ NO_LINK", () => {
    const spans = [mk("r", "a", T(9, 0), null)];
    const p1 = planDepart(spans, { categoryId: "b", at: T(10, 0), now: NOW, link: toNode("n1") });
    assert.deepEqual(p1.inserts[p1.inserts.length - 1].link, toNode("n1"));
    const p2 = planDepart(spans, { categoryId: "b", at: T(10, 0), now: NOW });
    assert.deepEqual(p2.inserts[p2.inserts.length - 1].link, NO_LINK);
    const p3 = planDepart(spans, { categoryId: "b", at: T(10, 0), now: NOW, link: null });
    assert.deepEqual(p3.inserts[p3.inserts.length - 1].link, NO_LINK, "null＝沒連");
    // 上一班被切短，不帶連結欄（不動上一班的連結）
    assert.equal(p1.patches[0].link, undefined);
  });

  test("F2 planFill 同上", () => {
    const p1 = planFill([], { categoryId: "b", start: T(9, 0), end: T(10, 0), now: NOW, link: toRoute("R") });
    assert.deepEqual(p1.inserts[0].link, toRoute("R"));
    const p2 = planFill([], { categoryId: "b", start: T(9, 0), end: T(10, 0), now: NOW });
    assert.deepEqual(p2.inserts[0].link, NO_LINK);
  });

  test("F3 planEdit：只改連結 ⇒ patch 只有 link；連結一樣 ⇒ patch 沒有 link；link undefined ⇒ 不動", () => {
    const spans = [mk("x", "a", T(9, 0), T(10, 0))];
    const base = { id: "x", categoryId: "a", start: T(9, 0), end: T(10, 0), now: NOW };
    const onlyLink = planEdit(spans, { ...base, link: toNode("n2"), curLink: toNode("n1") });
    assert.deepEqual(onlyLink.patches, [{ id: "x", link: toNode("n2") }]);
    const same = planEdit(spans, { ...base, link: toNode("n1"), curLink: toNode("n1") });
    assert.deepEqual(same.patches, [], "連結一樣、其他也沒變 ⇒ 不出 patch");
    const sameButMoved = planEdit(spans, { ...base, end: T(10, 30), link: toNode("n1"), curLink: toNode("n1") });
    assert.equal(sameButMoved.patches.length, 1);
    assert.equal(sameButMoved.patches[0].link, undefined, "連結一樣 ⇒ patch 不帶 link");
    const untouched = planEdit(spans, { ...base, end: T(10, 30), curLink: toNode("n1") });
    assert.equal(untouched.patches[0].link, undefined, "link undefined ⇒ 不動");
    const unlink = planEdit(spans, { ...base, link: null, curLink: toNode("n1") });
    assert.deepEqual(unlink.patches, [{ id: "x", link: NO_LINK }], "null＝取消連結");
    const noCur = planEdit(spans, { ...base, link: toNode("n1") });
    assert.deepEqual(noCur.patches, [{ id: "x", link: toNode("n1") }], "curLink 沒給＝當作不同");
  });

  test("F4 planSetLink：運行中、已結束都出 patch；一樣 ⇒ 空 plan；找不到 ⇒ RangeError", () => {
    const spans = [mk("done", "a", T(9, 0), T(10, 0)), mk("run", "b", T(10, 0), null)];
    for (const id of ["done", "run"]) {
      const p = planSetLink(spans, { id, link: toNode("n1"), curLink: NO_LINK });
      assert.deepEqual(p, { patches: [{ id, link: toNode("n1") }], inserts: [], deletes: [] });
    }
    assert.deepEqual(planSetLink(spans, { id: "run", link: toNode("n1"), curLink: toNode("n1") }), {
      patches: [],
      inserts: [],
      deletes: [],
    });
    assert.deepEqual(planSetLink(spans, { id: "run", link: null, curLink: NO_LINK }).patches, [], "null 對沒連＝一樣");
    assert.deepEqual(planSetLink(spans, { id: "run", link: null, curLink: toRoute("R") }).patches, [{ id: "run", link: NO_LINK }]);
    assert.throws(() => planSetLink(spans, { id: "nope", link: null, curLink: NO_LINK }), RangeError);
  });

  test("F5 planSplit 分類一樣 ⇒ inherit:true, keepLink:true；分類不同 ⇒ inherit:false, keepLink:true", () => {
    const spans = [mk("x", "a", T(9, 0), T(11, 0))];
    const same = planSplit(spans, { id: "x", at: T(10, 0), categoryId2: "a", now: NOW })!;
    assert.equal(same.inserts[0].inherit, true);
    assert.equal(same.inserts[0].keepLink, true);
    assert.equal(same.inserts[0].fromId, "x");
    const diff = planSplit(spans, { id: "x", at: T(10, 0), categoryId2: "b", now: NOW })!;
    assert.equal(diff.inserts[0].inherit, false);
    assert.equal(diff.inserts[0].keepLink, true);
    assert.equal(diff.inserts[0].link, undefined, "不明寫 ⇒ 照 fromId 抄");
  });

  test("F6 planSplitMulti 三刀四段、分類各不同 ⇒ 每個 insert keepLink:true", () => {
    const spans = [mk("x", "z", T(9, 0), T(13, 0))];
    const p = planSplitMulti(spans, { id: "x", cuts: [T(10, 0), T(11, 0), T(12, 0)], categoryIds: ["a", "b", "c", "d"], now: NOW });
    assert.equal(p.inserts.length, 3);
    for (const i of p.inserts) {
      assert.equal(i.keepLink, true);
      assert.equal(i.inherit, false);
      assert.equal(i.fromId, "x");
    }
  });

  test("F7 planResolveLongRun 的 cat ⇒ 新段 link 是 NO_LINK；gap、keep 不出 insert", () => {
    const spans = [mk("r", "a", T(9, 0), null)];
    const cat = planResolveLongRun(spans, { id: "r", end: T(10, 0), choice: "cat", categoryId2: "b", now: NOW });
    assert.equal(cat.inserts.length, 1);
    assert.deepEqual(cat.inserts[0].link, NO_LINK);
    for (const choice of ["gap", "keep"] as const) {
      assert.equal(planResolveLongRun(spans, { id: "r", end: T(10, 0), choice, now: NOW }).inserts.length, 0);
    }
  });

  test("F8 planCover 切成兩半的右半段 ⇒ inherit:true（既有，回歸）", () => {
    const p = planCover([mk("x", "a", T(9, 0), T(12, 0))], { start: T(10, 0), end: T(11, 0) }, null);
    assert.deepEqual(p.patches, [{ id: "x", end: T(10, 0) }]);
    assert.equal(p.inserts.length, 1);
    assert.equal(p.inserts[0].inherit, true);
    assert.equal(p.inserts[0].fromId, "x");
    assert.equal(p.inserts[0].start, T(11, 0));
    assert.equal(p.inserts[0].link, undefined);
  });

  test("F9 thresholdOf：預估 → 任務 → 分類 → 全域；第四參數省略＝跟現在一樣", () => {
    const cat = { default_min: 240 };
    assert.deepEqual(thresholdOf(30, cat, 840, 60), { min: 30, source: "estimate" });
    assert.deepEqual(thresholdOf(null, cat, 840, 60), { min: 60, source: "task" });
    assert.deepEqual(thresholdOf(null, cat, 840, 0), { min: 240, source: "category" });
    assert.deepEqual(thresholdOf(null, cat, 840, null), { min: 240, source: "category" });
    assert.deepEqual(thresholdOf(null, cat, 840), { min: 240, source: "category" });
    assert.deepEqual(thresholdOf(null, null, 840, 60), { min: 60, source: "task" });
    assert.deepEqual(thresholdOf(null, null, 840), { min: 840, source: "global" });
    assert.equal(thresholdOf(null, null, 0), null);
  });

  test("F10 runMarker 來源 task、超過 ⇒ late；來源 category ⇒ long", () => {
    const s = mk("r", "a", T(9, 0), null);
    const now = T(10, 30);
    assert.deepEqual(runMarker(s, { min: 60, source: "task" }, now), { kind: "late", overMs: 30 * MIN, pending: true });
    assert.deepEqual(runMarker(s, { min: 60, source: "category" }, now), { kind: "long", pending: true });
    assert.deepEqual(runMarker(s, { min: 120, source: "task" }, now), { kind: "none" }, "還沒超過");
  });

  test("F11 linkOfRow 兩欄都有值 ⇒ 只回 nodeId；linkLabelOf 七種情況；info 還沒載 ⇒ null", () => {
    assert.deepEqual(linkOfRow({ node_id: "n1", route_id: "R" }), toNode("n1"));
    assert.deepEqual(linkOfRow({ node_id: null, route_id: "R" }), toRoute("R"));
    const links: Record<string, LinkInfo> = {
      n1: info("n1", { name: "寫契約" }),
      n2: info("n2", { kind: "train", kindLabel: "列車", deleted: true }),
      n3: info("n3", { missing: true, name: "" }),
      R1: info("R1", { kind: "route", kindLabel: "路線", name: "創作線" }),
      R2: info("R2", { kind: "route", kindLabel: "路線", deleted: true }),
      R3: info("R3", { kind: "route", kindLabel: "路線", missing: true, name: "" }),
    };
    const row = (node_id: string | null, route_id: string | null = null) => ({ node_id, route_id });
    assert.equal(linkLabelOf(row("n1"), links), "寫契約");
    assert.equal(linkLabelOf(row("n2"), links), "（原列車已刪）");
    assert.equal(linkLabelOf(row("n2"), links), linkDeletedText("列車"));
    assert.equal(linkLabelOf(row("n3"), links), LINK_MISSING_TEXT);
    assert.equal(linkLabelOf(row(null, "R1"), links), "創作線");
    assert.equal(linkLabelOf(row(null, "R2"), links), "（原路線已刪）");
    assert.equal(linkLabelOf(row(null, "R3"), links), "（原路線已刪）");
    assert.equal(linkLabelOf(row(null, null), links), null);
    assert.equal(linkLabelOf(row("unknown"), links), null, "節點 info 還沒載");
    assert.equal(linkLabelOf(row(null, "unknown"), links), null, "路線 info 還沒載");
    assert.equal(linkLabelOf(row("n1", "R1"), links), "寫契約", "兩欄都有值 ⇒ 看節點");
  });

  test("F12 taskEstimateOf：deleted、missing、只連路線 ⇒ null", () => {
    const links: Record<string, LinkInfo> = {
      ok: info("ok", { estimateMin: 60 }),
      zero: info("zero", { estimateMin: 0 }),
      none: info("none", { estimateMin: null }),
      del: info("del", { estimateMin: 60, deleted: true }),
      miss: info("miss", { estimateMin: 60, missing: true }),
      R: info("R", { kind: "route", kindLabel: "路線", estimateMin: 60 }),
    };
    const row = (node_id: string | null, route_id: string | null = null) => ({ node_id, route_id });
    assert.equal(taskEstimateOf(row("ok"), links), 60);
    assert.equal(taskEstimateOf(row("zero"), links), null);
    assert.equal(taskEstimateOf(row("none"), links), null);
    assert.equal(taskEstimateOf(row("del"), links), null);
    assert.equal(taskEstimateOf(row("miss"), links), null);
    assert.equal(taskEstimateOf(row(null, "R"), links), null);
    assert.equal(taskEstimateOf(row("unknown"), links), null);
    assert.equal(taskEstimateOf(row(null, null), links), null);
  });

  test("F13 linkedTotals 節點：自己兩塊（重疊）、底下一塊、一塊運行中到 now；window 裁切", () => {
    const spans = [
      ls("a", T(9, 0), T(10, 0), "n1"),
      ls("b", T(9, 30), T(10, 30), "n1"), // 跟 a 重疊 30 分 ⇒ 自己這兩塊聯集 90 分
      ls("c", T(11, 0), T(12, 0), "child"),
      ls("d", T(13, 0), null, "n1"), // 運行中，now 13:30
    ];
    const now = T(13, 30);
    assert.deepEqual(linkedTotals(spans, { self: { nodeId: "n1" }, now }), {
      selfMs: 120 * MIN,
      belowMs: 60 * MIN,
      totalMs: 180 * MIN,
    });
    const w = { start: T(9, 45), end: T(13, 15) };
    assert.deepEqual(linkedTotals(spans, { self: { nodeId: "n1" }, now, window: w }), {
      selfMs: 60 * MIN, // 09:45–10:30 ＋ 13:00–13:15
      belowMs: 60 * MIN,
      totalMs: 120 * MIN,
    });
    // 負時長當 0；自己跟底下重疊時合計不重複計
    assert.equal(unionMs([{ start: T(10, 0), end: T(9, 0) }], now), 0);
    const overlap = [ls("x", T(9, 0), T(10, 0), "n1"), ls("y", T(9, 30), T(10, 30), "child")];
    assert.deepEqual(linkedTotals(overlap, { self: { nodeId: "n1" }, now }), { selfMs: 60 * MIN, belowMs: 60 * MIN, totalMs: 90 * MIN });
  });

  test("F14 linkedTotals 路線：只連路線的算自己、連節點的算底下", () => {
    const spans = [ls("a", T(9, 0), T(10, 0), null, "R"), ls("b", T(11, 0), T(11, 30), "n1"), ls("c", T(12, 0), T(12, 15), "n2", "R")];
    assert.deepEqual(linkedTotals(spans, { self: { routeId: "R" }, now: NOW }), {
      selfMs: 60 * MIN,
      belowMs: 45 * MIN, // c 兩欄都有值 ⇒ 連節點、算底下
      totalMs: 105 * MIN,
    });
  });

  test("F15 focusMs：沒連結的不算；跨日界線的塊只算今天那段；運行中到 now", () => {
    const day = { start: T(3, 0), end: T(3, 0, 1) };
    const spans = [
      ls("cross", T(2, 0), T(4, 0), "n1"), // 只算 03:00–04:00
      ls("bare", T(5, 0), T(6, 0), null), // 沒連 ⇒ 不算
      ls("route", T(7, 0), T(7, 30), null, "R"), // 只連路線也算
      ls("run", T(20, 0), null, "n2"), // 運行中，now 21:00
    ];
    assert.equal(focusMs(spans, day, T(21, 0)), (60 + 30 + 60) * MIN);
  });

  test("F16 doneKeyOf：一般 done ⇒ n；定期券 occurrence done ⇒ r:<due>；row undefined ⇒ undefined；運休、系列退休 ⇒ null", () => {
    const plain = (status: string) => ({ status, repeat_rule: null });
    const rep = (status: string) => ({ status, repeat_rule: '{"every":1}' });
    assert.equal(doneKeyOf(plain("done"), undefined, false), "n");
    assert.equal(doneKeyOf(plain("todo"), undefined, false), null);
    assert.equal(doneKeyOf(rep("todo"), { status: "done", due_on: "2026-10-16" }, true), "r:2026-10-16");
    assert.equal(doneKeyOf(undefined, { status: "done", due_on: "2026-10-16" }, true), undefined);
    assert.equal(doneKeyOf(undefined, undefined, false), undefined);
    assert.equal(doneKeyOf(rep("todo"), { status: "skipped", due_on: "2026-10-16" }, true), null, "運休不算蓋済");
    assert.equal(doneKeyOf(rep("done"), undefined, true), null, "系列退休、沒有目前班次");
    assert.equal(doneKeyOf(rep("done"), { status: "skipped", due_on: "2026-10-16" }, true), null, "系列退休＋班次運休");
    assert.equal(doneKeyOf(rep("todo"), undefined, true), null, "這班還沒交代");
  });

  test("F17 watchStep：working false 轉變 ⇒ 提示一次、第二次同樣的不再提示", () => {
    const { state, prompts } = run(WATCH_INIT, [obs(K, null), obs(K, "n"), obs(K, "n"), obs(K, "n")]);
    assert.deepEqual(prompts, [null, K, null, null]);
    assert.equal(state.prompted, `${K}#n`);
    assert.equal(state.base, "n");
  });

  test("F18 watchStep：working true 轉變 → pulled → settled ⇒ 不提示", () => {
    const { state, prompts } = run(BASE, [obs(K, "n", true), { kind: "pulled" }, { kind: "settled", dirty: false }]);
    assert.deepEqual(prompts, [null, null, null]);
    assert.equal(state.pending, false);
    assert.equal(state.pulled, false);
    assert.equal(state.base, "n");
    // 之後同一個蓋済不會被當成新的轉變
    assert.deepEqual(run(state, [obs(K, "n")]).prompts, [null]);
  });

  test("F19 watchStep：working true 轉變 → settled（沒 pulled）⇒ 這時才提示", () => {
    const { state, prompts } = run(BASE, [obs(K, "n", true), { kind: "settled", dirty: false }]);
    assert.deepEqual(prompts, [null, K]);
    assert.equal(state.prompted, `${K}#n`);
    assert.equal(state.pending, false);
    // pulled 只在有待判時才記；沒有待判時 pulled 不留到下一趟
    const idle = run(BASE, [{ kind: "pulled" }, obs(K, "n", true), { kind: "settled", dirty: false }]);
    assert.deepEqual(idle.prompts, [null, null, K]);
    // working 期間又取消済 ⇒ 待判作廢
    const undo = run(BASE, [obs(K, "n", true), obs(K, null, true), { kind: "settled", dirty: false }]);
    assert.deepEqual(undo.prompts, [null, null, null]);
  });

  test("F20 watchStep：換 key 不提示；doneKey undefined ⇒ base 不動；取消済再蓋不再提示；定期券隔天另一班 ⇒ 提示", () => {
    // 換 key（換班或改連結）⇒ 重設、不提示（就算新的那個已經蓋済）
    const sw = run(BASE, [obs("b2|n9", "n")]);
    assert.deepEqual(sw.prompts, [null]);
    assert.equal(sw.state.key, "b2|n9");
    assert.equal(sw.state.base, "n");
    // 切片暫時沒有這個節點 ⇒ base 不動；回來時才是轉變
    const gone = run(BASE, [obs(K, undefined), obs(K, "n")]);
    assert.equal(gone.prompts[0], null);
    assert.equal(gone.prompts[1], K);
    // 取消済再蓋（doneKey 一樣）⇒ prompted 擋住
    const again = run(BASE, [obs(K, "n"), obs(K, null), obs(K, "n")]);
    assert.deepEqual(again.prompts, [K, null, null]);
    // 定期券：今天這班蓋済 → 滾到下一班（沒結局）→ 隔天那班蓋済 ⇒ 再提示一次
    const rep = run(BASE, [obs(K, "r:2026-10-16"), obs(K, null), obs(K, "r:2026-10-17")]);
    assert.deepEqual(rep.prompts, [K, null, K]);
    // 運行中那班沒連節點 ⇒ key null，不提示
    assert.deepEqual(run(WATCH_INIT, [obs(null, null), obs(null, null)]).prompts, [null, null]);
  });

  test("F21 clipLabel 16 字邊界；runLabel label null", () => {
    const s16 = "一二三四五六七八九十一二三四五六";
    assert.equal(Array.from(s16).length, 16);
    assert.equal(clipLabel(s16), s16);
    const s17 = s16 + "七";
    assert.equal(clipLabel(s17), "一二三四五六七八九十一二三四五…");
    assert.equal(Array.from(clipLabel(s17)).length, 16);
    assert.equal(clipLabel("😀😀😀", 2), "😀…", "Array.from 算字（代理對算一個）");
    assert.equal(clipLabel(""), "");
    assert.equal(runLabel("創作", null), "創作");
    assert.equal(runLabel("創作", "寫契約"), "創作・寫契約");
  });

  test("F22 monthStartKey", () => {
    assert.equal(monthStartKey("2026-10-16"), "2026-10-01");
    assert.equal(monthStartKey("2026-10-01"), "2026-10-01");
    assert.equal(monthStartKey("2027-01-31"), "2027-01-01");
  });

  test("F23 watchStep：settled dirty ⇒ suppress；抑制中轉變不提示、base 更新；unsuppress 後同 doneKey 不再提示、新轉變照常；不 dirty ⇒ suppress 不變", () => {
    const dirty = watchStep(BASE, { kind: "settled", dirty: true }).state;
    assert.equal(dirty.suppress, true);
    // 抑制中：working false 的轉變 ⇒ 不提示、不記待判、base 更新
    const sup = run(dirty, [obs(K, "r:2026-10-16")]);
    assert.deepEqual(sup.prompts, [null]);
    assert.equal(sup.state.base, "r:2026-10-16");
    assert.equal(sup.state.pending, false);
    // 抑制中換 key 也維持抑制
    assert.equal(run(dirty, [obs("b2|n2", null)]).state.suppress, true);
    // 不 dirty 的收尾不動 suppress
    assert.equal(watchStep(sup.state, { kind: "settled", dirty: false }).state.suppress, true);
    assert.equal(watchStep(BASE, { kind: "settled", dirty: false }).state.suppress, false);
    // unsuppress 之後：同一個 doneKey 不是轉變；新的轉變照常提示
    const after = run(sup.state, [{ kind: "unsuppress" }, obs(K, "r:2026-10-16"), obs(K, null), obs(K, "r:2026-10-17")]);
    assert.equal(after.state.suppress, false);
    assert.deepEqual(after.prompts, [null, null, null, K]);
    // dirty 收尾時還有待判（沒 pulled）⇒ 照樣提示這一個，同時進抑制
    const both = run(BASE, [obs(K, "n", true), { kind: "settled", dirty: true }]);
    assert.deepEqual(both.prompts, [null, K]);
    assert.equal(both.state.suppress, true);
  });
  test("F24 insertLinkOf（applyPlan 寫進列的連結，sqlite／memory 共用）：明寫蓋過抄來的；inherit 或 keepLink 照抄；都沒有／src 不在 ⇒ NO_LINK", () => {
    const srcNode = { node_id: "n1", route_id: null };
    const srcRoute = { node_id: null, route_id: "r1" };
    const L: BlockLink = { nodeId: "n9", routeId: null };
    // 明寫 link 蓋過抄來的（含明寫 NO_LINK）
    assert.deepEqual(insertLinkOf({ link: L, inherit: true, keepLink: true }, srcNode), L);
    assert.deepEqual(insertLinkOf({ link: NO_LINK, inherit: true }, srcNode), NO_LINK);
    // inherit=false、keepLink=true ⇒ 照抄；inherit=true ⇒ 照抄；兩欄原樣
    assert.deepEqual(insertLinkOf({ inherit: false, keepLink: true }, srcNode), { nodeId: "n1", routeId: null });
    assert.deepEqual(insertLinkOf({ inherit: true }, srcRoute), { nodeId: null, routeId: "r1" });
    assert.deepEqual(insertLinkOf({ inherit: true }, { node_id: "n1", route_id: "r1" }), { nodeId: "n1", routeId: "r1" });
    // 兩者都沒有 ⇒ NO_LINK；src 不在 ⇒ NO_LINK
    assert.equal(insertLinkOf({ inherit: false }, srcNode), NO_LINK);
    assert.equal(insertLinkOf({ inherit: true, keepLink: true }, undefined), NO_LINK);
    // 抄來的是新物件（不是 src 本身，也不是共用的 NO_LINK）
    const copied = insertLinkOf({ inherit: false, keepLink: true }, srcRoute);
    assert.notEqual(copied, NO_LINK);
    // 純函式給的旗標落到列上：切開（分類換了）沿用；「其實在做別的」不帶；planCover 右半段沿用
    const spans = [mk("x", "a", T(9, 0), T(12, 0))];
    const split = planSplit(spans, { id: "x", at: T(10, 0), categoryId2: "b", now: NOW })!;
    assert.deepEqual(insertLinkOf(split.inserts[0], srcNode), { nodeId: "n1", routeId: null });
    const cat = planResolveLongRun([mk("r", "a", T(9, 0), null)], { id: "r", end: T(10, 0), choice: "cat", categoryId2: "b", now: NOW });
    assert.deepEqual(insertLinkOf(cat.inserts[0], srcNode), NO_LINK);
    const cover = planCover(spans, { start: T(10, 0), end: T(11, 0) }, null);
    assert.deepEqual(insertLinkOf(cover.inserts[0], srcRoute), { nodeId: null, routeId: "r1" });
  });
});
